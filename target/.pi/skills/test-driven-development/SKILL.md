---
name: test-driven-development
description: Drives development with tests (Java/Spring Boot). ALWAYS use this skill when implementing logic, fixing bugs, changing behavior, adding methods, or writing Java classes. Never write production code without a failing test first. Use when implementing features, fixing bugs, or changing behavior — skip for pure configuration, documentation, or boilerplate changes. Write JUnit5 tests first, then make them pass.
---

# Test-Driven Development (DevCenter)

## Overview

Write a failing test before writing the code that makes it pass. For bug fixes, reproduce the bug with a test before attempting a fix. Tests are proof — "seems right" is not done.

This skill is specialized for **Java/Spring Boot** with JUnit5, Mockito, and Spring Test.

**When NOT to use:** Pure configuration changes (application.yml), documentation updates, static content changes, or work where no code/behavior changes are made.

**Autonomous test decision:** Do not ask the user whether to write or skip tests. If code or behavior changes need regression proof, write the smallest relevant failing test first and continue through RED → GREEN → REFACTOR. If no code or behavior changes were made, do not write tests; state that no new tests are needed and run only useful narrow existing verification.

## The TDD Cycle

```
    RED                GREEN              REFACTOR
 Write a test    Write minimal code    Clean up the
 that fails  ──→  to make it pass  ──→  implementation  ──→  (repeat)
      │                  │                    │
      ▼                  ▼                    ▼
   Test FAILS        Test PASSES         Tests still PASS
```

### Step 1: RED — Write a Failing Test

Write the test first. It must fail. A test that passes immediately proves nothing.

```java
// RED: This test fails because createTask doesn't exist yet
@SpringBootTest
class TaskServiceTest {
    @Autowired
    private TaskService taskService;

    @Test
    void createTask_withTitle_returnsPendingStatus() {
        // Arrange
        CreateTaskRequest request = new CreateTaskRequest("Buy groceries");

        // Act
        Task task = taskService.createTask(request);

        // Assert
        assertThat(task.getId()).isNotNull();
        assertThat(task.getTitle()).isEqualTo("Buy groceries");
        assertThat(task.getStatus()).isEqualTo(TaskStatus.PENDING);
        assertThat(task.getCreatedAt()).isNotNull();
    }
}
```

### Step 2: GREEN — Make It Pass

Write the minimum code to make the test pass. Don't over-engineer:

```java
// GREEN: Minimal implementation
@Service
@RequiredArgsConstructor
public class TaskService {
    private final TaskRepository taskRepository;

    public Task createTask(CreateTaskRequest request) {
        Task task = Task.builder()
            .title(request.getTitle())
            .status(TaskStatus.PENDING)
            .createdAt(LocalDateTime.now())
            .build();
        return taskRepository.save(task);
    }
}
```

### Step 3: REFACTOR — Clean Up

With tests green, improve the code without changing behavior:

- Extract shared logic
- Improve naming
- Remove duplication
- Optimize if necessary

Run tests after every refactor step:

```bash
./gradlew test
```

## The Prove-It Pattern (Bug Fixes)

When a bug is reported, **do not start by trying to fix it.** Start by writing a test that reproduces it.

```
Bug report arrives
       │
       ▼
  Write a test that demonstrates the bug
       │
       ▼
  Test FAILS (confirming the bug exists)
       │
       ▼
  Implement the fix
       │
       ▼
  Test PASSES (proving the fix works)
       │
       ▼
  Run full test suite (no regressions)
```

**Example:**

```java
// Bug: "Completing a task doesn't update the completedAt timestamp"

// Step 1: Write the reproduction test (it should FAIL)
@Test
void completeTask_setsCompletedAt() {
    // Arrange
    Task task = taskService.createTask(new CreateTaskRequest("Test"));

    // Act
    Task completed = taskService.completeTask(task.getId());

    // Assert
    assertThat(completed.getStatus()).isEqualTo(TaskStatus.COMPLETED);
    assertThat(completed.getCompletedAt()).isNotNull();  // This fails → bug confirmed
}

// Step 2: Fix the bug
public Task completeTask(Long id) {
    Task task = taskRepository.findById(id)
        .orElseThrow(() -> new TaskNotFoundException(id));
    task.setStatus(TaskStatus.COMPLETED);
    task.setCompletedAt(LocalDateTime.now());  // This was missing
    return taskRepository.save(task);
}

// Step 3: Test passes → bug fixed, regression guarded
```

## The Test Pyramid

```
          /\
         /  \         E2E Tests (~5%)
        /    \        Full user flows, real DB
       /------\
      /        \      Integration Tests (~15%)
     /          \     @SpringBootTest, API boundaries
    /------------\
   /              \   Unit Tests (~80%)
  /                \  @ExtendWith(MockitoExtension), isolated logic
 /------------------\
```

**The Beyoncé Rule:** If you liked it, you should have put a test on it.

### Test Sizes

| Size | Spring Annotation | Speed | Example |
|------|------------------|-------|---------|
| **Small** | `@ExtendWith(MockitoExtension)` | Milliseconds | Pure logic, @Mock dependencies |
| **Medium** | `@DataJpaTest`, `@WebMvcTest` | Seconds | Repository tests, Controller slice tests |
| **Large** | `@SpringBootTest` | Minutes | Full context, real DB integration |

## Spring Boot Test Patterns

For detailed test patterns (unit, slice, integration), use the Read tool to load `references/spring-test-patterns.md`.

## Writing Good Tests

For best practices (state vs interactions, DAMP, mocking, naming), use the Read tool to load `references/test-writing-guide.md`.

## Test Anti-Patterns to Avoid

For detailed anti-patterns, common rationalizations, and red flags, see `references/tdd-anti-patterns.md`.

## Running Tests

```bash
# All tests
./gradlew test

# Specific module
./gradlew :api-service:test

# Specific test class
./gradlew :api-service:test --tests TaskServiceTest

# Specific test method
./gradlew :api-service:test --tests TaskServiceTest.createTask_withTitle_returnsPendingStatus

# With coverage (Jacoco)
./gradlew test jacocoTestReport
```

## DevCenter Integration

**TDD guidance:** Blocks writing new `.java` files in `src/main/` without a corresponding test class in `src/test/`.

**code-guardrail.js:** Runs Checkstyle + PMD on test files too — clean test code matters.

**AGENTS.md:** Developer persona includes TDD as a core workflow.


## Verification

- [ ] Every new behavior has a corresponding test
- [ ] All tests pass: `./gradlew test`
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] Test names describe the behavior being verified
- [ ] No tests were skipped (`@Disabled`)
- [ ] Coverage hasn't decreased (check Jacoco report)
