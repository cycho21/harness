from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "target" / ".pi" / "extensions" / "workflow" / "catalog.ts"
CORE = ROOT / "target" / ".pi" / "extensions" / "workflow" / "core.ts"
WORKFLOW_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
WORKFLOWS = ROOT / "target" / ".pi" / "workflows"


def test_workflow_catalog_lists_existing_templates():
    templates = sorted(path.stem for path in WORKFLOWS.glob("*.md"))
    assert "test-first" in templates
    assert "quality-gate" in templates

    catalog = CATALOG.read_text(encoding="utf-8")
    assert "export function listWorkflowTemplates" in catalog
    assert "export function readWorkflowTemplate" in catalog
    assert "export function formatLoadedWorkflowPrompt" in catalog
    assert "workflows" in catalog


def test_workflow_load_command_is_memory_only_and_prompt_injected():
    workflow = WORKFLOW_EXTENSION.read_text(encoding="utf-8")
    core = CORE.read_text(encoding="utf-8")

    assert '"list", "load", "unload"' in workflow
    assert "loadedWorkflowTemplate: null as WorkflowTemplate | null" in workflow
    assert "state.loadedWorkflowTemplate = template" in workflow
    assert "이 workflow는 extension memory에만 load되었습니다." in workflow
    assert "formatLoadedWorkflowPrompt(state.loadedWorkflowTemplate)" in workflow
    assert "export * from \"./catalog\";" in core
