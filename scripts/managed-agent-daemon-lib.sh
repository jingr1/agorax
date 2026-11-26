#!/usr/bin/env bash
# Shared helpers for managed-agent start/replace scripts.
# Sourced by start-managed-agent-host.sh and dev-managed-agent.sh.

agorax_managed_agent_listener_pids() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v port=":${port}" '
      index($4, port) || index($4, "*:" port) || index($4, "0.0.0.0:" port) || index($4, "[::]:" port) {
        while (match($0, /pid=[0-9]+/)) {
          print substr($0, RSTART + 4, RLENGTH - 4)
          $0 = substr($0, RSTART + RLENGTH)
        }
      }' | sort -u
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
  fi
}

agorax_is_agorax_agentd_pid() {
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

# True when a prebuilt binary on disk is newer than an agorax-agentd listener
# on $port (binary replaced after the process started), or the listener was
# started from a different path than $bin. Detection failures → false (leave
# a healthy daemon alone).
agorax_managed_agent_binary_stale() {
  local bin=$1
  local port=$2
  [[ -x "$bin" ]] || return 1

  local bin_mtime
  bin_mtime=$(stat -c %Y "$bin" 2>/dev/null || stat -f %m "$bin" 2>/dev/null || true)
  [[ -n "$bin_mtime" ]] || return 1

  local bin_real
  bin_real=$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")

  local pid cmd proc_start exe_path
  local stale=0
  for pid in $(agorax_managed_agent_listener_pids "$port"); do
    if ! agorax_is_agorax_agentd_pid "$pid"; then
      continue
    fi
    proc_start=$(stat -c %Y "/proc/$pid" 2>/dev/null || true)
    if [[ -n "$proc_start" ]] && [[ "$bin_mtime" -gt "$proc_start" ]]; then
      stale=1
      break
    fi
    cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
    # Path mismatch: another checkout's binary is holding our port.
    case "$cmd" in
      "$bin_real"|"$bin_real "*) ;;
      *agorax-agentd*)
        exe_path=${cmd%% *}
        if [[ -n "$exe_path" && "$exe_path" != "$bin" && "$exe_path" != "$bin_real" ]]; then
          stale=1
          break
        fi
        ;;
    esac
    # Replaced-in-place / renamed-away binary still mapped by the old process.
    if command -v readlink >/dev/null 2>&1; then
      exe_path=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
      case "$exe_path" in
        *'(deleted)'*)
          stale=1
          break
          ;;
      esac
    fi
  done
  [[ "$stale" -eq 1 ]]
}
