# Troubleshooting

For runtime failures, inspect the Cloudflare job status and safe structured logs.
The Container image provides pinned yt-dlp/EJS, Deno, FFmpeg and FFprobe;
installing programs on a local machine does not repair production dependencies.

## Missing downloader dependency or JavaScript runtime

Reproduce the failure in the Container image. Review and update its pinned
dependencies through the existing maintenance command:

```bash
./scripts/update-downloader-dependencies.sh
```

This runs local validation and does not deploy; release production changes
separately. Do not enable per-job remote EJS components.

## YouTube requires sign-in or asks to confirm you are not a bot

The cloud bot cannot use browser cookies or access login-only media. Use a permitted public source. The project does not implement password login or CAPTCHA bypass.

## YouTube download returns HTTP 403

The Container first uses yt-dlp's normal public client. If YouTube rejects that
stream with HTTP 403, it makes one isolated retry with the token-free
`web_embedded` client. The retry writes into a separate job subdirectory so it
cannot resume or reuse an incompatible partial file from the first attempt.

Search the structured logs by job ID for `download_fallback_attempt`. A failed
retry is reported with bounded fields such as `error_stage=download_process`,
`failure_reason=http_forbidden`, process exit code, and timeout state. Raw
yt-dlp output, URLs, Telegram identifiers, filenames, and tokens are not logged.
The fallback only supports videos that YouTube permits embedded clients to
access; it does not bypass private, login-only, CAPTCHA, DRM, or non-embeddable
restrictions.

## Instagram requires authentication

Private or login-only posts are unavailable to the cloud bot. Use a permitted public post; do not copy cookies into Cloudflare.

## TikTok media unavailable

TikTok links, including `vm.tiktok.com` and `vt.tiktok.com` short links, are
handled by yt-dlp like other sources. A TikTok response that explicitly
requires login is reported as sign-in-required rather than source-unavailable. The cloud bot does
not add cookies or bypass private, login-only, age-gated, DRM, or CAPTCHA
controls.

## X media unavailable

The post may be deleted, protected, login-only, rate-limited, or missing downloadable media. The bot does not bypass those controls. Try a permitted public source or retry later.

## Telegram file too large

The hosted Bot API limit is kept at a conservative 49,000,000 bytes. The Container tries lower resolution or transcoding, then writes a private R2 object and sends an expiring link. Verify `MEDIA_BUCKET`, `PUBLIC_WORKER_BASE_URL`, `DOWNLOAD_LINK_HMAC_SECRET`, and the bucket lifecycle.

## Telegram 429

Respect Telegram's returned `retry_after`. Download/probe stages may retry with backoff; a final upload with an ambiguous response is not blindly repeated. Check job status before issuing another request.

## Cloudflare Container cold start

The named Container sleeps after roughly five idle minutes. The first job after sleep can be slower. Check:

```bash
pnpm --dir apps/cloudflare-worker exec wrangler tail
curl --fail --silent --show-error "<PUBLIC_WORKER_BASE_URL>/health"
```

## Cloudflare Container timeout

Inspect safe structured logs for the job ID and stage. Confirm the selected `standard-1` capacity, source and FFmpeg timeouts, media duration, source-size limit, and temporary disk use. Do not increase every limit blindly.

## R2 link expired

Links expire after one hour by default and cannot be renewed from the old token. Send the source URL again if permitted. An expired token must return an error even while the object awaits its retention cleanup.

## Wrong Telegram user ID

Before setting a webhook, send `/start` to the bot and run these commands in bash:

```bash
read -r -s -p "Bot token: " TELEGRAM_BOT_TOKEN; export TELEGRAM_BOT_TOKEN; printf '\n'
pnpm exec tsx scripts/show-telegram-user-id.ts
unset TELEGRAM_BOT_TOKEN
```

`ALLOWED_TELEGRAM_USER_IDS` must contain exactly two distinct numeric Telegram user IDs, separated by a comma. Any other value disables the bot. Store the value, then redeploy. Telegram usernames are not accepted as identities.

## Invalid webhook secret

Rotate and set the same secret in Cloudflare and Telegram without printing it. Run these commands in bash:

```bash
cd apps/cloudflare-worker
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
cd ../..
read -r -s -p "Bot token: " TELEGRAM_BOT_TOKEN; export TELEGRAM_BOT_TOKEN; printf '\n'
read -r -s -p "Webhook secret: " TELEGRAM_WEBHOOK_SECRET; export TELEGRAM_WEBHOOK_SECRET; printf '\n'
export PUBLIC_WORKER_BASE_URL="https://<YOUR_WORKER_HOSTNAME>"
pnpm exec tsx scripts/set-telegram-webhook.ts
unset TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET
```

Use a URL-safe secret of 16–256 characters. Do not paste it into issue reports or logs.
