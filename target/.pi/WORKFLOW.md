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
| `interview` | Clarify requirements and unknowns. | Auto-advances to `plan` after user approval starts forward progress. |
| `plan` | Write/update spec + plan artifacts. | Auto-advances to `plan_review`; this means "ready for plan review", not plan approval. |
| `plan_review` | Present plan and resolve ambiguity. | User approval + DPAA PASS required before `implement`. |
| `implement` | Implement only the approved plan. | Auto-starts review/quality flow after implementation work is ready. |
| `code_review` | Main-agent and reviewer-agent review/fix/re-review loop. | Auto-advances to `review_approved` after review/quality gates pass. |
| `review_approved` | Review gates passed. | Auto-advances to `document`. |
| `document` | Update required docs/Swagger/feature notes. | Auto-advances to `commit`; this means "ready to prepare commit", not permission to push. |
| `commit` | Present summary and commit message. | User approval required before `push`; push policy scan is confirmed here when risky changes are present. |
| `push` | Push only after extension guards pass. | Successful push, then mark done. If workspace risk signature changed after approval, policy scan asks again. |
| `done` | No active work. | Start a new workflow if needed. |

## Operating Rules for the LLM

- Follow `/workflow status`; work only in the current phase.
- Ask before crossing approval-required boundaries: `plan_review → implement`, `commit → push`, gate skip/state/abort, and git push confirmation.
- Preparation/review transitions auto-chain: `interview → plan → plan_review`, `implement → code_review`, and `review_approved → document → commit`. `code_review → review_approved` is triggered by `submit_review_package` after main review, independent reviewer/subagent review, and quality gates pass.
- The extension injects mechanical reminders instead of blocking for easy-to-forget deliverables: documentation markdown/HTML/indexes, verification evidence before commit, review package summary in code review, commit summary/message, and field-log evidence for harness-runtime changes. Address each reminder or explicitly state why it is not applicable.
- Natural-language approval is accepted only from the interactive user.
- If a guard blocks, report the blocker and wait. Do not bypass or simulate guard results.
- Modifying `.pi/extensions/**` or `target/.pi/extensions/**` requires explicit interactive user approval for that tool call. The approval is extension in-memory only; do not create approval files.
- Do not create approval artifacts or authority files. Guard satisfaction comes from workflow phase, transition history, and extension-recorded evidence.
- Keep changes surgical: touch only files required by the current phase/task.

## Mechanical Guards

| Guard | Enforced by extension | Notes |
|------|------------------------|-------|
| DPAA | `plan_review → implement` | Checks the plan and blocks ambiguous implementation. |
| Code quality | `code_review → review_approved` | Runs `codeQualityGuard` / `HARNESS_CODE_QUALITY_GUARD_CMD`. |
| Code review | `code_review → review_approved` | `submit_review_package` must include main self-review, independent reviewer/subagent review, quality-gate summary, Critical=0, and Major≤2 before review approval. |
| Workspace | `git push` | Blocks wrong git root/branch and `git -C` push bypass. |
| Policy scan | `commit → push`, rechecked at `git push` | Prompts user for risky build/config/migration/Docker/CI/delete/large-change pushes. The approval is reused if the workspace risk signature is unchanged. |
| Push execution | `git push` | Requires `push` phase and in-memory push guard. |

One-use gate exceptions exist only for exceptional, user-confirmed cases via `/workflow skip <gate> <reason>`.

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
