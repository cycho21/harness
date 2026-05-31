from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "target" / ".pi" / "extensions" / "workflow" / "catalog.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


def test_workflow_prerequisite_scan_checks_runtime_build_and_checkstyle_files():
    catalog = CATALOG.read_text(encoding="utf-8")

    for needle in [
        "export function scanWorkflowPrerequisites",
        "WORKFLOW.md",
        ".pi/extensions/workflow.ts",
        ".pi/skills",
        "workflows",
        "dpaa",
        "pyproject.toml",
        "build.gradle",
        "build.gradle.kts",
        "pom.xml",
        "config/checkstyle/checkstyle.xml",
        "checkstyle.xml",
        "codeQualityGuard",
        "HARNESS_CODE_QUALITY_GUARD_CMD",
    ]:
        assert needle in catalog


def test_workflow_start_and_load_run_prerequisite_scan_with_explicit_yes_no_warning():
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8")

    assert "const ensurePrerequisites = async" in workflow
    assert "scanWorkflowPrerequisites()" in workflow
    assert "if (!(await ensurePrerequisites())) return;" in workflow
    assert "Workflow prerequisite 경고 확인" in workflow
    assert "예: 경고를 인지하고 계속 진행합니다." in workflow
    assert "아니오: workflow start/load를 중단합니다." in workflow
