from __future__ import annotations

import asyncio
import importlib
import json
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from downloader_container.app import create_app
from downloader_container.errors import DownloadError, ErrorCode
from downloader_container.process import ProcessExecutionError, ProcessResult
from downloader_container.service import DownloaderService
from downloader_container.youtube_collection import (
    YouTubeCollectionRequest,
    parse_collection_json,
    resolve_collection,
    youtube_collection_url,
)

PLAYLIST = "https://www.youtube.com/playlist?list=PL1234567890123456"
IDS = ["BaW_jenozKc", "jNQXAC9IVRw", "aqz-KE-bpKQ"]


def collection(**changes):
    return YouTubeCollectionRequest.model_validate({"sourceUrl": PLAYLIST, "kind": "playlist", "count": 3, **changes})


def test_strict_bounds_and_canonical_youtube_inputs(settings):
    for count in (0, 6, -1, True, "3", 3.5):
        with pytest.raises(ValidationError):
            collection(count=count)
    assert youtube_collection_url(settings, collection(sourceUrl=PLAYLIST + "&si=share&index=90")) == PLAYLIST
    for path in ("/@YouTube", "/@YouTube/videos/", "/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw", "/user/Google", "/c/Google"):
        assert youtube_collection_url(settings, collection(sourceUrl=f"https://youtube.com{path}", kind="channel")).endswith("/videos")
    assert youtube_collection_url(settings, collection(sourceUrl="https://youtube.com/watch?v=BaW_jenozKc&list=PL1234567890123456")) == PLAYLIST


@pytest.mark.parametrize(("url", "kind"), [
    ("https://example.com/playlist?list=PL1234567890123456", "playlist"),
    ("https://youtube.com.evil.example/playlist?list=PL1234567890123456", "playlist"),
    ("http://127.0.0.1/playlist?list=PL1234567890123456", "playlist"),
    ("https://youtube.com:8443/playlist?list=PL1234567890123456", "playlist"),
    ("https://user:pass@youtube.com/playlist?list=PL1234567890123456", "playlist"),
    ("https://youtube.com/playlist?list=RDBaW_jenozKc", "playlist"),
    ("https://youtube.com/playlist?list=WL", "playlist"),
    (PLAYLIST + "&list=PL9999999999999999", "playlist"),
    ("https://youtube.com/feed/subscriptions", "channel"),
    ("https://youtube.com/@YouTube/shorts", "channel"),
    ("https://youtube.com/@YouTube/streams", "channel"),
    ("https://youtube.com/@YouTube%2Fvideos", "channel"),
])
def test_rejects_non_youtube_or_unbounded_inputs(settings, url, kind):
    with pytest.raises(DownloadError):
        youtube_collection_url(settings, collection(sourceUrl=url, kind=kind))


def test_parser_keeps_order_deduplicates_and_never_refills():
    entries = [{"id": IDS[0], "ie_key": "Youtube"}, {"id": IDS[0]}, {"id": IDS[1], "availability": "private"}, {"id": IDS[2]}]
    assert parse_collection_json(json.dumps({"_type": "playlist", "entries": entries}), 4) == [IDS[0], IDS[2]]
    for bad in (None, {}, {"_type": "video", "entries": entries}, {"_type": "playlist", "entries": []}):
        with pytest.raises(DownloadError):
            parse_collection_json(json.dumps(bad), 3)
    with pytest.raises(DownloadError) as error:
        parse_collection_json(json.dumps({"_type": "playlist", "entries": entries}), 3)
    assert error.value.code == ErrorCode.SOURCE_SIZE_LIMIT
    for entry in ({"id": "http://127.0.0.1"}, {"id": IDS[0], "ie_key": "Vimeo"}, {"id": IDS[0], "entries": []},
                  {"id": IDS[0], "is_live": True}, {"id": IDS[0], "live_status": "is_upcoming"}, {"id": IDS[0], "availability": "subscriber_only"}):
        with pytest.raises(DownloadError):
            parse_collection_json(json.dumps({"_type": "playlist", "entries": [entry]}), 1)


@pytest.mark.asyncio
async def test_lookup_uses_finite_flat_metadata_public_proxy_and_cleans_workspace(settings, monkeypatch):
    payload = json.dumps({"_type": "playlist", "entries": [{"id": item} for item in IDS]})
    process = AsyncMock(return_value=ProcessResult((), 0, payload, ""))
    monkeypatch.setattr("downloader_container.youtube_collection.run_process", process)
    assert await resolve_collection(settings, collection(), "deno", "/usr/local/bin/deno", None) == IDS
    args = process.await_args.args[0]
    assert "--no-playlist" not in args
    for option in ("--yes-playlist", "--flat-playlist", "--lazy-playlist", "--skip-download", "--ignore-config", "--no-remote-components", "--no-cache-dir"):
        assert option in args
    assert args[args.index("--playlist-items") + 1] == "1:3"
    assert args[args.index("--proxy") + 1].startswith("http://127.0.0.1:")
    assert args[-2:] == ["--", PLAYLIST]
    assert process.await_args.kwargs["max_stdout_bytes"] == 256 * 1024
    assert process.await_args.kwargs["timeout_seconds"] == 18
    assert list(Path(settings.jobs_root).iterdir()) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("timed_out", "output_limited", "code"), [(True, False, ErrorCode.DOWNLOAD_TIMEOUT), (False, True, ErrorCode.SOURCE_SIZE_LIMIT)])
async def test_process_failures_are_bounded_and_cleaned(settings, monkeypatch, timed_out, output_limited, code):
    monkeypatch.setattr("downloader_container.youtube_collection.run_process", AsyncMock(side_effect=ProcessExecutionError(
        ProcessResult((), 1, "", "", timed_out=timed_out, output_limited=output_limited)
    )))
    with pytest.raises(DownloadError) as error:
        await resolve_collection(settings, collection(), "deno", "/usr/local/bin/deno", None)
    assert error.value.code == code
    assert list(Path(settings.jobs_root).iterdir()) == []


@pytest.mark.asyncio
async def test_collection_endpoint_auth_strict_body_and_transcription_exclusion(settings, ready_diagnostics, monkeypatch):
    resolve = AsyncMock(return_value=IDS)
    monkeypatch.setattr(importlib.import_module("downloader_container.app"), "resolve_collection", resolve)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    transport = httpx.ASGITransport(app=create_app(settings, service))
    headers = {"authorization": "Bearer test-internal-secret"}
    body = {"sourceUrl": PLAYLIST, "kind": "playlist", "count": 3}
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        assert (await client.post("/v1/youtube/resolve", json=body)).status_code == 401
        assert (await client.post("/v1/youtube/resolve", content="{}", headers={**headers, "content-type": "text/plain"})).status_code == 415
        for bad in ({**body, "count": 6}, {**body, "count": True}, {**body, "extra": "bad"}, {**body, "kind": "search"}):
            assert (await client.post("/v1/youtube/resolve", json=bad, headers=headers)).status_code == 400
        assert (await client.post("/v1/youtube/resolve", json=body, headers={**headers, "x-digibot-deadline-at": "nan"})).status_code == 400
        assert resolve.await_count == 0
        response = await client.post("/v1/youtube/resolve", json=body, headers=headers)
        assert response.json() == {"status": "success", "videoIds": IDS}
        settings.job_operation = "transcript"
        assert (await client.post("/v1/youtube/resolve", json=body, headers=headers)).json()["errorCode"] == "INVALID_REQUEST"
    assert resolve.await_count == 1


@pytest.mark.asyncio
async def test_concurrent_lookups_are_rejected_instead_of_accumulating(settings, ready_diagnostics, monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()

    async def resolve(*_args):
        started.set()
        await release.wait()
        return IDS

    monkeypatch.setattr(importlib.import_module("downloader_container.app"), "resolve_collection", resolve)
    service = DownloaderService(settings, dependency_provider=lambda _settings: ready_diagnostics)
    transport = httpx.ASGITransport(app=create_app(settings, service))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        body = {"sourceUrl": PLAYLIST, "kind": "playlist", "count": 3}
        headers = {"authorization": "Bearer test-internal-secret"}
        first = asyncio.create_task(client.post("/v1/youtube/resolve", json=body, headers=headers))
        await started.wait()
        second = await client.post("/v1/youtube/resolve", json=body, headers=headers)
        assert second.json()["errorCode"] == "SOURCE_RATE_LIMITED"
        release.set()
        assert (await first).json()["status"] == "success"
