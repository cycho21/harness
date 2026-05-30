# Testing Review Checklist

> DevCenter 테스트 품질 전문 리뷰 체크리스트

## Scope
- TDD 준수 여부
- 테스트 커버리지 품질
- 테스트 코드 구조 및 가독성
- Mocking 전략
- 통합 테스트 vs 단위 테스트 적절성

---

## DevCenter Testing Philosophy

**TDD (Test-Driven Development):**
1. Red: 실패하는 테스트 먼저 작성
2. Green: 테스트를 통과하는 최소 구현
3. Refactor: 코드 개선 (테스트는 그대로)

**Coverage Enforcement:**
```properties
# gradle.properties
api-service.minCoverage=0.60
common.minCoverage=0.70
consumer-service.minCoverage=0.55
```
- `coverage review guidance`가 커밋 시 강제
- LINE coverage + BRANCH coverage (80%)

---

## 🔴 Critical Testing Issues

### Missing Critical Tests

**새 public 메서드에 테스트 없음**
```java
// ❌ CRITICAL: 테스트 없는 public API
@Service
public class OrderService {
    public Order cancel(Long orderId) {
        Order order = repository.findById(orderId).orElseThrow();
        order.cancel();
        return repository.save(order);
    }
}

// OrderServiceTest.java doesn't have test_cancel()

// ✅ CORRECT: 테스트 먼저 작성 (TDD)
class OrderServiceTest {
    @Test
    void cancel_shouldChangeStatusToCancelled() {
        // given
        Order order = createPendingOrder();

        // when
        Order result = orderService.cancel(order.getId());

        // then
        assertThat(result.getStatus()).isEqualTo(OrderStatus.CANCELLED);
    }
}
```

**Edge Case 테스트 누락**
```java
// ❌ CRITICAL: Happy path만 테스트
@Test
void getUser_shouldReturnUser() {
    User user = userService.getUser(1L);
    assertThat(user).isNotNull();
}

// 누락된 케이스:
// - ID가 null이면?
// - 존재하지 않는 ID면?
// - 삭제된 사용자면?

// ✅ CORRECT: Edge cases 포함
@Test
void getUser_whenNotFound_shouldThrowException() {
    assertThatThrownBy(() -> userService.getUser(999L))
        .isInstanceOf(EntityNotFoundException.class);
}

@Test
void getUser_whenIdIsNull_shouldThrowException() {
    assertThatThrownBy(() -> userService.getUser(null))
        .isInstanceOf(IllegalArgumentException.class);
}
```

### Wrong Testing Layer

**Controller Test에서 Service Mock**
```java
// ❌ CRITICAL: @SpringBootTest에서 Service mock
@SpringBootTest
class UserControllerTest {
    @MockBean
    private UserService userService;  // Wrong layer

    @Test
    void getUser_shouldReturn200() {
        when(userService.getUser(1L)).thenReturn(user);
        // ...
    }
}

// ✅ CORRECT: @WebMvcTest 사용
@WebMvcTest(UserController.class)
class UserControllerTest {
    @MockBean
    private UserService userService;  // Correct - Controller만 테스트

    @Autowired
    private MockMvc mockMvc;

    @Test
    void getUser_shouldReturn200() throws Exception {
        when(userService.getUser(1L)).thenReturn(user);

        mockMvc.perform(get("/api/v1/users/1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.id").value(1));
    }
}
```

**Repository Test에서 DB 안 씀**
```java
// ❌ CRITICAL: Repository mock (통합 테스트 필요)
@ExtendWith(MockitoExtension.class)
class UserRepositoryTest {
    @Mock
    private UserRepository userRepository;  // Wrong - real DB needed
}

// ✅ CORRECT: @DataJpaTest
@DataJpaTest
class UserRepositoryTest {
    @Autowired
    private UserRepository userRepository;

    @Test
    void findByEmail_shouldReturnUser() {
        // given
        User user = new User("test@example.com");
        userRepository.save(user);

        // when
        Optional<User> result = userRepository.findByEmail("test@example.com");

        // then
        assertThat(result).isPresent();
    }
}
```

### Test Data Builder Missing

**테스트마다 중복된 객체 생성**
```java
// ❌ CRITICAL: Duplicated test data setup
@Test
void test1() {
    User user = new User();
    user.setId(1L);
    user.setEmail("test@example.com");
    user.setName("Test");
    user.setActive(true);
    // ...
}

@Test
void test2() {
    User user = new User();
    user.setId(2L);
    user.setEmail("test2@example.com");
    user.setName("Test2");
    user.setActive(true);
    // ... same setup repeated
}

// ✅ CORRECT: Test Data Builder
class UserTestBuilder {
    private Long id = 1L;
    private String email = "test@example.com";
    private String name = "Test";
    private boolean active = true;

    public static UserTestBuilder aUser() {
        return new UserTestBuilder();
    }

    public UserTestBuilder withEmail(String email) {
        this.email = email;
        return this;
    }

    public User build() {
        User user = new User();
        user.setId(id);
        user.setEmail(email);
        user.setName(name);
        user.setActive(active);
        return user;
    }
}

@Test
void test1() {
    User user = aUser().build();
}

@Test
void test2() {
    User user = aUser().withEmail("test2@example.com").build();
}
```

---

## 🟡 Major Testing Issues

### Over-Mocking

**Service Test에서 Repository도 Mock**
```java
// ⚠️ MAJOR: 너무 많은 Mock
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock
    private UserRepository userRepository;
    @Mock
    private EmailService emailService;
    @Mock
    private NotificationService notificationService;

    @InjectMocks
    private UserService userService;

    // 10+ when() statements per test
}

// ✅ BETTER: 통합 테스트 or Fake object
@SpringBootTest
class UserServiceIntegrationTest {
    @Autowired
    private UserService userService;

    @Autowired
    private UserRepository userRepository;

    @MockBean  // Only external dependencies
    private EmailService emailService;

    @Test
    void createUser_shouldSaveToDb() {
        // Real DB interaction, mock only external services
    }
}
```

### Poor Test Naming

**테스트 메서드명이 의미 불명확**
```java
// ⚠️ MAJOR: What does this test?
@Test
void test1() { }

@Test
void testGetUser() { }

@Test
void shouldWork() { }

// ✅ BETTER: Method_Condition_ExpectedResult
@Test
void getUser_whenUserExists_shouldReturnUser() { }

@Test
void getUser_whenUserNotFound_shouldThrowException() { }

@Test
void createOrder_whenUserInactive_shouldThrowValidationException() { }
```

### Missing Assertions

**테스트가 아무것도 검증 안 함**
```java
// ⚠️ MAJOR: No assertion
@Test
void createUser() {
    userService.createUser(request);
    // No assertion - test always passes
}

// ✅ CORRECT: Verify behavior
@Test
void createUser_shouldSaveToDatabase() {
    User result = userService.createUser(request);

    assertThat(result.getId()).isNotNull();
    assertThat(result.getEmail()).isEqualTo(request.getEmail());

    User saved = userRepository.findById(result.getId()).orElseThrow();
    assertThat(saved.getEmail()).isEqualTo(request.getEmail());
}
```

### Flaky Tests

**시간 의존적 테스트**
```java
// ⚠️ MAJOR: Flaky - depends on system time
@Test
void getRecentOrders_shouldReturnLast7Days() {
    Order order = createOrder(LocalDateTime.now().minusDays(3));

    List<Order> result = orderService.getRecentOrders();

    assertThat(result).hasSize(1);  // Fails at midnight
}

// ✅ CORRECT: Time injection
@Test
void getRecentOrders_shouldReturnLast7Days() {
    Clock fixedClock = Clock.fixed(
        Instant.parse("2024-01-15T10:00:00Z"),
        ZoneId.of("UTC")
    );
    orderService.setClock(fixedClock);

    Order order = createOrder(LocalDateTime.now(fixedClock).minusDays(3));

    List<Order> result = orderService.getRecentOrders();

    assertThat(result).hasSize(1);
}
```

**Random 데이터 사용**
```java
// ⚠️ MAJOR: Non-deterministic
@Test
void processUser() {
    User user = createUserWithRandomEmail();  // Different every run
    userService.process(user);
}

// ✅ CORRECT: Fixed test data
@Test
void processUser() {
    User user = aUser().withEmail("test@example.com").build();
    userService.process(user);
}
```

---

## 🔵 Minor Testing Issues

### @Transactional on Test

**테스트에 @Transactional (자동 롤백)**
```java
// ⚠️ MINOR: Hides transaction issues
@SpringBootTest
@Transactional  // Auto rollback
class UserServiceTest {
    @Test
    void createUser() {
        userService.createUser(request);
        // Transaction still open - can't catch LazyInitializationException
    }
}

// ✅ BETTER: Explicit cleanup or @DirtiesContext
@SpringBootTest
class UserServiceTest {
    @AfterEach
    void cleanup() {
        userRepository.deleteAll();
    }

    @Test
    void createUser() {
        userService.createUser(request);
        // Real transaction behavior
    }
}
```

### Magic Numbers in Tests

**하드코딩된 값**
```java
// ⚠️ MINOR: Magic number
@Test
void getUsers_shouldReturnPageSize() {
    Page<User> result = userService.getUsers(PageRequest.of(0, 20));
    assertThat(result.getSize()).isEqualTo(20);  // What is 20?
}

// ✅ BETTER: Named constant
private static final int DEFAULT_PAGE_SIZE = 20;

@Test
void getUsers_shouldReturnPageSize() {
    Page<User> result = userService.getUsers(
        PageRequest.of(0, DEFAULT_PAGE_SIZE)
    );
    assertThat(result.getSize()).isEqualTo(DEFAULT_PAGE_SIZE);
}
```

---

## DevCenter Testing Standards

### 1. Test File Location

```
api-service/
├─ src/main/java/com/example/UserService.java
└─ src/test/java/com/example/UserServiceTest.java  ✅

// NOT UserServiceTests.java (plural)
// NOT UserServiceTestCase.java
```

### 2. Test Annotations

**Controller:**
```java
@WebMvcTest(UserController.class)
@AutoConfigureMockMvc
```

**Service:**
```java
@SpringBootTest  // If integration test
// or
@ExtendWith(MockitoExtension.class)  // If unit test
```

**Repository:**
```java
@DataJpaTest
@AutoConfigureTestDatabase(replace = Replace.NONE)  // Use real DB
```

### 3. Coverage Exclusions

**제외 대상 (coverage review guidance):**
```java
// Config classes
@Configuration
public class AppConfig { }

// Application entry point
@SpringBootApplication
public class Application { }

// DTOs (no logic)
public class UserDto { }

// Entities (JPA managed)
@Entity
public class User { }
```

### 4. Integration Test Profile

```yaml
# src/test/resources/application-test.yml
spring:
  datasource:
    url: jdbc:h2:mem:testdb
  jpa:
    hibernate:
      ddl-auto: create-drop
```

```java
@SpringBootTest
@ActiveProfiles("test")
class UserServiceIntegrationTest { }
```

---

## Test Pyramid

**DevCenter 권장 비율:** 70% unit / 25% integration / 5% E2E

**각 레벨 예시:**

**Unit Test (70%):**
- Service 로직
- Util 메서드
- Domain model

**Integration Test (25%):**
- Controller + Service + Repository
- Kafka Consumer
- External API 호출

**E2E Test (5%):**
- Full user flow
- UI (if any)

---

## Common Pitfalls

### 1. Testing Implementation, Not Behavior

```java
// ❌ WRONG: Testing internal implementation
@Test
void createUser_shouldCallRepositorySave() {
    userService.createUser(request);
    verify(userRepository).save(any(User.class));  // Testing HOW, not WHAT
}

// ✅ CORRECT: Testing observable behavior
@Test
void createUser_shouldPersistUser() {
    User result = userService.createUser(request);

    User saved = userRepository.findById(result.getId()).orElseThrow();
    assertThat(saved.getEmail()).isEqualTo(request.getEmail());
}
```

### 2. One Assertion Per Test (Anti-pattern)

```java
// ❌ WRONG: Too granular
@Test
void createUser_shouldSetId() {
    User user = userService.createUser(request);
    assertThat(user.getId()).isNotNull();
}

@Test
void createUser_shouldSetEmail() {
    User user = userService.createUser(request);
    assertThat(user.getEmail()).isEqualTo(request.getEmail());
}

// ✅ CORRECT: Multiple related assertions OK
@Test
void createUser_shouldCreateValidUser() {
    User user = userService.createUser(request);

    assertThat(user.getId()).isNotNull();
    assertThat(user.getEmail()).isEqualTo(request.getEmail());
    assertThat(user.isActive()).isTrue();
}
```

---

## Review Checklist

테스트 리뷰 시:
- [ ] 새 public 메서드에 테스트 있는가?
- [ ] Happy path + edge cases 모두 커버되는가?
- [ ] 테스트 이름이 명확한가? (Method_Condition_Expected)
- [ ] Given-When-Then 구조인가?
- [ ] Assertion이 있는가?
- [ ] 적절한 테스트 레이어인가? (@WebMvcTest, @DataJpaTest)
- [ ] Mock 남용 안 했는가? (통합 테스트가 더 나을 수도)
- [ ] Flaky test 가능성은? (시간, random)
- [ ] Test data builder 필요한가? (중복 setup 3회 이상)

---

## False Positive Prevention

**Private 메서드는 직접 테스트 안 함**
```java
// ❌ WRONG: "private method has no test"
private String formatName(String name) { }

// ✅ CORRECT: Tested via public method
@Test
void createUser_shouldFormatName() {
    User user = userService.createUser(request);
    assertThat(user.getName()).isEqualTo("Formatted Name");
    // formatName() is tested indirectly
}
```

**@SpringBootTest는 느려도 필요할 수 있음**
```java
// Don't always suggest "use @WebMvcTest instead"
// Integration test with real DB is valuable for complex flows
@SpringBootTest
class OrderFlowIntegrationTest { }
```

---

## Review Output Example

```markdown
## 🔴 Critical Testing Issues

**UserService.java:42** - Missing test for cancel() method
- New public method added without test
- Fix: Add UserServiceTest.cancel_shouldChangeStatus()

**OrderServiceTest.java:23** - Missing edge case tests
- Only happy path tested
- Missing: null ID, not found, invalid status
- Fix: Add 3 edge case tests

## 🟡 Major Testing Issues

**UserControllerTest.java:15** - Wrong test layer
- Using @SpringBootTest but mocking Service
- Fix: Change to @WebMvcTest(UserController.class)

## ✅ Positive Observations
- Proper test data builder pattern
- Clear Given-When-Then structure
- Good coverage: 78% line, 82% branch
```
