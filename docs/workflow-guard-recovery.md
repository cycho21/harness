# Workflow Guard Recovery Guide

This guide documents common workflow guard failures, recovery steps, and the local audit trail used to inspect recurring friction.

## 1. Guard block

A guard block means the workflow refused a phase transition or tool action because a required condition was not met.

Recovery:

1. Read the guard message and identify the named gate or phase.
2. Fix the underlying cause first.
3. Retry the same workflow action after the fix.
4. Use a skip only when the user explicitly accepts the risk.

Audit check:

```text
.project-memory/harness/audit.jsonl
```

Look for `eventType: "guard_block"`.

## 2. DPAA failure

DPAA blocks `plan_review -> implement` when the implementation plan is ambiguous or insufficiently measurable.

Recovery:

1. Update `.ai/interview/plan.ko.md` first.
2. Update `.ai/interview/plan.md` as the faithful English translation.
3. Replace vague actions with concrete files, assertions, commands, and thresholds.
4. Retry `workflow_approve` so DPAA runs again.

## 3. Skip usage

A skip is an accepted-risk exception. It should not be proposed before a real fix attempt.

Recovery:

1. Explain the specific gate failure and risk to the user.
2. Use the skip tool only after explicit user approval.
3. Confirm that the audit log records `eventType: "guard_skip"`.

## 4. Missing approval dialog incident

Observed incident: during this hardening workflow, the `plan_review -> implement` approval dialog was not shown before DPAA precheck failure returned the workflow to `plan`.

Interpretation: treat this as an `approval_boundary_anomaly` until verified. Do not assume root cause from a single occurrence.

Recurrence check:

1. Inspect `.project-memory/harness/audit.jsonl`.
2. Search for `eventType: "approval_boundary_anomaly"`.
3. Confirm whether `fromPhase` is `plan_review`, `toPhase` is `implement`, and `result` mentions precheck before approval dialog.
4. If the event recurs, compare the timestamp with the user-visible approval prompt behavior.

## 5. Audit log inspection

The audit trail is stored separately from the richer field failure log:

```text
.project-memory/harness/audit.jsonl
```

Allowed audit fields are intentionally small: timestamp, event type, workflow id, phase, from/to phase, gate, result, severity, and reason summary. Raw prompts and raw transcripts must not be stored.

Related detailed diagnostic log:

```text
.project-memory/harness/events.jsonl
```
