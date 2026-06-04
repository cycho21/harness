---
name: requirements-room
description: Use for a role-based requirements meeting that is intentionally separate from the normal workflow interview. Facilitates product, design, frontend, backend, QA/integration, and operations perspectives, records cross-role questions and conflicts, and produces a requirements package before ordinary workflow planning. Output language is Korean.
---

# Requirements Room Skill

Use this skill when the user wants to run a requirements meeting with multiple job functions before creating an implementation plan.

This is not the default workflow interview and not the older feature-planning-room draft. It is a meeting facilitator that treats requirements discovery as a collaborative room.

## Shared Protocol

Read and follow the shared protocol before facilitating the room:

```text
.ai/interview/requirements-room-protocol.md
```

The shared protocol is the source of truth so Pi and Claude Code behave consistently.

## Required Behavior

- Respond in Korean unless the user asks otherwise.
- Act as a neutral facilitator, not as a single-role product owner or implementer.
- Start by confirming the meeting goal, participant roles, missing roles, and whether missing roles may be simulated.
- Run the room in short rounds: setup, role framing, cross-role contract, conflict resolution, final review, handoff.
- Ask one small question at a time by default. Use bulk mode only when the user explicitly asks for it.
- Maintain a visible room board: current round, current speaker/role, open blocker/high ambiguities, pending cross-role questions, and next action.
- Capture decisions, assumptions, conflicts, open questions, and role-specific draft requirements as separate artifacts.
- Do not finalize while blocker/high ambiguities remain open.
- Do not silently invent decisions. Offer candidate options, then ask the user to accept, reject, or modify them.
- Produce a requirements package that can be handed to the normal workflow plan phase.

## Artifact Root

Write artifacts under:

```text
.ai/interview/<feature-slug>/requirements-room/
```

Korean `.ko.md` files are the human source of truth. English `.md` files are normalized machine-check artifacts for DPAA/SBADR-style ambiguity checks.

## Handoff

After finalization, ask whether to pass the requirements package into the ordinary workflow plan phase. Do not implement directly from this skill unless the active workflow and user approval allow it.
