import * as fs from "node:fs";
import type { WorkflowInstance, WorkflowPhase } from "./types";
import { LEGACY_WORKFLOW_PHASE_ALIASES } from "./types";
import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "./checkpoints";
import { formatWorkspaceMismatch, runPreTransitionGate, validateWorkflowWorkspace } from "./gates";
import { getBranch, getGitRoot } from "./git";
import { getWorkflowStatePath, getWorkflowStateDir } from "./storage";
import { isSharedAutoAdvancePhase, isSharedTransitionAllowed, isSharedWorkflowPhase, sharedNextPhase } from "./policy-core";

export function createWorkflow(title: string): WorkflowInstance {
  const now = Date.now();
  const gitRoot = getGitRoot();
  return {
    id: `wf-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`,
    title: title || "workflow",
    phase: "interview",
    cwd: process.cwd(),
    gitRoot,
    branch: gitRoot ? getBranch(gitRoot) : "unknown",
    history: [],
    undone: [],
    startedAt: now,
    updatedAt: now,
  };
}

export type WorkflowAdvanceTransition = { from: WorkflowPhase; to: WorkflowPhase; message: string };

export function getNextPhase(phase: WorkflowPhase): WorkflowPhase | null {
  return sharedNextPhase(phase);
}

export function transitionWorkflow(workflow: WorkflowInstance, to: WorkflowPhase, reason: string): void {
  const from = workflow.phase;
  if (from !== to) {
    workflow.history.push({
      from,
      to,
      reason,
      timestamp: Date.now(),
      checkpointBefore: createWorkspaceCheckpoint(workflow, `${from}-to-${to}`),
    });
    workflow.undone = [];
  }
  workflow.phase = to;
  workflow.updatedAt = Date.now();
}

export async function advanceWorkflow(workflow: WorkflowInstance | null, reason: string): Promise<{ ok: boolean; message: string; gate?: string; transitions?: WorkflowAdvanceTransition[] }> {
  if (!workflow) return { ok: false, message: "진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요." };
  const workspace = validateWorkflowWorkspace(workflow);
  if (!workspace.ok) return { ok: false, message: formatWorkspaceMismatch(workspace) };

  const transitions: WorkflowAdvanceTransition[] = [];

  while (true) {
    const from = workflow.phase;
    const next = getNextPhase(from);
    if (!next) {
      if (transitions.length === 0) return { ok: false, message: `이미 마지막 단계입니다: ${workflow.phase}` };
      break;
    }

    if (!isSharedTransitionAllowed(from, next)) {
      return { ok: false, message: `Workflow transition blocked by policy: ${from} → ${next}` };
    }

    const gate = await runPreTransitionGate(workflow, from, next);
    if (!gate.ok) {
      if (transitions.length === 0) return { ok: false, message: gate.message, gate: gate.gate };
      break;
    }

    transitionWorkflow(workflow, next, reason);
    transitions.push({ from, to: next, message: gate.message });

    // Preparation/review phases advance automatically to the next approval boundary.
    // Risky boundaries (plan_review→implement, commit→push) still require a user
    // approval that starts from that phase. implement→code_review is automated;
    // code_review→review_approved is triggered after a submitted review package passes gates.
    if (!isSharedAutoAdvancePhase(next)) break;
  }

  saveWorkflow(workflow);
  const path = transitions.map((item, index) => index === 0 ? `${item.from} → ${item.to}` : `→ ${item.to}`).join(" ");
  return { ok: true, message: `Workflow 전이: ${path}`, transitions };
}

export function loadPersistedWorkflow(): WorkflowInstance | null {
  const file = getWorkflowStatePath();
  if (!fs.existsSync(file)) return null;

  try {
    const workflow = JSON.parse(fs.readFileSync(file, "utf-8")) as WorkflowInstance;
    workflow.cwd = workflow.cwd ?? process.cwd();
    workflow.gitRoot = workflow.gitRoot ?? getGitRoot();
    workflow.branch = workflow.branch ?? (workflow.gitRoot ? getBranch(workflow.gitRoot) : "unknown");
    workflow.phase = normalizeWorkflowPhase(workflow.phase);
    workflow.history = workflow.history.map((item) => ({
      ...item,
      from: normalizeWorkflowPhase(item.from),
      to: normalizeWorkflowPhase(item.to),
    }));
    workflow.undone = workflow.undone.map((item) => ({
      ...item,
      from: normalizeWorkflowPhase(item.from),
      to: normalizeWorkflowPhase(item.to),
    }));
    if (!isSharedWorkflowPhase(workflow.phase)) return null;
    return workflow;
  } catch {
    return null;
  }
}

export function normalizeWorkflowPhase(phase: string): WorkflowPhase {
  return (isSharedWorkflowPhase(phase)
    ? phase
    : LEGACY_WORKFLOW_PHASE_ALIASES[phase] ?? phase) as WorkflowPhase;
}

export function saveWorkflow(workflow: WorkflowInstance): void {
  const file = getWorkflowStatePath();
  fs.mkdirSync(getWorkflowStateDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(workflow, null, 2), "utf-8");
}

export function clearPersistedWorkflow(): void {
  fs.rmSync(getWorkflowStatePath(), { force: true });
}

export function undoWorkflow(workflow: WorkflowInstance | null): { ok: boolean; message: string } {
  if (!workflow) return { ok: false, message: "진행 중인 workflow가 없습니다." };
  const workspace = validateWorkflowWorkspace(workflow);
  if (!workspace.ok) return { ok: false, message: formatWorkspaceMismatch(workspace) };

  const last = workflow.history.pop();
  if (!last) return { ok: false, message: "되돌릴 workflow 전이가 없습니다." };

  last.checkpointAfter = createWorkspaceCheckpoint(workflow, `${last.to}-before-undo`);
  let restored: string | undefined;
  try {
    restored = restoreWorkspaceCheckpoint(last.checkpointBefore);
  } catch (err) {
    // restore 실패 시 pop된 history 복구
    workflow.history.push(last);
    return { ok: false, message: `Workspace restore 실패로 undo를 중단했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }

  workflow.phase = last.from;
  workflow.undone.push(last);
  workflow.updatedAt = Date.now();
  saveWorkflow(workflow);
  return {
    ok: true,
    message: [`Workflow undo: ${last.to} → ${last.from}`, restored].filter(Boolean).join("\n"),
  };
}

export function redoWorkflow(workflow: WorkflowInstance | null): { ok: boolean; message: string } {
  if (!workflow) return { ok: false, message: "진행 중인 workflow가 없습니다." };
  const workspace = validateWorkflowWorkspace(workflow);
  if (!workspace.ok) return { ok: false, message: formatWorkspaceMismatch(workspace) };

  const next = workflow.undone.pop();
  if (!next) return { ok: false, message: "다시 실행할 workflow 전이가 없습니다." };

  next.checkpointBefore = createWorkspaceCheckpoint(workflow, `${next.from}-before-redo`);
  let restored: string | undefined;
  try {
    restored = restoreWorkspaceCheckpoint(next.checkpointAfter);
  } catch (err) {
    // restore 실패 시 pop된 undone 복구
    workflow.undone.push(next);
    return { ok: false, message: `Workspace restore 실패로 redo를 중단했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }

  workflow.phase = next.to;
  workflow.history.push(next);
  workflow.updatedAt = Date.now();
  saveWorkflow(workflow);
  return {
    ok: true,
    message: [`Workflow redo: ${next.from} → ${next.to}`, restored].filter(Boolean).join("\n"),
  };
}

