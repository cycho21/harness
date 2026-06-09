import { Text, Box, truncateToWidth } from "@earendil-works/pi-tui";

import { formatWorkflowBoard, type WorkflowBoardState } from "./format";
import { getNextPhase } from "./state";
import { WORKFLOW_PHASES } from "./types";
import type { WorkflowRuntimeState } from "./runtime-state";

type WorkflowBoardCtx = { hasUI: boolean; ui: { setWidget: (...args: unknown[]) => void; theme?: unknown } };
type WorkflowStatusCtx = { hasUI: boolean; ui: { setStatus?: (...args: unknown[]) => void; theme?: unknown } };

export function getBoardState(state: WorkflowRuntimeState): WorkflowBoardState {
  const workflowId = state.workflow?.id;
  return {
    workflow: state.workflow,
    gateFailures: state.gateFailures,
    dpaaGuardSatisfied: Boolean(workflowId && state.dpaaGuardSatisfiedToken?.workflowId === workflowId),
    codeQualityGuardSatisfied: Boolean(workflowId && state.codeQualityGuardSatisfiedToken?.workflowId === workflowId),
    reviewPackageSubmitted: Boolean(workflowId && state.reviewPackageToken?.workflowId === workflowId),
    pushGuardSatisfied: Boolean(workflowId && state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId),
  };
}

export function refreshWorkflowBoard(state: WorkflowRuntimeState, ctx: WorkflowBoardCtx): void {
  if (!ctx.hasUI) return;
  try {
    if (!state.workflow) {
      (ctx.ui as any).setWidget("workflow-board", undefined);
      return;
    }
    (ctx.ui as any).setWidget("workflow-board", (_tui: unknown, theme: any) => {
      const rawLines = formatWorkflowBoard(getBoardState(state));
      const coloredLines = rawLines.map((line) => {
        if (!theme) return line;
        if (line.startsWith("🧭")) return theme.fg("accent", line);
        if (line.startsWith("Gates:")) {
          return line
            .replace(/✅/g, theme.fg("success", "✅"))
            .replace(/❌/g, theme.fg("error", "❌"))
            .replace(/⏳/g, theme.fg("warning", "⏳"));
        }
        if (line.startsWith("Tools:") || line.startsWith("Cmds:")) return theme.fg("dim", line);
        if (line.startsWith("→")) return theme.fg("warning", line);
        if (line.startsWith("   ") && !line.trim().startsWith("Gates") && !line.trim().startsWith("Tools") && !line.trim().startsWith("Cmds")) {
          return theme.fg("text", line);
        }
        return theme.fg("dim", line);
      });
      const content = coloredLines.join("\n");
      const text = new Text(content, 0, 0);
      const bgFn = theme ? (s: string) => theme.bg("customMessageBg", s) : undefined;
      const box = new Box(1, 0, bgFn);
      box.addChild(text);
      return box;
    });
  } catch { /* non-fatal */ }
}

export function colorOutcome(theme: any, icon: string): string {
  if (!theme) return icon;
  if (icon === "✅") return theme.fg("success", icon);
  if (icon === "❌") return theme.fg("error", icon);
  if (icon === "⏳") return theme.fg("warning", icon);
  return theme.fg("muted", icon);
}

export function colorResultLabel(theme: any, kind: "success" | "warning" | "error" | "muted", text: string): string {
  if (!theme) return text;
  return theme.fg(kind, text);
}

export function resultBox(theme: any, kind: "success" | "warning" | "error" | "pending", content: string): Box {
  const bgToken = kind === "success" ? "toolSuccessBg" : kind === "error" ? "toolErrorBg" : "toolPendingBg";
  const bgFn = theme ? (s: string) => theme.bg(bgToken, s) : undefined;
  const box = new Box(1, 0, bgFn);
  box.addChild(new Text(content, 0, 0));
  return box;
}

export function formatTransitionDetails(value: unknown): string {
  if (!Array.isArray(value)) return "advanced";
  const labels = value
    .map((item) => typeof item === "string" ? item : null)
    .filter((item): item is string => Boolean(item && item.trim()));
  return labels.length > 0 ? labels.join(" → ") : "advanced";
}

export function refreshWorkflowStatus(state: WorkflowRuntimeState, ctx: WorkflowStatusCtx): void {
  if (!ctx.hasUI || typeof (ctx.ui as any).setStatus !== "function") return;
  try {
    const theme = (ctx.ui as any).theme;
    const wf = state.workflow;
    if (!wf) {
      (ctx.ui as any).setStatus("workflow-phase", theme?.fg("muted", "⚪ no workflow") ?? "⚪ no workflow");
      return;
    }
    const workflowId = wf.id;
    const dpaa    = state.dpaaGuardSatisfiedToken?.workflowId === workflowId ? "✅" : (state.gateFailures.get("dpaa") ?? 0) > 0 ? "❌" : "⏳";
    const quality = state.codeQualityGuardSatisfiedToken?.workflowId === workflowId ? "✅" : (state.gateFailures.get("code-quality") ?? 0) > 0 ? "❌" : "⏳";
    const review  = state.reviewPackageToken?.workflowId === workflowId ? "✅" : "⏳";
    const push    = state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId ? "✅" : "⏳";
    const nextPhase = getNextPhase(wf.phase);
    const phaseIndex = Math.max(0, WORKFLOW_PHASES.indexOf(wf.phase)) + 1;
    const phaseTotal = WORKFLOW_PHASES.length;
    const title = truncateToWidth(wf.title || "workflow", 32);
    const workflowStr = `${theme?.fg("dim", "Workflow") ?? "Workflow"}: ${theme?.fg("accent", title) ?? title}`;
    const phaseStr = `${theme?.fg("dim", "phase") ?? "phase"}: ${theme?.fg("accent", wf.phase) ?? wf.phase}${theme?.fg("dim", " → ") ?? " -> "}${theme?.fg("accent", nextPhase ?? "done") ?? (nextPhase ?? "done")}`;
    const progressStr = `${theme?.fg("dim", "progress") ?? "progress"}: ${phaseIndex}/${phaseTotal}`;
    const gatePairs = [["DPAA", dpaa], ["Quality", quality], ["Review", review]];
    if (wf.phase === "commit" || wf.phase === "push") gatePairs.push(["Push", push]);
    const gatesStr = gatePairs
      .map(([label, icon]) => `${theme?.fg("dim", label) ?? label}:${colorOutcome(theme, icon)}`)
      .join(theme?.fg("dim", " ") ?? " ");
    const sep = theme?.fg("border", " │ ") ?? " | ";
    (ctx.ui as any).setStatus("workflow-phase", `⚙️ ${workflowStr}${sep}${phaseStr}${sep}${progressStr}${sep}${gatesStr}`);
  } catch { /* non-fatal */ }
}
