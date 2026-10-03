"""Bounded retrieval of a Worker-authorized Telegram file."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from .deadline import JobDeadlineExceeded, current_deadline
from .errors import DownloadError, ErrorCode
from .models import TelegramFileSource

TELEGRAM_API_ORIGIN = "https://api.telegram.org"
MAX_TELEGRAM_FILE_BYTES = 20_000_000
MAX_GET_FILE_RESPONSE_BYTES = 64 * 1024
_BOT_TOKEN_RE = re.compile(r"[A-Za-z0-9:_-]{1,256}")
_FILE_PATH_RE = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*")

# HTTPX includes request URLs in its INFO log and HTTP Core can include paths
# at DEBUG. Telegram authenticates in that path, so third-party request logs
# must stay disabled even when the application root logger is verbose.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def _validated_file_path(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 1024 or not _FILE_PATH_RE.fullmatch(value):
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
    if any(segment in {"", ".", ".."} for segment in value.split("/")):
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
    return value


def _strict_positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


async def _bounded_body(response: httpx.Response, *, max_bytes: int) -> bytes:
    length = _strict_positive_int(int(value)) if (value := response.headers.get("content-length", "")).isdigit() else None
    if value and length is None:
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
    if length is not None and length > max_bytes:
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
    content = bytearray()
    async for chunk in response.aiter_bytes(16 * 1024):
        if len(content) + len(chunk) > max_bytes:
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
        content.extend(chunk)
    return bytes(content)


async def _get_file_path(
    client: httpx.AsyncClient,
    source: TelegramFileSource,
    *,
    bot_token: str,
) -> str:
    async with client.stream(
        "POST",
        f"{TELEGRAM_API_ORIGIN}/bot{bot_token}/getFile",
        data={"file_id": source.file_id},
        headers={"Accept": "application/json"},
        follow_redirects=False,
    ) as response:
        if response.status_code != 200:
            raise DownloadError(
                ErrorCode.TELEGRAM_AUTH_FAILED if response.status_code == 401 else ErrorCode.DOWNLOAD_FAILED,
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        if response.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
        body = await _bounded_body(response, max_bytes=MAX_GET_FILE_RESPONSE_BYTES)
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED) from None
    result = payload.get("result") if isinstance(payload, dict) and payload.get("ok") is True else None
    if not isinstance(result, dict):
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
    raw_file_size = result.get("file_size")
    file_size = _strict_positive_int(raw_file_size) if raw_file_size is not None else None
    returned_id = result.get("file_id")
    if (
        not isinstance(returned_id, str)
        or not 0 < len(returned_id) <= 256
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in returned_id)
        or (raw_file_size is not None and file_size != source.file_size)
    ):
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
    return _validated_file_path(result.get("file_path"))


async def _stream_file(
    client: httpx.AsyncClient,
    url: str,
    target: Path,
    source: TelegramFileSource,
    workspace_size: Callable[[], int] | None,
) -> int:
    parent_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        parent_fd = os.open(target.parent, parent_flags)
    except OSError:
        raise DownloadError(ErrorCode.INVALID_REQUEST) from None
    completed = False
    try:
        parent_stat = os.fstat(parent_fd)
        if (
            not stat.S_ISDIR(parent_stat.st_mode)
            or stat.S_IMODE(parent_stat.st_mode) != 0o700
            or parent_stat.st_uid != os.geteuid()
        ):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            target_fd = os.open(target.name, flags, 0o600, dir_fd=parent_fd)
        except OSError:
            raise DownloadError(ErrorCode.INVALID_REQUEST) from None
        try:
            target_stat = os.fstat(target_fd)
            if not stat.S_ISREG(target_stat.st_mode) or stat.S_IMODE(target_stat.st_mode) != 0o600:
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            with os.fdopen(target_fd, "wb", buffering=0) as handle:
                target_fd = -1
                async with client.stream(
                    "GET",
                    url,
                    headers={"Accept-Encoding": "identity"},
                    follow_redirects=False,
                ) as response:
                    if response.status_code != 200 or response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise DownloadError(ErrorCode.DOWNLOAD_FAILED, retryable=response.status_code >= 500)
                    raw_length = response.headers.get("content-length")
                    if raw_length is not None and (not raw_length.isdigit() or int(raw_length) != source.file_size):
                        raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
                    written = 0
                    async for chunk in response.aiter_bytes(64 * 1024):
                        written += len(chunk)
                        if written > source.file_size or written > MAX_TELEGRAM_FILE_BYTES:
                            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
                        handle.write(chunk)
                        if workspace_size is not None:
                            workspace_size()
            if written != source.file_size:
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
            completed = True
            return written
        finally:
            if target_fd >= 0:
                os.close(target_fd)
    finally:
        if not completed:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(target.name, dir_fd=parent_fd)
        os.close(parent_fd)


async def download_telegram_file(
    source: TelegramFileSource,
    target: str | Path,
    *,
    bot_token: str,
    timeout_seconds: float,
    workspace_size: Callable[[], int] | None = None,
    client: httpx.AsyncClient | None = None,
) -> int:
    """Resolve and download exactly one declared Telegram file without redirects."""

    if not _BOT_TOKEN_RE.fullmatch(bot_token):
        raise DownloadError(ErrorCode.TELEGRAM_AUTH_FAILED)
    if source.file_size > MAX_TELEGRAM_FILE_BYTES:
        raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
    target_path = Path(target)
    if target_path.name in {"", ".", ".."}:
        raise DownloadError(ErrorCode.INVALID_REQUEST)
    deadline = current_deadline()
    if deadline is not None:
        timeout_seconds = deadline.budget(timeout_seconds)
    if timeout_seconds <= 0:
        raise DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, retryable=True)

    async def run() -> int:
        own_client = client is None
        http = client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            trust_env=False,
        )
        try:
            file_path = await _get_file_path(http, source, bot_token=bot_token)
            return await _stream_file(
                http,
                f"{TELEGRAM_API_ORIGIN}/file/bot{bot_token}/{file_path}",
                target_path,
                source,
                workspace_size,
            )
        finally:
            if own_client:
                await http.aclose()

    try:
        if deadline is not None:
            return await deadline.run(run(), timeout_seconds=timeout_seconds)
        async with asyncio.timeout(timeout_seconds):
            return await run()
    except JobDeadlineExceeded:
        raise
    except (TimeoutError, httpx.TimeoutException):
        raise DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, retryable=True) from None
    except httpx.HTTPError:
        raise DownloadError(ErrorCode.DOWNLOAD_FAILED, retryable=True) from None
