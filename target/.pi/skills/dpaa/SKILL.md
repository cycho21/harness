---
name: dpaa
description: Interpret and repair DPAA failures during `plan_review`. The workflow extension mechanically enforces DPAA before `implement`. Output language is Korean.
---

# DPAA Skill

DPAA is the deterministic ambiguity guard for plans. The extension enforces:

```text
plan_review → implement requires DPAA PASS
```

## Output Language

Respond in Korean.

## Artifacts

- Korean source of truth: `.ai/interview/spec.ko.md`, `.ai/interview/plan.ko.md`
- English DPAA inputs: `.ai/interview/spec.md`, `.ai/interview/plan.md`
- English files must be faithful translations of the Korean source; do not change them independently.

The extension checks the current plan from:

1. `.ai/interview/plan.md`
2. `docs/superpowers/plans/plan.md`
3. newest `docs/superpowers/plans/*.md`

## When DPAA Blocks

Do not implement and do not guess. For each relevant finding:

1. Explain the ambiguity in plain Korean.
2. Ask a targeted follow-up question or offer concrete options.
3. Wait for the user's answer.
4. Update the Korean source artifacts first.
5. Update the English DPAA artifacts as faithful translations.
6. Ask the user to approve the transition again.

Use `/workflow dpaa-audit` to inspect the latest receipt/snapshot when needed.

## Manual Check

```bash
PYTHONPATH=.pi python -m dpaa.cli .ai/interview/plan.md
```

If `python` is unavailable on macOS/Linux, use `python3`:

```bash
PYTHONPATH=.pi python3 -m dpaa.cli .ai/interview/plan.md
```

or:

```bash
PYTHONPATH=.pi python -m dpaa.cli docs/superpowers/plans/<plan-file>.md
```

## Success Criteria

- User-approved plan.
- DPAA PASS.
- Korean source artifacts and English DPAA artifacts describe the same requirements.
- Acceptance criteria are objective and no placeholders remain.
