from dpaa.models import Report

_ICONS = {"PASS": "✓", "WARN": "⚠", "FAIL": "✗"}


def to_text(report: Report) -> str:
    icon = _ICONS[report.level]
    lines = [
        f"DPAA Result: {icon} {report.level}",
        f"Overall Score: {report.overall}",
        f"Profile: {report.profile}",
        "",
        "Layer Scores:",
    ]
    for layer, score in report.scores.items():
        warn_tag = " [WARN-ONLY]" if layer == "syntactic" else ""
        lines.append(f"  {layer:15s} {score:3d}{warn_tag}")

    if report.findings:
        lines += ["", "Findings:"]
        for i, f in enumerate(report.findings, 1):
            lines.append(f"  {i}. [{f.layer}] {f.rule} (severity={f.severity}, score={f.score})")
            if f.line:
                lines.append(f"     line {f.line}: {f.text or ''}")
            lines.append(f"     {f.message}")
            if f.suggestion:
                lines.append(f"     → Fix: {f.suggestion.splitlines()[0]}")

    return "\n".join(lines)
