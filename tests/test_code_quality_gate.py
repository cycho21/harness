from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GATES = ROOT / "target" / ".pi" / "extensions" / "workflow" / "gates.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
FORMAT = ROOT / "target" / ".pi" / "extensions" / "workflow" / "format.ts"


def test_code_quality_gate_runs_before_review_approved():
    gates = GATES.read_text(encoding="utf-8")

    assert 'from === "code_review" && to === "review_approved"' in gates
    assert "runCodeQualityGate(workflow)" in gates
    assert "export function runCodeQualityGate" in gates
    assert "codeQualityGuard" in gates
    assert "HARNESS_CODE_QUALITY_GUARD_CMD" in gates
    assert "Checkstyle/PMD/test failures" in gates


def test_code_quality_gate_treats_unknown_exit_as_tooling_error():
    gates = GATES.read_text(encoding="utf-8")

    assert "err.status == null" in gates
    assert "exit code unknown" in gates
    assert "Treating as tooling error" in gates
    assert "Gate bypassed due to Node.js subprocess environment issue" in gates
    assert "ok: true" in gates


def test_code_quality_gate_has_explicit_skip_and_phase_guidance():
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    fmt = FORMAT.read_text(encoding="utf-8")

    assert '"code-quality"' in workflow
    assert "/workflow skip <gate> <사유>" in workflow
    assert "Advancing to review_approved mechanically runs codeQualityGuard" in fmt
