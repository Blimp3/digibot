# CPU transcription measurements

Measured 2026-09-07. The initial engine candidate is multilingual Whisper small,
run through whisper.cpp with GPU acceleration disabled. Model selection is
based on the measurements below, including a native Cloudflare CPU comparison.

## Local model comparison

The same 20.310125-second synthetic English speech fixture was converted to
16 kHz mono PCM and processed on an Apple M2. Wall time includes process
startup. Real-time factor (RTF) is processing seconds divided by audio seconds.

| Model | CPU threads | Wall time | RTF |
| --- | ---: | ---: | ---: |
| Medium | 1 | 96.06 s | 4.73 |
| Medium | 4 | 41.81 s | 2.06 |
| Small | 1 | 26.10 s | 1.29 |
| Small | 4 | 8.82 s | 0.43 |

All runs succeeded. Both models recognized the scripted phrases; differences
were number and unit formatting on this fixture. JSON and SRT timestamps
agreed, were monotonic, and remained within 0.5 seconds of the source duration.
Small emitted four segments; medium emitted nine. This clean synthetic sample
does not establish accuracy on noisy, multilingual, or long recordings, and
Mac timings do not predict Linux container throughput. The local Homebrew binary used its CPU/BLAS path; a configured Whisper thread count is not a CPU quota. The Cloudflare image uses the pinned upstream CPU-dispatch build with BLAS disabled, so cross-environment differences cannot be attributed to CPU allocation alone.

The small model is 487,601,967 bytes, downloaded from the
[official whisper.cpp model repository](https://huggingface.co/ggerganov/whisper.cpp).
SHA-256: `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.
The downloaded hash matches the model host's advertised linked ETag.

Comparison command, with the same fixture and a distinct output path per run:

```sh
whisper-cli -m MODEL -f fixture.wav --no-gpu -t THREADS -p 1 -l en \
  --output-srt --output-json --output-json-full --output-file OUTPUT
```

## Reproducing the synthetic fixture

The fixture was generated with macOS `say`, voice `Samantha`, at 175 words per minute, then converted with FFmpeg. The measured WAV SHA-256 is `d62c5cc7cec08ce2265bb08ce77e9b6e481ed6efda9bcdb9c3f275aef27e44ea`. A different macOS voice revision can produce different audio even from the same text; use the same WAV bytes for a controlled model/CPU comparison.

```sh
cat > fixture.txt <<'TEXT'
Benchmark transcript. This is a deterministic English speech fixture for local transcription. The key phrases are alpha river, copper meadow, and Cloudflare container. Count one, two, three. Timestamp checks use sixteen kilohertz mono PCM audio. The final phrase is green lantern. This sentence confirms the end of the test.
TEXT
say -v Samantha -r 175 -f fixture.txt -o fixture.aiff
ffmpeg -i fixture.aiff -ar 16000 -ac 1 -c:a pcm_s16le fixture.wav
```

## Cloudflare and Telegram

A Linux/amd64 image with scalar CPU kernels passed its non-root dependency
health check, but a 3.888-second speech fixture did not finish within the
300-second test cap under emulation on this Mac. No transcript or valid RTF
was produced. The deployed image uses upstream runtime CPU dispatch so native
hosts can select their supported optimized kernels. Emulation results are not
treated as Cloudflare throughput measurements.

The final Telegram regression ran on Worker 2.1.0 with the downloader on
`standard-1` and transcription on `standard-3` (2 vCPU, 8 GiB memory, 16 GB
disk), SSH disabled and empty authorized-key and trusted-CA lists.

### Production Telegram overlap check

A test session sent `/transcript` for a 19.064-second public YouTube test video, followed by an uncached `/audio` request for its first seven seconds. D1 read-back showed both admission lanes active simultaneously.

| Operation | Accepted (UTC) | Completed (UTC) | Total elapsed | Delivered result |
| --- | --- | --- | ---: | --- |
| Full-source transcript | 19:53:33.261 | 19:54:34.441 | 61.180 s | `<title>.md`, `text/markdown`, 375 bytes |
| First-seven-second audio | 19:53:42.988 | 19:54:12.524 | 29.536 s | M4A, `audio/mp4`, 113,449 bytes, verified duration 7.000 s |

The audio completed 21.917 seconds before the transcript. Both results were present in the authenticated Telegram conversation. Opening the actual received Markdown in Telegram's native viewer confirmed the source-title heading, source, duration, explicit Whisper-small method, transcript heading and readable English paragraphs beginning at 00:00, 00:07 and 00:16. Its short caption preview was visible. This verifies delivered structure and the separate lanes on one small fixture; it is not a general accuracy score or long-source test.

These are complete job times including source preparation, startup, processing and delivery, separate from the native processing measurements below. A repeat wake request at 20:37 UTC returned `LOGIN_REQUIRED`; no access-control workaround was attempted. The next request at 20:46:06.594 UTC completed at 20:47:06.560 UTC (59.966 seconds), delivering another 375-byte Markdown document. That repeat used the temporary two-CPU allocation with the application's existing one-thread setting. Source availability and extraction latency can vary independently of ASR.

### Final post-selection Telegram overlap check

An authorized public 161.472-second Instagram Reel was submitted for
transcription, followed by an uncached X request for an 11-second M4A. D1
showed both operation lanes admitted simultaneously.

| Operation | Accepted (UTC) | Completed (UTC) | Total elapsed | Delivered result |
| --- | --- | --- | ---: | --- |
| Full-source transcript | 21:18:32.225 | 21:20:35.892 | 123.667 s | 3,503-byte `text/markdown` document |
| First-11-second audio | 21:18:39.471 | 21:18:55.640 | 16.169 s | M4A, `audio/mp4`, 180,319 bytes |

The audio completed 100.252 seconds before the transcript. Opening the actual
received Markdown in Telegram's viewer showed the post's default title,
Instagram as the source, duration `00:02:41.472`, the method
`Automatic speech transcription (Whisper small)`, readable Italian paragraphs,
visible timestamps from `0:00.000` through a tail at `2:35.400`, and a caption
preview. This verifies final delivery structure and lane overlap on one
fixture. It does not establish transcript accuracy or alignment, and the
same-instance workspace cleanup was not directly observed.

### Native Cloudflare processing comparison

The exact synthetic WAV above was passed through the deployed `transcribe_audio` function on Cloudflare's native Linux/amd64 host. Both runs used the same image, model bytes, clean environment and non-root UID 10001. The host reported AVX2, AVX512F, F16C and FMA. No other job was active during either measurement.

| Allocation | Whisper threads | Audio | Processing wall time | RTF |
| --- | ---: | ---: | ---: | ---: |
| standard-2: 1 vCPU, 6 GiB | 1 | 20.310125 s | 46.833 s | 2.306 |
| standard-3: 2 vCPU, 8 GiB | 2 | 20.310125 s | 19.795 s | 0.975 |

Wall time covers FFmpeg conversion, Whisper process/model startup, automatic language detection, inference and document validation; it excludes source download, Container startup, SSH connection and Telegram delivery. The local model table used an English-language CLI setting and a different CPU build, so its timings are not a controlled comparison with these cloud runs.

Both native runs exited successfully, preserved all four scripted phrases, passed the production monotonic/bounded timestamp parser and output-size checks, and produced byte-identical Markdown. Two CPUs cut this measured processing time by 57.733% (2.366x speedup). This is one short clean fixture per allocation, not a statistical benchmark, representative accuracy evaluation or proof of the full 15-minute input limit.

## Resource costs and selection

Official [Cloudflare Container pricing](https://developers.cloudflare.com/containers/platform/pricing/) checked 2026-09-07. The Workers Paid plan is $5/month. Its monthly Container allowances are 375 vCPU-minutes, 25 GiB-hours memory and 200 GB-hours disk, shared with other Container use. Additional active CPU costs $0.000020 per vCPU-second; provisioned memory and disk while running cost $0.0000025 per GiB-second and $0.00000007 per GB-second. Idle awake time still incurs memory/disk usage; sleeping stops these charges. Workers, Durable Objects, logs and network are separate meters.

| Role or option | CPU | Memory | Disk | Gross cost per fully CPU-used running hour, before allowances |
| --- | ---: | ---: | ---: | ---: |
| Existing downloader: standard-1 | 0.5 vCPU | 4 GiB | 8 GB | $0.074016 |
| Initial transcription: standard-2 | 1 vCPU | 6 GiB | 12 GB | $0.129024 |
| Candidate upgrade: standard-3 | 2 vCPU | 8 GiB | 16 GB | $0.220032 |
| Larger comparison: standard-4 | 4 vCPU | 12 GiB | 20 GB | $0.401040 |

Illustrative usage only, not measured throughput or a spending forecast: thirty jobs per month, each with ten minutes of fully used CPU plus five minutes awake idle, would cost approximately $0.18 in Container overage on standard-2 versus $0.585 on standard-3, assuming all included allowances remain available and negligible idle CPU. The same-workload upgrade would add about $0.405/month if it provided no speedup. If standard-3 halved the processing phase to five minutes, its illustrative overage would instead be about $0.135/month. This example excludes other services, other Container use and egress; actual remaining allowances have not been inspected.

CPU capacity is distinct from the number of Whisper threads. A justified two-CPU trial must also use two inference threads; increasing only memory/capacity while keeping the one-thread cap would not establish the benefit of parallel inference. The authorized decision was to measure the initial native host, retain security/accuracy/timestamp checks, and choose the smallest allocation that gives practical latency. The native result selected `standard-3` with two Whisper threads, and the permanent Worker setting and final production delivery check are complete. The downloader allocation remains separate.

Using the table's fully utilized rates, the measured processing interval has an estimated gross cost of $0.0016785 on standard-2 versus $0.0012099 on standard-3, about 28% lower because it finishes sooner. This estimate assumes every allocated CPU is fully used throughout the interval and excludes startup, the five-minute idle tail, other services and allowances; it is not a measured bill. Five minutes of awake idle memory/disk alone adds roughly $0.004752 on standard-2 or $0.006336 on standard-3 before allowances. The resource choice favors practical latency at this small usage scale; actual monthly cost depends on workload and shared allowances.

## Post-release bounded quality checks — 2026-09-07 UTC

These opt-in checks used the production `transcribe_audio` path, pinned small
model, automatic language detection, two Whisper threads, GPU disabled, a
900-second input limit and a 1,800-second deadline. They are bounded fixture
checks, not a representative accuracy evaluation.

| Fixture and environment | Audio | Processing time | Result |
| --- | ---: | ---: | --- |
| Native Cloudflare, synthetic English speech plus pink noise | 20.310125 s | 19.370 s (RTF 0.9537) | **Passed:** all scripted phrase anchors, bounded/monotonic timestamps and document limits; six segments, 1,893-byte JSON, 547-byte Markdown, 305-character preview |
| Native Cloudflare, digital silence | 10 s | 15.751 s | **Failed no-speech expectation:** `unexpected_speech`; one segment, 804-byte JSON, 167-byte Markdown and three preview characters |

The noisy fixture mixes the original Samantha/175-wpm speech with seeded pink
noise (amplitude 0.02, seed 2419, equal mix weights, no normalization, limiter
0.95). Its FLAC SHA-256 is
`6453a6f06e29f2ae24a13c1ee6fc28835a45adaf646d61e7929166b615bf547d`.
Silence FLAC SHA-256 is
`bb6d4056e688428e27cbc8b14675dc2f92e14a328c525d22afa03221cba85095`.
The silence receipt retained counts, not the output text. The instance slept
before follow-up inspection, so whether those characters were lexical or
punctuation remains unverified; a lexical hallucination is not established.
A future bounded silence check should retain that classification before any
no-speech handling change. No model tuning or runtime patch followed this
quality failure.

Largest-process peak RSS was 786,419,712 bytes for noise and 785,027,072 bytes
for silence; these are not aggregate Container peaks. Job-directory usage
sampled every 250 ms peaked at 651,895 and 320,078 bytes respectively,
excluding model, fixture pack and other directories; sampling can miss brief
peaks. Neither run includes source acquisition, Container startup or Telegram
delivery.

### Near-limit local check

The **899-second synthetic English check failed locally** after 1,790.195
seconds, with 9.804 seconds remaining from the 1,800-second deadline and a
10-second process-cleanup reserve. The harness reported `transcription_failed`
and exit 1; it did not retain an exception subtype. No completed Whisper JSON
or Markdown was produced, so phrase anchors, timestamps and document-size
checks were not assessed. This gives no completed-output RTF or quality pass.
It is not evidence of a native Cloudflare timeout.

The source is 17,909,583-byte FLAC, SHA-256
`f5d24b637dc1014a9ed62565843816d4c034ed943f2c705255e176b7f8a79176`,
generated with macOS Samantha at 175 words/minute. Varied English speech
contains name, number, phrase and negation anchors near the start, middle
(431.502–456.943 s) and tail (869.269–880.507 s). Anchor matching would normalize
number words/digits and inspect bounded timestamp windows; an empty failed-
anchor list after inference failure is not an anchor pass.

This run used an Apple M2 and Homebrew whisper.cpp 1.8.4 CPU/BLAS with the same
pinned small model, two Whisper threads and GPU disabled. The shared Mac was
not isolated or CPU-quota constrained; the cloud build and CPU are different.
Largest-process peak RSS was 797,458,432 bytes and job-directory usage sampled
every 250 ms peaked at 28,768,078 bytes. Neither metric is total process-tree
memory or total disk use. The Whisper child was absent after the run ended.

The near-limit fixture was not run natively: SSH does not keep the Container
awake, and the brief native test instance slept before follow-up inspection.
No keepalive route, sleep-policy change, model change, deadline extension or
repeat inference was added. Native 899-second behavior and the full
source-to-Telegram deadline remain unproved.


## Native quality follow-up — 2026-09-08 UTC

These baseline runs used the unchanged `transcribe_audio` implementation, the
production small model and
Whisper executable, two threads, and a separate native `standard-3` Container.
The temporary Worker had no public routes, preview URL, Internet access, SSH
access, keys, production secrets, database, or bucket. An authenticated
Workflow held the normal Container HTTP request open and consumed its response.
The existing five-minute idle policy and 1,800-second job limit remained in
force; the absolute deadline was persisted once with the five-second Worker
margin. There were no extra health probes or SSH keepalives during inference.

The full receipts were retrieved through Cloudflare's
[full Workflow step-output API](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/step/).
The ordinary instance-status response truncates large step values. The
receipts are kept in a local evidence pack outside the repository; media and
generated hypotheses are not production storage.

| Baseline | Audio | Core processing | Result |
| --- | ---: | ---: | --- |
| Restored digital silence | 10 s | 23.177 s | **Lexical output:** `you`, one segment at 0.000–2.060 s, despite all 160,000 PCM samples being zero |
| New long synthetic fixture, cold | 899 s | 587.084 s | Processing completed; **quality failed** on `start:Maya Rossi`; the other 11 scripted checks passed |

The silence FLAC is byte-identical to the earlier fixture:
`bb6d4056e688428e27cbc8b14675dc2f92e14a328c525d22afa03221cba85095`.
The new run retained the exact Whisper JSON, Unicode code points, Markdown,
preview and complete PCM inspection. Its receipt SHA-256 is
`5637f035c3c039fe2c8c3439764db4aa9df021b15940742853de900b5a12769d`.
The discarded 2026-09-07 output text remains unavailable. A separate first
Workflow attempt failed during initial Container provisioning, before an ASR
receipt existed; it is retained as an infrastructure failure.

The new long fixture is a separate authored Samantha/175-wpm recording,
16,508,545-byte FLAC, SHA-256
`4c861d2419afcba17b324e4a00d057a496f66cf2f25a7281833b41c98498c6a2`.
It contains 78 complete utterances and known gaps, with scripted checks near
1, 440 and 870 seconds. It is not the earlier 899-second Mac fixture. Its
baseline produced 149 monotonic, bounded segments and a 17,997-byte Markdown
document matching the production parser. The final segment ended at 880.160 s,
0.132 s before the scripted last speech end at 880.292 s. These are coarse
segment checks with a 15-second boundary tolerance, not word-alignment scores.
The long receipt retained hashes and timestamps, but not the mistaken name's
exact text; that spelling cannot be recovered from this receipt.

The cold run reached Markdown readiness with 1,204.267 seconds left. Its
completed-processing RTF was 0.653, although the required quality gate failed.
The Workflow start-to-destruction interval was approximately 592 seconds.
The failed quality gate prevented a warm run; no threshold or accepted spelling
was changed to turn it into a pass. Cold receipt SHA-256:
`91dcd6cb047a0f10241d61143e66b6e8362a98a8f37d0c7783581bc5d4a1e0f0`.

One-second sampling recorded a 1,030,414,336-byte peak sum of process RSS,
1.9501 average CPU cores, and a 28,768,078-byte peak run workspace for the long
run. Summed RSS can count shared pages more than once. Cgroup memory counters
were unavailable, so no aggregate Container-memory peak is claimed. Both runs
verified their UUID workspace absent and zero remaining Whisper processes
before the Workflow destroyed the Container. These runs cover the native ASR
core and its request lifetime; source acquisition, production admission,
staging and actual Telegram delivery were outside this baseline harness.

The conservative candidate checks the completely validated, decoded mono
PCM stream and skips Whisper only when every sample is exactly zero. All
nonzero input retains the existing model, arguments and parser. The empty
document identifies the method as `Digital silence check (Whisper skipped)`
and remains compatible with reply search. It does not apply a volume cutoff,
VAD model, phrase blacklist or punctuation filter. The decoded-stream boundary
also applies to stereo cancellation and values lost during PCM quantization;
it does not establish that the original source was acoustically silent.

Natural-language scoring and its remaining coverage gaps are documented in
[ASR accuracy evaluation](asr-evaluation.md). Candidate native results and
release status must be established separately from these baseline results.

### Candidate evaluation gates fixed before inference

The paired natural-speech runs used the same 48 frozen English/Italian
VoxPopuli clips for baseline and candidate, once per variant with no automatic
retry. This is a short parliamentary diagnostic set, not the proposed
representative set of 48 clips lasting 45–90 seconds across narration,
conversation, accented/fast speech and quiet/background-sound strata.

| Check | Fixed target | Evidence boundary |
| --- | --- | --- |
| Exact decoded zero | Empty transcript and preview; zero Whisper launches; valid staged document and cleanup | Broader room tone, noise, music and quiet human speech require separate cases |
| Paired non-regression | Candidate-minus-baseline WER at most +1 percentage point and CER at most +0.5 per language; investigate every new complete-utterance omission | Nonzero-path differences need explanation even within those limits |
| Pilot accuracy | WER at most 20% and CER at most 10% per language; clear speech WER at most 15%, challenging strata at most 30% | Parliamentary strata cannot stand in for missing representative strata |
| Critical content | At least 95% correct names and numbers; no changed polarity or invented critical facts | Frozen automatic phrase checks do not establish semantic correctness |
| Alignment | All anchors present; median boundary error at most 1 s and 95th percentile at most 2 s | Natural clips have no independently reviewed word boundaries, so this gate is unavailable |
| Near-limit delivery | Verified Markdown with at least 30 s left, then confirmed delivery within the actual deadline | Private native staging does not establish Telegram delivery |

The broader plan also requires 12 separate calibration clips, a reviewed
24-case no-speech panel, and at least 20 names, 20 number expressions and 20
negation expressions per language with reviewed time intervals. Those missing
cases remain coverage gaps. A verified exact-zero fix may be released with
that narrow claim while the broader quality gates remain unmet.

### Completed short paired diagnostic

Four native batches completed all 48 baseline/candidate pairs, for 96 Whisper
launches. All input was nonzero and all paired text, segments and statuses
were identical. Each variant had 44 completed results and four processing
failures. The [accuracy report](asr-evaluation.md#native-paired-diagnostic--2026-09-08)
records all-cases English WER/CER of 35.489%/26.710% and Italian
31.270%/23.806%, with failures counted as deletions. Non-regression passed;
the absolute pilot accuracy gates failed. This is the short parliamentary
diagnostic, not the missing representative 45–90-second corpus.

Every completed artifact passed production manifest/resume validation and had
at least 30 seconds left at Markdown readiness. The four batch harness times
were 632.251, 647.731, 462.565 and 481.829 seconds. One-second resource sampling
recorded average CPU use between 1.9051 and 1.9163 cores, a maximum summed
process RSS of 852,369,408 bytes, a maximum run-workspace size of 1,825,769
bytes and a minimum free filesystem space of 14,033,297,408 bytes. Cgroup CPU
statistics were available; cgroup memory current/peak/events and CPU quota
were not. Initial/final guest memory readings are not a Container memory peak.

All 96 runs recorded absent UUID workspaces and no Whisper process remaining;
each completed batch Workflow destroyed its Container. The four final receipt
hashes, deadlines and resource data are preserved in the local evidence
pack. Source acquisition, production admission and Telegram delivery were
outside these runs.

### Candidate 899-second cold diagnostic

The candidate processed the same frozen 899-second fixture in **581.539
seconds through production transcription and document staging** (581.937
seconds for the harness). It produced a verified **18,005-byte Markdown** with
**1,206.628 seconds left** on the persisted deadline, 149 monotonic bounded
segments, and a final segment end of 880.160 seconds. The source, model,
Whisper binary and two-thread setting matched the baseline. This was a fresh
Container boot under the normal five-minute idle policy with the request held
open and fully consumed; no keepalive or lifecycle extension was introduced.

The required quality gate **failed** again: the opening `Maya Rossi` became
`Maijarasi`. The other 11 frozen coarse checks passed. The complete raw Whisper
JSON, transcript, Markdown and preview were retained, and their byte counts
and hashes were verified after retrieval. No accepted spelling or timestamp
tolerance was changed. The baseline's exact mistaken spelling was not retained,
so identical full text across the long runs cannot be established. A warm run
remains withheld after the failed cold quality gate; these timings establish
neither a quality pass nor actual Telegram delivery. The baseline excluded
document staging, so this pair is not a controlled speed comparison.

Production manifest integrity and resume checks passed. The UUID workspace was
absent and zero Whisper processes remained before successful Workflow Container
destruction at 13:24:19 UTC. One-second sampling (583 samples) recorded average
CPU use of 1.9454 cores, peak summed process RSS of 1,031,389,184 bytes, peak
workspace size of 45,316,552 bytes and minimum free filesystem space of
13,989,806,080 bytes. The workspace measurement includes staged source bytes.
Cgroup memory counters were unavailable; initial/final guest memory snapshots
do not establish a Container-memory peak.

Receipt SHA-256:
`3adc6cf8c0a004a07aa793a143595de23adf38f6b4c992214c5ace516903bdbe`.
The candidate's raw Whisper JSON SHA-256 is
`011d8edbcac697d21d0920042d0c29c55a21de2fa2002f9a0d66f0e694cdf423`;
the staged Markdown SHA-256 is
`ae9677a60825486ca608a4f35a9ed8a77e142d1af00a057075f9f48e69f4b753`.

### Candidate exact-zero staging and v4.1.1 release

The candidate processed the same 10-second silence FLAC on native Cloudflare
compute in **1.443 seconds through production transcription and document
staging**. The complete harness interval was 1.840 seconds. All 160,000 decoded
PCM samples were zero; Whisper was launched zero times. Text, segments and
preview were empty. The 175-byte Markdown used the method
`Digital silence check (Whisper skipped)`. Its staged manifest hash matched the
document, the production resume check passed, and 1,790.090 seconds remained
at Markdown readiness. The UUID workspace was absent and no Whisper process
remained before the Workflow destroyed the Container.

Receipt SHA-256:
`a8c31f0dc39508af9e3663630ca142b3932d6d98fe262bfbb46ebbce97f522bf`.
This is one native exact-zero case, supplemented by deterministic local
boundary tests; it does not close the 24-case no-speech panel or establish
quiet-speech recognition. An initial Workflow trigger passed its parameters
as a string and was rejected before any Container or ASR step. The corrected
client passed an object; this control-plane failure is retained separately.

The native candidate staging harness calls `DownloaderService._stage_transcript`
and its document staging path, with real UUID workspaces, manifest integrity
and resume validation. Its source bytes are staged from licensed or synthetic
fixtures. It excludes external source acquisition, production admission and
Telegram delivery. Holding the request open and consuming its response uses
the existing five-minute idle policy; no keepalive or sleep-policy extension
was added.

This exact-zero check shipped in v4.1.1. Its image replaced only
`transcription.py` on the existing transcription image; the remaining source,
Whisper binary, model, FFmpeg and Whisper libraries were verified unchanged,
with the same two vCPUs, 8 GiB memory, 16 GB disk, two inference threads,
disabled SSH and empty key lists. CI passed all six jobs.

## Telegram delivery follow-up — 2026-09-10 UTC

The historical accuracy results above remain unchanged.

One fresh `/transcript` request for the previously tested public Instagram
reel was sent through the native Telegram client.
The bot visibly accepted it, delivered the Markdown with a text preview, and
the received document was opened in Telegram's viewer and saved locally.
The production path excludes transcript cache reuse.

| Check | Observed result |
| --- | --- |
| Serving Worker before and after | v4.1.1 |
| Source duration | 161.472 seconds |
| Admission / completion | `2026-09-10T11:21:58.891Z` / `2026-09-10T11:24:31.837Z` |
| Admission-to-completion elapsed | 152.946 seconds; 1,646.163 seconds remained before the recorded deadline |
| Received document | 3,503 bytes, UTF-8 `text/markdown`; size matches the confirmed D1 delivery record |
| Content structure | Title, Instagram source, duration and Whisper-small method; 30 nonempty timestamped passages with nondecreasing start times from 0.000 through 155.400 seconds, within source duration |
| Delivery / dispatch | `confirmed` by `telegram`, completed job and dispatch, one dispatch attempt, no job error |
| Reply search | Replying `/search asset manager` to the received document returned four matching passages with neighboring context; the visible matching timestamps `00:00:10.880`, `00:00:23.360`, `00:01:05.800` and `00:01:48.760` match the downloaded file |
| Completed-job data | Encrypted source URL cleared; no R2 object pointer |
| Final production checks | Health/readiness HTTP 200 with D1 ready; zero unfinished jobs, active admissions, sending/unknown deliveries, unfinished dispatches and confirmed-but-unreconciled jobs |

The actual Telegram-downloaded file has SHA-256
`5b4eb43899cc73f6a0917949be653e2b0f2edf6bd7829c1215a340b51fe8bdb5`.
Local evidence outside the repository retains the received document,
sanitized read-only D1 and health receipts, the native-UI search observation
and runnable delivery assertions.
The received transcript is not committed to the repository.

This closes the pending fresh v4.1.1 Telegram transcript-delivery check for
this source. It is not a new 899-second Telegram run, exact-zero Telegram
case, word-accuracy measurement or direct Container-workspace cleanup
observation. The supplementary positive reply-search check passed; the
earlier zero-match and reattachment checks retain their original date/version.
No runtime, model, validation threshold, provider, resource or deployment
change was made. Independent review of this newly delivered transcript is not
claimed.
