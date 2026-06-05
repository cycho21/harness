import type { EditScope, WorkflowInstance, WorkflowPhase } from "./types";

export type WorkflowContinuationPending = {
  workflowId: string;
  phase: WorkflowPhase;
  marker: string;
};

export type WorkflowSteerMessage = {
  workflowId: string;
  phase: WorkflowPhase;
  marker: string;
  issuedAt: number;
};

export type WorkflowRuntimeState = {
  codeReviewGuardSatisfiedToken: {
    critical: number;
    major: number;
    minor: number;
    timestamp: number;
  } | null;
  workflow: WorkflowInstance | null;
  dpaaGuardSatisfiedToken: { workflowId: string; issuedAt: number; reason: string; planSha256?: string } | null;
  codeQualityGuardSatisfiedToken: { workflowId: string; issuedAt: number; reason: string } | null;
  pushExecutionGuardSatisfiedToken: { workflowId: string; issuedAt: number; reason: string } | null;
  policyApprovals: Array<{ timestamp: number; totalChanged: number; categories: string[]; signature: string }>;
  extensionMutationApprovedForWorkflowId: string | null;
  autoCheckpointForSession: boolean;
  gateFailures: Map<string, number>;
  lastInputCheckpointSignature: string | null;
  recentVerificationCommands: Array<{ command: string; timestamp: number; phase?: string }>;
  reviewPackageToken: null | { workflowId: string; timestamp: number; critical: number; major: number; minor: number; mainSummary: string; reviewerSummary: string; qualitySummary: string };
  workflowContinuationPending: WorkflowContinuationPending | null;
  pendingSteerMessages: Map<string, WorkflowSteerMessage>;
  cancelledWorkflowContinuationMarkers: Set<string>;
  activeEditScope: EditScope | null;
};

export const HARNESS_TOKEN_TYPES = {
  DPAA:           "harness-dpaa-token",
  CODE_QUALITY:   "harness-code-quality-token",
  CODE_REVIEW:    "harness-code-review-token",
  PUSH_EXECUTION: "harness-push-token",
  REVIEW_PACKAGE: "harness-review-package-token",
} as const;

export function createWorkflowRuntimeState(): WorkflowRuntimeState {
  return {
    codeReviewGuardSatisfiedToken: null,
    workflow: null,
    dpaaGuardSatisfiedToken: null,
    codeQualityGuardSatisfiedToken: null,
    pushExecutionGuardSatisfiedToken: null,
    policyApprovals: [],
    extensionMutationApprovedForWorkflowId: null,
    autoCheckpointForSession: false,
    gateFailures: new Map<string, number>(),
    lastInputCheckpointSignature: null,
    recentVerificationCommands: [],
    reviewPackageToken: null,
    workflowContinuationPending: null,
    pendingSteerMessages: new Map<string, WorkflowSteerMessage>(),
    cancelledWorkflowContinuationMarkers: new Set<string>(),
    activeEditScope: null,
  };
}

export function saveGuardTokensToWorkflowState(state: WorkflowRuntimeState, workflow: WorkflowInstance, save: (workflow: WorkflowInstance) => void): void {
  workflow.guardTokens = {
    dpaa: state.dpaaGuardSatisfiedToken ?? null,
    codeQuality: state.codeQualityGuardSatisfiedToken ?? null,
    codeReview: state.codeReviewGuardSatisfiedToken
      ? { ...state.codeReviewGuardSatisfiedToken, workflowId: workflow.id }
      : null,
    pushExecution: state.pushExecutionGuardSatisfiedToken ?? null,
  };
  save(workflow);
}

export function isWorkflowToken(d: Record<string, unknown>): d is { workflowId: string; issuedAt: number; reason: string } {
  return typeof d.workflowId === "string" && typeof d.issuedAt === "number" && typeof d.reason === "string";
}

export function isCodeReviewToken(d: Record<string, unknown>): d is { workflowId: string; critical: number; major: number; minor: number; timestamp: number } {
  return typeof d.workflowId === "string" && typeof d.critical === "number" && typeof d.major === "number" && typeof d.minor === "number" && typeof d.timestamp === "number";
}

export function isReviewPackageToken(d: Record<string, unknown>): d is { workflowId: string; timestamp: number; critical: number; major: number; minor: number; mainSummary: string; reviewerSummary: string; qualitySummary: string } {
  return typeof d.workflowId === "string" && typeof d.timestamp === "number" && typeof d.critical === "number" && typeof d.major === "number" && typeof d.minor === "number";
}

export function restoreGuardTokensToRuntimeState(state: WorkflowRuntimeState, entries: readonly { type: string; customType?: string; data?: unknown }[]): void {
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
