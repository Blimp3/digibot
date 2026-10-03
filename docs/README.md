# Documentation

The [root README](../README.md) is the overview and command reference.

## Guides

- [Architecture](architecture.md): request flow, queues, Mini App contracts, storage and delivery behavior.
- [Connected media](integration.md): pairing Provenance Lens, checks and downloads, link downloads, limits, data handling, failure and deletion behavior.
- [Security](security.md): trust boundaries and access controls; [reporting policy](../SECURITY.md).
- [Development](development.md): workspace setup, checks and dependency updates.
- [Troubleshooting](troubleshooting.md): provider, runtime and delivery failures.

## Measurements

These records state their method, environment and evidence boundaries. They
are dated observations from the private deployment this snapshot comes from,
not guarantees.

- [Local performance](measurements/performance.md): webhook latency, D1 query costs and encoding, with raw JSON results.
- [Encoding benchmark](measurements/encoding-benchmark.md) and [audio conversion benchmark](measurements/audio-remux.md).
- [Transcription](measurements/transcription.md): Whisper model selection, native Cloudflare CPU timings and quality checks.
- [ASR accuracy evaluation](measurements/asr-evaluation.md): scoring rules and the paired diagnostic.
- [Source captions and document search](measurements/captions-search.md).
- [Media tools](measurements/media-tools.md): quality selection, replied-file conversion and clip packs.
- [YouTube batches and media quality](measurements/youtube-batches.md).
