#!/usr/bin/env sh
set -eu
export PYTHONIOENCODING=utf-8

REPO="https://github.com/chochanyeon/harness.git"
DEST="$(pwd)"
REF=""
DRY_RUN=0
KEEP_TEMP=0
COMPONENTS="all"

usage() {
  cat <<'EOF'
Usage: update-harness.sh [options]

Updates upstream-managed harness runtime files while preserving project-owned files.

Options:
  --repo URL   Harness git remote (default: https://github.com/chochanyeon/harness.git)
  --dest DIR   Project root to update (default: current directory)
  --ref REF    Branch or tag to clone
  --dry-run    Print planned changes without writing files
  --component NAME Component to update: all, workflow, memory (repeatable; default: all)
  --keep-temp  Keep temporary clone directory
  -h, --help   Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --component) if [ "$COMPONENTS" = "all" ]; then COMPONENTS="$2"; else COMPONENTS="$COMPONENTS $2"; fi; shift 2 ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "Required command not found: git" >&2; exit 1; }
DEST=$(cd "$DEST" 2>/dev/null && pwd || { mkdir -p "$DEST" && cd "$DEST" && pwd; })
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/harness-update.XXXXXX")
CLONE_DIR="$TEMP_ROOT/repo"
COUNTS="$TEMP_ROOT/counts"

cleanup() {
  if [ "$KEEP_TEMP" -eq 1 ]; then echo "temp kept: $TEMP_ROOT"; else rm -rf "$TEMP_ROOT"; fi
}
trap cleanup EXIT INT TERM

echo "repo:   $REPO"
echo "dest:   $DEST"
[ -n "$REF" ] && echo "ref:    $REF"
echo "components: $COMPONENTS"
[ "$DRY_RUN" -eq 1 ] && echo "mode:   dry-run"

if [ -d "$REPO/target" ] && [ -z "$REF" ]; then
  CLONE_DIR=$(cd "$REPO" && pwd)
elif [ -n "$REF" ]; then
  git clone --depth 1 --branch "$REF" "$REPO" "$CLONE_DIR"
else
  git clone --depth 1 "$REPO" "$CLONE_DIR"
fi
TEMPLATE="$CLONE_DIR/target"
[ -d "$TEMPLATE" ] || { echo "Template directory not found in cloned repo: target" >&2; exit 1; }

managed_paths() {
  for component in $COMPONENTS; do
    if [ "$component" = "all" ]; then
      managed_paths_for workflow
      managed_paths_for memory
    else
      managed_paths_for "$component"
    fi
  done | awk '!seen[$0]++'
}

managed_paths_for() {
  case "$1" in
    workflow)
      printf '%s\n' \
        .pi/.gitignore \
        .pi/WORKFLOW.md \
        .pi/GOVERNANCE.md \
        .pi/extensions/workflow.ts \
        .pi/extensions/assistant-markdown-box.ts \
        .pi/extensions/workflow \
        .harness/workflow-policy.json \
        .pi/dpaa \
        .pi/sbadr \
        .pi/corenlp \
        .pi/setup_corenlp.sh \
        .pi/setup_corenlp.ps1 \
        .pi/workflows \
        .pi/skills \
        .pi/personas \
        .pi/themes \
        .pi/pyproject.toml \
        .pi/schemas/harness-field-log-event.schema.json ;;
    memory)
      printf '%s\n' \
        .pi/.gitignore \
        .pi/extensions/memory.ts \
        .pi/schemas/harness-memory-entry.schema.json ;;
    *) echo "Unknown component: $1" >&2; exit 2 ;;
  esac
}

UPDATED=0
: > "$COUNTS"
: > "$TEMP_ROOT/managed-paths"
managed_paths | while IFS= read -r MANAGED; do
    SRC_ROOT="$TEMPLATE/$MANAGED"
    [ -e "$SRC_ROOT" ] || continue
    echo x >> "$TEMP_ROOT/managed-paths"
    if [ -d "$SRC_ROOT" ]; then
      DEST_ROOT="$DEST/$MANAGED"
      if [ -e "$DEST_ROOT" ]; then
        printf 'clean      %s\n' "$MANAGED"
        if [ "$DRY_RUN" -ne 1 ]; then rm -rf "$DEST_ROOT"; fi
      fi
      find "$SRC_ROOT" -type f \
        ! -path '*/__pycache__/*' \
        ! -path '*/.pytest_cache/*' \
        ! -path '*/.mypy_cache/*' \
        ! -path '*/.ruff_cache/*' \
        ! -path '*/.venv/*' \
        ! -path '*/.cache/*' \
        ! -path '*/*.egg-info/*' \
        ! -name '.DS_Store' | sort | while IFS= read -r SRC; do
          REL=${SRC#"$TEMPLATE"/}
          TARGET="$DEST/$REL"
          printf 'update     %s\n' "$REL"
          if [ "$DRY_RUN" -ne 1 ]; then
            mkdir -p "$(dirname "$TARGET")"
            cp -p "$SRC" "$TARGET"
          fi
          echo x >> "$COUNTS"
        done
    else
      TARGET="$DEST/$MANAGED"
      printf 'update     %s\n' "$MANAGED"
      if [ "$DRY_RUN" -ne 1 ]; then
        mkdir -p "$(dirname "$TARGET")"
        cp -p "$SRC_ROOT" "$TARGET"
      fi
      echo x >> "$COUNTS"
    fi
  done

LOCAL_SRC="$TEMPLATE/.pi/LOCAL.md"
LOCAL_TARGET="$DEST/.pi/LOCAL.md"
if [ -f "$LOCAL_SRC" ] && [ ! -e "$LOCAL_TARGET" ]; then
  printf 'seed       %s\n' ".pi/LOCAL.md"
  if [ "$DRY_RUN" -ne 1 ]; then
    mkdir -p "$(dirname "$LOCAL_TARGET")"
    cp -p "$LOCAL_SRC" "$LOCAL_TARGET"
  fi
  echo x >> "$COUNTS"
fi

MANAGED_FOUND=$(wc -l < "$TEMP_ROOT/managed-paths" | tr -d ' ')
[ "$MANAGED_FOUND" -gt 0 ] || { echo "No managed harness paths were found in template. Check --repo, --ref, and target/ contents." >&2; exit 1; }
UPDATED=$(wc -l < "$COUNTS" | tr -d ' ')
echo ""
echo "Done. updated=$UPDATED"
echo "Project-owned paths were preserved: AGENTS.md, .pi/config/, .pi/local/, .pi/LOCAL.md."

component_includes_workflow() {
  for c in $COMPONENTS; do
    [ "$c" = "all" ] && return 0
    [ "$c" = "workflow" ] && return 0
  done
  return 1
}

if [ "$DRY_RUN" -ne 1 ] && component_includes_workflow; then
  CORENLP_SCRIPT="$DEST/.pi/setup_corenlp.sh"
  if [ -f "$CORENLP_SCRIPT" ]; then
    echo ""
    echo "Starting shared CoreNLP Docker container..."
    if bash "$CORENLP_SCRIPT"; then
      : # success
    else
      echo "Warning: CoreNLP startup failed. Run .pi/setup_corenlp.sh manually to retry." >&2
    fi
  fi
fi
