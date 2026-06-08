import type { WorkflowInstance, WorkflowPhase } from "./core";
import { formatWorkflowAction } from "./format";

export type WorkflowGateRunnerState = {
  workflow: WorkflowInstance | null;
  workflowContinuationPending: { workflowId: string; phase: WorkflowPhase; marker: string } | null;
  pendingSteerMessages: Map<string, { workflowId: string; phase: WorkflowPhase }>;
};

export type ReturnToPlanAfterDpaaBlockDeps = {
  transitionWorkflow: (workflow: WorkflowInstance, phase: WorkflowPhase, reason: string) => { ok: boolean; message: string };
  saveWorkflow: (workflow: WorkflowInstance) => void;
  refreshBoard: (ctx: any) => void;
  refreshStatus: (ctx: any) => void;
  steerLlm: (message: string, deliverAs?: "followUp" | "steer") => Promise<void>;
};

export async function returnToPlanAfterDpaaBlock(
  state: WorkflowGateRunnerState,
  ctx: any,
  message: string,
  deps: ReturnToPlanAfterDpaaBlockDeps,
): Promise<string> {
  if (!state.workflow || state.workflow.phase !== "plan_review") return message;
  const result = deps.transitionWorkflow(state.workflow, "plan", "dpaa_precheck_repair_required");
  if (!result.ok) return message;
  deps.saveWorkflow(state.workflow);
  deps.refreshBoard(ctx);
  deps.refreshStatus(ctx);
  await deps.steerLlm(
    "DPAA precheck failed before showing the implementation approval dialog. " +
    "The workflow has returned to plan so you can repair the plan artifacts, then retry workflow_approve.\n\n" +
    message.slice(0, 1200),
  );
  return [
    "DPAA precheck failed before user approval. The workflow returned to plan so the LLM can repair the plan and retry.",
    "",
    message,
    "",
    formatWorkflowAction(state.workflow),
  ].join("\n");
}

export function formatWorkflowGateBlockedMessage(message: string): string {
  return `Workflow transition was requested, but it was blocked by a workflow gate.\nInteractive user approval was received, but transition was blocked by guard validation.\nDefault handling: do not ask the user for a skip first. Fix the underlying cause within the current phase when possible, then retry the workflow transition. Ask the user only for product/architecture input, an approval boundary, or an accepted-risk exception.\n\n${message}`;
}
