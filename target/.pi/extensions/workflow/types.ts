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

export type PersistedGuardTokens = {
  dpaa: { workflowId: string; issuedAt: number; reason: string; planSha256?: string } | null;
  codeQuality: { workflowId: string; issuedAt: number; reason: string } | null;
  codeReview: { workflowId: string; critical: number; major: number; minor: number; timestamp: number } | null;
  pushExecution: { workflowId: string; issuedAt: number; reason: string } | null;
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
  guardTokens?: PersistedGuardTokens;
  /** implement 시작 시점의 미테스트 클래스 목록. implement→code_review 전환 시 TDD 첨종 여부 판단에 사용. */
  untestedClassesSnapshot?: string[];
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

// ─── Command catalog ─────────────────────────────────────────────────────────

/**
 * A structured command definition. The LLM calls workflow_run_command with
 * a commandId; the executor resolves the spec and runs it without shell
 * interpolation, preventing injection.
 */
export interface CommandSpec {
  /** Unique catalog key passed to workflow_run_command */
  id: string;
  description: string;
  /** Resolved executable name (or "auto" for project-type detection) */
  executable: string;
  /** Fixed arguments array — never shell-interpolated */
  fixedArgs: string[];
  /** Phases where this command may run, or "all" */
  allowedPhases: WorkflowPhase[] | "all";
  /** Working directory resolution policy */
  cwdPolicy: "git-root" | "harness-root" | "cwd";
  timeoutMs: number;
  maxOutputBytes: number;
  outputPolicy: "inline" | "summary" | "store-full";
  /** Risk classification — determines whether ctx.ui.confirm() is required */
  riskLevel: "read" | "low" | "medium" | "high" | "destructive";
  /** If true, always ask user confirmation before executing */
  requiresApproval: boolean;
}

export type CatalogCommandResult = {
  ok: boolean;
  commandId: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  cwd: string;
  elapsedMs: number;
};

// ─── Edit scope (MVP 4: Guarded Editing) ─────────────────────────────────────────────

export type EditOperation = "write" | "edit" | "delete";

export interface ProposedEdit {
  /** File path relative to git root. Must be canonicalized before use. */
  path: string;
  operation: EditOperation;
  /** New file content (for write) */
  content?: string;
  /** Exact text to replace (for edit) */
  oldText?: string;
  /** Replacement text (for edit) */
  newText?: string;
  /** Human-readable reason for this edit */
  reason: string;
}

export interface EditScope {
  id: string;
  /** null = pending user approval; "interactive-user" = approved */
  approvedBy: "interactive-user" | null;
  /** SHA-256 of the plan file at proposal time (from dpaaGuardSatisfiedToken) */
  sourcePlanHash: string | null;
  allowedGlobs: string[];
  deniedGlobs: string[];
  maxFiles: number;
  allowSymlinks: boolean;
  proposedEdits: ProposedEdit[];
  /** SHA-256 of each file at proposal time, for staleness detection at apply time */
  baseFileHashes: Record<string, string>;
  proposedAt: number;
  approvedAt: number | null;
}

export const LEGACY_WORKFLOW_PHASE_ALIASES: Record<string, WorkflowPhase> = {
  push_with_review: "push",
};
