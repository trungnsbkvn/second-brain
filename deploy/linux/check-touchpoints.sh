#!/usr/bin/env bash
# check-touchpoints.sh — surface upstream changes to our fork's inline
# touch-points (UPSTREAM.md §B) BEFORE merging, so a merge doesn't surprise you
# with conflicts. Git-only, zero deps.
#
#   deploy/linux/check-touchpoints.sh                 # report
#   deploy/linux/check-touchpoints.sh --fail-on-drift # non-zero exit on drift (CI)
set -euo pipefail

FAIL_ON_DRIFT=0
[ "${1:-}" = "--fail-on-drift" ] && FAIL_ON_DRIFT=1

# Keep in sync with UPSTREAM.md §B.
TOUCHPOINTS=(
  src/commands/serve-http.ts
  src/core/migrate.ts
  src/core/cycle.ts
  src/core/config.ts
  src/core/ai/recipes/ollama.ts
  src/core/operations.ts
  admin/src/App.tsx
  admin/src/api.ts
)

git fetch upstream --quiet 2>/dev/null || echo "warn: 'upstream' remote missing — add it (UPSTREAM.md §C)"
BASE=$(git merge-base HEAD upstream/master 2>/dev/null || true)
if [ -z "$BASE" ]; then
  echo "error: no merge-base with upstream/master (add the 'upstream' remote first)"
  exit 2
fi

echo "Upstream changes to fork touch-points since merge-base ($BASE):"
drift=0
for f in "${TOUCHPOINTS[@]}"; do
  stat=$(git diff --shortstat "$BASE" upstream/master -- "$f" 2>/dev/null || true)
  if [ -n "$stat" ]; then
    printf "  ⚠ %-38s %s\n" "$f" "$stat"
    drift=1
  else
    printf "  ✓ %-38s (no upstream change)\n" "$f"
  fi
done

if [ "$drift" = 1 ]; then
  echo "→ the ⚠ files will need conflict resolution during 'git merge upstream/master'."
  [ "$FAIL_ON_DRIFT" = 1 ] && exit 1
else
  echo "→ no upstream drift on touch-points — merge should be clean."
fi
