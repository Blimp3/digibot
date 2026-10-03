#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"

patterns=(
  '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'
  '[0-9]{6,12}:[A-Za-z0-9_-]{30,}'
  'gh[opurs]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{50,}'
  'sk_live_[A-Za-z0-9]{20,}'
  'AKIA[0-9A-Z]{16}'
)

pattern_args=()
for pattern in "${patterns[@]}"; do
  pattern_args+=(-e "$pattern")
done

# Tracked plus untracked files, .gitignore respected. No -I: a path marked
# binary in .gitattributes would otherwise be skipped silently, whereas a
# "Binary file ... matches" line still exits 0. git grep exits 0 on a match
# and 1 on none; anything on stderr (an unreadable file, no repository) means
# a file was not scanned, so that fails too even when the status is 1.
errors="$(mktemp)"
trap 'rm -f "$errors"' EXIT
status=0
git grep -nE --untracked "${pattern_args[@]}" -- . \
  ':!pnpm-lock.yaml' ':!apps/downloader-container/uv.lock' ':!scripts/scan-secrets.sh' 2>"$errors" || status=$?

if [[ -s "$errors" || "$status" -gt 1 ]]; then
  cat "$errors" >&2
  printf 'Secret scan could not run: git grep exited with status %s.\n' "$status" >&2
  exit 2
fi
if [[ "$status" -eq 0 ]]; then
  printf 'Potential secret material found. Remove or replace it before committing.\n' >&2
  exit 1
fi
printf 'No high-confidence secret patterns found in tracked and untracked files.\n'
