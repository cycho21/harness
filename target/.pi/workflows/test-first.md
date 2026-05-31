# Workflow: Test-First (TDD)

**When**: During iterative-dev, before implementing any logic.
**Persona**: Tester (developer/tester.md)

## Rule: Test Before Code

No implementation code without a failing test first. No exceptions.

## Steps

```
1. Write test for the acceptance criterion
2. Run test → must FAIL (proves test is testing something real)
3. Write minimum code to make it pass
4. Run test → must PASS
5. Refactor if needed (tests still pass)
6. Repeat for next criterion
```

## Test Types

| Scope | Tool | When |
|-------|------|------|
| Unit | JUnit 5 + Mockito | Every service method, domain logic |
| Integration | @IntegrationTest + H2/Testcontainers | Repository queries, Spring context |
| Controller | MockMvc / WebMvcTest | All endpoint inputs/outputs |
| Architecture | ArchUnit | Module boundary enforcement |

## Tags

- Unit tests: no tag (default)
- Integration tests: `@Tag("integration")` — excluded from `./gradlew test`, run with `integrationTest` task

## Anti-Patterns (Do NOT)

- Writing test after implementation to "cover" already-written code
- Mocking the DB in integration tests (use H2 or Testcontainers)
- `verify()` on repository mocks when Query/Command abstraction exists — use the abstraction
- Testing implementation details instead of behavior
- `@Disabled` without a linked issue

## Minimum Coverage Targets

- Service layer: 80%+ branch coverage
- Controller layer: all happy paths + key error paths
- Domain logic: 100% branch coverage
