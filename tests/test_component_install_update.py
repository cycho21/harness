import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_python_initializer_can_install_memory_only(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "scripts/init-target-harness.py",
            "--source",
            "target",
            "--dest",
            str(tmp_path),
            "--component",
            "memory",
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr

    assert (tmp_path / "AGENTS.md").exists()
    assert (tmp_path / ".pi" / "extensions" / "memory.ts").exists()
    assert (tmp_path / ".pi" / "schemas" / "harness-memory-entry.schema.json").exists()
    assert not (tmp_path / ".pi" / "extensions" / "workflow.ts").exists()
    assert not (tmp_path / ".pi" / "WORKFLOW.md").exists()


def test_python_initializer_can_install_workflow_only(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "scripts/init-target-harness.py",
            "--source",
            "target",
            "--dest",
            str(tmp_path),
            "--component",
            "workflow",
        ],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr

    assert (tmp_path / "AGENTS.md").exists()
    assert (tmp_path / ".pi" / "extensions" / "workflow.ts").exists()
    assert (tmp_path / ".pi" / "extensions" / "workflow").exists()
    assert (tmp_path / ".pi" / "schemas" / "harness-field-log-event.schema.json").exists()
    assert not (tmp_path / ".pi" / "extensions" / "memory.ts").exists()
    assert not (tmp_path / ".pi" / "schemas" / "harness-memory-entry.schema.json").exists()


def test_update_scripts_are_component_granular():
    sh = (ROOT / "scripts" / "update-harness.sh").read_text(encoding="utf-8")
    ps1 = (ROOT / "scripts" / "update-harness.ps1").read_text(encoding="utf-8")

    assert "--component" in sh
    assert ".pi/extensions/workflow.ts" in sh
    assert ".pi/extensions/memory.ts" in sh
    assert ".pi/extensions \\" not in sh
    assert ".pi/schemas/harness-field-log-event.schema.json" in sh
    assert ".pi/schemas/harness-memory-entry.schema.json" in sh

    assert "[string[]]$Component" in ps1
    assert '".pi/extensions/workflow.ts"' in ps1
    assert '".pi/extensions/memory.ts"' in ps1
    assert '".pi/extensions"' not in ps1
    assert '".pi/schemas"' not in ps1
