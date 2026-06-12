#!/usr/bin/env bash
# sync-dev-harness.sh
# Syncs target/.pi/ → .pi/ in the dev repo so the local harness reflects
# the current state of target/ without running update-harness.sh against GitHub.
#
# Usage: bash scripts/sync-dev-harness.sh
#
# Preserves project-owned paths: .pi/config/, .pi/local/, .pi/LOCAL.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/target/.pi"
DEST="$REPO_ROOT/.pi"

if [ ! -d "$SRC" ]; then
  echo "ERROR: $SRC not found" >&2
  exit 1
fi

echo "Syncing $SRC → $DEST …"

python3 "$REPO_ROOT/scripts/sync-dev-harness.py" "$SRC" "$DEST"

echo "Done."
