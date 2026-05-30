# Security Review Checklist

> DevCenter 보안 전문 리뷰 체크리스트

## Scope
- OWASP Top 10 기반 취약점 검증
- Spring Security 설정 검토
- 민감 데이터 처리 검증
- 인증/인가 로직 검증

---

## 🔴 Critical Security Issues

### A01: Broken Access Control

**인가 누락**
```java
// ❌ CRITICAL: 권한 체크 없음
@GetMapping("/admin/users")
public List<User> getAllUsers() {
    return userService.findAll();  // 누구나 접근 가능
}

// ✅ CORRECT
@PreAuthorize("hasRole('ADMIN')")
@GetMapping("/admin/users")
public List<User> getAllUsers() {
    return userService.findAll();
}
```

**IDOR (Insecure Direct Object Reference)**
```java
// ❌ CRITICAL: 다른 사용자 데이터 접근 가능
@GetMapping("/users/{userId}/profile")
public UserProfile getProfile(@PathVariable Long userId) {
    return profileService.findById(userId);  // userId 조작 가능
}

// ✅ CORRECT: 현재 사용자 검증
@GetMapping("/users/{userId}/profile")
public UserProfile getProfile(@PathVariable Long userId,
                               @AuthenticationPrincipal UserDetails currentUser) {
    if (!currentUser.getId().equals(userId)) {
        throw new AccessDeniedException();
    }
    return profileService.findById(userId);
}
```

### A02: Cryptographic Failures

**민감 데이터 평문 저장**
```java
// ❌ CRITICAL: 패스워드 평문 저장
@Column
private String password;  // 암호화 없음

// ✅ CORRECT
@Column
private String encryptedPassword;  // BCrypt 등으로 암호화
```

**약한 암호화 알고리즘**
```java
// ❌ CRITICAL: MD5/SHA1 사용
MessageDigest md = MessageDigest.getInstance("MD5");

// ✅ CORRECT: BCrypt, Argon2, PBKDF2
BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();
```

### A03: Injection

**SQL Injection**
```java
// ❌ CRITICAL: String concatenation
@Query("SELECT u FROM User u WHERE u.email = '" + email + "'")
List<User> findByEmail(String email);

// ✅ CORRECT: Parameterized query
@Query("SELECT u FROM User u WHERE u.email = :email")
List<User> findByEmail(@Param("email") String email);
```

**JPQL Injection**
```java
// ❌ CRITICAL: Dynamic query building
String jpql = "SELECT u FROM User u WHERE u.name = '" + name + "'";
entityManager.createQuery(jpql).getResultList();

// ✅ CORRECT: Named parameters
entityManager.createQuery("SELECT u FROM User u WHERE u.name = :name")
    .setParameter("name", name)
    .getResultList();
```

**Command Injection**
```java
// ❌ CRITICAL: User input in system command
Runtime.getRuntime().exec("ls " + userInput);

// ✅ CORRECT: ProcessBuilder with validated input
ProcessBuilder pb = new ProcessBuilder("ls", sanitized);
```

### A04: Insecure Design

**인증 없는 민감 작업**
```java
// ❌ CRITICAL: 비밀번호 재설정 토큰 없이
@PostMapping("/reset-password")
public void resetPassword(@RequestParam String email,
                          @RequestParam String newPassword) {
    userService.updatePassword(email, newPassword);
}

// ✅ CORRECT: 토큰 검증
@PostMapping("/reset-password")
public void resetPassword(@RequestParam String token,
                          @RequestParam String newPassword) {
    if (!tokenService.validateToken(token)) {
        throw new UnauthorizedException();
    }
    userService.updatePasswordByToken(token, newPassword);
}
```

### A05: Security Misconfiguration

**민감 정보 노출**
```java
// ❌ CRITICAL: Stack trace 노출
@ExceptionHandler(Exception.class)
public ResponseEntity<?> handle(Exception e) {
    return ResponseEntity.status(500).body(e.getMessage());  // 내부 정보 노출
}

// ✅ CORRECT: Generic error message
@ExceptionHandler(Exception.class)
public ResponseEntity<?> handle(Exception e) {
    log.error("Internal error", e);  // 로그에만 기록
    return ResponseEntity.status(500).body("Internal server error");
}
```

**CORS 설정 오류**
```java
// ❌ CRITICAL: 모든 origin 허용
@CrossOrigin(origins = "*")

// ✅ CORRECT: 명시적 origin 제한
@CrossOrigin(origins = "https://devcenter.nexon.com")
```

### A07: Identification and Authentication Failures

**약한 세션 관리**
```java
// ❌ CRITICAL: 세션 고정 공격 취약
session.setAttribute("user", user);  // 로그인 후 세션 ID 재생성 안 함

// ✅ CORRECT: 세션 재생성
request.getSession().invalidate();
request.getSession(true).setAttribute("user", user);
```

**브루트 포스 방어 없음**
```java
// ❌ CRITICAL: 무제한 로그인 시도
@PostMapping("/login")
public void login(@RequestParam String email, @RequestParam String password) {
    authService.authenticate(email, password);
}

// ✅ CORRECT: Rate limiting
@RateLimiter(key = "#email", limit = 5, duration = "5m")
@PostMapping("/login")
public void login(@RequestParam String email, @RequestParam String password) {
    authService.authenticate(email, password);
}
```

### A08: Software and Data Integrity Failures

**신뢰할 수 없는 역직렬화**
```java
// ❌ CRITICAL: 검증 없는 역직렬화
ObjectInputStream ois = new ObjectInputStream(inputStream);
MyObject obj = (MyObject) ois.readObject();  // RCE 가능

// ✅ CORRECT: JSON 사용 또는 whitelist 검증
ObjectMapper mapper = new ObjectMapper();
MyObject obj = mapper.readValue(json, MyObject.class);
```

### A09: Security Logging and Monitoring Failures

**민감 작업 로깅 누락**
```java
// ❌ CRITICAL: 권한 변경 로그 없음
public void grantAdminRole(Long userId) {
    userService.addRole(userId, "ADMIN");
}

// ✅ CORRECT: 감사 로그 기록
public void grantAdminRole(Long userId, @AuthenticationPrincipal UserDetails actor) {
    auditLog.info("ROLE_GRANT: user={}, role=ADMIN, actor={}", userId, actor.getUsername());
    userService.addRole(userId, "ADMIN");
}
```

**민감 정보 로깅**
```java
// ❌ CRITICAL: 패스워드 로그 노출
log.info("Login attempt: email={}, password={}", email, password);

// ✅ CORRECT: 민감 정보 마스킹
log.info("Login attempt: email={}", email);
```

### A10: Server-Side Request Forgery (SSRF)

**검증 없는 URL 요청**
```java
// ❌ CRITICAL: User-controlled URL
@GetMapping("/proxy")
public String fetchUrl(@RequestParam String url) {
    return restTemplate.getForObject(url, String.class);  // SSRF 가능
}

// ✅ CORRECT: URL whitelist 검증
@GetMapping("/proxy")
public String fetchUrl(@RequestParam String url) {
    if (!allowedDomains.contains(extractDomain(url))) {
        throw new SecurityException("Domain not allowed");
    }
    return restTemplate.getForObject(url, String.class);
}
```

---

## 🟡 Major Security Issues

### Input Validation

**XSS (Cross-Site Scripting)**
```java
// ⚠️ MAJOR: HTML 이스케이프 없음
@GetMapping("/comment/{id}")
public String getComment(@PathVariable Long id) {
    return commentService.findById(id).getContent();  // <script> 포함 가능
}

// ✅ CORRECT: Spring의 자동 이스케이프 또는 명시적 sanitization
@GetMapping("/comment/{id}")
public CommentDto getComment(@PathVariable Long id) {
    return commentService.findById(id);  // DTO로 반환, Thymeleaf가 자동 이스케이프
}
```

**Path Traversal**
```java
// ⚠️ MAJOR: 경로 조작 가능
@GetMapping("/files/{filename}")
public ResponseEntity<Resource> downloadFile(@PathVariable String filename) {
    Path path = Paths.get("/uploads/" + filename);  // ../../etc/passwd 가능
    return ResponseEntity.ok(new FileSystemResource(path));
}

// ✅ CORRECT: 경로 정규화 및 검증
@GetMapping("/files/{filename}")
public ResponseEntity<Resource> downloadFile(@PathVariable String filename) {
    Path path = Paths.get("/uploads/").resolve(filename).normalize();
    if (!path.startsWith("/uploads/")) {
        throw new SecurityException("Invalid path");
    }
    return ResponseEntity.ok(new FileSystemResource(path));
}
```

### Token Security

**JWT 검증 누락**
```java
// ⚠️ MAJOR: Signature 검증 안 함
Jwt jwt = Jwts.parser().parse(token);

// ✅ CORRECT: Signature 검증
Jwt jwt = Jwts.parserBuilder()
    .setSigningKey(secretKey)
    .build()
    .parseClaimsJws(token);
```

**토큰 만료 체크 누락**
```java
// ⚠️ MAJOR: 만료된 토큰도 허용
Claims claims = getClaims(token);
String userId = claims.getSubject();

// ✅ CORRECT: 만료 검증
Claims claims = getClaims(token);
if (claims.getExpiration().before(new Date())) {
    throw new TokenExpiredException();
}
```

---

## 🔵 Minor Security Issues

### Security Headers

**보안 헤더 누락**
```java
// ⚠️ MINOR: X-Content-Type-Options 없음
@GetMapping("/api/data")
public ResponseEntity<Data> getData() {
    return ResponseEntity.ok(data);
}

// ✅ BETTER: Security headers 추가
@GetMapping("/api/data")
public ResponseEntity<Data> getData() {
    return ResponseEntity.ok()
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY")
        .body(data);
}
```

### Secure Coding

**민감 정보 하드코딩**
```java
// ⚠️ MINOR: API key 하드코딩
private static final String API_KEY = "abc123";

// ✅ BETTER: 환경 변수 또는 @Value
@Value("${api.key}")
private String apiKey;
```

---

## DevCenter 특화 보안 규칙

### 1. OAuth 토큰 처리
- Access token은 HTTP-only cookie에 저장 (LocalStorage 금지)
- Refresh token은 Secure + HTTP-only 속성 필수

### 2. 내부 API 보안
- 외부 노출 API: `/api/public/**` 경로만
- 내부 API: `/api/internal/**`는 IP whitelist 또는 내부 인증 필수

### 3. 감사 로그 필수 작업
- 사용자 권한 변경
- 민감 데이터 조회/수정 (개인정보, 결제 정보)
- 설정 변경

---

## Review Prioritization

**릴리즈 블로커 (즉시 수정):**
- SQL Injection
- 인증/인가 우회
- 민감 데이터 평문 저장
- RCE 가능 취약점

**릴리즈 전 수정 필요:**
- XSS, CSRF
- 보안 로깅 누락
- 약한 암호화
- SSRF

**개선 권장:**
- 보안 헤더 누락
- 하드코딩된 시크릿
- Rate limiting 없음
