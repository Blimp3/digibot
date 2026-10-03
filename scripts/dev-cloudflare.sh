#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/cloudflare-worker"
pnpm exec wrangler dev
