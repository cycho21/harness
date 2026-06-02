Issue a one-use 10-minute workflow gate skip after explicit user approval.

Usage: `/workflow:skip <dpaa|code-quality|policy-scan> <reason>`

```bash
node .claude/hooks/workflow-gate.cjs skip "$ARGUMENTS"
```
