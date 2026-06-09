from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
RUNTIME_STATE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "runtime-state.ts"


def test_persisted_workflow_is_not_auto_loaded_as_authority():
    text = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    runtime_state = RUNTIME_STATE.read_text(encoding="utf-8")

    assert "workflow: WorkflowInstance | null" in runtime_state
    assert "workflow: null" in runtime_state
    assert "workflow: loadPersistedWorkflow()" not in text
    assert "저장된 워크플로우가 있습니다" in text          # 저장된 워크플로우 존재 표시
    assert "자동 복구하지 않으며 guard 증거로 신뢰하지 않습니다" in text  # 보안: 자동 복구 없음
    assert "/workflow load" in text                       # 올바른 복구 명령 안내
    assert "/workflow start" in text                      # 새 workflow 옵션 제공
