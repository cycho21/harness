from __future__ import annotations
from pathlib import Path
import yaml

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument
from dpaa.suggestions import get_suggestion

_RULES_PATH = Path(__file__).parent.parent / "rules" / "structural.yaml"


def _load_rules() -> dict:
    return yaml.safe_load(_RULES_PATH.read_text(encoding="utf-8"))


class StructuralLayer(LayerAnalyzer):
    LAYER_NAME = "structural"

    def analyze(self, doc: PlanDocument) -> LayerResult:
        rules = _load_rules()
        findings: list[Finding] = []
        placeholders = rules["placeholder_terms"]
        rule_cfg = rules["rules"]

        for section in doc.sections.values():
            for line_no, line in enumerate(section.content.splitlines(), start=section.line_start + 1):
                upper = line.upper()
                for placeholder in placeholders:
                    if placeholder.upper() in upper:
                        findings.append(Finding(
                            layer=self.LAYER_NAME,
                            rule="placeholder_found",
                            severity=rule_cfg["placeholder_found"]["severity"],
                            line=line_no,
                            text=line.strip(),
                            message=f"Placeholder '{placeholder}' found.",
                            score=rule_cfg["placeholder_found"]["score"],
                            suggestion=get_suggestion("placeholder_found"),
                        ))
                        break

        return self._make_result(findings)
