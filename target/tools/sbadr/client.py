"""CoreNLP HTTP client for dependency-based ambiguity analysis.

Uses the single best parse + enhanced++ dependency graph, which is
reliably serialized in CoreNLP's JSON output (unlike k-best trees).
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Sequence

from sbadr.server import CORENLP_HOST, CORENLP_PORT


@dataclass(frozen=True)
class Token:
    index: int       # 1-based
    word: str
    pos: str         # Penn POS tag
    ner: str = "O"


@dataclass(frozen=True)
class DepEdge:
    dep: str         # relation label, e.g. "obl:with", "conj:and"
    governor: int    # head token index (0 = ROOT)
    dependent: int   # dependent token index


@dataclass(frozen=True)
class ParsedSentence:
    index: int
    text: str
    tokens: Sequence[Token]
    deps: Sequence[DepEdge]   # enhanced++ dependencies
    constituency: str         # Penn Treebank string (single best)


def parse_sentences(sentences: list[str]) -> list[ParsedSentence]:
    """Send sentences to CoreNLP and return dependency parses.

    Each sentence is terminated with a period so CoreNLP's ssplit annotator
    treats them as separate units regardless of trailing punctuation.
    """
    def _ensure_period(s: str) -> str:
        return s if s[-1] in ".?!" else s + "."

    text = " ".join(_ensure_period(s) for s in sentences)
    props = json.dumps({
        "annotators": "tokenize,ssplit,pos,depparse,parse",
        "outputFormat": "json",
    })
    url = (
        f"http://{CORENLP_HOST}:{CORENLP_PORT}/"
        f"?properties={urllib.parse.quote(props)}"
    )
    data = text.encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "text/plain; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    result: list[ParsedSentence] = []
    for sent in payload.get("sentences", []):
        tokens = [
            Token(
                index=t["index"],
                word=t["word"],
                pos=t["pos"],
                ner=t.get("ner", "O"),
            )
            for t in sent.get("tokens", [])
        ]
        deps = [
            DepEdge(
                dep=e["dep"],
                governor=e["governor"],
                dependent=e["dependent"],
            )
            for e in sent.get("enhancedPlusPlusDependencies", [])
        ]
        result.append(ParsedSentence(
            index=sent.get("index", len(result)),
            text=" ".join(t.word for t in tokens),
            tokens=tokens,
            deps=deps,
            constituency=sent.get("parse", ""),
        ))
    return result
