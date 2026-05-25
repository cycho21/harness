from __future__ import annotations
import networkx as nx

from dpaa.layers.base import LayerAnalyzer
from dpaa.models import Finding, LayerResult
from dpaa.parser import PlanDocument, YamlBlockParser
from dpaa.suggestions import get_suggestion


class StateLayer(LayerAnalyzer):
    LAYER_NAME = "state"

    def analyze(self, doc: PlanDocument) -> LayerResult:
        steps_section = doc.sections.get("Steps")
        if not steps_section:
            return self._make_result([])

        steps = YamlBlockParser().extract_steps(steps_section.content)
        if not steps:
            return self._make_result([])

        return self._make_result(self._validate(steps))

    def _validate(self, steps: list[dict]) -> list[Finding]:
        findings: list[Finding] = []
        graph = nx.DiGraph()
        produced: dict[str, str] = {}

        for step in steps:
            step_id = step.get("id", "")
            graph.add_node(step_id)
            for state in step.get("produces", []):
                produced[state] = step_id

        for step in steps:
            step_id = step.get("id", "")
            for req in step.get("requires", []):
                if req not in produced:
                    findings.append(Finding(
                        layer=self.LAYER_NAME,
                        rule="missing_required_state_producer",
                        severity="critical",
                        text=step_id,
                        message=f"Required state '{req}' has no producer.",
                        score=20,
                        suggestion=get_suggestion("missing_required_state_producer"),
                    ))
                else:
                    graph.add_edge(produced[req], step_id)

            if not step.get("rollback"):
                findings.append(Finding(
                    layer=self.LAYER_NAME,
                    rule="missing_rollback",
                    severity="high",
                    text=step_id,
                    message=f"Step '{step_id}' has no rollback path.",
                    score=10,
                    suggestion=get_suggestion("missing_rollback"),
                ))

        if not nx.is_directed_acyclic_graph(graph):
            findings.append(Finding(
                layer=self.LAYER_NAME,
                rule="cyclic_dependency",
                severity="critical",
                message="Workflow dependency graph contains a cycle.",
                score=25,
                suggestion=get_suggestion("cyclic_dependency"),
            ))

        return findings
