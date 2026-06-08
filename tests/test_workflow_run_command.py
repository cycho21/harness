"""
Tests for workflow_run_command guarded tool and CommandSpec catalog.

Verifies:
- CommandSpec type defined in types.ts
- COMMAND_CATALOG defined with required commands
- getCatalogCommand / getCatalogCommandsForPhase / isPhaseAllowed exported
- runCatalogCommand uses execFileSync (not shell interpolation)
- Shell injection prevention: executable/args come from spec only
- Phase policy enforcement
- workflow_run_command tool registered in workflow.ts
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TYPES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "types.ts"
CATALOG = ROOT / "target" / ".pi" / "extensions" / "workflow" / "catalog.ts"
WORKFLOW = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


# ── CommandSpec type ──────────────────────────────────────────────────────────

def test_command_spec_interface_defined():
    src = TYPES.read_text(encoding="utf-8")
    assert "interface CommandSpec" in src


def test_command_spec_has_required_fields():
    src = TYPES.read_text(encoding="utf-8")
    for field in ["id", "executable", "fixedArgs", "allowedPhases", "cwdPolicy",
                  "timeoutMs", "maxOutputBytes", "outputPolicy", "riskLevel", "requiresApproval"]:
        assert field in src, f"CommandSpec missing field: {field}"


def test_catalog_command_result_type_defined():
    src = TYPES.read_text(encoding="utf-8")
    assert "CatalogCommandResult" in src


# ── COMMAND_CATALOG content ───────────────────────────────────────────────────

REQUIRED_COMMANDS = [
    "git-status", "git-diff", "git-diff-staged", "git-log",
    "code-quality", "project-test", "project-build",
]

def test_command_catalog_exported():
    src = CATALOG.read_text(encoding="utf-8")
    assert "export const COMMAND_CATALOG" in src


def test_required_commands_in_catalog():
    src = CATALOG.read_text(encoding="utf-8")
    for cmd_id in REQUIRED_COMMANDS:
        assert f'id: "{cmd_id}"' in src, f"Missing command in catalog: {cmd_id}"


def test_catalog_helper_functions_exported():
    src = CATALOG.read_text(encoding="utf-8")
    assert "export function getCatalogCommand" in src
    assert "export function getCatalogCommandsForPhase" in src
    assert "export function isPhaseAllowed" in src
    assert "export function runCatalogCommand" in src
    assert "export function formatCatalogCommandResult" in src


# ── Shell injection prevention ────────────────────────────────────────────────

def test_run_catalog_command_uses_exec_file_not_shell():
    """execFileSync uses argv array — no shell interpolation possible."""
    src = CATALOG.read_text(encoding="utf-8")
    assert "execFileSync" in src, "Must use execFileSync (argv form), not execSync with shell"


def test_run_catalog_command_does_not_interpolate_user_input():
    """The commandId from user is only used to look up the spec; never placed in a shell string."""
    src = CATALOG.read_text(encoding="utf-8")
    # Executable and args must come from spec fields, not from params
    assert "spec.executable" in src
    assert "spec.fixedArgs" in src or "[...spec.fixedArgs]" in src or "...args" in src


def test_no_shell_true_in_exec_file():
    src = CATALOG.read_text(encoding="utf-8")
    # shell: true would defeat injection prevention
    assert "shell: true" not in src


def test_windows_bat_files_are_wrapped_with_cmd_c():
    src = CATALOG.read_text(encoding="utf-8")
    assert 'process.platform === "win32"' in src
    assert '/\\.bat$/i.test(executable)' in src
    assert 'args = ["/c", executable, ...args];' in src
    assert 'executable = "cmd.exe";' in src


def test_auto_executable_resolved_from_filesystem():
    src = CATALOG.read_text(encoding="utf-8")
    # Auto resolution must check gradlew/mvnw on filesystem, not trust user input
    assert "resolveAutoExecutable" in src
    assert "gradlew" in src


def test_harness_repo_quality_command_detected():
    src = CATALOG.read_text(encoding="utf-8")
    assert 'type: "harness"' in src
    assert 'target/.pi/extensions/workflow.ts' in src
    assert 'tests/test_workflow_extension_runtime.py' in src
    assert '"-m", "pytest", "tests"' in src
    assert 'tests/test_workflow_*.py' not in src


# ── Phase policy enforcement ──────────────────────────────────────────────────

READ_ONLY_PHASES = ["plan_review", "review_approved", "done"]

def test_git_commands_allowed_in_all_phases():
    src = CATALOG.read_text(encoding="utf-8")
    # git-status should be "all"
    assert '"allowedPhases": "all"' in src or "allowedPhases: \"all\"" in src


def test_build_commands_restricted_to_impl_phases():
    src = CATALOG.read_text(encoding="utf-8")
    # code-quality / project-test restricted to implement and code_review
    # Look for the pattern in catalog entries
    assert '"implement"' in src and '"code_review"' in src


def test_is_phase_allowed_rejects_wrong_phase():
    """isPhaseAllowed must exist and correctly filter by phase."""
    src = CATALOG.read_text(encoding="utf-8")
    # Function must check allowedPhases === "all" or includes(phase)
    assert 'allowedPhases === "all"' in src
    assert "includes(phase)" in src


# ── workflow_run_command tool ─────────────────────────────────────────────────

def test_workflow_run_command_tool_registered():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert '"workflow_run_command"' in src


def test_tool_checks_phase_before_execution():
    workflow_src = WORKFLOW.read_text(encoding="utf-8")
    policy_src = (WORKFLOW.parent / "workflow" / "command-policy.ts").read_text(encoding="utf-8")
    assert "executeWorkflowCatalogCommand" in workflow_src
    assert "isPhaseAllowed" in policy_src
    assert "phase-not-allowed" in policy_src


def test_tool_rejects_unknown_command_id():
    policy_src = (WORKFLOW.parent / "workflow" / "command-policy.ts").read_text(encoding="utf-8")
    assert "unknown-command" in policy_src


def test_tool_calls_run_catalog_command():
    workflow_src = WORKFLOW.read_text(encoding="utf-8")
    policy_src = (WORKFLOW.parent / "workflow" / "command-policy.ts").read_text(encoding="utf-8")
    assert "executeWorkflowCatalogCommand" in workflow_src
    assert "runCatalogCommand" in policy_src


def test_tool_tracks_verification_commands():
    workflow_src = WORKFLOW.read_text(encoding="utf-8")
    policy_src = (WORKFLOW.parent / "workflow" / "command-policy.ts").read_text(encoding="utf-8")
    assert "recentVerificationCommands" in workflow_src
    # code-quality and project-test should be tracked
    assert '"code-quality"' in policy_src or "'code-quality'" in policy_src
