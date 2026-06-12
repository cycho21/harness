"""
Static analysis tests for workflow TypeScript extension files.

Checks for known failure patterns without running Node.js:
  - Missing imports that would cause ReferenceError at runtime
  - Variable shadowing of module-level imports
  - Required exports / function signatures
  - Gate message language (LLM-facing strings must be English)
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT_DIR = ROOT / "target" / ".pi" / "extensions" / "workflow"
WORKFLOW_TS = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"
CODE_REVIEW_SKILL = ROOT / "target" / ".pi" / "skills" / "code-review" / "SKILL.md"


def _skill_src(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _src(name: str) -> str:
    return (EXT_DIR / name).read_text(encoding="utf-8")


def _workflow_src() -> str:
    return WORKFLOW_TS.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# state.ts
# ---------------------------------------------------------------------------

class TestStateTs:
    def test_path_is_imported(self):
        """state.ts must not use path.* without importing node:path."""
        src = _src("state.ts")
        uses_path = bool(re.search(r"\bpath\.\w+", src))
        has_import = "from \"node:path\"" in src or "require(\"node:path\")" in src or "require('node:path')" in src
        if uses_path:
            assert has_import, (
                "state.ts uses path.* but does not import node:path — "
                "this causes 'path is not defined' at runtime"
            )

    def test_save_workflow_uses_storage_dir_not_path_dirname(self):
        """saveWorkflow must not call path.dirname — use getWorkflowStateDir() instead."""
        src = _src("state.ts")
        assert "path.dirname" not in src, (
            "saveWorkflow called path.dirname(file) without importing path. "
            "Use getWorkflowStateDir() from storage instead."
        )

    def test_save_workflow_uses_get_workflow_state_dir(self):
        src = _src("state.ts")
        assert "getWorkflowStateDir" in src
        assert "getWorkflowStateDir" in (EXT_DIR / "storage.ts").read_text(encoding="utf-8")

    def test_advance_workflow_uses_shared_policy_for_phase_order(self):
        src = _src("state.ts")
        assert "sharedNextPhase" in src
        assert "isSharedAutoAdvancePhase" in src
        assert "isSharedTransitionAllowed" in src
        assert "WORKFLOW_PHASES.indexOf" not in src
        assert "AUTO_ADVANCE_FROM_PHASES" not in src

    def test_advance_workflow_is_exported(self):
        src = _src("state.ts")
        assert "export async function advanceWorkflow" in src

    def test_save_workflow_is_exported(self):
        src = _src("state.ts")
        assert "export function saveWorkflow" in src


# ---------------------------------------------------------------------------
# workflow.ts — variable shadowing
# ---------------------------------------------------------------------------

class TestWorkflowTsResponsibilitySplit:
    def test_workflow_entrypoint_imports_responsibility_modules(self):
        src = _workflow_src()
        expected_imports = [
            'from "./workflow/transitions"',
            'from "./workflow/gate-runner"',
            'from "./workflow/checkpoint-commands"',
            'from "./workflow/command-policy"',
            'from "./workflow/application/continuation"',
            'from "./workflow/application/prompt-context"',
            'from "./workflow/application/tool-call-gate"',
            'from "./workflow/application/workflow-command-router"',
        ]
        missing = [item for item in expected_imports if item not in src]
        assert not missing, f"workflow.ts must delegate responsibility groups via imports: {missing}"

    def test_workflow_entrypoint_has_no_inline_continuation_or_prompt_context_logic(self):
        src = _workflow_src()
        assert "WORKFLOW_CONTINUATION_MARKER_PREFIX" not in src
        assert "WORKFLOW_STEER_MARKER_PREFIX" not in src
        assert "function buildWorkflowContinuationPrompt" not in src
        assert "formatWorkflowReminders(scanWorkflowReminders" not in src
        assert "async function ensureExtensionMutationApproved" not in src
        assert "function isProductionClassPath" not in src
        assert "hasGitDashC(cmd)" not in src
        assert 'pi.registerCommand("workflow"' not in src
        assert "registerWorkflowCommand(pi" in src
        router_src = (EXT_DIR / "application" / "workflow-command-router.ts").read_text(encoding="utf-8")
        assert "export type WorkflowCommandRequest" in router_src
        assert "export function parseWorkflowCommand" in router_src
        assert "parseWorkflowCommand(args)" in router_src
        tool_call_idx = src.index('pi.on("tool_call"')
        tool_call_block = src[tool_call_idx:tool_call_idx + 240]
        assert "handleWorkflowToolCall(state, event, ctx" in tool_call_block
        assert "validateWorkflowWorkspace" not in tool_call_block

    def test_clean_architecture_modules_exist(self):
        required = [
            EXT_DIR / "application" / "continuation.ts",
            EXT_DIR / "application" / "prompt-context.ts",
            EXT_DIR / "application" / "extension-mutation-approval.ts",
            EXT_DIR / "application" / "tool-call-gate.ts",
            EXT_DIR / "application" / "workflow-command-router.ts",
            EXT_DIR / "domain" / "ambiguity-gate-policy.ts",
            EXT_DIR / "domain" / "production-class-policy.ts",
        ]
        missing = [str(path.relative_to(ROOT)) for path in required if not path.exists()]
        assert not missing, f"Clean architecture modules missing: {missing}"

    def test_responsibility_modules_exist_with_named_exports(self):
        required_exports = {
            "transitions.ts": ["export async function precheckPlanReviewBeforeApproval", "export async function executeWorkflowApproval"],
            "gate-runner.ts": ["export async function returnToPlanAfterDpaaBlock", "export function formatWorkflowGateBlockedMessage"],
            "checkpoint-commands.ts": ["export function createManualWorkspaceCheckpoint", "export function restoreManualWorkspaceCheckpoint"],
            "command-policy.ts": ["export async function executeWorkflowCatalogCommand", "export function formatWorkflowToolsListing"],
        }
        for filename, exports in required_exports.items():
            src = _src(filename)
            for export in exports:
                assert export in src, f"{filename} must expose {export}"


class TestWorkflowTsPolicySOT:
    def test_manual_state_uses_shared_policy_phase_helpers(self):
        src = (EXT_DIR / "application" / "workflow-command-router.ts").read_text(encoding="utf-8")
        assert "sharedWorkflowPhases" in src
        assert "isSharedWorkflowPhase" in src
        state_block = src[src.index('if (command === "state")'):]
        assert "sharedWorkflowPhases" in state_block
        assert "isSharedWorkflowPhase" in state_block
        assert "WORKFLOW_PHASES" not in state_block


class TestAmbiguityGatePolicy:
    def test_adaptive_ambiguity_policy_supports_risk_levels(self):
        src = (EXT_DIR / "domain" / "ambiguity-gate-policy.ts").read_text(encoding="utf-8")
        assert '"advisory" | "standard" | "strict"' in src
        assert "blocksDpaaFail" in src
        assert "blocksSbadrFail" in src
        assert "STRICT_PATTERNS" in src
        assert "ADVISORY_PATTERNS" in src
        assert "titleSource" in src
        assert "strictSource" in src
        assert "parseAmbiguityPolicyMetadata" in src
        assert "ambiguity gate" in src
        assert "work type" in src

    def test_dpaa_gate_uses_adaptive_policy_before_blocking(self):
        src = _src("gates.ts")
        assert "classifyAmbiguityGatePolicy" in src
        assert "!ambiguityPolicy.blocksDpaaFail" in src
        assert "!ambiguityPolicy.blocksSbadrFail" in src
        assert "DPAA advisory skipped: no plan required" in src


class TestWorkflowTsShadowing:
    def test_no_const_path_shadowing_node_path(self):
        """No block-level 'const path' that shadows the node:path import."""
        src = _workflow_src()
        assert "import * as path from" in src, "workflow.ts must import node:path"
        const_path_count = src.count("const path ")
        assert const_path_count == 0, (
            f"Found {const_path_count} 'const path' declaration(s) in workflow.ts — "
            "this shadows the node:path import and causes ReferenceError at runtime"
        )

    def test_no_let_var_path_shadowing(self):
        src = _workflow_src()
        for decl in ["let path ", "var path "]:
            assert decl not in src, f"'{decl}' shadows node:path import in workflow.ts"

    def test_transition_path_variable_name_used(self):
        """The workflow command router must use 'transitionPath', not 'path', for the transition string."""
        src = (EXT_DIR / "application" / "workflow-command-router.ts").read_text(encoding="utf-8")
        assert "transitionPath" in src


# ---------------------------------------------------------------------------
# gates.ts — SBADR integration
# ---------------------------------------------------------------------------

class TestGatesTsSbadr:
    def test_is_core_nlp_installed_defined(self):
        src = _src("gates.ts")
        assert "function isCoreNlpInstalled" in src

    def test_install_core_nlp_defined(self):
        src = _src("gates.ts")
        assert "function installCoreNlp" in src

    def test_can_import_sbadr_defined(self):
        src = _src("gates.ts")
        assert "function canImportSbadr" in src

    def test_run_sbadr_analysis_defined(self):
        src = _src("gates.ts")
        assert "function runSbadrAnalysis" in src

    def test_sbadr_runs_after_dpaa_pass(self):
        src = _src("gates.ts")
        # The call to isCoreNlpInstalled() must appear after the DPAA PASS check.
        # Find the PASS branch, then verify the call is inside it.
        pass_idx = src.index('if (report.level === "PASS")')
        # Find the first call (not definition) of isCoreNlpInstalled after PASS check
        sbadr_call_idx = src.index("isCoreNlpInstalled()", pass_idx)
        assert sbadr_call_idx > pass_idx, "SBADR must run only after DPAA PASS"

    def test_sbadr_fail_calls_write_field_log(self):
        src = _src("gates.ts")
        # Both DPAA fail and SBADR fail should log
        assert src.count("writeFieldLogEvent") >= 3

    def test_sbadr_fail_message_is_english(self):
        src = _src("gates.ts")
        sbadr_block_start = src.index("function runSbadrAnalysis")
        sbadr_gate_start = src.index("if (sr.verdict === \"FAIL\")")
        # Extract SBADR FAIL gate block
        sbadr_fail_block = src[sbadr_gate_start:sbadr_gate_start + 1500]
        korean_pattern = re.compile(r"[가-힣]{3,}")
        matches = korean_pattern.findall(sbadr_fail_block)
        assert not matches, (
            f"SBADR FAIL gate message contains Korean (LLM-facing must be English): {matches}"
        )

    def test_sbadr_stdio_inherits_stderr(self):
        """CoreNLP startup progress must be visible — stderr should be inherited."""
        src = _src("gates.ts")
        assert 'stdio: ["pipe", "pipe", "inherit"]' in src, (
            "runSbadrAnalysis must use stdio: ['pipe','pipe','inherit'] "
            "so CoreNLP startup progress is visible"
        )

    def test_sbadr_skip_uses_dpaa_gate_exception(self):
        src = _src("gates.ts")
        assert "dpaa gate one-use exception" in src.lower() or "shares the dpaa gate one-use exception" in src

    def test_install_core_nlp_handles_both_platforms(self):
        src = _src("gates.ts")
        assert "setup_corenlp.ps1" in src
        assert "setup_corenlp.sh" in src
        assert 'process.platform === "win32"' in src


# ---------------------------------------------------------------------------
# catalog.ts — doctor + prerequisites
# ---------------------------------------------------------------------------

class TestCatalogTs:
    def test_sbadr_in_prerequisite_required_paths(self):
        src = _src("catalog.ts")
        assert '".pi/sbadr"' in src

    def test_setup_corenlp_sh_in_prerequisite_required_paths(self):
        src = _src("catalog.ts")
        assert '".pi/setup_corenlp.sh"' in src

    def test_doctor_checks_sbadr_import(self):
        src = _src("catalog.ts")
        assert "sbadr.cli" in src or "sbadr import" in src.lower()

    def test_doctor_checks_java(self):
        src = _src("catalog.ts")
        assert "java" in src.lower()

    def test_doctor_checks_corenlp_installed(self):
        src = _src("catalog.ts")
        assert "corenlp" in src.lower()
        assert "stanford-corenlp-" in src

    def test_doctor_checks_dpaa_import(self):
        src = _src("catalog.ts")
        assert "dpaa.cli" in src

    def test_doctor_checks_removed_claude_assets(self):
        src = _src("catalog.ts")
        assert "legacy .claude assets" in src
        assert '".claude"' in src


class TestPlanMetadataDocs:
    def test_plan_templates_document_ambiguity_policy_metadata(self):
        plan_template = (ROOT / "target" / ".pi" / "skills" / "planning-and-task-breakdown" / "references" / "plan-template.md").read_text(encoding="utf-8")
        interview_skill = (ROOT / "target" / ".pi" / "skills" / "interview" / "SKILL.md").read_text(encoding="utf-8")
        dpaa_skill = (ROOT / "target" / ".pi" / "skills" / "dpaa" / "SKILL.md").read_text(encoding="utf-8")
        combined = "\n".join([plan_template, interview_skill, dpaa_skill])
        assert "Ambiguity gate:" in combined
        assert "Risk:" in combined
        assert "Work type:" in combined


class TestDeepInterviewLiteWizard:
    def test_workflow_tool_adds_topology_and_clarity_questions(self):
        src = _workflow_src()
        assert "buildDeepInterviewLiteQuestions" in src
        assert "round_0_topology" in src
        assert "clarity_checkpoint" in src
        assert "deep-interview-lite" in src

    def test_workflow_start_prompt_mentions_deep_interview_lite_followups(self):
        src = _src("application/workflow-command-router.ts")
        assert "Round 0 topology confirmation" in src
        assert "clarity checkpoint" in src
        assert "weakest remaining clarity dimension" in src
        assert "inspect narrow repo evidence" in src


class TestTraceAndConsensusProtocols:
    def test_workflow_trace_command_is_registered(self):
        src = _src("application/workflow-command-router.ts")
        assert "trace <observation>" in src
        assert "Run the harness trace protocol" in src
        assert "Discriminating Probe" in src

    def test_plan_review_continuation_mentions_high_risk_consensus(self):
        src = _src("application/continuation.ts")
        assert "high-risk" in src
        assert "Architect/Critic consensus review" in src
        assert "Work type: api/security/migration/data/deploy" in src

    def test_plan_template_documents_high_risk_consensus(self):
        plan_template = (ROOT / "target" / ".pi" / "skills" / "planning-and-task-breakdown" / "references" / "plan-template.md").read_text(encoding="utf-8")
        assert "High-Risk Consensus Review" in plan_template
        assert "Architect review" in plan_template
        assert "Critic review" in plan_template


class TestCompactionAndArtifactContracts:
    def test_compact_handoff_skill_documents_resume_contract(self):
        skill = (ROOT / "target" / ".pi" / "skills" / "compact-handoff" / "SKILL.md").read_text(encoding="utf-8")
        assert "Compact Handoff" in skill
        assert "Workflow State" in skill
        assert "Verification Evidence" in skill
        assert "Guard State" in skill
        assert "must not claim to run" in skill

    def test_artifact_descriptor_contract_has_required_fields(self):
        src = _src("artifact-descriptor.ts")
        for token in ["ArtifactDescriptor", "kind", "path", "producer", "retention", "sizeBytes", "sha256", "summary"]:
            assert token in src
        assert "createArtifactHandoff" in src
        assert "DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES" in src

    def test_dpaa_receipt_records_report_descriptor(self):
        types_src = _src("types.ts")
        artifacts_src = _src("artifacts.ts")
        assert "import type { ArtifactDescriptor }" in types_src
        assert "reportDescriptor?: ArtifactDescriptor" in types_src
        assert "describeArtifact" in artifacts_src
        assert 'kind: "dpaa-report"' in artifacts_src
        assert 'component: "dpaa"' in artifacts_src
        assert "Report artifact" in artifacts_src

    def test_workflow_docs_record_abort_and_descriptor_contracts(self):
        guide = (ROOT / "target" / ".pi" / "WORKFLOW.md").read_text(encoding="utf-8")
        assert "Abort/cancel semantics" in guide
        assert "does not create guard evidence" in guide
        assert "Large handoffs should use an artifact descriptor" in guide

    def test_continuation_safety_skill_documents_retryability_and_pending_work(self):
        skill = (ROOT / "target" / ".pi" / "skills" / "continuation-safety" / "SKILL.md").read_text(encoding="utf-8")
        assert "Retryability" in skill
        assert "workflow_apply_approved_edit" in skill
        assert "DPAA/SBADR failure" in skill
        assert "Workspace mismatch" in skill
        assert "Do not silently retry mutating operations" in skill
        assert "subagent/reviewer is still running" in skill
        assert "Do not submit `submit_review_package`" in skill
        assert "Do not treat a timed-out subagent as success" in skill
        assert "background generator/test/server may still mutate" in skill

    def test_worktree_safety_skill_documents_cleanup_guards(self):
        skill = (ROOT / "target" / ".pi" / "skills" / "worktree-safety" / "SKILL.md").read_text(encoding="utf-8")
        assert "project-root `.worktrees/`" in skill
        assert "Do not remove dirty worktrees" in skill
        assert "Refuse symlinked worktree paths" in skill
        assert "Do not delete a stale plain directory automatically" in skill

    def test_evidence_verification_skill_documents_checks_and_benchmark(self):
        skill = (ROOT / "target" / ".pi" / "skills" / "evidence-verification" / "SKILL.md").read_text(encoding="utf-8")
        assert "Verification Summary" in skill
        assert "Acceptance Criteria Coverage" in skill
        assert "Workflow Regression Benchmark" in skill
        assert "Baseline" in skill
        assert "Target behavior" in skill
        assert "Regression risk" in skill
        assert "Do not claim runtime UX is validated by static tests alone" in skill
        assert "dogfood-required" in skill

    def test_workflow_guide_mentions_merged_safety_and_evidence_protocols(self):
        guide = (ROOT / "target" / ".pi" / "WORKFLOW.md").read_text(encoding="utf-8")
        assert "continuation-safety" in guide
        assert "subagents, async jobs, background commands, or delegated reviewers" in guide
        assert "evidence-verification" in guide
        assert "baseline, target behavior, verification evidence, and dogfood gaps" in guide

    def test_workflow_guide_documents_phase_protection_levels(self):
        guide = (ROOT / "target" / ".pi" / "WORKFLOW.md").read_text(encoding="utf-8")
        assert "Phase Protection Levels" in guide
        assert "light" in guide and "medium" in guide and "heavy" in guide and "terminal" in guide
        assert "do not proceed until required review/gate evidence exists" in guide
        assert "They do not replace mechanical guard evidence" in guide

    def test_runtime_events_doc_covers_main_flow(self):
        doc = (ROOT / "docs" / "workflow-runtime-events.md").read_text(encoding="utf-8")
        assert "Start Flow" in doc
        assert "workflow_interview_wizard" in doc
        assert "DPAA/SBADR precheck" in doc
        assert "git push" in doc
        assert "/workflow trace" in doc
        assert "compact-handoff" in doc

    def test_protocol_taxonomy_separates_default_flow_from_conditional_protocols(self):
        doc = (ROOT / "docs" / "workflow-protocol-taxonomy.md").read_text(encoding="utf-8")
        assert "Default Flow" in doc
        assert "Conditional Protocols" in doc
        assert "do **not** add mandatory steps to every workflow" in doc
        assert "interview → plan → plan_review → implement → code_review → review_approved → document → commit → push → done" in doc
        for token in ["trace", "evidence-verification", "continuation-safety", "compact-handoff", "worktree-safety", "cleanup"]:
            assert token in doc
        assert "Prefer merging over adding" in doc

    def test_omc_borrowed_patterns_ledger_prevents_duplicate_borrowing(self):
        doc = (ROOT / "docs" / "omc-borrowed-patterns.md").read_text(encoding="utf-8")
        assert "OMC Borrowed Patterns Ledger" in doc
        assert "Adopted Patterns" in doc
        assert "Partially Adopted Patterns" in doc
        assert "Deferred / Not Adopted Yet" in doc
        assert "Anti-Duplication Rules for Future Sessions" in doc
        assert "Check this ledger before borrowing more from OMC" in doc
        assert "Deep interview / topology-first discovery" in doc
        assert "Artifact descriptor integration" in doc
        assert "reviewer subagent timeout is raised" in doc
        assert "Full self-improve autonomous loop" in doc

    def test_template_settings_raise_reviewer_subagent_timeout(self):
        settings = json.loads((ROOT / "target" / ".pi" / "settings.json").read_text(encoding="utf-8"))
        assert settings["subagents"]["agentOverrides"]["reviewer"]["maxExecutionTimeMs"] == 300000

    def test_workflow_guide_points_to_protocol_taxonomy(self):
        guide = (ROOT / "target" / ".pi" / "WORKFLOW.md").read_text(encoding="utf-8")
        assert "Default Flow vs Conditional Protocols" in guide
        assert "situational safety tools" in guide
        assert "do not add them as mandatory checklist items" in guide
        assert "docs/workflow-protocol-taxonomy.md" in guide

    def test_prompt_contracts_doc_lists_contract_surfaces(self):
        doc = (ROOT / "docs" / "workflow-prompt-contracts.md").read_text(encoding="utf-8")
        assert "Workflow Prompt Contracts" in doc
        assert "[LLM WORKFLOW ACTION]" in doc
        assert "interview wizard kickoff rules" in doc
        assert "high-risk consensus guidance" in doc
        assert "submit_review_package" in doc
        assert "changed-file/hunk coverage checks" in doc
        assert "Critical/Major position validation" in doc
        assert "real `git push` completion event" in doc

    def test_status_hints_surface_review_artifact_write_failures(self):
        src = (EXT_DIR / "application" / "workflow-command-router.ts").read_text(encoding="utf-8")
        assert "reviewArtifactError" in src
        assert "review artifact write failed" in src.lower()
        assert "evidence-verification" in src


# ---------------------------------------------------------------------------
# format.ts — phase guidance
# ---------------------------------------------------------------------------

class TestFormatTs:
    def test_plan_review_mentions_sbadr(self):
        src = _src("format.ts")
        plan_review_idx = src.index('"plan_review"')
        guidance_block = src[plan_review_idx:plan_review_idx + 300]
        assert "SBADR" in guidance_block, (
            "plan_review phaseGuidance must mention SBADR "
            "since both DPAA and SBADR run on plan_review → implement"
        )

    def test_plan_review_mentions_dpaa(self):
        src = _src("format.ts")
        plan_review_idx = src.index('"plan_review"')
        guidance_block = src[plan_review_idx:plan_review_idx + 300]
        assert "DPAA" in guidance_block


# ---------------------------------------------------------------------------
# gates.ts — formatGateBlocked LLM message language
# ---------------------------------------------------------------------------

class TestGateMessageLanguage:
    """All formatGateBlocked 'why' and 'next' strings must be English."""

    def _extract_gate_blocked_args(self, src: str) -> list[str]:
        """Extract content of formatGateBlocked({...}) calls."""
        pattern = re.compile(r"formatGateBlocked\(\{(.*?)\}\)", re.DOTALL)
        return [m.group(1) for m in pattern.finditer(src)]

    def test_workspace_mismatch_gate_message_english(self):
        src = _src("gates.ts")
        workspace_idx = src.index('"Workflow Workspace"')
        block = src[workspace_idx:workspace_idx + 800]
        korean = re.findall(r"[가-힣]{3,}", block)
        assert not korean, f"Workspace gate message has Korean: {korean}"

    def test_push_policy_gate_message_english(self):
        src = _src("gates.ts")
        policy_idx = src.index('"Push Policy Scan"')
        block = src[policy_idx:policy_idx + 800]
        korean = re.findall(r"[가-힣]{3,}", block)
        assert not korean, f"Push policy gate message has Korean: {korean}"

    def test_dpaa_gate_next_actions_english(self):
        src = _src("gates.ts")
        dpaa_gate_idx = src.index('"DPAA"')
        block = src[dpaa_gate_idx:dpaa_gate_idx + 600]
        korean = re.findall(r"[가-힣]{3,}", block)
        assert not korean, f"DPAA gate message has Korean: {korean}"

    def test_code_quality_gate_message_english(self):
        src = _src("gates.ts")
        cq_idx = src.index('"Code Quality"')
        block = src[cq_idx:cq_idx + 600]
        korean = re.findall(r"[가-힣]{3,}", block)
        assert not korean, f"Code Quality gate message has Korean: {korean}"

    def test_dpaa_table_headers_english(self):
        src = _src("gates.ts")
        for korean_header in ["항목", "결과", "검증 기록", "스냅샷", "상위 Findings"]:
            assert korean_header not in src, (
                f"Korean table header '{korean_header}' found in gates.ts — "
                "LLM-facing table headers must be English"
            )

    def test_recent_output_label_english(self):
        src = _src("gates.ts")
        assert "최근 출력" not in src
        assert "Recent output" in src

    def test_guard_block_default_handling_contract(self):
        src = _src("gates.ts")
        assert "Default handling for the LLM" in src
        assert "Do not ask the user to skip this gate" in src
        assert "fix the underlying cause and retry the workflow transition" in src
        assert "Ask the user only when the fix requires product/architecture input or a workflow approval boundary" in src
        assert "Ask the user only when the fix requires product/architecture input, a workflow approval boundary, or an accepted-risk exception" not in src

    def test_guard_block_section_order(self):
        src = _src("gates.ts")
        body = src[src.index("export function formatGateBlocked"):]
        ordered = [
            '"Why blocked:"',
            '"Default handling for the LLM:"',
            '"Next actions:"',
            '"Accepted-risk exception path:"',
            '"Caution:"',
        ]
        positions = [body.index(item) for item in ordered]
        assert positions == sorted(positions)

    def test_guard_specific_handling_overrides(self):
        src = _src("gates.ts")
        assert "Do not try to satisfy this gate by editing files" in src
        assert "changing workflow state, or simulating evidence" in src
        assert "Do not silently fix or hide risky changes" in src
        assert "interactive policy approval path" in src

    def test_workflow_gate_blocked_message_reinforces_default_handling(self):
        src = (EXT_DIR / "application" / "workflow-command-router.ts").read_text(encoding="utf-8")
        assert "Default handling: do not ask the user for a skip first" in src
        assert "Fix the underlying cause within the current phase when possible" in src
        assert "Ask the user only for product/architecture input" in src

    def test_dpaa_precheck_runs_before_user_approval_dialog(self):
        workflow_src = _workflow_src()
        transition_src = _src("transitions.ts")
        gate_runner_src = _src("gate-runner.ts")
        precheck = transition_src.index("deps.precheckPlanReviewBeforeApproval(ctx)")
        confirm = transition_src.index("ctx.ui.confirm(")
        assert precheck < confirm
        assert "executeWorkflowApproval(state, params.summary, ctx" in workflow_src
        assert "DPAA precheck failed before user approval" in gate_runner_src
        assert "transitionWorkflow(state.workflow, \"plan\", \"dpaa_precheck_repair_required\")" not in workflow_src
        assert "deps.transitionWorkflow(state.workflow, \"plan\", \"dpaa_precheck_repair_required\")" in gate_runner_src

    def test_dpaa_warn_is_advisory_not_hard_block(self):
        src = _src("gates.ts")
        warn = src.index('if (report.level === "WARN")')
        fail_log = src.index('severity: "blocker"', warn)
        assert warn < fail_log
        warn_block = src[warn:fail_log]
        assert "ok: true" in warn_block
        assert "DPAA advisory: WARN findings detected before implementation" in warn_block


# ---------------------------------------------------------------------------
# reminders.ts — all English (LLM-injected)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# code-review/SKILL.md — Critic 7-step protocol contract tests
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# workflow.ts — workflow_state autoback and commit→push guard contracts
# ---------------------------------------------------------------------------

class TestWorkflowStateAndPushGuardContracts:
    """Guard that Bug 1 and Bug 2 fixes remain in place."""

    def test_autoback_does_not_call_steer_llm(self):
        """Bug 2 fix: workflow_state isAutoBack must NOT call steerLlm (sendUserMessage).
        The kick-off instructions must be returned in the tool result content."""
        src = _workflow_src()
        # The steerLlm call must not exist inside the isAutoBack block.
        # We verify by checking the kick-off is built as 'kickOff' const (not a void call).
        assert "const kickOff = isAutoBack" in src, (
            "workflow.ts must build kick-off as 'const kickOff = isAutoBack ...' "
            "(returned in tool result, not sent via steerLlm)"
        )
        # steerLlm(kickOff, ...) must NOT appear — only kickOff in content is allowed
        assert "steerLlm(kickOff" not in src, (
            "workflow.ts must not call steerLlm(kickOff, ...) "
            "— stale follow-up steers bypass onUserPrompt stale-marker check"
        )

    def test_push_guard_checks_uncommitted_changes(self):
        """Bug 1 fix: confirmPushPolicyForPushPhase must check for uncommitted changes."""
        src = _workflow_src()
        assert "git status --porcelain" in src, (
            "workflow.ts confirmPushPolicyForPushPhase must run 'git status --porcelain' "
            "to block push when uncommitted changes exist"
        )
        assert "uncommitted changes exist" in src.lower() or "Push blocked" in src, (
            "workflow.ts must emit a clear message when uncommitted changes block push"
        )


class TestCodeReviewSkillCriticProtocol:
    """Guard that the Critic protocol keywords remain present in the code-review skill."""

    def test_pre_commitment_present(self):
        """Phase 0: pre-commitment prediction step must be in the review process."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "pre-commitment" in src.lower(), (
            "code-review/SKILL.md must contain 'pre-commitment' step "
            "(Critic protocol Phase 0 — deliberate search before reading code)"
        )

    def test_gap_analysis_present(self):
        """Gap analysis ('what is missing') must be an explicit review step."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "gap analysis" in src.lower(), (
            "code-review/SKILL.md must contain 'gap analysis' step "
            "(explicit search for missing error handling, tests, edge cases)"
        )

    def test_coverage_pass_present(self):
        """Changed-file/hunk coverage must be explicit to avoid partial review claims."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "coverage pass" in src.lower()
        assert "changed files/hunks" in src.lower()
        assert "reviewed or explicitly skipped" in src.lower()

    def test_position_validation_present(self):
        """Critical/Major findings must verify file and line references before reporting."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "position validation" in src.lower()
        assert "critical/major" in src.lower()
        assert "line range" in src.lower()

    def test_self_audit_present(self):
        """Self-audit step must be present to filter low-confidence findings."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "self-audit" in src.lower(), (
            "code-review/SKILL.md must contain 'self-audit' step "
            "(LOW-confidence findings moved to 검토 필요 section)"
        )

    def test_realist_check_present(self):
        """Realist Check must be present to pressure-test severity labels."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "realist check" in src.lower(), (
            "code-review/SKILL.md must contain 'realist check' step "
            "(severity pressure-test before final report)"
        )

    def test_adversarial_escalation_present(self):
        """ADVERSARIAL escalation rule must be in Review Rules."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "adversarial" in src.lower(), (
            "code-review/SKILL.md must contain 'ADVERSARIAL' escalation rule "
            "(expand scope when Critical >= 1 is confirmed)"
        )

    def test_output_format_has_gap_section(self):
        """Output format must include a 'what is missing' section."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "뭐가 빠졌나" in src, (
            "code-review/SKILL.md output format must include '뭐가 빠졌나?' section "
            "(gap analysis results visible to the user)"
        )

    def test_output_format_has_review_scope_confirmation(self):
        """Output format must expose reviewed/skipped scope to users."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "리뷰 범위 확인" in src
        assert "제외한 파일과 사유" in src

    def test_output_format_has_review_needed_section(self):
        """Output format must include a low-confidence findings section."""
        src = _skill_src(CODE_REVIEW_SKILL)
        assert "검토 필요" in src, (
            "code-review/SKILL.md output format must include '검토 필요' section "
            "(self-audit low-confidence findings)"
        )


class TestRemindersTs:
    def test_mechanical_reminder_strings_english(self):
        src = _src("reminders.ts")
        # Only the section titles (Documentation, Verification etc.) and items are LLM-injected
        # Korean is only acceptable in structural brackets
        reminder_pattern = re.compile(
            r"(Workflow Mechanical Reminders|Action:|Do not silently|address each|No recent test|"
            r"No automated review|Commit phase|Harness runtime)", re.IGNORECASE
        )
        assert reminder_pattern.search(src), "reminders.ts LLM strings appear to have changed"


# ---------------------------------------------------------------------------
# storage.ts — exports required by state.ts
# ---------------------------------------------------------------------------

class TestStorageTs:
    def test_get_workflow_state_dir_exported(self):
        src = _src("storage.ts")
        assert "export function getWorkflowStateDir" in src

    def test_get_workflow_state_path_exported(self):
        src = _src("storage.ts")
        assert "export function getWorkflowStatePath" in src
