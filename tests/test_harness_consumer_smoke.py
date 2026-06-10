import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PI_NODE_MODULES = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"
FIXTURE = ROOT / "tests" / "fixtures" / "harness-consumer"


def _sh_path(path: Path) -> str:
    return path.resolve().as_posix()


def _run_node(script: str, project: Path, log_root: Path) -> dict:
    env = os.environ.copy()
    env["NODE_PATH"] = str(PI_NODE_MODULES)
    env["PI_CODING_AGENT_DIR"] = str(log_root / ".pi-agent")
    env["HARNESS_FIELD_LOG_ROOT"] = str(log_root)
    env["HARNESS_POLICY_MAX_CHANGED_FILES"] = "500"
    result = subprocess.run(
        ["node", "-e", script],
        cwd=project,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _workflow_script(project: Path) -> str:
    template = r'''
    const path = require('path');
    const { createJiti } = require('jiti');
    process.chdir(__PROJECT__);
    const extension = path.resolve('.pi/extensions/workflow.ts');
    const confirms = [];
    const pi = {
      events: {}, commands: {}, tools: {},
      on(name, fn) { this.events[name] = fn; },
      registerCommand(name, spec) { this.commands[name] = spec; },
      registerTool(spec) { this.tools[spec.name] = spec; },
      sendUserMessage() {},
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
    createJiti(path.resolve('consumer-smoke.js'), { interopDefault: false })(extension).default(pi);
    const ctx = {
      hasUI: true,
      hasPendingMessages: () => false,
      isIdle: () => false,
      ui: {
        notify() {},
        confirm: async (title, text) => { confirms.push({ title, text }); return true; },
        select: async (_message, options) => options[0],
        setStatus() {},
        setWidget() {},
      },
    };
    async function command(args) { return pi.commands.workflow.handler(args, ctx); }
    function detailsOf(result) { return result?.details ?? {}; }
    function textOf(result) { return result?.content?.[0]?.text ?? ''; }
    (async () => {
      const observations = {};
      const start = await command('start Consumer smoke workflow');
      const prepare = await command('approve');
      const toolsAfterPrepare = [...(pi.activeTools || [])];
      const skip = await command('skip dpaa smoke test preapproval');
      const implement = await command('approve');
      const toolsAfterImplement = [...(pi.activeTools || [])];
      observations.start = detailsOf(start);
      observations.prepare = detailsOf(prepare);
      observations.prepareText = textOf(prepare);
      observations.skip = detailsOf(skip);
      observations.implement = detailsOf(implement);
      observations.implementText = textOf(implement);
      console.log(JSON.stringify({ observations, confirms, toolsAfterPrepare, toolsAfterImplement, activeTools: pi.activeTools }));
    })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
    '''
    return textwrap.dedent(template).replace("__PROJECT__", json.dumps(str(project)))


def _audit_script(project: Path) -> str:
    template = r'''
    const path = require('path');
    const { createJiti } = require('jiti');
    process.chdir(__PROJECT__);
    const { writeAuditLogEvent, writeFieldLogEvent } = createJiti(path.resolve('audit-smoke.js'), { interopDefault: false })(path.resolve('.pi/extensions/workflow/field-log.ts'));
    const workflow = { id: 'wf-smoke', phase: 'plan_review' };
    writeAuditLogEvent({ eventType: 'transition', workflow, fromPhase: 'plan', toPhase: 'plan_review', phase: 'plan_review', result: 'success', severity: 'info', reasonSummary: 'transition smoke' });
    writeFieldLogEvent({ type: 'gate.failed', category: 'dpaa', severity: 'blocker', workflow, fromPhase: 'plan_review', toPhase: 'implement', summary: 'DPAA blocked smoke', expected: 'pass', actual: 'blocked', impact: 'approval stopped', primaryMessage: 'blocked' });
    writeFieldLogEvent({ type: 'gate.skipped', category: 'dpaa', severity: 'warning', status: 'accepted-risk', workflow, fromPhase: 'plan_review', toPhase: 'implement', summary: 'DPAA skipped smoke', expected: 'approval', actual: 'skip accepted', impact: 'accepted risk', primaryMessage: 'skipped' });
    writeAuditLogEvent({ eventType: 'approval_boundary_anomaly', workflow, fromPhase: 'plan_review', toPhase: 'implement', phase: 'plan_review', gate: 'dpaa', result: 'precheck_blocked_before_dialog', severity: 'warning', reasonSummary: 'approval dialog missing smoke' });
    console.log(JSON.stringify({ ok: true }));
    '''
    return textwrap.dedent(template).replace("__PROJECT__", json.dumps(str(project)))


@pytest.mark.skipif(shutil.which("git") is None or shutil.which("sh") is None or shutil.which("node") is None, reason="git, sh, and node are required")
def test_update_harness_fixture_and_workflow_phase_smoke(tmp_path):
    consumer = tmp_path / "consumer"
    shutil.copytree(FIXTURE, consumer)
    subprocess.run(["git", "init"], cwd=consumer, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    result = subprocess.run(
        ["sh", str(ROOT / "scripts" / "update-harness.sh"), "--repo", _sh_path(ROOT), "--dest", _sh_path(consumer)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    assert (consumer / ".pi").exists()
    assert (consumer / "AGENTS.md").exists()
    assert (consumer / ".harness" / "workflow-policy.json").exists()

    data = _run_node(_workflow_script(consumer), consumer, tmp_path / "workflow-log-root")
    assert "edit" not in data["toolsAfterPrepare"], data
    assert "workflow_propose_edit" in data["toolsAfterImplement"], data
    assert data["observations"]["skip"].get("ok", True) is True
    assert data["observations"]["implement"].get("ok", True) is True
    assert any("dpaa" in (item["title"] + item["text"]).lower() for item in data["confirms"])
    assert "workflow_propose_edit" in data["activeTools"]


def test_audit_jsonl_records_core_event_categories_without_raw_prompt(tmp_path):
    consumer = tmp_path / "consumer"
    shutil.copytree(FIXTURE, consumer)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "init-target-harness.py"), "--source", str(ROOT / "target"), "--dest", str(consumer)], cwd=ROOT, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, encoding="utf-8")

    log_root = tmp_path / "audit-log-root"
    _run_node(_audit_script(consumer), consumer, log_root)
    audit_file = log_root / ".project-memory" / "harness" / "audit.jsonl"
    records = [json.loads(line) for line in audit_file.read_text(encoding="utf-8").splitlines() if line]

    event_types = {record["eventType"] for record in records}
    assert {"transition", "guard_block", "guard_skip", "approval_boundary_anomaly"}.issubset(event_types)
    assert len(records) >= 4
    for record in records:
        joined_keys = "\n".join(record.keys()).lower()
        assert "raw" not in joined_keys
        assert "prompt" not in joined_keys
        assert "transcript" not in joined_keys
