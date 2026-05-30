---
name: planning-and-task-breakdown
description: Breaks work into ordered tasks for Java/Spring Boot. ALWAYS use this skill when you have a spec, receive a multi-step request, see "implement feature X", or feel uncertain about implementation order. Even simple features benefit from explicit task breakdown — use this whenever you'd otherwise "figure it out as you go". Use when the user mentions "plan this", "break this down", "what are the steps", or before starting any non-trivial implementation. Considers Spring layered architecture, JPA dependencies, and Gradle modules.
---

# Planning and Task Breakdown (DevCenter)

## Overview

Decompose work into small, verifiable tasks with explicit acceptance criteria for **Java/Spring Boot** projects. Good task breakdown is the difference between reliable work and a tangled mess.

Every task should be small enough to implement, test, and verify in a single focused session.

**When NOT to use:** Single-file changes with obvious scope, or when the spec already contains well-defined tasks.

## The Planning Process

### Step 1: Enter Plan Mode

Before writing any code, operate in read-only mode:

- Read the spec and relevant codebase sections
- Identify existing patterns and conventions (Spring Boot starters, layer structure)
- Map dependencies between components (Entity → Repository → Service → Controller)
- Note risks and unknowns (database migration, JPA relationships)

**Do NOT write code during planning.** The output is a plan document, not implementation.

### Step 2: Identify the Dependency Graph (Spring Boot)

Map what depends on what:

```
Database schema (Flyway migration)
    │
    ├── JPA Entity (@Entity, @Table)
    │       │
    │       ├── Repository (JpaRepository)
    │       │       │
    │       │       ├── Service (@Service, @Transactional)
    │       │       │       │
    │       │       │       ├── DTO (Request/Response)
    │       │       │       │       │
    │       │       │       │       └── Controller (@RestController)
    │       │       │       │               │
    │       │       │       │               └── GlobalExceptionHandler (@ControllerAdvice)
    │       │       │       │
    │       │       │       └── Test (Unit → Slice → Integration)
    │       │       │
    │       │       └── Query methods (findByStatus, etc.)
    │       │
    │       └── Entity relationships (@OneToMany, @ManyToOne)
    │
    └── Test data (src/test/resources/data.sql)
```

**Implementation order:** Bottom-up (Flyway → Entity → Repository → Service → DTO → Controller).

### Step 3: Slice Vertically (Spring Boot)

Instead of building all entities, then all services, then all controllers — build one complete feature path at a time.

**Bad (horizontal slicing):**
```
Task 1: Create all JPA entities (User, Task, Comment)
Task 2: Create all repositories (UserRepository, TaskRepository, CommentRepository)
Task 3: Create all services (UserService, TaskService, CommentService)
Task 4: Create all controllers (UserController, TaskController, CommentController)
Task 5: Connect everything
```

**Good (vertical slicing):**
```
Task 1: User can create a task
  - Entity: Task.java
  - Repository: TaskRepository.java
  - Service: TaskService.createTask()
  - DTO: CreateTaskRequest, TaskResponse
  - Controller: POST /api/tasks
  - Test: TaskServiceTest, TaskControllerTest

Task 2: User can view task list
  - Repository: TaskRepository.findAll(Pageable)
  - Service: TaskService.listTasks()
  - Controller: GET /api/tasks
  - Test: pagination tests

Task 3: User can update task status
  - Service: TaskService.updateStatus()
  - DTO: UpdateTaskStatusRequest
  - Controller: PATCH /api/tasks/:id/status
  - Test: status transition tests
```

Each vertical slice delivers working, testable functionality and passes `./gradlew test`.

### Step 4: Write Tasks

Each task follows this structure:

```markdown
## Task [N]: [Short descriptive title]

**Description:** One paragraph explaining what this task accomplishes.

**Acceptance criteria:**
- [ ] [Specific, testable condition]
- [ ] [Specific, testable condition]

**Verification:**
- [ ] Tests pass: `./gradlew :api-service:test`
- [ ] Build succeeds: `./gradlew build`
- [ ] Manual check: `curl -X POST http://localhost:8080/api/tasks -d '{"title":"Test"}'`

**Dependencies:** [Task numbers this depends on, or "None"]

**Files likely touched:**
- `api-service/src/main/java/.../Task.java` (Entity)
- `api-service/src/main/java/.../TaskRepository.java` (Repository)
- `api-service/src/main/java/.../TaskService.java` (Service)
- `api-service/src/main/java/.../CreateTaskRequest.java` (DTO)
- `api-service/src/main/java/.../TaskController.java` (Controller)
- `api-service/src/test/java/.../TaskServiceTest.java` (Test)

**Estimated scope:** [Small: 1-2 files | Medium: 3-5 files | Large: 5+ files]
```

**Java/Spring Boot specific acceptance criteria examples:**
```
- [ ] JPA entity has correct @Column annotations and indexes
- [ ] Repository extends JpaRepository<Task, Long>
- [ ] Service method is @Transactional
- [ ] Controller endpoint returns ResponseEntity with correct HTTP status
- [ ] DTO has @Valid constraints (@NotBlank, @Size)
- [ ] GlobalExceptionHandler catches domain exceptions
- [ ] Unit test uses @ExtendWith(MockitoExtension.class)
- [ ] Integration test uses @SpringBootTest
- [ ] No N+1 query (verified with query logging)
```

### Step 5: Order and Checkpoint

Arrange tasks so that:

1. **Flyway migrations first** (schema before entity)
2. **Dependencies satisfied** (Entity → Repository → Service → DTO → Controller)
3. **Each task leaves system working** (tests pass after each task)
4. **Verification checkpoints after 2-3 tasks**
5. **High-risk tasks early** (complex JPA relationships, transaction boundaries)

Add explicit checkpoints:

```markdown
## Checkpoint: After Tasks 1-3
- [ ] All tests pass: ./gradlew test
- [ ] Application starts: ./gradlew :api-service:bootRun
- [ ] Core user flow works end-to-end (Postman/curl)
- [ ] Checkstyle/PMD clean
- [ ] Review with human before proceeding
```

## Task Sizing Guidelines

| Size | Files | Scope | Example (Spring Boot) |
|------|-------|-------|-----------------------|
| **XS** | 1 | Single method or config | Add @Valid to existing DTO |
| **S** | 1-2 | One endpoint or service method | Add TaskService.deleteTask() + test |
| **M** | 3-5 | One feature slice (Entity → Controller) | User can create a task |
| **L** | 5-8 | Multi-layer feature with relationships | Task has many Comments (@OneToMany) |
| **XL** | 8+ | **Too large — break it down further** | — |

**Spring Boot file count estimation:**
- 1 endpoint = 4-6 files (Entity, Repository, Service, DTO×2, Controller, Test×2-3)
- 1 JPA relationship = +2-3 files (join table entity, migration, tests)

**When to break a task down further:**
- Would take >2 hours of agent work
- Cannot describe acceptance criteria in 3 or fewer bullet points
- Touches two or more Gradle modules (api-service + common)
- JPA relationship changes with cascading effects
- Task title contains "and" (sign it's two tasks)

## Plan Document Template (Spring Boot)

For a full plan template with phased tasks, checkpoints, risks, and open questions, see `references/plan-template.md`.

## Spring Boot Layering Rules

**Bottom-up dependency order:**

```
1. Flyway migration      (V001__create_task_table.sql)
2. JPA Entity            (Task.java)
3. Repository            (TaskRepository.java extends JpaRepository)
4. Service               (TaskService.java with @Transactional)
5. DTO                   (CreateTaskRequest, TaskResponse)
6. Controller            (TaskController.java)
7. Exception Handler     (GlobalExceptionHandler.java)
8. Tests                 (Unit → Slice → Integration)
```

**Never skip layers:** Controller must call Service, Service must call Repository. No Controller → Repository direct access.

## Test Strategy per Task

| Test Type | When | Example |
|-----------|------|---------|
| **Unit** | Service logic only | `TaskServiceTest` with `@ExtendWith(MockitoExtension)` |
| **Slice** | Controller without full context | `@WebMvcTest(TaskController.class)` |
| **Slice** | Repository without service | `@DataJpaTest` for `TaskRepository` |
| **Integration** | Full Spring Boot context | `@SpringBootTest` for end-to-end flow |

**Default strategy:** Unit tests for services, integration tests for full flows, slice tests only when necessary.

## Parallelization Opportunities

When multiple agents or sessions are available:

**Safe to parallelize:**
- Independent endpoints (GET /tasks, POST /comments) if they don't share state
- Tests for already-implemented features
- Documentation (JavaDoc, API docs)

**Must be sequential:**
- Flyway migrations (V001 → V002 → V003)
- JPA Entity changes (cascading relationship impacts)
- Service layer with shared state (@Transactional boundaries)

**Needs coordination:**
- Features sharing Entity (define Entity first, then parallelize)
- Features sharing DTO (define DTO contract first)
- GlobalExceptionHandler changes (coordinate error codes)

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll figure it out as I go" | That's how you end up with circular dependencies and rework. |
| "The tasks are obvious" | Write them down. Explicit tasks surface JPA dependencies and migration order. |
| "Planning is overhead" | Planning IS the task. Implementation without a plan is just typing. |
| "I can hold it all in my head" | Context windows are finite. Plans survive session boundaries. |
| "I'll add tests later" | You won't. Test tasks must be part of the plan. |

## Red Flags

- Starting implementation without a written task list
- Tasks that say "implement the feature" without acceptance criteria
- No verification steps in the plan
- All tasks are XL-sized
- No checkpoints between tasks
- Dependency order ignores Spring layers (Controller before Service)
- No Flyway migration task when schema changes
- No test tasks in the plan
- Entity changes without considering JPA relationship impacts

## DevCenter Integration

**persona-inject.sh:** Entity/Controller/Gradle 변경 시 페르소나 컨텍스트가 자동 주입됩니다 (advisory).

**TDD (지침):** 새 `.java` 파일에는 테스트를 먼저 작성합니다 — plan에 test task를 implementation task 앞에 배치하세요.

**WORKFLOW.md:** Planning is phase ② in the `feat/*` Full Lifecycle.

**TaskCreate tool:** Use TaskCreate to track plan execution — one task per checklist item.

## Verification

Before starting implementation, confirm:

- [ ] Every task has acceptance criteria (including JPA/transaction checks)
- [ ] Every task has verification step (`./gradlew test`, curl command)
- [ ] Task dependencies follow Spring layer order (Entity → Repository → Service → Controller)
- [ ] Flyway migration tasks precede Entity tasks
- [ ] No task touches more than ~5 files
- [ ] Test tasks are included (Unit → Slice → Integration)
- [ ] Checkpoints exist between major phases
- [ ] Architecture governance requirements noted (Entity/Controller changes)
- [ ] The human has reviewed and approved the plan
