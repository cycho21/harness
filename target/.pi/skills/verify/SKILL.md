---
name: verify
description: Use before claiming completion. Turns vague "it works" statements into concrete evidence from tests, build/typecheck, narrow commands, or explicit manual checks. Output language is Korean.
---

# Verify Skill

Use this skill whenever a feature, fix, refactor, workflow change, documentation rendering, or guard behavior must be proven before completion is claimed.

## Goal

Report only what was actually verified. Never imply completion without evidence.

## Verification Order

Prefer the narrowest reliable check first:

1. Existing targeted tests for the touched behavior.
2. Typecheck, build, lint, or static tests relevant to the touched area.
3. Narrow direct command or smoke check.
4. Manual validation steps with observable evidence.
5. If none is realistic, explicitly state what remains unverified.

## Workflow

1. Identify the exact behavior or claim that needs proof.
2. Map each acceptance criterion or changed behavior to at least one verification path.
3. Run the minimum relevant checks permitted by the current workflow phase.
4. If a check fails, fix the underlying cause when in an editable phase; otherwise report the blocker.
5. Summarize evidence concisely. Do not paste noisy logs unless the failure detail is needed.

## Output Template

```markdown
## Verification Summary
- Claim: <what is being verified>
- Result: passed / failed / partially verified / not verified

## Checks Run
| Check | Command / Method | Result | Evidence |
|-------|------------------|--------|----------|
| ... | ... | pass/fail | ... |

## Acceptance Criteria Coverage
- [ ] <criterion>: verified by <check>

## Remaining Unverified Items
- <none or explicit residual risk>
```

## Rules

- Do not say "complete", "done", or "works" unless the verification evidence supports it.
- Distinguish "not run" from "passed".
- If verification is skipped because the change is documentation-only, say why no runtime check was needed and still run `git diff --check` when practical.
- For workflow/code-review phases, respect phase tool policy and use workflow-approved commands when available.
