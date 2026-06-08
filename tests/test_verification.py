from dpaa.parser import MarkdownParser
from dpaa.layers.verification import VerificationLayer
from pathlib import Path

FIXTURES = Path("tests/fixtures")


def test_detects_missing_threshold():
    text = (FIXTURES / "bad_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = VerificationLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "missing_threshold" in rules


def test_good_plan_passes_verification():
    text = (FIXTURES / "good_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = VerificationLayer().analyze(doc)
    assert result.score == 0


def test_binary_observable_acceptance_condition_passes_verification():
    text = """# Plan\n\n## Acceptance Criteria\n\n- Pass when `python -m pytest tests/test_workflow.py -q` exits 0.\n- Must update README.md and README.en.md.\n- Should produce no code review blockers.\n"""
    doc = MarkdownParser().parse(text)
    result = VerificationLayer().analyze(doc)
    assert result.score == 0


def test_finding_includes_suggestion():
    text = (FIXTURES / "bad_plan.md").read_text(encoding="utf-8")
    doc = MarkdownParser().parse(text)
    result = VerificationLayer().analyze(doc)
    for f in result.findings:
        assert f.suggestion
