# workflow.ts 분리 리팩터링 계획

## 1. 배경 및 목표

`target/.pi/extensions/workflow.ts`는 Pi extension entrypoint이면서 tool 등록, command 처리, runtime hook, guard token 복원, UI 상태 갱신, continuation prompt, extension mutation approval 등을 함께 포함하고 있다. 이미 `target/.pi/extensions/workflow/**`에 여러 책임 모듈이 존재하므로, 이번 작업은 동작 변경 없이 entrypoint의 남은 책임을 더 작은 내부 모듈로 옮기고 entrypoint를 조립 계층으로 축소하는 것을 목표로 한다.

## 2. 원칙

- `target/.pi/extensions/workflow.ts`의 public extension default export와 등록되는 tool/command/hook 이름은 유지한다.
- 기존 메시지, phase transition, guard semantics, approval boundary, checkpoint semantics를 변경하지 않는다.
- 새 모듈은 `target/.pi/extensions/workflow/**` 아래에 두며 현재 실행 중인 `.pi`는 수정하지 않는다.
- 타입 안정성을 유지하고 `any` 추가/타입 약화를 최소화한다. 기존 `ctx: any`, `theme: any` 등은 가능한 경우 새 타입 alias나 좁은 interface로 격리하되 의미 변경은 하지 않는다.
- 큰 리라이트 대신 테스트로 보호되는 기능 단위로 분리한다.

## 3. 현재 구조 관찰

- `target/.pi/extensions/workflow.ts`: 약 2,424 lines. 현재 남아 있는 주요 내부 책임:
  - process memory state와 guard token persistence/restore
  - workflow board/status UI 갱신
  - phase tool policy와 mutating tool backstop
  - extension mutation approval 검사
  - workflow continuation prompt 큐잉/취소
  - push policy confirmation
  - tool 등록: `submit_review_package`, `workflow_run_command`, `workflow_approve`, `workflow_state`, `workflow_propose_edit`, `workflow_apply_approved_edit`, `workflow_interview_wizard`
  - `/workflow` command handler
  - runtime hooks: `input`, `tool_call`, `session_start`, `turn_start`, `before_agent_start`
- 이미 존재하는 내부 모듈:
  - `workflow/state.ts`, `gates.ts`, `format.ts`, `policy-core.ts`, `checkpoints.ts`, `edit-scope.ts`, `catalog.ts`, `artifacts.ts`, `reminders.ts`, `field-log.ts`, `git.ts`, `types.ts`, `ui.ts`, `interview-ui.ts` 등

## 4. 작업 계획

### Task 1 — 보호 테스트/정적 테스트 기준 확정

**설명:** 분리 전후 동일 동작을 검증할 최소 테스트 세트를 확정하고, 필요 시 static test를 보강해 새 모듈 export/import 경계를 검증한다.

**수용 기준:**
- workflow runtime/tool/transition 관련 기존 테스트가 리팩터링 회귀를 잡을 수 있다.
- 새 모듈 생성 시 import 경계 또는 등록 이름 보존을 확인하는 테스트가 필요하면 추가한다.

**검증:**
- `python -m pytest tests/test_workflow_extension_runtime.py tests/test_workflow_tool_policy.py tests/test_workflow_token_persistence.py tests/test_workflow_tui.py`

**예상 파일:**
- `tests/test_workflow_*.py` 중 필요한 파일

### Task 2 — runtime state/guard token 책임 분리

**설명:** `workflow.ts`의 process memory state, guard token type constants, persist/restore/save helper를 `workflow/runtime-state.ts` 같은 모듈로 이동한다. Pi API 의존이 필요한 appendEntry/save 흐름은 함수 인자로 주입해 entrypoint 동작을 유지한다.

**수용 기준:**
- guard evidence는 여전히 process memory 중심이며 파일 토큰으로 대체되지 않는다.
- `submit_review_package`, DPAA/code-quality/push guard token persistence 경로가 기존과 동일하다.
- 기존 token persistence tests가 통과한다.

**검증:**
- `python -m pytest tests/test_workflow_token_persistence.py tests/test_workflow_authority_tokens.py`

**예상 파일:**
- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/workflow/runtime-state.ts` 또는 유사명
- 관련 테스트

### Task 3 — UI/status board 책임 분리

**설명:** `getBoardState`, `refreshBoard`, `refreshStatus`, result box/color helpers를 `workflow/runtime-ui.ts` 같은 모듈로 이동한다. entrypoint는 state와 ctx를 넘겨 UI 갱신을 호출하는 역할만 한다.

**수용 기준:**
- TUI render 호출과 status/board 표현이 유지된다.
- `tests/test_workflow_tui.py`가 기대하는 render/result 호출이 깨지지 않는다.

**검증:**
- `python -m pytest tests/test_workflow_tui.py tests/test_workflow_extension_runtime.py`

**예상 파일:**
- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/workflow/runtime-ui.ts`

### Task 4 — policy/backstop/extension mutation approval 분리

**설명:** phase tool policy 적용, write path backstop, mutating bash 판정, 설치된 runtime `.pi/extensions/**` mutation approval 검사와 reason formatting을 별도 모듈로 이동한다. 이 harness source repo의 `target/.pi/extensions/**`는 일반 개발 대상이다.

**수용 기준:**
- read-only phase에서 write/edit/bash backstop이 유지된다.
- 설치된 runtime `.pi/extensions/**` 변경 승인 요구가 유지된다.
- runtime extension path 오탐/정탐 규칙이 기존과 동일하다.

**검증:**
- `python -m pytest tests/test_workflow_tool_policy.py tests/test_claude_workflow_gate.py`

**예상 파일:**
- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/workflow/runtime-policy.ts` 또는 `mutation-approval.ts`

### Task 5 — continuation prompt/push confirmation 분리

**설명:** workflow continuation marker 생성/추출/취소/큐잉과 push policy confirmation helper를 별도 모듈로 이동한다.

**수용 기준:**
- auto transition 이후 continuation prompt 주입/취소 동작이 유지된다.
- push phase의 policy approval signature와 확인 절차가 유지된다.

**검증:**
- `python -m pytest tests/test_workflow_extension_runtime.py tests/test_workflow_authority_tokens.py`

**예상 파일:**
- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/workflow/continuation.ts`
- 필요 시 `target/.pi/extensions/workflow/push-confirmation.ts`

### Task 6 — tool/command/hook 등록을 registration 모듈로 정리

**설명:** tool 등록, `/workflow` command handler, event hook 등록 블록을 기능별 registration 함수로 분리한다. entrypoint는 `createRuntimeContext` 후 `registerWorkflowTools`, `registerWorkflowCommand`, `registerWorkflowHooks`를 호출하는 형태로 축소한다.

**수용 기준:**
- 등록되는 tool/command/hook 이름과 schema가 유지된다.
- tool별 guard/approval/refresh/continuation 사이드이펙트가 유지된다.
- `workflow.ts`는 public entrypoint와 조립 로직 중심으로 축소된다.

**검증:**
- `python -m pytest tests/test_workflow_extension_runtime.py tests/test_workflow_run_command.py tests/test_workflow_edit_scope.py tests/test_workflow_tui.py tests/test_workflow_llm_transcript.py`

**예상 파일:**
- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/workflow/register-tools.ts`
- `target/.pi/extensions/workflow/register-command.ts`
- `target/.pi/extensions/workflow/register-hooks.ts`

### Task 7 — 문서 동기화 및 전체 검증

**설명:** 구조 변경이 완료되면 README 양쪽에 workflow extension 구조/대상 경계를 간결히 반영한다.

**수용 기준:**
- `README.md`와 `README.en.md`가 동일한 구조 정보를 담는다.
- 문서가 실제 파일 경로와 배포 단위(`target/.pi`)를 정확히 설명한다.

**검증:**
- 관련 workflow 테스트 전체: `python -m pytest tests/test_workflow_*.py tests/test_claude_workflow_gate.py`
- 필요 시 전체 pytest: `python -m pytest tests`

**예상 파일:**
- `README.md`
- `README.en.md`

## 5. 리스크 및 완화

- **리스크:** `workflow.ts` 내부 클로저 state와 Pi API 접근이 많아 분리 중 side effect가 누락될 수 있다.
  - **완화:** runtime context 객체를 명시하고, 각 registration 함수가 필요한 의존성만 받도록 한다.
- **리스크:** static tests가 문자열/위치 기반일 수 있어 단순 이동에도 실패할 수 있다.
  - **완화:** 테스트 실패 시 동작 보존 의도에 맞춰 테스트를 업데이트하되, 가드 semantics를 약화하지 않는다.
- **리스크:** approval-sensitive path 수정 가드가 구현 단계에서 차단할 수 있다.
  - **완화:** 구현 단계에서 정책 승인 도구 흐름을 준수한다.

## 6. 승인 전 확인 사항

이 계획은 동작 보존형 리팩터링을 전제로 한다. 구현 승인 후에는 TDD/회귀 테스트를 우선 사용해 작은 단위로 분리하고, 실패 시 원인 수정 후 재검증한다.
