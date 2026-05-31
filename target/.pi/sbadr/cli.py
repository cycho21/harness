"""SBADR CLI — syntactic ambiguity analysis for plan documents."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import typer

from sbadr import analyzer, server
from sbadr.filters import AmbiguityType

app = typer.Typer(
    name="sbadr",
    help="Score-Based Ambiguity Detector and Resolver (ICSME 2020)",
    add_completion=False,
)

server_app = typer.Typer(name="server", help="CoreNLP server management")
app.add_typer(server_app)

_TYPE_ICON = {
    AmbiguityType.PP_ATTACHMENT: "📎",
    AmbiguityType.COORDINATION: "🔀",
    AmbiguityType.ANALYTICAL: "🔍",
    AmbiguityType.NOUN_PHRASE: "📦",
}


@app.command()
def analyze(
    plan: Path = typer.Argument(..., help="English plan document (.en.md)"),
    k: int = typer.Option(5, "--k", help="Number of k-best parse trees"),
    output: Optional[Path] = typer.Option(None, "--output", "-o", help="Write JSON result to file"),
    no_text: bool = typer.Option(False, "--no-text", help="Suppress text output (use with --output)"),
    start_server: bool = typer.Option(True, "--start-server/--no-start-server",
                                       help="Auto-start CoreNLP server if not running"),
) -> None:
    """Analyze an English plan document for syntactic ambiguity."""
    if not plan.exists():
        typer.echo(f"Error: file not found: {plan}", err=True)
        raise typer.Exit(1)

    _proc = None
    try:
        if start_server:
            try:
                _proc = server.ensure_running()
            except RuntimeError as e:
                typer.echo(f"Error: {e}", err=True)
                raise typer.Exit(2)
        elif not server.is_running():
            typer.echo(
                "CoreNLP server is not running. "
                "Start it with: sbadr server start",
                err=True,
            )
            raise typer.Exit(2)

        result = analyzer.analyze_file(plan, k=k)
    finally:
        if _proc is not None:
            server.stop(_proc)

    # JSON output
    if output:
        data = {
            "verdict": result.verdict,
            "score": result.score,
            "sentence_count": result.sentence_count,
            "ambiguous_count": result.ambiguous_count,
            "max_score": result.max_score,
            "findings": [
                {
                    "sentence_index": f.sentence_index,
                    "sentence_text": f.sentence_text,
                    "type": f.ambiguity_type.value,
                    "score": f.divergence_score,
                    "detail": f.detail,
                    "suggestion": f.suggestion,
                }
                for f in result.findings
            ],
        }
        output.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    if no_text:
        _exit_for_verdict(result.verdict)
        return

    # Text output
    _print_report(plan, result)
    _exit_for_verdict(result.verdict)


def _exit_for_verdict(verdict: str) -> None:
    if verdict == "FAIL":
        raise typer.Exit(2)
    if verdict == "WARN":
        raise typer.Exit(1)
    # PASS → exit 0


def _print_report(plan: Path, result: analyzer.AnalysisResult) -> None:
    verdict_icon = {"PASS": "✅", "WARN": "⚠️", "FAIL": "🔴"}.get(result.verdict, "?")
    typer.echo(
        f"\n── SBADR Syntactic Ambiguity Analysis ──────────────────\n"
        f"  File    : {plan.name}\n"
        f"  Sentences: {result.sentence_count} analyzed, "
        f"{result.ambiguous_count} ambiguous\n"
        f"  Score   : {result.score:.3f}  (max divergence: {result.max_score:.3f})\n"
        f"  Verdict : {verdict_icon} {result.verdict}\n"
        f"─────────────────────────────────────────────────────────"
    )

    if not result.findings:
        typer.echo("  No syntactic ambiguities detected.")
        return

    typer.echo(f"\nTop findings ({min(5, len(result.findings))} of {len(result.findings)}):\n")
    for finding in result.top_findings:
        icon = _TYPE_ICON.get(finding.ambiguity_type, "·")
        typer.echo(
            f"  {icon} [{finding.ambiguity_type.value}] "
            f"sentence {finding.sentence_index}  score={finding.divergence_score:.3f}\n"
            f"    \"{finding.sentence_text[:90]}\"\n"
            f"    → {finding.detail}\n"
            f"    💡 {finding.suggestion}\n"
        )


# ---------------------------------------------------------------------------
# server subcommand
# ---------------------------------------------------------------------------

@server_app.command("start")
def server_start() -> None:
    """Start CoreNLP server in the background."""
    if server.is_running():
        typer.echo(f"CoreNLP server already running on port {server.CORENLP_PORT}")
        return
    try:
        server.start(quiet=False)
        typer.echo(f"✅ CoreNLP server started on port {server.CORENLP_PORT}")
    except Exception as e:
        typer.echo(f"Error: {e}", err=True)
        raise typer.Exit(1)


@server_app.command("stop")
def server_stop() -> None:
    """Stop CoreNLP server (sends shutdown request)."""
    import urllib.request
    url = f"http://{server.CORENLP_HOST}:{server.CORENLP_PORT}/shutdown"
    try:
        urllib.request.urlopen(url, timeout=5)
        typer.echo("CoreNLP server stopped.")
    except Exception:
        typer.echo("CoreNLP server is not running.")


@server_app.command("status")
def server_status() -> None:
    """Check if CoreNLP server is running."""
    if server.is_running():
        typer.echo(f"✅ CoreNLP server running on port {server.CORENLP_PORT}")
    else:
        typer.echo(f"❌ CoreNLP server not running")
        raise typer.Exit(1)
