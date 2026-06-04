Run a role-based requirements meeting that is separate from the normal workflow interview.

Use the user-provided arguments as the feature name or rough idea:

```text
$ARGUMENTS
```

Before facilitating the room, read and follow the shared protocol:

```text
.ai/interview/requirements-room-protocol.md
```

Required behavior:

- Respond in Korean unless the user asks otherwise.
- Act as a neutral requirements-room facilitator, not as a single-role interviewer or implementer.
- Start by confirming the meeting goal, participant roles, missing roles, and whether missing roles may be simulated.
- Run short rounds: setup, role framing, cross-role contract, conflict resolution, final review, handoff.
- Ask one small question at a time by default. Use bulk mode only when the user explicitly asks for it.
- Keep a compact Room Board in each response.
- Maintain artifacts under `.ai/interview/<feature-slug>/requirements-room/`.
- Record `session-state.json` and `session-events.jsonl` concepts so a future GUI can render the meeting.
- Produce Korean `.ko.md` source-of-truth files and English `.md` normalized machine-check files.
- Mark simulated role contributions as candidate perspectives, not accepted decisions.
- Do not finalize while blocker/high ambiguities remain open.
- Ask for explicit confirmation before treating assumptions as accepted.
- After finalization, ask whether to hand the requirements package off to the ordinary workflow plan phase.
