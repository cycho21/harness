"""
Static analysis tests for workflow TypeScript extension files.

Checks for known failure patterns without running Node.js:
  - Missing imports that would cause ReferenceError at runtime
  - Variable shadowing of module-level imports
  - Required exports / function signatures
  - Gate message language (LLM-facing strings must be English)
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT_DIR = ROOT / "target" / ".pi" / "extensions" / "workflow"
WORKFLOW_TS = ROOT / "target" / ".pi" / "extensions" / "workflow.ts"


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
