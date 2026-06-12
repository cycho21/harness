# Workflow Prompt Contracts

This document defines which LLM-facing workflow prompts and protocol texts should be treated as stable contracts and covered by static or fixture tests.

## Why This Exists

Workflow behavior often changes through prompt text, not only TypeScript logic. Small wording changes can accidentally remove a required action, weaken a guard, or make the LLM ask the user when it should repair autonomously. Prompt contracts make those behaviors explicit.

## Contract Candidates

Add or update tests when changing text that controls:

- phase transition instructions in `[LLM WORKFLOW ACTION]`
- interview wizard kickoff rules
- plan review repair and high-risk consensus guidance
- code review package requirements, changed-scope coverage, and finding position validation
- documentation/verification/field-log reminders
- accepted-risk skip wording
- workspace mismatch and policy scan recovery instructions
- push execution constraints
- compact handoff, trace, cleanup, evidence-verification, continuation-safety, and worktree-safety protocols

## Test Styles

Use the narrowest stable test that catches the intended regression:

1. **Static token test** — assert required phrases remain present.
2. **Fixture prompt test** — render a representative prompt and compare important sections.
3. **Behavior smoke test** — drive the fake runtime through the phase or command.
4. **Golden benchmark** — reserve for complex reviewer/planner behavior where output shape matters.

Avoid brittle full-string snapshots unless exact formatting is the behavior being protected.

## Required Coverage Examples

- `/workflow start` kickoff must mention `workflow_interview_wizard`, topology confirmation, and clarity checkpoint.
- `/workflow trace` must request hypotheses, evidence for/against, rebuttal, critical unknown, and discriminating probe.
- `plan_review` high-risk guidance must mention Architect/Critic consensus review.
- `code_review` must require `submit_review_package` and independent review before approval.
- `code_review` skill text must preserve changed-file/hunk coverage checks and Critical/Major position validation.
- `push` must require policy scan approval and a real `git push` completion event.
- `compact-handoff` must say it does not invoke native compaction itself.

## Review Checklist

Before merging prompt/protocol changes:

- [ ] Does the changed text affect LLM behavior or only human explanation?
- [ ] Is there a static or runtime test for the required action?
- [ ] Could a future wording cleanup remove a guard instruction?
- [ ] Are Korean and English README descriptions still aligned?
- [ ] Are examples clearly non-authoritative when guard evidence is required?
