# Agent Governance

Use this file for delegation and role selection. Mechanical workflow gates live in `.pi/extensions/workflow.ts`.

## Roles

| Role | Responsibility | Persona |
|------|----------------|---------|
| Architect | System design, API contracts, DB/schema decisions | `.pi/personas/architect/AGENTS.md` |
| Developer | Implementation, tests, local verification | `.pi/personas/developer/AGENTS.md` |
| Tester | Test strategy and regression checks | `.pi/personas/developer/AGENTS.md` |
| Reviewer | Security, performance, architecture, quality review | `.pi/personas/reviewer/AGENTS.md` |

Default order: Architect → Developer/Tester → Reviewer.

## Human Approval

Before delegating to subagents or starting multi-agent work:

1. State the plan: agents, models, scope, expected outputs.
2. Wait for explicit user approval.
3. Start only after approval.

If a skill has its own interactive approval protocol, follow that protocol. Do not treat LLM assumptions as user approval.

## Persona Loading

Load persona docs only when relevant:

- Architecture/API/schema/security-sensitive design → architect persona.
- Java/Spring implementation or test strategy → developer persona.
- Review/security/performance/architecture validation → reviewer persona.

Keep persona loading targeted; do not read the whole persona tree unless needed.

## Model Selection

- Use stronger reasoning for architecture, ambiguity, or cross-cutting decisions.
- Use standard reasoning for focused implementation/review.
- Escalate only when uncertainty or impact justifies it.
