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
import os
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
RUNTIME_UI = ROOT / "target" / ".pi" / "extensions" / "workflow" / "runtime-ui.ts"
COMMAND_POLICY = ROOT / "target" / ".pi" / "extensions" / "workflow" / "command-policy.ts"
MARKDOWN_BOX = ROOT / "target" / ".pi" / "extensions" / "workflow" / "markdown-box.ts"
FORMAT = ROOT / "target" / ".pi" / "extensions" / "workflow" / "format.ts"
THEME = ROOT / "target" / ".pi" / "themes" / "workflow-console.json"
PI_DARK_THEME = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "dist" / "modes" / "interactive" / "theme" / "dark.json"
PI_NODE_MODULES = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"


def _run_markdown_box(script_body: str) -> dict:
    env = os.environ.copy()
    env["NODE_PATH"] = str(PI_NODE_MODULES)
    script = textwrap.dedent(f'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('markdown-box-test.js'), {{ interopDefault: false }});
        const mod = jiti(path.resolve('target/.pi/extensions/workflow/markdown-box.ts'));
        {script_body}
    ''')
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


# ── Imports ───────────────────────────────────────────────────────────────────

def test_pi_tui_imported():
    src = WORKFLOW.read_text(encoding="utf-8") + RUNTIME_UI.read_text(encoding="utf-8")
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
    helpers = RUNTIME_UI.read_text(encoding="utf-8")
    block = _tool_block(src, "workflow_approve")
    assert "function formatTransitionDetails" in helpers
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
    src = WORKFLOW.read_text(encoding="utf-8") + RUNTIME_UI.read_text(encoding="utf-8")
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
    src = WORKFLOW.read_text(encoding="utf-8") + RUNTIME_UI.read_text(encoding="utf-8")
    assert "setStatus" in src
    assert '"workflow-phase"' in src


def test_refresh_status_shows_gate_indicators():
    src = RUNTIME_UI.read_text(encoding="utf-8")
    idx = src.index("function refreshWorkflowStatus")
    block = src[idx:idx + 2400]
    assert "DPAA" in block or "dpaa" in block
    assert "Quality" in block or "quality" in block
    assert "Review" in block or "review" in block
    assert "colorOutcome(theme, icon)" in block


def test_outcome_colors_map_success_failure_and_pending():
    src = RUNTIME_UI.read_text(encoding="utf-8")
    idx = src.index("function colorOutcome")
    block = src[idx:idx + 500]
    assert 'icon === "✅"' in block and 'theme.fg("success"' in block
    assert 'icon === "❌"' in block and 'theme.fg("error"' in block
    assert 'icon === "⏳"' in block and 'theme.fg("warning"' in block


def test_result_boxes_use_status_background_tokens():
    src = WORKFLOW.read_text(encoding="utf-8")
    helpers = RUNTIME_UI.read_text(encoding="utf-8")
    idx = helpers.index("function resultBox")
    block = helpers[idx:idx + 700]
    assert "new Box(1, 0, bgFn)" in block
    assert "theme.bg(bgToken" in block
    assert '"toolSuccessBg"' in block
    assert '"toolErrorBg"' in block
    assert '"toolPendingBg"' in block
    assert src.count("return resultBox(theme") >= 8


# ── Board widget theme ────────────────────────────────────────────────────────

def test_refresh_board_applies_theme_colors():
    src = RUNTIME_UI.read_text(encoding="utf-8")
    idx = src.index("function refreshWorkflowBoard")
    block = src[idx:idx + 1000]
    assert "theme.fg(" in block


def test_format_workflow_board_defined():
    src = FORMAT.read_text(encoding="utf-8")
    assert "export function formatWorkflowBoard" in src


def test_automatic_chain_display_guidance_is_explicit():
    src = FORMAT.read_text(encoding="utf-8")
    assert "User-visible next stop" in src
    assert "planning in progress" in src
    assert "plan_review awaiting plan approval" in src


def test_code_review_guidance_prefers_async_subagent_review():
    src = FORMAT.read_text(encoding="utf-8")
    assert "Prefer async subagent review" in src
    assert "foreground timeouts" in src
    assert "submit_review_package" in src


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
    workflow_src = WORKFLOW.read_text(encoding="utf-8")
    policy_src = COMMAND_POLICY.read_text(encoding="utf-8")
    idx = workflow_src.index('command === "tools"')
    block = workflow_src[idx:idx + 500]
    assert "formatWorkflowToolsListing" in block
    assert "Built-in tools" in policy_src or "builtins" in policy_src


def test_tools_command_shows_catalog_commands():
    workflow_src = WORKFLOW.read_text(encoding="utf-8")
    policy_src = COMMAND_POLICY.read_text(encoding="utf-8")
    idx = workflow_src.index('command === "tools"')
    block = workflow_src[idx:idx + 500]
    assert "formatWorkflowToolsListing" in block
    assert "Catalog commands" in policy_src or "catalogCmds" in policy_src


def test_logs_command_uses_format_recent_field_logs():
    src = WORKFLOW.read_text(encoding="utf-8")
    assert "formatRecentFieldLogs" in src
    idx = src.index('command === "logs"')
    block = src[idx:idx + 200]
    assert "formatRecentFieldLogs" in block


# ── Semantic Markdown box rendering ──────────────────────────────────────────

def test_semantic_box_exports_present():
    src = MARKDOWN_BOX.read_text(encoding="utf-8")
    for symbol in [
        "DEFAULT_SEMANTIC_BOX_TYPES",
        "KNOWN_CODE_LANGUAGES",
        "classifyFenceInfo",
        "parseMarkdownFencedBlocks",
        "renderSemanticMarkdownBoxes",
        "SEMANTIC_BOX_LABELS",
        "SEMANTIC_BOX_COLOR_KINDS",
    ]:
        assert f"export {symbol}" in src or f"export const {symbol}" in src or f"export function {symbol}" in src or f"export interface {symbol}" in src


def test_semantic_box_default_types_classify_as_box():
    data = _run_markdown_box(r'''
        const types = ['note', 'warning', 'error', 'plan', 'review', 'decision', 'tip'];
        console.log(JSON.stringify(Object.fromEntries(types.map((type) => [type, mod.classifyFenceInfo(type)]))));
    ''')
    assert set(data.values()) == {"box"}


def test_semantic_box_code_languages_stay_code():
    data = _run_markdown_box(r'''
        const langs = ['ts', 'typescript', 'js', 'javascript', 'python', 'py', 'bash', 'sh', 'shell', 'json', 'yaml', 'java', 'text', 'plaintext', 'mermaid', 'dockerfile', 'ps1', 'powershell'];
        console.log(JSON.stringify(Object.fromEntries(langs.map((lang) => [lang, mod.classifyFenceInfo(lang)]))));
    ''')
    assert len(data) >= 12
    assert set(data.values()) == {"code"}


def test_semantic_box_unknown_non_code_info_becomes_box():
    data = _run_markdown_box(r'''
        console.log(JSON.stringify({ result: mod.classifyFenceInfo('summary-card') }));
    ''')
    assert data["result"] == "box"


def test_semantic_box_parser_supports_backtick_and_tilde_fences():
    data = _run_markdown_box(r'''
        const backtick = mod.parseMarkdownFencedBlocks('before\n```note\nhello\n```\nafter');
        const tilde = mod.parseMarkdownFencedBlocks('~~~tip\nhello\n~~~');
        console.log(JSON.stringify({
          backtickKinds: backtick.map((segment) => segment.kind),
          tildeKinds: tilde.map((segment) => segment.kind),
        }));
    ''')
    assert "box" in data["backtickKinds"]
    assert "box" in data["tildeKinds"]


def test_semantic_box_rendering_preserves_code_fences():
    data = _run_markdown_box(r'''
        const lines = mod.renderSemanticMarkdownBoxes('```ts\nconst x = 1;\n```', 80);
        console.log(JSON.stringify({ first: lines[0], last: lines[lines.length - 1], lines }));
    ''')
    assert data["first"].startswith("```ts")
    assert data["last"] == "```"
    assert "const x = 1;" in data["lines"]


def test_semantic_box_rendering_preserves_untyped_code_fences():
    data = _run_markdown_box(r'''
        const lines = mod.renderSemanticMarkdownBoxes('```\nplain code\n```', 80);
        console.log(JSON.stringify({ first: lines[0], last: lines[lines.length - 1], lines }));
    ''')
    assert data["first"] == "```"
    assert data["last"] == "```"
    assert "plain code" in data["lines"]


def test_semantic_box_rendered_lines_fit_width_40():
    data = _run_markdown_box(r'''
        const lines = mod.renderSemanticMarkdownBoxes('```warning\nThis is a very long warning message that must be truncated or wrapped safely.\n```', 40);
        console.log(JSON.stringify({ lines, lengths: lines.map((line) => [...line.replace(/\x1b\[[0-9;]*m/g, '')].length) }));
    ''')
    assert data["lines"]
    assert all(length <= 40 for length in data["lengths"])


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
