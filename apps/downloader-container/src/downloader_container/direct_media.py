"""Validated direct-media delivery helpers.

This edition ships no provider-specific resolver: ``resolve_direct_media``
returns ``None`` for every source, so TikTok, X and all other sites go through
yt-dlp.  The generic pieces stay because the service, captions and their tests
use them: the ``DirectMedia`` record, strict provider-URL validation, bounded
response reads and the bounded fallback download.

Provider URLs are kept out of logs and user-facing errors because provider
query strings are short-lived credentials.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .deadline import JobDeadlineExceeded, current_deadline
from .errors import DownloadError, ErrorCode, ErrorStage
from .models import ProbeInfo
from .security import validate_source_url

TIKTOK_MEDIA_HOST_SUFFIXES = (
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "tiktokcdn-in.com",
    "tiktokcdn-asia.com",
    "byteicdn.com",
)
MAX_PROVIDER_URL_LENGTH = 8_192


@dataclass(frozen=True, slots=True)
class DirectMedia:
    """Validated remote media metadata used by the Telegram URL send path."""

    url: str
    filename: str
    mime_type: str
    size_bytes: int
    duration: float | None
    width: int | None
    height: int | None
    probe: ProbeInfo


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float) and value.is_integer() and value > 0:
        return int(value)
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


async def _request_bounded(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    max_bytes: int,
    **kwargs: Any,
) -> httpx.Response:
    """Materialize at most ``max_bytes`` from an untrusted response."""

    async def request() -> httpx.Response:
        async with client.stream(method, url, **kwargs) as response:
            content_length = _positive_int(response.headers.get("content-length"))
            if content_length is not None and content_length > max_bytes:
                raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
            content = bytearray()
            try:
                async for chunk in response.aiter_bytes(64 * 1024):
                    if len(content) + len(chunk) > max_bytes:
                        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
                    content.extend(chunk)
            except httpx.DecodingError as exc:
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED, retryable=True, error_stage=ErrorStage.DIRECT_RESOLVE) from exc
            # ``aiter_bytes`` has already decoded Content-Encoding. Retaining
            # the original compression headers would decode the bytes twice.
            decoded_headers = [
                (name, value)
                for name, value in response.headers.multi_items()
                if name.lower() not in {"content-encoding", "content-length", "transfer-encoding"}
            ]
            return httpx.Response(
                response.status_code,
                headers=decoded_headers,
                content=bytes(content),
                request=response.request,
            )

    deadline = current_deadline()
    return await request() if deadline is None else await deadline.run(request())


async def download_direct_media(
    url: str,
    target: str | Path,
    *,
    max_bytes: int,
    timeout_seconds: float = 60,
    proxy_url: str | None = None,
) -> int:
    """Bounded local fallback download for an explicit Telegram 400.

    Telegram's URL fetch may reject a provider URL even when the resolver's
    metadata is valid.  This fallback is called only after that explicit,
    non-ambiguous rejection; it never follows a redirect to an unvalidated
    host and never logs the URL.
    """

    target_path = Path(target)
    if target_path.exists() or target_path.is_symlink():
        raise DownloadError(ErrorCode.INVALID_REQUEST)
    deadline = current_deadline()
    if deadline is not None:
        timeout_seconds = deadline.budget(timeout_seconds)
    own_client = httpx.AsyncClient(
        timeout=httpx.Timeout(timeout_seconds),
        follow_redirects=False,
        proxy=proxy_url,
    )
    completed = False
    try:
        async with (
            asyncio.timeout(timeout_seconds),
            own_client,
            own_client.stream(
                "GET",
                url,
                follow_redirects=False,
                headers={"User-Agent": "private-media-downloader-container/0.1", "Accept": "video/mp4"},
            ) as response,
        ):
            if response.status_code < 200 or response.status_code >= 300:
                raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type and content_type != "video/mp4":
                raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
            content_length = _positive_int(response.headers.get("content-length"))
            if content_length is not None and content_length > max_bytes:
                raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
            written = 0
            with target_path.open("xb") as handle:
                async for chunk in response.aiter_bytes(64 * 1024):
                    written += len(chunk)
                    if written > max_bytes:
                        raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
                    handle.write(chunk)
            if written <= 0:
                raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
            completed = True
            return written
    except JobDeadlineExceeded:
        raise
    except TimeoutError as exc:
        raise DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, retryable=True) from exc
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise DownloadError(ErrorCode.SOURCE_NETWORK_BLOCKED, retryable=True) from exc
    finally:
        if not completed:
            with contextlib.suppress(FileNotFoundError):
                target_path.unlink()


def _host_in_suffixes(hostname: str, suffixes: tuple[str, ...]) -> bool:
    lowered = hostname.rstrip(".").lower()
    return any(lowered == suffix or lowered.endswith(f".{suffix}") for suffix in suffixes)


def validate_direct_media_url(
    url: str,
    *,
    provider: str,
    resolve_dns: bool = True,
    max_length: int = MAX_PROVIDER_URL_LENGTH,
) -> str:
    """Validate a final provider URL before giving it to Telegram.

    ``provider`` is deliberately explicit so a URL from one service cannot be
    confused with another resolver's output.  X allows exactly
    ``video.twimg.com``; TikTok allows only known CDN suffixes.
    """

    if not isinstance(url, str) or len(url) > max_length:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    parsed = urlsplit(url)
    if parsed.scheme.lower() != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    if parsed.port is not None or not parsed.path or parsed.fragment:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    if provider == "x":
        allowed = parsed.hostname.rstrip(".").lower() == "video.twimg.com"
    elif provider == "tiktok":
        allowed = _host_in_suffixes(parsed.hostname, TIKTOK_MEDIA_HOST_SUFFIXES)
    else:
        raise ValueError("unsupported direct media provider")
    if not allowed:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    try:
        validated = validate_source_url(
            url,
            allowed_hosts={parsed.hostname.rstrip(".").lower()},
            resolve_dns=resolve_dns,
            max_length=max_length,
        )
    except DownloadError:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE) from None
    if validated.port is not None:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
    return validated.normalized


async def resolve_direct_media(
    source_url: str,
    *,
    max_bytes: int,
    timeout_seconds: float = 15,
    resolve_dns: bool = True,
    retries: int = 2,
    proxy_url: str | None = None,
) -> DirectMedia | None:
    """Return ``None``: no direct-media resolver ships in this edition.

    Every source, TikTok and X included, is handled by yt-dlp.  The signature
    and the validated ``telegram_url`` delivery path are kept for a resolver
    that uses a documented provider API.
    """

    return None


__all__ = [
    "DirectMedia",
    "download_direct_media",
    "resolve_direct_media",
    "validate_direct_media_url",
]
