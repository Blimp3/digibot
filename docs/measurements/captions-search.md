# Source captions and document search

## Local source checks — 2026-09-07 UTC

These checks used this feature checkout's actual `probe_media`,
`PublicEgressProxy` and `source_captions` path with yt-dlp 2026.07.04 on a
local computer. They fetched source metadata and caption tracks, without downloading
audio/video or invoking Whisper. Temporary Markdown files were removed after
inspection. They do not prove Cloudflare-to-Telegram delivery.

| Public source | Selected track | Output | Search phrase |
| --- | --- | --- | --- |
| A 19-second public test video | Publisher-provided English; default and explicit `en` selection passed | 435-byte Markdown, 6 cues | A known phrase, at `00:00:07.974` |
| A 143-second public video with automatic captions | Original automatic English | 10,408-byte Markdown, 142 cues | A known phrase, at `00:00:04.240` |

The automatic track exposed two source-format cases now covered by regression
checks: an empty first VTT payload line and display tails beyond the source
duration. Valid cue ends are clipped to the known source duration; invalid,
reversed, nonfinite or out-of-source starting times remain rejected. Rolling
captions can repeat words in adjacent passages; only identical overlapping
cues are combined. These are passage timestamps, not verified word alignment.

The selected TED and Vimeo metadata probes failed upstream before caption
extraction. These two successful YouTube fixtures do not establish provider-wide
support, multilingual quality or behavior near the 900-second source ceiling.

## Local regression and review

The final local checks passed 451 Worker tests and 263 Python tests with three
explicit optional skips.
These checks validate source behavior; production evidence follows separately.

Search regressions cover authorization, strict document parsing, bounded
fixed-origin file reads, Unicode-normalized literal matching, context and
truncation, cooldown/hourly limits, replay and no resend after uncertain sends.
Only update/user/time receipts use seven-day cleanup; files, queries and result
text are not stored. Queue fault, cap and isolation checks are local evidence.

## Live Telegram checks — 2026-09-08 UTC

The queue/Whisper/download batch began on 2026-09-07 at 23:44 UTC; final caption
retests completed on 2026-09-08.

Health, readiness and unknown-route 404 checks passed.
The downloader instance was observed running the final image after successful
caption requests. ASR remains at two CPUs, 8 GiB and two Whisper threads; caption requests
did not wake or revise it.

### Source captions: initial failure, fix and retest

Both initial YouTube caption requests failed `LOGIN_REQUIRED` during shared
yt-dlp metadata probing, before caption fetching. Local extraction had not
proved Cloudflare availability. The fix permits missing media formats only for
caption metadata probing; ordinary download and Whisper probes stay strict.
No cookies, client impersonation, alternate egress or Whisper fallback was added.

The final runtime delivered both explicit-English requests:

| Source | Received document | Method/language | Submission to delivery |
| --- | --- | --- | --- |
| The 19-second public test video | `<title>.md`, 435 bytes | Publisher-provided captions, `en` | 10.323 s |
| The 143-second public video | `<title>.md`, 10,408 bytes | Original automatic captions, `en` | 17.259 s, including queue wait |

Both documents were actually received and saved from Telegram; their method,
language and timestamped content were checked. Saved bytes were identical to
the received downloads.
D1 confirmed completed deliveries, cleared encrypted source URLs and no R2
object. Automatic rolling captions retain repeated text at adjacent timestamps;
this is not exact word alignment.

### Download, Whisper and queue checks

The initial batch admitted five unfinished requests for one authorized user:
two Whisper transcripts, one eight-second audio clip, and the two captions that
initially failed. `/queue` showed active source and Whisper jobs concurrently,
a second Whisper at position 1 and source-caption positions 1 and 2; `/status`
showed the latest request at position 2. Failed caption jobs released their
slots in order without blocking Whisper.

The audio file arrived in 16.186 seconds. Whisper delivered a 3,503-byte
Markdown file after 119.495 seconds; its queued successor automatically
promoted and delivered after 223.808 seconds including wait. The final caption
retest separately showed the second caption accepted at source position 1 and
automatically promoted. All five initial terminal jobs cleared encrypted source
URLs. These observations prove the named FIFO/concurrency fixtures, not
sustained throughput or a general latency guarantee.

### Actual reply-to-file search

At 00:01–00:03 UTC, before the caption-only update, native Telegram searches
passed on both the original delivered Whisper document and a saved/reattached
copy. The copy was 3,503 bytes with SHA-256
`5b4eb43899cc73f6a0917949be653e2b0f2edf6bd7829c1215a340b51fe8bdb5`.
A known phrase returned one matching passage at `00:00:00.000` and neighboring
context at `00:00:05.440`; a separate query returned `No matches found.`
The result retained title and explicitly labeled editable method metadata.

The first two searches created exactly two minimal search receipts with null
job IDs, zero new jobs and zero new notices. Together with code and retention
regressions, this supports the ephemeral search contract; it is not an
account-wide infrastructure inspection. No permanent transcript archive or
query/excerpt storage was added.

On the final runtime at 00:10 UTC, the saved 10,408-byte automatic
caption file was reattached in Telegram and searched by replying with
`/search` and a known phrase. The actual response identified `Automatic captions`
and `en`, and returned three matching passages at `00:00:04.240`,
`00:00:06.430` and `00:00:06.440`, with neighboring context from
`00:00:04.230` through `00:00:08.110`.

At 00:11 UTC, replying to the original publisher-caption document with
`/search` and a known phrase returned one matching passage at
`00:00:07.974`, with context at `00:00:05.318` and `00:00:12.616`.
The result retained `Publisher-provided captions` and `en` as file metadata.

### Scope limits

Sixth-job rejection, second-user isolation, uncertain-send injection and
missed-completion minute recovery were checked locally, not injected live.
Five accepted jobs do not themselves prove rejection of a sixth. Queue wait
has no automatic expiry by contract; this run is not an indefinite wait test.
Cooldown/replay fault behavior remains local-test evidence. Same-instance
workspace cleanup was not directly observed; terminal D1 URL clearing was.

The named fixtures do not establish provider-wide availability, exact word
alignment, full 900-second behavior, representative accuracy, sustained
throughput or billing. Published [Whisper measurements](transcription.md)
remain unchanged: bounded native noise passed, silence failed its no-speech
expectation and the 899-second local check produced no completed transcript.
