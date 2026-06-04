# Implementation Plan: Workflow Board TUI Visibility Improvement

## Approach
Three targeted edits across two files. No new abstractions; changes are additive or inline replacements.

## Steps

### Step 1 — `target/.pi/extensions/workflow/format.ts`

**Change:** Delete the variable `const hintShort = hint.slice(0, 76);` (1 line).
Replace the reference `hintShort` in the last board line with `hint` (1 token swap).

Before:
```
const hintShort = hint.slice(0, 76);
...
`→ ${hintShort}`,
```
After:
```
`→ ${hint}`,
```

**Measurable outcome:** `formatWorkflowBoard` returns the full Deliverable string untruncated; no character count limit applies.

---

### Step 2 — `target/.pi/extensions/workflow.ts`: `refreshBoard` function body

**Change:** Replace the existing `(ctx.ui as any).setWidget("workflow-board", lines)` call with a call that passes a component factory function.

The factory function signature is `(tui: unknown, theme: any) => Component`.
Inside the factory:
1. Call `formatWorkflowBoard(getBoardState())` to get `string[]`.
2. Apply per-line `theme.fg(...)` coloring (identical logic to current).
3. Join lines with `\n` into a single string.
4. Construct `new Text(content, 0, 0)` wrapping the joined string.
5. Construct `new Box(1, 0, (s: string) => theme.bg("customMessageBg", s))` and call `box.addChild(text)`.
6. Return `box`.

**Measurable outcome:** The widget renders with `customMessageBg` background applied to every line; the board is visually distinct from the chat area.

**Import change:** Add `Box` to the existing `@earendil-works/pi-tui` import line.

---

### Step 3 — `target/.pi/extensions/workflow.ts`: four call sites

Add `refreshBoard(ctx); refreshStatus(ctx);` at the end of each of the following four locations:

| Location | Current last statement before insertion |
|---|---|
| `session_start` handler body, after guard-token restoration | `restoreGuardTokens(entries)` call |
| `/workflow start` command branch, after `state.workflow = createWorkflow(...)` | `cancelWorkflowContinuationPending()` call |
| `/workflow load` command branch, after `state.workflow = persisted` assignment | `ctx.ui.notify(...)` call |
| Gate failure counter increment (`state.gateFailures.set(gate, ...)`) | `writeFieldLogEvent(...)` call |

**Measurable outcome:** Board widget is present immediately after each of these four events, verified by visual inspection in TUI.

## Test Strategy
- `/workflow start "test"` → board appears with `customMessageBg` background
- `/reload` → board reappears without manual command
- `/workflow load` (with persisted workflow) → board updates immediately
- `interview` phase → Deliverable line shows full sentence, not cut at word boundary
- Force a DPAA gate failure → board shows `❌ fail` without requiring user refresh

## Risks
- `Box` + `Text` with pre-colored ANSI strings: `Box` uses `visibleWidth` internally so ANSI codes are excluded from width calculations — safe.
- `setWidget` factory API is accessed via `(ctx.ui as any)` cast; no type safety. Pattern unchanged from existing code.
