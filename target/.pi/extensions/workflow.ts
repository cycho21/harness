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
  exportFieldLogs,
  formatHarnessDoctor,
  formatLatestDpaaAudit,
  formatRecentFieldLogs,
  formatPushPolicyScanBlocked,
  formatWorkflowPrerequisiteScan,
  formatWorkflowHistory,
  formatWorkflowAction,
  formatWorkflowStatus,
  formatWorkspaceMismatch,
  getBranch,
  getGitRoot,
  getUntestedClasses,
  getWorkspaceStatusSignature,
  isGitPush,
  getNextPhase,
  loadPersistedWorkflow,
  saveWorkflow,
  scanPushPolicy,
  scanWorkflowPrerequisites,
  shouldOfferInputCheckpoint,
  shortInputReason,
  writeFieldLogEvent,
  validateWorkflowWorkspace,
  transitionWorkflow,
  isSharedWorkflowPhase,
  sharedWorkflowPhases,
  isSharedApprovalBoundary,
  getPhaseWritePathPolicy,
  isWritePathBlocked,
  matchesWriteGlob,
  sha256File,
  findPlanForDpaa,
  getCatalogCommand,
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
import { launchInterviewWizard, type InterviewQuestion } from "./workflow/interview-ui";
import {
  DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES,
  writeTextArtifact,
  type ArtifactDescriptor,
} from "./workflow/artifact-descriptor";
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
import { createWorkflowContinuationService } from "./workflow/application/continuation";
import {
  buildWorkflowSystemPromptInjection,
  formatGuardMemoryStatus as formatGuardMemoryStatusForState,
} from "./workflow/application/prompt-context";
import { handleWorkflowToolCall } from "./workflow/application/tool-call-gate";
import { registerWorkflowCommand } from "./workflow/application/workflow-command-router";

// This file lives at: <harness-root>/.pi/extensions/workflow.ts
const HARNESS_ROOT = path.resolve(__dirname, "../..");

const TOPOLOGY_QUESTION_ID = "round_0_topology";
const CLARITY_QUESTION_ID = "clarity_checkpoint";

function buildDeepInterviewLiteQuestions(workflowTitle: string, baselineQuestions: InterviewQuestion[]): InterviewQuestion[] {
  const normalizedBaseline = baselineQuestions.map((question) => normalizeInterviewQuestion(question));
  const hasTopology = normalizedBaseline.some((question) => question.id === TOPOLOGY_QUESTION_ID || /topology|component|scope shape|지형도|컴포넌트/i.test(`${question.title}\n${question.prompt}`));
  const hasClarity = normalizedBaseline.some((question) => question.id === CLARITY_QUESTION_ID || /clarity|ambiguity|weakest|명확성|모호/i.test(`${question.title}\n${question.prompt}`));

  return [
    ...(hasTopology ? [] : [buildTopologyQuestion(workflowTitle)]),
    ...normalizedBaseline,
    ...(hasClarity ? [] : [buildClarityQuestion()]),
  ];
}

function normalizeInterviewQuestion(question: InterviewQuestion): InterviewQuestion {
  return {
    ...question,
    allowFreeText: true,
    allowSkip: !question.required,
  };
}

function buildTopologyQuestion(workflowTitle: string): InterviewQuestion {
  return {
    id: TOPOLOGY_QUESTION_ID,
    title: "Round 0: Topology confirmation",
    prompt: [
      `작업 '${workflowTitle}'의 상위 컴포넌트 지형도를 먼저 확인합니다.`,
      "독립적으로 성공/실패를 판단할 수 있는 결과물, 표면, 통합, 또는 작업흐름을 자유입력에 적어주세요.",
      "추가/제거/병합/분리/보류할 항목이 있으면 함께 적어주세요.",
    ].join("\n"),
    helpText: "예: 1) Interview wizard UX 2) Spec/plan artifact mapping 3) README docs. 보류: scoring formula는 제외.",
    required: true,
    allowFreeText: true,
    allowSkip: false,
    choices: [
      { id: "single_component", label: "단일 컴포넌트 작업" },
      { id: "multiple_components", label: "여러 상위 컴포넌트가 있음" },
      { id: "needs_split_merge", label: "추가/제거/병합/분리가 필요함" },
      { id: "has_deferred_scope", label: "명시적으로 보류할 범위가 있음" },
      { id: "unsure", label: "아직 범위 지형도가 불확실함" },
    ],
  };
}

function buildClarityQuestion(): InterviewQuestion {
  return {
    id: CLARITY_QUESTION_ID,
    title: "Clarity checkpoint",
    prompt: [
      "현재 기준으로 가장 덜 명확한 차원을 선택하고 자유입력에 구체적인 불확실성을 적어주세요.",
      "이 답변은 wizard 이후 LLM이 가장 약한 차원부터 follow-up 질문을 고르는 데 사용됩니다.",
    ].join("\n"),
    helpText: "예: 완료 기준이 아직 pass/fail로 판단되지 않음, 기존 코드 영향 범위를 모르겠음, 보류 범위가 애매함.",
    required: false,
    allowFreeText: true,
    allowSkip: true,
    choices: [
      { id: "goal", label: "목표/문제 정의" },
      { id: "scope", label: "범위/비범위/topology" },
      { id: "acceptance", label: "완료 기준/pass-fail 조건" },
      { id: "constraints", label: "제약/위험/호환성" },
      { id: "context", label: "기존 코드/시스템 맥락" },
    ],
  };
}

function buildInterviewWizardCompletion(summaryMarkdown: string): string {
  return [
    "Interview wizard completed in deep-interview-lite mode. Collected answers:",
    "",
    summaryMarkdown,
    "",
    "Next steps for the LLM:",
    "1. Treat the Round 0 topology answer as required coverage for the spec and plan.",
    "2. For brownfield work, inspect narrow repo evidence before asking codebase-direction questions.",
    "3. Report clarity across goal, scope/out-of-scope, acceptance criteria, constraints/risks, and existing context.",
    "4. Ask focused follow-up questions for the weakest clarity dimension before advancing to plan.",
    "5. REQUIRED: Call workflow_score_interview with your per-dimension clarity scores (0-100 each).",
    "   Scoring rubric:",
    "   - goal (0-100): Can the objective be stated without qualifiers? Is the problem well-defined?",
    "   - scope (0-100): Are included, excluded, deferred, and optional parts clear?",
    "   - acceptance (0-100): Can success be judged objectively as pass/fail?",
    "   - constraints (0-100): Are limits, compatibility, risks, and dependencies clear enough?",
    "   - context (0-100): For brownfield, is the relevant code/system context understood?",
    "   Threshold: any dimension < 60 → call workflow_interview_wizard again with follow-up questions",
    "   targeting only the low-score dimensions, then re-score.",
    "   Example call (replace <N> with your actual assessed score — do NOT copy these numbers):",
    "   workflow_score_interview({ goal: <N>, scope: <N>, acceptance: <N>, constraints: <N>, context: <N>,",
    "     reasoning: \"<brief explanation of why the lowest-score dimension is unclear>\" })",
    "6. Include the score table in your chat response so the user can see the assessment.",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  // ── In-memory state ────────────────────────────────────────────────────────
  // Process memory only: the LLM cannot forge this guard evidence through shell/file writes.
  const state = createWorkflowRuntimeState();

  const continuation = createWorkflowContinuationService(state, pi);

  // ── Guard token audit entries ────────────────────────────────────────────
  // Runtime guard evidence lives in current process memory only. CustomEntries
  // are retained for audit/debugging and are never restored as authority.

  function persistGuardToken(type: string, data: Record<string, unknown>): void {
    try { pi.appendEntry(type, { ...data, persistedAt: Date.now(), auditOnly: true }); } catch { /* non-fatal */ }
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

  const workflowContinuationMarker = continuation.createContinuationMarker;
  const workflowContinuationMarkerComment = continuation.continuationMarkerComment;
  const cancelWorkflowContinuationPending = continuation.cancelPending;
  const consumeCancelledWorkflowContinuationPrompt = continuation.consumeCancelledPrompt;
  const consumeStaleWorkflowSteerPrompt = continuation.consumeStaleSteerPrompt;
  const clearPendingWorkflowSteersExceptCurrent = continuation.clearSteersExceptCurrent;
  const clearPendingWorkflowSteersForPhase = continuation.clearSteersForPhase;
  const markWorkflowContinuationDelivered = continuation.markDelivered;
  const steerLlm = continuation.steerLlm;

  async function queueWorkflowContinuation(_piApi: ExtensionAPI, ctx: any, workflow: WorkflowInstance | null, transitions: Array<{ from: WorkflowPhase; to: WorkflowPhase }> | undefined): Promise<void> {
    return continuation.queue(ctx, workflow, transitions);
  }

  const SKIPPABLE_WORKFLOW_GATES = ["dpaa", "code-quality", "policy-scan", "interview-ambiguity"] as const;
  type SkippableWorkflowGate = typeof SKIPPABLE_WORKFLOW_GATES[number];

  function isSkippableWorkflowGate(value: string): value is SkippableWorkflowGate {
    return (SKIPPABLE_WORKFLOW_GATES as readonly string[]).includes(value);
  }

  const SKIPPABLE_WORKFLOW_GATE_DESCRIPTIONS: Record<SkippableWorkflowGate, string> = {
    "dpaa": "DPAA ambiguity analysis gate (plan_review → implement)",
    "code-quality": "Code quality/test gate (code_review → review_approved)",
    "policy-scan": "Push policy scan gate (commit → push)",
    "interview-ambiguity": "Interview ambiguity scoring gate (interview → plan)",
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
    clearPendingWorkflowSteersForPhase(
      state.workflow?.id,
      gate === "dpaa" ? "plan_review"
        : gate === "code-quality" ? "code_review"
        : gate === "interview-ambiguity" ? "interview"
        : "commit",
    );
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
    state.interviewWizardCompletedToken = null;
    state.interviewAmbiguityScoreToken = null;
    state.policyApprovals = [];
    state.gateFailures = new Map();
  }

  function isGitPushDryRun(cmd: string): boolean {
    return /(?:^|\s)(?:--dry-run|-n)(?:\s|$)/.test(cmd);
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
    // Guard: block push if there are uncommitted changes.
    // This prevents the LLM from being confused by stale steers into skipping the commit step.
    try {
      const gitRoot = getGitRoot();
      if (gitRoot) {
        const { execSync } = require("node:child_process");
        const allLines = execSync("git status --porcelain", { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
        // Only block for staged or modified tracked files; untracked files (??) are not pushed.
        const dirty = allLines.split("\n").filter((l) => l.length >= 2 && l.slice(0, 2) !== "??").join("\n").trim();
        if (dirty) {
          ctx.ui.notify(
            [
              "Push blocked: uncommitted changes exist.",
              "Run git add + git commit before pushing.",
              "",
              dirty.split("\n").slice(0, 5).join("\n"),
            ].join("\n"),
            "warning",
          );
          return false;
        }
      }
    } catch { /* git unavailable or not a repo — skip the check */ }

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

      const reviewPackageMarkdown = [
        "# Review Package",
        "",
        `Workflow: ${state.workflow.title}`,
        `Workflow ID: ${state.workflow.id}`,
        `Submitted At: ${new Date().toISOString()}`,
        "",
        "## Severity Counts",
        `- Critical: ${critical}`,
        `- Major: ${major}`,
        `- Minor: ${minor}`,
        "",
        "## Main Agent Self-Review",
        String(params.mainReviewSummary),
        "",
        "## Independent Reviewer / Subagent Review",
        String(params.reviewerReviewSummary),
        "",
        "## Quality Gate Summary",
        String(params.qualityGateSummary),
      ].join("\n");
      let reviewArtifact: ArtifactDescriptor | undefined;
      let reviewArtifactError: string | undefined;
      if (Buffer.byteLength(reviewPackageMarkdown, "utf8") > DEFAULT_INLINE_ARTIFACT_THRESHOLD_BYTES) {
        const artifactPath = path.join(process.cwd(), ".ai", "workflow-artifacts", state.workflow.id, `review-package-${Date.now()}.md`);
        try {
          reviewArtifact = writeTextArtifact({
            filePath: artifactPath,
            content: reviewPackageMarkdown,
            kind: "review",
            producer: { system: "harness", component: "submit_review_package" },
            retention: "until-completion",
            summary: `Review package accepted: Critical=${critical}, Major=${major}, Minor=${minor}.`,
          });
        } catch (error) {
          reviewArtifactError = error instanceof Error ? error.message : String(error);
        }
      }

      const reviewArtifactReference = reviewArtifact
        ? `Stored in review artifact: ${path.relative(process.cwd(), reviewArtifact.path)} (sha256=${reviewArtifact.sha256})`
        : null;

      cancelWorkflowContinuationPending();
      state.reviewPackageToken = {
        workflowId: state.workflow.id,
        timestamp: Date.now(),
        critical,
        major,
        minor,
        mainSummary: reviewArtifactReference ?? String(params.mainReviewSummary),
        reviewerSummary: reviewArtifactReference ?? String(params.reviewerReviewSummary),
        qualitySummary: reviewArtifactReference ?? String(params.qualityGateSummary),
        reviewArtifact,
        reviewArtifactError,
      };
      persistGuardToken(HARNESS_TOKEN_TYPES.REVIEW_PACKAGE, state.reviewPackageToken as unknown as Record<string, unknown>);

      const result = await advanceWorkflow(state.workflow, "automated_review_package");
      const notices: string[] = [
        `Review package accepted: Critical=${critical}, Major=${major}, Minor=${minor}.`,
      ];
      if (reviewArtifact) {
        notices.push(`Review package artifact: ${path.relative(process.cwd(), reviewArtifact.path)} (${reviewArtifact.sizeBytes} bytes, sha256=${reviewArtifact.sha256.slice(0, 12)}…)`);
      } else if (reviewArtifactError) {
        notices.push(`Review package artifact warning: descriptor write failed (${reviewArtifactError}). Review evidence was still recorded in the guard token.`);
      }
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
      return { content: [{ type: "text", text: notices.join("\n") }], details: { ok: result.ok, critical, major, minor, workflowPhase: state.workflow.phase, reviewArtifact, reviewArtifactError } };
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
      args: Type.Optional(Type.Array(Type.String(), { description: "Extra arguments for commands with allowUserArgs (e.g. git-commit: ['-m', 'message']). Passed to execFileSync — no shell interpolation." })),
      reason: Type.Optional(Type.String({ description: "Why this command is being run (for audit log)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const userArgs = Array.isArray(params.args) ? (params.args as string[]).map(String) : [];
      return executeWorkflowCatalogCommand(state, params.commandId, ctx, userArgs);
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
    description: "Move the workflow one step forward or backward. Backward transitions from review phases (code_review → implement, plan_review → plan) require no user approval. For normal forward advancement, use workflow_approve.",
    promptSnippet: "Move workflow phase one step; review-phase backward transitions are automatic",
    promptGuidelines: [
      "Use workflow_state with direction: 'prev' to return to a previous phase when issues are found during review (e.g. code_review → implement, plan_review → plan). No user approval required for these backward transitions.",
      "For normal forward phase advancement, use workflow_approve instead.",
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

      const currentPhase = state.workflow.phase;
      const phases = sharedWorkflowPhases();
      const idx = phases.indexOf(currentPhase);
      const targetIdx = params.direction === "next" ? idx + 1 : idx - 1;
      if (targetIdx < 0 || targetIdx >= phases.length) {
        return { content: [{ type: "text", text: `Cannot move ${params.direction} from '${currentPhase}'.` }], details: { ok: false } };
      }
      const targetPhase = phases[targetIdx];

      // Backward transitions from review phases are autonomous corrections — no user approval needed.
      // code_review → implement: LLM found issues in review, returning to fix.
      // plan_review → plan: LLM found plan ambiguity, returning to revise.
      const REVIEW_BACK_PHASES: WorkflowPhase[] = ["code_review", "plan_review"];
      const isAutoBack = params.direction === "prev" && REVIEW_BACK_PHASES.includes(currentPhase);

      if (!isAutoBack) {
        if (!ctx.hasUI) {
          return { content: [{ type: "text", text: "UI required for manual phase recovery." }], details: { ok: false } };
        }
        const confirmed = await ctx.ui.confirm(
          `수동 복구: '${currentPhase}' → '${targetPhase}'

사유: ${params.reason}

진행할까요?`,
        );
        if (!confirmed) {
          return { content: [{ type: "text", text: "Cancelled." }], details: { ok: false, reason: "user-declined" } };
        }
      }

      // Clear stale gate state so the LLM doesn't see "N consecutive failures" after returning to fix.
      if (isAutoBack) {
        if (currentPhase === "code_review") {
          state.reviewPackageToken = null;
          state.codeQualityGuardSatisfiedToken = null;
          state.gateFailures.delete("code-quality");
        } else if (currentPhase === "plan_review") {
          state.dpaaGuardSatisfiedToken = null;
          state.gateFailures.delete("dpaa");
        }
        cancelWorkflowContinuationPending();
      }

      const transitionReason = isAutoBack ? `review-back: ${params.reason}` : `manual-recovery: ${params.reason}`;
      transitionWorkflow(state.workflow, targetPhase, transitionReason);
      applyPhaseToolPolicy(targetPhase);
      refreshBoard(ctx);
      refreshStatus(ctx);

      // Build kick-off text in the tool result — NOT via sendUserMessage (steerLlm).
      // A follow-up steer can arrive after the phase has advanced, bypassing the
      // onUserPrompt stale-marker check and replaying a stale [LLM WORKFLOW ACTION].
      const kickOff = isAutoBack
        ? (currentPhase === "code_review"
            ? [
                `🔁 code_review → implement 돌아옴: ${params.reason}`,
                "",
                "수정 루프 행동:",
                "1. 리뷰 사유에서 제시된 문제를 수정하세요.",
                "2. 수정 완료 후 workflow_approve 호출 → code_review 에 재진입합니다.",
                "3. 리뷰 통과(Critical=0, Major≤2) 시 submit_review_package 호출합니다.",
                "",
                formatWorkflowAction(state.workflow),
              ].join("\n")
            : [
                `🔁 plan_review → plan 돌아옴: ${params.reason}`,
                "",
                "수정 루프 행동:",
                "1. DPAA 실패 이유를 바탕으로 계획 아티팩트를 수정하세요.",
                "2. 수정 완료 후 workflow_approve 호출 → plan_review 에 재진입합니다.",
                "3. DPAA 통과 시 implement 단계로 자동 진행됩니다.",
                "",
                formatWorkflowAction(state.workflow),
              ].join("\n"))
        : null;

      return {
        content: [{ type: "text", text: kickOff ?? `워크플로우 복구 완료: '${currentPhase}' → '${targetPhase}'

${formatWorkflowAction(state.workflow)}` }],
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
      "Call this at the start of the interview phase with the baseline questions tailored to the workflow goal.",
      "The tool automatically wraps those questions with deep-interview-lite topology confirmation and clarity checkpoint questions.",
      "The tool blocks until the user completes or cancels the wizard, then returns the collected answers and next-step interview guidance.",
    ].join(" "),
    promptSnippet: "Collect deep-interview-lite answers via interactive TUI wizard",
    promptGuidelines: [
      "Call workflow_interview_wizard immediately when an interview phase starts. Generate 5 baseline questions (scope, motivation, acceptance criteria, affected files/modules, constraints/risks) with domain-specific choices for the workflow goal. The wizard adds Round 0 topology confirmation and clarity checkpoint questions automatically.",
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
        { description: "Exactly 5 baseline interview questions tailored to the workflow goal. The runtime adds topology and clarity-checkpoint questions." },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.workflow || state.workflow.phase !== "interview") {
        return {
          content: [{ type: "text", text: "workflow_interview_wizard can only be called during the interview phase." }],
          details: { ok: false },
        };
      }
      const questions = buildDeepInterviewLiteQuestions(state.workflow.title, params.questions);
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
      state.interviewWizardCompletedToken = { workflowId: state.workflow.id, completedAt: Date.now() };
      return {
        content: [{ type: "text", text: buildInterviewWizardCompletion(result.summaryMarkdown) }],
        details: { ok: true, answers: result.answers, summaryMarkdown: result.summaryMarkdown, mode: "deep-interview-lite" },
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
        return resultBox(theme, "success",
          theme.fg("success", "✅ 인터뷰 wizard 완료") +
          theme.fg("warning", " — 다음: workflow_score_interview 호출 필수 (5개 차원 점수 0-100)"));
      }
      if (d?.cancelled) {
        return resultBox(theme, "warning", theme.fg("warning", "⚠️ 사용자가 wizard를 취소했습니다"));
      }
      return resultBox(theme, "error", theme.fg("error", "❌ interview wizard 실패"));
    },
  });

  // ── Tool: workflow_score_interview — LLM records per-dimension ambiguity scores ──
  pi.registerTool({
    name: "workflow_score_interview",
    label: "Score Interview",
    description: [
      "Record per-dimension clarity scores for the completed interview.",
      "Call this after workflow_interview_wizard completes to evaluate the answer quality.",
      "Scores gate the interview → plan transition: any dimension < 60 blocks plan progression.",
      "If any dimension is low, run workflow_interview_wizard again with follow-up questions targeting those dimensions, then re-score.",
    ].join(" "),
    promptSnippet: "Record interview clarity scores and gate plan progression",
    promptGuidelines: [
      "Call workflow_score_interview immediately after workflow_interview_wizard completes. Score each dimension honestly 0-100. If any score < 60, run a follow-up wizard round for those dimensions before re-scoring. Include the score table in your chat response.",
    ],
    parameters: Type.Object({
      goal: Type.Number({ description: "Goal/problem clarity score 0-100", minimum: 0, maximum: 100 }),
      scope: Type.Number({ description: "Scope/out-of-scope clarity score 0-100", minimum: 0, maximum: 100 }),
      acceptance: Type.Number({ description: "Acceptance criteria clarity score 0-100", minimum: 0, maximum: 100 }),
      constraints: Type.Number({ description: "Constraints/risks clarity score 0-100", minimum: 0, maximum: 100 }),
      context: Type.Number({ description: "Existing code/system context clarity score 0-100", minimum: 0, maximum: 100 }),
      reasoning: Type.Optional(Type.String({ description: "Brief reasoning for low scores or notable gaps" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!state.workflow || state.workflow.phase !== "interview") {
        return {
          content: [{ type: "text", text: "workflow_score_interview can only be called during the interview phase." }],
          details: { ok: false },
        };
      }

      const { goal, scope, acceptance, constraints, context, reasoning } = params;
      const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
      const scores = {
        goal: clamp(goal),
        scope: clamp(scope),
        acceptance: clamp(acceptance),
        constraints: clamp(constraints),
        context: clamp(context),
      };

      const THRESHOLD = 60;
      const dims: Array<[string, number]> = Object.entries(scores) as Array<[string, number]>;
      const failing = dims.filter(([, score]) => score < THRESHOLD);

      state.interviewAmbiguityScoreToken = {
        workflowId: state.workflow.id,
        issuedAt: Date.now(),
        ...scores,
        ...(reasoning ? { reasoning } : {}),
      };

      const scoreTable = [
        "| Dimension    | Score | Status |",
        "|-------------|-------|--------|",
        ...dims.map(([name, score]) =>
          `| ${name.padEnd(12)} | ${String(score).padStart(3)}/100 | ${score >= THRESHOLD ? "✅ pass" : "❌ low"} |`,
        ),
      ].join("\n");

      if (failing.length === 0) {
        return {
          content: [{ type: "text", text: [
            "✅ Interview ambiguity gate: all dimensions passed.",
            "",
            scoreTable,
            "",
            "You may now proceed to plan. Call workflow_approve when ready.",
          ].join("\n") }],
          details: { ok: true, scores, passed: true },
        };
      }

      const failingNames = failing.map(([name]) => name).join(", ");
      return {
        content: [{ type: "text", text: [
          `⚠️ Interview ambiguity gate: ${failing.length} dimension(s) below threshold (${THRESHOLD}).`,
          "",
          scoreTable,
          "",
          `Low-score dimensions: ${failingNames}`,
          "",
          "Action required:",
          "1. Call workflow_interview_wizard again with follow-up questions targeting the low-score dimensions.",
          "2. After the follow-up wizard, call workflow_score_interview again with updated scores.",
          "3. Repeat until all dimensions reach 60 or above (max 2 additional rounds).",
          ...(reasoning ? ["", `Reasoning: ${reasoning}`] : []),
        ].join("\n") }],
        details: { ok: true, scores, passed: false, failing: failing.map(([name]) => name) },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("📊 score_interview ")) +
        theme.fg("dim", "인터뷰 명확성 점수 기록 중…"),
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) return resultBox(theme, "pending", theme.fg("warning", "점수 기록 중…"));
      const d = result.details as Record<string, unknown>;
      if (!d?.ok) return resultBox(theme, "error", theme.fg("error", "❌ 점수 기록 실패 (interview 단계에서만 호출 가능)"));
      if (d?.passed) return resultBox(theme, "success", theme.fg("success", "✅ 인터뷰 명확성 점수 통과"));
      const failing = Array.isArray(d?.failing) ? (d.failing as string[]).join(", ") : "";
      return resultBox(theme, "warning", theme.fg("warning", `⚠️ 낮은 차원: ${failing} — 후속 wizard 라운드 필요`));
    },
  });

  registerWorkflowCommand(pi, {
    state,
    cancelWorkflowContinuationPending,
    workflowContinuationMarker,
    workflowContinuationMarkerComment,
    precheckPlanReviewBeforeApproval,
    confirmPushPolicyForPushPhase,
    queueWorkflowContinuation,
    clearPendingWorkflowSteersExceptCurrent,
    clearPendingWorkflowSteersForPhase,
    applyPhaseToolPolicy,
    refreshBoard,
    refreshStatus,
    persistGuardToken,
    clearActiveWorkflowAfterCompletion,
    formatGuardMemoryStatus,
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

  // ── Gate: tool_call → workflow policy pipeline ───────────────────────────
  pi.on("tool_call", async (event, ctx) => handleWorkflowToolCall(state, event, ctx, { steerLlm }));

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
    return formatGuardMemoryStatusForState(state);
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
    return { systemPrompt: event.systemPrompt + buildWorkflowSystemPromptInjection(state) };
  });
}
