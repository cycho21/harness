# Agent Governance

## Roles & Hierarchy

| Icon | Role | Responsibility | Details |
|------|------|---------------|--------|
| 🏛️ | Architect | System design, API contracts, DB schema, blueprint | [→](./personas/architect/AGENTS.md) |
| 💻 | Developer | Backend/Frontend coding, implementation | [→](./personas/developer/AGENTS.md) |
| 🧪 | Tester | TDD, unit tests, regression (managed by Developer team) | [→](./personas/developer/AGENTS.md) |
| 🔍 | Reviewer | Security audit, performance, quality gate | [→](./personas/reviewer/AGENTS.md) |

**Chain of command**: Architect → Developer → Tester → Reviewer. No code is merged without Reviewer "Approve."

---

## Human-in-the-Loop Approval Protocol

Before delegating to any sub-agent:
1. Present the plan (which agents, which models)
2. **Wait for explicit user approval** ("Yes", "Proceed", "Go")
3. Only then begin execution

**Exception:** Skills that include their own approval gate (e.g., `subagent-driven-development`, `push-with-review`) are exempt when the user explicitly invokes them — the skill invocation itself counts as approval.

---

## Model Selection

- **Architect**: High-capability reasoning (complex design, ambiguity, cross-cutting impact)
- **Developer / Reviewer**: Standard reasoning; escalate only if architecturally sensitive
- **Tester**: Lightweight verification (unit tests, regression, syntax checks)

---

## Pre-Work Checklist

Role-specific documents contain constraints and patterns that prevent common mistakes. Reading them upfront costs less than fixing a misaligned implementation later.

Before starting non-trivial tasks (2+ files, architectural decisions, new features), use the Read tool to load role-specific guidelines:

**Architecture/System design work:**
1. Read `.pi/personas/architect/AGENTS.md`
2. Read specialist docs as needed:
   - `system-designer.md` (for system architecture decisions)
   - `tech-stack-specialist.md` (for technology selection)

**Backend/Frontend implementation:**
1. Read `.pi/personas/developer/AGENTS.md`
2. Read specialist docs as needed:
   - `backend-engineer.md` (for Java/Spring Boot work)
   - `front-engineer.md` (for frontend work)
   - `tester.md` (for TDD/test strategy)

**Code review/quality verification:**
1. Read `.pi/personas/reviewer/AGENTS.md`
2. Read specialist docs as needed:
   - `security-expert.md` (for security review)
   - `performance-analyst.md` (for performance review)
   - `architecture-expert.md` (for architecture review)
   - `testing-expert.md` (for TDD/test strategy review)

**Example:**
```
User: "Design a new REST API for task management"
You:
1. Read `.pi/personas/architect/AGENTS.md`
2. Read `.pi/personas/architect/system-designer.md`
3. Follow the loaded instructions for API design
```
