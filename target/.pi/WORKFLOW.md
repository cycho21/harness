# DevCenter Harness — Workflow Guide

This file is the concise operating map. Mechanical enforcement lives in `.pi/extensions/workflow.ts`; LLM instructions should stay short and phase-focused.

## Core Workflow

```text
interview
→ plan
→ plan_review
→ implement
→ code_review
→ review_approved
→ document
→ commit
→ push
→ done
```

| Phase | LLM job | Guard / exit condition |
|------|---------|------------------------|
| `interview` | Clarify requirements and unknowns. | User approves moving to planning. |
| `plan` | Write/update spec + plan artifacts. | User approves plan review. |
| `plan_review` | Present plan and resolve ambiguity. | DPAA must PASS before `implement`. |
| `implement` | Implement only the approved plan. | User approves code review. |
| `code_review` | Review/fix/re-review loop. | User confirms code review guard; extension runs `codeQualityGuard`. |
| `review_approved` | Ensure findings are addressed/accepted. | User approves documentation. |
| `document` | Update required docs/Swagger/feature notes. | User approves commit. |
| `commit` | Present summary and commit message. | User approves push. |
| `push` | Push only after extension guards pass. | Successful push, then mark done. |
| `done` | No active work. | Start a new workflow if needed. |

## Operating Rules for the LLM

- Follow `/workflow status`; work only in the current phase.
- Ask before advancing phases. Natural-language approval is accepted only from the interactive user.
- If a guard blocks, report the blocker and wait. Do not bypass or simulate guard results.
- Do not create approval artifacts or token files. Guard satisfaction is extension memory only.
- Keep changes surgical: touch only files required by the current phase/task.

## Mechanical Guards

| Guard | Enforced by extension | Notes |
|------|------------------------|-------|
| DPAA | `plan_review → implement` | Checks the plan and blocks ambiguous implementation. |
| Code quality | `code_review → review_approved` | Runs `codeQualityGuard` / `HARNESS_CODE_QUALITY_GUARD_CMD`. |
| Code review | `code_review → review_approved` | User must explicitly confirm Critical=0 and Major≤2. |
| Workspace | `git push` | Blocks wrong git root/branch and `git -C` push bypass. |
| Policy scan | `git push` | Prompts user for risky build/config/migration/Docker/CI/delete/large-change pushes. |
| Push execution | `git push` | Requires `push` phase and in-memory push guard. |

Skip tokens exist only for exceptional, user-confirmed cases via `/workflow skip <gate> <reason>`.

## Artifact Conventions

- Korean source artifacts: `.ai/interview/*.ko.md`
- English DPAA artifacts: `.ai/interview/spec.md`, `.ai/interview/plan.md`
- DPAA snapshots/receipts: `.ai/interview/runs/<workflow-id>/...`
- Feature docs: `docs/feat/<feature-name>.md` and rendered HTML when required

## Branch / Task Hints

Branch type guides which loaded workflow or skill to use; it is not the source of authority.

| Task signal | Typical workflow emphasis |
|------------|---------------------------|
| feature / new behavior | Full workflow, documentation likely required |
| fix / hotfix | Reproduce, implement minimal fix, review carefully |
| refactor | Existing tests first, no behavior change |
| chore / config | Policy scan likely needs explicit user confirmation |
| docs | Documentation-focused; code-quality guard may be irrelevant unless code changed |

## Resources

- Main project instructions: `AGENTS.md`
- Extension implementation: `.pi/extensions/workflow.ts` and `.pi/extensions/workflow/`
- Workflow templates: `.pi/workflows/`
- DPAA: `.pi/dpaa/`
- Skills: `.pi/skills/`
- Personas: `.pi/personas/`
- Governance: `.pi/GOVERNANCE.md`
