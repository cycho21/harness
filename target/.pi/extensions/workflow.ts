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
import { Text, Box, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  isGitPush,
  getNextPhase,
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
  isSharedApprovalBoundary,
  getPhaseAllowedTools,
  getPhaseWritePathPolicy,
  matchesWriteGlob,
  sha256File,
  findPlanForDpaa,
  getCatalogCommand,
  getCatalogCommandsForPhase,
  isPhaseAllowed,
  runCatalogCommand,
  formatCatalogCommandResult,
  formatWorkflowBoard,
  WORKFLOW_PHASES,
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
import { launchInterviewWizard } from "./workflow/interview-ui";

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
    extensionMutationApprovedForWorkflowId: null as string | null,
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
    if (state.workflow) saveGuardTokensToState(state.workflow);
  }

  function saveGuardTokensToState(workflow: import("./workflow/types").WorkflowInstance): void {
    try {
      workflow.guardTokens = {
        dpaa: state.dpaaGuardSatisfiedToken ?? null,
        codeQuality: state.codeQualityGuardSatisfiedToken ?? null,
        codeReview: state.codeReviewGuardSatisfiedToken
          ? { ...state.codeReviewGuardSatisfiedToken, workflowId: workflow.id }
          : null,
        pushExecution: state.pushExecutionGuardSatisfiedToken ?? null,
      };
      saveWorkflow(workflow);
    } catch { /* non-fatal */ }
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
    // 1st pass: restore from session entries (current session history)
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
    // 2nd pass: fallback to state.json guardTokens (survives new sessions)
    const gt = wf.guardTokens;
    if (!gt) return;
    if (!state.dpaaGuardSatisfiedToken && gt.dpaa?.workflowId === wf.id)
      state.dpaaGuardSatisfiedToken = gt.dpaa;
    if (!state.codeQualityGuardSatisfiedToken && gt.codeQuality?.workflowId === wf.id)
      state.codeQualityGuardSatisfiedToken = gt.codeQuality;
    if (!state.codeReviewGuardSatisfiedToken && gt.codeReview?.workflowId === wf.id)
      state.codeReviewGuardSatisfiedToken = { critical: gt.codeReview.critical, major: gt.codeReview.major, minor: gt.codeReview.minor, timestamp: gt.codeReview.timestamp };
    if (!state.pushExecutionGuardSatisfiedToken && gt.pushExecution?.workflowId === wf.id)
      state.pushExecutionGuardSatisfiedToken = gt.pushExecution;
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
      if (!state.workflow) {
        (ctx.ui as any).setWidget("workflow-board", undefined);
        return;
      }
      (ctx.ui as any).setWidget("workflow-board", (_tui: unknown, theme: any) => {
        const rawLines = formatWorkflowBoard(getBoardState());
        const coloredLines = rawLines.map((line) => {
          if (!theme) return line;
          if (line.startsWith("🧭")) return theme.fg("accent", line);
          if (line.startsWith("Gates:")) {
            return line
              .replace(/✅ pass/g, theme.fg("success", "✅ pass"))
              .replace(/❌ fail/g, theme.fg("error", "❌ fail"))
              .replace(/⏳ pending/g, theme.fg("muted", "⏳ pending"));
          }
          if (line.startsWith("Tools:") || line.startsWith("Cmds:")) return theme.fg("dim", line);
          if (line.startsWith("→")) return theme.fg("warning", line);
          if (line.startsWith("   ") && !line.trim().startsWith("Gates") && !line.trim().startsWith("Tools") && !line.trim().startsWith("Cmds")) {
            return theme.fg("text", line);
          }
          return theme.fg("dim", line);
        });
        const content = coloredLines.join("\n");
        const text = new Text(content, 0, 0);
        const bgFn = theme ? (s: string) => theme.bg("customMessageBg", s) : undefined;
        const box = new Box(1, 0, bgFn);
        box.addChild(text);
        return box;
      });
    } catch { /* non-fatal */ }
  }
  function colorOutcome(theme: any, icon: string): string {
    if (!theme) return icon;
    if (icon === "✅") return theme.fg("success", icon);
    if (icon === "❌") return theme.fg("error", icon);
    if (icon === "⏳") return theme.fg("warning", icon);
    return theme.fg("muted", icon);
  }

  function colorResultLabel(theme: any, kind: "success" | "warning" | "error" | "muted", text: string): string {
    if (!theme) return text;
    return theme.fg(kind, text);
  }

  function resultBox(theme: any, kind: "success" | "warning" | "error" | "pending", content: string): Box {
    const bgToken = kind === "success" ? "toolSuccessBg" : kind === "error" ? "toolErrorBg" : "toolPendingBg";
    const bgFn = theme ? (s: string) => theme.bg(bgToken, s) : undefined;
    const box = new Box(1, 0, bgFn);
    box.addChild(new Text(content, 0, 0));
    return box;
  }

  function formatTransitionDetails(value: unknown): string {
    if (!Array.isArray(value)) return "advanced";
    const labels = value
      .map((item) => typeof item === "string" ? item : null)
      .filter((item): item is string => Boolean(item && item.trim()));
    return labels.length > 0 ? labels.join(" → ") : "advanced";
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
      const nextPhase = getNextPhase(wf.phase);
      const phaseIndex = Math.max(0, WORKFLOW_PHASES.indexOf(wf.phase)) + 1;
      const phaseTotal = WORKFLOW_PHASES.length;
      const title = truncateToWidth(wf.title || "workflow", 32);
      const workflowStr = `${theme?.fg("dim", "Workflow") ?? "Workflow"}: ${theme?.fg("accent", title) ?? title}`;
      const phaseStr = `${theme?.fg("dim", "phase") ?? "phase"}: ${theme?.fg("accent", wf.phase) ?? wf.phase}${theme?.fg("dim", " → ") ?? " -> "}${theme?.fg("accent", nextPhase ?? "done") ?? (nextPhase ?? "done")}`;
      const progressStr = `${theme?.fg("dim", "progress") ?? "progress"}: ${phaseIndex}/${phaseTotal}`;
      const gatePairs = [["DPAA", dpaa], ["Quality", quality], ["Review", review]];
      if (wf.phase === "commit" || wf.phase === "push") gatePairs.push(["Push", push]);
      const gatesStr = gatePairs
        .map(([label, icon]) => `${theme?.fg("dim", label) ?? label}:${colorOutcome(theme, icon)}`)
        .join(theme?.fg("dim", " ") ?? " ");
      const sep = theme?.fg("border", " │ ") ?? " | ";
      (ctx.ui as any).setStatus("workflow-phase", `⚙️ ${workflowStr}${sep}${phaseStr}${sep}${progressStr}${sep}${gatesStr}`);
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

  function mentionsRuntimeExtensionPath(value: string): boolean {
    const normalized = normalizePathText(value);
    // Protect only the running project-local runtime extension path: .pi/extensions/**.
    // In the harness source repository, target/.pi/extensions/** is the deployment
    // template source and must remain a normal editable development target.
    if (/(^|[\s"'=:(])target\/\.pi\/extensions(?:\/|$)/.test(normalized)) return false;
    if (normalized.includes("/target/.pi/extensions/")) return false;
    return /(^|[\s"'=:(])\.pi\/extensions(?:\/|$)/.test(normalized)
      || normalized.includes("/.pi/extensions/");
  }

  function collectStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collectStrings);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
    return [];
  }

  function isLikelyMutatingBash(command: string): boolean {
    if (!mentionsRuntimeExtensionPath(command)) return false;
    // Only block shell operations that directly mutate files. Read-like commands
    // such as cat/grep/rg/ls/find, or interpreter commands used for inspection,
    // must remain allowed even when they mention .pi/extensions/**.
    if (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|sed\s+-i|perl\s+-pi)\b/.test(command)) return true;
    // Strip safe redirects before checking for output redirects:
    //   2>/dev/null  >/dev/null  &>/dev/null  2>&1  1>&2  etc.
    const stripped = command
      .replace(/\d*&?>>?\/dev\/(null|zero|stdin|stdout|stderr)/g, "")
      .replace(/\d*>&\d+/g, "");
    return /(>|>>|\btee\b)/.test(stripped);
  }

  function requiresExtensionMutationApproval(toolName: string, input: unknown): boolean {
    const lower = toolName.toLowerCase();
    if (lower === "bash") {
      const strings = collectStrings(input);
      if (!strings.some(mentionsRuntimeExtensionPath)) return false;
      return strings.some(isLikelyMutatingBash);
    }
    if (/^(edit|write|multi.?edit|apply.?patch)$/.test(lower)) {
      // Only check the target path — not file content — to avoid false positives
      // when writing docs/plans that merely mention .pi/extensions in their text.
      const pathValue = String((input as any)?.path ?? "");
      return mentionsRuntimeExtensionPath(pathValue);
    }
    return false;
  }

  function formatExtensionMutationApprovalReason(toolName: string, input: unknown): string {
    const lower = toolName.toLowerCase();
    const targets = /^(edit|write|multi.?edit|apply.?patch)$/.test(lower)
      ? [String((input as any)?.path ?? "")].filter(Boolean)
      : collectStrings(input).filter(mentionsRuntimeExtensionPath).slice(0, 5);
    return [
      "── 🧩 RUNTIME EXTENSION WRITE APPROVAL REQUIRED ─────",
      "",
      "  Writing or editing the running .pi/extensions/** runtime files requires explicit user approval.",
      "  target/.pi/extensions/** is deployment-template source in this repo and is not protected by this guard.",
      "  Read-only inspection is allowed; approval is checked in extension memory for this mutating tool call only.",
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
      if (!state.workflow) {
        return { content: [{ type: "text", text: "No active workflow. Start one with /workflow start." }], details: { ok: false } };
      }
      const nextPhase = getNextPhase(state.workflow.phase);
      const requiresUserApproval = Boolean(nextPhase && isSharedApprovalBoundary(state.workflow.phase, nextPhase));
      if (!ctx.hasUI && requiresUserApproval) {
        return { content: [{ type: "text", text: "Interactive UI is required for this approval boundary. Re-run from a UI session so the yes/no dialog can be shown." }], details: { ok: false, reason: "no-ui" } };
      }

      // Pre-flight checks before showing any dialog — fail fast with a clear message
      if (state.workflow.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
        return {
          content: [{ type: "text", text: "⚠️ submit_review_package를 먼저 호출해야 합니다. 자기 리뷰, 독립 리뷰어 리뷰, quality gate를 완료한 후 submit_review_package를 호출하세요." }],
          details: { ok: false, reason: "review-package-required" },
        };
      }

      // commit → push: policy scan owns its own yes/no dialog; skip the generic confirm to avoid double dialogs.
      if (state.workflow.phase === "commit") {
        if (!(await confirmPushPolicyForPushPhase(ctx))) {
          return { content: [{ type: "text", text: "Push policy 확인이 거부됐습니다. Push 단계 진입이 취소됩니다." }], details: { ok: false, reason: "policy-declined" } };
        }
      } else if (requiresUserApproval) {
        const confirmed = await ctx.ui.confirm(
          `${params.summary}

[${state.workflow.phase}] → [${nextPhase ?? "done"}]

다음 단계로 진행할까요?`,
        );
        if (!confirmed) {
          return { content: [{ type: "text", text: "취소됐습니다. 현재 단계를 유지합니다." }], details: { ok: false, reason: "user-declined" } };
        }
      }

      const workflowId = state.workflow.id;
      const result = await advanceWorkflow(state.workflow, "user_approved", { approvedPlanSha256: state.dpaaGuardSatisfiedToken?.planSha256 });
      if (!result.ok) {
        if (result.gate) { state.gateFailures.set(result.gate, (state.gateFailures.get(result.gate) ?? 0) + 1); }
        refreshBoard(ctx);
        refreshStatus(ctx);
        return { content: [{ type: "text", text: `Workflow transition was requested, but it was blocked by a workflow gate.\n\n${result.message}` }], details: { ok: false, reason: "gate-blocked" } };
      }

      const transitions = result.transitions ?? [];
      transitions.forEach((t) => {
        if (t.from === "plan_review" && t.to === "implement") {
          const dpaaTx = transitions.find((tx) => tx.from === "plan_review" && tx.to === "implement");
          state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved", planSha256: dpaaTx?.planSha256 };
          persistGuardToken(HARNESS_TOKEN_TYPES.DPAA, state.dpaaGuardSatisfiedToken as unknown as Record<string, unknown>);
          state.gateFailures.delete("dpaa");
        }
        if (t.from === "code_review" && t.to === "review_approved") {
          state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "automated_review_passed" };
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
          persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY, state.codeQualityGuardSatisfiedToken as unknown as Record<string, unknown>);
          persistGuardToken(HARNESS_TOKEN_TYPES.CODE_REVIEW, { ...state.codeReviewGuardSatisfiedToken, workflowId });
          state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
          if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
          state.gateFailures.delete("code-quality");
        }
        if (t.from === "commit" && t.to === "push") {
          state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          persistGuardToken(HARNESS_TOKEN_TYPES.PUSH_EXECUTION, state.pushExecutionGuardSatisfiedToken as unknown as Record<string, unknown>);
        }
      });

      refreshBoard(ctx);
      refreshStatus(ctx);
      return {
        content: [{ type: "text", text: result.message + "\n\n" + formatWorkflowAction(state.workflow) }],
        details: { ok: true, transitions: transitions.map((t) => `${t.from} → ${t.to}`) },
      };
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
            "Review package required before review_approved. Run main self-review, independent reviewer/subagent review, quality gates, then call submit_review_package.",
            "",
            formatWorkflowAction(state.workflow),
          ].join("\n"), "warning");
          return;
        }
        const nextPhase = state.workflow ? getNextPhase(state.workflow.phase) : null;
        const requiresUserApproval = Boolean(state.workflow && nextPhase && isSharedApprovalBoundary(state.workflow.phase, nextPhase));
        if (state.workflow && requiresUserApproval && !ctx.hasUI) {
          ctx.ui.notify("Interactive UI is required for this approval boundary so the yes/no dialog can be shown.", "warning");
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
          ctx.ui.notify(["Workflow transition was requested, but it was blocked by a workflow gate.", "", result.message, "", formatWorkflowAction(state.workflow)].join("\n"), "warning");
          return;
        }
        const transitions = result.transitions ?? [];
        transitions.forEach((t) => {
          if (t.from === "plan_review" && t.to === "implement") state.gateFailures.delete("dpaa");
          if (t.from === "code_review" && t.to === "review_approved") state.gateFailures.delete("code-quality");
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
        if (transitionPath) notices.push(`Transition path: ${transitionPath}`);
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
          "workflow_approve",
          "workflow_state",
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
        applyPhaseToolPolicy(state.workflow.phase);
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify([
          formatWorkflowStatus(state.workflow),
          "",
          evidenceNotices.length > 0 ? `수동 state 복구 완료: ${evidenceNotices.join(", ")}` : "수동 state 복구 완료: 복구할 guard evidence 없음",
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

    // Natural-language approval detection removed.
    // Phase transitions are driven by workflow_approve. It shows a yes/no dialog only at approval boundaries.
    // Users should not be instructed to type /workflow approve for normal operation.
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
              ? "This phase is read/review focused. For review-loop fixes, return to an editing phase or use an explicit reviewed fix workflow."
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
            "  Complete review/document/commit deliverables, then use the workflow yes/no approval dialog to enter push.",
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
            next: ["Return to commit phase", "Use the workflow yes/no approval dialog to advance commit → push", "Retry git push"],
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
    // extensionMutationApprovedForWorkflowId is workflow-scoped; no per-turn reset needed.
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
