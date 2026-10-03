# YouTube batches and media quality

## Live Telegram check — 2026-09-11

Method: native Telegram requests to the deployed bot, with one public playlist
and one public channel.

- A default-count playlist delivered its one available
  320×240, 19-second MP4 and explained the short slice; a two-item channel M4A
  request delivered both files in listed order (6,255,673 and 10,929,426
  bytes); an explicit one-item playlist MP3 delivered 232,755 bytes. A six-item
  request and a non-YouTube request were rejected without media jobs.
- All four media jobs had confirmed delivery and cleared temporary inputs, with
  no unfinished jobs, admissions, uncertain deliveries or dispatches left. The
  received MP4 passed full FFmpeg decoding and matched the local output's
  SHA-256. MP3 and M4A playback were checked; full decoding of the received
  audio files is not claimed.

These bounded fixtures do not show that every YouTube item is reachable from
the cloud server. The [Telegram re-check below](#telegram-re-check--2026-10-01-utc)
repeated these checks on 2026-10-01, and they passed.

## Telegram re-check — 2026-10-01 UTC

Run from a Telegram desktop client between 16:50 and 16:55 UTC. It reused the
2026-09-11 playlist and channel. `/activity` reports UTC.

- `/health` and `/ready` returned 200.
- Before the run, `/queue` reported no unfinished jobs.

| Step | Command | Result |
| --- | --- | --- |
| 1.1 | `/playlist <playlist URL>` | The bot sent the lookup notice, then "Queued 1 YouTube video item in listed order … The selected slice had fewer usable distinct items; nothing beyond it was added." It delivered one MP4: the 19-second, 320×240 test video. |
| 1.2 | `/channel <channel URL> 2 m4a` | "Queued 2 YouTube M4A items in listed order". It delivered the channel's two latest items as M4A files in listed order: 10:05 (9.3 MB) and 6:26 (5.9 MB). The channel has published a newer video since 2026-09-11, so the first item differs from that run. |
| 1.3 | `/playlist <playlist URL> 1 mp3` | "Queued 1 YouTube MP3 item". It delivered one MP3 of the same video, 0:19, 227.2 KB, the same size as the 232,755-byte file of 2026-09-11. |
| 1.4 | `/playlist <playlist URL> 6` | Rejected with the `/playlist` and `/channel` usage line. No job was created. |
| 1.5 | `/playlist <Vimeo channel URL>` | Rejected with "Use a public YouTube playlist URL or a channel /@handle or /channel/UC… URL. Mixes, feeds and other sites are not supported." No job was created. |
| 1.6 | `/queue`, then `/activity` | No unfinished jobs. `/activity` listed 16:50 Video, 16:51 Audio, 16:51 Audio and 16:53 Audio, all YouTube and all Confirmed. |

The record leaves out bot message IDs, SHA-256 hashes, ffprobe output and
decode results, because the received files were not saved from Telegram.
Sizes are as Telegram displays them.


## Download quality review

- Automatic video requests cap height at 1080p; individual `/video` requests
  offer lower ceilings. The selector considers available formats and known
  size estimates. Actual output height is checked, without upscaling.
- Prefer MP4 video plus M4A audio when available. A 49,000,000-byte direct
  Telegram target can select a smaller source or trigger H.264 CRF 28/32/35
  compression (AAC 96 kbps), then private-R2 fallback where available.
- M4A prefers available AAC/M4A; compatible AAC remux avoids another lossy
  encode where the existing path permits it. MP3 is converted; oversize audio
  can use 96/64/48 kbps. A requested extension does not imply original or
  lossless quality. Trimmed video uses H.264 CRF 23 and AAC 128 kbps.
- The [2026-09-08 actual-file checks](media-tools.md#telegram-e2e--2026-09-08-utc)
  decoded twelve media files successfully, including a 406×720 selected-height
  portrait, a 202×360 trim, MP3/M4A conversions and ordered clip albums.
  Those are dated fixture checks, not a fresh provider-wide quality score.
- That run's two YouTube video attempts failed upstream `LOGIN_REQUIRED`.
  Neither the old evidence nor a successful new playlist lookup proves that
  every YouTube item can be downloaded from the cloud server.

## Batch contract

Only explicit `/playlist URL [1-5] [video|m4a|mp3]` and
`/channel URL [1-5] [video|m4a|mp3]` expand collections. Defaults are three
automatic videos. Canonical public YouTube playlists and channel Videos tabs
are accepted; mixes, search/feed URLs, other sites, Shorts/live channel tabs
and access-control bypasses are not.

The Container uses the existing public-address-pinning egress proxy and an
argument-array yt-dlp process with finite positive playlist slicing, flat/lazy
metadata extraction and no media download. Output is capped at 256 KiB, the
Worker result at 4 KiB, and the lookup at twenty seconds including cloud
startup on the Worker side. Temporary lookup directories are cleaned. Only
strict video IDs cross the result boundary; the Worker constructs and validates
individual canonical URLs itself.

One per-user thirty-second lookup cooldown and the configured hourly lookup
cap are independent of media jobs and transcript searches. Only user/update/
time metadata uses the existing seven-day receipt cleanup. The collection
source and extracted list are not archived. Admitted per-video URLs use the
existing encrypted queue storage and terminal cleanup.

All resolved jobs are admitted in one D1 transaction, so queue/hourly caps or
an insertion failure cannot leave a partial batch. Each item occupies one
ordinary queue/hourly slot. A finite ordered slice is frozen once; duplicates
and known unusable entries are skipped without fetching replacements. A
download failure is independent of other jobs. No ZIP or aggregate delivery
receipt is introduced. Delivery uncertainty retains the existing operator gate.

Lookup is deliberately one-shot. The durable initial notice instructs the
user to check `/queue` before retrying after interruption; no automatic
collection re-expansion can submit a changed or duplicate list. Admitted jobs
and their dispatch notices retain the existing durable recovery.

## Local verification

- Worker collection contract/atomic admission regressions passed, including
  duplicate updates, independent owner queues, cooldown, queue filling during
  lookup, concurrent batches and full hourly rollback.
- Python collection checks: 19 passed, including strict inputs, finite process
  flags, output/time limits, cleanup, endpoint authentication and no accumulated
  concurrent metadata lookups.
- Fresh local provider lookup: YouTube's Videos tab returned exactly two IDs
  in 0.819 seconds; an empty yt-dlp fixture playlist correctly returned
  `MEDIA_UNAVAILABLE` in 3.873 seconds. Both left zero temporary workspaces.
- A positive public yt-dlp fixture playlist returned its one available video
  from a requested two-position slice in 1.030 seconds, with zero remaining
  workspaces. This confirms finite lookup, not media delivery.
- Full final-candidate regressions passed: 606 Worker tests in 40 files,
  459 Python tests with three opt-in skips, TypeScript/lint/build, Ruff/mypy
  and secret scan. Python finished in 36.32 seconds; no opt-in live/Whisper
  result is inferred from those totals. The native Telegram results are in
  the live check above.
