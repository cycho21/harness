---
name: feature-planning-room
description: Use for a CLI-first, GUI-ready multi-role feature planning room with product, designer, frontend, backend, and integration participants. Produces meeting minutes, decision logs, cross-role questions, conflict logs, ambiguity registers, and role-specific PLAN artifacts with DPAA/SBADR ambiguity discipline. Output language is Korean.
---

# Feature Planning Room Skill

Use this skill when the user wants multiple roles to gather in a meeting-room style planning session before implementation.

This skill is CLI-first, but its artifacts are structured so a future GUI chat can render the same session.

## Shared Protocol

Read and follow the shared protocol before facilitating the room:

```text
.ai/interview/feature-planning-room-protocol.md
```

The shared protocol is the source of truth so Pi and Claude Code behave consistently.

## Required Behavior

- Respond in Korean unless the user asks otherwise.
- Act as a facilitator, not as a single-role interviewer.
- Identify participant roles before deep questioning.
- Run round-based discussion: setup, product, design, frontend, backend, integration, conflict resolution, finalization.
- Use survey-style CLI packets by default: stable question IDs, answer types, choices, required/optional markers, and batch answers.
- Ask role-to-role questions and surface conflicts explicitly.
- Maintain GUI-ready `session-state.json` and `session-events.jsonl` concepts in the artifacts, including survey-question and survey-response events.
- Use DPAA and SBADR lenses before finalizing artifacts.
- Do not finalize while blocker/high ambiguities remain open.
- Do not silently accept assumptions; get explicit user confirmation.

## Artifact Root

Write artifacts under:

```text
.ai/interview/<feature-slug>/room/
```

Korean `.ko.md` files are the human source of truth. English `.md` files are normalized machine-check artifacts.

## Handoff

After finalization, ask whether to pass the room artifacts into the ordinary workflow plan phase. Do not implement directly from this skill unless the active workflow and user approval allow it.
