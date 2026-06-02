from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


def test_workflow_guard_evidence_is_memory_only_and_push_uses_transition_history():
    text = WORKFLOW_EXTENSION.read_text(encoding="utf-8")

    assert "dpaaGuardSatisfiedToken: null as" in text
    assert "codeQualityGuardSatisfiedToken: null as" in text
    assert "pushExecutionGuardSatisfiedToken: null as" in text
    assert "policyApprovals: [] as Array" in text
    assert "state.dpaaGuardSatisfiedToken = { workflowId" in text
    assert "state.pushExecutionGuardSatisfiedToken = { workflowId" in text
    assert 'item.from === "commit" && item.to === "push"' in text
    assert "Workflow Transition History" in text


def test_manual_state_and_abort_have_explicit_yes_no_confirm_copy():
    text = WORKFLOW_EXTENSION.read_text(encoding="utf-8")

    assert "Workflow state 수동 변경 승인 확인" in text
    assert "예: 위 내용을 내가 확인하고 phase/evidence를 복구합니다." in text
    assert "아니오: phase와 evidence를 변경하지 않습니다." in text
    assert "state.dpaaGuardSatisfiedToken = null" in text
    assert "state.pushExecutionGuardSatisfiedToken = null" in text
    assert "Code quality guard satisfied → quality evidence 복구" in text
    assert "Code review guard satisfied → review evidence 복구" in text
    assert "Workflow 종료 승인 확인" in text
    assert "예: in-memory workflow를 종료하고 persisted 참고 기록도 삭제합니다." in text
    assert "아니오: workflow를 유지합니다." in text


def test_policy_approval_audit_and_natural_approval_messages_are_explicit():
    text = WORKFLOW_EXTENSION.read_text(encoding="utf-8")

    assert "state.policyApprovals.push" in text
    assert "Interactive user approval advanced the workflow" in text
    assert "Interactive user approval was received, but transition was blocked" in text
    assert "DPAA guard satisfied: transition evidence recorded in current-session memory" in text
    assert "Code quality guard satisfied: quality evidence recorded in current-session memory" in text
    assert "Automated review approved: review/quality evidence recorded in current-session memory" in text
    assert "Push phase approved: commit → push transition evidence recorded in workflow history" in text
    assert "[Workflow Guard Evidence]" in text
