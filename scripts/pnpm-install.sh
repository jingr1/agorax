#!/usr/bin/env bash
# pnpm install with ELECTRON_MIRROR set (required — pnpm ignores .npmrc electron_mirror).
#
# Usage:
#   scripts/pnpm-install.sh [pnpm-install-args...]
#   ELECTRON_MIRROR=https://custom/mirror/ scripts/pnpm-install.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/electron-mirror-env.sh"
echo "Electron binary mirror: $ELECTRON_MIRROR" >&2

exec pnpm install "$@"
