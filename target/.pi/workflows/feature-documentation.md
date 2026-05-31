# Workflow: Feature Documentation

**When**: After IMPLEMENT phase, before REVIEW. Triggered when:
- New external API endpoints added/changed
- DB schema changes (new tables, columns, index changes)
- New domain concepts or architectural decisions
- Changes that affect other teams (consumer-service ↔ api-service contracts)

**Persona**: Developer writes; Architect validates architectural decisions.

## Decision Gate (run this before writing)

Ask:
1. Does this change affect external API consumers? (yes → document)
2. Does this introduce a new domain concept? (yes → document)
3. Is the "why" behind a key decision non-obvious? (yes → document)
4. Is this a bug fix / minor config change? (no → skip)

If all "no" → skip documentation, proceed to quality-gate.

## Output Format

Create `docs/feat/<feature-name>.md`:

```markdown
# <Feature Name>

> 작성일: YYYY-MM-DD | 브랜치: feat/<branch> | 작성자: <id>

## Context & Problem
[Why this change was needed — the business/technical driver]

## Flow Diagram
[mermaid sequence/flow diagram for non-trivial flows]

## Decision Log
| 결정 | 선택한 방향 | 이유 | 중요도 |
|------|------------|------|--------|
...

## 변경 범위
[Affected files, API changes, DB changes]
```

## Quality Gate for Documentation

- Explains *why*, not just *what* (the code already shows what)
- Decision Log has at least one entry per non-obvious choice
- Flow diagram present for request/response flows > 2 hops

## Render (optional)

Run `/render-docs` skill to generate HTML version for GitLab Pages.
