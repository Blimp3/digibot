from __future__ import annotations

import asyncio
import gzip
import json

import brotli
import httpx
import pytest

from downloader_container.config import Settings
from downloader_container.direct_media import (
    _request_bounded,
    download_direct_media,
    resolve_direct_media,
    validate_direct_media_url,
)
from downloader_container.errors import DownloadError, ErrorCode, ErrorStage

TIKTOK_ID = "7578502470108777750"
X_ID = "2089598976970670190"


def test_provider_url_validation_is_strict_and_provider_specific() -> None:
    accepted = validate_direct_media_url(
        "https://v16e.tiktokcdn.com/video.mp4?token=short-lived",
        provider="tiktok",
        resolve_dns=False,
    )
    assert accepted.startswith("https://v16e.tiktokcdn.com/")

    for url, provider in (
        ("https://evil-tiktokcdn.com/video.mp4", "tiktok"),
        ("https://v16e.tiktokcdn.com.evil.example/video.mp4", "tiktok"),
        ("http://v16e.tiktokcdn.com/video.mp4", "tiktok"),
        ("https://video.twimg.com.evil.example/video.mp4", "x"),
        ("https://v16e.tiktokcdn.com/video.mp4", "x"),
        ("https://video.twimg.com/video.mp4", "tiktok"),
    ):
        with pytest.raises(DownloadError) as caught:
            validate_direct_media_url(url, provider=provider, resolve_dns=False)
        assert caught.value.code == ErrorCode.MEDIA_UNAVAILABLE


@pytest.mark.asyncio
async def test_provider_response_is_rejected_while_streaming_past_cap() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 65)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DownloadError) as caught:
            await _request_bounded(client, "GET", "https://provider.example/data", max_bytes=64)
    assert caught.value.code == ErrorCode.MEDIA_UNAVAILABLE


@pytest.mark.asyncio
@pytest.mark.parametrize(("encoding", "compress"), [("gzip", gzip.compress), ("br", brotli.compress)])
async def test_bounded_response_materializes_decoded_compressed_json_once(encoding, compress) -> None:
    payload = {"items": []}
    decoded = json.dumps(payload).encode()
    compressed = compress(decoded)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "content-encoding": encoding,
                "content-length": str(len(compressed)),
                "content-type": "application/json",
            },
            content=compressed,
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await _request_bounded(client, "GET", "https://provider.example/data", max_bytes=1_024)

    assert response.json() == payload
    assert "content-encoding" not in response.headers
    assert response.headers["content-length"] == str(len(decoded))


@pytest.mark.asyncio
async def test_bounded_response_maps_malformed_compression_to_stable_error() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"not-gzip"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DownloadError) as caught:
            await _request_bounded(client, "GET", "https://provider.example/data", max_bytes=1_024)

    assert caught.value.code == ErrorCode.DOWNLOAD_FAILED
    assert caught.value.error_stage == ErrorStage.DIRECT_RESOLVE
    assert caught.value.retryable


def test_direct_resolver_default_covers_short_provider_rate_limit_bursts(monkeypatch) -> None:
    monkeypatch.delenv("DIRECT_RESOLVER_RETRIES", raising=False)

    assert Settings.from_env().direct_resolver_retries == 5


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source_url",
    [
        f"https://www.tiktok.com/@author/video/{TIKTOK_ID}",
        "https://vm.tiktok.com/ZN81M7dbB/",
        f"https://x.com/author/status/{X_ID}/video/1",
        f"https://twitter.com/author/status/{X_ID}",
        "https://www.youtube.com/watch?v=example",
    ],
)
async def test_no_direct_resolver_ships_so_yt_dlp_handles_every_source(source_url) -> None:
    assert await resolve_direct_media(source_url, max_bytes=20_000_000, resolve_dns=False, retries=0) is None


@pytest.mark.asyncio
async def test_direct_download_deadline_removes_partial_file(tmp_path) -> None:
    async def slow_response(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: video/mp4\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n"
            b"1\r\nx\r\n"
        )
        await writer.drain()
        try:
            await reader.read()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(slow_response, "127.0.0.1", 0)
    port = int(server.sockets[0].getsockname()[1])
    target = tmp_path / "partial.mp4"
    try:
        with pytest.raises(DownloadError) as caught:
            await download_direct_media(
                f"http://127.0.0.1:{port}/media.mp4",
                target,
                max_bytes=1_024,
                timeout_seconds=0.02,
            )
        assert caught.value.code == ErrorCode.DOWNLOAD_TIMEOUT
        assert not target.exists()
    finally:
        server.close()
        await server.wait_closed()
