"""yt-dlp probe and download command construction."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .config import Settings
from .errors import DownloadError, ErrorCode, ErrorStage, FailureReason, error_from_process_output
from .logging_utils import ProcessName
from .models import MediaMode, PreferredFormat, ProbeInfo
from .process import ProcessExecutionError, run_process
from .security import safe_child_path

_PATH_MARKER = "__DOWNLOADER_FINAL_PATH__"
IMAGE_EXTENSIONS = frozenset(
    {"avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"}
)


@dataclass(frozen=True, slots=True)
class DownloadPlan:
    mode: MediaMode
    format_selector: str
    preferred_format: PreferredFormat
    maximum_height: int | None
    output_kind: Literal["video", "audio", "image"] = "video"


def runtime_argument(runtime_name: str, runtime_path: str) -> str:
    if runtime_name != "deno" or not Path(runtime_path).is_absolute():
        raise ValueError("JavaScript runtime path must be absolute")
    return f"{runtime_name}:{runtime_path}"


def yt_dlp_common_args(
    settings: Settings,
    runtime_name: str,
    runtime_path: str,
    *,
    proxy_url: str | None = None,
) -> list[str]:
    args = [
        settings.yt_dlp_path,
        "--no-colors",
        "--no-playlist",
        "--ignore-config",
        "--js-runtimes",
        runtime_argument(runtime_name, runtime_path),
        "--no-remote-components",
        "--socket-timeout",
        "30",
        "--retries",
        str(settings.max_retries),
        "--fragment-retries",
        str(settings.max_retries),
        "--extractor-retries",
        str(settings.max_retries),
        "--max-filesize",
        str(settings.max_source_download_bytes),
    ]
    if proxy_url is not None:
        args.extend(["--proxy", proxy_url])
    return args


def build_probe_args(
    settings: Settings,
    source_url: str,
    runtime_name: str,
    runtime_path: str,
    *,
    proxy_url: str | None = None,
    captions_only: bool = False,
) -> list[str]:
    return [
        *yt_dlp_common_args(settings, runtime_name, runtime_path, proxy_url=proxy_url),
        "--dump-single-json",
        "--skip-download",
        *(["--ignore-no-formats-error"] if captions_only else []),
        source_url,
    ]


def parse_probe_json(stdout: str) -> ProbeInfo:
    """Parse yt-dlp JSON while tolerating informational lines around it."""

    raw: dict[str, Any] | None = None
    try:
        candidate = json.loads(stdout)
        if isinstance(candidate, dict):
            raw = candidate
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        for index, char in enumerate(stdout):
            if char != "{":
                continue
            try:
                candidate, _ = decoder.raw_decode(stdout[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                raw = candidate
                break
    if raw is None:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE, detail="invalid probe output", failure_reason=FailureReason.INVALID_PROBE_OUTPUT)
    if raw.get("_type") in {"playlist", "multi_video"} or raw.get("entries") is not None:
        raise DownloadError(ErrorCode.PLAYLIST_NOT_ALLOWED)
    if raw.get("is_live") is True or raw.get("live_status") in {"is_live", "was_live"}:
        raise DownloadError(ErrorCode.LIVE_STREAM_NOT_SUPPORTED)
    # Some public image extractors expose one direct image at the top level
    # instead of returning a normal ``formats`` array.  Normalize that shape
    # into one synthetic format for planning; yt-dlp still resolves the source
    # URL and downloads it through its normal, bounded process.
    formats = raw.get("formats")
    extension = str(raw.get("ext") or "").lower().lstrip(".")
    if (not isinstance(formats, list) or not formats) and extension in IMAGE_EXTENSIONS:
        raw = {
            **raw,
            "formats": [
                {
                    "format_id": "best",
                    "ext": extension,
                    "width": raw.get("width"),
                    "height": raw.get("height"),
                    "filesize": raw.get("filesize") or raw.get("filesize_approx"),
                    "vcodec": "mjpeg" if extension in {"jpg", "jpeg"} else extension,
                    "acodec": "none",
                }
            ],
        }
    try:
        return ProbeInfo.model_validate(raw)
    except Exception as exc:
        raise DownloadError(ErrorCode.MEDIA_UNAVAILABLE, detail="invalid probe metadata", failure_reason=FailureReason.INVALID_PROBE_METADATA) from exc


async def probe_media(
    settings: Settings,
    source_url: str,
    runtime_name: str,
    runtime_path: str,
    *,
    cwd: str | Path,
    proxy_url: str | None = None,
    captions_only: bool = False,
    info_json: Path | None = None,
) -> ProbeInfo:
    args = build_probe_args(settings, source_url, runtime_name, runtime_path, proxy_url=proxy_url, captions_only=captions_only)
    try:
        result = await run_process(args, cwd=cwd, timeout_seconds=settings.probe_timeout_seconds)
    except ProcessExecutionError as exc:
        if exc.result.timed_out:
            failure = DownloadError(ErrorCode.DOWNLOAD_TIMEOUT, retryable=True)
        elif exc.result.output_limited:
            failure = DownloadError(ErrorCode.SOURCE_SIZE_LIMIT)
        else:
            failure = error_from_process_output(exc.result.stderr or exc.result.stdout, probe=True)
        failure.error_stage = ErrorStage.PROBE
        failure.process_name = ProcessName.YT_DLP.value
        failure.process_exit_code = exc.result.returncode
        failure.process_timed_out = exc.result.timed_out
        raise failure from None
    try:
        probe = parse_probe_json(result.stdout)
    except DownloadError as failure:
        failure.process_name = ProcessName.YT_DLP.value
        failure.process_exit_code = result.returncode
        failure.process_timed_out = result.timed_out
        raise
    if info_json is not None:
        # The download reuses this extraction (--load-info-json) instead of
        # running a second one; only clean yt-dlp JSON is safe to reload.
        try:
            json.loads(result.stdout)
        except json.JSONDecodeError:
            return probe
        info_json.write_text(result.stdout, encoding="utf-8")
    return probe


def parse_final_path(output: str, workspace: str | Path) -> Path:
    """Extract a final path and require it to remain in the job directory."""

    candidates: list[str] = []
    for line in output.splitlines():
        value = line.strip()
        if value.startswith(_PATH_MARKER):
            value = value[len(_PATH_MARKER) :].strip()
        if value:
            candidates.append(value)
    for value in reversed(candidates):
        path = Path(value)
        if not path.is_absolute():
            path = Path(workspace) / path
        try:
            safe = Path(safe_child_path(workspace, path))
        except DownloadError:
            continue
        if safe.is_file():
            return safe
    # Tests and some yt-dlp versions may not emit --print output; choose the
    # newest ordinary media file as a constrained fallback.
    root = Path(workspace)
    files = [path for path in root.rglob("*") if path.is_file() and not path.is_symlink()]
    if files:
        return max(files, key=lambda path: path.stat().st_mtime_ns)
    raise DownloadError(ErrorCode.DOWNLOAD_FAILED, detail="yt-dlp produced no file")


def build_video_selector(maximum_height: int | None, preferred_format: PreferredFormat) -> str:
    height = f"[height<=?{maximum_height}]" if maximum_height is not None else ""
    if preferred_format == PreferredFormat.MP4:
        return f"bv*{height}[ext=mp4]+ba[ext=m4a]/b{height}[ext=mp4]/bv*{height}+ba/b{height}"
    return f"bv*{height}+ba/b{height}"


def build_download_args(
    settings: Settings,
    source_url: str,
    workspace: str | Path,
    plan: DownloadPlan,
    runtime_name: str,
    runtime_path: str,
    *,
    proxy_url: str | None = None,
    extract_audio: bool = True,
    info_json: Path | None = None,
    download_sections: str | None = None,
) -> list[str]:
    workspace_path = Path(workspace).resolve()
    template = str(workspace_path / "%(title).180B [%(id)s].%(ext)s")
    args = [
        *yt_dlp_common_args(settings, runtime_name, runtime_path, proxy_url=proxy_url),
        "--newline",
        "--progress",
        "--output",
        template,
        "--print",
        f"after_move:{_PATH_MARKER}%(filepath)s",
        "--format",
        plan.format_selector,
        *(["--download-sections", download_sections] if download_sections is not None else []),
        *(["--load-info-json", str(info_json)] if info_json is not None else [source_url]),
    ]
    if plan.output_kind == "image":
        # Image-only jobs retain the external ``video`` request mode for
        # compatibility, but must not ask yt-dlp/FFmpeg to merge an image
        # into an MP4 container.
        return args
    if plan.mode == MediaMode.VIDEO:
        if plan.preferred_format == PreferredFormat.MP4:
            args.extend(["--merge-output-format", "mp4"])
    elif extract_audio:
        args.extend(
            [
                "--extract-audio",
                "--audio-format",
                plan.preferred_format.value,
                "--audio-quality",
                "0",
                "--embed-metadata",
            ]
        )
    return args
