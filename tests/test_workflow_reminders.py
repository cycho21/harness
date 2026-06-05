import json
import os
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PI_NODE_MODULES = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"


def _run_node(script: str, tmp_path: Path) -> dict:
    env = os.environ.copy()
    env["NODE_PATH"] = str(PI_NODE_MODULES)
    env["PI_CODING_AGENT_DIR"] = str(tmp_path / ".pi-agent")
    env["HARNESS_FIELD_LOG_ROOT"] = str(tmp_path / "field-log-root")
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_documentation_and_commit_summary_reminders_are_injected_in_commit_phase(tmp_path):
    project = tmp_path / "project"
    docs = project / "docs" / "feat"
    docs.mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (docs / "payment-timeout.md").write_text("# Payment Timeout\n", encoding="utf-8")
    (project / "src.txt").write_text("changed\n", encoding="utf-8")

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir({json.dumps(str(project))});

        const extension = {json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))};
        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(extension).default(pi);

        const ctx = {{ hasUI: true, ui: {{ notify: () => {{}}, confirm: async () => true }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime docs reminder', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          const prompt = await pi.events.before_agent_start({{ systemPrompt: 'base' }});
          console.log(JSON.stringify({{ prompt: prompt.systemPrompt }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node(script, tmp_path)

    assert "[Workflow Mechanical Reminders]" in data["prompt"]
    assert "Documentation:" in data["prompt"]
    assert "docs/feat/html/payment-timeout.html is missing" in data["prompt"]
    assert "docs/feat/INDEX.md is missing" in data["prompt"]
    assert "docs/feat/html/index.html is missing" in data["prompt"]
    assert "Verification:" not in data["prompt"]
    assert "No recent test/lint/typecheck/build/codeQualityGuard command was observed" not in data["prompt"]
    assert "Commit Summary:" in data["prompt"]
    assert "Provide a concise diff summary" in data["prompt"]
    assert "Cause:" in data["prompt"]
    assert "Required action:" in data["prompt"]
    assert "Do not:" in data["prompt"]
    assert "Pass condition:" in data["prompt"]
    assert "explicitly state why" in data["prompt"]


def test_verification_reminder_disappears_when_code_quality_guard_is_satisfied(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (project / "src.txt").write_text("changed\n", encoding="utf-8")

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir({json.dumps(str(project))});

        const reminders = {json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "reminders.ts"))};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const {{ scanWorkflowReminders }} = jiti(reminders);
        const workflow = {{ id: 'wf-test', title: 'Reminder test', phase: 'commit', gitRoot: {json.dumps(str(project))}, history: [] }};

        const withoutQuality = scanWorkflowReminders(workflow, {{}});
        const withQuality = scanWorkflowReminders(workflow, {{ codeQualityGuardSatisfied: true }});
        console.log(JSON.stringify({{
          withoutQuality: withoutQuality?.sections.map((section) => section.title) ?? [],
          withQuality: withQuality?.sections.map((section) => section.title) ?? [],
        }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert "Verification" in data["withoutQuality"]
    assert "Verification" not in data["withQuality"]
    assert "Commit Summary" in data["withQuality"]


def test_verification_reminder_disappears_after_observed_test_command(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (project / "src.txt").write_text("changed\n", encoding="utf-8")

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir({json.dumps(str(project))});

        const extension = {json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))};
        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(extension).default(pi);

        const ctx = {{ hasUI: true, ui: {{ notify: () => {{}}, confirm: async () => true }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime verification reminder', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          await pi.events.tool_call({{ toolName: 'bash', input: {{ command: 'pytest -q' }} }}, ctx);
          const prompt = await pi.events.before_agent_start({{ systemPrompt: 'base' }});
          console.log(JSON.stringify({{ prompt: prompt.systemPrompt }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node(script, tmp_path)

    assert "No recent test/lint/typecheck/build/codeQualityGuard command was observed" not in data["prompt"]
    assert "Commit Summary:" in data["prompt"]


def test_workflow_reminder_source_is_exported_and_documented():
    core = (ROOT / "target" / ".pi" / "extensions" / "workflow" / "core.ts").read_text(encoding="utf-8")
    reminder = (ROOT / "target" / ".pi" / "extensions" / "workflow" / "reminders.ts").read_text(encoding="utf-8")
    workflow = (ROOT / "target" / ".pi" / "extensions" / "workflow.ts").read_text(encoding="utf-8")

    assert 'export * from "./reminders";' in core
    assert "scanWorkflowReminders" in workflow
    assert "formatWorkflowReminders" in workflow
    assert "Workflow Mechanical Reminders" in reminder
    assert "Review Package" in reminder
    assert "Field Log Evidence" in reminder
