"""Two-stage download, verification, Telegram delivery, and R2 fallback."""

from __future__ import annotations

import asyncio
import functools
import hashlib
import hmac
import json
import math
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal, Protocol, cast

from .config import Settings
from .deadline import JobDeadline, JobDeadlineExceeded, activate_deadline, current_deadline
from .dependencies import collect_dependency_diagnostics, resolve_js_runtime
from .direct_media import DirectMedia, download_direct_media, resolve_direct_media, validate_direct_media_url
from .egress_proxy import PublicEgressProxy
from .errors import DownloadError, ErrorCode, ErrorStage, FailureReason, error_from_process_output
from .ffprobe import telegram_input_demuxer, verify_media
from .formats import FormatChoice, choose_audio_plan, choose_telegram_video
from .logging_utils import OperationTimer, ProcessName, log_event
from .models import (
    IntegrationAudioRequest,
    JobDeliveryRequest,
    JobFailure,
    JobRunRequest,
    JobSuccess,
    MediaMetadata,
    MediaMode,
    PreferredFormat,
    ProbeInfo,
)
from .probe import DownloadPlan, build_download_args, parse_final_path, probe_media
from .process import ProcessExecutionError, run_process
from .r2 import R2Uploader
from .security import ValidatedUrl, safe_child_path, sanitize_filename, validate_source_url
from .telegram import (
    PHOTO_MIME_TYPES,
    TelegramApiError,
    TelegramClient,
    TelegramMessage,
    validate_telegram_message_id,
)
from .telegram_files import download_telegram_file
from .workspace import JobWorkspace

INTEGRATION_AUDIO_MAX_BYTES = 4 * 1024 * 1024
INTEGRATION_AUDIO_MAX_DURATION_SECONDS = 60.0
CHAT_ACTION_TIMEOUT_SECONDS = 5.0
# Margin around a downloaded trim section; the exact cut is still made locally.
SECTION_PADDING_SECONDS = 2.0
# Known limit: fixed quality floor for the size-capped encode; below it the plain CRF ladder decides.
MIN_VIDEO_KBPS = 150


async def _bounded_await[T](awaitable: Awaitable[T], timeout_seconds: float | None = None) -> T:
    deadline = current_deadline()
    if deadline is None:
        return await awaitable
    return await deadline.run(awaitable, timeout_seconds=timeout_seconds)


async def _bounded_sleep(seconds: float) -> None:
    deadline = current_deadline()
    if deadline is None:
        await asyncio.sleep(seconds)
    else:
        await deadline.sleep(seconds)


DeliveryOutcome = Literal["rejected", "ambiguous"]


def _delivery_outcome_for_error(error: BaseException) -> DeliveryOutcome:
    if isinstance(error, TelegramApiError):
        return error.outcome
    if isinstance(error, DownloadError) and error.code in {
        ErrorCode.TELEGRAM_AUTH_FAILED,
        ErrorCode.TELEGRAM_FILE_TOO_LARGE,
        ErrorCode.TELEGRAM_RATE_LIMITED,
        ErrorCode.R2_UPLOAD_FAILED,
    }:
        return "rejected"
    if isinstance(error, DownloadError) and error.code == ErrorCode.TELEGRAM_UPLOAD_FAILED:
        return "ambiguous"
    return "rejected"


def _retry_after_for_error(error: BaseException) -> int | None:
    return error.retry_after if isinstance(error, TelegramApiError) else None


def _manifest_deadline_at(path: Path) -> float | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("deadlineAt")
    except (OSError, ValueError, TypeError, AttributeError):
        return None
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value) or value <= 0:
        return None
    return float(value)


class MediaDelivery(Protocol):
    async def send_media(
        self,
        *,
        chat_id: str,
        path: str | Path,
        metadata: MediaMetadata,
        probe: ProbeInfo,
        mode: MediaMode,
    ) -> TelegramMessage: ...

    async def send_media_group(
        self, *, chat_id: str, clips: list[tuple[Path, MediaMetadata]], probe: ProbeInfo, max_bytes: int,
    ) -> list[TelegramMessage]: ...

    async def send_document(
        self,
        *,
        chat_id: str,
        path: str | Path,
        metadata: MediaMetadata,
        probe: ProbeInfo,
        mode: MediaMode,
    ) -> TelegramMessage: ...

    async def send_video_url(
        self,
        *,
        chat_id: str,
        url: str,
        metadata: MediaMetadata,
        probe: ProbeInfo,
    ) -> TelegramMessage: ...

    async def send_download_link(
        self,
        *,
        chat_id: str,
        filename: str,
        size_bytes: int,
        expires_at: str,
        url: str,
    ) -> TelegramMessage: ...

    async def send_chat_action(self, *, chat_id: str, action: str) -> None: ...


class ObjectUploader(Protocol):
    async def upload(
        self,
        *,
        job_id: str,
        path: str | Path,
        filename: str,
        mime_type: str,
    ) -> Any: ...


class DependencyProvider(Protocol):
    def __call__(self, settings: Settings) -> dict[str, object]: ...


def _prepare_error(exc: Exception) -> DownloadError:
    """Map a failed prepare to its stable, redacted error."""

    if isinstance(exc, DownloadError):
        return exc
    if isinstance(exc, JobDeadlineExceeded):
        return DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, retryable=True)
    return DownloadError(ErrorCode.INTERNAL_ERROR, error_stage=ErrorStage.INTERNAL, retryable=True)


def _telegram_result(message: TelegramMessage, metadata: MediaMetadata) -> dict[str, object]:
    result: dict[str, object] = {
        "status": "completed",
        "delivery": "telegram",
        "telegramMessageId": str(message.message_id),
        "filename": metadata.filename,
        "mimeType": metadata.mime_type,
        "sizeBytes": metadata.size_bytes,
    }
    if message.file_id:
        result["telegramFileId"] = message.file_id
    if message.media_method:
        result["telegramMediaMethod"] = message.media_method
    return result


def _is_youtube_hostname(hostname: str) -> bool:
    normalized = hostname.lower().rstrip(".")
    return normalized == "youtu.be" or normalized == "youtube.com" or normalized.endswith(".youtube.com")


def _youtube_web_embedded_args(args: list[str], source_url: str, output_dir: Path) -> list[str]:
    """Insert the bounded YouTube client override as an argv option."""

    if not args or source_url not in args or "--output" not in args:
        return args
    source_index = args.index(source_url)
    output_index = args.index("--output")
    if output_index + 1 >= len(args):
        return args
    output_template = Path(args[output_index + 1]).name
    isolated_args = list(args)
    isolated_args[output_index + 1] = str(output_dir / output_template)
    return [*isolated_args[:source_index], "--extractor-args", "youtube:player_client=web_embedded", *isolated_args[source_index:]]


class DownloaderService:
    """One bounded active job at a time for the initial personal deployment."""

    def __init__(
        self,
        settings: Settings,
        *,
        telegram: MediaDelivery | None = None,
        r2: ObjectUploader | None = None,
        dependency_provider: DependencyProvider = collect_dependency_diagnostics,
    ) -> None:
        self.settings = settings
        self.telegram = telegram
        self.r2 = r2
        self.dependency_provider = dependency_provider
        self._active = asyncio.Semaphore(1)
        self._diagnostics: dict[str, object] | None = None

    def diagnostics(self) -> dict[str, object]:
        if self._diagnostics is None:
            self._diagnostics = self.dependency_provider(self.settings)
        return self._diagnostics

    def _deadline_for_expiry(self, deadline_at: float | None) -> JobDeadline:
        if deadline_at is None:
            return JobDeadline.start(self.settings.job_timeout_seconds)
        try:
            return JobDeadline.from_absolute(deadline_at, maximum_seconds=self.settings.job_timeout_seconds)
        except ValueError:
            # Pydantic rejects malformed API values. Keep direct service calls
            # fail-safe by applying the local cap instead of trusting input.
            return JobDeadline.start(self.settings.job_timeout_seconds)

    def _delivery_deadline_at(self, request: JobDeliveryRequest) -> float | None:
        candidates = [request.deadline_at] if request.deadline_at is not None else []
        if request.delivery_mode in {"telegram", "telegram_url"}:
            manifest_path = Path(self.settings.jobs_root) / request.job_id / ".manifest.json"
            persisted = _manifest_deadline_at(manifest_path)
            if persisted is not None:
                candidates.append(persisted)
        return min(candidates) if candidates else None

    def _runtime(self) -> tuple[str, str]:
        if self._diagnostics:
            runtime = self._diagnostics.get("runtime")
            if (
                isinstance(runtime, dict)
                and runtime.get("name") == "deno"
                and isinstance(runtime.get("path"), str)
            ):
                return str(runtime["name"]), str(runtime["path"])
        runtime = resolve_js_runtime(self.settings)
        return runtime.name, runtime.path

    def _telegram_client(self) -> MediaDelivery:
        if self.telegram is not None:
            return self.telegram
        self.telegram = TelegramClient(
            self.settings.telegram_bot_token,
            api_base=self.settings.telegram_api_base,
            timeout_seconds=self.settings.telegram_upload_timeout_seconds,
        )
        return self.telegram

    def _r2_uploader(self) -> ObjectUploader:
        if self.r2 is not None:
            return self.r2
        self.r2 = R2Uploader(self.settings)
        return self.r2

    def _r2_fallback_available(self) -> bool:
        if self.r2 is not None:
            return True
        return all(
            (
                self.settings.r2_endpoint,
                self.settings.r2_bucket,
                self.settings.r2_access_key_id,
                self.settings.r2_secret_access_key,
                self.settings.r2_public_base_url,
                self.settings.download_link_hmac_secret,
            )
        )

    async def run(self, request: JobRunRequest) -> dict[str, object]:
        deadline = self._deadline_for_expiry(request.deadline_at)
        with activate_deadline(deadline):
            return await self._run_with_deadline(request)

    async def prepare_integration_audio(self, request: IntegrationAudioRequest) -> dict[str, object]:
        """Extract one bounded MP3 without creating a legacy download artifact.

        The Worker owns the account-scoped temporary R2 object. This method
        only returns the verified bytes while its ordinary JobWorkspace is
        still active; the workspace is removed as soon as the request ends.
        """

        now = time.time()
        requested_deadline = request.deadline_at if request.deadline_at is not None else request.expires_epoch
        deadline_at = min(requested_deadline, request.expires_epoch, now + self.settings.job_timeout_seconds)
        deadline = self._deadline_for_expiry(deadline_at)
        bounded_request = request.model_copy(update={"deadline_at": deadline.deadline_at})
        with activate_deadline(deadline):
            return await self._prepare_integration_audio_with_deadline(bounded_request)

    async def _prepare_integration_audio_with_deadline(self, request: IntegrationAudioRequest) -> dict[str, object]:
        started = time.monotonic()
        validated: ValidatedUrl | None = None
        acquired = False
        try:
            if request.expires_epoch <= time.time():
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            validated = validate_source_url(
                request.source_url,
                allowed_hosts=self.settings.effective_allowed_source_hosts,
                resolve_dns=self.settings.resolve_source_dns,
                max_length=self.settings.max_url_length,
            )
            deadline = current_deadline()
            if deadline is not None:
                deadline.ensure_remaining()
            await _bounded_await(self._active.acquire())
            acquired = True
            try:
                async with PublicEgressProxy() as egress_proxy:
                    job = JobRunRequest(
                        jobId="integration-" + hashlib.sha256(f"{request.account_id}\0{request.operation_id}".encode()).hexdigest(),
                        sourceUrl=request.source_url,
                        telegramChatId="1",
                        waitingMessageId=1,
                        mode=MediaMode.AUDIO,
                        preferredFormat=PreferredFormat.MP3,
                        trimStartSeconds=request.segment.start_seconds,
                        trimEndSeconds=request.segment.end_seconds,
                        deadlineAt=deadline.deadline_at if deadline is not None else None,
                    )
                    result = await _bounded_await(
                        self._run_active(job, validated, proxy_url=egress_proxy.url, processing_only_audio=True),
                    )
            finally:
                self._active.release()
                acquired = False
            log_event(
                "integration_audio_prepared",
                operation_id=request.operation_id,
                state="prepared",
                operation_ms=int((time.monotonic() - started) * 1000),
                output_size=cast(int, result["sizeBytes"]) if isinstance(result.get("sizeBytes"), int) else None,
            )
            return result
        except Exception as exc:
            error = _prepare_error(exc)
            log_event(
                "integration_audio_failed",
                operation_id=request.operation_id,
                state="failed",
                error_code=error.code.value,
                operation_ms=int((time.monotonic() - started) * 1000),
                **error.diagnostic_fields(),
            )
            return JobFailure(
                errorCode=error.code.value, safeMessage=error.safe_message, retryable=error.retryable,
                diagnostics=error.diagnostic_fields() if error.process_name is not None else None,
            ).model_dump(
                by_alias=True, exclude_none=True,
            )
        finally:
            if acquired:
                self._active.release()

    async def _run_with_deadline(self, request: JobRunRequest) -> dict[str, object]:
        """Prepare a verified artifact; Telegram delivery is a separate call."""

        started = time.monotonic()
        validated: ValidatedUrl | None = None
        acquired = False
        try:
            if ("download" if request.operation == "transcript" and request.transcript_method == "captions" else request.operation) != self.settings.job_operation:
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            deadline = current_deadline()
            if deadline is not None:
                deadline.ensure_remaining()
            if request.telegram_file is None:
                if request.source_url is None:
                    raise DownloadError(ErrorCode.INVALID_REQUEST)
                validated = validate_source_url(
                    request.source_url,
                    allowed_hosts=self.settings.effective_allowed_source_hosts,
                    resolve_dns=self.settings.resolve_source_dns,
                    max_length=self.settings.max_url_length,
                )
            log_event(
                "job_received",
                job_id=request.job_id,
                source_host=validated.hostname if validated else None,
                state="received",
            )
            await _bounded_await(self._active.acquire())
            acquired = True
            try:
                if request.telegram_file is not None:
                    result = await _bounded_await(self._run_active(request, None, proxy_url=""))
                else:
                    async with PublicEgressProxy() as egress_proxy:
                        result = await _bounded_await(self._run_active(request, validated, proxy_url=egress_proxy.url))
            finally:
                self._active.release()
                acquired = False
            raw_size = result.get("sizeBytes")
            output_size = raw_size if isinstance(raw_size, int) else None
            log_event(
                "job_prepared",
                job_id=request.job_id,
                source_host=validated.hostname if validated else None,
                state="prepared",
                operation_ms=int((time.monotonic() - started) * 1000),
                output_size=output_size,
            )
            return result
        except Exception as exc:
            error = _prepare_error(exc)
            log_event(
                "job_failed",
                job_id=request.job_id,
                source_host=validated.hostname if validated else None,
                state="failed",
                error_code=error.code.value,
                operation_ms=int((time.monotonic() - started) * 1000),
                **error.diagnostic_fields(),
            )
            return JobFailure(
                errorCode=error.code.value,
                safeMessage=error.safe_message,
                retryable=error.retryable,
                diagnostics=error.diagnostic_fields() if error.process_name is not None else None,
            ).model_dump(by_alias=True, exclude_none=True)
        finally:
            if acquired:
                self._active.release()

    async def _run_active(
        self,
        request: JobRunRequest,
        validated: ValidatedUrl | None,
        *,
        proxy_url: str,
        processing_only_audio: bool = False,
    ) -> dict[str, object]:
        resumed = None
        if not processing_only_audio:
            resumed = await self._resume_clip_pack(request) if request.clip_ranges else self._resume_prepared(request)
        if resumed is not None:
            log_event("job_prepare_resumed", job_id=request.job_id, state="prepared")
            return resumed
        existing_dir = Path(self.settings.jobs_root) / request.job_id
        if existing_dir.exists() or existing_dir.is_symlink():
            # A killed process can leave a partial direct manifest. It is safe
            # to rebuild it because Telegram delivery has not happened yet.
            JobWorkspace.cleanup_existing(self.settings.jobs_root, request.job_id)

        if request.telegram_file is not None:
            with JobWorkspace(self.settings.jobs_root, request.job_id, max_bytes=self.settings.max_temp_disk_bytes) as workspace:
                return await self._stage_telegram_file(request, workspace)
        if validated is None:
            raise DownloadError(ErrorCode.INVALID_REQUEST)

        # A direct-media resolver may return a short-lived, validated
        # provider-hosted MP4 URL; none ships in this edition, so this is
        # always None and yt-dlp handles the source.  Keep this attempt before the yt-dlp/EJS
        # dependency gate: audio jobs download that validated MP4 locally and
        # extract the requested audio format through the shared staging path.
        direct = None if request.operation == "transcript" and request.transcript_method == "captions" else await self._try_direct_media(request, proxy_url=proxy_url)
        if direct is not None:
            with JobWorkspace(self.settings.jobs_root, request.job_id, max_bytes=self.settings.max_temp_disk_bytes) as workspace:
                try:
                    return await self._stage_direct_file(
                        request, direct, validated, workspace, proxy_url=proxy_url,
                        processing_only_audio=processing_only_audio,
                    )
                except DownloadError as exc:
                    exc.error_stage = exc.error_stage or ErrorStage.STAGING
                    raise

        diagnostics = self.diagnostics()
        if not diagnostics.get("ready", False):
            binaries = diagnostics.get("binaries", {})
            if isinstance(binaries, dict):
                if not (binaries.get("yt-dlp") or {}).get("supported", False):
                    raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
                if not (binaries.get("yt-dlp-ejs") or {}).get("supported", False):
                    raise DownloadError(ErrorCode.EJS_MISSING)
                if not (binaries.get("ffmpeg") or {}).get("supported", False):
                    raise DownloadError(ErrorCode.FFMPEG_MISSING)
                if not (binaries.get("ffprobe") or {}).get("supported", False):
                    raise DownloadError(ErrorCode.FFPROBE_MISSING)
            raise DownloadError(ErrorCode.INTERNAL_ERROR)
        runtime_name, runtime_path = self._runtime()
        with JobWorkspace(self.settings.jobs_root, request.job_id, max_bytes=self.settings.max_temp_disk_bytes) as workspace:
            if not processing_only_audio:
                self._log_state(request, validated, "probing")
            captions_only = request.operation == "transcript" and request.transcript_method == "captions"
            info_json = workspace.child(".probe.info.json")
            try:
                with OperationTimer("probe_timing", job_id=request.job_id, state="probing") as timer:
                    probe = await _bounded_await(probe_media(
                        self.settings,
                        validated.normalized,
                        runtime_name,
                        runtime_path,
                        cwd=workspace.path,
                        proxy_url=proxy_url,
                        captions_only=captions_only,
                        info_json=None if captions_only else info_json,
                    ), self.settings.probe_timeout_seconds)
                    if not captions_only:
                        self._validate_probe(probe)
                    if request.trim_start_seconds is not None and probe.duration is not None:
                        self._trim_end(request, probe.duration)
                    timer.finish()
            except DownloadError as exc:
                exc.error_stage = ErrorStage.PROBE
                raise
            if captions_only:
                from .captions import source_captions

                document, preview = await _bounded_await(source_captions(
                    probe, workspace.path, language=request.caption_language,
                    proxy_url=proxy_url, settings=self.settings,
                ))
                return await self._stage_transcript_document(request, document, preview, probe.duration, probe, workspace)
            try:
                plan, _choice = self._select_plan(request, probe)
                if (request.trim_start_seconds is not None or request.clip_ranges) and plan.output_kind == "image":
                    raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
            except DownloadError as exc:
                exc.error_stage = ErrorStage.FORMAT_SELECTION
                raise
            exact_image_size = None
            if plan.output_kind == "image" and _choice.video_format_id is not None:
                exact_image_size = next(
                    (
                        fmt.filesize
                        for fmt in probe.formats
                        if fmt.format_id == _choice.video_format_id and fmt.filesize is not None
                    ),
                    None,
                )
            if (
                exact_image_size is not None
                and exact_image_size > self.settings.telegram_upload_limit_bytes
                and not self._r2_fallback_available()
            ):
                # Image-only media has no safe local transcode path. Fail
                # before fetching a known oversized source when R2 cannot
                # provide the only remaining delivery route. An approximate
                # probe size is deliberately insufficient for this shortcut.
                raise DownloadError(ErrorCode.R2_UPLOAD_FAILED, error_stage=ErrorStage.FORMAT_SELECTION)
            if not processing_only_audio:
                self._log_state(request, validated, "downloading")
            download = functools.partial(
                self._download, request, validated, workspace, plan, runtime_name, runtime_path,
                proxy_url=proxy_url, info_json=info_json,
            )
            with OperationTimer("download_timing", job_id=request.job_id, state="downloading") as timer:
                section = await self._try_trim_section(request, probe, workspace, download, keep=info_json.name)
                output, section_start = section if section is not None else (await download(), 0.0)
                timer.finish()
            info_json.unlink(missing_ok=True)
            workspace.current_size()
            if not processing_only_audio:
                self._log_state(request, validated, "processing")
            try:
                metadata = await _bounded_await(verify_media(
                    output,
                    ffprobe_path=self.settings.ffprobe_path,
                    timeout_seconds=self.settings.ffmpeg_timeout_seconds,
                    cwd=workspace.path,
                ), self.settings.ffmpeg_timeout_seconds)
                self._validate_final_duration(metadata)
            except DownloadError as exc:
                exc.error_stage = ErrorStage.MEDIA_VERIFY
                raise
            image_only = (
                plan.output_kind == "image"
                and metadata.mime_type.startswith("image/")
                and not metadata.has_audio
            )
            if request.mode == MediaMode.VIDEO and not metadata.has_video and not image_only:
                raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA, error_stage=ErrorStage.MEDIA_VERIFY)
            if request.mode == MediaMode.AUDIO and not metadata.has_audio:
                raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA, error_stage=ErrorStage.MEDIA_VERIFY)
            if request.operation == "transcript":
                return await self._stage_transcript(request, output, metadata, probe, workspace)
            if request.clip_ranges:
                return await self._stage_clip_pack(request, output, metadata, probe, workspace)
            output, metadata = await self._trim_media(request, output, metadata, workspace, title=probe.title, offset=section_start)
            if processing_only_audio:
                return await self._finish_integration_audio(request, output, metadata, workspace, title=probe.title)
            # There is no safe image-to-video transcode fallback.  A large
            # image goes through the same private R2 path as any other file
            # that cannot fit Telegram's direct-upload budget.
            if not image_only and (metadata.size_bytes > self.settings.telegram_upload_limit_bytes
                    or (request.mode == MediaMode.VIDEO and not 0 < (metadata.height or 0) <= (request.maximum_height or 1080))):
                output, metadata = await self._try_transcode(request, output, metadata, workspace)
                self._validate_final_duration(metadata)
            if metadata.size_bytes <= self.settings.telegram_upload_limit_bytes:
                try:
                    return await self._stage_telegram(request, output, metadata, probe, workspace)
                except DownloadError as exc:
                    exc.error_stage = ErrorStage.STAGING
                    raise
            try:
                return await self._prepare_r2(request, output, metadata, validated)
            except DownloadError as exc:
                exc.error_stage = ErrorStage.R2_UPLOAD
                raise

    async def _try_direct_media(self, request: JobRunRequest, *, proxy_url: str) -> DirectMedia | None:
        if request.source_url is None:
            return None
        try:
            return await resolve_direct_media(
                request.source_url,
                max_bytes=min(
                    self.settings.telegram_url_limit_bytes,
                    self.settings.max_source_download_bytes,
                ) if request.mode == MediaMode.VIDEO and request.trim_start_seconds is None and not request.clip_ranges else self.settings.max_source_download_bytes,
                timeout_seconds=self.settings.direct_resolver_timeout_seconds,
                resolve_dns=self.settings.resolve_source_dns,
                retries=self.settings.direct_resolver_retries,
                proxy_url=proxy_url,
            )
        except DownloadError as exc:
            # The regular yt-dlp/multipart lane remains the compatibility
            # fallback for blocked, private, image, unavailable, or transient
            # direct-resolver results.  The stable failure is selected by that
            # lane and never includes the provider URL.
            if exc.code == ErrorCode.DOWNLOAD_TIMEOUT:
                raise
            return None

    def _manifest_matches(self, request: JobRunRequest | JobDeliveryRequest, manifest: dict[str, Any]) -> bool:
        if bool(request.clip_ranges) != (manifest.get("kind") == "clip_pack"):
            return False
        if request.clip_ranges and manifest.get("clipRanges") != [item.model_dump(by_alias=True) for item in request.clip_ranges]:
            return False
        runtime = "download" if request.operation == "transcript" and request.transcript_method == "captions" else request.operation
        if runtime != self.settings.job_operation or manifest.get("operation", "download") != request.operation:
            return False
        if request.operation == "transcript":
            return (manifest.get("transcriptMethod", "whisper") == request.transcript_method
                    and manifest.get("captionLanguage") == request.caption_language)
        return manifest.get("transcriptMethod") is None and manifest.get("captionLanguage") is None

    def _resume_prepared(self, request: JobRunRequest) -> dict[str, object] | None:
        """Return a complete staged result after a lost prepare response."""

        job_dir = Path(self.settings.jobs_root) / request.job_id
        manifest_path = job_dir / ".manifest.json"
        if job_dir.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file():
            return None
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("sourceKind", "url") != ("telegram_file" if request.telegram_file is not None else "url"):
                return None
            if not self._manifest_matches(request, manifest):
                return None
            if (manifest.get("trimStartSeconds"), manifest.get("trimEndSeconds")) != (request.trim_start_seconds, request.trim_end_seconds):
                return None
            metadata = MediaMetadata.model_validate(manifest["metadata"])
            if request.telegram_file is not None:
                expected_mime = "video/mp4" if request.mode == MediaMode.VIDEO else (
                    "audio/mpeg" if request.preferred_format == PreferredFormat.MP3 else "audio/mp4"
                )
                if manifest.get("mode") != request.mode.value or metadata.mime_type != expected_mime:
                    return None
            if request.mode == MediaMode.VIDEO:
                if manifest.get("maximumHeight", 1080) != (request.maximum_height or 1080):
                    return None
                self._validate_video_height(metadata, request.maximum_height or 1080)
            deadline_at = _manifest_deadline_at(manifest_path)
            if manifest.get("kind") == "direct":
                direct_url = manifest.get("directUrl")
                provider = manifest.get("provider")
                if not isinstance(direct_url, str) or provider not in {"tiktok", "x"}:
                    return None
                validate_direct_media_url(
                    direct_url,
                    provider=provider,
                    resolve_dns=self.settings.resolve_source_dns,
                )
                if metadata.size_bytes > self.settings.telegram_url_limit_bytes:
                    return None
                return self._direct_success(request, metadata, direct_url, deadline_at=deadline_at)
            staged = job_dir / metadata.filename
            if staged.is_symlink() or not staged.is_file() or staged.stat().st_size != metadata.size_bytes:
                return None
            if request.operation == "transcript":
                self._verify_transcript(staged, metadata, manifest)
        except (DownloadError, OSError, ValueError, KeyError, TypeError):
            return None
        return JobSuccess(
            status="prepared",
            delivery="telegram",
            objectKey=f"staged/{request.job_id}/{metadata.filename}",
            filename=metadata.filename,
            mimeType=metadata.mime_type,
            sizeBytes=metadata.size_bytes,
            duration=metadata.duration,
            width=metadata.width,
            height=metadata.height,
            deadlineAt=deadline_at,
        ).model_dump(by_alias=True, exclude_none=True)

    def _direct_success(
        self,
        request: JobRunRequest,
        metadata: MediaMetadata,
        _direct_url: str,
        *,
        deadline_at: float | None = None,
    ) -> dict[str, object]:
        self._validate_video_height(metadata, request.maximum_height or 1080)
        if deadline_at is None:
            deadline = current_deadline()
            deadline_at = deadline.deadline_at if deadline is not None else None
        return JobSuccess(
            status="prepared",
            delivery="telegram_url",
            objectKey=f"staged/{request.job_id}/remote.mp4",
            filename=metadata.filename,
            mimeType=metadata.mime_type,
            sizeBytes=metadata.size_bytes,
            duration=metadata.duration,
            width=metadata.width,
            height=metadata.height,
            deadlineAt=deadline_at,
        ).model_dump(by_alias=True, exclude_none=True)

    def _validate_probe(self, probe: ProbeInfo) -> None:
        if probe.is_live is True:
            raise DownloadError(ErrorCode.LIVE_STREAM_NOT_SUPPORTED)
        if probe.duration is not None and probe.duration > self.settings.max_duration_seconds:
            raise DownloadError(ErrorCode.DURATION_LIMIT)
        if not probe.formats:
            raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)

    def _validate_final_duration(self, metadata: MediaMetadata) -> None:
        if not metadata.has_video and not metadata.has_audio:
            return
        duration = metadata.duration
        if duration is None or not math.isfinite(duration) or duration <= 0:
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        if duration > self.settings.max_duration_seconds:
            raise DownloadError(ErrorCode.DURATION_LIMIT)

    @staticmethod
    def _validate_video_height(metadata: MediaMetadata, maximum_height: int) -> None:
        if metadata.mime_type.startswith("image/") and not metadata.has_video:
            return
        if (type(maximum_height) is not int or not 144 <= maximum_height <= 2160
                or not metadata.has_video or not 0 < (metadata.height or 0) <= maximum_height):
            raise DownloadError(ErrorCode.PROCESSING_FAILED, error_stage=ErrorStage.MEDIA_VERIFY)

    def _select_plan(self, request: JobRunRequest, probe: ProbeInfo) -> tuple[DownloadPlan, FormatChoice]:
        if request.mode == MediaMode.VIDEO:
            return choose_telegram_video(
                probe,
                maximum_height=request.maximum_height or 1080,
                max_bytes=self.settings.telegram_upload_limit_bytes,
            )
        preferred = request.preferred_format
        if preferred not in {None, PreferredFormat.M4A, PreferredFormat.MP3}:
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        return choose_audio_plan(probe, preferred_format=preferred or PreferredFormat.M4A)

    async def _download(
        self,
        request: JobRunRequest,
        validated: ValidatedUrl,
        workspace: JobWorkspace,
        plan: DownloadPlan,
        runtime_name: str,
        runtime_path: str,
        *,
        proxy_url: str,
        info_json: Path | None = None,
        download_sections: str | None = None,
    ) -> Path:
        build_args = functools.partial(
            build_download_args,
            self.settings,
            validated.normalized,
            workspace.path,
            plan,
            runtime_name,
            runtime_path,
            proxy_url=proxy_url,
            extract_audio=request.trim_start_seconds is None,
            download_sections=download_sections,
        )
        args = build_args(info_json=info_json if info_json is not None and info_json.is_file() else None)
        output_root = workspace.path

        def process_failure(exc: ProcessExecutionError) -> DownloadError:
            if exc.result.timed_out:
                return DownloadError(
                    ErrorCode.DOWNLOAD_TIMEOUT,
                    retryable=True,
                    error_stage=ErrorStage.DOWNLOAD_PROCESS,
                    process_name=ProcessName.YT_DLP.value,
                    process_exit_code=exc.result.returncode,
                    process_timed_out=exc.result.timed_out,
                )
            if exc.result.output_limited:
                return DownloadError(
                    ErrorCode.SOURCE_SIZE_LIMIT,
                    error_stage=ErrorStage.DOWNLOAD_PROCESS,
                    process_name=ProcessName.YT_DLP.value,
                    process_exit_code=exc.result.returncode,
                    process_timed_out=exc.result.timed_out,
                )
            failure = error_from_process_output(exc.result.stderr or exc.result.stdout)
            failure.error_stage = ErrorStage.DOWNLOAD_PROCESS
            failure.process_name = ProcessName.YT_DLP.value
            failure.process_exit_code = exc.result.returncode
            failure.process_timed_out = exc.result.timed_out
            return failure

        try:
            result = await run_process(
                args,
                cwd=workspace.path,
                timeout_seconds=self.settings.download_timeout_seconds,
                term_grace_seconds=self.settings.process_term_grace_seconds,
                resource_check=workspace.current_size,
            )
        except ProcessExecutionError as exc:
            failure = process_failure(exc)
            # yt-dlp hands a section to ffmpeg, which reports YouTube's 403 only as an exit code.
            section_refused = download_sections is not None and "ffmpeg exited with code" in (exc.result.stderr or "")
            if not (
                (failure.failure_reason == FailureReason.HTTP_FORBIDDEN or section_refused)
                and not exc.result.timed_out
                and _is_youtube_hostname(validated.hostname)
            ):
                raise failure from None
            fallback_dir = workspace.ensure_within(workspace.path / "youtube-web-embedded")
            if fallback_dir.exists() or fallback_dir.is_symlink():
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED, error_stage=ErrorStage.DOWNLOAD_OUTPUT) from None
            fallback_dir.mkdir(mode=0o700)
            # A fresh extraction: the client override does nothing on reloaded probe JSON.
            fallback_args = _youtube_web_embedded_args(build_args(), validated.normalized, fallback_dir)
            log_event(
                "download_fallback_attempt",
                job_id=request.job_id,
                source_host=validated.hostname,
                state="downloading",
                error_code=failure.code.value,
                error_stage=ErrorStage.DOWNLOAD_PROCESS,
                failure_reason=failure.failure_reason,
                process_name=ProcessName.YT_DLP,
                process_exit_code=exc.result.returncode,
                process_timed_out=exc.result.timed_out,
                retry_count=1,
                fallback="youtube_web_embedded",
            )
            try:
                result = await run_process(
                    fallback_args,
                    cwd=workspace.path,
                    timeout_seconds=self.settings.download_timeout_seconds,
                    term_grace_seconds=self.settings.process_term_grace_seconds,
                    resource_check=workspace.current_size,
                )
                output_root = fallback_dir
            except ProcessExecutionError as fallback_exc:
                raise process_failure(fallback_exc) from None
        try:
            output = parse_final_path(f"{result.stdout}\n{result.stderr}", output_root)
        except DownloadError as exc:
            exc.error_stage = ErrorStage.DOWNLOAD_OUTPUT
            exc.process_name = ProcessName.YT_DLP.value
            exc.process_exit_code = result.returncode
            exc.process_timed_out = result.timed_out
            raise
        try:
            size = output.stat().st_size
        except OSError as exc:
            raise DownloadError(
                ErrorCode.DOWNLOAD_FAILED,
                error_stage=ErrorStage.DOWNLOAD_OUTPUT,
                process_name=ProcessName.YT_DLP.value,
                process_exit_code=result.returncode,
                process_timed_out=result.timed_out,
            ) from exc
        if size > self.settings.max_source_download_bytes:
            raise DownloadError(
                ErrorCode.SOURCE_SIZE_LIMIT,
                error_stage=ErrorStage.DOWNLOAD_OUTPUT,
                process_name=ProcessName.YT_DLP.value,
                process_exit_code=result.returncode,
                process_timed_out=result.timed_out,
            )
        return output

    async def _try_trim_section(
        self,
        request: JobRunRequest,
        probe: ProbeInfo,
        workspace: JobWorkspace,
        download: Callable[..., Awaitable[Path]],
        *,
        keep: str,
    ) -> tuple[Path, float] | None:
        """Fetch only a padded trim window; None means download the full source."""

        # Known limit: single trims only; clip packs still fetch the full source.
        if (request.trim_start_seconds is None or request.clip_ranges
                or request.operation == "transcript" or probe.duration is None):
            return None
        start = max(0.0, request.trim_start_seconds - SECTION_PADDING_SECONDS)
        end = self._trim_end(request, probe.duration) + SECTION_PADDING_SECONDS
        try:
            output = await download(download_sections=f"*{start:.3f}-{end:.3f}")
            section = await _bounded_await(verify_media(
                output, ffprobe_path=self.settings.ffprobe_path,
                timeout_seconds=self.settings.ffmpeg_timeout_seconds, cwd=workspace.path,
            ), self.settings.ffmpeg_timeout_seconds)
        except DownloadError as exc:
            if exc.code == ErrorCode.DOWNLOAD_TIMEOUT:
                raise
        else:
            # A stream-copied section is exact only in MP4 (edit list; other video
            # containers restart at a keyframe), and yt-dlp can exit 0 on a short one.
            if ((request.mode != MediaMode.VIDEO or output.suffix == ".mp4")
                    and start + (section.duration or 0) >= min(float(cast(int, request.trim_end_seconds)), probe.duration - 0.25)):
                return output, start
        log_event("download_fallback_attempt", job_id=request.job_id, state="downloading",
                  error_stage=ErrorStage.DOWNLOAD_PROCESS, fallback="full_source")
        workspace.prune(keep)
        return None

    @staticmethod
    def _trim_end(request: JobRunRequest, duration: float | None) -> float:
        start, end = request.trim_start_seconds, request.trim_end_seconds
        if start is None or end is None or duration is None or not math.isfinite(duration) or duration <= 0:
            raise DownloadError(ErrorCode.INVALID_TIME_RANGE)
        if start >= duration:
            raise DownloadError(ErrorCode.START_BEYOND_DURATION)
        return min(float(end), duration)

    @staticmethod
    def _validate_trim_output(request: JobRunRequest, metadata: MediaMetadata, duration: float) -> None:
        # Codec padding and frame boundaries can round a cut by up to 250 ms.
        if metadata.duration is None or not math.isfinite(metadata.duration) or abs(metadata.duration - duration) > 0.25:
            raise DownloadError(ErrorCode.PROCESSING_FAILED, error_stage=ErrorStage.TRANSCODE)
        if request.mode == MediaMode.VIDEO:
            DownloaderService._validate_video_height(metadata, request.maximum_height or 1080)
            valid = metadata.has_video and metadata.mime_type == "video/mp4"
        else:
            mp3 = request.preferred_format == PreferredFormat.MP3
            valid = (
                metadata.has_audio and not metadata.has_video
                and metadata.mime_type == ("audio/mpeg" if mp3 else "audio/mp4")
                and metadata.first_audio_codec == ("mp3" if mp3 else "aac")
            )
        if not valid:
            raise DownloadError(ErrorCode.PROCESSING_FAILED, error_stage=ErrorStage.TRANSCODE)

    async def _trim_media(
        self,
        request: JobRunRequest,
        output: Path,
        metadata: MediaMetadata,
        workspace: JobWorkspace,
        *,
        title: str,
        input_demuxer: str | None = None,
        retain_source: bool = False,
        offset: float = 0.0,
    ) -> tuple[Path, MediaMetadata]:
        """Cut [start, end] of the source; ``offset`` is the source time at the file's t=0."""

        start = request.trim_start_seconds
        if start is None:
            return output, metadata
        self._validate_final_duration(metadata)
        end = self._trim_end(request, offset + cast(float, metadata.duration))
        duration = end - start
        clamped = end < cast(int, request.trim_end_seconds)
        extension = "mp4" if request.mode == MediaMode.VIDEO else (request.preferred_format or PreferredFormat.M4A).value
        name = sanitize_filename(title or output.stem, max_length=90)
        target = workspace.child(f"{name} [clip {start}-{end:g}s{' end-of-media' if clamped else ''}].{extension}")
        # Known limit: download the bounded full source, then encode one exact cut;
        # add provider-specific segment fetching only after measuring download cost.
        args = [self.settings.ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y",
                "-ss", str(start - offset),
                *(["-protocol_whitelist", "file", "-f", input_demuxer] if input_demuxer else []),
                *(["-enable_drefs", "0", "-use_absolute_path", "0"] if input_demuxer == "mov" else []),
                "-i", str(output), "-t", str(duration)]
        if request.mode == MediaMode.VIDEO:
            height = request.maximum_height or 1080
            args.extend(["-map", "0:V:0", "-map", "0:a:0?", "-c:v", "libx264",
                         "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                         "-vf", f"scale=-2:trunc(min(ih\\,{height})/2)*2", "-c:a", "aac", "-b:a", "128k"])
        else:
            args.extend(["-map", "0:a:0", "-vn", "-c:a", "libmp3lame" if extension == "mp3" else "aac",
                         "-b:a", "128k"])
        args.extend(["-map_metadata", "-1" if input_demuxer else "0", "-map_chapters", "-1", "-metadata", f"title={name}",
                     "-movflags", "+faststart", str(target)])
        try:
            await run_process(args, cwd=workspace.path, timeout_seconds=self.settings.ffmpeg_timeout_seconds,
                              term_grace_seconds=self.settings.process_term_grace_seconds,
                              resource_check=workspace.current_size)
            workspace.current_size()
            verified = await _bounded_await(verify_media(
                target, ffprobe_path=self.settings.ffprobe_path,
                timeout_seconds=self.settings.ffmpeg_timeout_seconds, cwd=workspace.path,
            ), self.settings.ffmpeg_timeout_seconds)
            self._validate_final_duration(verified)
            self._validate_trim_output(request, verified, duration)
        except ProcessExecutionError as exc:
            raise DownloadError(ErrorCode.PROCESS_TIMEOUT if exc.result.timed_out else ErrorCode.PROCESSING_FAILED,
                                retryable=exc.result.timed_out, error_stage=ErrorStage.TRANSCODE) from None
        if not retain_source:
            output.unlink()
        return target, verified.model_copy(update={
            "trim_start_seconds": start, "trim_end_seconds": end, "trim_end_clamped": clamped,
        })

    def _clip_pack_budget(self, count: int) -> tuple[int, int]:
        if count not in {2, 3}:
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        total = min(49_000_000, self.settings.telegram_upload_limit_bytes)
        # Known limit: equal clip budgets can reject uneven packs; allocate spare bytes only if needed later.
        per_clip = (total - 65_536) // count
        if per_clip <= 0:
            raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
        return total, per_clip

    def _clip_source_fingerprint(self, request: JobRunRequest) -> str:
        source = {"fileId": request.telegram_file.file_id, "fileSize": request.telegram_file.file_size} if request.telegram_file else request.source_url
        payload = json.dumps(["clip-pack-source-v1", request.job_id,
                              "telegram_file" if request.telegram_file else "url", source],
                             separators=(",", ":"), sort_keys=True).encode()
        return hmac.new(self.settings.internal_container_secret.encode(), payload, hashlib.sha256).hexdigest()

    @staticmethod
    def _clip_pack_result(request: JobRunRequest | JobDeliveryRequest, manifest: dict[str, Any], clips: list[tuple[Path, MediaMetadata]]) -> dict[str, object]:
        first = clips[0][1]
        return JobSuccess(
            status="prepared", delivery="telegram", objectKey=f"staged/{request.job_id}/{first.filename}",
            filename=first.filename, mimeType=first.mime_type,
            sizeBytes=sum(item.size_bytes for _, item in clips), duration=sum(item.duration or 0 for _, item in clips),
            width=first.width, height=first.height, clipCount=len(clips), deadlineAt=manifest.get("deadlineAt"),
        ).model_dump(by_alias=True, exclude_none=True)

    async def _read_clip_pack(
        self, request: JobRunRequest | JobDeliveryRequest, job_dir: Path, manifest: dict[str, Any],
    ) -> list[tuple[Path, MediaMetadata]]:
        ranges = request.clip_ranges
        if (not ranges or not self._manifest_matches(request, manifest) or request.mode != MediaMode.VIDEO
                or manifest.get("mode") != "video" or manifest.get("sourceKind") not in {"url", "telegram_file"}):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        if isinstance(request, JobRunRequest):
            fingerprint = manifest.get("sourceFingerprint")
            if (not isinstance(fingerprint, str) or not hmac.compare_digest(fingerprint, self._clip_source_fingerprint(request))
                    or manifest.get("sourceKind") != ("telegram_file" if request.telegram_file else "url")
                    or manifest.get("maximumHeight") != (request.maximum_height or 1080)):
                raise DownloadError(ErrorCode.INVALID_REQUEST)
        records = manifest.get("clips")
        if not isinstance(records, list) or len(records) != len(ranges):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        _, per_clip = self._clip_pack_budget(len(ranges))
        duration = manifest.get("sourceDuration")
        if (isinstance(duration, bool) or not isinstance(duration, int | float) or not math.isfinite(duration)
                or not 0 < duration <= self.settings.max_duration_seconds):
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        maximum_height = manifest.get("maximumHeight")
        if isinstance(maximum_height, bool) or not isinstance(maximum_height, int):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        clips = []
        effective_ranges: set[tuple[int, float]] = set()
        for index, (record, requested) in enumerate(zip(records, ranges, strict=True), start=1):
            metadata = MediaMetadata.model_validate(record["metadata"])
            expected_end = min(float(requested.end_seconds), duration)
            effective = (requested.start_seconds, expected_end)
            if (requested.start_seconds >= expected_end or effective in effective_ranges
                    or metadata.filename != f"clip-{index:02d}.mp4"
                    or metadata.trim_start_seconds != requested.start_seconds or metadata.trim_end_seconds != expected_end
                    or metadata.trim_end_clamped != (expected_end < requested.end_seconds)):
                raise DownloadError(ErrorCode.PROCESSING_FAILED)
            effective_ranges.add(effective)
            output = Path(self._staged_file(job_dir, metadata.filename))
            digest = record.get("sha256")
            with output.open("rb") as stream:
                actual_digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if not isinstance(digest, str) or not hmac.compare_digest(digest, actual_digest):
                raise DownloadError(ErrorCode.PROCESSING_FAILED)
            verified = await _bounded_await(verify_media(
                output, ffprobe_path=self.settings.ffprobe_path,
                timeout_seconds=self.settings.ffmpeg_timeout_seconds, cwd=job_dir,
            ), self.settings.ffmpeg_timeout_seconds)
            self._validate_video_height(verified, maximum_height)
            if (verified.mime_type != "video/mp4" or verified.first_video_codec != "h264"
                    or (verified.has_audio and verified.first_audio_codec != "aac")
                    or verified.duration is None or abs(verified.duration - (expected_end - requested.start_seconds)) > 0.25
                    or verified.size_bytes != metadata.size_bytes or verified.size_bytes > per_clip
                    or verified.width != metadata.width or verified.height != metadata.height
                    or verified.duration != metadata.duration or verified.mime_type != metadata.mime_type
                    or verified.has_video != metadata.has_video or verified.has_audio != metadata.has_audio
                    or verified.first_video_codec != metadata.first_video_codec or verified.first_audio_codec != metadata.first_audio_codec):
                raise DownloadError(ErrorCode.PROCESSING_FAILED)
            clips.append((output, metadata))
        expected_files = {".manifest.json", *(metadata.filename for _, metadata in clips)}
        if {child.name for child in job_dir.iterdir()} != expected_files:
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        return clips

    async def _resume_clip_pack(self, request: JobRunRequest) -> dict[str, object] | None:
        job_dir = Path(self.settings.jobs_root) / request.job_id
        manifest_path = job_dir / ".manifest.json"
        if job_dir.is_symlink() or manifest_path.is_symlink() or not manifest_path.is_file():
            return None
        try:
            manifest = json.loads(manifest_path.read_text())
            clips = await self._read_clip_pack(request, job_dir, manifest)
            return self._clip_pack_result(request, manifest, clips)
        except (DownloadError, OSError, ValueError, KeyError, TypeError, AttributeError):
            return None

    async def _stage_clip_pack(
        self, request: JobRunRequest, source: Path, metadata: MediaMetadata, probe: ProbeInfo, workspace: JobWorkspace,
        *, input_demuxer: str | None = None,
    ) -> dict[str, object]:
        ranges = request.clip_ranges
        if not ranges or request.mode != MediaMode.VIDEO or request.operation != "download" or not metadata.has_video:
            raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
        _, per_clip = self._clip_pack_budget(len(ranges))
        self._validate_final_duration(metadata)
        cuts = []
        effective_ranges: set[tuple[int, float]] = set()
        for requested in ranges:
            cut = request.model_copy(update={"clip_ranges": None, "trim_start_seconds": requested.start_seconds,
                                             "trim_end_seconds": requested.end_seconds})
            end = self._trim_end(cut, metadata.duration)
            effective = (requested.start_seconds, end)
            if effective in effective_ranges:
                raise DownloadError(ErrorCode.INVALID_TIME_RANGE)
            effective_ranges.add(effective)
            cuts.append(cut)
        retained_source = workspace.child("pack-source.bin")
        if source != retained_source:
            source.replace(retained_source)
            source = retained_source
        clips: list[dict[str, Any]] = []
        for index, cut in enumerate(cuts, start=1):
            output, verified = await self._trim_media(
                cut, source, metadata, workspace, title=f"clip-{index:02d}", input_demuxer=input_demuxer, retain_source=True,
            )
            if verified.size_bytes > per_clip:
                output, verified = await self._try_transcode(cut, output, verified, workspace, upload_limit_bytes=per_clip)
            self._validate_trim_output(cut, verified, self._trim_end(cut, metadata.duration) - cast(int, cut.trim_start_seconds))
            if (verified.size_bytes > per_clip or verified.first_video_codec != "h264"
                    or (verified.has_audio and verified.first_audio_codec != "aac")):
                raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE if verified.size_bytes > per_clip else ErrorCode.PROCESSING_FAILED)
            target = workspace.child(f"clip-{index:02d}.mp4")
            if output != target:
                output.replace(target)
            verified = verified.model_copy(update={"filename": target.name})
            with target.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            clips.append({"metadata": verified.model_dump(by_alias=True), "sha256": digest})
        workspace.prune(*(item["metadata"]["filename"] for item in clips))
        deadline = current_deadline()
        manifest = {
            "kind": "clip_pack", "operation": "download", "mode": "video",
            "sourceKind": "telegram_file" if request.telegram_file else "url",
            "sourceFingerprint": self._clip_source_fingerprint(request), "sourceDuration": metadata.duration,
            "clipRanges": [item.model_dump(by_alias=True) for item in ranges], "maximumHeight": request.maximum_height or 1080,
            "deadlineAt": deadline.deadline_at if deadline else None,
            "probe": {"title": sanitize_filename(probe.title or "Clip pack"), "extractor": probe.extractor}, "clips": clips,
        }
        manifest_path = workspace.child(".manifest.json")
        manifest_path.write_text(json.dumps(manifest, separators=(",", ":")))
        manifest_path.chmod(0o600)
        verified_clips = await self._read_clip_pack(request, workspace.path, manifest)
        result = self._clip_pack_result(request, manifest, verified_clips)
        workspace.retain()
        return result

    async def _deliver_clip_pack(self, request: JobDeliveryRequest, job_dir: Path, manifest: dict[str, Any]) -> dict[str, object]:
        try:
            clips = await self._read_clip_pack(request, job_dir, manifest)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise DownloadError(ErrorCode.PROCESSING_FAILED) from exc
        prepared = self._clip_pack_result(request, manifest, clips)
        if (request.object_key != prepared["objectKey"] or request.filename != prepared["filename"]
                or request.mime_type != prepared["mimeType"] or request.size_bytes != prepared["sizeBytes"]):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        probe = ProbeInfo.model_validate(manifest["probe"])
        total, _ = self._clip_pack_budget(len(clips))
        await self._send_action(request.telegram_chat_id, "upload_video")
        messages = await _bounded_await(self._telegram_client().send_media_group(
            chat_id=request.telegram_chat_id, clips=clips, probe=probe, max_bytes=total,
        ), self.settings.telegram_upload_timeout_seconds)
        if not isinstance(messages, list) or len(messages) != len(clips):
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="ambiguous")
        ids = [str(self._confirmed_message(message).message_id) for message in messages]
        if len(set(ids)) != len(ids):
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED, outcome="ambiguous")
        self._cleanup_workspace(request, state="completed")
        return {"status": "completed", "delivery": "telegram", "telegramMessageId": ids[0], "telegramMessageIds": ids,
                "telegramMediaMethod": "sendMediaGroup", "filename": request.filename, "mimeType": request.mime_type,
                "sizeBytes": request.size_bytes}

    async def _stage_telegram_file(self, request: JobRunRequest, workspace: JobWorkspace) -> dict[str, object]:
        source_file = request.telegram_file
        if source_file is None or request.operation != "download":
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        if source_file.file_size > self.settings.max_source_download_bytes:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        source = workspace.child("telegram-input.bin")
        with OperationTimer("download_timing", job_id=request.job_id, state="downloading"):
            await _bounded_await(download_telegram_file(
                source_file, source, bot_token=self.settings.telegram_bot_token,
                timeout_seconds=self.settings.download_timeout_seconds, workspace_size=workspace.current_size,
            ), self.settings.download_timeout_seconds)
        workspace.current_size()
        if source.stat().st_size > self.settings.max_source_download_bytes:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        metadata = await _bounded_await(verify_media(
            source, ffprobe_path=self.settings.ffprobe_path, timeout_seconds=self.settings.ffmpeg_timeout_seconds,
            cwd=workspace.path, telegram_input=True,
        ), self.settings.ffmpeg_timeout_seconds)
        self._validate_final_duration(metadata)
        if (request.mode == MediaMode.VIDEO and not metadata.has_video) or (request.mode == MediaMode.AUDIO and not metadata.has_audio):
            raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
        demuxer = telegram_input_demuxer(metadata)
        title = sanitize_filename(source_file.file_name or "Telegram upload", max_length=90)
        probe = ProbeInfo(title=title, extractor="telegram", duration=metadata.duration,
                          width=metadata.width, height=metadata.height)
        if request.clip_ranges:
            return await self._stage_clip_pack(request, source, metadata, probe, workspace, input_demuxer=demuxer)
        if request.trim_start_seconds is not None:
            output, verified = await self._trim_media(request, source, metadata, workspace, title=title, input_demuxer=demuxer)
            if verified.size_bytes > self.settings.telegram_upload_limit_bytes:
                output, verified = await self._try_transcode(request, output, verified, workspace, title=title)
        else:
            output, verified = await self._try_transcode(request, source, metadata, workspace, title=title, input_demuxer=demuxer)
        self._validate_final_duration(verified)
        if request.mode == MediaMode.VIDEO:
            self._validate_video_height(verified, request.maximum_height or 1080)
            valid = (verified.mime_type == "video/mp4" and verified.first_video_codec == "h264"
                     and (not verified.has_audio or verified.first_audio_codec == "aac"))
        else:
            mp3 = request.preferred_format == PreferredFormat.MP3
            valid = (verified.has_audio and not verified.has_video
                     and verified.mime_type == ("audio/mpeg" if mp3 else "audio/mp4")
                     and verified.first_audio_codec == ("mp3" if mp3 else "aac"))
        if not valid or output == source:
            raise DownloadError(ErrorCode.PROCESSING_FAILED, error_stage=ErrorStage.MEDIA_VERIFY)
        if verified.size_bytes > self.settings.max_source_download_bytes:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        # Keep only the verified output before staging retains the workspace.
        workspace.prune(output.name)
        if verified.size_bytes <= self.settings.telegram_upload_limit_bytes:
            return await self._stage_telegram(request, output, verified, probe, workspace)
        return await self._prepare_r2(request, output, verified, None)

    async def _stage_direct_file(
        self,
        request: JobRunRequest,
        direct: DirectMedia,
        validated: ValidatedUrl,
        workspace: JobWorkspace,
        *,
        proxy_url: str,
        processing_only_audio: bool = False,
    ) -> dict[str, object]:
        provider = {"tiktok": "tiktok", "twitter": "x", "x": "x"}.get(direct.probe.extractor or "")
        if provider is None or direct.mime_type != "video/mp4" or direct.size_bytes <= 0:
            raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE)
        source_limit = min(self.settings.telegram_url_limit_bytes, self.settings.max_source_download_bytes) if (
            request.mode == MediaMode.VIDEO and request.trim_start_seconds is None and not request.clip_ranges
        ) else self.settings.max_source_download_bytes
        if direct.size_bytes > source_limit:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        if direct.duration is not None and direct.duration > self.settings.max_duration_seconds:
            raise DownloadError(ErrorCode.DURATION_LIMIT)
        if request.trim_start_seconds is not None and direct.duration is not None:
            self._trim_end(request, direct.duration)
        safe_url = validate_direct_media_url(
            direct.url,
            provider=provider,
            resolve_dns=self.settings.resolve_source_dns,
        )
        source = workspace.child("direct-source.mp4")
        with OperationTimer("download_timing", job_id=request.job_id, state="downloading") as timer:
            await download_direct_media(
                safe_url,
                source,
                max_bytes=source_limit,
                timeout_seconds=self.settings.download_timeout_seconds,
                proxy_url=proxy_url,
            )
            timer.finish()
        workspace.current_size()
        source_metadata = await _bounded_await(verify_media(
            source,
            ffprobe_path=self.settings.ffprobe_path,
            timeout_seconds=self.settings.ffmpeg_timeout_seconds,
            cwd=workspace.path,
        ), self.settings.ffmpeg_timeout_seconds)
        self._validate_final_duration(source_metadata)
        if (request.mode == MediaMode.AUDIO and not source_metadata.has_audio) or (request.mode == MediaMode.VIDEO and not source_metadata.has_video):
            raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
        if request.operation == "transcript":
            return await self._stage_transcript(request, source, source_metadata, direct.probe, workspace)
        if request.clip_ranges:
            return await self._stage_clip_pack(request, source, source_metadata, direct.probe, workspace)
        title = direct.probe.title or direct.filename
        if request.trim_start_seconds is not None:
            output, metadata = await self._trim_media(request, source, source_metadata, workspace, title=title)
            if metadata.size_bytes > self.settings.telegram_upload_limit_bytes:
                output, metadata = await self._try_transcode(request, output, metadata, workspace, title=title)
        elif (request.mode == MediaMode.VIDEO and source_metadata.mime_type == "video/mp4"
              and 0 < (source_metadata.height or 0) <= (request.maximum_height or 1080)
              and source_metadata.size_bytes <= self.settings.telegram_upload_limit_bytes):
            output, metadata = source, source_metadata.model_copy(update={"filename": direct.filename})
        else:
            output, metadata = await self._try_transcode(request, source, source_metadata, workspace, title=title)
        self._validate_final_duration(metadata)
        expected_format = request.preferred_format or (PreferredFormat.MP4 if request.mode == MediaMode.VIDEO else PreferredFormat.M4A)
        expected_mime = "video/mp4" if request.mode == MediaMode.VIDEO else "audio/mpeg" if expected_format == PreferredFormat.MP3 else "audio/mp4"
        if (
            (output == source and request.mode != MediaMode.VIDEO)
            or output.suffix.lower() != f".{expected_format.value}"
            or metadata.mime_type != expected_mime
            or (request.mode == MediaMode.AUDIO and (not metadata.has_audio or metadata.has_video))
            or (request.mode == MediaMode.VIDEO and not metadata.has_video)
        ):
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        if metadata.size_bytes > self.settings.max_source_download_bytes:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        if processing_only_audio:
            return await self._finish_integration_audio(request, output, metadata, workspace, title=title)
        if metadata.size_bytes <= self.settings.telegram_upload_limit_bytes:
            return await self._stage_telegram(request, output, metadata, direct.probe, workspace)
        return await self._prepare_r2(request, output, metadata, validated)

    async def _finish_integration_audio(
        self,
        request: JobRunRequest,
        output: Path,
        metadata: MediaMetadata,
        workspace: JobWorkspace,
        *,
        title: str,
    ) -> dict[str, object]:
        """Apply the integrated MP3 limits and return bytes before cleanup."""

        if request.mode != MediaMode.AUDIO or request.preferred_format != PreferredFormat.MP3:
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        if metadata.size_bytes > INTEGRATION_AUDIO_MAX_BYTES:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        if metadata.trim_end_clamped:
            raise DownloadError(ErrorCode.INVALID_TIME_RANGE)
        duration = metadata.duration
        if (
            not metadata.has_audio
            or metadata.has_video
            or metadata.mime_type != "audio/mpeg"
            or metadata.first_audio_codec != "mp3"
            or output.suffix.lower() != ".mp3"
            or not isinstance(duration, float | int)
            or isinstance(duration, bool)
            or not math.isfinite(duration)
            or duration <= 0
            or duration > INTEGRATION_AUDIO_MAX_DURATION_SECONDS
        ):
            raise DownloadError(ErrorCode.DURATION_LIMIT if duration is not None and duration > INTEGRATION_AUDIO_MAX_DURATION_SECONDS else ErrorCode.PROCESSING_FAILED)
        try:
            content = output.read_bytes()
        except OSError as exc:
            raise DownloadError(ErrorCode.PROCESSING_FAILED) from exc
        if len(content) != metadata.size_bytes or len(content) <= 0:
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        if len(content) > INTEGRATION_AUDIO_MAX_BYTES:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        return {
            "status": "prepared",
            "mimeType": "audio/mpeg",
            "filename": sanitize_filename(output.name, fallback="segment.mp3"),
            "sizeBytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "duration": float(duration),
            "trimEndClamped": metadata.trim_end_clamped,
            "content": content,
        }

    async def _try_transcode(
        self,
        request: JobRunRequest,
        output: Path,
        metadata: MediaMetadata,
        workspace: JobWorkspace,
        *,
        title: str | None = None,
        input_demuxer: str | None = None,
        upload_limit_bytes: int | None = None,
    ) -> tuple[Path, MediaMetadata]:
        upload_limit = self.settings.telegram_upload_limit_bytes if upload_limit_bytes is None else upload_limit_bytes
        if upload_limit <= 0:
            raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
        self._log_state(request, None, "processing")
        extension = "mp4" if request.mode == MediaMode.VIDEO else (request.preferred_format.value if request.preferred_format else "m4a")
        copy_audio = (
            input_demuxer is None
            and request.mode == MediaMode.AUDIO
            and extension == "m4a"
            and metadata.has_video
            and metadata.first_audio_codec is not None
            and metadata.first_audio_codec.lower() == "aac"
        )
        if request.mode == MediaMode.AUDIO:
            attempts: tuple[int | None, ...] = (None, 96, 64, 48) if copy_audio else (96, 64, 48)
        else:
            attempts = (28, 32, 35)
        # Cap the video bitrate to the budget so the first CRF attempt normally
        # fits: VBV bounds video at maxrate * (duration + 2 s buffer), audio is
        # 96 kbps, and 3% covers container overhead. The ladder stays as backup.
        duration = metadata.duration if metadata.duration and math.isfinite(metadata.duration) else 0.0
        maxrate_kbps = int((upload_limit * 8 * 0.97 / 1000 - 96 * duration) / (duration + 2)) if duration > 0 else 0
        video_cap = ["-maxrate", f"{maxrate_kbps}k", "-bufsize", f"{2 * maxrate_kbps}k"] if maxrate_kbps >= MIN_VIDEO_KBPS else []
        deadline = current_deadline()
        last_encoded: tuple[Path, MediaMetadata] | None = None
        for attempt in attempts:
            copy_attempt = attempt is None
            if copy_attempt:
                target = workspace.child("transcoded-copy.m4a")
            else:
                target = workspace.child(f"transcoded-{attempt}.{extension}")
            if target.exists():
                target.unlink()
            if request.mode == MediaMode.VIDEO:
                args = [
                    self.settings.ffmpeg_path,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(output),
                    "-map",
                    "0:V:0",
                    "-map",
                    "0:a:0?",
                    "-c:v",
                    "libx264",
                    "-vf",
                    f"scale=-2:trunc(min(ih\\,{request.maximum_height or 1080})/2)*2",
                    "-preset",
                    "veryfast",
                    "-crf",
                    str(attempt),
                    *video_cap,
                    "-c:a",
                    "aac",
                    "-b:a",
                    "96k",
                    "-movflags",
                    "+faststart",
                ]
            elif copy_attempt:
                args = [
                    self.settings.ffmpeg_path,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(output),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-c:a",
                    "copy",
                    "-movflags",
                    "+faststart",
                ]
            else:
                bitrate = f"{attempt}k"
                codec = "libmp3lame" if extension == "mp3" else "aac"
                args = [
                    self.settings.ffmpeg_path,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(output),
                    "-vn",
                    "-c:a",
                    codec,
                    "-b:a",
                    bitrate,
                    "-movflags",
                    "+faststart",
                ]
            if input_demuxer:
                input_index = args.index("-i")
                args[input_index:input_index] = [
                    "-protocol_whitelist", "file", "-f", input_demuxer,
                    *(["-enable_drefs", "0", "-use_absolute_path", "0"] if input_demuxer == "mov" else []),
                ]
                args.extend(["-map_metadata", "-1", "-map_chapters", "-1"])
                if request.mode == MediaMode.AUDIO:
                    args.extend(["-map", "0:a:0"])
                else:
                    args.extend(["-pix_fmt", "yuv420p"])
            if request.mode == MediaMode.AUDIO and title:
                safe_title = "".join(char for char in title if ord(char) >= 0x20 and char != "\x7f")[:256]
                if safe_title:
                    args.extend(["-metadata", f"title={safe_title}"])
            args.append(str(target))
            try:
                with OperationTimer("encode_timing", job_id=request.job_id, state="processing") as timer:
                    await run_process(
                        args,
                        cwd=workspace.path,
                        timeout_seconds=self.settings.ffmpeg_timeout_seconds,
                        term_grace_seconds=self.settings.process_term_grace_seconds,
                        resource_check=workspace.current_size,
                    )
                    workspace.current_size()
                    verified = await _bounded_await(verify_media(
                        target,
                        ffprobe_path=self.settings.ffprobe_path,
                        timeout_seconds=self.settings.ffmpeg_timeout_seconds,
                        cwd=workspace.path,
                    ), self.settings.ffmpeg_timeout_seconds)
                    verified = verified.model_copy(update={
                        "filename": metadata.filename if metadata.trim_start_seconds is not None else verified.filename,
                        "trim_start_seconds": metadata.trim_start_seconds,
                        "trim_end_seconds": metadata.trim_end_seconds,
                        "trim_end_clamped": metadata.trim_end_clamped,
                    })
                    if request.mode == MediaMode.VIDEO:
                        self._validate_video_height(verified, request.maximum_height or 1080)
                    if metadata.trim_start_seconds is not None and metadata.trim_end_seconds is not None:
                        self._validate_trim_output(request, verified, metadata.trim_end_seconds - metadata.trim_start_seconds)
                    if copy_attempt and (
                        verified.mime_type != "audio/mp4"
                        or not verified.has_audio
                        or verified.has_video
                        or verified.first_audio_codec is None
                        or verified.first_audio_codec.lower() != "aac"
                    ):
                        raise DownloadError(ErrorCode.PROCESSING_FAILED, error_stage=ErrorStage.TRANSCODE)
                    if copy_attempt and verified.size_bytes > upload_limit:
                        self._validate_final_duration(verified)
                        output.unlink(missing_ok=True)
                        output = target
                        metadata = verified
                    timer.finish()
            except ProcessExecutionError as exc:
                target.unlink(missing_ok=True)
                if deadline is not None and exc.result.timed_out and deadline.remaining() <= self.settings.process_term_grace_seconds:
                    raise DownloadError(
                        ErrorCode.PROCESS_TIMEOUT,
                        retryable=True,
                        error_stage=ErrorStage.TRANSCODE,
                    ) from None
                log_event(
                    "transcode_attempt_failed",
                    job_id=request.job_id,
                    state="processing",
                    error_code=ErrorCode.PROCESSING_FAILED.value,
                    error_stage=ErrorStage.TRANSCODE,
                    failure_reason="media_processing_failed",
                    process_name=ProcessName.FFMPEG,
                    process_exit_code=exc.result.returncode,
                    process_timed_out=exc.result.timed_out,
                )
                continue
            except DownloadError as exc:
                if not copy_attempt or exc.code != ErrorCode.PROCESSING_FAILED:
                    raise
                target.unlink(missing_ok=True)
                log_event(
                    "transcode_attempt_failed",
                    job_id=request.job_id,
                    state="processing",
                    error_code=exc.code.value,
                    error_stage=ErrorStage.TRANSCODE,
                    failure_reason=FailureReason.MEDIA_PROCESSING_FAILED,
                    process_name=ProcessName.FFPROBE,
                )
                continue
            if not copy_attempt:
                if last_encoded is not None:
                    last_encoded[0].unlink(missing_ok=True)
                last_encoded = (target, verified)
            if verified.size_bytes <= upload_limit:
                return target, verified
        if input_demuxer:
            if last_encoded is None:
                raise DownloadError(ErrorCode.PROCESSING_FAILED, error_stage=ErrorStage.TRANSCODE)
            return last_encoded
        if request.mode == MediaMode.VIDEO and 0 < (metadata.height or 0) <= (request.maximum_height or 1080):
            return output, metadata
        return last_encoded or (output, metadata)

    async def _stage_transcript(
        self, request: JobRunRequest, output: Path, metadata: MediaMetadata,
        probe: ProbeInfo, workspace: JobWorkspace,
    ) -> dict[str, object]:
        from .transcription import transcribe_audio

        if not metadata.has_audio or metadata.duration is None:
            raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
        with OperationTimer("transcription_timing", job_id=request.job_id, state="processing") as timer:
            document, preview = await transcribe_audio(
                output, workspace.path, title=probe.title, source=probe.extractor or "source",
                duration=metadata.duration, settings=self.settings,
            )
            timer.finish()
        return await self._stage_transcript_document(request, document, preview, metadata.duration, probe, workspace)

    async def _stage_transcript_document(
        self, request: JobRunRequest, document: Path, preview: str, duration: float | None,
        probe: ProbeInfo, workspace: JobWorkspace,
    ) -> dict[str, object]:
        if document.is_symlink():
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        document = workspace.ensure_within(document)
        if document.parent != workspace.path.resolve():
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        document_metadata = MediaMetadata(
            filename=document.name, mimeType="text/markdown", sizeBytes=document.stat().st_size,
            duration=duration, transcriptPreview=preview,
        )
        if document_metadata.size_bytes > self.settings.telegram_upload_limit_bytes:
            raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
        if not 0 < document_metadata.size_bytes <= 2_000_000:
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        transcript_sha256 = hashlib.sha256(document.read_bytes()).hexdigest()
        self._verify_transcript(document, document_metadata, {"transcriptSha256": transcript_sha256})
        workspace.prune(document.name)
        return await self._stage_telegram(request, document, document_metadata, probe, workspace)

    @staticmethod
    def _verify_transcript(output: Path, metadata: MediaMetadata, manifest: dict[str, Any]) -> None:
        if output.is_symlink() or not output.is_file() or metadata.mime_type != "text/markdown" or output.suffix != ".md" or not 0 < metadata.size_bytes <= 2_000_000:
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        if output.stat().st_size != metadata.size_bytes:
            raise DownloadError(ErrorCode.PROCESSING_FAILED)
        content = output.read_bytes()
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise DownloadError(ErrorCode.PROCESSING_FAILED) from exc
        if hashlib.sha256(content).hexdigest() != manifest.get("transcriptSha256"):
            raise DownloadError(ErrorCode.PROCESSING_FAILED)

    async def _stage_telegram(
        self,
        request: JobRunRequest,
        output: Path,
        metadata: MediaMetadata,
        probe: ProbeInfo,
        workspace: JobWorkspace,
    ) -> dict[str, object]:
        if request.mode == MediaMode.VIDEO:
            self._validate_video_height(metadata, request.maximum_height or 1080)
        target = workspace.child(metadata.filename)
        if output != target:
            if target.exists():
                target.unlink()
            output.replace(target)
        deadline = current_deadline()
        manifest = {
            "sourceKind": "telegram_file" if request.telegram_file is not None else "url",
            "operation": request.operation,
            "transcriptMethod": request.transcript_method if request.operation == "transcript" else None,
            "captionLanguage": request.caption_language,
            "maximumHeight": request.maximum_height or 1080,
            "trimStartSeconds": request.trim_start_seconds,
            "trimEndSeconds": request.trim_end_seconds,
            "deadlineAt": deadline.deadline_at if deadline is not None else None,
            "metadata": metadata.model_dump(by_alias=True),
            "probe": {
                "id": probe.id,
                "title": probe.title,
                "extractor": probe.extractor,
                "duration": probe.duration,
                "width": probe.width,
                "height": probe.height,
            },
            "mode": request.mode.value,
        }
        if request.operation == "transcript":
            manifest["transcriptSha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
        workspace.child(".manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
        workspace.retain()
        object_key = f"staged/{request.job_id}/{metadata.filename}"
        return JobSuccess(
            status="prepared",
            delivery="telegram",
            objectKey=object_key,
            filename=metadata.filename,
            mimeType=metadata.mime_type,
            sizeBytes=metadata.size_bytes,
            duration=metadata.duration,
            width=metadata.width,
            height=metadata.height,
            deadlineAt=deadline.deadline_at if deadline is not None else None,
        ).model_dump(by_alias=True, exclude_none=True)

    async def _prepare_r2(
        self,
        request: JobRunRequest,
        output: Path,
        metadata: MediaMetadata,
        validated: ValidatedUrl | None,
    ) -> dict[str, object]:
        if request.mode == MediaMode.VIDEO:
            self._validate_video_height(metadata, request.maximum_height or 1080)
        self._log_state(request, validated, "processing")
        uploader = self._r2_uploader()
        with OperationTimer("r2_upload_timing", job_id=request.job_id, state="uploading") as timer:
            result = await _bounded_await(uploader.upload(
                job_id=request.job_id,
                path=output,
                filename=metadata.filename,
                mime_type=metadata.mime_type,
            ), self.settings.telegram_upload_timeout_seconds)
            timer.finish()
        deadline = current_deadline()
        return JobSuccess(
            status="prepared",
            delivery="r2",
            objectKey=result.object_key,
            filename=metadata.filename,
            mimeType=metadata.mime_type,
            sizeBytes=metadata.size_bytes,
            duration=metadata.duration,
            width=metadata.width,
            height=metadata.height,
            expiresAt=result.expires_at,
            deadlineAt=deadline.deadline_at if deadline is not None else None,
        ).model_dump(by_alias=True, exclude_none=True)

    async def deliver(self, request: JobDeliveryRequest) -> dict[str, object]:
        deadline = self._deadline_for_expiry(self._delivery_deadline_at(request))
        with activate_deadline(deadline):
            return await self._deliver_with_deadline(request)

    async def _deliver_with_deadline(self, request: JobDeliveryRequest) -> dict[str, object]:
        """Perform one non-retryable Telegram delivery.

        The Worker owns waiting-message deletion. The Container only deletes
        its staged directory after Telegram confirms the message. A confirmed
        response remains successful when local cleanup has to be deferred.
        """

        started = time.monotonic()
        try:
            if ("download" if request.operation == "transcript" and request.transcript_method == "captions" else request.operation) != self.settings.job_operation or (request.operation == "transcript" and request.delivery_mode != "telegram"):
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            deadline = current_deadline()
            if deadline is not None:
                deadline.ensure_remaining()
            if request.clip_ranges and request.delivery_mode != "telegram":
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            if request.delivery_mode == "r2":
                return await _bounded_await(self._deliver_r2_link(request, started))
            if request.delivery_mode == "telegram_url":
                return await _bounded_await(self._deliver_direct_url(request, started))
            job_dir = Path(self.settings.jobs_root) / request.job_id
            if job_dir.is_symlink() or not job_dir.is_dir():
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
            filename = request.object_key.split("/", 2)[-1]
            if filename != request.filename:
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            output = Path(self._staged_file(job_dir, filename))
            manifest_path = job_dir / ".manifest.json"
            if not manifest_path.is_file() or manifest_path.is_symlink():
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError) as exc:
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED) from exc
            if request.clip_ranges or manifest.get("kind") == "clip_pack":
                return await self._deliver_clip_pack(request, job_dir, manifest)
            try:
                metadata = MediaMetadata.model_validate(manifest["metadata"])
                probe = ProbeInfo.model_validate(manifest["probe"])
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED) from exc
            if metadata.filename != request.filename or metadata.mime_type != request.mime_type:
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            if not self._manifest_matches(request, manifest):
                raise DownloadError(ErrorCode.INVALID_REQUEST)
            if metadata.size_bytes > self.settings.telegram_upload_limit_bytes:
                raise DownloadError(ErrorCode.TELEGRAM_FILE_TOO_LARGE)
            if request.operation == "transcript":
                self._verify_transcript(output, metadata, manifest)
            else:
                verified = await _bounded_await(verify_media(
                    output,
                    ffprobe_path=self.settings.ffprobe_path,
                    timeout_seconds=self.settings.ffmpeg_timeout_seconds,
                    cwd=job_dir,
                ))
                self._validate_final_duration(verified)
                if request.mode == MediaMode.VIDEO:
                    self._validate_video_height(verified, manifest.get("maximumHeight", 1080))
                if verified.size_bytes != metadata.size_bytes or verified.mime_type != metadata.mime_type:
                    raise DownloadError(ErrorCode.PROCESSING_FAILED)
            client = self._telegram_client()
            if request.operation == "transcript":
                action = "upload_document"
            elif metadata.mime_type in PHOTO_MIME_TYPES:
                action = "upload_photo"
            elif metadata.mime_type.startswith("image/"):
                action = "upload_document"
            else:
                action = "upload_video" if request.mode == MediaMode.VIDEO else "upload_audio"
            await self._send_action(request.telegram_chat_id, action)
            try:
                message = await self._retry_explicit_telegram_rate_limit(
                    request.job_id,
                    lambda: client.send_media(
                        chat_id=request.telegram_chat_id,
                        path=output,
                        metadata=metadata,
                        probe=probe,
                        mode=request.mode,
                    ),
                )
            except DownloadError as exc:
                if request.operation == "transcript":
                    raise
                # Telegram's explicit 413 can use the R2 fallback and an
                # explicit 400 can use one sendDocument retry. Network, 5xx,
                # and unknown errors remain non-retried so an ambiguous upload
                # is never sent a second time through another path.
                if exc.code != ErrorCode.TELEGRAM_FILE_TOO_LARGE:
                    if not (
                        isinstance(exc, TelegramApiError)
                        and exc.code == ErrorCode.TELEGRAM_UPLOAD_FAILED
                        and exc.status_code == 400
                    ):
                        raise
                    try:
                        message = await self._send_document_fallback(
                            client=client,
                            request=request,
                            output=output,
                            metadata=metadata,
                            probe=probe,
                        )
                    except DownloadError as document_exc:
                        if document_exc.code != ErrorCode.TELEGRAM_FILE_TOO_LARGE:
                            raise
                        return await self._fallback_telegram_upload_to_r2(
                            request=request,
                            output=output,
                            metadata=metadata,
                            uploader=self._r2_uploader(),
                            client=client,
                            started=started,
                        )
                    message = self._confirmed_message(message)
                    self._cleanup_workspace(request, state="completed")
                    log_event(
                        "delivery_completed",
                        job_id=request.job_id,
                        state="completed",
                        delivery="telegram",
                        fallback="telegram_document",
                        operation_ms=int((time.monotonic() - started) * 1000),
                        output_size=metadata.size_bytes,
                    )
                    return _telegram_result(message, metadata)
                return await self._fallback_telegram_upload_to_r2(
                    request=request,
                    output=output,
                    metadata=metadata,
                    uploader=self._r2_uploader(),
                    client=client,
                    started=started,
                )
            message = self._confirmed_message(message)
            self._cleanup_workspace(request, state="completed")
            log_event("delivery_completed", job_id=request.job_id, state="completed", operation_ms=int((time.monotonic() - started) * 1000), output_size=metadata.size_bytes)
            return _telegram_result(message, metadata)
        except JobDeadlineExceeded:
            timeout_error = DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, error_stage=ErrorStage.TELEGRAM_DELIVERY)
            self._cleanup_workspace(request, state="failed")
            log_event(
                "delivery_failed",
                job_id=request.job_id,
                state="failed",
                error_code=timeout_error.code.value,
                operation_ms=int((time.monotonic() - started) * 1000),
                **timeout_error.diagnostic_fields(),
            )
            return JobFailure(
                errorCode=timeout_error.code.value,
                safeMessage=timeout_error.safe_message,
                retryable=False,
                # The deadline may fire while Telegram is still reading a
                # response after the provider accepted the request. Keep the
                # result unknown so the Worker never sends a second copy.
                outcome="ambiguous",
            ).model_dump(by_alias=True, exclude_none=True)
        except DownloadError as exc:
            # Delivery is deliberately non-retried. Once it has failed, no
            # caller can safely reuse the staged file, so remove it even when
            # Telegram's response was ambiguous.
            self._cleanup_workspace(request, state="failed")
            log_event(
                "delivery_failed",
                job_id=request.job_id,
                state="failed",
                error_code=exc.code.value,
                operation_ms=int((time.monotonic() - started) * 1000),
                **exc.diagnostic_fields(),
            )
            return JobFailure(
                errorCode=exc.code.value,
                safeMessage=exc.safe_message,
                retryable=False,
                outcome=_delivery_outcome_for_error(exc),
                retryAfterSeconds=None if request.clip_ranges else _retry_after_for_error(exc),
            ).model_dump(by_alias=True, exclude_none=True)
        except Exception:
            self._cleanup_workspace(request, state="failed")
            delivery_error = DownloadError(ErrorCode.TELEGRAM_UPLOAD_FAILED, error_stage=ErrorStage.TELEGRAM_DELIVERY)
            log_event(
                "delivery_failed",
                job_id=request.job_id,
                state="failed",
                error_code=delivery_error.code.value,
                operation_ms=int((time.monotonic() - started) * 1000),
                **delivery_error.diagnostic_fields(),
            )
            return JobFailure(
                errorCode=ErrorCode.TELEGRAM_UPLOAD_FAILED,
                safeMessage=DownloadError(ErrorCode.TELEGRAM_UPLOAD_FAILED).safe_message,
                retryable=False,
                outcome="ambiguous",
            ).model_dump(by_alias=True, exclude_none=True)

    async def _deliver_direct_url(self, request: JobDeliveryRequest, started: float) -> dict[str, object]:
        """Send the provider URL retained in the private direct manifest."""

        expected_key = f"staged/{request.job_id}/remote.mp4"
        if request.object_key != expected_key or request.filename == "remote.mp4":
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        job_dir = Path(self.settings.jobs_root) / request.job_id
        if job_dir.is_symlink() or not job_dir.is_dir():
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
        manifest_path = job_dir / ".manifest.json"
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            metadata = MediaMetadata.model_validate(manifest["metadata"])
            probe = ProbeInfo.model_validate(manifest["probe"])
            provider = manifest.get("provider")
            direct_url = manifest.get("directUrl")
            if manifest.get("kind") != "direct" or provider not in {"tiktok", "x"} or not isinstance(direct_url, str):
                raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
            safe_url = validate_direct_media_url(
                direct_url,
                provider=provider,
                resolve_dns=self.settings.resolve_source_dns,
            )
        except DownloadError:
            raise
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED) from exc
        if (
            metadata.filename != request.filename
            or metadata.mime_type != request.mime_type
            or metadata.size_bytes != request.size_bytes
            or metadata.mime_type != "video/mp4"
            or metadata.size_bytes > min(self.settings.telegram_url_limit_bytes, self.settings.max_source_download_bytes)
            or request.mode != MediaMode.VIDEO
        ):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        if metadata.duration is not None and metadata.duration > self.settings.max_duration_seconds:
            raise DownloadError(ErrorCode.DURATION_LIMIT)
        self._validate_video_height(metadata, manifest.get("maximumHeight", 1080))
        client = self._telegram_client()
        try:
            message = await self._retry_explicit_telegram_rate_limit(
                request.job_id,
                lambda: client.send_video_url(
                    chat_id=request.telegram_chat_id,
                    url=safe_url,
                    metadata=metadata,
                    probe=probe,
                ),
            )
        except TelegramApiError as exc:
            # An explicit 400 proves Telegram did not accept this URL and is
            # safe to recover with one bounded local multipart upload. Network,
            # 5xx, and unknown responses remain terminal to avoid duplicates.
            if exc.code != ErrorCode.TELEGRAM_UPLOAD_FAILED or exc.status_code != 400:
                raise
            message = await self._direct_multipart_fallback(
                request=request,
                job_dir=job_dir,
                safe_url=safe_url,
                maximum_height=manifest.get("maximumHeight", 1080),
                metadata=metadata,
                probe=probe,
                client=client,
            )
        message = self._confirmed_message(message)
        self._cleanup_workspace(request, state="completed")
        log_event(
            "delivery_completed",
            job_id=request.job_id,
            state="completed",
            delivery="telegram_url",
            operation_ms=int((time.monotonic() - started) * 1000),
            output_size=metadata.size_bytes,
        )
        return _telegram_result(message, metadata)

    async def _direct_multipart_fallback(
        self,
        *,
        request: JobDeliveryRequest,
        job_dir: Path,
        safe_url: str,
        maximum_height: int,
        metadata: MediaMetadata,
        probe: ProbeInfo,
        client: MediaDelivery,
    ) -> TelegramMessage:
        target = Path(safe_child_path(job_dir, job_dir / metadata.filename))
        if target.parent != job_dir or target.exists() or target.is_symlink():
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        message: TelegramMessage | None = None
        try:
            async with PublicEgressProxy() as egress_proxy:
                with OperationTimer("download_timing", job_id=request.job_id, state="downloading") as timer:
                    await download_direct_media(
                        safe_url,
                        target,
                        max_bytes=min(
                            self.settings.telegram_upload_limit_bytes,
                            self.settings.max_source_download_bytes,
                        ),
                        timeout_seconds=self.settings.download_timeout_seconds,
                        proxy_url=egress_proxy.url,
                    )
                    timer.finish()
            verified = await _bounded_await(verify_media(
                target,
                ffprobe_path=self.settings.ffprobe_path,
                timeout_seconds=self.settings.ffmpeg_timeout_seconds,
                cwd=job_dir,
            ), self.settings.ffmpeg_timeout_seconds)
            self._validate_final_duration(verified)
            self._validate_video_height(verified, maximum_height)
            if (
                verified.size_bytes != metadata.size_bytes
                or verified.mime_type != "video/mp4"
                or not verified.has_video
            ):
                raise DownloadError(ErrorCode.PROCESSING_FAILED)
            message = await self._retry_explicit_telegram_rate_limit(
                request.job_id,
                lambda: client.send_media(
                    chat_id=request.telegram_chat_id,
                    path=target,
                    metadata=verified,
                    probe=probe,
                    mode=MediaMode.VIDEO,
                ),
            )
        finally:
            self._cleanup_path(request, target, state="completed" if message is not None else "failed")
        if message is None:
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
        return message

    async def _send_document_fallback(
        self,
        *,
        client: MediaDelivery,
        request: JobDeliveryRequest,
        output: Path,
        metadata: MediaMetadata,
        probe: ProbeInfo,
    ) -> TelegramMessage:
        sender = getattr(client, "send_document", None)
        if not callable(sender):
            raise DownloadError(ErrorCode.TELEGRAM_UPLOAD_FAILED)
        async def send() -> TelegramMessage:
            return cast(
                TelegramMessage,
                await sender(
                    chat_id=request.telegram_chat_id,
                    path=output,
                    metadata=metadata,
                    probe=probe,
                    mode=request.mode,
                ),
            )

        return await self._retry_explicit_telegram_rate_limit(
            request.job_id,
            send,
        )

    async def _retry_explicit_telegram_rate_limit(
        self,
        job_id: str,
        operation: Callable[[], Awaitable[TelegramMessage]],
    ) -> TelegramMessage:
        """Retry only Telegram's explicit 429 rejection, which confirms no send."""

        for retry_count in range(self.settings.max_retries + 1):
            attempt_started = False

            async def invoke() -> TelegramMessage:
                nonlocal attempt_started
                attempt_started = True
                return await operation()

            try:
                with OperationTimer("telegram_send_timing", job_id=job_id, state="uploading") as timer:
                    message = await _bounded_await(invoke(), self.settings.telegram_upload_timeout_seconds)
                    timer.finish()
                return message
            except JobDeadlineExceeded:
                if attempt_started:
                    raise TelegramApiError(
                        ErrorCode.TELEGRAM_UPLOAD_FAILED,
                        outcome="ambiguous",
                    ) from None
                raise
            except TimeoutError as exc:
                raise TelegramApiError(
                    ErrorCode.TELEGRAM_UPLOAD_FAILED,
                    retryable=True,
                    outcome="ambiguous",
                ) from exc
            except TelegramApiError as exc:
                if exc.code != ErrorCode.TELEGRAM_RATE_LIMITED or retry_count >= self.settings.max_retries:
                    raise
                delay = exc.retry_after
                if delay is None:
                    # Missing or malformed metadata does not prove that a
                    # later attempt is safe to schedule. Telegram already
                    # rejected this attempt, so return that rejection without
                    # inventing a backoff or sending again.
                    raise
                deadline = current_deadline()
                if deadline is not None and delay >= deadline.remaining():
                    # Preserve the provider's full delay by leaving it on the
                    # explicit rejection; the current request cannot wait for
                    # it without crossing its absolute deadline.
                    raise
                log_event(
                    "telegram_rate_limit_retry",
                    job_id=job_id,
                    state="uploading",
                    retry_count=retry_count + 1,
                )
                try:
                    await _bounded_sleep(delay)
                except JobDeadlineExceeded:
                    # No send started during the sleep; retain the proven
                    # Telegram rejection rather than converting it to an
                    # ambiguous delivery outcome.
                    raise exc from None
        raise DownloadError(ErrorCode.TELEGRAM_RATE_LIMITED)

    async def _fallback_telegram_upload_to_r2(
        self,
        *,
        request: JobDeliveryRequest,
        output: Path,
        metadata: MediaMetadata,
        uploader: ObjectUploader,
        client: MediaDelivery,
        started: float,
    ) -> dict[str, object]:
        """Send one signed R2 link after Telegram explicitly returns 413."""

        with OperationTimer("r2_upload_timing", job_id=request.job_id, state="uploading") as timer:
            uploaded = await _bounded_await(
                uploader.upload(
                    job_id=request.job_id,
                    path=output,
                    filename=metadata.filename,
                    mime_type=metadata.mime_type,
                ),
                self.settings.telegram_upload_timeout_seconds,
            )
            timer.finish()
        object_key = getattr(uploaded, "object_key", None)
        if not isinstance(object_key, str) or not object_key.startswith(f"jobs/{request.job_id}/"):
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
        url: object
        expires_at: object
        builder = getattr(uploader, "download_url_for", None)
        if callable(builder):
            url, expires_at = builder(object_key=object_key, filename=metadata.filename)
        else:
            url = getattr(uploaded, "download_url", None)
            expires_at = getattr(uploaded, "expires_at", None)
        if not isinstance(url, str) or not url.startswith("https://") or not isinstance(expires_at, str):
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
        message = await self._retry_explicit_telegram_rate_limit(
            request.job_id,
            lambda: client.send_download_link(
                chat_id=request.telegram_chat_id,
                filename=metadata.filename,
                size_bytes=metadata.size_bytes,
                expires_at=expires_at,
                url=url,
            ),
        )
        message = self._confirmed_message(message)
        self._cleanup_workspace(request, state="completed")
        log_event(
            "delivery_completed",
            job_id=request.job_id,
            state="completed",
            delivery="r2",
            fallback="telegram_file_too_large",
            operation_ms=int((time.monotonic() - started) * 1000),
            output_size=metadata.size_bytes,
        )
        return {
            "status": "completed",
            "delivery": "r2",
            "telegramMessageId": str(message.message_id),
            "objectKey": object_key,
            "filename": metadata.filename,
            "mimeType": metadata.mime_type,
            "sizeBytes": metadata.size_bytes,
            "expiresAt": expires_at,
        }

    async def _deliver_r2_link(self, request: JobDeliveryRequest, started: float) -> dict[str, object]:
        if not request.object_key.startswith(f"jobs/{request.job_id}/"):
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        if request.object_key.rsplit("/", 1)[-1] != request.filename:
            raise DownloadError(ErrorCode.INVALID_REQUEST)
        uploader = self._r2_uploader()
        builder = getattr(uploader, "download_url_for", None)
        if not callable(builder):
            raise DownloadError(ErrorCode.R2_UPLOAD_FAILED)
        url, expires_at = builder(object_key=request.object_key, filename=request.filename)
        client = self._telegram_client()
        message = await self._retry_explicit_telegram_rate_limit(
            request.job_id,
            lambda: client.send_download_link(
                chat_id=request.telegram_chat_id,
                filename=request.filename,
                size_bytes=request.size_bytes,
                expires_at=expires_at,
                url=url,
            ),
        )
        message = self._confirmed_message(message)
        self._cleanup_workspace(request, state="completed")
        log_event("r2_link_delivered", job_id=request.job_id, state="completed", operation_ms=int((time.monotonic() - started) * 1000))
        return {
            "status": "completed",
            "delivery": "r2",
            "telegramMessageId": str(message.message_id),
            "objectKey": request.object_key,
            "filename": request.filename,
            "mimeType": request.mime_type,
            "sizeBytes": request.size_bytes,
            "expiresAt": expires_at,
        }

    @staticmethod
    def _staged_file(job_dir: Path, filename: str) -> str:
        candidate = Path(safe_child_path(job_dir, job_dir / filename))
        if candidate.parent != job_dir or candidate.name != filename or candidate.is_symlink() or not candidate.is_file():
            raise DownloadError(ErrorCode.DOWNLOAD_FAILED)
        return str(candidate)

    @staticmethod
    def _confirmed_message(message: object) -> TelegramMessage:
        try:
            message_id = validate_telegram_message_id(getattr(message, "message_id", None))
            file_id = getattr(message, "file_id", None)
            media_method = getattr(message, "media_method", None)
        except TelegramApiError:
            raise
        except Exception as exc:
            raise TelegramApiError(ErrorCode.TELEGRAM_UPLOAD_FAILED) from exc
        return TelegramMessage(
            message_id,
            file_id=file_id if isinstance(file_id, str) else None,
            media_method=media_method if isinstance(media_method, str) else None,
        )

    def _cleanup_workspace(self, request: JobDeliveryRequest, *, state: str) -> None:
        try:
            JobWorkspace.cleanup_existing(self.settings.jobs_root, request.job_id)
        except Exception:
            # A confirmed send is durable at Telegram even when local cleanup
            # fails; maintenance can retry the bounded workspace cleanup.
            log_event("delivery_cleanup_deferred", job_id=request.job_id, state=state)

    @staticmethod
    def _cleanup_path(request: JobDeliveryRequest, path: Path, *, state: str) -> None:
        try:
            path.unlink()
        except FileNotFoundError:
            return
        except Exception:
            log_event("delivery_cleanup_deferred", job_id=request.job_id, state=state)

    async def _send_action(self, chat_id: str, action: str) -> None:
        try:
            await _bounded_await(
                self._telegram_client().send_chat_action(chat_id=chat_id, action=action),
                CHAT_ACTION_TIMEOUT_SECONDS,
            )
        except Exception:
            # Chat actions are best-effort and never alter delivery semantics.
            return

    def _log_state(self, request: JobRunRequest, validated: ValidatedUrl | None, state: str) -> None:
        log_event(
            "job_state",
            job_id=request.job_id,
            source_host=validated.hostname if validated else None,
            state=state,
        )
