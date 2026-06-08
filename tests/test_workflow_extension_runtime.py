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
    env["HARNESS_FIELD_LOG_ROOT"] = str(tmp_path / "field-log-root")
    env["HARNESS_POLICY_MAX_CHANGED_FILES"] = "500"  # dev repo has many untracked files
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        encoding="utf-8",
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
          await pi.events.tool_result({ toolName: 'bash', input: { command: 'git push origin HEAD' }, isError: false, content: [], details: {} }, ctx);
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
    assert "No active workflow" in data["prompt"]
    assert "Current phase: push" not in data["prompt"]
    assert any("Workflow 전이: push → done" in item for item in data["notifications"])


def test_workflow_extension_runtime_status_without_active_workflow_includes_llm_action(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('status', ctx);
          console.log(JSON.stringify({ notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert "[LLM WORKFLOW ACTION]" in joined
    assert "No active workflow" in joined


def test_workflow_extension_runtime_approve_failures_include_llm_action(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('approve', ctx);
          const noWorkflowApprove = notifications[notifications.length - 1].text;
          await pi.commands.workflow.handler('start Runtime approve failure action', ctx);
          await pi.commands.workflow.handler('state code_review', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const missingReviewPackageApprove = notifications[notifications.length - 1].text;
          console.log(JSON.stringify({ noWorkflowApprove, missingReviewPackageApprove }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "[LLM WORKFLOW ACTION]" in data["noWorkflowApprove"]
    assert "No active workflow" in data["noWorkflowApprove"]
    assert "[LLM WORKFLOW ACTION]" in data["missingReviewPackageApprove"]
    assert "Current phase: code_review" in data["missingReviewPackageApprove"]


def test_workflow_extension_runtime_state_outputs_single_llm_action_block(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime single action block', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          const stateNotification = notifications[notifications.length - 1].text;
          console.log(JSON.stringify({ stateNotification }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["stateNotification"].count("[LLM WORKFLOW ACTION]") == 1
    assert "manual recovery only" in data["stateNotification"]


def test_workflow_extension_runtime_push_approve_does_not_complete_without_git_push(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime push approve no done', ctx);
          await pi.commands.workflow.handler('state push', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          await pi.commands.workflow.handler('status', ctx);
          const prompt = await pi.events.before_agent_start({ systemPrompt: 'base' });
          console.log(JSON.stringify({
            notifications: notifications.map((item) => item.text),
            prompt: prompt.systemPrompt,
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert "requires an observed successful git push" in joined
    assert "Workflow 전이: push → done" not in joined
    assert "Current phase: push" in joined
    assert "Current phase: push" in data["prompt"]


def test_workflow_extension_runtime_clears_active_workflow_after_successful_git_push(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime done cleanup', ctx);
          await pi.commands.workflow.handler('state push', ctx);
          await pi.events.tool_result({ toolName: 'bash', input: { command: 'git push origin HEAD' }, isError: false, content: [], details: {} }, ctx);
          await pi.commands.workflow.handler('status', ctx);
          const prompt = await pi.events.before_agent_start({ systemPrompt: 'base' });
          console.log(JSON.stringify({
            notifications: notifications.map((item) => item.text),
            prompt: prompt.systemPrompt,
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert "Workflow 전이: push → done" in joined
    assert "No active workflow" in joined
    assert "Current phase: done" not in data["prompt"]
    assert "Current phase: push" not in data["prompt"]
    assert "No active workflow" in data["prompt"]


def test_workflow_extension_runtime_auto_advances_low_risk_phase_boundaries(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime auto advance', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          await pi.commands.workflow.handler('state review_approved', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          console.log(JSON.stringify({ notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert "Workflow 전이: interview → plan → plan_review" in joined
    assert "Workflow 전이: review_approved → document → commit" in joined


def test_workflow_extension_runtime_does_not_queue_continuation_while_busy_after_auto_transition(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const sentMessages = [];
        const pi = {
          events: {},
          commands: {},
          tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage(text, options) { sentMessages.push({ text, options }); },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, isIdle: () => false, hasPendingMessages: () => false, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime continuation', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          console.log(JSON.stringify({ sentMessages, notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert len(data["sentMessages"]) == 1
    assert "현재 페이즈: interview" in data["sentMessages"][0]["text"]
    assert all("Continue the workflow from the current phase" not in item["text"] for item in data["sentMessages"])


def test_workflow_extension_runtime_busy_auto_transition_does_not_create_stale_continuation(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const sentMessages = [];
        const pi = {
          events: {},
          commands: {},
          tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage(text, options) { sentMessages.push({ text, options }); },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, isIdle: () => false, hasPendingMessages: () => false, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime stale continuation', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          console.log(JSON.stringify({ sentMessages }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert len(data["sentMessages"]) == 1
    assert "현재 페이즈: interview" in data["sentMessages"][0]["text"]
    assert all("Current phase: plan_review" not in item["text"] for item in data["sentMessages"])


def test_workflow_extension_runtime_skips_continuation_when_messages_pending(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const sentMessages = [];
        const pi = {
          events: {},
          commands: {},
          tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage(text, options) { sentMessages.push({ text, options }); },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, isIdle: () => false, hasPendingMessages: () => true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime pending continuation', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          console.log(JSON.stringify({ sentMessages }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["sentMessages"] == []


def test_workflow_extension_runtime_moves_implement_to_code_review_then_review_package_advances(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');
        process.env.HARNESS_CODE_QUALITY_GUARD_CMD = 'node -e "process.exit(0)"';

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime review automation', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const beforePackage = notifications.map((item) => item.text).join('\n');
          const tool = pi.tools.submit_review_package;
          const result = await tool.execute('review-1', {
            mainReviewSummary: 'Main self-review found no remaining blockers.',
            reviewerReviewSummary: 'Independent reviewer/subagent review found no critical or major issues.',
            qualityGateSummary: 'codeQualityGuard passed.',
            critical: 0,
            major: 0,
            minor: 1,
          }, undefined, undefined, ctx);
          console.log(JSON.stringify({ notifications: notifications.map((item) => item.text), beforePackage, toolResult: result.content[0].text, toolNames: Object.keys(pi.tools) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "submit_review_package" in data["toolNames"]
    assert "Workflow 전이: implement → code_review" in data["beforePackage"]
    assert "review_approved" not in data["beforePackage"]
    assert "Workflow 전이: code_review → review_approved → document → commit" in data["toolResult"]
    assert "Automated review approved" in data["toolResult"]


def test_extension_modification_requires_interactive_user_approval(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const confirms = [];
        const ctxApprove = { hasUI: true, ui: { notify: () => {}, confirm: async (title, text) => { confirms.push({ title, text }); return true; } } };
        const ctxNoUi = { hasUI: false, ui: { notify: () => {}, confirm: async () => { throw new Error('no ui'); } } };

        (async () => {
          const readResult = await pi.events.tool_call({ toolName: 'bash', input: { command: 'rg foo .pi/extensions/workflow.ts' } }, ctxApprove);
          const editResult = await pi.events.tool_call({ toolName: 'edit', input: { path: '.pi/extensions/workflow.ts', edits: [] } }, ctxApprove);
          const noUiResult = await pi.events.tool_call({ toolName: 'write', input: { path: '.pi/extensions/memory.ts', content: 'x' } }, ctxNoUi);
          console.log(JSON.stringify({
            readAllowed: readResult === undefined,
            editAllowed: editResult === undefined,
            noUiBlocked: Boolean(noUiResult && noUiResult.block),
            noUiReason: noUiResult && noUiResult.reason,
            confirmTitles: confirms.map((item) => item.title),
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["readAllowed"] is True
    assert data["editAllowed"] is True
    assert data["noUiBlocked"] is True
    assert "EXTENSION MODIFICATION APPROVAL REQUIRED" in data["noUiReason"]
    assert data["confirmTitles"] == ["Harness extension 수정 승인 확인"]


def test_commit_to_push_policy_confirmation_is_reused_for_git_push(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (project / "build.gradle").write_text("plugins {}\n", encoding="utf-8")

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir({json.dumps(str(project))});

        const extension = {json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))};
        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(extension).default(pi);

        const notifications = [];
        const confirms = [];
        const ctx = {{ hasUI: true, ui: {{ notify: (text, level) => notifications.push({{ text, level }}), confirm: async (title, text) => {{ confirms.push({{ title, text }}); return true; }} }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime push policy approval', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const pushResult = await pi.events.tool_call({{ toolName: 'bash', input: {{ command: 'git push origin HEAD' }} }}, ctx);
          console.log(JSON.stringify({{
            pushAllowed: pushResult === undefined,
            confirmTitles: confirms.map((item) => item.title),
            notifications: notifications.map((item) => item.text),
          }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["pushAllowed"] is True
    assert data["confirmTitles"].count("Push policy scan 승인 확인") == 1
    assert "Workflow state 수동 변경 승인 확인" in data["confirmTitles"]


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
          const result = await pi.tools.submit_review_package.execute('review-fail', {
            mainReviewSummary: 'Main self-review complete.',
            reviewerReviewSummary: 'Independent reviewer found no threshold blockers.',
            qualityGateSummary: 'codeQualityGuard attempted.',
            critical: 0,
            major: 0,
            minor: 0,
          }, undefined, undefined, ctx);
          console.log(JSON.stringify({ notifications: notifications.map((item) => item.text), toolResult: result.content[0].text }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"]) + "\n" + data["toolResult"]

    assert "CODE QUALITY GATE BLOCKED" in joined
    assert "Mechanical code quality guard failed" in joined
    assert "code_review → review_approved" in joined


def test_workflow_typo_suggestion_for_near_miss_slash_command(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          const typo = await pi.events.input({ source: 'interactive', text: '/workflot abort' }, ctx);
          const valid = await pi.events.input({ source: 'interactive', text: '/workflow status' }, ctx);
          const prose = await pi.events.input({ source: 'interactive', text: 'workflow looks good' }, ctx);
          console.log(JSON.stringify({ typo, valid, prose, notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["typo"]["action"] == "handled"
    assert data["valid"]["action"] == "continue"
    assert data["prose"]["action"] == "continue"
    assert any("/workflow abort" in item for item in data["notifications"])
    assert all("workflow looks good" not in item for item in data["notifications"])


def test_stale_phase_steer_message_is_consumed_after_phase_changes(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const sentMessages = [];
        const pi = {
          events: {}, commands: {}, tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage(text, options) { sentMessages.push({ text, options }); },
          getAllTools() { return [
            { name: 'read', sourceInfo: { source: 'builtin' } },
            { name: 'write', sourceInfo: { source: 'builtin' } },
            { name: 'edit', sourceInfo: { source: 'builtin' } },
            { name: 'bash', sourceInfo: { source: 'builtin' } },
            ...Object.keys(this.tools).map((name) => ({ name, sourceInfo: { source: 'extension' } })),
          ]; },
          setActiveTools(names) { this.activeTools = names; },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const ctx = { hasUI: true, hasPendingMessages: () => false, isIdle: () => false, ui: { notify: () => {}, confirm: async () => true, select: async (_m, options) => options[0], setStatus: () => {}, setWidget: () => {} } };

        (async () => {
          await pi.commands.workflow.handler('start stale steer workflow', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const editResult = await pi.events.tool_call({ toolName: 'edit', input: { path: 'src/app.txt', edits: [] } }, ctx);
          await pi.commands.workflow.handler('skip dpaa stale steer test', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          console.log(JSON.stringify({ editResult, sentMessages, phaseTools: pi.activeTools }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["editResult"]["block"] is True
    assert "plan_review 페이즈" in data["editResult"]["reason"]
    assert all("harness-workflow-steer" not in item["text"] for item in data["sentMessages"])
    assert "write" in data["phaseTools"]


def test_stale_code_review_steer_is_consumed_after_phase_advances_to_commit(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const sentMessages = [];
        const pi = {
          events: {}, commands: {}, tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage(text, options) { sentMessages.push({ text, options }); },
          getAllTools() { return [
            { name: 'read', sourceInfo: { source: 'builtin' } },
            { name: 'write', sourceInfo: { source: 'builtin' } },
            { name: 'edit', sourceInfo: { source: 'builtin' } },
            { name: 'bash', sourceInfo: { source: 'builtin' } },
            ...Object.keys(this.tools).map((name) => ({ name, sourceInfo: { source: 'extension' } })),
          ]; },
          setActiveTools(names) { this.activeTools = names; },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const ctx = { hasUI: true, hasPendingMessages: () => false, isIdle: () => false, ui: { notify: () => {}, confirm: async () => true, select: async (_m, options) => options[0], setStatus: () => {}, setWidget: () => {} } };

        (async () => {
          await pi.commands.workflow.handler('start stale review steer workflow', ctx);
          await pi.commands.workflow.handler('state code_review', ctx);
          const editResult = await pi.events.tool_call({ toolName: 'edit', input: { path: 'src/app.txt', edits: [] } }, ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          console.log(JSON.stringify({ editResult, sentMessages, phaseTools: pi.activeTools }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["editResult"]["block"] is True
    assert "code_review 페이즈" in data["editResult"]["reason"]
    assert all("harness-workflow-steer" not in item["text"] for item in data["sentMessages"])
    assert "workflow_approve" in data["phaseTools"]


def test_workflow_skip_gate_tool_allows_llm_to_record_interactive_skip_and_advance(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const confirms = [];
        const pi = {
          events: {}, commands: {}, tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage() {},
          getAllTools() { return [
            { name: 'read', sourceInfo: { source: 'builtin' } },
            { name: 'write', sourceInfo: { source: 'builtin' } },
            { name: 'edit', sourceInfo: { source: 'builtin' } },
            { name: 'bash', sourceInfo: { source: 'builtin' } },
            ...Object.keys(this.tools).map((name) => ({ name, sourceInfo: { source: 'extension' } })),
          ]; },
          setActiveTools(names) { this.activeTools = names; },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const ctx = { hasUI: true, hasPendingMessages: () => false, isIdle: () => false, ui: { notify: () => {}, confirm: async (text) => { confirms.push(text); return true; }, select: async (_m, options) => options[0], setStatus: () => {}, setWidget: () => {} } };

        (async () => {
          await pi.commands.workflow.handler('start skip tool workflow', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const skip = await pi.tools.workflow_skip_gate.execute('skip-1', {
            gate: 'dpaa',
            reason: 'DPAA false positive on deterministic contract plan test fixture.',
          }, undefined, undefined, ctx);
          const approved = await pi.tools.workflow_approve.execute('approve-1', { summary: 'Advance after explicit gate skip approval.' }, undefined, undefined, ctx);
          console.log(JSON.stringify({ toolNames: Object.keys(pi.tools), skip: skip.details, approved: approved.details, confirms, phaseTools: pi.activeTools }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "workflow_skip_gate" in data["toolNames"]
    assert data["skip"]["ok"] is True
    assert data["skip"]["gate"] == "dpaa"
    assert data["approved"]["ok"] is True
    assert "plan_review → implement" in data["approved"]["transitions"]
    assert any("Workflow gate skip 승인 확인" in item for item in data["confirms"])
    assert "workflow_approve" in data["phaseTools"] or "submit_review_package" in data["phaseTools"]


def test_no_ui_blocks_accepted_risk_and_destructive_workflow_commands(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const notifications = [];
        const pi = {
          events: {}, commands: {}, tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          sendUserMessage() {},
          getAllTools() { return [
            { name: 'read', sourceInfo: { source: 'builtin' } },
            { name: 'write', sourceInfo: { source: 'builtin' } },
            { name: 'edit', sourceInfo: { source: 'builtin' } },
            { name: 'bash', sourceInfo: { source: 'builtin' } },
            ...Object.keys(this.tools).map((name) => ({ name, sourceInfo: { source: 'extension' } })),
          ]; },
          setActiveTools(names) { this.activeTools = names; },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const ctx = {
          hasUI: false,
          hasPendingMessages: () => false,
          isIdle: () => false,
          ui: {
            notify: (text, level) => notifications.push({ text, level }),
            confirm: async () => { throw new Error('confirm must not be called without UI'); },
            setStatus: () => {},
            setWidget: () => {},
          },
        };

        (async () => {
          await pi.commands.workflow.handler('start no ui dangerous commands', ctx);
          const skipTool = await pi.tools.workflow_skip_gate.execute('skip-no-ui', {
            gate: 'dpaa',
            reason: 'no ui must not auto-approve accepted risk',
          }, undefined, undefined, ctx);
          await pi.commands.workflow.handler('skip dpaa no-ui-slash-skip', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          await pi.commands.workflow.handler('abort', ctx);
          await pi.commands.workflow.handler('status', ctx);
          console.log(JSON.stringify({ skipTool: skipTool.details, notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert data["skipTool"]["ok"] is False
    assert data["skipTool"]["reason"] == "no-ui"
    assert "대화형 UI가 없어 gate skip을 승인할 수 없습니다" in joined
    assert "대화형 UI가 없어 workflow state 수동 복구를 승인할 수 없습니다" in joined
    assert "대화형 UI가 없어 workflow 종료를 승인할 수 없습니다" in joined
    assert "Current phase: interview" in joined
