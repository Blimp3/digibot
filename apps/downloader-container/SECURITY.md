# Container security boundary

This service is private infrastructure. Put it behind the Cloudflare Worker
Container binding and do not publish a direct Container URL. Require a long,
random `INTERNAL_CONTAINER_SECRET`; the service compares it with
`hmac.compare_digest` and accepts no user-controlled command options.

Source URLs are limited to HTTP/HTTPS, reject credentials and control
characters, normalize IDNA hostnames, enforce the configured exact initial-host
allowlist, and resolve DNS before yt-dlp. An allowed apex does not implicitly
authorize its subdomains, and extractor-internal CDN/media hosts are not input
allowlist entries. Loopback, private, reserved, multicast,
link-local, and cloud metadata addresses are rejected. The application never
follows a source redirect itself; supported-site redirects remain inside the
pinned yt-dlp networking/extractor layer and its finite redirect handling.

Every child process is created with an argv array, `shell=False` semantics, a
new process group, an absolute request deadline, and SIGTERM/SIGKILL cleanup
that includes descendants after the leader exits. Each job gets a
unique `/tmp/media-jobs/JOB_ID/` directory. Failed preparation is removed
immediately. A verified artifact is intentionally retained for the separate
delivery call, removed after confirmed delivery or terminal delivery failure,
and swept by startup stale cleanup if execution is interrupted. Output paths are checked against that directory
and final media is validated by FFprobe rather than its extension.

R2 uploads use the remaining job budget for botocore connect/read timeouts and
disable SDK retries. The synchronous SDK call runs in a shielded worker thread;
the application cannot forcibly stop that thread, so a timeout or cancellation
drains it before releasing the active-job claim or cleaning its workspace.

Logs are JSON and contain only job identifiers, source hostname, stage events,
state, durations, sizes, retry counts, and stable error codes. They never contain
Telegram URLs/tokens, complete source URLs, cookies, credentials, file content,
or raw process output. R2 is private; link tokens are HMAC signed and include
only an object key, sanitized filename, and expiration.

Do not use this service to bypass DRM, paywalls, CAPTCHA, account controls, or
access restrictions. Do not add cookies or private media credentials to the
Container.

No direct-media resolver ships in this edition; yt-dlp handles every source.
The retained direct-URL delivery path accepts only HTTPS URLs on approved
TikTok CDN suffixes or the exact `video.twimg.com` host. It requires a known size within Telegram's URL-fetch
limit and H.264 MP4 metadata. The short-lived provider URL is stored only in a
mode-0600 retained job manifest, validated again immediately before delivery,
and deleted with the job workspace. It is never included in Worker step output,
delivery requests, logs, captions, or errors.

Outbound Telegram and R2 storage origins must be HTTPS origins without
credentials, paths, query strings, or fragments. Plain HTTP is accepted only
for explicit loopback local development endpoints. `PUBLIC_WORKER_BASE_URL` is
always HTTPS because it is embedded in signed links; it is normalized to the
origin before signed paths are appended.
