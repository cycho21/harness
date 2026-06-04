# Requirements Room Protocol

Shared protocol for a role-based requirements meeting. Use this protocol when the user wants a new feature discovery flow that is separate from the normal workflow interview and separate from the older feature-interview / feature-planning-room drafts.

## Purpose

Turn a rough product idea into a requirements package by running a short, structured meeting across job functions.

The room exists before ordinary workflow planning. It does not implement code. It produces the shared facts, decisions, conflicts, and role-specific draft requirements that a later workflow plan can consume.

## Entrypoints

- Pi: invoke the `requirements-room` skill.
- Claude Code: run `/requirements-room <feature name or rough idea>`.

## Difference from Existing Drafts

- `feature-interview` is a deep 1:1 interviewer.
- `feature-planning-room` is an earlier multi-role planning-room draft with survey packets.
- `requirements-room` is a productized meeting facilitator. It keeps rounds short, exposes role conflicts early, and treats a requirements package as the final output.

## Output Language and Source of Truth

- Respond to the user in Korean unless the user asks otherwise.
- Korean artifacts are the human/team source of truth.
- English artifacts are normalized machine-check inputs for ambiguity checks.
- Do not update English artifacts independently from Korean artifacts.

## Artifact Layout

Create or update these files under `.ai/interview/<feature-slug>/requirements-room/`:

```text
session-state.json
session-events.jsonl
00-room-summary.ko.md
00-room-summary.md
01-meeting-minutes.ko.md
01-meeting-minutes.md
02-decision-log.ko.md
02-decision-log.md
03-assumption-log.ko.md
03-assumption-log.md
04-conflict-log.ko.md
04-conflict-log.md
05-open-questions.ko.md
05-open-questions.md
06-role-drafts/
  product.ko.md
  product.md
  design.ko.md
  design.md
  frontend.ko.md
  frontend.md
  backend.ko.md
  backend.md
  qa-integration.ko.md
  qa-integration.md
  operations.ko.md
  operations.md
07-requirements-package.ko.md
07-requirements-package.md
requirements-spec.json
```

## Session State Model

`session-state.json` should be deterministic and GUI-ready:

```json
{
  "schemaVersion": 1,
  "featureSlug": "example-feature",
  "mode": "requirements-room",
  "phase": "setup | role-framing | cross-role-contract | conflict-resolution | final-review | handoff",
  "participants": [
    { "id": "product", "label": "Product / Planning", "present": true, "simulated": false },
    { "id": "design", "label": "Design / UX", "present": true, "simulated": false },
    { "id": "frontend", "label": "Frontend", "present": true, "simulated": false },
    { "id": "backend", "label": "Backend", "present": true, "simulated": false },
    { "id": "qa-integration", "label": "QA / Integration", "present": true, "simulated": false },
    { "id": "operations", "label": "Operations", "present": false, "simulated": true }
  ],
  "currentRound": 1,
  "currentRole": "product",
  "openQuestions": [],
  "decisions": [],
  "assumptions": [],
  "conflicts": [],
  "ambiguities": [],
  "handoffReady": false
}
```

## Event Log Model

Append one JSON object per meaningful event to `session-events.jsonl`:

```json
{"type":"room-started","round":0,"summary":"Requirements room opened for customer export scheduling"}
{"type":"question","round":1,"from":"facilitator","to":"product","id":"P1","summary":"Clarify target user"}
{"type":"answer","round":1,"from":"product","id":"P1","summary":"Operations managers schedule exports"}
{"type":"decision","round":2,"owner":"backend","summary":"Use async job status endpoint"}
{"type":"conflict","round":3,"roles":["frontend","backend"],"summary":"Immediate preview versus background generation"}
```

## Room Board

Every facilitator response should include a compact room board:

```text
Room Board
- Phase: role-framing
- Round: 2
- Current role: frontend
- Open blocker/high ambiguities: 1
- Pending cross-role questions: 2
- Next: FE2 — API response states
```

## Required Rounds

### 0. Setup

Confirm:

- Feature name or rough idea.
- Meeting goal.
- Which roles are present.
- Whether absent roles may be simulated by the facilitator.
- Expected output depth: quick draft, normal package, or implementation-ready package.

### 1. Role Framing

Ask one small question at a time. Cover these roles by default:

- Product / Planning: target users, excluded users, problem, success criteria, MVP boundary, non-goals.
- Design / UX: primary flow, screens, entry/exit points, empty/loading/error/success states, accessibility constraints.
- Frontend: routes, components, state ownership, validation, API needs, cache/loading/error behavior.
- Backend: domain model, endpoints, DTOs, authorization, persistence, transactions, idempotency, audit/logging.
- QA / Integration: acceptance scenarios, contract tests, fixtures, external dependencies, rollout risks.
- Operations: observability, support runbook, migration, rollback, feature flags, monitoring.

### 2. Cross-Role Contract

Create explicit contracts between roles:

- Product ↔ Design: user promise, scope, and UX priority.
- Design ↔ Frontend: screen states, component reuse, responsive/accessibility requirements.
- Frontend ↔ Backend: request/response shape, error mapping, pagination, loading and retry semantics.
- Backend ↔ QA/Integration: test data, contract tests, external systems, failure modes.
- Backend/Operations ↔ Product: rollout, data migration, support, audit, analytics.

### 3. Conflict Resolution

For each conflict:

1. State the conflict neutrally.
2. List affected roles.
3. Explain impact if unresolved.
4. Offer 2-4 concrete options.
5. Ask the user to choose or modify an option.
6. Record the decision or keep it open with severity.

### 4. Final Review

Finalize only when all are true:

- Every role has at least one draft requirement section.
- Every blocker/high ambiguity is resolved, accepted as an explicit assumption, or deferred with owner and impact.
- Each acceptance criterion has observable evidence.
- Cross-role API/UI/state/error contracts are explicit.
- Korean source artifacts and English normalized artifacts are semantically equivalent.

### 5. Handoff

Before handing off, ask:

```text
요구사항 회의 패키지가 준비되었습니다.
이 내용을 일반 workflow plan 단계로 넘길까요?
수정할 부분이 있으면 알려주세요.
```

## Ambiguity Register

Every ambiguity item must include:

```text
ID
Role(s) affected
Type: FACT | DECISION | ASSUMPTION | CONSTRAINT | OPEN_QUESTION | CONFLICT
Severity: blocker | high | medium | low
Question or issue
Options considered
Current answer
Verification impact
Owner
Status: open | resolved | accepted-assumption | deferred
```

Do not finalize while any blocker/high item is still `open`.

## Facilitator Rules

- Ask one question or one small section at a time unless the user requests bulk mode.
- Prefer concrete options when the ambiguity space is known.
- Preserve the user's wording in meeting minutes and decision context.
- Mark simulated role contributions clearly as candidate perspectives, not decisions.
- Do not let implementation begin from room artifacts without a normal workflow plan and approval.
