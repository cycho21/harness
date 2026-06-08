import * as path from "node:path";
import {
  createWorkspaceCheckpoint,
  formatWorkspaceCheckpoints,
  getWorkspaceStatusSignature,
  redoWorkflow,
  resolveWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  undoWorkflow,
  type WorkflowInstance,
} from "./core";

export type WorkflowCheckpointCommandState = {
  workflow: WorkflowInstance | null;
  lastInputCheckpointSignature?: string | null;
};

export function createManualWorkspaceCheckpoint(state: WorkflowCheckpointCommandState, reason: string): { message: string; level: "info" | "warning" } {
  if (!state.workflow) {
    return { message: "진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", level: "warning" };
  }
  const checkpoint = createWorkspaceCheckpoint(state.workflow, reason);
  state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
  return {
    message: checkpoint ? `Workspace checkpoint 생성: ${path.basename(checkpoint)}` : "Workspace checkpoint를 생성하지 못했습니다.",
    level: checkpoint ? "info" : "warning",
  };
}

export function formatManualWorkspaceCheckpoints(state: WorkflowCheckpointCommandState): string {
  return formatWorkspaceCheckpoints(state.workflow);
}

export function restoreManualWorkspaceCheckpoint(state: WorkflowCheckpointCommandState, checkpointId: string | undefined): { message: string; level: "info" | "warning" } {
  if (!state.workflow) {
    return { message: "진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", level: "warning" };
  }
  if (!checkpointId) {
    return { message: "복구할 checkpoint id가 필요합니다. /workflow checkpoints 로 목록을 확인하세요.", level: "warning" };
  }
  const checkpoint = resolveWorkspaceCheckpoint(state.workflow, checkpointId);
  if (!checkpoint) {
    return { message: "복구할 checkpoint를 찾지 못했습니다. /workflow checkpoints 로 목록을 확인하세요.", level: "warning" };
  }
  createWorkspaceCheckpoint(state.workflow, `before-restore-${path.basename(checkpoint)}`);
  const message = restoreWorkspaceCheckpoint(checkpoint);
  state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
  return { message, level: "info" };
}

export function undoManualWorkflowCheckpoint(state: WorkflowCheckpointCommandState): { message: string; level: "info" | "warning" } {
  const result = undoWorkflow(state.workflow);
  return { message: result.message, level: result.ok ? "info" : "warning" };
}

export function redoManualWorkflowCheckpoint(state: WorkflowCheckpointCommandState): { message: string; level: "info" | "warning" } {
  const result = redoWorkflow(state.workflow);
  return { message: result.message, level: result.ok ? "info" : "warning" };
}
