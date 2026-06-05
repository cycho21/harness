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
    assert "[Workflow Guard Evidence]" in data["prompt"]
    assert "Push transition evidence: present" in data["prompt"]


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


def test_workflow_extension_runtime_queues_continuation_after_auto_transition(tmp_path):
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

    assert len(data["sentMessages"]) == 2
    assert "현재 페이즈: interview" in data["sentMessages"][0]["text"]
    assert data["sentMessages"][1]["options"] == {"deliverAs": "followUp"}
    assert "Continue the workflow from the current phase" in data["sentMessages"][1]["text"]
    assert "Current phase: code_review" in data["sentMessages"][1]["text"]
    assert "Do not cross a user-approval boundary automatically" in data["sentMessages"][1]["text"]
    assert "harness-workflow-continuation:" in data["sentMessages"][1]["text"]


def test_workflow_extension_runtime_cancelled_continuation_prompt_is_consumed(tmp_path):
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
          const stalePrompt = sentMessages[0].text;
          await pi.commands.workflow.handler('state implement', ctx);
          const staleInputResult = await pi.events.input({ source: 'extension', text: stalePrompt }, ctx);
          console.log(JSON.stringify({ sentMessages, staleInputResult }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert len(data["sentMessages"]) == 2
    assert "현재 페이즈: interview" in data["sentMessages"][0]["text"]
    assert "Current phase: plan_review" in data["sentMessages"][1]["text"]
    assert data["staleInputResult"] == {"action": "handled"}


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
          await pi.events.tool_call({ toolName: 'edit', input: { path: 'src/app.txt', edits: [] } }, ctx);
          const staleText = sentMessages.find((item) => item.text.includes('plan_review 페이즈')).text;
          await pi.commands.workflow.handler('skip dpaa stale steer test', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const consumed = await pi.events.input({ source: 'extension', text: staleText }, ctx);
          console.log(JSON.stringify({ consumed, staleText, phaseTools: pi.activeTools }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["consumed"]["action"] == "handled"
    assert "harness-workflow-steer" in data["staleText"]
    assert "write" in data["phaseTools"]
