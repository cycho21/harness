from __future__ import annotations
import re
from pathlib import Path
import yaml

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument, split_sentences
from dpaa.suggestions import get_suggestion

_RULES_PATH = Path(__file__).parent.parent / "rules" / "execution.yaml"
_METRIC_RE = re.compile(
    r"\d+(\.\d+)?\s?(ms|s|sec|seconds|%|requests|retries|attempts|MB|GB|min|hour)",
    re.IGNORECASE,
)


def _load_rules() -> dict:
    return yaml.safe_load(_RULES_PATH.read_text(encoding="utf-8"))


class ExecutionLayer(LayerAnalyzer):
    LAYER_NAME = "execution"

    def analyze(self, doc: PlanDocument) -> LayerResult:
        rules = _load_rules()
        weak_terms = rules["weak_terms"]
        rule_cfg = rules["rules"]["weak_action_without_metric"]

        findings: list[Finding] = []
        is_structured = self._has_structured_steps(doc)

        for section in doc.sections.values():
            for line_no, sentence in split_sentences(section.content):
                lower = sentence.lower()
                has_weak = any(term in lower for term in weak_terms)
                has_metric = bool(_METRIC_RE.search(sentence))

                if has_weak and not has_metric:
                    severity = "medium" if is_structured else rule_cfg["severity"]
                    score = rule_cfg["score"] // 2 if is_structured else rule_cfg["score"]
                    findings.append(Finding(
                        layer=self.LAYER_NAME,
                        rule="weak_action_without_metric",
                        severity=severity,
                        line=section.line_start + line_no,
                        text=sentence,
                        message="Weak action term without measurable metric.",
                        score=score,
                        suggestion=get_suggestion("weak_action_without_metric"),
                    ))

        return self._make_result(findings)

    def _has_structured_steps(self, doc: PlanDocument) -> bool:
        steps_section = doc.sections.get("Steps", None)
        if not steps_section:
            return False
        return "```yaml" in steps_section.content
