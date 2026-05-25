from __future__ import annotations
import pytest
from unittest.mock import patch
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
    findings = [f for f in result.findings if f.rule == "long_sentence"]
    assert len(findings) == 1
    finding = findings[0]
    assert finding.score == 3


def test_short_sentence_no_long_finding():
    doc = _make_doc("The worker retries failed jobs every 30 seconds.")
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "long_sentence" not in rules


def test_multiple_subjects_detected():
    sentence = "The worker and the scheduler and the monitor or the dispatcher handle retries."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    findings = [f for f in result.findings if f.rule == "multiple_subjects"]
    assert len(findings) == 1
    finding = findings[0]
    assert finding.score == 5


def test_two_conjunctions_no_multiple_subjects():
    sentence = "The worker and the scheduler handle retries and failures."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    rules = {f.rule for f in result.findings}
    assert "multiple_subjects" not in rules


def test_long_sentence_boundary_does_not_trigger():
    """Exactly 40 words must not trigger long_sentence."""
    sentence = " ".join(["word"] * 40)
    result = SyntacticLayer().analyze(_make_doc(sentence))
    long_findings = [f for f in result.findings if f.rule == "long_sentence"]
    assert long_findings == []


def test_multiple_subjects_minimum_trigger():
    """Exactly 3 conjunctions (>2) must trigger multiple_subjects."""
    sentence = "The system checks A and B or C and D to ensure correctness."
    result = SyntacticLayer().analyze(_make_doc(sentence))
    multi_findings = [f for f in result.findings if f.rule == "multiple_subjects"]
    assert len(multi_findings) == 1


def test_passive_voice_without_agent_detected():
    sentence = "The configuration file is updated during deployment."
    doc = _make_doc(sentence)
    result = SyntacticLayer().analyze(doc)
    findings = [f for f in result.findings if f.rule == "passive_voice_without_agent"]
    assert len(findings) == 1
    finding = findings[0]
    assert finding.score == 5


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
    passive = "The index is updated after the migration step."
    conjunction = "The a and the b and the c or the d runs the task."
    content = f"{long}\n{passive}\n{conjunction}"
    doc = _make_doc(content)
    result = SyntacticLayer().analyze(doc)
    assert len(result.findings) == 3
    assert result.score == 13  # long_sentence(3) + passive_voice(5) + multiple_subjects(5)


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


def test_graceful_degradation_without_stanza():
    """Layer returns empty result when stanza-dependent analysis is unavailable."""
    from dpaa.models import LayerResult
    layer = SyntacticLayer()
    doc = _make_doc("This is a normal sentence.")
    with patch.object(layer, '_analyze_impl', return_value=LayerResult(
        layer=SyntacticLayer.LAYER_NAME, score=0, findings=()
    )):
        result = layer.analyze(doc)
    assert result.findings == ()
    assert result.score == 0
