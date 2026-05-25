from __future__ import annotations
import pytest
from dpaa.layers.syntactic import SyntacticLayer
from dpaa.parser import MarkdownParser, PlanDocument, Section


def _make_doc(content: str) -> PlanDocument:
    doc = MarkdownParser().parse(f"# Test\n\n{content}")
    return doc


def test_layer_name():
    assert SyntacticLayer.LAYER_NAME == "syntactic"


def test_warn_only_flag():
    assert SyntacticLayer.WARN_ONLY is True


def test_no_high_or_critical_severity():
    long = " ".join(["word"] * 45)
    passive = "The system is configured without clear ownership of the process."
    conjunction = "The worker and the scheduler and the monitor or the dispatcher do the task."
    content = f"{long}\n{passive}\n{conjunction}"
    doc = _make_doc(content)
    result = SyntacticLayer().analyze(doc)
    for f in result.findings:
        assert f.severity in {"low", "medium"}, f"Unexpected severity: {f.severity}"


def test_long_sentence_detected():
    long_sentence = " ".join(["word"] * 45)
    doc = _make_doc(long_sentence)
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "long_sentence" in rules


def test_short_sentence_no_long_finding():
    doc = _make_doc("The worker retries failed jobs every 30 seconds.")
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "long_sentence" not in rules


def test_multiple_subjects_detected():
    sentence = "The worker and the scheduler and the monitor or the dispatcher handle retries."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "multiple_subjects" in rules


def test_two_conjunctions_no_multiple_subjects():
    sentence = "The worker and the scheduler handle retries and failures."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "multiple_subjects" not in rules


def test_passive_voice_without_agent_detected():
    sentence = "The configuration file is updated during deployment."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "passive_voice_without_agent" in rules


def test_passive_voice_with_agent_not_flagged():
    sentence = "The configuration file is updated by the deployment script."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "passive_voice_without_agent" not in rules


def test_clean_sentence_no_findings():
    sentence = "The orchestrator restarts the worker service after migration completes."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    assert result.findings == ()
    assert result.score == 0


def test_three_findings_score_at_most_15():
    long = " ".join(["word"] * 45)
    passive = "The index is rebuilt after the migration step."
    conjunction = "The a and the b and the c or the d runs the task."
    content = f"{long}\n{passive}\n{conjunction}"
    doc = _make_doc(content)
    result = SyntacticLayer().analyze(doc)
    assert result.score <= 15


def test_finding_scores_are_positive():
    sentence = " ".join(["word"] * 45)
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    for f in result.findings:
        assert f.score > 0


def test_empty_document_returns_no_findings():
    doc = MarkdownParser().parse("")
    result = SyntacticLayer().analyze(doc)
    assert result.findings == ()
    assert result.score == 0
