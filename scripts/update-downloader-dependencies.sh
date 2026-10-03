#!/usr/bin/env bash
set -euo pipefail

live=0
deno_version=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --deploy)
      printf '%s\n' '--deploy was removed. Verify locally here, then release it separately.' >&2
      exit 2
      ;;
    --live)
      live=1
      shift
      ;;
    --deno-version)
      if [[ "$#" -lt 2 ]]; then
        printf '%s\n' '--deno-version requires X.Y.Z' >&2
        exit 2
      fi
      deno_version="$2"
      shift 2
      ;;
    *)
      printf 'Usage: %s [--deno-version X.Y.Z] [--live]\n' "$0" >&2
      exit 2
      ;;
  esac
done

container_dir="$(cd "$(dirname "$0")/../apps/downloader-container" && pwd)"

if [[ "$live" -eq 1 && ( -z "${LIVE_YOUTUBE_URL:-}" || -z "${LIVE_SECONDARY_URL:-}" ) ]]; then
  printf '%s\n' '--live requires LIVE_YOUTUBE_URL and LIVE_SECONDARY_URL.' >&2
  exit 2
fi

if [[ -n "$deno_version" ]]; then
  if [[ ! "$deno_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s\n' 'Deno version must be numeric X.Y.Z.' >&2
    exit 2
  fi
  dockerfile="$container_dir/Dockerfile"
  update_file="$(mktemp "$container_dir/.Dockerfile.update.XXXXXX")"
  cleanup_update() { rm -f "$update_file"; }
  trap cleanup_update EXIT
  awk -v version="$deno_version" '{
    sub(/denoland\/deno:bin-[0-9][0-9.]*/, "denoland/deno:bin-" version)
    print
  }' "$dockerfile" > "$update_file"
  chmod 0644 "$update_file"
  mv "$update_file" "$dockerfile"
  trap - EXIT
  if ! grep -Fq "denoland/deno:bin-${deno_version} AS deno" "$dockerfile"; then
    printf '%s\n' 'Deno Dockerfile tag update did not match the expected FROM line.' >&2
    exit 1
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  printf 'uv is required to update the deterministic Python lock. See https://docs.astral.sh/uv/.\n' >&2
  exit 1
fi

cd "$container_dir"
uv lock --upgrade-package yt-dlp --upgrade-package yt-dlp-ejs
uv sync --frozen --all-groups
uv run ruff check .
uv run mypy src
uv run pytest
docker build --platform linux/amd64 --tag private-media-downloader:verify .

container_id="$(docker run --detach --rm --platform linux/amd64 --publish 127.0.0.1::8080 private-media-downloader:verify)"
cleanup() { docker stop "$container_id" >/dev/null 2>&1 || true; }
trap cleanup EXIT
host_port="$(docker port "$container_id" 8080/tcp | awk -F: 'NR==1 {print $NF}')"
curl --fail --silent --show-error --retry 15 --retry-delay 1 --retry-connrefused "http://127.0.0.1:${host_port}/health" >/dev/null

if [[ "$live" -eq 1 ]]; then
  # The production image deliberately omits the dev/test group. Run the
  # opt-in probes inside the freshly built image instead of exercising the
  # host virtualenv: this verifies the image's pinned yt-dlp, EJS, Deno and
  # FFmpeg paths after every dependency update.
  docker run --rm --platform linux/amd64 \
    --env LIVE_YOUTUBE_URL="$LIVE_YOUTUBE_URL" \
    --env LIVE_SECONDARY_URL="$LIVE_SECONDARY_URL" \
    --env RUN_LIVE_MEDIA_TESTS=1 \
    private-media-downloader:verify \
    python -c '
import asyncio
import os
import tempfile
from pathlib import Path

from downloader_container.config import Settings
from downloader_container.probe import build_probe_args, probe_media
from downloader_container.security import validate_source_url

async def main() -> None:
    settings = Settings.from_env()
    settings.max_retries = 0
    settings.probe_timeout_seconds = min(settings.probe_timeout_seconds, 90)
    runtime_path = settings.deno_path
    assert Path(runtime_path).is_absolute()
    assert Path(runtime_path).name == "deno"
    urls = (os.environ["LIVE_YOUTUBE_URL"], os.environ["LIVE_SECONDARY_URL"])
    with tempfile.TemporaryDirectory(prefix="live-smoke-") as directory:
        for source_url in urls:
            validated = validate_source_url(
                source_url,
                allowed_hosts=settings.effective_allowed_source_hosts,
                resolve_dns=settings.resolve_source_dns,
                max_length=settings.max_url_length,
            )
            args = build_probe_args(settings, validated.normalized, "deno", runtime_path)
            assert args[args.index("--js-runtimes") + 1] == f"deno:{runtime_path}"
            probe = await probe_media(
                settings,
                validated.normalized,
                "deno",
                runtime_path,
                cwd=Path(directory),
            )
            assert probe.id
            assert probe.formats

asyncio.run(main())
'
fi

printf 'Verified locally. Review the diff, then release it separately.\n'
