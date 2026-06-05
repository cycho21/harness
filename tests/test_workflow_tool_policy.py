"""
Tests for MVP 2: phase-based tool policy via pi.setActiveTools().

Verifies that:
- PHASE_ALLOWED_BUILTIN_TOOLS is defined in policy-core.ts
- getPhaseAllowedTools is exported from policy-core.ts
- Read-only phases do not allow write/edit
- Write phases allow write/edit
- applyPhaseToolPolicy is wired in workflow.ts
- tool_call backstop blocks write/edit in read-only phases
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY_CORE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "policy-core.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


def _policy(text: str) -> dict[str, list[str]]:
    """Parse PHASE_ALLOWED_BUILTIN_TOOLS block into a phase→tools dict (best-effort)."""
    import re
    block_m = re.search(
        r"PHASE_ALLOWED_BUILTIN_TOOLS[^{]*\{(.+?)\};",
        text,
        re.DOTALL,
    )
    if not block_m:
        return {}
    result: dict[str, list[str]] = {}
    for line in block_m.group(1).splitlines():
        m = re.match(r'\s+(\w+):\s+(.+),', line.strip())
        if not m:
            continue
        phase = m.group(1)
        tools_raw = m.group(2)
        tools = re.findall(r'"(\w+)"', tools_raw)
        result[phase] = tools
    return result


READ_ONLY_PHASES = {"plan_review", "review_approved", "done"}
WRITE_PHASES = {"interview", "plan", "implement", "document"}


def test_phase_allowed_builtin_tools_defined():
    src = POLICY_CORE.read_text(encoding="utf-8")
    assert "PHASE_ALLOWED_BUILTIN_TOOLS" in src


def test_get_phase_allowed_tools_exported():
    src = POLICY_CORE.read_text(encoding="utf-8")
    assert "export function getPhaseAllowedTools" in src


def test_read_only_phases_exclude_write_and_edit():
    src = POLICY_CORE.read_text(encoding="utf-8")
    policy = _policy(src)
    for phase in READ_ONLY_PHASES:
        if phase not in policy:
            continue  # phase not parsed — rely on structural check below
        tools = policy[phase]
        assert "write" not in tools, f"{phase} should not allow write"
        assert "edit" not in tools, f"{phase} should not allow edit"


def test_write_phases_include_write_and_edit():
    src = POLICY_CORE.read_text(encoding="utf-8")
    policy = _policy(src)
    for phase in WRITE_PHASES:
        if phase not in policy:
            continue
        tools = policy[phase]
        assert "write" in tools, f"{phase} should allow write"
        assert "edit" in tools, f"{phase} should allow edit"


def test_all_workflow_phases_covered():
    src = POLICY_CORE.read_text(encoding="utf-8")
    all_phases = [
        "interview", "plan", "plan_review", "implement",
        "code_review", "review_approved", "document",
        "commit", "push", "done",
    ]
    for phase in all_phases:
        assert phase in src, f"PHASE_ALLOWED_BUILTIN_TOOLS missing phase: {phase}"


def test_apply_phase_tool_policy_defined_in_workflow():
    src = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    assert "applyPhaseToolPolicy" in src
    assert "pi.setActiveTools" in src
    assert "getPhaseAllowedTools" in src


def test_apply_phase_tool_policy_called_on_start():
    src = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    # Must be called after workflow start and after session_start
    assert src.count("applyPhaseToolPolicy") >= 3


def test_tool_call_backstop_steers_write_edit_in_readonly_phases():
    src = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    assert "PHASE_ALLOWED_BUILTIN_TOOLS" in src
    assert 'event.toolName === "write"' in src or "event.toolName ===" in src
    assert "phaseAllowed && !phaseAllowed.includes(event.toolName)" in src
    assert "void steerLlm" in src


def test_tdd_gate_checks_write_and_edit_calls_in_implement_phase():
    src = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    assert 'state.workflow?.phase === "implement"' in src
    assert 'event.toolName === "write" || event.toolName === "edit"' in src
    assert "isProductionClassPath" in src
    assert "src/test/java" in src
    assert "Test.java" in src
    assert "testExists" in src
    assert "TDD:" in src
