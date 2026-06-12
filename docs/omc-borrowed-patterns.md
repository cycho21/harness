# OMC Borrowed Patterns Ledger

This document records useful patterns borrowed or considered from `oh-my-claudecode` so future sessions do not re-import the same ideas blindly.

External reference repository used during research:

```text
I:/tmp/pi-github-repos/yeachan-heo/oh-my-claudecode
https://github.com/yeachan-heo/oh-my-claudecode
```

## Status Legend

| Status | Meaning |
|--------|---------|
| Adopted | Implemented or documented in the harness template. Do not re-borrow as a new concept. Improve only if integrating deeper. |
| Partially adopted | Captured as guidance or a small contract, but not fully mechanized. Future work should extend the existing harness concept, not create a duplicate. |
| Deferred | Useful, but intentionally not adopted yet. Re-evaluate only with a concrete use case. |

## Adopted Patterns

| OMC pattern | Harness adaptation | Primary files |
|-------------|--------------------|---------------|
| Deep interview / topology-first discovery | `deep-interview-lite` in interview skill and workflow wizard; topology, evidence-first brownfield questions, clarity checkpoint, terminology stabilization | `target/.pi/skills/interview/SKILL.md`, `target/.pi/extensions/workflow.ts`, `target/.pi/extensions/workflow/application/workflow-command-router.ts` |
| Trace reasoning protocol | `trace` skill plus `/workflow trace <observation>` command | `target/.pi/skills/trace/SKILL.md`, `target/.pi/extensions/workflow/application/workflow-command-router.ts` |
| Verify before claim | Merged into `evidence-verification` so completion claims and workflow regressions share one evidence protocol | `target/.pi/skills/evidence-verification/SKILL.md` |
| AI slop cleanup | `cleanup` skill for behavior-preserving cleanup passes | `target/.pi/skills/cleanup/SKILL.md` |
| High-risk plan critique | Architect/Critic consensus guidance for high-risk/strict/API/security/migration/data/deploy plans | `target/.pi/WORKFLOW.md`, `target/.pi/extensions/workflow/application/continuation.ts`, `target/.pi/skills/planning-and-task-breakdown/references/plan-template.md` |
| Critic 7-step review protocol | Pre-commitment predictions, changed-file/hunk coverage checks, Critical/Major position validation, gap analysis (what’s missing), self-audit (LOW-confidence findings → 검토 필요), realist check (severity pressure-test), ADVERSARIAL escalation (Critical ≥1 → expand scope) added to code-review skill; FRAGILE assumption rating and pre-mortem added to plan_review high-risk path; DPAA (linguistic clarity) and Critic (logical soundness) kept as independent layers | `target/.pi/skills/code-review/SKILL.md`, `target/.pi/WORKFLOW.md`, `target/.pi/skills/planning-and-task-breakdown/references/plan-template.md` |
| Manual compact handoff | `compact-handoff` skill; prepares resume note but does not invoke native compaction | `target/.pi/skills/compact-handoff/SKILL.md` |
| Artifact descriptor handoff | Standard descriptor contract for large handoffs with kind/path/producer/retention/size/hash/summary | `target/.pi/extensions/workflow/artifact-descriptor.ts` |
| Tool failure recovery | Merged into `continuation-safety`; retryability classes and harness-specific recovery patterns | `target/.pi/skills/continuation-safety/SKILL.md` |
| Pending async/subagent work safety | Merged into `continuation-safety`; blocks completion/commit/push/compaction when delegated work is uncollected | `target/.pi/skills/continuation-safety/SKILL.md` |
| Worktree cleanup safety | `worktree-safety` skill; `.worktrees/` only, dirty preservation, symlink refusal, no stale-dir auto-delete | `target/.pi/skills/worktree-safety/SKILL.md` |
| Skill/protocol protection taxonomy | Phase protection levels plus default-flow vs conditional-protocol separation | `target/.pi/WORKFLOW.md`, `docs/workflow-protocol-taxonomy.md` |
| Prompt/behavior contract testing mindset | Prompt contract documentation and static tests for critical protocol text | `docs/workflow-prompt-contracts.md`, `tests/test_workflow_ts_static.py` |
| Runtime event map | Workflow event-flow documentation from start through push/recovery | `docs/workflow-runtime-events.md` |
| Self-improve benchmark idea | Merged into `evidence-verification` as small workflow regression benchmark matrix | `target/.pi/skills/evidence-verification/SKILL.md` |
| Path-based push risk classifier | Push policy scan now flags high-risk path segments and filenames such as auth/session/security/secret/token/permission and `schema.prisma` as a distinct category, extending existing push policy rather than adding a new gate | `target/.pi/extensions/workflow/gates.ts`, `tests/test_push_policy_scan.py` |
| Actionable-vs-optional failure hinting | `/workflow status` surfaces the latest actionable field-log failure while suppressing optional environment follow-up noise such as CoreNLP/Docker startup failures | `target/.pi/extensions/workflow/field-log.ts`, `target/.pi/extensions/workflow/application/workflow-command-router.ts`, `tests/test_workflow_runtime_modules.py` |

## Partially Adopted Patterns

| OMC pattern | Current harness state | Future extension rule |
|-------------|-----------------------|-----------------------|
| Subagent tracker / async ownership | Guidance exists in `continuation-safety`; reviewer subagent timeout is raised in `target/.pi/settings.json`; no mechanical runtime tracker yet | Extend workflow status/review gates if mechanizing. Do not add another pending-work skill. |
| Stop/idle hook blocking | Some continuation/reminder behavior exists; pending async ownership is not mechanically blocked | Add runtime checks only if real dogfood shows missed pending work. |
| Artifact descriptor integration | Descriptor helpers exist; large `submit_review_package` payloads are written as review descriptors, DPAA receipts now include `dpaa-report` descriptors, and trace/verification outputs are still skill-level reports rather than automatic artifacts | Continue wiring existing `artifact-descriptor.ts` into outputs instead of defining a second descriptor format. |
| Dogfood/runtime fixture benchmarks | Runtime fixture tests now cover interview wizard topology/clarity wrapping, `/workflow trace` routing, and high-risk plan-review continuation prompts; full manual dogfood is still pending | Extend existing workflow runtime tests for new behavior, using `evidence-verification` for evidence. |
| Phase protection levels | Documented only; not a hard gate taxonomy | Mechanize only where a concrete phase safety bug appears. |
| Compact lifecycle | `compact-handoff` exists; no automatic resume validation | Extend `compact-handoff`, do not add a separate resume skill. |
| Status/HUD surfacing | `/workflow status` now shows conditional protocol hints only when runtime triggers exist, such as missing commit verification evidence or review artifact write failure; no always-on checklist is added | Add more status hints only for concrete triggers; avoid making conditional protocols look mandatory. |
| Bridge routing/fallback | Runtime fixture tests now cover trace observation-missing fallback, sendUserMessage-unavailable fallback, and unknown-command status fallback; a full OMC-style routing matrix is not adopted | Prefer targeted command-router fixture tests over new protocol docs. |
| Security/review hardening | Some path/policy/worktree rules exist | Add focused tests/rules for concrete protected-path or policy failures. |

## Deferred / Not Adopted Yet

| OMC pattern | Reason deferred |
|-------------|-----------------|
| Full OMC deep-interview ontology/threshold/state machine | Too heavy for current Pi workflow; `deep-interview-lite` is the chosen adaptation. |
| Full self-improve autonomous loop | High complexity and risk of runaway workflow changes; keep as evidence/benchmark guidance for now. |
| Full team runtime / worker orchestration clone | Pi already has subagent tooling; only borrow safety and ownership concepts. |
| HUD/notification layer clone | Useful later, but currently secondary to workflow correctness and dogfood tests. |
| New mandatory gates for every borrowed protocol | Would increase flow complexity; conditional protocols remain situational unless mechanically justified. |

## Anti-Duplication Rules for Future Sessions

1. Check this ledger before borrowing more from OMC.
2. If a pattern is listed as Adopted, improve the existing harness file instead of creating a new skill or protocol.
3. If a pattern is Partially adopted, extend the named current adaptation rather than renaming or duplicating it.
4. Prefer merging over adding when the idea is another form of verification, continuation safety, cleanup, or context handoff.
5. Keep the default workflow linear; conditional protocols must stay trigger-based.
6. When adding new OMC-derived behavior, update this ledger with status, adaptation, files, and future rule.
7. Critic protocol is now Adopted; do not re-borrow `agents/critic.md` patterns as a new concept. Extend `code-review/SKILL.md` or `WORKFLOW.md` instead.

## Suggested Next Borrowing Targets

If future work continues OMC borrowing, prioritize:

1. Wiring `artifact-descriptor.ts` into trace/verification outputs beyond review packages and DPAA receipts.
2. Additional status surfacing only for concrete pending-work/last-failure triggers, without making protocols mandatory.
3. Additional command-router fallback tests only when a new route or capability fallback is added.
4. Additional manual dogfood transcripts for full `/workflow start` UX.
5. deep-interview mathematical ambiguity scoring (per-component topology scoring, ontology stability tracking) — extend existing interview skill when a concrete dogfood gap appears.
6. Ralplan pre-execution gate — intercepts vague execution requests; evaluate if harness workflow needs this or if the interview phase already covers it adequately.
