from __future__ import annotations
import re

_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z])")


def split_sentences(text: str) -> list[tuple[int, str]]:
    """Returns list of (line_number, sentence) tuples."""
    results: list[tuple[int, str]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        sentences = _SENTENCE_RE.split(stripped)
        for s in sentences:
            if s.strip():
                results.append((line_no, s.strip()))
    return results
