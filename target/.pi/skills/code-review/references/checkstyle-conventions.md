---
tags: [checkstyle, pmd, code-quality, java, ci]
added: 2026-05-19
---

## Context

DevCenter CI enforces Checkstyle and PMD on every build. Violations block the build.
All violations must be fixed in the actual code — lint config changes are forbidden.

## Core Rule

**Fix the code. Never touch `checkstyle.xml` or `suppressions.xml`.**
`// CHECKSTYLE:OFF` is also blocked by the code guardrail gate.

---

## Writing New Code (Prevention)

Apply these rules from the start to avoid violations before they happen.

| Rule | Limit | Correct example |
|------|-------|-----------------|
| `static final` field name | UPPER_SNAKE_CASE | `private static final Logger LOG = ...` |
| Indentation | 4 spaces — no tab characters | Editor: "Insert spaces for tabs" |
| Imports | No wildcards — explicit symbols only | `import static org.mockito.Mockito.mock;` |
| Line length | Max 120 chars | Split with `+` concatenation or line break |
| Method parameter count | Max 7 | Group related params into a `record` |
| Cyclomatic complexity | Max 10 | Use Map lookup or extract private methods |
| Empty record body | `{ }` (space required) | `private record Foo() { }` |

**Complexity design:** Count branches (`if`, `else`, `case`, `catch`, `&&`, `||`, `?:`, `while`, `for`).
If ≥ 5 branches are expected, consider a Map lookup or strategy pattern.

**Parameter design:** If total params exceed 7, extract a record/DTO, use Builder, or split the method.

---

## Violation Fix Patterns

### ConstantNameCheck — `static final` fields must be UPPER_SNAKE_CASE

```java
// Before
private static final Logger log = LoggerFactory.getLogger(Foo.class);

// After
private static final Logger LOG = LoggerFactory.getLogger(Foo.class);
```

Update all references: `log.info(...)` → `LOG.info(...)`.

---

### FileTabCharacterCheck — No tab characters; use 4 spaces

Use the Edit tool to replace tab characters with 4 spaces in the affected lines. For files with many tab violations, use the Write tool to rewrite the corrected content.

---

### AvoidStarImportCheck — No wildcard imports

```java
// Before
import static org.mockito.Mockito.*;

// After
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
```

List only the symbols actually used in the file.

---

### LineLengthCheck — Max 120 chars per line

Split long strings with `+`. This is a compile-time constant expression (JLS §15.29) — no runtime cost.

```java
// Before (512 chars on one line)
@TestPropertySource(properties = {"spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,..."})

// After
@TestPropertySource(properties = {
    "spring.autoconfigure.exclude="
        + "org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,"
        + "org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration"
})
```

Applies to `@Disabled`, `@Sql`, JSON strings, and any annotation attribute.

---

### ParameterNumberCheck — Max 7 parameters per method

Group related parameters into a test-private `record`.

```java
// Before: 8 params (violation)
private static Row row(long id, int tokenType, String tokenId, ...) { ... }

// After: 7 params (passes)
private record Token(int type, String id) { }  // empty body: { } with space — WhitespaceAroundCheck

private static Row row(long id, Token token, ...) {
    return builder
        .tokenType(token.type())
        .tokenId(token.id())
        .build();
}
// Call site: row(1L, new Token(1, "tk-id"), ...)
```

> Empty record body must be `{ }` (with space), not `{}` — required by WhitespaceAroundCheck.

---

### CyclomaticComplexityCheck — Max complexity 10

Replace switch-based lookup with a static `Map`.

```java
// Before: each case adds +1 → 9 cases = complexity 10+ (violation)
private String mapToScope(String api) {
    switch (api.toLowerCase()) {
        case "accounts": return "accounts";
        case "market":   return "market";
        // ...
    }
    return null;
}

// After: complexity 2 (Map lookup + null check)
private static final Map<String, String> SCOPE_MAP = Map.of(
    "accounts",      "accounts",
    "characters",    "characters",
    "enhancement",   "enhancement",
    "game_meta",     "gamemeta",
    "items",         "items",
    "reward",        "reward",
    "market",        "market",
    "affiliate",     "affiliate",
    "game_resources","game_resources"
);

private String mapToScope(String api) {
    String name = SCOPE_MAP.get(api.toLowerCase());
    return name != null ? String.format("v1rc1_%s_%s", name, quota) : null;
}
```

> `Map.of()` supports up to 10 key-value pairs. Use `Map.ofEntries(Map.entry(...), ...)` for 11+.

---

## PMD

- `UnnecessaryLocalBeforeReturn`: deprecation warning only, not a build error — safe to ignore.
- Distinguish `WARN` vs `ERROR` in PMD output: only `ERROR` fails the build.

---

## Never Do

| Action | Reason |
|--------|--------|
| Add `SuppressionFilter` to `checkstyle.xml` | Lint config is off-limits |
| Create `suppressions.xml` | Same |
| Add `// CHECKSTYLE:OFF` comments | Code guardrail gate detects this in diffs and blocks commit |
| Commit before fixing violations | CI build fails |
