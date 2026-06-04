#!/usr/bin/env sh
set -eu
export PYTHONIOENCODING=utf-8

REPO="https://github.com/cycho21/harness.git"
DEST="$(pwd)"
REF=""
SOURCE_SUBDIR="target"
FORCE=0
CLEAN=0
DRY_RUN=0
KEEP_TEMP=0
COMPONENTS="all"

usage() {
  cat <<'EOF'
Usage: init-target-harness.sh [options]

Options:
  --repo URL          Harness git remote (default: https://github.com/cycho21/harness.git)
  --dest DIR          Project root to initialize (default: current directory)
  --ref REF           Branch or tag to clone
  --source-subdir DIR Template directory inside repo (default: target)
  --force             Overwrite existing files
  --clean             Clean managed harness runtime paths before reinstalling; preserves AGENTS.md, .pi/LOCAL.md, and .ai/interview artifacts
  --dry-run           Print planned changes without writing files
  --component NAME    Component to initialize: all, workflow, memory, claude-workflow (repeatable; default: all)
  --keep-temp         Keep temporary clone directory
  -h, --help          Show this help

Notes:
  A shared Stanford CoreNLP Docker container is started automatically when
  the workflow component is selected. Requires Docker Desktop.
  To skip, use --component memory (workflow component omitted).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --source-subdir) SOURCE_SUBDIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --clean) CLEAN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --component) if [ "$COMPONENTS" = "all" ]; then COMPONENTS="$2"; else COMPONENTS="$COMPONENTS $2"; fi; shift 2 ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "Required command not found: git" >&2; exit 1; }
command -v find >/dev/null 2>&1 || { echo "Required command not found: find" >&2; exit 1; }

DEST=$(cd "$DEST" 2>/dev/null && pwd || { mkdir -p "$DEST" && cd "$DEST" && pwd; })
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/harness.XXXXXX")
CLONE_DIR="$TEMP_ROOT/repo"

cleanup() {
  if [ "$KEEP_TEMP" -eq 1 ]; then
    echo "temp kept: $TEMP_ROOT"
  else
    rm -rf "$TEMP_ROOT"
  fi
}
trap cleanup EXIT INT TERM

echo "repo:   $REPO"
echo "dest:   $DEST"
[ -n "$REF" ] && echo "ref:    $REF"
echo "components: $COMPONENTS"
[ "$DRY_RUN" -eq 1 ] && echo "mode:   dry-run"
[ "$CLEAN" -eq 1 ] && echo "mode:   clean reinstall (managed runtime paths only)"

if [ -n "$REF" ]; then
  git clone --depth 1 --branch "$REF" "$REPO" "$CLONE_DIR"
else
  git clone --depth 1 "$REPO" "$CLONE_DIR"
fi

SOURCE="$CLONE_DIR/$SOURCE_SUBDIR"
[ -d "$SOURCE" ] || { echo "Source template directory not found in repo: $SOURCE_SUBDIR" >&2; exit 1; }

component_selected() {
  rel=$1
  for component in $COMPONENTS; do
    if [ "$component" = "all" ]; then
      component_selected_with "workflow" "$rel" && return 0
      component_selected_with "memory" "$rel" && return 0
    else
      component_selected_with "$component" "$rel" && return 0
    fi
  done
  return 1
}

component_roots() {
  component=$1
  case "$component" in
    workflow)
      printf '%s\n' AGENTS.md .pi/.gitignore .pi/LOCAL.md .pi/WORKFLOW.md .pi/GOVERNANCE.md .pi/extensions/workflow.ts .pi/extensions/workflow .harness/workflow-policy.json .ai/interview .pi/dpaa .pi/workflows .pi/skills .pi/personas .pi/themes .pi/pyproject.toml .pi/schemas/harness-field-log-event.schema.json .pi/sbadr .pi/corenlp .pi/setup_corenlp.sh .pi/setup_corenlp.ps1 ;;
    memory)
      printf '%s\n' AGENTS.md .pi/.gitignore .pi/LOCAL.md .pi/extensions/memory.ts .pi/schemas/harness-memory-entry.schema.json ;;
    claude-workflow)
      printf '%s\n' .claude/settings.json .claude/hooks/workflow-gate.cjs .claude/commands/workflow .claude/commands/feature-interview.md .claude/commands/feature-planning-room.md .claude/commands/requirements-room.md .harness/.gitignore .harness/README.md .harness/workflow-policy.json .harness/state.json .harness/workflow.json .harness/proposal .harness/authority .ai/interview .pi/dpaa .pi/sbadr .pi/pyproject.toml .pi/setup_corenlp.sh .pi/setup_corenlp.ps1 ;;
    *) echo "Unknown component: $component" >&2; exit 2 ;;
  esac
}

selected_component_roots() {
  for component in $COMPONENTS; do
    if [ "$component" = "all" ]; then
      component_roots workflow
      component_roots memory
    else
      component_roots "$component"
    fi
  done | sort -u
}

component_selected_with() {
  component=$1
  rel=$2
  case "$component" in
    workflow)
      case "$rel" in
        AGENTS.md|.pi/.gitignore|.pi/LOCAL.md|.pi/WORKFLOW.md|.pi/GOVERNANCE.md|.pi/extensions/workflow.ts|.pi/extensions/workflow/*|.harness/workflow-policy.json|.ai/interview/*|.pi/dpaa/*|.pi/workflows/*|.pi/skills/*|.pi/personas/*|.pi/themes/*|.pi/pyproject.toml|.pi/schemas/harness-field-log-event.schema.json|.pi/sbadr/*|.pi/corenlp/*|.pi/setup_corenlp.sh|.pi/setup_corenlp.ps1) return 0 ;;
      esac ;;
    memory)
      case "$rel" in
        AGENTS.md|.pi/.gitignore|.pi/LOCAL.md|.pi/extensions/memory.ts|.pi/schemas/harness-memory-entry.schema.json) return 0 ;;
      esac ;;
    claude-workflow)
      case "$rel" in
        .claude/settings.json|.claude/hooks/workflow-gate.cjs|.claude/commands/workflow/*|.claude/commands/feature-interview.md|.claude/commands/feature-planning-room.md|.claude/commands/requirements-room.md|.harness/.gitignore|.harness/README.md|.harness/workflow-policy.json|.harness/state.json|.harness/workflow.json|.harness/proposal/*|.harness/authority/*|.ai/interview/*|.pi/dpaa/*|.pi/sbadr/*|.pi/pyproject.toml|.pi/setup_corenlp.sh|.pi/setup_corenlp.ps1) return 0 ;;
      esac ;;
    *) echo "Unknown component: $component" >&2; exit 2 ;;
  esac
  return 1
}

if [ "$CLEAN" -eq 1 ]; then
  selected_component_roots | while IFS= read -r ROOT; do
    case "$ROOT" in
      AGENTS.md|.pi/LOCAL.md|.ai/interview)
        printf 'preserve   %s\n' "$ROOT"
        continue ;;
    esac
    TARGET_ROOT="$DEST/$ROOT"
    if [ -e "$TARGET_ROOT" ]; then
      printf 'clean      %s\n' "$ROOT"
      if [ "$DRY_RUN" -ne 1 ]; then
        rm -rf "$TARGET_ROOT"
      fi
    fi
  done
fi

preserve_on_clean() {
  rel=$1
  case "$rel" in
    AGENTS.md|.pi/LOCAL.md|.ai/interview|.ai/interview/*) return 0 ;;
  esac
  return 1
}

COPIED=0
SKIPPED=0
OVERWRITTEN=0

find "$SOURCE" -type f \
  ! -path '*/__pycache__/*' \
  ! -path '*/.pytest_cache/*' \
  ! -path '*/.mypy_cache/*' \
  ! -path '*/.ruff_cache/*' \
  ! -path '*/.venv/*' \
  ! -path '*/.cache/*' \
  ! -path '*/*.egg-info/*' \
  ! -name '.DS_Store' | sort | while IFS= read -r SRC; do
    REL=${SRC#"$SOURCE"/}
    component_selected "$REL" || continue
    TARGET="$DEST/$REL"

    if [ -e "$TARGET" ] && { { [ "$CLEAN" -eq 1 ] && preserve_on_clean "$REL"; } || { [ "$FORCE" -ne 1 ] && [ "$CLEAN" -ne 1 ]; }; }; then
      printf 'skip       %s\n' "$REL"
      SKIPPED=$((SKIPPED + 1))
    else
      if [ -e "$TARGET" ]; then
        ACTION="overwrite"
        OVERWRITTEN=$((OVERWRITTEN + 1))
      else
        ACTION="copy"
        COPIED=$((COPIED + 1))
      fi
      printf '%-10s %s\n' "$ACTION" "$REL"

      if [ "$DRY_RUN" -ne 1 ]; then
        mkdir -p "$(dirname "$TARGET")"
        cp -p "$SRC" "$TARGET"
      fi
    fi

    echo "$COPIED $OVERWRITTEN $SKIPPED" > "$TEMP_ROOT/counts"
  done

if [ -f "$TEMP_ROOT/counts" ]; then
  set -- $(cat "$TEMP_ROOT/counts")
  COPIED=$1
  OVERWRITTEN=$2
  SKIPPED=$3
fi

echo ""
echo "Done. copied=$COPIED overwritten=$OVERWRITTEN skipped=$SKIPPED"

# Install Stanford CoreNLP if workflow component was selected
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
      echo "Warning: CoreNLP installation failed. Run .pi/setup_corenlp.sh manually to retry." >&2
    fi
  fi
fi

echo "Next: run 'pi' from the destination project root."
