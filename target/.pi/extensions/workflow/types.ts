export type WorkflowPhase =
  | "interview"
  | "plan"
  | "plan_review"
  | "implement"
  | "code_review"
  | "review_approved"
  | "document"
  | "commit"
  | "push"
  | "done";

export type WorkflowTransition = {
  from: WorkflowPhase;
  to: WorkflowPhase;
  reason: string;
  timestamp: number;
  checkpointBefore?: string;
  checkpointAfter?: string;
};

export type WorkflowInstance = {
  id: string;
  title: string;
  phase: WorkflowPhase;
  cwd: string;
  gitRoot: string | null;
  branch: string;
  history: WorkflowTransition[];
  undone: WorkflowTransition[];
  startedAt: number;
  updatedAt: number;
};

export type DpaaReport = {
  overall: number;
  level: string;
  findings: Array<{
    layer: string;
    rule: string;
    line?: number;
    message: string;
    suggestion: string;
  }>;
};

export type DpaaRunReceipt = {
  timestamp: string;
  workflowId: string;
  from: WorkflowPhase;
  to: WorkflowPhase;
  projectRoot: string;
  planPath: string;
  planSha256: string;
  exitCode: number;
  level: string;
  overall: number;
  findingsCount: number;
  reportSha256: string;
  snapshotVersion?: string;
  snapshotPath?: string;
};

export type ArtifactSnapshot = {
  workflowId: string;
  version: string;
  reason: string;
  source: "manual" | "dpaa" | "review" | "interview" | "escalation";
  createdAt: string;
  previous: string | null;
  path: string;
  specPath?: string;
  planPath?: string;
  specSha256?: string;
  planSha256?: string;
  dpaa?: {
    level: string;
    overall: number;
    findingsCount: number;
    exitCode: number;
    reportSha256: string;
  };
};

export const WORKFLOW_PHASES: WorkflowPhase[] = [
  "interview",
  "plan",
  "plan_review",
  "implement",
  "code_review",
  "review_approved",
  "document",
  "commit",
  "push",
  "done",
];

export const LEGACY_WORKFLOW_PHASE_ALIASES: Record<string, WorkflowPhase> = {
  push_with_review: "push",
};
