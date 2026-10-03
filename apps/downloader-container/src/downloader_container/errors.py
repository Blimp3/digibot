"""Stable application errors exposed by the downloader service.

The service deliberately keeps internal process output out of this module's
messages.  Callers can safely use ``error_code`` for programmatic handling and
``safe_message`` for user-facing responses.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    INVALID_URL = "INVALID_URL"
    UNSUPPORTED_HOST = "UNSUPPORTED_HOST"
    UNAUTHORIZED_REQUEST = "UNAUTHORIZED_REQUEST"
    INVALID_REQUEST = "INVALID_REQUEST"
    INVALID_TIME_RANGE = "INVALID_TIME_RANGE"
    START_BEYOND_DURATION = "START_BEYOND_DURATION"
    UNSUPPORTED_MEDIA = "UNSUPPORTED_MEDIA"
    PLAYLIST_NOT_ALLOWED = "PLAYLIST_NOT_ALLOWED"
    LIVE_STREAM_NOT_SUPPORTED = "LIVE_STREAM_NOT_SUPPORTED"
    LOGIN_REQUIRED = "LOGIN_REQUIRED"
    MEDIA_PRIVATE = "MEDIA_PRIVATE"
    MEDIA_UNAVAILABLE = "MEDIA_UNAVAILABLE"
    CAPTIONS_UNAVAILABLE = "CAPTIONS_UNAVAILABLE"
    CAPTION_LANGUAGE_UNAVAILABLE = "CAPTION_LANGUAGE_UNAVAILABLE"
    SOURCE_RATE_LIMITED = "SOURCE_RATE_LIMITED"
    SOURCE_BLOCKED_SERVER = "SOURCE_BLOCKED_SERVER"
    SOURCE_NETWORK_BLOCKED = "SOURCE_NETWORK_BLOCKED"
    DURATION_LIMIT = "DURATION_LIMIT"
    SOURCE_SIZE_LIMIT = "SOURCE_SIZE_LIMIT"
    DOWNLOAD_TIMEOUT = "DOWNLOAD_TIMEOUT"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    DENO_MISSING = "DENO_MISSING"
    EJS_MISSING = "EJS_MISSING"
    FFMPEG_MISSING = "FFMPEG_MISSING"
    FFPROBE_MISSING = "FFPROBE_MISSING"
    PROCESS_TIMEOUT = "PROCESS_TIMEOUT"
    PROCESSING_FAILED = "PROCESSING_FAILED"
    TELEGRAM_FILE_TOO_LARGE = "TELEGRAM_FILE_TOO_LARGE"
    TELEGRAM_RATE_LIMITED = "TELEGRAM_RATE_LIMITED"
    TELEGRAM_UPLOAD_FAILED = "TELEGRAM_UPLOAD_FAILED"
    TELEGRAM_AUTH_FAILED = "TELEGRAM_AUTH_FAILED"
    R2_UPLOAD_FAILED = "R2_UPLOAD_FAILED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class ErrorStage(StrEnum):
    """Bounded stages used by diagnostics.

    These values are intentionally operational categories rather than free-form
    exception text.  They are safe to persist in structured logs and make a
    failure searchable without exposing the source URL or child-process output.
    """

    REQUEST = "request"
    DEPENDENCY_CHECK = "dependency_check"
    DIRECT_RESOLVE = "direct_resolve"
    PROBE = "probe"
    FORMAT_SELECTION = "format_selection"
    DOWNLOAD_PROCESS = "download_process"
    DOWNLOAD_OUTPUT = "download_output"
    MEDIA_VERIFY = "media_verify"
    TRANSCODE = "transcode"
    STAGING = "staging"
    TELEGRAM_DELIVERY = "telegram_delivery"
    R2_UPLOAD = "r2_upload"
    INTERNAL = "internal"


class FailureReason(StrEnum):
    """Bounded, privacy-safe failure classifications for diagnostics."""

    INVALID_INPUT = "invalid_input"
    UNAUTHORIZED = "unauthorized"
    UNSUPPORTED_SOURCE = "unsupported_source"
    UNSUPPORTED_MEDIA = "unsupported_media"
    AUTH_REQUIRED = "auth_required"
    MEDIA_PRIVATE = "media_private"
    SOURCE_UNAVAILABLE = "source_unavailable"
    NO_FORMATS = "no_formats"
    JS_CHALLENGE_FAILED = "js_challenge_failed"
    NETWORK_ERROR = "network_error"
    INVALID_PROBE_OUTPUT = "invalid_probe_output"
    INVALID_PROBE_METADATA = "invalid_probe_metadata"
    SOURCE_RATE_LIMITED = "source_rate_limited"
    HTTP_FORBIDDEN = "http_forbidden"
    SOURCE_BLOCKED = "source_blocked"
    NETWORK_BLOCKED = "network_blocked"
    LIMIT_EXCEEDED = "limit_exceeded"
    TIMEOUT = "timeout"
    PROCESS_FAILED = "process_failed"
    DEPENDENCY_MISSING = "dependency_missing"
    MEDIA_PROCESSING_FAILED = "media_processing_failed"
    TELEGRAM_RATE_LIMITED = "telegram_rate_limited"
    TELEGRAM_FAILURE = "telegram_failure"
    STORAGE_FAILURE = "storage_failure"
    INTERNAL = "internal"


SAFE_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.INVALID_URL: "The link is not a valid public HTTP or HTTPS URL.",
    ErrorCode.UNSUPPORTED_HOST: "This source is not permitted for cloud downloads.",
    ErrorCode.UNAUTHORIZED_REQUEST: "The internal request is not authorized.",
    ErrorCode.INVALID_REQUEST: "The download request is invalid.",
    ErrorCode.INVALID_TIME_RANGE: "That time range cannot be applied to this media. Use a valid range within a media item with a known duration.",
    ErrorCode.START_BEYOND_DURATION: "The requested start is at or beyond the end of this media. Choose an earlier start.",
    ErrorCode.UNSUPPORTED_MEDIA: "This media type is not supported.",
    ErrorCode.PLAYLIST_NOT_ALLOWED: "Playlists and channels are not supported.",
    ErrorCode.LIVE_STREAM_NOT_SUPPORTED: "Live streams are not supported.",
    ErrorCode.LOGIN_REQUIRED: "This media requires sign-in. Send a public media link that can be opened without signing in.",
    ErrorCode.MEDIA_PRIVATE: "This media is private or is not available to the bot.",
    ErrorCode.MEDIA_UNAVAILABLE: "The source media is unavailable.",
    ErrorCode.CAPTIONS_UNAVAILABLE: "No supported source captions are available.",
    ErrorCode.CAPTION_LANGUAGE_UNAVAILABLE: "The requested caption language is unavailable.",
    ErrorCode.SOURCE_RATE_LIMITED: "The source is rate limiting the cloud server. Try again later.",
    ErrorCode.SOURCE_BLOCKED_SERVER: "The source blocked the cloud server. Try again later or send a link from another supported source.",
    ErrorCode.SOURCE_NETWORK_BLOCKED: "The source address is not permitted.",
    ErrorCode.DURATION_LIMIT: "The media is longer than the configured limit.",
    ErrorCode.SOURCE_SIZE_LIMIT: "The source file is larger than the configured limit.",
    ErrorCode.DOWNLOAD_TIMEOUT: "The source took too long to download.",
    ErrorCode.DOWNLOAD_FAILED: "The source download failed.",
    ErrorCode.DENO_MISSING: "The required Deno JavaScript runtime is unavailable.",
    ErrorCode.EJS_MISSING: "The yt-dlp JavaScript challenge component is unavailable.",
    ErrorCode.FFMPEG_MISSING: "FFmpeg is unavailable for media processing.",
    ErrorCode.FFPROBE_MISSING: "FFprobe is unavailable for media verification.",
    ErrorCode.PROCESS_TIMEOUT: "Media processing timed out.",
    ErrorCode.PROCESSING_FAILED: "The downloaded media could not be processed.",
    ErrorCode.TELEGRAM_FILE_TOO_LARGE: "The processed file is too large for direct Telegram delivery.",
    ErrorCode.TELEGRAM_RATE_LIMITED: "Telegram is rate limiting the bot. Try again later.",
    ErrorCode.TELEGRAM_UPLOAD_FAILED: "Telegram could not accept the processed media.",
    ErrorCode.TELEGRAM_AUTH_FAILED: "Telegram bot authentication failed.",
    ErrorCode.R2_UPLOAD_FAILED: "Temporary link delivery is unavailable.",
    ErrorCode.INTERNAL_ERROR: "The downloader encountered an internal error.",
}


_DEFAULT_DIAGNOSTICS: dict[ErrorCode, tuple[ErrorStage, FailureReason]] = {
    ErrorCode.INVALID_URL: (ErrorStage.REQUEST, FailureReason.INVALID_INPUT),
    ErrorCode.UNSUPPORTED_HOST: (ErrorStage.REQUEST, FailureReason.UNSUPPORTED_SOURCE),
    ErrorCode.UNAUTHORIZED_REQUEST: (ErrorStage.REQUEST, FailureReason.UNAUTHORIZED),
    ErrorCode.INVALID_REQUEST: (ErrorStage.REQUEST, FailureReason.INVALID_INPUT),
    ErrorCode.INVALID_TIME_RANGE: (ErrorStage.REQUEST, FailureReason.INVALID_INPUT),
    ErrorCode.START_BEYOND_DURATION: (ErrorStage.PROBE, FailureReason.INVALID_INPUT),
    ErrorCode.UNSUPPORTED_MEDIA: (ErrorStage.FORMAT_SELECTION, FailureReason.UNSUPPORTED_MEDIA),
    ErrorCode.PLAYLIST_NOT_ALLOWED: (ErrorStage.PROBE, FailureReason.UNSUPPORTED_MEDIA),
    ErrorCode.LIVE_STREAM_NOT_SUPPORTED: (ErrorStage.PROBE, FailureReason.UNSUPPORTED_MEDIA),
    ErrorCode.LOGIN_REQUIRED: (ErrorStage.PROBE, FailureReason.AUTH_REQUIRED),
    ErrorCode.MEDIA_PRIVATE: (ErrorStage.PROBE, FailureReason.MEDIA_PRIVATE),
    ErrorCode.MEDIA_UNAVAILABLE: (ErrorStage.PROBE, FailureReason.SOURCE_UNAVAILABLE),
    ErrorCode.CAPTIONS_UNAVAILABLE: (ErrorStage.PROBE, FailureReason.SOURCE_UNAVAILABLE),
    ErrorCode.CAPTION_LANGUAGE_UNAVAILABLE: (ErrorStage.PROBE, FailureReason.SOURCE_UNAVAILABLE),
    ErrorCode.SOURCE_RATE_LIMITED: (ErrorStage.PROBE, FailureReason.SOURCE_RATE_LIMITED),
    ErrorCode.SOURCE_BLOCKED_SERVER: (ErrorStage.PROBE, FailureReason.SOURCE_BLOCKED),
    ErrorCode.SOURCE_NETWORK_BLOCKED: (ErrorStage.DIRECT_RESOLVE, FailureReason.NETWORK_BLOCKED),
    ErrorCode.DURATION_LIMIT: (ErrorStage.PROBE, FailureReason.LIMIT_EXCEEDED),
    ErrorCode.SOURCE_SIZE_LIMIT: (ErrorStage.DOWNLOAD_OUTPUT, FailureReason.LIMIT_EXCEEDED),
    ErrorCode.DOWNLOAD_TIMEOUT: (ErrorStage.DOWNLOAD_PROCESS, FailureReason.TIMEOUT),
    ErrorCode.DOWNLOAD_FAILED: (ErrorStage.DOWNLOAD_PROCESS, FailureReason.PROCESS_FAILED),
    ErrorCode.DENO_MISSING: (ErrorStage.DEPENDENCY_CHECK, FailureReason.DEPENDENCY_MISSING),
    ErrorCode.EJS_MISSING: (ErrorStage.DEPENDENCY_CHECK, FailureReason.DEPENDENCY_MISSING),
    ErrorCode.FFMPEG_MISSING: (ErrorStage.DEPENDENCY_CHECK, FailureReason.DEPENDENCY_MISSING),
    ErrorCode.FFPROBE_MISSING: (ErrorStage.DEPENDENCY_CHECK, FailureReason.DEPENDENCY_MISSING),
    ErrorCode.PROCESS_TIMEOUT: (ErrorStage.MEDIA_VERIFY, FailureReason.TIMEOUT),
    ErrorCode.PROCESSING_FAILED: (ErrorStage.MEDIA_VERIFY, FailureReason.MEDIA_PROCESSING_FAILED),
    ErrorCode.TELEGRAM_FILE_TOO_LARGE: (ErrorStage.TELEGRAM_DELIVERY, FailureReason.LIMIT_EXCEEDED),
    ErrorCode.TELEGRAM_RATE_LIMITED: (ErrorStage.TELEGRAM_DELIVERY, FailureReason.TELEGRAM_RATE_LIMITED),
    ErrorCode.TELEGRAM_UPLOAD_FAILED: (ErrorStage.TELEGRAM_DELIVERY, FailureReason.TELEGRAM_FAILURE),
    ErrorCode.TELEGRAM_AUTH_FAILED: (ErrorStage.TELEGRAM_DELIVERY, FailureReason.UNAUTHORIZED),
    ErrorCode.R2_UPLOAD_FAILED: (ErrorStage.R2_UPLOAD, FailureReason.STORAGE_FAILURE),
    ErrorCode.INTERNAL_ERROR: (ErrorStage.INTERNAL, FailureReason.INTERNAL),
}


@dataclass(slots=True)
class DownloadError(Exception):
    """An expected failure with a stable, redacted response."""

    code: ErrorCode
    detail: str | None = None
    retryable: bool = False
    error_stage: ErrorStage | None = None
    failure_reason: FailureReason | None = None
    process_name: str | None = None
    process_exit_code: int | None = None
    process_timed_out: bool | None = None
    available_languages: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        default_stage, default_reason = _DEFAULT_DIAGNOSTICS[self.code]
        if self.error_stage is None:
            self.error_stage = default_stage
        if self.failure_reason is None:
            self.failure_reason = default_reason
        Exception.__init__(self, self.safe_message)

    @property
    def safe_message(self) -> str:
        message = SAFE_MESSAGES[self.code]
        if self.code == ErrorCode.CAPTION_LANGUAGE_UNAVAILABLE and self.available_languages:
            message += " Available: " + ", ".join(self.available_languages[:12]) + "."
        return message

    def as_dict(self) -> dict[str, object]:
        return {
            "status": "failed",
            "errorCode": self.code.value,
            "safeMessage": self.safe_message,
            "retryable": self.retryable,
        }

    def diagnostic_fields(self) -> dict[str, Any]:
        """Return only bounded fields intended for structured diagnostics."""

        stage = self.error_stage
        reason = self.failure_reason
        if not isinstance(stage, ErrorStage):
            try:
                stage = ErrorStage(stage) if stage is not None else None
            except ValueError:
                stage = None
        if not isinstance(reason, FailureReason):
            try:
                reason = FailureReason(reason) if reason is not None else None
            except ValueError:
                reason = None
        fields: dict[str, Any] = {
            "error_stage": stage.value if stage is not None else ErrorStage.INTERNAL.value,
            "failure_reason": reason.value if reason is not None else FailureReason.INTERNAL.value,
        }
        if self.process_name in {"yt-dlp", "ffmpeg", "ffprobe"}:
            fields["process_name"] = self.process_name
        if type(self.process_exit_code) is int and -(2**31) <= self.process_exit_code < 2**31:
            fields["process_exit_code"] = self.process_exit_code
        if isinstance(self.process_timed_out, bool):
            fields["process_timed_out"] = self.process_timed_out
        return fields


# Known yt-dlp/FFmpeg output markers; the first row with any marker wins.
_PROCESS_OUTPUT_ERRORS: tuple[tuple[tuple[str, ...], ErrorCode, bool, FailureReason | None], ...] = (
    (("sign in to confirm", "login required", "requiring login", "requires login", "--cookies-from-browser"),
     ErrorCode.LOGIN_REQUIRED, False, None),
    (("private video", "this video is private"), ErrorCode.MEDIA_PRIVATE, False, None),
    (("confirm you are not a bot", "captcha"), ErrorCode.SOURCE_BLOCKED_SERVER, False, None),
    (("too many requests", "http error 429"), ErrorCode.SOURCE_RATE_LIMITED, True, None),
    (("http error 403", "http 403", "403: forbidden"), ErrorCode.DOWNLOAD_FAILED, True, FailureReason.HTTP_FORBIDDEN),
)

# Diagnostic evidence only: these markers never change the public error or retries.
_PROBE_OUTPUT_REASONS: tuple[tuple[tuple[str, ...], FailureReason], ...] = (
    (("requested format is not available", "no video formats found", "only images are available"), FailureReason.NO_FORMATS),
    (("challenge solving failed", "nsig extraction failed", "signature extraction failed"), FailureReason.JS_CHALLENGE_FAILED),
    (("unsupported url",), FailureReason.UNSUPPORTED_SOURCE),
    (("unable to download webpage", "unable to download api page", "connection refused", "certificate verify failed"), FailureReason.NETWORK_ERROR),
    (("video unavailable", "video is not available", "this video is unavailable"), FailureReason.SOURCE_UNAVAILABLE),
)


def error_from_process_output(output: str, *, probe: bool = False) -> DownloadError:
    """Map known yt-dlp/FFmpeg text to stable errors without returning it."""

    lowered = output.lower()
    stage = ErrorStage.PROBE if probe else ErrorStage.DOWNLOAD_PROCESS
    for markers, code, retryable, reason in _PROCESS_OUTPUT_ERRORS:
        if any(marker in lowered for marker in markers):
            return DownloadError(code, retryable=retryable, error_stage=stage, failure_reason=reason)
    if "playlist" in lowered and "not allowed" in lowered:
        return DownloadError(ErrorCode.PLAYLIST_NOT_ALLOWED, error_stage=stage)
    reason = FailureReason.PROCESS_FAILED
    if probe:
        reason = next((reason for markers, reason in _PROBE_OUTPUT_REASONS if any(marker in lowered for marker in markers)), reason)
    return DownloadError(
        ErrorCode.MEDIA_UNAVAILABLE if probe else ErrorCode.DOWNLOAD_FAILED,
        retryable=True,
        error_stage=stage,
        failure_reason=reason,
    )
