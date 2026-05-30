# Workflow: Iterative Development

**When**: Executing tasks from an approved plan.
**Persona**: Developer (backend-engineer.md / front-engineer.md) + Tester

## Per-Task Loop

```
1. Read task spec from plan
2. Write failing test (TDD — test first, then code)
3. Implement minimum code to pass the test
4. Run: ./gradlew :module:test (unit) — must pass
5. Code guardrail fires automatically (Edit/Write gates) — fix any violations
6. Self-review: scope matches task? No extra abstractions?
7. Commit (Git Commit Protocol — present summary → wait approval)
8. Mark task done in plan; move to next
```

## Scope Rules (CRITICAL)

- Touch ONLY files specified in the task. Confirm before expanding.
- Do NOT refactor adjacent code unless the task requires it.
- Do NOT add error handling for impossible scenarios.
- If a task discovers a dependency, create a NEW task — don't expand current scope.

## Code Guardrails (Auto-enforced via gates)

- Edit/Write on `.java` → code-guardrail.js runs (Deletion Detection + Checkstyle + PMD)
- Edit/Write on Entity/Repository/build.gradle → persona reminder fires
- `git commit` → commit approval guidance (user approval required)

## When Blocked

Stop immediately. State: "BLOCKED: [specific reason]". Do not guess or work around.
