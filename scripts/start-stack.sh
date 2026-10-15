#!/usr/bin/env bash
# Start Hermes gateway + Managed Agent daemon + Agorax UI.
#
# Usage:
#   scripts/start-stack.sh prod   # production UI (node server-entry.js) — used by `pnpm start`
#   scripts/start-stack.sh dev    # Vite UI — used by `pnpm dev`
#
# Gateway is skipped when already running. Daemon is idempotent (:8788 /health).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-prod}"
export PATH="$HOME/.local/bin:$HOME/.local/go1.24.5/bin:$HOME/go/bin:/usr/local/go/bin:${PATH:-}"

case "$MODE" in
  prod)
    UI_CMD='node server-entry.js'
    ;;
  dev)
    UI_CMD='pnpm dev:ui'
    ;;
  *)
    echo "usage: $0 <prod|dev>" >&2
    exit 2
    ;;
esac

# Defaults for the UI process (shell exports still win).
UI_ENV="AGORAX_MANAGED_AGENT_URL=${AGORAX_MANAGED_AGENT_URL:-http://127.0.0.1:8788}"
UI_ENV+=" AGORAX_WORKSPACE_ID=${AGORAX_WORKSPACE_ID:-default}"
UI_ENV+=" PORT=${PORT:-6734}"

GATEWAY_CMD='pgrep -f "[h]ermes gateway" >/dev/null 2>&1 && echo "hermes gateway already running — skipping" || hermes gateway run'

exec pnpm exec concurrently \
  --names gateway,ui,daemon \
  --prefix-colors blue,green,magenta \
  "$GATEWAY_CMD" \
  "$UI_ENV $UI_CMD" \
  "pnpm dev:managed-agent"
