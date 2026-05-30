---
name: api-and-interface-design
description: Guides stable REST API design for Spring Boot. ALWAYS use when designing endpoints, creating DTOs, defining entity relationships, or changing public API contracts. Use when the user mentions "API", "endpoint", "contract", "interface". Every observable behavior is a commitment — this skill ensures backward-compatible, well-documented interfaces.
---

# API and Interface Design (DevCenter)

## Overview

Design stable, well-documented interfaces that are hard to misuse. Good interfaces make the right thing easy and the wrong thing hard.

This skill is specialized for **Spring Boot REST APIs** with standard patterns: DTO/Entity separation, @Valid, ResponseEntity, Global Exception Handler.

## Core Principles

### Hyrum's Law

> With a sufficient number of users of an API, all observable behaviors of your system will be depended on by somebody, regardless of what you promise in the contract.

**Implications:**
- Every public behavior — including error message text, field ordering, timing — becomes a de facto contract once users depend on it
- **Be intentional about what you expose.** Every observable behavior is a potential commitment
- **Don't leak implementation details.** If users can observe it, they will depend on it
- **Plan for deprecation at design time.**

**Safe deprecation strategy:**
1. Add the new version alongside the old (both work simultaneously)
2. Mark the old version as `@Deprecated` with migration guide in JavaDoc
3. Log deprecation warnings when old version is used
4. Wait at least 6 months (or 2 major versions)
5. Remove the old version only after confirming zero usage

### The One-Version Rule

Avoid forcing consumers to choose between multiple versions of the same API. Design for extension rather than forking.

### 1. Contract First

Define the interface before implementing it. The contract is the spec.

```java
// Define the contract first (DTO layer)
public record CreateTaskRequest(
    @NotBlank(message = "Title is required")
    @Size(max = 200, message = "Title must not exceed 200 characters")
    String title,

    String description,

    @Valid
    AssigneeDto assignee
) {}

public record TaskResponse(
    Long id,
    String title,
    String description,
    TaskStatus status,
    LocalDateTime createdAt,
    LocalDateTime updatedAt
) {
    // Factory method from entity
    public static TaskResponse from(Task entity) {
        return new TaskResponse(
            entity.getId(),
            entity.getTitle(),
            entity.getDescription(),
            entity.getStatus(),
            entity.getCreatedAt(),
            entity.getUpdatedAt()
        );
    }
}
```

### 2. DTO/Entity Separation

**Never expose JPA entities directly in REST APIs.**

| Layer | Type | Purpose |
|-------|------|---------|
| **API** | DTO (Request/Response) | Client contract, validation, versioning |
| **Service** | Entity | Business logic, persistence, relationships |

For code examples (good vs bad patterns), use the Read tool to load `references/examples.md`.

**Why DTO/Entity separation?**
- Entities have JPA annotations (@OneToMany, lazy loading) that leak to JSON
- API contracts should be stable; entity schemas change for performance/normalization
- Validation rules differ: API validation (user input) vs. entity validation (business rules)
- Security: entities may contain sensitive fields not intended for API exposure

### 3. Consistent Error Semantics

Use **Global Exception Handler** with structured error responses. For complete implementation example, use the Read tool to load `references/examples.md`.

**HTTP Status Mapping:**

| Status | Code | Meaning |
|--------|------|---------|
| 200 | OK | Successful GET, PATCH, DELETE |
| 201 | Created | Successful POST (include `Location` header) |
| 400 | Bad Request | Malformed request syntax |
| 401 | Unauthorized | Not authenticated |
| 403 | Forbidden | Authenticated but not authorized |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Duplicate, optimistic lock failure |
| 422 | Unprocessable Entity | Validation failed (semantically invalid) |
| 500 | Internal Server Error | Unexpected error (never expose stack traces) |

### 4. Validate at Boundaries

Use `@Valid` at API boundaries. Trust internal code.

```java
@RestController
@RequestMapping("/api/tasks")
public class TaskController {
    @PostMapping
    public ResponseEntity<TaskResponse> createTask(
        @Valid @RequestBody CreateTaskRequest request  // Validates here
    ) {
        // After validation, service layer trusts the data
        Task task = taskService.createTask(request);
        return ResponseEntity
            .created(URI.create("/api/tasks/" + task.getId()))
            .body(TaskResponse.from(task));
    }
}
```

**Where validation belongs:**
- API controllers (user input) — `@Valid @RequestBody`
- Configuration classes (environment variables) — `@Validated` + `@Value` with constraints
- External service clients (third-party responses) — validate shape and content

> **Third-party API responses are untrusted data.** Validate their shape and content before using them in logic or rendering.

**Where validation does NOT belong:**
- Between internal services (they share type contracts)
- In utility functions called by already-validated code
- On data from your own database

### 5. Prefer Addition Over Modification

Extend interfaces without breaking existing consumers:

```java
// ✅ Good: Add optional fields
public record CreateTaskRequest(
    @NotBlank String title,
    String description,
    TaskPriority priority,  // Added later, optional (nullable)
    List<String> labels     // Added later, optional
) {}

// ❌ Bad: Change existing field types or remove fields
public record CreateTaskRequest(
    @NotBlank String title,
    // description removed — breaks existing consumers
    int priority  // Changed from TaskPriority enum — breaks existing consumers
) {}
```

### 6. Predictable Naming

| Pattern | Convention | Example |
|---------|-----------|---------|
| REST endpoints | Plural nouns, no verbs | `GET /api/tasks`, `POST /api/tasks` |
| Query params | camelCase | `?sortBy=createdAt&pageSize=20` |
| JSON fields | camelCase | `{ "createdAt", "updatedAt", "taskId" }` |
| Boolean fields | is/has/can prefix | `isComplete`, `hasAttachments` |
| Enum values | UPPER_SNAKE | `PENDING`, `IN_PROGRESS`, `COMPLETED` |

## Spring Boot REST Patterns

For detailed REST endpoint patterns (Resource Design, Sub-resources, Pagination, Filtering, Partial Updates), use the Read tool to load `references/spring-boot-rest-patterns.md`.

## JPA Entity Relationship Design

For JPA relationship patterns (@OneToMany, @ManyToOne, @ManyToMany), use the Read tool to load `references/jpa-relationships.md`.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "We'll document the API later" | The types ARE the documentation. Define them first. |
| "We don't need pagination for now" | You will the moment someone has 100+ items. Add it from the start. |
| "PATCH is complicated, let's use PUT" | PUT requires the full object. PATCH is what clients want. |
| "We'll version when we need to" | Breaking changes without versioning break consumers. Design for extension from the start. |
| "Nobody uses that undocumented behavior" | Hyrum's Law: if it's observable, somebody depends on it. |
| "Internal APIs don't need contracts" | Internal consumers are still consumers. Contracts enable parallel work. |
| "JPA entities as DTOs is fine" | Leaks implementation (lazy loading, circular refs). Use separate DTOs. |

## Red Flags

- Endpoints returning JPA entities directly
- Inconsistent error formats across endpoints
- Validation scattered in service layer instead of at API boundaries
- Breaking changes to existing fields (type changes, removals)
- List endpoints without pagination
- Verbs in REST URLs (`/api/createTask`, `/api/getTasks`)
- Third-party API responses used without validation

## DevCenter Integration

**persona-inject.sh:** Entity/Controller/Security 파일 수정 시 페르소나 컨텍스트를 자동 주입합니다 (advisory).

**AGENTS.md:** Backend Engineer persona includes REST API design as a core responsibility.

**WORKFLOW.md:** API design is part of the `feat/*` Full Lifecycle, phase ④ incremental-implementation.

## Verification

- [ ] Every endpoint has typed Request and Response DTOs
- [ ] Error responses follow a single consistent format (@ControllerAdvice)
- [ ] Validation happens at API boundaries only (`@Valid @RequestBody`)
- [ ] List endpoints support pagination (`Pageable`)
- [ ] New fields are additive and optional (backward compatible)
- [ ] Naming follows consistent conventions (camelCase JSON, UPPER_SNAKE enums)
- [ ] JPA entities are NOT exposed directly in REST responses
