# harness

[한국어 README](README.md)

Pi workflow harness source repository.

Pi workflow runtime files are isolated under `target/` so developing the harness from this repository root does not automatically load the harness extension, skills, or context files. In an initialized project, `AGENTS.md`, `.pi/`, and optional Claude Code workflow-gate files under `.claude/` and `.harness/` are placed at the project root. Claude Code and Pi share workflow policy declarations through `.harness/workflow-policy.json` while keeping runtime-specific adapters separate.

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

DPAA dependencies are installed automatically into `.pi/.venv/` the first time the DPAA gate runs. The generated venv is ignored by `.pi/.gitignore`.

SBADR (Score-Based Ambiguity Detector and Resolver, ICSME 2020) is installed alongside DPAA under `.pi/sbadr/`. It detects syntactic ambiguity in English plan documents using Stanford CoreNLP dependency parsing (PP attachment, coordination scope, analytical, noun-phrase stacking). CoreNLP is installed automatically on the first gate run. To install manually:

```bash
# macOS/Linux
bash .pi/setup_corenlp.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .pi/setup_corenlp.ps1
```

Requires Java 17+ and downloads ~500 MB. DPAA and SBADR are complementary: DPAA covers multi-layer plan quality (structural, referential, temporal, verification) in a rule-based, server-free way; SBADR adds deep syntactic NLP analysis for English text.

Separate enhanced interview commands are available for new feature discovery:

```text
/feature-interview <feature-name or rough idea>
/feature-planning-room <feature-name or rough idea>
```

`/feature-interview` is the deep 1:1 interview mode. It uses `.ai/interview/feature-interview-protocol.md` as the shared protocol, so Pi's `feature-interview` skill and Claude Code's `/feature-interview` command follow the same rules.

`/feature-planning-room` is the CLI-first, GUI-ready meeting-room mode. It uses `.ai/interview/feature-planning-room-protocol.md` as the shared protocol and is designed to produce a participant roster, survey-style CLI packets, round-based facilitation, cross-role questions, decision logs, conflict logs, ambiguity registers, `session-state.json`, and `session-events.jsonl` so a future GUI chat can render the same session. Survey responses support both choice answers and multiple subjective answers in one message using `ID=value` or `ID:` blocks.

Both commands write artifacts under `.ai/interview/<feature-slug>/`: product, design, frontend, backend, integration PLAN documents plus ambiguity tracking. Korean `.ko.md` files are the human source of truth, and English `.md` files are DPAA/SBADR-friendly machine-check artifacts.

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
- The component also installs DPAA/SBADR runtime files (`.pi/dpaa`, `.pi/sbadr`) plus the shared enhanced feature interview protocols (`/feature-interview`, `/feature-planning-room`), codeQualityGuard, push policy scan, checkpoint/restore, and field-log support.

Operating model:

- Bash is not strongly sandboxed. To preserve UX, Claude Code uses reminders and PreToolUse checks as the default guardrail.
- Normal work must advance only to the next workflow phase; skipped phases/manual state recovery are treated as abnormal recovery paths.
- Automatic advancement phases are `interview → plan → plan_review`, `implement → code_review`, and `review_approved → document → commit`. User approval is required at `plan_review → implement` and `commit → push`; `code_review → review_approved` requires `submit_review_package` and the quality gate instead of simple user approval.
- `/workflow status`, `/workflow start`, `/workflow load`, `/workflow approve`, and `/workflow state <phase>` output include an `[LLM WORKFLOW ACTION]` block that states the current phase, next phase, transition mode, and required LLM action. After an automatic transition segment completes, the extension queues one follow-up continuation prompt when no pending messages exist so the agent continues the current phase. This continuation never crosses approval boundaries and is protected by stale/duplicate marker guards. `/workflow state <phase>` is manual recovery only; normal advancement uses `/workflow approve` or `submit_review_package`.
- Context-heavy implementation, code review, large diff analysis, and log analysis should prefer subagents so the main agent remains a workflow controller with minimal context pollution. Pi and Claude prompts also inject the concise `[WORKFLOW HARD RULES]` block from `.harness/workflow-policy.json` to remind the agent about phase order, approval boundaries, the code-review fix loop, subagent use, and main-context hygiene. In `implement`, `code_review`, `document`, and `commit`, prompts also inject the current `[CONTEXT STRATEGY]`: what main keeps, what it avoids, and the expected subagent return format.

Optional arguments:

Windows PowerShell:

```powershell
# Preview only
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -DryRun

# Use a specific branch/tag
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Ref main

# Overwrite existing files intentionally
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Force

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
