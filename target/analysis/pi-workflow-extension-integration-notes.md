# PI Workflow Extension Integration Notes

## 현재 company-harness 관찰 요약

- 이미 PI extension이 존재한다: `.pi/extensions/harness-gates.ts`
- 기존 목표와 매우 유사하다.
  - PI extension 기반
  - Docker/별도 worker 없이 PI 기본 흐름 위에서 동작
  - hook/tool_call 기반 gate
  - 파일 토큰 대신 in-memory token 사용
  - `/skill:code-review` 이후 `submit_review_result` tool로 커밋 허용 토큰 발급
- `WORKFLOW.md`, `AGENTS.md`, `skills/*`에 lifecycle/skill 중심 workflow가 이미 잘 정리되어 있다.

## 우리 실험과의 매핑

| 우리 workflow 실험 | company-harness 대응 |
|---|---|
| `/workflow start` | 아직 없음 |
| `/workflow approve` / 자연어 승인 | 아직 없음 |
| workflow state | 현재는 review token 정도만 in-memory 관리 |
| state별 allow/deny path | 일부는 hooks/guard로 존재, PI extension에는 미구현 |
| checkpoint/rollback | 기존 예시/개념은 있으나 company extension에는 미구현 |
| code review gate | 이미 `harness-gates.ts`에 구현됨 |
| skills 등록 | 이미 `resources_discover`로 구현됨 |

## 중요한 판단

새 extension을 따로 만들기보다, 기존 `.pi/extensions/harness-gates.ts`에 **workflow state manager를 추가**하는 편이 자연스럽다.

이유:

1. 이미 PI extension control-plane이 존재한다.
2. skills path 등록과 gate state가 같은 프로세스 메모리를 공유할 수 있다.
3. commit gate와 workflow state가 분리되면 UX가 꼬일 수 있다.
4. 기존 회사 harness의 철학과 맞다: final-stage gates + advisory context.

## 추천 MVP 통합 범위

### 1단계: workflow state만 추가

추가 명령:

```txt
/workflow start
/workflow approve
/workflow status
/workflow state <state>   # debug/manual
```

상태:

```txt
interview
  -> plan
  -> plan_review
  -> implement
  -> code_review
  -> document
  -> commit
  -> push
  -> done
```

회사 harness의 `WORKFLOW.md`와 맞추려면 branch type별 flow를 나중에 분기한다.

### 2단계: 자연어 승인 감지

`pi.on("input")`에서 다음 입력을 감지:

```txt
응
진행해
좋아
계속해
approve
continue
```

active workflow 상태일 때만 다음 state로 전이한다.

### 3단계: before_agent_start에 현재 workflow state 주입

기존 `before_agent_start` injection에 추가:

```txt
[Workflow State]
현재 단계: plan_review
다음 단계: implement
승인 방식: 사용자가 /workflow approve 또는 자연어 승인 입력
```

LLM이 임의로 다음 단계로 넘어가지 않고 사용자 승인을 요청하도록 유도한다.

### 4단계: path guard는 나중에

회사 harness는 이미 final-stage gate 중심이다. 처음부터 state별 path allowlist를 강하게 넣으면 기존 사용성을 해칠 수 있다.

MVP에서는 path guard 대신 advisory message부터 권장:

- implement 전에는 source edit 자제
- review 전에는 commit 자제
- commit은 기존 gate가 이미 강제

### 5단계: checkpoint/rollback은 나중에

회사 repo에는 git 기반 workflow가 강하게 전제되어 있다. MVP에서는 rollback보다 `git diff`, `git restore` 안내 정도로 충분하다.

## 비권장

- Docker worker 도입
- 별도 PI worker 실행
- 기존 `harness-gates.ts`와 별도 extension으로 중복 state 관리
- commit gate를 workflow approve로 대체
- workflow state를 프로젝트 내부 파일에 저장

## 권장 저장 위치

Workflow state는 in-memory 우선이 가장 안전하다.

- 장점: LLM이 bash로 위조 불가
- 단점: PI 재시작 시 state 초기화

MVP에서는 재시작 내구성보다 우회 방지가 더 중요하므로 in-memory를 권장한다.

나중에 persistence가 필요하면 PI agent dir 아래에 저장하되, 프로젝트 내부 파일은 피한다.

## 구현 현황

MVP workflow state layer를 기존 `.pi/extensions/harness-gates.ts`에 통합했다.

추가된 명령:

```txt
/workflow start <목표>
/workflow approve
/workflow status
/workflow undo
/workflow redo
/workflow history
/workflow abort
/workflow state <phase>   # debug/manual
```

추가된 상태:

```txt
interview
  -> plan
  -> plan_review
  -> implement
  -> code_review
  -> document
  -> commit
  -> push
  -> done
```

추가 동작:

- 한 번에 하나의 active workflow만 허용
- `undo` / `redo`는 workflow state 전이만 되돌림
- 자연어 승인 감지: `응`, `진행해`, `좋아`, `계속해`, `approve`, `continue` 등
- `before_agent_start`에 현재 workflow state와 다음 단계 안내를 주입
- 기존 code-review/commit gate는 변경하지 않음

## 결론

company-harness는 이미 우리가 만들려던 방향과 매우 가깝다. 새 harness를 만들기보다 기존 `harness-gates.ts`에 workflow state/approval layer를 추가하는 것이 가장 자연스럽다.

MVP 목표는 다음 한 문장으로 잡는다.

> 기존 code-review/commit gate는 유지하고, 그 앞단에 interview → plan → review → implement → commit/push로 자연스럽게 진행되는 PI workflow state layer를 추가한다.
