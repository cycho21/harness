from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "target" / ".pi" / "extensions" / "workflow" / "catalog.ts"
CORE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "core.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
WORKFLOWS = ROOT / "target" / ".pi" / "workflows"


def test_workflow_template_files_exist():
    templates = sorted(path.stem for path in WORKFLOWS.glob("*.md"))
    assert "test-first" in templates
    assert "quality-gate" in templates


def test_workflow_load_command_restores_persisted_instance():
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    core = CORE.read_text(encoding="utf-8")

    # list and load commands must both be handled
    assert 'command === "list"' in workflow
    assert 'command === "load"' in workflow
    assert "loadPersistedWorkflow" in workflow
    assert "state.workflow = persisted" in workflow
    assert 'export * from "./catalog";' in core
