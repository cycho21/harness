import type { ArtifactDescriptor } from "./artifact-descriptor";
import type { EditScope, WorkflowInstance, WorkflowPhase, WorkflowGate } from "./types";

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
  interviewWizardCompletedToken: { workflowId: string; completedAt: number } | null;
  interviewAmbiguityScoreToken: {
    workflowId: string;
    issuedAt: number;
    goal: number;
    scope: number;
    acceptance: number;
    constraints: number;
    context: number;
    reasoning?: string;
  } | null;
  policyApprovals: Array<{ timestamp: number; totalChanged: number; categories: string[]; signature: string }>;
  extensionMutationApprovedForWorkflowId: string | null;
  autoCheckpointForSession: boolean;
  gateFailures: Map<WorkflowGate, number>;
  lastInputCheckpointSignature: string | null;
  recentVerificationCommands: Array<{ command: string; timestamp: number; phase?: string }>;
  reviewPackageToken: null | {
    workflowId: string;
    timestamp: number;
    critical: number;
    major: number;
    minor: number;
    mainSummary: string;
    reviewerSummary: string;
    qualitySummary: string;
    reviewedFiles?: string[];
    skippedFiles?: Array<{ path: string; reason: string }>;
    positionValidation?: string;
    reviewArtifact?: ArtifactDescriptor;
    reviewArtifactError?: string;
  };
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
    interviewWizardCompletedToken: null,
    interviewAmbiguityScoreToken: null,
    policyApprovals: [],
    extensionMutationApprovedForWorkflowId: null,
    autoCheckpointForSession: false,
    gateFailures: new Map<WorkflowGate, number>(),
    lastInputCheckpointSignature: null,
    recentVerificationCommands: [],
    reviewPackageToken: null,
    workflowContinuationPending: null,
    pendingSteerMessages: new Map<string, WorkflowSteerMessage>(),
    cancelledWorkflowContinuationMarkers: new Set<string>(),
    activeEditScope: null,
  };
}
