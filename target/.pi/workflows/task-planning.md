# Workflow: Task Planning

**When**: After requirement-analysis, before any implementation.
**Persona**: Architect leads; Developer reviews for feasibility.

## Steps

1. **Read requirement-analysis output** — acceptance criteria must be locked.
2. **Identify affected files** (max 5 for confirmation, ask before expanding).
3. **Design the implementation approach** — API shape, DB changes, service logic.
4. **Break into tasks**: each task must have a verifiable outcome.
   - Format: `[Task N]: <what> → verify: <how to check it's done>`
   - Aim: each task completable in < 2 hours.
5. **Write plan to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`**.
6. **Adversarial review**: spawn fresh Opus agent with zero session context to challenge the plan. Incorporate findings.
7. **Get user approval** on the plan before starting Task 1.

## Plan File Format

```markdown
# <Feature Name> Implementation Plan

## Acceptance Criteria
- [ ] ...

## Tasks
### Task 1: <name>
- [ ] Step 1 → verify: ...
- [ ] Step 2 → verify: ...

### Task 2: <name>
...
```

## Do NOT

- Start implementation before plan is approved.
- Write tasks without verifiable outcomes.
- Skip adversarial review for non-trivial plans.
