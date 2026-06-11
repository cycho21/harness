---
name: tool-error-recovery
description: Use after a failed tool call, command, guard, edit application, or workflow transition. Classifies retryability and gives a concrete recovery action without hiding the failure. Output language is Korean.
---

# Tool Error Recovery Skill

Use this skill when a tool call, command, edit, workflow transition, guard, or verification step fails and the next action is not obvious.

## Goal

Turn a raw failure into a safe recovery plan: classify what failed, whether retry is safe, what evidence is needed, and the next concrete action.

## Failure Record

Capture these fields before retrying:

```markdown
## Failure Record
- Tool / command: <name>
- Workflow phase: <phase or none>
- Operation intent: <what we were trying to do>
- Error summary: <short exact error>
- Changed state: <files/state/tokens possibly changed, or none known>
- Retryability: safe retry / retry after repair / do not retry yet / user decision required
```

## Recovery Classes

| Class | Meaning | Default action |
|------|---------|----------------|
| Safe retry | transient or no state changed | retry once with same intent |
| Retry after repair | stale input, missing prerequisite, wrong path, invalid args | repair prerequisite, then retry |
| Do not retry yet | destructive risk, unclear partial mutation, workspace mismatch | inspect state and ask only if needed |
| User decision required | business/architecture choice or accepted-risk skip | ask a targeted question |

## Common Harness Recoveries

- `workflow_apply_approved_edit` stale hashes: discard the stale scope, propose the edit again from current file content.
- Path validation failure: do not bypass; correct the path or explain why the requested path is protected.
- DPAA/SBADR failure: return to plan, repair ambiguity/syntax, retry approval.
- Code quality failure: fix code, not checkstyle/PMD suppressions, then rerun the narrow gate.
- Workspace mismatch: stop mutating; report expected cwd/branch and wait for user/environment correction.
- Policy scan block: present the risk summary; use accepted-risk skip only after explicit user approval.
- Push failure: do not force push unless explicitly requested; inspect remote rejection reason first.

## Output Template

```markdown
## Failure Recovery
- Failed operation: <tool/command>
- Phase: <phase>
- Retryability: <class>

## Diagnosis
<why it failed, with evidence>

## Safe Next Action
1. <next concrete action>

## Do Not Do
- <unsafe shortcut to avoid>
```

## Rules

- Do not silently retry mutating operations when partial state is unclear.
- Do not turn a tool failure into a broad refactor.
- Do not hide guard failures from the user; fix autonomously only when the cause is mechanical and within scope.
- Prefer one focused recovery action over a long list of possibilities.
