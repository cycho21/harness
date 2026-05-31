from __future__ import annotations
from abc import ABC, abstractmethod
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument


class LayerAnalyzer(ABC):
    LAYER_NAME: str = ""
    WARN_ONLY: bool = False  # Only L2 syntactic sets this True

    @abstractmethod
    def analyze(self, doc: PlanDocument) -> LayerResult:
        ...

    def _cap_score(self, score: int) -> int:
        return min(100, score)

    def _make_result(self, findings: list[Finding]) -> LayerResult:
        return LayerResult(
            layer=self.LAYER_NAME,
            score=self._cap_score(sum(f.score for f in findings)),
            findings=tuple(findings),
        )
