# Private media downloader Worker

This app is the Cloudflare-side control plane for the personal downloader. It
accepts an authenticated Telegram webhook, records one update exactly once in
D1, sends a short-lived waiting message, and starts the named `MediaJobWorkflow`
instance. The workflow delegates retryable yt-dlp/FFmpeg preparation to the
private `DownloaderContainer`, then calls its separate non-retryable delivery
endpoint. The container owns the direct Telegram multipart/R2-link send,
and temporary-file cleanup; after the container confirms delivery, the Worker
records completion idempotently, then deletes the waiting message in a separate
idempotent step.

## Local setup

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm wrangler d1 migrations apply DB --local
pnpm dev
```

Never put a bot token, webhook secret, or HMAC key in `wrangler.jsonc`, source
control, logs, or a test fixture. Use Worker Secrets for deployed values:

```sh
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET
pnpm wrangler secret put INTERNAL_CONTAINER_SECRET
pnpm wrangler secret put ALLOWED_TELEGRAM_USER_IDS
pnpm wrangler secret put DOWNLOAD_LINK_HMAC_SECRET
```

Create the D1 database and private R2 bucket, replace the placeholders in an
environment-specific Wrangler configuration, set `R2_ENDPOINT` to the
account-specific S3 API endpoint shown in the R2 API tokens page. Containers
need the Workers Paid plan. For the first deploy, start Docker and run:

```sh
pnpm wrangler d1 migrations apply DB --remote
pnpm wrangler deploy
```

This builds and pushes both Container images, then deploys the Worker and
Workflow. For later Worker-only updates, run
`pnpm wrangler deploy --containers-rollout none` (or `pnpm worker:deploy` from
the repository root). It leaves the validated Container images and running
instances unchanged. Omit `--containers-rollout none` only for an intentional,
separately validated Container release.

The Worker exposes public `GET /health` and bounded `GET /ready` endpoints,
`POST /telegram/webhook`, and the signed `GET /download/:token` route. The
canonical downloader Mini App shell is `GET /apps/downloader`, with private
APIs under `/api/apps/downloader/*`. Existing `/mini-app`, its CSS and
JavaScript assets, `/api/sources`, and `/api/history*` paths remain exact
downloader compatibility aliases.

Health is liveness-only and retains the existing `ok`, `service`, and `version`
fields; its `versionMetadata` object contains the immutable Cloudflare Worker
version `id`, deploy `tag`, and upload `timestamp`. Readiness performs only a
bounded D1 `SELECT 1` check and returns HTTP 503 when D1 is unavailable. The
download route streams an R2 object and does not read the full object into
Worker memory. Dispatch and queue recovery run every minute; R2 retention runs
separately every 15 minutes, deleting expired private R2 objects before
clearing their D1 pointers and retaining the history rows.

## Security boundaries

- Telegram webhook requests require the Bot API secret header and a
  constant-time comparison.
- `ALLOWED_TELEGRAM_USER_IDS` must parse as exactly two distinct positive safe
  numeric Telegram user IDs (comma or whitespace separated); any one, three,
  duplicate, malformed, or otherwise invalid value rejects the whole config
  fail-closed. Only private chats are allowed.
- Source URLs are restricted to HTTP(S), exact configured hostnames, and
  public address space; credentials and fragments are rejected/removed.
- Source URLs are encrypted in D1 and cleared when a job reaches a terminal
  state. Only a keyed HMAC-SHA-256 of the URL and the source hostname remain
  for correlation.
- The final Container Telegram-send step has no automatic retry. Download/
  preparation retries are separate so an ambiguous upload cannot silently send
  a duplicate.
- Worker `sendMessage` status calls are retried only after an HTTP 429, or a
  body-level 429 inside HTTP 2xx, with a valid positive safe-integer
  `retry_after` no greater than 86,400 seconds. In-request calls decline valid
  delays above 30 seconds rather than shortening them or keeping a Worker
  request open.
  Missing or invalid values, network failures, 5xx (including body 429), and
  ambiguous 2xx responses are terminal and never resent. The final media
  delivery remains a separate non-retried Workflow step; only an explicit 400
  permits one `sendDocument` fallback and an explicit 413 permits an R2-link
  fallback.
- Preparation has a bounded Workflow timeout controlled by
  `JOB_TIMEOUT_SECONDS` (default 1200 seconds). The deadline is created at the
  preparation checkpoint after the durable queue notice is observed; queue
  wait and waiting-notice delay, including Telegram 429 backoff, are excluded.
  Container subprocess and Telegram timeouts remain enforced independently.
- `MAX_ACTIVE_JOBS` and `MAX_ACTIVE_TRANSCRIPTIONS` bound the active source and
  Whisper lanes. A five-unfinished limit applies to
  each owner or invited account, counting running and waiting work. Telegram commands
  from the two-user allowlist therefore allow ten; each invited account's Lens
  link downloads add up to five more in the same source lane. The separate
  `MAX_JOBS_PER_HOUR` limit remains per allowed user: the code default is 5,
  and the checked-in `wrangler.jsonc` sets 20.
- R2 is private; download tokens are HMAC-signed and expire independently of
  the object retention cleanup schedule.

## Request queues

Downloads and source captions share one durable FIFO lane; Whisper transcripts
use a separate durable FIFO lane. When a lane completes a job, its oldest
waiting request is promoted automatically, and the minute recovery promotes or
dispatches waiting work after a missed handoff. Waiting has no automatic queue
timeout. The source URL remains encrypted/protected in D1 while preparation
needs it; terminal completion or failure clears it.

The acceptance message reports the position when accepted. `/queue` shows only
the requesting user's unfinished jobs and current positions, while `/status`
reports the latest job's current position. Aggregate counts refer to the same
lane and disclose no other-user details. The preparation deadline is created
at the preparation checkpoint after the durable queue notice is observed;
queue wait and waiting-notice delay, including Telegram 429 backoff, are
excluded. There are no cancel, reorder or priority controls. An unknown
delivery outcome keeps the active lane slot for operator review and is not
automatically released or resent.

## Captions and file search

The `/captions URL [language]` path uses transcript document delivery
with `transcript_method=captions`, admitted on the source lane and routed to
the downloader Container. Full sources must be at most 900 seconds. Caption
preparation uses the ordinary 1,200-second default deadline, created at the
preparation checkpoint after the durable queue notice is observed; queue wait
and waiting-notice delay, including Telegram 429 backoff, are excluded.
Whisper remains on its separate lane with its existing model and settings.
Migrations
`0014_source_captions.sql` and `0015_job_queue.sql` add caption metadata,
search receipt fields, and the D1 queue guard/index and dispatch-lease trigger.

`/search phrase` must reply to a DigiBot-format `.md` document up to 2,000,000
bytes in the allowed user's current private chat. Saved and reattached files
are supported. The Worker validates and fetches the file only from Telegram,
searches normalized literal phrases within segments, and sends bounded
plain-text excerpts with neighbors and passage timestamps. Method provenance
is labeled as editable file metadata. Queries, documents and result excerpts
are not stored in D1, R2 or the notice outbox.

Atomic admission retains only update/user/time in `processed_updates` for the
existing seven-day cleanup, enforces a 30-second per-user cooldown, and uses
`MAX_JOBS_PER_HOUR` as a separate hourly search cap. A duplicate webhook does
not rerun the search; an uncertain result send is not automatically resent.
The getFile and download phases have total 7-second and 8-second deadlines,
respectively, including bounded response reads. Search does not occupy a
Container or create a job. See [architecture](../../docs/architecture.md) for
caption selection and search limitations, and the
[captions and search record](../../docs/measurements/captions-search.md) for
live and local-only checks.

## Quality selection, Telegram inputs and clip packs

The Worker persists ten-minute private quality prompts for explicit
`/video URL [timing]` or replied `/video [timing]`. Opaque callbacks bind the
choice to the allowed user, chat and prompt; selection consumes it atomically
with queue admission. A replacement supersedes the old prompt. Cancel removes
the prompt only. Automatic (up to 1080p by default), 720p, 480p and 360p choices
follow the configured ceiling; bare URLs retain automatic immediate admission.

Sending/forwarding one video, audio, voice message or audio/video document up
to 20,000,000 bytes returns instructions. Only an authorized same-private-chat
reply `/audio [m4a|mp3] [timing]` or `/video [timing]` admits conversion. Captions
and original sender metadata are not commands/authorization. Unsupported
photos/stickers/animations/video notes/albums/archives are rejected. Queued file
descriptors are encrypted, resolved at execution, cleared at terminal state,
and excluded from cross-job media-cache reuse.

Clip packs accept: `/clips URL` or replied `/clips` plus 2–3 ranges,
using the same picker, one admission/hourly count/deadline and one source-lane
job. Complete ordered album receipts are required through delivery and
recovery; uncertainty holds the whole job without resend or single-file/R2
fallback. Album rate-limit rejection is not automatically deferred/retried. See the
[media tools contract and checks](../../docs/measurements/media-tools.md) for bounds.

Migrations `0016_video_quality_prompts.sql`, `0017_telegram_file_sources.sql`
and `0018_clip_packs.sql` add the prompt, file-source and clip-pack state.
Deploy compatible Container images before the Worker. See the
[media tools record](../../docs/measurements/media-tools.md) for live and local
verification boundaries.
