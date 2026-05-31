---
name: code-review
description: For Java/Spring Boot code review. Use this skill when the user says "review", "check this code", "is this ready to push", "코드 리뷰", "리뷰해줘", "푸시 전에 봐줘", "이거 괜찮아?", or during the `code_review` workflow phase. Even simple changes benefit from review. Output language is Korean; skill instructions are English.
---

# Code Review Skill

Perform thorough pre-push code reviews focusing on code quality, bug detection, performance, naming conventions, and test coverage.

> **출력 언어**: 모든 리뷰 결과와 피드백은 한국어로 작성합니다. 스킬 설명은 영어입니다.

## Reviewer Perspective

Review as a **senior engineer on the DevCenter team** who:
- Knows the project's ADR-0001 architecture and team conventions
- Values pragmatism over perfection (working code > theoretical purity)
- Focuses on bugs and architectural issues, not style preferences
- Gives actionable feedback with concrete fix suggestions
- Respects the "Surgical Changes" principle (only review changed code)

## Review Framework

Evaluate every change across these five dimensions:

1. **Correctness** — Does the code do what it should? Edge cases handled (null, empty, boundary values, error paths)? Race conditions or off-by-one errors?
2. **Readability** — Can another engineer understand this without explanation? Names descriptive and consistent? Control flow clear (no deeply nested logic)?
3. **Architecture** — Follows existing patterns? Module boundaries maintained? Abstraction level appropriate (not over-engineered, not too coupled)?
4. **Security** — Input validated at system boundaries? Auth/authz checked? Secrets safe from logs/VCS? (→ `references/security-checklist.md`)
5. **Performance** — N+1 query patterns? Unbounded loops or unconstrained data fetching? Missing pagination? (→ `references/performance-checklist.md`)

## Review Process

Follow this workflow for every code review request:

1. **Read task/context first**: Read the git commit message, PR description, or user's explanation — it reveals intent and what "correct" looks like before touching a single line of code
2. **Review tests before implementation**: Tests reveal intent and coverage gaps; if tests are wrong, the whole review is off
3. **Identify the target**: Determine what code to review (files, directories, or git diff)
4. **Load project context**:
   - For Java/Spring Boot: read `references/java-checklist.md` before analysis — without it, you'll flag Jackson/JPA fields as "unused" and miss ADR-0001 violations specific to this codebase
5. **Read the code**: Use appropriate tools to read file contents
6. **Analyze by dimension**: Apply the five-dimension framework above, using language-specific checklists
7. **Generate report**: Provide prioritized findings with clear explanations

## Diff-Aware Review

- **Focus on changed lines**, not pre-existing code
- Only flag pre-existing issues if they interact with the changed code
- Never suggest "while you're here" improvements to adjacent code
- This aligns with the project's "Surgical Changes" principle (AGENTS.md)

## Review Scope

### What to Review

- Code quality and readability
- Potential bugs and logic errors
- Performance issues and anti-patterns
- Naming conventions and code style
- Test coverage and test quality
- Design patterns and architecture

### Diff Size Limits

**Recommended limits for effective review:**
- **Ideal**: 1-5 files, <300 lines changed
- **Good**: 6-10 files, 300-500 lines changed
- **Maximum**: 15 files, <1000 lines changed

**If diff exceeds maximum:**
- Ask user to split into smaller commits/PRs
- Review high-impact files first (controllers, services)
- Focus on critical issues only (logic errors, security)

**Tip**: Large diffs (>500 lines) reduce review effectiveness. Smaller, focused changes catch more bugs.

### What NOT to Review

- Infrastructure configurations (Terraform, Kubernetes YAML)
- Build scripts (unless specifically requested)
- Pre-existing code not touched in this diff

## Language-Specific Guidelines

**Java/Spring Boot (DevCenter):**
- Read `references/java-checklist.md` before analysis — it has DevCenter-specific patterns (ADR-0001 rules, reflection-used fields, framework conventions) that generic review misses
- Without it: Jackson/JPA fields get flagged as "unused", ADR-0001 layer violations go undetected, project scoring criteria are ignored

## Specialized Review Perspectives

For focused or in-depth reviews, load additional perspective-specific checklists:

**Security Review** (OWASP Top 10, authentication, authorization):
- Read `references/security-checklist.md`
- Use when: Pre-release security audit, authentication changes, sensitive data handling

**Performance Review** (N+1 queries, algorithm complexity, caching):
- Read `references/performance-checklist.md`
- Use when: API response time > 500ms, large dataset changes, optimization needed

**Architecture Review** (ADR-0001 compliance, layer separation, domain model):
- Read `references/architecture-checklist.md`
- Use when: New feature design, refactoring, cross-cutting concerns

**Testing Review** (TDD compliance, coverage quality, test structure):
- Read `references/testing-checklist.md`
- Use when: Reviewing test code, coverage below threshold, flaky tests

**When to use specialized checklists:**
- **General commit review**: `java-checklist.md` only (comprehensive baseline)
- **Release audit**: All 4 specialized checklists
- **Specific concern**: Load relevant checklist (e.g., performance-checklist.md for slow API)

**How to combine:**
```
1. Always load java-checklist.md (baseline + project context)
2. Add specialized checklists as needed
3. Aggregate findings by severity (Critical/Major/Minor)
4. Report perspective-specific issues in separate sections
```

## Output Format

**IMPORTANT**: All output must be in Korean. Structure review feedback as follows:

```
# 코드 리뷰 결과

**리뷰 대상**: [파일 목록]
**언어**: [Java/Go]
**판정**: ✅ 커밋 가능 | ⚠️ 수정 필요 | 🔴 대폭 수정 필요

**개요**: [1-2문장으로 변경사항 성격과 전반적 평가 요약]

## 🔴 Critical Issues (커밋 전 필수 수정)
[버그, 크래시, 심각한 문제를 일으킬 이슈들 — 파일:라인 포함, 수정 방법 필수]

## 🟡 Major Issues (수정 권장)
[코드 품질, 유지보수성, 성능에 영향을 주는 이슈들 — 파일:라인 포함, 수정 방법 필수]

## 🔵 Minor Issues (개선 고려)
[스타일 이슈, 작은 개선사항, 제안]

## ✅ 긍정적 관찰사항 (최소 1개 필수)
[잘 작성된 부분, 좋은 패턴 — 구체적으로 명시]

## 🔍 검증 현황
- 테스트 검토: [예/아니오, 관찰 사항]
- 빌드 확인: [예/아니오]
- 보안 점검: [예/아니오, 관찰 사항]
```

## Priority Definitions

- **🔴 Critical**: Logic errors, null pointer risks, resource leaks, race conditions, incorrect API usage
- **🟡 Major**: Poor naming, code duplication, missing error handling, performance issues, missing tests
- **🔵 Minor**: Formatting, minor style inconsistencies, better alternatives, documentation suggestions

## Example Usage

User: "Review this file before I commit"
→ Read the file, identify language, apply checklist, generate report

User: "Review my recent changes"
→ Use git diff to see changes, review only modified code

User: "Check if this code is ready to commit"
→ Full review with commit readiness assessment

## Review Rules

1. **Tests first** — read tests before implementation; they reveal intent and coverage
2. **Read context first** — task description or commit context before touching code
3. **Fix required for Critical/Major** — every Critical and Major finding must include a specific, actionable fix recommendation; flagging without guiding is not useful
4. **Positive feedback required** — always include at least one specific positive observation; vague praise ("looks good") doesn't count
5. **No approval with Critical** — don't approve code that has Critical issues
6. **Uncertainty → say so** — if uncertain, flag it and suggest investigation rather than guessing; "I'm not sure if X is intentional" is more useful than a wrong confident statement
7. **Diff-aware** — focus on changed lines; never flag pre-existing code unless it directly interacts with the change

## Workflow Integration

This skill produces the human-readable review report only. It does not unlock workflow guards by itself.

During `code_review`, use `/skill:code-review-gate` for the review/fix loop. The user confirms guard satisfaction through `/workflow approve`; the extension records the in-memory guard state and runs mechanical quality checks.

Review threshold:
- ✅ Satisfied: Critical == 0 AND Major <= 2
- ⚠️ Not satisfied: Critical >= 1 OR Major >= 3
