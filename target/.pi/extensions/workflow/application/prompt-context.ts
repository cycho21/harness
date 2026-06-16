import type { WorkflowRuntimeState } from "../runtime-state";
import { getBranch, getGitRoot } from "../git";
import { formatWorkflowAction, formatWorkflowPrompt } from "../format";
import { formatWorkflowReminders, scanWorkflowReminders } from "../reminders";
import { scanPushPolicy } from "../gates";
import { formatLatestActionableFailureHint } from "../field-log";

function fieldLogCategoryForGate(gate: string): string {
  if (gate === "policy-scan") return "push-policy";
  if (gate === "code-quality") return "code-quality";
  if (gate === "dpaa") return "dpaa";
  if (gate === "interview-ambiguity") return "interview-ambiguity";
  return gate;
}

export function formatGuardMemoryStatus(state: WorkflowRuntimeState): string {
  const workflowId = state.workflow?.id;
  const policyScan = scanPushPolicy();
  const lastPolicy = state.policyApprovals.at(-1);
  const interviewScoreOk = Boolean(workflowId && state.interviewAmbiguityScoreToken?.workflowId === workflowId);
  return [
    "🧪 Guard memory/status",
    `- Interview ambiguity score: ${interviewScoreOk ? `present (goal:${state.interviewAmbiguityScoreToken!.goal} scope:${state.interviewAmbiguityScoreToken!.scope} acceptance:${state.interviewAmbiguityScoreToken!.acceptance} constraints:${state.interviewAmbiguityScoreToken!.constraints} context:${state.interviewAmbiguityScoreToken!.context})` : "absent"}  (required: interview → plan)`,
    `- DPAA guard: ${workflowId && state.dpaaGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
    `- Code quality guard: ${workflowId && state.codeQualityGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
    `- Code review guard: ${state.codeReviewGuardSatisfiedToken ? `satisfied (Cr:${state.codeReviewGuardSatisfiedToken.critical} Maj:${state.codeReviewGuardSatisfiedToken.major} min:${state.codeReviewGuardSatisfiedToken.minor})` : "absent"}`,
    `- Push execution guard: ${workflowId && state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
    `- Policy scan now: ${policyScan.ok ? `ok (${policyScan.totalChanged} changed)` : `confirmation required (${policyScan.findings.map((finding) => finding.category).join(", ")})`}`,
    `- Last policy approval: ${lastPolicy ? `${new Date(lastPolicy.timestamp).toISOString()} / ${lastPolicy.totalChanged} changed / ${lastPolicy.categories.join(", ")}` : "none"}`,
  ].join("\n");
}

export function buildWorkflowSystemPromptInjection(state: WorkflowRuntimeState): string {
  const root = getGitRoot();
  const branch = root ? getBranch(root) : "unknown";
  const dpaaOk = Boolean(state.workflow && state.dpaaGuardSatisfiedToken?.workflowId === state.workflow.id);
  const qualOk = Boolean(state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id);
  const reviewOk = Boolean(state.codeReviewGuardSatisfiedToken);
  const pushOk = Boolean(state.workflow && state.pushExecutionGuardSatisfiedToken?.workflowId === state.workflow.id);
  const interviewScoreOk = Boolean(state.workflow && state.interviewAmbiguityScoreToken?.workflowId === state.workflow.id);
  const failedGates = Array.from(state.gateFailures.entries()).filter(([, count]) => count > 0);
  const latestActionableFailure = formatLatestActionableFailureHint(20, {
    activeGateFailures: failedGates.map(([gate]) => fieldLogCategoryForGate(gate)),
  });
  const authLines = [
    "[Workflow Guard Evidence]",
    `Interview ambiguity score evidence: ${interviewScoreOk ? "present" : "absent"}  (required: interview → plan; call workflow_score_interview after wizard)`,
    `DPAA guard evidence: ${dpaaOk ? "present" : "absent"}  (required: plan_review → implement)`,
    `Code quality guard evidence: ${qualOk ? "present" : "absent"}  (required: code_review → review_approved)`,
    `Code review guard evidence: ${reviewOk ? "present" : "absent"}  (required: submit_review_package before review_approved)`,
    `Push transition evidence: ${pushOk ? "present" : "absent"}  (required: commit → push before git push)`,
    `Policy scan approvals this session: ${state.policyApprovals.length}`,
  ].join("\n");

  return [
    "",
    "[Harness Context]",
    `Branch: ${branch}`,
    formatWorkflowPrompt(state.workflow),
    authLines,
    ...(latestActionableFailure ? ["", "[Workflow Failure Hint]", latestActionableFailure, "[/Workflow Failure Hint]"] : []),
    formatWorkflowReminders(scanWorkflowReminders(state.workflow, {
      recentVerificationCommands: state.recentVerificationCommands,
      interviewWizardCompleted: Boolean(state.workflow && state.interviewWizardCompletedToken?.workflowId === state.workflow.id),
      interviewScoreRecorded: Boolean(state.workflow && state.interviewAmbiguityScoreToken?.workflowId === state.workflow.id),
      codeQualityGuardSatisfied: Boolean(state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id),
      reviewPackageSubmitted: Boolean(state.workflow && state.reviewPackageToken?.workflowId === state.workflow.id),
    })),
  ].join("\n");
}

export function formatWorkflowStatusWithGuardMemory(state: WorkflowRuntimeState): string {
  return [formatWorkflowAction(state.workflow), "", formatGuardMemoryStatus(state)].join("\n");
}
