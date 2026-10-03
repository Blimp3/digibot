"""Direct, token-safe Telegram Bot API multipart delivery."""

from __future__ import annotations

import html
import json
import re
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx

from .deadline import JobDeadlineExceeded, current_deadline
from .errors import DownloadError, ErrorCode
from .models import MediaMetadata, MediaMode, ProbeInfo
from .security import sanitize_filename, validate_service_origin

PHOTO_MIME_TYPES = frozenset({"image/jpeg", "image/png"})


@dataclass(frozen=True, slots=True)
class TelegramMessage:
    message_id: int
    file_id: str | None = None
    media_method: str | None = None


MAX_SAFE_TELEGRAM_MESSAGE_ID = 2**53 - 1


def _safe_retry_after(value: object) -> int | None:
    """Accept only a JSON integer that can be represented safely downstream."""

    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= MAX_SAFE_TELEGRAM_MESSAGE_ID:
        return None
    return value


class TelegramApiError(DownloadError):
    def __init__(
        self,
        code: ErrorCode,
        *,
        retryable: bool = False,
        retry_after: int | None = None,
        status_code: int | None = None,
        outcome: Literal["rejected", "ambiguous"] | None = None,
    ) -> None:
        self.retry_after = _safe_retry_after(retry_after)
        self.status_code = status_code
        if outcome is None:
            outcome = (
                "rejected"
                if code in {ErrorCode.TELEGRAM_AUTH_FAILED, ErrorCode.TELEGRAM_FILE_TOO_LARGE, ErrorCode.TELEGRAM_RATE_LIMITED}
                or (status_code is not None and 400 <= status_code < 500 and status_code != 408)
                else "ambiguous"
            )
        self.outcome: Literal["rejected", "ambiguous"] = outcome
        super().__init__(code, retryable=retryable)

def validate_telegram_message_id(value: object) -> int:
    """Return a positive, JavaScript-safe Telegram message ID."""

    if isinstance(value, bool):
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
    if isinstance(value, int):
        message_id = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        try:
            message_id = int(value)
        except ValueError as exc:
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED) from exc
    else:
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
    if not 0 < message_id <= MAX_SAFE_TELEGRAM_MESSAGE_ID:
        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
    return message_id


def _source_platform(probe: ProbeInfo) -> str:
    extractor = (probe.extractor or "source").lower()
    aliases = {
        "youtube": "YouTube",
        "instagram": "Instagram",
        "tiktok": "TikTok",
        "twitter": "X",
        "vimeo": "Vimeo",
        "reddit": "Reddit",
        "pinterest": "Pinterest",
        "ted": "TED",
        "tedtalk": "TED",
        "tedembed": "TED",
        "tedseries": "TED",
        "tedplaylist": "TED",
    }
    return aliases.get(extractor, sanitize_filename(probe.extractor or "source", fallback="source", max_length=32))


def build_caption(probe: ProbeInfo, metadata: MediaMetadata) -> str:
    title = sanitize_filename(probe.title, fallback="media", max_length=180)
    platform = _source_platform(probe)
    parts = [title, f"Source: {platform}"]
    if metadata.transcript_preview is not None:
        parts.extend(["Timestamped transcript", "", metadata.transcript_preview])
        return "\n".join(parts)[:1_024]
    if metadata.duration is not None:
        parts.append(f"Duration: {int(metadata.duration // 60)}:{int(metadata.duration % 60):02d}")
    if metadata.trim_start_seconds is not None and metadata.trim_end_seconds is not None:
        times = []
        for value in (metadata.trim_start_seconds, metadata.trim_end_seconds):
            hours, remainder = divmod(round(value * 1000), 3_600_000)
            minutes, remainder = divmod(remainder, 60_000)
            seconds, milliseconds = divmod(remainder, 1000)
            fraction = f".{milliseconds:03d}".rstrip("0") if milliseconds else ""
            times.append(f"{hours:02d}:{minutes:02d}:{seconds:02d}{fraction}")
        parts.append(f"Clip: {times[0]}–{times[1]}")
        if metadata.trim_end_clamped:
            parts.append("Stopped at the end of the media; the requested end was later.")
    if metadata.width and metadata.height:
        parts.append(f"Resolution: {metadata.width}x{metadata.height}")
    # Telegram captions are limited; truncate by code points after all fields
    # are sanitized and contain no source query parameters.
    return "\n".join(parts)[:1_024]


class TelegramClient:
    def __init__(
        self,
        token: str,
        *,
        api_base: str = "https://api.telegram.org",
        timeout_seconds: float = 600,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.token = token
        self.api_base = validate_service_origin(api_base, allow_loopback_http=True)
        self.timeout_seconds = timeout_seconds
        self._client = client
        if not self.token:
            raise DownloadError(ErrorCode.TELEGRAM_AUTH_FAILED)

    def _url(self, method: str) -> str:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{1,63}", method):
            raise ValueError("invalid Telegram method")
        # Keep this local variable private; never log or include it in errors.
        return f"{self.api_base}/bot{self.token}/{method}"

    async def _post(
        self,
        method: str,
        *,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, Any, str]] | None = None,
        json_body: dict[str, object] | None = None,
        max_request_bytes: int | None = None,
    ) -> dict[str, Any]:
        own_client = self._client is None
        deadline = current_deadline()
        client_timeout = self.timeout_seconds
        if deadline is not None:
            client_timeout = deadline.budget(client_timeout)
        client = self._client or httpx.AsyncClient(timeout=client_timeout, follow_redirects=False)
        try:
            try:
                if max_request_bytes is None:
                    operation = client.post(self._url(method), data=data, files=files, json=json_body)
                else:
                    if type(max_request_bytes) is not int or max_request_bytes <= 0:
                        raise TelegramApiError(ErrorCode.TELEGRAM_FILE_TOO_LARGE, outcome="rejected")
                    request = client.build_request("POST", self._url(method), data=data, files=files, json=json_body)
                    raw_length = request.headers.get("content-length")
                    if raw_length is None or not raw_length.isdigit():
                        raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="rejected")
                    if int(raw_length) > max_request_bytes:
                        raise TelegramApiError(ErrorCode.TELEGRAM_FILE_TOO_LARGE, outcome="rejected")
                    operation = client.send(request)
                if deadline is None:
                    response = await operation
                else:
                    response = await deadline.run(
                        operation,
                        timeout_seconds=self.timeout_seconds,
                    )
            except JobDeadlineExceeded:
                raise
            except (httpx.TimeoutException, httpx.NetworkError, TimeoutError) as exc:
                raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, retryable=True) from exc
        finally:
            if own_client:
                await client.aclose()
        try:
            if deadline is not None:
                deadline.ensure_remaining()
            payload = response.json()
        except JobDeadlineExceeded:
            raise
        except (ValueError, json.JSONDecodeError) as exc:
            if response.status_code == 429:
                raise TelegramApiError(
                    ErrorCode.TELEGRAM_RATE_LIMITED,
                    retryable=True,
                    status_code=response.status_code,
                ) from exc
            raise TelegramApiError(
                ErrorCode.TELEGRAM_UPLOAD_FAILED,
                retryable=response.status_code >= 500,
                status_code=response.status_code,
            ) from exc
        if not isinstance(payload, dict):
            if response.status_code == 429:
                raise TelegramApiError(
                    ErrorCode.TELEGRAM_RATE_LIMITED,
                    retryable=True,
                    status_code=response.status_code,
                )
            raise TelegramApiError(
                ErrorCode.TELEGRAM_UPLOAD_FAILED,
                retryable=response.status_code >= 500,
                status_code=response.status_code,
            )
        payload_error_code = payload.get("error_code")
        error_code = (
            response.status_code
            if response.status_code >= 400
            else payload_error_code
            if isinstance(payload_error_code, int) and not isinstance(payload_error_code, bool)
            else response.status_code
        )
        if error_code == 401:
            raise TelegramApiError(ErrorCode.TELEGRAM_AUTH_FAILED, status_code=error_code)
        if error_code == 413:
            raise TelegramApiError(ErrorCode.TELEGRAM_FILE_TOO_LARGE, status_code=error_code)
        if error_code == 429:
            params = payload.get("parameters")
            retry_after = params.get("retry_after") if isinstance(params, dict) else None
            raise TelegramApiError(
                ErrorCode.TELEGRAM_RATE_LIMITED,
                retryable=True,
                retry_after=retry_after,
                status_code=error_code,
            )
        if error_code >= 500:
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, retryable=True, status_code=error_code)
        if not 200 <= response.status_code < 300 or payload.get("ok") is not True:
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, status_code=error_code)
        return payload

    async def send_media(
        self,
        *,
        chat_id: str,
        path: str | Path,
        metadata: MediaMetadata,
        probe: ProbeInfo,
        mode: MediaMode,
        force_document: bool = False,
    ) -> TelegramMessage:
        path_obj = Path(path)
        if not path_obj.is_file() or path_obj.is_symlink():
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        caption = build_caption(probe, metadata)
        if force_document:
            method, field, extras = "sendDocument", "document", {}
        elif mode == MediaMode.VIDEO and metadata.mime_type == "video/mp4":
            method, field, extras = "sendVideo", "video", {"supports_streaming": "true"}
        elif mode == MediaMode.AUDIO and metadata.mime_type.startswith("audio/"):
            method, field, extras = "sendAudio", "audio", {}
        elif metadata.mime_type in PHOTO_MIME_TYPES:
            method, field, extras = "sendPhoto", "photo", {}
        else:
            method, field, extras = "sendDocument", "document", {}
        data = {"chat_id": str(chat_id), "caption": caption, **extras}
        with path_obj.open("rb") as handle:
            payload = await self._post(
                method,
                data=data,
                files={field: (sanitize_filename(metadata.filename), handle, metadata.mime_type)},
            )
        result = payload.get("result") or {}
        return self._message_from_result(result, method, field)

    async def send_media_group(
        self,
        *,
        chat_id: str,
        clips: list[tuple[Path, MediaMetadata]],
        probe: ProbeInfo,
        max_bytes: int,
    ) -> list[TelegramMessage]:
        """Send one complete, ordered MP4 album without an internal retry."""

        if not 2 <= len(clips) <= 3 or not re.fullmatch(r"[1-9][0-9]*", chat_id):
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="rejected")
        expected_chat_id = int(chat_id)
        if expected_chat_id > MAX_SAFE_TELEGRAM_MESSAGE_ID:
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="rejected")
        captions: list[str] = []
        media: list[dict[str, object]] = []
        with ExitStack() as stack:
            files: dict[str, tuple[str, Any, str]] = {}
            for index, (path, metadata) in enumerate(clips, start=1):
                if (
                    not path.is_file()
                    or path.is_symlink()
                    or metadata.mime_type != "video/mp4"
                    or not metadata.has_video
                    or metadata.size_bytes <= 0
                    or path.stat().st_size != metadata.size_bytes
                    or metadata.trim_start_seconds is None
                    or metadata.trim_end_seconds is None
                    or not 0 < metadata.trim_end_seconds - metadata.trim_start_seconds <= 120
                ):
                    raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="rejected")
                caption = f"Clip {index}/{len(clips)}\n{build_caption(probe, metadata.model_copy(update={'transcript_preview': None}))}"[:1_024]
                if "\nClip: " not in f"\n{caption}":
                    raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="rejected")
                attachment = f"clip_{index}"
                captions.append(caption)
                media.append({
                    "type": "video",
                    "media": f"attach://{attachment}",
                    "caption": caption,
                    "supports_streaming": True,
                })
                files[attachment] = (
                    sanitize_filename(metadata.filename),
                    stack.enter_context(path.open("rb")),
                    metadata.mime_type,
                )
            payload = await self._post(
                "sendMediaGroup",
                data={"chat_id": chat_id, "media": json.dumps(media, separators=(",", ":"))},
                files=files,
                max_request_bytes=max_bytes,
            )
        result = payload.get("result")
        if not isinstance(result, list) or len(result) != len(clips):
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
        messages: list[TelegramMessage] = []
        message_ids: set[int] = set()
        media_group_id: str | None = None
        for item, expected_caption in zip(result, captions, strict=True):
            if not isinstance(item, dict):
                raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
            try:
                message_id = validate_telegram_message_id(item.get("message_id"))
                response_chat = item.get("chat")
                response_video = item.get("video")
                group = item.get("media_group_id")
                if (
                    message_id in message_ids
                    or not isinstance(response_chat, dict)
                    or response_chat.get("type") != "private"
                    or validate_telegram_message_id(response_chat.get("id")) != expected_chat_id
                    or not isinstance(response_video, dict)
                    or not isinstance(response_video.get("file_id"), str)
                    or not response_video["file_id"].strip()
                    or not isinstance(group, str)
                    or not group.strip()
                    or len(group) > 128
                    or any(ord(character) < 0x20 or ord(character) == 0x7F for character in group)
                    or item.get("caption") != expected_caption
                ):
                    raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
            except TelegramApiError:
                raise
            except (TypeError, ValueError):
                raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED) from None
            if media_group_id is None:
                media_group_id = group
            elif group != media_group_id:
                raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
            message_ids.add(message_id)
            messages.append(TelegramMessage(
                message_id,
                file_id=response_video["file_id"],
                media_method="sendMediaGroup",
            ))
        return messages

    @staticmethod
    def _message_from_result(result: Any, method: str, media_field: str | None = None) -> TelegramMessage:
        if not isinstance(result, dict):
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
        message_id = validate_telegram_message_id(result.get("message_id"))
        file_id: str | None = None
        if media_field:
            media = result.get(media_field)
            if isinstance(media, dict) and isinstance(media.get("file_id"), str):
                file_id = media["file_id"]
        return TelegramMessage(message_id, file_id=file_id, media_method=method)

    async def send_video_url(
        self,
        *,
        chat_id: str,
        url: str,
        metadata: MediaMetadata,
        probe: ProbeInfo,
    ) -> TelegramMessage:
        """Ask Telegram to fetch a validated remote MP4 URL directly."""

        payload = await self._post(
            "sendVideo",
            json_body={
                "chat_id": str(chat_id),
                "video": url,
                "caption": build_caption(probe, metadata),
                "supports_streaming": True,
            },
        )
        return self._message_from_result(payload.get("result"), "sendVideo", "video")

    async def send_document(
        self,
        *,
        chat_id: str,
        path: str | Path,
        metadata: MediaMetadata,
        probe: ProbeInfo,
        mode: MediaMode,
    ) -> TelegramMessage:
        return await self.send_media(
            chat_id=chat_id,
            path=path,
            metadata=metadata,
            probe=probe,
            mode=mode,
            force_document=True,
        )

    async def send_download_link(
        self,
        *,
        chat_id: str,
        filename: str,
        size_bytes: int,
        expires_at: str,
        url: str,
    ) -> TelegramMessage:
        safe_name = html.escape(sanitize_filename(filename))
        size_mb = size_bytes / 1_000_000
        text = f"{safe_name} ({size_mb:.1f} MB)\nTemporary link expires: {html.escape(expires_at)}"
        payload = await self._post(
            "sendMessage",
            data={
                "chat_id": str(chat_id),
                "text": text[:4_096],
                "parse_mode": "HTML",
                "reply_markup": json.dumps({"inline_keyboard": [[{"text": "Download", "url": url}]]}),
            },
        )
        result = payload.get("result") or {}
        return self._message_from_result(result, "sendMessage")

    async def send_chat_action(self, *, chat_id: str, action: str) -> None:
        if action not in {"upload_video", "upload_document", "upload_audio", "upload_photo"}:
            raise ValueError("unsupported chat action")
        await self._post("sendChatAction", data={"chat_id": str(chat_id), "action": action})
