#!/usr/bin/env python3
"""Measure the current bounded transcode policy against a local bitrate budget.

The benchmark is deliberately synthetic and local.  It does not call yt-dlp,
Telegram, Cloudflare, or any provider.  The production 49 MB limit is reported
alongside a smaller near-limit exercise so the three current CRF attempts run
within a short, repeatable fixture.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
BENCHMARK_PROFILE = "current-crf-vs-duration-audio-overhead-budget"
SAMPLE_COUNT = 1
SOURCE_DURATION_SECONDS = 8.0
SOURCE_WIDTH = 1920
SOURCE_HEIGHT = 1080
SOURCE_FPS = 30
TELEGRAM_LIMIT_BYTES = 49_000_000
BASELINE_CRFS = (28, 32, 35)
AUDIO_BITRATE = 96_000
OVERHEAD_FRACTION = 0.08
QUALITY_FLOOR_PSNR_DB = 30.0
QUALITY_FLOOR_SSIM = 0.90


@dataclass(slots=True)
class RunMetrics:
    wall_seconds: float | None
    cpu_user_seconds: float | None
    cpu_system_seconds: float | None
    peak_rss_bytes: int | None
    output_size_bytes: int

    @property
    def cpu_total_seconds(self) -> float | None:
        if self.cpu_user_seconds is None or self.cpu_system_seconds is None:
            return None
        return self.cpu_user_seconds + self.cpu_system_seconds


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def _executable(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"{name} is required on PATH")
    return path


def _time_prefix() -> list[str]:
    path = "/usr/bin/time" if Path("/usr/bin/time").is_file() else shutil.which("time")
    if path is None:
        raise RuntimeError("an external time command is required")
    return [path, "-l"] if platform.system() == "Darwin" else [path, "-v"]


def _run(args: Sequence[str], *, label: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        list(args),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        timeout=600,
    )
    if completed.returncode:
        details = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"{label} failed ({completed.returncode}): {details[-1_000:]}")
    return completed


def _optional_command(args: Sequence[str]) -> str | None:
    try:
        return _run(args, label=args[0]).stdout.strip() or None
    except (OSError, RuntimeError):
        return None


def _git_metadata() -> dict[str, Any]:
    git = ["git", "-C", str(REPO_ROOT)]
    head = _optional_command([*git, "rev-parse", "HEAD"])
    status = _optional_command([*git, "status", "--porcelain=v1", "--untracked-files=all"])
    return {
        "head": head or "unknown",
        "dirty": None if status is None else bool(status),
        "dirtyPathCount": len(status.splitlines()) if status else 0,
    }


def _parse_time(stderr: str, *, wall_fallback: float) -> tuple[float | None, float | None, float | None, int | None]:
    if platform.system() == "Darwin":
        real = re.search(r"\b([0-9.]+)\s+real\b", stderr)
        user = re.search(r"\b([0-9.]+)\s+user\b", stderr)
        system = re.search(r"\b([0-9.]+)\s+sys\b", stderr)
        rss = re.search(r"^\s*(\d+)\s+maximum resident set size\s*$", stderr, re.MULTILINE)
        return (
            float(real.group(1)) if real is not None else wall_fallback,
            float(user.group(1)) if user is not None else None,
            float(system.group(1)) if system is not None else None,
            int(rss.group(1)) if rss is not None else None,
        )
    elapsed = re.search(r"^\s*Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*(\S+)\s*$", stderr, re.MULTILINE)
    user = re.search(r"^\s*User time \(seconds\):\s*([0-9.]+)\s*$", stderr, re.MULTILINE)
    system = re.search(r"^\s*System time \(seconds\):\s*([0-9.]+)\s*$", stderr, re.MULTILINE)
    rss = re.search(r"^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$", stderr, re.MULTILINE)
    elapsed_seconds: float | None = None
    if elapsed:
        parts = elapsed.group(1).split(":")
        try:
            if len(parts) == 3:
                elapsed_seconds = int(parts[0]) * 3_600 + int(parts[1]) * 60 + float(parts[2])
            elif len(parts) == 2:
                elapsed_seconds = int(parts[0]) * 60 + float(parts[1])
            else:
                elapsed_seconds = float(parts[0])
        except ValueError:
            elapsed_seconds = None
    return (
        elapsed_seconds or wall_fallback,
        float(user.group(1)) if user is not None else None,
        float(system.group(1)) if system is not None else None,
        int(rss.group(1)) * 1_024 if rss is not None else None,
    )


def _run_measured(args: Sequence[str], *, output: Path, label: str) -> RunMetrics:
    started = time.monotonic()
    completed = subprocess.run(
        [*_time_prefix(), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        timeout=600,
    )
    wall_fallback = time.monotonic() - started
    if completed.returncode:
        details = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"{label} failed ({completed.returncode}): {details[-1_000:]}")
    wall, user, system, rss = _parse_time(completed.stderr, wall_fallback=wall_fallback)
    _require(output.is_file(), f"{label} did not create {output.name}")
    return RunMetrics(wall, user, system, rss, output.stat().st_size)


def _probe(path: Path, *, ffprobe: str) -> dict[str, Any]:
    document = json.loads(
        _run(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            label=f"ffprobe {path.name}",
        ).stdout
    )
    streams = [stream for stream in document.get("streams", []) if isinstance(stream, dict)]
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), {})
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
    format_info = document.get("format", {})
    duration = format_info.get("duration") if isinstance(format_info, dict) else None
    try:
        duration = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration = None
    return {
        "duration": duration,
        "video_streams": sum(stream.get("codec_type") == "video" for stream in streams),
        "audio_streams": sum(stream.get("codec_type") == "audio" for stream in streams),
        "video_codec": video.get("codec_name"),
        "audio_codec": audio.get("codec_name"),
        "width": video.get("width"),
        "height": video.get("height"),
        "sample_rate": audio.get("sample_rate"),
        "channels": audio.get("channels"),
        "format_name": format_info.get("format_name") if isinstance(format_info, dict) else None,
    }


def _encode_args(
    *,
    ffmpeg: str,
    source: Path,
    output: Path,
    crf: int | None = None,
    video_bitrate: int | None = None,
) -> list[str]:
    args = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
    ]
    if crf is not None:
        args.extend(["-crf", str(crf)])
    if video_bitrate is not None:
        args.extend(["-b:v", f"{video_bitrate}", "-maxrate", f"{video_bitrate}", "-bufsize", f"{video_bitrate * 2}"])
    args.extend(["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(output)])
    return args


def _quality_metric(reference: Path, candidate: Path, *, ffmpeg: str, filter_name: str) -> float:
    completed = _run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "info",
            "-i",
            str(reference),
            "-i",
            str(candidate),
            "-lavfi",
            f"[0:v:0]setpts=PTS-STARTPTS[a];[1:v:0]setpts=PTS-STARTPTS[b];[a][b]{filter_name}",
            "-f",
            "null",
            "-",
        ],
        label=f"{filter_name} {candidate.name}",
    )
    text = completed.stderr + completed.stdout
    if filter_name == "ssim":
        match = re.search(r"SSIM .*All:([0-9.]+)", text)
    else:
        match = re.search(r"PSNR .*average:([0-9.]+)", text)
    _require(match is not None, f"{filter_name} summary missing for {candidate.name}")
    return float(match.group(1))


def _audio_levels(path: Path, *, ffmpeg: str) -> dict[str, float]:
    completed = _run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        label=f"audio levels {path.name}",
    )
    text = completed.stderr + completed.stdout
    result: dict[str, float] = {}
    for key in ("mean_volume", "max_volume"):
        match = re.search(rf"{key}:\s*(-?[0-9.]+) dB", text)
        _require(match is not None, f"{key} summary missing for {path.name}")
        result[key] = float(match.group(1))
    return result


def _quality_check(
    reference: Path,
    candidate: Path,
    *,
    ffmpeg: str,
    ffprobe: str,
    reference_probe: dict[str, Any],
    require_quality_floor: bool,
) -> dict[str, Any]:
    candidate_probe = _probe(candidate, ffprobe=ffprobe)
    _require(candidate_probe["video_streams"] == 1, f"{candidate.name} must contain one video stream")
    _require(candidate_probe["width"] == reference_probe["width"], f"{candidate.name} changed width")
    _require(candidate_probe["height"] == reference_probe["height"], f"{candidate.name} changed height")
    _require(candidate_probe["duration"] is not None, f"{candidate.name} has no duration")
    _require(
        abs(candidate_probe["duration"] - reference_probe["duration"]) <= 0.25,
        f"{candidate.name} changed duration unexpectedly",
    )
    psnr = _quality_metric(reference, candidate, ffmpeg=ffmpeg, filter_name="psnr")
    ssim = _quality_metric(reference, candidate, ffmpeg=ffmpeg, filter_name="ssim")
    has_audio = reference_probe["audio_streams"] > 0
    audio: dict[str, Any] = {"preserved": not has_audio and candidate_probe["audio_streams"] == 0}
    if has_audio:
        _require(candidate_probe["audio_streams"] == 1, f"{candidate.name} did not preserve its audio stream")
        _require(candidate_probe["audio_codec"] == "aac", f"{candidate.name} audio is not AAC")
        reference_levels = _audio_levels(reference, ffmpeg=ffmpeg)
        candidate_levels = _audio_levels(candidate, ffmpeg=ffmpeg)
        audio = {
            "preserved": True,
            "codec": candidate_probe["audio_codec"],
            "channels": candidate_probe["channels"],
            "meanVolumeDb": candidate_levels["mean_volume"],
            "meanVolumeDeltaDb": candidate_levels["mean_volume"] - reference_levels["mean_volume"],
            "maxVolumeDb": candidate_levels["max_volume"],
            "maxVolumeDeltaDb": candidate_levels["max_volume"] - reference_levels["max_volume"],
        }
        _require(abs(audio["meanVolumeDeltaDb"]) <= 1.5, f"{candidate.name} changed mean audio level too much")
    quality_floor_met = psnr >= QUALITY_FLOOR_PSNR_DB and ssim >= QUALITY_FLOOR_SSIM and audio["preserved"]
    if require_quality_floor:
        _require(quality_floor_met, f"{candidate.name} failed the quality floor")
    return {
        "candidate": candidate.name,
        "durationSeconds": candidate_probe["duration"],
        "videoCodec": candidate_probe["video_codec"],
        "psnrDb": psnr,
        "ssim": ssim,
        "audio": audio,
        "qualityFloorMet": quality_floor_met,
    }


def _metric_dict(metrics: RunMetrics, *, duration: float | None) -> dict[str, Any]:
    result = {
        "wallSeconds": metrics.wall_seconds,
        "cpuUserSeconds": metrics.cpu_user_seconds,
        "cpuSystemSeconds": metrics.cpu_system_seconds,
        "cpuTotalSeconds": metrics.cpu_total_seconds,
        "peakRssBytes": metrics.peak_rss_bytes,
        "outputSizeBytes": metrics.output_size_bytes,
    }
    if duration and duration > 0:
        result["outputBitrateKbps"] = metrics.output_size_bytes * 8 / duration / 1_000
    return result


def _fmt(value: Any, places: int = 2) -> str:
    return f"{value:.{places}f}" if isinstance(value, int | float) else "n/a"


def _fmt_mib(value: Any) -> str:
    return _fmt(value / 1_048_576, 1) if isinstance(value, int | float) else "n/a"


def _baseline(
    source: Path,
    *,
    output_dir: Path,
    ffmpeg: str,
    ffprobe: str,
    limit_bytes: int,
    reference_probe: dict[str, Any],
) -> dict[str, Any]:
    attempts: list[dict[str, Any]] = []
    selected: Path | None = None
    for crf in BASELINE_CRFS:
        output = output_dir / f"baseline-crf-{crf}.mp4"
        metrics = _run_measured(
            _encode_args(ffmpeg=ffmpeg, source=source, output=output, crf=crf),
            output=output,
            label=f"baseline CRF {crf}",
        )
        row = {"crf": crf, "accepted": metrics.output_size_bytes <= limit_bytes, **_metric_dict(metrics, duration=reference_probe["duration"])}
        attempts.append(row)
        if row["accepted"]:
            selected = output
            break
    if selected is None:
        raise RuntimeError(f"baseline did not fit local limit {limit_bytes}")
    selected_crf = next(row["crf"] for row in attempts if row["accepted"])
    quality = _quality_check(
        source,
        selected,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        reference_probe=reference_probe,
        require_quality_floor=False,
    )
    total = {
        "wallSeconds": sum(row["wallSeconds"] for row in attempts if row["wallSeconds"] is not None),
        "cpuTotalSeconds": sum(row["cpuTotalSeconds"] for row in attempts if row["cpuTotalSeconds"] is not None),
        "peakRssBytes": max(
            (row["peakRssBytes"] for row in attempts if row["peakRssBytes"] is not None),
            default=None,
        ),
    }
    return {
        "limitBytes": limit_bytes,
        "attempts": attempts,
        "total": total,
        "selectedCrf": selected_crf,
        "quality": quality,
    }


def _experimental(
    source: Path,
    *,
    output_dir: Path,
    ffmpeg: str,
    ffprobe: str,
    limit_bytes: int,
    reference_probe: dict[str, Any],
) -> dict[str, Any]:
    duration = reference_probe["duration"] or SOURCE_DURATION_SECONDS
    audio_budget_bytes = math.ceil(AUDIO_BITRATE * duration / 8)
    overhead_budget_bytes = max(16_384, math.ceil(limit_bytes * OVERHEAD_FRACTION))
    video_budget_bytes = limit_bytes - audio_budget_bytes - overhead_budget_bytes
    _require(video_budget_bytes > 0, "local limit leaves no video budget")
    video_bitrate = math.floor(video_budget_bytes * 8 / duration)
    output = output_dir / "experimental-budget.mp4"
    metrics = _run_measured(
        _encode_args(ffmpeg=ffmpeg, source=source, output=output, video_bitrate=video_bitrate),
        output=output,
        label="experimental duration/audio/overhead budget",
    )
    _require(metrics.output_size_bytes <= limit_bytes, "experimental budget exceeded the local limit")
    quality = _quality_check(
        source,
        output,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        reference_probe=reference_probe,
        require_quality_floor=True,
    )
    return {
        "limitBytes": limit_bytes,
        "durationSeconds": duration,
        "audioBitrate": AUDIO_BITRATE,
        "audioBudgetBytes": audio_budget_bytes,
        "overheadFraction": OVERHEAD_FRACTION,
        "overheadBudgetBytes": overhead_budget_bytes,
        "videoBudgetBytes": video_budget_bytes,
        "videoBitrate": video_bitrate,
        "metrics": _metric_dict(metrics, duration=duration),
        "quality": quality,
    }


def _metadata_policy_check() -> dict[str, Any]:
    source_path = REPO_ROOT / "apps/downloader-container/src"
    sys.path.insert(0, str(source_path))
    from downloader_container.config import Settings
    from downloader_container.errors import DownloadError, ErrorCode
    from downloader_container.models import MediaMetadata
    from downloader_container.service import DownloaderService

    settings = Settings(max_duration_seconds=7_200)
    service = DownloaderService(settings)
    boundary = MediaMetadata(
        filename="synthetic.mp4",
        mimeType="video/mp4",
        sizeBytes=1,
        duration=settings.max_duration_seconds,
        hasVideo=True,
    )
    service._validate_final_duration(boundary)
    over_limit_rejected = False
    try:
        service._validate_final_duration(boundary.model_copy(update={"duration": settings.max_duration_seconds + 1}))
    except DownloadError as exc:
        over_limit_rejected = exc.code == ErrorCode.DURATION_LIMIT
    _require(over_limit_rejected, "metadata above the two-hour limit was not rejected")
    return {
        "maxDurationSeconds": settings.max_duration_seconds,
        "boundaryAccepted": True,
        "overLimitRejected": True,
        "encodedDurationSeconds": SOURCE_DURATION_SECONDS,
    }


def _image_only_check(*, ffprobe: str) -> dict[str, Any]:
    source_path = REPO_ROOT / "apps/downloader-container/src"
    sys.path.insert(0, str(source_path))
    from downloader_container.formats import choose_telegram_video
    from downloader_container.models import ProbeInfo

    probe = ProbeInfo(
        id="synthetic-image",
        title="Synthetic image",
        extractor="benchmark",
        formats=[
            {
                "format_id": "image",
                "ext": "jpg",
                "width": 1_600,
                "height": 900,
                "vcodec": "mjpeg",
                "acodec": "none",
                "filesize": 10_000,
            }
        ],
    )
    plan, choice = choose_telegram_video(probe, maximum_height=1_080, max_bytes=TELEGRAM_LIMIT_BYTES)
    _require(plan.output_kind == "image", "image-only probe did not select the image plan")
    _require(plan.format_selector == "best", "image-only probe selected a video merge plan")
    return {
        "plannerOutputKind": plan.output_kind,
        "plannerSelector": plan.format_selector,
        "choiceExtension": choice.extension,
    }


def _render_report(result: dict[str, Any], *, output_path: Path) -> None:
    environment = result["environment"]
    source = result["source"]
    local_limit = result["localLimitBytes"]
    baseline_production = result["baselineProduction"]
    baseline_local = result["baselineLocal"]
    experimental = result["experimental"]
    rows = []
    for row in baseline_local["attempts"]:
        rows.append(
            f"| Current baseline CRF {row['crf']} | {row['accepted']} | {_fmt(row['wallSeconds'])} | "
            f"{_fmt(row['cpuTotalSeconds'])} | {_fmt_mib(row['peakRssBytes'])} | {row['outputSizeBytes']:,} |"
        )
    metrics = experimental["metrics"]
    rows.append(
        f"| Experimental budget ({experimental['videoBitrate'] / 1_000:.0f} kbps video) | "
        f"{metrics['outputSizeBytes'] <= local_limit} | {_fmt(metrics['wallSeconds'])} | "
        f"{_fmt(metrics['cpuTotalSeconds'])} | {_fmt_mib(metrics['peakRssBytes'])} | {metrics['outputSizeBytes']:,} |"
    )
    quality = baseline_local["quality"]
    exp_quality = experimental["quality"]
    audio = exp_quality["audio"]
    baseline_total = baseline_local["total"]
    report = f"""# Synthetic encoding benchmark

Recorded {result['recordedAt']}.

This is a local, provider-free measurement. It leaves the product encoding policy unchanged. The fixture is a {SOURCE_WIDTH}x{SOURCE_HEIGHT}, {SOURCE_FPS} fps, {SOURCE_DURATION_SECONDS:g}-second `testsrc2` video with a 440 Hz / 48 kHz sine-wave audio stream. The local near-limit exercise uses **{local_limit:,} bytes** so the current three-attempt policy is exercised quickly; the production Telegram acceptance target remains **{TELEGRAM_LIMIT_BYTES:,} bytes**.

## Environment

| Item | Value |
| --- | --- |
| FFmpeg | `{environment['ffmpegVersion']}` |
| FFprobe | `{environment['ffprobeVersion']}` |
| Machine | `{environment['machine']}` |
| CPU | `{environment['cpuModel']}` ({environment['cpuCount']} logical cores) |
| Physical memory | `{environment['physicalMemoryBytes']}` bytes |
| Source Git HEAD | `{result['git']['head']}` |
| Source checkout | `dirty={result['git']['dirty']}`; {result['git']['dirtyPathCount']} paths |
| Sample count | `{result['sampleCount']}` |
| Profile | `{result['profile']}` |
| Source size | {source['sizeBytes']:,} bytes |
| Source duration | {source['probe']['duration']:.3f} s |
| Source streams | {source['probe']['video_streams']} video / {source['probe']['audio_streams']} audio |

Background-load note: {result['backgroundNote'] or 'none recorded'}

The current service policy is three sequential video attempts at CRF 28, 32, and 35, with H.264 `veryfast` and AAC 96 kbps; it accepts the first output at or below the upload limit. The local experimental profile reserves the measured duration's AAC bytes and 8% of the target for container and rate-control overhead, then derives one video bitrate:

`video_bitrate = floor((target_bytes - ceil(audio_bitrate * duration / 8) - max(16,384, ceil(target_bytes * 0.08))) * 8 / duration)`

The experimental quality floor is PSNR >= {QUALITY_FLOOR_PSNR_DB:.0f} dB, SSIM >= {QUALITY_FLOOR_SSIM:.2f}, one AAC stream when audio is present, and mean audio-level change <= 1.5 dB.

## Measured encodes

Wall and CPU values are seconds from `/usr/bin/time`; peak memory is maximum resident set size. CPU is user + system. Each row is one fresh FFmpeg process.

| Profile | Accepted | Wall s | CPU s | Peak RSS MiB | Output bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
{chr(10).join(rows)}

Near-limit baseline total across all three attempts was **{_fmt(baseline_total['wallSeconds'])} s wall / {_fmt(baseline_total['cpuTotalSeconds'])} s CPU**, with **{_fmt_mib(baseline_total['peakRssBytes'])} MiB peak RSS** (the maximum of the three attempts). The final accepted pass was CRF {baseline_local['selectedCrf']} at {next(row['outputSizeBytes'] for row in baseline_local['attempts'] if row['accepted']):,} bytes; the earlier attempts were over the {local_limit:,}-byte local cap.

Production-target calibration forced one CRF {baseline_production['selectedCrf']} encode of the {source['sizeBytes']:,}-byte source, producing {baseline_production['attempts'][0]['outputSizeBytes']:,} bytes in {_fmt(baseline_production['attempts'][0]['wallSeconds'])} s wall / {_fmt(baseline_production['attempts'][0]['cpuTotalSeconds'])} s CPU, with {_fmt_mib(baseline_production['attempts'][0]['peakRssBytes'])} MiB peak RSS. Normal service would bypass transcoding because that source is already below the {TELEGRAM_LIMIT_BYTES:,}-byte limit. No comparable candidate near {TELEGRAM_LIMIT_BYTES:,} bytes was measured; this run is calibration only. The smaller local target selected CRF {baseline_local['selectedCrf']} after {len(baseline_local['attempts'])} attempt(s).

## Quality and stream checks

| Candidate | PSNR dB | SSIM | Video | Audio | Quality floor |
| --- | ---: | ---: | --- | --- | --- |
| Current baseline selected CRF {baseline_local['selectedCrf']} | {quality['psnrDb']:.3f} | {quality['ssim']:.6f} | {quality['videoCodec']} | {'preserved' if quality['audio']['preserved'] else 'missing'} | {'pass' if quality['qualityFloorMet'] else 'fail'} |
| Experimental budget | {exp_quality['psnrDb']:.3f} | {exp_quality['ssim']:.6f} | {exp_quality['videoCodec']} | {'preserved' if audio['preserved'] else 'missing'} | {'pass' if exp_quality['qualityFloorMet'] else 'fail'} |

Experimental AAC mean level was {audio['meanVolumeDb']:.2f} dB, a {audio['meanVolumeDeltaDb']:+.2f} dB change from the source; the output has {audio['channels']} channel(s). Output duration was {exp_quality['durationSeconds']:.3f} s.

The missing-audio fixture was encoded with the same mapping (`0:a:0?`) and verified to contain zero audio streams; this checks that the optional map does not invent audio. The image-only planner check returned `output_kind={result['imageOnly']['plannerOutputKind']}`, selector `{result['imageOnly']['plannerSelector']}`, and extension `{result['imageOnly']['choiceExtension']}`; it does not route a JPEG through an MP4 video/audio merge.

## Duration policy evidence

The service's authoritative metadata validator accepted synthetic metadata exactly at the configured **{result['durationPolicy']['maxDurationSeconds']:,}-second (two-hour) boundary** and rejected metadata at one second over it. Only the {result['durationPolicy']['encodedDurationSeconds']:g}-second fixture was encoded, so this is boundary-policy evidence without a two-hour encode.

## Limits

- The {local_limit:,}-byte near-limit run is a bounded exercise, not a claim that the 49 MB result scales linearly across codecs, durations, resolutions, or hardware.
- This measures one local FFmpeg 8.x build and one synthetic pattern; real downloaded media can have different motion, audio layouts, subtitles, metadata, and muxing overhead.
- No live sources, Telegram calls, deployment, secret access, or product encoding-policy change were used.
"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")


def _benchmark(*, output_path: Path, local_limit_bytes: int, background_note: str) -> dict[str, Any]:
    ffmpeg = _executable("ffmpeg")
    ffprobe = _executable("ffprobe")
    git_metadata = _git_metadata()
    with tempfile.TemporaryDirectory(prefix="digibot-encoding-") as temporary:
        work = Path(temporary)
        source = work / "source.mp4"
        no_audio = work / "source-no-audio.mp4"
        image = work / "source-image.jpg"
        source_metrics = _run_measured(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"testsrc2=size={SOURCE_WIDTH}x{SOURCE_HEIGHT}:rate={SOURCE_FPS}",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-t",
                str(SOURCE_DURATION_SECONDS),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "10",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                str(source),
            ],
            output=source,
            label="synthetic source",
        )
        _run_measured(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"testsrc2=size={SOURCE_WIDTH}x{SOURCE_HEIGHT}:rate={SOURCE_FPS}",
                "-t",
                str(SOURCE_DURATION_SECONDS),
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "10",
                "-pix_fmt",
                "yuv420p",
                str(no_audio),
            ],
            output=no_audio,
            label="synthetic no-audio source",
        )
        _run_measured(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1600x900:rate=1",
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(image),
            ],
            output=image,
            label="synthetic image source",
        )
        source_probe = _probe(source, ffprobe=ffprobe)
        no_audio_probe = _probe(no_audio, ffprobe=ffprobe)
        image_probe = _probe(image, ffprobe=ffprobe)
        _require(source_probe["video_streams"] == 1 and source_probe["audio_streams"] == 1, "source fixture streams are wrong")
        _require(no_audio_probe["video_streams"] == 1 and no_audio_probe["audio_streams"] == 0, "no-audio fixture streams are wrong")
        _require(image_probe["video_streams"] == 1 and image_probe["audio_streams"] == 0, "image fixture streams are wrong")

        baseline_production = _baseline(
            source,
            output_dir=work,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            limit_bytes=TELEGRAM_LIMIT_BYTES,
            reference_probe=source_probe,
        )
        baseline_local = _baseline(
            source,
            output_dir=work,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            limit_bytes=local_limit_bytes,
            reference_probe=source_probe,
        )
        experimental = _experimental(
            source,
            output_dir=work,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
            limit_bytes=local_limit_bytes,
            reference_probe=source_probe,
        )
        no_audio_output = work / "no-audio-crf-28.mp4"
        _run_measured(
            _encode_args(ffmpeg=ffmpeg, source=no_audio, output=no_audio_output, crf=28),
            output=no_audio_output,
            label="missing-audio validation encode",
        )
        no_audio_encoded_probe = _probe(no_audio_output, ffprobe=ffprobe)
        _require(no_audio_encoded_probe["audio_streams"] == 0, "missing-audio encode gained an audio stream")
        image_only = _image_only_check(ffprobe=ffprobe)
        result = {
            "recordedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "profile": BENCHMARK_PROFILE,
            "sampleCount": SAMPLE_COUNT,
            "git": git_metadata,
            "environment": {
                "ffmpegVersion": _run([ffmpeg, "-version"], label="ffmpeg version").stdout.splitlines()[0],
                "ffprobeVersion": _run([ffprobe, "-version"], label="ffprobe version").stdout.splitlines()[0],
                "machine": f"{platform.system()} {platform.machine()}",
                "cpuModel": _optional_command(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.processor() or "unknown",
                "cpuCount": _optional_command(["sysctl", "-n", "hw.ncpu"]) or "unknown",
                "physicalMemoryBytes": _optional_command(["sysctl", "-n", "hw.memsize"]) or "unknown",
            },
            "backgroundNote": background_note,
            "localLimitBytes": local_limit_bytes,
            "source": {"sizeBytes": source_metrics.output_size_bytes, "probe": source_probe},
            "baselineProduction": baseline_production,
            "baselineLocal": baseline_local,
            "experimental": experimental,
            "missingAudio": {
                "source": no_audio_probe,
                "encoded": no_audio_encoded_probe,
                "audioStreams": no_audio_encoded_probe["audio_streams"],
            },
            "imageOnly": {"probe": image_probe, **image_only},
            "durationPolicy": _metadata_policy_check(),
        }
        _render_report(result, output_path=output_path)
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=REPO_ROOT / "docs/measurements/encoding-benchmark.md",
        help="Markdown report path",
    )
    parser.add_argument(
        "--local-limit-bytes",
        type=int,
        default=1_500_000,
        help="small local cap used to exercise all three baseline attempts",
    )
    parser.add_argument(
        "--background-note",
        default="",
        help="optional note about concurrent local work during the measurement",
    )
    args = parser.parse_args()
    _require(args.local_limit_bytes > 0, "local limit must be positive")
    result = _benchmark(
        output_path=args.output,
        local_limit_bytes=args.local_limit_bytes,
        background_note=args.background_note,
    )
    print(
        json.dumps(
            {
                "report": str(args.output),
                "profile": result["profile"],
                "sampleCount": result["sampleCount"],
                "git": result["git"],
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
