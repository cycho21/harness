# Writing Good Tests

## Test State, Not Interactions

Assert on the *outcome*, not on which methods were called internally.

```java
// Good: Tests what the function does
@Test
void listTasks_sortsByCreationDateDescending() {
    List<Task> tasks = taskService.listTasks(Sort.by("createdAt").descending());
    assertThat(tasks.get(0).getCreatedAt())
        .isAfter(tasks.get(1).getCreatedAt());
}

// Bad: Tests how the function works internally
@Test
void listTasks_callsRepositoryWithSort() {
    taskService.listTasks(Sort.by("createdAt").descending());
    verify(taskRepository).findAll(argThat(sort ->
        sort.toString().contains("createdAt: DESC")
    ));
}
```

## DAMP Over DRY in Tests

```java
// DAMP: Each test is self-contained
@Test
void createTask_rejectsEmptyTitle() {
    CreateTaskRequest request = new CreateTaskRequest("");
    assertThatThrownBy(() -> taskService.createTask(request))
        .isInstanceOf(ValidationException.class)
        .hasMessage("Title is required");
}

@Test
void createTask_trimsWhitespace() {
    CreateTaskRequest request = new CreateTaskRequest("  Buy groceries  ");
    Task task = taskService.createTask(request);
    assertThat(task.getTitle()).isEqualTo("Buy groceries");
}
```

## Prefer Real Implementations Over Mocks

Use the simplest test double:

```
1. Real implementation  → @SpringBootTest
2. Fake                 → In-memory H2 DB (@DataJpaTest)
3. Stub                 → when(mock.method()).thenReturn(value)
4. Mock (interaction)   → verify(mock).method() — use sparingly
```

**Use mocks only when:** the real implementation is too slow (external APIs, email sending), non-deterministic, or has side effects you can't control.

## Use the Arrange-Act-Assert Pattern

```java
@Test
void markOverdue_whenDeadlinePassed() {
    // Arrange
    Task task = Task.builder()
        .title("Test")
        .deadline(LocalDateTime.of(2025, 1, 1, 0, 0))
        .build();

    // Act
    boolean result = task.isOverdue(LocalDateTime.of(2025, 1, 2, 0, 0));

    // Assert
    assertThat(result).isTrue();
}
```

## One Assertion Per Concept

```java
// Good: Each test verifies one behavior
@Test void createTask_rejectsEmptyTitle() { ... }

@Test void createTask_trimsWhitespace() { ... }

@Test void createTask_enforcesMaxLength() { ... }

// Bad: Everything in one test
@Test
void createTask_validatesTitle() {
    assertThatThrownBy(() -> taskService.createTask(new CreateTaskRequest("")))
        .isInstanceOf(ValidationException.class);
    assertThat(taskService.createTask(new CreateTaskRequest("  hello  ")).getTitle())
        .isEqualTo("hello");
    assertThatThrownBy(() -> taskService.createTask(new CreateTaskRequest("a".repeat(256))))
        .isInstanceOf(ValidationException.class);
}
```

## Name Tests Descriptively

```java
// Good: Reads like a specification
class TaskServiceTest {
    @Nested
    @DisplayName("completeTask")
    class CompleteTask {
        @Test void setsStatusToCompletedAndRecordsTimestamp() { ... }

        @Test void throwsNotFoundExceptionForNonExistentTask() { ... }

        @Test void isIdempotent_completingAlreadyCompletedTaskIsNoOp() { ... }

        @Test void sendsNotificationToAssignee() { ... }
    }
}

// Bad: Vague names
class TaskServiceTest {
    @Test void test1() { ... }
    @Test void itWorks() { ... }
    @Test void handlesErrors() { ... }
}
```
