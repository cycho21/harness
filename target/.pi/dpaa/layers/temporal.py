from __future__ import annotations
from pathlib import Path
import yaml
import re

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument, split_sentences
from dpaa.suggestions import get_suggestion

_RULES_PATH = Path(__file__).parent.parent / "rules" / "temporal.yaml"
_INTERVAL_RE = re.compile(
    r"\d+\s?(s|sec|seconds|ms|min|minutes|hour|hours|days?)",
    re.IGNORECASE,
)


def _load_rules() -> dict:
    return yaml.safe_load(_RULES_PATH.read_text(encoding="utf-8"))


class TemporalLayer(LayerAnalyzer):
    LAYER_NAME = "temporal"

    def analyze(self, doc: PlanDocument) -> LayerResult:
        rules = _load_rules()
        vague_terms = rules["vague_temporal_terms"]
        findings: list[Finding] = []

        for section in doc.sections.values():
            for line_no, sentence in split_sentences(section.content):
                lower = sentence.lower()
                has_interval = bool(_INTERVAL_RE.search(sentence))

                for term in vague_terms:
                    if term in lower:
                        rule = "periodic_without_interval" if term == "periodically" else "vague_temporal_without_interval"
                        if not has_interval:
                            findings.append(Finding(
                                layer=self.LAYER_NAME,
                                rule=rule,
                                severity=rules["rules"][rule]["severity"],
                                line=section.line_start + line_no,
                                text=sentence,
                                message=f"Temporal term '{term}' has no exact interval or condition.",
                                score=rules["rules"][rule]["score"],
                                suggestion=get_suggestion(rule),
                            ))
                        break

        return self._make_result(findings)
