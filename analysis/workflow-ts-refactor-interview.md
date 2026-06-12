# workflow.ts 분리 리팩터링 인터뷰 기록

## 목표

`target/.pi/extensions/workflow.ts`를 책임별 모듈 구조로 분리하여 유지보수성, 테스트 용이성, 향후 기능 확장성, 상태 전이 버그 위험 감소를 달성한다.

## 분리 범위

- 책임별 모듈화
  - phase/state transition
  - guard/policy enforcement
  - approval handling
  - checkpoint handling
  - evidence/review/quality-gate recording
- public entrypoint는 명확히 유지하고 내부 로직은 서비스/모듈 단위로 재구성한다.
- 현재 실행 중인 `.pi`가 아니라 배포 단위 소스인 `target/.pi`만 대상으로 한다.

## 완료 기준

- 기존 workflow 동작, 명령, phase transition, guard semantics, 사용자 메시지를 보존한다.
- 관련 기존 테스트가 통과한다.
- 필요한 경우 모듈 경계에 맞는 신규/수정 테스트를 추가한다.
- 각 모듈의 책임과 import 경계가 명확하다.
- 구조 변경이 문서화된 동작에 영향을 주는 경우 `README.md`와 `README.en.md`를 동기화하여 갱신한다.

## 영향 파일/영역

- 주요 대상: `target/.pi/extensions/workflow.ts`
- 보조 대상: `target/.pi/extensions/workflow/**`
- 관련 테스트: workflow extension 관련 테스트 파일
- 문서: `README.md`, `README.en.md` (구조/경계 설명 반영 필요 시)

## 제약 및 리스크

- 동작 변경 금지: 메시지, phase transition, guard semantics를 유지한다.
- 작은 단계로 진행: 한 번에 대규모 재작성하지 않는다.
- 타입 안정성 유지: `any` 추가나 타입 약화를 피한다.
- 무관한 리팩터링/포맷팅은 하지 않는다.
- 설치된 runtime `.pi/extensions/**` 수정은 정책상 명시적 승인 절차를 준수해야 한다. 이 harness source repo의 `target/.pi/extensions/**`는 배포 템플릿 소스이므로 일반 개발 대상으로 취급한다.

## 남은 불확실성

- 실제 코드 조사 후 `workflow.ts`에 남아야 할 public entrypoint 범위와 이미 존재하는 `target/.pi/extensions/workflow/**` 모듈의 재사용/확장 방향을 계획에서 확정한다.
