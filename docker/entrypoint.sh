#!/bin/bash
set -e

WORKSPACE_USER=workspace
WORKSPACE_GROUP=workspace
WORKSPACE_HOME="$(getent passwd "$WORKSPACE_USER" | cut -d: -f6)"
TARGET_UID="${HERMES_UID:-}"
TARGET_GID="${HERMES_GID:-}"

fix_owner_if_needed() {
  local path="$1"
  if [ ! -e "$path" ]; then
    return
  fi

  local actual_uid
  actual_uid=$(id -u "$WORKSPACE_USER")
  local current_uid
  current_uid=$(stat -c %u "$path" 2>/dev/null || true)
  if [ -n "$current_uid" ] && [ "$current_uid" != "$actual_uid" ]; then
    chown -R "$WORKSPACE_USER:$WORKSPACE_GROUP" "$path" 2>/dev/null || \
      echo "Warning: chown failed for $path (rootless container or restricted mount?) — continuing anyway"
  fi
}

if [ "$(id -u)" = "0" ]; then
  current_uid=$(id -u "$WORKSPACE_USER")
  current_gid=$(id -g "$WORKSPACE_USER")

  if [ -n "$TARGET_GID" ] && [ "$TARGET_GID" != "$current_gid" ]; then
    echo "Changing workspace GID to $TARGET_GID"
    groupmod -o -g "$TARGET_GID" "$WORKSPACE_GROUP" 2>/dev/null || true
  fi

  if [ -n "$TARGET_UID" ] && [ "$TARGET_UID" != "$current_uid" ]; then
    echo "Changing workspace UID to $TARGET_UID"
    usermod -o -u "$TARGET_UID" "$WORKSPACE_USER"
  fi

  # Create state dirs as root, then always chown the *data* paths — not only
  # when $WORKSPACE_HOME itself is mis-owned. useradd -m leaves the home
  # directory owned by workspace, so fix_owner_if_needed(home) would skip and
  # leave a root-owned .hermes behind. collab.db then fails with SQLITE_CANTOPEN
  # after we drop privileges (CI smoke / bare docker run without a volume).
  mkdir -p "$WORKSPACE_HOME/.hermes" /workspace
  chown -R "$WORKSPACE_USER:$WORKSPACE_GROUP" \
    "$WORKSPACE_HOME/.hermes" /workspace 2>/dev/null || \
    echo "Warning: chown failed for .hermes|/workspace — continuing anyway"
  fix_owner_if_needed "$WORKSPACE_HOME"
  fix_owner_if_needed /workspace

  echo "Dropping root privileges"
  exec gosu "$WORKSPACE_USER:$WORKSPACE_GROUP" "$0" "$@"
fi

exec "$@"
