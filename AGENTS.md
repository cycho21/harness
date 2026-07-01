# DevCenter Project

**이 repo는 Pi harness를 개발하는 repo다.** `target/.pi/`가 배포 단위 소스이며, push 후 다른 프로젝트에서 `scripts/update-harness.sh`로 가져다 쓴다. `target/.pi/`를 직접 수정하는 것이 맞고, 이 repo 자체에 harness를 적용하는 게 아니다.

**개발 중 로컬 동기화**: `target/.pi/`를 수정한 후에는 `bash scripts/sync-dev-harness.sh` (Windows: `powershell -File scripts\sync-dev-harness.ps1`)를 실행해 `.pi/`에 반영한다. 이 dev repo 자체가 harness를 `.pi/`에서 로드하므로, 동기화 없이는 테스트와 실제 런타임이 달라진다.

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
- The only user-approval boundary is `commit → push`. From interview through commit everything is autonomous — guards that fail must be fixed and retried without asking the user. Auto-chain: `interview → plan → plan_review → implement → code_review → review_approved → document → commit`. In `code_review`, run main self-review, independent review, and quality gates, then call `submit_review_package`.
- If a guard blocks, read the reason, attempt to fix the underlying cause, and retry the operation autonomously. Do not report to the user unless the same guard blocks repeatedly — the extension will prompt for an explicit skip after repeated failures.
- If a workflow reminder is injected, address it explicitly; do not silently skip missing documentation, verification, review-package, commit-summary, or field-log evidence reminders.
- Do not simulate guard results, write token files, or claim approval on behalf of the user.
- Modifying installed runtime `.pi/extensions/**` requires explicit interactive user approval for that tool call; never create file-based approval markers. In this harness source repository, `target/.pi/extensions/**` is deployment-template source and is a normal development target.
- Code review guard satisfaction is recorded by the extension only after `submit_review_package` and quality gates pass; do not simulate token files or claim gate results without running the required checks.

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
- Decide test necessity autonomously: write/run tests when code or behavior changes need regression proof; do not write tests when there is no code/behavior change.
- Do not ask whether to write or skip tests. Only ask before destructive, slow, network-dependent, or resource-heavy tests.
- TDD is expected for production code; config/docs/infrastructure changes are exempt.
- TDD cycle (failing test → implement → verify) is a single work unit: do not pause to ask for approval between writing the test and implementing. Complete the full cycle autonomously.
- If a TDD gate triggers (untested production class detected, or new production code lacks a test): write the test first without asking. Do not ask the user whether to write a test.

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

Checkstyle/PMD/static analysis failures must be fixed in code. Fix them silently and autonomously — do not report failures to the user, do not ask before fixing.

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

## Gate Handling

When a workflow gate blocks, do not simply report the block and stop. Read the gate message and act:

- **If the cause is clear and fixable** (e.g. ambiguous plan sentence, missing metric, placeholder left in plan): propose a concrete fix, apply it after user confirmation, then re-run `/workflow approve`.
- **If the cause requires user input** (e.g. unclear requirement, architectural decision): explain the specific finding to the user, ask a targeted question, and wait for the answer before updating the plan.
- **Never silently skip or simulate a gate result.** Use `/workflow skip <gate> <reason>` only after explaining the reason to the user and receiving explicit approval.
- Gate messages are written in English and directed at you (the LLM). Present the relevant findings to the user in Korean.

## Documentation

Whenever a code or configuration change is made to this repository:

- Update `README.md` to reflect the change (new components, paths, commands, boundaries).
- Keep `README.en.md` in sync with `README.md` — both files must describe the same content.
- Do not commit without updating both README files if the change affects documented behaviour.

## Forbidden Actions

- Unrequested full-repository refactoring.
- Multi-file modification without confirmation.
- Destructive commands without explicit approval.
- Force push unless explicitly requested by the user.
- Creating commits without user approval or the active workflow phase requiring it.
- Making architecture assumptions when unclear.

## Encoding

All files must be UTF-8.
