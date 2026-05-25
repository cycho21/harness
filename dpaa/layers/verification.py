from __future__ import annotations
import re
from pathlib import Path
import yaml

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument, split_sentences
from dpaa.suggestions import get_suggestion

_RULES_PATH = Path(__file__).parent.parent / "rules" / "verification.yaml"
_METRIC_RE = re.compile(
    r"\d+(\.\d+)?\s?(ms|s|sec|seconds|%|requests|retries|attempts|MB|GB|min|hour)",
    re.IGNORECASE,
)


def _load_rules() -> dict:
    return yaml.safe_load(_RULES_PATH.read_text(encoding="utf-8"))


class VerificationLayer(LayerAnalyzer):
    LAYER_NAME = "verification"

    def analyze(self, doc: PlanDocument) -> LayerResult:
        rules = _load_rules()
        triggers = rules["acceptance_triggers"]
        threshold_patterns = rules["threshold_patterns"]
        test_methods = rules["test_method_patterns"]
        findings: list[Finding] = []

        ac_section = doc.sections.get("Acceptance Criteria")
        if not ac_section:
            return self._make_result(findings)

        # test method is checked at section level: "Run:" often appears on its own line
        section_lower = ac_section.content.lower()
        section_has_test = any(t in section_lower for t in test_methods)

        for line_no, sentence in split_sentences(ac_section.content):
            lower = sentence.lower()
            looks_like_ac = any(t in lower for t in triggers)
            if not looks_like_ac:
                continue

            has_metric = bool(_METRIC_RE.search(sentence))
            has_threshold = any(p in lower for p in threshold_patterns)

            if not has_metric:
                findings.append(Finding(
                    layer=self.LAYER_NAME,
                    rule="missing_metric",
                    severity="high",
                    line=line_no,
                    text=sentence,
                    message="Acceptance criterion has no numeric metric.",
                    score=10,
                    suggestion=get_suggestion("missing_metric"),
                ))
            if not has_threshold:
                findings.append(Finding(
                    layer=self.LAYER_NAME,
                    rule="missing_threshold",
                    severity="high",
                    line=line_no,
                    text=sentence,
                    message="Acceptance criterion has no measurable threshold.",
                    score=10,
                    suggestion=get_suggestion("missing_threshold"),
                ))

        if not section_has_test:
            findings.append(Finding(
                layer=self.LAYER_NAME,
                rule="missing_test_method",
                severity="medium",
                message="Acceptance Criteria section has no explicit test method.",
                score=6,
                suggestion=get_suggestion("missing_test_method"),
            ))

        return self._make_result(findings)
