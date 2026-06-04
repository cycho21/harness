import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowPhase } from "./types";
import { WORKFLOW_PHASES } from "./types";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const POLICY_FILE = path.join(PROJECT_ROOT, ".harness", "workflow-policy.json");

export type PhaseContextStrategy = {
  delegateTo: string;
  mainKeeps: string[];
  mainAvoids: string[];
};

export type SharedTransitionPolicy = {
  strictNextPhaseOnly: boolean;
  forbidSkippedPhases: boolean;
  manualStateRestoreIsRecoveryOnly: boolean;
  tokenIssuanceIsNotThePolicySource: boolean;
};

export type SharedWorkflowPolicy = {
  schemaVersion: number;
  phases: WorkflowPhase[];
  autoAdvanceFromPhases: WorkflowPhase[];
  approvalBoundaries: string[];
  gates: string[];
  transitionPolicy: SharedTransitionPolicy;
  contextManagement: Record<string, unknown>;
  contextStrategy: Partial<Record<WorkflowPhase, PhaseContextStrategy>>;
  subagentHandoffContract: string[];
  reminderPolicy: Record<string, unknown> & { hardRules?: string[] };
  phaseGuidance: Partial<Record<WorkflowPhase, string>>;
};

const DEFAULT_POLICY: SharedWorkflowPolicy = {
  schemaVersion: 1,
  phases: WORKFLOW_PHASES,
  autoAdvanceFromPhases: ["interview", "plan", "implement", "review_approved", "document"],
  approvalBoundaries: ["plan_review:implement", "commit:push"],
  gates: ["dpaa", "code-quality", "policy-scan"],
  transitionPolicy: {
    strictNextPhaseOnly: true,
    forbidSkippedPhases: true,
    manualStateRestoreIsRecoveryOnly: true,
    tokenIssuanceIsNotThePolicySource: true,
  },
  contextManagement: {
    mainAgentRole: "workflow-controller",
    subagentPreferredPhases: ["implement", "code_review"],
  },
  contextStrategy: {
    implement: {
      delegateTo: "worker",
      mainKeeps: ["changed files", "summary", "verification", "risks"],
      mainAvoids: ["raw logs", "large diffs", "file dumps"],
    },
    code_review: {
      delegateTo: "reviewer",
      mainKeeps: ["finding counts", "fix summary", "quality result", "blockers"],
      mainAvoids: ["full review transcript", "full logs"],
    },
    document: {
      delegateTo: "worker when documentation is large",
      mainKeeps: ["docs changed", "rationale", "verification"],
      mainAvoids: ["large copied docs", "unrelated documentation"],
    },
    commit: {
      delegateTo: "main",
      mainKeeps: ["diff summary", "verification summary", "risk summary", "commit message"],
      mainAvoids: ["raw diff", "full logs"],
    },
  },
  subagentHandoffContract: ["Summary", "Changed files", "Verification", "Risks", "Blockers", "Recommended next step"],
  reminderPolicy: {
    injectOnUserPrompt: true,
    injectBeforeAgentStart: true,
    includeCurrentPhase: true,
    includeNextPhase: true,
    includeNoSkipRule: true,
    includeSubagentGuidance: true,
    hardRules: [
      "Follow the current workflow phase.",
      "Never skip phases; only advance to the next phase.",
      "User approval is required only before implement and before push.",
      "In code_review, fix/review/quality loop stays in code_review.",
      "Use subagents for implementation, review, large diffs, and logs.",
      "Keep main context to decisions, changed files, verification, blockers, next phase.",
    ],
  },
  phaseGuidance: {},
};

function asWorkflowPhaseList(value: unknown, fallback: WorkflowPhase[]): WorkflowPhase[] {
  if (!Array.isArray(value)) return fallback;
  const phases = value.filter((item): item is WorkflowPhase => WORKFLOW_PHASES.includes(item as WorkflowPhase));
  return phases.length > 0 ? phases : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function normalizeTransitionPolicy(value: unknown): SharedTransitionPolicy {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    strictNextPhaseOnly: typeof source.strictNextPhaseOnly === "boolean" ? source.strictNextPhaseOnly : DEFAULT_POLICY.transitionPolicy.strictNextPhaseOnly,
    forbidSkippedPhases: typeof source.forbidSkippedPhases === "boolean" ? source.forbidSkippedPhases : DEFAULT_POLICY.transitionPolicy.forbidSkippedPhases,
    manualStateRestoreIsRecoveryOnly: typeof source.manualStateRestoreIsRecoveryOnly === "boolean" ? source.manualStateRestoreIsRecoveryOnly : DEFAULT_POLICY.transitionPolicy.manualStateRestoreIsRecoveryOnly,
    tokenIssuanceIsNotThePolicySource: typeof source.tokenIssuanceIsNotThePolicySource === "boolean" ? source.tokenIssuanceIsNotThePolicySource : DEFAULT_POLICY.transitionPolicy.tokenIssuanceIsNotThePolicySource,
  };
}

function normalizeContextStrategy(value: unknown): Partial<Record<WorkflowPhase, PhaseContextStrategy>> {
  if (!value || typeof value !== "object") return {};
  const result: Partial<Record<WorkflowPhase, PhaseContextStrategy>> = {};
  for (const phase of WORKFLOW_PHASES) {
    const item = (value as Record<string, unknown>)[phase];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const delegateTo = typeof record.delegateTo === "string" ? record.delegateTo : "";
    const mainKeeps = stringList(record.mainKeeps);
    const mainAvoids = stringList(record.mainAvoids);
    if (delegateTo || mainKeeps.length > 0 || mainAvoids.length > 0) result[phase] = { delegateTo, mainKeeps, mainAvoids };
  }
  return result;
}

let _policyCache: SharedWorkflowPolicy | null = null;

export function loadSharedWorkflowPolicy(): SharedWorkflowPolicy {
  if (_policyCache) return _policyCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(POLICY_FILE, "utf-8")) as Partial<SharedWorkflowPolicy>;
    _policyCache = {
      ...DEFAULT_POLICY,
      ...parsed,
      phases: asWorkflowPhaseList(parsed.phases, DEFAULT_POLICY.phases),
      autoAdvanceFromPhases: asWorkflowPhaseList(parsed.autoAdvanceFromPhases, DEFAULT_POLICY.autoAdvanceFromPhases),
      approvalBoundaries: Array.isArray(parsed.approvalBoundaries) ? parsed.approvalBoundaries.filter((item): item is string => typeof item === "string") : DEFAULT_POLICY.approvalBoundaries,
      gates: Array.isArray(parsed.gates) ? parsed.gates.filter((item): item is string => typeof item === "string") : DEFAULT_POLICY.gates,
      transitionPolicy: normalizeTransitionPolicy(parsed.transitionPolicy),
      contextManagement: parsed.contextManagement && typeof parsed.contextManagement === "object" ? parsed.contextManagement : DEFAULT_POLICY.contextManagement,
      contextStrategy: parsed.contextStrategy && typeof parsed.contextStrategy === "object" ? normalizeContextStrategy(parsed.contextStrategy) : DEFAULT_POLICY.contextStrategy,
      subagentHandoffContract: Array.isArray(parsed.subagentHandoffContract) ? parsed.subagentHandoffContract.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : DEFAULT_POLICY.subagentHandoffContract,
      reminderPolicy: parsed.reminderPolicy && typeof parsed.reminderPolicy === "object" ? parsed.reminderPolicy : DEFAULT_POLICY.reminderPolicy,
      phaseGuidance: parsed.phaseGuidance && typeof parsed.phaseGuidance === "object" ? parsed.phaseGuidance : DEFAULT_POLICY.phaseGuidance,
    };
    return _policyCache;
  } catch (err) {
    console.error(`[harness] Failed to load workflow policy from ${POLICY_FILE}: ${err}. Using defaults.`);
    return DEFAULT_POLICY; // do not cache on error — next call may succeed
  }
}

export function sharedWorkflowPhases(): WorkflowPhase[] {
  return loadSharedWorkflowPolicy().phases;
}

export function isSharedWorkflowPhase(phase: string): phase is WorkflowPhase {
  return sharedWorkflowPhases().includes(phase as WorkflowPhase);
}

export function sharedNextPhase(phase: WorkflowPhase): WorkflowPhase | null {
  const phases = sharedWorkflowPhases();
  const index = phases.indexOf(phase);
  return index >= 0 ? phases[index + 1] ?? null : null;
}

export function isSharedAutoAdvancePhase(phase: WorkflowPhase): boolean {
  return loadSharedWorkflowPolicy().autoAdvanceFromPhases.includes(phase);
}

export function sharedTransitionKey(from: WorkflowPhase, to: WorkflowPhase): string {
  return `${from}:${to}`;
}

export function isSharedApprovalBoundary(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return loadSharedWorkflowPolicy().approvalBoundaries.includes(sharedTransitionKey(from, to));
}

export function isSharedTransitionAllowed(from: WorkflowPhase, to: WorkflowPhase): boolean {
  const policy = loadSharedWorkflowPolicy().transitionPolicy;
  if (policy.strictNextPhaseOnly || policy.forbidSkippedPhases) return sharedNextPhase(from) === to;
  return isSharedWorkflowPhase(from) && isSharedWorkflowPhase(to);
}

export function sharedPhaseGuidance(phase: WorkflowPhase): string | null {
  return loadSharedWorkflowPolicy().phaseGuidance[phase] ?? null;
}

export function sharedHardRules(): string[] {
  const rules = loadSharedWorkflowPolicy().reminderPolicy.hardRules;
  return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0) : [];
}

export function sharedContextStrategy(phase: WorkflowPhase): PhaseContextStrategy | null {
  return loadSharedWorkflowPolicy().contextStrategy[phase] ?? null;
}

// ─── Phase-based tool policy ─────────────────────────────────────────────────

const READ_ONLY_BUILTIN = ["read", "bash", "grep", "find", "ls"] as const;
const WRITE_BUILTIN = ["write", "edit"] as const;
const ALL_BUILTIN = [...READ_ONLY_BUILTIN, ...WRITE_BUILTIN] as const;

/**
 * Defines which built-in tools are allowed in each workflow phase.
 * Extension tools (e.g. submit_review_package) are always appended by getPhaseAllowedTools().
 */
export const PHASE_ALLOWED_BUILTIN_TOOLS: Record<WorkflowPhase, readonly string[]> = {
  interview:       ALL_BUILTIN,
  plan:            ALL_BUILTIN,
  plan_review:     READ_ONLY_BUILTIN,
  implement:       ALL_BUILTIN,
  code_review:     READ_ONLY_BUILTIN,
  review_approved: ["read"],
  document:        ALL_BUILTIN,
  commit:          READ_ONLY_BUILTIN,
  push:            READ_ONLY_BUILTIN,
  done:            ["read"],
};

/**
 * Returns the full allowed tool name list for a given phase.
 * extensionToolNames should come from pi.getAllTools() filtered to non-builtin sources.
 */
export function getPhaseAllowedTools(phase: WorkflowPhase, extensionToolNames: string[] = []): string[] {
  const builtins: readonly string[] = PHASE_ALLOWED_BUILTIN_TOOLS[phase] ?? ALL_BUILTIN;
  return [...new Set([...builtins, ...extensionToolNames])];
}

export function sharedSubagentHandoffContract(): string[] {
  return loadSharedWorkflowPolicy().subagentHandoffContract;
}
