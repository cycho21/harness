# Pi Extension-First Workflow Core Design

## Summary

The previous direction considered building a separate Workflow SDK and standalone interactive console on top of the Pi SDK. After reviewing Pi's extension capabilities, that is no longer the recommended first path.

Pi extensions already support the core capabilities we need:

- custom guarded tools
- active tool control via `pi.setActiveTools()`
- pre-execution tool blocking via `tool_call`
- built-in tool override or disabling
- custom commands
- user approval dialogs and custom TUI through `ctx.ui`
- status/widgets/footer/message rendering
- session lifecycle hooks
- session persistence
- context/system prompt interception
- command execution through extension-owned logic

Therefore, the new plan is:

```text
Build workflow-core as a reusable TypeScript policy/runtime library.
Use a Pi extension adapter as the first implementation surface.
Defer a standalone SDK console until Pi TUI/extension limits are proven.
```

## Decision

Use **Pi extension-first** as the primary implementation path.

Do not build a separate Workflow SDK console initially.

## Goals

- Strengthen the existing harness inside Pi's extension system.
- Keep Pi's interactive mode, auth, model selection, sessions, compaction, and TUI.
- Move workflow policy logic into reusable `workflow-core` modules.
- Use Pi extension APIs to control active tools by phase.
- Expose guarded custom tools for workflow operations.
- Restrict or replace built-in `bash`, `edit`, and `write` where needed.
- Use explicit approvals, gate results, artifact hashes, and audit events.
- Keep future SDK/standalone CLI adapters possible, but not required for MVP.

## Non-Goals

- Do not build a separate `wf` console as the first milestone.
- Do not parse Pi interactive output.
- Do not duplicate Pi's session, model, auth, compaction, or TUI systems.
- Do not make the LLM the source of workflow authority.
- Do not rely only on prompt instructions for safety.

## Operating Principle

```text
LLM proposes and reasons.
Pi extension adapter controls what the LLM can call.
workflow-core authorizes phase transitions, tools, commands, approvals, and gates.
```

## Why Not Standalone SDK First?

A standalone SDK runtime still has value, but it is not the best first move.

### Capabilities Already Available in Pi Extensions

| Need | Pi extension support |
|---|---|
| Custom guarded tools | `pi.registerTool()` |
| Phase-specific tool exposure | `pi.setActiveTools()` |
| Block tool execution | `pi.on("tool_call")` returns `{ block: true }` |
| Override built-ins | register same tool name or use `--no-builtin-tools` |
| Bash interception | `tool_call`, `user_bash`, custom tools, `pi.exec()` |
| User approval | `ctx.ui.confirm()`, `select()`, `input()`, `custom()` |
| Clean TUI status | `setStatus`, `setWidget`, `setFooter`, renderers |
| State persistence | `pi.appendEntry()` or project-local files |
| Context control | `before_agent_start`, `context`, `before_provider_request` |
| Session lifecycle | `session_start`, `session_shutdown`, switch/fork/compact hooks |

### Standalone SDK Runtime Costs

A separate SDK runtime would require us to own or wrap:

- process entrypoint
- interactive input loop
- rendering
- model/session setup
- lifecycle management
- logs and event bridge
- tool registration
- approval UI
- future compatibility with Pi internals

Pi extension mode already gives most of that.

## Architecture

```text
target/.pi/extensions/workflow.ts
  └─ Pi adapter / command registration / event hooks

workflow-core
  ├─ WorkflowStateMachine
  ├─ PhasePolicy
  ├─ ToolPolicy
  ├─ CommandCatalog
  ├─ ApprovalManager
  ├─ ArtifactStore
  ├─ GateRunner
  ├─ AuditLog
  └─ HashBinding

Pi runtime
  ├─ interactive TUI
  ├─ sessions
  ├─ model/auth/compaction
  ├─ extension lifecycle
  └─ active tool surface
```

The adapter owns Pi-specific wiring. The core owns deterministic policy.

## workflow-core Responsibilities

`workflow-core` should be UI-agnostic and Pi-agnostic where practical.

It should provide:

- phase order and transition validation
- approval boundary rules
- phase-specific tool policy
- command allowlist policy
- artifact hash binding
- gate staleness rules
- audit event schema
- state persistence helpers
- policy decision functions

Example shape:

```ts
interface WorkflowCore {
  getState(): WorkflowState;
  requestTransition(to: WorkflowPhase): PolicyDecision;
  approveBoundary(boundary: ApprovalBoundary, evidence: ApprovalEvidence): PolicyDecision;
  evaluateToolCall(call: ToolCallIntent): PolicyDecision;
  evaluateCommand(command: CommandIntent): PolicyDecision;
  recordGateResult(result: GateResult): PolicyDecision;
}
```

## Pi Extension Adapter Responsibilities

The Pi extension adapter should:

- register `/workflow` commands
- load and save workflow state
- register guarded workflow tools
- update active tools per phase with `pi.setActiveTools()`
- block unexpected or disallowed tool calls in `tool_call`
- ask user approval through `ctx.ui.confirm()` or richer custom UI
- show compact workflow status through `setStatus` and `setWidget`
- hide or summarize noisy tool output where possible
- write audit events
- run DPAA/SBADR/code-quality gates

## Tool Surface Strategy

Prefer a deny-by-default tool surface.

### Default Tool Posture

For strict workflow sessions:

```text
no unrestricted built-in tools by default
activate only phase-allowed guarded tools
```

Potential approaches:

1. Start Pi with `--no-builtin-tools` and register workflow tools.
2. Override built-ins with guarded versions.
3. Use `pi.setActiveTools()` to expose only phase-allowed tools.
4. Add `tool_call` backstop checks for unexpected tools.

The exact approach should be validated in an MVP 0 spike.

## Guarded Tools

Initial guarded tools:

```text
workflow_read_context
workflow_write_artifact
workflow_record_decision
workflow_record_blocker
workflow_run_command
workflow_run_dpaa
workflow_run_sbadr
workflow_request_approval
workflow_submit_review_package
```

Later guarded tools:

```text
workflow_propose_edit
workflow_apply_approved_edit
workflow_prepare_commit
workflow_push_with_policy
```

Every guarded tool must:

1. validate current phase
2. validate parameters
3. validate artifact/path/command policy
4. execute or reject
5. write audit event
6. return structured result to the LLM

## Built-In Tool Handling

Built-in tools should not be trusted by prompt instructions alone.

### Read Tools

`read`, `grep`, `find`, and `ls` may be allowed in early MVPs if scoped safely.

Risks:

- secret leakage
- huge context injection
- reading unrelated project areas

Mitigations:

- path denylist
- max file size
- binary refusal
- secret pattern checks
- phase-specific readable scopes

### Write/Edit Tools

`write` and `edit` should be disabled or overridden in strict workflow mode.

Use `workflow_write_artifact` for artifacts first.

Use `workflow_apply_approved_edit` only after an edit scope model exists.

### Bash Tool

Raw `bash` should be disabled or blocked by default.

Use `workflow_run_command` with a command catalog instead.

## Command Catalog

Do not represent commands as raw shell strings.

Use structured argv specs.

```ts
interface CommandSpec {
  id: string;
  description: string;
  executable: string;
  fixedArgs: string[];
  argSchema?: unknown;
  allowedPhases: WorkflowPhase[];
  cwdPolicy: "project-root" | "artifact-root" | "custom";
  timeoutMs: number;
  maxOutputBytes: number;
  outputPolicy: "summary" | "store-full" | "inline-small";
  riskLevel: "low" | "medium" | "high" | "destructive";
  requiresApproval: boolean;
  envAllowlist: string[];
  networkPolicy: "forbid" | "allow" | "unknown";
  stdinPolicy: "none" | "fixed" | "allowed";
}
```

Examples:

```text
git-status
git-diff
git-log-recent
dpaa-check
sbadr-check
code-quality
project-test
project-build
```

Package-manager commands should be treated as medium/high risk because scripts can run arbitrary code.

## Approval and Gate Hash Binding

Approvals and gate results must be bound to immutable artifact content.

```ts
interface ApprovalEvidence {
  boundary: "plan_review:implement" | "commit:push";
  artifactIds: string[];
  artifactHashes: string[];
  policyVersion: string;
  approvedBy: "interactive-user";
  approvedAt: string;
}
```

```ts
interface GateResult {
  gate: "dpaa" | "sbadr" | "code-quality" | "policy-scan";
  status: "pass" | "fail" | "skipped";
  artifactIds: string[];
  artifactHashes: string[];
  policyVersion: string;
  reportPath: string;
  completedAt: string;
}
```

A phase transition must fail if the current artifact hashes no longer match the approved/gated hashes.

## Edit Scope Model

Even if file editing is not in the first MVP, the model must be designed early.

```ts
interface EditScope {
  id: string;
  approvedBy: "interactive-user";
  sourcePlanArtifactId: string;
  sourcePlanHash: string;
  allowedGlobs: string[];
  deniedGlobs: string[];
  maxFiles: number;
  maxBytesChanged: number;
  allowSymlinks: boolean;
  requiresDiffPreview: boolean;
  baseFileHashes?: Record<string, string>;
}
```

Rules:

- canonicalize paths before checking
- reject path traversal
- reject protected paths
- reject symlinks unless explicitly allowed
- bind writes to approved plan hash
- revalidate immediately before mutation

## Runtime State

The current harness already uses `.harness/`, `.ai/interview/`, and Pi session state. Avoid introducing a competing source of truth without a migration plan.

Recommended MVP posture:

```text
Use existing harness state/artifact locations where possible.
Add workflow-core metadata only where current state cannot represent it.
```

Potential locations:

```text
.harness/workflow.json
.harness/workflow-policy.json
.ai/interview/**
.project-memory/harness/events.jsonl
```

If `.workflow/` is later introduced, define it as a replacement or adapter-owned storage root, not an uncoordinated second source of truth.

## Audit Log

Audit events should be machine-readable and append-only where practical.

Important events:

```text
workflow.started
phase.transition.requested
phase.transition.blocked
phase.transition.completed
tool.allowed
tool.blocked
tool.executed
command.requested
command.executed
command.blocked
gate.started
gate.completed
approval.requested
approval.granted
approval.denied
artifact.written
artifact.changed
```

Future hardening:

- hash-chained audit entries
- file locking
- atomic state writes
- replay-based recovery

## UI Strategy Inside Pi

Use Pi's interactive mode instead of replacing it initially.

Use extension UI APIs to make the workflow feel cleaner:

- `ctx.ui.setStatus()` for phase/gate summary
- `ctx.ui.setWidget()` for compact workflow board
- `ctx.ui.confirm()` for approval boundaries
- `ctx.ui.select()` for structured choices
- `ctx.ui.input()` / `ctx.ui.editor()` for targeted input
- `pi.registerMessageRenderer()` for concise workflow messages
- custom tool `renderCall` / `renderResult` to hide raw noise
- optionally `ctx.ui.custom()` for richer phase screens

Raw logs should still be written to files. The TUI should show summaries and paths.

## TUI UX Specification

The workflow UI should make Pi feel like a controlled workflow console without replacing Pi's interactive mode.

### Layout

Use a persistent workflow board near the editor.

Preferred placement:

```text
above editor: compact workflow board
footer/status: one-line phase indicator
message stream: concise workflow events only
raw details: files, overlays, or explicit show commands
```

Compact board example:

```text
╭─ Workflow ─────────────────────────────────────╮
│ Phase     plan_review                          │
│ Gates     DPAA pass · SBADR pending            │
│ Approval  required                             │
│ Tools     read_context · write_artifact        │
│ Next      approve plan or revise artifacts     │
╰────────────────────────────────────────────────╯
```

The board should stay small. It should summarize state, not become a log viewer.

### Phase-Specific Display

Each phase should expose the next useful action and the minimum evidence required to continue.

| Phase | Primary UI content |
|---|---|
| `interview` | current question, missing decisions, next question/action |
| `plan` | draft artifacts, open assumptions, required review checks |
| `plan_review` | plan hash, DPAA/SBADR status, approval requirement, revise/approve choices |
| `implement` | approved edit scope, allowed files, latest changed files, pending gates |
| `code_review` | review package status, independent review status, quality gate results |
| `review_approved` | approved review evidence and documentation/commit readiness |
| `document` | documentation updates needed and completed |
| `commit` | commit summary, staged files, final gate freshness |
| `push` | remote/branch, commit hash, push approval status |
| `done` | final summary and evidence paths |

### Approval UI

Approval boundaries should use explicit dialogs or overlays rather than plain text prompts.

Approval screen example:

```text
╭─ Approval Required ─────────────────────────────╮
│ Boundary   plan_review → implement             │
│ Artifact   docs/plan.md                        │
│ Hash       a83f91c...                          │
│ Gates      DPAA pass · SBADR pass              │
│ Risk       medium                              │
│                                                │
│ [Approve] [Show report] [Reject] [Revise]      │
╰────────────────────────────────────────────────╯
```

Rules:

- show boundary, artifacts, hashes, gate status, and risk level
- show short hashes in the UI, but store full hashes in approval evidence
- never approve stale hashes
- include a clear reject/revise path
- write an audit event for approve, reject, and cancel

### Tool Result Rendering

Tool output should be concise by default.

Success:

```text
✓ dpaa-check passed
  report: .harness/reports/dpaa-20260603.md
```

Blocked:

```text
⚠ command blocked: npm install
  reason: command not in catalog
  next: choose an allowed command or request policy update
```

Failure:

```text
✗ quality gate failed
  summary: 2 checkstyle violations
  report: .harness/reports/code-quality-20260603.md
```

Rules:

- use `renderCall` and `renderResult` for guarded tools
- show at most a small summary inline
- store full stdout/stderr in artifacts when output is large
- always include the report/artifact path for details
- include the next recommended action for blocked or failed operations

### Details, Logs, and Overlays

The default UI should remain clean. Details are opt-in.

Commands or UI actions should provide:

```text
/workflow status
/workflow show artifact <id>
/workflow show gate <gate>
/workflow logs
/workflow tools
```

Detailed content can use `ctx.ui.custom()` overlays:

- right-side gate report panel
- centered approval dialog
- artifact preview screen
- command output/log viewer
- policy rejection explanation

Raw logs should not flood the message stream.

### Guard Block UX

A blocked action must explain three things:

1. what was blocked
2. why it was blocked
3. what to do next

Example:

```text
⚠ transition blocked
  from: plan_review
  to: implement
  reason: plan artifact changed after approval
  next: re-run DPAA and request approval again
```

### Keyboard UX

Interactive workflow screens should use predictable keys:

```text
↑/↓       move selection
enter     choose primary action
esc       cancel/close
r         rerun selected gate when available
d         show details
l         show logs
?         show help
```

Every custom component should show a one-line help footer.

### Noise Policy

The message stream should prioritize human-readable workflow events.

Default behavior:

- suppress raw command output unless short and useful
- summarize tool calls and results
- show file/report paths for evidence
- reserve overlays or show commands for details
- keep assistant prose concise around workflow operations

### Accessibility and Terminal Constraints

- every rendered line must fit the provided width
- use theme colors, not hardcoded color assumptions
- preserve Korean/IME behavior for input components
- support narrow terminal fallback by hiding nonessential widgets
- ensure keyboard-only operation works for approvals and details

## MVP 0 — Pi Extension Capability Spike

Before changing the main workflow, prove these extension capabilities in a small spike:

- register custom guarded tool
- disable or hide built-in tools
- use `pi.setActiveTools()` dynamically
- block a built-in tool with `tool_call`
- run a command through `pi.exec()` with argv
- show status/widget/confirm UI
- persist a small state entry
- verify behavior in TUI and RPC modes if relevant

Exit criteria:

```text
A small extension can run with only guarded tools active and block unexpected tools.
```

## MVP 1 — Extract workflow-core Policy

- Move phase order and transition policy into reusable TS modules.
- Add policy decision types.
- Add artifact hash helpers.
- Add approval evidence schema.
- Add gate result schema.
- Add basic audit event schema.
- Add unit tests for transitions and approval boundaries.

No major TUI changes yet.

## MVP 2 — Pi Adapter Tool Surface Control

- Register initial guarded tools.
- Apply phase-based `pi.setActiveTools()`.
- Add `tool_call` backstop blocking.
- Add command catalog with structured argv.
- Add `workflow_run_command`.
- Add policy rejection responses.
- Add tests for command injection and tool rejection.

## MVP 3 — Gate Binding and Approval Integrity

- Bind DPAA result to plan artifact hash.
- Bind user approval to artifact hash.
- Reject stale gate/approval transitions.
- Add compact workflow status widget.
- Add `/workflow approve` improvements using `ctx.ui.confirm()`.

## MVP 4 — Guarded Editing

- Define and enforce `EditScope`.
- Add `workflow_propose_edit`.
- Add `workflow_apply_approved_edit`.
- Use file mutation queue where needed.
- Add protected path and symlink tests.

## MVP 5 — Cleaner Interactive Experience

- Improve tool rendering.
- Reduce noisy system output.
- Add workflow board widget.
- Add concise gate summaries.
- Add debug/log commands for raw evidence.

## Pi Documentation Review Plan

Before implementation, review the current Pi documentation pages and record which capabilities affect this design.

Known docs index:

```text
/docs/latest/quickstart
/docs/latest/usage
/docs/latest/providers
/docs/latest/containerization
/docs/latest/settings
/docs/latest/keybindings
/docs/latest/sessions
/docs/latest/compaction
/docs/latest/extensions
/docs/latest/skills
/docs/latest/prompt-templates
/docs/latest/themes
/docs/latest/packages
/docs/latest/models
/docs/latest/custom-provider
/docs/latest/sdk
/docs/latest/rpc
/docs/latest/json
/docs/latest/tui
/docs/latest/session-format
/docs/latest/windows
/docs/latest/termux
/docs/latest/tmux
/docs/latest/terminal-setup
/docs/latest/shell-aliases
/docs/latest/development
```

Review goals:

- identify extension APIs that replace standalone SDK work
- identify TUI, theme, command, and rendering capabilities
- identify model/provider/OAuth capabilities
- identify session/state/compaction constraints
- identify platform or terminal constraints relevant to workflow UX
- update this design only with documented capabilities and remaining gaps

## Test Strategy

Minimum tests:

- state machine transition tests
- approval boundary tests
- artifact hash staleness tests
- gate result binding tests
- active tool policy tests
- tool rejection tests
- command argv validation tests
- shell injection prevention tests
- protected path tests
- symlink/path traversal tests
- audit event tests
- Pi extension spike tests where feasible

## When to Reconsider Standalone SDK Runtime

Reconsider a standalone SDK console only if one or more becomes true:

- Pi TUI cannot be made clean enough through extension UI.
- Extension ordering or user-installed extensions create unacceptable policy ambiguity.
- We need a non-Pi product surface.
- We need central multi-project workflow orchestration.
- We need a GUI/server where Pi interactive mode is not involved.
- We need stronger isolation than extension mode can provide.

## Open Questions

1. Should strict workflow mode require `--no-builtin-tools`?
2. Which read-only built-ins should remain active in each phase?
3. Should command catalog be project-configurable, auto-detected, or both?
4. How much state should remain in `.harness/` versus Pi session custom entries?
5. Should SBADR be a required gate or preview-only until CoreNLP reliability improves?
6. How should this design coexist with Claude Code workflow gate files?

## Revised Decision Draft

```text
Do not build a standalone Workflow SDK console first.
Use Pi extensions as the primary execution surface.
Extract workflow-core policy modules for reuse and testability.
Use guarded custom tools and active tool control inside Pi.
Use command catalog instead of raw Bash.
Bind approvals and gate results to artifact hashes.
Keep SDK/standalone console as a future adapter, not the MVP.
```
