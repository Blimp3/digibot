# ASR accuracy evaluation

This repository contains an offline scorer for completed Whisper results. The
scorer reads strict JSONL files and never invokes an ASR engine, calls a
provider, or accesses the network. It is intended to make accuracy evidence
repeatable while keeping source media and inference outputs outside the
production checkout.

## Evaluation inputs

The reference file has one record per clip. Each record contains:

- `clip_id`, `language`, `stratum`, `speaker`, `split`, and the reference
  `text`;
- `provenance` with a SHA-256, license, source, revision, and crop bounds;
- optional `critical` full-text checks, each with an ID and accepted forms;
- optional `anchors`, each with an ID, time window, and accepted forms.

The hypothesis file has one record per clip with `clip_id`, `status`, `text`,
and timestamped `segments`. Reference and hypothesis IDs must match exactly;
duplicates, unknown fields, duplicate JSON keys, blank JSONL lines, malformed
provenance, nonfinite timestamps, and unordered segments are rejected.

Completed `ok` and `no_speech` statuses are valid inputs. `cancelled`,
`error`, `failed`, `processing_failure`, and `timeout` are failure statuses.
An `ok` record's full text must equal its segment text joined with spaces after
Unicode NFC, case folding, straight-apostrophe canonicalization, and whitespace
collapse. This accepts harmless joining whitespace without allowing empty full
text to hide lexical segments. A `no_speech` record requires exactly empty text
and an empty segment list. Failure records may retain partial diagnostic text
or segments, but neither is treated as a transcription: the all-cases score
uses an empty hypothesis, so reference words become deletions. `valid_only`
excludes those failure statuses but retains completed `no_speech` results.

The allowed split labels are `calibration`, `heldout`, and `non_speech`.
Strata are validated lower-case snake-case identifiers rather than a fixed
taxonomy; the current corpus uses `parliamentary` and
`source_accented_parliamentary`. Language tags are stored in lower-case
BCP-47-like form. The provenance fields make it possible to identify the exact
source revision and crop used to create a reference without putting media in
the repository.

## Scoring rules

Text is normalized with Unicode NFC, case folding, canonical straight
apostrophes, and whitespace collapse. Lexical WER and CER discard sentence
punctuation while retaining accents, within-word apostrophes, fillers,
repetitions, numeric signs, and decimal separators. This makes `Hello, world.`
equivalent to `hello world` without changing `-12` into `12` or adding a
number-to-word dictionary. Word and character Levenshtein metrics report
substitutions, deletions, insertions, total errors, the reference-unit
denominator, and WER or CER. A zero-reference denominator is reported as
`null` rather than an invented zero rate.
Ordinary hyphens become word separators; a sign immediately before a number
is retained. CER includes the single normalized spaces between words.

Critical checks match an accepted form in the complete hypothesis text.
Timestamp anchors join hypothesis segments that overlap the anchor window and
apply the same explicit form matching to that bounded text. Numeric forms use
sign and decimal continuation boundaries, so a form `12` does not match
`-12`, `12.50`, or `120`. These are automatic phrase/form checks; they do not
replace human semantic review.

For an empty reference, the scorer classifies the raw completed output as
`empty`, `punctuation_or_symbol_only`, `non_speech_annotation`, or
`lexical_output`. A failed job is classified as `processing_failure`. A
bracketed label is considered an annotation only when its normalized body is
one of the recognized non-speech labels; ambiguous bracketed text remains
lexical output.

Each report contains `all_cases` and `valid_only` summaries grouped overall,
by language, by stratum, and by clip. It also includes status counts, no-speech
class counts, critical and anchor pass summaries, and a `gaps` object.

When baseline hypotheses are supplied, `baseline_comparison` reports the
candidate-minus-baseline all-cases WER and CER difference for each language.
Its fixed-seed paired bootstrap draws speakers with replacement 1,000 times and
includes every clip belonging to each drawn speaker, then reports a 95%
percentile interval. A language is explicitly unavailable when any speaker ID
is unknown, fewer than two known speakers are present, or a speaker cluster has
no lexical reference words. These intervals describe this corpus and sampling
procedure; the scorer makes no broader significance or population claim.

## Current evidence pack

The durable staging directory is a local evidence pack, intentionally outside
the repository. Its `corpus/README.md` freezes the natural-language selection plan:

- 12 standard English VoxPopuli test utterances;
- 12 English utterances with the source accent label;
- 24 Italian VoxPopuli test utterances;
- source-declared durations from 2 to 20 seconds and known `speaker_id` values.

The source metadata and revisions are recorded in `corpus/sources.json`.
FLEURS was checked as a secondary source but is not counted because the current
public selection does not provide a reliable speaker ID. VoxPopuli supplies
formal and spontaneous parliamentary speech with labeled non-native English
accents; it does not establish casual personal speech, consumer microphones,
quiet-room coverage, or production noise coverage.

The [VoxPopuli paper](https://aclanthology.org/2021.acl-long.80/) describes
references derived from supplied parliamentary transcripts, with alignment
and ASR-based filtering. These references are source annotations, not new ASR
hypotheses, but the checked source documentation does not establish two
independent human reviews of these selected clips. Dataset language and accent
labels likewise remain source metadata until the recordings are reviewed.
These clips were held out from DigiBot tuning; their absence from Whisper's
pretraining data is not established.

The same directory contains controlled synthetic inputs for boundary and
near-limit checks. `fixtures-new/manifest.json` records an 899-second,
16-kHz mono Samantha fixture at 175 words per minute and a separate 10-second
digital-silence fixture, including their hashes and scripted anchor windows.
The completed 48-clip native paired diagnostic and its frozen hypotheses are
recorded below. A separately justified four-case replay was subsequently run
once for the four historical failures; its result is recorded after the
original report. The representative working inventory is described after the
diagnostic reports; its human-reference and inference gates remain open.

## Native paired diagnostic — 2026-09-08

All 48 clips were processed once with each variant: **96 Whisper launches**,
with no automatic retries. Every decoded input was nonzero. Baseline and
candidate hypothesis records, including text, segments and failure status,
were identical for all 48 pairs. Each variant produced **44 completed results
and four processing failures**. The corpus contains 493.868 seconds of audio
and 24 known, distinct speakers per language.

The unchanged scorer counts failed jobs as empty usable hypotheses in the
all-cases view; the valid-only view excludes them. Rates below apply equally
to baseline and candidate. WER cells show percent and word errors/reference
words; CER cells show percent and character errors/reference characters.

| View | Source-labelled group | Cases (failed) | WER | CER |
| --- | --- | ---: | ---: | ---: |
| All cases | English | 24 (1) | 35.489% (225/634) | 26.710% (914/3422) |
| All cases | Italian | 24 (3) | 31.270% (197/630) | 23.806% (987/4146) |
| All cases | English parliamentary | 12 (0) | 31.683% (96/303) | 22.980% (384/1671) |
| All cases | English source-accented parliamentary | 12 (1) | 38.973% (129/331) | 30.268% (530/1751) |
| Valid only | English | 23 (0) | 31.261% (186/595) | 22.759% (739/3247) |
| Valid only | Italian | 21 (0) | 17.681% (93/526) | 9.769% (342/3501) |
| Valid only | English parliamentary | 12 (0) | 31.683% (96/303) | 22.980% (384/1671) |
| Valid only | English source-accented parliamentary | 11 (0) | 30.822% (90/292) | 22.525% (355/1576) |

All Italian clips are parliamentary, so their stratum totals equal the Italian
language totals. All-cases word substitutions/deletions/insertions are
120/90/15 for English and 45/137/15 for Italian; corresponding character counts
are 333/436/145 and 133/793/61. The complete report retains every grouping,
per-clip result and valid-only edit count.

The paired candidate-minus-baseline WER and CER changes are **0 percentage
points**, with 95% speaker-bootstrap intervals **[0, 0]** for each language
(1,000 replicates, seed 20260908). Thus the diagnostic non-regression gate
passed, while the all-cases pilot thresholds of WER ≤20% and CER ≤10% failed
for both languages. Identical outputs establish no accuracy improvement.

| Automatic accepted-form check | English matches | Italian matches |
| --- | ---: | ---: |
| Names | 19/31 (61.290%) | 11/17 (64.706%) |
| Number expressions | 1/3 (33.333%) | 6/6 (100%) |
| Negation expressions | 2/8 (25%) | 4/6 (66.667%) |

These are all-cases lexical matches, not human semantic judgements. The name
target failed in both languages and the English number target failed. Six
Italian number matches do not satisfy the required 20-expression coverage.
Negation matching cannot establish unchanged polarity. All 48 reference
records have zero reviewed timing anchors, so alignment accuracy is unavailable.

The failed IDs are `voxpopuli-en-20`, `voxpopuli-it-03`,
`voxpopuli-it-14` and `voxpopuli-it-23`. For each failed run, FFmpeg and
Whisper exited successfully before production transcription raised
`DownloadError` / `PROCESSING_FAILED`. No timeout or output-limit event was
recorded. Each pair has the same raw-output hash. The original report retained
only those byte counts and hashes, so the validator reason was unknown at that
time; the separately justified replay below retained the raw JSON and
reproduced the failure. No validation threshold was relaxed and no failed
output was counted as a completed transcript.

Worst-five all-cases WER IDs are English `en-02`, `en-20`, `en-15`,
`en-06`, `en-21`, and Italian `it-11`, `it-23`, `it-03`, `it-14`,
`it-19` (all use the `voxpopuli-` prefix). The per-clip report retains their
edit counts and failure status. Some English-labelled hypotheses contain
non-English text; neither the spoken language nor the source annotation has
been independently reviewed, so this observation does not establish its cause.

The frozen references have SHA-256
`f7f44ea81b9bf71eba36ee726e9df70bf114ecec543efc5bf8e4786f71215338`.
Before inference, one absent Italian number form was removed from the reference
checks; the original and correction receipt remain preserved. Nothing was
retuned after inference. Both 48-record hypothesis files have SHA-256
`a977a15db7d462e2f1de26e87daa11f0fa431e9112245c70c53d175de9fc195d`;
the unchanged scorer CLI output has SHA-256
`4739c796cf72e47d873d06a68a021a1d838b9b091a102151e54f3efb9b638b8c`.
The annotated report adds provenance, critical-category counts and worst-clip
tables; its SHA-256 is
`c21c2d356877026cf647f1cf4ff610bc7addee737c1c9eaeb1afc2a6cb9a5af2`.
Every original scorer field was verified equal in the annotated report.
Files share prefix `corpus/results/asr-score-final48-f7f44ea81b9b-`
in a local evidence pack outside the repository: `references.jsonl`,
`baseline-hypotheses.jsonl`, `candidate-hypotheses.jsonl`, `scorer-output.json`,
`report.json` and `summary.md`. The four sealed native receipts and their hashes are listed
in that summary and `native-paired/receipts/corpus-four-batch-summary.json`.

### Four-clip failure replay — 2026-09-08

The candidate-only replay ran once for the four historical failures. All four
retained raw JSON files matched the historical byte counts and SHA-256 values,
and the unchanged candidate parser reproduced
`PROCESSING_FAILED: transcript timestamp exceeds media duration` for every
clip. The existing 0.5-second timestamp tolerance and failure status were
preserved.

| Clip | Media duration (s) | Last raw end (s) | Excess (s) |
| --- | ---: | ---: | ---: |
| `voxpopuli-en-20` | 12.417063 | 14.000000 | 1.582937 |
| `voxpopuli-it-03` | 16.099938 | 17.000000 | 0.900062 |
| `voxpopuli-it-14` | 9.899063 | 11.560000 | 1.660937 |
| `voxpopuli-it-23` | 14.080063 | 16.100000 | 2.019937 |

The sealed receipt is
`native-diagnostic/receipts/cf_a8777175e57806f3250016f6afa903aec452e74f96df148ecc573bd0ee460920.receipt.json`
with SHA-256
`d55e00c32751c94f5357428452fa930d3c3f22f7ee6be18192501e6cbe7014fb`; the
offline replay report is `native-diagnostic/receipts/analysis.json` with
SHA-256 `c713edf6d011c587175665a5a91b62eb5e35af65759fd17b4345fa93053d235d`.
The replay used candidate parser SHA-256
`7518d0b2eaeae96bd8e3689c428b8d9689150a04d3a078820f9d3d2c7671b4ce`.
The receipt records four candidate invocations, 134.105 seconds of harness
time, an absent run workspace, and zero remaining Whisper processes. This was
a separate four-case diagnostic, not a new 48-clip rerun. The original 48-clip
score reports and hypothesis files remain unchanged, and this replay makes no
quality-improvement claim.

### Remaining representative coverage

A working inventory in a local evidence pack outside the repository has 84
slots. Its final verifier reports 72 populated local
candidates and 12 planned Italian slots: 36 of 48 held-out speech rows are
populated, all 12 calibration rows are populated, and all 24 no-speech rows are
populated. The no-speech panel contains six exact-zero files, six room-tone
files, six noise/effect files, and six instrumental files; the exact-zero
check verified decoded mathematical zero samples.

The target remains 48 held-out 45–90-second recordings across English and
Italian narration, conversation, accented/fast speech and quiet/background
speech, plus 12 separate calibration recordings and 24 no-speech cases. It
requires two independent fluent reviews, adjudicated references, reviewed
timing anchors, and at least 20 names, 20 number expressions and 20 negation
expressions per language. The 12 open speech slots are six Italian
accented/fast cases and six Italian quiet/background cases.

| Candidate source | Current planning label | Status boundary |
| --- | --- | --- |
| AMI Meeting Corpus | English conversation, accented/fast, quiet/background, and calibration | Source and crop candidates are recorded; category and human review remain pending. |
| NOCANDO | English and Italian clear narration, plus Italian calibration | Picture narration is not conversation; source labels do not establish quality. |
| Radio Radicale | Italian broadcast-interview conversation candidate | Interview format and language are source labels; spontaneous conversation and speaker identity remain pending. |
| Ambient and no-speech sources | Exact-zero, room tone, noise/effects, and instrumental | The panel is populated for review; contamination and sung-word checks remain pending except for the exact-zero check. |

These source and stratum labels are candidate labels from provenance and
planning, not passed quality or representativeness decisions. The verifier
confirmed AMI and NOCANDO held-out/calibration source splits are disjoint;
cross-corpus voice identity is unproven. All natural speech references,
independent reviews, category decisions, anchors, and contamination checks
remain pending, and no new panel ASR has run. The short 48-clip diagnostic does
not fill these representative slots.

The reviewer pack (208 files including 72 clips, plus a checksum file) is kept
in a local evidence pack outside the repository. A [2026-09-10 native Telegram follow-up](transcription.md#telegram-delivery-follow-up--2026-09-10-utc)
verified fresh v4.1.1 transcription and document delivery for a 161.472-second
source. That check is separate from independent review of the new transcript
and from the representative accuracy panel, which remain incomplete.

## Running the scorer

Run the self-check with Python 3.12 or later:

```sh
python3.12 tools/test_asr_eval.py
```

Score two JSONL files and write a deterministic JSON report:

```sh
python3.12 tools/asr_eval.py \
  --references references.jsonl \
  --hypotheses hypotheses.jsonl \
  --output asr-report.json
```

Add an offline baseline comparison with a third JSONL file in the same
hypothesis schema:

```sh
python3.12 tools/asr_eval.py \
  --references references.jsonl \
  --hypotheses candidate.jsonl \
  --baseline-hypotheses baseline.jsonl \
  --output comparison-report.json
```

The command writes exit status 2 and a concise error to stderr for malformed
input. It performs no media conversion and does not modify either input file.
