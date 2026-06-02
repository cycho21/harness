# Workflow Context Management Improvement Plan

## Goal

Phase 1 goal: keep the main agent compact and reliable by preventing context pollution during long workflows.

Phase 2 goal: add lightweight recovery state for context pressure or compaction after the reminder behavior is stable.

## Scope

Add lightweight workflow/context guidance before implementing heavier recovery machinery.

## Proposed Changes

### 1. Phase context strategy

Add concise phase-specific context strategy to `.harness/workflow-policy.json`.

For each relevant phase, define:

- default delegation target
- what the main agent should keep
- what the main agent should avoid loading

Initial focus:

- `implement`
- `code_review`
- `document`
- `commit`

Example intent:

```text
implement:
- delegate implementation/log-heavy work to worker subagents
- main keeps changed files, summary, verification, risks
- main avoids raw logs, large diffs, file dumps

code_review:
- delegate independent review to reviewer subagents
- main keeps finding counts, fix summary, quality result, blockers
- main avoids full review transcript and full logs
```

### 2. Subagent handoff contract

Define a short expected output format for context-heavy subagent work:

```text
Summary:
Changed files:
Verification:
Risks:
Blockers:
Recommended next step:
```

Use this as reminder guidance, not a new hard gate.

### 3. Prompt reminder integration

Update Pi and Claude prompt injection to include only the current phase's context strategy and handoff contract.

Slice 1 displays context strategy only for:

- `implement`
- `code_review`
- `document`
- `commit`

Keep reminders short:

```text
[CONTEXT STRATEGY: code_review]
- Delegate independent review and heavy fixes.
- Keep only finding counts, fix summary, quality result, blockers.
- Avoid full logs/review transcripts in main context.
[/CONTEXT STRATEGY]
```

### 4. Compact recovery summary

Add a lightweight summary command/artifact later, after reminder behavior is stable.

Candidate artifact:

```text
.harness/session-summary.md
```

Candidate fields:

```text
Current phase:
Next phase:
Approved scope:
Changed files:
Verification:
Review status:
Blockers:
Next action:
```

This is a second step, not part of the first implementation slice unless needed.

## Non-goals

- Do not add a new `revise` phase.
- Do not enable Claude Bash sandbox by default.
- Do not add new user approval boundaries.
- Do not add heavy automatic compaction logic in the first slice.
- Do not make reminders verbose.

## Implementation Slice 1

1. Add `contextStrategy` and `subagentHandoffContract` to `.harness/workflow-policy.json`.

   Minimal JSON shape:

   ```json
   {
     "contextStrategy": {
       "implement": {
         "delegateTo": "worker",
         "mainKeeps": ["changed files", "summary", "verification", "risks"],
         "mainAvoids": ["raw logs", "large diffs", "file dumps"]
       },
       "code_review": {
         "delegateTo": "reviewer",
         "mainKeeps": ["finding counts", "fix summary", "quality result", "blockers"],
         "mainAvoids": ["full review transcript", "full logs"]
       }
     },
     "subagentHandoffContract": [
       "Summary",
       "Changed files",
       "Verification",
       "Risks",
       "Blockers",
       "Recommended next step"
     ]
   }
   ```

2. Extend Pi policy loader types/defaults.
3. Extend Claude policy loader fallback.
4. Render current phase context strategy in Pi/Claude prompt reminders for `implement`, `code_review`, `document`, and `commit` only.
5. Add focused tests for reminder rendering.
6. Update README/README.en.md briefly.

## Verification

- `node -c target/.claude/hooks/workflow-gate.cjs`
- `python -m pytest tests/test_claude_workflow_gate.py tests/test_workflow_ts_static.py -q`

## Risks

- Reminder text can become too long; keep only current phase strategy.
- Policy schema can grow too broad; keep fields declarative and small.
- Subagent output contract may be ignored unless consistently included in prompts.

## Open Questions

- Should `.harness/session-summary.md` be generated at every phase transition or only on demand?
- After Slice 1, should context strategy be expanded to `interview`/`plan`, or kept only for context-heavy phases?
