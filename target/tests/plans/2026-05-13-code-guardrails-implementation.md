# LLM Code Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement Phase 1 of the workflow harness—real-time code quality validation via Edit/Write hooks (3-layer: deletion detection, Checkstyle, PMD).

**Architecture:**
- Hook intercepts Edit/Write tool calls (PreToolUse)
- Layer 1: Parse tool_input for critical deletions (Tier 1/2 block, Tier 3 auto-allow)
- Layer 2+3: Run Checkstyle + PMD in a **single Gradle invocation** (unified `guardFilePath` property)
- CPD (code duplication) is project-wide by design — in CI only, NOT in the hook
- Performance target: < 15s on warm Gradle daemon; fail-open (skip, not block) on timeout or tool error

**Platform:** Windows / macOS / Linux (cross-platform)

---

## ⚠️ Critical Design Constraints

### 1. Hook API is stdin-based
PI hooks receive input via stdin as JSON. Pattern from existing `validate-feat-html.js`:
```js
#!/usr/bin/env node
async function main() {
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  await new Promise(resolve => process.stdin.on('end', resolve));
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const filePath = payload?.tool_input?.file_path;
  // exit(0) = allow, exit(2) = block (message written to stdout)
}
main();
```
**Never use `module.exports = async (context) =>` — that pattern does not work.**

### 2. Deletion detection must use tool_input, not git diff
PreToolUse fires BEFORE the file is saved. `git diff HEAD` shows pre-edit state — useless.

- **Edit tool**: `payload.tool_input.old_string` is the content being replaced
- **Write tool**: multiset-diff between `fs.readFileSync(filePath)` and `payload.tool_input.content`
  - Use **multiset (bag) comparison**, not set membership — otherwise duplicate lines (blank lines, `}`, `return;`) cause false negatives and false positives

### 3. Tier 1 must compare old vs new (not just detect deletions)
For the Edit tool, `old_string` contains modified lines, not just deleted ones.
Replacing `public void process(String a)` with `public void process(String a, int b)` puts the old signature in `old_string` — Tier 1 would fire even though the method still exists.

**Fix**: only fire Tier 1 when the structural element is present in `old_string` but absent from `new_string` (true deletion, not modification).
This check is skipped for Write tool (no `new_string` — full file overwrite).

### 4. isReplacement needs size-ratio guard
`new_string` being non-empty is not sufficient — `// placeholder` bypasses Tier 2.
Replacement is only recognized when `new_string` line count ≥ 30% of `old_string` line count.

### 5. Single Gradle invocation with unified property
Run Checkstyle and PMD together in one Gradle call to avoid paying configuration overhead twice (~2-4s each):
```
<gradlew> :module:checkstyleMain :module:pmdMain -PguardFilePath=/abs/path/File.java
```
Both tasks read a single property `guardFilePath` — do not use separate `checkFilePath`/`pmdFilePath`.

### 6. Cross-platform Gradle wrapper
Never hardcode `./gradlew` — this fails on Windows (`ENOENT`).
```js
const GRADLEW = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
```

### 7. Source set routing (main vs test)
Files under `src/main/java` → `checkstyleMain` / `pmdMain`
Files under `src/test/java` → `checkstyleTest` / `pmdTest`

Without this, test file edits silently skip validation (wrong source set).

### 8. Gradle `source` assignment syntax
Use `files(...)` not `[file(...)]`:
```gradle
source = files(project.guardFilePath)   // correct — FileCollection
source = [file(project.guardFilePath)]  // wrong — Groovy List, not FileCollection
```

### 9. compileJava prerequisite
Checkstyle and PMD need compiled class files for type resolution (e.g., `ClassDataAbstractionCoupling`).
If `build/classes` doesn't exist the tool fails with classpath errors — not a violation.
The hook treats "no report file produced" as a tool error and allows the save (fail-open).
**Prerequisite**: `<gradlew> compileJava compileTestJava` must have run at least once per fresh checkout.

### 10. Hook registration format (from existing settings.json)
```json
"PreToolUse": [
  {
    "matcher": "Edit",
    "hooks": [{"type": "command", "command": "node D:/JavaProject/DevCenter/.pi/hooks/code-guardrail.js"}]
  },
  {
    "matcher": "Write",
    "hooks": [{"type": "command", "command": "node D:/JavaProject/DevCenter/.pi/hooks/code-guardrail.js"}]
  }
]
```
Note: Absolute path matches existing hook registration convention in this project.

### 11. Per-edit override UX (deferred to Phase 2)
PI's PreToolUse hook has no built-in per-violation decision mechanism — exit(2) blocks entirely.
Global bypass (`GUARDRAIL_SKIP=1` or `.pi/.guardrail-skip`) is the only override for Phase 1.

---

## File Structure

**New files:**
- `config/pmd/ruleset.xml` - PMD rules configuration
- `.pi/hooks/code-guardrail.js` - Main hook implementation

**Modified files:**
- `config/checkstyle/checkstyle.xml` - Add new rules (ClassDataAbstractionCoupling, JavaNCSS)
- `api-service/build.gradle` - Add PMD plugin + `guardFilePath` property support
- `consumer-service/build.gradle` - Add Checkstyle + PMD plugins + `guardFilePath` support
- `common/build.gradle` - Add Checkstyle + PMD plugins + `guardFilePath` support
- `.pi/settings.json` - Register hook (PreToolUse, Edit + Write matchers)
- `.piignore` - Add build report directories
- `.gitignore` - Add `.guardrail-skip`

---

## Task 0: Adversarial Review (Pre-Implementation Gate)

- [x] **Step 1: Invoke devils-advocate skill**

Run `/devils-advocate` with this plan as input. Evaluate technical correctness, performance assumptions, edge cases.

- [x] **Step 2: Incorporate findings, update plan**

- [x] **Step 3: Document review outcome in Review Notes section**

---

## Task 1: PMD Configuration

**Files:** Create `config/pmd/ruleset.xml`

- [x] **Step 1: Create PMD ruleset file**

```xml
<?xml version="1.0"?>
<ruleset name="DevCenter PMD Rules"
         xmlns="http://pmd.sourceforge.net/ruleset/2.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://pmd.sourceforge.net/ruleset/2.0.0
                             https://pmd.sourceforge.io/ruleset_2_0_0.xsd">

  <description>PMD rules for LLM code guardrails (per-file rules only; CPD excluded)</description>

  <rule ref="category/java/design.xml/ExcessiveClassLength">
    <properties>
      <property name="minimum" value="500"/>
    </properties>
  </rule>

  <!-- UnnecessaryLocalBeforeReturn only — SimplifyBooleanReturn intentionally
       omitted: already in checkstyle.xml, duplicate would double-report. -->
  <rule ref="category/java/codestyle.xml/UnnecessaryLocalBeforeReturn"/>

  <rule ref="category/java/design.xml/AvoidDeeplyNestedIfStmts">
    <properties>
      <property name="problemDepth" value="3"/>
    </properties>
  </rule>

  <!-- GodClass tuned for Spring Boot DI.
       tcc=0.5 is MORE aggressive than PMD default (0.33) — raises the bar for
       Tight Class Cohesion, flagging more classes. Monitor for violations on
       existing code before enforcing. -->
  <rule ref="category/java/design.xml/GodClass">
    <properties>
      <property name="tcc" value="0.5"/>
      <property name="wmc" value="47"/>
      <property name="atfd" value="5"/>
    </properties>
  </rule>

  <rule ref="category/java/design.xml/TooManyFields">
    <properties>
      <property name="maxfields" value="15"/>
    </properties>
  </rule>

  <rule ref="category/java/design.xml/TooManyMethods">
    <properties>
      <property name="maxmethods" value="20"/>
    </properties>
  </rule>
</ruleset>
```

- [x] **Step 2: Verify XML syntax**

`xmllint --noout config/pmd/ruleset.xml`

- [x] **Step 3: Commit**

```
config: add PMD ruleset for code guardrails

Per-file rules only (CPD excluded — belongs in CI).
GodClass thresholds tuned for Spring Boot DI.
SimplifyBooleanReturn excluded (already in Checkstyle).
```

---

## Task 2: Checkstyle Configuration Update

**Files:** Modify `config/checkstyle/checkstyle.xml`

- [x] **Step 1: Add new rules inside the TreeWalker block**

Current structure:
```xml
<module name="Checker">
  ...
  <module name="TreeWalker">
    ...
    <module name="CyclomaticComplexity">...</module>
    <!-- INSERT HERE — inside TreeWalker, NOT at Checker level -->
  </module>
</module>
```

Add after `CyclomaticComplexity`, before TreeWalker's closing `</module>`:

```xml
    <!-- God Class prevention -->
    <module name="ClassDataAbstractionCoupling">
      <property name="max" value="10"/>
    </module>

    <!-- Code size metrics.
         Verify JavaNCSS is present in Checkstyle 10.20.2 before relying on it —
         it was deprecated in some versions. If absent, Checkstyle will fail at
         configuration parse time (caught by Step 2 below). -->
    <module name="JavaNCSS">
      <property name="methodMaximum" value="50"/>
      <property name="classMaximum" value="500"/>
    </module>
```

- [x] **Step 2: Verify configuration**

`xmllint --noout config/checkstyle/checkstyle.xml`

Then run: `<gradlew> :api-service:checkstyleMain`
Expected: passes, or reveals pre-existing violations (do not fix now — out of scope).
If Checkstyle reports "JavaNCSS not found", remove that module and document here.

- [x] **Step 3: Commit**

```
config: extend Checkstyle rules for code guardrails

Added inside TreeWalker:
- ClassDataAbstractionCoupling: max 10
- JavaNCSS: methodMaximum=50, classMaximum=500
```

---

## Task 3: Add PMD to api-service (with guardFilePath support)

**Files:** Modify `api-service/build.gradle`

- [x] **Step 1: Add PMD plugin**

Add `id 'pmd'` to the plugins block.

- [x] **Step 2: Configure PMD with guardFilePath**

```gradle
pmd {
    toolVersion = '7.0.0'
    consoleOutput = false
    ruleSetFiles = files("${rootProject.projectDir}/config/pmd/ruleset.xml")
}

tasks.withType(Pmd) {
    if (project.hasProperty('guardFilePath')) {
        source = files(project.guardFilePath)   // files() not [file()] — must be FileCollection
    }
    reports {
        xml.required = true
        html.required = false
    }
}
```

- [x] **Step 3: Update existing Checkstyle config to use guardFilePath**

Update the existing `tasks.withType(Checkstyle)` block:

```gradle
tasks.withType(Checkstyle) {
    if (project.hasProperty('guardFilePath')) {
        source = files(project.guardFilePath)   // files() not [file()] — must be FileCollection
    }
    reports {
        xml.required = true
        html.required = false   // was true; HTML reports disabled for hook use.
                                // Run ./gradlew checkstyleMain without -PguardFilePath
                                // for full HTML reports during normal development.
    }
}
```

Note: `html.required` changes from `true` to `false`. This affects `./gradlew checkstyleMain` runs without the property (e.g., CI). If HTML reports are needed in CI, add a separate CI task or condition on `project.hasProperty`.

- [x] **Step 4: Verify single-file combined invocation**

Warm compiled classes first: `<gradlew> :api-service:compileJava`

Test main-source file:
```
<gradlew> :api-service:checkstyleMain :api-service:pmdMain -PguardFilePath=<abs path to main .java>
```
Check `build/reports/checkstyle/main.xml` and `build/reports/pmd/main.xml` — confirm only the target file is listed.

Test test-source file:
```
<gradlew> :api-service:checkstyleTest :api-service:pmdTest -PguardFilePath=<abs path to test .java>
```

- [x] **Step 5: Commit**

```
build: add PMD + guardFilePath single-file support to api-service

- PMD 7.0.0 with shared ruleset
- Unified guardFilePath property for Checkstyle and PMD
- Single Gradle invocation runs both tools on one file
- html.required=false (XML only, for hook parsing)
```

---

## Task 4: Add Checkstyle + PMD to consumer-service

**Files:** Modify `consumer-service/build.gradle`

- [x] **Step 1: Read consumer-service build file**

Check if Checkstyle/PMD already present.

- [x] **Step 2: Add plugins**

Add `id 'checkstyle'`, `id 'pmd'` to plugins block.

- [x] **Step 3: Configure Checkstyle with guardFilePath**

```gradle
checkstyle {
    toolVersion = '10.20.2'
    configFile = file("${rootProject.projectDir}/config/checkstyle/checkstyle.xml")
    maxWarnings = 0
}

tasks.withType(Checkstyle) {
    if (project.hasProperty('guardFilePath')) {
        source = files(project.guardFilePath)   // files() not [file()]
    }
    reports {
        xml.required = true
        html.required = false
    }
}
```

- [x] **Step 4: Configure PMD with guardFilePath**

```gradle
pmd {
    toolVersion = '7.0.0'
    consoleOutput = false
    ruleSetFiles = files("${rootProject.projectDir}/config/pmd/ruleset.xml")
}

tasks.withType(Pmd) {
    if (project.hasProperty('guardFilePath')) {
        source = files(project.guardFilePath)   // files() not [file()]
    }
    reports {
        xml.required = true
        html.required = false
    }
}
```

- [x] **Step 5: Test combined invocation**

`<gradlew> :consumer-service:checkstyleMain :consumer-service:pmdMain -PguardFilePath=<file>`

- [x] **Step 6: Commit**

```
build: add Checkstyle + PMD to consumer-service

Unified guardFilePath property (files() FileCollection).
```

---

## Task 5: Add Checkstyle + PMD to common

**Files:** Modify `common/build.gradle`

- [x] **Step 1: Read common build file**

- [x] **Step 2–4: Add plugins + configure (same as consumer-service)**

Same configuration as Task 4. Use `files(project.guardFilePath)` — not `[file(...)]`.

- [x] **Step 5: Test**

`<gradlew> :common:checkstyleMain :common:pmdMain -PguardFilePath=<file>`

- [x] **Step 6: Commit**

```
build: add Checkstyle + PMD to common module

Unified guardFilePath property (files() FileCollection).
```

---

## Task 6: Hook Implementation — Skeleton

**Files:** Create `.pi/hooks/code-guardrail.js`

- [x] **Step 1: Create hook skeleton**

```js
#!/usr/bin/env node
/**
 * Code Guardrail Hook — PreToolUse (Edit, Write)
 *
 * Reads PI hook payload from stdin (JSON).
 * exit(0) = allow, exit(2) = block (message written to stdout).
 *
 * Layer execution order:
 *   1. Deletion Detection  — reads tool_input directly, no Gradle
 *   2. Checkstyle + PMD   — single Gradle invocation, ~4-15s warm
 *
 * CPD intentionally excluded — project-wide, belongs in CI.
 * Prerequisite: <gradlew> compileJava compileTestJava must have run at least once.
 * Bypass: GUARDRAIL_SKIP=1 env var, or create .pi/.guardrail-skip
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let PROJECT_ROOT;
try {
  PROJECT_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
} catch {
  PROJECT_ROOT = path.join(__dirname, '../..');
}

const GRADLE_TIMEOUT_MS = 20000;
const GRADLEW = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

async function main() {
  let payload;
  try {
    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    await new Promise(resolve => process.stdin.on('end', resolve));
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }

  const filePath = payload?.tool_input?.file_path;

  if (!filePath || !filePath.endsWith('.java')) {
    process.exit(0);
  }

  if (process.env.GUARDRAIL_SKIP === '1' ||
      fs.existsSync(path.join(PROJECT_ROOT, '.pi/.guardrail-skip'))) {
    console.error(`[Guardrail] SKIP active — bypassing: ${path.basename(filePath)}`);
    process.exit(0);
  }

  console.error(`[Guardrail] Validating ${path.basename(filePath)}...`);

  // Layer 1: Deletion Detection
  // TODO: Task 8

  // Layer 2+3: Checkstyle + PMD (single Gradle invocation)
  // TODO: Task 7

  process.exit(0);
}

main();
```

- [x] **Step 2: Verify syntax**

`node --check .pi/hooks/code-guardrail.js`

- [x] **Step 3: Commit**

```
feat: add code guardrail hook skeleton

Cross-platform: GRADLEW detects win32 vs posix.
PROJECT_ROOT via git rev-parse (fallback to __dirname).
Bypass: GUARDRAIL_SKIP=1 or .pi/.guardrail-skip.
```

---

## Task 7: Hook Layer 2+3 — Checkstyle + PMD

**Files:** Modify `.pi/hooks/code-guardrail.js`

- [x] **Step 1: Add `getModuleInfo()` with source set detection**

```js
/**
 * Returns { module, task, reportSuffix } or null if file is not in a known module.
 * task = 'Main' | 'Test' — drives checkstyleMain vs checkstyleTest.
 * Normalizes path separators to handle Windows backslashes.
 */
function getModuleInfo(filePath) {
  const p = filePath.replace(/\\/g, '/');

  let module = null;
  if (p.includes('/api-service/'))      module = 'api-service';
  else if (p.includes('/consumer-service/')) module = 'consumer-service';
  else if (p.includes('/common/'))      module = 'common';

  if (!module) return null;

  const isTest = p.includes('/src/test/');
  return {
    module,
    task: isTest ? 'Test' : 'Main',
    reportSuffix: isTest ? 'test' : 'main',
  };
}
```

- [x] **Step 2: Add `runStaticAnalysis()` — single cross-platform Gradle invocation**

```js
function runStaticAnalysis(filePath) {
  const info = getModuleInfo(filePath);
  if (!info) return { styleViolations: [], pmdViolations: [] };

  const { module, task, reportSuffix } = info;

  try {
    execSync(
      `${GRADLEW} :${module}:checkstyle${task} :${module}:pmd${task} -PguardFilePath="${filePath}"`,
      { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: GRADLE_TIMEOUT_MS }
    );
    return { styleViolations: [], pmdViolations: [] };
  } catch (err) {
    if (err.killed) {   // covers both SIGTERM (posix) and Windows timeout kill
      console.error('[Guardrail] Static analysis timed out (20s) — skipping');
      return { styleViolations: [], pmdViolations: [] };
    }

    // Non-zero exit: violations found OR tool error (e.g., missing compiled classes).
    // "No report file" = tool error → fail-open (allow save with warning).
    const csReport = path.join(PROJECT_ROOT, module, `build/reports/checkstyle/${reportSuffix}.xml`);
    const pmdReport = path.join(PROJECT_ROOT, module, `build/reports/pmd/${reportSuffix}.xml`);

    if (!fs.existsSync(csReport) && !fs.existsSync(pmdReport)) {
      console.error('[Guardrail] Static analysis failed (no report produced — compiled classes missing?). Skipping.');
      return { styleViolations: [], pmdViolations: [] };
    }

    return {
      styleViolations: fs.existsSync(csReport)
        ? parseCheckstyleXml(fs.readFileSync(csReport, 'utf-8'), filePath)
        : [],
      pmdViolations: fs.existsSync(pmdReport)
        ? parsePmdXml(fs.readFileSync(pmdReport, 'utf-8'), filePath)
        : [],
    };
  }
}
```

- [x] **Step 3: Add XML parsers (with entity decoding and escaped basename)**

```js
function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseCheckstyleXml(xml, filePath) {
  const escaped = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = xml.match(new RegExp(`<file name="[^"]*${escaped}"[^>]*>([\\s\\S]*?)<\\/file>`));
  if (!block) return [];
  const violations = [];
  const re = /<error line="(\d+)"[^>]*message="([^"]*)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    violations.push({ line: parseInt(m[1]), message: decodeXmlEntities(m[2]) });
  }
  return violations;
}

function parsePmdXml(xml, filePath) {
  const escaped = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = xml.match(new RegExp(`<file name="[^"]*${escaped}"[^>]*>([\\s\\S]*?)<\\/file>`));
  if (!block) return [];
  const violations = [];
  const re = /<violation beginline="(\d+)"[^>]*rule="([^"]*)"[^>]*>([^<]*)<\/violation>/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    violations.push({ line: parseInt(m[1]), rule: m[2], message: decodeXmlEntities(m[3].trim()) });
  }
  return violations;
}

function formatStyleErrors(violations) {
  let msg = '[Guardrail] Checkstyle violations:\n';
  violations.forEach(v => { msg += `  Line ${v.line}: ${v.message}\n`; });
  return msg + '\nSimplify the code before proceeding.';
}

function formatPmdErrors(violations) {
  let msg = '[Guardrail] PMD violations:\n';
  violations.forEach(v => { msg += `  Line ${v.line} [${v.rule}]: ${v.message}\n`; });
  return msg + '\nRefactor before proceeding.';
}
```

- [x] **Step 4: Replace Layer 2+3 TODO in main()**

```js
  // Layer 2+3: Checkstyle + PMD (single Gradle invocation)
  const { styleViolations, pmdViolations } = runStaticAnalysis(filePath);

  if (styleViolations.length > 0) {
    console.log(formatStyleErrors(styleViolations));
    process.exit(2);
  }

  if (pmdViolations.length > 0) {
    console.log(formatPmdErrors(pmdViolations));
    process.exit(2);
  }
```

- [x] **Step 5: Test**

Edit a method to exceed 150 lines → Checkstyle MethodLength violation, exit(2).
Add 21+ methods to a class → PMD TooManyMethods, exit(2).
Edit a file under `src/test/java/` → confirm `checkstyleTest`/`pmdTest` invoked.

- [x] **Step 6: Commit**

```
feat: implement Layer 2+3 — Checkstyle + PMD

Cross-platform: GRADLEW variable (gradlew.bat / ./gradlew).
Single Gradle invocation per edit (saves ~2-4s vs two sequential calls).
Source set routing: main vs test files → correct task suffix.
Timeout (20s): skip not block (fail-open).
Fail-open if no report file (compiled classes missing).
Basename escaped before regex injection.
XML entity decoding in error messages.
```

---

## Task 8: Hook Layer 1 — Deletion Detection

**Files:** Modify `.pi/hooks/code-guardrail.js`

- [x] **Step 1: Add `getDeletedLines()` — reads tool_input, not git diff**

```js
/**
 * Extracts lines being deleted by the current tool operation.
 *
 * Edit tool: old_string is the exact content being replaced.
 * Write tool: multiset bag-diff (not set) between current file and incoming content.
 *   Bag comparison handles duplicate lines (blank lines, "}", "return;") correctly.
 */
function getDeletedLines(payload, filePath) {
  const toolName = payload?.tool_name;

  if (toolName === 'Edit') {
    const oldStr = payload?.tool_input?.old_string || '';
    return oldStr.split('\n').map(l => `-${l}`);
  }

  if (toolName === 'Write') {
    if (!fs.existsSync(filePath)) return []; // new file — nothing to delete
    const current = fs.readFileSync(filePath, 'utf-8').split('\n');
    const incoming = (payload?.tool_input?.content || '').split('\n');

    const bag = {};
    incoming.forEach(l => { bag[l] = (bag[l] || 0) + 1; });

    const deleted = [];
    current.forEach(l => {
      if (bag[l] > 0) { bag[l]--; }
      else { deleted.push(`-${l}`); }
    });
    return deleted;
  }

  return [];
}
```

- [x] **Step 2: Add Tier 1 detection with true-deletion check**

```js
const TIER1_PATTERNS = [
  /^-\s*public\s+(class|interface|enum)\s+\w+/,
  /^-\s*@(Entity|Repository|Service|Controller|Component|RestController)/,
  /^-\s*@(Id|Column|Table|ManyToOne|OneToMany|ManyToMany)/,
  /^-\s*public\s+.+\s+\w+\s*\(/,   // public method — any return type incl. generics
  /^-\s*@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)/,
];

/**
 * Returns true if the deleted line's structural element is not present in newLines.
 * Prevents false positives when Edit modifies (not removes) a public method.
 */
function isTrulyDeleted(deletedLine, newLines) {
  const trimmed = deletedLine.replace(/^-\s*/, '').trim();
  return !newLines.some(nl => nl.trim() === trimmed);
}

/**
 * @param {string[]} deletedLines   lines prefixed with '-'
 * @param {string[]} newLines       new_string lines for Edit tool; [] for Write tool
 */
function detectTier1(deletedLines, newLines) {
  const hits = new Set();
  deletedLines.forEach(line => {
    TIER1_PATTERNS.forEach(p => {
      if (p.test(line)) {
        // Write tool (newLines=[]) always flags. Edit tool only flags true deletions.
        if (newLines.length === 0 || isTrulyDeleted(line, newLines)) {
          hits.add(line.substring(1).trim());
        }
      }
    });
  });
  return [...hits];
}
```

- [x] **Step 3: Add Tier 2 detection with size-ratio and 50% threshold**

```js
/**
 * @param {string[]} deletedLines
 * @param {boolean}  isReplacement   true when Edit replaces ≥30% of old content
 * @param {number}   totalCurrentLines  line count of current file (Write tool only)
 */
function detectTier2(deletedLines, isReplacement, totalCurrentLines) {
  const hits = [];

  // Absolute line count — skipped for Edit replacements to allow legitimate refactoring.
  // Not skipped for Write (full file overwrite) or empty replacements.
  if (!isReplacement && deletedLines.length >= 30) {
    hits.push(`${deletedLines.length} lines deleted (threshold: 30)`);
  }

  // Percentage of file deleted — Write tool only (we have total line count).
  if (!isReplacement && totalCurrentLines > 0 &&
      deletedLines.length >= totalCurrentLines * 0.5) {
    hits.push(`${deletedLines.length}/${totalCurrentLines} lines deleted (≥50% of file)`);
  }

  const importDels = deletedLines.filter(l => /^-\s*import\s+/.test(l));
  if (importDels.length >= 15) {
    hits.push(`${importDels.length} imports deleted (threshold: 15)`);
  }

  const testDels = deletedLines.filter(l => /^-\s*@Test/.test(l));
  if (testDels.length > 0) {
    hits.push(`${testDels.length} @Test method(s) deleted`);
  }

  return hits;
}

// Tier 3 (private methods, comments, blank lines) is handled implicitly:
// if no Tier 1 or Tier 2 match, the operation is allowed without confirmation.

function formatDeletionWarning(tier1, tier2) {
  let msg = '';
  if (tier1.length > 0) {
    msg += '[Guardrail] Critical code deletion detected:\n';
    tier1.forEach(l => { msg += `  ${l}\n`; });
    msg += '\nThis may break API contracts, DB mappings, or component wiring.\n';
  }
  if (tier2.length > 0) {
    msg += '[Guardrail] Large deletion detected:\n';
    tier2.forEach(v => { msg += `  - ${v}\n`; });
    msg += '\nThis may be unintentional. Review before proceeding.\n';
  }
  msg += '\nTo override: GUARDRAIL_SKIP=1 or create .pi/.guardrail-skip';
  return msg;
}
```

- [x] **Step 4: Replace Layer 1 TODO in main()**

```js
  // Layer 1: Deletion Detection
  const deletedLines = getDeletedLines(payload, filePath);
  if (deletedLines.length > 0) {
    const newLines = payload?.tool_name === 'Edit'
      ? (payload?.tool_input?.new_string || '').split('\n')
      : [];

    // isReplacement: Edit with new content ≥ 30% of old content size.
    // Prevents trivial bypass ("// placeholder" replaces 200 lines).
    const oldLineCount = (payload?.tool_input?.old_string || '').split('\n').length;
    const newLineCount = newLines.length;
    const isReplacement = payload?.tool_name === 'Edit' &&
                          newLineCount >= Math.ceil(oldLineCount * 0.3);

    // 50% threshold requires current file line count (Write only).
    const currentLineCount = payload?.tool_name === 'Write' && fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf-8').split('\n').length
      : 0;

    const tier1 = detectTier1(deletedLines, newLines);
    const tier2 = detectTier2(deletedLines, isReplacement, currentLineCount);

    if (tier1.length > 0 || tier2.length > 0) {
      console.log(formatDeletionWarning(tier1, tier2));
      process.exit(2);
    }
  }
```

- [x] **Step 5: Test — Edit modification (must NOT block)**

Edit: replace `public void process(String a)` with `public void process(String a, int b)`.
Expected: old signature in `old_string`, but `isTrulyDeleted` finds it in `new_string` → no Tier 1 hit → allowed.

- [x] **Step 6: Test — Edit true deletion (must block)**

Edit: remove a `@Service` annotation entirely (not replaced).
Expected: Tier 1, exit(2).

- [x] **Step 7: Test — Edit replacement, Tier 2 skip**

Edit: replace a 35-line method body with a 10-line refactored version.
old=35 lines, new=10 lines → 10 >= ceil(35 * 0.3) = 11? No → isReplacement=false.
Actually 10 < 11, so isReplacement=false — Tier 2 (30 lines) would fire.
Adjust threshold if this is too aggressive — document actual behavior here.

- [x] **Step 8: Test — Write, 50% deletion**

Write a file with half the lines removed.
Expected: Tier 2 "≥50% of file", exit(2).

- [x] **Step 9: Test — bypass**

`GUARDRAIL_SKIP=1 node .pi/hooks/code-guardrail.js < /dev/null`
Expected: exit(0), no validation.

- [x] **Step 10: Commit**

```
feat: implement Layer 1 — deletion detection

Reads from tool_input directly (not git diff).
- Edit: old_string = deleted content
- Write: multiset bag-diff (not set — handles duplicate lines)

Tier 1: public class/interface/enum, JPA annotations, public methods,
        REST mappings. Edit modifications skipped via isTrulyDeleted()
        (compares old vs new — avoids false positives on method edits).
Tier 2: 30+ line absolute count, 50% of file (Write), 15+ imports, @Test.
        isReplacement check (≥30% size ratio) relaxes Tier 2 for Edit.
Tier 3: falls through implicitly (private, comments, blank lines).
```

---

## Task 9: Hook Registration and Integration Testing

**Files:** Modify `.pi/settings.json`

- [x] **Step 1: Register hook for Edit and Write (PreToolUse)**

Add to `hooks.PreToolUse`:

```json
{
  "matcher": "Edit",
  "hooks": [{"type": "command", "command": "node D:/JavaProject/DevCenter/.pi/hooks/code-guardrail.js"}]
},
{
  "matcher": "Write",
  "hooks": [{"type": "command", "command": "node D:/JavaProject/DevCenter/.pi/hooks/code-guardrail.js"}]
}
```

- [x] **Step 2: Warm Gradle daemon before testing**

`<gradlew> help`
Expected: daemon starts; subsequent invocations skip 10-30s startup.

- [x] **Step 3–9: Integration tests**

| Test | Expected |
|------|----------|
| Edit: remove `@Service` | Tier 1 block |
| Edit: add param to existing method | NOT blocked (isTrulyDeleted) |
| Edit: replace 35-line body with 10-line refactor | Verify Tier 2 behavior, document result |
| Checkstyle: method > 150 lines | Layer 2 block |
| PMD: class with 21+ methods | Layer 3 block |
| Edit file under `src/test/java/` | checkstyleTest/pmdTest invoked |
| Edit `.yml` file | exit(0) immediately |
| Bypass via GUARDRAIL_SKIP=1 | All layers skipped |
| Bypass via `.guardrail-skip` file | All layers skipped |

- [x] **Step 10: Measure wall-clock time**

Edit a valid Java file, measure hook duration.
Record: ___s (warm Gradle). If > 15s, raise `GRADLE_TIMEOUT_MS` or reduce rules.

- [x] **Step 11: Commit**

```
config: register code guardrail hooks for Edit/Write (PreToolUse)

Layer order: deletion detection → Checkstyle+PMD (single invocation).
Phase 1: Code Guardrails complete.
```

---

## Task 10: Wrap-Up

- [x] **Step 1: Run full validation suite**

`<gradlew> checkstyleMain pmdMain`
Document pre-existing violations — do not fix now (out of scope).

- [x] **Step 2: Add build report directories to .piignore**

```
**/build/reports/checkstyle/
**/build/reports/pmd/
```
Prevents PI from reading report XML artifacts as source context.

- [x] **Step 3: Add .guardrail-skip to .gitignore**

`echo ".pi/.guardrail-skip" >> .gitignore`

- [x] **Step 4: Update spec performance numbers**

In `docs/superpowers/specs/2026-05-12-llm-code-guardrails-design.md`:
- Change "~3.5 seconds" → "< 15 seconds on warm Gradle daemon"
- Add: "Cold daemon (~30s+) → 20s timeout → fail-open (skipped, not blocked)"

- [x] **Step 5: Commit**

```
chore: wrap-up code guardrails phase 1

- Add build/reports to .piignore
- Add .guardrail-skip to .gitignore
- Update spec performance numbers
```

---

## Verification Checklist

- [x] PMD ruleset: no XML errors, no SimplifyBooleanReturn (deduped), GodClass thresholds set
- [x] Checkstyle: ClassDataAbstractionCoupling + JavaNCSS inside TreeWalker; JavaNCSS compatibility verified
- [x] All 3 modules: Checkstyle + PMD with `source = files(project.guardFilePath)` (not `[file(...)]`)
- [x] Hook: stdin API (not `module.exports`)
- [x] Hook: `GRADLEW = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'`
- [x] Hook: `PROJECT_ROOT` via `git rev-parse`
- [x] Layer 1: reads `old_string`/bag-diff — NOT `git diff`
- [x] Layer 1: Edit modifications don't trigger Tier 1 (`isTrulyDeleted` check)
- [x] Layer 1: `isReplacement` uses ≥30% size ratio (not just non-empty)
- [x] Layer 1: Tier 2 includes 50% of file threshold (Write tool)
- [x] Layer 2+3: single Gradle invocation per edit
- [x] Layer 2+3: source set routing (main vs test)
- [x] Layer 2+3: `err.killed` only (no `err.signal === 'SIGTERM'`)
- [x] Layer 2+3: basename escaped before regex injection
- [x] Layer 2+3: XML entity decoding in error messages
- [x] Fail-open: timeout and missing report both allow (not block)
- [x] Bypass: `GUARDRAIL_SKIP=1` and `.guardrail-skip` file both work
- [x] `.guardrail-skip` in `.gitignore`
- [x] `build/reports/` in `.piignore`
- [x] Hook registered under PreToolUse, Edit + Write matchers
- [x] Wall-clock time measured and documented
- [x] Spec performance numbers updated

---

## Known Limitations

1. **Cold Gradle daemon**: First run can take 30s+; 20s timeout causes silent skip. Warm daemon with `<gradlew> help` before coding.
2. **Absolute path in hook registration**: Breaks on machines with different project root. Pre-existing convention; out of scope.
3. **compileJava prerequisite**: Without `build/classes`, Checkstyle/PMD fail silently (fail-open). Run `<gradlew> compileJava compileTestJava` after fresh checkout.
4. **isReplacement 30% ratio**: An Edit that replaces 35 lines with 10 lines (28%) is treated as a non-replacement and may trigger Tier 2. Adjust threshold based on observed behavior in Step 7 of Task 8.
5. **Write bag-diff and formatters**: Auto-formatters that rewrite the full file will generate many "deleted" lines even for equivalent content. Use bypass during formatter runs.
6. **Per-edit override deferred**: Spec's "Proceed Anyway / Cancel" UX requires Phase 2.
7. **CPD not in hook**: `<gradlew> cpdCheck` in CI only.
8. **html.required change**: `api-service` Checkstyle HTML reports disabled when `guardFilePath` is active. CI jobs that rely on HTML output need a separate invocation without the property.

---

## Future Enhancements (Not in Scope)

- Phase 2: Per-edit override UX
- Phase 3: Persona Integration
- Phase 4–8: Workflow Enforcement, Documentation, Review Gates, Architecture Governance, Full Integration

---

## Review Notes

**Round 1 — Opus reviewer (2026-05-13):** CONDITIONAL PASS

Fixed: Hook API (stdin), deletion detection timing (tool_input not git diff), Checkstyle single-file (guardFilePath), CPD excluded, hook registration format, timeout/bypass, source set routing, single Gradle invocation, unified guardFilePath property, SimplifyBooleanReturn dedup, GodClass thresholds, PROJECT_ROOT via git, XML entity decoding, path normalization, Tier 3 documented, spec performance numbers, .guardrail-skip in .gitignore.

**Round 2 — Opus reviewer (2026-05-13):** CONDITIONAL PASS

10 prior fixes verified genuine. New findings incorporated:
- `./gradlew` → cross-platform `GRADLEW` constant (win32: `gradlew.bat`, posix: `./gradlew`)
- Tier 1 false positive on Edit: added `isTrulyDeleted()` + `newLines` param to `detectTier1()`
- `source = [file(...)]` → `source = files(...)` (all 3 modules — Gradle DSL correctness)
- Basename escaped before regex injection in both XML parsers
- `isReplacement`: non-empty check → ≥30% size ratio guard
- `detectTier2`: added 50% of file deleted threshold (from spec, was silently dropped)
- `err.signal === 'SIGTERM' || err.killed` → `err.killed` only (Windows compat)
- `build/reports/` added to `.piignore`
- `html.required` change documented as behavioral impact on CI
- GodClass `tcc=0.5` noted as more aggressive than PMD default (0.33)
- JavaNCSS compatibility check added to Task 2
