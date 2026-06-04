# Task Spec: Workflow Board TUI 시인성 개선

## 문제
현재 workflow board 위젯에 세 가지 시각적 문제가 있다.

1. **배경색 없음**: board 위젯이 채팅 영역과 동일한 배경을 사용해 구분이 어렵다.
2. **글자 잘림**: "Deliverable" 힌트 줄이 문자 수 기준 76자에서 강제 잘림 (`hint.slice(0, 76)`) — 단어 중간에 잘려 "before pla" 같이 보임.
3. **갱신 누락**: 세션 시작/워크플로우 로드 시 board가 갱신되지 않아 위젯이 없거나 오래된 상태로 보임.

## 완료 기준
- [ ] Board 위젯이 테마 배경색(`customMessageBg`)으로 채팅 영역과 시각적으로 구분됨
- [ ] 힌트 줄이 단어 중간에 잘리지 않음 (컴포넌트가 너비에 맞게 래핑하거나 전체 표시)
- [ ] Board가 아래 시점에 모두 갱신됨:
  - 세션 시작 (`session_start`)
  - 워크플로우 시작 (`/workflow start`)
  - 워크플로우 로드 (`/workflow load`)
  - 단계 전환 (phase transition)
  - 게이트 통과/실패
- [ ] 기존 board 콘텐츠(단계, 다음 단계, 목표, 게이트 상태, Tools, Cmds) 보존됨
- [ ] 버그 없이 동작 (오류 시 기존처럼 non-fatal silently catch)

## 제약사항
- `format.ts` 변경은 `formatWorkflowBoard` 반환 형태(string[])를 유지 — 렌더링 책임만 `workflow.ts`로 이동
- Pi TUI API만 사용 (`Box`, `Text` from `@earendil-works/pi-tui`)
- Extension 파일(`workflow.ts`, `workflow/format.ts`) 수정만 허용

## 범위 외
- Board 항목 추가/제거
- Status bar(`refreshStatus`) 디자인 변경
- 테마 파일 수정
- `workflow/ui.ts` 이외 파일 수정
