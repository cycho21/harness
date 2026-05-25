import pytest
from dpaa.parser import MarkdownParser
from dpaa.layers.execution import ExecutionLayer
from pathlib import Path

FIXTURES = Path("tests/fixtures")


def test_detects_weak_verb_without_metric():
    text = (FIXTURES / "bad_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = ExecutionLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "weak_action_without_metric" in rules


def test_no_findings_on_good_plan():
    text = (FIXTURES / "good_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = ExecutionLayer().analyze(doc)
    assert result.score == 0


def test_structured_yaml_step_reduces_severity():
    text = (FIXTURES / "structured_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = ExecutionLayer().analyze(doc)
    for f in result.findings:
        assert f.severity != "high", "structured YAML steps must not produce high severity"


def test_finding_includes_suggestion():
    text = (FIXTURES / "bad_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = ExecutionLayer().analyze(doc)
    for f in result.findings:
        assert f.suggestion, f"Finding {f.rule} has no suggestion"
