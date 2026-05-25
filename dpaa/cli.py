from __future__ import annotations
from pathlib import Path
import typer

from dpaa.parser import MarkdownParser
from dpaa.layers import (
    StructuralLayer, ReferentialLayer, TemporalLayer,
    ExecutionLayer, VerificationLayer, StateLayer,
)
from dpaa.scoring.scorer import Scorer
from dpaa.output.json_report import to_json
from dpaa.output.text_report import to_text

app = typer.Typer()


@app.command()
def lint(
    plan: Path = typer.Argument(..., help="Path to plan document (Markdown)"),
    profile: str = typer.Option("default", help="Scoring profile: default | strict | minimal"),
    output: Path | None = typer.Option(None, help="Write JSON report to file"),
    text: bool = typer.Option(True, help="Print human-readable output"),
    syntactic: bool = typer.Option(False, help="Enable L2 syntactic layer (requires stanza)"),
) -> None:
    content = plan.read_text(encoding="utf-8")
    doc = MarkdownParser().parse(content)

    analyzers = [
        StructuralLayer(profile=profile),
        ReferentialLayer(),
        TemporalLayer(),
        ExecutionLayer(),
        VerificationLayer(),
        StateLayer(),
    ]

    if syntactic:
        from dpaa.layers.syntactic import SyntacticLayer, _STANZA_AVAILABLE
        analyzers.insert(1, SyntacticLayer())
        if not _STANZA_AVAILABLE:
            typer.echo("Warning: stanza not installed; syntactic checks use regex heuristics only.", err=True)

    layer_results = [a.analyze(doc) for a in analyzers]
    report = Scorer(profile=profile).compute(str(plan), layer_results)

    if text:
        typer.echo(to_text(report))

    if output:
        output.write_text(to_json(report), encoding="utf-8")
        typer.echo(f"\nReport written to {output}")

    raise typer.Exit(code=1 if report.level == "FAIL" else 0)


if __name__ == "__main__":
    app()
