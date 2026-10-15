#!/usr/bin/env bash
# Manage the clean release worktree (build + start only — no WIP source).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE="${HERMES_RELEASE_DIR:-$ROOT/../agorax-release}"
CMD="${1:-help}"

case "$CMD" in
  sync)
    COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
    echo "[release] syncing worktree to committed HEAD $COMMIT"
    git -C "$RELEASE" fetch origin 2>/dev/null || true
    git -C "$RELEASE" checkout --detach "$COMMIT"
    ;;
  build)
    echo "[release] building at $RELEASE"
    (cd "$RELEASE" && pnpm build)
    ;;
  start)
    echo "[release] starting production server on PORT=${PORT:-6734}"
    (cd "$RELEASE" && PORT="${PORT:-6734}" pnpm start)
    ;;
  rebuild)
    "$0" sync
    "$0" build
    ;;
  help|*)
    cat <<EOF
Usage: $0 <sync|build|start|rebuild>

  sync     Reset release worktree to dev repo's committed HEAD (no uncommitted files)
  build    pnpm build in release worktree
  start    pnpm start in release worktree (default PORT=6734)
  rebuild  sync + build

Dev repo:     $ROOT  →  pnpm dev:ui  (PORT=3001)
Release tree: $RELEASE  →  pnpm start (PORT=6734)

Override release path: HERMES_RELEASE_DIR=/path/to/release $0 build
EOF
    ;;
esac
