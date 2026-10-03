# M4A audio copy measurement

Method: FFmpeg 5.1.9 from the production Container image, run locally under
Docker (linux/amd64 on Apple Silicon), recorded 2026-09-07.

| Conversion of a synthetic 60-second MP4 with AAC audio | Median of 3 runs |
| --- | ---: |
| Copy existing AAC packets into M4A | 0.219 seconds |
| Re-encode audio to AAC at 96 kbit/s | 0.927 seconds |

Copying was 4.23 times faster for this fixture. The output contained one AAC
audio stream and no video; its AAC packet hash matched the source exactly.
These measurements cover only the local FFmpeg operation, including process
startup. They do not predict provider download time, Cloudflare cold starts,
Telegram upload time, or every recording's performance.

The YouTube path already prefers audio-only M4A and yt-dlp already copies AAC
when extracting M4A from MP4. Direct-media MP4 audio extraction uses the
equivalent copy-first path. Non-AAC input, MP3 requests, failed
copy attempts and files requiring compression retain the encoding fallback.

Reproduce with Python 3.12, FFmpeg and FFprobe on PATH:

```sh
python apps/downloader-container/scripts/audio_remux_benchmark.py
```

The script generates its own fixture, runs both paths three times, verifies
packet preservation and audio-only output, and prints timings. It makes no
network requests. [FFmpeg documents stream copying](https://ffmpeg.org/ffmpeg.html#Streamcopy)
as transferring encoded packets without decoding or re-encoding them.
