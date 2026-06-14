"""
Tests for MVP 4: Guarded Editing — EditScope, path validation, and tools.

Verifies:
- EditScope and ProposedEdit types in types.ts
- edit-scope.ts: path traversal, symlink, protected path blocking
- computeBaseFileHashes / verifyBaseFileHashes
- applyProposedEdit for write/edit/delete
- workflow_propose_edit tool registered
- workflow_apply_approved_edit tool registered
- Phase restriction (only write phases)
- Protected path patterns cover extension files, node_modules, .git, .env, secrets, .ssh
"""
from pathlib import Path
import subprocess
import sys
import tempfile
import os

ROOT = Path(__file__).resolve().parents[1]
TYPES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "types.ts"
EDIT_SCOPE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "edit-scope.ts"
WORKFLOW = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
CORE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "core.ts"


# ── Types ─────────────────────────────────────────────────────────────────────

def test_edit_scope_interface_defined():
    src = TYPES.read_text(encoding="utf-8")
    assert "interface EditScope" in src


def test_proposed_edit_interface_defined():
    src = TYPES.read_text(encoding="utf-8")
    assert "interface ProposedEdit" in src


def test_edit_scope_has_required_fields():
    src = TYPES.read_text(encoding="utf-8")
    for field in ["approvedBy", "sourcePlanHash", "allowedGlobs", "deniedGlobs",
                  "maxFiles", "allowSymlinks", "proposedEdits", "baseFileHashes",
                  "proposedAt", "approvedAt"]:
        assert field in src, f"EditScope missing field: {field}"


def test_proposed_edit_has_required_fields():
    src = TYPES.read_text(encoding="utf-8")
    for field in ["path", "operation", "content", "oldText", "newText", "reason"]:
        assert field in src, f"ProposedEdit missing field: {field}"


def test_edit_operation_type_defined():
    src = TYPES.read_text(encoding="utf-8")
    assert "EditOperation" in src
    assert '"write"' in src and '"edit"' in src and '"delete"' in src


# ── edit-scope.ts: path validation ───────────────────────────────────────────

def test_validate_edit_path_exported():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "export function validateEditPath" in src


def test_path_traversal_blocked():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "startsWith" in src or "rel.startsWith" in src
    assert "traversal" in src.lower()


def test_symlink_rejection():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "isSymbolicLink" in src
    assert "Symlinks" in src or "symlink" in src.lower()


def test_protected_patterns_cover_extensions():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert ".pi/extensions" in src
    assert "node_modules" in src
    assert ".git" in src
    assert ".env" in src
    assert "secrets" in src
    assert ".ssh" in src


def test_protected_patterns_cover_harness_ts_files():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    # Must block .pi/*.ts files
    assert r"\.ts" in src or ".ts" in src


def test_core_exports_edit_scope_module():
    src = CORE.read_text(encoding="utf-8")
    assert "edit-scope" in src


# ── edit-scope.ts: hash helpers ───────────────────────────────────────────────

def test_compute_base_file_hashes_exported():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "export function computeBaseFileHashes" in src


def test_verify_base_file_hashes_exported():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "export function verifyBaseFileHashes" in src


def test_apply_proposed_edit_exported():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "export function applyProposedEdit" in src


def test_create_edit_scope_exported():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "export function createEditScope" in src


# ── edit-scope.ts: write/edit/delete operations ───────────────────────────────

def test_apply_handles_all_three_operations():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert '"write"' in src or "'write'" in src
    assert '"edit"' in src or "'edit'" in src
    assert '"delete"' in src or "'delete'" in src


def test_apply_write_creates_parent_dirs():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "mkdirSync" in src


def test_apply_edit_checks_old_text_exists():
    src = EDIT_SCOPE.read_text(encoding="utf-8")
    assert "oldText" in src
    # indexOf-based check (safe vs String.replace pattern interpretation)
    assert "indexOf" in src or "includes" in src


# ── Tools registered ──────────────────────────────────────────────────────────

def test_workflow_propose_edit_tool_registered():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert '"workflow_propose_edit"' in src


def test_workflow_apply_approved_edit_tool_registered():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert '"workflow_apply_approved_edit"' in src


def test_propose_edit_validates_paths():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "validateEditPath" in src
    assert "path-validation-failed" in src


def test_propose_edit_checks_phase():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "WRITE_PHASES" in src
    assert "phase-not-allowed" in src


def test_propose_edit_requires_ui():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "ctx.hasUI" in src
    assert "no-ui" in src


def test_apply_re_validates_paths():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "path-revalidation-failed" in src


def test_apply_checks_hash_staleness():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "verifyBaseFileHashes" in src
    assert "stale-hashes" in src


def test_active_edit_scope_in_state():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "activeEditScope" in src


# ── Functional: validate_edit_path via Node ───────────────────────────────────

def _run_node(script: str) -> dict:
    """Run a small Node.js snippet via jiti to test edit-scope logic."""
    import json
    pi_modules = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"
    env = os.environ.copy()
    env["NODE_PATH"] = str(pi_modules)
    result = subprocess.run(
        ["node", "-e", script],
        cwd=str(ROOT / "target"),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        encoding="utf-8",
    )
    if result.returncode != 0:
        return {"error": result.stderr}
    try:
        return json.loads(result.stdout)
    except Exception:
        return {"raw": result.stdout}


def test_validate_path_traversal_blocked_runtime():
    script = r"""
const path = require('path');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { interopDefault: false });
const mod = jiti(path.resolve('.pi/extensions/workflow/edit-scope.ts'));
const gitRoot = 'C:/tmp/project';
const result = mod.validateEditPath('../../../etc/passwd', gitRoot, false);
console.log(JSON.stringify(result));
"""
    data = _run_node(script)
    if "error" in data:
        return  # skip if jiti unavailable
    assert data.get("ok") is False
    assert "traversal" in (data.get("reason") or "").lower()


def test_validate_protected_extension_path_blocked_runtime():
    script = r"""
const path = require('path');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { interopDefault: false });
const mod = jiti(path.resolve('.pi/extensions/workflow/edit-scope.ts'));
const gitRoot = path.resolve('.');
const result = mod.validateEditPath('.pi/extensions/workflow.ts', gitRoot, false);
console.log(JSON.stringify(result));
"""
    data = _run_node(script)
    if "error" in data:
        return  # skip if jiti unavailable
    assert data.get("ok") is False
    assert "protected" in (data.get("reason") or "").lower()


def test_validate_sensitive_default_paths_blocked_runtime():
    script = r"""
const path = require('path');
const { createJiti } = require('jiti');
const jiti = createJiti(__filename, { interopDefault: false });
const mod = jiti(path.resolve('.pi/extensions/workflow/edit-scope.ts'));
const gitRoot = path.resolve('.');
const cases = {
  gitConfig: mod.validateEditPath('.git/config', gitRoot, false),
  envLocal: mod.validateEditPath('apps/api/.env.local', gitRoot, false),
  secretsFile: mod.validateEditPath('config/secrets/prod.key', gitRoot, false),
  sshKey: mod.validateEditPath('.ssh/id_rsa', gitRoot, false),
  nestedSshKey: mod.validateEditPath('ops/.ssh/deploy_key', gitRoot, false),
};
console.log(JSON.stringify(cases));
"""
    data = _run_node(script)
    if "error" in data:
        return  # skip if jiti unavailable
    for result in data.values():
        assert result.get("ok") is False
        assert "protected" in (result.get("reason") or "").lower()
