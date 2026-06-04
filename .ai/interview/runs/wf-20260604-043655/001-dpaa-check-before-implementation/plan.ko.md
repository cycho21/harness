# Implementation Plan: Workflow Board TUI 시인성 개선

## 접근 방식
두 가지 핵심 변경:

1. **`format.ts`**: `hintShort = hint.slice(0, 76)` 제거 → 전체 hint 사용 (래핑은 컴포넌트가 담당)
2. **`workflow.ts` `refreshBoard`**: `setWidget`에 string array 대신 컴포넌트 팩토리 `(tui, theme) => Box` 전달
   - `Box` 생성 시 bgFn으로 `theme.bg("customMessageBg", s)` 적용
   - 내부에 `Text` 컴포넌트로 colored content 삽입
   - 기존 inline color 로직을 팩토리 내부로 이동
3. **`workflow.ts` refresh 호출 추가**: `session_start`, `start`, `load`, `approve`, 게이트 실패 시

## 단계

1. **`format.ts` 수정** — `target/.pi/extensions/workflow/format.ts`
   - `hintShort` 변수 제거, `hint` 전체를 board 마지막 줄에 사용
   - `formatWorkflowBoard` 반환 타입(`string[]`) 유지

2. **`workflow.ts` `refreshBoard` 리팩터** — `target/.pi/extensions/workflow.ts`
   - import에 `Box` 추가: `import { Text, Box, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"`
   - `setWidget` 호출을 string array → 컴포넌트 팩토리로 교체
   - 팩토리 내에서: `formatWorkflowBoard` 호출 → 줄별 색상 적용 → `Box(1, 0, bgFn)` + `Text(content, 0, 0)` 조합

3. **`workflow.ts` refresh 누락 지점 추가** — `target/.pi/extensions/workflow.ts`
   - `session_start` 핸들러 말미에 `refreshBoard(ctx)` + `refreshStatus(ctx)` 추가
   - `/workflow start` 명령 성공 시 `refreshBoard(ctx)` + `refreshStatus(ctx)` 추가
   - `/workflow load` 명령 성공 시 `refreshBoard(ctx)` + `refreshStatus(ctx)` 추가
   - 게이트 실패 카운터 증가 후 `refreshBoard(ctx)` 추가

## 테스트 전략
- `/workflow start <goal>` 후 board 위젯 배경색 확인
- `/reload` 후 board 즉시 표시 확인
- `/workflow load` 후 board 표시 확인
- `interview` 단계에서 Deliverable 힌트 전체 텍스트 표시 확인 (잘림 없음)
- DPAA gate 실패 시 board의 `❌ fail` 상태 즉시 반영 확인

## 에스컬레이션 포인트
- `Box` bgFn에 어떤 `theme.bg()` 키를 써야 가장 적합한지 (현재 `customMessageBg` 예정, `toolPendingBg`도 후보)
- `refreshBoard` ctx 타입 정의: 현재 inline 타입으로 선언, 리팩터 시 변경 가능

## 위험
- `Box` 컴포넌트 내에서 ANSI 코드 포함 문자열 렌더링 시 width 계산 오차 가능 → `visibleWidth` 사용으로 완화
- setWidget 팩토리 API가 `(ctx.ui as any)` 캐스팅으로 호출되므로 타입 안전성 없음 → 기존 방식 유지
