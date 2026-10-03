"""FFprobe-backed final-file verification and metadata extraction."""

from __future__ import annotations

import json
import math
import mimetypes
from pathlib import Path
from typing import Any

from .errors import DownloadError, ErrorCode
from .models import MediaMetadata
from .process import ProcessExecutionError, run_process
from .security import sanitize_filename

MAX_TELEGRAM_STREAMS = 16
MAX_TELEGRAM_DURATION_SECONDS = 2 * 60 * 60
MAX_TELEGRAM_DIMENSION = 3840
MAX_TELEGRAM_SHORT_DIMENSION = 2160
MAX_TELEGRAM_PIXELS = 3840 * 2160
MAX_TELEGRAM_FRAME_RATE = 60
MAX_TELEGRAM_PIXEL_RATE = MAX_TELEGRAM_PIXELS * MAX_TELEGRAM_FRAME_RATE
MAX_TELEGRAM_AUDIO_CHANNELS = 8
MAX_TELEGRAM_AUDIO_SAMPLE_RATE = 192_000

_TELEGRAM_FORMAT_DEMUXERS = {
    "mov,mp4,m4a,3gp,3g2,mj2": "mov",
    "matroska,webm": "matroska",
    "ogg": "ogg",
    "mp3": "mp3",
    "wav": "wav",
    "flac": "flac",
    "mpegts": "mpegts",
}


def _sniff_telegram_demuxer(path: Path, size: int) -> str:
    try:
        with path.open("rb") as handle:
            head = handle.read(512)
    except OSError:
        raise DownloadError(ErrorCode.PROCESSING_FAILED) from None
    if len(head) >= 12 and head[4:8] == b"ftyp" and 8 <= int.from_bytes(head[:4], "big") <= size:
        return "mov"
    if head.startswith(b"\x1aE\xdf\xa3"):
        return "matroska"
    if head.startswith(b"OggS"):
        return "ogg"
    if head.startswith(b"fLaC"):
        return "flac"
    if len(head) >= 12 and head[:4] in {b"RIFF", b"RF64", b"BW64"} and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith(b"ID3") or (
        len(head) >= 2
        and head[0] == 0xFF
        and head[1] & 0xE0 == 0xE0
        and head[1] & 0x18 != 0x08
        and head[1] & 0x06 != 0
    ):
        return "mp3"
    if len(head) > 376 and head[0] == head[188] == head[376] == 0x47:
        return "mpegts"
    raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)


def _format_demuxer(format_name: Any) -> str | None:
    return _TELEGRAM_FORMAT_DEMUXERS.get(format_name) if isinstance(format_name, str) else None


def telegram_input_demuxer(metadata: MediaMetadata) -> str:
    """Return the exact safe demuxer verified for a Telegram input."""

    demuxer = _format_demuxer(metadata.format_name)
    if demuxer is None:
        raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
    return demuxer


def _positive_int(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value if value > 0 else None
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _frame_rate(stream: dict[str, Any]) -> float | None:
    for key in ("avg_frame_rate", "r_frame_rate"):
        value = stream.get(key)
        if not isinstance(value, str) or len(value) > 32:
            continue
        numerator, separator, denominator = value.partition("/")
        if not separator or not numerator.isdigit() or not denominator.isdigit():
            continue
        bottom = int(denominator)
        rate = int(numerator) / bottom if bottom else 0
        if math.isfinite(rate) and rate > 0:
            return rate
    return None


def _validate_telegram_streams(
    streams: list[dict[str, Any]],
    format_info: dict[str, Any],
    expected_demuxer: str,
) -> None:
    if len(streams) > MAX_TELEGRAM_STREAMS or _format_demuxer(format_info.get("format_name")) != expected_demuxer:
        raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
    durations = [_number(format_info.get("duration")), *(_number(stream.get("duration")) for stream in streams)]
    duration = max((value for value in durations if value is not None and math.isfinite(value)), default=None)
    if duration is None or not 0 < duration <= MAX_TELEGRAM_DURATION_SECONDS:
        raise DownloadError(ErrorCode.DURATION_LIMIT)
    playable = False
    for stream in streams:
        stream_type = stream.get("codec_type")
        attached = isinstance(stream.get("disposition"), dict) and stream["disposition"].get("attached_pic") == 1
        if stream_type == "video" and not attached:
            playable = True
            width, height, rate = _positive_int(stream.get("width")), _positive_int(stream.get("height")), _frame_rate(stream)
            if (
                width is None
                or height is None
                or rate is None
                or max(width, height) > MAX_TELEGRAM_DIMENSION
                or min(width, height) > MAX_TELEGRAM_SHORT_DIMENSION
                or width * height > MAX_TELEGRAM_PIXELS
                or rate > MAX_TELEGRAM_FRAME_RATE
                or width * height * rate > MAX_TELEGRAM_PIXEL_RATE
            ):
                raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
        elif stream_type == "audio":
            playable = True
            channels = _positive_int(stream.get("channels"))
            sample_rate = _positive_int(stream.get("sample_rate"))
            if (
                channels is None
                or sample_rate is None
                or channels > MAX_TELEGRAM_AUDIO_CHANNELS
                or sample_rate > MAX_TELEGRAM_AUDIO_SAMPLE_RATE
            ):
                raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)
    if not playable:
        raise DownloadError(ErrorCode.UNSUPPORTED_MEDIA)


def _mime_for_streams(
    path: Path,
    streams: list[dict[str, Any]],
    format_info: dict[str, Any],
    *,
    telegram_input: bool = False,
) -> str:
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    format_name = format_info.get("format_name")
    if telegram_input:
        demuxer = _format_demuxer(format_name)
        if video:
            return {"mov": "video/mp4", "matroska": "video/webm", "ogg": "video/ogg", "mpegts": "video/mp2t"}.get(
                demuxer or "", "video/mp4"
            )
        if has_audio:
            return {
                "mov": "audio/mp4", "matroska": "audio/webm", "ogg": "audio/ogg", "mp3": "audio/mpeg",
                "wav": "audio/wav", "flac": "audio/flac", "mpegts": "audio/mp2t",
            }.get(demuxer or "", "audio/mpeg")
    if len(video) == 1 and not has_audio:
        codec = video[0].get("codec_name")
        image_formats = {
            "mjpeg": ({"image2", "jpeg_pipe"}, "image/jpeg"),
            "png": ({"image2", "png_pipe"}, "image/png"),
            "bmp": ({"image2", "bmp_pipe"}, "image/bmp"),
            "tiff": ({"image2", "tiff_pipe"}, "image/tiff"),
            "gif": ({"gif"}, "image/gif"),
            "webp": ({"image2", "webp_pipe"}, "image/webp"),
        }
        formats, mime = image_formats.get(str(codec), (set(), ""))
        if format_name in formats:
            return mime
        tags = format_info.get("tags", {})
        brand = tags.get("major_brand") if isinstance(tags, dict) else None
        if format_name == "mov,mp4,m4a,3gp,3g2,mj2" and str(video[0].get("nb_frames")) == "1":
            if codec == "av1" and brand == "avif":
                return "image/avif"
            if codec == "hevc" and brand in {"heic", "heix", "mif1"}:
                return "image/heic"
    guessed = mimetypes.guess_type(path.name)[0] or ""
    if video:
        return guessed if guessed.startswith("video/") else "video/mp4"
    if has_audio:
        if path.suffix.lower() in {".m4a", ".mp4", ".aac"}:
            return "audio/mp4"
        return guessed if guessed.startswith("audio/") else "audio/mpeg"
    return "application/octet-stream"


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


async def verify_media(
    path: str | Path,
    *,
    ffprobe_path: str,
    timeout_seconds: float,
    cwd: str | Path | None = None,
    telegram_input: bool = False,
) -> MediaMetadata:
    file_path = Path(path)
    if not file_path.is_file() or file_path.is_symlink():
        raise DownloadError(ErrorCode.PROCESSING_FAILED)
    try:
        size = file_path.stat().st_size
    except OSError as exc:
        raise DownloadError(ErrorCode.PROCESSING_FAILED) from exc
    if size <= 0:
        raise DownloadError(ErrorCode.PROCESSING_FAILED)
    expected_demuxer = _sniff_telegram_demuxer(file_path, size) if telegram_input else None
    args = [
        ffprobe_path,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ]
    if expected_demuxer is not None:
        args.extend(["-protocol_whitelist", "file", "-f", expected_demuxer])
        if expected_demuxer == "mov":
            args.extend(["-enable_drefs", "0", "-use_absolute_path", "0"])
        args.extend(["-max_streams", str(MAX_TELEGRAM_STREAMS), "-i", str(file_path)])
    else:
        args.append(str(file_path))
    try:
        result = await run_process(args, cwd=cwd, timeout_seconds=timeout_seconds)
    except ProcessExecutionError as exc:
        if exc.result.timed_out:
            raise DownloadError(ErrorCode.PROCESS_TIMEOUT, retryable=True) from None
        raise DownloadError(ErrorCode.PROCESSING_FAILED) from None
    try:
        document = json.loads(result.stdout)
        streams = document.get("streams", [])
        format_info = document.get("format", {})
        if not isinstance(streams, list) or not streams:
            raise ValueError("no streams")
        if not isinstance(format_info, dict):
            format_info = {}
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise DownloadError(ErrorCode.PROCESSING_FAILED) from exc
    streams = [stream for stream in streams if isinstance(stream, dict)]
    if expected_demuxer is not None:
        _validate_telegram_streams(streams, format_info, expected_demuxer)
    # Attached cover art is not a playable video stream.
    streams = [stream for stream in streams
               if not (isinstance(stream.get("disposition"), dict) and stream["disposition"].get("attached_pic") == 1)]
    mime_type = _mime_for_streams(file_path, streams, format_info, telegram_input=telegram_input)
    has_video = not mime_type.startswith("image/") and any(isinstance(stream, dict) and stream.get("codec_type") == "video" for stream in streams)
    has_audio = any(isinstance(stream, dict) and stream.get("codec_type") == "audio" for stream in streams)
    first_audio_stream = next(
        (stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"),
        {},
    )
    first_audio_codec = first_audio_stream.get("codec_name")
    if not isinstance(first_audio_codec, str):
        first_audio_codec = None
    video_stream = next((stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "video"), {})
    first_video_codec = video_stream.get("codec_name")
    if not isinstance(first_video_codec, str):
        first_video_codec = None
    duration = _number(format_info.get("duration"))
    width = int(video_stream["width"]) if video_stream.get("width") is not None else None
    height = int(video_stream["height"]) if video_stream.get("height") is not None else None
    filename = sanitize_filename(file_path.name, fallback="media.bin")
    return MediaMetadata(
        filename=filename,
        mimeType=mime_type,
        sizeBytes=size,
        duration=duration,
        width=width,
        height=height,
        hasVideo=has_video,
        hasAudio=has_audio,
        firstVideoCodec=first_video_codec,
        firstAudioCodec=first_audio_codec,
        formatName=format_info.get("format_name"),
    )
