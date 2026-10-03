"""Loopback HTTP proxy that pins every outbound connection to a public IP."""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

from .deadline import JobDeadline, JobDeadlineExceeded, current_deadline
from .errors import DownloadError
from .security import resolve_public_addresses

MAX_PROXY_HEADER_BYTES = 64 * 1024
PROXY_CONNECT_TIMEOUT_SECONDS = 15.0
Resolver = Callable[[str, int | None], tuple[str, ...]]
Connector = Callable[[str, int], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


async def _default_connector(address: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    family = socket.AF_INET6 if ipaddress.ip_address(address).version == 6 else socket.AF_INET
    return await asyncio.open_connection(address, port, family=family)


def _parse_connect_target(target: str) -> tuple[str, int]:
    try:
        parsed = urlsplit(f"//{target}")
        if (
            not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
        port = parsed.port or 443
    except ValueError as exc:
        raise ValueError("invalid CONNECT target") from exc
    if not 1 <= port <= 65_535:
        raise ValueError("invalid proxy target port")
    return parsed.hostname, port


async def _relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(64 * 1024):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        with contextlib.suppress(Exception):
            writer.close()
            await writer.wait_closed()


class PublicEgressProxy:
    """Small per-job proxy that revalidates and pins every requested host."""

    def __init__(
        self,
        *,
        resolver: Resolver = resolve_public_addresses,
        connector: Connector = _default_connector,
    ) -> None:
        self._resolver = resolver
        self._connector = connector
        self._server: asyncio.Server | None = None
        self._connections: set[asyncio.StreamWriter] = set()
        self._deadline: JobDeadline | None = None

    @property
    def url(self) -> str:
        if self._server is None or not self._server.sockets:
            raise RuntimeError("egress proxy is not running")
        port = int(self._server.sockets[0].getsockname()[1])
        return f"http://127.0.0.1:{port}"

    async def __aenter__(self) -> PublicEgressProxy:
        self._deadline = current_deadline()
        self._server = await asyncio.start_server(
            self._handle_client,
            host="127.0.0.1",
            port=0,
            limit=MAX_PROXY_HEADER_BYTES,
        )
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._server is not None:
            self._server.close()
        for writer in tuple(self._connections):
            writer.close()
        if self._server is not None:
            await self._server.wait_closed()
        await asyncio.gather(
            *(writer.wait_closed() for writer in tuple(self._connections)),
            return_exceptions=True,
        )
        self._connections.clear()

    async def _connect_public(self, hostname: str, port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        deadline = self._deadline or current_deadline()
        resolution = asyncio.to_thread(self._resolver, hostname, port)
        if deadline is None:
            resolved = await resolution
        else:
            resolved = await deadline.run(resolution)
        addresses = tuple(
            safe_address
            for address in resolved
            for safe_address in resolve_public_addresses(address, port)
        )
        last_error: Exception | None = None
        for address in addresses:
            try:
                connection = self._connector(address, port)
                if deadline is None:
                    return await asyncio.wait_for(connection, timeout=PROXY_CONNECT_TIMEOUT_SECONDS)
                return await deadline.run(connection, timeout_seconds=PROXY_CONNECT_TIMEOUT_SECONDS)
            except (OSError, TimeoutError) as exc:
                if isinstance(exc, JobDeadlineExceeded):
                    raise
                last_error = exc
        raise ConnectionError("public destination unavailable") from last_error

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        upstream: asyncio.StreamWriter | None = None
        deadline = self._deadline or current_deadline()
        try:
            header_read = reader.readuntil(b"\r\n\r\n")
            if deadline is None:
                header = await header_read
            else:
                header = await deadline.run(header_read)
            if len(header) > MAX_PROXY_HEADER_BYTES:
                raise ValueError("proxy header too large")
            lines = header.split(b"\r\n")
            request_line = lines[0].decode("ascii", errors="strict")
            method, target, version = request_line.split(" ", 2)
            if method.upper() == "CONNECT":
                hostname, port = _parse_connect_target(target)
                upstream_reader, upstream = await self._connect_public(hostname, port)
                self._connections.add(upstream)
                writer.write(f"{version} 200 Connection Established\r\n\r\n".encode("ascii"))
                await writer.drain()
            else:
                parsed = urlsplit(target)
                if (
                    parsed.scheme not in {"http", "https"}
                    or not parsed.hostname
                    or parsed.username is not None
                    or parsed.password is not None
                ):
                    raise ValueError("invalid absolute proxy URL")
                if parsed.scheme != "http":
                    raise ValueError("HTTPS proxy requests must use CONNECT")
                port = parsed.port or 80
                upstream_reader, upstream = await self._connect_public(parsed.hostname, port)
                self._connections.add(upstream)
                origin_target = parsed.path or "/"
                if parsed.query:
                    origin_target += f"?{parsed.query}"
                filtered = [
                    line
                    for line in lines[1:]
                    if line and not line.lower().startswith(b"proxy-connection:")
                ]
                upstream.write(
                    f"{method} {origin_target} {version}\r\n".encode("ascii")
                    + b"\r\n".join(filtered)
                    + b"\r\n\r\n"
                )
                await upstream.drain()
            relays = asyncio.gather(_relay(reader, upstream), _relay(upstream_reader, writer))
            if deadline is None:
                await relays
            else:
                await deadline.run(relays)
        except JobDeadlineExceeded:
            pass
        except (DownloadError, ValueError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            with contextlib.suppress(Exception):
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
        finally:
            self._connections.discard(writer)
            writer.close()
            if upstream is not None:
                self._connections.discard(upstream)
                upstream.close()
            await asyncio.gather(
                writer.wait_closed(),
                *(tuple([upstream.wait_closed()]) if upstream is not None else ()),
                return_exceptions=True,
            )
