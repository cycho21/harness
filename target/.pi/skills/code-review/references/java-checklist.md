# Java/Spring Boot Code Review Checklist

> DevCenter 프로젝트 특화 체크리스트 (프로젝트 컨텍스트 포함)

## Project Context

### DevCenter Characteristics
- **Framework**: Spring Boot 3.x, Java (see `build.gradle` for current versions)
- **Architecture**: Clean Architecture (Controller → Service → Repository → Entity)
- **Philosophy**: TDD (test-first), High cohesion & Low coupling
- **Coverage**: Enforced via coverage review guidance (60-70% thresholds)

### ADR-0001 Core Rules
1. **Layer Separation**: Never skip layers (Controller must call Service, not Repository)
2. **DTO/Entity Separation**: DTOs for API, Entities for persistence (never expose Entity to REST API)
3. **Transaction Boundaries**: `@Transactional` on Service layer only, NOT on Controller
4. **Dependency Injection**: Constructor injection (not `@Autowired` fields)
5. **Exception Handling**: `@ControllerAdvice` for global exception handling

### Common Patterns (Don't Flag as Unused)

**Reflection-based usage:**
```java
// Jackson serialization/deserialization
private String field;  // Used by @JsonProperty, not "unused"

// JPA entity fields
@Column(name = "user_id")
private Long userId;  // Used by JPA reflection

// Lombok-generated methods
@Getter @Setter
private String name;  // getter/setter exist at runtime
```

**Framework conventions:**
```java
// Spring Data JPA method naming
List<User> findByEmailAndStatus(String email, String status);
// Method name IS the query - don't flag as "should use @Query"

// @Value injection
@Value("${app.feature.enabled}")
private boolean featureEnabled;  // Injected by Spring, not unused
```

---

## Common False Positives (DON'T Flag These)

### 1. "Field is unused" (but used via reflection)
```java
// ❌ WRONG: "field 'id' is never used"
public class UserDto {
    private Long id;  // Used by Jackson for JSON serialization
}

// ✅ CORRECT: Acknowledge reflection usage
```

### 2. "Method should be static" (but overrides interface)
```java
// ❌ WRONG: "method can be static"
@Override
public User findById(Long id) {
    return repository.findById(id).orElse(null);
}

// ✅ CORRECT: Interface method cannot be static
```

### 3. "Add null check" (but Spring guarantees non-null)
```java
// ❌ WRONG: "userId might be null"
public void updateUser(@PathVariable Long userId) {
    // Spring validates path variable exists
}

// ✅ CORRECT: Framework guarantees non-null in this context
```

### 4. "Unused import" (but used in Javadoc)
```java
// ❌ WRONG: "import never used"
import com.example.UserDto;

/**
 * Converts {@link UserDto} to Entity
 */
// ✅ CORRECT: Used in documentation
```

---

## 🔴 Critical Issues (Must Fix)

### Logic Errors
- [ ] Null pointer risks (`.get()` without `.isPresent()` check)
- [ ] Off-by-one errors in loops
- [ ] Incorrect comparison operators (`==` for Object equality)
- [ ] Resource leaks (unclosed `InputStream`, `Connection`)
- [ ] Race conditions in multi-threaded code:
  - Shared mutable state without synchronization
  - Check-then-act without atomicity (`if (exists) → modify`)
  - Non-thread-safe collection across threads (`HashMap` vs `ConcurrentHashMap`)

### Spring Boot Specific
- [ ] **Layer violation**: Controller calling Repository directly
- [ ] **Entity exposure**: Returning JPA Entity from REST API (must use DTO)
- [ ] **Transaction misuse**: `@Transactional` on Controller (should be Service only)
- [ ] **N+1 query**: Missing `@EntityGraph` or `JOIN FETCH` in related entities
- [ ] **Lazy loading outside transaction**: Accessing lazy field after transaction closed

> For deeper architecture analysis (circular dependencies, domain model design,
> module boundaries), load `architecture-checklist.md`.

### Security
- [ ] SQL injection via string concatenation (use `@Query` with parameters)
- [ ] Path traversal vulnerability (`../../` in file paths)
- [ ] Hardcoded credentials/secrets
- [ ] Missing input validation on user data

---

## 🟡 Major Issues (Should Fix)

### Design & Architecture
- [ ] Service layer missing (business logic in Controller)
- [ ] God class (>500 lines, multiple responsibilities)
- [ ] Circular dependencies between Services
- [ ] DTO/Entity mixed (same class used for both API and persistence)

### Error Handling
- [ ] Empty catch block (swallowing exceptions)
- [ ] Generic `Exception` catch (should catch specific exceptions)
- [ ] Missing error response DTO (returning plain String errors)
- [ ] No `@ControllerAdvice` for REST API exceptions

### Code Quality
- [ ] Code duplication (same logic in 3+ places)
- [ ] Magic numbers (use constants or enums)
- [ ] Poor naming (`doStuff()`, `temp`, `data`)
- [ ] Deep nesting (>3 levels)

### Testing
- [ ] New public method without test
- [ ] Test mocking Service in Controller test (should use `@WebMvcTest`)
- [ ] Missing edge case tests (null, empty, boundary)

### Logging
- [ ] Empty catch block without logging
- [ ] Logging sensitive data (passwords, tokens, PII)
- [ ] Missing request correlation ID in logs
- [ ] Using `System.out.println` instead of Logger
- [ ] Inconsistent log levels (ERROR for non-errors, DEBUG in production path)

---

## 🔵 Minor Issues (Consider Fixing)

### Style & Conventions
- [ ] Field injection instead of constructor injection
- [ ] Missing `@Override` annotation
- [ ] Inconsistent formatting (but not severe)
- [ ] Javadoc missing for public API (optional in DevCenter)

### Optimization Opportunities
- [ ] Using `List` when `Set` would prevent duplicates
- [ ] Eager loading when lazy is sufficient
- [ ] StringBuilder in simple string concatenation (JVM optimizes)

### Documentation
- [ ] Complex logic without inline comments
- [ ] Missing README update for new endpoint
- [ ] Outdated TODO comments

---

## Review Guidelines

### Priority Rules
1. **Critical** blocks commit → must fix before merge
2. **Major** degrades quality → strongly recommend fix
3. **Minor** improves code → suggest, but optional

### Context Awareness
- **Check ADR-0001** before flagging architectural issues
- **Verify reflection usage** before flagging "unused" fields
- **Consider framework conventions** (Spring Data method naming)
- **Balance strictness with pragmatism** (don't enforce Javadoc on obvious methods)

### False Positive Prevention
Ask yourself:
- "Could this be used via reflection?" (Jackson, JPA, Lombok)
- "Is this a framework convention?" (Spring Data queries)
- "Does ADR-0001 already cover this?" (don't repeat architecture rules)
- "Is this actually a problem, or just a different style?"

---

## Example Review Output Format

```markdown
## 🔴 Critical Issues (Must Fix Before Commit)

**UserController.java:42** - Entity exposure
- Returning `User` entity directly from REST API
- Fix: Create `UserResponse` DTO and map entity → DTO
- Why: Exposes internal database structure, breaks ADR-0001

**UserService.java:67** - N+1 query detected
- `user.getOrders()` triggers separate query per user
- Fix: Add `@EntityGraph(attributePaths = "orders")` to repository method
- Why: Performance degradation with large datasets

## 🟡 Major Issues (Should Fix)

**UserService.java:23** - Empty catch block
- Exception swallowed without logging
- Fix: At minimum log the exception, or propagate as custom exception

## ✅ Positive Observations

- Proper DTO/Entity separation in UserMapper
- Comprehensive test coverage (87% line, 82% branch)
- Clean layer separation (no Controller → Repository calls)
```

---

## Scoring Criteria

**Ready to commit**: No Critical, ≤2 Major
**Needs fixes**: 1+ Critical or 3+ Major
**Needs major revision**: Multiple architectural violations
