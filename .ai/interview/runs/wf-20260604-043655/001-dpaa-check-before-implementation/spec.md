# Task Spec: Workflow Board TUI Visibility Improvement

## Problem
The workflow board widget has three visual issues:

1. **No background color**: The board widget uses the same background as the chat area, making it hard to distinguish.
2. **Text truncation bug**: The "Deliverable" hint line is hard-sliced at 76 characters (`hint.slice(0, 76)`) — cutting mid-word (e.g., "before pla").
3. **Missing refresh**: Board is not updated on session start or workflow load, so the widget is often absent or stale.

## Acceptance Criteria
- [ ] Board widget has a visually distinct background color (theme `customMessageBg`)
- [ ] Hint/deliverable text is NOT cut mid-word (component wraps or shows full text)
- [ ] Board refreshes at all of: session_start, workflow start, workflow load, phase transition, gate pass/fail
- [ ] Existing board content (phase, next, title, gate status, Tools, Cmds) is preserved
- [ ] No regressions; errors remain non-fatal (silent catch)

## Constraints
- `format.ts` changes must keep `formatWorkflowBoard` return type (`string[]`) intact
- Use only Pi TUI API (`Box`, `Text` from `@earendil-works/pi-tui`)
- Only modify extension files: `workflow.ts` and `workflow/format.ts`

## Out of Scope
- Adding/removing board items
- Status bar (`refreshStatus`) design changes
- Theme file modifications
- Modifying files other than the two listed
