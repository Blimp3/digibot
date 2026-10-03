# Media tools — contract and live check

Method: local regression suites, then one live Telegram run on 2026-09-08 with
actual fixtures. Received files were saved and checked with FFprobe, a full
FFmpeg decode or a UTF-8 content check.

Result: quality selection, replied-file conversion and ordered clip packs
worked on these fixtures. All 15 received files passed. Four
saved/reattached-file searches (three positive and one no-match), fresh
captions and Whisper, selected-quality URL video and bare URL video passed.

## Quality and conversion contracts

| Input/action | Implemented behavior |
| --- | --- |
| Bare public URL | Automatic immediate admission, retaining the existing path |
| `/video URL [timing]` or reply `/video [timing]` to supported media | Private quality picker: Automatic (up to 1080p by default), 720p, 480p, 360p, Cancel; choices filtered by configuration |
| Picker selection | One-use opaque callback bound to the allowed private user/chat/prompt; ten-minute expiry, replacement supersedes previous prompt, selection atomically admits one queued job |
| Cancel | Cancels the selection prompt, not a previously admitted job |
| Sent/forwarded attachment alone | Instructions only; neither caption nor original sender grants authority |
| Reply `/audio [m4a\|mp3] [timing]` or `/video [timing]` | Convert one video/audio/voice/audio-video document, at most 20,000,000 input bytes; `/video` uses the picker |

Actual output height is capped without upscaling. Telegram inputs require
same-private-chat authorization, declared and streamed bounds, real media
verification and safe local demuxing. Photos, stickers, animations, video
notes, albums, archives, playlists and local-reference inputs are excluded.
The source descriptor stays encrypted while queued, `getFile` resolves only
when the job runs, and the input is removed after verified output. There is
no permanent input archive or cross-job cache reuse. Single-output delivery
retains the 49,000,000-byte Telegram budget and private-R2 fallback.

## Clip-pack contract

Use `/clips URL from 00:00 to 00:02; from 00:03 for 2 seconds`, or reply
`/clips from 00:00 to 00:02; from 00:03 for 2 seconds` to supported media.
The existing timing grammar defines 2–3 requested MP4 clips in one native
Telegram album. Requested order is preserved, overlaps allowed, duplicate
ranges rejected both as requested and after source-end clamping. Clamping is
disclosed. Each clip is at most 120 seconds; aggregate requested duration is
at most 300 seconds. No automatic
moment selection or ZIP bundle is introduced.

The same quality picker, one source download, one job/hourly count/queue slot
and one processing deadline cover the pack. Prepare and verify all clips
before one group call. The whole multipart request must fit 49,000,000 bytes:
reserve 64 KiB, allocate remaining media bytes equally across clips, and check
the actual HTTPX multipart `Content-Length` before sending. A configured lower
upload ceiling further reduces the budget. Equal allocations can reject an
uneven pack even when another clip has spare bytes. Success needs all ordered
message IDs throughout delivery and recovery; incomplete/ambiguous delivery marks the whole job unknown without automatic
resend or fallback. A Telegram rate-limit rejection is not automatically
deferred/retried for the album. A partial album cannot be assumed safe to retry.

## Local regression record — 2026-09-08

The final parent-run Worker suite passed 567 tests in 37 files in 35.33 seconds.
The full Python suite passed 419 tests with three explicit opt-in skips for
live providers/local Whisper-model checks. Root lint, typecheck, build/Worker
dry-run, secret scan and generated-binding checks passed; the dry-run bundle
was 318.07 KiB (73.83 KiB gzip). Ruff and mypy also passed (23 Python source
files checked by mypy). An independent security review of the frozen
clip-pack implementation, including transport and Worker recovery, reported no
defect. This is scoped local review evidence, not production verification.

Earlier phase checks passed 490 Worker/302 Python tests for quality selection
and 538 Worker/362 Python tests for file conversion. Those counts describe
earlier stages, are not added together, and do not replace the integrated run.
No CI or production behavior is inferred from local results.

Local clip checks cover requested order, duplicate/effectively duplicate
ranges, aggregate limits, exact multipart transport size and complete receipt
validation through Workflow/recovery. Telegram fault behavior remains local
regression evidence until an actual live receipt says otherwise.

## Telegram E2E — 2026-09-08 UTC

The callback helper verified registered `message` and `callback_query` updates
and zero pending updates.

The received-file verifier passed 15 actual saved Telegram files:
12 media files passed FFprobe/full FFmpeg decode, and three Markdown documents
passed UTF-8/content checks. The media fixtures include:

| Actual request/output | Verified result |
| --- | --- |
| Reply-convert UI-forwarded landscape fixture to 3-second MP3 | MP3, 3.000 s, 48,851 bytes |
| Portrait video, selected maximum 720p | H.264/AAC MP4, 406×720, 10.005 s, 98,592 bytes |
| Pair requested in order 7–9 s, then 0–2 s, maximum 480p | Two H.264/AAC MP4 files, 854×480, 2.000 s each; blue then red; 70,844 bytes combined |
| Trio requested in order 3–5 s, 7–9 s, then 0–2 s, maximum 360p | Three H.264/AAC MP4 files, 640×360, 2.000 s each; green, blue, red; 105,669 bytes combined |
| MP3 audio file converted to 3-second M4A | AAC audio, 3.000 s, 47,981 bytes |
| Ogg/Opus audio-file conversion | AAC M4A, 8.000 s, 98,839 bytes; not a Telegram voice-message fixture |
| Bare Instagram URL | H.264/AAC MP4, 608×1080, 161.471 s decoded audio duration, 11,316,011 bytes |
| Instagram URL, first 3 seconds, selected maximum 360p | H.264/AAC MP4, 202×360, 3.009832 s, 109,726 bytes |
| Attributed forward from DigiBot, replied MP3 first 3 seconds | 48,974 bytes; decoded audio 3.000 s, D1/container duration 3.030204 s |

The pair and trio arrived as native albums. D1 confirmed their complete ordered
message-ID arrays, with the first ID matching the scalar anchor. Saved file
sizes matched the job receipts; inspected colors independently verified the
submitted nonchronological order. The successful file-source jobs had
cache reuse disabled and their encrypted source cleared at terminal state.
Received files and D1 receipts are distinct checks: the later received-file
record completes trio/M4A inspection that the earlier cumulative D1 snapshot
still marked pending.

Cancel visibly removed its keyboard. There was no isolated D1 read between
Cancel and creation of the next prompt, so the UI observation does not establish
an independently sampled post-Cancel zero-prompt count. Forward was performed
from the user's own Saved Messages, but Telegram removed the sender attribution;
that first fixture did not prove forwarded-origin behavior. A later bot-video
Share action targeted only DigiBot and visibly retained `Forwarded from DigiBot`.
Replying with MP3 first three seconds produced the separately verified
48,974-byte result, with confirmed D1 delivery, cache reuse disabled and source
cleared. This closes the attributed-forward UI coverage gap; it does not claim
an independent raw `forward_origin` payload inspection. The Ogg/Opus
upload was classified as an audio file, not a genuine Telegram voice message,
so it covers audio-file handling only.

Fresh selected-360p and bare-URL YouTube video requests both failed upstream
with `LOGIN_REQUIRED`. These are provider rejections, not successful downloads;
the strict ordinary-media probe was retained. A fresh bare Instagram URL did
deliver the independently decoded file above. A separate Instagram URL with
selected 360p and a three-second trim also completed and is included in the
15-file receipt.
Across 14 admitted media jobs, 12 completed and the two known YouTube video
requests failed `LOGIN_REQUIRED`; no other unexpected failure was recorded.

Fresh publisher and automatic caption files were received, saved and reattached
(435 and 10,408 bytes). A new Whisper document was also received, saved and
reattached (3,503 bytes). Actual positive reply searches passed for all three;
a fourth, no-match publisher search also passed:

| Fresh document | Actual matching passages | Returned method/language metadata |
| --- | --- | --- |
| Publisher captions | One, at `00:00:07.974` | Publisher-provided captions, `en` |
| Automatic captions | Three, at `00:00:04.240`, `00:00:06.430`, `00:00:06.440` | Automatic captions, `en` |
| Whisper | Four, at `00:00:10.880`, `00:00:23.360`, `00:01:05.800`, `00:01:48.760` | Whisper small transcription; no language field in this document |
| Publisher no-match query | Explicit `No matches found.` | Source title, Publisher-provided captions, `en` |

The fresh Whisper request completed in 121.548 seconds with one dispatch
attempt and zero prior exact media-cache candidates. The deployed Workflow
always bypasses media-cache reuse for transcript operations. This establishes
a fresh request path even though its deterministic Markdown bytes match the
prior fixture; a job's `cache_valid` flag alone is not evidence of reuse.
ASR instance observations before/after showed the transcription application
stopped; its running state was not caught. The downloader was directly
observed running.
The ASR serving claim therefore rests on configured version, fresh request
lineage and successful output, not a captured running-instance snapshot.

`/queue` showed Whisper downloading concurrently with captions starting and a
video at waiting position 1; `/status` showed that latest queued position.
These observations are separate from the completed output receipts.

Reattaching `publisher.md` produced the correct `/search` hint. Replying with
a nonmatching phrase returned the title, publisher method, English language and `No matches found.`
`/queue` then reported no unfinished jobs.

### Not verified in this run

- Genuine Telegram voice-branch coverage remains absent. A running ASR snapshot
  was not captured; fresh inference lineage and output are recorded above.
- Live boundary-size, end-clamping, prompt-expiry/replacement, input-cleanup,
  partial-album and uncertain-send fault coverage is not inferred from local
  tests or these short happy-path files. Their local checks remain separate.
- Album totals above are saved media bytes; exact multipart enforcement is
  code/local-test evidence, not an independently captured live HTTP request.

## Limits of this evidence

After the run, D1 held 14 jobs: 12 completed and the two expected provider
failures. No delivery, notice, job, admission, dispatch, source or quality
prompt was left open or unknown. Search receipts hold only update, job, time
and user metadata, with no query, excerpt or file content. Fault and boundary
scenarios remain local-only. Source-data clearing in D1 does not prove that
the Container disk was inspected.

These named fixtures do not establish provider-wide support, long-run queue
reliability, throughput or billing.
