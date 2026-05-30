# Hook Execution Order & Conflict Analysis

## Current Hook Registration (settings.json)

### PreToolUse(Bash) - 3 hooks
1. `guard-git-push.sh`
2. `guard-git-commit.sh`
3. `guard-coverage.sh` ✅ NEWLY ADDED

### PreToolUse(Edit) - 4 hooks
1. `code-guardrail.js`
2. `guard-persona-reminder.sh`
3. `guard-test-first.sh`
4. `guard-arch-governance.sh`

### PreToolUse(Write) - 4 hooks
1. `code-guardrail.js`
2. `guard-persona-reminder.sh`
3. `guard-test-first.sh`
4. `guard-arch-governance.sh`

### PreToolUse(Skill) - 1 hook
1. `guard-skill-prereqs.sh`

### PostToolUse(Write) - 2 hooks
1. `validate-feat-html.js`
2. `validate-feat-index.js`

---

## Execution Flow Analysis

### Scenario 1: git commit with no approval gate

```
Bash("git commit -m 'feat: add Service'")
  ↓
PreToolUse hooks execute sequentially:
  ↓
1. guard-git-push.sh
   - Check: git push pattern?
   - Result: NO (only checks "git push")
   - Action: exit 0 (pass)
  ↓
2. guard-git-commit.sh
   - Check: git commit pattern?
   - Result: YES
   - Check: .commit-gate-session exists?
   - Result: NO
   - Check: .commit-gate exists + fresh?
   - Result: NO
   - Action: deny with "승인 필요" message
   - **BLOCKS HERE** ❌
  ↓
3. guard-coverage.sh
   - **NEVER EXECUTES** (blocked by step 2)
```

**Problem**: Coverage check never runs until user approval is granted.

---

### Scenario 2: git commit with approval gate

```
Bash("git commit -m 'feat: add Service'")
  ↓
PreToolUse hooks execute sequentially:
  ↓
1. guard-git-push.sh
   - Result: exit 0 (pass)
  ↓
2. guard-git-commit.sh
   - Check: git commit pattern?
   - Result: YES
   - Check: .commit-gate exists + fresh?
   - Result: YES (user ran `touch .commit-gate`)
   - Action: exit 0 (pass)
   - Side effects:
     - mv .commit-gate → consumed
     - warn about missing plan (feat/* only)
     - warn about missing tests
     - warn about missing docs
  ↓
3. guard-coverage.sh
   - Check: git commit pattern?
   - Result: YES
   - Extract: changed .java files
   - For each module:
     - Run: ./gradlew test jacocoTestReport
     - Run: ./gradlew jacocoTestCoverageVerification
     - Check: "Rule violated" in output?
   - If any module fails:
     - Action: deny with coverage report
     - **BLOCKS HERE** ❌
   - Else:
     - Action: exit 0 (pass)
  ↓
All hooks passed → git commit executes
```

---

## Recommended Execution Order

**Current**: git-push → git-commit → coverage
**Problem**: Technical check (coverage) happens AFTER procedural check (approval)

**Better**: git-push → coverage → git-commit
**Benefit**: Users fix technical issues BEFORE requesting approval

### Updated settings.json recommendation:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "${PI_PROJECT_DIR}/.pi/hooks/guard-git-push.sh"
    },
    {
      "type": "command",
      "command": "${PI_PROJECT_DIR}/.pi/hooks/guard-coverage.sh"
    },
    {
      "type": "command",
      "command": "${PI_PROJECT_DIR}/.pi/hooks/guard-git-commit.sh"
    }
  ]
}
```

**User flow with new order**:
1. Write code
2. `git commit` → coverage check → BLOCK if < threshold
3. Add tests
4. `git commit` → coverage OK → approval required
5. `touch .commit-gate`
6. `git commit` → all pass → commit succeeds

---

## Conflict Analysis

### No Infinite Loops ✅

**guard-git-commit.sh**:
- Reads: stdin JSON, git status, file system (.commit-gate)
- Writes: JSON to stdout, warns to stderr
- External commands: git, find, grep
- Does NOT trigger: any other hooks

**guard-coverage.sh**:
- Reads: stdin JSON, git status, gradle.properties
- Writes: JSON to stdout
- External commands: git, grep, ./gradlew
- Does NOT trigger: any other hooks

**Conclusion**: No circular dependencies, no infinite loops.

---

### No Resource Conflicts ✅

**File access**:
- guard-git-commit: reads/writes `.commit-gate` (atomic mv)
- guard-coverage: reads `gradle.properties`, writes `build/reports/jacoco/`
- No overlap

**Git operations**:
- Both read `git diff --cached` (read-only)
- No concurrent modifications

**Conclusion**: No resource conflicts.

---

### Side Effects

**guard-git-commit.sh**:
1. Consumes `.commit-gate` file (mv to temp, then rm)
2. Prints warnings to stderr (non-blocking)
3. Reads git state (no modifications)

**guard-coverage.sh**:
1. Runs `./gradlew test` (generates test reports)
2. Runs `./gradlew jacocoTestReport` (generates coverage reports)
3. Runs `./gradlew jacocoTestCoverageVerification` (reads reports, no side effects)
4. Generates files in `build/reports/jacoco/` (harmless)

**Potential issue**: Running tests twice?
- No: coverage check only runs if `.java` files changed
- guard-git-commit doesn't run tests

**Conclusion**: Side effects are isolated.

---

## Performance Impact

**guard-git-commit.sh**: ~50ms
- Pattern matching
- File checks
- find/grep commands

**guard-coverage.sh**: ~10-60s (depending on module)
- `./gradlew test`: 5-30s
- `jacocoTestReport`: 1-5s
- `jacocoTestCoverageVerification`: <1s

**Total delay**: ~10-60s per commit when .java files change

**Mitigation**:
- Only runs when `.java` files in staged changes
- Caches test results (Gradle incremental build)
- Skips if no .java changes

---

## Edge Cases

### 1. Multiple modules changed

```
Changed files:
- api-service/src/main/java/ServiceA.java
- common/src/main/java/UtilB.java

guard-coverage.sh behavior:
- Extracts modules: api-service, common
- Runs coverage check for EACH module
- Fails if ANY module < threshold
```

**Result**: Correct behavior ✅

---

### 2. Only test files changed

```
Changed files:
- api-service/src/test/java/ServiceATest.java

guard-coverage.sh behavior:
- grep -E 'src/main/java/.*\.java$' → NO MATCH
- Skips coverage check
- exit 0
```

**Result**: Correct behavior ✅ (no main code changed, no coverage check needed)

---

### 3. .commit-gate expires during coverage check

```
1. User: touch .commit-gate (10-minute TTL starts)
2. git commit
3. guard-git-commit: .commit-gate valid → pass (consumed)
4. guard-coverage: runs tests (takes 60s)
5. Coverage check passes
6. Commit succeeds
```

**Result**: Works correctly ✅ (gate consumed before coverage check)

---

### 4. Coverage check hangs

```
guard-coverage.sh runs:
./gradlew test jacocoTestReport --console=plain --quiet

If this hangs (infinite loop in test):
- No timeout set → hangs forever
- User must Ctrl+C
```

**Mitigation needed**: Add timeout to guard-coverage.sh
```bash
timeout 300 ./gradlew test jacocoTestReport 2>&1
```

---

## Recommendations

1. ✅ **Reorder hooks**: coverage before commit approval
2. ✅ **Add timeout**: guard-coverage.sh should timeout after 5 min
3. ✅ **Document**: coverage check can be slow, explain in .pi/workflows/coverage-enforcement.md
4. ⚠️ **Consider**: Skip coverage check if COVERAGE_SKIP=1 (emergency bypass)

---

## Final Verdict

**No infinite loops**: ✅
**No resource conflicts**: ✅
**No logical errors**: ✅ (after reordering)
**Performance acceptable**: ⚠️ (10-60s delay, but only when .java changed)
**Side effects isolated**: ✅

**Action items**:
1. Reorder hooks in settings.json
2. Add timeout to guard-coverage.sh
3. Document performance impact
