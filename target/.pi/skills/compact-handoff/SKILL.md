---
name: compact-handoff
description: Prepare a concise handoff note before manual context compaction. Does not invoke compaction itself; summarizes workflow state, decisions, artifacts, verification, and next action. Output language is Korean.
---

# Compact Handoff Skill

Use this skill when the conversation is getting long, before the user manually compacts context, or when a workflow should be resumed safely after context loss.

This skill prepares the handoff only. It must not claim to run Pi or provider-native compaction commands on the user's behalf.

## Goal

Create a compact, accurate resume note that lets the next context continue the workflow without rereading the entire conversation.

## Handoff Content

Include only durable, relevant facts:

1. **Workflow State** — current phase, goal, branch, and whether a workflow is active.
2. **User Decisions** — explicit approvals, rejected options, accepted risks, and open decisions.
3. **Artifacts** — paths to spec/plan/docs/reports, plus hashes or descriptor references when available.
4. **Changed Files** — only files changed in the current workstream, not a full repo inventory.
5. **Verification Evidence** — commands/checks actually run and their results.
6. **Pending Work** — the single next action and blockers.
7. **Guard State** — DPAA/code-review/quality/policy/push evidence if relevant; never invent evidence.
8. **Non-Goals / Warnings** — important things not to do after resume.

## Output Template

```markdown
## Compact Handoff

### Current State
- Workflow: <none or [phase] title>
- Branch: <branch>
- Goal: <goal>

### Decisions
- <decision / approval / rejected option>

### Artifacts
| Kind | Path / Descriptor | Notes |
|------|-------------------|-------|
| spec | ... | ... |

### Changed Files
- <path>: <why changed>

### Verification
- <command/check>: <result>

### Pending Next Action
1. <single next action>

### Guard / Risk Notes
- <guard evidence or missing evidence>
- <accepted risk or warning>
```

## Rules

- Be concise; prefer paths and facts over narrative.
- Do not include secrets, raw tokens, or long logs.
- Do not treat audit-only tokens or transcript text as guard authority.
- If the user wants actual compaction, tell them to run the native compact command manually after copying the handoff note.
- If there is no active workflow, still summarize current uncommitted work and next action.
