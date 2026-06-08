# harness

[한국어 README](README.md)

Pi workflow harness source repository.

Pi workflow runtime files are isolated under `target/` so developing the harness from this repository root does not automatically load the harness extension, skills, or context files. The template includes a colorful high-visibility console theme at `target/.pi/themes/workflow-console.json`; it keeps a dark base while using brighter cyan, pink, yellow, and green accents for status and emphasis. In an initialized project it is installed as `.pi/themes/workflow-console.json` and can be selected as `workflow-console` in Pi's `/settings`. In an initialized project, `AGENTS.md`, `.pi/`, and optional Claude Code workflow-gate files under `.claude/` and `.harness/` are placed at the project root. Claude Code and Pi share workflow policy declarations through `.harness/workflow-policy.json` while keeping runtime-specific adapters separate.

The TUI-improvement harness extension helper `target/.pi/extensions/workflow/markdown-box.ts` provides reusable box-line rendering for semantic fenced block types `note`, `warning`, `error`, `plan`, `review`, `decision`, and `tip`. The `target/.pi/extensions/assistant-markdown-box.ts` extension also renders natural-language assistant fenced blocks with info strings (`text`, `plain`, `plaintext`, and `txt`) as warm amber TUI background panels. Real code fences remain handled by Pi's Markdown renderer, and the raw assistant message stored in provider context/session history is not changed.

When developing the workflow extension, keep `target/.pi/extensions/workflow.ts` as the entrypoint and top-level assembly layer. Put new guard decisions in `target/.pi/extensions/workflow/gates.ts`, reminder decisions in `workflow/reminders.ts`, command catalog logic and harness repo code-quality detection in `workflow/catalog.ts`, and state/persistence in `workflow/state.ts` and `workflow/storage.ts`. Put runtime process state, guard token restoration, and stale steer metadata in `workflow/runtime-state.ts`, phase tool policy, runtime extension mutation approval checks, and `/workflow` typo suggestions in `workflow/runtime-policy.ts`, footer/board/result box UI helpers in `workflow/runtime-ui.ts`, and general UI helpers in `workflow/ui.ts` or `workflow/interview-ui.ts`. When adding a feature, choose the appropriate submodule before adding business logic to `workflow.ts`.

## Initialize in another project

From the target project's directory, run the one-liner for your OS.

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh
```

Then start Pi from the same project directory:

```powershell
pi
```

The initializer clones `https://github.com/cycho21/harness.git` into a temp directory, copies missing files from `target/`, then removes the temp clone. Existing files are skipped by default.

After initialization, self-check the install:

```text
/workflow doctor
```

The source repo test suite includes a fake LLM action-loop test that drives the real Pi workflow extension commands, tools, and events through a full workflow and guard recovery path.

```bash
python -m pytest tests/test_workflow_fake_llm_session.py -q
```

After workflow guard/reminder/catalog changes, run the minimum smoke test for recently fragile areas. This bundle covers Windows `.bat` wrapping, code quality tooling-error handling, reminder signals, and TDD write/edit detection.

```bash
python -m pytest tests/test_workflow_reminders.py tests/test_workflow_run_command.py tests/test_code_quality_gate.py tests/test_workflow_tool_policy.py -q
```

DPAA dependencies are installed automatically into `.pi/.venv/` the first time the DPAA gate runs. The generated venv is ignored by `.pi/.gitignore`.

SBADR (Score-Based Ambiguity Detector and Resolver, ICSME 2020) is installed alongside DPAA under `.pi/sbadr/`. It detects syntactic ambiguity in English plan documents using Stanford CoreNLP dependency parsing (PP attachment, coordination scope, analytical, noun-phrase stacking). CoreNLP is installed automatically on the first gate run. To install manually:

```bash
# macOS/Linux
bash .pi/setup_corenlp.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .pi/setup_corenlp.ps1
```

Requires Java 17+ and downloads ~500 MB. DPAA and SBADR are complementary: DPAA covers multi-layer plan quality (structural, referential, temporal, verification) in a rule-based, server-free way; SBADR adds deep syntactic NLP analysis for English text.

Separate requirements-discovery and enhanced interview commands are available for new feature discovery:

```text
/requirements-room <feature-name or rough idea>
/feature-interview <feature-name or rough idea>
/feature-planning-room <feature-name or rough idea>
```

Duplicate, legacy, or advanced-room skills (`code-review-gate`, `push-with-review`, `feature-interview`, `feature-planning-room`, `requirements-room`) are kept command-only and excluded from default model auto-invocation. Use them only through an explicit `/skill:<name>` call or the corresponding slash command.

`/requirements-room` is the new multi-role requirements meeting facilitator. It is separate from the default workflow interview and the older planning-room draft. It runs short rounds for product, design, frontend, backend, QA/integration, and operations perspectives, then records cross-role contracts, conflicts, decisions, assumptions, and open questions as a requirements package. It uses `.ai/interview/requirements-room-protocol.md` as the shared protocol and writes artifacts under `.ai/interview/<feature-slug>/requirements-room/`.

`/feature-interview` is the deep 1:1 interview mode. It uses `.ai/interview/feature-interview-protocol.md` as the shared protocol, so Pi's `feature-interview` skill and Claude Code's `/feature-interview` command follow the same rules.

`/feature-planning-room` is the CLI-first, GUI-ready meeting-room draft. It uses `.ai/interview/feature-planning-room-protocol.md` as the shared protocol and is designed to produce a participant roster, survey-style CLI packets, round-based facilitation, cross-role questions, decision logs, conflict logs, ambiguity registers, `session-state.json`, and `session-events.jsonl` so a future GUI chat can render the same session.

Artifacts are written under `.ai/interview/<feature-slug>/`. Korean `.ko.md` files are the human source of truth, and English `.md` files are DPAA/SBADR-friendly machine-check artifacts.

Harness failures are logged locally under `.project-memory/harness/events.jsonl` when gates block or are explicitly skipped. Review and export redacted logs with:

```text
/workflow failures
/workflow failures export
```

External memory is stored separately under `.project-memory/memory/`. It starts as a small, user-governed memory layer: manually remember durable facts, search/list them, disable incorrect entries, and inspect what was injected into the prompt. Retrieval/injection tracking is recorded as ids/hashes/counts rather than raw prompts. The extension also adds `.project-memory/` to `.git/info/exclude` on first write so local memory is not accidentally committed.

Current MVP commands:

```text
/memory remember <durable project fact or decision>
/memory list
/memory search <query>
/memory explain
/memory stats
/memory feedback <id> helpful|irrelevant|wrong|stale
```

Planned later: candidate extraction, approve/reject workflow, merge/supersede, export, and AGENTS.md promotion. These are intentionally not automatic in the MVP.

Default `--component all` means Pi `workflow + memory`. Claude Code workflow gates are intentionally separate; install them explicitly with `--component claude-workflow`.

Install only one component when needed:

```bash
# workflow only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component workflow

# memory only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component memory

# Claude Code workflow gate only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component claude-workflow
```

The Claude Code component installs `.claude/settings.json` with workflow hooks. The built-in Bash sandbox is intentionally not enabled by default because it harms UX too much; the default guardrail is hook/reminder-driven workflow enforcement.

- `UserPromptSubmit` repeatedly reminds the agent of the current phase, next phase, no-skip rule, and subagent guidance.
- `PreToolUse` blocks file-tool writes to `.claude/**`, `.harness/state.json`, `.harness/authority/**`, and other protected gate paths, then checks phase-appropriate tool use.
- `PostToolUse` reevaluates artifacts and advances workflow state automatically when exit conditions pass.
- `.harness/workflow-policy.json` declares shared Pi/Claude phase order, auto-advance, approval-boundary, transition, reminder, and context-management policy. It is the SSOT for phase order and approval boundaries.
- The component also installs DPAA/SBADR runtime files (`.pi/dpaa`, `.pi/sbadr`) plus the shared requirements-discovery protocols (`/requirements-room`, `/feature-interview`, `/feature-planning-room`), codeQualityGuard, push policy scan, checkpoint/restore, and field-log support.

Operating model:

- Bash is not strongly sandboxed. To preserve UX, Claude Code uses reminders and PreToolUse checks as the default guardrail.
- Normal work must advance only to the next workflow phase; skipped phases/manual state recovery are treated as abnormal recovery paths.
- Automatic advancement phases are `interview → plan → plan_review`, `implement → code_review`, and `review_approved → document → commit`. User approval is required at `plan_review → implement` and `commit → push`; `code_review → review_approved` requires `submit_review_package` and the quality gate instead of simple user approval. When a guard blocks a transition, the blocked message includes the default LLM handling: do not ask for a skip first, fix the underlying cause within the current phase when possible, then retry the transition. User input is reserved for product/architecture decisions, approval boundaries, or accepted-risk exceptions.
- `/workflow status`, `/workflow start`, `/workflow load`, `/workflow approve`, and `/workflow state <phase>` output include an `[LLM WORKFLOW ACTION]` block that states the current phase, next phase, transition mode, and required LLM action. After an automatic transition segment completes, the extension sends one continuation prompt only when the agent is idle and no pending messages exist, so the agent can continue the current phase. This continuation never crosses approval boundaries and is protected by stale/duplicate marker guards. When a phase changes, stale steer markers from earlier phases are cleaned up; if an old steer arrives late, it is consumed regardless of whether Pi reports it as extension or user input, preventing old `plan_review` or `code_review` guidance from overriding the current phase. In read-only phases such as `plan_review`, `code_review`, and `review_approved`, `write/edit` tool calls are blocked immediately instead of queuing follow-up steering, and workflow continuation is not queued while the agent is busy, preventing repeated `Follow-up: ⚠️ ...` warnings or stale continuations from accumulating in the TUI. In the `push` phase, a successful real `git push` bash `tool_result` is consumed as the completion event and advances `push → done` automatically. The completion history remains persisted but the active workflow is cleared immediately so stale phase continuations are not injected into later prompts. `/workflow state <phase>` is manual recovery only. Normal operation should not ask the user to type `/workflow approve`; approval boundaries are handled with a TUI yes/no dialog, while automatic transition segments advance without user confirmation. The workflow approval dashboard safely normalizes transition metadata to strings so missing values are not rendered as `undefined`.
- When `/workflow start <goal>` starts the `interview` phase in a UI session, an interview wizard opens automatically. It presents the existing five interview questions one by one, combines choices with free-text input for most questions, allows `unknown/skip` only on optional questions, and blocks required questions until the user selects a choice or enters free text. It shows question progress above the editor and workflow title/current phase/next phase/overall phase progress in the footer. The preview key shows the collected answer summary, and the same summary appears automatically after the final question. If UI is unavailable or the wizard is cancelled/fails, the existing chat-based interview continuation remains the fallback.
- Context-heavy implementation, code review, large diff analysis, and log analysis should prefer subagents so the main agent remains a workflow controller with minimal context pollution. Pi and Claude prompts also inject the concise `[WORKFLOW HARD RULES]` block from `.harness/workflow-policy.json` to remind the agent about phase order, approval boundaries, the code-review fix loop, subagent use, and main-context hygiene. In `implement`, `code_review`, `document`, and `commit`, prompts also inject the current `[CONTEXT STRATEGY]`: what main keeps, what it avoids, and the expected subagent return format.
- Gate skips remain accepted-risk exceptions. Humans can use `/workflow skip <dpaa|code-quality|policy-scan> <reason>`, while agents that cannot execute slash commands can call `workflow_skip_gate(gate, reason)` after explaining the failure and receiving explicit user approval. Both paths show an interactive confirmation and create a one-use, 10-minute skip; the agent must retry the transition with `workflow_approve` afterward.

### Extension modification boundary

Installed project runtime extensions under `.pi/extensions/**` are protected and require explicit user confirmation before mutation. In this harness source repository, `target/.pi/extensions/**` is the deployment template source and is a normal development target, not a protected runtime extension path.

Optional arguments:

Windows PowerShell:

```powershell
# Preview only
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -DryRun

# Use a specific branch/tag
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Ref main

# Overwrite existing files intentionally
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Force

# Clean reinstall managed harness runtime files, preserving AGENTS.md, .pi/LOCAL.md, and .ai/interview artifacts
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Clean

# Install only one component
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Component claude-workflow
```

macOS/Linux:

```bash
# Preview only
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --dry-run

# Use a specific branch/tag
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --ref main

# Overwrite existing files intentionally
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --force

# Clean reinstall managed harness runtime files, preserving AGENTS.md, .pi/LOCAL.md, and .ai/interview artifacts
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --clean

# Install only one component
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component claude-workflow
```

## Update an installed harness

Run from the project root.

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'update-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh
```

Updates overwrite upstream-managed harness runtime files only. Project-owned files such as `AGENTS.md`, `.pi/config/`, and `.pi/local/` are preserved.

Caution: upstream-managed directories such as `.pi/skills`, `.pi/personas`, `.pi/workflows`, `.pi/themes`, and `.pi/extensions/workflow` may be replaced as whole directories during update. Put project-specific customizations under `.pi/local/` or `.pi/config/`.

Install/update entrypoints force UTF-8 for Windows PowerShell/cmd and Python subprocesses. They do not rely on the legacy Windows local code page for output/input.

Update only one component when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component workflow
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component memory
```

## Customization boundary

**Dependencies:**

| Dependency | Purpose | Notes |
|---|---|---|
| Python 3.10+ | DPAA, SBADR | venv auto-created by harness |
| Java 17+ | SBADR (CoreNLP) | CoreNLP auto-installed on first gate run |
| git | workflow | required |

- Upstream-managed: `.pi/extensions/`, `.pi/dpaa/`, `.pi/sbadr/`, `.pi/setup_corenlp.sh`, `.pi/setup_corenlp.ps1`, `.pi/workflows/`, `.pi/skills/`, `.pi/personas/`, `.pi/WORKFLOW.md`, `.pi/GOVERNANCE.md`, `.pi/pyproject.toml`, `.pi/schemas/`
- Project-owned: `AGENTS.md`, `.pi/config/`, `.pi/local/`, `.pi/LOCAL.md`
- Generated/ignored: `.pi/.venv/`, `.pi/.cache/`, `.pi/dpaa-runs/`

See `.pi/LOCAL.md` after initialization for the same boundary inside the project.

## Preview the bundled target template

`target/` is the template that gets copied into another project. To preview that template locally without initializing another repository:

```powershell
cd target
pi
```

For normal usage, run the initializer from the project you want to equip with the harness, then run `pi` from that project root.

Key runtime entrypoints:

- `target/AGENTS.md`
- `target/.pi/WORKFLOW.md`
- `target/.pi/extensions/workflow.ts`
- `target/.harness/workflow-policy.json`
- `target/.pi/extensions/memory.ts`
- `target/.pi/skills/`
- `target/.pi/personas/`
- `target/.pi/GOVERNANCE.md`
- `target/.pi/dpaa/`
- `target/.pi/sbadr/`
- `target/.pi/setup_corenlp.sh`
- `target/.pi/pyproject.toml`
- `target/.pi/workflows/`
- `target/.pi/schemas/harness-field-log-event.schema.json`
- `target/.pi/schemas/harness-memory-entry.schema.json`
