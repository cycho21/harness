# Feature Interview Protocol

Shared protocol for Pi skills and Claude Code slash commands. Use this protocol when the user wants a separate, highly detailed feature interview before ordinary workflow planning.

## Purpose

Turn a fuzzy feature idea into role-specific, implementation-ready planning artifacts without letting any implementer make hidden decisions.

The process is intentionally strict. It should feel almost excessively detailed when the feature is non-trivial.

## Supported Entrypoints

- Pi: invoke the `feature-interview` skill.
- Claude Code: run `/feature-interview <feature name or rough idea>`.

## Output Language and Source of Truth

- Respond to the user in Korean unless the user asks otherwise.
- Korean artifacts are the human/team source of truth.
- English artifacts are normalized machine-check inputs for DPAA and SBADR.
- Do not update English artifacts independently from the Korean source.

## Artifact Layout

Create or update these files under `.ai/interview/<feature-slug>/`:

```text
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
06-ambiguity-register.ko.md
06-ambiguity-register.md
feature-spec.json
```

`05-integration-plan.*` is mandatory because role-specific plans often conflict at API, state, permissions, error handling, delivery sequencing, and validation boundaries.

## Interview Principles

1. Ask grouped, targeted questions. Do not ask a single broad question such as “anything else?”.
2. After every user answer, extract decisions, assumptions, contradictions, missing fields, and role-specific blockers.
3. Continue interviewing until every role plan can be executed without unstated choices.
4. Never silently choose a product, UX, frontend, backend, API, data, testing, or rollout interpretation.
5. If the user says “just proceed”, list the remaining assumptions and ask for explicit confirmation before treating them as accepted assumptions.
6. Prefer concrete options over open-ended questions when the ambiguity space is known.
7. Keep out-of-scope decisions explicit.

## Ambiguity Model

Maintain an ambiguity register throughout the interview. Every item must have:

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

Before finalizing, inspect the Korean source and English normalized artifacts with the same intent as DPAA:

- Structural completeness: problem, scope, out-of-scope, roles, steps, dependencies, risks.
- Referential clarity: every actor, screen, API, state, entity, permission, and file/module reference is unambiguous.
- Temporal order: setup, migration, API, UI, integration, rollout, and verification sequence is explicit.
- Execution clarity: each plan step has an owner role and concrete action.
- Verification clarity: every acceptance criterion has pass/fail evidence.

## SBADR Lens

Before finalizing English artifacts, inspect sentences for syntactic ambiguity that SBADR is designed to catch:

- PP attachment ambiguity: unclear modifiers such as “with”, “for”, “in”, “on”.
- Coordination ambiguity: unclear `and/or` grouping.
- Analytical ambiguity: vague causal or conditional sentences.
- Noun phrase stacking: dense phrases with unclear ownership or scope.

Rewrite English artifacts into short, explicit sentences. Prefer bullets over nested clauses.

## Required Interview Coverage

### 1. Product / Planning

Clarify at least:

- Target user and excluded users.
- User job, pain point, and success outcome.
- MVP scope versus later scope.
- Acceptance criteria with objective pass/fail evidence.
- Business rules, permissions, policy constraints, and compliance needs.
- Rollout, migration, support, analytics, and operational expectations.

### 2. Design / UX

Clarify at least:

- Primary user flow and alternate flows.
- Screen inventory and entry/exit points.
- Empty, loading, error, disabled, success, and permission-denied states.
- Responsive behavior, accessibility expectations, localization, and content tone.
- Design system constraints, component reuse, visual hierarchy, and anti-patterns.

### 3. Frontend

Clarify at least:

- Routes, pages, components, forms, validation, state ownership, and cache behavior.
- API contract needs, optimistic updates, retries, error mapping, and loading strategy.
- Browser/device support, performance expectations, accessibility checks, and test strategy.
- Integration points with existing UI architecture.

### 4. Backend

Clarify at least:

- Domain entities, DTOs, API endpoints, request/response schemas, and validation rules.
- Authorization, transactions, persistence, migrations, idempotency, concurrency, and audit logging.
- Error codes, rate limits, external integrations, observability, and rollback strategy.
- Unit/integration/API test strategy.

### 5. Integration

Clarify at least:

- API-field-to-UI-state mapping.
- Cross-role dependency order.
- Contract tests or shared fixtures.
- End-to-end acceptance scenario.
- Release sequencing and fallback behavior.

## Finalization Checklist

Finalize only when all are true:

- Every role has a complete plan document.
- Every plan has objective acceptance criteria and verification steps.
- The ambiguity register has no open blocker/high items.
- Any accepted assumptions are explicitly marked and user-confirmed.
- Korean artifacts and English artifacts are semantically equivalent.
- English artifacts are DPAA/SBADR-friendly: short, explicit, low-ambiguity sentences.

## Final User Prompt

Before handing off to the normal workflow plan or implementation path, ask:

```text
역할별 PLAN과 모호성 정리가 완료되었습니다.
이 산출물을 기준으로 일반 workflow plan 단계로 넘길까요?
수정할 부분이 있으면 알려주세요.
```
