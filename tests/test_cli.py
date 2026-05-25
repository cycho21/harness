from typer.testing import CliRunner
from dpaa.cli import app
from pathlib import Path
import json

runner = CliRunner()
FIXTURES = Path("tests/fixtures")


def test_bad_plan_exits_1():
    result = runner.invoke(app, [str(FIXTURES / "bad_plan.md")])
    assert result.exit_code == 1


def test_good_plan_exits_0():
    result = runner.invoke(app, [str(FIXTURES / "good_plan.md")])
    assert result.exit_code == 0


def test_output_contains_level():
    result = runner.invoke(app, [str(FIXTURES / "bad_plan.md")])
    assert "FAIL" in result.output or "WARN" in result.output


def test_json_output_written(tmp_path):
    out = tmp_path / "score.json"
    runner.invoke(app, [str(FIXTURES / "bad_plan.md"), "--output", str(out)])
    assert out.exists()
    data = json.loads(out.read_text(encoding="utf-8"))
    assert "overall" in data
    assert "level" in data
    assert "findings" in data
