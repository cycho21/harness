# Implementation Plan Template (Spring Boot)

Use this template when planning multi-step features for Java/Spring Boot projects.

```markdown
# Implementation Plan: [Feature Name]

Risk: normal
Work type: feature
Ambiguity gate: standard

## Overview
[One paragraph summary of what we're building]

## Ambiguity Gate Metadata
Set these fields deliberately so DPAA/SBADR uses the intended strictness before implementation:

- `Risk: low|normal|high`
- `Work type: docs|cosmetic|discovery|feature|api|security|migration|data|deploy`
- `Ambiguity gate: advisory|standard|strict`

Use `advisory` only for low-risk documentation/cosmetic/discovery work. Use `strict` for API contracts, schema/database changes, security/privacy, migrations, data loss, CI/deploy/release, or destructive behavior.

## High-Risk Consensus Review

Required when `Risk: high`, `Ambiguity gate: strict`, or `Work type: api|security|migration|data|deploy`:

- [ ] Architect review: strongest feasibility/architecture objections resolved or explicitly accepted.
- [ ] Critic review: acceptance criteria, alternatives, risks, and verification steps are testable and coherent.
- [ ] Plan repaired after review; no major open feasibility or testability gaps remain.

## Architecture Decisions
- **Layer separation:** Controller → Service → Repository (no skipping)
- **DTO/Entity separation:** DTOs for API, Entities for persistence
- **Transaction boundaries:** @Transactional on Service layer only
- **Exception handling:** GlobalExceptionHandler for domain exceptions
- **Database:** [Flyway migration strategy, schema changes]
- **JPA relationships:** [@OneToMany mappings, lazy/eager fetching]

## Task List

### Phase 1: Database Schema
- [ ] Task 1: Create Flyway migration for [table_name]
- [ ] Task 2: Create JPA Entity with indexes

### Checkpoint: Schema
- [ ] Migration applied: ./gradlew :api-service:flywayMigrate
- [ ] Entity validates on startup

### Phase 2: Repository & Service
- [ ] Task 3: Create TaskRepository with query methods
- [ ] Task 4: Implement TaskService.createTask() with @Transactional

### Checkpoint: Business Logic
- [ ] Unit tests pass (TaskServiceTest with Mockito)
- [ ] No N+1 queries (check query logs)

### Phase 3: REST API
- [ ] Task 5: Create CreateTaskRequest DTO with @Valid
- [ ] Task 6: Implement POST /api/tasks endpoint
- [ ] Task 7: Add GlobalExceptionHandler for TaskNotFoundException

### Checkpoint: API
- [ ] Integration tests pass (@SpringBootTest)
- [ ] Postman collection updated
- [ ] curl smoke test works

### Phase 4: Additional Endpoints
- [ ] Task 8: GET /api/tasks (with Pageable)
- [ ] Task 9: PATCH /api/tasks/:id

### Checkpoint: Complete
- [ ] All tests pass: ./gradlew test
- [ ] Checkstyle/PMD clean
- [ ] Ready for code review

## Gradle Module Breakdown
| Module | Tasks | Reason |
|--------|-------|--------|
| `api-service` | 1-9 | Main REST API layer |
| `common` | (none) | Shared utilities (if needed) |

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| JPA N+1 queries | High | Add @EntityGraph or JOIN FETCH |
| LazyInitializationException | Medium | Ensure @Transactional boundaries correct |
| Flyway migration conflicts | Medium | Coordinate with team on schema changes |
| Large payload (no pagination) | High | Require Pageable on list endpoints |

## Open Questions
- Which fields should be indexed? (High-traffic queries)
- Soft delete or hard delete for tasks?
- Optimistic locking (@Version) needed?
```
