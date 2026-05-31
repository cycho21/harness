# External Memory Extension Development Plan

## Goal
Build a separate Pi extension that gives LLM-augmented development a small, durable, user-governable memory layer. The extension should help future work by retrieving only the few memories that are relevant to the current task, while avoiding memory pollution, stale guidance, prompt-cache churn, and user loss of control.

## Critical Assumption
External memory is not valuable because it stores a lot. It is valuable only if it reliably selects a very small set of correct, current, task-specific memories and makes their use transparent.

```text
Bad external memory  = conversation log + broad automatic injection
Good external memory = curated decisions/pitfalls + top-N stable retrieval + explain/delete/update
```

## Non-goals
- Do not replace `AGENTS.md`.
- Do not inject all memories into every conversation.
- Do not store raw conversation logs as memory.
- Do not mix with harness field failure logs.
- Do not make low-confidence LLM inference an always-active project rule.
- Do not optimize for memory volume; optimize for precision and lifecycle quality.

## Design Principle

```text
AGENTS.md            = stable human-reviewed instructions, always-on
External memory      = learned context from prior work, task-specific top-N
Skills               = reusable procedures
Field logs           = harness improvement telemetry
```

External memory is operated by the LLM/extension, but owned by the user.

## Main Risks

### 1. Memory pollution
LLM-inferred memories can be wrong, temporary, or based on failed root-cause guesses. Bad memories are worse than missing memories because the LLM may treat them as durable truth.

Mitigation:
- only explicit user instructions can become active automatically
- inferred/tool-observed/test-derived memories start as candidates
- every injected memory has an id and can be explained/disabled/deleted

### 2. Stale or conflicting memory
Project decisions change. A memory system must update, supersede, disable, and merge memories, not just create them.

Mitigation:
- support `supersedes`, `supersededBy`, `conflictsWith`, `lastVerifiedAt`, `validUntil`, and staleness checks
- retrieval excludes stale/deprecated memories by default
- conflicting active memories trigger a user clarification instead of silent use

### 3. Retrieval noise
Most memories should not be injected. Irrelevant memory increases token use, distracts the model, and reduces quality.

Mitigation:
- inject 0-5 memories, preferably 0-3 for normal turns
- use strict relevance thresholds
- score by request, files, symbols, workflow phase, type/status, importance, and confidence
- maintain retrieval evaluation fixtures

### 4. Prompt-cache churn
If memory blocks change every turn, cache_control/prompt caching will miss because the prompt prefix/content changes.

Mitigation:
- keep a stable base memory policy block separate from dynamic memory
- render selected memory deterministically
- exclude timestamps, scores, last-accessed fields, and other changing values from injected blocks
- use sticky selected memory sets during a workflow/session
- penalize unnecessary changes to the injected memory set

### 5. LLM not actually using injected memory
Putting memory in the prompt does not guarantee the LLM will apply it.

Mitigation:
- classify injected memory by use: `constraint`, `decision`, `preference`, `warning`, `context`
- active constraints/decisions are rendered as "must consider"
- if current code/user instruction conflicts with memory, ask the user or prefer the latest explicit user instruction
- `/memory explain` shows which memories were injected and why

## Storage Layout

Applied projects should store memory under `.project-memory/memory/`:

```text
.project-memory/
  memory/
    entries.jsonl
    candidates.jsonl
    index.json
    injection-state.json
    audit.jsonl
    metrics.jsonl
    feedback.jsonl
    exports/
```

Suggested separation:

```text
entries.jsonl         active/disabled/deprecated/superseded memories
candidates.jsonl      unapproved proposed memories
audit.jsonl           create/update/delete/approve/reject/use events
metrics.jsonl         retrieval/injection/cache/user-action metrics for improvement
feedback.jsonl        explicit user feedback and inferred correction signals
index.json            lightweight generated retrieval index/cache
injection-state.json  sticky selected memory ids/hashes per workflow/session
```

## Schema

Initial schema:

```text
target/.pi/schemas/harness-memory-entry.schema.json
```

Each memory entry should include:

- `memoryId`
- `scope`
- `type`
- `status`
- `confidence`
- `importance`
- `content.summary`
- `content.details`
- `index.topics`
- `index.files`
- `index.symbols`
- `index.appliesToPhases`
- `provenance`
- `governance`
- `privacy`
- lifecycle metadata for staleness/conflicts/supersession

Planned schema additions before implementation:

```json
{
  "lifecycle": {
    "lastVerifiedAt": "date-time",
    "validUntil": "date-time",
    "staleness": "fresh | aging | stale",
    "conflictsWith": ["mem_..."],
    "mergeGroup": "optional stable grouping key"
  },
  "rendering": {
    "useAs": "constraint | decision | preference | warning | context",
    "stableRenderHash": "sha256:..."
  }
}
```

## Extension Files

```text
target/.pi/extensions/memory.ts
target/.pi/extensions/memory/
  core.ts
  schema.ts
  storage.ts
  retrieval.ts
  selector.ts
  writer.ts
  lifecycle.ts
  commands.ts
  prompt.ts
  audit.ts
  metrics.ts
  feedback.ts
  redact.ts
```

### Responsibilities

#### `storage.ts`
- append/read/update JSONL records
- tombstone or status-change deletes
- atomic writes where feasible
- migrate schema versions later

#### `retrieval.ts`
- produce candidate matches using request text, topics, files, symbols, phase, recency, importance, confidence
- exclude disabled/rejected/deprecated/stale memories unless explicitly requested

#### `selector.ts`
- choose the final injected memory set from retrieval candidates
- enforce top-N and token budget
- apply cache-churn penalty
- preserve sticky memory set during active workflow/session unless a higher-confidence match justifies replacement
- generate deterministic prompt render order

#### `writer.ts`
- detect memory-worthy facts/decisions/preferences/pitfalls
- generate candidate entries
- auto-activate only explicit user-instruction memories

#### `lifecycle.ts`
- detect duplicates, conflicts, supersession, stale memories
- propose merge/archive/disable actions
- update lifecycle fields

#### `commands.ts`
- register `/memory` commands

#### `prompt.ts`
- inject stable memory policy and selected dynamic memory
- keep injected context small, deterministic, and transparent

#### `audit.ts`
- append audit events for create/edit/delete/approve/reject/use/inject

#### `metrics.ts`
- append mechanical retrieval/injection/cache metrics
- aggregate precision/churn/staleness indicators for `/memory stats`
- never store raw prompts; store hashes, ids, counts, and coarse matched reasons

#### `feedback.ts`
- record explicit user feedback (`helpful`, `irrelevant`, `wrong`, `missed`, `stale`)
- capture correction signals such as immediate `/memory disable`, `/memory delete`, or user saying a remembered rule is wrong
- convert feedback into retrieval eval fixture candidates when useful

## Retrieval and Selection Strategy

Retrieval produces candidates. Selection decides what actually enters the prompt.

### Retrieval candidate scoring

```text
candidate_score =
  keyword/topic match      25%
+ file/path match          25%
+ phase match              15%
+ type/status priority     15%
+ recency/importance       10%
+ confidence               10%
```

Inputs:

- current user request
- current workflow phase if present
- recently read/edited files if available
- symbols/classes/functions mentioned or edited
- branch/workspace
- recent tool/test failure summaries if available

### Injection selection scoring

```text
injection_score =
  candidate_score
+ sticky_bonus
+ constraint_or_decision_bonus
- cache_churn_penalty
- staleness_penalty
- conflict_penalty
- token_budget_penalty
```

Default limits:

```text
max injected memories: 3 normal, 5 for explicitly memory-heavy tasks
max injected tokens: 800-1200
minimum score for injection: high threshold, e.g. 0.75 or equivalent
candidate-only memories: do not inject as facts; include only if user asks or as low-confidence warnings
```

### Retrieval output shape

```json
{
  "memoryId": "mem_...",
  "score": 0.82,
  "matchedReasons": ["file", "topic", "phase"],
  "useAs": "constraint",
  "renderHash": "sha256:..."
}
```

## Prompt Cache Strategy

### Stable base prompt

This part should be static and cache-friendly:

```text
[External Memory Policy v1]
External memory may be provided in a later block.
Use active constraints/decisions only when relevant.
Do not treat candidate memory as fact.
If memory conflicts with current user instruction or current code, ask or prefer the latest explicit user instruction.
[/External Memory Policy]
```

### Dynamic memory block

This part is small, deterministic, and placed after the stable prefix:

```text
[External Memory Context v1]
- mem_001 | decision | high | constraint | Root after init exposes only .pi/ and AGENTS.md.
- mem_017 | pitfall | medium | warning | Windows path separators previously broke workflow tests; prefer pathlib in tests.
[/External Memory Context]
```

Dynamic block rules:

- sort deterministically: use priority/useAs/type, then `memoryId`
- include only stable content fields
- do not include retrieval score
- do not include timestamps
- do not include last accessed time
- do not include current branch/cwd unless part of the memory itself
- use stable render hashes to detect unchanged blocks

### Sticky selection
During one workflow/session, keep the selected memory set stable unless:

- a new memory has substantially higher relevance
- current files/phase changed significantly
- user explicitly asks about a different topic
- a selected memory becomes disabled/deleted/superseded

## Tracking and Improvement Loop

The extension must be developed as an observed system. Because memory quality can only be judged in real use, MVP must track enough data to improve retrieval and lifecycle rules without storing sensitive raw prompts.

### What to track mechanically

Append one small record to `metrics.jsonl` whenever retrieval/selection/injection runs:

```json
{
  "schemaVersion": 1,
  "timestamp": "date-time",
  "operation": "retrieve | select | inject | search | feedback",
  "requestHash": "sha256-of-normalized-request-or-empty",
  "workflowId": "optional",
  "phase": "optional",
  "candidateCount": 12,
  "selectedMemoryIds": ["mem_001", "mem_017"],
  "selectedRenderHashes": ["sha256:..."],
  "stickySetReused": true,
  "dynamicBlockHash": "sha256:...",
  "cacheChurn": "none | low | high",
  "matchedReasons": {
    "file": 1,
    "topic": 2,
    "phase": 1
  },
  "excludedCounts": {
    "belowThreshold": 7,
    "disabled": 1,
    "stale": 1,
    "cacheChurnPenalty": 1
  }
}
```

Do not store raw user prompts, raw tool output, secrets, or full memory text in metrics.

### User feedback commands

Add commands for explicit quality signals:

```text
/memory feedback <id> helpful
/memory feedback <id> irrelevant
/memory feedback <id> wrong
/memory feedback <id> stale
/memory missed <query-or-description>
```

Feedback effects:

- `helpful`: increases confidence in retrieval tags/reasons, not memory truth itself
- `irrelevant`: lowers retrieval priority for similar contexts
- `wrong`: disables or candidates a correction flow; do not keep injecting silently
- `stale`: marks lifecycle staleness and excludes from injection until reviewed
- `missed`: creates an eval fixture candidate and optionally starts `/memory search`

### Inferred feedback signals

Record low-confidence signals when users act immediately after injection:

```text
/memory disable <id> after injection    -> likely irrelevant/wrong
/memory delete <id> after injection     -> likely wrong/sensitive
/memory edit <id> after injection       -> memory content needed correction
user says "그 기억은 틀렸어"             -> explicit wrong/stale feedback
```

These signals should update feedback logs and may create lifecycle review candidates. They must not automatically rewrite active memory without user confirmation.

### Metrics to review

`/memory stats` should summarize:

```text
- injection count
- average selected memory count
- zero-injection rate
- sticky set reuse rate
- dynamic block hash churn rate
- top disabled/deleted-after-injection memories
- feedback counts by helpful/irrelevant/wrong/stale/missed
- stale/deprecated memory count
- retrieval eval pass/fail summary
```

### Turning tracking into improvements

Use tracking data to improve the extension in small loops:

```text
1. Inspect /memory stats and feedback logs.
2. Add or update retrieval eval fixtures for misses/noise.
3. Tune selector thresholds/cache-churn penalty.
4. Fix lifecycle rules for stale/conflicting memories.
5. Only then add more automation.
```

Success is not "more memories stored". Success is fewer repeated corrections, fewer irrelevant injections, stable prompt blocks, and users rarely needing to re-explain durable project context.

## Memory Writing Policy

### Auto-active allowed
Only when the user is explicit:

```text
"기억해"
"앞으로는"
"항상"
"절대"
"이 프로젝트에서는"
"결정:"
```

Requirements:

- confidence: `explicit`
- status: `active`
- provenance.source: `user-explicit` or `user-correction`

### Candidate only
Use candidate for:

- inferred project conventions
- repeated tool/test failures
- observed pitfalls
- ambiguous preferences
- lessons from a completed task
- LLM-derived root cause analysis
- field-log-derived summaries

### Do not store
Do not store:

- temporary plans
- raw logs
- secrets/tokens
- uncertain guesses
- one-off implementation details with no future value
- current-turn implementation steps unless they become a durable rule/lesson

## User Commands

MVP commands:

```text
/memory list
/memory search <query>
/memory show <id>
/memory remember <text>
/memory candidates
/memory approve <id>
/memory reject <id>
/memory edit <id>
/memory delete <id>
/memory disable <id>
/memory enable <id>
/memory explain
/memory feedback <id> helpful|irrelevant|wrong|stale
/memory missed <query-or-description>
/memory export
```

Lifecycle/quality commands:

```text
/memory conflicts
/memory stale
/memory compact
/memory merge <id> <id>
/memory supersede <old-id> <new-id>
/memory promote <id> agents
/memory promote <id> local
/memory stats
/memory doctor
/memory eval
```

## Command Behavior

### `/memory list`
Show active memories, grouped by type/status. Keep output short.

### `/memory search <query>`
Search all non-rejected memory. Include candidates/deprecated only with flags later.

### `/memory show <id>`
Show full entry plus audit summary, status, provenance, and whether it is injectable.

### `/memory remember <text>`
Create explicit active memory from user text unless privacy checks fail.

### `/memory candidates`
List unapproved candidates.

### `/memory approve <id>`
Move candidate to active after checking duplicates/conflicts.

### `/memory reject <id>`
Mark candidate rejected.

### `/memory edit <id>`
Interactive edit if UI available; otherwise print editable JSON guidance.

### `/memory delete <id>`
Tombstone or remove based on policy. Audit the delete.

### `/memory disable <id>`
Keep entry but prevent auto-injection.

### `/memory enable <id>`
Re-enable injection only after conflict/staleness checks.

### `/memory explain`
Show memories injected into the latest prompt, why they matched, and their stable render hashes.

### `/memory feedback <id> helpful|irrelevant|wrong|stale`
Record explicit user feedback for an injected or searched memory. Feedback affects future retrieval/lifecycle review, but does not silently rewrite memory content.

### `/memory missed <query-or-description>`
Record that the current turn needed memory that was not retrieved. Optionally run search and create a retrieval eval fixture candidate.

### `/memory conflicts`
Show active memories that conflict by topic/file/supersession metadata.

### `/memory stale`
Show memories not verified recently or likely invalidated by changed files/AGENTS.md.

## Integration with Workflow Extension

Keep memory extension separate, but allow loose integration:

- workflow phase can be used as retrieval signal
- workflow/session id can define sticky memory selection scope
- workflow checkpoints can trigger candidate extraction
- field logs can become candidate pitfall memories only after summarization, never raw import

Potential API later:

```ts
getCurrentWorkflowPhase(): string | undefined
getCurrentWorkflowId(): string | undefined
recordMemoryCandidate(input): string
searchMemory(context): MemoryMatch[]
selectPromptMemories(context): SelectedMemory[]
```

## Privacy and Safety

Default policy:

```text
read existing memory: on
retrieve/inject relevant active memory: on
write candidate memory: on
auto-active memory: only explicit user instruction
export memory: explicit command only
delete/disable/edit: user-controlled
```

Redaction:

- absolute paths -> `<PROJECT_ROOT>`
- URLs -> `<URL>` unless explicitly public docs
- secrets -> refuse storage or mark `containsSecrets=true`, `autoInject=never`

## Retrieval Evaluation

External memory needs fixture-style evals, not only unit tests.

Example:

```text
task: "push policy scan 우회 문제 고쳐줘"
current files:
  - target/.pi/extensions/workflow.ts
  - target/.pi/extensions/workflow/gates.ts
must retrieve:
  - push phase only rule
  - policy-scan explicit approval rule
must not retrieve:
  - DPAA ambiguity scoring rule
  - unrelated Python venv setup memory
```

Eval fixture shape:

```json
{
  "task": "...",
  "phase": "push",
  "files": ["..."],
  "mustRetrieve": ["mem_a", "mem_b"],
  "mustNotRetrieve": ["mem_c"]
}
```

## Tests

Add tests:

```text
tests/test_memory_schema.py
tests/test_memory_storage.py
tests/test_memory_retrieval.py
tests/test_memory_selector.py
tests/test_memory_commands.py
tests/test_memory_prompt_injection.py
tests/test_memory_lifecycle.py
tests/test_memory_privacy.py
tests/test_memory_metrics.py
tests/test_memory_feedback.py
tests/test_memory_retrieval_eval.py
```

Test cases:

- schema contains governance/privacy/retrieval/lifecycle metadata
- explicit `/memory remember` creates active memory
- inferred candidate does not become active without approval
- disabled memory is not injected
- rejected/deprecated/stale memory is not searched by default
- file match increases retrieval score
- phase match increases retrieval score
- cache-churn penalty preserves sticky injected memory set
- dynamic prompt render is deterministic for the same selected ids/hashes
- prompt render excludes timestamps/scores/lastAccessedAt
- `/memory explain` reports injected memory ids and matched reasons
- metrics records contain ids/hashes/counts but not raw prompts or memory text
- feedback commands update future retrieval/lifecycle review state
- disabling immediately after injection creates an inferred feedback signal
- export excludes non-exportable or secret memories
- retrieval eval fixtures pass must-retrieve/must-not-retrieve checks

## Phased Implementation

### Phase 1: Safe Foundation
- Add schema test for `harness-memory-entry.schema.json`
- Add lifecycle/rendering schema fields before code implementation
- Add extension skeleton under `target/.pi/extensions/memory.ts`
- Add storage/audit/metrics JSONL helpers
- Add `/memory remember`, `/memory list`, `/memory show`, `/memory delete`, `/memory disable`
- Add `/memory stats` with basic counts, even before automatic injection exists

### Phase 2: Retrieval Without Injection
- Add retrieval scorer
- Add `/memory search`
- Add retrieval eval fixtures
- Tune must-retrieve/must-not-retrieve behavior before prompt injection

### Phase 3: Cache-aware Prompt Selection
- Add selector with top-N/token budget/cache-churn penalty
- Add deterministic memory rendering and stable render hashes
- Add sticky selection state per workflow/session
- Add `before_agent_start` injection for selected active memories
- Add metrics for candidate count, selected ids, render hashes, dynamic block hash, sticky reuse, and exclusions
- Add `/memory explain`

### Phase 4: Feedback Before Automation
- Add `/memory feedback` and `/memory missed`
- Add inferred feedback signals for disable/delete/edit after injection
- Add metrics-to-eval fixture workflow for misses/noisy injections
- Tune retrieval thresholds and cache-churn penalty from real feedback before automatic candidate extraction

### Phase 5: Candidate Workflow
- Add candidate store
- Add `/memory candidates`, `/memory approve`, `/memory reject`
- Add simple candidate extraction hook after workflow checkpoints or explicit command
- Keep all LLM-inferred memory as candidate by default

### Phase 6: Lifecycle Management
- Add edit/enable/export
- Add conflicts/stale/compact/merge/supersede commands
- Add duplicate and conflict detection
- Expand memory doctor/stats with feedback and churn summaries

### Phase 7: AGENTS.md Promotion
- Add `/memory promote <id> agents`
- Generate patch proposal for `AGENTS.md`, not automatic edit unless user confirms

## Acceptance Criteria for MVP

- User can create, list, show, search, delete, and disable memory.
- Only explicit user memory can become active automatically.
- Relevant active memories are automatically injected only when they clear a strict threshold.
- Default injection is 0-3 memories and deterministic.
- Dynamic memory block is cache-aware: stable order, no timestamps/scores, sticky set where possible.
- User can see which memories were injected and why.
- Metrics track retrieval/injection/cache churn without raw prompts or secrets.
- User can mark injected/searched memories helpful, irrelevant, wrong, or stale.
- Missed-memory feedback can become retrieval eval fixture candidates.
- Candidate memories are separate from active memories.
- Disabled/rejected/deprecated/stale memories are not injected.
- Memory data stays under `.project-memory/memory/`.
- Field logs remain separate under `.project-memory/harness/`.
- Retrieval eval tests verify must-retrieve and must-not-retrieve examples.
- Tests pass on Windows/macOS/Linux-compatible paths.
