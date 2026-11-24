#!/usr/bin/env bash
# Start agorax-agentd for local Agorax development.
#
# Idempotent (safe under `pnpm dev:ui` restarts):
#   - /health OK            → skip
#   - our process on :PORT  → skip (do not kill; avoids bind races)
#   - foreign process       → fail with a clear message
#   - port free             → start
# Pass --force (or AGORAX_MANAGED_AGENT_REPLACE=1) to replace a stale
# agorax-agentd that is holding the port without answering /health.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${AGORAX_MANAGED_AGENT_PORT:-8788}"
HOST="${AGORAX_MANAGED_AGENT_HOST:-127.0.0.1}"
HEALTH_URL="http://${HOST}:${PORT}/health"
DB_PATH="${AGORAX_AGENT_DB_PATH:-$ROOT/.agorax/agent.db}"
FORCE=0
REPLACE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --replace-only) FORCE=1; REPLACE_ONLY=1 ;;
  esac
done
if [[ "${AGORAX_MANAGED_AGENT_REPLACE:-}" == "1" ]]; then
  FORCE=1
fi

mkdir -p "$ROOT/.agorax"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-dotenv-file.sh"
# Repo .env first, then ~/.hermes/.env for provider keys (Codex tokenx
# env_key=TOKENX_API_KEY_VPEL, etc.). Existing process env wins.
agorax_load_dotenv_file "$ROOT/.env"
agorax_load_dotenv_file "${HERMES_HOME:-$HOME/.hermes}/.env"

health_ok() {
  curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1
}

# Pre-bridge binaries still pass /health. GET on the POST-only hermes-bridge
# route returns 405 when registered, 404 when the binary is too old.
hermes_bridge_ok() {
  local code
  code=$(
    curl -sS -o /dev/null -w '%{http_code}' --max-time 1 -X GET \
      "http://${HOST}:${PORT}/v1/workspaces/hermes%3Adefault/hermes-bridge/sessions/_probe_/activity" \
      2>/dev/null || echo 000
  )
  [[ "$code" == "405" ]]
}

daemon_ready() {
  health_ok && hermes_bridge_ok
}

listener_pids() {
  if command -v ss >/dev/null 2>&1; then
    # Prefer numeric output; fall back to parsing the process column.
    ss -ltnp 2>/dev/null | awk -v port=":${PORT}" '
      index($4, port) || index($4, "*:" port) || index($4, "0.0.0.0:" port) || index($4, "[::]:" port) {
        while (match($0, /pid=[0-9]+/)) {
          print substr($0, RSTART + 4, RLENGTH - 4)
          $0 = substr($0, RSTART + RLENGTH)
        }
      }' | sort -u
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
  fi
}

is_agorax_agentd_pid() {
  local pid=$1
  local cmd
  cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
  [[ -n "$cmd" ]] || return 1
  case "$cmd" in
    *agorax-agentd* | *packages/agent/daemon/cmd/agorax-agentd* | *cmd/agorax-agentd*)
      return 0
      ;;
  esac
  return 1
}

free_stale_listeners() {
  local pid
  local freed=0
  for pid in $(listener_pids); do
    if is_agorax_agentd_pid "$pid"; then
      echo "dev:managed-agent: replacing stale agorax-agentd pid=$pid on :${PORT}"
      kill "$pid" 2>/dev/null || true
      freed=1
    else
      echo "dev:managed-agent: :${PORT} held by non-agorax pid=$pid — $(ps -p "$pid" -o args= 2>/dev/null || echo unknown)" >&2
      echo "dev:managed-agent: refuse to kill foreign process; free the port or set AGORAX_MANAGED_AGENT_PORT" >&2
      exit 1
    fi
  done
  if [[ "$freed" -eq 1 ]]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [[ -z "$(listener_pids)" ]]; then
        return 0
      fi
      sleep 0.2
    done
    echo "dev:managed-agent: port :${PORT} still busy after killing stale daemon" >&2
    exit 1
  fi
}

if [[ "$FORCE" -ne 1 ]] && daemon_ready; then
  echo "dev:managed-agent: healthy daemon (with hermes-bridge) already on ${HEALTH_URL} — skipping"
  exit 0
fi

if [[ "$FORCE" -ne 1 ]] && health_ok && ! hermes_bridge_ok; then
  echo "dev:managed-agent: ${HEALTH_URL} ok but hermes-bridge missing — replacing stale daemon"
  FORCE=1
fi

existing="$(listener_pids)"
if [[ -n "$existing" ]]; then
  ours=0
  foreign=0
  for pid in $existing; do
    if is_agorax_agentd_pid "$pid"; then
      ours=1
    else
      foreign=1
    fi
  done
  if [[ "$foreign" -eq 1 ]]; then
    echo "dev:managed-agent: :${PORT} held by a non-agorax process — $(ps -p $(echo "$existing" | tr '\n' ',' | sed 's/,$//') -o pid=,args= 2>/dev/null || true)" >&2
    exit 1
  fi
  if [[ "$ours" -eq 1 && "$FORCE" -ne 1 ]]; then
    if health_ok; then
      echo "dev:managed-agent: agorax-agentd already listening on :${PORT} — skipping"
    else
      echo "dev:managed-agent: agorax-agentd already listening on :${PORT} (health not ready yet) — skipping"
      echo "dev:managed-agent: pass --force to replace it"
    fi
    exit 0
  fi
  if [[ "$FORCE" -eq 1 ]]; then
    free_stale_listeners
  fi
fi

if [[ "$REPLACE_ONLY" -eq 1 ]]; then
  echo "dev:managed-agent: listeners on :${PORT} cleared (--replace-only)"
  exit 0
fi

export AGORAX_MANAGED_AGENT_HOST="$HOST"
export AGORAX_MANAGED_AGENT_PORT="$PORT"
export AGORAX_AGENT_DB_PATH="$DB_PATH"

# Prefer a prebuilt binary when present — avoids multi-minute go run module fetches.
BIN="$ROOT/.agorax/agorax-agentd"
if [[ -x "$BIN" ]]; then
  echo "dev:managed-agent: starting $BIN on ${HOST}:${PORT} (db=$DB_PATH)"
  exec "$BIN"
fi

# shellcheck disable=SC1091
source "$ROOT/scripts/ensure-go.sh"
agorax_ensure_go

cd "$ROOT/agorax-agent-daemon"
echo "dev:managed-agent: starting agorax-agentd on ${HOST}:${PORT} (db=$DB_PATH)"
exec go run ./packages/agent/daemon/cmd/agorax-agentd
