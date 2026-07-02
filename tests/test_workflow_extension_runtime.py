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


def test_ambiguity_gate_policy_classification_runtime(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        const { classifyAmbiguityGatePolicy } = jiti(path.resolve('target/.pi/extensions/workflow/domain/ambiguity-gate-policy.ts'));
        const wf = (title) => ({ id: 'wf', title, phase: 'plan_review', cwd: process.cwd(), gitRoot: process.cwd(), branch: 'main', history: [], undone: [], startedAt: Date.now(), updatedAt: Date.now() });
        const withReadmeVerification = [
          '# Plan',
          '- Implement user profile behavior.',
          '- Verification: tests pass.',
          '- Verification: README updated.',
        ].join('\n');
        const explicitAdvisoryPlan = [
          '---',
          'Risk: low',
          'Work type: docs',
          'Ambiguity gate: advisory',
          '---',
          '# Plan',
          '- Update API documentation wording only.',
        ].join('\n');
        const explicitStrictPlan = [
          'Risk: high',
          'Work type: migration',
          '# Plan',
          '- Rename copy in README.',
        ].join('\n');
        const conflictingHighRiskPlan = [
          'Risk: high',
          'Work type: security',
          'Ambiguity gate: advisory',
          '# Plan',
          '- Change auth token handling.',
        ].join('\n');
        const compoundStrictWorkTypePlan = [
          'Risk: low',
          'Work type: data migration',
          '# Plan',
          '- Move account rows to the new table.',
        ].join('\n');
        console.log(JSON.stringify({
          readmeTypo: classifyAmbiguityGatePolicy(wf('Fix README typo')).strictness,
          investigation: classifyAmbiguityGatePolicy(wf('Investigate flaky test')).strictness,
          featureWithReadmeVerification: classifyAmbiguityGatePolicy(wf('Add user profile feature'), withReadmeVerification).strictness,
          apiEndpoint: classifyAmbiguityGatePolicy(wf('Add API endpoint')).strictness,
          databaseMigration: classifyAmbiguityGatePolicy(wf('Run database migration')).strictness,
          securityToken: classifyAmbiguityGatePolicy(wf('Update security token handling')).strictness,
          explicitAdvisoryMetadata: classifyAmbiguityGatePolicy(wf('Update API documentation'), explicitAdvisoryPlan).strictness,
          explicitStrictMetadata: classifyAmbiguityGatePolicy(wf('README copy edit'), explicitStrictPlan).strictness,
          conflictingHighRiskMetadata: classifyAmbiguityGatePolicy(wf('Auth token update'), conflictingHighRiskPlan).strictness,
          compoundStrictWorkType: classifyAmbiguityGatePolicy(wf('Move account data'), compoundStrictWorkTypePlan).strictness,
        }));
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["readmeTypo"] == "advisory"
    assert data["investigation"] == "advisory"
    assert data["featureWithReadmeVerification"] == "standard"
    assert data["apiEndpoint"] == "strict"
    assert data["databaseMigration"] == "strict"
    assert data["securityToken"] == "strict"
    assert data["explicitAdvisoryMetadata"] == "advisory"
    assert data["explicitStrictMetadata"] == "strict"
    assert data["conflictingHighRiskMetadata"] == "strict"
    assert data["compoundStrictWorkType"] == "strict"


def test_production_class_policy_handles_relative_and_absolute_paths(tmp_path):
    project = tmp_path / "project"
    service = project / "src" / "main" / "java" / "com" / "example" / "FooService.java"
    dto = project / "src" / "main" / "java" / "com" / "example" / "dto" / "FooDto.java"
    exact_test = project / "src" / "test" / "java" / "com" / "example" / "FooServiceTest.java"
    integration_test = project / "src" / "test" / "java" / "com" / "example" / "FooServiceIntegrationTest.java"
    service.parent.mkdir(parents=True)
    dto.parent.mkdir(parents=True)
    exact_test.parent.mkdir(parents=True)
    integration_test.write_text("class FooServiceIntegrationTest {}\n", encoding="utf-8")
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const {{ isProductionClassPath, expectedProductionTestPath, hasProductionClassTestCoverage, decideProductionClassTddGate }} = jiti(path.resolve('target/.pi/extensions/workflow/domain/production-class-policy.ts'));
        const gitRoot = {json.dumps(str(project))};
        console.log(JSON.stringify({{
          relativeService: isProductionClassPath('src/main/java/com/example/FooService.java', gitRoot),
          absoluteService: isProductionClassPath({json.dumps(str(service))}, gitRoot),
          dtoExcluded: isProductionClassPath({json.dumps(str(dto))}, gitRoot),
          testClassExcluded: isProductionClassPath('src/test/java/com/example/FooServiceTest.java', gitRoot),
          expectedTestPath: expectedProductionTestPath('src/main/java/com/example/FooService.java', gitRoot).replace(/\\/g, '/'),
          relatedIntegrationTestCounts: hasProductionClassTestCoverage('src/main/java/com/example/FooService.java', gitRoot),
          missingRelatedTest: hasProductionClassTestCoverage('src/main/java/com/example/BarService.java', gitRoot),
          newClassWithoutTest: decideProductionClassTddGate({{ className: 'BarService', testPath: 'BarServiceTest.java', isNewFile: true, hasTestCoverage: false }}).action,
          existingClassWithoutTest: decideProductionClassTddGate({{ className: 'BarService', testPath: 'BarServiceTest.java', isNewFile: false, hasTestCoverage: false }}).action,
          classWithCoverage: decideProductionClassTddGate({{ className: 'FooService', testPath: 'FooServiceTest.java', isNewFile: true, hasTestCoverage: true }}).action,
        }}));
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["relativeService"] is True
    assert data["absoluteService"] is True
    assert data["dtoExcluded"] is False
    assert data["testClassExcluded"] is False
    assert data["expectedTestPath"].endswith("src/test/java/com/example/FooServiceTest.java")
    assert data["relatedIntegrationTestCounts"] is True
    assert data["missingRelatedTest"] is False
    assert data["newClassWithoutTest"] == "block"
    assert data["existingClassWithoutTest"] == "block"
    assert data["classWithCoverage"] == "allow"


def test_tdd_preflight_blocks_production_edit_until_related_test_evidence(tmp_path):
    project = tmp_path / "project"
    service = project / "src" / "main" / "java" / "com" / "example" / "FooService.java"
    service.parent.mkdir(parents=True)
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const {{ createWorkflowRuntimeState }} = jiti(path.resolve('target/.pi/extensions/workflow/runtime-state.ts'));
        const {{ handleWorkflowToolCall, handleWorkflowToolResult }} = jiti(path.resolve('target/.pi/extensions/workflow/application/tool-call-gate.ts'));
        const gitRoot = {json.dumps(str(project))};
        const state = createWorkflowRuntimeState();
        state.workflow = {{ id: 'wf-tdd', title: 'TDD preflight', phase: 'implement', cwd: gitRoot, gitRoot, branch: 'main', history: [], undone: [], startedAt: Date.now(), updatedAt: Date.now() }};
        const steers = [];
        const deps = {{ steerLlm: async (message, deliverAs) => steers.push({{ message, deliverAs }}) }};
        const ctx = {{ hasUI: false, ui: {{ confirm: async () => false }} }};

        (async () => {{
          const firstProduction = await handleWorkflowToolCall(state, {{ toolName: 'write', input: {{ path: 'src/main/java/com/example/FooService.java', content: 'class FooService {{}}' }} }}, ctx, deps);
          const failedTestCall = await handleWorkflowToolCall(state, {{ toolName: 'write', input: {{ path: 'src/test/java/com/example/FooServiceTest.java', content: 'class FooServiceTest {{}}' }} }}, ctx, deps);
          await handleWorkflowToolResult(state, {{ toolName: 'write', input: {{ path: 'src/test/java/com/example/FooServiceTest.java' }}, isError: true }});
          const stillBlocked = await handleWorkflowToolCall(state, {{ toolName: 'write', input: {{ path: 'src/main/java/com/example/FooService.java', content: 'class FooService {{}}' }} }}, ctx, deps);
          const testWrite = await handleWorkflowToolCall(state, {{ toolName: 'write', input: {{ path: 'src/test/java/com/example/FooServiceTest.java', content: 'class FooServiceTest {{}}' }} }}, ctx, deps);
          await handleWorkflowToolResult(state, {{ toolName: 'write', input: {{ path: 'src/test/java/com/example/FooServiceTest.java' }}, isError: false }});
          const secondProduction = await handleWorkflowToolCall(state, {{ toolName: 'write', input: {{ path: 'src/main/java/com/example/FooService.java', content: 'class FooService {{}}' }} }}, ctx, deps);
          const dtoWrite = await handleWorkflowToolCall(state, {{ toolName: 'write', input: {{ path: 'src/main/java/com/example/dto/FooDto.java', content: 'class FooDto {{}}' }} }}, ctx, deps);
          console.log(JSON.stringify({{
            firstBlocked: Boolean(firstProduction && firstProduction.block),
            firstReason: firstProduction ? firstProduction.reason : '',
            failedTestAllowed: failedTestCall === undefined,
            stillBlockedAfterFailedTest: Boolean(stillBlocked && stillBlocked.block),
            testAllowed: testWrite === undefined,
            secondAllowed: secondProduction === undefined,
            dtoAllowed: dtoWrite === undefined,
            evidence: state.tddTestEvidence,
            steers,
          }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["firstBlocked"] is True
    assert "do not ask" in data["firstReason"]
    assert "pre-approved" in data["firstReason"]
    assert "not scope expansion" in data["firstReason"]
    assert "Next action" in data["firstReason"]
    assert data["failedTestAllowed"] is True
    assert data["stillBlockedAfterFailedTest"] is True
    assert data["testAllowed"] is True
    assert data["secondAllowed"] is True
    assert data["dtoAllowed"] is True
    assert data["evidence"]


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
    assert data["pushAllowed"] is False
    assert "Workflow state 수동 변경 승인 확인" in data["confirmTitles"]
    assert any("guard evidence 복구 없음" in item for item in data["notifications"])
    assert not any("Workflow 전이: push → done" in item for item in data["notifications"])
    assert "Current phase: push" in data["prompt"]


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


def test_workflow_extension_runtime_status_omits_conditional_protocol_hints_without_triggers(tmp_path):
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
          await pi.commands.workflow.handler('start Runtime no protocol hints', ctx);
          await pi.commands.workflow.handler('status', ctx);
          console.log(JSON.stringify({ status: notifications[notifications.length - 1].text }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "Conditional protocol hints" not in data["status"]


def test_workflow_extension_runtime_status_surfaces_evidence_verification_when_commit_lacks_recent_checks(tmp_path):
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
          await pi.commands.workflow.handler('start Runtime evidence hint', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          await pi.commands.workflow.handler('status', ctx);
          console.log(JSON.stringify({ status: notifications[notifications.length - 1].text }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "Conditional protocol hints (triggered only):" in data["status"]
    assert "no recent verification evidence" in data["status"]
    assert "evidence-verification" in data["status"]


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


def test_workflow_extension_runtime_blocks_cd_and_git_shell_chains_during_workflow(tmp_path):
    script = textwrap.dedent(
        r'''
        const fs = require('fs');
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const sentMessages = [];
        const ctx = { hasUI: true, ui: { notify: () => {}, confirm: async () => true } };
        pi.requestAttention = async (payload) => { sentMessages.push(payload.message); };

        (async () => {
          await pi.commands.workflow.handler('start Runtime cd git chain block', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          const result = await pi.events.tool_call({ toolName: 'bash', input: { command: 'cd ../target && env FOO=1 git status --short' } }, ctx);
          const addResult = await pi.events.tool_call({ toolName: 'bash', input: { command: 'cd ../target && git add README.md' } }, ctx);
          const eventsPath = path.join(process.env.HARNESS_FIELD_LOG_ROOT, '.project-memory', 'harness', 'events.jsonl');
          const events = fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, 'utf-8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const shellChainEvent = events.reverse().find((event) => event.failure?.summary === 'Shell cd/git chain was blocked during an active workflow.');
          console.log(JSON.stringify({ result, addResult, sentMessages, shellChainEvent }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["result"]["block"] is True
    assert "cd ... && git" in data["result"]["reason"]
    assert "workflow_run_command" in data["result"]["reason"]
    assert "git-status" in data["result"]["reason"]
    assert data["addResult"]["block"] is True
    assert "git-add-all" not in data["addResult"]["reason"]
    assert "path-specific git add" in data["addResult"]["reason"]
    assert data["shellChainEvent"]["event"]["severity"] == "major"


def test_workflow_extension_runtime_git_push_catalog_command_completes_push_phase(tmp_path):
    repo = tmp_path / "repo"
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "init", str(repo)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (repo / "README.md").write_text("# Push catalog test\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "commit", "-m", "test: initial"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["git", "push", "-u", "origin", "main"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir({json.dumps(str(repo))});
        process.env.HARNESS_POLICY_MAX_CHANGED_FILES = '500';

        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))}).default(pi);

        const notifications = [];
        const ctx = {{ hasUI: true, ui: {{ notify: (text, level) => notifications.push({{ text, level }}), confirm: async () => true, setWidget() {{}}, setStatus() {{}} }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime catalog push cleanup', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const push = await pi.tools.workflow_run_command.execute('push-1', {{ commandId: 'git-push', reason: 'runtime push catalog completion test' }}, undefined, undefined, ctx);
          await pi.commands.workflow.handler('status', ctx);
          const prompt = await pi.events.before_agent_start({{ systemPrompt: 'base' }});
          console.log(JSON.stringify({{
            push: push.details,
            notifications: notifications.map((item) => item.text),
            prompt: prompt.systemPrompt,
          }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"])

    assert data["push"]["ok"] is True
    assert "Workflow 전이: push → done" in joined
    assert "No active workflow" in joined
    assert "No active workflow" in data["prompt"]


def test_workflow_extension_runtime_clears_active_workflow_after_successful_git_push(tmp_path):
    project = tmp_path / "clean-project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir('target');

        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);
        process.chdir({json.dumps(str(project))});

        const notifications = [];
        const ctx = {{ hasUI: true, ui: {{ notify: (text, level) => notifications.push({{ text, level }}), confirm: async () => true }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime done cleanup', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          await pi.events.tool_result({{ toolName: 'bash', input: {{ command: 'git push origin HEAD' }}, isError: false, content: [], details: {{}} }}, ctx);
          await pi.commands.workflow.handler('status', ctx);
          const prompt = await pi.events.before_agent_start({{ systemPrompt: 'base' }});
          console.log(JSON.stringify({{
            notifications: notifications.map((item) => item.text),
            prompt: prompt.systemPrompt,
          }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
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
          await pi.commands.workflow.handler('skip interview-ambiguity test skip', ctx);
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


def test_workflow_extension_runtime_interview_wizard_uses_baseline_without_automatic_scaffold(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const captured = { questions: [], widgetUpdates: 0 };
        const notifications = [];
        const ctx = {
          hasUI: true,
          ui: {
            notify: (text, level) => notifications.push({ text, level }),
            confirm: async () => true,
            setWidget: () => { captured.widgetUpdates += 1; },
            custom: async (factory) => {
              const donePromise = new Promise((resolve) => {
                const widget = factory({ requestRender() {} }, {}, {}, resolve);
                captured.questions = widget.questions.map((q) => ({ id: q.id, title: q.title, prompt: q.prompt, helpText: q.helpText, choices: q.choices, allowFreeText: q.allowFreeText, allowSkip: q.allowSkip }));
                widget.handleInput(' ');
                widget.handleInput('n');
                resolve({
                  completed: true,
                  summaryMarkdown: '## Interview Summary\n- captured',
                  answers: captured.questions.map((q) => ({ questionId: q.id, selectedChoiceIds: [], freeText: 'answer', skipped: false })),
                });
              });
              return await donePromise;
            },
          },
        };
        const baseline = ['scope', 'motivation', 'acceptance', 'modules', 'constraints'].map((id) => ({
          id,
          title: id,
          prompt: `question ${id}`,
          helpText: `help ${id}`,
          required: true,
          choices: [{ id: `${id}_choice`, label: id }],
        }));

        (async () => {
          await pi.commands.workflow.handler('start Runtime interview wizard', ctx);
          const result = await pi.tools.workflow_interview_wizard.execute('call-1', { questions: baseline }, undefined, undefined, ctx);
          console.log(JSON.stringify({
            ids: captured.questions.map((q) => q.id),
            first: captured.questions[0],
            last: captured.questions[captured.questions.length - 1],
            ok: result.details.ok,
            mode: result.details.mode,
            text: result.content[0].text,
            widgetUpdates: captured.widgetUpdates,
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["ids"] == ["scope", "motivation", "acceptance", "modules", "constraints"]
    assert "round_0_topology" not in data["ids"]
    assert "clarity_checkpoint" not in data["ids"]
    assert data["first"]["id"] == "scope"
    assert data["last"]["id"] == "constraints"
    assert data["first"]["allowFreeText"] is True
    assert data["first"]["allowSkip"] is False
    assert data["last"]["allowFreeText"] is True
    assert data["last"]["allowSkip"] is False
    assert data["ok"] is True
    assert data["mode"] == "deep-interview-lite"
    assert "weakest clarity dimension" in data["text"]
    assert data["widgetUpdates"] >= 3


def test_workflow_extension_runtime_interview_wizard_renders_recommended_choice_without_auto_select(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const captured = { rendered: '', selectedBeforeInput: [] };
        const ctx = {
          hasUI: true,
          ui: {
            notify: () => {},
            confirm: async () => true,
            setWidget: () => {},
            custom: async (factory) => {
              return await new Promise((resolve) => {
                const theme = { fg: (_kind, text) => text };
                const widget = factory({ requestRender() {} }, theme, {}, resolve);
                captured.rendered = widget.render(160).join('\n');
                captured.selectedBeforeInput = widget.answers[0].selectedChoiceIds;
                resolve({
                  completed: true,
                  summaryMarkdown: '## Interview Summary\n- captured',
                  answers: widget.answers,
                });
              });
            },
          },
        };
        const baseline = [{
          id: 'scope',
          title: 'Scope',
          prompt: 'Choose a direction',
          helpText: 'Recommended choices are advisory.',
          required: true,
          choices: [
            { id: 'recommended', label: 'Schema/type/UI support', recommended: true, recommendationReason: 'Backward compatible contract.' },
            { id: 'plain', label: 'Plain label-only choice' },
          ],
        }];

        (async () => {
          await pi.commands.workflow.handler('start Runtime recommended choice', ctx);
          await pi.tools.workflow_interview_wizard.execute('call-1', { questions: baseline }, undefined, undefined, ctx);
          console.log(JSON.stringify(captured));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "[추천]" in data["rendered"]
    assert "Backward compatible contract." in data["rendered"]
    assert data["selectedBeforeInput"] == []


def test_workflow_extension_runtime_interview_wizard_followup_does_not_repeat_topology_scaffold(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const captured = { questions: [] };
        const ctx = {
          hasUI: true,
          ui: {
            notify: () => {},
            confirm: async () => true,
            setWidget: () => {},
            custom: async (factory) => {
              return await new Promise((resolve) => {
                const widget = factory({ requestRender() {} }, {}, {}, resolve);
                captured.questions = widget.questions.map((q) => ({ id: q.id, title: q.title }));
                resolve({
                  completed: true,
                  summaryMarkdown: '## Follow-up Summary\n- captured',
                  answers: captured.questions.map((q) => ({ questionId: q.id, selectedChoiceIds: [], freeText: 'answer', skipped: false })),
                });
              });
            },
          },
        };
        const followup = [{
          id: 'acceptance_followup',
          title: 'Acceptance follow-up',
          prompt: 'What exact pass/fail evidence should prove this work is done?',
          helpText: 'Example: named tests pass and the prompt no longer repeats topology.',
          required: true,
          choices: [{ id: 'tests', label: '테스트 통과' }, { id: 'manual', label: '수동 확인' }],
        }];

        (async () => {
          await pi.commands.workflow.handler('start Runtime interview followup', ctx);
          await pi.tools.workflow_interview_wizard.execute('call-1', { questions: followup, round: 'follow_up' }, undefined, undefined, ctx);
          console.log(JSON.stringify({ ids: captured.questions.map((q) => q.id) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["ids"] == ["acceptance_followup"]


def test_workflow_extension_runtime_trace_command_sends_runtime_trace_prompt(tmp_path):
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
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime trace context', ctx);
          await pi.commands.workflow.handler('trace DPAA blocked after plan review', ctx);
          console.log(JSON.stringify({ sentMessages, notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    trace_messages = [item["text"] for item in data["sentMessages"] if "Run the harness trace protocol" in item["text"]]

    assert len(trace_messages) == 1
    trace = trace_messages[0]
    assert "Observation:\nDPAA blocked after plan review" in trace
    assert "Active workflow: [interview] Runtime trace context" in trace
    assert "Evidence For/Against" in trace
    assert "Discriminating Probe" in trace
    assert "Do not edit files during trace" in trace


def test_workflow_extension_runtime_trace_command_warns_when_observation_is_missing(tmp_path):
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
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('trace', ctx);
          console.log(JSON.stringify({ sentMessages, notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["sentMessages"] == []
    assert any("사용법: /workflow trace <관찰된 실패/이상 동작>" in item for item in data["notifications"])


def test_workflow_extension_runtime_trace_command_warns_when_send_user_message_is_unavailable(tmp_path):
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
          await pi.commands.workflow.handler('trace DPAA failed', ctx);
          console.log(JSON.stringify({ notifications: notifications.map((item) => item.text) }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert any("trace kickoff 메시지 전송을 지원하지 않습니다" in item for item in data["notifications"])


def test_workflow_extension_runtime_unknown_command_falls_back_to_status_without_mutation(tmp_path):
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
          await pi.commands.workflow.handler('start Runtime unknown command fallback', ctx);
          const before = notifications.length;
          await pi.commands.workflow.handler('does-not-exist', ctx);
          console.log(JSON.stringify({
            fallbackNotification: notifications.slice(before).map((item) => item.text).join('\n'),
            allNotifications: notifications.map((item) => item.text),
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert "Current phase: interview" in data["fallbackNotification"]
    assert "[LLM WORKFLOW ACTION]" in data["fallbackNotification"]
    assert "Workflow 전이" not in data["fallbackNotification"]


def test_workflow_extension_runtime_plan_review_continuation_mentions_high_risk_consensus(tmp_path):
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
        const ctx = { hasUI: true, isIdle: () => true, hasPendingMessages: () => false, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime high risk continuation', ctx);
          await pi.commands.workflow.handler('skip interview-ambiguity test skip', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          console.log(JSON.stringify({ sentMessages }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    continuation_messages = [item["text"] for item in data["sentMessages"] if "Continue the workflow from the current phase" in item["text"]]

    assert len(continuation_messages) == 1
    prompt = continuation_messages[0]
    assert "Current phase: plan_review" in prompt
    assert "high-risk (Risk: high, Ambiguity gate: strict, or Work type: api/security/migration/data/deploy)" in prompt
    assert "Architect/Critic consensus review" in prompt
    assert "Do not ask the user for permission to re-enter a review phase" in prompt


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


def test_workflow_extension_runtime_submit_review_package_writes_descriptor_for_large_review_output(tmp_path):
    script = textwrap.dedent(
        r'''
        const fs = require('fs');
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');
        process.env.HARNESS_CODE_QUALITY_GUARD_CMD = 'node -e "process.exit(0)"';

        const entries = [];
        const pi = {
          events: {},
          commands: {},
          tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          appendEntry(type, data) { entries.push({ type, data }); },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };
        const large = 'review evidence line\n'.repeat(700);

        (async () => {
          await pi.commands.workflow.handler('start Runtime large review artifact', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const result = await pi.tools.submit_review_package.execute('review-large', {
            mainReviewSummary: large,
            reviewerReviewSummary: large,
            qualityGateSummary: large,
            critical: 0,
            major: 0,
            minor: 0,
          }, undefined, undefined, ctx);
          const artifact = result.details.reviewArtifact;
          const exists = artifact && fs.existsSync(artifact.path);
          const content = exists ? fs.readFileSync(artifact.path, 'utf8') : '';
          const relativePath = artifact ? path.relative(process.cwd(), artifact.path).replace(/\\/g, '/') : '';
          const reviewEntry = entries.find((entry) => entry.type === 'harness-review-package-token');
          try { fs.rmSync(path.join(process.cwd(), '.ai', 'workflow-artifacts'), { recursive: true, force: true }); } catch {}
          console.log(JSON.stringify({
            ok: result.details.ok,
            mode: artifact ? 'descriptor' : 'inline',
            artifact,
            exists,
            relativePath,
            contentHasReviewPackage: content.includes('# Review Package'),
            contentHasQualityGate: content.includes('## Quality Gate Summary'),
            toolText: result.content[0].text,
            reviewEntry,
            reviewEntryHasInlineLargePayload: reviewEntry ? JSON.stringify(reviewEntry.data).includes('review evidence line') : null,
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["ok"] is True
    assert data["mode"] == "descriptor"
    assert data["exists"] is True
    assert data["relativePath"].startswith(".ai/workflow-artifacts/")
    assert data["artifact"]["kind"] == "review"
    assert data["artifact"]["producer"]["component"] == "submit_review_package"
    assert data["artifact"]["retention"] == "until-completion"
    assert data["artifact"]["sizeBytes"] > 8 * 1024
    assert len(data["artifact"]["sha256"]) == 64
    assert data["contentHasReviewPackage"] is True
    assert data["contentHasQualityGate"] is True
    assert "Review package artifact:" in data["toolText"]
    assert data["reviewEntry"]["data"]["reviewArtifact"]["kind"] == "review"
    assert data["reviewEntry"]["data"]["mainSummary"].startswith("Stored in review artifact:")
    assert data["reviewEntryHasInlineLargePayload"] is False


def test_workflow_extension_runtime_submit_review_package_records_structured_coverage_evidence(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');
        process.env.HARNESS_CODE_QUALITY_GUARD_CMD = 'node -e "process.exit(0)"';

        const entries = [];
        const pi = {
          events: {},
          commands: {},
          tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
          appendEntry(type, data) { entries.push({ type, data }); },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const ctx = { hasUI: true, ui: { notify() {}, confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime review coverage evidence', ctx);
          await pi.commands.workflow.handler('state implement', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          const result = await pi.tools.submit_review_package.execute('review-coverage', {
            mainReviewSummary: 'Main self-review checked all changed files.',
            reviewerReviewSummary: 'Independent reviewer validated changed hunks.',
            qualityGateSummary: 'codeQualityGuard passed.',
            reviewedFiles: ['target/.pi/extensions/workflow.ts', 'tests/test_workflow_extension_runtime.py::review package case'],
            skippedFiles: [{ path: 'docs/generated.html', reason: 'generated from markdown and not manually reviewed' }],
            positionValidation: 'No Critical/Major findings remained; no file:line references required validation.',
            critical: 0,
            major: 0,
            minor: 0,
          }, undefined, undefined, ctx);
          const reviewEntry = entries.find((entry) => entry.type === 'harness-review-package-token');
          console.log(JSON.stringify({
            ok: result.details.ok,
            reviewedFiles: result.details.reviewedFiles,
            skippedFiles: result.details.skippedFiles,
            positionValidation: result.details.positionValidation,
            token: reviewEntry.data,
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["ok"] is True
    assert data["reviewedFiles"] == ["target/.pi/extensions/workflow.ts", "tests/test_workflow_extension_runtime.py::review package case"]
    assert data["skippedFiles"] == [{"path": "docs/generated.html", "reason": "generated from markdown and not manually reviewed"}]
    assert data["positionValidation"].startswith("No Critical/Major")
    assert data["token"]["reviewedFiles"] == data["reviewedFiles"]
    assert data["token"]["skippedFiles"] == data["skippedFiles"]
    assert data["token"]["positionValidation"] == data["positionValidation"]


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
        process.env.HARNESS_CODE_QUALITY_GUARD_CMD = 'node -e "console.error(\'gradle daemon unavailable\'); process.exit(7)"';

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
    assert "Quality guard execution failed before violations could be verified" in joined
    assert "environment-error" in joined
    assert "Attempts: 2" in joined
    assert "stderr" in joined
    assert "gradle daemon unavailable" in joined
    assert "code_review → review_approved" in joined


def _write_fake_gradle_wrapper(project: Path, mode: str) -> None:
    bat = project / "gradlew.bat"
    sh = project / "gradlew"
    bat.write_text(
        "@echo off\n"
        "echo %*>> gradle-args.txt\n"
        "echo %* | findstr /C:\"compileJava\" >nul\n"
        "if %errorlevel%==0 (\n"
        + ("  echo COMPILATION ERROR: cannot find symbol 1>&2\n  exit /b 1\n" if mode == "compile-fail" else "  echo compile ok\n  exit /b 0\n")
        + ")\n"
        + ("echo Checkstyle violations found in src/main/java/App.java 1>&2\nexit /b 7\n" if mode == "style-fail" else "echo SHOULD_NOT_RUN_STYLE 1>&2\nexit /b 0\n"),
        encoding="utf-8",
    )
    sh.write_text(
        "#!/usr/bin/env bash\n"
        "echo \"$*\" >> gradle-args.txt\n"
        "if [[ \" $* \" == *\" compileJava \"* ]]; then\n"
        + ("  echo 'COMPILATION ERROR: cannot find symbol' >&2\n  exit 1\n" if mode == "compile-fail" else "  echo 'compile ok'\n  exit 0\n")
        + "fi\n"
        + ("echo 'Checkstyle violations found in src/main/java/App.java' >&2\nexit 7\n" if mode == "style-fail" else "echo 'SHOULD_NOT_RUN_STYLE' >&2\nexit 0\n"),
        encoding="utf-8",
    )
    sh.chmod(0o755)


def test_gradle_code_quality_gate_reports_compile_error_before_style_tasks(tmp_path):
    project = tmp_path / "gradle-project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (project / "build.gradle").write_text("task codeQualityGuard {}\n", encoding="utf-8")
    _write_fake_gradle_wrapper(project, "compile-fail")
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const fs = require('fs');
        const {{ createJiti }} = require('jiti');
        delete process.env.HARNESS_CODE_QUALITY_GUARD_CMD;
        process.chdir({json.dumps(str(project))});

        const extension = {json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))};
        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(extension).default(pi);
        const notifications = [];
        const ctx = {{ hasUI: true, ui: {{ notify: (text, level) => notifications.push({{ text, level }}), confirm: async () => true }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime gradle compile preflight', ctx);
          await pi.commands.workflow.handler('state code_review', ctx);
          const result = await pi.tools.submit_review_package.execute('review-fail', {{
            mainReviewSummary: 'Main self-review complete.',
            reviewerReviewSummary: 'Independent reviewer found no threshold blockers.',
            qualityGateSummary: 'codeQualityGuard attempted.',
            critical: 0,
            major: 0,
            minor: 0,
          }}, undefined, undefined, ctx);
          const args = fs.readFileSync(path.join(process.cwd(), 'gradle-args.txt'), 'utf8');
          console.log(JSON.stringify({{ notifications: notifications.map((item) => item.text), toolResult: result.content[0].text, args }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"]) + "\n" + data["toolResult"]

    assert "CODE QUALITY GATE BLOCKED" in joined
    assert "compilation-error" in joined
    assert "Compilation failed before static analysis" in joined
    assert "COMPILATION ERROR" in joined
    assert "compileJava" in data["args"]
    assert "codeQualityGuard" not in data["args"]


def test_gradle_code_quality_gate_runs_style_after_compile_success(tmp_path):
    project = tmp_path / "gradle-project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (project / "build.gradle").write_text("task codeQualityGuard {}\n", encoding="utf-8")
    _write_fake_gradle_wrapper(project, "style-fail")
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const fs = require('fs');
        const {{ createJiti }} = require('jiti');
        delete process.env.HARNESS_CODE_QUALITY_GUARD_CMD;
        process.chdir({json.dumps(str(project))});

        const extension = {json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow.ts"))};
        const pi = {{ events: {{}}, commands: {{}}, tools: {{}}, on(name, fn) {{ this.events[name] = fn; }}, registerCommand(name, spec) {{ this.commands[name] = spec; }}, registerTool(spec) {{ this.tools[spec.name] = spec; }} }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(extension).default(pi);
        const notifications = [];
        const ctx = {{ hasUI: true, ui: {{ notify: (text, level) => notifications.push({{ text, level }}), confirm: async () => true }} }};

        (async () => {{
          await pi.commands.workflow.handler('start Runtime gradle style after compile', ctx);
          await pi.commands.workflow.handler('state code_review', ctx);
          const result = await pi.tools.submit_review_package.execute('review-fail', {{
            mainReviewSummary: 'Main self-review complete.',
            reviewerReviewSummary: 'Independent reviewer found no threshold blockers.',
            qualityGateSummary: 'codeQualityGuard attempted.',
            critical: 0,
            major: 0,
            minor: 0,
          }}, undefined, undefined, ctx);
          const args = fs.readFileSync(path.join(process.cwd(), 'gradle-args.txt'), 'utf8');
          console.log(JSON.stringify({{ notifications: notifications.map((item) => item.text), toolResult: result.content[0].text, args }}));
        }})().catch((error) => {{ console.error(error.stack || String(error)); process.exit(1); }});
        '''
    )
    data = _run_node_runtime(script, tmp_path)
    joined = "\n".join(data["notifications"]) + "\n" + data["toolResult"]

    assert "CODE QUALITY GATE BLOCKED" in joined
    assert "code-violation" in joined
    assert "Checkstyle violations" in joined
    assert "compileJava" in data["args"]
    assert "codeQualityGuard" in data["args"]


def test_workflow_extension_runtime_does_not_retry_checkstyle_violation_failures(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');
        process.env.HARNESS_CODE_QUALITY_GUARD_CMD = 'node -e "console.error(\'Checkstyle violations found in src/Main.java\'); process.exit(7)"';

        const pi = { events: {}, commands: {}, tools: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; }, registerTool(spec) { this.tools[spec.name] = spec; } };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.workflow.handler('start Runtime code quality violation', ctx);
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
    assert "code-violation" in joined
    assert "Attempts: 1" in joined
    assert "Checkstyle violations found" in joined


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
          await pi.commands.workflow.handler('skip interview-ambiguity test skip', ctx);
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
          await pi.commands.workflow.handler('skip interview-ambiguity test skip', ctx);
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


def test_plan_review_to_implement_requires_no_user_approval(tmp_path):
    """plan_review → implement 전환은 유저 승인 없이 자동으로 진행되어야 한다."""
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = {
          events: {}, commands: {}, tools: {},
          on(name, fn) { this.events[name] = fn; },
          registerCommand(name, spec) { this.commands[name] = spec; },
          registerTool(spec) { this.tools[spec.name] = spec; },
        };
        const jiti = createJiti(path.resolve('runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);

        const confirms = [];
        const ctx = {
          hasUI: true,
          ui: {
            notify: () => {},
            // Track every confirm dialog title so we can verify none was shown for plan_review→implement
            confirm: async (title) => { confirms.push(title); return true; },
          },
        };

        (async () => {
          await pi.commands.workflow.handler('start Auto advance test', ctx);
          // Skip interview ambiguity gate (not under test here)
          await pi.commands.workflow.handler('skip interview-ambiguity test skip to verify no confirm dialog', ctx);
          // advance: interview → plan → plan_review (auto, no confirm expected)
          await pi.commands.workflow.handler('approve', ctx);

          // Skip DPAA so the gate doesn't block
          await pi.commands.workflow.handler('skip dpaa test skip to verify no confirm dialog', ctx);

          // approve from plan_review → should auto-advance to implement WITHOUT showing a confirm dialog
          const result = await pi.tools.workflow_approve.execute(
            'approve-1', { summary: 'plan done, advance to implement' },
            undefined, undefined, ctx
          );
          console.log(JSON.stringify({ result: result.details, confirms }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    # Transition must succeed
    assert data["result"]["ok"] is True
    transitions = data["result"].get("transitions", [])
    assert any("plan_review" in str(t) and "implement" in str(t) for t in transitions), \
        f"Expected plan_review→implement transition, got: {transitions}"

    # No confirm dialog should have been shown for this transition
    plan_review_confirms = [c for c in data["confirms"] if "plan_review" in c or "implement" in c]
    assert plan_review_confirms == [], \
        f"Unexpected confirm dialogs for plan_review→implement: {plan_review_confirms}"


def test_workflow_state_autoback_does_not_send_followup_steer_message(tmp_path):
    """Bug fix: workflow_state prev (isAutoBack) must NOT call sendUserMessage.
    The kick-off instructions belong in the tool result, not a follow-up that can go stale."""
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

        const ctx = { hasUI: true, hasPendingMessages: () => false, isIdle: () => false,
          ui: { notify: () => {}, confirm: async () => true, select: async (_m, opts) => opts[0], setStatus: () => {}, setWidget: () => {} } };

        (async () => {
          await pi.commands.workflow.handler('start autoback steer test', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          // Advance to code_review
          await pi.commands.workflow.handler('state code_review', ctx);
          const beforeSteer = sentMessages.length;
          // Trigger isAutoBack: code_review → implement
          const result = await pi.tools.workflow_state.execute('ws-1', { direction: 'prev', reason: 'minor fix needed' }, undefined, undefined, ctx);
          const afterSteer = sentMessages.length;
          const steersSent = afterSteer - beforeSteer;
          // The kick-off content should be in the tool result, not a separate message
          const resultText = result.content[0].text;
          console.log(JSON.stringify({ steersSent, resultText, phase: 'implement' }));
        })().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    # Bug fix: no follow-up steer message should be sent
    assert data["steersSent"] == 0, (
        f"workflow_state isAutoBack sent {data['steersSent']} follow-up message(s); "
        "kick-off content must be in the tool result instead to prevent stale steer replay"
    )
    # The tool result must contain the kick-off instructions
    assert "수정 루프" in data["resultText"] or "code_review" in data["resultText"], (
        "workflow_state isAutoBack tool result must contain kick-off instructions"
    )


def test_commit_to_push_blocked_when_uncommitted_changes_exist(tmp_path):
    """Bug fix: workflow_approve in commit phase must block if there are uncommitted changes."""
    project = tmp_path / "dirty-project"
    project.mkdir()
    subprocess.run(["git", "init"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    tracked = project / "tracked.txt"
    tracked.write_text("staged but not committed\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=project, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        process.chdir('target');

        const notifications = [];
        const pi = {{
          events: {{}}, commands: {{}}, tools: {{}},
          on(name, fn) {{ this.events[name] = fn; }},
          registerCommand(name, spec) {{ this.commands[name] = spec; }},
          registerTool(spec) {{ this.tools[spec.name] = spec; }},
          sendUserMessage() {{}},
          getAllTools() {{ return [
            {{ name: 'read', sourceInfo: {{ source: 'builtin' }} }},
            {{ name: 'write', sourceInfo: {{ source: 'builtin' }} }},
            {{ name: 'edit', sourceInfo: {{ source: 'builtin' }} }},
            {{ name: 'bash', sourceInfo: {{ source: 'builtin' }} }},
            ...Object.keys(this.tools).map((name) => ({{ name, sourceInfo: {{ source: 'extension' }} }})),
          ]; }},
          setActiveTools(names) {{ this.activeTools = names; }},
        }};
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        jiti(path.resolve('.pi/extensions/workflow.ts')).default(pi);
        process.chdir({json.dumps(str(project))});

        const ctx = {{ hasUI: true, hasPendingMessages: () => false, isIdle: () => false,
          ui: {{
            notify(msg) {{ notifications.push(msg); }},
            confirm: async () => true,
            select: async (_m, opts) => opts[0],
            setStatus: () => {{}},
            setWidget: () => {{}},
          }}
        }};

        (async () => {{
          await pi.commands.workflow.handler('start uncommitted test', ctx);
          await pi.commands.workflow.handler('approve', ctx);
          await pi.commands.workflow.handler('state code_review', ctx);
          await pi.commands.workflow.handler('state commit', ctx);
          const result = await pi.tools.workflow_approve.execute('wa-1', {{ summary: 'push without committing' }}, undefined, undefined, ctx);
          await pi.commands.workflow.handler('status', ctx);
          const statusText = notifications[notifications.length - 1] ?? '';
          console.log(JSON.stringify({{ resultOk: result.details?.ok, resultReason: result.details?.reason, notifications, statusText }}));
        }})().catch((e) => {{ console.error(e.stack || String(e)); process.exit(1); }});
        '''
    )
    data = _run_node_runtime(script, tmp_path)

    assert data["resultOk"] is False, (
        "commit→push workflow_approve must block when tracked staged/modified changes exist. "
        f"Got resultOk={data['resultOk']}, reason={data['resultReason']}, notifications={data['notifications']}"
    )
    assert data["resultReason"] == "policy-declined"
    assert any("uncommitted" in n.lower() or "커밋" in n for n in data["notifications"]), data["notifications"]
    assert "Current phase: commit" in data["statusText"], data["statusText"]
