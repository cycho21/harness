# DevCenter Project
---
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Coding Principles

**Think before coding.** State assumptions explicitly. If multiple interpretations exist, surface them — don't pick silently. If unclear, stop and ask.

**Simplicity first.** Write the minimum code that solves the problem. No speculative features, abstractions for single use, or error handling for impossible scenarios. Ask: "Would a senior engineer say this is overcomplicated?"

**Surgical changes.** Touch only what the task requires. Don't improve adjacent code, refactor unrelated things, or remove pre-existing dead code. Every changed line should trace to the user's request.

**Verify completion.** Define success criteria before starting. For multi-step tasks, state a plan with verification steps. A task isn't done until it's verified, not just "looks right."

## Core Philosophies
1. **TDD**: Test-first for production code. Configuration, documentation, and infrastructure changes are exempt.
2. **Clean Architecture**: Business logic independent of frameworks, UI, and DB. High cohesion, low coupling.

## Output Style
- Concise, no unnecessary explanations, no repetition
- Focus on actionable output only

## Priority Order
1. Avoid unnecessary token waste (no re-reading known files, no verbose summaries)
2. Minimize scope (don't expand beyond what's asked)
3. Correctness over coverage (be right about less rather than wrong about more)

---

## Agent Governance

Roles, approval protocol, model selection, and pre-work checklist are defined in [`.pi/GOVERNANCE.md`](./.pi/GOVERNANCE.md). Read it before delegating to sub-agents or starting multi-file tasks.

**Persona pre-work is self-enforced** (no gate): for architectural or security-sensitive files, load the relevant persona doc from `.pi/personas/` before editing. The checklist is in GOVERNANCE.md.

---

## Project Memory

Project-specific failure patterns and learnings are stored here so they don't have to be relearned each session. Two layers:

| Layer | Path | Git | Purpose |
|-------|------|-----|---------|
| Team | `.project-memory/` | ✅ tracked | Architecture pitfalls, shared patterns |
| Personal | `.project-memory/personal/` | ❌ gitignored | Individual habits, personal patterns |

**Before starting any task:**
1. Read `.project-memory/INDEX.md` (team)
2. If `.project-memory/personal/INDEX.md` exists, read it too
3. Load relevant files using the Read tool before beginning

**After finishing a task:**
- Team-relevant learning → propose adding to `.project-memory/`
- Personal pattern → propose adding to `.project-memory/personal/`
- Write the file and update the appropriate `INDEX.md` only after user approval

**Memory file format:**
```markdown
---
tags: [tag1, tag2]
added: YYYY-MM-DD
---

## Context
## Failed approach
## Correct approach
## Core rule
One-line summary
```

---

## Core Execution Rules

### Scope Limitation (MANDATORY)
Loading unused files wastes context and slows reasoning — start narrow and expand only when needed.
- Never read the entire repository unless explicitly instructed
- Always start at file/function level
- Ask before accessing additional files

### No Implicit Expansion
Traversing imports automatically pulls in unrelated context and risks unintended side effects.
- Do not assume related files or traverse imports automatically
- Only expand scope after user confirmation

### Step Separation (CRITICAL)
Mixing analysis with edits makes it impossible to catch misunderstandings before code is written. If you discover the approach is wrong mid-implementation, the rollback cost is high.
1. **Analysis** (no code changes)
2. Scope identification
3. Design decision
4. Implementation
5. Validation

### Before / During / After Implementation
- **Before**: Briefly explain the problem → list affected files (max 5) → confirm if scope > 1 file
- **During**: Modify ONLY the specified file. No unrelated refactoring or optimization.
- **After**: List potential side effects → suggest test cases → do NOT auto-run further changes

---

## Worktree Directory (MANDATORY)

Always create worktrees in `.worktrees/` at the project root. **Never use `.pi/worktrees/`.**

```
✅  .worktrees/<branch-name>
❌  .pi/worktrees/<branch-name>
```

When using `EnterWorktree` or any native worktree tool, verify the target path before creation. If the tool defaults to `.pi/worktrees/`, override it or use `git worktree add .worktrees/<name> -b <name>` directly.

---

## Push/Commit Protocols (MANDATORY)

For push and commit workflows, see the `/push-with-review` skill (Single Source of Truth).

**Core principle:** Invoking the `/push-with-review` skill itself counts as user approval. Commits and pushes proceed automatically within the skill, but retries on failure require explicit user approval.

---

## Harness Gates v2

Harness gates are implemented as a Pi extension in `.pi/extensions/harness-gates.ts`.

- **Final-stage gates (deny)**: 커밋 시점에서 결정론적으로 차단. 우회 불가.
- **Advisory context**: 브랜치, 리뷰 토큰, workflow state를 system prompt에 주입. 차단하지 않음.

### Final-Stage Gates (커밋 시점, deny)

| Gate | Behavior | Trigger |
|------|----------|---------|
| Commit message gate | **Deny** — Conventional Commits 형식 강제 | `git commit -m ...` 메시지 형식 위반 |
| Code review gate | **Deny** — `/skill:code-review` 결과 필수 (Critical=0, Major≤2, TTL 60분) | 리뷰 없음 또는 미통과 |

### Advisory Context (차단 없음)

| Context | Purpose |
|---------|---------|
| Session status | 브랜치, 미테스트 클래스, 리뷰 토큰 상태 안내 |
| Workflow state | `/workflow start/approve/undo/redo/status` 기반 현재 단계 안내 |
| Persona guidance | Entity/Security/Gradle 등 민감 변경 전 `.pi/personas/` 문서 수동 로드 |

### Code Review Gate

`/skill:code-review` 완료 후 `submit_review_result` 도구를 호출해야 합니다.
- Token location: process memory only — 파일로 위조 불가
- TTL: 60 minutes — expired review requires re-running `/skill:code-review`
- Threshold: Critical=0, Major≤2 → commit allowed; else denied

### TDD (지침 — 코드리뷰에서 검증)

TDD는 gate이 아닌 지침으로 운영합니다. 코드리뷰 게이트에서 테스트 누락이 검증됩니다.

1. 새 클래스 작성 전 `XxxTest.java` (`@Test` 포함) 먼저 작성
2. 테스트 실패(Red) 확인 후 구현(Green) 시작
3. Edit 시에도 변경 내용에 대응하는 테스트가 있어야 함
4. 버그 수정 시 재현 테스트 먼저 작성
5. `@Test void dummy() {}` 같은 형식적 테스트는 리뷰에서 거부됨

Exempt: `DTO|Request|Response|Config|Configuration|Application|Properties|Exception|Enum|Record|Constants`

### 커버리지 (지침 — CI에서 강제)

커버리지는 커밋 시점이 아닌 CI/CD 파이프라인에서 검증합니다.

- 변경한 클래스의 라인 커버리지: 모듈별 임계값 유지 (기본 60%)
- `./gradlew :<module>:test jacocoTestReport`로 로컬 확인 가능
- CI에서 `jacocoTestCoverageVerification` 실패 시 MR merge 차단

### Multi-Agent Pattern

When using `/subagent-driven-development` skill:
- Invoking the skill counts as user approval for the full implementation cycle
- Sub-agents commit automatically once code-review gate + commit-message gate + static-analysis gate all pass
- Sub-agents must run `/code-review` before each commit; gates enforce this
- Architecture/design questions escalate to main session — sub-agents never guess

## Forbidden Actions
- Full repository refactoring
- Multi-file modification without confirmation
- Destructive / long-running / network-dependent tests without explicit approval
- Rewriting code outside requested scope
- Making assumptions about architecture
- Creating a git commit without approval — except when executing via an approved skill workflow (e.g., `push-with-review`, `subagent-driven-development`)

## Test Execution Policy
- Implement/fix requests implicitly include permission to run the **minimum relevant local tests**
- Prefer narrowest verification first (unit test → targeted command → smoke test)
- **Ask** before running destructive, slow, network-dependent, or resource-heavy tests

---

## Code Quality (Checkstyle / PMD)

**See `.pi/skills/code-review/references/checkstyle-conventions.md` for fix patterns** (load it before touching violations). Human-readable version: `docs/conventions/checkstyle.ko.md`.

Core rules:
- **절대 `checkstyle.xml` / `suppressions.xml` 수정 금지** — 항상 코드를 수정
- `// CHECKSTYLE:OFF` 주석도 금지 (코드 가드레일 훅이 커밋 차단)
- 수정 전에 정확히 무엇을 어떻게 수정할지 사용자에게 물어보고 진행

---

## Architecture Decision Records (ADR)

**All architectural decisions are documented in `docs/adr/`**

Core architectural rules (see [ADR-0001](./docs/adr/0001-spring-boot-layered-architecture.md)):
- **Layer separation**: Controller → Service → Repository → Entity (never skip layers)
- **DTO/Entity separation**: DTOs for API, Entities for persistence (never expose entities directly)
- **Transaction boundaries**: `@Transactional` on service layer only, not controllers
- **Dependency injection**: Constructor injection (not `@Autowired` fields)
- **Exception handling**: `@ControllerAdvice` for global exception handling

When making architectural decisions:
1. Check existing ADRs in `docs/adr/`
2. For new decisions, create ADR using template at `docs/adr/template.md`
3. Update `docs/adr/README.md` index

**Architecture governance**: When editing Entity, Controller, or Gradle files, load the relevant persona doc from `.pi/personas/` before proceeding.

---

## File Encoding
- All files must be **UTF-8** encoded
- PowerShell read: `Get-Content -Encoding utf8`
- PowerShell write: `Set-Content -Encoding utf8`

## Token Optimization
1. Don't re-read files already accessed in session
2. Execute parallel tool calls when possible
3. Limit shell command output (use head/tail)
4. Delegate 20+ line outputs to subagents
5. Use .piignore actively when available
