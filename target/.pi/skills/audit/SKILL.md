---
name: audit
description: Independent LLM audit workflow for commit ranges. Use when checking audit status, starting an audit session, advancing the reviewed pointer, or resetting it. No CLI required — all operations use git directly.
---

# AI Audit Harness

An independent LLM audit session reviews commit ranges that the Primary Session produced.
The two sessions never share context — bias contamination is prevented by design.

## State: One Git Ref

The only persisted state is `refs/ai/reviewer/last-reviewed`.
Everything else is read live from git.

## Quick Reference

| Operation | Command |
|-----------|---------|
| Pending commits | `git log refs/ai/reviewer/last-reviewed..HEAD --oneline` |
| Changed files | `git diff refs/ai/reviewer/last-reviewed..HEAD --name-only` |
| Current base | `git rev-parse refs/ai/reviewer/last-reviewed` |
| Advance pointer | `git update-ref refs/ai/reviewer/last-reviewed $(git rev-parse HEAD)` |
| Init / reset pointer | `git update-ref refs/ai/reviewer/last-reviewed $(git rev-parse HEAD)` |

## Workflow

```
init:
  git update-ref refs/ai/reviewer/last-reviewed $(git rev-parse HEAD)
  ↓
[dev loop: code → commit]
  Check .ai/fix-contract.md — if it exists, read and resolve before continuing
  ↓
  ┌── SEPARATE audit session ───────────────────────────────┐
  │   Pass: base..HEAD range (from git commands above)      │
  │   Pass: .pi/skills/audit/references/auditor-persona.md │
  │   Auditor reads git log/diff/files directly — no input doc │
  └─────────────────────────────────────────────────────────┘
  ↓
verdict OK?
  → rm -f .ai/fix-contract.md
  → git update-ref refs/ai/reviewer/last-reviewed $(git rev-parse HEAD)
verdict ≠ OK?
  → auditor writes .ai/fix-contract.md with fix instructions
  → pointer stays; main session reads fix-contract at next session start
```

## Audit Session Instructions

Start a new, separate session — never reuse the Primary Session.

Give the auditor two pieces of context:
1. The commit range: output of `git log refs/ai/reviewer/last-reviewed..HEAD --oneline`
2. The persona file: `.pi/skills/audit/references/auditor-persona.md`

The auditor must:
1. Read `auditor-persona.md` — role, verdict rules, output format
2. Read `.ai/spec.md` directly from the repo — task definition and success criteria
3. Run `git log`, `git diff`, `git show` on the range to gather evidence
4. Answer the five core questions (see persona)
5. Return exactly one audit report in the required format
6. Never edit files, never propose patches, never move refs

## Key Files

| Path | Git | Purpose |
|------|-----|---------|
| `.ai/spec.md` | tracked | Task definition — edit per task before starting |
| `.ai/fix-contract.md` | gitignored | Fix instructions from auditor → main session |
| `refs/ai/reviewer/last-reviewed` | git ref | Audit base pointer |
| `.pi/skills/audit/references/auditor-persona.md` | tracked | Auditor identity |

## References

- `references/auditor-persona.md` — full auditor identity, verdict rules, output format
