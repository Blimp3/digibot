"""Bounded local Whisper transcription for already verified media files."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import unicodedata
import wave
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .deadline import JobDeadline, JobDeadlineExceeded, activate_deadline, current_deadline
from .errors import DownloadError, ErrorCode
from .process import ProcessExecutionError, run_process
from .security import safe_child_path, sanitize_filename

WHISPER_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
WHISPER_MODEL_SHA256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
WHISPER_METHOD = "Automatic speech transcription (Whisper small)"
DEFAULT_MAX_CAPTION_CHARS = 600
DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024
# Keep this below the delivery verifier's hard 2,000,000-byte transcript cap.
DEFAULT_MAX_MARKDOWN_BYTES = 2_000_000
DEFAULT_MAX_SEGMENTS = 10_000
TIMESTAMP_TOLERANCE_SECONDS = 0.5
_TIMESTAMP_RE = re.compile(r"^(?P<hours>\d+):(?P<minutes>[0-5]\d):(?P<seconds>[0-5]\d),(?P<millis>\d{3})$")


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start_seconds: float
    end_seconds: float
    text: str


def _processing_error(detail: str) -> DownloadError:
    return DownloadError(ErrorCode.PROCESSING_FAILED, detail=detail)


def _parse_timestamp(value: object) -> float:
    if not isinstance(value, str):
        raise _processing_error("invalid transcript timestamp")
    match = _TIMESTAMP_RE.fullmatch(value)
    if match is None:
        raise _processing_error("invalid transcript timestamp")
    return (
        int(match.group("hours")) * 3_600
        + int(match.group("minutes")) * 60
        + int(match.group("seconds"))
        + int(match.group("millis")) / 1_000
    )


def _clean_segment_text(value: object) -> str:
    if not isinstance(value, str) or "\x00" in value:
        raise _processing_error("invalid transcript text")
    cleaned = " ".join(value.split())
    if any(ord(char) < 0x20 and char not in "\t\n\r" for char in cleaned):
        raise _processing_error("invalid transcript text")
    return cleaned


def parse_transcription_json(
    document: str | bytes | bytearray,
    *,
    duration: float,
    max_segments: int = DEFAULT_MAX_SEGMENTS,
) -> tuple[TranscriptSegment, ...]:
    """Parse whisper.cpp JSON and enforce bounded, monotonic segment times."""

    if isinstance(document, bytes | bytearray):
        try:
            document = bytes(document).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _processing_error("transcript JSON is not UTF-8") from exc
    if not isinstance(document, str):
        raise _processing_error("invalid transcript JSON")
    if isinstance(duration, bool) or not isinstance(duration, int | float) or not math.isfinite(float(duration)):
        raise _processing_error("invalid media duration")
    duration_value = float(duration)
    if duration_value <= 0:
        raise _processing_error("invalid media duration")
    if isinstance(max_segments, bool) or not isinstance(max_segments, int) or max_segments <= 0:
        raise ValueError("max_segments must be positive")
    try:
        parsed: object = json.loads(document)
    except json.JSONDecodeError as exc:
        raise _processing_error("invalid transcript JSON") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get("transcription"), list):
        raise _processing_error("invalid transcript JSON")
    raw_segments = parsed["transcription"]
    if len(raw_segments) > max_segments:
        raise _processing_error("too many transcript segments")

    segments: list[TranscriptSegment] = []
    previous_end = 0.0
    for raw in raw_segments:
        if not isinstance(raw, dict) or not isinstance(raw.get("timestamps"), dict):
            raise _processing_error("invalid transcript segment")
        timestamps = raw["timestamps"]
        start = _parse_timestamp(timestamps.get("from"))
        end = _parse_timestamp(timestamps.get("to"))
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise _processing_error("invalid transcript segment time")
        if start < previous_end:
            raise _processing_error("non-monotonic transcript timestamps")
        if end > duration_value + TIMESTAMP_TOLERANCE_SECONDS:
            raise _processing_error("transcript timestamp exceeds media duration")
        text = _clean_segment_text(raw.get("text"))
        if text:
            segments.append(TranscriptSegment(start, end, text))
        previous_end = end
    return tuple(segments)


def _format_timestamp(seconds: float) -> str:
    milliseconds = int(round(seconds * 1_000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}"


def _display_text(value: str, *, fallback: str, max_length: int) -> str:
    normalized = unicodedata.normalize("NFKC", value or "")
    normalized = " ".join(normalized.split())
    cleaned = "".join(char if ord(char) >= 0x20 and ord(char) != 0x7F else "_" for char in normalized)
    return cleaned[:max_length].rstrip() or fallback


def _build_markdown(
    *,
    title: str,
    source: str,
    duration: float,
    segments: tuple[TranscriptSegment, ...],
    method: str = WHISPER_METHOD,
    language: str | None = None,
) -> str:
    paragraphs = [f"[{_format_timestamp(segment.start_seconds)}] {segment.text}" for segment in segments]
    body = "\n\n".join(paragraphs) if paragraphs else "_(No speech was detected.)_"
    return (
        f"# {title}\n\n"
        f"Source: {source}\n"
        f"Duration: {_format_timestamp(duration)}\n\n"
        f"Method: {method}\n"
        + (f"Language: {language}\n" if language else "")
        + "\n"
        f"## Transcript\n\n"
        f"{body}\n"
    )


def _build_caption(*, segments: tuple[TranscriptSegment, ...], limit: int) -> str:
    if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
        raise ValueError("caption limit must be positive")
    preview = " ".join(segment.text for segment in segments)
    if len(preview) <= limit:
        return preview
    if limit == 1:
        return "…"
    return preview[: limit - 1].rstrip() + "…"


def _directory_size(root: Path, max_bytes: int) -> int:
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [entry for entry in dirs if not (Path(directory) / entry).is_symlink()]
        for filename in files:
            path = Path(directory) / filename
            if path.is_symlink():
                continue
            try:
                total += path.stat().st_size
            except OSError as exc:
                raise _processing_error("cannot inspect transcription workspace") from exc
            if total > max_bytes:
                raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
    return total


def _regular_file(path: Path, *, detail: str) -> Path:
    if path.is_symlink() or not path.is_file():
        raise _processing_error(detail)
    return path


def _is_zero_pcm(path: Path, *, duration: float, resource_check: Callable[[], object]) -> bool:
    """Validate the converted PCM completely, including after a nonzero sample."""

    deadline = current_deadline()
    try:
        resource_check()
        if deadline is not None:
            deadline.ensure_remaining()
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16_000, "NONE"):
                raise _processing_error("audio conversion produced an invalid PCM format")
            remaining = audio.getnframes()
            if not 0 < remaining <= math.ceil((duration + TIMESTAMP_TOLERANCE_SECONDS) * 16_000):
                raise _processing_error("audio conversion produced an invalid PCM duration")
            zero = True
            while remaining:
                if deadline is not None:
                    deadline.ensure_remaining()
                resource_check()
                frames = min(remaining, 16_000)
                data = audio.readframes(frames)
                if len(data) != frames * 2:
                    raise _processing_error("audio conversion produced truncated PCM")
                zero = zero and not any(data)
                remaining -= frames
            if audio.readframes(1):
                raise _processing_error("audio conversion produced an incomplete PCM frame")
        if deadline is not None:
            deadline.ensure_remaining()
        # Known limit: decoded exact zero only; broader suppression needs quiet-speech calibration.
        return zero
    except JobDeadlineExceeded:
        raise
    except (OSError, EOFError, wave.Error) as exc:
        raise _processing_error("audio conversion produced invalid WAV data") from exc


def _read_bounded_utf8(path: Path, max_bytes: int) -> str:
    path = _regular_file(path, detail="transcript JSON was not produced")
    try:
        size = path.stat().st_size
        if size > max_bytes:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        return path.read_bytes().decode("utf-8")
    except DownloadError:
        raise
    except (OSError, UnicodeDecodeError) as exc:
        raise _processing_error("transcript JSON could not be read") from exc


def _validate_settings(settings: Settings) -> None:
    for name in ("ffmpeg_path", "whisper_path", "whisper_model_path"):
        value = getattr(settings, name, None)
        if not isinstance(value, str) or not value or not Path(value).is_absolute() or "\x00" in value:
            raise _processing_error("transcription dependency path is invalid")
    threads = getattr(settings, "whisper_threads", None)
    if isinstance(threads, bool) or not isinstance(threads, int) or not 1 <= threads <= 4:
        raise _processing_error("transcription thread count is invalid")
    for name in ("job_timeout_seconds", "ffmpeg_timeout_seconds", "process_term_grace_seconds", "max_temp_disk_bytes"):
        value = getattr(settings, name, None)
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(float(value)) or value <= 0:
            raise _processing_error("transcription resource limit is invalid")


def _map_process_error(exc: ProcessExecutionError) -> DownloadError:
    if exc.result.timed_out:
        return DownloadError(ErrorCode.PROCESS_TIMEOUT, retryable=True)
    return _processing_error("transcription process failed")


@contextmanager
def _use_deadline(deadline: JobDeadline | None) -> Iterator[None]:
    """Activate a supplied deadline without replacing an existing request scope."""

    if current_deadline() is not None or deadline is None:
        yield
        return
    with activate_deadline(deadline):
        yield


async def _transcribe_audio(
    audio_path: Path,
    output_dir: Path,
    *,
    title: str,
    source: str,
    duration: float,
    settings: Settings,
    resource_check: Callable[[], object],
) -> tuple[Path, str]:
    _validate_settings(settings)
    if isinstance(duration, bool) or not isinstance(duration, int | float) or not math.isfinite(float(duration)):
        raise _processing_error("invalid media duration")
    duration_value = float(duration)
    if duration_value <= 0 or duration_value > float(settings.max_duration_seconds):
        raise DownloadError(ErrorCode.DURATION_LIMIT)

    audio_path = Path(audio_path)
    if audio_path.is_symlink() or not audio_path.is_file():
        raise _processing_error("verified audio file is unavailable")
    try:
        audio_size = audio_path.stat().st_size
    except OSError as exc:
        raise _processing_error("verified audio file cannot be inspected") from exc
    if audio_size <= 0 or audio_size > settings.max_source_download_bytes:
        raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)

    output_dir = Path(output_dir)
    if output_dir.exists() and output_dir.is_symlink():
        raise _processing_error("transcription output directory is unsafe")
    try:
        output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        output_dir = output_dir.resolve(strict=True)
    except OSError as exc:
        raise _processing_error("transcription output directory is unavailable") from exc
    if not output_dir.is_dir():
        raise _processing_error("transcription output directory is invalid")

    safe_title = sanitize_filename(title, fallback="transcript", max_length=120)
    display_title = _display_text(title, fallback=safe_title, max_length=180)
    safe_source = _display_text(source, fallback="source", max_length=80)
    output_path = Path(safe_child_path(output_dir, output_dir / f"{safe_title}.md"))
    if output_path.exists() or output_path.is_symlink():
        raise _processing_error("transcript output already exists")
    resource_check()

    with tempfile.TemporaryDirectory(prefix=".transcription-", dir=output_dir) as temporary:
        temporary_dir = Path(temporary)
        wav_path = temporary_dir / "audio.wav"
        json_base = temporary_dir / "transcript"
        ffmpeg_args = [
            settings.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            str(audio_path),
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ]
        try:
            await run_process(
                ffmpeg_args,
                cwd=temporary_dir,
                timeout_seconds=float(settings.ffmpeg_timeout_seconds),
                term_grace_seconds=float(settings.process_term_grace_seconds),
                max_stdout_bytes=64 * 1024,
                max_stderr_bytes=256 * 1024,
                resource_check=resource_check,
            )
        except ProcessExecutionError as exc:
            raise _map_process_error(exc) from None
        _regular_file(wav_path, detail="audio conversion produced no file")
        if wav_path.stat().st_size <= 44:
            raise _processing_error("audio conversion produced an empty file")

        zero_pcm = _is_zero_pcm(wav_path, duration=duration_value, resource_check=resource_check)
        segments: tuple[TranscriptSegment, ...] = ()
        if not zero_pcm:
            whisper_args = [
                settings.whisper_path,
                "-m",
                settings.whisper_model_path,
                "-f",
                str(wav_path),
                "--no-gpu",
                "--threads",
                str(settings.whisper_threads),
                "--processors",
                "1",
                "--language",
                "auto",
                "--output-json",
                "--no-prints",
                "--output-file",
                str(json_base),
            ]
            try:
                await run_process(
                    whisper_args,
                    cwd=Path(settings.whisper_path).parent,
                    timeout_seconds=float(settings.job_timeout_seconds),
                    term_grace_seconds=float(settings.process_term_grace_seconds),
                    max_stdout_bytes=64 * 1024,
                    max_stderr_bytes=256 * 1024,
                    resource_check=resource_check,
                )
            except ProcessExecutionError as exc:
                raise _map_process_error(exc) from None
            segments = parse_transcription_json(
                _read_bounded_utf8(json_base.with_suffix(".json"), DEFAULT_MAX_JSON_BYTES),
                duration=duration_value,
            )
        markdown = _build_markdown(
            title=display_title, source=safe_source, duration=duration_value, segments=segments,
            method="Digital silence check (Whisper skipped)" if zero_pcm else WHISPER_METHOD,
        )
        encoded = markdown.encode("utf-8")
        if len(encoded) > DEFAULT_MAX_MARKDOWN_BYTES:
            raise DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        try:
            markdown_temp = temporary_dir / "transcript.md"
            markdown_temp.write_bytes(encoded)
            _directory_size(output_dir, int(settings.max_temp_disk_bytes))
            os.replace(markdown_temp, output_path)
        except OSError as exc:
            raise _processing_error("transcript Markdown could not be written") from exc
    return output_path, _build_caption(segments=segments, limit=DEFAULT_MAX_CAPTION_CHARS)


async def transcribe_audio(
    audio_path: str | Path,
    output_dir: str | Path,
    *,
    title: str,
    source: str,
    duration: float,
    settings: Settings | None = None,
    deadline: JobDeadline | None = None,
) -> tuple[Path, str]:
    """Convert verified local audio and write a bounded Markdown transcript.

    The caller owns source acquisition and delivery. This function only runs
    local FFmpeg and whisper.cpp processes and returns the Markdown path plus a
    Telegram-safe preview caption.
    """

    active_settings = settings or Settings()
    output_path = Path(output_dir)

    def resource_check() -> None:
        _directory_size(output_path, int(active_settings.max_temp_disk_bytes))

    with _use_deadline(deadline):
        active = current_deadline()
        if active is not None:
            active.ensure_remaining()
        return await _transcribe_audio(
            Path(audio_path),
            output_path,
            title=title,
            source=source,
            duration=duration,
            settings=active_settings,
            resource_check=resource_check,
        )


__all__ = [
    "DEFAULT_MAX_CAPTION_CHARS",
    "TranscriptSegment",
    "WHISPER_MODEL_SHA256",
    "WHISPER_MODEL_URL",
    "parse_transcription_json",
    "transcribe_audio",
]
