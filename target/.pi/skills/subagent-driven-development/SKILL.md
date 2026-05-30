---
name: subagent-driven-development
description: Main-agent-as-user-proxy pattern for implementing plans via sub-agents while keeping the main session context-light. Invoke after planning-and-task-breakdown produces a plan. Main session holds design intent and reviews; sub-agents write code, run tests, and fix issues. Commits proceed automatically once TDD gate + code-review gate pass. Use when user says "실행해줘", "구현해줘", "서브에이전트로 해줘", or after a plan is approved.
---

# Subagent-Driven Development

> **핵심 원칙**: 메인 세션 = 사용자 복제본 (의도와 맥락 보유). 서브 에이전트 = 구현 실행자 (좁은 컨텍스트, 명확한 지시).

## Purpose

인터뷰와 계획 단계를 거친 메인 세션은 전체 맥락(비즈니스 의도, 설계 결정, 교차 의존성)을 보유한다.
구현은 서브 에이전트에게 위임하여 메인 세션의 컨텍스트 오염을 방지한다.

```
메인 세션 (user proxy)
  ├── 계획 보유
  ├── 설계 결정 보유
  ├── 서브 에이전트 출력 검토
  └── push-with-review 최종 실행

서브 에이전트 (implementer)
  ├── 단일 태스크 구현
  ├── TDD 게이트 통과 (테스트 먼저)
  └── 코드 리뷰 서브 에이전트에 보고
```

## When to Use

- planning-and-task-breakdown 스킬이 실행 계획을 생성한 후
- 3개 이상의 파일을 건드리는 피처 구현 시
- 메인 세션의 컨텍스트가 이미 인터뷰/설계 정보로 무거울 때

**사용하지 않아도 되는 경우:** 단일 파일 수정, 간단한 버그 픽스 (직접 구현이 빠름).

---

## Approval Protocol

이 스킬을 호출하는 것 자체가 전체 구현 사이클에 대한 사용자 승인이다.
개별 태스크 커밋은 다음 세 조건 충족 시 자동 진행한다:

1. **TDD 게이트**: 구현 파일 전 테스트 파일(`@Test` 포함) 작성 완료
2. **코드 리뷰 게이트**: Critical=0, Major≤2 (`/code-review` 스킬 실행)
3. **커밋 메시지 게이트**: Conventional Commits 형식 준수

추가 사용자 승인 없이 진행 가능. 단, 서브 에이전트가 **아키텍처 결정이나 설계 충돌**에 부딪히면 메인 에이전트에게 보고 후 대기해야 한다 — 추측해서 진행하지 않는다.

---

## The Cycle

### Step 0: 계획 로드

```
Read the plan file produced by planning-and-task-breakdown.
Identify: task list, dependencies, file targets, acceptance criteria.
Set up TaskCreate entries for each task.
```

### Step 1: 구현 서브 에이전트 실행

각 태스크마다 Agent 툴을 사용해 서브 에이전트를 생성한다. **태스크 하나 = 에이전트 하나**.

독립적 태스크는 병렬 실행 가능. 의존성이 있는 태스크는 순차 실행.

```
Agent({
  description: "Implement Task N: <task title>",
  prompt: [구현 에이전트 프롬프트 템플릿 참고],
  isolation: "worktree"  // 필요한 경우
})
```

### Step 2: 출력 검토

서브 에이전트 완료 후 메인 에이전트는:
1. 에이전트 결과 요약만 읽음 (원본 파일 전체를 main context로 읽어들이지 않음)
2. 코드 리뷰 서브 에이전트를 실행하거나 `/code-review` 스킬 직접 실행
3. Critical/Major 이슈가 있으면 수정 서브 에이전트를 실행

### Step 3: 반복

모든 태스크 완료까지 Step 1-2를 반복한다.

### Step 4: 최종 배포

```
Invoke push-with-review skill
```

---

## Sub-Agent Prompt Templates

### 구현 에이전트 (Implementation Agent)

```
DevCenter 프로젝트에서 다음 태스크를 구현하세요.

## 컨텍스트
- 브랜치: <branch>
- 계획 파일: <plan_path>
- 스펙 파일: <spec_path>

## 태스크 N: <task_title>

### 설명
<task_description>

### 수락 기준
<acceptance_criteria>

### 수정할 파일
<file_list>

### 의존성
<dependencies>

## 제약사항 (반드시 준수)

1. **TDD 필수**: 구현 파일 작성 전 반드시 XxxTest.java를 먼저 작성하세요.
   - `TDD guidance`가 테스트 없이 구현 파일 Write를 차단합니다.
   - 테스트 파일에 @Test 어노테이션이 포함되어야 토큰이 생성됩니다.

2. **커밋 메시지**: Conventional Commits 형식 준수
   - `feat(scope): 설명` 형식
   - `Pi commit message gate`가 형식 위반 커밋을 차단합니다.

3. **커밋 전 코드 리뷰**: 커밋 전 `/code-review` 스킬을 실행하세요.
   - `Pi code review gate`가 리뷰 없는 커밋을 차단합니다.

4. **범위 제한**: 지정된 파일만 수정하세요. 인접 코드 리팩토링 금지.

5. **아키텍처 질문**: 설계 결정이 필요한 경우 추측하지 말고 메인 에이전트에게 보고하세요.

## 완료 조건
- [ ] 수락 기준의 모든 항목 충족
- [ ] `./gradlew :<module>:test` 통과
- [ ] 코드 리뷰 통과 (Critical=0, Major≤2)
- [ ] 커밋 완료

완료 시 변경된 파일 목록과 커밋 해시를 보고하세요.
```

### 코드 리뷰 에이전트 (Review Agent)

```
DevCenter 프로젝트의 최근 변경사항을 코드 리뷰하세요.

검토 대상: git diff HEAD (또는 특정 커밋 해시 <commit_hash>)

태스크 컨텍스트:
- 구현한 기능: <feature_description>
- 수락 기준: <acceptance_criteria>

`/code-review` 스킬을 실행하세요.
결과는 한국어로 출력하고, `tmp/review-result.json`을 반드시 작성하세요.
```

### 수정 에이전트 (Fix Agent)

```
코드 리뷰에서 다음 이슈가 발견되었습니다:

## 🔴 Critical Issues
<critical_issues>

## 🟡 Major Issues
<major_issues>

파일: <file_list>

지적된 이슈만 수정하세요. 인접 코드 변경 금지.
수정 후 다시 `/code-review` 스킬을 실행하고 결과를 보고하세요.
```

---

## Context Isolation Rules

메인 세션의 컨텍스트를 보호하는 규칙:

| DO | DON'T |
|----|-------|
| Agent 툴 결과 요약만 읽기 | 구현 파일 전체를 Read 툴로 읽기 |
| TaskUpdate로 진행 상황 추적 | 파일 diff 전체를 main context에 로드 |
| 에이전트에게 전체 스펙 경로 제공 | 스펙 내용을 프롬프트에 직접 붙여넣기 |
| 아키텍처 결정은 메인 세션에서 | 구현 세부사항은 서브 에이전트에서 |

---

## Harness Integration

이 스킬과 harness v2 게이트의 상호작용:

| 게이트 | 서브 에이전트 영향 |
|--------|-----------------|
| `TDD guidance` | 서브 에이전트가 테스트 파일(@Test)을 먼저 Write → 토큰 생성 → 구현 파일 Write 가능 |
| `TDD guidance` | 서브 에이전트가 기존 파일 Edit 시 테스트 변경 없으면 ask — 프롬프트에 "기존 테스트가 커버함" 또는 "새 테스트 필요" 명시 |
| `Pi commit message gate` | 서브 에이전트 커밋 메시지에 Conventional Commits 형식 지시 |
| `Pi code review gate` | 각 태스크 완료 후 `/code-review` 스킬 실행 지시 |
| `session-start-context.sh` | SessionStart 시 미테스트 클래스 목록 주입 — 서브 에이전트 프롬프트 작성에 활용 |

---

## Progress Tracking

TaskCreate/TaskUpdate로 진행 상황을 추적한다:

```
TaskCreate: "Implement Task 1: <title>"
TaskUpdate: in_progress (서브 에이전트 실행 시)
TaskUpdate: completed (리뷰 통과 + 커밋 완료 시)
```

태스크 상태는 메인 세션의 ground truth다. 서브 에이전트 실패 시 태스크를 다시 in_progress로 유지하고 수정 에이전트를 실행한다.

---

## Failure Handling

| 상황 | 처리 방법 |
|------|----------|
| 서브 에이전트가 TDD 게이트에서 차단됨 | 테스트를 먼저 작성하라는 지시로 프롬프트 수정 후 재실행 |
| 코드 리뷰 Critical 발견 | 수정 에이전트 실행 → 재리뷰 |
| 서브 에이전트가 아키텍처 질문 반환 | 메인 에이전트가 결정 후 프롬프트에 답변 포함하여 재실행 |
| push-with-review 게이트 실패 | 메인 에이전트가 원인 파악 후 수정 에이전트 실행 |
