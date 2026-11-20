#!/usr/bin/env bash
# Start agorax managed-agent daemon on the host network (not Cursor sandbox).
#
# Prefer a prebuilt binary; keep newly started daemons in the foreground.
# A validated existing daemon is external and is never stopped by this script.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${AGORAX_AGENT_LOG:-/tmp/agorax-daemon.log}"
PORT="${AGORAX_MANAGED_AGENT_PORT:-8788}"
DB_PATH="${AGORAX_AGENT_DB_PATH:-$ROOT/.agorax/agent.db}"
BIN="$ROOT/.agorax/agorax-agentd"
export AGORAX_MANAGED_AGENT_PORT="$PORT"
export AGORAX_AGENT_DB_PATH="$DB_PATH"

mkdir -p "$ROOT/.agorax"

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

if [[ "$FORCE" -ne 1 ]] && health_ok; then
  echo "managed-agent-host: healthy daemon already on :${PORT} — skipping"
  exit 0
fi

if [[ "$FORCE" -eq 1 ]]; then
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
