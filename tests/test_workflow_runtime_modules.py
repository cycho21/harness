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


def test_runtime_state_restores_latest_matching_guard_tokens_only(tmp_path):
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
        const entries = [
          {{ type: 'custom', customType: mod.HARNESS_TOKEN_TYPES.DPAA, data: {{ workflowId: 'wf-current', issuedAt: 20, reason: 'older', planSha256: 'old' }} }},
          {{ type: 'custom', customType: mod.HARNESS_TOKEN_TYPES.DPAA, data: {{ workflowId: 'wf-current', issuedAt: 30, reason: 'newer', planSha256: 'new' }} }},
          {{ type: 'custom', customType: mod.HARNESS_TOKEN_TYPES.CODE_QUALITY, data: {{ workflowId: 'wf-other', issuedAt: 40, reason: 'wrong-workflow' }} }},
          {{ type: 'custom', customType: mod.HARNESS_TOKEN_TYPES.CODE_REVIEW, data: {{ workflowId: 'wf-current', timestamp: 50, critical: 0, major: 0, minor: 1 }} }},
          {{ type: 'custom', customType: mod.HARNESS_TOKEN_TYPES.REVIEW_PACKAGE, data: {{ workflowId: 'wf-current', timestamp: 60, critical: 0, major: 0, minor: 0, mainSummary: 'main', reviewerSummary: 'review', qualitySummary: 'quality' }} }},
        ];

        mod.restoreGuardTokensToRuntimeState(state, entries);
        console.log(JSON.stringify({{
          dpaa: state.dpaaGuardSatisfiedToken,
          codeQuality: state.codeQualityGuardSatisfiedToken,
          codeReview: state.codeReviewGuardSatisfiedToken,
          push: state.pushExecutionGuardSatisfiedToken,
          reviewPackage: state.reviewPackageToken,
        }}));
        '''
    )
    data = _run_node(script, tmp_path)

    assert data["dpaa"] == {"workflowId": "wf-current", "issuedAt": 30, "reason": "newer", "planSha256": "new"}
    assert data["codeQuality"] == {"workflowId": "wf-current", "issuedAt": 11, "reason": "fallback-quality"}
    assert data["codeReview"] == {"critical": 0, "major": 0, "minor": 1, "timestamp": 50}
    assert data["push"] == {"workflowId": "wf-current", "issuedAt": 13, "reason": "fallback-push"}
    assert data["reviewPackage"]["qualitySummary"] == "quality"
