#!/usr/bin/env python3
"""Compare local AAC stream copy with re-encoding; no provider or Telegram calls."""

import hashlib
import json
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


def run(*args: str) -> bytes:
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=120)


def audio_hash(path: Path) -> str:
    return hashlib.sha256(run(
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
        "-c:a", "copy", "-f", "adts", "-",
    )).hexdigest()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="digibot-audio-") as temporary:
        root = Path(temporary)
        source = root / "source.mp4"
        run(
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=160x120:r=1:d=60",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=60",
            "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "128k",
            "-shortest", str(source),
        )
        timings: dict[str, list[float]] = {"copy": [], "encode": []}
        for _ in range(3):
            for mode in timings:
                target = root / f"{mode}.m4a"
                started = time.perf_counter()
                run(
                    "ffmpeg", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0",
                    "-vn", "-c:a", "copy" if mode == "copy" else "aac",
                    *([] if mode == "copy" else ["-b:a", "96k"]),
                    "-movflags", "+faststart", str(target),
                )
                timings[mode].append(time.perf_counter() - started)
        copied = root / "copy.m4a"
        assert audio_hash(source) == audio_hash(copied), "AAC packets changed"
        probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-of", "json", str(copied)))
        assert len(probe["streams"]) == 1 and probe["streams"][0]["codec_name"] == "aac"
        medians = {mode: statistics.median(values) for mode, values in timings.items()}
        print(json.dumps({
            "ffmpeg": run("ffmpeg", "-version").decode().splitlines()[0],
            "source_seconds": 60, "runs_per_mode": 3, "median_seconds": medians,
            "speedup": medians["encode"] / medians["copy"], "aac_packets_identical": True,
            "audio_only": True,
        }, indent=2))


if __name__ == "__main__":
    main()
