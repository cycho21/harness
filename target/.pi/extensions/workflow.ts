/**
 * workflow.ts — Pi Extension
 *
 * Implements the harness final-stage gates and advisory workflow layer as a
 * Pi extension.
 *
 * Gates:
 *   1. Push Review Gate — require explicit user confirmation of code review guard before git push
 *   2. Workflow Workspace Gate — active workflow pushes must happen from the bound worktree/branch
 *   3. Push Policy Scan — flag risky build/config/migration/Docker/CI/deletion/large-change pushes
 *
 * Additional behavior:
 *   - resources_discover: register bundled harness skills with Pi
 *   - session_start: show branch and untested-class context
 *   - before_agent_start: inject gate/workflow state into the system prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  addSkipToken,
  advanceWorkflow,
  clearPersistedWorkflow,
  createArtifactSnapshot,
  createWorkflow,
  consumeSkipToken,
  createWorkspaceCheckpoint,
  formatArtifactSnapshotCreated,
  formatGateBlocked,
  exportFieldLogs,
  formatHarnessDoctor,
  formatLatestDpaaAudit,
  formatRecentFieldLogs,
  formatWorkflowReminders,
  formatPushPolicyScanBlocked,
  formatWorkflowPrerequisiteScan,
  formatWorkflowHistory,
  formatWorkflowPrompt,
  formatWorkflowAction,
  formatWorkflowStatus,
  formatWorkspaceMismatch,
  getBranch,
  getGitRoot,
  getUntestedClasses,
  getWorkspaceStatusSignature,
  hasGitDashC,
  isGitPush,
  getNextPhase,
  loadPersistedWorkflow,
  saveWorkflow,
  scanWorkflowReminders,
  scanPushPolicy,
  scanWorkflowPrerequisites,
  shouldOfferInputCheckpoint,
  shortInputReason,
  writeFieldLogEvent,
  validateWorkflowWorkspace,
  transitionWorkflow,
  isSharedWorkflowPhase,
  sharedWorkflowPhases,
  isSharedAutoAdvancePhase,
  isSharedApprovalBoundary,
  getPhaseWritePathPolicy,
  isWritePathBlocked,
  matchesWriteGlob,
  sha256File,
  findPlanForDpaa,
  getCatalogCommand,
  PHASE_ALLOWED_BUILTIN_TOOLS,
  validateEditPath,
  computeBaseFileHashes,
  verifyBaseFileHashes,
  applyProposedEdit,
  formatEditScopeDiff,
  createEditScope,
  type EditScope,
  type ProposedEdit,
  type WorkflowInstance,
  type WorkflowPhase,
} from "./workflow/core";
import { launchInterviewWizard } from "./workflow/interview-ui";
import {
  createWorkflowRuntimeState,
  HARNESS_TOKEN_TYPES,
} from "./workflow/runtime-state";
import {
  colorResultLabel,
  formatTransitionDetails,
  refreshWorkflowBoard,
  refreshWorkflowStatus,
  resultBox,
} from "./workflow/runtime-ui";
import {
  applyPhaseToolPolicyForHost,
  formatExtensionMutationApprovalReason,
  requiresExtensionMutationApproval,
  suggestWorkflowCommandTypo,
} from "./workflow/runtime-policy";
import {
  executeWorkflowApproval,
  precheckPlanReviewBeforeApproval as runPlanReviewPrecheck,
} from "./workflow/transitions";
import {
  returnToPlanAfterDpaaBlock as returnToPlanAfterDpaaBlockWithDeps,
} from "./workflow/gate-runner";
import {
  createManualWorkspaceCheckpoint,
  formatManualWorkspaceCheckpoints,
  redoManualWorkflowCheckpoint,
  restoreManualWorkspaceCheckpoint,
  undoManualWorkflowCheckpoint,
} from "./workflow/checkpoint-commands";
import {
  executeWorkflowCatalogCommand,
  formatWorkflowToolsListing,
} from "./workflow/command-policy";

// This file lives at: <harness-root>/.pi/extensions/workflow.ts
const HARNESS_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_CONTINUATION_MARKER_PREFIX = "harness-workflow-continuation:";
const WORKFLOW_STEER_MARKER_PREFIX = "harness-workflow-steer:";

export default function (pi: ExtensionAPI) {
  // ── In-memory state ────────────────────────────────────────────────────────
  // Process memory only: the LLM cannot forge this guard evidence through shell/file writes.
  const state = createWorkflowRuntimeState();

  // ── Guard token audit entries ────────────────────────────────────────────
  // Runtime guard evidence lives in current process memory only. CustomEntries
  // are retained for audit/debugging and are never restored as authority.

  function persistGuardToken(type: string, data: Record<string, unknown>): void {
    try { pi.appendEntry(type, { ...data, persistedAt: Date.now(), auditOnly: true }); } catch { /* non-fatal */ }
  }

  /** LLM에게 교정 지시를 주입합니다. 사용자에게 묻지 않고 LLM이 스스로 수정하도록 유도합니다.
   * @param deliverAs "steer"(기본): 현재 tool batch 직후 개입. "followUp"은 workflow 종료 후까지 밀릴 수 있어 예외적으로만 사용합니다. */
  async function steerLlm(message: string, deliverAs: "followUp" | "steer" = "steer"): Promise<void> {
    try {
      const workflow = state.workflow;
      if (!workflow) {
        await (pi as any).sendUserMessage(message, { deliverAs });
        return;
      }
      const marker = `${workflow.id}:${workflow.phase}:${Date.now()}`;
      state.pendingSteerMessages.set(marker, { workflowId: workflow.id, phase: workflow.phase, marker, issuedAt: Date.now() });
      if (state.pendingSteerMessages.size > 20) {
        const oldest = state.pendingSteerMessages.keys().next().value;
        if (oldest) state.pendingSteerMessages.delete(oldest);
      }
      await (pi as any).sendUserMessage([message, workflowSteerMarkerComment(marker)].join("\n"), { deliverAs });
    } catch { /* non-fatal */ }
  }

  /**
   * implement 페이즈에서 TDD 대상인 production 클래스 경로인지 판단합니다.
   * 제외 suffix(Entity, Dto 등) 및 제외 디렉토리(dto/, entity/ 등)는 false.
   */
  function isProductionClassPath(filePath: string, _gitRoot: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    if (!/\/src\/main\/java\/.+\.java$/.test(normalized)) return false;
    if (/\/dto\/|\/entity\/|\/model\/|\/repository\//.test(normalized)) return false;
    const className = path.basename(filePath, ".java");
    if (/^Q[A-Z]|^Migration/.test(className)) return false;
    const EXCLUDE = /(Entity|Dto|VO|Vo|Request|Response|Payload|Config|Configuration|Application|Properties|Settings|Exception|Error|Enum|Record|Constants|Constant|Event|Message|Projection|Form)$/i;
    return !EXCLUDE.test(className);
  }

  // ── Phase-based tool policy ─────────────────────────────────────────────────
  // Restricts the LLM’s callable tool surface to what’s appropriate for the
  // active workflow phase. Call after any phase change or on session restore.
  // ── Workflow board widget ──────────────────────────────────────────────────
  function refreshBoard(ctx: { hasUI: boolean; ui: { setWidget: (...args: unknown[]) => void; theme?: unknown } }): void {
    refreshWorkflowBoard(state, ctx);
  }

  function refreshStatus(ctx: { hasUI: boolean; ui: { setStatus?: (...args: unknown[]) => void; theme?: unknown } }): void {
    refreshWorkflowStatus(state, ctx);
  }

  function applyPhaseToolPolicy(phase: WorkflowPhase | null): void {
    applyPhaseToolPolicyForHost(pi as unknown as { getAllTools?: () => Array<{ name: string; sourceInfo: { source: string } }>; setActiveTools?: (names: string[]) => void }, phase);
  }

  function workflowContinuationMarker(workflow: WorkflowInstance): string {
    return `${workflow.id}:${workflow.phase}:${workflow.updatedAt}`;
  }

  function workflowContinuationMarkerComment(marker: string): string {
    return `<!-- ${WORKFLOW_CONTINUATION_MARKER_PREFIX}${marker} -->`;
  }

  function workflowSteerMarkerComment(marker: string): string {
    return `<!-- ${WORKFLOW_STEER_MARKER_PREFIX}${marker} -->`;
  }

  function extractWorkflowMarker(text: string, prefix: string): string | undefined {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<!--\\s*${escaped}([^\\s>]+)\\s*-->`).exec(text)?.[1];
  }

  function extractWorkflowContinuationMarker(text: string): string | undefined {
    return extractWorkflowMarker(text, WORKFLOW_CONTINUATION_MARKER_PREFIX);
  }

  function extractWorkflowSteerMarker(text: string): string | undefined {
    return extractWorkflowMarker(text, WORKFLOW_STEER_MARKER_PREFIX);
  }

  function cancelWorkflowContinuationPending(): void {
    if (state.workflowContinuationPending) {
      state.cancelledWorkflowContinuationMarkers.add(state.workflowContinuationPending.marker);
      if (state.cancelledWorkflowContinuationMarkers.size >= 20) {
        const oldest = state.cancelledWorkflowContinuationMarkers.values().next().value;
        if (oldest) state.cancelledWorkflowContinuationMarkers.delete(oldest);
      }
    }
    state.workflowContinuationPending = null;
  }

  function consumeCancelledWorkflowContinuationPrompt(text: string): boolean {
    const marker = extractWorkflowContinuationMarker(text);
    return marker ? state.cancelledWorkflowContinuationMarkers.delete(marker) : false;
  }

  function consumeStaleWorkflowSteerPrompt(text: string): boolean {
    const marker = extractWorkflowSteerMarker(text);
    if (!marker) return false;
    const pending = state.pendingSteerMessages.get(marker);
    const [markerWorkflowId, markerPhase] = marker.split(":");
    const expectedWorkflowId = pending?.workflowId ?? markerWorkflowId;
    const expectedPhase = pending?.phase ?? (isSharedWorkflowPhase(markerPhase) ? markerPhase : null);
    if (!expectedWorkflowId || !expectedPhase) return false;
    const current = state.workflow;
    const isStale = !current || current.id !== expectedWorkflowId || current.phase !== expectedPhase;
    state.pendingSteerMessages.delete(marker);
    return isStale;
  }

  function clearPendingWorkflowSteersExceptCurrent(): void {
    const current = state.workflow;
    if (!current) {
      state.pendingSteerMessages.clear();
      return;
    }
    for (const [marker, pending] of state.pendingSteerMessages.entries()) {
      if (pending.workflowId !== current.id || pending.phase !== current.phase) {
        state.pendingSteerMessages.delete(marker);
      }
    }
  }

  function clearPendingWorkflowSteersForPhase(workflowId: string | null | undefined, phase: WorkflowPhase): void {
    if (!workflowId) return;
    for (const [marker, pending] of state.pendingSteerMessages.entries()) {
      if (pending.workflowId === workflowId && pending.phase === phase) {
        state.pendingSteerMessages.delete(marker);
      }
    }
  }

  const SKIPPABLE_WORKFLOW_GATES = ["dpaa", "code-quality", "policy-scan"] as const;
  type SkippableWorkflowGate = typeof SKIPPABLE_WORKFLOW_GATES[number];

  function isSkippableWorkflowGate(value: string): value is SkippableWorkflowGate {
    return (SKIPPABLE_WORKFLOW_GATES as readonly string[]).includes(value);
  }

  const SKIPPABLE_WORKFLOW_GATE_DESCRIPTIONS: Record<SkippableWorkflowGate, string> = {
    "dpaa": "DPAA ambiguity analysis gate (plan_review → implement)",
    "code-quality": "Code quality/test gate (code_review → review_approved)",
    "policy-scan": "Push policy scan gate (commit → push)",
  };

  async function recordWorkflowGateSkip(gate: SkippableWorkflowGate, reason: string, ctx: any): Promise<{ ok: boolean; gate: SkippableWorkflowGate; reason?: string }> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) return { ok: false, gate, reason: "missing-reason" };
    const failures = state.gateFailures.get(gate) ?? 0;
    if (!ctx?.hasUI) return { ok: false, gate, reason: "no-ui" };
    const ok = await ctx.ui.confirm(
      "Workflow gate skip 승인 확인",
      [
        `${gate} gate를 1회 예외 처리합니다.`,
        `대상: ${SKIPPABLE_WORKFLOW_GATE_DESCRIPTIONS[gate]}`,
        failures > 0 ? `현재 연속 실패 횟수: ${failures}` : "현재 기록된 실패 횟수: 0",
        "",
        `사유: ${trimmedReason}`,
        "",
        "이 skip은 accepted-risk로 기록되며 10분 TTL의 1회성 예외입니다.",
      ].join("\n"),
    );
    if (!ok) return { ok: false, gate, reason: "user-declined" };
    addSkipToken(gate, trimmedReason);
    if (gate === "dpaa" && state.workflow) {
      state.dpaaGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "skip-preapproved" };
    }
    state.gateFailures.delete(gate);
    clearPendingWorkflowSteersForPhase(state.workflow?.id, gate === "dpaa" ? "plan_review" : gate === "code-quality" ? "code_review" : "commit");
    writeFieldLogEvent({
      type: "gate.skipped",
      category: gate === "policy-scan" ? "push-policy" : gate === "code-quality" ? "code-quality" : "dpaa",
      severity: "warning",
      status: "accepted-risk",
      workflowId: state.workflow?.id,
      phase: state.workflow?.phase,
      gate,
      findingCode: "gate.skip.accepted-risk",
      action: "skip-gate-once",
      impact: "Repeated exceptions may indicate guard false positives or missing workflow affordances.",
      primaryMessage: trimmedReason,
      improvementKind: gate === "dpaa" ? "dpaa-rule" : "workflow-rule",
    });
    return { ok: true, gate };
  }

  function markWorkflowContinuationDelivered(text: string | undefined): void {
    if (!text) return;
    const marker = extractWorkflowContinuationMarker(text);
    if (marker && state.workflowContinuationPending?.marker === marker) state.workflowContinuationPending = null;
  }

  async function returnToPlanAfterDpaaBlock(ctx: any, message: string): Promise<string> {
    if (state.workflow?.phase === "plan_review") {
      const workflowId = state.workflow.id;
      const failures = (state.gateFailures.get("dpaa") ?? 0) + 1;
      state.gateFailures.set("dpaa", failures);
      state.dpaaGuardSatisfiedToken = null;
      clearPendingWorkflowSteersForPhase(workflowId, "plan_review");
      applyPhaseToolPolicy("plan");
    }
    return returnToPlanAfterDpaaBlockWithDeps(state, ctx, message, {
      transitionWorkflow,
      saveWorkflow,
      refreshBoard,
      refreshStatus,
      steerLlm,
    });
  }

  async function precheckPlanReviewBeforeApproval(ctx: any): Promise<{ ok: true } | { ok: false; text: string }> {
    return runPlanReviewPrecheck(state, ctx, returnToPlanAfterDpaaBlock);
  }

  function clearActiveWorkflowAfterCompletion(): void {
    cancelWorkflowContinuationPending();
    state.pendingSteerMessages.clear();
    state.workflow = null;
    state.dpaaGuardSatisfiedToken = null;
    state.codeQualityGuardSatisfiedToken = null;
    state.codeReviewGuardSatisfiedToken = null;
    state.pushExecutionGuardSatisfiedToken = null;
    state.reviewPackageToken = null;
    state.policyApprovals = [];
    state.gateFailures = new Map();
  }

  function isGitPushDryRun(cmd: string): boolean {
    return /(?:^|\s)(?:--dry-run|-n)(?:\s|$)/.test(cmd);
  }

  function shouldSendWorkflowContinuation(workflow: WorkflowInstance, transitions: Array<{ from: WorkflowPhase; to: WorkflowPhase }> | undefined): boolean {
    if (!transitions?.some((item) => isSharedAutoAdvancePhase(item.from))) return false;
    return ["plan_review", "code_review", "commit"].includes(workflow.phase);
  }

  function buildWorkflowContinuationPrompt(workflow: WorkflowInstance, marker: string): string {
    return [
      "Continue the workflow from the current phase.",
      "",
      formatWorkflowAction(workflow),
      "",
      "Rules:",
      "- Continue only within the current phase and its required actions.",
      "- Do not cross a user-approval boundary automatically.",
      "- Do not bypass DPAA, SBADR, submit_review_package, quality, policy, or workspace guards.",
      "- If the current phase requires user approval, present the required summary/question and stop.",
      "",
      workflowContinuationMarkerComment(marker),
    ].join("\n");
  }

  async function queueWorkflowContinuation(piApi: ExtensionAPI, ctx: any, workflow: WorkflowInstance | null, transitions: Array<{ from: WorkflowPhase; to: WorkflowPhase }> | undefined): Promise<void> {
    if (!workflow || !shouldSendWorkflowContinuation(workflow, transitions)) return;
    if (state.workflowContinuationPending?.workflowId === workflow.id && state.workflowContinuationPending.phase === workflow.phase) return;
    if (ctx.hasPendingMessages?.()) return;
    if (typeof (piApi as any).sendUserMessage !== "function") return;
    cancelWorkflowContinuationPending();

    const marker = workflowContinuationMarker(workflow);
    state.workflowContinuationPending = { workflowId: workflow.id, phase: workflow.phase, marker };
    try {
      if (state.workflow?.id !== workflow.id || state.workflow.phase !== workflow.phase) {
        state.workflowContinuationPending = null;
        return;
      }
      const prompt = buildWorkflowContinuationPrompt(workflow, marker);
      if (!ctx.isIdle?.()) {
        // Do not queue continuation as followUp while the agent is busy. In long
        // automatic workflows, followUp can remain pending until the workflow is
        // already finished, then arrive as stale "Follow-up: ..." input.
        state.workflowContinuationPending = null;
        return;
      }
      await (piApi as any).sendUserMessage(prompt);
    } catch (error) {
      state.workflowContinuationPending = null;
      ctx.ui.notify(`Workflow continuation prompt failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  async function ensureExtensionMutationApproved(toolName: string, input: unknown, ctx: any): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!requiresExtensionMutationApproval(toolName, input)) return { ok: true };
    const currentWorkflowId = state.workflow?.id ?? "no-workflow";
    if (state.extensionMutationApprovedForWorkflowId === currentWorkflowId) return { ok: true };
    const reason = formatExtensionMutationApprovalReason(toolName, input);
    if (!ctx.hasUI) {
      return { ok: false, reason: [reason, "", "대화형 사용자 승인이 필요하지만 현재 UI를 사용할 수 없어 extension 수정을 차단했습니다."].join("\n") };
    }
    if (typeof ctx.ui.select === "function") {
      const choice = await ctx.ui.select(
        [reason, "", "위 harness extension 파일 수정을 어떻게 처리하시겠습니까?"].join("\n"),
        [
          "예 — 이번만 허용",
          "예 — 이번 워크플로우에서 계속 허용",
          "아니오",
        ],
      );
      if (choice === "예 — 이번 워크플로우에서 계속 허용") {
        state.extensionMutationApprovedForWorkflowId = currentWorkflowId;
        return { ok: true };
      }
      if (choice === "예 — 이번만 허용") return { ok: true };
      return { ok: false, reason: "Harness extension modification blocked: user did not approve this tool call." };
    }

    const approved = await ctx.ui.confirm(
      "Harness extension 수정 승인 확인",
      [reason, "", "이번 tool call에서만 harness extension 파일 수정을 허용하시겠습니까?"].join("\n"),
    );
    return approved ? { ok: true } : { ok: false, reason: "Harness extension modification blocked: user did not approve this tool call." };
  }

  function pushPolicySignature(policyScan: ReturnType<typeof scanPushPolicy>): string {
    return JSON.stringify({
      totalChanged: policyScan.totalChanged,
      findings: policyScan.findings
        .map((finding) => ({ category: finding.category, files: [...finding.files].sort() }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    });
  }

  async function confirmPushPolicyForPushPhase(ctx: any): Promise<boolean> {
    const policySkip = consumeSkipToken("policy-scan");
    if (policySkip) {
      const scan = scanPushPolicy();
      state.policyApprovals.push({ timestamp: Date.now(), totalChanged: scan.totalChanged, categories: scan.findings.map((f) => f.category), signature: pushPolicySignature(scan) });
      if (state.policyApprovals.length > 20) state.policyApprovals.shift();
      return true;
    }

    const policyScan = scanPushPolicy();
    if (policyScan.ok) return true;

    const signature = pushPolicySignature(policyScan);
    const lastApproval = state.policyApprovals.at(-1);
    if (lastApproval?.signature === signature) return true;

    if (!ctx.hasUI) {
      ctx.ui.notify([
        formatPushPolicyScanBlocked(policyScan),
        "",
        "push 단계 진입에는 위험 변경 사항에 대한 사용자 확인이 필요하지만 현재 UI를 사용할 수 없습니다.",
        "대화형 세션에서 다시 시도하거나, 사용자에게 명시 승인받은 뒤 `/workflow skip policy-scan <reason>`을 실행하세요.",
      ].join("\n"), "warning");
      return false;
    }

    const approved = await ctx.ui.confirm(
      "Push policy scan 승인 확인",
      [
        formatPushPolicyScanBlocked(policyScan),
        "",
        "위 위험 변경 사항을 확인했으며 push 단계로 계속 진행하시겠습니까?",
        "",
        "예: 현재 git push를 계속 진행합니다.",
        "Interactive user approval advanced the workflow; record policy approval in extension memory only.",
        "아니오: git push를 차단합니다.",
      ].join("\n"),
    );
    if (!approved) return false;

    state.policyApprovals.push({
      timestamp: Date.now(),
      totalChanged: policyScan.totalChanged,
      categories: policyScan.findings.map((finding) => finding.category),
      signature,
    });
    if (state.policyApprovals.length > 20) state.policyApprovals.shift();
    return true;
  }

  // ── resources_discover: register bundled harness skills ───────────────────
  pi.on("resources_discover", async () => {
    const skillsPath = path.join(HARNESS_ROOT, ".pi", "skills");
    if (!fs.existsSync(skillsPath)) return;
    return { skillPaths: [skillsPath] };
  });

  // ── Tool: submit_review_package — records main/subagent review evidence ──
  pi.registerTool({
    name: "submit_review_package",
    label: "Submit review package",
    description: "Record the main-agent self-review, independent reviewer/subagent review, and quality-gate summary before automated review approval.",
    parameters: Type.Object({
      mainReviewSummary: Type.String({ description: "Main agent self-review summary and fixes performed." }),
      reviewerReviewSummary: Type.String({ description: "Independent reviewer/subagent findings summary." }),
      qualityGateSummary: Type.String({ description: "Quality gate/test/lint/typecheck result summary." }),
      critical: Type.Number({ description: "Critical issue count after fixes." }),
      major: Type.Number({ description: "Major issue count after fixes." }),
      minor: Type.Number({ description: "Minor issue count after fixes." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.workflow) {
        return { content: [{ type: "text", text: "No active workflow. Start /workflow first." }], details: { ok: false } };
      }
      if (state.workflow.phase !== "code_review") {
        return { content: [{ type: "text", text: `Review package can be submitted only in code_review phase. Current phase: ${state.workflow.phase}` }], details: { ok: false } };
      }
      const critical = Number(params.critical);
      const major = Number(params.major);
      const minor = Number(params.minor);
      const missing = [params.mainReviewSummary, params.reviewerReviewSummary, params.qualityGateSummary].some((value) => !String(value ?? "").trim());
      if (missing || !Number.isFinite(critical) || !Number.isFinite(major) || !Number.isFinite(minor)) {
        return { content: [{ type: "text", text: "Review package rejected: main review, independent reviewer review, quality gate summary, and severity counts are required." }], details: { ok: false } };
      }
      if (critical > 0 || major > 2) {
        state.reviewPackageToken = null;
        return { content: [{ type: "text", text: `Review package rejected: Critical=${critical} (required 0), Major=${major} (required ≤2). Return to implement, fix issues, then review again.` }], details: { ok: false, critical, major, minor } };
      }

      cancelWorkflowContinuationPending();
      state.reviewPackageToken = {
        workflowId: state.workflow.id,
        timestamp: Date.now(),
        critical,
        major,
        minor,
        mainSummary: String(params.mainReviewSummary),
        reviewerSummary: String(params.reviewerReviewSummary),
        qualitySummary: String(params.qualityGateSummary),
      };
      persistGuardToken(HARNESS_TOKEN_TYPES.REVIEW_PACKAGE, state.reviewPackageToken as unknown as Record<string, unknown>);

      const result = await advanceWorkflow(state.workflow, "automated_review_package");
      const notices: string[] = [
        `Review package accepted: Critical=${critical}, Major=${major}, Minor=${minor}.`,
      ];
      if (result.ok) {
        state.codeQualityGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "automated_review_package" };
        state.codeReviewGuardSatisfiedToken = { critical, major, minor, timestamp: Date.now() };
        persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY, state.codeQualityGuardSatisfiedToken as unknown as Record<string, unknown>);
        persistGuardToken(HARNESS_TOKEN_TYPES.CODE_REVIEW, { ...state.codeReviewGuardSatisfiedToken, workflowId: state.workflow.id });
        state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
        if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
        notices.push(result.message);
        notices.push("Automated review approved: review package and quality gate satisfied.");
      } else {
        notices.push(result.message);
      }
      notices.push("", formatWorkflowAction(state.workflow));
      if (result.ok) {
        applyPhaseToolPolicy(state.workflow.phase);
        clearPendingWorkflowSteersExceptCurrent();
        refreshBoard(ctx);
        refreshStatus(ctx);
        await queueWorkflowContinuation(pi, ctx, state.workflow, result.transitions);
      }
      return { content: [{ type: "text", text: notices.join("\n") }], details: { ok: result.ok, critical, major, minor, workflowPhase: state.workflow.phase } };
    },

    renderCall(args, theme) {
      const c = args.critical ?? "?", m = args.major ?? "?", mn = args.minor ?? "?";
      return new Text(
        theme.fg("toolTitle", theme.bold("submit_review_package ")) +
        theme.fg("dim", `│ Cr:${c} Maj:${m} min:${mn}`),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "Submitting review package…"));
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        return resultBox(
          theme,
          "success",
          theme.fg("success", "✅ Review package accepted ") +
          theme.fg("dim", `Cr:${d.critical} Maj:${d.major} min:${d.minor} → ${d.workflowPhase ?? "advanced"}`),
        );
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const first = text.split("\n")[0] ?? "Rejected";
      const isThresholdRejection = /rejected|Return to implement/i.test(first);
      return resultBox(
        theme,
        isThresholdRejection ? "warning" : "error",
        colorResultLabel(theme, isThresholdRejection ? "warning" : "error", `${isThresholdRejection ? "⚠️" : "❌"} ${first}`),
      );
    },},{
  });

  // ── Tool: workflow_run_command — guarded structured-argv execution ───────────
  pi.registerTool({
    name: "workflow_run_command",
    label: "Run workflow command",
    description: [
      "Execute a pre-approved command from the workflow command catalog.",
      "Commands run with structured argv (no shell interpolation — injection impossible).",
      "Only commands allowed for the current workflow phase may be run.",
    ].join(" "),
    promptSnippet: "Run a safe, phase-allowed command from the workflow catalog",
    promptGuidelines: [
      "Use workflow_run_command instead of bash when running project commands (tests, build, quality gates) during an active workflow.",
      "workflow_run_command prevents shell injection and enforces phase-based command policies automatically.",
    ],
    parameters: Type.Object({
      commandId: Type.String({ description: "Catalog command ID. Use /workflow tools to see available IDs for the current phase." }),
      reason: Type.Optional(Type.String({ description: "Why this command is being run (for audit log)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeWorkflowCatalogCommand(state, params.commandId, ctx);
    },

    renderCall(args, theme) {
      const spec = getCatalogCommand(String(args.commandId ?? ""));
      const label = spec ? spec.description : String(args.commandId ?? "unknown");
      return new Text(
        theme.fg("toolTitle", theme.bold("▶ ")) +
        theme.fg("accent", String(args.commandId ?? "")) +
        theme.fg("dim", `  ${label.slice(0, 50)}`),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        const d2 = result.details as Record<string, unknown>;
        return resultBox(theme, "pending", theme.fg("warning", `▶ Running: ${String(d2?.commandId ?? "")} …`));
      }
      const d = result.details as Record<string, unknown>;
      const ms = d?.elapsedMs ? `${d.elapsedMs}ms` : "";
      const exit = d?.exitCode !== undefined ? `exit ${d.exitCode}` : "";
      const trunc = d?.truncated ? theme.fg("warning", " [truncated]") : "";
      if (d?.ok) {
        const output = (result.content[0]?.type === "text" ? result.content[0].text : "").split("\n").filter(Boolean);
        const lines = output.slice(-3).join(" │ ").slice(0, 80);
        return resultBox(
          theme,
          "success",
          theme.fg("success", `✅ ${d.commandId} `) +
          theme.fg("dim", `(${ms})`) + trunc +
          (lines ? `\n  ${theme.fg("dim", lines)}` : ""),
        );
      }
      const reason = String(d?.reason ?? "");
      const warning = reason === "user-cancelled" || reason === "phase-not-allowed" || reason === "unknown-command";
      return resultBox(
        theme,
        warning ? "warning" : "error",
        colorResultLabel(theme, warning ? "warning" : "error", `${warning ? "⚠️" : "❌"} ${d?.commandId ?? "command"} `) +
        theme.fg("dim", `${reason || exit} (${ms})`) + trunc,
      );
    },
  });

  // ── Tool: workflow_approve — advance workflow; prompts only at approval boundaries ──
  pi.registerTool({
    name: "workflow_approve",
    label: "Advance workflow phase",
    description: "Advance the workflow to the next phase. Shows a UI yes/no confirmation only at user approval boundaries; automatic transitions advance without asking the user.",
    promptSnippet: "Advance workflow phase; show yes/no only at approval boundaries",
    promptGuidelines: [
      "Call workflow_approve when current phase deliverables are complete and a normal transition should occur.",
      "workflow_approve must not ask the user for automatic transitions such as implement → code_review.",
      "At approval boundaries, workflow_approve shows the user a yes/no dialog; do not ask the user to type /workflow approve.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Brief summary of what was completed in this phase and what the next phase involves" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeWorkflowApproval(state, params.summary, ctx, {
        precheckPlanReviewBeforeApproval,
        confirmPushPolicyForPushPhase,
        steerLlm,
        refreshBoard,
        refreshStatus,
        persistGuardToken,
        clearPendingWorkflowSteersForPhase,
        clearPendingWorkflowSteersExceptCurrent,
        clearActiveWorkflowAfterCompletion,
        applyPhaseToolPolicy,
      });
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("✅ ")) + theme.fg("accent", "workflow_approve") +
        theme.fg("dim", `  ${String(args.summary ?? "").slice(0, 60)}`),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "Awaiting workflow approval…"));
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        const transitions = formatTransitionDetails(d.transitions);
        return resultBox(theme, "success", theme.fg("success", "✅ Workflow advanced ") + theme.fg("dim", transitions));
      }
      const reason = String(d?.reason ?? "blocked");
      const warning = reason === "user-declined" || reason === "review-package-required" || reason === "policy-declined" || reason === "gate-blocked";
      const text = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : reason;
      return resultBox(theme, warning ? "warning" : "error", colorResultLabel(theme, warning ? "warning" : "error", `${warning ? "⚠️" : "❌"} ${text}`));
    },},{
  });

  // ── Tool: workflow_skip_gate — accepted-risk gate exception for LLM tool surface ────
  pi.registerTool({
    name: "workflow_skip_gate",
    label: "Skip workflow gate once",
    description: "Record an explicit interactive-user accepted-risk exception for one workflow gate. Use only after explaining the gate failure and receiving user approval.",
    promptSnippet: "Skip one workflow gate after explicit user approval",
    promptGuidelines: [
      "Use only when a workflow gate is unnecessary or a false positive for the current task.",
      "Explain the gate failure and risk before calling this tool.",
      "A non-empty reason is required and the extension asks the interactive user for confirmation.",
      "After the skip is accepted, call workflow_approve again to retry the transition.",
    ],
    parameters: Type.Object({
      gate: Type.Union([Type.Literal("dpaa"), Type.Literal("code-quality"), Type.Literal("policy-scan")], { description: "Gate to skip once." }),
      reason: Type.String({ description: "Concrete accepted-risk reason for skipping this gate once." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const gate = String(params.gate ?? "");
      const reason = String(params.reason ?? "");
      if (!isSkippableWorkflowGate(gate)) {
        return { content: [{ type: "text", text: `Unknown workflow gate: ${gate || "<empty>"}` }], details: { ok: false, reason: "unknown-gate" } };
      }
      const result = await recordWorkflowGateSkip(gate, reason, ctx);
      if (!result.ok) {
        const text = result.reason === "missing-reason"
          ? "Workflow gate skip rejected: a concrete reason is required."
          : "Workflow gate skip was declined by the interactive user.";
        return { content: [{ type: "text", text }], details: { ok: false, gate, reason: result.reason } };
      }
      return {
        content: [{ type: "text", text: `✅ [${gate}] one-use gate exception recorded. Retry the transition with workflow_approve.\nReason: ${reason.trim()}` }],
        details: { ok: true, gate, reason: reason.trim() },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow_skip_gate ")) +
        theme.fg("warning", String(args.gate ?? "?")),
        0, 0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "Awaiting gate skip confirmation…"));
      const ok = Boolean((result.details as Record<string, unknown> | undefined)?.ok);
      const text = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "workflow_skip_gate";
      return resultBox(theme, ok ? "success" : "warning", colorResultLabel(theme, ok ? "success" : "warning", text));
    },
  });

  // ── Tool: workflow_state — manual phase recovery (one step at a time) ────────────────
  pi.registerTool({
    name: "workflow_state",
    label: "Manual phase recovery",
    description: "Move the workflow one step forward or backward for manual recovery. Use only when the workflow is stuck in an incorrect phase. For normal advancement, use workflow_approve.",
    promptSnippet: "Move workflow phase one step for manual recovery",
    promptGuidelines: [
      "Use workflow_state only for recovery when the workflow is in a wrong phase.",
      "For normal phase advancement, use workflow_approve instead.",
      "direction: 'next' moves forward one step, 'prev' moves backward one step.",
    ],
    parameters: Type.Object({
      direction: Type.Union([Type.Literal("next"), Type.Literal("prev")], { description: "'next' or 'prev' — move one step forward or backward" }),
      reason: Type.String({ description: "Why this manual recovery is needed" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.workflow) {
        return { content: [{ type: "text", text: "No active workflow." }], details: { ok: false } };
      }
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "UI required for manual phase recovery." }], details: { ok: false } };
      }

      const currentPhase = state.workflow.phase;
      const phases = sharedWorkflowPhases();
      const idx = phases.indexOf(currentPhase);
      const targetIdx = params.direction === "next" ? idx + 1 : idx - 1;
      if (targetIdx < 0 || targetIdx >= phases.length) {
        return { content: [{ type: "text", text: `Cannot move ${params.direction} from '${currentPhase}'.` }], details: { ok: false } };
      }
      const targetPhase = phases[targetIdx];

      const confirmed = await ctx.ui.confirm(
        `수동 복구: '${currentPhase}' → '${targetPhase}'

사유: ${params.reason}

진행할까요?`,
      );
      if (!confirmed) {
        return { content: [{ type: "text", text: "Cancelled." }], details: { ok: false, reason: "user-declined" } };
      }

      transitionWorkflow(state.workflow, targetPhase, `manual-recovery: ${params.reason}`);
      applyPhaseToolPolicy(targetPhase);
      refreshBoard(ctx);
      refreshStatus(ctx);

      return {
        content: [{ type: "text", text: `워크플로우 복구 완료: '${currentPhase}' → '${targetPhase}'\n\n${formatWorkflowAction(state.workflow)}` }],
        details: { ok: true, from: currentPhase, to: targetPhase },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("🔄 ")) + theme.fg("accent", "workflow_state") +
        theme.fg("dim", `  ${args.direction} (${String(args.reason ?? "").slice(0, 50)})`),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "Awaiting manual recovery confirmation…"));
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        return resultBox(theme, "success", theme.fg("success", "✅ Manual recovery applied ") + theme.fg("dim", `${d.from ?? "?"} → ${d.to ?? "?"}`));
      }
      const reason = String(d?.reason ?? "manual recovery blocked");
      const warning = reason === "user-declined";
      const text = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : reason;
      return resultBox(theme, warning ? "warning" : "error", colorResultLabel(theme, warning ? "warning" : "error", `${warning ? "⚠️" : "❌"} ${text}`));
    },
  });

  // ── Tool: workflow_propose_edit — propose file edits for user approval ───────
  pi.registerTool({
    name: "workflow_propose_edit",
    label: "Propose edits",
    description: [
      "Propose file edits for user review and approval before applying.",
      "Validates paths (traversal, symlinks, protected paths) and shows a diff preview.",
      "Creates an approved EditScope on user confirmation; then call workflow_apply_approved_edit.",
    ].join(" "),
    promptSnippet: "Propose file edits for user approval before applying",
    promptGuidelines: [
      "Use workflow_propose_edit only when a guarded edit scope is required by phase/path policy; normal implement edits should use regular file tools.",
      "Do not use workflow_propose_edit for target/.pi/extensions/** in the harness source repo; that path is deployment-template source, not the running extension path.",
      "Always wait for user approval via workflow_propose_edit before calling workflow_apply_approved_edit.",
    ],
    parameters: Type.Object({
      edits: Type.Array(Type.Object({
        path: Type.String({ description: "File path relative to git root" }),
        operation: Type.String({ description: "One of: write, edit, delete" }),
        content: Type.Optional(Type.String({ description: "New file content (for write)" })),
        oldText: Type.Optional(Type.String({ description: "Exact text to replace (for edit)" })),
        newText: Type.Optional(Type.String({ description: "Replacement text (for edit)" })),
        reason: Type.String({ description: "Why this edit is needed" }),
      })),
      summary: Type.String({ description: "Human-readable summary of what these edits accomplish" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const WRITE_PHASES: WorkflowPhase[] = ["interview", "plan", "implement", "document"];
      const phase = state.workflow?.phase ?? null;
      if (phase && !WRITE_PHASES.includes(phase)) {
        return {
          content: [{ type: "text", text: `workflow_propose_edit is not allowed in phase "${phase}". Permitted in: ${WRITE_PHASES.join(", ")}.` }],
          details: { ok: false, reason: "phase-not-allowed" },
        };
      }
      const gitRoot = getGitRoot();
      if (!gitRoot) {
        return {
          content: [{ type: "text", text: "Cannot propose edits: no git root detected." }],
          details: { ok: false, reason: "no-git-root" },
        };
      }
      const edits = params.edits as ProposedEdit[];
      const validationErrors: string[] = [];
      const pathPolicy = phase ? getPhaseWritePathPolicy(phase) : null;
      for (const edit of edits) {
        const r = validateEditPath(edit.path, gitRoot, false);
        if (!r.ok) validationErrors.push((r as { ok: false; reason: string }).reason);
        if (!["write", "edit", "delete"].includes(edit.operation)) {
          validationErrors.push(`Invalid operation "${edit.operation}" for "${edit.path}".`);
        }
        if (pathPolicy && edit.operation !== "delete") {
          const relPath = path.relative(gitRoot, path.resolve(gitRoot, edit.path)).replace(/\\/g, "/");
          if (isWritePathBlocked(relPath, pathPolicy)) {
            const hint = pathPolicy.mode === "deny"
              ? `Denied pattern: ${pathPolicy.patterns.find((p) => matchesWriteGlob(relPath, [p])) ?? "(matched)"}. 소스 코드는 ${phase} 페이즈에서 수정하지 마세요.`
              : `허용된 경로: ${pathPolicy.patterns.join(", ")}.`;
            validationErrors.push(`Phase path policy: "${edit.path}" is blocked in ${phase} phase. ${hint}`);
          }
        }
      }
      if (validationErrors.length > 0) {
        return {
          content: [{ type: "text", text: ["Path validation failed:", ...validationErrors.map((e) => `  • ${e}`)].join("\n") }],
          details: { ok: false, reason: "path-validation-failed", errors: validationErrors },
        };
      }
      if (edits.length === 0) {
        return {
          content: [{ type: "text", text: "No edits proposed." }],
          details: { ok: false, reason: "no-edits" },
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "workflow_propose_edit requires interactive user approval (no UI available)." }],
          details: { ok: false, reason: "no-ui" },
        };
      }
      const diff = formatEditScopeDiff(edits, gitRoot);
      const approvalText = [`Summary: ${params.summary}`, `Files: ${edits.length}`, diff].join("\n");
      const approved = await ctx.ui.confirm("Review and approve proposed edits", approvalText);
      if (!approved) {
        // Do NOT clear activeEditScope here — a previously approved scope from
        // a different propose call must not be destroyed by this rejection.
        return {
          content: [{ type: "text", text: "Edits rejected by user. Do not apply these changes." }],
          details: { ok: false, reason: "user-rejected" },
        };
      }
      const planHash = state.dpaaGuardSatisfiedToken?.planSha256 ?? null;
      const scope = createEditScope(edits, gitRoot, planHash);
      scope.approvedBy = "interactive-user";
      scope.approvedAt = Date.now();
      state.activeEditScope = scope;
      return {
        content: [{ type: "text", text: `Edits approved. EditScope ID: ${scope.id}\nCall workflow_apply_approved_edit with this ID to apply.` }],
        details: { ok: true, scopeId: scope.id, fileCount: edits.length },
      };
    },

    renderCall(args, theme) {
      const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : [];
      const paths = edits.slice(0, 3).map((e) => String(e.path ?? "")).join(", ");
      const extra = edits.length > 3 ? ` +${edits.length - 3}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("📝 propose_edit ")) +
        theme.fg("dim", `${edits.length} file(s): ${paths}${extra}`),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "Awaiting user approval…"));
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        return resultBox(
          theme,
          "success",
          theme.fg("success", `✅ Edits approved (${d.fileCount} file(s)) `) +
          theme.fg("dim", `→ call workflow_apply_approved_edit with scopeId`),
        );
      }
      const reason = String(d?.reason ?? "rejected");
      const warning = reason === "user-rejected" || reason === "phase-not-allowed";
      const label = reason === "user-rejected" ? "Rejected by user" : reason === "path-validation-failed" ? "Path validation failed" : reason;
      return resultBox(theme, warning ? "warning" : "error", colorResultLabel(theme, warning ? "warning" : "error", `${warning ? "⚠️" : "❌"} ${label}`));
    },},{
  });

  // ── Tool: workflow_apply_approved_edit — apply an approved EditScope ──────
  pi.registerTool({
    name: "workflow_apply_approved_edit",
    label: "Apply approved edits",
    description: [
      "Apply an EditScope approved by workflow_propose_edit.",
      "Re-validates paths and file hashes before mutation.",
      "Blocks if files changed since approval.",
    ].join(" "),
    promptSnippet: "Apply file edits that were already approved by the user",
    promptGuidelines: [
      "Only call workflow_apply_approved_edit after workflow_propose_edit returns a scopeId.",
      "If apply fails due to stale hashes, call workflow_propose_edit again.",
    ],
    parameters: Type.Object({
      scopeId: Type.String({ description: "EditScope ID returned by workflow_propose_edit" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const scope = state.activeEditScope;
      if (!scope || scope.id !== params.scopeId) {
        return {
          content: [{ type: "text", text: `No approved EditScope with ID "${params.scopeId}". Call workflow_propose_edit first.` }],
          details: { ok: false, reason: "scope-not-found" },
        };
      }
      if (scope.approvedBy !== "interactive-user") {
        return {
          content: [{ type: "text", text: `EditScope "${params.scopeId}" not approved.` }],
          details: { ok: false, reason: "not-approved" },
        };
      }
      const gitRoot = getGitRoot();
      if (!gitRoot) {
        return {
          content: [{ type: "text", text: "Cannot apply edits: no git root detected." }],
          details: { ok: false, reason: "no-git-root" },
        };
      }
      // Re-validate paths
      const pathErrors: string[] = [];
      for (const edit of scope.proposedEdits) {
        const r = validateEditPath(edit.path, gitRoot, scope.allowSymlinks);
        if (!r.ok) pathErrors.push((r as { ok: false; reason: string }).reason);
      }
      if (pathErrors.length > 0) {
        state.activeEditScope = null;
        return {
          content: [{ type: "text", text: ["Path re-validation failed (scope invalidated):", ...pathErrors.map((e) => `  • ${e}`)].join("\n") }],
          details: { ok: false, reason: "path-revalidation-failed", errors: pathErrors },
        };
      }
      // Verify file hashes
      const hashCheck = verifyBaseFileHashes(scope, gitRoot);
      if (!hashCheck.ok) {
        state.activeEditScope = null;
        return {
          content: [{ type: "text", text: ["Files changed since approval (scope invalidated):", ...hashCheck.changed.map((f) => `  • ${f}`), "Call workflow_propose_edit again."].join("\n") }],
          details: { ok: false, reason: "stale-hashes", changed: hashCheck.changed },
        };
      }
      // Apply
      const applied: string[] = [];
      const failed: string[] = [];
      for (const edit of scope.proposedEdits) {
        try {
          applyProposedEdit(edit, gitRoot);
          applied.push(`${edit.operation}: ${edit.path}`);
        } catch (err) {
          failed.push(`${edit.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      state.activeEditScope = null;
      if (failed.length > 0) {
        return {
          content: [{ type: "text", text: [`Applied ${applied.length}, failed ${failed.length}:`, ...applied.map((a) => `  ✅ ${a}`), ...failed.map((f) => `  ❌ ${f}`)].join("\n") }],
          details: { ok: false, applied, failed },
        };
      }
      return {
        content: [{ type: "text", text: [`Applied ${applied.length} edit(s):`, ...applied.map((a) => `  ✅ ${a}`)].join("\n") }],
        details: { ok: true, applied },
      };
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("🔧 apply_edit ")) +
        theme.fg("dim", `scope: ${String(args.scopeId ?? "").slice(0, 24)}`),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "Applying edits…"));
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        const applied = Array.isArray(d.applied) ? d.applied as string[] : [];
        const preview = applied.slice(0, 3).map((a) => a.split(": ")[1] ?? a).join(", ");
        const extra = applied.length > 3 ? ` +${applied.length - 3}` : "";
        return resultBox(
          theme,
          "success",
          theme.fg("success", `✅ Applied ${applied.length} edit(s): `) +
          theme.fg("dim", `${preview}${extra}`),
        );
      }
      const reason = String(d?.reason ?? "failed");
      const warning = reason === "scope-not-found" || reason === "stale-hashes";
      const label = reason === "stale-hashes" ? "Files changed since approval" : reason === "path-revalidation-failed" ? "Path validation failed" : "Apply failed";
      return resultBox(theme, warning ? "warning" : "error", colorResultLabel(theme, warning ? "warning" : "error", `${warning ? "⚠️" : "❌"} ${label}`));
    },
  });

  // ── Tool: workflow_interview_wizard — LLM-driven dynamic interview TUI ────
  pi.registerTool({
    name: "workflow_interview_wizard",
    label: "Interview Wizard",
    description: [
      "Launch a TUI interview wizard with questions generated by the LLM.",
      "Call this at the start of the interview phase with 5 questions tailored to the workflow goal.",
      "The tool blocks until the user completes or cancels the wizard, then returns the collected answers.",
    ].join(" "),
    promptSnippet: "Collect interview answers via interactive TUI wizard",
    promptGuidelines: [
      "Call workflow_interview_wizard immediately when an interview phase starts. Generate 5 questions (scope, motivation, acceptance criteria, affected files/modules, constraints/risks) with domain-specific choices for the workflow goal.",
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Unique snake_case identifier" }),
          title: Type.String({ description: "Short question heading shown to the user" }),
          prompt: Type.String({ description: "Detailed question prompt" }),
          helpText: Type.String({ description: "Example answer or hint" }),
          required: Type.Boolean({ description: "Whether the user must answer this question" }),
          choices: Type.Array(
            Type.Object({
              id: Type.String({ description: "Unique choice identifier" }),
              label: Type.String({ description: "Choice label shown in TUI" }),
            }),
            { description: "3–5 domain-specific choices for this question" },
          ),
        }),
        { description: "Exactly 5 interview questions tailored to the workflow goal" },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.workflow || state.workflow.phase !== "interview") {
        return {
          content: [{ type: "text", text: "workflow_interview_wizard can only be called during the interview phase." }],
          details: { ok: false },
        };
      }
      const questions = params.questions.map((q) => ({
        ...q,
        allowFreeText: true,
        allowSkip: !q.required,
      }));
      let result: import("./workflow/interview-ui").InterviewWizardResult | null = null;
      try {
        result = await launchInterviewWizard(ctx as any, state.workflow.title, questions);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Interview wizard error: ${error instanceof Error ? error.message : String(error)}` }],
          details: { ok: false },
        };
      }
      if (!result?.completed) {
        return {
          content: [{ type: "text", text: "Interview wizard was cancelled by the user. Continue with a chat-based interview." }],
          details: { ok: false, cancelled: true },
        };
      }
      return {
        content: [{ type: "text", text: `Interview wizard completed. Collected answers:\n\n${result.summaryMarkdown}` }],
        details: { ok: true, answers: result.answers, summaryMarkdown: result.summaryMarkdown },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("🎙️ interview_wizard ")) +
        theme.fg("dim", "TUI 인터뷰 진행 중…"),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "인터뷰 wizard 대기 중…"));
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        return resultBox(theme, "success", theme.fg("success", "✅ 인터뷰 wizard 완료"));
      }
      if (d?.cancelled) {
        return resultBox(theme, "warning", theme.fg("warning", "⚠️ 사용자가 wizard를 취소했습니다"));
      }
      return resultBox(theme, "error", theme.fg("error", "❌ interview wizard 실패"));
    },
  });

  // ── Command: /workflow — advisory workflow state manager ──────────────────
  pi.registerCommand("workflow", {
    description: "Manage the advisory interview → plan → implementation → review → document → commit → push workflow state.",
    getArgumentCompletions: (prefix) => {
      const GATE_LABELS: Record<string, string> = {
        "dpaa": "DPAA gate (plan_review → implement)",
        "code-quality": "Checkstyle/PMD/test gate (code_review → review_approved)",
        "policy-scan": "push 전 위험 변경 파일 scan gate",
      };

      if (prefix.startsWith("skip ")) {
        const gatePart = prefix.slice("skip ".length);
        return Object.keys(GATE_LABELS)
          .filter((g) => g.startsWith(gatePart))
          .map((g) => {
            const failures = state.gateFailures.get(g) ?? 0;
            const failureHint = failures > 0 ? `  [✗${failures}]` : "";
            return { value: `skip ${g}`, label: `skip ${g}${failureHint}  —  ${GATE_LABELS[g]}` };
          });
      }

      const COMMAND_LABELS: Record<string, string> = {
        start: "start <goal> — start workflow",
        approve: "approve — advance next transition; yes/no only at approval boundaries",
        status: "status — 현재 워크플로우 상태 표시",
        doctor: "doctor — check harness runtime",
        failures: "failures — show/export field logs",
        list: "list — show active or persisted workflow",
        load: "load — load persisted workflow",
        undo: "undo — restore previous workflow checkpoint",
        redo: "redo — reapply undone workflow checkpoint",
        history: "history — show transition/checkpoint history",
        abort: "abort — abort active workflow after confirmation",
        state: "state <phase> — 수동 복구 전용 (workflow_state tool 권장)",
        snapshot: "snapshot — create artifact snapshot",
        checkpoint: "checkpoint — create workspace checkpoint",
        checkpoints: "checkpoints — list workspace checkpoints",
        restore: "restore <id> — restore workspace checkpoint",
        skip: "skip <gate> <reason> — accepted-risk recovery only",
        "dpaa-audit": "dpaa-audit — show latest DPAA/SBADR audit",
        tools: "tools — show allowed tools and commands for current phase",
        logs: "logs — show recent workflow field log events",
      };
      const commands = Object.keys(COMMAND_LABELS);
      const persisted = loadPersistedWorkflow();
      return commands
        .filter((value) => value.startsWith(prefix))
        .map((value) => {
          if (value === "load" && persisted) {
            return { value, label: `load  ← [${persisted.phase}] ${persisted.title}` };
          }
          if (value === "skip") {
            const activeFailures = Object.keys(GATE_LABELS).filter((g) => (state.gateFailures.get(g) ?? 0) > 0);
            return { value, label: activeFailures.length > 0 ? `skip  ← 실패 중: ${activeFailures.join(", ")}` : COMMAND_LABELS[value] };
          }
          return { value, label: COMMAND_LABELS[value] ?? value };
        });
    },
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      const ensurePrerequisites = async (): Promise<boolean> => {
        const scan = scanWorkflowPrerequisites();
        if (!scan.ok) {
          ctx.ui.notify([
            formatWorkflowPrerequisiteScan(scan),
            "",
            "필수 workflow runtime 파일이 없어 진행할 수 없습니다.",
          ].join("\n"), "warning");
          return false;
        }
        if (scan.warnings.length === 0) return true;
        if (!ctx.hasUI) {
          ctx.ui.notify([
            formatWorkflowPrerequisiteScan(scan),
            "",
            "경고 확인을 위한 대화형 UI가 없어 진행을 중단합니다.",
          ].join("\n"), "warning");
          return false;
        }
        return ctx.ui.confirm(
          "Workflow prerequisite 경고 확인",
          [
            formatWorkflowPrerequisiteScan(scan),
            "",
            "위 경고가 있어도 workflow를 계속 진행하시겠습니까?",
            "",
            "예: 경고를 인지하고 계속 진행합니다.",
            "아니오: workflow start/load를 중단합니다.",
          ].join("\n"),
        );
      };

      if (command === "doctor") {
        ctx.ui.notify(formatHarnessDoctor(), "info");
        return;
      }

      if (command === "failures") {
        if (rest[0] === "export") {
          const exported = exportFieldLogs();
          ctx.ui.notify(`Harness field logs exported: ${path.relative(process.cwd(), exported)}`, "info");
          return;
        }
        const limit = Number.parseInt(rest[0] ?? "10", 10);
        ctx.ui.notify(formatRecentFieldLogs(Number.isFinite(limit) ? limit : 10), "info");
        return;
      }

      if (command === "start") {
        if (state.workflow && state.workflow.phase !== "done") {
          ctx.ui.notify(
            `이미 진행 중인 workflow가 있습니다: ${state.workflow.phase}\n` +
              "먼저 /workflow status로 확인하거나 /workflow abort로 종료하세요.",
            "warning",
          );
          return;
        }

        if (!(await ensurePrerequisites())) return;
        cancelWorkflowContinuationPending();
        state.workflow = createWorkflow(rest.join(" "));
        state.codeReviewGuardSatisfiedToken = null;
        state.policyApprovals = [];
        state.reviewPackageToken = null;
        state.gateFailures = new Map();
        saveWorkflow(state.workflow);
        applyPhaseToolPolicy(state.workflow.phase);
        refreshBoard(ctx);
        refreshStatus(ctx);
        // Gap fix: name the session so /resume shows the workflow title
        try { pi.setSessionName(`[wf] ${state.workflow.title}`); } catch { /* non-fatal */ }
        ctx.ui.notify(formatWorkflowStatus(state.workflow), "info");
        // Kick off LLM interview automatically when the queue is clear.
        // If Pi already has pending messages, avoid sending a kick-off that would be out of order.
        if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;
        try {
          const wf = state.workflow;
          const marker = workflowContinuationMarker(wf);
          state.workflowContinuationPending = { workflowId: wf.id, phase: wf.phase, marker };
          const prompt = [
            `Workflow '${wf.title}'이(가) 시작되었습니다. 현재 페이즈: interview.`,
            "",
            formatWorkflowAction(wf),
            "",
            "Rules:",
            "- Call workflow_interview_wizard first. Generate 5 questions tailored to the workflow goal (scope · motivation · acceptance criteria · affected files/modules · constraints/risks). For each question provide 3–5 domain-specific choices drawn from knowledge of the stated goal.",
            "- After the wizard returns answers, use them as interview context. Ask follow-up questions only for remaining ambiguities.",
            "- Do not advance to plan until requirements are sufficiently understood.",
            "- Do not request user approval to start — the user already approved by running /workflow start.",
            "",
            workflowContinuationMarkerComment(marker),
          ].join("\n");
          await (pi as any).sendUserMessage(prompt);
        } catch (error) {
          state.workflowContinuationPending = null;
          ctx.ui.notify(`Workflow interview kick-off failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return;
      }

      if (command === "list") {
        const activeOrPersisted = state.workflow ?? loadPersistedWorkflow();
        ctx.ui.notify([formatWorkflowStatus(activeOrPersisted), "", formatGuardMemoryStatus()].join("\n"), "info");
        return;
      }

      if (command === "load") {
        if (state.workflow && state.workflow.phase !== "done") {
          ctx.ui.notify(`이미 진행 중인 workflow가 있습니다: ${state.workflow.phase}\n먼저 /workflow abort로 종료하거나 /workflow status로 확인하세요.`, "warning");
          return;
        }
        const persisted = loadPersistedWorkflow();
        if (!persisted) {
          ctx.ui.notify("불러올 저장된 workflow 인스턴스가 없습니다.", "warning");
          return;
        }
        cancelWorkflowContinuationPending();
        state.workflow = persisted;
        applyPhaseToolPolicy(state.workflow.phase);
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify([`✅ Workflow 인스턴스를 메모리에 로드했습니다: [${persisted.phase}] ${persisted.title}`, "", formatWorkflowStatus(state.workflow)].join("\n"), "info");
        return;
      }

      if (command === "approve") {
        if (state.workflow?.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
          ctx.ui.notify([
            "review_approved로 전환하려면 먼저 review package가 필요합니다. 자기 리뷰 → 독립 리뷰어 리뷰 → quality gate 확인 후 submit_review_package를 호출하세요.",
            "",
            formatWorkflowAction(state.workflow),
          ].join("\n"), "warning");
          return;
        }
        const nextPhase = state.workflow ? getNextPhase(state.workflow.phase) : null;
        const requiresUserApproval = Boolean(state.workflow && nextPhase && isSharedApprovalBoundary(state.workflow.phase, nextPhase));
        if (state.workflow && requiresUserApproval && !ctx.hasUI) {
          ctx.ui.notify("승인 대화상자를 표시하려면 대화형 UI가 필요합니다. UI 세션에서 다시 시도하세요.", "warning");
          return;
        }
        const slashPlanReviewPrecheck = await precheckPlanReviewBeforeApproval(ctx);
        if (!slashPlanReviewPrecheck.ok) {
          ctx.ui.notify(slashPlanReviewPrecheck.text, "warning");
          return;
        }
        if (state.workflow?.phase === "commit" && !(await confirmPushPolicyForPushPhase(ctx))) return;
        if (state.workflow && requiresUserApproval && state.workflow.phase !== "commit") {
          const ok = await ctx.ui.confirm(
            `Workflow approval boundary: [${state.workflow.phase}] → [${nextPhase ?? "done"}]

계속 진행하시겠습니까?`,
          );
          if (!ok) {
            ctx.ui.notify("취소됐습니다. 현재 단계를 유지합니다.", "warning");
            return;
          }
        }
        const workflowId = state.workflow?.id ?? null;
        const approvedPlanSha256 = state.dpaaGuardSatisfiedToken?.planSha256;
        const result = await advanceWorkflow(state.workflow, "user_approved", { approvedPlanSha256 });
        if (!result.ok) {
          if (result.gate) { state.gateFailures.set(result.gate, (state.gateFailures.get(result.gate) ?? 0) + 1); }
          refreshBoard(ctx);
          refreshStatus(ctx);
          ctx.ui.notify(["게이트가 워크플로우 전환을 차단했습니다. 근본 원인을 해결한 후 /workflow approve를 다시 실행하세요.", "Default handling: do not ask the user for a skip first. Fix the underlying cause within the current phase when possible, then retry the workflow transition. Ask the user only for product/architecture input, an approval boundary, or an accepted-risk exception.", "", result.message, "", formatWorkflowAction(state.workflow)].join("\n"), "warning");
          return;
        }
        const transitions = result.transitions ?? [];
        transitions.forEach((t) => {
          if (t.from === "plan_review" && t.to === "implement") {
            state.gateFailures.delete("dpaa");
            clearPendingWorkflowSteersForPhase(workflowId, "plan_review");
          }
          if (t.from === "code_review" && t.to === "review_approved") {
            state.gateFailures.delete("code-quality");
            clearPendingWorkflowSteersForPhase(workflowId, "code_review");
          }
        });
        const transitionPath = transitions.map((t) => `${t.from} → ${t.to}`).join(", ");
        const notices: string[] = [result.message];
        if (workflowId && transitions.some((item) => item.from === "plan_review" && item.to === "implement")) {
          const dpaaTx = transitions.find((t) => t.from === "plan_review" && t.to === "implement");
          state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved", planSha256: dpaaTx?.planSha256 };
          persistGuardToken(HARNESS_TOKEN_TYPES.DPAA, state.dpaaGuardSatisfiedToken as unknown as Record<string, unknown>);
          notices.push("DPAA guard satisfied: transition evidence recorded in current-session memory.");
        }
        if (workflowId && transitions.some((item) => item.from === "code_review" && item.to === "review_approved")) {
          state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "automated_review_passed" };
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
          persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY, state.codeQualityGuardSatisfiedToken as unknown as Record<string, unknown>);
          persistGuardToken(HARNESS_TOKEN_TYPES.CODE_REVIEW, { ...state.codeReviewGuardSatisfiedToken, workflowId });
          state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
          if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
          notices.push("Automated review approved: review/quality evidence recorded in current-session memory.");
          notices.push("Code quality guard satisfied: quality evidence recorded in current-session memory.");
        }
        if (workflowId && transitions.some((item) => item.from === "commit" && item.to === "push")) {
          state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          persistGuardToken(HARNESS_TOKEN_TYPES.PUSH_EXECUTION, state.pushExecutionGuardSatisfiedToken as unknown as Record<string, unknown>);
          notices.push("Push phase approved: commit → push transition evidence recorded in workflow history.");
        }
        clearPendingWorkflowSteersExceptCurrent();
        const completed = transitions.some((t) => t.to === "done");
        if (transitionPath) notices.push(`Transition path: ${transitionPath}`);
        if (completed) {
          clearActiveWorkflowAfterCompletion();
          applyPhaseToolPolicy(null);
        } else {
          notices.push("", formatWorkflowAction(state.workflow));
          applyPhaseToolPolicy(state.workflow.phase);
        }
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify(notices.join("\n"), "info");
        await queueWorkflowContinuation(pi, ctx, state.workflow, transitions);
        return;
      }

      if (command === "undo") {
        const result = undoManualWorkflowCheckpoint(state);
        ctx.ui.notify(result.message, result.level);
        return;
      }

      if (command === "redo") {
        const result = redoManualWorkflowCheckpoint(state);
        ctx.ui.notify(result.message, result.level);
        return;
      }

      if (command === "history") {
        ctx.ui.notify(formatWorkflowHistory(state.workflow), "info");
        return;
      }

      if (command === "dpaa-audit") {
        ctx.ui.notify(formatLatestDpaaAudit(), "info");
        return;
      }

      if (command === "tools") {
        ctx.ui.notify(formatWorkflowToolsListing(state.workflow?.phase ?? null), "info");
        return;
      }

      if (command === "logs") {
        const limit = parseInt(rest[0] ?? "20", 10);
        ctx.ui.notify(formatRecentFieldLogs(Number.isFinite(limit) ? limit : 20), "info");
        return;
      }

      if (command === "snapshot") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", "warning");
          return;
        }
        const workspace = validateWorkflowWorkspace(state.workflow);
        if (!workspace.ok) {
          ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
          return;
        }
        const reason = rest.join(" ").trim() || "manual snapshot";
        const snapshot = createArtifactSnapshot(state.workflow, "manual", reason);
        if (!snapshot) {
          ctx.ui.notify("스냅샷할 spec/plan 파일이 없습니다. `.ai/interview/spec.md` 또는 `.ai/interview/plan.md`를 먼저 작성하세요.", "warning");
          return;
        }
        ctx.ui.notify(formatArtifactSnapshotCreated(snapshot), "info");
        return;
      }

      if (command === "checkpoint") {
        if (state.workflow) {
          const workspace = validateWorkflowWorkspace(state.workflow);
          if (!workspace.ok) {
            ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
            return;
          }
        }
        const reason = rest.join(" ").trim() || "manual";
        const result = createManualWorkspaceCheckpoint(state, reason);
        ctx.ui.notify(result.message, result.level);
        return;
      }

      if (command === "checkpoints") {
        ctx.ui.notify(formatManualWorkspaceCheckpoints(state), "info");
        return;
      }

      if (command === "restore") {
        if (state.workflow) {
          const workspace = validateWorkflowWorkspace(state.workflow);
          if (!workspace.ok) {
            ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
            return;
          }
        }
        const result = restoreManualWorkspaceCheckpoint(state, rest[0]);
        ctx.ui.notify(result.message, result.level);
        return;
      }

      if (command === "skip") {
        const VALID_GATES = ["dpaa", "code-quality", "policy-scan"] as const;
        const GATE_DESC: Record<string, string> = {
          "dpaa": "DPAA 모호성 분석 gate (plan_review → implement 전환 시 실행)",
          "code-quality": "Checkstyle/PMD/테스트 gate (code_review → review_approved 전환 시 실행)",
          "policy-scan": "push 전 위험 변경 파일 scan gate",
        };
        const gate = rest[0] as typeof VALID_GATES[number] | undefined;
        const reason = rest.slice(1).join(" ").trim();
        if (!gate || !VALID_GATES.includes(gate)) {
          const failures = VALID_GATES.filter((g) => (state.gateFailures.get(g) ?? 0) > 0);
          ctx.ui.notify([
            "사용법: /workflow skip <gate> <사유>",
            "",
            "Gate 목록:",
            ...VALID_GATES.map((g) => {
              const f = state.gateFailures.get(g) ?? 0;
              return `  ${g}  —  ${GATE_DESC[g]}${f > 0 ? ` [✗${f}회 실패]` : ""}`;
            }),
            ...(failures.length > 0 ? ["", `현재 실패 중: ${failures.join(", ")}`] : []),
          ].join("\n"), "warning");
          return;
        }
        if (!reason) {
          ctx.ui.notify(`사유를 입력하세요.\n예: /workflow skip ${gate} 테스트 환경에서 checkstyle 미적용 확인`, "warning");
          return;
        }
        const failures2 = state.gateFailures.get(gate) ?? 0;
        if (!ctx.hasUI) {
          ctx.ui.notify("대화형 UI가 없어 gate skip을 승인할 수 없습니다. UI 세션에서 다시 시도하세요.", "warning");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Workflow gate skip 승인 확인",
          [
            `[${gate}] gate를 1회 건너뛰겠습니까?`,
            `대상: ${GATE_DESC[gate]}`,
            ...(failures2 > 0 ? [`이번 세션 실패 횟수: ${failures2}회`] : []),
            "",
            `사유: ${reason}`,
            "",
            "예: 다음 1회에 한해 해당 gate 예외를 허용합니다 (TTL 10분).",
            "아니오: gate를 유지합니다.",
          ].join("\n"),
        );
        if (!ok) return;
        addSkipToken(gate, reason);
        if (gate === "dpaa" && state.workflow) {
          state.dpaaGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "skip-preapproved" };
        }
        state.gateFailures.delete(gate);
        writeFieldLogEvent({
          type: "gate.skipped",
          category: gate === "policy-scan" ? "push-policy" : gate === "code-quality" ? "code-quality" : gate === "dpaa" ? "dpaa" : "workspace",
          severity: "warning",
          status: "accepted-risk",
          workflow: state.workflow,
          summary: `${gate} gate one-use exception issued by explicit user approval.`,
          expected: "Harness gates run unless the user explicitly approves a one-time exception.",
          actual: `One-use exception issued: ${reason}`,
          impact: "Repeated exceptions may indicate guard false positives or missing workflow affordances.",
          primaryMessage: reason,
          improvementKind: gate === "dpaa" ? "dpaa-rule" : "workflow-rule",
        });
        ctx.ui.notify(`✅ [${gate}] 1회 예외 허용됨 (TTL 10분)\n사유: ${reason}`, "warning");
        return;
      }

      if (command === "abort") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다.", "info");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("대화형 UI가 없어 workflow 종료를 승인할 수 없습니다. UI 세션에서 다시 시도하세요.", "warning");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Workflow 종료 승인 확인",
          [
            `현재 워크플로우(${state.workflow.phase})를 종료하시겠습니까?`,
            "",
            "예: 워크플로우 메모리를 종료하고 저장된 파일 기록도 삭제합니다.",
            "아니오: 워크플로우를 유지합니다.",
          ].join("\n"),
        );
        if (!ok) return;
        cancelWorkflowContinuationPending();
        state.workflow = null;
        state.dpaaGuardSatisfiedToken = null;
        state.codeQualityGuardSatisfiedToken = null;
        state.pushExecutionGuardSatisfiedToken = null;
        state.codeReviewGuardSatisfiedToken = null;
        state.policyApprovals = [];
        state.reviewPackageToken = null;
        state.gateFailures = new Map();
        state.activeEditScope = null;
        clearPersistedWorkflow();
        applyPhaseToolPolicy(null);
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify("Workflow를 종료했습니다.", "info");
        return;
      }

      if (command === "status") {
        if (state.workflow) {
          ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus(), "", formatWorkflowAction(state.workflow)].join("\n"), "info");
          return;
        }

        const persisted = loadPersistedWorkflow();
        if (!persisted) {
          ctx.ui.notify([formatWorkflowStatus(null), "", formatGuardMemoryStatus(), "", formatWorkflowAction(null)].join("\n"), "info");
          return;
        }

        ctx.ui.notify([
          formatWorkflowStatus(null),
          "",
          formatGuardMemoryStatus(),
          "",
          formatWorkflowAction(null),
          "",
          `📂 저장된 워크플로우가 있습니다: [${persisted.phase}] ${persisted.title}`,
          `   마지막 업데이트: ${new Date(persisted.updatedAt).toLocaleString("ko-KR")}`,
          "",
          "  /workflow load     — 이전 워크플로우를 메모리에 복구합니다 (guard evidence 없이)",
          "  /workflow start <목표>  — 새 워크플로우를 시작합니다",
          "",
          "⚠️  저장된 파일은 표시·감사용입니다. 자동 복구하지 않으며 guard 증거로 신뢰하지 않습니다.",
        ].join("\n"), "info");
        return;
      }

      if (command === "state") {
        const phases = sharedWorkflowPhases();
        const next = rest[0] as WorkflowPhase | undefined;
        if (!next || !isSharedWorkflowPhase(next)) {
          ctx.ui.notify(`사용법: /workflow state <${phases.join("|")}>`, "warning");
          return;
        }
        const recoveryClaims: Record<WorkflowPhase, string> = {
          interview: "초기 interview 단계로 복구합니다. guard evidence는 복구하지 않습니다.",
          plan: "plan 단계로 복구합니다. guard evidence는 복구하지 않습니다.",
          plan_review: "plan_review 단계로 복구합니다. DPAA는 통과한 것으로 간주하지 않습니다.",
          implement: "implement 단계로 복구하지만 DPAA transition evidence는 복구하지 않습니다.",
          code_review: "code_review 단계로 복구하지만 DPAA/code quality/code review evidence는 복구하지 않습니다.",
          review_approved: "review_approved 단계로 복구하지만 code quality/review evidence는 복구하지 않습니다.",
          document: "document 단계로 복구하지만 review evidence는 복구하지 않습니다.",
          commit: "commit 단계로 복구하지만 push approval evidence는 복구하지 않습니다.",
          push: "push 단계로 복구하지만 commit → push approval evidence는 복구하지 않습니다. 실제 push는 정상 승인 이력이 없으면 차단될 수 있습니다.",
          done: "workflow가 완료됐다고 표시하지만 실행 evidence는 복구하지 않습니다.",
        };
        if (!ctx.hasUI) {
          ctx.ui.notify("대화형 UI가 없어 workflow state 수동 복구를 승인할 수 없습니다. UI 세션에서 다시 시도하세요.", "warning");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Workflow state 수동 변경 승인 확인",
          [
            `workflow memory 상태를 '${next}' 단계로 변경하시겠습니까?`,
            "",
            recoveryClaims[next],
            "",
            "예: phase만 복구합니다. guard evidence는 복구하지 않습니다.",
            "아니오: phase를 변경하지 않습니다.",
            "",
            "주의: 이 명령은 수동 phase 복구 전용입니다. DPAA/code review/push evidence는 정상 gate/tool 결과로만 다시 획득하세요.",
          ].join("\n"),
        );
        if (!ok) return;
        cancelWorkflowContinuationPending();
        if (!state.workflow) state.workflow = createWorkflow("manual");
        transitionWorkflow(state.workflow, next, "manual_override");
        state.dpaaGuardSatisfiedToken = null;
        state.codeQualityGuardSatisfiedToken = null;
        state.pushExecutionGuardSatisfiedToken = null;
        state.codeReviewGuardSatisfiedToken = null;
        const evidenceNotices: string[] = ["guard evidence 복구 없음"];
        saveWorkflow(state.workflow);
        applyPhaseToolPolicy(state.workflow.phase);
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify([
          formatWorkflowStatus(state.workflow),
          "",
          `수동 state 복구 완료: ${evidenceNotices.join(", ")}`,
          "",
          "주의: /workflow state <phase> 또는 workflow_state 툴은 수동 복구 전용입니다. 정상 진행에는 workflow_approve 툴 또는 submit_review_package를 사용하세요.",
          "",
          formatGuardMemoryStatus(),
          "",
          formatWorkflowAction(state.workflow),
        ].join("\n"), "warning");
        return;
      }

      ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus(), "", formatWorkflowAction(state.workflow)].join("\n"), "info");
    },
  });

  // ── User-input checkpoint prompt + natural approval handling ───────────────
  pi.on("input", async (event, ctx) => {
    if (consumeCancelledWorkflowContinuationPrompt(event.text) || consumeStaleWorkflowSteerPrompt(event.text)) {
      return { action: "handled" };
    }

    if (event.source === "interactive") {
      const suggestion = suggestWorkflowCommandTypo(event.text);
      if (suggestion) {
        ctx.ui.notify(suggestion, "warning");
        return { action: "handled" };
      }
    }

    // Natural-language workflow approvals are accepted only from text the user
    // typed in the interactive editor. Assistant messages do not fire this
    // event, and extension/RPC-injected messages must not advance phases.
    if (event.source !== "interactive") return { action: "continue" };
    if (!state.workflow || state.workflow.phase === "done") return { action: "continue" };

    if (shouldOfferInputCheckpoint(state.workflow, event.text, state.lastInputCheckpointSignature)) {
      let shouldCheckpoint = false;
      if (state.autoCheckpointForSession) {
        shouldCheckpoint = true;
      } else if (ctx.hasUI) {
        const choice = await ctx.ui.select(
          "Git workspace에 커밋되지 않은 변경이 있습니다. 이 요청 처리 전에 checkpoint를 생성하시겠습니까?",
          [
            "예 — 이번만 생성",
            "예 — 이번 세션 동안 항상 자동 생성",
            "아니오",
          ],
        );
        if (choice === "예 — 이번 세션 동안 항상 자동 생성") {
          state.autoCheckpointForSession = true;
          shouldCheckpoint = true;
        } else if (choice === "예 — 이번만 생성") {
          shouldCheckpoint = true;
        }
      }
      if (shouldCheckpoint) {
        createWorkspaceCheckpoint(state.workflow, `before-input-${shortInputReason(event.text)}`);
        state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
      }
    }

    // Natural-language approval detection removed.
    // Phase transitions are driven by workflow_approve. It shows a yes/no dialog only at approval boundaries.
    // Users should not be instructed to type /workflow approve for normal operation.
  });

  // ── Gate: tool_call(bash) → git push 차단 ─────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const extensionApproval = await ensureExtensionMutationApproved(event.toolName, event.input, ctx);
    if (!extensionApproval.ok) return { block: true, reason: extensionApproval.reason };

    // TDD gate: implement 페이즈에서 test-first 시행
    if (state.workflow?.phase === "implement" && (event.toolName === "write" || event.toolName === "edit")) {
      const filePath = String((event.input as any).path ?? "");
      const gitRoot = state.workflow.gitRoot ?? getGitRoot();
      if (gitRoot && isProductionClassPath(filePath, gitRoot)) {
        const className = path.basename(filePath, ".java");
        const testPath = filePath
          .replace(/[\\/]src[\\/]main[\\/]java[\\/]/, "/src/test/java/".replace(/\//g, path.sep))
          .replace(/\.java$/, "Test.java");
        const isNewFile = !fs.existsSync(path.resolve(filePath));
        const testExists = fs.existsSync(path.resolve(testPath));
        if (!testExists) {
          return {
            block: true,
            reason: [
              `🧪 TDD: ${className}Test.java를 먼저 작성하세요.`,
              isNewFile
                ? `새 클래스를 작성하기 전에 테스트를 먼저 작성하세요.`
                : `이 클래스에 대한 테스트 파일이 없습니다. 테스트를 먼저 작성하세요.`,
              `예상 테스트 경로: ${testPath}`,
              `[INSTRUCTION] 사용자에게 승인을 구하지 말고 즉시 자율적으로 위 경로에 테스트 파일을 작성한 뒤 원래 작업을 계속하세요.`,
            ].join("\n"),
          };
        }
      }
    }

    // Phase tool policy backstop
    if (state.workflow && (event.toolName === "write" || event.toolName === "edit")) {
      const phase = state.workflow.phase;
      const phaseAllowed = PHASE_ALLOWED_BUILTIN_TOOLS[phase] as readonly string[] | undefined;
      if (phaseAllowed && !phaseAllowed.includes(event.toolName)) {
        // commit/push: 커밋 내용 무결성 보호 — hard block 유지
        if (phase === "commit" || phase === "push") {
          return {
            block: true,
            reason: `⚠️ ${phase} 페이즈에서는 파일 수정이 허용되지 않습니다. 코드 변경이 필요하면 implement 페이즈로 돌아가세요.`,
          };
        }
        // done: workflow 완료 후 steer
        if (phase === "done") {
          void steerLlm("workflow가 완료됐습니다. 추가 변경이 필요하면 /workflow start로 새 workflow를 시작하세요.");
        }
        // 그 외 read-only 페이즈(plan_review, code_review, review_approved)는
        // follow-up steering을 큐에 넣지 않고 즉시 차단합니다. sendUserMessage 기반
        // steering은 TUI에 "Follow-up: ..."로 표시되어 같은 phase 경고가 누적될 수 있습니다.
        const phaseGuide: Record<string, string> = {
          plan_review: "plan_review 페이즈입니다. 파일을 수정하기 전에 plan 검토를 완료하고 workflow_approve로 implement 단계로 진행하세요.",
          code_review: "code_review 페이즈입니다. 소스 수정이 필요하다면 implement 페이즈로 돌아가거나, 리뷰를 먼저 완료하세요.",
          review_approved: "review_approved 페이즈입니다. 문서화 작업만 필요하며 소스 수정은 이 단계에서 하지 않습니다.",
        };
        const guide = phaseGuide[phase] ?? `${phase} 페이즈에서는 소스 수정이 계획에 없습니다.`;
        return { block: true, reason: `⚠️ ${guide}` };
      }

      // Phase write-path policy: 경로 위반 시 follow-up steering 대신 즉시 차단합니다.
      const pathPolicy = getPhaseWritePathPolicy(state.workflow.phase);
      if (pathPolicy) {
        const filePath = String((event.input as any).path ?? "");
        if (filePath) {
          const gitRoot = state.workflow.gitRoot ?? getGitRoot();
          const relPath = gitRoot
            ? path.relative(gitRoot, path.resolve(gitRoot, filePath)).replace(/\\/g, "/")
            : filePath.replace(/\\/g, "/");
          if (isWritePathBlocked(relPath, pathPolicy)) {
            const hint = pathPolicy.mode === "deny"
              ? `${state.workflow.phase} 페이즈에서는 문서(마크다운, HTML 등)만 작성할 수 있습니다. 소스 코드 수정이 필요하다면 implement 페이즈로 돌아가세요.`
              : `이 페이즈에서 허용된 경로: ${pathPolicy.patterns.join(", ")}.`;
            return { block: true, reason: `⚠️ ${hint}` };
          }
        }
      }
    }

    if (event.toolName !== "bash") return;

    const cmd = String((event.input as any).command ?? "");
    if (/\b(pytest|npm\s+(test|run\s+(test|lint|typecheck|build))|pnpm\s+(test|lint|typecheck|build)|yarn\s+(test|lint|typecheck|build)|gradle(w|\.bat)?\s+.*(test|check|build|codeQualityGuard)|mvn\s+.*(test|verify|package)|go\s+test|cargo\s+(test|clippy)|tsc\b|eslint\b|ruff\b|mypy\b)\b/i.test(cmd)) {
      state.recentVerificationCommands.push({ command: cmd, timestamp: Date.now(), phase: state.workflow?.phase });
      if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
    }
    if (!isGitPush(cmd)) return;

    if (state.workflow) {
      if (hasGitDashC(cmd)) {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "workspace",
          severity: "blocker",
          workflow: state.workflow,
          summary: "git push used git -C during an active workflow.",
          expected: "Push commands run from the workflow-bound worktree/cwd.",
          actual: "git push command used -C to target a path.",
          impact: "Push is blocked to prevent bypassing workflow workspace binding.",
          primaryMessage: cmd,
          command: cmd,
          improvementKind: "workflow-rule",
        });
        return {
          block: true,
          reason: [
            "── 🧭 WORKFLOW WORKSPACE REQUIRED ─────",
            "",
            "  During an active workflow, `git -C <path>` cannot target another workspace.",
            "  Run git commands from the worktree/cwd where this workflow started.",
            "",
            `  Workflow CWD: ${state.workflow.cwd}`,
            `  Workflow Branch: ${state.workflow.branch}`,
            "",
            "──────────────────────────────────────",
          ].join("\n"),
        };
      }

      const workspace = validateWorkflowWorkspace(state.workflow);
      if (!workspace.ok) {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "workspace",
          severity: "blocker",
          workflow: state.workflow,
          summary: "Workflow workspace mismatch blocked git push.",
          expected: "Current cwd/git root/branch match the workflow start workspace.",
          actual: workspace.problems.join(", "),
          impact: "Push is blocked to prevent cross-branch or cross-worktree mistakes.",
          primaryMessage: formatWorkspaceMismatch(workspace),
          command: cmd,
          improvementKind: "workflow-rule",
        });
        return {
          block: true,
          reason: formatWorkspaceMismatch(workspace),
        };
      }

      if (state.workflow.phase !== "push") {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "phase",
          severity: "blocker",
          workflow: state.workflow,
          summary: "git push was attempted outside the push phase.",
          expected: "git push is allowed only during the push phase.",
          actual: `Current phase: ${state.workflow.phase}`,
          impact: "Push is blocked until review/document/commit phases are completed.",
          primaryMessage: `Current phase: ${state.workflow.phase}; required phase: push`,
          command: cmd,
          improvementKind: "workflow-rule",
        });
        // block + steer: LLM이 올바른 페이즈 진입 방법을 알 수 있도록 교정 지시 주입
        void steerLlm(
          `🚦 git push는 push 페이즈에서만 실행할 수 있습니다. 현재 페이즈: ${state.workflow.phase}.\n` +
          `workflow_approve를 호출해 단계를 진행하고, commit → push 전환 후 다시 시도하세요.`,
          "steer",
        );
        return {
          block: true,
          reason: `git push blocked: current phase is "${state.workflow.phase}", required phase is "push". workflow_approve로 단계를 진행하세요.`,
        };
      }

      if (!state.workflow.history.some((item) => item.from === "commit" && item.to === "push")) {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "phase",
          severity: "blocker",
          workflow: state.workflow,
          summary: "git push was attempted without commit → push transition history.",
          expected: "Workflow history contains commit → push before git push.",
          actual: "Missing commit → push transition history.",
          impact: "Push is blocked to prevent skipped workflow phases.",
          primaryMessage: "Missing workflow transition history: commit → push",
          command: cmd,
          improvementKind: "workflow-rule",
        });
        return {
          block: true,
          reason: formatGateBlocked({
            gate: "Workflow Transition History",
            why: "The workflow is in push, but commit → push transition history is missing.",
            next: [
              "Use workflow_state tool or /workflow state commit to return to commit phase (manual recovery)",
              "Then call workflow_approve to show the user the commit → push approval dialog",
              "Only after the commit → push transition is recorded in workflow history, retry git push",
            ],
          }),
        };
      }

      // Push authority is derived from strict workflow phase/history validation.
      // Diagnostic guard evidence is not the policy source.
    }

    const policySkip = consumeSkipToken("policy-scan");
    if (!policySkip) {
      const policyScan = scanPushPolicy();
      const policySignature = pushPolicySignature(policyScan);
      const policyAlreadyApproved = state.policyApprovals.at(-1)?.signature === policySignature;
      if (!policyScan.ok && !policyAlreadyApproved) {
        writeFieldLogEvent({
          type: "policy.blocked",
          category: "push-policy",
          severity: "blocker",
          workflow: state.workflow,
          summary: "Push policy scan blocked git push.",
          expected: "Risky push requires policy review or explicit one-use exception.",
          actual: `Policy findings: ${policyScan.findings.map((finding) => finding.category).join(", ")}`,
          impact: "Push is blocked until changes are reviewed or user approves skip.",
          primaryMessage: formatPushPolicyScanBlocked(policyScan),
          command: cmd,
          files: policyScan.findings.flatMap((finding) => finding.files.slice(0, 20).map((file) => ({ path: file, role: "changed" as const }))),
          improvementKind: "workflow-rule",
        });

        if (ctx.hasUI) {
          const approved = await ctx.ui.confirm(
            "Push policy scan 승인 확인",
            [
              formatPushPolicyScanBlocked(policyScan),
              "",
              "위험 변경 사항을 확인했으며 git push를 계속 진행하시겠습니까?",
              "",
              "예: 현재 workspace 상태를 승인하고 push합니다.",
              "아니오: push를 차단합니다. 변경 사항을 검토하거나 `/workflow skip policy-scan <사유>`로 예외 처리하세요.",
            ].join("\n"),
          );
          if (approved) {
            state.gateFailures.delete("policy-scan");
            state.policyApprovals.push({
              timestamp: Date.now(),
              totalChanged: policyScan.totalChanged,
              categories: policyScan.findings.map((finding) => finding.category),
              signature: policySignature,
            });
            if (state.policyApprovals.length > 20) state.policyApprovals.shift();
            return; // allow push
          }
        }

        return {
          block: true,
          reason: [
            formatPushPolicyScanBlocked(policyScan),
            "",
            "위험 변경 사항을 검토하고 줄인 뒤 git push를 재시도하세요.",
            "또는 `/workflow skip policy-scan <사유>`로 명시 예외 처리하세요.",
          ].join("\n"),
        };
      }
    }

    // Review authority is enforced during code_review → review_approved and commit → push.
    // `git push` only rechecks workspace, phase, transition history, and push policy.
  });

  // ── Post-push completion: successful git push completes the workflow ───────
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = String((event.input as any)?.command ?? "");
    if (!isGitPush(cmd) || isGitPushDryRun(cmd)) return;
    if (event.isError) return;
    if (!state.workflow || state.workflow.phase !== "push") return;
    if (!state.workflow.history.some((item) => item.from === "commit" && item.to === "push")) return;

    transitionWorkflow(state.workflow, "done", "git_push_succeeded");
    saveWorkflow(state.workflow);
    writeFieldLogEvent({
      type: "phase.transition",
      category: "phase",
      severity: "info",
      status: "resolved",
      workflow: state.workflow,
      summary: "Successful git push completed the workflow.",
      expected: "A successful push-phase git push advances push → done.",
      actual: "git push tool_result completed without error.",
      impact: "Active workflow is cleared so stale push-phase context is not injected into later prompts.",
      primaryMessage: "Workflow 전이: push → done",
      command: cmd,
      improvementKind: "workflow-rule",
    });
    clearActiveWorkflowAfterCompletion();
    applyPhaseToolPolicy(null);
    refreshBoard(ctx);
    refreshStatus(ctx);
    ctx.ui.notify("Workflow 전이: push → done\nGit push 성공으로 workflow를 완료했습니다.", "info");
  });

  // ── session_start: 상태 초기화 + 세션 컨텍스트 알림 ───────────────────────
  // ── Fun working indicator ──────────────────────────────────────────────
  // 응답 스트리밍 중... 표시되는 인디케이터를 재미있는 문구들로 교체합니다.

  /**
   * 회색 바탕에 흰색 하이라이트를 입힙니다. pos(0~1)는 하이라이트 중심 위치이며,
   * 프레임마다 pos가 오른쪽으로 이동하면서 흰빛이 흘러가는 효과를 냅니다.
   */
  function shimmerGradient(text: string, pos = 0): string {
    const base: [number, number, number] = [105, 105, 105]; // 바탕 회색
    const hi: [number, number, number]   = [255, 255, 255]; // 하이라이트 흰색
    const halfWidth = 0.18; // 하이라이트가 닿는 좌우 폭(글자 비율)
    const chars = [...text]; // Unicode 코드 포인트 단위로 분리
    const n = chars.length;
    return chars.map((ch, i) => {
      // 공백과 제어 문자는 채색 안 함
      if (ch === " " || ch.charCodeAt(0) < 32) return ch;
      const t = n <= 1 ? 0 : i / (n - 1);
      const d = Math.abs(t - pos);
      const lin = Math.max(0, 1 - d / halfWidth);
      const e = lin * lin * (3 - 2 * lin); // smoothstep 으로 부드러운 falloff
      const r = Math.round(base[0] + (hi[0] - base[0]) * e);
      const g = Math.round(base[1] + (hi[1] - base[1]) * e);
      const b = Math.round(base[2] + (hi[2] - base[2]) * e);
      return `\x1b[38;2;${r};${g};${b}m${ch}`;
    }).join("") + "\x1b[0m";
  }

  /**
   * 단일 문구를 frameCount개의 shimmer 애니메이션 프레임으로 확장합니다.
   * 하이라이트가 왼쪽 밖에서 들어와 오른쪽 밖으로 빠져나가도록 sweep 합니다.
   */
  function shimmerFrames(text: string, frameCount = 50, sweepFrames = 25): string[] {
    return Array.from({ length: frameCount }, (_, i) => {
      const c = i % sweepFrames; // sweep를 반복해 문구 유지 시간과 흐름 속도를 분리
      const pos = -0.2 + 1.4 * (c / (sweepFrames - 1)); // -0.2 → 1.2 sweep
      return shimmerGradient(text, pos);
    });
  }
  const FUN_PHRASES = [
    "임채훈을 괴롭히는 중... 😈",
    "임채훈 열심히 갈구는 중... 🤦",
    "임채훈을 뒷조사하는 중... 🔎",
    "임채훈을 놀리는 중... 🎯",
    "임채훈 해야할 코드리뷰 대신 진행 중... 😳",
    "임채훈이 커피 마시고 오는 사이 일러바치는 중... ☕",
    "임채훈한테 들키지 않게 조용히 수정 중... 🤫",
    "임채훈의 커밋을 대신 써주는 중... ✍️",
    "임채훈에게 더 열심히 하라고 채찍질 중... 💪",
    "임채훈의 PR 반려 이유 조작 중... 📋",
    "임채훈에게 야근 시키는 계획 수립 중... 🌙",
    "임채훈한테 TDD 강요하는 중... 🧪",
    "임채훈의 코드에서 버그 찾았다... 🎉🎉🎉",
    "임채훈의 깃허브 히스토리 파헤치는 중... 🕵️",
    "임채훈보다 빨리 끝내는 중... 🏆",
    "임채훈의 변수명 지적할 목록 작성 중... 📝",
    "임채훈이 모르게 리팩토링하는 중... 🔧",
    "임채훈에게 '이건 레거시입니다' 설명하는 중... 😇",
    "임채훈이 없을 때 몰래 배포하는 척하는 중... 🚀",
	"임채훈의 커밋에서 TODO 발굴 중... ⛏️",
	"임채훈의 '간단한 수정' 분석 중... 🔬",
	"임채훈의 코드에 주석 추가 중... 📚",
	"임채훈이 남긴 기술부채 적립 중... 💳",
	"임채훈의 기술부채 상환 중... 💸",
	"임채훈의 로그에서 진실 찾는 중... 🔍",
	"임채훈의 커밋 메시지 해석 중... 📖",
	"임채훈의 브랜치 구조 복원 중... 🌳",
	"임채훈의 스택트레이스 감상 중... 🎨",
	"임채훈의 코드 고고학 진행 중... 🏺",
	"임채훈이 만들어 놓은 버그를 핫픽스 준비 중... 🚒",
	"임채훈의 예외처리 누락 수집 중... ⚠️",
	"임채훈이 작성한 정규식 해독 중... 🌀",
	"임채훈의 Race Condition 추적 중... 🏃",
	"임채훈의 TODO를 몰래 Jira로 승격 중... 🎫",
	"임채훈의 코드에서 비즈니스 로직 찾는 중... 🗺️",
	"임채훈의 if문 개수 세는 중... 🔢",
	"임채훈이 왜 성공했는지 조사 중... 🎲",
	"임채훈이 왜 실패했는지 더 조사 중... 🤯",
	"임채훈의 리뷰 요청 읽씹하는 중... 🙈",
	"임채훈보다 먼저 원인 찾는 중... 🏆",
	"임채훈이 작업한 커밋 되돌릴 준비 중... 🔄",
	"임채훈의 설명과 실제 동작 비교 중... ⚖️",
	"임채훈의 API 명세 복원 중... 📑",
	"임채훈이 결정한 함수명에 의미 부여 중... 🏷️",
	"임채훈이 작성한 코드 실행 결과에 놀라는 중... 😳",
	"임채훈이 저질러 놓은 컨텍스트 수집 중... 📚",
	"임채훈이 작성한 SQL 튜닝 중... 🗄️",
	"임채훈의 Kafka Lag 구경 중... 📈",
	"임채훈이 작성해야 될 테스트코드 대신 작성 중... 🧪",
	"임채훈이 할 문서화 대신 하는 중... 📖",
	"임채훈이 만든 버그를 연구 중... 🧬",
	"임채훈의 '금방 끝나요' 검증 중... ⌛",
	"임채훈의 설명을 한국어로 번역 중... 🌐",
	"임채훈에게 책임 소재 문의 중... ☎️",
	"임채훈이 남긴 미해결 과제 발굴 중... 🔦",
	"임채훈의 PR에 리뷰 37개 남기는 중... 💀",
	"임채훈 몰래 린터 돌리는 중... 🧹",
	"임채훈의 코드에 기도하는 중... 🙏"
  ];

  pi.on("session_start", async (event, ctx) => {
    // 재미있는 working indicator 설정 — 세션마다 랜덤 순서로 섞어서 신선함 유지
    try {
      // 세션마다 랜덤 순서로 섞고, 각 문구를 20프레임의 흐르는 무지개색 애니메이션으로 확장
      const shuffled = [...FUN_PHRASES].sort(() => Math.random() - 0.5);
      const frames = shuffled.flatMap(phrase => shimmerFrames(phrase, 50, 25));
      // 50프레임 \xd7 100ms = 문구당 5초 (흔면 sweep 2.5초 × 2회)
      (ctx.ui as any).setWorkingIndicator?.({ frames, intervalMs: 100 });
      // 인디케이터 오른쪽의 "Working..." 메시지 제거 (인터럽트 힌트는 footer에 별도 표시)
      (ctx.ui as any).setWorkingMessage?.("");
    } catch { /* non-fatal */ }

    state.codeReviewGuardSatisfiedToken = null;
    cancelWorkflowContinuationPending();

    // Fork: clear all guard evidence and workflow state so forked session starts clean.
    // The fork inherits the session file but not in-memory guard tokens or .harness state.
    if (event.reason === "fork") {
      state.workflow = null;
      state.dpaaGuardSatisfiedToken = null;
      state.codeQualityGuardSatisfiedToken = null;
      state.codeReviewGuardSatisfiedToken = null;
      state.pushExecutionGuardSatisfiedToken = null;
      state.reviewPackageToken = null;
      state.policyApprovals = [];
      state.pendingSteerMessages.clear();
      state.gateFailures = new Map();
      applyPhaseToolPolicy(null);
      ctx.ui.notify("포크된 세션에서는 guard 증거를 초기화했습니다. 이 포크에서 워크플로우를 계속하려면 /workflow load 를 실행하세요.", "info");
      return;
    }

    // Restore persisted workflow metadata only; persisted guard entries are audit-only
    // and must never become runtime authority after a session restart.
    const persisted = loadPersistedWorkflow();
    if (persisted && persisted.phase !== "done" && !state.workflow) {
      state.workflow = persisted;
    }
    applyPhaseToolPolicy(state.workflow?.phase ?? null);
    refreshBoard(ctx);
    refreshStatus(ctx);

    const root = getGitRoot();
    if (!root) return;

    const branch = getBranch(root);
    const untested = getUntestedClasses(root);

    const parts = [`브랜치: ${branch}`];
    if (untested.length === 0) {
      parts.push("미테스트 클래스: 없음 ✅");
    } else {
      const preview = untested.slice(0, 5).join(", ");
      const extra = untested.length > 5 ? ` 외 ${untested.length - 5}개` : "";
      parts.push(`미테스트 클래스: ${preview}${extra}`);
    }

    ctx.ui.notify(`Harness Gates 로드 | ${parts.join(" | ")}`, "info");

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/^\/workflow\s+state\s+(\S*)$/);
        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        const prefix = match[1] ?? "";
        const items = sharedWorkflowPhases()
          .filter((phase) => phase.startsWith(prefix))
          .map((phase) => ({ value: phase, label: `${phase} — manual recovery target` }));
        return { prefix, items };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });

  function formatGuardMemoryStatus(): string {
    const workflowId = state.workflow?.id;
    const policyScan = scanPushPolicy();
    const lastPolicy = state.policyApprovals.at(-1);
    return [
      "🧪 Guard memory/status",
      `- DPAA guard: ${workflowId && state.dpaaGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
      `- Code quality guard: ${workflowId && state.codeQualityGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
      `- Code review guard: ${state.codeReviewGuardSatisfiedToken ? `satisfied (Cr:${state.codeReviewGuardSatisfiedToken.critical} Maj:${state.codeReviewGuardSatisfiedToken.major} min:${state.codeReviewGuardSatisfiedToken.minor})` : "absent"}`,
      `- Push execution guard: ${workflowId && state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
      `- Policy scan now: ${policyScan.ok ? `ok (${policyScan.totalChanged} changed)` : `confirmation required (${policyScan.findings.map((finding) => finding.category).join(", ")})`}`,
      `- Last policy approval: ${lastPolicy ? `${new Date(lastPolicy.timestamp).toISOString()} / ${lastPolicy.totalChanged} changed / ${lastPolicy.categories.join(", ")}` : "none"}`,
    ].join("\n");
  }

  // ── before_agent_start: inject gate state into the system prompt ──────────
  //
  // System-prompt injection makes these constraints part of the model's rules,
  // instead of presenting them only as tool rejection messages to work around.
  pi.on("turn_start", async () => {
    // extensionMutationApprovedForWorkflowId is workflow-scoped; no per-turn reset needed.
  });

  pi.on("before_agent_start", async (event) => {
    markWorkflowContinuationDelivered((event as any).prompt);

    const root = getGitRoot();
    const branch = root ? getBranch(root) : "unknown";

    const dpaaOk   = Boolean(state.workflow && state.dpaaGuardSatisfiedToken?.workflowId === state.workflow.id);
    const qualOk    = Boolean(state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id);
    const reviewOk  = Boolean(state.codeReviewGuardSatisfiedToken);
    const pushOk    = Boolean(state.workflow && state.pushExecutionGuardSatisfiedToken?.workflowId === state.workflow.id);
    const authLines = [
      "[Workflow Guard Evidence]",
      `DPAA guard evidence: ${dpaaOk ? "present" : "absent"}  (required: plan_review \u2192 implement)`,
      `Code quality guard evidence: ${qualOk ? "present" : "absent"}  (required: code_review \u2192 review_approved)`,
      `Code review guard evidence: ${reviewOk ? "present" : "absent"}  (required: submit_review_package before review_approved)`,
      `Push transition evidence: ${pushOk ? "present" : "absent"}  (required: commit \u2192 push before git push)`,
      `Policy scan approvals this session: ${state.policyApprovals.length}`,
    ].join("\n");

    const injection = [
      "",
      "[Harness Context]",
      `Branch: ${branch}`,
      formatWorkflowPrompt(state.workflow),
      authLines,
      formatWorkflowReminders(scanWorkflowReminders(state.workflow, {
        recentVerificationCommands: state.recentVerificationCommands,
        codeQualityGuardSatisfied: Boolean(state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id),
        reviewPackageSubmitted: Boolean(state.workflow && state.reviewPackageToken?.workflowId === state.workflow.id),
      })),
    ].join("\n");

    return { systemPrompt: event.systemPrompt + injection };
  });
}
