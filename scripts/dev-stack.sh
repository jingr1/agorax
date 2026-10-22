#!/usr/bin/env bash
# Export Electron CDN backup, ensure the binary is present, then start the stack.
# Used by `pnpm dev` / `pnpm start` so install runs with ELECTRON_MIRROR set
# (pnpm's verifyDepsBeforeRun cannot see .npmrc electron_mirror — see electron-mirror-env.sh).
#
# Usage: scripts/dev-stack.sh <dev|prod>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/electron-mirror-env.sh"

electron_dist_ready() {
  local dir
  shopt -s nullglob
  for dir in "$ROOT"/node_modules/.pnpm/electron@*/node_modules/electron; do
    if [[ -e "$dir/dist/electron" || -e "$dir/dist/Electron.app" || -e "$dir/dist/electron.exe" ]]; then
      return 0
    fi
  done
  return 1
}

if ! electron_dist_ready; then
  echo "Electron binary missing — pnpm install with mirror: $ELECTRON_MIRROR" >&2
  pnpm install
fi

exec bash "$ROOT/scripts/start-stack.sh" "${1:-dev}"
