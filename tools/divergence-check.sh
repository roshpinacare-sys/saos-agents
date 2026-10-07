#!/usr/bin/env bash
# divergence-check — read-only visibility for silent divergence (pattern: measure, don't claim).
# Run manually or from any monitor: reports ahead/behind vs the remote tip.
# Exit: 0 = synced-or-ahead (FF possible) | 1 = fetch failed | 2 = behind or true divergence
#
# Usage:  bash tools/divergence-check.sh [branch]   # default: main
set -uo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-main}"
export GIT_TERMINAL_PROMPT=0
git fetch origin "$TARGET" >/dev/null 2>&1 || { echo "FETCH-FAIL (offline / credential / remote unreachable)"; exit 1; }
RT=$(git rev-parse "origin/$TARGET")
LH=$(git rev-parse HEAD)
COUNTS=$(git rev-list --left-right --count "$RT...$LH")
BEHIND=$(echo "$COUNTS" | cut -f1)
AHEAD=$(echo "$COUNTS" | cut -f2)
echo "remote=$RT"
echo "local =$LH"
echo "behind=$BEHIND ahead=$AHEAD"
if [[ "$BEHIND" -eq 0 ]]; then
  echo "STATE: SYNCED-OR-AHEAD — FF push possible"
  exit 0
elif git merge-base --is-ancestor "$LH" "$RT"; then
  echo "STATE: LOCAL-BEHIND — remote advanced; local must fetch/merge (never force others)"
  exit 2
else
  echo "STATE: TRUE-DIVERGENCE — both lineages advanced since common ancestor"
  echo "LAW: no force. Reconcile by decision (fetch + merge + ledger note) or operator order."
  exit 2
fi
