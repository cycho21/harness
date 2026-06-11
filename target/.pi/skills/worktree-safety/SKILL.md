---
name: worktree-safety
description: Use when creating, reusing, cleaning, or diagnosing git worktrees. Enforces .worktrees-only placement, dirty-worktree preservation, symlink refusal, and safe cleanup. Output language is Korean.
---

# Worktree Safety Skill

Use this skill whenever worktrees are created, reused, removed, or inspected for workflow/subagent isolation.

## Core Rules

- Create worktrees only under project-root `.worktrees/`.
- Never create worktrees under `.pi/`, `.project-memory/`, temp harness state, or arbitrary sibling paths.
- Do not delete a stale plain directory automatically. Stop and report the path.
- Do not remove dirty worktrees. Preserve them and report the dirty files.
- Refuse symlinked worktree paths before any cleanup.
- If `git worktree remove` fails because a worktree is locked or registered, preserve metadata and report the exact failure.
- Do not force-remove a worktree unless the user explicitly approves after seeing the risk.

## Safety Checks

Before creating or cleaning a worktree:

```text
1. git rev-parse --show-toplevel
2. git worktree list --porcelain
3. confirm target path starts with <project-root>/.worktrees/
4. reject if target path is a symlink
5. reject cleanup if target has uncommitted/staged/untracked files
6. reject stale non-worktree directories unless user explicitly decides what to do
```

## Output Template

```markdown
## Worktree Safety Check
- Repo root: <path>
- Target path: <path>
- Operation: create / reuse / cleanup / diagnose
- Decision: allowed / blocked

## Evidence
- <git worktree/list/status evidence>

## Blocker or Next Action
- <safe next action>
```

## Rules

- Treat unknown ownership as blocked, not as permission to delete.
- Prefer reuse of a clean registered worktree over recreation.
- Keep branch names sanitized and predictable.
- Never hide worktree cleanup failures; they may contain user work.
