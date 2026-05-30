# Performance Review Checklist

> DevCenter 성능 전문 리뷰 체크리스트

## Scope
- Database query 최적화
- JPA N+1 문제 검출
- 메모리 누수 방지
- 알고리즘 복잡도 검증
- 캐싱 기회 발견

---

## 🔴 Critical Performance Issues

### N+1 Query Problem

**Lazy Loading in Loop**
```java
// ❌ CRITICAL: N+1 query
@GetMapping("/users")
public List<UserDto> getUsers() {
    List<User> users = userRepository.findAll();  // 1 query
    return users.stream()
        .map(u -> new UserDto(u.getId(), u.getOrders()))  // N queries
        .collect(Collectors.toList());
}

// Query count: 1 + N (users 100명이면 101 queries)

// ✅ CORRECT: JOIN FETCH
@Query("SELECT u FROM User u LEFT JOIN FETCH u.orders")
List<User> findAllWithOrders();

// 또는 @EntityGraph
@EntityGraph(attributePaths = {"orders"})
List<User> findAll();
```

**Implicit Lazy Loading Outside Transaction**
```java
// ❌ CRITICAL: LazyInitializationException or N+1
@GetMapping("/user/{id}")
public UserDto getUser(@PathVariable Long id) {
    User user = userService.findById(id);  // Transaction ends here
    return new UserDto(user.getName(), user.getOrders().size());  // Lazy load
}

// ✅ CORRECT: Eager fetch in Service
@Transactional(readOnly = true)
public User findByIdWithOrders(Long id) {
    return userRepository.findByIdWithOrders(id);
}
```

### Inefficient Queries

**SELECT * instead of specific columns**
```java
// ❌ CRITICAL: 불필요한 컬럼 조회
@Query("SELECT u FROM User u WHERE u.email = :email")
User findByEmail(@Param("email") String email);  // 모든 컬럼 조회

// ✅ CORRECT: DTO Projection (필요한 컬럼만)
@Query("SELECT new com.example.UserEmailDto(u.id, u.email) FROM User u WHERE u.email = :email")
UserEmailDto findEmailByEmail(@Param("email") String email);
```

**Missing Index on WHERE clause**
```java
// ❌ CRITICAL: 인덱스 없는 컬럼 조회
@Entity
public class Order {
    @Column  // No index
    private String orderNumber;
}

// findByOrderNumber() → Full table scan

// ✅ CORRECT: Add index
@Column
@Index(name = "idx_order_number")
private String orderNumber;
```

### Memory Leaks

**Static Collection Growth**
```java
// ❌ CRITICAL: 메모리 누수
public class CacheManager {
    private static final Map<String, Object> cache = new HashMap<>();

    public void put(String key, Object value) {
        cache.put(key, value);  // 무한 증가
    }
}

// ✅ CORRECT: Size limit or TTL
private static final LoadingCache<String, Object> cache =
    CacheBuilder.newBuilder()
        .maximumSize(1000)
        .expireAfterWrite(10, TimeUnit.MINUTES)
        .build(loader);
```

**Unclosed Resources**
```java
// ❌ CRITICAL: Connection leak
public void processFile(String path) throws IOException {
    InputStream is = new FileInputStream(path);
    process(is);
    // is not closed → resource leak
}

// ✅ CORRECT: try-with-resources
public void processFile(String path) throws IOException {
    try (InputStream is = new FileInputStream(path)) {
        process(is);
    }
}
```

---

## 🟡 Major Performance Issues

### Database Optimization

**Batch INSERT missing**
```java
// ⚠️ MAJOR: Individual INSERT (100개면 100번 쿼리)
for (User user : users) {
    userRepository.save(user);
}

// ✅ CORRECT: Batch INSERT
@Modifying
@Query("INSERT INTO User ...")
void batchInsert(@Param("users") List<User> users);

// Or configure batch size
spring.jpa.properties.hibernate.jdbc.batch_size=50
```

**Missing READ-ONLY transaction**
```java
// ⚠️ MAJOR: 읽기 전용인데 Write lock
@Transactional
public List<User> getUsers() {
    return userRepository.findAll();  // Unnecessary write lock
}

// ✅ CORRECT: Read-only transaction
@Transactional(readOnly = true)
public List<User> getUsers() {
    return userRepository.findAll();
}
```

**Pagination missing for large results**
```java
// ⚠️ MAJOR: 10만 건 전체 로드
@GetMapping("/orders")
public List<Order> getAllOrders() {
    return orderRepository.findAll();  // OOM 위험
}

// ✅ CORRECT: Pageable
@GetMapping("/orders")
public Page<Order> getAllOrders(Pageable pageable) {
    return orderRepository.findAll(pageable);
}
```

### Algorithm Complexity

**O(n²) when O(n) possible**
```java
// ⚠️ MAJOR: Nested loop
for (User user : users) {
    for (Order order : orders) {
        if (order.getUserId().equals(user.getId())) {
            user.addOrder(order);  // O(n²)
        }
    }
}

// ✅ CORRECT: Map lookup O(n)
Map<Long, List<Order>> ordersByUserId = orders.stream()
    .collect(Collectors.groupingBy(Order::getUserId));

for (User user : users) {
    user.setOrders(ordersByUserId.get(user.getId()));
}
```


### Caching Opportunities

**Repeated DB queries for static data**
```java
// ⚠️ MAJOR: 매 요청마다 DB 조회
@GetMapping("/countries")
public List<Country> getCountries() {
    return countryRepository.findAll();  // Static data
}

// ✅ CORRECT: @Cacheable
@Cacheable("countries")
@GetMapping("/countries")
public List<Country> getCountries() {
    return countryRepository.findAll();
}
```

**No cache invalidation strategy**
```java
// ⚠️ MAJOR: 수정 시 캐시 갱신 안 함
@PostMapping("/users")
public User createUser(@RequestBody User user) {
    return userRepository.save(user);  // Cache에 반영 안 됨
}

// ✅ CORRECT: @CacheEvict
@CacheEvict(value = "users", allEntries = true)
@PostMapping("/users")
public User createUser(@RequestBody User user) {
    return userRepository.save(user);
}
```

---

## 🔵 Minor Performance Issues

### Stream Overhead (Profile First)

**Stream for trivial operations on small collections**
```java
// ⚠️ MINOR: Only flag if profiling shows this is a bottleneck
List<String> names = users.stream()
    .map(User::getName)
    .collect(Collectors.toList());

// ✅ BETTER: Only if this code is in a hot path
List<String> names = new ArrayList<>(users.size());
for (User user : users) {
    names.add(user.getName());
}
```

**Note**: Modern JVMs optimize Stream well. Don't suggest this unless:
- The collection is accessed millions of times per second (hot path)
- Profiling shows Stream allocation is the bottleneck
- Readability loss is justified by measured performance gain

### String Operations

**String concatenation in loop**
```java
// ⚠️ MINOR: String + in loop
String result = "";
for (String s : list) {
    result += s + ",";  // Creates new String object each iteration
}

// ✅ BETTER: StringBuilder
StringBuilder sb = new StringBuilder();
for (String s : list) {
    sb.append(s).append(",");
}
String result = sb.toString();

// ✅ BEST: String.join (JDK 8+)
String result = String.join(",", list);
```

### Collection Sizing

**ArrayList without initial capacity**
```java
// ⚠️ MINOR: Resizing overhead
List<User> users = new ArrayList<>();
for (int i = 0; i < 1000; i++) {
    users.add(fetchUser(i));  // Internal array resizing
}

// ✅ BETTER: Pre-size
List<User> users = new ArrayList<>(1000);
```

### Lazy Initialization

**Eager loading of heavy objects**
```java
// ⚠️ MINOR: 사용 안 할 수도 있는데 미리 로드
private static final HeavyObject obj = new HeavyObject();  // Startup delay

// ✅ BETTER: Lazy initialization
private static volatile HeavyObject obj;

public static HeavyObject getInstance() {
    if (obj == null) {
        synchronized (ClassName.class) {
            if (obj == null) {
                obj = new HeavyObject();
            }
        }
    }
    return obj;
}
```

---

## DevCenter 특화 성능 규칙

### 1. API Response Time Target
- **P50**: < 100ms
- **P95**: < 500ms
- **P99**: < 1s

초과 시 최적화 필요:
- Query 분석 (EXPLAIN)
- Index 추가
- Caching 도입

### 2. Kafka Consumer Batch Size
```java
// DevCenter 기본값
@KafkaListener(
    topics = "events",
    containerFactory = "batchFactory"  // Batch size: 100
)
public void consume(List<Event> events) {
    // Batch processing
}
```

---

## Benchmarking Guidelines

### When to Profile
- API 응답 시간 > 500ms (P95)
- DB query 실행 시간 > 100ms
- 메모리 사용량 증가 추세 (GC 빈번)

### Profiling Tools
```bash
# JVM profiling
java -agentlib:hprof=cpu=samples,depth=10 -jar app.jar

# Query logging
spring.jpa.show-sql=true
spring.jpa.properties.hibernate.format_sql=true

# Actuator metrics
management.endpoints.web.exposure.include=metrics,health
```

### Optimization Priority
1. **Database queries** (가장 큰 영향)
   - N+1 제거
   - Index 추가
   - Query tuning
2. **Caching** (읽기 많은 데이터)
   - Static/Reference data
   - Computed results
3. **Algorithm** (복잡도 개선)
   - O(n²) → O(n log n)
4. **String/Collection** (미세 최적화)
   - 마지막 수단

---

## Performance Testing Checklist

리뷰 시 다음 질문:
- [ ] 이 코드가 100배 더 많은 데이터를 처리하면?
- [ ] 동시 요청 100개가 들어오면?
- [ ] 캐시가 꽉 차면 어떻게 동작하나?
- [ ] DB 연결이 끊기면?
- [ ] 메모리가 부족하면?

**답변이 "모르겠다"면 성능 리스크 있음**

---

## False Positive Prevention

**JPA는 Lazy Loading이 기본**
```java
// ❌ WRONG: "orders never accessed, remove it"
@OneToMany
private List<Order> orders;  // Lazy fetch is intentional

// ✅ CORRECT: Lazy loading for optional data
```

**Stream은 항상 빠른 게 아님**
```java
// N < 100이고 simple operation이면 loop이 더 빠를 수 있음
// Don't blindly suggest stream conversion
```

---

## Review Output Example

```markdown
## 🔴 Critical Performance Issues

**UserService.java:42** - N+1 Query detected
- `user.getOrders()` triggers 100 separate queries
- Impact: 2초 → 200ms (90% reduction expected)
- Fix: Add `@EntityGraph(attributePaths = "orders")`

## 🟡 Major Performance Issues

**OrderRepository.java:23** - Missing pagination
- `findAll()` loads 50,000 orders into memory
- Risk: OutOfMemoryError with data growth
- Fix: Add `Pageable` parameter, return `Page<Order>`

## ✅ Positive Observations
- Proper use of `@Transactional(readOnly = true)`
- Connection pool sized appropriately (20)
- Appropriate batch size for Kafka (100)
```
