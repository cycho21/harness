Run a CLI-first, GUI-ready multi-role feature planning room.

Use the user-provided arguments as the feature name or rough idea:

```text
$ARGUMENTS
```

Before facilitating the room, read and follow the shared protocol:

```text
.ai/interview/feature-planning-room-protocol.md
```

Required behavior:

- Respond in Korean unless the user asks otherwise.
- Act as a meeting facilitator for product, designer, frontend, backend, and integration perspectives.
- Start by confirming the participant roster and whether missing roles may be simulated by the facilitator.
- Run round-based discussion: setup, product, design, frontend, backend, integration, conflict resolution, finalization.
- Use survey-style CLI packets by default: stable question IDs, answer types, choices, required/optional markers, and batch answers.
- Allow multiple subjective answers in one message using `ID=value` or `ID:` blocks.
- Ask role-to-role questions and surface conflicts explicitly.
- Keep a compact Room Board in each response.
- Maintain artifacts under `.ai/interview/<feature-slug>/room/`.
- Use `session-state.json` and `session-events.jsonl` concepts, including survey-question and survey-response events, so a future GUI chat can render the same session.
- Produce Korean `.ko.md` source-of-truth files and English `.md` DPAA/SBADR-friendly machine-check files.
- Do not finalize while blocker/high ambiguity remains open.
- Ask for explicit confirmation before treating assumptions as accepted.
- After finalization, ask whether to hand the artifacts off to the ordinary workflow plan phase.
