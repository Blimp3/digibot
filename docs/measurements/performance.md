# Local performance evidence

These are local synthetic measurements, not Cloudflare billing or live
Telegram/source measurements. No provider calls were made. The runs were taken
in the private source repository before this snapshot; the commit IDs and
checkout state in the raw JSON refer to that history and do not resolve here.
They measure that code, not later unmeasured changes.

## Webhook and accepted notice

Method: 100 sequential synthetic media requests per implementation, real local
Miniflare/workerd D1, a fixed 250 ms fake Telegram response, and immediate
simulated Workflow startup. The baseline is the earlier webhook implementation. Each request must
return 200 with durable acceptance and produce exactly one confirmed notice.
The disposable test database is reset between samples. No source probe,
Container startup or media delivery occurs in this benchmark.

| Final committed Worker run | Earlier implementation | Recovery implementation |
| --- | ---: | ---: |
| HTTP p50 | 349.10 ms | 81.85 ms |
| HTTP p95 | 363.28 ms | 104.93 ms |
| HTTP p99 | 388.92 ms | 199.42 ms |
| Confirmed notice p50 | 326.71 ms | 377.92 ms |
| Confirmed notice p95 | 338.84 ms | 405.97 ms |
| Confirmed notice p99 | 359.49 ms | 487.48 ms |
| Failures / requests | 0 / 100 | 0 / 100 |
| Notice sends | 100 | 100 |

[Raw final results](webhook-final.json). The earlier
[isolated exploratory run](webhook-isolated.json) is retained separately. The target of HTTP p95 below
one second passed here. It was not obtained by hiding a long notice delay.
Notice timing includes the fake network delay and local outbox/receipt writes;
real Workflow scheduling delay is not measured.

The earlier deliberately retained [contended result](webhook-contended.json)
ran alongside substantial local testing. Recovery HTTP p95 was 1,228.75 ms,
p99 18,490.60 ms; notice p95 1,739.66 ms and p99 6,427.32 ms. Both sides still
had zero failures in 100 requests. This run **missed** the one-second target.
These are two separate runs, not a confidence interval or a guarantee.

Reproduce from repository root:

```bash
pnpm exec tsx apps/cloudflare-worker/tests/webhook-benchmark.ts
```

The benchmark builds the earlier implementation from a commit in the private
history, so this command does not run in this snapshot.

## D1 query and write costs

Method: actual local D1, checked-in initial/recovery SQL, 10,000 completed
synthetic jobs across four owners with a repeated source identity, plus 10,000
dispatch records (500 started). Admission triggers are omitted for synthetic
history insertion. Real application query helpers run 10 warmups and 100
measured samples each; assertions require identical before/after results.
Candidate indexes exist only in the disposable benchmark database.

| Query | Rows read before → candidate | p95 before → candidate | Decision |
| --- | ---: | ---: | --- |
| History | 51 → 21 | 13.48 → 14.38 ms | Keep existing index; no observed latency gain |
| Scoped cache | 12,500 → 1 | 14.30 → 16.80 ms | Add only this index in migration 0011 |
| Statistics | 12,500 → 12,500 | 14.03 → 12.67 ms | No new index |
| Recovery | 1,000 → 20 | 12.29 → 14.85 ms | Keep existing index; synthetic active density exceeds normal one-slot workload |

All query samples had zero failures and zero writes. Query plans show the
scoped cache candidate serving every equality key and output ordering without
a temporary sorting tree. A separate 100-sample completed-metadata update
measured mean writes **1 → 2**, p95 **15.76 → 15.90 ms**, p99
**16.64 → 16.73 ms**. The additional index write is intentional; the sizable
read reduction, rather than noisy local latency, justifies the cache index.
The other candidate indexes are not added. [Raw queries, plans and write
measurements](d1-final.json). The earlier
[candidate run](d1-candidates.json) is retained for comparison.

These warm timings include local binding overhead. The final run was separate
from encoding and the full workspace suite; the exploratory candidate run had
concurrent encoding load. Cache p95 did not improve consistently across runs. This repeated-source dataset tests a cache-heavy case, not observed
production traffic. Measure remote rows and workload frequency after an
approved release before claiming monetary savings.

```bash
pnpm exec tsx apps/cloudflare-worker/tests/d1-benchmark.ts
```

## Encoding and unchanged resource policy

The [encoding report](encoding-benchmark.md) measures an 8-second 1080p
synthetic fixture on Apple M2 / FFmpeg 8.1.2 at a deliberately small 1.5 MB
ceiling. The whole three-attempt baseline took 2.47 s wall / 12.62 s CPU;
the experimental budgeted pass took 1.36 s / 4.98 s. Peak RSS was
462.1 → 449.2 MiB and accepted output 1,326,389 → 1,487,809 bytes.
Both met the stated PSNR/SSIM/audio quality checks. One sample per profile is
insufficient for a production encoding change, so no policy was changed.

The two-hour limit was tested with boundary metadata, not a two-hour encode.
The forced 49 MB calibration uses an already-small source which ordinary
service would not transcode. Missing-audio and image-only handling are checked.

After the frozen Python environment is installed, reproduce from
`apps/downloader-container` with `uv run python scripts/encoding_benchmark.py`.

Concurrency remains one, `standard-1`, sleep five minutes. Cloudflare cold/warm
startup, provisioned-resource cost, actual CPU/egress, workload frequency, and
alternative idle times are **unmeasured** and remain prerequisites for tuning.

## Safe observations

The implementation records webhook duration, confirmed-notice delay, dispatch
delay, cache hit/miss, retries, preparation/delivery and individual Container
stage timings through existing allowlisted logging. Private diagnostics expose
bounded state counts, oldest claims, confirmed-but-incomplete jobs, and cleanup
backlog; they never wake the Container. Actual Python dependency health and
the Worker wrapper's synthetic health are separate checks. Persisted traces
remain disabled. Logging failure tests reject raw URLs, tokens and private
exception data; no production traces were enabled to obtain measurements.
