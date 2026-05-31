import json
import os
import subprocess
import textwrap
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PI_NODE_MODULES = Path.home() / "AppData" / "Roaming" / "npm" / "node_modules" / "@earendil-works" / "pi-coding-agent" / "node_modules"
SCHEMA = ROOT / "target" / ".pi" / "schemas" / "harness-memory-entry.schema.json"
MEMORY_EXTENSION = ROOT / "target" / ".pi" / "extensions" / "memory.ts"


def _run_node_memory(script: str, tmp_path: Path) -> dict:
    env = os.environ.copy()
    env["NODE_PATH"] = str(PI_NODE_MODULES)
    env["PI_CODING_AGENT_DIR"] = str(tmp_path / ".pi-agent")
    env["HARNESS_MEMORY_ROOT"] = str(tmp_path / "memory-root")
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


def test_memory_schema_supports_lifecycle_rendering_tracking():
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))

    assert "lifecycle" in schema["required"]
    assert "rendering" in schema["required"]
    assert "lifecycle" in schema["properties"]
    assert "rendering" in schema["properties"]
    assert "stableRenderHash" in schema["properties"]["rendering"]["properties"]
    assert "conflictsWith" in schema["properties"]["lifecycle"]["properties"]


def test_memory_extension_exposes_tracking_and_cache_aware_terms():
    text = MEMORY_EXTENSION.read_text(encoding="utf-8")

    assert ".project-memory" in text
    assert "metrics.jsonl" in text
    assert "feedback.jsonl" in text
    assert "External Memory Policy v1" in text
    assert "External Memory Context v1" in text
    assert "stableRenderHash" in text
    assert "stickySetReused" in text
    assert "cacheChurn" in text
    assert "requestHash" in text
    assert "appendFeedback" in text


def test_memory_runtime_remember_inject_explain_and_feedback(tmp_path):
    script = textwrap.dedent(
        r'''
        const path = require('path');
        const fs = require('fs');
        const { createJiti } = require('jiti');
        process.chdir('target');

        const pi = { events: {}, commands: {}, on(name, fn) { this.events[name] = fn; }, registerCommand(name, spec) { this.commands[name] = spec; } };
        const jiti = createJiti(path.resolve('memory-runtime-test.js'), { interopDefault: false });
        jiti(path.resolve('.pi/extensions/memory.ts')).default(pi);

        const notifications = [];
        const ctx = { hasUI: true, ui: { notify: (text, level) => notifications.push({ text, level }), confirm: async () => true } };

        (async () => {
          await pi.commands.memory.handler('remember 결정: workflow push policy scan은 명시 승인 없이 우회 금지', ctx);
          const prompt = await pi.events.before_agent_start({ systemPrompt: 'base', userPrompt: 'push policy scan 우회 문제 고쳐줘' });
          await pi.commands.memory.handler('explain', ctx);
          const root = process.env.HARNESS_MEMORY_ROOT;
          const metrics = fs.readFileSync(path.join(root, '.project-memory', 'memory', 'metrics.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
          const entry = fs.readFileSync(path.join(root, '.project-memory', 'memory', 'entries.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)[0];
          await pi.commands.memory.handler(`feedback ${entry.memoryId} helpful`, ctx);
          const feedback = fs.readFileSync(path.join(root, '.project-memory', 'memory', 'feedback.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
          console.log(JSON.stringify({
            commandNames: Object.keys(pi.commands),
            prompt: prompt.systemPrompt,
            notifications: notifications.map((item) => item.text),
            metrics,
            feedback,
            entry,
          }));
        })().catch((error) => { console.error(error.stack || String(error)); process.exit(1); });
        '''
    )
    data = _run_node_memory(script, tmp_path)

    assert "memory" in data["commandNames"]
    assert "[External Memory Policy v1]" in data["prompt"]
    assert "[External Memory Context v1]" in data["prompt"]
    assert "workflow push policy scan" in data["prompt"]
    assert any("Memory explain" in text for text in data["notifications"])
    assert data["entry"]["status"] == "active"
    assert data["entry"]["rendering"]["stableRenderHash"].startswith("sha256:")
    inject_metrics = [item for item in data["metrics"] if item.get("operation") == "inject"]
    assert inject_metrics
    assert inject_metrics[-1]["selectedMemoryIds"] == [data["entry"]["memoryId"]]
    assert "requestHash" in inject_metrics[-1]
    assert "push policy scan 우회" not in json.dumps(inject_metrics, ensure_ascii=False)
    assert data["feedback"][-1]["kind"] == "helpful"
