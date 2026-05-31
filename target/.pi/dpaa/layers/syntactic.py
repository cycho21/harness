from __future__ import annotations
import re

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument, split_sentences
from dpaa.suggestions import get_suggestion

try:
    import stanza as _stanza  # noqa: F401
    _STANZA_AVAILABLE = True
except (ImportError, ModuleNotFoundError):
    _STANZA_AVAILABLE = False

_PASSIVE_RE = re.compile(
    r'\b(?:is|are|was|were|be|been|being)\s+\w{1,50}ed\b',
    re.IGNORECASE,
)
_BY_AGENT_RE = re.compile(r'\bby\b', re.IGNORECASE)
_COORD_RE = re.compile(r'\b(and|or)\b', re.IGNORECASE)


def _check_long_sentence(layer: str, line: int, sentence: str) -> Finding | None:
    if len(sentence.split()) > 40:
        return Finding(
            layer=layer,
            rule="long_sentence",
            severity="low",
            line=line,
            text=sentence[:120],
            message="Sentence exceeds 40 words; may indicate ambiguity or multiple concerns.",
            score=3,
            suggestion=get_suggestion("long_sentence"),
        )
    return None


def _check_multiple_subjects(layer: str, line: int, sentence: str) -> Finding | None:
    if len(_COORD_RE.findall(sentence)) > 2:
        return Finding(
            layer=layer,
            rule="multiple_subjects",
            severity="medium",
            line=line,
            text=sentence[:120],
            message="Sentence has more than 2 coordination conjunctions; subject may be ambiguous.",
            score=5,
            suggestion=get_suggestion("multiple_subjects"),
        )
    return None


def _check_passive_voice(layer: str, line: int, sentence: str) -> Finding | None:
    if _PASSIVE_RE.search(sentence) and not _BY_AGENT_RE.search(sentence):
        return Finding(
            layer=layer,
            rule="passive_voice_without_agent",
            severity="medium",
            line=line,
            text=sentence[:120],
            message="Passive voice used without specifying agent ('by <who>'); ownership is ambiguous.",
            score=5,
            suggestion=get_suggestion("passive_voice_without_agent"),
        )
    return None


class SyntacticLayer(LayerAnalyzer):
    LAYER_NAME = "syntactic"
    WARN_ONLY = True

    def analyze(self, doc: PlanDocument) -> LayerResult:
        return self._analyze_impl(doc)

    def _analyze_impl(self, doc: PlanDocument) -> LayerResult:
        findings: list[Finding] = []
        for section in doc.sections.values():
            for line_no, sentence in split_sentences(section.content):
                actual_line = section.line_start + line_no
                for check in (_check_long_sentence, _check_multiple_subjects, _check_passive_voice):
                    finding = check(self.LAYER_NAME, actual_line, sentence)
                    if finding is not None:
                        findings.append(finding)
        return self._make_result(findings)
