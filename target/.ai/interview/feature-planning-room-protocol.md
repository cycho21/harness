# Feature Planning Room Protocol

Shared CLI-first protocol for a multi-role feature planning room. The same protocol is intentionally file- and event-oriented so a future GUI chat can reuse the artifacts without changing the planning semantics.

## Purpose

Run a structured planning-room session where product, design, frontend, backend, and integration concerns are discussed together before ordinary implementation planning.

The default CLI interaction style is survey-like: each round presents a structured questionnaire with IDs, answer types, choices, and optional free-text fields so participants can answer in batches.

The protocol is designed for:

- CLI or slash-command sessions today.
- GUI chat or TUI sessions later.
- Human participants in one meeting room.
- A single user proxying multiple roles.
- An LLM facilitator simulating missing role perspectives when explicitly allowed.

## Entrypoints

- Pi: invoke the `feature-planning-room` skill.
- Claude Code: run `/feature-planning-room <feature name or rough idea>`.

## Relationship to Feature Interview

`feature-interview` is a deep 1:1 interview.

`feature-planning-room` is a multi-role meeting format. It uses the same DPAA/SBADR ambiguity discipline, but adds:

- participant roster
- survey-style CLI questionnaires
- round-based facilitation
- cross-role questions
- decision log
- conflict log
- meeting transcript/events
- GUI-ready session state

## Output Language and Source of Truth

- Respond to the user in Korean unless the user asks otherwise.
- Korean artifacts are the human/team source of truth.
- English artifacts are normalized machine-check inputs for DPAA and SBADR.
- Do not update English artifacts independently from Korean artifacts.

## Artifact Layout

Create or update these files under `.ai/interview/<feature-slug>/room/`:

```text
session-state.json
session-events.jsonl
meeting-minutes.ko.md
meeting-minutes.md
decision-log.ko.md
decision-log.md
cross-role-questions.ko.md
cross-role-questions.md
conflict-log.ko.md
conflict-log.md
ambiguity-register.ko.md
ambiguity-register.md
plans/
  00-summary.ko.md
  00-summary.md
  01-product-plan.ko.md
  01-product-plan.md
  02-design-plan.ko.md
  02-design-plan.md
  03-frontend-plan.ko.md
  03-frontend-plan.md
  04-backend-plan.ko.md
  04-backend-plan.md
  05-integration-plan.ko.md
  05-integration-plan.md
feature-spec.json
```

## GUI-Ready State Model

`session-state.json` should be easy for a future GUI to render. Use this conceptual shape:

```json
{
  "schemaVersion": 1,
  "featureSlug": "example-feature",
  "mode": "cli-first-room",
  "phase": "roster | discovery | role-rounds | conflict-resolution | finalization | handoff",
  "participants": [
    { "id": "product", "label": "Product/Planner", "present": true },
    { "id": "design", "label": "Designer", "present": true },
    { "id": "frontend", "label": "Frontend Developer", "present": true },
    { "id": "backend", "label": "Backend Developer", "present": true },
    { "id": "integration", "label": "Integration/Tech Lead", "present": false }
  ],
  "openQuestions": [],
  "decisions": [],
  "conflicts": [],
  "ambiguities": [],
  "nextSpeaker": "product",
  "round": 1
}
```

Keep the JSON deterministic and append-only where practical so a GUI can refresh without parsing free text.

## Event Log Model

Append one JSON object per meaningful meeting event to `session-events.jsonl`:

```json
{"type":"question","round":2,"from":"facilitator","to":"design","summary":"Clarify empty and error states"}
{"type":"answer","round":2,"from":"design","summary":"Empty state uses onboarding CTA"}
{"type":"decision","round":3,"owner":"backend","summary":"Use cursor pagination for the first release"}
{"type":"conflict","round":4,"roles":["frontend","backend"],"summary":"Realtime updates versus polling"}
```

This event log is the future GUI chat transcript source.

## Participant Roster

Start by identifying who is present:

```text
참석자를 확인하겠습니다.
1. 기획/PM 역할 답변자는 누구인가요?
2. 디자이너 역할 답변자는 누구인가요?
3. 프론트엔드 역할 답변자는 누구인가요?
4. 백엔드 역할 답변자는 누구인가요?
5. 빠진 역할은 제가 관점만 시뮬레이션해도 될까요, 아니면 질문을 보류할까요?
```

If only one user is present, ask whether they want to answer as all roles or let the facilitator provide candidate options for each role.

## Survey-Style CLI Interaction

Use survey packets as the default CLI format. A survey packet is a grouped questionnaire for one round or one role. It should let the user answer many items in one response.

### Survey Packet Format

Use stable question IDs so answers can be referenced later:

```text
[Survey Packet: Round <n> — <role/topic>]
응답 방법: 각 문항 ID 옆에 답을 적어주세요. 선택지는 번호/문자로 답해도 됩니다.

P1. <question>  (single choice)
1) <option>
2) <option>
3) 기타: <직접 입력>
답변:

P2. <question>  (multiple choice)
[ ] A. <option>
[ ] B. <option>
[ ] C. 기타: <직접 입력>
답변:

P3. <question>  (short text)
답변:

P4. <question>  (scale)
1 낮음 · 2 · 3 · 4 · 5 높음
답변:
```

### Answer Types

Prefer these answer types:

- `single choice`: one option only.
- `multiple choice`: multiple options allowed.
- `short text`: one or two sentences.
- `long text`: a paragraph-length subjective answer.
- `list`: multiple free-text bullets in one answer.
- `table`: structured rows such as API fields or screen states.
- `scale`: risk, priority, confidence, or urgency score.
- `yes/no/unknown`: force uncertainty to be explicit.

### Survey Response Parsing

After each user response:

1. Parse answers by question ID.
2. Accept batched subjective answers. Users may answer multiple `short text`, `long text`, `list`, or `table` questions in one message.
3. Preserve the user's wording for subjective answers in meeting minutes and decision context.
4. Mark unanswered required questions as open.
5. Convert unclear answers into ambiguity-register entries.
6. Summarize decisions made by the survey.
7. Ask only follow-up survey questions for missing, conflicting, or high-risk answers.

Valid batched subjective answer styles include:

```text
P3=운영자가 반복 입력 없이 상태를 빠르게 확인하는 것
P4=- 실시간 알림 제외
   - 모바일 최적화 제외
   - 관리자 권한 세분화 제외
P5=운영자가 3분 안에 대상 상태를 확인하고 CSV 없이 처리 완료 가능
```

or:

```text
P3:
운영자가 반복 입력 없이 상태를 빠르게 확인하는 것

P4:
- 실시간 알림 제외
- 모바일 최적화 제외
- 관리자 권한 세분화 제외

P5:
운영자가 3분 안에 대상 상태를 확인하고 CSV 없이 처리 완료 가능
```

### Required and Optional Questions

Every packet must distinguish required and optional questions:

```text
필수: P1, P2, P3
선택: P4, P5
```

Do not block finalization on unanswered optional questions unless the answer becomes necessary for DPAA/SBADR clarity.

### Survey Batch Size

Keep each packet answerable in one CLI response:

- Normal packet: 5–10 questions.
- Heavy technical packet: up to 12 questions if most are choice/table questions.
- If more questions are needed, split into another packet.

### Follow-up Style

Follow-up questions should also be survey-like:

```text
[Follow-up Survey: unresolved backend blockers]
B7. 인증 실패 응답은 어떤 형식이어야 하나요? (single choice)
1) 기존 공통 에러 포맷 사용
2) 이 기능 전용 에러 코드 추가
3) 아직 모름 — backend가 제안
답변:
```

## Round Structure

### Round 0 — Setup

- Feature name and short description.
- Participant roster.
- Meeting objective.
- Non-goals and time/rigor preference.
- Whether missing roles may be simulated by the facilitator.

### Round 1 — Product Frame

Owner: product/planner.

Clarify:

- Target users and excluded users.
- User job and success outcome.
- MVP scope and later scope.
- Business rules.
- Objective acceptance criteria.
- Analytics, rollout, operations, and support expectations.

### Round 2 — Design / UX Frame

Owner: designer.

Clarify:

- Primary and alternate flows.
- Screen inventory.
- Entry and exit points.
- Empty, loading, error, disabled, success, and permission-denied states.
- Accessibility, localization, tone, and design-system constraints.

### Round 3 — Frontend Frame

Owner: frontend developer.

Clarify:

- Routes, pages, components, forms, and client validation.
- State ownership, cache behavior, optimistic update policy, and retry behavior.
- API needs and error mapping.
- Browser/device support and frontend test strategy.

### Round 4 — Backend Frame

Owner: backend developer.

Clarify:

- Domain model, DTOs, APIs, request/response schemas, and validation.
- Authorization, transactions, persistence, migrations, idempotency, concurrency, and audit logs.
- Error codes, rate limits, observability, rollback, and backend test strategy.

### Round 5 — Cross-Role Contract

Owner: facilitator/integration.

Clarify:

- API-field-to-UI-state mapping.
- Permission and error mapping across UI/API.
- Dependency order.
- Contract tests or shared fixtures.
- End-to-end acceptance scenarios.

### Round 6 — Conflict Resolution

Resolve conflicts explicitly. Each conflict entry must include:

```text
ID
Roles involved
Conflict statement
Options
Trade-offs
Decision owner
Decision
Verification impact
Status
```

### Round 7 — Finalization

Generate or update all artifacts. Ask the user to review the final decisions and open assumptions.

## Cross-Role Question Rules

The facilitator must actively ask role-to-role questions, for example:

- Product to Design: “Which user states must be visible in the MVP?”
- Design to Frontend: “Which states require distinct components?”
- Frontend to Backend: “Which errors must have stable machine-readable codes?”
- Backend to Product: “Which business rule decides authorization?”
- Integration to all: “Which acceptance scenario proves the whole feature works?”

Do not treat role plans as independent documents. Every role plan must be checked against the integration plan.

## Ambiguity Discipline

Maintain the ambiguity register throughout the room session. Every item must include:

```text
ID
Role(s) affected
Type: FACT | DECISION | ASSUMPTION | HYPOTHESIS | CONSTRAINT | OPEN_QUESTION | CONFLICT
Severity: blocker | high | medium | low
Question or issue
Options considered
Decision / answer
Verification impact
Status: open | resolved | accepted-assumption | deferred
```

Do not finalize while any `blocker` or `high` ambiguity remains `open`.

## DPAA Lens

Before finalization, inspect artifacts for:

- Structural completeness.
- Referential clarity.
- Temporal order.
- Execution clarity.
- Verification clarity.
- Explicit out-of-scope boundaries.
- Owner role for every plan step.

## SBADR Lens

Before finalization, rewrite English artifacts into SBADR-friendly text:

- Short sentences.
- Explicit modifier targets.
- Clear `and/or` grouping.
- Minimal noun phrase stacking.
- No vague conditional phrasing.

## CLI UX Rules

For CLI/slash-command operation:

1. Show the current round and intended respondent.
2. Ask grouped survey packets by role instead of free-form interview questions.
3. Use stable question IDs and answer types.
4. Allow the user to answer with compact forms such as `P1=2, P2=A/C, P3=...`, and allow multiple subjective answers in one message using `ID=value` or `ID:` blocks.
5. After each answer, summarize newly resolved decisions and newly opened questions.
6. Keep a compact room board in the response:

```text
Room Board
- Round: <n>
- Current role: <role>
- Open blocker/high ambiguities: <count>
- Open conflicts: <count>
- Decisions since last turn: <count>
- Next respondent: <role>
```

7. Do not dump full artifacts in every turn. Provide paths and concise summaries.

## GUI Expansion Notes

A GUI chat should be able to render the same session from:

- `session-state.json` for current board state.
- `session-events.jsonl` for chat/timeline and survey-response events.
- `decision-log.*` for confirmed decisions.
- `cross-role-questions.*` for per-role queues.
- `conflict-log.*` for unresolved trade-offs.
- `plans/*` for preview/export.

Do not encode important state only in prose. If future tooling needs it, mirror it in JSON or JSONL.

## Final User Prompt

Before handing off to the normal workflow plan phase, ask:

```text
회의실형 기능 기획 산출물이 준비되었습니다.
이 산출물을 기준으로 일반 workflow plan 단계로 넘길까요?
수정할 부분이 있으면 알려주세요.
```
