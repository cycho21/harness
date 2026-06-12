# Deferred Improvements

These items were discussed and intentionally deferred so the harness can improve through real use instead of overbuilding early.

## External Memory Roadmap

Current state: manual active memory, deterministic top-N injection, metrics/feedback logs, secret-save rejection, local `.project-memory/` exclude.

Deferred:

- Candidate auto-extraction from conversation/workflow checkpoints.
- `/memory candidates`, `/memory approve`, `/memory reject`.
- Semantic/vector retrieval and retrieval eval fixture generation from feedback.
- Feedback-aware ranking adjustments.
- Merge/supersede/compact/stale lifecycle commands.
- AGENTS.md promotion proposals.
- Provider-level prompt cache hit-rate measurement.

## Field Log Analysis Workflow

Current state: projects produce `.project-memory/harness/events.jsonl`, export redacted logs, and harness-dev workflows get field-log evidence reminders.

Deferred:

- Import command for redacted field logs in the harness repo.
- LLM-assisted clustering of recurring field failures.
- Field-log-to-memory candidate conversion.
- Automated issue/improvement proposal generation from imported logs.
- Regression test scaffold generation from field-log reproduction hints.

## Environment Validation

Deferred:

- Real macOS end-to-end validation for init/update/doctor/workflow/memory.
- Real Linux end-to-end validation outside CI-like shell tests.
- First-run DPAA venv/network failure matrix.

## Workflow Phase Transition Bugs (Dogfood 2026-06-12)

Observed during dogfood of Critic 7-step protocol integration workflow.

### Fixed: commit 단계 건너뜀 — push로 직접 이동

**재현 경로**: implement 완료 → code_review → review_approved → document → commit 직전에 stale steer inject → `workflow_approve` 호출 → commit 단계를 거치지 않고 push 단계로 직접 전환됨.

**증상**: 커밋이 생성되지 않은 상태에서 push phase 진입. `git-add-all` 명령이 push phase에서 차단됨.

**해결**: `commit → push` 승인 시 `git status --porcelain`을 확인하고, tracked staged/modified 변경이 남아 있으면 `Push blocked: uncommitted changes exist.`로 전환을 차단한다. untracked 파일은 push 대상이 아니므로 차단하지 않는다.

**회귀 테스트**: `tests/test_workflow_ts_static.py::TestWorkflowStateAndPushGuardContracts`, `tests/test_workflow_extension_runtime.py::test_commit_to_push_blocked_when_uncommitted_changes_exist`.

### Fixed: `workflow_state prev` 이유 문자열이 stale steer로 replay됨

**재현 경로**: 구현 중 `workflow_state prev`(reason: "...")를 두 번 호출 → 각 호출의 reason이 steer marker로 저장됨 → workflow 완료(done) 이후 해당 steer들이 늦게 inject되어 이미 완료된 workflow에 `[LLM WORKFLOW ACTION]` 블록 재주입.

**증상 1**: commit 직전 plan 단계로 rollback된 것처럼 보이는 steer inject.
**증상 2**: done 이후 implement 단계로 rollback된 것처럼 보이는 steer inject.

**해결**: `workflow_state prev` 자동 복구 안내는 `sendUserMessage` steer로 큐잉하지 않고 tool result 본문에 포함한다. 또한 phase 전진 시 이전 phase의 pending steer를 정리해 늦게 도착한 steer가 현재 phase를 덮어쓰지 못하게 한다.

**회귀 테스트**: `tests/test_workflow_ts_static.py::TestWorkflowStateAndPushGuardContracts`, `tests/test_workflow_extension_runtime.py::test_workflow_state_autoback_does_not_send_followup_steer_message`, `tests/test_workflow_extension_runtime.py::test_stale_code_review_steer_is_consumed_after_phase_advances_to_commit`.

## Workflow Review Automation Next Steps

Current state: `submit_review_package` records main review, independent reviewer/subagent review summary, quality gate summary, and severity counts; it then triggers `code_review → review_approved` when thresholds and code quality pass. The code-review skill now requires changed-file/hunk coverage confirmation and Critical/Major position validation, with static contract tests guarding those review instructions. DPAA receipts now record `dpaa-report` artifact descriptors for auditability.

Deferred:

- Direct Pi SDK/subagent API integration if/when project-local extensions can invoke reviewer agents directly.
- Structured reviewer artifacts under `.project-memory/workflow/reviews/` if persistence is needed.
- Richer severity taxonomy and reviewer checklist templates per workflow type.
- Automatic review-package quality scoring beyond Critical=0 and Major≤2.
