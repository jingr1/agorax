#!/usr/bin/env bash
# Start agorax managed-agent daemon on the host network (not Cursor sandbox).
#
# Prefer a prebuilt binary; keep newly started daemons in the foreground.
# A healthy daemon that matches the on-disk binary is left alone; a newer
# install (or foreign checkout binary) on :PORT is replaced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${AGORAX_AGENT_LOG:-/tmp/agorax-daemon.log}"
PORT="${AGORAX_MANAGED_AGENT_PORT:-8788}"
DB_PATH="${AGORAX_AGENT_DB_PATH:-$ROOT/.agorax/agent.db}"
BIN="$ROOT/.agorax/agorax-agentd"
export AGORAX_MANAGED_AGENT_PORT="$PORT"
export AGORAX_AGENT_DB_PATH="$DB_PATH"

mkdir -p "$ROOT/.agorax"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-dotenv-file.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/managed-agent-daemon-lib.sh"
# Prebuilt-binary path used to skip dotenv entirely — Codex then failed with
# Missing environment variable: ACME_API_KEY_PRIMARY (key lives in ~/.hermes/.env).
agorax_load_dotenv_file "$ROOT/.env"
agorax_load_dotenv_file "${HERMES_HOME:-$HOME/.hermes}/.env"

# If something already answers /health, leave it alone unless --force.
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

health_ok() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null |
    node -e 'let text="";process.stdin.on("data",data=>text+=data);process.stdin.on("end",()=>{try{const health=JSON.parse(text);process.exit(health.ok===true&&health.runtime==="agorax-managed-agent"?0:1)}catch{process.exit(1)}})'
}

# Hermes 1:1 display SoT requires hermes-bridge. A pre-bridge binary can still
# answer /health; treat missing route as stale so pnpm dev does not skip forever.
hermes_bridge_ok() {
  local code
  code=$(
    curl -sS -o /dev/null -w '%{http_code}' --max-time 1 -X GET \
      "http://127.0.0.1:${PORT}/v1/workspaces/hermes%3Adefault/hermes-bridge/sessions/_probe_/activity" \
      2>/dev/null || echo 000
  )
  # POST-only route → 405 when present; 404 when the binary never registered it.
  [[ "$code" == "405" ]]
}

daemon_ready() {
  health_ok && hermes_bridge_ok
}

if [[ "$FORCE" -ne 1 ]] && daemon_ready && agorax_managed_agent_binary_stale "$BIN" "$PORT"; then
  echo "managed-agent-host: :${PORT} healthy but on-disk $BIN is newer (or path mismatch) — replacing"
  FORCE=1
fi

if [[ "$FORCE" -ne 1 ]] && daemon_ready; then
  echo "managed-agent-host: healthy daemon (with hermes-bridge) already on :${PORT} — skipping"
  exit 0
fi

if [[ "$FORCE" -ne 1 ]] && health_ok && ! hermes_bridge_ok; then
  echo "managed-agent-host: :${PORT} answers /health but lacks hermes-bridge — replacing stale daemon"
  FORCE=1
fi

if [[ "$FORCE" -eq 1 ]]; then
  # Replace listeners via the shared helper, then prefer the prebuilt binary
  # (go run can hang on module download and leave :PORT empty for minutes).
  bash "$ROOT/scripts/dev-managed-agent.sh" --force --replace-only
  if [[ -x "$BIN" ]]; then
    echo "managed-agent-host: starting $BIN on :${PORT} (log=$LOG)"
    exec "$BIN"
  fi
  exec bash "$ROOT/scripts/dev-managed-agent.sh" --force
fi

if [[ -x "$BIN" ]]; then
  echo "managed-agent-host: starting $BIN on :${PORT} (log=$LOG)"
  exec "$BIN"
fi

echo "managed-agent-host: no prebuilt binary at $BIN — falling back to go run"
# shellcheck disable=SC1091
source "$ROOT/scripts/ensure-go.sh"
agorax_ensure_go
exec bash "$ROOT/scripts/dev-managed-agent.sh"
