# Workflow: Quality Gate

**When**: Before git push, after all tasks complete and tests pass.
**Persona**: Reviewer (security-expert.md + performance-analyst.md)

## Checklist

### Code Quality (Auto-enforced)
- [ ] All Edit/Write gates passed (code-guardrail.js — Checkstyle + PMD)
- [ ] Unit tests pass: `./gradlew :module:test`
- [ ] No new Checkstyle violations introduced (api-service: enforced, others: advisory)

### Security Review
- [ ] No secrets, tokens, or credentials hardcoded
- [ ] Input validation at all external boundaries (controllers)
- [ ] Authentication/authorization not bypassed
- [ ] SQL injection not possible (JPA/QueryDSL — parameterized)
- [ ] Sensitive data not logged

### Performance Review
- [ ] No N+1 queries introduced (check repository calls in loops)
- [ ] No blocking calls in async contexts
- [ ] Large result sets paginated or limited

### Architecture Review
- [ ] Business logic in Service layer (not Controller, not Repository)
- [ ] No direct infrastructure calls from domain entities
- [ ] Module boundaries respected (common ← api-service / consumer-service, no reverse)

## Verdict

- **Approve**: All checklist items satisfied. Proceed to push.
- **Request Changes**: List specific findings. Developer fixes; re-review.
- **Escalate**: Uncertain about security/performance impact → human review required.

## On Approval

Run `/push-with-review` skill (per AGENTS.md Push Protocol).
