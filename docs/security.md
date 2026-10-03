# Security design

## Trust boundaries

The Telegram and Cloudflare path treats Telegram updates, URLs, redirect destinations, media metadata, filenames, extractor output, and Container responses as untrusted.

## Authentication and authorization

- Telegram webhook requests require `X-Telegram-Bot-Api-Secret-Token`; comparisons are timing-safe.
- In Telegram, only configured numeric Telegram user IDs in private chats can create or inspect jobs. Usernames are never authorization identities.
- A paired Lens session can create one kind of job: a link download through `POST /api/integration/link-downloads`. The job's user and chat come only from the authenticated account, never from the request, so the result goes to that account's own linked private chat. Invited accounts get 5 link jobs an hour; owners get the configured hourly job limit, shared with their Telegram jobs; everyone keeps the five-unfinished bound. The owner tier is re-checked against the live allowlist on every link-download request, so an owner account removed from it gets 403 there even with a valid session. That account keeps its other connected-media access (Lens Checks, Downloads, History and statistics) until it is revoked; there is no revoke command today.
- Worker-to-Container requests use a separate timing-safe internal secret.
- The Container has no public route; access is through its Durable Object binding.
- Download links use an HMAC over a canonical token payload including object identity and expiry.

Use separate, randomly generated values for every secret. Store them with `wrangler secret put` or a Cloudflare Secret Store binding. Do not place them in `wrangler.jsonc`, `.dev.vars.example`, GitHub variables, logs, test fixtures, or command-line arguments.

## URL and network controls

The Telegram interface accepts one `http` or `https` URL and a configured exact initial-host allowlist. URL parsing rejects credentials, invalid schemes, excessive length, localhost, loopback, link-local, private IP space, and metadata/infrastructure destinations. Hostnames are canonicalized before exact comparison and resolved to public addresses before yt-dlp starts. An allowlisted apex does not implicitly authorize its subdomains, and extractor-internal CDN/media hosts are not source-input entries. Application code follows no source redirects; any future application-level redirect resolver must cap the chain and repeat the same URL/DNS checks for every target. Supported-site redirects currently remain inside the pinned yt-dlp network/extractor layer and its finite redirect handling.

yt-dlp receives no Telegram-supplied headers, proxy, output path, postprocessor arguments, extractor arguments, or command-line options. All processes use argument arrays with shell execution disabled. Job IDs and filenames are validated independently of media metadata.

## Resource controls

Defaults limit URLs to 2,048 characters, media duration to two hours, source bytes to 500 MB, direct Telegram payloads to 49,000,000 bytes, one active download plus one independently admitted transcript, twenty accepted jobs per user per hour shared across both operations (five for an invited account's Lens link downloads), one item, and a roughly 20-minute download deadline. Transcription is capped at fifteen minutes of source audio and a persisted thirty-minute total deadline; its Markdown artifact is limited to 2,000,000 bytes. The Container uses a unique temporary directory. Failed preparation is cleaned immediately; verified artifacts retained for the separate delivery call are removed after confirmed delivery or terminal failure, with startup stale cleanup covering interrupted execution.

## Privacy

Structured logs contain a job ID, normalized source hostname, state, timings, sizes, retry count, stable error code, and bounded diagnostic classifications. They exclude Telegram user, chat, update, and message identifiers; source query strings; Telegram message bodies; token-bearing Bot API URLs; cookies; browser profiles; full signed URLs; raw process output; and media bytes. D1 retains only an encrypted full URL for the minimum processing window and clears it on a terminal state.

## Delivery invariants

- The provider-aware preparation status is deleted only after a successful final Telegram send.
- On failure the waiting message remains and is edited with a stable, short error.
- Retryable download work is isolated from the final Telegram upload; an ambiguous upload is not automatically repeated.
- R2 is private. Its Worker download route streams content and validates HMAC, expiry, object mapping, disposition, type, and length.

## Mini App and Worker status boundaries

The immutable Mini App registry contains only the downloader. Its canonical
shell is `/apps/downloader` with private APIs under `/api/apps/downloader/*`;
`/mini-app`, its assets, `/api/sources`, and `/api/history*` are exact legacy
downloader aliases. Route and method resolution occurs before authentication.
Protected APIs verify Telegram raw `initData` once, then bind every D1 and R2
operation to the resulting allowlisted user principal. Handlers cannot supply a
different user ID or escape the fixed `jobs/<job-id>/...` R2 namespace.

`GET /health` is liveness-only and returns only the stable service/version
fields plus Cloudflare's immutable `versionMetadata` (`id`, `tag`, and
`timestamp`). Bounded `GET /ready` performs only D1 `SELECT 1` and returns 503
when D1 is unavailable; it does not probe the Workflow, Container, or R2.
The scheduled handler runs every 15 minutes and deletes expired R2 objects
before clearing their D1 pointers while retaining history metadata.

Telegram message creation is non-idempotent. Worker status `sendMessage` calls
retry only an explicit HTTP 429, or a body-level 429 in HTTP 2xx with a valid
positive safe-integer `retry_after` no greater than 86,400 seconds. Delays above
the 30-second in-request budget are not shortened or held open by the Worker.
Missing or invalid values, network failures, 5xx responses (including a body
429), malformed confirmations, and other ambiguous outcomes are terminal and
never resent. Final media delivery is a separate non-retried Workflow step;
only explicit 400 and 413 responses permit the documented `sendDocument` and
private-R2 fallbacks for ordinary media. Transcripts already use `sendDocument`, have no R2 credentials, and do not get a second-send fallback.

## Dependency integrity

The Container lock pins Python packages, including yt-dlp's matching default EJS dependency. Deno is installed at image-build time and EJS is never fetched dynamically per job. The update script changes the lock, rebuilds linux/amd64, runs static checks and tests, starts the health check, and stops after local verification.

The transcription image pins the upstream whisper.cpp revision and verifies the multilingual small model against its expected SHA-256 at build time. Code, model, binaries and CPU-dispatch libraries are root-owned and nonwritable by UID 10001. Whisper runs from its trusted executable directory, since its loader searches the working directory as well as configured library locations. Untrusted loader-path environment variables are not forwarded to that runtime. Staged documents are operation-bound, size/UTF-8 checked, and verified against their saved SHA-256 before resume or delivery.

## Non-goals

The system does not bypass DRM, paywalls, CAPTCHA, robots policy, anti-bot
controls, private-media authorization or account security. Operate it only with
sources and metadata you are permitted to retrieve and display.

## Reporting a vulnerability

Do not open a public issue containing credentials, signed links, cookies, private URLs, Telegram IDs, or media. Rotate any exposed value first. Report it privately through GitHub private vulnerability reporting, as described in the [security policy](../SECURITY.md), with a minimal redacted reproduction, the affected commit, expected/observed behavior, and impact.
