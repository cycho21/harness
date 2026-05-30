# company-harness

Harness source repository.

Runtime files that affect PI sessions are isolated under `target/` so developing the harness from this repository root does not automatically load the harness extension, skills, hooks, or context files.

To run the harness as an applied PI target:

```bash
cd target
pi
```

Key runtime entrypoints:

- `target/AGENTS.md`
- `target/WORKFLOW.md`
- `target/.pi/extensions/harness-gates.ts`
- `target/.pi/skills/`
- `target/.pi/personas/`
- `target/.pi/GOVERNANCE.md`
