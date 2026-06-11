# Workflow Runtime Events

This document summarizes the runtime event flow for the harness workflow extension. It is AI-readable operational documentation, not a replacement for the source code.

## Start Flow

```text
/workflow start <goal>
→ prerequisite scan
→ workflow instance persisted
→ phase tool policy applied
→ status/board refreshed
→ interview kickoff prompt queued when no user message is pending
→ workflow_interview_wizard runs in UI sessions
→ deep-interview-lite answers guide follow-up questions
```

## Preparation Flow

```text
interview
→ plan
→ plan_review
```

- `interview` clarifies topology, scope, acceptance criteria, constraints, and existing context.
- `plan` writes Korean source artifacts and English DPAA/SBADR artifacts.
- `plan_review` presents the plan, runs high-risk consensus review when metadata requires it, and waits for implementation approval.

## Guarded Implementation Flow

```text
plan_review approval
→ DPAA/SBADR precheck
→ implement
→ code_review
→ submit_review_package
→ review_approved
```

- DPAA/SBADR failures return to plan repair.
- `implement` changes only approved scope.
- `code_review` requires main self-review, independent review, and quality gate evidence.

## Documentation / Commit / Push Flow

```text
review_approved
→ document
→ commit
→ push
→ done
```

- Documentation reminders are advisory but must be addressed or explicitly marked not applicable.
- `commit → push` is a user approval boundary.
- `git push` is observed as the completion event for `push → done`.

## Continuation and Steering

- Continuation prompts are queued only when the agent is idle and no pending user message exists.
- Stale continuation and steer markers are consumed instead of being allowed to affect later phases.
- Read-only phases block write/edit calls immediately instead of queuing corrective follow-up noise.

## Recovery Events

- `/workflow state <phase>` is manual recovery only and does not create guard evidence.
- `/workflow abort` requires interactive confirmation and does not approve any guard.
- `/workflow trace <observation>` starts evidence-driven causal analysis before a fix.
- `compact-handoff` prepares a resume note before manual context compaction.

## Artifact and Evidence Rules

- Guard tokens stored as CustomEntries are audit-only after restart.
- Large handoffs should use artifact descriptors instead of raw inline content.
- Verification claims should cite commands, checks, or manual evidence actually observed.
