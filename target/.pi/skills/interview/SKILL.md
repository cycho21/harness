---
name: interview
description: Use for structured pre-implementation interviews before planning non-trivial work. Guides requirement discovery, ambiguity removal, spec/plan creation, iterative review, subagent implementation handoff, and final goal review. Trigger only when the user explicitly asks to plan, design, interview, or work through requirements before implementation. Output language is Korean.
---

# Interview Skill

Use this skill for non-trivial work that needs requirements discovery before implementation. The flow is:

Interview → Spec/Plan → iterative review → subagent implementation → goal review.

## Output Language

Respond to the user in Korean.

Write two artifact sets:

- `.ai/interview/spec.ko.md` and `.ai/interview/plan.ko.md` are the Korean source-of-truth documents for the user/team.
- `.ai/interview/spec.md` and `.ai/interview/plan.md` are English normalized artifacts for DPAA.

Reason: DPAA currently uses English-centered deterministic rules. The Korean `.ko.md` files are the human-approved source of truth; the English `.md` files are machine-check translations. Do not change the English files independently from the Korean source.

## Artifact Versioning

Keep `.ai/interview/spec.ko.md`, `.ai/interview/plan.ko.md`, `.ai/interview/spec.md`, and `.ai/interview/plan.md` as the latest working copies, but preserve meaningful changes with snapshots:

```text
/workflow snapshot <reason>
```

Create a snapshot when any meaningful requirement or plan change occurs, including:

- The user adds, removes, or changes a requirement.
- Acceptance criteria change.
- Scope or out-of-scope boundaries change.
- Technology choices change.
- User review changes the plan.
- Implementation escalation changes requirements or design direction.
- DPAA failure causes spec/plan repair.

Do not create snapshots for typo-only or formatting-only edits.

## Clarification Before Modification

When you find ambiguity, conflicting requirements, DPAA findings, review feedback, or requirement changes:

1. Do not immediately rewrite `.ai/interview/spec.ko.md`, `.ai/interview/plan.ko.md`, `.ai/interview/spec.md`, or `.ai/interview/plan.md`.
2. First explain exactly what is wrong or unclear.
3. Ask targeted clarification questions or present concrete options.
4. Wait for the user's answer.
5. Only after the user answers, update the spec/plan.
6. If the answer changes requirements or the plan meaningfully, create a snapshot with `/workflow snapshot <reason>`.

Never silently resolve ambiguity on behalf of the user.

## Trigger

Use this skill only when the user explicitly asks to plan, design, interview, or work through requirements before implementation. Examples:

- "계획 짜보자", "계획 세워보자", "플랜 짜줘", "설계해보자"
- "인터뷰해줘", "같이 설계하자"

Do not invoke this skill for a direct edit or implementation request unless the user explicitly asks for the interview/planning workflow.

---

## Phase 1: Interview

Goal: run a deep-but-light requirements interview until an implementer could write the spec without making unstated decisions. This phase absorbs the useful parts of a Socratic deep interview while leaving planning, DPAA, implementation, and review to the existing workflow.

Default to focused, one-question follow-ups for complex or vague work. Use grouped questions only for the baseline round or for simple factual confirmations. Do not assume one round is enough; if the answer creates new ambiguity, ask follow-up questions immediately.

### 1.1 First Round — Baseline Understanding

Ask these questions together unless the user's opening request already answers them:

```text
다음 내용을 알려주세요:

1. 무엇을 만들거나 수정하려 하나요? (구체적 범위)
2. 왜 필요한가요? (해결하려는 문제 또는 동기)
3. 완료 기준은 무엇인가요? (테스트 가능한 기준으로)
4. 영향 받는 파일/모듈을 알고 있나요?
5. 제약사항이나 알려진 위험이 있나요?
```

### 1.2 Brownfield Evidence First

For brownfield work, gather narrow repository evidence before asking the user about facts the code can reveal.

Rules:

- Inspect only the smallest relevant files/modules. Do not perform broad repository exploration unless the user explicitly asks.
- Cite concrete evidence in the question: file path, symbol, command, guard, policy, or repeated pattern.
- Ask the user to decide direction, priority, or intent; do not ask them to rediscover codebase facts.
- If evidence is insufficient, say what was checked and ask a targeted question.

Example:

```text
확인한 근거:
- target/.pi/extensions/workflow/gates.ts: DPAA/code-quality gate 판단이 있음
- target/.pi/WORKFLOW.md: interview → plan → plan_review 흐름이 문서화되어 있음

질문:
이번 변경은 interview skill의 질문 프로토콜만 강화하면 충분한가요,
아니면 workflow extension의 phase/gate 동작도 바꿔야 하나요?
```

### 1.3 Round 0 — Topology Confirmation

Before drilling into details, confirm the top-level scope shape. Extract 1-6 top-level components, outcomes, workstreams, surfaces, integrations, or deliverables that can succeed or fail independently. Do not treat low-level implementation tasks as topology components unless the user framed them as independent outcomes.

Ask a topology confirmation question:

```text
먼저 범위의 지형도를 확인하겠습니다.

제가 이해한 상위 컴포넌트는 다음과 같습니다:

1. <컴포넌트 A>: <한 문장 설명>
2. <컴포넌트 B>: <한 문장 설명>
...

추가, 제거, 병합, 분리, 또는 명시적으로 보류할 항목이 있나요?
```

After the answer:

- Treat confirmed active components as required spec coverage.
- Treat deferred components as explicit Out of Scope items with the user's reason when available.
- If only one component exists, still record it so acceptance criteria and plan steps can map to it.

### 1.4 Clarity Dimensions → Weakest-Dimension Follow-up

After each user answer, assess clarity qualitatively across these dimensions:

- Goal: can the objective be stated without qualifiers?
- Scope / Out of Scope: are included, excluded, deferred, and optional parts clear?
- Acceptance Criteria: can success be judged objectively as pass/fail?
- Constraints / Risks: are limits, compatibility, performance, security, rollback, and dependencies clear enough?
- Existing Context: for brownfield work, is the relevant code/system context understood well enough to modify safely?

Report the assessment before follow-up when ambiguity remains:

```text
명확성 점검:
- 목표: 높음|중간|낮음 — <이유>
- 범위/비범위: 높음|중간|낮음 — <이유>
- 완료 기준: 높음|중간|낮음 — <이유>
- 제약/위험: 높음|중간|낮음 — <이유>
- 기존 코드 맥락: 높음|중간|낮음|해당 없음 — <이유>

다음 질문 대상: <가장 약한 차원>
이유: <왜 이 차원이 지금 가장 큰 구현 리스크인지>
```

Then ask one focused question targeting that weakest dimension. Group at most three small factual subquestions only when they are tightly related and needed to unblock the same dimension.

Check for:

- Acceptance criteria that use subjective terms such as "works well", "better", or "faster".
- Missing edge cases: empty values, errors, concurrency, permissions, rollback, compatibility.
- Multiple viable implementation approaches with no selection criteria.
- Uncertain scope language such as "probably", "usually", or "maybe".
- Missing compatibility constraints with existing code or systems.
- Multi-component scope where one detailed component hides under-specified sibling components.

### 1.5 Terminology and Entity Stabilization

If important terms, entities, or workflow concepts are unstable or overlapping, ask a terminology question before writing the spec.

Use when three or more similar concepts appear, or when a term could map to multiple implementation objects.

Example:

```text
현재 핵심 용어를 이렇게 이해했습니다:

- Gate: phase 전환을 막거나 허용하는 기계적 검사
- Reminder: 막지는 않지만 누락을 알려주는 안내
- Approval boundary: 사용자 확인이 필요한 전환 지점

이 정의가 맞나요? 합치거나 이름을 바꿔야 할 용어가 있나요?
```

Carry confirmed terms into the spec's Terminology section.

### 1.6 Challenge Questions for Long or Expanding Interviews

When the interview reaches three or more follow-up rounds, ambiguity stalls, or scope keeps expanding, use one challenge-style question to reduce accidental complexity:

- Contrarian: ask what would be true if the main assumption were wrong.
- Simplifier: ask for the smallest useful version that still satisfies the goal.
- Ontology-style: ask what the core thing fundamentally is when nouns/entities keep shifting.

Examples:

```text
반대 가정 질문:
이 기능을 새 gate로 만들지 않고 기존 DPAA/plan_review만 강화한다면 무엇이 부족할까요?
```

```text
단순화 질문:
최소 버전이 “Topology 확인 + clarity report만 추가”라면 충분할까요?
```

### 1.7 Exit Criteria

Proceed to Phase 2 only when all are true:

1. The confirmed topology is recorded, including active and deferred components.
2. You are confident that a spec can be written without the implementer making additional decisions.
3. Every acceptance criterion can be judged objectively as pass/fail.
4. No clarity dimension remains "낮음" unless the user explicitly accepts the risk.
5. Brownfield direction questions cite repo evidence or state what evidence was unavailable.

If you are not confident, ask another focused round. If the user says "just proceed", explicitly state the remaining ambiguity, affected topology components, and likely rework risk before asking for confirmation. Do not silently choose an interpretation.

---

## Phase 2: Write Spec + Plan

Create these files from the interview context:

1. Write `.ai/interview/spec.ko.md` and `.ai/interview/plan.ko.md` in Korean for the user/team.
2. Translate/normalize them into `.ai/interview/spec.md` and `.ai/interview/plan.md` in English for DPAA.
3. Continue explaining the result to the user in Korean.
4. After the initial Korean+English spec/plan set is written, create a snapshot with `/workflow snapshot initial`.

### `.ai/interview/spec.md` — WHAT

Use the same structure for `.ai/interview/spec.ko.md` in Korean and `.ai/interview/spec.md` in English.

```markdown
# Task Spec: <title>

## Problem
<problem and motivation>

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| <component> | active|deferred | <description> | <covered criteria or deferral reason> |

## Acceptance Criteria
- [ ] <testable criterion 1>
- [ ] <testable criterion 2>

## Constraints
<known constraints, limits, risks>

## Terminology
- <term>: <confirmed meaning>

## Out of Scope
<explicit exclusions, including deferred topology components>
```

### `.ai/interview/plan.md` — HOW

```markdown
# Implementation Plan: <title>

Risk: normal
Work type: feature
Ambiguity gate: standard

## Approach
<high-level strategy and key design decisions>

## Steps
1. <step> — `path/file`
   - Component: <topology component>
   - Acceptance Criteria: <AC id/list>
2. ...

## Test Strategy
<how each acceptance criterion will be verified>

## Escalation Points
<decisions that may still require user/main-session input>

## Risks
<technical risks and mitigations>
```

---

## Phase 3: Iterative Spec/Plan Review

### 3.1 Self-Review Before Showing the User

Check the plan in this order:

- [ ] Every active topology component has acceptance-criteria coverage or a clear implementation step.
- [ ] Every deferred topology component appears in Out of Scope with a deferral note.
- [ ] Every acceptance criterion is testable and unambiguous.
- [ ] Every plan step maps to at least one acceptance criterion and one topology component.
- [ ] There are no hidden assumptions.
- [ ] Confirmed terminology is recorded when terms could otherwise conflict.
- [ ] Out of Scope is explicit.
- [ ] External dependencies, if any, are listed as risks.

If any item fails, update the files before presenting them to the user. Also verify that the `.ko.md` files contain the Korean source of truth and the `.md` files contain faithful English DPAA translations.

### 3.2 User Review

Summarize the spec and plan, then ask:

```text
위 내용으로 진행할까요?
수정이 필요한 부분이 있으면 알려주세요.
```

If the user requests changes:

1. Restate the requested change and confirm the interpretation if any ambiguity remains.
2. Update the spec/plan only after the user's intent is clear.
3. If the change is meaningful, create a snapshot with `/workflow snapshot <reason>`.
4. Run self-review again.
5. Present the updated version.

Proceed to Phase 4 only after explicit approval such as "진행해", "좋아", "맞아", or "OK".

---

## Phase 4: Subagent Implementation

### 4.1 Delegate to Subagent Workflow

Invoke:

```text
Skill("subagent-driven-development")
```

The subagent prompt must include:

- Full `.ai/interview/spec.md` content or a path plus an instruction to read it.
- Full `.ai/interview/plan.md` content or a path plus an instruction to read it.
- The escalation protocol below.

### 4.2 Escalation Protocol

If a subagent encounters a decision it cannot make, it must output:

```text
ESCALATION: <question>
Context: <why blocked, available options>
```

When the main agent sees this:

- Do not read implementation files.
- Answer only from the interview/spec/plan context.
- Resume the subagent with the answer as additional context.
- Do not explore implementation details directly in the main session.

When the subagent reports `IMPLEMENTATION_COMPLETE: <summary>`, proceed to Phase 5.

---

## Phase 5: Goal Review Loop

### 5.1 LLM Goal Review

Using only the subagent completion report, review every acceptance criterion from `.ai/interview/spec.md`:

```text
완료 기준 검토:
- [ ] <기준 1>: ✅ 충족 / ⚠️ 부분 충족 / ❌ 미충족
  근거: <서브에이전트 보고 중 해당 내용>
- [ ] <기준 2>: ...
```

### 5.2 Branching

If all criteria are ✅:

```text
✅ 모든 완료 기준 충족
→ 사용자 확인 후 code_review 단계로 진행 가능
```

If any criterion is ⚠️ or ❌:

1. Send only the unmet criteria back to the subagent.
2. Resume Phase 4.1.
3. Run the goal review again after the next completion report.

### 5.3 Final User Confirmation

Even if all criteria are ✅, ask:

```text
모든 완료 기준이 충족되었습니다.
code_review 단계로 진행할까요?
```

If the user asks to stop early, accept immediately.

---

## Absolute Rules

- The main agent must not directly read or edit implementation files during the subagent implementation/review loop.
- Escalation answers must come from interview/spec/plan context only.
- Do not change phase order.
- Do not proceed to Phase 4 without explicit user approval.
