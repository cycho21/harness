import json
import os
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PI_NODE_MODULES = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"


def _run_node_runtime(script: str, tmp_path: Path) -> dict:
    env = os.environ.copy()
    env["NODE_PATH"] = str(PI_NODE_MODULES)
    env["PI_CODING_AGENT_DIR"] = str(tmp_path / ".pi-agent")
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_workflow_extension_runtime_registers_and_allows_restored_push(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const confirms = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async (title, text) => { confirms.push({ title, text }); return true; } } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime restored push', ctx);
          await pi.commands.workflow.handler('state push', ctx);
          const pushResult = await pi.events.tool_call({ toolName: 'bash', input: { command: 'git push origin HEAD' } }, ctx);
          const prompt = await pi.events.before_agent_start({ systemPrompt: 'base' });
          console.log(JSON.stringify({
            commandNames: Object.keys(pi.commands),
            toolNames: Object.keys(pi.tools),
            pushAllowed: pushResult === undefined,
            confirmTitles: confirms.map((item) => item.title),
            prompt: prompt.systemPrompt,
            notifications: notifications.map((item) => item.text),
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "workflow" in data["commandNames"]
    assert "submit_review_result" not in data["toolNames"]
    assert data["pushAllowed"] is True
    assert "Workflow state 수동 변경 승인 확인" in data["confirmTitles"]
    assert "[Workflow Authority Memory]" in data["prompt"]
    assert "Push execution guard satisfied token: present" in data["prompt"]


def test_workflow_extension_runtime_blocks_failed_code_quality_guard(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');
        process.env.HARNESS_CODE_QUALITY_GUARD_CMD = 'node -e "process.exit(7)"';

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime code quality', ctx);
          await pi.commands.workflow.handler('state code_review', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          console.log(JSON.stringify({ notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert "CODE QUALITY GATE BLOCKED" in joined
    assert "Mechanical code quality guard failed" in joined
    assert "code_review → review_approved" in joined
