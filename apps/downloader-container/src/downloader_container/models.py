"""Typed HTTP and media pipeline models."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class MediaMode(StrEnum):
    VIDEO = "video"
    AUDIO = "audio"


class PreferredFormat(StrEnum):
    MP4 = "mp4"
    ORIGINAL = "original"
    M4A = "m4a"
    MP3 = "mp3"


JobId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")]
ChatId = Annotated[str, Field(min_length=1, max_length=32, pattern=r"^-?[0-9]{1,31}$")]
CaptionLanguage = Annotated[str, Field(min_length=2, max_length=35, pattern=r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$")]

MessageId = Annotated[int, Field(gt=0, le=2_147_483_647)]


class ClipRange(BaseModel):
    """One requested video clip range, preserved in caller order."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    start_seconds: int = Field(alias="startSeconds", strict=True, ge=0, lt=86400)
    end_seconds: int = Field(alias="endSeconds", strict=True, gt=0, le=86400)

    @model_validator(mode="after")
    def is_bounded(self) -> Self:
        if not 0 < self.end_seconds - self.start_seconds <= 120:
            raise ValueError("each clip requires 0 <= start < end <= 86400 and at most 120 seconds")
        return self


def _validate_clip_ranges(ranges: list[ClipRange]) -> None:
    values = [(clip.start_seconds, clip.end_seconds) for clip in ranges]
    if len(set(values)) != len(values):
        raise ValueError("clip ranges must be distinct")
    if sum(end - start for start, end in values) > 300:
        raise ValueError("total clip duration cannot exceed 300 seconds")


class TelegramFileSource(BaseModel):
    """Opaque Telegram file identity supplied by the trusted Worker."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, populate_by_name=True)

    file_id: str = Field(alias="fileId", min_length=1, max_length=256)
    file_size: int = Field(alias="fileSize", strict=True, gt=0, le=20_000_000)
    file_name: str | None = Field(default=None, alias="fileName", min_length=1, max_length=190)

    @field_validator("file_id", "file_name")
    @classmethod
    def text_is_not_control_data(cls, value: str | None) -> str | None:
        if value is not None and any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
            raise ValueError("Telegram file fields contain control characters")
        return value


class JobRunRequest(BaseModel):
    """Request accepted by the private Worker-to-Container endpoint."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, populate_by_name=True)

    job_id: JobId = Field(alias="jobId")
    source_url: str | None = Field(default=None, alias="sourceUrl", min_length=1, max_length=2048)
    telegram_file: TelegramFileSource | None = Field(default=None, alias="telegramFile")
    telegram_chat_id: ChatId = Field(alias="telegramChatId")
    waiting_message_id: MessageId = Field(alias="waitingMessageId")
    mode: MediaMode
    operation: Literal["download", "transcript"] = "download"
    transcript_method: Literal["whisper", "captions"] = Field(default="whisper", alias="transcriptMethod")
    caption_language: CaptionLanguage | None = Field(default=None, alias="captionLanguage")
    maximum_height: int | None = Field(default=1080, alias="maximumHeight", ge=144, le=2160)
    preferred_format: PreferredFormat | None = Field(default=None, alias="preferredFormat")
    trim_start_seconds: int | None = Field(default=None, alias="trimStartSeconds", strict=True, ge=0, lt=86400)
    trim_end_seconds: int | None = Field(default=None, alias="trimEndSeconds", strict=True, gt=0, le=86400)
    clip_ranges: list[ClipRange] | None = Field(default=None, alias="clipRanges", min_length=2, max_length=3)
    # Optional persisted absolute expiry for a retried prepare operation.
    deadline_at: float | None = Field(default=None, alias="deadlineAt", gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def trim_range_is_complete(self) -> Self:
        if (self.source_url is None) == (self.telegram_file is None):
            raise ValueError("exactly one media source is required")
        if self.telegram_file is not None and self.operation != "download":
            raise ValueError("Telegram files support download operations only")
        _validate_transcript_fields(self)
        start, end = self.trim_start_seconds, self.trim_end_seconds
        if self.operation == "transcript" and (self.mode != MediaMode.AUDIO or start is not None or end is not None):
            raise ValueError("transcription requires full-source audio")
        if (start is None) != (end is None) or (start is not None and end is not None and start >= end):
            raise ValueError("trim requires 0 <= start < end <= 86400 seconds")
        if start is not None and self.preferred_format == PreferredFormat.ORIGINAL:
            raise ValueError("trimmed video requires mp4")
        if self.clip_ranges is not None:
            _validate_clip_ranges(self.clip_ranges)
            if self.operation != "download" or self.mode != MediaMode.VIDEO:
                raise ValueError("clip ranges require a video download")
            if start is not None or end is not None:
                raise ValueError("clip ranges cannot be combined with an ordinary trim")
            if self.preferred_format == PreferredFormat.ORIGINAL:
                raise ValueError("clip ranges require mp4")
        return self

    @field_validator("source_url")
    @classmethod
    def source_url_is_not_control_data(cls, value: str | None) -> str | None:
        if value is not None and any(ord(char) < 0x20 for char in value):
            raise ValueError("source URL contains control characters")
        return value

    @field_validator("preferred_format")
    @classmethod
    def preferred_format_matches_mode(
        cls, value: PreferredFormat | None, info: Any
    ) -> PreferredFormat | None:
        mode = info.data.get("mode")
        if value is None or mode is None:
            return value
        if mode == MediaMode.VIDEO and value not in (PreferredFormat.MP4, PreferredFormat.ORIGINAL):
            raise ValueError("video jobs require mp4 or original")
        if mode == MediaMode.AUDIO and value not in (PreferredFormat.M4A, PreferredFormat.MP3):
            raise ValueError("audio jobs require m4a or mp3")
        return value


class IntegrationAudioSegment(BaseModel):
    """The bounded, integer range requested by the private audio adapter."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    start_seconds: int = Field(alias="startSeconds", strict=True, ge=0, lt=86400)
    end_seconds: int = Field(alias="endSeconds", strict=True, gt=0, le=86400)

    @model_validator(mode="after")
    def is_bounded(self) -> Self:
        if not 0 < self.end_seconds - self.start_seconds <= 60:
            raise ValueError("integration audio ranges are at most 60 seconds")
        return self


IntegrationAccountId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")]


class IntegrationAudioRequest(BaseModel):
    """Private processing-only request; it has no Telegram or D1 job fields."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, populate_by_name=True)

    account_id: IntegrationAccountId = Field(alias="accountId")
    operation_id: JobId = Field(alias="operationId")
    source_url: str = Field(alias="sourceUrl", min_length=1, max_length=2048)
    segment: IntegrationAudioSegment
    expires_at: str = Field(alias="expiresAt", min_length=20, max_length=40)
    deadline_at: float | None = Field(default=None, alias="deadlineAt", gt=0, allow_inf_nan=False)

    @field_validator("source_url")
    @classmethod
    def source_url_is_not_control_data(cls, value: str) -> str:
        if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
            raise ValueError("source URL contains control characters")
        return value

    @field_validator("expires_at")
    @classmethod
    def expiry_is_utc_iso(cls, value: str) -> str:
        from datetime import UTC, datetime

        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("expiresAt must be an ISO timestamp") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("expiresAt must include a timezone")
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")

    @property
    def expires_epoch(self) -> float:
        from datetime import datetime

        return datetime.fromisoformat(self.expires_at.replace("Z", "+00:00")).timestamp()


class JobDeliveryRequest(BaseModel):
    """One non-retryable direct Telegram delivery of a staged artifact."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, populate_by_name=True)

    job_id: JobId = Field(alias="jobId")
    telegram_chat_id: ChatId = Field(alias="telegramChatId")
    object_key: str = Field(
        alias="objectKey",
        min_length=10,
        max_length=320,
        pattern=r"^(?:staged|jobs)/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}/[-A-Za-z0-9._(){}\[\]+@=, ]{1,190}$",
    )
    filename: str = Field(min_length=1, max_length=190)
    mime_type: str = Field(alias="mimeType", min_length=1, max_length=128)
    size_bytes: int = Field(default=0, alias="sizeBytes", ge=0, le=2_000_000_000)
    mode: MediaMode
    operation: Literal["download", "transcript"] = "download"
    transcript_method: Literal["whisper", "captions"] = Field(default="whisper", alias="transcriptMethod")
    caption_language: CaptionLanguage | None = Field(default=None, alias="captionLanguage")
    delivery_mode: str = Field(default="telegram", alias="deliveryMode")
    clip_ranges: list[ClipRange] | None = Field(default=None, alias="clipRanges", min_length=2, max_length=3)
    # New Workers may carry the prepare expiry; older payloads omit it and
    # staged delivery can recover it from the private local manifest.
    deadline_at: float | None = Field(default=None, alias="deadlineAt", gt=0, allow_inf_nan=False)

    @field_validator("delivery_mode")
    @classmethod
    def only_telegram_delivery(cls, value: str) -> str:
        if value not in {"telegram", "telegram_url", "r2"}:
            raise ValueError("unsupported delivery mode")
        return value

    @model_validator(mode="after")
    def transcript_fields_are_compatible(self) -> Self:
        _validate_transcript_fields(self)
        if self.operation == "transcript" and self.delivery_mode != "telegram":
            raise ValueError("transcripts require direct Telegram delivery")
        if self.clip_ranges is not None:
            _validate_clip_ranges(self.clip_ranges)
            if self.operation != "download" or self.mode != MediaMode.VIDEO or self.delivery_mode != "telegram":
                raise ValueError("clip ranges require direct Telegram video delivery")
        return self


def _validate_transcript_fields(request: JobRunRequest | JobDeliveryRequest) -> None:
    if request.operation != "transcript" and {"transcript_method", "caption_language"} & request.model_fields_set:
        raise ValueError("transcript fields require transcript operation")
    if request.caption_language is not None and request.transcript_method != "captions":
        raise ValueError("captionLanguage requires captions")
    if request.operation == "transcript" and request.mode != MediaMode.AUDIO:
        raise ValueError("transcripts require audio mode")


class ProbeFormat(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    format_id: str | None = None
    ext: str | None = None
    height: int | None = None
    width: int | None = None
    vcodec: str | None = None
    acodec: str | None = None
    filesize: int | None = None
    filesize_approx: int | None = None
    tbr: float | None = None
    abr: float | None = None
    protocol: str | None = None


class ProbeInfo(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str = "unknown"
    title: str = "media"
    extractor: str | None = None
    webpage_url: str | None = None
    duration: float | None = None
    is_live: bool | None = None
    entries: list[dict[str, Any]] | None = None
    width: int | None = None
    height: int | None = None
    thumbnail: str | None = None
    formats: list[ProbeFormat] = Field(default_factory=list)


class MediaMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    filename: str
    transcript_preview: str | None = Field(default=None, alias="transcriptPreview", max_length=600)
    mime_type: str = Field(alias="mimeType")
    size_bytes: int = Field(alias="sizeBytes", ge=0)
    duration: float | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)
    has_video: bool = Field(default=False, alias="hasVideo")
    has_audio: bool = Field(default=False, alias="hasAudio")
    first_video_codec: str | None = Field(default=None, alias="firstVideoCodec")
    first_audio_codec: str | None = Field(default=None, alias="firstAudioCodec")
    format_name: str | None = Field(default=None, alias="formatName")
    trim_start_seconds: int | None = Field(default=None, alias="trimStartSeconds", ge=0, lt=86400)
    trim_end_seconds: float | None = Field(default=None, alias="trimEndSeconds", gt=0, le=86400, allow_inf_nan=False)
    trim_end_clamped: bool = Field(default=False, alias="trimEndClamped")


class JobSuccess(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    status: str = "completed"
    delivery: str
    telegram_message_id: int | None = Field(default=None, alias="telegramMessageId")
    object_key: str | None = Field(default=None, alias="objectKey")
    filename: str
    mime_type: str = Field(alias="mimeType")
    size_bytes: int = Field(alias="sizeBytes", ge=0)
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    expires_at: str | None = Field(default=None, alias="expiresAt")
    deadline_at: float | None = Field(default=None, alias="deadlineAt", gt=0, allow_inf_nan=False)
    clip_count: int | None = Field(default=None, alias="clipCount", strict=True, ge=2, le=3)

    @model_validator(mode="after")
    def clip_pack_is_direct_telegram(self) -> Self:
        if self.clip_count is not None and self.delivery != "telegram":
            raise ValueError("clip packs require direct Telegram delivery")
        return self


class JobFailure(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    status: str = "failed"
    error_code: str = Field(alias="errorCode")
    safe_message: str = Field(alias="safeMessage")
    retryable: bool = False
    # Internal preparation diagnostics contain only DownloadError.diagnostic_fields().
    diagnostics: dict[str, Any] | None = None
    # Delivery failures must tell the Worker whether Telegram definitely
    # rejected the request or may have accepted it before the response was
    # lost. Prepare failures leave this field absent.
    outcome: Literal["rejected", "ambiguous"] | None = None
    # A valid Telegram 429 delay can be scheduled durably by the Worker when
    # it does not fit the current in-call deadline.
    retry_after_seconds: int | None = Field(default=None, alias="retryAfterSeconds", gt=0, le=2**53 - 1)


class HealthResponse(BaseModel):
    status: str
    service: str = "downloader-container"
    dependencies: dict[str, Any]
