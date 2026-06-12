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
| `plan_review` | Present plan and resolve ambiguity. For high-risk plans, run Architect/Critic consensus review before implementation approval. | DPAA PASS required before `implement`. Auto-advances on pass; auto-returns to `plan` on fail. |
| `implement` | Implement only the approved plan. | Auto-starts review/quality flow after implementation work is ready. |
| `code_review` | Main-agent and reviewer-agent review/fix/re-review loop. | Auto-advances to `review_approved` after review/quality gates pass. |
| `review_approved` | Review gates passed. | Auto-advances to `document`. |
| `document` | Update required docs/Swagger/feature notes. | Auto-advances to `commit`; this means "ready to prepare commit", not permission to push. |
| `commit` | Present summary and commit message. | User approval required before `push`; push policy scan is confirmed here when risky changes are present. |
| `push` | Push only after extension guards pass. | Successful push, then mark done. If workspace risk signature changed after approval, policy scan asks again. |
| `done` | No active work. | Start a new workflow if needed. |

## Default Flow vs Conditional Protocols

The default path is the phase sequence above. Conditional protocols (`trace`, `evidence-verification`, `continuation-safety`, `compact-handoff`, `worktree-safety`, `cleanup`) are situational safety tools; do not add them as mandatory checklist items unless their trigger applies. See `docs/workflow-protocol-taxonomy.md` in the repository for the full taxonomy.

## Operating Rules for the LLM

- Follow `/workflow status`; work only in the current phase.
- The only user-approval boundary is `commit → push`. Everything from interview through commit is autonomous.
- Auto-chain sequence: `interview → plan → plan_review → implement → code_review → review_approved → document → commit`. Each transition is automatic once the phase work is complete and guards pass. `code_review → review_approved` is triggered by `submit_review_package` after main review, independent review, and quality gates pass.
- The extension injects mechanical reminders instead of blocking for easy-to-forget deliverables: documentation markdown/HTML/indexes, verification evidence before commit, review package summary in code review, commit summary/message, and field-log evidence for harness-runtime changes. Address each reminder or explicitly state why it is not applicable.
- For long sessions, use the `compact-handoff` skill before manual compaction. It prepares a concise resume note but does not invoke compaction itself.
- Before phase advancement, review package submission, commit, push, or compaction, use the `continuation-safety` protocol when a tool/guard/transition failed or when subagents, async jobs, background commands, or delegated reviewers may still be running or uncollected.
- After changing workflow prompts, guards, interview behavior, review protocols, or runtime routing, use `evidence-verification` to record baseline, target behavior, verification evidence, and dogfood gaps.
- Natural-language approval is accepted only from the interactive user.
- If plan metadata says `Risk: high`, `Ambiguity gate: strict`, or `Work type: api|security|migration|data|deploy`, perform an Architect/Critic consensus review in `plan_review` and repair feasibility/testability gaps before implementation approval. This is a **separate layer from DPAA** (DPAA checks linguistic clarity; Critic checks logical soundness). Critic review steps: (1) extract key assumptions and rate each VERIFIED/REASONABLE/FRAGILE — FRAGILE assumptions are highest-priority targets; (2) run a pre-mortem: assume this plan was executed and failed, generate 3 concrete failure scenarios, verify the plan addresses each; (3) apply executor perspective: can each step be completed with only what is written, without asking questions? Repair any FRAGILE assumption or unaddressed failure scenario before requesting implementation approval.
- If a DPAA/SBADR guard blocks, attempt to repair the plan autonomously (rewrite vague sentences, add missing metrics, remove placeholders, fix syntactic ambiguity) and retry `/workflow approve`. Repeat until DPAA PASS or a genuine business decision is required. Only then ask the user.
- For all other guards, report the blocker and wait. Do not bypass or simulate guard results.
- Modifying installed runtime `.pi/extensions/**` requires explicit interactive user approval for that tool call. The approval is extension in-memory only; do not create approval files. In the company-harness source repository only, `target/.pi/extensions/**` is deployment-template source and is a normal development target.
- Do not create approval artifacts or authority files. Guard satisfaction comes from workflow phase, transition history, and extension-recorded evidence.
- Abort/cancel semantics: `/workflow abort` stops the active workflow only after interactive confirmation; it does not create guard evidence, does not imply DPAA/code-review/quality/push approval, and should preserve dirty workspace changes for explicit user handling.
- Keep changes surgical: touch only files required by the current phase/task.

## Phase Protection Levels

Protection levels describe how aggressively the LLM and extension should avoid accidental progress or mutation in each phase.

| Level | Meaning | Phases |
|------|---------|--------|
| light | Guidance-focused; normal edits/checks are allowed when in scope. | `interview`, `plan`, `document` |
| medium | Evidence-focused; completion claims require explicit artifacts or verification. | `implement`, `commit` |
| heavy | Guard-focused; do not proceed until required review/gate evidence exists. | `plan_review`, `code_review`, `push` |
| terminal | No procedural continuation without a new workflow. | `done` |

Use these levels as design guidance for new reminders, tool policy, and recovery behavior. They do not replace mechanical guard evidence.

## Mechanical Guards

| Guard | Enforced by extension | Notes |
|------|------------------------|-------|
| High-risk consensus | `plan_review` LLM procedure | Architect/Critic review (assumption FRAGILE rating, pre-mortem, executor perspective) is required for high-risk metadata before requesting implementation approval. Independent layer from DPAA. |
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
- Large handoffs should use an artifact descriptor instead of raw inline content. Descriptor fields are `kind`, `path`, `producer`, `retention`, `sizeBytes`, `sha256`, and optional `summary`.

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
