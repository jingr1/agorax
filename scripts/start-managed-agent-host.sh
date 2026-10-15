#!/usr/bin/env bash
# Start agorax managed-agent daemon on the host network (not Cursor sandbox).
#
# Prefer a prebuilt binary under .agorax/ (fast, durable). Fall back to
# scripts/dev-managed-agent.sh --force (go run). Always detach so
# `pnpm dev:ui`'s concurrently task can exit without killing the daemon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${AGORAX_AGENT_LOG:-/tmp/agorax-daemon.log}"
PORT="${AGORAX_MANAGED_AGENT_PORT:-8788}"
DB_PATH="${AGORAX_AGENT_DB_PATH:-$ROOT/.agorax/agent.db}"
BIN="$ROOT/.agorax/agorax-agentd"
export PATH="$HOME/.local/go1.24.5/bin:$HOME/go/bin:/usr/local/go/bin:${PATH:-}"
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
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

if [[ "$FORCE" -ne 1 ]] && health_ok; then
  echo "managed-agent-host: healthy daemon already on :${PORT} — skipping"
  exit 0
fi

# Best-effort free our own stale listeners before relaunch.
if command -v ss >/dev/null 2>&1; then
  for pid in $(ss -ltnp 2>/dev/null | awk -v port=":${PORT}" '
    index($4, port) {
      while (match($0, /pid=[0-9]+/)) {
        print substr($0, RSTART + 4, RLENGTH - 4)
        $0 = substr($0, RSTART + RLENGTH)
      }
    }' | sort -u); do
    cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
    case "$cmd" in
      *agorax-agentd* | *packages/agent/daemon/cmd/agorax-agentd* | *cmd/agorax-agentd*)
        echo "managed-agent-host: replacing stale pid=$pid"
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done
  sleep 0.4
fi

if [[ -x "$BIN" ]]; then
  echo "managed-agent-host: starting $BIN on :${PORT} (log=$LOG)"
  nohup "$BIN" >>"$LOG" 2>&1 &
  echo "started pid=$! log=$LOG"
  exit 0
fi

echo "managed-agent-host: no prebuilt binary at $BIN — falling back to go run"
nohup bash "$ROOT/scripts/dev-managed-agent.sh" --force >>"$LOG" 2>&1 &
echo "started pid=$! log=$LOG"
