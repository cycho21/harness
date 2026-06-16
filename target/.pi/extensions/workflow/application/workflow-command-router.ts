import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

import {
  addSkipToken,
  advanceWorkflow,
  clearPersistedWorkflow,
  createArtifactSnapshot,
  createWorkflow,
  formatArtifactSnapshotCreated,
  exportFieldLogs,
  formatHarnessDoctor,
  formatLatestActionableFailureHint,
  formatLatestDpaaAudit,
  formatRecentFieldLogs,
  formatWorkflowPrerequisiteScan,
  formatWorkflowHistory,
  formatWorkflowAction,
  formatWorkflowStatus,
  formatWorkspaceMismatch,
  getNextPhase,
  loadPersistedWorkflow,
  saveWorkflow,
  scanWorkflowPrerequisites,
  validateWorkflowWorkspace,
  transitionWorkflow,
  isSharedWorkflowPhase,
  sharedWorkflowPhases,
  isSharedApprovalBoundary,
  type WorkflowInstance,
  type WorkflowPhase,
} from "../core";
import { writeAuditLogEvent, writeFieldLogEvent } from "../field-log";
import {
  createManualWorkspaceCheckpoint,
  formatManualWorkspaceCheckpoints,
  redoManualWorkflowCheckpoint,
  restoreManualWorkspaceCheckpoint,
  undoManualWorkflowCheckpoint,
} from "../checkpoint-commands";
import { formatWorkflowToolsListing } from "../command-policy";
import { HARNESS_TOKEN_TYPES, type WorkflowRuntimeState } from "../runtime-state";

export type WorkflowCommandRouterDeps = {
  state: WorkflowRuntimeState;
  cancelWorkflowContinuationPending: () => void;
  workflowContinuationMarker: (workflow: WorkflowInstance) => string;
  workflowContinuationMarkerComment: (marker: string) => string;
  precheckPlanReviewBeforeApproval: (ctx: any) => Promise<{ ok: true } | { ok: false; text: string }>;
  confirmPushPolicyForPushPhase: (ctx: any) => Promise<boolean>;
  queueWorkflowContinuation: (
    piApi: ExtensionAPI,
    ctx: any,
    workflow: WorkflowInstance | null,
    transitions: Array<{ from: WorkflowPhase; to: WorkflowPhase }> | undefined,
  ) => Promise<void>;
  clearPendingWorkflowSteersExceptCurrent: () => void;
  clearPendingWorkflowSteersForPhase: (workflowId: string | null | undefined, phase: WorkflowPhase) => void;
  applyPhaseToolPolicy: (phase: WorkflowPhase | null) => void;
  refreshBoard: (ctx: any) => void;
  refreshStatus: (ctx: any) => void;
  persistGuardToken: (type: string, data: Record<string, unknown>) => void;
  clearActiveWorkflowAfterCompletion: () => void;
  formatGuardMemoryStatus: () => string;
};

export type WorkflowCommandRequest = {
  command: string;
  rest: string[];
};

export function parseWorkflowCommand(input: string): WorkflowCommandRequest {
  const [command = "status", ...rest] = input.trim().split(/\s+/).filter(Boolean);
  return { command, rest };
}

function fieldLogCategoryForGate(gate: string): "dpaa" | "code-quality" | "push-policy" | "interview-ambiguity" | "workspace" {
  if (gate === "policy-scan") return "push-policy";
  if (gate === "code-quality") return "code-quality";
  if (gate === "dpaa") return "dpaa";
  if (gate === "interview-ambiguity") return "interview-ambiguity";
  return "workspace";
}

function formatConditionalProtocolHints(state: WorkflowRuntimeState): string {
  const workflow = state.workflow;
  if (!workflow) return "";

  const hints: string[] = [];
  const workspace = validateWorkflowWorkspace(workflow);
  if (!workspace.ok) {
    hints.push("- workspace mismatch → use continuation-safety before mutating; use worktree-safety if a worktree is involved.");
  }

  const failedGates = Array.from(state.gateFailures.entries()).filter(([, count]) => count > 0);
  if (failedGates.length > 0) {
    hints.push(`- guard failure(s): ${failedGates.map(([gate, count]) => `${gate}×${count}`).join(", ")} → use continuation-safety before retrying.`);
  }

  if ((state.gateFailures.get("dpaa") ?? 0) >= 2) {
    hints.push("- repeated DPAA/SBADR failure → use trace before more plan rewrites.");
  }

  if (workflow.phase === "commit" && state.recentVerificationCommands.length === 0) {
    hints.push("- no recent verification evidence → use evidence-verification before committing.");
  }

  if (state.reviewPackageToken?.reviewArtifactError) {
    hints.push("- review artifact write failed → use evidence-verification to cite the guard token and preserve review evidence before commit.");
  }

  const latestActionableFailure = formatLatestActionableFailureHint(20, {
    activeGateFailures: failedGates.map(([gate]) => fieldLogCategoryForGate(gate)),
  });
  if (latestActionableFailure) hints.push(latestActionableFailure);

  if (workflow.history.length >= 8) {
    hints.push("- long workflow history → use compact-handoff before manual context compaction.");
  }

  if (hints.length === 0) return "";
  return ["Conditional protocol hints (triggered only):", ...hints].join("\n");
}

export function registerWorkflowCommand(pi: ExtensionAPI, deps: WorkflowCommandRouterDeps): void {
  const {
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
  } = deps;

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
      trace: "trace <observation> — evidence-driven causal analysis before fixing",
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
    const { command, rest } = parseWorkflowCommand(args);

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

    if (command === "trace") {
      const observation = rest.join(" ").trim();
      if (!observation) {
        ctx.ui.notify("사용법: /workflow trace <관찰된 실패/이상 동작>", "warning");
        return;
      }
      if (typeof (pi as any).sendUserMessage !== "function") {
        ctx.ui.notify("이 Pi runtime은 trace kickoff 메시지 전송을 지원하지 않습니다.", "warning");
        return;
      }
      const workflowContext = state.workflow
        ? [`Active workflow: [${state.workflow.phase}] ${state.workflow.title}`, `Branch: ${state.workflow.branch}`, `CWD: ${state.workflow.cwd}`].join("\n")
        : "No active workflow.";
      await (pi as any).sendUserMessage([
        "Run the harness trace protocol before proposing or implementing a fix.",
        "",
        "Use Skill(\"trace\") if available, or follow `target/.pi/skills/trace/SKILL.md` exactly.",
        "",
        "Observation:",
        observation,
        "",
        "Workflow context:",
        workflowContext,
        "",
        "Required output: Observation, Ranked Hypotheses, Evidence For/Against, Rebuttal Round, Current Best Explanation, Critical Unknown, and one Discriminating Probe. Do not edit files during trace unless the user explicitly asks to proceed after the trace.",
      ].join("\n"));
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
      state.interviewAmbiguityScoreToken = null;
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
          "- Call workflow_interview_wizard first. Generate 5 baseline questions tailored to the workflow goal (scope · motivation · acceptance criteria · affected files/modules · constraints/risks). The wizard automatically adds Round 0 topology confirmation and a clarity checkpoint.",
          "- After the wizard returns answers, treat the topology answer as required spec/plan coverage and ask focused follow-up questions for the weakest remaining clarity dimension.",
          "- For brownfield work, inspect narrow repo evidence before asking direction questions about codebase facts.",
          "- Do not advance to plan until requirements are sufficiently understood and no clarity dimension remains low unless the user accepts the risk.",
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
        writeAuditLogEvent({
          eventType: "approval_boundary_anomaly",
          workflow: state.workflow,
          phase: state.workflow?.phase,
          fromPhase: state.workflow?.phase,
          toPhase: nextPhase,
          gate: "dpaa",
          result: "precheck_blocked_before_dialog",
          severity: "warning",
          reasonSummary: "Implementation approval dialog was not shown because the slash-command DPAA precheck blocked first.",
        });
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
        if (result.gate) {
          state.gateFailures.set(result.gate, (state.gateFailures.get(result.gate) ?? 0) + 1);
        }
        refreshBoard(ctx);
        refreshStatus(ctx);
        ctx.ui.notify(["게이트가 워크플로우 전환을 차단했습니다. 근본 원인을 해결한 후 /workflow approve를 다시 실행하세요.", "Default handling: do not ask the user for a skip first. Fix the underlying cause within the current phase when possible, then retry the workflow transition. Ask the user only for product/architecture input, an approval boundary, or an accepted-risk exception.", "", result.message, "", formatWorkflowAction(state.workflow)].join("\n"), "warning");
        return;
      }
      const transitions = result.transitions ?? [];
      transitions.forEach((t) => {
        writeAuditLogEvent({
          eventType: "transition",
          workflowId,
          fromPhase: t.from,
          toPhase: t.to,
          phase: t.to,
          result: "success",
          severity: "info",
          reasonSummary: `Workflow transition ${t.from} -> ${t.to}`,
        });
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
      const VALID_GATES = ["dpaa", "code-quality", "policy-scan", "interview-ambiguity"] as const;
      const GATE_DESC: Record<string, string> = {
        "dpaa": "DPAA 모호성 분석 gate (plan_review → implement 전환 시 실행)",
        "code-quality": "Checkstyle/PMD/테스트 gate (code_review → review_approved 전환 시 실행)",
        "policy-scan": "push 전 위험 변경 파일 scan gate",
        "interview-ambiguity": "인터뷰 모호성 점수 gate (interview → plan 전환 시 실행)",
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
        category: fieldLogCategoryForGate(gate),
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
        const protocolHints = formatConditionalProtocolHints(state);
        ctx.ui.notify([
          formatWorkflowStatus(state.workflow),
          "",
          formatGuardMemoryStatus(),
          ...(protocolHints ? ["", protocolHints] : []),
          "",
          formatWorkflowAction(state.workflow),
        ].join("\n"), "info");
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

    const protocolHints = formatConditionalProtocolHints(state);
    ctx.ui.notify([
      formatWorkflowStatus(state.workflow),
      "",
      formatGuardMemoryStatus(),
      ...(protocolHints ? ["", protocolHints] : []),
      "",
      formatWorkflowAction(state.workflow),
    ].join("\n"), "info");
  },
});

}
