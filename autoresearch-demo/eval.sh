#!/usr/bin/env bash
# Locked eval — do not edit during autoresearch loop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
FILE="$ROOT/routing_hint.md"
score=0
grep -qi 'wiki' "$FILE" && score=$((score + 1))
grep -qi 'citation\|source' "$FILE" && score=$((score + 1))
grep -qi 'uncertainty\|confidence' "$FILE" && score=$((score + 1))
grep -qi 'no recommendation\|no strategy' "$FILE" && score=$((score + 1))
echo "$score"
