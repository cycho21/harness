"""SBADR main analysis orchestrator."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from sbadr.client import parse_sentences
from sbadr.filters import Finding, run_pipeline

# Divergence score above this threshold → WARN; above _FAIL_THRESHOLD → FAIL
# FAIL requires max_score ≥ 0.50 so that only PP attachment (0.6) triggers FAIL.
# Coordination (0.40) and analytical (0.25) can only produce WARN.
_WARN_THRESHOLD = 0.15
_FAIL_THRESHOLD = 0.50

# Minimum number of ambiguous sentences to trigger WARN/FAIL
_WARN_MIN_COUNT = 1
_FAIL_MIN_COUNT = 3


@dataclass
class AnalysisResult:
    findings: list[Finding]
    sentence_count: int
    ambiguous_count: int
    max_score: float
    verdict: str        # "PASS" | "WARN" | "FAIL"
    score: float        # overall ambiguity score 0.0–1.0

    @property
    def top_findings(self) -> list[Finding]:
        return sorted(self.findings, key=lambda f: f.divergence_score, reverse=True)[:5]


def _clean_line(line: str) -> str:
    line = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)  # links
    line = re.sub(r"`[^`]+`", "", line)                    # inline code
    line = re.sub(r"\*{1,2}([^*]+)\*{1,2}", r"\1", line)  # bold/italic
    line = re.sub(r"\s+", " ", line)
    return line.strip()


def _extract_sentences(text: str) -> list[str]:
    """Extract plain English sentences from a Markdown plan document.

    List items (bullets, numbered) are kept as individual units rather than
    joined into one long run-on — each item may be its own complex sentence.
    """
    sentences: list[str] = []
    in_code = False
    paragraph_lines: list[str] = []
    last_was_list_item = False
    pending_list_item: str = ""  # accumulates multi-line list item text

    def flush_paragraph() -> None:
        if not paragraph_lines:
            return
        paragraph = " ".join(paragraph_lines)
        paragraph_lines.clear()
        for s in re.split(r"(?<=[.!?])\s+(?=[A-Z])", paragraph):
            s = s.strip()
            if len(s.split()) >= 5:
                sentences.append(s)

    def flush_pending_list_item() -> None:
        nonlocal pending_list_item, last_was_list_item
        if pending_list_item and len(pending_list_item.split()) >= 5:
            sentences.append(pending_list_item)
        pending_list_item = ""
        last_was_list_item = False

    for line in text.splitlines():
        stripped = line.strip()
        leading_spaces = len(line) - len(line.lstrip())

        # Toggle code block
        if stripped.startswith("```"):
            in_code = not in_code
            flush_pending_list_item()
            flush_paragraph()
            continue
        if in_code or not stripped:
            if not in_code:
                flush_pending_list_item()
            continue
        # Skip table rows
        if stripped.startswith("|"):
            continue
        # Skip pure header lines (no prose content)
        if re.match(r"^#{1,6}\s*$", stripped):
            continue

        is_list_item = bool(re.match(r"^(\d+\.|[-*+])\s+", stripped))
        # Continuation: indented non-bullet line immediately after a list item
        is_continuation = (
            last_was_list_item
            and not is_list_item
            and leading_spaces >= 2
        )

        # Strip markdown structure markers
        cleaned = re.sub(r"^#{1,6}\s+", "", stripped)
        cleaned = re.sub(r"^(\d+\.|[-*+])\s+", "", cleaned)
        # Remove trailing "— `code`" BEFORE _clean_line strips backticks
        cleaned = re.sub(r"\s*[—–]\s*`[^`]+`\s*$", "", cleaned).strip()
        cleaned = _clean_line(cleaned)
        # Remove any bare trailing em-dash remaining after code was stripped
        cleaned = re.sub(r"\s*[—–]\s*$", "", cleaned).strip()

        if not cleaned or len(cleaned.split()) < 3:
            flush_pending_list_item()
            continue

        if is_list_item:
            flush_pending_list_item()
            flush_paragraph()
            pending_list_item = cleaned
            last_was_list_item = True
        elif is_continuation and pending_list_item:
            # Append continuation to current list item
            pending_list_item = pending_list_item + " " + cleaned
        else:
            flush_pending_list_item()
            paragraph_lines.append(cleaned)
            last_was_list_item = False

    flush_pending_list_item()
    flush_paragraph()
    return sentences


def analyze_file(path: str | Path, k: int = 5) -> AnalysisResult:  # noqa: ARG001
    """Analyze an English plan document for syntactic ambiguity.

    Requires CoreNLP server to be running (call server.ensure_running() first).
    k is unused (kept for CLI compatibility; dependency-based approach uses 1 parse).
    """
    text = Path(path).read_text(encoding="utf-8")
    sentences = _extract_sentences(text)

    if not sentences:
        return AnalysisResult(
            findings=[],
            sentence_count=0,
            ambiguous_count=0,
            max_score=0.0,
            verdict="PASS",
            score=0.0,
        )

    parsed = parse_sentences(sentences)
    all_findings: list[Finding] = []
    for sent in parsed:
        all_findings.extend(run_pipeline(sent))

    ambiguous_count = len({f.sentence_index for f in all_findings})
    max_score = max((f.divergence_score for f in all_findings), default=0.0)

    # Overall score: weighted by proportion of ambiguous sentences + max divergence
    proportion = ambiguous_count / len(sentences) if sentences else 0.0
    overall = round((proportion * 0.5 + max_score * 0.5), 4)

    # FAIL requires multiple high-confidence findings (score ≥ FAIL_THRESHOLD).
    # Using only ambiguous_count would cause FAIL when low-score coordination /
    # analytical findings inflate the total, even with no genuine PP attachment.
    high_conf_count = len({f.sentence_index for f in all_findings
                           if f.divergence_score >= _FAIL_THRESHOLD})
    if max_score >= _FAIL_THRESHOLD and high_conf_count >= _FAIL_MIN_COUNT:
        verdict = "FAIL"
    elif max_score >= _WARN_THRESHOLD or ambiguous_count >= _WARN_MIN_COUNT:
        verdict = "WARN"
    else:
        verdict = "PASS"

    return AnalysisResult(
        findings=all_findings,
        sentence_count=len(sentences),
        ambiguous_count=ambiguous_count,
        max_score=max_score,
        verdict=verdict,
        score=overall,
    )
