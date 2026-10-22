# shellcheck shell=bash
# Source from other scripts:  source "$ROOT/scripts/electron-mirror-env.sh"
#
# pnpm does NOT forward custom .npmrc keys (e.g. electron_mirror) into lifecycle
# script env, so Electron's postinstall keeps hitting GitHub unless ELECTRON_MIRROR
# is set in the process environment before `pnpm install` / rebuild.
#
# Trailing slash required by @electron/get path join.
ELECTRON_MIRROR_BACKUP="${ELECTRON_MIRROR_BACKUP:-https://npmmirror.com/mirrors/electron/}"

if [[ -z "${ELECTRON_MIRROR+x}" ]]; then
  export ELECTRON_MIRROR="$ELECTRON_MIRROR_BACKUP"
fi
