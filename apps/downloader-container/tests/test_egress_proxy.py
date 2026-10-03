from __future__ import annotations

import asyncio
from urllib.parse import urlsplit

import pytest

from downloader_container.egress_proxy import PublicEgressProxy
from downloader_container.errors import DownloadError, ErrorCode


@pytest.mark.asyncio
async def test_proxy_rejects_non_global_resolver_result_before_connecting() -> None:
    connector_calls: list[tuple[str, int]] = []

    async def connector(address: str, port: int):
        connector_calls.append((address, port))
        raise AssertionError("connector must not receive a non-global address")

    proxy = PublicEgressProxy(
        resolver=lambda _host, _port: ("100.64.0.1",),
        connector=connector,
    )

    with pytest.raises(DownloadError) as caught:
        await proxy._connect_public("media.example", 443)

    assert caught.value.code == ErrorCode.SOURCE_NETWORK_BLOCKED
    assert connector_calls == []


@pytest.mark.asyncio
async def test_proxy_blocks_private_destination_at_connect_time() -> None:
    async with PublicEgressProxy() as proxy:
        endpoint = urlsplit(proxy.url)
        reader, writer = await asyncio.open_connection(endpoint.hostname, endpoint.port)
        writer.write(b"CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        await writer.drain()
        response = await reader.readuntil(b"\r\n\r\n")
        assert b"502 Bad Gateway" in response
        writer.close()
        await writer.wait_closed()


@pytest.mark.asyncio
async def test_proxy_connects_to_the_resolved_public_ip_literal() -> None:
    observed: list[tuple[str, int]] = []

    async def echo(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writer.write(await reader.read(4))
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    origin = await asyncio.start_server(echo, "127.0.0.1", 0)
    origin_port = int(origin.sockets[0].getsockname()[1])

    async def connector(address: str, port: int):
        observed.append((address, port))
        return await asyncio.open_connection("127.0.0.1", origin_port)

    async with PublicEgressProxy(
        resolver=lambda _host, _port: ("93.184.216.34",),
        connector=connector,
    ) as proxy:
        endpoint = urlsplit(proxy.url)
        reader, writer = await asyncio.open_connection(endpoint.hostname, endpoint.port)
        writer.write(b"CONNECT media.example:443 HTTP/1.1\r\nHost: media.example\r\n\r\n")
        await writer.drain()
        assert b"200 Connection Established" in await reader.readuntil(b"\r\n\r\n")
        writer.write(b"ping")
        await writer.drain()
        assert await reader.readexactly(4) == b"ping"
        writer.close()
        await writer.wait_closed()

    origin.close()
    await origin.wait_closed()
    assert observed == [("93.184.216.34", 443)]


async def _proxy_roundtrip(proxy: PublicEgressProxy, request: bytes) -> bytes:
    endpoint = urlsplit(proxy.url)
    reader, writer = await asyncio.open_connection(endpoint.hostname, endpoint.port)
    writer.write(request)
    await writer.drain()
    response = await reader.readuntil(b"\r\n\r\n")
    writer.close()
    await writer.wait_closed()
    return response


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "request_line",
    [
        b"GET https://media.example/clip HTTP/1.1",
        b"GET http://user:secret@media.example/clip HTTP/1.1",
        b"GET http://user@media.example/clip HTTP/1.1",
        b"GET http:///clip HTTP/1.1",
        b"GET ftp://media.example/clip HTTP/1.1",
        b"GET /clip HTTP/1.1",
        b"not-a-request-line",
    ],
)
async def test_plain_proxy_rejects_bad_targets_before_connecting(request_line: bytes) -> None:
    connector_calls: list[tuple[str, int]] = []

    async def connector(address: str, port: int):
        connector_calls.append((address, port))
        raise AssertionError("connector must not run for a rejected request")

    async with PublicEgressProxy(resolver=lambda _host, _port: ("93.184.216.34",), connector=connector) as proxy:
        response = await _proxy_roundtrip(proxy, request_line + b"\r\nHost: media.example\r\n\r\n")

    assert response.startswith(b"HTTP/1.1 502 Bad Gateway")
    assert connector_calls == []


@pytest.mark.asyncio
async def test_plain_proxy_forwards_origin_form_without_proxy_headers() -> None:
    received: list[bytes] = []
    observed: list[tuple[str, int]] = []

    async def origin(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        received.append(await reader.readuntil(b"\r\n\r\n"))
        writer.write(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(origin, "127.0.0.1", 0)
    origin_port = int(server.sockets[0].getsockname()[1])

    async def connector(address: str, port: int):
        observed.append((address, port))
        return await asyncio.open_connection("127.0.0.1", origin_port)

    async with PublicEgressProxy(resolver=lambda _host, _port: ("93.184.216.34",), connector=connector) as proxy:
        response = await _proxy_roundtrip(
            proxy,
            b"GET http://media.example:8080/clip/one?quality=720&t=5 HTTP/1.1\r\n"
            b"Host: media.example:8080\r\n"
            b"Proxy-Connection: keep-alive\r\n"
            b"User-Agent: digibot-test\r\n\r\n",
        )

    server.close()
    await server.wait_closed()
    assert response.startswith(b"HTTP/1.1 204 No Content")
    assert observed == [("93.184.216.34", 8080)]
    assert received == [
        b"GET /clip/one?quality=720&t=5 HTTP/1.1\r\n"
        b"Host: media.example:8080\r\n"
        b"User-Agent: digibot-test\r\n\r\n"
    ]
