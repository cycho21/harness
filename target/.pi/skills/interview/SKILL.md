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

Goal: keep asking grouped clarification questions until an implementer could write the spec without making unstated decisions. Do not assume one round is enough; if the answer creates new ambiguity, ask follow-up questions immediately.

### 1.1 First Round — Baseline Understanding

Ask these questions together:

```text
다음 내용을 알려주세요:

1. 무엇을 만들거나 수정하려 하나요? (구체적 범위)
2. 왜 필요한가요? (해결하려는 문제 또는 동기)
3. 완료 기준은 무엇인가요? (테스트 가능한 기준으로)
4. 영향 받는 파일/모듈을 알고 있나요?
5. 제약사항이나 알려진 위험이 있나요?
```

### 1.2 Ambiguity Detection → Follow-up Questions

After each user answer, list every point where implementation would require judgment. Check for:

- Acceptance criteria that use subjective terms such as "works well", "better", or "faster".
- Missing edge cases: empty values, errors, concurrency, permissions, rollback, compatibility.
- Multiple viable implementation approaches with no selection criteria.
- Uncertain scope language such as "probably", "usually", or "maybe".
- Missing compatibility constraints with existing code or systems.

If any ambiguity remains, ask grouped follow-up questions immediately:

```text
몇 가지 더 명확히 해야 할 부분이 있어요:

1. <구체적 질문>
2. <구체적 질문>
...
```

### 1.3 Exit Criteria

Proceed to Phase 2 only when both are true:

1. You are confident that a spec can be written without the implementer making additional decisions.
2. Every acceptance criterion can be judged objectively as pass/fail.

If you are not confident, ask another round. If the user says "just proceed", explicitly state the remaining ambiguity and ask for confirmation before moving on. Do not silently choose an interpretation.

---

## Phase 2: Write Spec + Plan

Create these files from the interview context:

1. Write `.ai/interview/spec.ko.md` and `.ai/interview/plan.ko.md` in Korean for the user/team.
2. Translate/normalize them into `.ai/interview/spec.md` and `.ai/interview/plan.md` in English for DPAA.
3. Continue explaining the result to the user in Korean.
4. After the initial Korean+English spec/plan set is written, create a snapshot with `/workflow snapshot initial`.

### `.ai/interview/spec.md` — WHAT

```markdown
# Task Spec: <title>

## Problem
<problem and motivation>

## Acceptance Criteria
- [ ] <testable criterion 1>
- [ ] <testable criterion 2>

## Constraints
<known constraints, limits, risks>

## Out of Scope
<explicit exclusions>
```

### `.ai/interview/plan.md` — HOW

```markdown
# Implementation Plan: <title>

## Approach
<high-level strategy and key design decisions>

## Steps
1. <step> — `path/file`
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

- [ ] Every acceptance criterion is testable and unambiguous.
- [ ] Every plan step maps to at least one acceptance criterion.
- [ ] There are no hidden assumptions.
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
