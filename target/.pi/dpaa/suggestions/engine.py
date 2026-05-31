from __future__ import annotations
from pathlib import Path
import yaml

_TEMPLATES_PATH = Path(__file__).parent / "templates.yaml"
_templates: dict[str, dict] | None = None


def _load() -> dict[str, dict]:
    global _templates
    if _templates is None:
        _templates = yaml.safe_load(_TEMPLATES_PATH.read_text(encoding="utf-8"))
    return _templates


def get_suggestion(rule_id: str) -> str:
    templates = _load()
    entry = templates.get(rule_id)
    if not entry:
        return ""
    return entry.get("fix", "").strip()
