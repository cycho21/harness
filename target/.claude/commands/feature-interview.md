Run a separate, highly detailed feature-development interview that produces role-specific PLAN artifacts for product, design, frontend, backend, and integration.

Use the user-provided arguments as the feature name or rough idea:

```text
$ARGUMENTS
```

Before asking questions, read and follow the shared protocol:

```text
.ai/interview/feature-interview-protocol.md
```

Required behavior:

- Respond in Korean unless the user asks otherwise.
- Be deliberately detailed; the goal is to remove ambiguity, not to minimize questions.
- Maintain an ambiguity register throughout the interview.
- Use DPAA and SBADR lenses before finalizing artifacts.
- Create artifacts under `.ai/interview/<feature-slug>/`.
- Produce Korean `.ko.md` source-of-truth files and English `.md` normalized machine-check files.
- Do not finalize while blocker/high ambiguity remains open.
- Ask for explicit confirmation before treating assumptions as accepted.
- After finalization, ask whether to hand the artifacts off to the ordinary workflow plan phase.
