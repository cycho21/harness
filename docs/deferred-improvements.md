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

### Bug 1: commit 단계 건너뜀 — push로 직접 이동

**재현 경로**: implement 완료 → code_review → review_approved → document → commit 직전에 stale steer inject → `workflow_approve` 호출 → commit 단계를 거치지 않고 push 단계로 직접 전환됨.

**증상**: 커밋이 생성되지 않은 상태에서 push phase 진입. `git-add-all` 명령이 push phase에서 차단됨.

**임시 조치**: `workflow_state prev`로 commit 단계 복귀 후 수동 `git add -A` + `git-commit` 실행.

**수정 방향**: commit → push 전환 시 uncommitted changes가 존재하면 extension이 블로킹하거나 경고해야 함. 또는 `workflow_approve`가 commit 단계에서 staged changes 없이 push로 넘어가지 않도록 guard 추가.

### Bug 2: `workflow_state prev` 이유 문자열이 stale steer로 replay됨

**재현 경로**: 구현 중 `workflow_state prev`(reason: "...")를 두 번 호출 → 각 호출의 reason이 steer marker로 저장됨 → workflow 완료(done) 이후 해당 steer들이 늦게 inject되어 이미 완료된 workflow에 `[LLM WORKFLOW ACTION]` 블록 재주입.

**증상 1**: commit 직전 plan 단계로 rollback된 것처럼 보이는 steer inject.
**증상 2**: done 이후 implement 단계로 rollback된 것처럼 보이는 steer inject.

**임시 조치**: git status / git log로 실제 상태 확인 후 무시.

**수정 방향**: `workflow_state prev` 복구 steer는 phase 전진 시 즉시 소비(consume)되어야 함. 현재 forward transition이 stale steer를 청소하지 않는 것으로 보임. workflow가 done 또는 다음 phase로 이미 전진한 경우 이전 phase steer를 inject하지 않도록 marker 만료 로직 점검.

## Workflow Review Automation Next Steps

Current state: `submit_review_package` records main review, independent reviewer/subagent review summary, quality gate summary, and severity counts; it then triggers `code_review → review_approved` when thresholds and code quality pass.

Deferred:

- Direct Pi SDK/subagent API integration if/when project-local extensions can invoke reviewer agents directly.
- Structured reviewer artifacts under `.project-memory/workflow/reviews/` if persistence is needed.
- Richer severity taxonomy and reviewer checklist templates per workflow type.
- Automatic review-package quality scoring beyond Critical=0 and Major≤2.
