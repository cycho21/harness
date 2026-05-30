# Architecture Review Checklist

> DevCenter 아키텍처 전문 리뷰 체크리스트

## Scope
- Clean Architecture 원칙 준수 (ADR-0001)
- 레이어 분리 및 의존성 방향
- 도메인 모델 설계
- API 설계 및 계약
- 확장성 및 유지보수성

---

## ADR-0001 Core Rules

> ADR-0001 rules (layer separation, DTO/Entity, transactions, DI) are covered
> in `java-checklist.md`. This checklist focuses on design-level architecture issues.

**DevCenter Architecture:**
- Spring Boot Layered Architecture (Controller → Service → Repository → Entity)
- See `java-checklist.md` for enforcement details

**This checklist focuses on:**
- Circular dependencies
- God classes and responsibility distribution
- Domain model design (Anemic vs Rich)
- Module boundaries and cohesion

---

## 🔴 Critical Architecture Violations

### Layer Violation

**Controller → Repository 직접 호출**
```java
// ❌ CRITICAL: Service layer 건너뛰기
@RestController
public class UserController {
    @Autowired
    private UserRepository userRepository;  // Layer violation

    @GetMapping("/users/{id}")
    public User getUser(@PathVariable Long id) {
        return userRepository.findById(id).orElseThrow();
    }
}

// ✅ CORRECT: Service를 거쳐야 함
@RestController
public class UserController {
    private final UserService userService;

    @GetMapping("/users/{id}")
    public UserResponse getUser(@PathVariable Long id) {
        return userService.getUserById(id);  // Service → Repository
    }
}
```

**Repository에서 비즈니스 로직**
```java
// ❌ CRITICAL: Repository에 비즈니스 로직
public interface UserRepository extends JpaRepository<User, Long> {
    default void activateUser(Long id) {
        User user = findById(id).orElseThrow();
        user.setActive(true);  // Business logic in Repository
        save(user);
    }
}

// ✅ CORRECT: Service에 비즈니스 로직
@Service
public class UserService {
    public void activateUser(Long id) {
        User user = userRepository.findById(id).orElseThrow();
        user.activate();  // Domain logic in Entity
        userRepository.save(user);
    }
}
```

### Entity Exposure

**REST API에서 Entity 직접 반환**
```java
// ❌ CRITICAL: Entity 노출
@GetMapping("/users/{id}")
public User getUser(@PathVariable Long id) {
    return userRepository.findById(id).orElseThrow();
}

// 문제:
// 1. 내부 DB 구조 노출 (password 등)
// 2. JSON 직렬화 시 LazyInitializationException
// 3. API 계약 변경 불가 (Entity 변경 = API 변경)

// ✅ CORRECT: DTO 사용
@GetMapping("/users/{id}")
public UserResponse getUser(@PathVariable Long id) {
    User user = userService.findById(id);
    return UserMapper.toResponse(user);
}
```

**@RequestBody로 Entity 직접 받기**
```java
// ❌ CRITICAL: Entity를 직접 바인딩
@PostMapping("/users")
public User createUser(@RequestBody User user) {
    return userService.save(user);
}

// 문제:
// 1. Mass Assignment 취약점 (id, createdAt 등 조작 가능)
// 2. Validation 분리 불가

// ✅ CORRECT: DTO 사용
@PostMapping("/users")
public UserResponse createUser(@RequestBody CreateUserRequest request) {
    User user = UserMapper.toEntity(request);
    return userService.create(user);
}
```

### Transaction Boundary Violation

**Controller에 @Transactional**
```java
// ❌ CRITICAL: Controller에 트랜잭션
@RestController
@Transactional  // Wrong layer
public class UserController {
    @PostMapping("/users")
    public User createUser(@RequestBody User user) {
        return userRepository.save(user);
    }
}

// ✅ CORRECT: Service에 트랜잭션
@Service
public class UserService {
    @Transactional
    public User create(CreateUserRequest request) {
        User user = UserMapper.toEntity(request);
        return userRepository.save(user);
    }
}
```

**Repository에 @Transactional**
```java
// ❌ CRITICAL: Repository 메서드에 직접
public interface UserRepository extends JpaRepository<User, Long> {
    @Transactional  // Wrong - Service가 관리해야 함
    @Modifying
    @Query("UPDATE User u SET u.active = true WHERE u.id = :id")
    void activateUser(@Param("id") Long id);
}

// ✅ CORRECT: Service에서 트랜잭션 관리
@Service
public class UserService {
    @Transactional
    public void activateUser(Long id) {
        userRepository.activateUser(id);
    }
}
```

### Dependency Injection Violation

**Field Injection**
```java
// ❌ CRITICAL: Field injection
@Service
public class UserService {
    @Autowired
    private UserRepository userRepository;  // Hard to test, hidden dependency
}

// ✅ CORRECT: Constructor injection
@Service
public class UserService {
    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }
}

// Or Lombok
@Service
@RequiredArgsConstructor
public class UserService {
    private final UserRepository userRepository;
}
```

---

## 🟡 Major Architecture Issues

### Circular Dependencies

**Service 간 순환 참조**
```java
// ⚠️ MAJOR: Circular dependency
@Service
public class UserService {
    @Autowired
    private OrderService orderService;  // UserService → OrderService
}

@Service
public class OrderService {
    @Autowired
    private UserService userService;  // OrderService → UserService (cycle!)
}

// ✅ CORRECT: Extract common logic to separate service
@Service
public class UserOrderService {
    private final UserService userService;
    private final OrderService orderService;

    // Orchestration logic here
}
```

### God Class

**Service에 모든 로직 집중**
```java
// ⚠️ MAJOR: 800 lines, 30+ methods
@Service
public class UserService {
    public User create() { }
    public User update() { }
    public void sendEmail() { }
    public void generateReport() { }
    public void syncWithExternalSystem() { }
    // ... 25 more methods
}

// ✅ CORRECT: Single Responsibility
@Service
public class UserService {
    public User create() { }
    public User update() { }
}

@Service
public class UserNotificationService {
    public void sendEmail() { }
}

@Service
public class UserReportService {
    public void generateReport() { }
}
```

### Anemic Domain Model

**Entity가 단순 데이터 홀더**
```java
// ⚠️ MAJOR: Anemic model
@Entity
public class Order {
    private OrderStatus status;
    // Only getters/setters
}

@Service
public class OrderService {
    public void cancel(Long orderId) {
        Order order = repository.findById(orderId).orElseThrow();
        if (order.getStatus() == OrderStatus.PENDING) {
            order.setStatus(OrderStatus.CANCELLED);  // Business logic in Service
        }
    }
}

// ✅ CORRECT: Rich domain model
@Entity
public class Order {
    private OrderStatus status;

    public void cancel() {
        if (this.status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only PENDING orders can be cancelled");
        }
        this.status = OrderStatus.CANCELLED;
    }
}

@Service
public class OrderService {
    public void cancel(Long orderId) {
        Order order = repository.findById(orderId).orElseThrow();
        order.cancel();  // Domain logic in Entity
        repository.save(order);
    }
}
```

### Missing Domain Events

**강결합된 도메인 로직**
```java
// ⚠️ MAJOR: OrderService가 UserService, NotificationService 직접 의존
@Service
public class OrderService {
    private final UserService userService;
    private final NotificationService notificationService;

    @Transactional
    public Order create(CreateOrderRequest request) {
        Order order = repository.save(new Order(request));
        userService.incrementOrderCount(order.getUserId());  // Tight coupling
        notificationService.sendOrderConfirmation(order);   // Tight coupling
        return order;
    }
}

// ✅ CORRECT: Domain Event 발행
@Service
public class OrderService {
    private final ApplicationEventPublisher eventPublisher;

    @Transactional
    public Order create(CreateOrderRequest request) {
        Order order = repository.save(new Order(request));
        eventPublisher.publishEvent(new OrderCreatedEvent(order));  // Loose coupling
        return order;
    }
}

@Component
public class OrderEventListener {
    @EventListener
    public void handleOrderCreated(OrderCreatedEvent event) {
        userService.incrementOrderCount(event.getOrder().getUserId());
    }

    @EventListener
    public void sendNotification(OrderCreatedEvent event) {
        notificationService.sendOrderConfirmation(event.getOrder());
    }
}
```

---

## 🔵 Minor Architecture Issues

### DTO Duplication

**Request/Response DTO가 거의 동일**
```java
// ⚠️ MINOR: 중복 DTO
public class CreateUserRequest {
    private String email;
    private String name;
}

public class UpdateUserRequest {
    private String email;
    private String name;
}

// ✅ BETTER: Base DTO 활용
public class UserFormDto {
    private String email;
    private String name;
}

// Request는 validation만 다름
@Valid
public class CreateUserRequest extends UserFormDto {
    @NotNull
    private String password;
}
```

### Repository Interface Naming

**일관성 없는 명명**
```java
// ⚠️ MINOR: get vs find 혼용
Optional<User> getById(Long id);
List<User> findByEmail(String email);

// ✅ BETTER: 일관된 명명 (Spring Data 관례)
Optional<User> findById(Long id);
List<User> findByEmail(String email);
```

---

## DevCenter 특화 아키텍처 규칙

### 1. Module Structure
```
api-service/          # REST API 진입점
├─ controller/
├─ service/
├─ repository/
└─ entity/

common/               # 공통 라이브러리
├─ dto/
├─ exception/
└─ util/

consumer-service/     # Kafka Consumer
└─ listener/
```

**규칙:**
- `common`에 비즈니스 로직 금지 (utility만)
- `api-service`와 `consumer-service`는 서로 독립적

### 2. Exception Handling Strategy

**@ControllerAdvice 필수**
```java
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(EntityNotFoundException.class)
    public ResponseEntity<ErrorResponse> handleNotFound(EntityNotFoundException e) {
        return ResponseEntity.status(404)
            .body(new ErrorResponse("NOT_FOUND", e.getMessage()));
    }
}
```

### 3. API Versioning

**URL 기반 버전 관리**
```java
// ✅ CORRECT
@GetMapping("/api/v1/users/{id}")
public UserResponse getUser(@PathVariable Long id) { }

// ❌ WRONG: 버전 없음
@GetMapping("/api/users/{id}")
```

### 4. DTO Mapper 위치

**독립적인 Mapper 클래스**
```java
// ✅ CORRECT
public class UserMapper {
    public static UserResponse toResponse(User user) { }
    public static User toEntity(CreateUserRequest request) { }
}

// ❌ WRONG: DTO 내부에 toEntity()
public class CreateUserRequest {
    public User toEntity() { }  // DTO가 Entity 의존
}
```

---

## Architecture Decision Record (ADR)

새로운 아키텍처 결정 시 ADR 작성 필수:

**Check existing ADRs:**

Use the Glob tool on `docs/adr/*.md` to see existing ADRs. The current ADRs are in `docs/adr/`, not `.pi/adrs/`.

**Create new ADR if:**
- 새로운 레이어 추가
- 외부 시스템 통합 방식 결정
- 데이터 모델 변경 (정규화 전략)
- 트랜잭션 범위 변경

---

## Review Questions

리뷰 시 다음 질문:
- [ ] 이 코드는 어느 레이어에 속하는가?
- [ ] 의존성 방향이 올바른가? (상위 → 하위)
- [ ] DTO/Entity 분리되어 있는가?
- [ ] 트랜잭션 경계가 명확한가?
- [ ] 도메인 로직이 Entity에 있는가, Service에 있는가?
- [ ] 새로운 요구사항 추가 시 영향 범위는?
- [ ] 테스트 가능한 구조인가?

---

## False Positive Prevention

**JPA Repository 메서드는 비즈니스 로직 아님**
```java
// ❌ WRONG: "Business logic in Repository"
List<User> findByEmailAndActiveTrue(String email);

// ✅ CORRECT: This is a query method, not business logic
```

**@Transactional(readOnly = true)는 Service에도 필요**
```java
// Don't flag as "unnecessary annotation"
@Transactional(readOnly = true)
public List<User> findAll() {
    return userRepository.findAll();
}
```

---

## Review Output Example

```markdown
## 🔴 Critical Architecture Violations

**UserController.java:23** - Layer violation (ADR-0001)
- Controller calling Repository directly, bypassing Service
- Impact: Business logic scattered, transaction boundary unclear
- Fix: Create UserService.getUserById() and call from Controller

**UserController.java:45** - Entity exposure
- Returning JPA Entity `User` from REST API
- Risk: Exposes password field, LazyInitializationException
- Fix: Create UserResponse DTO and use UserMapper

## 🟡 Major Architecture Issues

**OrderService.java:67** - God class detected
- 850 lines, 35 methods, multiple responsibilities
- Suggestion: Extract UserNotificationService, OrderReportService

## ✅ Positive Observations
- Clean DTO/Entity separation
- Proper constructor injection throughout
- Domain events used for loose coupling
```
