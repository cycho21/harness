import {
  advanceWorkflow,
  getCatalogCommand,
  getGitRoot,
  getNextPhase,
  getUntestedClasses,
  isSharedApprovalBoundary,
  runCatalogCommand,
  runPreTransitionGate,
  saveWorkflow,
  type WorkflowInstance,
  type WorkflowPhase,
} from "./core";
import { HARNESS_TOKEN_TYPES } from "./runtime-state";
import { formatWorkflowAction } from "./format";
import { formatWorkflowGateBlockedMessage } from "./gate-runner";

export type WorkflowApprovalState = {
  workflow: WorkflowInstance | null;
  dpaaGuardSatisfiedToken: any;
  reviewPackageToken: any;
  codeQualityGuardSatisfiedToken: any;
  codeReviewGuardSatisfiedToken: any;
  pushExecutionGuardSatisfiedToken: any;
  recentVerificationCommands: Array<{ command: string; timestamp: number; phase?: WorkflowPhase }>;
  gateFailures: Map<string, number>;
};

export type WorkflowApprovalDeps = {
  precheckPlanReviewBeforeApproval: (ctx: any) => Promise<{ ok: true } | { ok: false; text: string }>;
  confirmPushPolicyForPushPhase: (ctx: any) => Promise<boolean>;
  steerLlm: (message: string, deliverAs?: "followUp" | "steer") => Promise<void>;
  refreshBoard: (ctx: any) => void;
  refreshStatus: (ctx: any) => void;
  persistGuardToken: (type: string, data: Record<string, unknown>) => void;
  clearPendingWorkflowSteersForPhase: (workflowId: string | null | undefined, phase: WorkflowPhase) => void;
  clearPendingWorkflowSteersExceptCurrent: () => void;
  clearActiveWorkflowAfterCompletion: () => void;
  applyPhaseToolPolicy: (phase: WorkflowPhase | null) => void;
};

export async function precheckPlanReviewBeforeApproval(
  state: WorkflowApprovalState,
  ctx: any,
  returnToPlanAfterDpaaBlock: (ctx: any, message: string) => Promise<string>,
): Promise<{ ok: true } | { ok: false; text: string }> {
  if (!state.workflow || state.workflow.phase !== "plan_review") return { ok: true };
  if (state.dpaaGuardSatisfiedToken?.workflowId === state.workflow.id && state.dpaaGuardSatisfiedToken.reason === "skip-preapproved") return { ok: true };
  const result = await runPreTransitionGate(state.workflow, "plan_review", "implement", { approvedPlanSha256: state.dpaaGuardSatisfiedToken?.planSha256 });
  if (result.ok) return { ok: true };
  if (result.gate === "dpaa") {
    return { ok: false, text: await returnToPlanAfterDpaaBlock(ctx, result.message) };
  }
  return { ok: false, text: result.message };
}

export async function executeWorkflowApproval(
  state: WorkflowApprovalState,
  summary: string,
  ctx: any,
  deps: WorkflowApprovalDeps,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  if (!state.workflow) {
    return { content: [{ type: "text", text: "No active workflow. Start one with /workflow start." }], details: { ok: false } };
  }
  const nextPhase = getNextPhase(state.workflow.phase);
  const requiresUserApproval = Boolean(nextPhase && isSharedApprovalBoundary(state.workflow.phase, nextPhase));
  if (!ctx.hasUI && requiresUserApproval) {
    return { content: [{ type: "text", text: "Interactive UI is required for this approval boundary. Re-run from a UI session so the yes/no dialog can be shown." }], details: { ok: false, reason: "no-ui" } };
  }

  const planReviewPrecheck = await deps.precheckPlanReviewBeforeApproval(ctx);
  if (!planReviewPrecheck.ok) {
    return { content: [{ type: "text", text: planReviewPrecheck.text }], details: { ok: false, reason: "dpaa-precheck-failed" } };
  }

  if (state.workflow.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
    return {
      content: [{ type: "text", text: "⚠️ submit_review_package를 먼저 호출해야 합니다. 자기 리뷰, 독립 리뷰어 리뷰, quality gate를 완료한 후 submit_review_package를 호출하세요." }],
      details: { ok: false, reason: "review-package-required" },
    };
  }

  if (state.workflow.phase === "commit") {
    if (!(await deps.confirmPushPolicyForPushPhase(ctx))) {
      return { content: [{ type: "text", text: "Push policy 확인이 거부됐습니다. Push 단계 진입이 취소됩니다." }], details: { ok: false, reason: "policy-declined" } };
    }
  } else if (requiresUserApproval) {
    const confirmed = await ctx.ui.confirm(
      summary,
      `[${state.workflow.phase}] → [${nextPhase ?? "done"}]\n\n다음 단계로 진행할까요?`,
    );
    if (!confirmed) {
      return { content: [{ type: "text", text: "취소됐습니다. 현재 단계를 유지합니다." }], details: { ok: false, reason: "user-declined" } };
    }
  }

  const workflowId = state.workflow.id;

  if (state.workflow.phase === "implement") {
    const tddRoot = state.workflow.gitRoot ?? getGitRoot();
    const snapshot = state.workflow.untestedClassesSnapshot;
    if (tddRoot && snapshot) {
      const currentUntested = getUntestedClasses(tddRoot);
      const newlyUntested = currentUntested.filter((cls) => !snapshot.includes(cls));
      if (newlyUntested.length > 0) {
        await deps.steerLlm(
          `🧪 TDD 미준수 필요 — implement 중 테스트 없는 클래스가 생겼습니다. 테스트 작성 후 workflow_approve를 다시 호출하세요.\n\n` +
          newlyUntested.map((c) => `- ${c}`).join("\n"),
        );
        return {
          content: [{ type: "text", text: `TDD 미준수 (${newlyUntested.length}개 클래스). 테스트를 먼저 작성하세요.` }],
          details: { ok: false, reason: "tdd-violation", classes: newlyUntested },
        };
      }
    }
  }

  if (state.workflow.phase === "implement") {
    const gitRoot = state.workflow.gitRoot ?? getGitRoot();
    const qualitySpec = getCatalogCommand("code-quality");
    if (qualitySpec && gitRoot) {
      const qualityResult = runCatalogCommand(qualitySpec, gitRoot);
      const isToolingError = !qualityResult.ok && (
        qualityResult.output.includes("No quality command detected") ||
        qualityResult.output.includes("No code-quality command") ||
        qualityResult.exitCode == null
      );
      if (!qualityResult.ok && !isToolingError) {
        const violations = qualityResult.output.split("\n").slice(-60).join("\n").trim();
        await deps.steerLlm(
          `🔧 code_review 진입 전 품질 검사 실패 — 수정 후 workflow_approve를 다시 호출하세요.\n\n${violations}`,
        );
        return {
          content: [{ type: "text", text: "품질 검사 실패. 위반을 수정한 후 다시 시도하세요." }],
          details: { ok: false, reason: "quality-gate-failed" },
        };
      }
    }
  }

  const result = await advanceWorkflow(state.workflow, "user_approved", { approvedPlanSha256: state.dpaaGuardSatisfiedToken?.planSha256 });
  if (!result.ok) {
    if (result.gate) {
      const failures = (state.gateFailures.get(result.gate) ?? 0) + 1;
      state.gateFailures.set(result.gate, failures);
      if (failures >= 3) {
        await deps.steerLlm(
          `⚠️ ${result.gate} gate가 ${failures}번 연속 실패했습니다.\n\n` +
          `현재 접근 방식이 막혀있습니다. 다음을 시도해보세요:\n` +
          `- gate 실패 메시지의 근본 원인을 먼저 분석\n` +
          `- DPAA 실패라면 자연어 문장 수정 반복을 멈추고 files/exports/tests/commands/non-goals 표 기반 contract plan으로 재작성\n` +
          `- 문제를 더 작은 단위로 분해해 각각 해결\n` +
          `- 계획 자체가 문제라면 /workflow undo로 plan 단계로 돌아가 수정\n\n` +
          `Gate 메시지:\n${result.message.slice(0, 500)}`,
        );
      }
    }
    deps.refreshBoard(ctx);
    deps.refreshStatus(ctx);
    return { content: [{ type: "text", text: formatWorkflowGateBlockedMessage(result.message) }], details: { ok: false, reason: "gate-blocked" } };
  }

  const transitions = result.transitions ?? [];
  transitions.forEach((t) => {
    if (t.from === "plan_review" && t.to === "implement") {
      const dpaaTx = transitions.find((tx) => tx.from === "plan_review" && tx.to === "implement");
      state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved", planSha256: dpaaTx?.planSha256 };
      deps.persistGuardToken(HARNESS_TOKEN_TYPES.DPAA, state.dpaaGuardSatisfiedToken as unknown as Record<string, unknown>);
      state.gateFailures.delete("dpaa");
      deps.clearPendingWorkflowSteersForPhase(workflowId, "plan_review");
      const implRoot = state.workflow?.gitRoot ?? getGitRoot();
      if (implRoot && state.workflow) {
        state.workflow.untestedClassesSnapshot = getUntestedClasses(implRoot);
        saveWorkflow(state.workflow);
      }
    }
    if (t.from === "code_review" && t.to === "review_approved") {
      state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "automated_review_passed" };
      state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
      deps.persistGuardToken(HARNESS_TOKEN_TYPES.CODE_QUALITY, state.codeQualityGuardSatisfiedToken as unknown as Record<string, unknown>);
      deps.persistGuardToken(HARNESS_TOKEN_TYPES.CODE_REVIEW, { ...state.codeReviewGuardSatisfiedToken, workflowId });
      state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
      if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
      state.gateFailures.delete("code-quality");
      deps.clearPendingWorkflowSteersForPhase(workflowId, "code_review");
    }
    if (t.from === "commit" && t.to === "push") {
      state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
      deps.persistGuardToken(HARNESS_TOKEN_TYPES.PUSH_EXECUTION, state.pushExecutionGuardSatisfiedToken as unknown as Record<string, unknown>);
    }
  });

  deps.clearPendingWorkflowSteersExceptCurrent();
  const completed = transitions.some((t) => t.to === "done");
  if (completed) {
    deps.clearActiveWorkflowAfterCompletion();
    deps.applyPhaseToolPolicy(null);
  }
  deps.refreshBoard(ctx);
  deps.refreshStatus(ctx);
  return {
    content: [{ type: "text", text: completed ? result.message : result.message + "\n\n" + formatWorkflowAction(state.workflow) }],
    details: { ok: true, transitions: transitions.map((t) => `${t.from} → ${t.to}`), completed },
  };
}
