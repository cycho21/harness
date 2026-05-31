from __future__ import annotations
from typing import Literal
from pydantic import BaseModel

Severity = Literal["low", "medium", "high", "critical"]
Level = Literal["PASS", "WARN", "FAIL"]


class Finding(BaseModel, frozen=True):
    layer: str
    rule: str
    severity: Severity
    line: int | None = None
    text: str | None = None
    message: str
    score: int
    suggestion: str = ""


class LayerResult(BaseModel, frozen=True):
    layer: str
    score: int
    findings: tuple[Finding, ...]


class Report(BaseModel, frozen=True):
    file: str
    overall: int
    level: Level
    scores: dict[str, int]
    findings: tuple[Finding, ...]
    analyzer_version: str
    ruleset_version: str
    profile: str
