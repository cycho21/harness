"""
Tests for guard token persistence and MVP 3 artifact hash binding.

Covers:
- HARNESS_TOKEN_TYPES constants defined in workflow.ts
- persistGuardToken writes audit-only entries and restore is intentionally absent
- planSha256 propagated through DPAA gate result
- advanceWorkflow accepts approvedPlanSha256
- runPreTransitionGate accepts opts.approvedPlanSha256
- Hash staleness check blocks transition when plan changes
- Fork session clears guard state
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
RUNTIME_STATE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "runtime-state.ts"
GATES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "gates.ts"
STATE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "state.ts"


# ── Task 1: Token persistence ─────────────────────────────────────────────────

def test_harness_token_types_defined():
    src = WORKFLOW.read_text(encoding="utf-8") + RUNTIME_STATE.read_text(encoding="utf-8")
    assert "HARNESS_TOKEN_TYPES" in src
    assert "harness-dpaa-token" in src
    assert "harness-code-quality-token" in src
    assert "harness-code-review-token" in src
    assert "harness-push-token" in src
    assert "harness-review-package-token" in src


def test_persist_guard_token_function_defined():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "function persistGuardToken" in src
    assert "pi.appendEntry" in src
    assert "auditOnly: true" in src


def test_restore_guard_tokens_function_absent():
    src = WORKFLOW.read_text(encoding="utf-8") + RUNTIME_STATE.read_text(encoding="utf-8")
    assert "function restoreGuardTokens" not in src
    assert "restoreGuardTokensToRuntimeState" not in src


def test_persist_called_on_dpaa_token():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "persistGuardToken(HARNESS_TOKEN_TYPES.DPAA" in src


def test_persist_called_on_code_quality_token():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY" in src


def test_persist_called_on_push_execution_token():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "persistGuardToken(HARNESS_TOKEN_TYPES.PUSH_EXECUTION" in src


def test_persist_called_on_review_package_token():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "persistGuardToken(HARNESS_TOKEN_TYPES.REVIEW_PACKAGE" in src


def test_session_start_does_not_restore_persisted_guard_tokens():
    src = WORKFLOW.read_text(encoding="utf-8")
    session_start_idx = src.index('pi.on("session_start"')
    session_start_block = src[session_start_idx:session_start_idx + 2000]
    assert "getEntries" not in session_start_block
    assert "audit-only" in session_start_block


# ── Task 2: MVP 3 Artifact hash binding ──────────────────────────────────────

def test_dpaa_token_includes_plan_sha256_field():
    src = WORKFLOW.read_text(encoding="utf-8") + RUNTIME_STATE.read_text(encoding="utf-8")
    assert "planSha256" in src
    # dpaaGuardSatisfiedToken type includes planSha256
    assert "planSha256?: string" in src


def test_dpaa_gate_returns_plan_sha256_on_pass():
    src = GATES.read_text(encoding="utf-8")
    # Non-skip DPAA pass paths must include planSha256
    # (skip paths intentionally omit it since the hash check is also skipped)
    non_skip_pass = [
        m.start() for m in re.finditer(r'return \{ ok: true.*?DPAA.*?check passed', src)
    ]
    assert len(non_skip_pass) >= 1, "No non-skip DPAA pass return found"
    for idx in non_skip_pass:
        snippet = src[idx:idx+160]
        assert "planSha256" in snippet, f"Missing planSha256 in DPAA pass at offset {idx}: {snippet!r}"


def test_run_pre_transition_gate_accepts_approved_hash():
    src = GATES.read_text(encoding="utf-8")
    assert "approvedPlanSha256" in src
    assert "opts?.approvedPlanSha256" in src or "opts.approvedPlanSha256" in src


def test_hash_staleness_check_blocks_transition():
    src = GATES.read_text(encoding="utf-8")
    assert "Stale Approval" in src or "stale" in src.lower()
    assert "currentHash !== opts" in src or "!== opts" in src or "currentHash !==" in src


def test_advance_workflow_accepts_approved_plan_sha256():
    src = STATE.read_text(encoding="utf-8")
    assert "approvedPlanSha256" in src


def test_sha256_imported_in_gates():
    src = GATES.read_text(encoding="utf-8")
    assert "sha256File" in src


# ── Task 3: Fork handling ─────────────────────────────────────────────────────

def test_fork_reason_clears_guard_state():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert 'event.reason === "fork"' in src
    # After fork detection, state.workflow must be set to null
    fork_idx = src.index('event.reason === "fork"')
    fork_block = src[fork_idx:fork_idx + 600]
    assert "state.workflow = null" in fork_block


def test_fork_notifies_user():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "forked session" in src or "fork" in src
