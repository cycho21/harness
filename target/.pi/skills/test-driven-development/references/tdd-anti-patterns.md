# TDD Anti-Patterns and Red Flags

## Test Anti-Patterns to Avoid

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Testing implementation details | Tests break on refactoring | Test inputs/outputs, not internals |
| Flaky tests (timing, order-dependent) | Erode trust | Use @DirtiesContext sparingly, isolate state |
| Testing framework code | Wastes time | Only test YOUR code |
| Snapshot abuse | Large snapshots nobody reviews | Use sparingly, review every change |
| No test isolation | Tests pass alone, fail together | Each test sets up and tears down state |
| Mocking everything | Tests pass, production breaks | Mock only at boundaries |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll write tests after the code works" | You won't. Tests written after test implementation, not behavior. |
| "This is too simple to test" | Simple code gets complicated. Tests document expected behavior. |
| "Tests slow me down" | Tests slow you down now, speed you up on every future change. |
| "I tested it manually" | Manual testing doesn't persist. |
| "The code is self-explanatory" | Tests ARE the specification. |
| "It's just a prototype" | Prototypes become production code. |

## Red Flags

- Writing code without any corresponding tests
- Tests that pass on the first run
- "All tests pass" but no tests were actually run
- Bug fixes without reproduction tests
- Test names that don't describe behavior
- Skipping tests to make the suite pass
