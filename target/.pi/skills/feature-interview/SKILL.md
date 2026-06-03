---
name: feature-interview
description: Use for a separate, highly detailed feature-development interview that produces product, design, frontend, backend, integration, and ambiguity-register PLAN artifacts before ordinary workflow planning. Designed to remove ambiguity with DPAA and SBADR lenses. Output language is Korean.
---

# Feature Interview Skill

Use this skill when the user explicitly asks for a separate enhanced interview, role-specific planning, ambiguity removal, or new-feature discovery before implementation.

This is different from the default `interview` skill. The default interview creates one spec and one plan. This skill creates role-specific plans for:

- product/planning
- design/UX
- frontend
- backend
- integration

## Shared Protocol

Read and follow the shared protocol before interviewing:

```text
.ai/interview/feature-interview-protocol.md
```

The shared protocol is the source of truth so Pi and Claude Code behave consistently.

## Required Behavior

- Respond in Korean unless the user asks otherwise.
- Be deliberately detailed. Do not optimize for short interviews when requirements are ambiguous.
- Maintain an ambiguity register throughout the conversation.
- Use DPAA and SBADR lenses before finalizing artifacts.
- Do not finalize while blocker/high ambiguities remain open.
- Do not silently accept assumptions; get explicit user confirmation.

## Artifact Root

Write artifacts under:

```text
.ai/interview/<feature-slug>/
```

Use Korean `.ko.md` files as the human source of truth and English `.md` files as normalized machine-check artifacts.

## Handoff

After finalization, ask whether to pass the artifacts into the ordinary workflow plan phase. Do not implement directly from this skill unless the active workflow and user approval allow it.
