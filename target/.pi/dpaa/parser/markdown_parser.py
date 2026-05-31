from __future__ import annotations
from dataclasses import dataclass, field
from markdown_it import MarkdownIt


@dataclass
class Section:
    title: str
    level: int
    content: str
    line_start: int


@dataclass
class PlanDocument:
    sections: dict[str, Section] = field(default_factory=dict)
    raw: str = ""


class MarkdownParser:
    def __init__(self) -> None:
        self._md = MarkdownIt()

    def parse(self, text: str) -> PlanDocument:
        doc = PlanDocument(raw=text)
        tokens = self._md.parse(text)
        lines = text.splitlines()

        current_title: str | None = None
        current_level: int = 0
        current_start: int = 0
        content_lines: list[str] = []

        for token in tokens:
            if token.type == "heading_open":
                if current_title:
                    doc.sections[current_title] = Section(
                        title=current_title,
                        level=current_level,
                        content="\n".join(content_lines).strip(),
                        line_start=current_start,
                    )
                current_level = int(token.tag[1])
                current_start = token.map[0] if token.map else 0
                content_lines = []
                current_title = None
            elif token.type == "inline" and current_title is None and token.content:
                current_title = token.content.strip()
            elif token.type not in ("heading_open", "heading_close", "inline") and current_title:
                if token.map:
                    for i in range(token.map[0], token.map[1]):
                        if i < len(lines):
                            content_lines.append(lines[i])

        if current_title:
            doc.sections[current_title] = Section(
                title=current_title,
                level=current_level,
                content="\n".join(content_lines).strip(),
                line_start=current_start,
            )

        return doc
