# Synthetic encoding benchmark

Recorded 2026-09-04T23:19:39+00:00.

This is a local, provider-free measurement. It leaves the product encoding policy unchanged. The fixture is a 1920x1080, 30 fps, 8-second `testsrc2` video with a 440 Hz / 48 kHz sine-wave audio stream. The local near-limit exercise uses **1,500,000 bytes** so the current three-attempt policy is exercised quickly; the production Telegram acceptance target remains **49,000,000 bytes**.

## Environment

| Item | Value |
| --- | --- |
| FFmpeg | `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers` |
| FFprobe | `ffprobe version 8.1.2 Copyright (c) 2007-2026 the FFmpeg developers` |
| Machine | `Darwin arm64` |
| CPU | `Apple M2` (8 logical cores) |
| Physical memory | `8589934592` bytes |
| Source checkout | Private pre-snapshot checkout with uncommitted changes |
| Sample count | `1` |
| Profile | `current-crf-vs-duration-audio-overhead-budget` |
| Source size | 29,108,242 bytes |
| Source duration | 8.000 s |
| Source streams | 1 video / 1 audio |

Background-load note: The parent D1 benchmark was running concurrently; treat wall and CPU values as observed under local contention.

The current service policy is three sequential video attempts at CRF 28, 32, and 35, with H.264 `veryfast` and AAC 96 kbps; it accepts the first output at or below the upload limit. The local experimental profile reserves the measured duration's AAC bytes and 8% of the target for container and rate-control overhead, then derives one video bitrate:

`video_bitrate = floor((target_bytes - ceil(audio_bitrate * duration / 8) - max(16,384, ceil(target_bytes * 0.08))) * 8 / duration)`

Later change (2026-09-22, not re-measured here): the service keeps the CRF 28/32/35 ladder but caps each attempt with `-maxrate`/`-bufsize` derived from the duration and byte budget, so the first attempt normally fits.

The experimental quality floor is PSNR >= 30 dB, SSIM >= 0.90, one AAC stream when audio is present, and mean audio-level change <= 1.5 dB.

## Measured encodes

Wall and CPU values are seconds from `/usr/bin/time`; peak memory is maximum resident set size. CPU is user + system. Each row is one fresh FFmpeg process.

| Profile | Accepted | Wall s | CPU s | Peak RSS MiB | Output bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current baseline CRF 28 | False | 0.87 | 4.38 | 459.6 | 2,571,249 |
| Current baseline CRF 32 | False | 0.78 | 4.10 | 462.1 | 1,663,153 |
| Current baseline CRF 35 | True | 0.82 | 4.14 | 449.9 | 1,326,389 |
| Experimental budget (1284 kbps video) | True | 1.36 | 4.98 | 449.2 | 1,487,809 |

Near-limit baseline total across all three attempts was **2.47 s wall / 12.62 s CPU**, with **462.1 MiB peak RSS** (the maximum of the three attempts). The final accepted pass was CRF 35 at 1,326,389 bytes; the first two attempts were over the 1,500,000-byte local cap.

Production-target calibration forced one CRF 28 encode of the 29,108,242-byte source, producing 2,571,249 bytes in 0.93 s wall / 4.56 s CPU, with 450.0 MiB peak RSS. Normal service would bypass transcoding because that source is already below the 49,000,000-byte limit. No comparable candidate near 49,000,000 bytes was measured; this run is calibration only. The smaller local target selected CRF 35 after 3 attempt(s).

## Quality and stream checks

| Candidate | PSNR dB | SSIM | Video | Audio | Quality floor |
| --- | ---: | ---: | --- | --- | --- |
| Current baseline selected CRF 35 | 36.252 | 0.976757 | h264 | preserved | pass |
| Experimental budget | 36.823 | 0.979485 | h264 | preserved | pass |

Experimental AAC mean level was -21.10 dB, a +0.00 dB change from the source; the output has 1 channel(s). Output duration was 8.000 s.

The missing-audio fixture was encoded with the same mapping (`0:a:0?`) and verified to contain zero audio streams; this checks that the optional map does not invent audio. The image-only planner check returned `output_kind=image`, selector `best`, and extension `jpg`; it does not route a JPEG through an MP4 video/audio merge.

## Duration policy evidence

The service's authoritative metadata validator accepted synthetic metadata exactly at the configured **7,200-second (two-hour) boundary** and rejected metadata at one second over it. Only the 8-second fixture was encoded, so this is boundary-policy evidence without a two-hour encode.

## Limits

- The 1,500,000-byte near-limit run is a bounded exercise, not a claim that the 49 MB result scales linearly across codecs, durations, resolutions, or hardware.
- This measures one local FFmpeg 8.x build and one synthetic pattern; real downloaded media can have different motion, audio layouts, subtitles, metadata, and muxing overhead.
- No live sources, Telegram calls, deployment, secret access, or product encoding-policy change were used.
