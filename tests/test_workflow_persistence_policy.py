from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


def test_persisted_workflow_is_not_auto_loaded_as_authority():
    text = WORKFLOW_EXTENSION.read_text(encoding="utf-8")

    assert "workflow: null as WorkflowInstance | null" in text
    assert "workflow: loadPersistedWorkflow()" not in text
    assert "이전 workflow 기록이 파일에 남아 있지만 자동 복구하지 않습니다" in text
    assert "파일 기록은 표시/감사용이며 gate 통과 권한으로 신뢰하지 않습니다" in text
    assert "계속하려면 사용자가 직접 명시 명령을 입력하세요" in text
    assert "/workflow state ${persisted.phase}" in text
