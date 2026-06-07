import json
import os
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PI_NODE_MODULES = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"


def _run_fake_llm_session(script: str, tmp_path: Path) -> dict:
    env = os.environ.copy()
    env["NODE_PATH"] = str(PI_NODE_MODULES)
    env["PI_CODING_AGENT_DIR"] = str(tmp_path / ".pi-agent")
    env["HARNESS_FIELD_LOG_ROOT"] = str(tmp_path / "field-log-root")
    env["HARNESS_POLICY_MAX_CHANGED_FILES"] = "500"
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=40,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _make_fake_llm_script(
    project: Path,
    body: str,
    *,
    confirm_answers: list[bool] | None = None,
    has_pending_messages: bool = False,
) -> str:
    """Build a deterministic fake LLM/Pi host around the real workflow extension."""

    template = r'''
    const fs = require('fs');
    const path = require('path');
    const { createJiti } = require('jiti');
    process.chdir(__PROJECT__);

    const extension = __EXTENSION__;
    const confirmAnswers = __CONFIRM_ANSWERS__;
    const sentMessages = [];
    const notifications = [];
    const confirms = [];
    const statuses = [];
    const widgets = [];
    const pi = {
      events: {},
      commands: {},
      tools: {},
      on(name, fn) { this.events[name] = fn; },
      registerCommand(name, spec) { this.commands[name] = spec; },
      registerTool(spec) { this.tools[spec.name] = spec; },
      sendUserMessage(text, options) { sentMessages.push({ text, options }); },
      setSessionName(name) { this.sessionName = name; },
      getAllTools() {
        return [
          { name: 'read', sourceInfo: { source: 'builtin' } },
          { name: 'write', sourceInfo: { source: 'builtin' } },
          { name: 'edit', sourceInfo: { source: 'builtin' } },
          { name: 'bash', sourceInfo: { source: 'builtin' } },
          ...Object.keys(this.tools).map((name) => ({ name, sourceInfo: { source: 'extension' } })),
        ];
      },
      setActiveTools(names) { this.activeTools = names; },
    };
    const jiti = createJiti(path.resolve('fake-llm-session.js'), { interopDefault: false });
    jiti(extension).default(pi);

    const ctx = {
      hasUI: true,
      hasPendingMessages: () => __HAS_PENDING_MESSAGES__,
      isIdle: () => false,
      ui: {
        notify: (text, level) => notifications.push({ text, level }),
        confirm: async (title, text) => {
          const answer = confirmAnswers.length > 0 ? confirmAnswers.shift() : true;
          confirms.push({ title, text, answer });
          return answer;
        },
        select: async (_message, options) => options[0],
        setStatus: (key, value) => statuses.push({ key, value }),
        setWidget: (key, value) => widgets.push({ key, hasValue: Boolean(value) }),
      },
    };

    async function command(args) { return pi.commands.workflow.handler(args, ctx); }
    async function tool(name, params) { return pi.tools[name].execute(`${name}-1`, params, undefined, undefined, ctx); }
    async function toolCall(toolName, input) { return pi.events.tool_call({ toolName, input }, ctx); }
    async function toolResult(toolName, input, isError = false) { return pi.events.tool_result?.({ toolName, input, isError, content: [], details: {} }, ctx); }
    async function beforeAgentStart(systemPrompt = 'base') { return pi.events.before_agent_start({ systemPrompt }); }
    function textOf(result) { return result.content?.[0]?.text ?? ''; }
    function fileText(relPath) { return fs.existsSync(relPath) ? fs.readFileSync(relPath, 'utf-8') : null; }
    function dump(extra) {
      console.log(JSON.stringify({
        ...extra,
        activeTools: pi.activeTools,
        sentMessages,
        sentMessageCount: sentMessages.length,
        notificationText: notifications.map((item) => item.text).join('\n'),
        confirmTitles: confirms.map((item) => item.title),
        confirmAnswersSeen: confirms.map((item) => item.answer),
        statusUpdates: statuses.length,
        widgetUpdates: widgets.length,
      }));
    }

    (async () => {
    __BODY__
    })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
    '''
    return textwrap.dedent(template).replace("__PROJECT__", json.dumps(str(project))).replace(
        "__EXTENSION__", json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))
    ).replace("__CONFIRM_ANSWERS__", json.dumps(confirm_answers or [])).replace(
        "__HAS_PENDING_MESSAGES__", "true" if has_pending_messages else "false"
    ).replace("__BODY__", textwrap.indent(body.strip(), "      "))


def _init_project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (project / "README.md").write_text("# fake llm project\n", encoding="utf-8")
    return project


def test_fake_llm_agent_loop_drives_full_workflow_and_recovers_from_bad_actions(tmp_path):
    """Replay a full fake-assistant workflow against the real Pi extension."""
    project = _init_project(tmp_path)
    script = _make_fake_llm_script(
        project,
        r'''
        const observations = {};
        await command('start Fake LLM full workflow');
        await command('approve'); // interview -> plan -> plan_review

        observations.toolsPlanReview = pi.activeTools;
        observations.planReviewEdit = await toolCall('edit', { path: 'src/app.txt', edits: [] });
        const planReviewPropose = await tool('workflow_propose_edit', {
          summary: 'bad wrong-phase edit proposal',
          edits: [{ path: 'src/app.txt', operation: 'write', content: 'bad', reason: 'should be blocked' }],
        });
        observations.planReviewPropose = planReviewPropose.details;
        observations.planReviewProposeText = textOf(planReviewPropose);
        observations.prePush = await toolCall('bash', { command: 'git push origin HEAD' });

        await command('skip dpaa fake e2e avoids expensive DPAA/SBADR setup');
        await command('approve'); // plan_review -> implement
        observations.toolsImplement = pi.activeTools;

        const propose = await tool('workflow_propose_edit', {
          summary: 'Create app file from approved fake implementation plan',
          edits: [{
            path: 'src/app.txt',
            operation: 'write',
            content: 'hello from fake llm workflow\n',
            reason: 'implement the approved fake feature',
          }],
        });
        observations.propose = propose.details;
        const apply = await tool('workflow_apply_approved_edit', { scopeId: propose.details.scopeId });
        observations.apply = apply.details;

        const gitStatus = await tool('workflow_run_command', { commandId: 'git-status', reason: 'verify working tree after fake edit' });
        observations.gitStatus = gitStatus.details;

        await command('approve'); // implement -> code_review, then stop for review package
        observations.toolsCodeReview = pi.activeTools;
        const prematureApprove = await tool('workflow_approve', { reason: 'fake assistant tries to skip submit_review_package' });
        observations.prematureApprove = prematureApprove.details;
        observations.prematureApproveText = textOf(prematureApprove);

        const review = await tool('submit_review_package', {
          mainReviewSummary: 'Fake main self-review found no blockers.',
          reviewerReviewSummary: 'Fake independent reviewer found no critical or major issues.',
          qualityGateSummary: 'No project quality gate configured in temp repo; guard skipped by runtime.',
          critical: 0,
          major: 0,
          minor: 0,
        });
        observations.review = review.details;
        observations.reviewText = textOf(review);
        observations.toolsCommit = pi.activeTools;

        observations.commitPush = await toolCall('bash', { command: 'git push origin HEAD' });
        await command('approve'); // commit -> push
        observations.toolsPush = pi.activeTools;
        observations.push = await toolCall('bash', { command: 'git push origin HEAD' });
        await toolResult('bash', { command: 'git push origin HEAD' }, false);

        const prompt = await beforeAgentStart('base');
        dump({ observations, appFile: fileText('src/app.txt'), prompt: prompt.systemPrompt });
        ''',
    )

    data = _run_fake_llm_session(script, tmp_path)
    observations = data["observations"]

    assert "edit" not in observations["toolsPlanReview"]
    assert "workflow_propose_edit" in observations["toolsImplement"]
    assert "submit_review_package" in observations["toolsCodeReview"]
    assert "workflow_approve" in observations["toolsCommit"]
    assert "bash" in observations["toolsPush"]

    assert observations["planReviewEdit"]["block"] is True
    assert "plan_review 페이즈" in observations["planReviewEdit"]["reason"]
    assert observations["planReviewPropose"]["ok"] is False
    assert observations["planReviewPropose"]["reason"] == "phase-not-allowed"
    assert observations["prePush"]["block"] is True
    assert "current phase" in observations["prePush"]["reason"]
    assert "required phase" in observations["prePush"]["reason"]

    assert observations["propose"]["ok"] is True
    assert observations["apply"]["ok"] is True
    assert observations["gitStatus"]["ok"] is True
    assert observations["prematureApprove"]["ok"] is False
    assert "submit_review_package" in observations["prematureApproveText"]
    assert observations["review"]["ok"] is True
    assert observations["review"]["workflowPhase"] == "commit"
    assert observations["commitPush"]["block"] is True
    assert 'current phase is "commit"' in observations["commitPush"]["reason"]
    assert "push" not in observations  # undefined from JS means allowed and is omitted by JSON.stringify

    assert data["appFile"] == "hello from fake llm workflow\n"
    assert "No active workflow" in data["prompt"]
    assert "Current phase: push" not in data["prompt"]
    assert "bash" in data["activeTools"]
    assert all(item.get("options") != {"deliverAs": "followUp"} for item in data["sentMessages"])
    assert data["statusUpdates"] > 0
    assert data["widgetUpdates"] > 0
    assert "Workflow gate skip 승인 확인" in data["confirmTitles"]
    assert "Review package accepted" in data["notificationText"] or observations["review"]["ok"]


def test_fake_llm_edit_approval_rejection_path_validation_and_scope_guard(tmp_path):
    """Cover the edit-scope failure paths an LLM is likely to hit."""
    project = _init_project(tmp_path)
    script = _make_fake_llm_script(
        project,
        r'''
        const observations = {};
        await command('start Fake LLM edit guard workflow');
        await command('approve');
        await command('skip dpaa fake edit guard setup');
        await command('approve'); // implement

        const rejected = await tool('workflow_propose_edit', {
          summary: 'User rejects this edit',
          edits: [{ path: 'src/rejected.txt', operation: 'write', content: 'nope\n', reason: 'exercise rejection' }],
        });
        observations.rejected = rejected.details;
        observations.rejectedText = textOf(rejected);

        const invalidScope = await tool('workflow_apply_approved_edit', { scopeId: 'not-a-real-scope' });
        observations.invalidScope = invalidScope.details;
        observations.invalidScopeText = textOf(invalidScope);

        const traversal = await tool('workflow_propose_edit', {
          summary: 'Path traversal must be rejected',
          edits: [{ path: '../escape.txt', operation: 'write', content: 'escape\n', reason: 'malicious or mistaken path' }],
        });
        observations.traversal = traversal.details;
        observations.traversalText = textOf(traversal);

        const badOperation = await tool('workflow_propose_edit', {
          summary: 'Invalid operation must be rejected',
          edits: [{ path: 'src/app.txt', operation: 'append', content: 'bad\n', reason: 'unsupported operation' }],
        });
        observations.badOperation = badOperation.details;
        observations.badOperationText = textOf(badOperation);

        dump({ observations, rejectedFile: fileText('src/rejected.txt'), escapeFile: fileText('../escape.txt') });
        ''',
        confirm_answers=[True, True, True, False],
    )

    data = _run_fake_llm_session(script, tmp_path)
    observations = data["observations"]

    assert observations["rejected"]["ok"] is False
    assert observations["rejected"]["reason"] == "user-rejected"
    assert "Do not apply" in observations["rejectedText"]
    assert observations["invalidScope"]["ok"] is False
    assert observations["invalidScope"]["reason"] == "scope-not-found"
    assert observations["traversal"]["ok"] is False
    assert observations["traversal"]["reason"] == "path-validation-failed"
    assert "Path validation failed" in observations["traversalText"]
    assert observations["badOperation"]["ok"] is False
    assert observations["badOperation"]["reason"] == "path-validation-failed"
    assert "Invalid operation" in observations["badOperationText"]
    assert data["rejectedFile"] is None
    assert data["escapeFile"] is None
    assert data["confirmAnswersSeen"] == [True, True, True, False]


def test_fake_llm_review_package_rejects_missing_and_blocking_findings_before_accepting(tmp_path):
    """Review package must be complete and below blocking severity thresholds."""
    project = _init_project(tmp_path)
    script = _make_fake_llm_script(
        project,
        r'''
        const observations = {};
        await command('start Fake LLM review guard workflow');
        await command('approve');
        await command('skip dpaa fake review guard setup');
        await command('approve'); // implement
        await command('approve'); // code_review

        const missing = await tool('submit_review_package', {
          mainReviewSummary: '',
          reviewerReviewSummary: 'Reviewer checked the change.',
          qualityGateSummary: 'Quality gate passed.',
          critical: 0,
          major: 0,
          minor: 0,
        });
        observations.missing = missing.details;
        observations.missingText = textOf(missing);

        const blocking = await tool('submit_review_package', {
          mainReviewSummary: 'Main review found unresolved issues.',
          reviewerReviewSummary: 'Independent reviewer found too many major issues.',
          qualityGateSummary: 'Quality gate result captured.',
          critical: 0,
          major: 3,
          minor: 1,
        });
        observations.blocking = blocking.details;
        observations.blockingText = textOf(blocking);

        const accepted = await tool('submit_review_package', {
          mainReviewSummary: 'Main self-review fixed previous issues.',
          reviewerReviewSummary: 'Independent reviewer reports no critical and at most two major issues.',
          qualityGateSummary: 'codeQualityGuard passed after fixes.',
          critical: 0,
          major: 2,
          minor: 4,
        });
        observations.accepted = accepted.details;
        observations.acceptedText = textOf(accepted);

        dump({ observations });
        ''',
    )

    observations = _run_fake_llm_session(script, tmp_path)["observations"]

    assert observations["missing"]["ok"] is False
    assert "required" in observations["missingText"]
    assert observations["blocking"]["ok"] is False
    assert observations["blocking"]["major"] == 3
    assert "Return to implement" in observations["blockingText"]
    assert observations["accepted"]["ok"] is True
    assert observations["accepted"]["workflowPhase"] == "commit"
    assert "code_review" in observations["acceptedText"]
    assert "review_approved" in observations["acceptedText"]
    assert "document" in observations["acceptedText"]
    assert "commit" in observations["acceptedText"]


def test_fake_llm_startup_does_not_inject_interview_when_user_message_is_pending(tmp_path):
    """A pending user message should suppress automatic kickoff prompt injection."""
    project = _init_project(tmp_path)
    script = _make_fake_llm_script(
        project,
        r'''
        await command('start Pending message workflow');
        const prompt = await beforeAgentStart('base prompt');
        dump({ prompt: prompt.systemPrompt });
        ''',
        has_pending_messages=True,
    )

    data = _run_fake_llm_session(script, tmp_path)

    assert data["sentMessageCount"] == 0
    assert "base prompt" in data["prompt"]
    assert "LLM WORKFLOW ACTION" in data["prompt"]
    assert "Start interview now" not in data["prompt"]
