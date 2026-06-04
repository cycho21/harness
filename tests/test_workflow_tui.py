"""
Tests for MVP 5: TUI UX improvements.

Covers:
- Text + truncateToWidth imports from @earendil-works/pi-tui
- renderCall/renderResult on guarded workflow tools with outcome colors
- refreshStatus() footer function defined
- refreshBoard() uses theme coloring
- /workflow tools subcommand
- /workflow logs subcommand
- workflow-console.json has 51 tokens matching Pi dark theme
- formatWorkflowBoard defined in format.ts
- WorkflowBoardState type exported
"""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
FORMAT = ROOT / "target" / ".pi" / "extensions" / "workflow" / "format.ts"
THEME = ROOT / "target" / ".pi" / "themes" / "workflow-console.json"
PI_DARK_THEME = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "modes" / "interactive" / "theme" / "dark.json"


# ── Imports ───────────────────────────────────────────────────────────────────

def test_pi_tui_imported():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "@earendil-works/pi-tui" in src
    assert "Text" in src
    assert "truncateToWidth" in src


# ── renderCall/renderResult on all tools ─────────────────────────────────────

def _tool_block(src: str, tool_name: str) -> str:
    """Extract the full tool registration block (up to next pi.registerTool/Command)."""
    idx = src.index(f'"{tool_name}"')
    # Find the end: next registerTool or registerCommand after this one
    next_reg = src.find("pi.register", idx + len(tool_name))
    return src[idx: next_reg if next_reg > 0 else idx + 8000]


def test_submit_review_package_has_render_call():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderCall" in _tool_block(src, "submit_review_package")


def test_submit_review_package_has_render_result():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderResult" in _tool_block(src, "submit_review_package")


def test_workflow_run_command_has_render_call():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderCall" in _tool_block(src, "workflow_run_command")


def test_workflow_run_command_has_render_result():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderResult" in _tool_block(src, "workflow_run_command")


def test_workflow_propose_edit_has_render_call():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderCall" in _tool_block(src, "workflow_propose_edit")


def test_workflow_propose_edit_has_render_result():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderResult" in _tool_block(src, "workflow_propose_edit")


def test_workflow_apply_approved_edit_has_render_call():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderCall" in _tool_block(src, "workflow_apply_approved_edit")


def test_workflow_apply_approved_edit_has_render_result():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "renderResult" in _tool_block(src, "workflow_apply_approved_edit")


def test_workflow_approve_has_colored_render_result():
    src = WORKFLOW.read_text(encoding="utf-8")
    block = _tool_block(src, "workflow_approve")
    assert "renderResult" in block
    assert "Workflow advanced" in block
    assert "gate-blocked" in block
    assert "theme.fg(\"success\"" in block
    assert "colorResultLabel(theme, warning ? \"warning\" : \"error\"" in block


def test_workflow_approve_render_result_filters_undefined_transitions():
    src = WORKFLOW.read_text(encoding="utf-8")
    block = _tool_block(src, "workflow_approve")
    assert "function formatTransitionDetails" in src
    assert "const transitions = formatTransitionDetails(d.transitions);" in block
    assert "d.transitions.join" not in block


def test_workflow_state_has_colored_render_result():
    src = WORKFLOW.read_text(encoding="utf-8")
    block = _tool_block(src, "workflow_state")
    assert "renderResult" in block
    assert "Manual recovery applied" in block
    assert "Awaiting manual recovery confirmation" in block
    assert "theme.fg(\"success\"" in block


def test_render_functions_use_theme_fg():
    """All renderCall/renderResult implementations must use theme.fg for coloring."""
    src = WORKFLOW.read_text(encoding="utf-8")
    assert src.count("theme.fg(") >= 12


def test_render_functions_return_text_component():
    """Tool renders must return new Text(...)."""
    src = WORKFLOW.read_text(encoding="utf-8")
    assert src.count("new Text(") >= 8


def test_render_result_handles_is_partial():
    """All renderResult must handle isPartial streaming state."""
    src = WORKFLOW.read_text(encoding="utf-8")
    assert src.count("isPartial") >= 6


# ── Footer status ─────────────────────────────────────────────────────────────

def test_refresh_status_function_defined():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "function refreshStatus" in src


def test_refresh_status_uses_set_status():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "setStatus" in src
    assert '"workflow-phase"' in src


def test_refresh_status_shows_gate_indicators():
    src = WORKFLOW.read_text(encoding="utf-8")
    idx = src.index("function refreshStatus")
    block = src[idx:idx + 2400]
    assert "DPAA" in block or "dpaa" in block
    assert "Quality" in block or "quality" in block
    assert "Review" in block or "review" in block
    assert "colorOutcome(theme, icon)" in block


def test_outcome_colors_map_success_failure_and_pending():
    src = WORKFLOW.read_text(encoding="utf-8")
    idx = src.index("function colorOutcome")
    block = src[idx:idx + 500]
    assert 'icon === "✅"' in block and 'theme.fg("success"' in block
    assert 'icon === "❌"' in block and 'theme.fg("error"' in block
    assert 'icon === "⏳"' in block and 'theme.fg("warning"' in block


def test_result_boxes_use_status_background_tokens():
    src = WORKFLOW.read_text(encoding="utf-8")
    idx = src.index("function resultBox")
    block = src[idx:idx + 700]
    assert "new Box(1, 0, bgFn)" in block
    assert "theme.bg(bgToken" in block
    assert '"toolSuccessBg"' in block
    assert '"toolErrorBg"' in block
    assert '"toolPendingBg"' in block
    assert src.count("return resultBox(theme") >= 8


# ── Board widget theme ────────────────────────────────────────────────────────

def test_refresh_board_applies_theme_colors():
    src = WORKFLOW.read_text(encoding="utf-8")
    idx = src.index("function refreshBoard")
    block = src[idx:idx + 1000]
    assert "theme.fg(" in block


def test_format_workflow_board_defined():
    src = FORMAT.read_text(encoding="utf-8")
    assert "export function formatWorkflowBoard" in src


def test_workflow_board_state_type_exported():
    src = FORMAT.read_text(encoding="utf-8")
    assert "WorkflowBoardState" in src


# ── New subcommands ───────────────────────────────────────────────────────────

def test_workflow_tools_subcommand_defined():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert 'command === "tools"' in src


def test_workflow_logs_subcommand_defined():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert 'command === "logs"' in src


def test_tools_command_shows_builtin_tools():
    src = WORKFLOW.read_text(encoding="utf-8")
    idx = src.index('command === "tools"')
    block = src[idx:idx + 500]
    assert "Built-in tools" in block or "builtins" in block


def test_tools_command_shows_catalog_commands():
    src = WORKFLOW.read_text(encoding="utf-8")
    idx = src.index('command === "tools"')
    block = src[idx:idx + 500]
    assert "Catalog commands" in block or "catalogCmds" in block


def test_logs_command_uses_format_recent_field_logs():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "formatRecentFieldLogs" in src
    idx = src.index('command === "logs"')
    block = src[idx:idx + 200]
    assert "formatRecentFieldLogs" in block


# ── Theme validation ──────────────────────────────────────────────────────────

def test_workflow_console_theme_has_51_tokens():
    with open(THEME, encoding="utf-8") as f:
        d = json.load(f)
    assert len(d["colors"]) == 51, f"Expected 51 tokens, got {len(d['colors'])}"


def test_workflow_console_theme_matches_pi_dark_token_names():
    """All 51 token names must match Pi's built-in dark theme."""
    if not PI_DARK_THEME.exists():
        return  # skip if Pi not installed
    with open(THEME, encoding="utf-8") as f:
        ours = set(json.load(f)["colors"].keys())
    with open(PI_DARK_THEME, encoding="utf-8") as f:
        pi_dark = set(json.load(f)["colors"].keys())
    missing = pi_dark - ours
    extra = ours - pi_dark
    assert not missing, f"Missing tokens vs Pi dark: {missing}"
    assert not extra, f"Extra tokens not in Pi dark: {extra}"


def test_workflow_console_theme_has_vars():
    with open(THEME, encoding="utf-8") as f:
        d = json.load(f)
    assert "vars" in d
    assert len(d["vars"]) > 0


def test_compaction_settings_in_pi_settings():
    settings_path = ROOT / "target" / ".pi" / "settings.json"
    assert settings_path.exists(), ".pi/settings.json missing"
    with open(settings_path, encoding="utf-8") as f:
        d = json.load(f)
    assert "compaction" in d
    assert d["compaction"].get("keepRecentTokens", 0) >= 30000
