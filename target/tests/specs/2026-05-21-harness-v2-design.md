# Harness v2 Design Spec

**Date:** 2026-05-21
**Branch:** feat/harness-improvement
**Status:** Draft

---

## 1. Problem Statement

현재 harness(`.pi/hooks/`)는 게이트가 존재하지만 실질적 효과가 없다.

### 확인된 3가지 근본 원인

| 원인 | 현상 |
|------|------|
| **우회가 너무 쉬움** | `COVERAGE_SKIP=1`, `REVIEW_SKIP=1` 등 env var 하나로 모든 게이트 무력화 가능 |
| **시점이 틀림** | 모든 게이트가 `git commit` 직전에만 발동. 코드 작성 중엔 아무 피드백 없음 |
| **Advisory가 무시됨** | TDD Edit 가드, persona reminder 등이 stderr 경고만 출력하고 실제 효과 없음 |

### 추가 구조적 문제

- git commit 감지 로직이 5개 hook에 복사됨 (중복)
- `deny()` JSON 헬퍼가 각 hook에 각자 구현됨 (중복)
- `violations.jsonl` 기록이 거의 없어 harness 효과를 측정할 수 없음

---

## 2. Design Philosophy

> **"올바른 행동을 하게 만드는 것이 먼저, 막는 것은 최후 수단"**

Hook은 LLM의 보조 수단이지 주 제어 수단이 아니다.
실제 enforcement는 **LLM이 작업 시작 전부터 올바른 컨텍스트를 갖는 것**에서 나온다.

이에 따라 harness를 3개 레이어로 구성한다:

```
Layer 1: Context Injection  ← 주 메커니즘 (차단 없음, 인지 강화)
Layer 2: Soft Gates         ← 보조 (ask, 메인 에이전트가 판단)
Layer 3: Hard Gates         ← 최후 수단 (deny, 명백한 규칙 위반만)
```

### 멀티 에이전트 전제

- **메인 세션 에이전트**: 인터뷰 컨텍스트 보유, `ask` 프롬프트의 실질적 응답자
- **구현 에이전트**: 메인 에이전트로부터 task를 받아 구현 수행
- **검토 에이전트**: 코드리뷰, 테스트 등 담당
- Hook의 `ask` 프롬프트는 메인 에이전트가 판단하므로 human 개입 불필요

---

## 3. Layer 1: Context Injection

차단 없이 LLM의 인지를 강화한다. 모든 출력은 `additionalContext`로 주입.

### 3-1. SessionStart Hook — `session-start-context.sh`

**트리거:** 세션 시작 시 (`SessionStart` 이벤트)
**목적:** 작업 시작 전 LLM이 현재 상태를 정확히 알게 함

**주입 내용:**
```
=== DevCenter Harness Context ===
브랜치: feat/xxx
커버리지: 87.3% (임계값: 80%)
테스트 없는 production 클래스: [XxxService, YyyRepository]
미해결 Checkstyle 위반: 0개

TDD 원칙:
- 새 클래스 작성 전 반드시 XxxTest.java 먼저 작성
- 테스트가 실패(Red)한 뒤 구현(Green) 시작
- Edit 시에도 변경 내용에 대응하는 테스트가 있어야 함
```

**구현 방식:** `git diff origin/dev...HEAD`, JaCoCo XML 파싱으로 현황 계산

---

### 3-2. Persona Auto-Inject — `persona-inject.sh`

**트리거:** `PreToolUse(Edit|Write)` — 아키텍처/보안 파일 수정 전
**목적:** persona reminder를 "경고"에서 "컨텍스트 주입"으로 전환

**현재 동작 (문제):**
```
stderr: "[Persona] Read .pi/personas/architect/AGENTS.md"  ← 무시됨
```

**새 동작:**
```
additionalContext: AGENTS.md 파일 내용 직접 주입
```

파일 감지 패턴은 기존 `guard-persona-reminder.sh`와 동일:
- `Entity|Repository|build.gradle|settings.gradle` → Architect persona
- `Security|Auth|Jwt|Token|Filter|Interceptor` → Security persona

---

### 3-3. Pre-Commit Context — `pre-commit-context.sh`

**트리거:** `PreToolUse(Bash)` — git commit 감지 시, 게이트보다 먼저 실행
**목적:** 차단 전에 LLM이 스스로 수정할 기회 제공

**주입 내용:**
```
=== 커밋 전 체크 ===
테스트 없이 수정된 production 클래스:
  - src/main/java/.../XxxService.java (대응 테스트 변경 없음)
  - src/main/java/.../YyyController.java (XxxServiceTest.java 없음)

커버리지: 79.1% → 임계값 80% 미달
```

이 컨텍스트를 보고 LLM이 자가 교정하면 Layer 3 게이트는 발동하지 않는다.

---

## 4. Layer 2: Soft Gates

컨텍스트만으로 해결되지 않을 때 메인 에이전트의 판단을 요청한다.
`permissionDecision: ask` — 실질 응답자는 메인 세션 에이전트.

### 4-1. TDD Edit Gate — `guard-tdd-edit.sh`

**트리거:** `PreToolUse(Edit)` — production Java 파일 수정 시
**조건:** 대응 테스트 파일에 현재 세션에서의 변경이 없을 때

**ask 메시지:**
```
🧪 [TDD] XxxService.java 수정 시도

  대응 테스트: XxxServiceTest.java
  테스트 파일 변경 여부: 없음 (git diff HEAD 기준)

  이 수정에 새 테스트가 필요한가요?
  → 필요: 테스트 먼저 작성 후 재시도
  → 불필요 (버그 수정/리팩토링): 진행 허용
```

**판단 기준 (메인 에이전트용):**
- 새 메서드 추가 → 테스트 필요
- 기존 로직 버그 수정, 이미 커버되는 경우 → 불필요
- 리팩토링 → 불필요

---

### 4-2. Bypass Gate (env var 제거)

**적용 대상:** `guard-coverage.sh`, `guard-code-review.sh`, `guard-static-analysis.sh`
**변경:** `COVERAGE_SKIP=1` 등 env var bypass → `ask`로 대체

**ask 메시지 예시 (커버리지):**
```
⚠️ 커버리지 게이트 우회 요청

  모듈: xxx-module
  현재: 74.2% / 임계값: 80%
  미달 클래스: XxxService (68%)

  우회 사유가 있나요?
  → 레거시 코드 수정, 긴급 배포 등
```

---

## 5. Layer 3: Hard Gates

명백한 규칙 위반만 차단한다. 판단이 필요 없는 객관적 기준만 적용.

### 5-1. TDD Write Gate — `guard-tdd-write.sh` (기존 guard-test-first.sh 개선)

**트리거:** `PreToolUse(Write)` — 새 production Java 파일 생성
**메커니즘:** C+D 조합 — TDD 세션 토큰 + `@Test` 어노테이션

**흐름:**
```
Write(XxxTest.java) + @Test 포함
  → hook이 .pi/hooks/gates/tdd-{ClassName} 토큰 생성

Write(Xxx.java) 시도
  → 토큰 없으면 deny
  → 토큰 있으면 통과, 토큰 삭제
```

**우회 방지:**
- 토큰 저장 위치: `.pi/hooks/gates/` → `guard-settings.sh`가 Edit/Write 차단
- Bash로 토큰 직접 생성 시: `guard-settings-bash.sh`가 ask 요청
- `@Test` 없이 XxxTest.java만 생성: 토큰 미생성 → 구현 파일 차단

**토큰 TTL:** 세션 간 잔류 토큰은 `SessionStart` hook에서 일괄 삭제한다.
(`session-start-context.sh`가 시작 시 `.pi/hooks/gates/tdd-*` 전체 삭제)

**deny 메시지:**
```
── 🧪 TDD PROTOCOL ────────────────────

  구현 파일 작성 전 테스트가 먼저입니다.

  대상: XxxService.java
  필요: XxxServiceTest.java (@Test 포함)

  ① XxxServiceTest.java 작성 (@Test 최소 1개)
  ② 테스트 실패 확인
  ③ 구현 시작

──────────────────────────────────────
```

---

### 5-2. Code Review Gate — `guard-code-review.sh` (기존 유지 + bypass 수정)

변경 사항: env var bypass 제거 → Layer 2 bypass gate로 이전
기존 로직(review-result.json TTL, critical/major 임계값) 유지

---

### 5-3. Static Analysis Gate — `guard-static-analysis.sh` (기존 유지 + bypass 수정)

변경 사항: `STATIC_ANALYSIS_SKIP=1` 제거 → bypass gate로 이전

---

### 5-4. Coverage Gate — `guard-coverage.sh` (기존 유지 + bypass 수정)

변경 사항: `COVERAGE_SKIP=1` 제거 → bypass gate로 이전

---

### 5-5. Conventional Commits Gate — `guard-commit-message.sh` (신규)

**트리거:** `PreToolUse(Bash)` — git commit 감지
**검사:** `^(feat|fix|chore|refactor|docs|test|perf|ci|style|revert)(\([a-z0-9-]+\))?: .+`

**deny 메시지:**
```
── 📝 COMMIT MESSAGE FORMAT ───────────

  커밋 메시지 형식 오류

  현재: "update service logic"
  필요: "feat(xxx-module): 설명"

  타입: feat | fix | chore | refactor | docs | test | perf | ci

──────────────────────────────────────
```

---

## 6. Architecture: hook-common.sh

현재 5개 hook에 복사된 중복 로직을 공통 라이브러리로 추출한다.

### 제공 함수

```bash
# git commit 감지 (현재 5개 hook에 동일 로직 복사됨)
is_git_commit "$CMD"  # returns 0 if commit, 1 otherwise

# git root 탐색
git_root()  # echo /path/to/repo/root

# deny JSON 출력
deny "메시지"  # jq -n ... 래퍼

# ask JSON 출력
ask "메시지"   # permissionDecision: ask 래퍼

# violation 로깅
log_violation "type" "file" "detail"  # → ~/.pi/hooks/violations.jsonl
```

### 적용 대상

모든 hook 파일에서 `source "${HOOK_DIR}/hook-common.sh"` 추가.
각 hook의 중복 구현 제거.

---

## 7. Observability

### 7-1. Violation Logging

**위치:** `~/.pi/hooks/violations.jsonl`
**형식:**
```json
{"ts":"2026-05-21T10:30:00Z","type":"tdd-write","file":"XxxService.java","branch":"feat/xxx","detail":"no token found"}
{"ts":"2026-05-21T10:35:00Z","type":"bypass-ask","gate":"coverage","branch":"feat/xxx","detail":"74.2% < 80%"}
```

**기록 시점:** 모든 deny, 모든 ask 발동 시 → `log_violation()` via `hook-common.sh`

---

### 7-2. Stop Hook — `session-stop-report.sh`

**트리거:** `Stop` 이벤트 (PI 세션 종료 시)
**출력:**
```
=== Harness Session Report ===
세션 내 게이트 발동:
  TDD Write 차단: 2회
  Bypass ask: 1회 (coverage, feat/xxx)
  Conventional commit 차단: 1회
  Edit TDD ask: 3회 → 2회 허용, 1회 거부

누적 위반 (violations.jsonl): 47건
```

---

## 8. settings.json 변경 사항

### 추가할 hook 연결

hook 실행 순서는 settings.json 배열 순서에 의존한다.
`pre-commit-context.sh`는 반드시 Layer 3 게이트보다 앞에 위치해야 한다.
settings.json의 `...` 자리는 구현 단계에서 실제 `command` 경로와 `timeout`으로 채운다.

```json
"SessionStart": [
  {
    "hooks": [
      { "command": "session-start-context.sh" }             // 신규
    ]
  }
],
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      { "command": "pre-commit-context.sh" },               // 신규 (게이트보다 먼저)
      { "command": "guard-commit-message.sh" },             // 신규
      { "command": "guard-code-review.sh" },                // 기존 (bypass 수정)
      { "command": "guard-static-analysis.sh" },            // 기존 (bypass 수정)
      { "command": "guard-coverage.sh" },                   // 기존 (bypass 수정)
      { "command": "guard-doc-gate.sh" }                    // 기존 유지
    ]
  },
  {
    "matcher": "Write",
    "hooks": [
      { "command": "persona-inject.sh" },                   // 기존 guard-persona-reminder.sh 대체
      { "command": "guard-settings.sh" },                   // 기존 유지
      { "command": "guard-tdd-write.sh" }                   // 기존 guard-test-first.sh 대체 (Write 전용)
    ]
  },
  {
    "matcher": "Edit",
    "hooks": [
      { "command": "persona-inject.sh" },                   // 동일 hook, Edit에도 적용
      { "command": "guard-settings.sh" },                   // 기존 유지
      { "command": "guard-tdd-edit.sh" }                    // 신규 (Edit 전용, Write와 분리)
    ]
  }
],
"Stop": [
  {
    "hooks": [
      { "command": "session-stop-report.sh" }               // 신규
    ]
  }
]
```

**제거되는 기존 hook:**
- `guard-persona-reminder.sh` → `persona-inject.sh`로 대체, 삭제
- `guard-test-first.sh` → `guard-tdd-write.sh` + `guard-tdd-edit.sh`로 분리, 삭제

---

## 9. 구현 범위 요약

| 항목 | 유형 | 우선순위 |
|------|------|----------|
| `hook-common.sh` 생성 | 신규 | P0 — 모든 것의 기반 |
| `session-start-context.sh` | 신규 | P0 — Layer 1 핵심 |
| `pre-commit-context.sh` | 신규 | P1 |
| `persona-inject.sh` | 기존 대체 | P1 |
| `guard-tdd-write.sh` | 기존 개선 | P1 |
| `guard-tdd-edit.sh` | 신규 | P1 |
| `guard-commit-message.sh` | 신규 | P2 |
| `session-stop-report.sh` | 신규 | P2 |
| 기존 3개 hook bypass 제거 | 기존 수정 | P1 |
| settings.json 연결 | 설정 수정 | P0 |

---

## 10. 비고 — 범위 외

- `code-guardrail.js`: 내용 검토 없이 활성화하지 않음. 별도 분석 필요
- `guard-doc-gate.sh`: 변경 없음 (잘 동작 중)
- `guard-settings-bash.sh`: 변경 없음 (TDD 토큰 우회 방지에 의존됨)
- `validate-feat-html.js`, `validate-feat-index.js`: 변경 없음 (잘 동작 중)
- `copy-permissions-to-worktree.js`: 변경 없음
- `post-tool-use-memory.js`: 변경 없음
