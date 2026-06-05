# workflow dogfooding UX 개선 인터뷰 기록

## 목표

`workflow.ts 분리 리팩터링` dogfooding 중 드러난 workflow UX 마찰을 개선한다. 핵심은 phase 신뢰성, 흐름 중단 감소, 실수 복구, 리팩터링 친화성이다.

## 포함 범위

발견된 6개 개선점을 모두 계획에 포함한다.

1. stale steer/continuation 메시지 폐기
2. `interview → plan → plan_review` automatic preparation chain의 사용자 표시 phase 정리
3. `/workflot` 등 `/workflow` 명령 오타 제안
4. harness repo 전용 code-quality command 감지/실행 개선
5. subagent review 기본 async UX 개선
6. static test의 모듈 경계 인식 개선

## 동기

- 현재 phase와 사용자에게 노출되는 메시지의 불일치를 제거해 phase 신뢰성을 높인다.
- subagent timeout, quality command 미감지처럼 workflow 흐름을 막는 지점을 줄인다.
- 오타나 잘못된 명령에 친절한 복구 제안을 제공한다.
- 리팩터링 시 테스트가 파일 내부 문자열 위치에 과도하게 결합되지 않도록 개선한다.

## 완료 기준

- phase mismatch stale steer/continuation이 사용자에게 노출되지 않는다.
- interview wizard 이후 plan 작성/plan_review 도달 상태가 사용자에게 명확히 표시된다.
- `/workflot abort`, `/worflow status` 같은 근접 오타에 `/workflow ...` 제안이 표시된다.
- 이 repo에서 code-quality catalog가 의미 있는 검증 명령을 실행하거나 명확한 대체 안내를 제공한다.
- 관련 회귀 테스트가 추가/수정되어 통과한다.

## 영향 모듈

- `target/.pi/extensions/workflow.ts`
- `target/.pi/extensions/workflow/runtime-state.ts`
- `target/.pi/extensions/workflow/runtime-policy.ts`
- `target/.pi/extensions/workflow/runtime-ui.ts`
- continuation/state/format/catalog/policy 관련 workflow 모듈
- workflow 관련 tests
- `README.md`, `README.en.md`

## 제약과 리스크

- guard/approval boundary 의미를 약화하지 않는다.
- 현재 실행 중인 root `.pi/**`는 수정하지 않고 배포 소스인 `target/.pi/**`만 수정한다.
- 정상 continuation/steer를 잘못 폐기하지 않도록 테스트 우선으로 진행한다.
- 작은 단계로 구현하고 workflow 관련 테스트로 검증한다.
- 동작/구조 변경 시 README 양국어 문서를 동기화한다.
