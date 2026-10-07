#!/usr/bin/env bash
# forecast-conflicts — git merge-tree --write-tree dry-run (pattern #5 in docs/PATTERNS.md).
# Predicts which files will conflict between HEAD and the remote tip BEFORE the
# stash/rebase dance, so the cure is a rebase, not a post-mortem.
# ADVISORY ONLY — it reports, it never blocks by itself.
#
# Usage:  bash tools/forecast-conflicts.sh [branch]   # default: main
# Exit:   0 = clean / no divergence · 1 = conflicts predicted · 2 = internal error
set -uo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-main}"
export GIT_TERMINAL_PROMPT=0
git fetch origin "$TARGET" -q || { echo "FORECAST-ERROR: fetch failed"; exit 2; }
REMOTE_TIP=$(git rev-parse "origin/$TARGET")
LOCAL_HEAD=$(git rev-parse HEAD)
if [[ "$REMOTE_TIP" == "$LOCAL_HEAD" ]] || git merge-base --is-ancestor "$REMOTE_TIP" "$LOCAL_HEAD" 2>/dev/null; then
  echo "FORECAST: clean fast-forward — no conflict possible (origin synced or ancestor)"
  exit 0
fi
OUT="$(git merge-tree --write-tree "$LOCAL_HEAD" "$REMOTE_TIP" 2>/dev/null)"
RC=$?
if [[ $RC -eq 0 ]]; then
  echo "FORECAST: origin moved but merge-tree predicts NO conflicts — reconcile (stash→rebase) is safe"
  exit 0
fi
if [[ $RC -eq 1 ]]; then
  echo "FORECAST: conflicts predicted between HEAD and origin/$TARGET:"
  echo "$OUT" | tail -n +2 | awk 'NF' | sed 's/^/  ! /'
  echo "FORECAST-ADVICE: regenerated state → local wins · additive ledgers/docs → union merge"
  exit 1
fi
echo "FORECAST-ERROR: merge-tree exited rc=$RC"
exit 2
