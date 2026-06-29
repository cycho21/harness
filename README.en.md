# harness

[한국어 README](README.md)

Pi workflow harness source repository.

Pi workflow runtime files are isolated under `target/` so developing the harness from this repository root does not automatically load the harness extension, skills, or context files. The template includes a colorful high-visibility console theme at `target/.pi/themes/workflow-console.json`; it keeps a dark base while using brighter cyan, pink, yellow, and green accents for status and emphasis. In an initialized project it is installed as `.pi/themes/workflow-console.json` and can be selected as `workflow-console` in Pi's `/settings`. In an initialized project, `AGENTS.md`, `.pi/`, and `.harness/workflow-policy.json` are placed at the project root.

The TUI-improvement harness extension helper `target/.pi/extensions/workflow/markdown-box.ts` renders semantic fenced block types `note`, `warning`, `error`, `plan`, `review`, `decision`, and `tip` as boxed lines. The `target/.pi/extensions/assistant-markdown-box.ts` extension now uses that helper in the actual assistant-response rendering path for semantic fenced blocks, and also renders code fences (`ts`, `python`, `bash`, etc.) and natural-language assistant fenced blocks with info strings (`text`, `plain`, `plaintext`, and `txt`) as muted-teal TUI background panels with vertical margins. The raw assistant message stored in provider context/session history is not changed.

When developing the workflow extension, keep `target/.pi/extensions/workflow.ts` as the entrypoint and top-level assembly layer. `target/.pi/extensions/workflow/` contains responsibility-based implementation modules. Use Clean Architecture boundaries: orchestration/use-case logic belongs in `workflow/application/`, pure policy decisions belong in `workflow/domain/`, and Pi/TUI runtime wiring stays in the entrypoint or runtime adapter modules. Continuation/steer prompt orchestration now lives in `workflow/application/continuation.ts`, system prompt and guard-memory assembly in `workflow/application/prompt-context.ts`, `/workflow` command routing in `workflow/application/workflow-command-router.ts`, the tool-call gate pipeline in `workflow/application/tool-call-gate.ts`, extension mutation approval in `workflow/application/extension-mutation-approval.ts`, and TDD production-class classification in `workflow/domain/production-class-policy.ts`. Put phase/transition handling in `workflow/transitions.ts`, gate transition helpers in `workflow/gate-runner.ts`, checkpoint command handlers in `workflow/checkpoint-commands.ts`, and command/policy wiring in `workflow/command-policy.ts`. Put new guard decisions in `target/.pi/extensions/workflow/gates.ts`, reminder decisions in `workflow/reminders.ts`, command catalog logic and harness repo code-quality detection in `workflow/catalog.ts`, and state/persistence in `workflow/state.ts` and `workflow/storage.ts`. Put runtime process state in `workflow/runtime-state.ts`, phase tool policy and `/workflow` typo suggestions in `workflow/runtime-policy.ts`, footer/board/result box UI helpers in `workflow/runtime-ui.ts`, and general UI helpers in `workflow/ui.ts` or `workflow/interview-ui.ts`. Guard token CustomEntries are audit-only and are not restored as authority after a session restart. When adding a feature, choose the appropriate submodule before adding business logic to `workflow.ts`.

## Initialize in another project

From the target project's directory, run the one-liner for your OS.

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh
```

Then start Pi from the same project directory:

```powershell
pi
```

The initializer clones `https://github.com/chochanyeon/harness.git` into a temp directory, copies missing files from `target/`, then removes the temp clone. Existing files are skipped by default.

After initialization, self-check the install:

```text
/workflow doctor
```

The source repo test suite includes a fake LLM action-loop test that drives the real Pi workflow extension commands, tools, and events through a full workflow and guard recovery path.

```bash
python -m pytest tests/test_workflow_fake_llm_session.py -q
```

The `update-harness.sh` deployment path is covered by a sample consumer project smoke test. The test applies the update script to a fixed fixture, checks the installed files, and verifies the `interview -> plan -> plan_review -> implement` workflow phase path. It uses the existing fake/runtime harness pattern instead of launching the direct Pi CLI so local smoke runs stay stable.

```bash
python -m pytest tests/test_harness_consumer_smoke.py -q
```

After workflow guard/reminder/catalog changes, run the minimum smoke test for recently fragile areas. This bundle covers Windows `.bat` wrapping, code quality tooling-error handling, reminder signals, and TDD write/edit detection.

```bash
python -m pytest tests/test_workflow_reminders.py tests/test_workflow_run_command.py tests/test_code_quality_gate.py tests/test_workflow_tool_policy.py -q
```

DPAA dependencies are installed automatically into `.pi/.venv/` the first time the DPAA gate runs. The generated venv is ignored by `.pi/.gitignore`.

SBADR (Score-Based Ambiguity Detector and Resolver, ICSME 2020) is installed alongside DPAA under `.pi/sbadr/`. It detects syntactic ambiguity in English plan documents using Stanford CoreNLP dependency parsing (PP attachment, coordination scope, analytical, noun-phrase stacking). The workflow gate invokes SBADR through `.pi/.venv` with `python -m sbadr.cli analyze ...`. CoreNLP is installed automatically on the first gate run. To install manually:

```bash
# macOS/Linux
bash .pi/setup_corenlp.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .pi/setup_corenlp.ps1
```

Requires Java 17+ and downloads ~500 MB. DPAA and SBADR are complementary: DPAA covers multi-layer plan quality (structural, referential, temporal, verification) in a rule-based, server-free way; SBADR adds deep syntactic NLP analysis for English text.

Requirements discovery now focuses on the default workflow `interview → plan` path. The separate feature-interview, feature-planning-room, and requirements-room skills and slash commands have been removed. The `interview` skill now follows a deep-interview-lite style: it confirms top-level component topology early, cites narrow repo evidence first for brownfield work, and targets follow-up questions at the weakest clarity dimension across goal, scope, acceptance criteria, constraints, and existing context. After the wizard completes, the LLM must record goal/scope/acceptance/constraints/context scores (0–100 each) with `workflow_score_interview`; any dimension below 60 blocks the `interview → plan` transition.

Artifacts are written under `.ai/interview/`. Korean `.ko.md` files are the human source of truth, and English `.md` files are DPAA/SBADR-friendly machine-check artifacts. Specs include topology and necessary terminology, and plan steps map to the related topology component and acceptance criteria.

Supporting protocols are situational safety tools, not mandatory steps added to every default workflow. The default flow and conditional protocol taxonomy are documented in [`docs/workflow-protocol-taxonomy.md`](docs/workflow-protocol-taxonomy.md). The upstream OMC repository is [`yeachan-heo/oh-my-claudecode`](https://github.com/yeachan-heo/oh-my-claudecode), and patterns already borrowed from OMC plus anti-duplication rules are recorded in [`docs/omc-borrowed-patterns.md`](docs/omc-borrowed-patterns.md). Representative protocols include `trace` for causal analysis, `evidence-verification` for completion and regression evidence, `continuation-safety` for failure and pending-work recovery, `compact-handoff` for context compaction, `worktree-safety` for worktree operations, and `cleanup` for behavior-preserving cleanup. `/workflow trace <observation>` starts the trace protocol with the current workflow context.

High-risk plans require an extra consensus procedure in `plan_review`. When plan metadata says `Risk: high`, `Ambiguity gate: strict`, or `Work type: api|security|migration|data|deploy`, the LLM must run Architect/Critic-style feasibility and testability review and repair the plan before retrying the automatic implementation transition. The Critic procedure is an independent layer from DPAA (linguistic clarity gate): it checks key assumption FRAGILE rating, a pre-mortem (3 concrete failure scenarios), and executor perspective (can each step be completed with only what is written). The `code_review` skill applies the same Critic protocol to code changes: pre-commitment predictions, gap analysis, self-audit, realist check, and ADVERSARIAL escalation; it also requires changed-file/hunk coverage checks and Critical/Major position validation. Large review/trace/verification/DPAA outputs can use the descriptor contract in `target/.pi/extensions/workflow/artifact-descriptor.ts` with standard fields (`kind`, `path`, `producer`, `retention`, `sizeBytes`, `sha256`, and `summary`) instead of raw inline content, and DPAA receipts now record `dpaa-report` descriptors.

Harness failures are logged locally under `.project-memory/harness/events.jsonl` when gates block or are explicitly skipped. `/workflow failures` shows recent events plus category/severity counts so recurring guard friction or policy false positives are easy to spot. The separate audit stream at `.project-memory/harness/audit.jsonl` records `transition`, `guard_block`, `guard_skip`, and `approval_boundary_anomaly` events with minimal fields and without raw prompt/transcript content. Review and export redacted field logs with:

```text
/workflow failures
/workflow failures export
```

Guard recovery procedures and the missing approval dialog incident are documented in [`docs/workflow-guard-recovery.md`](docs/workflow-guard-recovery.md). The runtime event flow from `/workflow start` through continuation, guards, review, commit, push, and recovery is summarized in [`docs/workflow-runtime-events.md`](docs/workflow-runtime-events.md). LLM-facing prompt and protocol text that should be pinned by tests is documented in [`docs/workflow-prompt-contracts.md`](docs/workflow-prompt-contracts.md).

External memory is stored separately under `.project-memory/memory/`. It starts as a small, user-governed memory layer: remember durable facts, search/list them, disable incorrect entries, and inspect what was injected into the prompt. Agents can also save durable memory through the `memory_remember({ text })` tool without requiring the user to type a slash command. Retrieval/injection tracking is recorded as ids/hashes/counts rather than raw prompts. The extension also adds `.project-memory/` to `.git/info/exclude` on first write so local memory is not accidentally committed.

Current MVP commands/tools:

```text
/memory remember <durable project fact or decision>
memory_remember({ text })   # agent-facing tool that returns memoryId/status/summary/path
/memory list
/memory search <query>
/memory show <id>
/memory disable <id>
/memory enable <id>
/memory delete <id>
/memory explain
/memory doctor              # root, file health, status counts, recent injection ids/reasons/hash
/memory stats
/memory feedback <id> helpful|irrelevant|wrong|stale
/memory missed <query-or-description>
```

Principles: inject only relevant top-N memories, keep metrics to ids/hashes/counts instead of raw prompts, and reject raw secret-like memory text. Planned later: candidate extraction, approve/reject workflow, merge/supersede, export, and AGENTS.md promotion.

Install only one component when needed:

```bash
# workflow only
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh -s -- --component workflow

# memory only
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh -s -- --component memory
```

Operating model:

- Bash is not strongly sandboxed.
- Normal work must advance only to the next workflow phase; skipped phases/manual state recovery are treated as abnormal recovery paths.
- Automatic advancement phases are `interview → plan → plan_review → implement`, `implement → code_review`, and `review_approved → document → commit`. User approval is required only at `commit → push`; `plan_review → implement` is a DPAA/SBADR-gated automatic transition, and `code_review → review_approved` requires `submit_review_package` and the quality gate instead of simple user approval. `submit_review_package` can also store optional `reviewedFiles`, `skippedFiles`, and `positionValidation` evidence for changed-file/hunk coverage and Critical/Major position checks. For Gradle quality commands, the gate first runs a `compileJava` preflight before static analysis so compile/syntax failures are reported as `compilation-error` instead of being misdiagnosed as Checkstyle/PMD violations. It uses structured-argv `execFileSync` with `--no-daemon --no-build-cache`, does not use `-q`, and retries environment/tooling failures without Checkstyle/PMD/coverage violations once before blocking as `environment-error` with stdout/stderr tails in the reason. When a guard blocks a transition, the blocked message includes the default LLM handling: do not ask for a skip first, fix the underlying cause within the current phase when possible, then retry the transition. User input is reserved for product/architecture decisions, approval boundaries, or accepted-risk exceptions. If the approved implementation scope is already satisfied, the LLM should record concrete evidence, run the narrowest relevant verification, avoid inventing edits, and continue to `code_review`. The first standardization slice covers transition guard messages in `gates.ts`, related workflow failure or steering text, static tests, and both README files. AGENTS.md, `.pi/WORKFLOW.md`, `.harness/workflow-policy.json`, and the full tool or phase policy block-message cleanup are deferred to a second slice.
- `/workflow status`, `/workflow start`, `/workflow load`, `/workflow approve`, and `/workflow state <phase>` output include an `[LLM WORKFLOW ACTION]` block that states the current phase, next phase, transition mode, and required LLM action. `/workflow status` shows conditional protocol hints only for concrete triggers such as workspace mismatch, guard failure, missing verification evidence, review artifact write failure, or the latest still-active actionable field-log failure. Optional environment follow-up noise such as CoreNLP/Docker startup failure and already-cleared gate failures are excluded from the last actionable failure hint. After an automatic transition segment completes, the extension sends one continuation prompt only when the agent is idle and no pending messages exist, so the agent can continue the current phase. This continuation never crosses approval boundaries and is protected by stale/duplicate marker guards. When a phase changes, stale steer markers from earlier phases are cleaned up; if an old steer arrives late, it is consumed regardless of whether Pi reports it as extension or user input, preventing old `plan_review` or `code_review` guidance from overriding the current phase. In read-only phases such as `plan_review`, `code_review`, and `review_approved`, `write/edit` tool calls are blocked immediately instead of queuing follow-up steering, and workflow continuation is not queued while the agent is busy, preventing repeated `Follow-up: ⚠️ ...` warnings or stale continuations from accumulating in the TUI. At the `commit → push` boundary, tracked staged/modified changes block the transition with `Push blocked: uncommitted changes exist.` because they would not be included in the already-created commit; untracked files are not blocked by this guard because they are not push targets. The push policy scan also labels high-risk paths/files such as `auth`, `session`, `security`, `secret`, `token`, `permission`, `schema.prisma`, `.env*`, compose files, `infra`, `terraform`, `k8s`, `rbac`, `iam`, and `policy` separately from build/config/migration/Docker/CI/deletion/large-change findings. In the `push` phase, prefer the `workflow_run_command` `git-push` catalog command; it runs `git push` only in that phase and accepts no extra args, preventing arbitrary remote/branch or force-push variants. Git catalog commands run with structured argv as `git -C <workflow-root> ...` instead of shell `cd ... && git ...`, and active workflows block bash `cd ... && git ...` chains with a catalog-command hint. A successful real `git push` tool result is consumed as the completion event and advances `push → done` automatically. `workflow_approve` cannot advance `push → done`; the active workflow remains until a successful push is observed. The completion history remains persisted but the active workflow is cleared immediately so stale phase continuations are not injected into later prompts. `/workflow state <phase>` is manual recovery only. Normal operation should not ask the user to type `/workflow approve`; approval boundaries are handled with a TUI yes/no dialog, while automatic transition segments advance without user confirmation. The workflow approval dashboard safely normalizes transition metadata to strings so missing values are not rendered as `undefined`.
- When `/workflow start <goal>` starts the `interview` phase in a UI session, an interview wizard opens automatically. The LLM still provides the five baseline questions, and the runtime wraps them with deep-interview-lite questions: Round 0 topology confirmation before baseline discovery and a clarity checkpoint after it. The wizard presents questions one by one, combines choices with free-text input for most questions, allows `unknown/skip` only on optional questions, and blocks required questions until the user selects a choice or enters free text. It shows question progress above the editor and workflow title/current phase/next phase/overall phase progress in the footer. The preview key shows the collected answer summary, and the same summary appears automatically after the final question. The returned wizard result tells the LLM to treat topology as required spec/plan coverage, inspect narrow repo evidence for brownfield follow-ups, and ask focused questions for the weakest clarity dimension before advancing. If UI is unavailable or the wizard is cancelled/fails, the existing chat-based interview continuation remains the fallback.
- Context-heavy implementation, code review, large diff analysis, and log analysis should prefer subagents so the main agent remains a workflow controller with minimal context pollution. Pi prompts inject the concise `[WORKFLOW HARD RULES]` block from `.harness/workflow-policy.json` to remind the agent about phase order, approval boundaries, the code-review fix loop, subagent use, and main-context hygiene. `target/.pi/settings.json` raises the reviewer subagent default execution limit to 300000ms so long diff/review fixtures do not repeatedly hit the previous 120s timeout. In `implement`, `code_review`, `document`, and `commit`, prompts also inject the current `[CONTEXT STRATEGY]`: what main keeps, what it avoids, and the expected subagent return format.
- Guard blocked messages use this section order: `Why blocked`, `Default handling for the LLM`, `Next actions`, optional `Exception path`, and `Caution`. `Exception path` appears only for guards with a skip path. `Default handling for the LLM` states the no-skip-first rule, repair-before-retry for repairable failures, and the restricted conditions for user questions. DPAA/SBADR run as the automatic `plan_review → implement` gate with adaptive strictness: plan metadata (`Ambiguity gate: advisory|standard|strict`, `Risk: low|normal|high`, `Work type: docs|feature|api|security|migration`) is applied first, and keyword fallback is used when metadata is absent. docs/cosmetic/discovery/small work may become advisory based on the workflow title, may treat FAIL as advisory, and may proceed without a machine-checkable plan; normal feature work keeps FAIL blocking; API/schema/security/migration/data/deployment work stays strict when detected through metadata or in the workflow title/plan content. The verification layer accepts binary/observable acceptance conditions such as `command exits 0`, `tests pass`, `README updated`, and `no blockers/errors` in addition to numeric metrics. WARN remains advisory and does not block the transition. The workspace guard forbids file edits, workflow-state changes, and evidence simulation, then asks the user to return to the expected directory and branch. The policy-scan guard forbids hiding or silently changing risky files, then asks the agent to present the risk summary and use the interactive policy approval path.
- During `implement`, the TDD write policy blocks Java production behavior class edits until a related test already exists or the current implement phase has evidence that the related test file was written/edited first. It recognizes `FooTest`, `FooTests`, `FooIT`, and `FooIntegrationTest` in the corresponding test package. Required test creation is pre-approved implementation scope, not scope expansion, so agents must not ask the user before proceeding through RED → GREEN → REFACTOR. DTO/entity/model/repository/config-style artifacts remain exempt from hard blocking.
- Guarded edit tools block protected paths such as `.git/**`, `.env*`, `secrets/**`, `.ssh/**`, `node_modules/**`, and running runtime `.pi` code paths even when an edit scope is proposed.
- Gate skips remain accepted-risk exceptions. Humans can use `/workflow skip <dpaa|code-quality|policy-scan|interview-ambiguity> <reason>`, while agents that cannot execute slash commands can call `workflow_skip_gate(gate, reason)` after explaining the failure and receiving explicit user approval. Both paths show an interactive confirmation and create a one-use, 10-minute skip; the agent must retry the transition with `workflow_approve` afterward. Guard token CustomEntries are audit-only and are not restored as runtime authority after a session restart. `/workflow state <phase>` restores the phase only; it does not create DPAA, code-review, quality, or push guard evidence. Non-UI sessions do not approve accepted-risk skips, `/workflow state`, or `/workflow abort`; these recovery or destructive actions require an interactive confirmation.

### Extension modification boundary

Installed project runtime extensions under `.pi/extensions/**` are protected and require explicit user confirmation before mutation. In this harness source repository, `target/.pi/extensions/**` is the deployment template source and is a normal development target, not a protected runtime extension path.

Optional arguments:

Windows PowerShell:

```powershell
# Preview only
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -DryRun

# Use a specific branch/tag
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Ref main

# Overwrite existing files intentionally
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Force

# Clean reinstall managed harness runtime files, preserving AGENTS.md, .pi/LOCAL.md, and .ai/interview artifacts
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Clean

```

macOS/Linux:

```bash
# Preview only
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh -s -- --dry-run

# Use a specific branch/tag
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh -s -- --ref main

# Overwrite existing files intentionally
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh -s -- --force

# Clean reinstall managed harness runtime files, preserving AGENTS.md, .pi/LOCAL.md, and .ai/interview artifacts
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/init-target-harness.sh | sh -s -- --clean

```

## Update an installed harness

Run from the project root.

Windows PowerShell:

```powershell
$p=Join-Path $env:TEMP 'update-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/update-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/update-harness.sh | sh
```

Updates overwrite upstream-managed harness runtime files only. Project-owned files such as `AGENTS.md`, `.pi/config/`, and `.pi/local/` are preserved.

Caution: upstream-managed directories such as `.pi/skills`, `.pi/personas`, `.pi/workflows`, `.pi/themes`, and `.pi/extensions/workflow` may be replaced as whole directories during update. Put project-specific customizations under `.pi/local/` or `.pi/config/`.

Install/update entrypoints force UTF-8 for Windows PowerShell/cmd and Python subprocesses. They do not rely on the legacy Windows local code page for output/input.

Update only one component when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/update-harness.sh | sh -s -- --component workflow
curl -fsSL https://raw.githubusercontent.com/chochanyeon/harness/main/scripts/update-harness.sh | sh -s -- --component memory
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
