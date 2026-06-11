import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowInstance, WorkflowPhase } from "../types";
import type { WorkflowRuntimeState } from "../runtime-state";
import { formatWorkflowAction } from "../format";
import { isSharedAutoAdvancePhase, isSharedWorkflowPhase } from "../policy-core";

const WORKFLOW_CONTINUATION_MARKER_PREFIX = "harness-workflow-continuation:";
const WORKFLOW_STEER_MARKER_PREFIX = "harness-workflow-steer:";

export type WorkflowContinuationHostContext = {
  hasPendingMessages?: () => boolean;
  isIdle?: () => boolean;
  ui: { notify: (message: string, level?: string) => void };
};

export type WorkflowContinuationService = ReturnType<typeof createWorkflowContinuationService>;

export function createWorkflowContinuationService(state: WorkflowRuntimeState, pi: ExtensionAPI) {
  function createContinuationMarker(workflow: WorkflowInstance): string {
    return `${workflow.id}:${workflow.phase}:${workflow.updatedAt}`;
  }

  function continuationMarkerComment(marker: string): string {
    return `<!-- ${WORKFLOW_CONTINUATION_MARKER_PREFIX}${marker} -->`;
  }

  function steerMarkerComment(marker: string): string {
    return `<!-- ${WORKFLOW_STEER_MARKER_PREFIX}${marker} -->`;
  }

  function extractWorkflowMarker(text: string, prefix: string): string | undefined {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<!--\\s*${escaped}([^\\s>]+)\\s*-->`).exec(text)?.[1];
  }

  function extractContinuationMarker(text: string): string | undefined {
    return extractWorkflowMarker(text, WORKFLOW_CONTINUATION_MARKER_PREFIX);
  }

  function extractSteerMarker(text: string): string | undefined {
    return extractWorkflowMarker(text, WORKFLOW_STEER_MARKER_PREFIX);
  }

  function cancelPending(): void {
    if (state.workflowContinuationPending) {
      state.cancelledWorkflowContinuationMarkers.add(state.workflowContinuationPending.marker);
      if (state.cancelledWorkflowContinuationMarkers.size >= 20) {
        const oldest = state.cancelledWorkflowContinuationMarkers.values().next().value;
        if (oldest) state.cancelledWorkflowContinuationMarkers.delete(oldest);
      }
    }
    state.workflowContinuationPending = null;
  }

  function consumeCancelledPrompt(text: string): boolean {
    const marker = extractContinuationMarker(text);
    return marker ? state.cancelledWorkflowContinuationMarkers.delete(marker) : false;
  }

  function consumeStaleSteerPrompt(text: string): boolean {
    const marker = extractSteerMarker(text);
    if (!marker) return false;
    const pending = state.pendingSteerMessages.get(marker);
    const [markerWorkflowId, markerPhase] = marker.split(":");
    const expectedWorkflowId = pending?.workflowId ?? markerWorkflowId;
    const expectedPhase = pending?.phase ?? (isSharedWorkflowPhase(markerPhase) ? markerPhase : null);
    if (!expectedWorkflowId || !expectedPhase) return false;
    const current = state.workflow;
    const isStale = !current || current.id !== expectedWorkflowId || current.phase !== expectedPhase;
    state.pendingSteerMessages.delete(marker);
    return isStale;
  }

  function clearSteersExceptCurrent(): void {
    const current = state.workflow;
    if (!current) {
      state.pendingSteerMessages.clear();
      return;
    }
    for (const [marker, pending] of state.pendingSteerMessages.entries()) {
      if (pending.workflowId !== current.id || pending.phase !== current.phase) {
        state.pendingSteerMessages.delete(marker);
      }
    }
  }

  function clearSteersForPhase(workflowId: string | null | undefined, phase: WorkflowPhase): void {
    if (!workflowId) return;
    for (const [marker, pending] of state.pendingSteerMessages.entries()) {
      if (pending.workflowId === workflowId && pending.phase === phase) {
        state.pendingSteerMessages.delete(marker);
      }
    }
  }

  function markDelivered(text: string | undefined): void {
    if (!text) return;
    const marker = extractContinuationMarker(text);
    if (marker && state.workflowContinuationPending?.marker === marker) state.workflowContinuationPending = null;
  }

  async function steerLlm(message: string, deliverAs: "followUp" | "steer" = "steer"): Promise<void> {
    try {
      const workflow = state.workflow;
      if (!workflow) {
        await (pi as any).sendUserMessage(message, { deliverAs });
        return;
      }
      const marker = `${workflow.id}:${workflow.phase}:${Date.now()}`;
      state.pendingSteerMessages.set(marker, { workflowId: workflow.id, phase: workflow.phase, marker, issuedAt: Date.now() });
      if (state.pendingSteerMessages.size > 20) {
        const oldest = state.pendingSteerMessages.keys().next().value;
        if (oldest) state.pendingSteerMessages.delete(oldest);
      }
      await (pi as any).sendUserMessage([message, steerMarkerComment(marker)].join("\n"), { deliverAs });
    } catch { /* non-fatal */ }
  }

  function shouldSend(workflow: WorkflowInstance, transitions: Array<{ from: WorkflowPhase; to: WorkflowPhase }> | undefined): boolean {
    if (!transitions?.some((item) => isSharedAutoAdvancePhase(item.from))) return false;
    return ["plan_review", "code_review", "commit"].includes(workflow.phase);
  }

  function buildPrompt(workflow: WorkflowInstance, marker: string): string {
    return [
      "Continue the workflow from the current phase.",
      "",
      formatWorkflowAction(workflow),
      "",
      "Rules:",
      "- Continue only within the current phase and its required actions.",
      "- The only user-approval boundary is commit → push. All other transitions are autonomous.",
      "- Do not bypass DPAA, SBADR, submit_review_package, quality, policy, or workspace guards.",
      "- plan_review is a repair loop: if the plan is high-risk (Risk: high, Ambiguity gate: strict, or Work type: api/security/migration/data/deploy), run Architect/Critic consensus review before implementation approval; if DPAA fails, call workflow_state prev to return to plan, fix the plan, then call workflow_approve to re-enter plan_review. Repeat until consensus and DPAA pass.",
      "- code_review is a repair loop: if quality/review issues found, call workflow_state prev to return to implement, fix the issues, then call workflow_approve to re-enter code_review. Repeat until review passes.",
      "- These loops are fully autonomous. Do not ask the user for permission to re-enter a review phase.",
      "",
      continuationMarkerComment(marker),
    ].join("\n");
  }

  async function queue(ctx: WorkflowContinuationHostContext, workflow: WorkflowInstance | null, transitions: Array<{ from: WorkflowPhase; to: WorkflowPhase }> | undefined): Promise<void> {
    if (!workflow || !shouldSend(workflow, transitions)) return;
    if (state.workflowContinuationPending?.workflowId === workflow.id && state.workflowContinuationPending.phase === workflow.phase) return;
    if (ctx.hasPendingMessages?.()) return;
    if (typeof (pi as any).sendUserMessage !== "function") return;
    cancelPending();

    const marker = createContinuationMarker(workflow);
    state.workflowContinuationPending = { workflowId: workflow.id, phase: workflow.phase, marker };
    try {
      if (state.workflow?.id !== workflow.id || state.workflow.phase !== workflow.phase) {
        state.workflowContinuationPending = null;
        return;
      }
      const prompt = buildPrompt(workflow, marker);
      if (!ctx.isIdle?.()) {
        state.workflowContinuationPending = null;
        return;
      }
      await (pi as any).sendUserMessage(prompt);
    } catch (error) {
      state.workflowContinuationPending = null;
      ctx.ui.notify(`Workflow continuation prompt failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  return {
    createContinuationMarker,
    continuationMarkerComment,
    cancelPending,
    consumeCancelledPrompt,
    consumeStaleSteerPrompt,
    clearSteersExceptCurrent,
    clearSteersForPhase,
    markDelivered,
    steerLlm,
    queue,
  };
}
