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
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  formatWorkspaceCheckpoints,
  formatWorkspaceMismatch,
  getBranch,
  getGitRoot,
  getUntestedClasses,
  getWorkspaceStatusSignature,
  hasGitDashC,
  isApprovalText,
  isGitPush,
  loadPersistedWorkflow,
  resolveWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  saveWorkflow,
  scanWorkflowReminders,
  scanPushPolicy,
  scanWorkflowPrerequisites,
  shouldOfferInputCheckpoint,
  shortInputReason,
  undoWorkflow,
  redoWorkflow,
  writeFieldLogEvent,
  validateWorkflowWorkspace,
  transitionWorkflow,
  isSharedWorkflowPhase,
  sharedWorkflowPhases,
  isSharedAutoAdvancePhase,
  getPhaseAllowedTools,
  sha256File,
  findPlanForDpaa,
  getCatalogCommand,
  getCatalogCommandsForPhase,
  isPhaseAllowed,
  runCatalogCommand,
  formatCatalogCommandResult,
  formatWorkflowBoard,
  PHASE_ALLOWED_BUILTIN_TOOLS,
  validateEditPath,
  computeBaseFileHashes,
  verifyBaseFileHashes,
  applyProposedEdit,
  formatEditScopeDiff,
  createEditScope,
  COMMAND_CATALOG,
  type WorkflowBoardState,
  type EditScope,
  type ProposedEdit,
  type WorkflowInstance,
  type WorkflowPhase,
} from "./workflow/core";

// This file lives at: <harness-root>/.pi/extensions/workflow.ts
const HARNESS_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_CONTINUATION_MARKER_PREFIX = "harness-workflow-continuation:";

type WorkflowContinuationPending = {
  workflowId: string;
  phase: WorkflowPhase;
  marker: string;
};

export default function (pi: ExtensionAPI) {
  // ── In-memory state ────────────────────────────────────────────────────────
  // Process memory only: the LLM cannot forge this guard evidence through shell/file writes.
  const state = {
    codeReviewGuardSatisfiedToken: null as {
      critical: number;
      major: number;
      minor: number;
      timestamp: number;
    } | null,
    workflow: null as WorkflowInstance | null,
    dpaaGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string; planSha256?: string } | null,
    codeQualityGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    pushExecutionGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    policyApprovals: [] as Array<{ timestamp: number; totalChanged: number; categories: string[]; signature: string }>,
    extensionMutationTurnApproved: false,
    autoCheckpointForSession: false,
    gateFailures: new Map<string, number>(),
    lastInputCheckpointSignature: null as string | null,
    recentVerificationCommands: [] as Array<{ command: string; timestamp: number; phase?: string }>,
    reviewPackageToken: null as null | { workflowId: string; timestamp: number; critical: number; major: number; minor: number; mainSummary: string; reviewerSummary: string; qualitySummary: string },
    workflowContinuationPending: null as WorkflowContinuationPending | null,
    cancelledWorkflowContinuationMarkers: new Set<string>(),
    activeEditScope: null as EditScope | null,
  };

  // ── Guard token persistence ──────────────────────────────────────────────
  // Tokens live in process memory only. Persisting them as CustomEntries lets
  // them survive session restarts as long as the workflow ID still matches.
  const HARNESS_TOKEN_TYPES = {
    DPAA:           "harness-dpaa-token",
    CODE_QUALITY:   "harness-code-quality-token",
    CODE_REVIEW:    "harness-code-review-token",
    PUSH_EXECUTION: "harness-push-token",
    REVIEW_PACKAGE: "harness-review-package-token",
  } as const;

  function persistGuardToken(type: string, data: Record<string, unknown>): void {
    try { pi.appendEntry(type, { ...data, persistedAt: Date.now() }); } catch { /* non-fatal */ }
  }

  // Type guards for token restoration — prevent silent field-type mismatches
  function isWorkflowToken(d: Record<string, unknown>): d is { workflowId: string; issuedAt: number; reason: string } {
    return typeof d.workflowId === "string" && typeof d.issuedAt === "number" && typeof d.reason === "string";
  }
  function isCodeReviewToken(d: Record<string, unknown>): d is { workflowId: string; critical: number; major: number; minor: number; timestamp: number } {
    return typeof d.workflowId === "string" && typeof d.critical === "number" && typeof d.major === "number" && typeof d.minor === "number" && typeof d.timestamp === "number";
  }
  function isReviewPackageToken(d: Record<string, unknown>): d is { workflowId: string; timestamp: number; critical: number; major: number; minor: number; mainSummary: string; reviewerSummary: string; qualitySummary: string } {
    return typeof d.workflowId === "string" && typeof d.timestamp === "number" && typeof d.critical === "number" && typeof d.major === "number" && typeof d.minor === "number";
  }

  function restoreGuardTokens(entries: readonly { type: string; customType?: string; data?: unknown }[]): void {
    const wf = state.workflow;
    if (!wf) return;
    const seen = new Set<string>();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== "custom" || !e.customType) continue;
      if (seen.has(e.customType)) continue;
      seen.add(e.customType);
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (d.workflowId !== wf.id) continue;
      switch (e.customType) {
        case HARNESS_TOKEN_TYPES.DPAA:
          if (!state.dpaaGuardSatisfiedToken && isWorkflowToken(d))
            state.dpaaGuardSatisfiedToken = { ...d, planSha256: typeof d.planSha256 === "string" ? d.planSha256 : undefined };
          break;
        case HARNESS_TOKEN_TYPES.CODE_QUALITY:
          if (!state.codeQualityGuardSatisfiedToken && isWorkflowToken(d))
            state.codeQualityGuardSatisfiedToken = d;
          break;
        case HARNESS_TOKEN_TYPES.CODE_REVIEW:
          if (!state.codeReviewGuardSatisfiedToken && isCodeReviewToken(d))
            state.codeReviewGuardSatisfiedToken = { critical: d.critical, major: d.major, minor: d.minor, timestamp: d.timestamp };
          break;
        case HARNESS_TOKEN_TYPES.PUSH_EXECUTION:
          if (!state.pushExecutionGuardSatisfiedToken && isWorkflowToken(d))
            state.pushExecutionGuardSatisfiedToken = d;
          break;
        case HARNESS_TOKEN_TYPES.REVIEW_PACKAGE:
          if (!state.reviewPackageToken && isReviewPackageToken(d))
            state.reviewPackageToken = d;
          break;
      }
    }
  }

  // ── Phase-based tool policy ─────────────────────────────────────────────────
  // Restricts the LLM’s callable tool surface to what’s appropriate for the
  // active workflow phase. Call after any phase change or on session restore.
  // ── Workflow board widget ──────────────────────────────────────────────────
  function getBoardState(): WorkflowBoardState {
    const workflowId = state.workflow?.id;
    return {
      workflow: state.workflow,
      gateFailures: state.gateFailures,
      dpaaGuardSatisfied: Boolean(workflowId && state.dpaaGuardSatisfiedToken?.workflowId === workflowId),
      codeQualityGuardSatisfied: Boolean(workflowId && state.codeQualityGuardSatisfiedToken?.workflowId === workflowId),
      reviewPackageSubmitted: Boolean(workflowId && state.reviewPackageToken?.workflowId === workflowId),
      pushGuardSatisfied: Boolean(workflowId && state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId),
    };
  }

  function refreshBoard(ctx: { hasUI: boolean; ui: { setWidget: (...args: unknown[]) => void; theme?: unknown } }): void {
    if (!ctx.hasUI) return;
    try {
      const theme = (ctx.ui as any).theme;
      const lines = formatWorkflowBoard(getBoardState()).map((line) => {
        if (!theme) return line;
        // Colour phase name
        if (line.startsWith("🧭")) {
          return theme.fg("accent", line);
        }
        // Colour gate status line
        if (line.startsWith("Gates:")) {
          return line
            .replace(/✅ pass/g, theme.fg("success", "✅ pass"))
            .replace(/❌ fail/g, theme.fg("error", "❌ fail"))
            // (no "✅ submitted" — gate vocab unified to "✅ pass" in formatWorkflowBoard)
            .replace(/⏳ pending/g, theme.fg("muted", "⏳ pending"));
        }
        if (line.startsWith("Tools:") || line.startsWith("Cmds:")) {
          return theme.fg("dim", line);
        }
        if (line.startsWith("→")) {
          return theme.fg("warning", line);
        }
        if (line.startsWith("   ") && !line.trim().startsWith("Gates") && !line.trim().startsWith("Tools") && !line.trim().startsWith("Cmds")) {
          // title line — slightly brighter than dim
          return theme ? theme.fg("text", line) : line;
        }
        return theme.fg("dim", line);
      });
      (ctx.ui as any).setWidget("workflow-board", lines);
    } catch { /* non-fatal */ }
  }

  function refreshStatus(ctx: { hasUI: boolean; ui: { setStatus?: (...args: unknown[]) => void; theme?: unknown } }): void {
    if (!ctx.hasUI || typeof (ctx.ui as any).setStatus !== "function") return;
    try {
      const theme = (ctx.ui as any).theme;
      const wf = state.workflow;
      if (!wf) {
        (ctx.ui as any).setStatus("workflow-phase", theme?.fg("muted", "⚪ no workflow") ?? "⚪ no workflow");
        return;
      }
      const workflowId = wf.id;
      const dpaa    = state.dpaaGuardSatisfiedToken?.workflowId === workflowId ? "✅" : (state.gateFailures.get("dpaa") ?? 0) > 0 ? "❌" : "⏳";
      const quality = state.codeQualityGuardSatisfiedToken?.workflowId === workflowId ? "✅" : (state.gateFailures.get("code-quality") ?? 0) > 0 ? "❌" : "⏳";
      const review  = state.reviewPackageToken?.workflowId === workflowId ? "✅" : "⏳";
      const push    = state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId ? "✅" : "⏳";
      const phaseStr = theme?.fg("accent", wf.phase) ?? wf.phase;
      // Show push guard only in commit/push phases to keep footer concise
      const gateItems = ["DPAA", dpaa, "Quality", quality, "Review", review];
      if (wf.phase === "commit" || wf.phase === "push") gateItems.push("Push", push);
      const gatesStr = theme?.fg("dim", `${gateItems[0]}:${gateItems[1]} ${gateItems[2]}:${gateItems[3]} ${gateItems[4]}:${gateItems[5]}${gateItems[6] ? ` ${gateItems[6]}:${gateItems[7]}` : ""}`) ?? gateItems.join(" ");
      const sep = theme?.fg("border", " │ ") ?? " | ";
      (ctx.ui as any).setStatus("workflow-phase", `⚙️ ${phaseStr}${sep}${gatesStr}`);
    } catch { /* non-fatal */ }
  }

  function applyPhaseToolPolicy(phase: WorkflowPhase | null): void {
    // Guard: pi.getAllTools / pi.setActiveTools may not exist in test/minimal environments
    if (typeof (pi as any).getAllTools !== "function" || typeof (pi as any).setActiveTools !== "function") return;
    const all = (pi as any).getAllTools() as Array<{ name: string; sourceInfo: { source: string } }>;
    if (!phase) {
      // No active workflow — restore all tools
      (pi as any).setActiveTools(all.map((t) => t.name));
      return;
    }
    const extensionTools = all
      .filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk")
      .map((t) => t.name);
    const allowed = getPhaseAllowedTools(phase, extensionTools);
    (pi as any).setActiveTools(allowed);
  }

  function normalizePathText(value: string): string {
    return value.replace(/\\/g, "/");
  }

  function mentionsExtensionPath(value: string): boolean {
    const normalized = normalizePathText(value);
    return /(^|[\s"'=:(])(?:target\/)?\.pi\/extensions(?:\/|$)/.test(normalized) || normalized.includes("/.pi/extensions/") || normalized.includes("/target/.pi/extensions/");
  }

  function collectStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collectStrings);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
    return [];
  }

  function isLikelyMutatingBash(command: string): boolean {
    if (!mentionsExtensionPath(command)) return false;
    return /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|sed\s+-i|perl\s+-pi|python3?|node|npx|tsx)\b/.test(command)
      || /(>|>>|\btee\b)/.test(command);
  }

  function requiresExtensionMutationApproval(toolName: string, input: unknown): boolean {
    const lower = toolName.toLowerCase();
    const strings = collectStrings(input);
    if (!strings.some(mentionsExtensionPath)) return false;
    if (lower === "bash") return strings.some(isLikelyMutatingBash);
    if (/^(edit|write|multi.?edit|apply.?patch)$/.test(lower)) return true;
    return false;
  }

  function formatExtensionMutationApprovalReason(toolName: string, input: unknown): string {
    const targets = collectStrings(input).filter(mentionsExtensionPath).slice(0, 5);
    return [
      "── 🧩 EXTENSION MODIFICATION APPROVAL REQUIRED ─────",
      "",
      "  Modifying harness extension files requires explicit user approval.",
      "  Approval is checked in extension memory for this tool call only; no approval file/token is trusted.",
      "",
      `  Tool: ${toolName}`,
      ...targets.map((target) => `  Target: ${target.slice(0, 240)}`),
      "",
      "─────────────────────────────────────────────────────",
    ].join("\n");
  }

  function workflowContinuationMarker(workflow: WorkflowInstance): string {
    return `${workflow.id}:${workflow.phase}:${workflow.updatedAt}`;
  }

  function workflowContinuationMarkerComment(marker: string): string {
    return `<!-- ${WORKFLOW_CONTINUATION_MARKER_PREFIX}${marker} -->`;
  }

  function extractWorkflowContinuationMarker(text: string): string | undefined {
    const escaped = WORKFLOW_CONTINUATION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<!--\\s*${escaped}([^\\s>]+)\\s*-->`).exec(text)?.[1];
  }

  function cancelWorkflowContinuationPending(): void {
    if (state.workflowContinuationPending) {
      state.cancelledWorkflowContinuationMarkers.add(state.workflowContinuationPending.marker);
      if (state.cancelledWorkflowContinuationMarkers.size > 20) {
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

  function markWorkflowContinuationDelivered(text: string | undefined): void {
    if (!text) return;
    const marker = extractWorkflowContinuationMarker(text);
    if (marker && state.workflowContinuationPending?.marker === marker) state.workflowContinuationPending = null;
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
      const prompt = buildWorkflowContinuationPrompt(workflow, marker);
      const options = ctx.isIdle?.() ? undefined : { deliverAs: "followUp" };
      await (piApi as any).sendUserMessage(prompt, options);
    } catch (error) {
      state.workflowContinuationPending = null;
      ctx.ui.notify(`Workflow continuation prompt failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  async function ensureExtensionMutationApproved(toolName: string, input: unknown, ctx: any): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!requiresExtensionMutationApproval(toolName, input)) return { ok: true };
    if (state.extensionMutationTurnApproved) return { ok: true };
    const reason = formatExtensionMutationApprovalReason(toolName, input);
    if (!ctx.hasUI) {
      return { ok: false, reason: [reason, "", "대화형 사용자 승인이 필요하지만 현재 UI를 사용할 수 없어 extension 수정을 차단했습니다."].join("\n") };
    }
    const choice = await ctx.ui.select(
      [reason, "", "위 harness extension 파일 수정을 어떻게 처리하시겠습니까?"].join("\n"),
      [
        "예 — 이번만 허용",
        "예 — 이번 턴 동안 모두 허용",
        "아니오",
      ],
    );
    if (choice === "예 — 이번 턴 동안 모두 허용") {
      state.extensionMutationTurnApproved = true;
      return { ok: true };
    }
    if (choice === "예 — 이번만 허용") return { ok: true };
    return { ok: false, reason: "Harness extension modification blocked: user did not approve this tool call." };
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
        "예: 현재 workspace 상태에 대한 policy approval을 기록하고 push 단계로 진행합니다.",
        "아니오: push 단계 진입을 중단하고 변경 검토를 요구합니다.",
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
      if (isPartial) return new Text(theme.fg("warning", "Submitting review package…"), 0, 0);
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        return new Text(
          theme.fg("success", "✅ Review package accepted ") +
          theme.fg("dim", `Cr:${d.critical} Maj:${d.major} min:${d.minor} → ${d.workflowPhase ?? "advanced"}`),
          0, 0,
        );
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const first = text.split("\n")[0] ?? "Rejected";
      return new Text(theme.fg("error", `❌ ${first}`), 0, 0);
    },
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
      const spec = getCatalogCommand(params.commandId);
      if (!spec) {
        const available = COMMAND_CATALOG.map((s) => `${s.id} — ${s.description}`).join("\n");
        return {
          content: [{ type: "text", text: `Unknown command ID: "${params.commandId}".
Available:
${available}` }],
          details: { ok: false, reason: "unknown-command" },
        };
      }

      const phase = state.workflow?.phase ?? null;
      if (phase && !isPhaseAllowed(spec, phase)) {
        const allowed = getCatalogCommandsForPhase(phase).map((s) => s.id).join(", ") || "none";
        return {
          content: [{ type: "text", text: [
            `Command "${spec.id}" is not allowed in workflow phase "${phase}".`,
            `Allowed in this phase: ${allowed}`,
          ].join("\n") }],
          details: { ok: false, reason: "phase-not-allowed", phase, commandId: spec.id },
        };
      }

      if (spec.requiresApproval && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          `Run: ${spec.id}`,
          `${spec.description}
Risk level: ${spec.riskLevel}`,
        );
        if (!ok) {
          return {
            content: [{ type: "text", text: `Command "${spec.id}" cancelled by user.` }],
            details: { ok: false, reason: "user-cancelled" },
          };
        }
      }

      const result = runCatalogCommand(spec, getGitRoot());
      const formatted = formatCatalogCommandResult(result, spec);

      if (["code-quality", "project-test"].includes(spec.id)) {
        state.recentVerificationCommands.push({ command: spec.id, timestamp: Date.now(), phase: phase ?? undefined });
        if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
      }

      return {
        content: [{ type: "text", text: formatted }],
        details: { ok: result.ok, commandId: spec.id, exitCode: result.exitCode, elapsedMs: result.elapsedMs, truncated: result.truncated },
      };
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
        return new Text(theme.fg("warning", `▶ Running: ${String(d2?.commandId ?? "")} …`), 0, 0);
      }
      const d = result.details as Record<string, unknown>;
      const ms = d?.elapsedMs ? `${d.elapsedMs}ms` : "";
      const exit = d?.exitCode !== undefined ? `exit ${d.exitCode}` : "";
      const trunc = d?.truncated ? theme.fg("warning", " [truncated]") : "";
      if (d?.ok) {
        const output = (result.content[0]?.type === "text" ? result.content[0].text : "").split("\n").filter(Boolean);
        const lines = output.slice(-3).join(" │ ").slice(0, 80);
        return new Text(
          theme.fg("success", `✅ ${d.commandId} `) +
          theme.fg("dim", `(${ms})`) + trunc +
          (lines ? `\n  ${theme.fg("dim", lines)}` : ""),
          0, 0,
        );
      }
      return new Text(
        theme.fg("error", `❌ ${d?.commandId ?? "command"} `) +
        theme.fg("dim", `${exit} (${ms})`) + trunc,
        0, 0,
      );
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
      "Use workflow_propose_edit for non-trivial file changes during implement or document phases.",
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
      if (isPartial) return new Text(theme.fg("warning", "Awaiting user approval…"), 0, 0);
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        return new Text(
          theme.fg("success", `✅ Edits approved (${d.fileCount} file(s)) `) +
          theme.fg("dim", `→ call workflow_apply_approved_edit with scopeId`),
          0, 0,
        );
      }
      const reason = String(d?.reason ?? "rejected");
      const label = reason === "user-rejected" ? "Rejected by user" : reason === "path-validation-failed" ? "Path validation failed" : reason;
      return new Text(theme.fg("error", `❌ ${label}`), 0, 0);
    },
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
      if (isPartial) return new Text(theme.fg("warning", "Applying edits…"), 0, 0);
      const d = result.details as Record<string, unknown>;
      if (d?.ok) {
        const applied = Array.isArray(d.applied) ? d.applied as string[] : [];
        const preview = applied.slice(0, 3).map((a) => a.split(": ")[1] ?? a).join(", ");
        const extra = applied.length > 3 ? ` +${applied.length - 3}` : "";
        return new Text(
          theme.fg("success", `✅ Applied ${applied.length} edit(s): `) +
          theme.fg("dim", `${preview}${extra}`),
          0, 0,
        );
      }
      const reason = String(d?.reason ?? "failed");
      const label = reason === "stale-hashes" ? "Files changed since approval" : reason === "path-revalidation-failed" ? "Path validation failed" : "Apply failed";
      return new Text(theme.fg("error", `❌ ${label}`), 0, 0);
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
        approve: "approve — advance next allowed transition or approval boundary",
        status: "status — show current state plus LLM action",
        doctor: "doctor — check harness runtime",
        failures: "failures — show/export field logs",
        list: "list — show active or persisted workflow",
        load: "load — load persisted workflow",
        undo: "undo — restore previous workflow checkpoint",
        redo: "redo — reapply undone workflow checkpoint",
        history: "history — show transition/checkpoint history",
        abort: "abort — abort active workflow after confirmation",
        state: "state <phase> — manual recovery only, not normal advancement",
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
              "먼저 /workflow status, /workflow approve, /workflow abort 중 하나를 사용하세요.",
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
        // Kick off LLM interview automatically
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
            "- Begin the interview now: ask targeted questions to clarify requirements and remove ambiguities.",
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
        ctx.ui.notify([`✅ Workflow 인스턴스를 메모리에 로드했습니다: [${persisted.phase}] ${persisted.title}`, "", formatWorkflowStatus(state.workflow)].join("\n"), "info");
        return;
      }

      if (command === "approve") {
        if (state.workflow?.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
          ctx.ui.notify([
            "Review package required before review_approved. Run main self-review, independent reviewer/subagent review, quality gates, then call submit_review_package.",
            "",
            formatWorkflowAction(state.workflow),
          ].join("\n"), "warning");
          return;
        }
        if (state.workflow?.phase === "commit" && !(await confirmPushPolicyForPushPhase(ctx))) return;
        const workflowId = state.workflow?.id ?? null;
        const approvedPlanSha256 = state.dpaaGuardSatisfiedToken?.planSha256;
        const result = await advanceWorkflow(state.workflow, "user_approved", { approvedPlanSha256 });
        if (!result.ok) {
          if (result.gate) { state.gateFailures.set(result.gate, (state.gateFailures.get(result.gate) ?? 0) + 1); }
          ctx.ui.notify([result.message, "", formatWorkflowAction(state.workflow)].join("\n"), "warning");
          return;
        }
        const transitions = result.transitions ?? [];
        transitions.forEach((t) => {
          if (t.from === "plan_review" && t.to === "implement") state.gateFailures.delete("dpaa");
          if (t.from === "code_review" && t.to === "review_approved") state.gateFailures.delete("code-quality");
        });
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
        notices.push("", formatWorkflowAction(state.workflow));
        applyPhaseToolPolicy(state.workflow.phase);
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify(notices.join("\n"), "info");
        await queueWorkflowContinuation(pi, ctx, state.workflow, transitions);
        return;
      }

      if (command === "undo") {
        const result = undoWorkflow(state.workflow);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }

      if (command === "redo") {
        const result = redoWorkflow(state.workflow);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
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
        const phase = state.workflow?.phase ?? null;
        const builtins = phase ? PHASE_ALLOWED_BUILTIN_TOOLS[phase] ?? [] : ["all"];
        const catalogCmds = phase ? getCatalogCommandsForPhase(phase) : COMMAND_CATALOG;
        const extensionToolNames = [
          "submit_review_package",
          "workflow_run_command",
          "workflow_propose_edit",
          "workflow_apply_approved_edit",
        ];
        const lines = [
          phase ? `⚙️ Phase: ${phase}` : "No active workflow (showing all)",
          "",
          `Built-in tools: ${(builtins as readonly string[]).join(", ") || "none"}`,
          "",
          "Extension tools (always available):",
          ...extensionToolNames.map((n) => `  ${n}`),
          "",
          "Catalog commands (via workflow_run_command):",
          ...catalogCmds.map((s) => `  ${s.id.padEnd(20)} ${s.description}  [${s.riskLevel}]`),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
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
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", "warning");
          return;
        }
        const workspace = validateWorkflowWorkspace(state.workflow);
        if (!workspace.ok) {
          ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
          return;
        }
        const reason = rest.join(" ").trim() || "manual";
        const checkpoint = createWorkspaceCheckpoint(state.workflow, reason);
        state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
        ctx.ui.notify(checkpoint ? `Workspace checkpoint 생성: ${path.basename(checkpoint)}` : "Workspace checkpoint를 생성하지 못했습니다.", checkpoint ? "info" : "warning");
        return;
      }

      if (command === "checkpoints") {
        ctx.ui.notify(formatWorkspaceCheckpoints(state.workflow), "info");
        return;
      }

      if (command === "restore") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", "warning");
          return;
        }
        const workspace = validateWorkflowWorkspace(state.workflow);
        if (!workspace.ok) {
          ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
          return;
        }
        const checkpointId = rest[0];
        const checkpoint = resolveWorkspaceCheckpoint(state.workflow, checkpointId);
        if (!checkpoint) {
          ctx.ui.notify("복구할 checkpoint를 찾지 못했습니다. /workflow checkpoints 로 목록을 확인하세요.", "warning");
          return;
        }
        createWorkspaceCheckpoint(state.workflow, `before-restore-${path.basename(checkpoint)}`);
        ctx.ui.notify(restoreWorkspaceCheckpoint(checkpoint), "info");
        state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
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
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
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
        ));
        if (!ok) return;
        addSkipToken(gate, reason);
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
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow 종료 승인 확인",
          [
            `현재 workflow(${state.workflow.phase})를 종료하시겠습니까?`,
            "",
            "예: in-memory workflow를 종료하고 persisted 참고 기록도 삭제합니다.",
            "아니오: workflow를 유지합니다.",
          ].join("\n"),
        ));
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
          ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus()].join("\n"), "info");
          return;
        }

        const persisted = loadPersistedWorkflow();
        if (!persisted) {
          ctx.ui.notify([formatWorkflowStatus(null), "", formatGuardMemoryStatus()].join("\n"), "info");
          return;
        }

        ctx.ui.notify([
          formatWorkflowStatus(null),
          "",
          formatGuardMemoryStatus(),
          "",
          "참고: 이전 workflow 기록이 파일에 남아 있지만 자동 복구하지 않습니다.",
          "파일 기록은 표시/감사용이며 gate 통과 권한으로 신뢰하지 않습니다.",
          "계속하려면 사용자가 직접 명시 명령을 입력하세요:",
          `  /workflow state ${persisted.phase}`,
          `  # last workflow: ${persisted.title}`,
          `  # updated: ${new Date(persisted.updatedAt).toISOString()}`,
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
          plan: "요구사항 확인 후 plan 단계까지 진행했다고 확인합니다. guard evidence는 복구하지 않습니다.",
          plan_review: "plan 작성 후 review 단계까지 진행했다고 확인합니다. DPAA는 아직 통과한 것으로 간주하지 않습니다.",
          implement: "DPAA guard가 만족되어 implement 단계에 진입했다고 확인하고 transition evidence를 복구합니다.",
          code_review: "DPAA guard가 만족되고 구현이 완료되어 code_review 단계에 진입했다고 확인합니다.",
          review_approved: "DPAA, code quality, code review guard가 모두 만족되었다고 확인하고 관련 evidence를 복구합니다.",
          document: "review_approved 이후 문서화 단계까지 진행했다고 확인하고 관련 evidence를 복구합니다.",
          commit: "문서화까지 완료되어 commit 단계까지 진행했다고 확인하고 관련 evidence를 복구합니다.",
          push: "DPAA, code quality, code review, commit approval이 완료되어 push 단계라고 확인하고 transition evidence를 복구합니다.",
          done: "workflow가 완료되었다고 표시합니다. 실행 evidence는 복구하지 않습니다.",
        };
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow state 수동 변경 승인 확인",
          [
            `workflow memory 상태를 '${next}' 단계로 변경하시겠습니까?`,
            "",
            recoveryClaims[next],
            "",
            "예: 위 내용을 내가 확인하고 phase/evidence를 복구합니다.",
            "아니오: phase와 evidence를 변경하지 않습니다.",
            "",
            "주의: 이 명령은 사용자의 명시적 복구 승인으로 간주됩니다. 자동 파일 복구는 여전히 신뢰하지 않습니다.",
          ].join("\n"),
        ));
        if (!ok) return;
        cancelWorkflowContinuationPending();
        if (!state.workflow) state.workflow = createWorkflow("manual");
        transitionWorkflow(state.workflow, next, "manual_override");
        state.dpaaGuardSatisfiedToken = null;
        state.codeQualityGuardSatisfiedToken = null;
        state.pushExecutionGuardSatisfiedToken = null;
        state.codeReviewGuardSatisfiedToken = null;
        const phaseIndex = phases.indexOf(next);
        const evidenceNotices: string[] = [];
        if (phaseIndex >= phases.indexOf("implement") && next !== "done") {
          state.dpaaGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          persistGuardToken(HARNESS_TOKEN_TYPES.DPAA, state.dpaaGuardSatisfiedToken as unknown as Record<string, unknown>);
          evidenceNotices.push("DPAA guard satisfied → transition evidence 복구");
        }
        if (phaseIndex >= phases.indexOf("review_approved") && next !== "done") {
          state.codeQualityGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
          persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY, state.codeQualityGuardSatisfiedToken as unknown as Record<string, unknown>);
          persistGuardToken(HARNESS_TOKEN_TYPES.CODE_REVIEW, { ...state.codeReviewGuardSatisfiedToken, workflowId: state.workflow.id });
          evidenceNotices.push("Code quality guard satisfied → quality evidence 복구");
          evidenceNotices.push("Code review guard satisfied → review evidence 복구");
        }
        if (phaseIndex >= phases.indexOf("push") && next !== "done") {
          state.pushExecutionGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          persistGuardToken(HARNESS_TOKEN_TYPES.PUSH_EXECUTION, state.pushExecutionGuardSatisfiedToken as unknown as Record<string, unknown>);
          if (!state.workflow.history.some((item) => item.from === "commit" && item.to === "push")) {
            state.workflow.history.push({ from: "commit", to: "push", reason: "manual_state_restore", timestamp: Date.now() });
          }
          evidenceNotices.push("Push phase approved → transition evidence 복구");
        }
        saveWorkflow(state.workflow);
        ctx.ui.notify([
          formatWorkflowStatus(state.workflow),
          "",
          evidenceNotices.length > 0 ? `수동 state 복구 완료: ${evidenceNotices.join(", ")}` : "수동 state 복구 완료: 복구할 guard evidence 없음",
          "",
          "주의: /workflow state <phase>는 수동 복구 전용입니다. 정상 진행에는 /workflow approve 또는 submit_review_package를 사용하세요.",
          "",
          formatGuardMemoryStatus(),
        ].join("\n"), "warning");
        return;
      }

      ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus()].join("\n"), "info");
    },
  });

  // ── User-input checkpoint prompt + natural approval handling ───────────────
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" && consumeCancelledWorkflowContinuationPrompt(event.text)) {
      return { action: "handled" };
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

    if (!isApprovalText(event.text)) return { action: "continue" };

    const from = state.workflow.phase;
    if (state.workflow.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          "[Workflow] Review package is required before review_approved.",
          "Run main self-review, independent reviewer/subagent review, quality gates, then call submit_review_package.",
        ].join("\n"),
      };
    }

    if (state.workflow.phase === "commit" && !(await confirmPushPolicyForPushPhase(ctx))) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          "[Workflow] Interactive user approval was received, but push policy scan requires confirmation before entering push phase.",
          "Review the policy scan warning and approve again after resolving or accepting the risk.",
        ].join("\n"),
      };
    }

    const workflowId = state.workflow.id;
    const result = await advanceWorkflow(state.workflow, "natural_language_approval", { approvedPlanSha256: state.dpaaGuardSatisfiedToken?.planSha256 });
    if (!result.ok) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          `[Workflow] Interactive user approval was received, but transition was blocked: ${result.message}`,
          "Resolve the blocker before asking the user to approve the next phase again.",
        ].join("\n"),
      };
    }

    const transitions = result.transitions ?? [{ from, to: state.workflow.phase }];
    const transitionPath = transitions.map((item, index) => index === 0 ? `'${item.from}' → '${item.to}'` : `→ '${item.to}'`).join(" ");
    const notices: string[] = [
      `[Workflow] Interactive user approval advanced the workflow: ${transitionPath}.`,
    ];
    if (transitions.some((item) => item.from === "plan_review" && item.to === "implement")) {
      const dpaaNlaTx = transitions.find((t) => t.from === "plan_review" && t.to === "implement");
      state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval", planSha256: dpaaNlaTx?.planSha256 };
      persistGuardToken(HARNESS_TOKEN_TYPES.DPAA, state.dpaaGuardSatisfiedToken as unknown as Record<string, unknown>);
      notices.push("[Workflow] DPAA guard satisfied: transition evidence recorded in current-session memory.");
    }
    if (transitions.some((item) => item.from === "code_review" && item.to === "review_approved")) {
      state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "automated_review_passed" };
      state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
      persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY, state.codeQualityGuardSatisfiedToken as unknown as Record<string, unknown>);
      persistGuardToken(HARNESS_TOKEN_TYPES.CODE_REVIEW, { ...state.codeReviewGuardSatisfiedToken, workflowId });
      state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
      if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
      notices.push("[Workflow] Automated review approved: review/quality evidence recorded in current-session memory.");
      notices.push("[Workflow] Code quality guard satisfied: quality evidence recorded in current-session memory.");
    }
    if (transitions.some((item) => item.from === "commit" && item.to === "push")) {
      state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval" };
      persistGuardToken(HARNESS_TOKEN_TYPES.PUSH_EXECUTION, state.pushExecutionGuardSatisfiedToken as unknown as Record<string, unknown>);
      notices.push("[Workflow] Push phase approved: commit → push transition evidence recorded in workflow history.");
    }
    notices.push("Proceed according to the current phase and its automatic/approval transition policy.");
    notices.push(formatWorkflowAction(state.workflow));

    return {
      action: "transform",
      text: [
        event.text,
        "",
        ...notices,
      ].join("\n"),
    };
  });

  // ── Gate: tool_call(bash) → git push 차단 ─────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    const extensionApproval = await ensureExtensionMutationApproved(event.toolName, event.input, ctx);
    if (!extensionApproval.ok) return { block: true, reason: extensionApproval.reason };

    // Phase tool policy backstop: block write/edit in read-only phases
    if (state.workflow && (event.toolName === "write" || event.toolName === "edit")) {
      const phaseAllowed = PHASE_ALLOWED_BUILTIN_TOOLS[state.workflow.phase] as readonly string[] | undefined;
      if (phaseAllowed && !phaseAllowed.includes(event.toolName)) {
        return {
          block: true,
          reason: [
            `⚠️ Phase tool policy blocked: ${event.toolName} is not allowed in ${state.workflow.phase} phase.`,
            `Allowed built-in tools: ${(phaseAllowed as readonly string[]).join(", ")}`,
            state.workflow.phase === "code_review"
              ? "To modify files in code_review, use workflow_propose_edit (proposes changes for user approval) then workflow_apply_approved_edit."
              : state.workflow.phase === "plan_review" || state.workflow.phase === "review_approved"
              ? "This phase is read-only. Advance the workflow before making file changes."
              : "Use workflow_propose_edit for guarded file changes in this phase.",
          ].join("\n"),
        };
      }

      // Phase write-path policy: restrict which paths may be written per phase
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
              ? `소스 코드 파일은 ${state.workflow.phase} 페이즈에서 수정할 수 없습니다. 문서 첑(마크다운, HTML, 샘플 등)에 대한 변경만 허용됩니다.`
              : `허용된 경로: ${pathPolicy.patterns.join(", ")}.`;
            return {
              block: true,
              reason: [
                `⚠️ Phase path policy blocked: ${event.toolName} to "${filePath}" is not allowed in ${state.workflow.phase} phase.`,
                hint,
                `HARNESS_WRITE_PATH_POLICY 환경 변수로 정책 오버라이드 가능.`,
              ].join("\n"),
            };
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
        return {
          block: true,
          reason: [
            "── 🚦 WORKFLOW PHASE REQUIRED ────────",
            "",
            "  git push is allowed only during the push phase.",
            "  Complete review/document/commit deliverables, then advance with /workflow approve or interactive natural-language approval.",
            "",
            `  Current phase: ${state.workflow.phase}`,
            "  Required phase: push",
            "",
            "──────────────────────────────────────",
          ].join("\n"),
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
            next: ["Return to commit phase", "Advance commit → push through /workflow approve or explicit natural-language approval", "Retry git push"],
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

  // ── session_start: 상태 초기화 + 세션 컨텍스트 알림 ───────────────────────
  pi.on("session_start", async (event, ctx) => {
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
      state.gateFailures = new Map();
      applyPhaseToolPolicy(null);
      ctx.ui.notify("Workflow guard state cleared for forked session. Use /workflow load if the workflow should continue in this fork.", "info");
      return;
    }

    // Restore persisted workflow, guard tokens, and apply tool policy
    const persisted = loadPersistedWorkflow();
    if (persisted && !state.workflow) {
      state.workflow = persisted;
    }
    if (state.workflow) {
      restoreGuardTokens(ctx.sessionManager.getEntries() as readonly { type: string; customType?: string; data?: unknown }[]);
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
    state.extensionMutationTurnApproved = false;
  });

  pi.on("before_agent_start", async (event) => {
    markWorkflowContinuationDelivered((event as any).prompt);

    const root = getGitRoot();
    const branch = root ? getBranch(root) : "unknown";

    const authLines = [
      "[Workflow Guard Evidence]",
      `DPAA guard evidence: ${state.workflow && state.dpaaGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Code quality guard evidence: ${state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Code review guard evidence: ${state.codeReviewGuardSatisfiedToken ? "present" : "absent"}`,
      `Push transition evidence: ${state.workflow && state.pushExecutionGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
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
