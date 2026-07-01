import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowInstance, WorkflowTaskItem, WorkflowTaskQueue, WorkflowTaskStatus } from "./types";

export type WorkflowTaskInput = {
  id?: string;
  title: string;
  scope?: string;
  acceptanceCriteria?: string[];
  verification?: string[];
  status?: WorkflowTaskStatus;
  dependencies?: string[];
  notes?: string;
};

export type WorkflowTaskQueueInput = {
  id?: string;
  title: string;
  tasks?: WorkflowTaskInput[];
};

const WORKFLOW_TASK_STATUSES: WorkflowTaskStatus[] = ["pending", "active", "done", "blocked", "deferred"];

export function isWorkflowTaskStatus(value: string): value is WorkflowTaskStatus {
  return (WORKFLOW_TASK_STATUSES as string[]).includes(value);
}

export function createWorkflowTaskQueue(input: WorkflowTaskQueueInput): WorkflowTaskQueue {
  const now = Date.now();
  const usedIds = new Set<string>();
  const tasks = (input.tasks ?? []).map((task, index) => normalizeTaskInput(task, index, now, usedIds));
  return enforceSingleActiveTask({
    id: input.id?.trim() || stableId(input.title, "queue"),
    title: input.title.trim() || "Epic PEV Queue",
    tasks,
    activeTaskId: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function addWorkflowTask(queue: WorkflowTaskQueue, input: WorkflowTaskInput): WorkflowTaskQueue {
  const now = Date.now();
  const usedIds = new Set(queue.tasks.map((task) => task.id));
  const task = normalizeTaskInput(input, queue.tasks.length, now, usedIds);
  return enforceSingleActiveTask({
    ...queue,
    tasks: [...queue.tasks, task],
    updatedAt: now,
  });
}

export function activateWorkflowTask(queue: WorkflowTaskQueue, taskId: string): WorkflowTaskQueue {
  assertTaskExists(queue, taskId);
  const now = Date.now();
  return {
    ...queue,
    activeTaskId: taskId,
    updatedAt: now,
    tasks: queue.tasks.map((task) => ({
      ...task,
      status: task.id === taskId ? "active" : task.status === "active" ? "pending" : task.status,
      updatedAt: task.id === taskId || task.status === "active" ? now : task.updatedAt,
    })),
  };
}

export function markWorkflowTask(queue: WorkflowTaskQueue, taskId: string, status: WorkflowTaskStatus, notes?: string): WorkflowTaskQueue {
  assertTaskExists(queue, taskId);
  if (status === "active") return activateWorkflowTask(queue, taskId);
  const now = Date.now();
  const tasks = queue.tasks.map((task) => task.id === taskId
    ? { ...task, status, notes: notes ?? task.notes, updatedAt: now }
    : task);
  return enforceSingleActiveTask({
    ...queue,
    activeTaskId: queue.activeTaskId === taskId ? null : queue.activeTaskId,
    tasks,
    updatedAt: now,
  });
}

export function formatWorkflowTaskQueueSummary(queue?: WorkflowTaskQueue | null): string {
  if (!queue) return "[Epic PEV Queue]\n- No task queue is active.";
  const counts = WORKFLOW_TASK_STATUSES
    .map((status) => `${status}:${queue.tasks.filter((task) => task.status === status).length}`)
    .join(" ");
  const active = queue.tasks.find((task) => task.status === "active") ?? null;
  const nextPending = queue.tasks.find((task) => task.status === "pending") ?? null;
  return [
    "[Epic PEV Queue]",
    `- Queue: ${truncate(queue.title, 120)}`,
    `- Progress: ${counts}`,
    active ? `- Active task: ${formatTaskLabel(active)}` : "- Active task: none",
    ...(active ? formatActiveTaskExecutionCues(active) : []),
    nextPending ? `- Next pending task: ${formatTaskLabel(nextPending)}` : "- Next pending task: none",
  ].join("\n");
}

function formatTaskLabel(task: WorkflowTaskItem): string {
  return truncate(`${task.id} — ${task.title}`, 140);
}

function formatActiveTaskExecutionCues(task: WorkflowTaskItem): string[] {
  return [
    `- Active scope: ${truncate(task.scope, 120)}`,
    `- Active acceptance: ${formatListPreview(task.acceptanceCriteria)}`,
    `- Active verification: ${formatListPreview(task.verification)}`,
  ];
}

function formatListPreview(values: string[]): string {
  if (values.length === 0) return "not specified";
  const preview = values.slice(0, 2).map((value) => truncate(value, 60)).join("; ");
  return values.length > 2 ? `${preview}; +${values.length - 2} more` : preview;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function writeWorkflowTaskQueueArtifact(
  workflow: Pick<WorkflowInstance, "id" | "taskQueue">,
  cwd = process.cwd(),
): { path: string; writtenAt: string } {
  if (!workflow.taskQueue) throw new Error("Workflow has no taskQueue to write.");
  const runDir = path.join(cwd, ".ai", "interview", "runs", workflow.id);
  fs.mkdirSync(runDir, { recursive: true });
  const artifactPath = path.join(runDir, "task-queue.json");
  const writtenAt = new Date().toISOString();
  const queue = { ...workflow.taskQueue, artifactPath };
  fs.writeFileSync(artifactPath, JSON.stringify({ workflowId: workflow.id, writtenAt, queue }, null, 2), "utf-8");
  workflow.taskQueue.artifactPath = artifactPath;
  return { path: artifactPath, writtenAt };
}

function normalizeTaskInput(input: WorkflowTaskInput, index: number, now: number, usedIds: Set<string>): WorkflowTaskItem {
  const id = uniqueId(input.id?.trim() || stableId(input.title, `task-${index + 1}`), usedIds);
  usedIds.add(id);
  return {
    id,
    title: input.title.trim(),
    scope: input.scope?.trim() || "Not specified",
    acceptanceCriteria: normalizeStringList(input.acceptanceCriteria),
    verification: normalizeStringList(input.verification),
    status: input.status ?? "pending",
    dependencies: normalizeStringList(input.dependencies),
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeStringList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function enforceSingleActiveTask(queue: WorkflowTaskQueue): WorkflowTaskQueue {
  const activeTasks = queue.tasks.filter((task) => task.status === "active");
  if (activeTasks.length === 0) return { ...queue, activeTaskId: null };
  const activeTask = activeTasks[activeTasks.length - 1];
  return {
    ...queue,
    activeTaskId: activeTask.id,
    tasks: queue.tasks.map((task) => task.id === activeTask.id
      ? task
      : task.status === "active" ? { ...task, status: "pending" as WorkflowTaskStatus } : task),
  };
}

function assertTaskExists(queue: WorkflowTaskQueue, taskId: string): void {
  if (!queue.tasks.some((task) => task.id === taskId)) throw new Error(`Unknown task id: ${taskId}`);
}

function stableId(value: string, fallback: string): string {
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return id || fallback;
}

function uniqueId(base: string, usedIds: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}
