# DevCenter Project

Concise project instructions for Pi. Mechanical workflow enforcement lives in `.pi/extensions/workflow.ts`; this file tells the LLM how to behave.

## Working Style

- Think before coding. State assumptions; ask when intent is ambiguous.
- Keep changes surgical. Touch only files required by the user request/current phase.
- Prefer simple, direct solutions. No speculative abstractions or unrelated refactors.
- Verify completion with the narrowest relevant checks.
- Be concise in Korean unless the user asks otherwise.

## Workflow Discipline

Follow `/workflow status`.

```text
interview → plan → plan_review → implement → code_review → review_approved → document → commit → push → done
```

Rules:

- Work only in the current phase.
- Ask the user before advancing phases.
- If a guard blocks, report the blocker and wait.
- Do not simulate guard results, write token files, or claim approval on behalf of the user.
- Code review guard satisfaction is confirmed by the user through the extension, not by an LLM tool result.

## Scope Rules

- Start narrow: file/function level before broader exploration.
- Do not traverse imports or read unrelated files unless needed.
- If scope grows beyond the original request, stop and ask.
- Avoid full-repository scans unless explicitly requested.

## Implementation Rules

Before editing:

1. Restate the problem briefly.
2. Identify affected files; if more than 5, ask before proceeding.
3. Define verification.

During editing:

- Modify only the agreed files.
- Do not improve adjacent code opportunistically.
- Preserve existing architecture and style unless the task is to change them.

After editing:

- Summarize changed files.
- Mention side effects and verification performed.

## Testing Policy

- Implement/fix requests include permission to run the minimum relevant local tests.
- Prefer narrow tests first: unit → targeted command → smoke.
- Ask before destructive, slow, network-dependent, or resource-heavy tests.
- TDD is expected for production code; config/docs/infrastructure changes are exempt.

## Worktrees

Create worktrees only under project-root `.worktrees/`.

```text
✅ .worktrees/<branch-name>
❌ .pi/worktrees/<branch-name>
```

## Project Memory

Before non-trivial work, check project memory if present:

- `.project-memory/INDEX.md` for team memory
- `.project-memory/personal/INDEX.md` for personal memory

Add new memory only after user approval.

## Governance / Personas

Delegation, role selection, and persona loading are in `.pi/GOVERNANCE.md`.

Load personas only when relevant:

- architecture/API/schema/security-sensitive design → architect
- Java/Spring implementation/testing → developer
- review/security/performance/architecture validation → reviewer

## Code Quality

Checkstyle/PMD violations must be fixed in code.

- Do not edit `checkstyle.xml` or `suppressions.xml` to silence violations.
- Do not add `// CHECKSTYLE:OFF`.
- Load `.pi/skills/code-review/references/checkstyle-conventions.md` before fixing unfamiliar violations.

## Architecture Rules

Follow existing ADRs in `docs/adr/`.

Core defaults:

- Controller → Service → Repository → Entity.
- DTOs for API boundaries; do not expose entities directly.
- `@Transactional` belongs on service layer.
- Prefer constructor injection.
- Use `@ControllerAdvice` for global exception handling.

For new architecture decisions, create/update ADRs only after user approval.

## Forbidden Actions

- Unrequested full-repository refactoring.
- Multi-file modification without confirmation.
- Destructive commands without explicit approval.
- Force push unless explicitly requested by the user.
- Creating commits without user approval or the active workflow phase requiring it.
- Making architecture assumptions when unclear.

## Encoding

All files must be UTF-8.
