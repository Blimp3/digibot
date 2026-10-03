# Development guide

Reference for working on the DigiBot codebase. Using the Telegram bot requires none of this setup. A deployed instance runs entirely on Cloudflare.

## Workspace

- `apps/cloudflare-worker/`: Telegram webhook, Workflows, Mini App, D1 and R2 integration.
- `apps/downloader-container/`: Python media processing and production image.
- `scripts/`: development, verification and maintenance commands.

Use Node.js 22.22.2 or newer, the pnpm version pinned in `package.json`, Python 3.12 and uv. Docker with `linux/amd64` support is needed for image checks and local Container development.

## Install the workspace

```bash
pnpm install --frozen-lockfile
```

For Python development:

```bash
cd apps/downloader-container
uv sync --frozen --all-groups
cd ../..
```

## Local Cloudflare development

Copy the placeholder development file and replace values only in the ignored copy:

```bash
cp apps/cloudflare-worker/.dev.vars.example apps/cloudflare-worker/.dev.vars
pnpm --dir apps/cloudflare-worker exec wrangler d1 migrations apply DB --local
./scripts/dev-cloudflare.sh
```

Docker must be running for the Container binding. Development secrets must be non-production values. Never commit `.dev.vars`.

## Build and test

The full local gate, matching CI's TypeScript and Python jobs:

```bash
pnpm check && pnpm check:py
```

`pnpm check` runs lint, typecheck (including `wrangler types --check`), tests, the Wrangler dry-run build and the secret scan. `pnpm check:py` syncs the locked Python environment and runs Ruff, mypy, pytest and `tools/test_asr_eval.py`. The individual steps:

TypeScript checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Python checks:

```bash
cd apps/downloader-container
uv sync --frozen --all-groups
uv run ruff check .
uv run mypy src
uv run pytest
uv run python ../../tools/test_asr_eval.py
cd ../..
```

Build the production architecture:

```bash
docker build --platform linux/amd64 --tag private-media-downloader:local apps/downloader-container
```

Normal CI fakes yt-dlp, FFmpeg, Telegram and R2 and never contacts media sites or uses account cookies. Opt-in live tests require user-provided public test URLs:

```bash
cd apps/downloader-container
RUN_LIVE_MEDIA_TESTS=1 \
LIVE_YOUTUBE_URL="<PUBLIC_TEST_URL>" \
LIVE_SECONDARY_URL="<PUBLIC_TIKTOK_INSTAGRAM_OR_X_TEST_URL>" \
uv run pytest -m live
```

## Update yt-dlp safely

Do not run remote EJS downloads inside a media job. The image installs yt-dlp's pinned default dependencies and EJS during build. To update:

```bash
./scripts/update-downloader-dependencies.sh
./scripts/update-downloader-dependencies.sh --deno-version "<REVIEWED_X.Y.Z>"
git diff -- apps/downloader-container/pyproject.toml apps/downloader-container/uv.lock apps/downloader-container/Dockerfile
```

The lock file pins the resolved yt-dlp and matching EJS versions even though `pyproject.toml` permits a reviewed newer yt-dlp. The script upgrades that lock, optionally updates the pinned Deno image tag, runs Ruff, mypy, pytest, builds linux/amd64, and checks Container health. Its opt-in live probes run inside that newly built image. It does not deploy. After reviewing versions and release notes, opt in explicitly:

```bash
./scripts/update-downloader-dependencies.sh --live
```

Use `--live` only after setting both `LIVE_YOUTUBE_URL` and `LIVE_SECONDARY_URL` to public, permitted test items. The updater stops after local verification; release separately.

## CI and dependency policy

- Pull requests run TypeScript lint/type/test/build, Python lint/type/test, linux/amd64 image build, dependency audit, and secret scanning. None of these jobs needs a repository secret.
- This snapshot has no deployment workflow. Deploy with Wrangler from your own Cloudflare account; see the [Worker README](../apps/cloudflare-worker/README.md).
