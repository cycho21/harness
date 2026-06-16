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
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_runtime_policy_filters_builtin_tools_but_preserves_extension_tools(tmp_path):
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "runtime-policy.ts"))});

        const calls = [];
        const host = {{
          getAllTools() {{
            return [
              {{ name: 'read', sourceInfo: {{ source: 'builtin' }} }},
              {{ name: 'write', sourceInfo: {{ source: 'builtin' }} }},
              {{ name: 'edit', sourceInfo: {{ source: 'builtin' }} }},
              {{ name: 'bash', sourceInfo: {{ source: 'builtin' }} }},
              {{ name: 'workflow_approve', sourceInfo: {{ source: 'extension' }} }},
              {{ name: 'sdk_tool', sourceInfo: {{ source: 'sdk' }} }},
            ];
          }},
          setActiveTools(names) {{ calls.push(names); }},
        }};

        mod.applyPhaseToolPolicyForHost(host, 'plan_review');
        mod.applyPhaseToolPolicyForHost(host, null);
        console.log(JSON.stringify({{ planReview: calls[0], noPhase: calls[1] }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert "read" in data["planReview"]
    assert "bash" in data["planReview"]
    assert "workflow_approve" in data["planReview"]
    assert "write" not in data["planReview"]
    assert "edit" not in data["planReview"]
    assert data["noPhase"] == ["read", "write", "edit", "bash", "workflow_approve", "sdk_tool"]


def test_runtime_policy_requires_approval_only_for_mutating_runtime_extension_paths(tmp_path):
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "runtime-policy.ts"))});

        const cases = {{
          readRuntime: mod.requiresExtensionMutationApproval('bash', {{ command: 'rg foo .pi/extensions/workflow.ts' }}),
          teeRuntime: mod.requiresExtensionMutationApproval('bash', {{ command: 'echo x | tee .pi/extensions/workflow.ts' }}),
          editRuntime: mod.requiresExtensionMutationApproval('edit', {{ path: '.pi/extensions/workflow.ts' }}),
          writeTargetTemplate: mod.requiresExtensionMutationApproval('write', {{ path: 'target/.pi/extensions/workflow.ts' }}),
          redirectTargetTemplate: mod.requiresExtensionMutationApproval('bash', {{ command: 'echo x > target/.pi/extensions/workflow.ts' }}),
          nestedRuntime: mod.requiresExtensionMutationApproval('bash', {{ command: 'printf x > ./nested/.pi/extensions/memory.ts' }}),
        }};
        console.log(JSON.stringify(cases));
        '''
    )
    data = _run_node(script, tmp_path)

    assert data["readRuntime"] is False
    assert data["teeRuntime"] is True
    assert data["editRuntime"] is True
    assert data["writeTargetTemplate"] is False
    assert data["redirectTargetTemplate"] is False
    assert data["nestedRuntime"] is True


def test_field_log_actionable_hint_ignores_optional_corenlp_noise(tmp_path):
    script = textwrap.dedent(
        rf'''
        const fs = require('fs');
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "field-log.ts"))});

        const root = process.env.HARNESS_FIELD_LOG_ROOT;
        const logDir = path.join(root, '.project-memory', 'harness');
        fs.mkdirSync(logDir, {{ recursive: true }});
        const events = [
          {{
            timestamp: '2026-06-12T00:00:00.000Z',
            event: {{ category: 'update', type: 'update.failed', severity: 'warning', status: 'open', summary: 'CoreNLP startup failed' }},
            failure: {{ summary: 'CoreNLP startup failed', actual: 'dockerDesktopLinuxEngine unavailable; optional environment follow-up' }},
          }},
          {{
            timestamp: '2026-06-12T00:01:00.000Z',
            event: {{ category: 'dpaa', type: 'gate.failed', severity: 'warning', status: 'open' }},
            failure: {{ summary: 'Failed to read DPAA report: ENOENT' }},
          }},
        ];
        fs.writeFileSync(path.join(logDir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
        console.log(JSON.stringify({{ hint: mod.formatLatestActionableFailureHint() }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert "last actionable failure" in data["hint"]
    assert "dpaa" in data["hint"]
    assert "Failed to read DPAA report" in data["hint"]
    assert "CoreNLP" not in data["hint"]


def test_field_log_actionable_hint_suppresses_resolved_gate_categories(tmp_path):
    script = textwrap.dedent(
        rf'''
        const fs = require('fs');
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "field-log.ts"))});

        const root = process.env.HARNESS_FIELD_LOG_ROOT;
        const logDir = path.join(root, '.project-memory', 'harness');
        fs.mkdirSync(logDir, {{ recursive: true }});
        const event = {{
          timestamp: '2026-06-12T00:01:00.000Z',
          event: {{ category: 'dpaa', type: 'gate.failed', severity: 'warning', status: 'open' }},
          failure: {{ summary: 'Failed to read DPAA report: ENOENT' }},
        }};
        fs.writeFileSync(path.join(logDir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
        console.log(JSON.stringify({{
          stale: mod.formatLatestActionableFailureHint(20, {{ activeGateFailures: [] }}),
          active: mod.formatLatestActionableFailureHint(20, {{ activeGateFailures: ['dpaa'] }}),
        }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert data["stale"] == ""
    assert "last actionable failure" in data["active"]
    assert "dpaa" in data["active"]


def test_field_log_actionable_hint_handles_interview_ambiguity_gate_category(tmp_path):
    script = textwrap.dedent(
        rf'''
        const fs = require('fs');
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "field-log.ts"))});

        const root = process.env.HARNESS_FIELD_LOG_ROOT;
        const logDir = path.join(root, '.project-memory', 'harness');
        fs.mkdirSync(logDir, {{ recursive: true }});
        const event = {{
          timestamp: '2026-06-12T00:01:00.000Z',
          event: {{ category: 'interview-ambiguity', type: 'gate.failed', severity: 'blocker', status: 'open' }},
          failure: {{ summary: 'Interview ambiguity score missing before interview → plan transition.' }},
        }};
        fs.writeFileSync(path.join(logDir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
        console.log(JSON.stringify({{
          stale: mod.formatLatestActionableFailureHint(20, {{ activeGateFailures: [] }}),
          active: mod.formatLatestActionableFailureHint(20, {{ activeGateFailures: ['interview-ambiguity'] }}),
        }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert data["stale"] == ""
    assert "last actionable failure" in data["active"]
    assert "interview-ambiguity" in data["active"]
    assert "Interview ambiguity score missing" in data["active"]


def test_write_dpaa_receipt_includes_report_descriptor(tmp_path):
    plan = tmp_path / "plan.md"
    report = tmp_path / "dpaa-report.json"
    plan.write_text("# Plan\n", encoding="utf-8")
    report.write_text('{"level":"PASS","findings":[]}\n', encoding="utf-8")

    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "artifacts.ts"))});

        const workflow = {{
          id: 'wf-dpaa-descriptor',
          title: 'DPAA descriptor test',
          phase: 'plan_review',
          cwd: process.cwd(),
          gitRoot: process.cwd(),
          branch: 'main',
          createdAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T00:00:00.000Z',
          history: [],
        }};
        const receipt = mod.writeDpaaReceipt({{
          workflow,
          from: 'plan_review',
          to: 'implement',
          planPath: {json.dumps(str(plan))},
          reportPath: {json.dumps(str(report))},
          report: {{ level: 'PASS', overall: 0, findings: [] }},
          exitCode: 0,
        }});
        console.log(JSON.stringify({{
          kind: receipt.reportDescriptor.kind,
          path: receipt.reportDescriptor.path,
          component: receipt.reportDescriptor.producer.component,
          retention: receipt.reportDescriptor.retention,
          sizeBytes: receipt.reportDescriptor.sizeBytes,
          sha256: receipt.reportDescriptor.sha256,
          reportSha256: receipt.reportSha256,
          summary: receipt.reportDescriptor.summary,
        }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert data["kind"] == "dpaa-report"
    assert Path(data["path"]).resolve() == report.resolve()
    assert data["component"] == "dpaa"
    assert data["retention"] == "until-completion"
    assert data["sizeBytes"] == report.stat().st_size
    assert data["sha256"] == data["reportSha256"]
    assert data["summary"] == "DPAA PASS: 0 finding(s), penalty=0."



def test_runtime_state_does_not_restore_persisted_guard_tokens_as_authority(tmp_path):
    script = textwrap.dedent(
        rf'''
        const path = require('path');
        const {{ createJiti }} = require('jiti');
        const jiti = createJiti(path.resolve('runtime-test.js'), {{ interopDefault: false }});
        const mod = jiti({json.dumps(str(ROOT / "target" / ".pi" / "extensions" / "workflow" / "runtime-state.ts"))});

        const state = mod.createWorkflowRuntimeState();
        state.workflow = {{
          id: 'wf-current',
          title: 'Coverage runtime state',
          phase: 'push',
          cwd: process.cwd(),
          gitRoot: process.cwd(),
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:00.000Z',
          history: [],
          guardTokens: {{
            dpaa: {{ workflowId: 'wf-current', issuedAt: 10, reason: 'fallback-dpaa' }},
            codeQuality: {{ workflowId: 'wf-current', issuedAt: 11, reason: 'fallback-quality' }},
            codeReview: {{ workflowId: 'wf-current', timestamp: 12, critical: 0, major: 1, minor: 2 }},
            pushExecution: {{ workflowId: 'wf-current', issuedAt: 13, reason: 'fallback-push' }},
          }},
        }};

        console.log(JSON.stringify({{
          hasRestoreExport: typeof mod.restoreGuardTokensToRuntimeState === 'function',
          dpaa: state.dpaaGuardSatisfiedToken,
          codeQuality: state.codeQualityGuardSatisfiedToken,
          codeReview: state.codeReviewGuardSatisfiedToken,
          push: state.pushExecutionGuardSatisfiedToken,
          reviewPackage: state.reviewPackageToken,
        }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert data["hasRestoreExport"] is False
    assert data["dpaa"] is None
    assert data["codeQuality"] is None
    assert data["codeReview"] is None
    assert data["push"] is None
    assert data["reviewPackage"] is None
