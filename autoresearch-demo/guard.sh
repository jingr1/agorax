#!/usr/bin/env bash
# Locked guard — do not edit during autoresearch loop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
FILE="$ROOT/routing_hint.md"
test -f "$FILE"
bytes=$(wc -c < "$FILE")
test "$bytes" -le 600
