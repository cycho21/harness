# Claude Code Workflow Gate

This directory contains the lightweight Claude Code port of the pi workflow gate. Claude Code integration lives in `.claude/`; workflow state, shared policy, authority files, and compatibility proposal artifacts live here.

The Claude Code component does not enable the built-in Bash sandbox by default because the UX cost is high. Instead, `UserPromptSubmit` reminders keep workflow rules visible and the `PreToolUse` hook blocks Claude Code file tools (`Edit`, `Write`, `MultiEdit`) from touching protected paths or skipping phases.

## State flow

The default phase model mirrors the pi workflow extension. Phase order and approval boundaries are declared in `.harness/workflow-policy.json`, which is the shared Pi/Claude policy SSOT:

```text
interview -> plan -> plan_review -> implement -> code_review -> review_approved -> document -> commit -> push -> done
```

Automatic progress windows:

```text
interview -> plan -> plan_review
implement -> code_review
review_approved -> document -> commit
```

Approval boundaries:

```text
plan_review -> implement
commit -> push
```

## Claude slash commands

The component seeds prompt commands under `.claude/commands/workflow/`:

```text
/workflow:start <goal>
/workflow:status
/workflow:approve
/workflow:list
/workflow:load
/workflow:history
/workflow:snapshot <reason>
/workflow:submit-review-package critical=0 major=0 minor=0 summary="..."
/workflow:undo
/workflow:redo
/workflow:skip <gate> <reason>
/workflow:failures [export]
/workflow:doctor
/workflow:state <phase>
/workflow:abort
```

These commands call the gate CLI:

```bash
node .claude/hooks/workflow-gate.cjs <command>
```

Additional ported pi commands:

```text
/workflow:checkpoint <reason>
/workflow:checkpoints
/workflow:restore <checkpoint-prefix>
/workflow:dpaa-audit
```

## Ported mechanical gates

- `plan_review -> implement`: requires `plan-review.json` approval, then runs DPAA against `.ai/interview/plan.md` or `docs/superpowers/plans/*.md`. If CoreNLP is available or installable, SBADR runs after DPAA PASS.
- `code_review -> review_approved`: requires `review-package.json` approval, then runs `HARNESS_CODE_QUALITY_GUARD_CMD` or Gradle `codeQualityGuard` when a Gradle project is detected.
- `commit -> push`: scans risky changed paths and requires `push-approval.json` if the scan finds protected harness or secret-like files. `push-approval.json` may include a `signature` matching the policy scan.
- Push guard: blocks `git -C <path> push`, workspace/branch mismatches, and pushes outside the `push` phase.
- Workspace checkpoints: stores staged/unstaged patches and untracked files under `.harness/checkpoints/<workflow-id>/` and can restore by prefix. Phase transitions create checkpoints; `/workflow:undo` and `/workflow:redo` restore workspace state as well as phase state.
- Field logs: gate failures and policy blocks append JSONL events to `.project-memory/harness/events.jsonl`.
- Workflow catalog: `/workflow:list` shows the active/persisted workflow and `.pi/workflows/*.md` catalog entries.
- Natural-language approval: `UserPromptSubmit` detects explicit approvals such as `응 진행해` at approval boundaries and advances the workflow.
- Prompt guidance: `UserPromptSubmit` injects current phase guidance as a system message each turn, including next-phase/no-skip/subagent reminders from `.harness/workflow-policy.json`.
- Context management: implementation, code review, large diff analysis, and log analysis should prefer subagents so the main agent remains a workflow controller.

## Claude-writable artifacts

Primary pi-compatible artifacts:

- `.ai/interview/spec.md`
- `.ai/interview/spec.ko.md`
- `.ai/interview/plan.md`
- `.ai/interview/plan.ko.md`
- `docs/superpowers/plans/*.md`

Compatibility proposal files:

- `.harness/proposal/interview.md`
- `.harness/proposal/interview.yaml`
- `.harness/proposal/implementation-summary.md`
- `.harness/proposal/docs-summary.md`

## Protected gate files

The hook and Claude Code settings treat these as protected paths. Claude should not edit them directly.

- `.claude/**`
- `.harness/state.json`
- `.harness/workflow.json`
- `.harness/.authority-runtime/**` — generated runtime recovery/skip artifacts; hook only; ignored by `.harness/.gitignore`
- `.harness/workflow-policy.json` — shared Pi/Claude workflow policy declaration
- `.harness/checkpoints/**`, `.harness/dpaa-runs/**` — generated runtime artifacts; ignored by `.harness/.gitignore`
- `.harness/authority/**`
- `.harness/policy.yaml`

## User/reviewer authority files

- `.harness/authority/plan-review.json`
- `.harness/authority/review-package.json`
- `.harness/authority/push-approval.json`

To approve implementation, a human/reviewer updates `plan-review.json`:

```json
{
  "status": "approved",
  "approved_allowed_files": ["src/example.ts"],
  "approved_test_plan": ["npm test"]
}
```

To approve the code review package, update `review-package.json`:

```json
{
  "status": "approved",
  "summary": "Self-review, independent review, and quality checks passed.",
  "critical": 0,
  "major": 0,
  "minor": 0
}
```

To approve push, update `push-approval.json`:

```json
{ "status": "approved", "reason": "Policy scan accepted" }
```
