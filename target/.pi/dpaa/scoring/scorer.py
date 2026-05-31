from __future__ import annotations
from pathlib import Path
import yaml

from dpaa.models import Finding, LayerResult, Level, Report
from dpaa import ANALYZER_VERSION, RULESET_VERSION

_PROFILES_PATH = Path(__file__).parent.parent / "rules" / "profiles.yaml"
_WARN_ONLY_LAYERS = {"syntactic"}


def _load_profiles() -> dict:
    return yaml.safe_load(_PROFILES_PATH.read_text(encoding="utf-8"))["profiles"]


class Scorer:
    def __init__(self, profile: str = "default") -> None:
        profiles = _load_profiles()
        if profile not in profiles:
            raise ValueError(f"Unknown profile: {profile}. Available: {list(profiles)}")
        cfg = profiles[profile]
        self._profile = profile
        self._weights: dict[str, float] = cfg["weights"]
        self._pass_threshold: int = cfg["thresholds"]["pass"]
        self._warn_threshold: int = cfg["thresholds"]["warn"]

    def compute(self, file: str, layer_results: list[LayerResult]) -> Report:
        scores: dict[str, int] = {r.layer: r.score for r in layer_results}
        all_findings: list[Finding] = [f for r in layer_results for f in r.findings]

        overall = sum(
            self._weights.get(layer, 0) * score
            for layer, score in scores.items()
        )
        overall_int = int(round(overall))

        # L2 syntactic is WARN-only: exclude its contribution from FAIL gate
        warn_only_contribution = sum(
            self._weights.get(layer, 0) * scores.get(layer, 0)
            for layer in _WARN_ONLY_LAYERS
        )
        gated_overall = overall_int - int(round(warn_only_contribution))

        if gated_overall > self._warn_threshold:
            level: Level = "FAIL"
        elif overall_int > self._pass_threshold:
            level = "WARN"
        else:
            level = "PASS"

        return Report(
            file=file,
            overall=overall_int,
            level=level,
            scores=scores,
            findings=tuple(all_findings),
            analyzer_version=ANALYZER_VERSION,
            ruleset_version=RULESET_VERSION,
            profile=self._profile,
        )
