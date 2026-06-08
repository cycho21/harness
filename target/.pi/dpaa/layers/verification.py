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
# Negation/prohibition: "must not", "should not", "shouldn't", "mustn't"
_NEGATION_RE = re.compile(r"\b(must\s+not|must\s+NOT|should\s+not|shouldn't|mustn't)\b")
# Prerequisite: "must have <verb>ed"
_PREREQ_RE = re.compile(r"\bmust\s+have\b")
# Binary/observable acceptance conditions are precise even without numeric SLOs.
# Examples: command exits 0, tests pass, file exists/updated, no blockers/errors.
_BINARY_OBSERVABLE_RE = re.compile(
    r"\b("
    r"exits?\s+0|exit\s+code\s+0|passes?|pass(?:es)?\b|"
    r"exists?|create[ds]?|update[ds]?|remove[ds]?|delete[ds]?|rendered|generated|"
    r"no(?:\s+\w+){0,4}\s+(?:errors?|failures?|findings?|blockers?|warnings?|diff|changes?)|"
    r"without\s+(?:errors?|failures?|findings?|blockers?|warnings?)"
    r")\b",
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
        findings: list[Finding] = []

        for section in doc.sections.values():
            for line_no, sentence in split_sentences(section.content):
                lower = sentence.lower()
                if not any(t in lower for t in triggers):
                    continue

                stripped = sentence.strip()
                # Skip labels, questions, headings, table rows
                if (stripped.endswith(":") or stripped.endswith("?")
                        or stripped.startswith("#") or stripped.startswith(">")
                        or "│" in stripped):
                    continue
                # Skip prohibitions ("must not", "should not") — binary constraints are precise
                if _NEGATION_RE.search(sentence):
                    continue
                # Skip prerequisites ("must have run", "must have completed")
                if _PREREQ_RE.search(sentence):
                    continue
                # Skip very short fragments (≤3 words) — headings, terse labels
                if len(stripped.split()) < 4:
                    continue

                has_binary_observable = bool(_BINARY_OBSERVABLE_RE.search(sentence))
                has_metric = bool(_METRIC_RE.search(sentence)) or has_binary_observable
                has_threshold = any(p in lower for p in threshold_patterns) or has_binary_observable

                if not has_metric:
                    findings.append(Finding(
                        layer=self.LAYER_NAME,
                        rule="missing_metric",
                        severity="high",
                        line=section.line_start + line_no,
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
                        line=section.line_start + line_no,
                        text=sentence,
                        message="Acceptance criterion has no measurable threshold.",
                        score=10,
                        suggestion=get_suggestion("missing_threshold"),
                    ))

        return self._make_result(findings)
