from __future__ import annotations
import re
from pathlib import Path
import yaml

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument, split_sentences
from dpaa.suggestions import get_suggestion

_RULES_PATH = Path(__file__).parent.parent / "rules" / "referential.yaml"
_ANTECEDENT_WINDOW = 3


def _load_rules() -> dict:
    return yaml.safe_load(_RULES_PATH.read_text(encoding="utf-8"))


class ReferentialLayer(LayerAnalyzer):
    LAYER_NAME = "referential"

    def analyze(self, doc: PlanDocument) -> LayerResult:
        rules = _load_rules()
        pronouns = rules["pronouns"]
        findings: list[Finding] = []

        for section in doc.sections.values():
            sentences = split_sentences(section.content)
            for idx, (line_no, sentence) in enumerate(sentences):
                prior_window = " ".join(
                    s for _, s in sentences[max(0, idx - _ANTECEDENT_WINDOW):idx]
                ).lower()

                for pronoun in pronouns:
                    pattern = rf"\b{re.escape(pronoun)}\b"
                    match = re.search(pattern, sentence.lower())
                    if match:
                        # Include text before the pronoun in the current sentence
                        # as part of the antecedent search window (handles relative clauses)
                        pre_pronoun = sentence[: match.start()].lower()
                        full_window = prior_window + " " + pre_pronoun
                        # Antecedent present if: article+noun anywhere in window,
                        # OR (for relative-clause pronouns only) a bare noun immediately precedes
                        _RELATIVE_PRONOUNS = {"that", "which"}
                        noun_in_window = bool(
                            re.search(r"\b(the|a|an)\s+\w+", full_window)
                            or (
                                pronoun in _RELATIVE_PRONOUNS
                                and re.search(r"\w+\s+$", pre_pronoun)
                            )
                        )
                        if not noun_in_window:
                            findings.append(Finding(
                                layer=self.LAYER_NAME,
                                rule="unresolved_pronoun",
                                severity="high",
                                line=section.line_start + line_no,
                                text=sentence,
                                message=f"Pronoun '{pronoun}' has no clear antecedent.",
                                score=10,
                                suggestion=get_suggestion("unresolved_pronoun"),
                            ))
                        break

        return self._make_result(findings)
