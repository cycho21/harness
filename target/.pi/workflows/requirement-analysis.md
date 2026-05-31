# Workflow: Requirement Analysis

**When**: User brings a new feature request or bug report before any coding starts.
**Persona**: Architect (system-designer.md for APIs/schema, tech-stack-specialist.md for library decisions)

## Steps

1. **Restate the problem** in your own words. Ask if the interpretation is correct.
2. **Identify stakeholders**: which external systems, APIs, teams are affected?
3. **Surface constraints**: DB migrations required? API contract changes? Performance targets?
4. **List acceptance criteria** — what does "done" look like, testably?
5. **Identify unknowns** — flag anything that blocks design decisions.
6. **Hand off to task-planning** once criteria are agreed.

## Output

A short requirement summary (not a plan):
```
Problem: ...
Acceptance criteria:
  - [ ] ...
Constraints: ...
Unknowns (need resolution): ...
```

## Do NOT

- Start designing before restating and confirming the problem.
- Skip stakeholder/constraint identification.
- Begin task-planning without confirmed acceptance criteria.
