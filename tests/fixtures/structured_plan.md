# Goal

Implement plan review workflow.

# Steps

```yaml
steps:
  - id: PLAN_REVIEW
    action: review
    target: plan_document
    produces:
      - PLAN_APPROVED
    rollback: Discard review notes and restart.

  - id: IMPLEMENT
    action: implement
    target: approved_plan
    requires:
      - PLAN_APPROVED
    produces:
      - PATCH_CREATED
    rollback: Delete working branch and revert local changes.

  - id: MERGE
    action: merge
    target: patch
    requires:
      - PATCH_CREATED
    produces:
      - MERGED
    rollback: Revert merge commit and notify team.
```

# Acceptance Criteria

PASS if all steps complete within 2 hours.
Run integration test suite: pytest tests/workflow/

# Rollback

Revert merge. Delete feature branch. Notify team via Slack #dev channel.
