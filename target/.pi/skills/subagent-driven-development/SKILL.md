---
name: subagent-driven-development
description: Main-agent-as-user-proxy pattern for implementing approved plans via subagents while keeping the main session context-light. Invoke after a plan is approved, when the user says "실행해줘", "구현해줘", "서브에이전트로 해줘", or when planning-and-task-breakdown/interview has produced an approved plan. Output language is Korean.
---

# Subagent-Driven Development

Core principle: the main session acts as the user's proxy and keeps intent, requirements, and design decisions. Subagents execute narrow implementation tasks with isolated context.

## Output Language

Respond to the user in Korean. Subagent prompts may be written in Korean when they are user-facing, but control rules in this skill are authoritative in English.

## Purpose

Use this skill to prevent the main session from absorbing large implementation context after interview and planning. The main session owns intent and acceptance criteria; subagents write code, run tests, fix review findings, and report concise results.

```text
Main session (user proxy)
  ├── owns the plan
  ├── owns design decisions
  ├── reviews subagent summaries
  └── returns to the explicit workflow phases for code_review/document/commit/push

Subagent (implementer)
  ├── implements one task at a time
  ├── follows TDD
  └── reports completion, blockers, and commits
```

## When to Use

- After `planning-and-task-breakdown` or `interview` produces an approved plan.
- For features that touch three or more files.
- When the main session already contains heavy interview/design context.

Do not use for a single-file change or trivial bug fix when direct implementation is simpler.

---

## Approval Protocol

Invoking this skill approves only the subagent implementation/review loop. It does not approve later workflow phases.

Subagents may work on scoped tasks and report results, but final `code_review → document → commit → push` progression remains controlled by `/workflow` and explicit user approval.

If a subagent hits an architecture decision, design conflict, unclear requirement, or scope expansion, it must stop and escalate to the main session. It must not guess.

---

## The Cycle

### Step 0: Load the Approved Plan

```text
Read the approved plan.
Identify tasks, dependencies, target files, acceptance criteria, and test strategy.
Create task-tracking entries for each task.
```

### Step 1: Run Implementation Subagents

Use one subagent per task. Independent tasks may run in parallel; dependent tasks must run sequentially.

```text
Agent task:
- Implement Task N: <task title>
- Use an isolated worktree when needed.
- Follow the implementation prompt template below.
```

### Step 2: Review Subagent Output

After a subagent completes, the main session should:

1. Read only the subagent summary, not full implementation files.
2. Run a review subagent or the `/code-review` skill.
3. If Critical/Major issues exist, run a fix subagent scoped only to those findings.

### Step 3: Repeat

Repeat Steps 1–2 until all tasks are complete.

### Step 4: Return to Workflow

When all tasks satisfy acceptance criteria, report completion and ask the user to continue to the `code_review` workflow phase.

---

## Subagent Prompt Templates

### Implementation Agent

```text
Implement the following task in the DevCenter project.

## Context
- Branch: <branch>
- Plan file: <plan_path>
- Spec file: <spec_path>

## Task N: <task_title>

### Description
<task_description>

### Acceptance Criteria
<acceptance_criteria>

### Files to Modify
<file_list>

### Dependencies
<dependencies>

## Mandatory Rules

1. TDD is required.
   - Write the relevant test before production code.
   - The test file must contain a real @Test.

2. Use clear commit messages.
   - Conventional Commits are recommended, but commit messages are not infrastructure-gated.

3. Run review before reporting done.
   - Execute `/code-review-gate` or `/code-review` on your scoped changes.
   - Do not create guard/authority artifacts or claim user approval.

4. Respect scope.
   - Modify only the specified files.
   - Do not refactor adjacent code unless explicitly required.

5. Escalate design questions.
   - If architecture, requirements, or scope are unclear, stop and report to the main session.

## Done Criteria
- [ ] All acceptance criteria are satisfied.
- [ ] Relevant tests pass.
- [ ] Code review passes with Critical=0 and Major≤2.
- [ ] Commit is completed.

Report changed files and commit hash when done.
```

### Review Agent

```text
Review the recent DevCenter project changes.

Target: git diff HEAD or commit <commit_hash>

Task context:
- Feature: <feature_description>
- Acceptance criteria: <acceptance_criteria>

Run the `/code-review-gate` skill.
Report the result in Korean. Do not create guard/authority artifacts; user confirmation happens through `/workflow approve`.
```

### Fix Agent

```text
The code review found these issues:

## 🔴 Critical Issues
<critical_issues>

## 🟡 Major Issues
<major_issues>

Files: <file_list>

Fix only the listed issues. Do not make adjacent changes.
Run `/code-review-gate` again after the fix and report the result.
```

---

## Context Isolation Rules

| DO | DON'T |
|----|-------|
| Read subagent summaries | Read entire implementation files in the main session |
| Track progress with task entries | Load large diffs into the main context |
| Give subagents paths to specs/plans | Paste large files into every prompt unnecessarily |
| Keep architecture decisions in the main session | Let subagents invent design decisions |

---

## Harness Integration

| Gate | Subagent impact |
|------|-----------------|
| TDD guidance | Subagents must write tests before implementation. |
| Code review phase | Subagents may run `/code-review-gate`, but user confirmation happens in `/workflow approve`. |
| Session context | Untested-class and branch context should inform subagent prompts. |

---

## Progress Tracking

Track task state in the main session:

```text
TaskCreate: "Implement Task 1: <title>"
TaskUpdate: in_progress when the subagent starts
TaskUpdate: completed after review passes and commit completes
```

The main session's task state is the source of truth. If a subagent fails, keep the task in progress and run a scoped fix agent.

---

## Failure Handling

| Situation | Response |
|----------|----------|
| TDD gate blocks implementation | Re-run with explicit instruction to write the test first. |
| Code review finds Critical issues | Run a scoped fix agent, then review again. |
| Subagent returns an architecture question | Main session decides from approved context, then resumes the subagent. |
| Later workflow guard fails | Identify the cause and run a scoped fix agent only after user approval. |
