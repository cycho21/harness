---
name: push-with-review
description: Legacy convenience skill for the post-implementation path. Prefer the explicit workflow phases (`code_review → review_approved → document → commit → push`). Use this skill only as a checklist helper when the user asks for push/review guidance. Output language is Korean.
---

# Push / Review Checklist Helper

The workflow extension owns phase transitions and push enforcement. This skill must not bypass `/workflow` or create guard tokens.

## Output Language

Respond in Korean.

## Use

Use as a checklist helper when the user asks to prepare for push. Follow the active `/workflow status` phase.

## Phase Checklist

### `code_review`

1. Run `/skill:code-review-gate` or `/skill:code-review` on staged and unstaged changes.
2. Fix Critical issues and Major issues above threshold.
3. Repeat review until:
   - Critical = 0
   - Major ≤ 2
4. Ask the user to run/approve `/workflow approve`; the extension will ask for explicit guard confirmation and run `codeQualityGuard`.

### `review_approved`

- Confirm review findings are addressed or explicitly accepted.
- Ask before moving to documentation.

### `document`

- For feature/API/schema/architecture-impacting changes, run `/skill:document-feature`.
- Regenerate Swagger/OpenAPI when API behavior changed.
- Ask before moving to commit.

### `commit`

1. Show branch, changed files, and concise commit summary.
2. Validate scope: changes should match the branch/task purpose.
3. Propose commit message.
4. Wait for user approval before committing.

### `push`

- Run `git push` only in `push` phase.
- If push fails, stop. Explain cause and options; wait for user approval before retry/rebase/force-push.

## Rules

- Do not run `git push` outside `push` phase.
- Do not retry failed git commands automatically.
- Do not force-push unless the user explicitly requests it.
- Do not claim guard satisfaction; the extension records it after user confirmation.
