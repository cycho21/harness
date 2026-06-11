---
name: cleanup
description: Use for regression-safe cleanup of AI slop, duplicate code, dead code, needless abstractions, or boundary leaks. Preserves behavior, prefers deletion, and requires verification. Output language is Korean.
---

# Cleanup Skill

Use this skill when the user asks for cleanup, anti-slop, simplification, dead-code removal, duplicate removal, or a behavior-preserving refactor.

Do not use this skill for feature work, broad redesign, or behavior changes unless the user explicitly includes those in scope.

## Principles

- Preserve behavior unless the user explicitly asks for a behavior change.
- Lock behavior with focused tests or a concrete verification plan before editing when practical.
- Prefer deletion over addition.
- Reuse existing utilities and patterns before adding new abstractions.
- Keep diffs small, reversible, and smell-focused.
- Do not silently expand scope beyond the requested files or feature area.

## Slop Categories

Classify the cleanup target before editing:

- **Duplication** — repeated logic or copy-paste branches.
- **Dead code** — unused exports, unreachable branches, stale flags, debug leftovers.
- **Needless abstraction** — pass-through wrappers, speculative layers, single-use helpers.
- **Boundary violation** — wrong-layer imports, hidden coupling, misplaced responsibilities.
- **Weak verification** — behavior not protected by tests or smoke checks.
- **Documentation drift** — behavior changed but README/feature docs were not updated.

## Workflow

1. Bound the cleanup surface to requested files or changed-file scope.
2. Identify behavior that must remain unchanged.
3. Choose the narrowest regression check or verification plan.
4. Write a short cleanup plan before editing.
5. Run one smell-focused pass at a time:
   - Pass 1: dead code deletion
   - Pass 2: duplicate removal
   - Pass 3: naming/error-handling simplification
   - Pass 4: verification or test reinforcement
6. Re-run relevant verification after each risky pass.
7. Stop if cleanup would require product or architecture decisions not already approved.

## Review Mode

If the user asks for cleanup review only:

1. Do not edit files.
2. Review the cleanup plan, changed files, and verification evidence.
3. Flag leftover slop, behavior drift, missing tests, or excessive abstraction.
4. Return required follow-ups instead of self-approving.

## Output Template

```markdown
## Cleanup Scope
- Files / area: <scope>
- Behavior to preserve: <behavior>

## Slop Classification
- <category>: <evidence>

## Cleanup Plan
1. <small reversible step>

## Verification
- <command or method>

## Result
- Changed files:
- Simplifications:
- Behavior lock / checks run:
- Remaining risks:
```

## Rules

- Do not mix unrelated refactors into one cleanup pass.
- Do not add dependencies for cleanup unless explicitly approved.
- For Java production behavior changes, follow the test-driven-development skill instead of treating the work as pure cleanup.
- If checkstyle/PMD/static analysis fails, fix the code rather than suppressing the rule.
