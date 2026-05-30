# LLM Code Guardrails Design

**Date**: 2026-05-12
**Status**: Approved
**Purpose**: Prevent LLM from generating problematic code through real-time validation hooks

## Motivation

LLM agents can produce code that violates quality standards:
- Overly complex methods (high cyclomatic complexity)
- Duplicated code blocks (copy-paste patterns)
- Unintentionally deleting critical code (public APIs, entities, annotations)
- Excessively long files or methods

This system adds validation layers to Edit/Write operations, blocking or warning before problematic code is saved.

## Architecture

```
Edit/Write Tool Invoked
    ↓
┌─────────────────────────────────────┐
│ code-guardrail.js Hook              │
│ (registered in .pi/settings.json)│
└─────────────────────────────────────┘
    ↓
Layer 1: Deletion Detection (~0.3s)
    ↓ (approved or Tier 3)
Layer 2: Checkstyle Validation (~1s)
    ↓ (passed)
Layer 3: PMD CPD Validation (~2s)
    ↓ (passed)
✅ File Save Allowed
```

**Total validation time**: < 15 seconds per Edit/Write (warm Gradle daemon)

---

## Selective Documentation Philosophy

**CORE PRINCIPLE**: Document only what's non-obvious. Code should be self-explanatory; documentation adds value only when context can't be inferred from the code itself.

### The Documentation Paradox

**Problem with over-documentation**:
- Docs become stale as code changes
- No one reads 500-page documentation
- Maintenance burden (update code AND docs)
- False sense of security ("it's documented" doesn't mean it's understood)

**Problem with under-documentation**:
- Complex architectural decisions lost after a few sessions
- Non-obvious design choices become mysteries 6 months later
- "Why did we do it this way?" requires archaeology

**Solution**: Selective documentation—trigger only when valuable, skip when code is sufficient.

### When to Document (Judgment Criteria)

**Document when**:
- **Non-obvious architectural decisions**: "We chose eventual consistency over strong consistency because..."
- **Trade-off choices**: "We sacrificed read performance for write throughput because our workload is 90% writes"
- **Complex domain logic**: "This validation sequence must happen in this specific order due to regulatory requirements"
- **Workarounds for external constraints**: "We can't use feature X because third-party API Y has limitation Z"
- **Performance-critical paths**: "This cached computation saves 500ms per request, here's the invalidation strategy"
- **Multi-phase features**: Architecture → Implementation → Migration spread across multiple PRs

**Skip documentation when**:
- **Self-explanatory CRUD**: Adding `GET /api/users/:id` endpoint
- **Straightforward bug fixes**: "Null check was missing, added it"
- **Obvious refactoring**: "Extracted 3 duplicated methods into a helper"
- **Dependency updates**: "Upgraded Spring Boot 3.2 → 3.3"
- **Code speaks for itself**: Method names, types, and tests make intent clear

**Heuristic**: If a senior engineer can read the code and understand *why* without asking questions, skip documentation.

### Dual-Format Documentation Strategy

**Markdown (Source of Truth)**:
- `docs/feat/<feature-name>.md`
- Version-controlled in git
- Human-editable
- Contains:
  - **Context & Problem**: Why was this built? What problem does it solve?
  - **Flow Diagram**: Mermaid diagrams showing how it works
  - **Decision Log**: What choices were made and why (with importance: High/Medium/Low)
  - **변경 범위**: Changed files, DB schema, API endpoints

**HTML (Rendered View)**:
- `docs/feat/html/<feature-name>.html`
- Generated from md with **editorial judgment**
- Optimized for browser reading (dark theme, patterns for density)
- Patterns applied:
  - **Toggle**: Collapsed by default for secondary content (changed files, long lists)
  - **Tab**: Independent diagrams (request flow vs. approval flow)
  - **Accordion**: Grouped items by category (Decision Log by importance: High/Medium/Low)
  - **Diff view**: Git diffs with syntax highlighting, +/- counts
- Index page: `docs/feat/html/index.html` (searchable, newest-first)

### Documentation Workflow (Triggered Selectively)

```
IMPLEMENT Phase completes
    ↓
Documentation Decision Gate
    ↓
┌─ Evaluate criteria:
│  - Architectural impact? (High/Medium/Low)
│  - Non-obvious decisions?
│  - Complex domain logic?
│  - Trade-off choices?
│
├─ If Low impact + obvious → Skip DOCUMENT, proceed to REVIEW
│
└─ If Medium/High impact → Ask user: "이 feature는 문서화가 필요할까요?"
    ↓ (User says Yes)

DOCUMENT Phase (feature-documentation workflow)
    ↓
┌─ Step 1: Auto-collect
│  - git log <main-branch>..HEAD --oneline
│  - git diff <main-branch>..HEAD --name-only
│  - Read changed files to understand flow
│
├─ Step 2: User input (AskUserQuestion)
│  - Context & Problem (why built, problem solved)
│  - Decision Log (design decisions + reasons + importance)
│
├─ Step 3: Generate Flow Diagram
│  - Mermaid sequenceDiagram or flowchart
│  - Auto-generated from code analysis
│  - Self-review for accuracy
│
├─ Step 4: Write md
│  - docs/feat/<feature-name>.md
│  - Template: Context → Flow → Decisions → 변경 범위
│  - Update docs/feat/INDEX.md (newest entry first)
│
├─ Step 5: Render html
│  - Read md, analyze content density
│  - Apply patterns: toggle/tab/accordion/diff
│  - Generate docs/feat/html/<feature-name>.html
│  - Update docs/feat/html/index.html
│
└─ Step 6: Quality check
   - Does Context explain *why*, not just *what*?
   - Does Flow match actual code?
   - Does each Decision have a clear reason?
   - Does 변경 범위 match git diff?
```

### Enforcement (Soft Gate, Not Mandatory)

**Decision gate**: After IMPLEMENT, harness evaluates if documentation adds value.
- Analyze: commit messages, changed files, architectural impact
- Low impact + self-explanatory → Skip DOCUMENT, proceed to REVIEW
- Medium/High impact → Ask user: "문서화 필요할까요?" (default: No)
- User can always skip, even if harness recommends

**No blocking**: Documentation is **never mandatory**. Harness suggests, user decides.

**Reviewer responsibility**:
- If code is unclear and no docs exist → Request documentation in review
- If code is self-explanatory → Approve without docs

### Benefits

1. **Knowledge preservation** (where it matters): Non-obvious decisions survive beyond LLM context window
2. **Low noise ratio**: No one reads 500 documents; only 10 well-chosen docs get read
3. **Code review quality**: Reviewers can request docs if code is unclear (not mandatory upfront)
4. **Maintenance**: 6 months later, you remember why that weird workaround exists (only if it was documented because it was weird)
5. **Dual format** (when used): md for editing, html for reading (best of both worlds)
6. **Reduced burden**: LLM doesn't waste time documenting obvious CRUD operations

---

## Layer 1: Deletion Detection

### Purpose
Prevent LLM from removing critical code structures.

### Implementation
Parse `git diff` output to detect deletions, categorized into 3 tiers.

### Tier 1: Critical Deletion (User Confirmation Required)

**Patterns**:
- `public class/interface/enum` declarations
- Spring/JPA annotations: `@Entity`, `@Repository`, `@Service`, `@Controller`, `@Component`
- JPA mapping annotations: `@Id`, `@Column`, `@Table`, `@ManyToOne`, etc.
- `public` method signatures
- API endpoint annotations: `@GetMapping`, `@PostMapping`, etc.

**Action**: Prompt user with detailed warning, wait for Y/N confirmation.

**Warning Message**:
```
⚠️  Critical Code Deletion Detected

The following critical code is being deleted:
  Line 45: public class AffiliateService
  Line 67: @Entity
  Line 89: public ResponseEntity<User> getUser(...)

This may break:
  - API contracts
  - Database mappings
  - Component dependencies

Do you want to proceed? (Y/N)
```

### Tier 2: Large Deletion (User Confirmation Required)

**Thresholds**:
- 30+ consecutive lines deleted
- 15+ imports deleted
- 50%+ of file deleted
- Any `@Test` method deleted

**Action**: Prompt user with statistics, wait for Y/N confirmation.

**Warning Message**:
```
⚠️  Large Code Deletion Detected

- 45 consecutive lines deleted (threshold: 30)
- 3 test methods removed
- 62% of file deleted (threshold: 50%)

This might be unintentional refactoring.

Do you want to proceed? (Y/N)
```

### Tier 3: Safe Deletion (Auto-Allowed)

**Patterns**:
- `private` methods/fields
- Comments (`//` or `/* */`)
- Unused imports
- Blank lines

**Action**: Allow without confirmation.

---

## Layer 2: Checkstyle Validation

### Purpose
Enforce coding standards and complexity limits.

### Rules (Existing + New)

**Existing** (from commit 5148d8b):
- `CyclomaticComplexity`: max 10
- `LineLength`: max 120
- `MethodLength`: max 150
- `ParameterNumber`: max 7

**New Rules**:
```xml
<!-- God Class prevention -->
<module name="ClassDataAbstractionCoupling">
  <property name="max" value="10"/>
</module>

<!-- Code size metrics -->
<module name="JavaNCSS">
  <property name="methodMaximum" value="50"/>
  <property name="classMaximum" value="500"/>
</module>
```

### Configuration
- Config file: `config/checkstyle/checkstyle.xml`
- Applied to: `api-service`, `consumer-service`, `common`
- Version: 10.20.2

### Error Format
```
❌ Code Quality Check Failed

Checkstyle violations in AffiliateService.java:

  Line 67: Method 'processAffiliate' length is 156 (max: 150)
  Line 89: Cyclomatic complexity is 12 (max: 10)

Please simplify the code before proceeding.
```

**Action on violation**: Block file save, return error to LLM for correction.

---

## Layer 3: PMD CPD Validation

### Purpose
Detect code duplication (LLM's common pattern: copy-paste refactoring).

### Configuration

**PMD Version**: 7.0.0

**Ruleset** (`config/pmd/ruleset.xml`):
```xml
<ruleset>
  <!-- Excessive class length -->
  <rule ref="category/java/design.xml/ExcessiveClassLength">
    <properties>
      <property name="minimum" value="500"/>
    </properties>
  </rule>

  <!-- Unnecessary code patterns -->
  <rule ref="category/java/codestyle.xml/UnnecessaryLocalBeforeReturn"/>
  <rule ref="category/java/design.xml/SimplifyBooleanReturns"/>
  <rule ref="category/java/design.xml/AvoidDeeplyNestedIfStmts">
    <properties>
      <property name="problemDepth" value="3"/>
    </properties>
  </rule>
</ruleset>
```

**CPD Settings**:
- Minimum tokens: 50 (~10 lines)
- Language: Java
- Ignore literals: true
- Ignore identifiers: false

### Error Format
```
❌ Duplicate Code Detected

Found 2 duplicated blocks:

  Block 1: AffiliateService.java:45-67 (23 lines)
  Block 2: AffiliateTicketService.java:89-111 (23 lines)

Refactor duplicated code into a shared method.
```

**Action on violation**: Block file save, return error to LLM for refactoring.

---

## Hook Implementation

### Registration

**File**: `.pi/settings.json`

```json
{
  "hooks": {
    "Edit": ".pi/hooks/code-guardrail.js",
    "Write": ".pi/hooks/code-guardrail.js"
  }
}
```

### Hook Logic

**File**: `.pi/hooks/code-guardrail.js`

```javascript
module.exports = async (context) => {
  const { filePath, tool, approvalOverride } = context;

  // Only validate Java files
  if (!filePath.endsWith('.java')) {
    return { allowed: true };
  }

  // Layer 1: Deletion Detection
  if (!approvalOverride) {
    const deletionCheck = await checkDeletions(filePath);
    if (deletionCheck.tier1 || deletionCheck.tier2) {
      return {
        allowed: false,
        requiresApproval: true,
        message: deletionCheck.message
      };
    }
  }

  // Layer 2: Checkstyle
  const styleViolations = await runCheckstyle(filePath);
  if (styleViolations.length > 0) {
    return {
      allowed: false,
      reason: formatCheckstyleErrors(styleViolations)
    };
  }

  // Layer 3: PMD CPD
  const duplications = await runPmdCpd(filePath);
  if (duplications.length > 0) {
    return {
      allowed: false,
      reason: formatCpdErrors(duplications)
    };
  }

  return { allowed: true };
};
```

### User Interaction

**Method**: Hook returns blocking result with detailed message. PI displays the message and waits for user decision.

**Flow**:
1. Hook detects Tier 1/2 violation
2. Return `{ allowed: false, requiresApproval: true, message: "..." }`
3. PI shows message to user
4. User chooses: "Proceed Anyway" or "Cancel"
5. If user proceeds, re-invoke Edit/Write with approval flag

**Fallback**: If PI doesn't support `requiresApproval`, hook blocks unconditionally (safe default).

**Timeout**: No timeout needed (user must explicitly choose).

---

## Gradle Integration

### Module-Level Changes

Apply to: `api-service/build.gradle`, `consumer-service/build.gradle`, `common/build.gradle`

```gradle
plugins {
    id 'checkstyle'
    id 'pmd'
}

checkstyle {
    toolVersion = '10.20.2'
    configFile = file("${rootProject.projectDir}/config/checkstyle/checkstyle.xml")
    maxWarnings = 0
}

pmd {
    toolVersion = '7.0.0'
    consoleOutput = false
    ruleSetFiles = files("${rootProject.projectDir}/config/pmd/ruleset.xml")
}

tasks.withType(Checkstyle) {
    reports {
        xml.required = true
        html.required = false  // Hook only needs XML
    }
}

tasks.withType(Pmd) {
    reports {
        xml.required = true
        html.required = false
    }
}
```

**Note**: These tasks are **not** run during normal builds. Hook invokes them directly on modified files only.

---

## File Structure

```
DevCenter/
├── .pi/
│   ├── settings.json              (Hook registration)
│   ├── hooks/
│   │   └── code-guardrail.js      (Main hook logic - Phase 1)
│   ├── workflows/                 (Phase 3 - forked from Superpowers)
│   │   ├── requirement-analysis.md
│   │   ├── task-planning.md
│   │   ├── iterative-dev.md
│   │   ├── quality-gate.md
│   │   └── test-first.md
│   ├── personas/                  (Phase 2 - role-based agents)
│   │   ├── architect/
│   │   │   ├── PERSONA.md         (Chief Architect)
│   │   │   ├── system-designer.md
│   │   │   └── tech-stack-specialist.md
│   │   ├── developer/
│   │   │   ├── PERSONA.md         (Engineering Manager)
│   │   │   ├── backend-engineer.md
│   │   │   ├── frontend-engineer.md
│   │   │   └── tester.md
│   │   └── reviewer/
│   │       ├── PERSONA.md         (QA Director)
│   │       ├── security-expert.md
│   │       └── performance-analyst.md
│   └── plans/                     (Generated during task-planning workflow)
│       └── <feature-name>.md
├── config/
│   ├── checkstyle/
│   │   └── checkstyle.xml         (Updated with new rules)
│   └── pmd/
│       └── ruleset.xml            (New file)
├── docs/
│   ├── feat/                      (Feature documentation - dual format)
│   │   ├── INDEX.md               (Feature list, newest-first)
│   │   ├── <feature-name>.md      (Markdown source: Context/Flow/Decisions)
│   │   └── html/
│   │       ├── index.html         (Searchable feature list)
│   │       └── <feature-name>.html (Rendered with patterns: toggle/tab/accordion)
│   └── superpowers/specs/         (Design documentation)
│       └── 2026-05-12-llm-code-guardrails-design.md
├── api-service/build.gradle       (Add PMD plugin)
├── consumer-service/build.gradle  (Add checkstyle + PMD)
└── common/build.gradle            (Add checkstyle + PMD)
```

**Rationale**:
- `.pi/` = Harness runtime (hooks, workflows, personas, plans)
- `config/` = Build tools configuration (language-specific)
- `docs/` = Human-readable documentation (design docs, feature specs)

---

## Error Handling

### Hook Execution Failure

If any layer crashes (e.g., Checkstyle binary not found):
- **Action**: Log error, allow file save (fail-open to avoid blocking workflow)
- **Reason**: Hook failures shouldn't break LLM operation

### False Positives

**Checkstyle/PMD over-reporting**:
- **Short-term**: User approves via Tier 2 mechanism
- **Long-term**: Tune rules in config files

**Deletion detection false positives**:
- Example: Deleting a public method that was just added in same session
- **Mitigation**: User confirmation flow handles this

---

## Performance Considerations

**Per-file validation cost**: < 15 seconds on warm Gradle daemon
- Deletion check: < 0.1s (reads tool_input directly, no Gradle)
- Checkstyle + PMD: 4–15s warm daemon (single combined Gradle invocation)

**Cold daemon**: First invocation can take 30s+; 20s timeout causes silent
skip (fail-open). Warm daemon with `gradlew help` before coding sessions.

**CPD excluded from hook**: Project-wide by design — runs in CI only.

**Optimization applied**:
1. **Single Gradle invocation** for Checkstyle + PMD (saves ~2-4s vs two calls)
2. **Fail-open** on timeout and missing compiled classes (skips, not blocks)
3. **Source set routing** prevents wrong task invocation

**Expected impact**: Adds 4–15s latency per Edit/Write on Java files (warm daemon). Acceptable for quality gates.

---

## Long-term Vision: Full Workflow Harness

This code guardrail system is **Phase 1** of a larger goal: a complete harness that controls LLM behavior across the entire development workflow.

### Ultimate Goal

Build a unified workflow harness that orchestrates:
1. **Process workflows** (inspired by Superpowers, adapted for DevCenter)
2. **Role-based personas** (expert sub-agents for specialized work)
3. **Code guardrails** (this design - quality gates)

**Philosophy**: Fork Superpowers' workflow concepts, reverse-engineer the core patterns, and simplify to checklist-based workflows. No external dependencies—own the entire workflow. Language/framework agnostic design, with concrete implementations per project (DevCenter uses Spring Boot/Java).

**Unified Structure**: All harness components live under `.pi/` for easy discovery and management.

```
User Request
    ↓
┌─────────────────────────────────────┐
│ ARCHITECTURE Phase                  │
│ Agent: 🏛️ Architect                 │
│ - System Designer (API, DB, modules)│
│ - Tech Stack Specialist (libraries) │
│ Workflow: requirement-analysis      │
│ Output: Architecture Design Doc     │
│ Gate: User approval required        │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ PLAN Phase                          │
│ Workflow: task-planning             │
│ - Break into implementable tasks    │
│ - Define acceptance criteria        │
│ - Identify dependencies             │
│ Output: .pi/plans/<feature>.md  │
│ Gate: User approval before coding   │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ IMPLEMENT Phase                     │
│ Agent: 💻 Developer (Engineering Mgr)│
│ - Backend Engineer (server logic)   │
│ - Frontend Engineer (UI)            │
│ - Tester (unit tests, validation)   │
│ Workflow: iterative-dev             │
│ Guardrails: This design (Layer 1-3) │
│ Gate: Tests pass before next task   │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ DOCUMENT Phase (선택적)              │
│ Decision Gate:                      │
│ - Evaluate: architectural impact?   │
│ - Ask user: "문서화 필요?"            │
│ - Default: Skip                     │
│                                     │
│ If triggered:                       │
│ Workflow: feature-documentation     │
│ - Auto-collect: commits, diffs      │
│ - User input: Context, Decisions    │
│ - Generate: Flow diagrams (Mermaid) │
│ - Write: docs/feat/<name>.md        │
│ - Render: docs/feat/html/<name>.html│
│ Output: md (source) + html (rendered)│
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ REVIEW Phase                        │
│ Agent: 🔍 Reviewer (QA Director)     │
│ - Security Expert (vulnerability)   │
│ - Performance Analyst (benchmarks)  │
│ Workflow: quality-gate              │
│ Gate: "Approve" or "Request Changes"│
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ TEST Phase                          │
│ Agent: 🧪 Tester (from Developer team)│
│ Workflow: test-first                │
│ Output: Test report + coverage      │
│ Gate: All tests pass                │
└─────────────────────────────────────┘
    ↓
✅ Feature Complete → Ready for PR/Deploy
```

### Harness Components Integration

The harness combines three independent systems into a unified workflow controller:

#### 1. Superpowers Skills (Process Workflows)
- **Source**: `.pi/plugins/cache/pi-plugins-official/superpowers/`
- **Purpose**: Enforce software engineering best practices (TDD, incremental implementation, specs-first)
- **Examples**: `brainstorming`, `writing-plans`, `incremental-implementation`, `test-driven-development`
- **Integration**: Harness invokes skills at correct phases, prevents skipping

#### 2. Role-Based Personas (Expert Sub-Agents)
- **Source**: `.pi/personas/{architect,developer,reviewer}/PERSONA.md`
- **Purpose**: Delegate specialized work to expert personas with clear responsibilities
- **Hierarchy**:
  - **Architect** → System Designer + Tech Stack Specialist
  - **Developer** → Backend Engineer + Frontend Engineer + Tester
  - **Reviewer** → Security Expert + Performance Analyst
- **Integration**: Harness dispatches tasks to appropriate persona based on work type

#### 3. Code Guardrails (Quality Gates)
- **Source**: This design - `.pi/hooks/code-guardrail.js`
- **Purpose**: Real-time validation on Edit/Write to prevent LLM from generating bad code
- **Layers**: Deletion detection + Checkstyle + PMD CPD
- **Integration**: Runs automatically during IMPLEMENT phase, blocks saves on violations

### Harness Enforcement Mechanisms

**Prevent Skipping Phases**:
- Hook blocks `git commit` if no Architecture Design Doc exists (for new features)
- Hook blocks implementation if plan not approved by user
- Hook blocks implementation if Architect hasn't validated design
- Hook suggests documentation if architectural impact detected (user can skip)
- Hook blocks PR creation if Reviewer hasn't approved
- Hook blocks PR creation if tests don't pass

**Prevent Scope Creep**:
- Track current task from plan
- Block edits to files not listed in task's "affected files"
- Require user approval to expand scope
- Architect must approve architectural changes

**Prevent Role Confusion** (via `.pi/personas/` dispatcher):
- Route DB schema changes → `.pi/personas/architect/system-designer.md`
- Route library additions → `.pi/personas/architect/tech-stack-specialist.md`
- Route business logic → `.pi/personas/developer/{backend,frontend}-engineer.md`
- Route security concerns → `.pi/personas/reviewer/security-expert.md`
- Route performance issues → `.pi/personas/reviewer/performance-analyst.md`
- Route test generation → `.pi/personas/developer/tester.md`

**Prevent Premature Optimization**:
- Block performance refactoring unless Performance Analyst shows actual issue
- Block architectural changes unless Architect produces design doc

**Prevent Unsafe Deletions** (current design):
- Already implemented in Layer 1 (deletion detection)
- Blocks public API deletion without user confirmation

### Phase Roadmap

**Phase 1: Code Guardrails** (this design)
- Real-time validation on Edit/Write
- Complexity/duplication/deletion controls
- **Status**: Design complete, implementation next
- **Deliverable**: `.pi/hooks/code-guardrail.js` + PMD config

**Phase 2: Persona Integration**
- Move `docs/agents/` → `.pi/personas/` (unified structure)
- Integrate personas into workflow dispatcher
- Route tasks to Architect/Developer/Reviewer based on work type
- Enforce persona specialization (no Backend Engineer doing frontend work)
- **Deliverable**: Persona dispatcher hook + `.pi/personas/` structure

**Phase 3: Workflow Enforcement**
- Create `.pi/workflows/*.md` (forked from Superpowers concepts)
  - requirement-analysis.md
  - task-planning.md
  - iterative-dev.md
  - feature-documentation.md (CRITICAL - new workflow)
  - quality-gate.md
  - test-first.md
- Require requirement-analysis → task-planning sequence
- Block implementation without approved plan
- Track task completion vs. plan
- **Deliverable**: Pre-commit hook that checks for plan file + workflow checklists

**Phase 4: Selective Documentation**
- Optional feature-documentation workflow after IMPLEMENT
- Harness evaluates: architectural impact + complexity → suggests documentation if valuable
- User decides: "Skip" (default) or "Document"
- Generate dual-format output when triggered: md (source) + html (rendered with patterns)
- Quality gate: documentation must explain *why*, not just *what*
- **Deliverable**: Documentation decision gate + feature-documentation workflow (optional trigger)

**Phase 4.5: Review Gates**
- Mandatory Reviewer (QA Director) approval before commit
- Security Expert + Performance Analyst analysis
- Reviewer validates both code AND documentation quality
- Human approval required for "Request Changes" verdict
- **Deliverable**: Pre-commit hook invoking Reviewer persona

**Phase 5: Test Enforcement**
- TDD workflow (test first, then implement) via Tester persona
- Coverage thresholds
- Auto-rollback on test failures
- **Deliverable**: Test-first enforcement hook

**Phase 6: Architecture Governance**
- Architect approval required for:
  - DB schema changes
  - New dependencies/libraries
  - API contract changes
- System Designer validates module boundaries
- Tech Stack Specialist validates version compatibility
- **Deliverable**: Pre-implementation architecture gate

**Phase 7: Full Integration**
- Unified workflow controller orchestrating all phases
- Adaptive prompting based on current phase + active persona
- Learning from past violations
- Telemetry and analytics dashboard
- **Deliverable**: Complete harness with metrics

### Integration with Existing Systems

The harness orchestrates three independent systems:

#### DevCenter Workflows → Process Control
**Source**: `.pi/workflows/*.md` (forked from Superpowers concepts, simplified)

| Workflow | When Invoked | Enforced By | Superpowers Equivalent |
|----------|--------------|-------------|----------------------|
| `requirement-analysis` | User starts new feature | Pre-plan hook (Phase 3) | brainstorming |
| `task-planning` | After requirements approval | Harness auto-invokes | writing-plans |
| `iterative-dev` | During IMPLEMENT phase | Task tracker + code guardrails | incremental-implementation |
| `feature-documentation` | After IMPLEMENT, before REVIEW | Pre-review hook (Phase 5) | documentation-and-adrs (simplified) |
| `quality-gate` | Before git commit | Pre-commit hook (Phase 4) | code-review-and-quality |
| `test-first` | During TEST phase | Test-first hook (Phase 5) | test-driven-development |

**Key Simplifications**:
- Workflows are **checklists**, not full skills (lighter weight)
- Language-agnostic design (core process is universal)
- Concrete tools/configs per project (DevCenter: Checkstyle/PMD for Java; others: Pylint for Python, etc.)
- Integrated with `.pi/personas/` (not standalone)
- Fewer steps, faster execution
- Unified `.pi/` structure (workflows + personas + hooks)

**Example Workflow Structure** (`.pi/workflows/task-planning.md`):
```markdown
# Task Planning Workflow

## Purpose
Break approved requirements into implementable tasks with clear acceptance criteria.

## Checklist
- [ ] Read architecture design doc
- [ ] Identify affected modules (api-service / consumer-service / common)
- [ ] Break into tasks (max 1 task per file, or 1 file per task)
- [ ] Define acceptance criteria for each task
- [ ] Identify task dependencies (which tasks block others)
- [ ] Estimate complexity (S/M/L)
- [ ] Write to `.pi/plans/<feature-name>.md`
- [ ] Get user approval

## Output Format
- Task list with dependencies
- Acceptance criteria per task
- Affected files per task

## Success Criteria
- User approves plan
- Each task is independently testable
- No task is larger than 1 day of work
```

**Example: feature-documentation Workflow** (`.pi/workflows/feature-documentation.md`):
```markdown
# Feature Documentation Workflow

## Purpose
Document completed features with context, flow diagrams, and design decisions. Generate dual-format output (md + html).

## Checklist
- [ ] Auto-collect: git log, git diff, changed files
- [ ] Ask user: Context & Problem, Decision Log (with importance)
- [ ] Generate Mermaid flow diagrams from code analysis
- [ ] Write docs/feat/<feature-name>.md (template: Context → Flow → Decisions → 변경 범위)
- [ ] Update docs/feat/INDEX.md (newest entry first)
- [ ] Render docs/feat/html/<feature-name>.html (apply toggle/tab/accordion patterns based on content density)
- [ ] Update docs/feat/html/index.html
- [ ] Quality check: Context explains *why*, Flow matches code, Decisions have reasons

## Output Format
- docs/feat/<name>.md (Markdown source)
- docs/feat/html/<name>.html (Rendered with editorial patterns)
- docs/feat/INDEX.md updated
- docs/feat/html/index.html updated

## Success Criteria
- Documentation exists before REVIEW phase
- Flow diagrams accurately reflect code
- Decision Log captures *why*, not just *what*
- HTML renders correctly with appropriate patterns
```

All workflows follow this pattern: Purpose → Checklist → Output Format → Success Criteria.

#### .pi/personas → Work Delegation

| Persona | Triggered When | Deliverable |
|---------|---------------|-------------|
| 🏛️ **Architect** | Architecture/design work needed | Design doc, DB schema, API contract |
| → System Designer | DB schema, API contracts, modules | Technical blueprint |
| → Tech Stack Specialist | New dependency, library selection | Stack compatibility report |
| 💻 **Developer** | Implementation work assigned | Working code + unit tests |
| → Backend Engineer | Server-side logic, API, DB | Backend implementation |
| → Frontend Engineer | UI, client-side state | Frontend implementation |
| → Tester | Validate implementation | Test report, edge case coverage |
| 🔍 **Reviewer** | Before commit/PR creation | Approve or Request Changes |
| → Security Expert | Security-sensitive code | Vulnerability scan report |
| → Performance Analyst | Performance-critical code | Benchmark + optimization suggestions |

#### Code Guardrails → Real-Time Quality Gates

| Layer | When Active | Blocks On |
|-------|------------|-----------|
| Layer 1: Deletion | Every Edit/Write | Tier 1/2 deletions (user approval) |
| Layer 2: Checkstyle | Every Edit/Write | Complexity, length, style violations |
| Layer 3: PMD CPD | Every Edit/Write | Code duplication > 10 lines |

**Key Principle**:
- **`.pi/workflows/`** define *what* process to follow (inspired by Superpowers, owned by DevCenter)
- **`.pi/personas/`** define *who* does the work
- **`.pi/hooks/`** define *how* code quality is enforced

The harness **orchestrates** all three, ensuring the right workflow is executed, by the right persona, with the right quality checks.

**Why Fork Instead of Use Superpowers Directly?**
1. **Simplicity**: Superpowers is comprehensive but heavy—we only need 5 core workflows
2. **Customization**: Easier to adapt workflows per project (DevCenter: Spring Boot; others: Go, Python, etc.)
3. **Ownership**: No external dependency, easier to evolve with project needs
4. **Integration**: Workflows tightly coupled with personas (Superpowers is standalone)
5. **Speed**: Checklist-based workflows vs. full-featured skills (faster execution)
6. **Language-agnostic**: Core workflows are universal; only tools/configs are project-specific
7. **Unified structure**: All harness components in `.pi/` for easy discovery

---

## Future Enhancements (Current Phase)

### Phase 1.2: Additional Static Analysis
- **SpotBugs**: Add as Layer 4 for bug pattern detection (requires compiled bytecode, slower)
- **ArchUnit**: Enforce architectural boundaries (e.g., "controller can't import repository")

### Phase 1.3: Auto-Fixing
- If Checkstyle/PMD report fixable issues (e.g., unused imports), auto-apply fix before prompting user

### Phase 1.4: Learning Mode
- Track which violations LLM commonly makes
- Adjust system prompt dynamically to prevent specific patterns

---

## Success Criteria

1. **LLM blocked from**:
   - Creating methods with complexity > 10
   - Creating methods > 150 lines
   - Deleting public APIs without user confirmation
   - Copy-pasting code blocks > 10 lines
   - **Skipping documentation phase** (no commit without docs)

2. **User experience**:
   - Validation completes in < 15 seconds (warm daemon)
   - False positive rate < 5% (measured over 100 edits)
   - Clear error messages guide LLM to fix issues
   - **Documentation generated automatically** (user only provides Context + Decisions)

3. **Documentation quality** (when triggered):
   - Only non-obvious features get documented (not every CRUD operation)
   - Harness suggests documentation when architectural impact detected
   - When documented: docs/feat/<name>.md captures Context, Flow, Decisions
   - When documented: docs/feat/html/<name>.html rendered with patterns
   - Decision Log explains *why*, not just *what*
   - Flow diagrams match actual code
   - Documentation burden reduced by 80% (only valuable docs written)

4. **Maintenance**:
   - Adding new rules requires only editing XML config files
   - No code changes to hook logic for rule adjustments

---

## Rollout Plan

1. **Phase 1**: Deploy to `api-service` only (already has Checkstyle)
   - Add PMD
   - Add deletion detection hook
   - Test with LLM for 1 week

2. **Phase 2**: Extend to `consumer-service` and `common`
   - Add Checkstyle + PMD plugins
   - Apply same hook

3. **Phase 3**: Tune rules based on real usage
   - Adjust thresholds if too many false positives
   - Add new patterns to Tier 1/2 deletion detection

---

## Unified Harness Vision

### What the Harness Controls

```
┌──────────────────────────────────────────────────────────┐
│                    DevCenter Workflow Harness            │
│  Orchestrates: Workflows + Personas + Quality Gates     │
└──────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐      ┌──────────┐      ┌─────────┐
   │ WHAT    │      │ WHO      │      │ HOW     │
   │ Process │      │ Persona  │      │ Quality │
   └─────────┘      └──────────┘      └─────────┘
        │                │                 │
   .pi/         .pi/           .pi/hooks/
   workflows/       personas/          code-guardrail.js
   (forked from     (role-based        (quality gates)
   Superpowers)     sub-agents)
```

### Example: "Add user authentication feature"

**Traditional LLM behavior (uncontrolled)**:
1. ❌ LLM jumps straight to writing AuthController.java
2. ❌ Copy-pastes JWT logic from memory (duplicated code)
3. ❌ Creates 200-line method with complexity 15
4. ❌ Deletes existing SecurityConfig without asking
5. ❌ No tests written
6. ❌ No design doc explaining architecture
7. ❌ No documentation of *why* JWT was chosen
8. ❌ 6 months later, no one remembers why that token refresh hack exists

**With Harness (controlled workflow)**:

```
1. ARCHITECTURE Phase
   Harness: Invoke Architect persona
   → System Designer: Produce auth design (JWT vs Session, where to store tokens)
   → Tech Stack Specialist: Validate Spring Security version compatibility
   Output: docs/architecture/auth-design.md
   Gate: User approves design ✅

2. PLAN Phase
   Harness: Invoke task-planning workflow
   → Break into tasks: [AuthService, AuthController, JwtUtil, SecurityConfig, Tests]
   → Define acceptance criteria for each task
   → Identify task dependencies
   Output: .pi/plans/auth-feature-plan.md
   Gate: User approves task breakdown ✅

3. IMPLEMENT Phase - Task 1: AuthService
   Harness: Assign to Developer → Backend Engineer
   Workflow: iterative-dev
   - Write test first (test-first workflow)
   - Implement minimal code to pass test
   - Refactor if needed
   Code Guardrails (real-time):
     ✅ Layer 1: No critical deletions
     ✅ Layer 2: Checkstyle passes (complexity < 10, length < 150)
     ✅ Layer 3: PMD CPD passes (no duplication)
   → Backend Engineer writes AuthService.java
   → Tester validates with unit tests
   Gate: Tests pass ✅

4. IMPLEMENT Phase - Task 2: AuthController
   (Same flow as Task 1)

5. DOCUMENT Phase (선택적)
   Harness: Evaluate documentation need
   → Analyze changes:
     - Security-critical (authentication system)
     - Architectural change (Session → JWT)
     - Non-obvious trade-off (stateless tokens vs server memory)
   → Suggest: "이 feature는 아키텍처 결정이 포함되어 문서화를 추천합니다. 진행할까요?"
   → User: "네" (문서화 진행)

   If user accepts:
   → Auto-collect:
     - git log dev..HEAD (5 commits)
     - git diff dev..HEAD (AuthService.java, AuthController.java, SecurityConfig.java)
   → Ask user via AskUserQuestion:
     - "왜 JWT로 전환했나요?" → User explains: "분산 환경에서 세션 공유 문제"
     - "주요 설계 결정과 이유?" → User explains: "Refresh token 전략, 만료 시간"
   → Generate Mermaid diagrams (코드 분석 기반)
   → Write docs/feat/auth-feature.md
   → Render docs/feat/html/auth-feature.html (toggle/tab/accordion patterns)

   If user declines:
   → Skip DOCUMENT, proceed to REVIEW
   → Reviewer can still request docs during review if code is unclear

6. REVIEW Phase
   Harness: Invoke Reviewer → Security Expert
   Workflow: quality-gate
   → Security Expert reviews:
     - Code: Hardcoded secrets, SQL injection, weak JWT algorithm
     - Documentation: Does Decision Log explain *why* JWT was chosen?
   Output: Security audit report + documentation review
   Gate: Security Expert approves ✅

7. TEST Phase
   Harness: Invoke Tester
   Workflow: test-first (integration tests)
   → Run full integration tests
   → Coverage check (> 80%)
   → Performance regression check
   Gate: All tests pass ✅

8. COMMIT
   Harness: Pre-commit hook validates:
     ✅ Architecture design exists
     ✅ Plan completed
     ✅ Documentation exists (docs/feat/auth-feature.md + html)
     ✅ Reviewer approved
     ✅ Tests pass
   → Commit allowed
```

**Result**: High-quality, well-architected, secure authentication system with full documentation and tests.

### Key Differences

| Without Harness | With Harness |
|----------------|--------------|
| LLM decides process | Harness enforces process |
| No role specialization | Work routed to expert personas |
| Quality checks optional | Quality gates mandatory |
| Documentation always skipped OR over-documented | Documentation suggested only when valuable |
| Code context lost after session | Non-obvious decisions preserved in docs/feat/ |
| md OR html (inconsistent) | Dual format (when used): md (source) + html (rendered) |
| "Move fast, break things" | "Move deliberately, build right" |
| Output varies wildly | Consistent, predictable quality |
| 500 unread documents OR zero | ~10 well-chosen docs that people actually read |

---

## Known Limitations

1. **Multi-file refactoring**
   - Each file validated independently
   - Example: Moving a class to another file might trigger "critical deletion" on source file
   - **Mitigation**: User approves deletion via Tier 1 confirmation
   - **Future**: Detect "move" patterns by analyzing multiple files in same Edit batch

2. **High approval rate**
   - If user approves > 80% of Tier 1/2 warnings, thresholds may be too strict
   - **Mitigation**: Log approval decisions, review patterns after 100 edits
   - **Future**: Adjust thresholds or move patterns between tiers based on data

3. **Performance on large files**
   - Files > 1000 lines: Checkstyle + PMD may approach 15s warm daemon limit
   - **Mitigation**: 20s timeout → fail-open (skip, not block); CPD excluded from hook (CI only)
   - **Future**: Use incremental analysis (only check changed methods)
