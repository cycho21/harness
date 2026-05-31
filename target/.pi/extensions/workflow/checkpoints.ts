import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowInstance } from "./types";
import { getWorkflowStateDir, slugify } from "./storage";
import { isApprovalText } from "./git";
import { validateWorkflowWorkspace } from "./gates";
import { banner, table } from "./ui";

export function createWorkspaceCheckpoint(workflow: WorkflowInstance, reason: string): string | undefined {
  const root = workflow.gitRoot;
  if (!root || !fs.existsSync(root)) return undefined;

  const id = `${Date.now()}-${slugify(reason)}`;
  const dir = path.join(getWorkspaceCheckpointRoot(workflow.id), id);
  fs.mkdirSync(dir, { recursive: true });

  const stagedPatch = execFileSync("git", ["-C", root, "diff", "--binary", "--cached"]);
  const unstagedPatch = execFileSync("git", ["-C", root, "diff", "--binary"]);
  fs.writeFileSync(path.join(dir, "staged.patch"), stagedPatch);
  fs.writeFileSync(path.join(dir, "unstaged.patch"), unstagedPatch);

  const untracked = execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf-8" })
    .split("\0")
    .filter(Boolean);
  const untrackedDir = path.join(dir, "untracked");
  for (const relative of untracked) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(untrackedDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    workflowId: workflow.id,
    reason,
    createdAt: new Date().toISOString(),
    gitRoot: root,
    branch: workflow.branch,
    untracked,
  }, null, 2), "utf-8");

  return dir;
}

export function getWorkspaceCheckpointRoot(workflowId: string): string {
  return path.join(getWorkflowStateDir(), "workspace-checkpoints", workflowId);
}

export function listWorkspaceCheckpoints(workflow: WorkflowInstance | null): string[] {
  if (!workflow) return [];
  const dir = getWorkspaceCheckpointRoot(workflow.id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, "meta.json")))
    .sort();
}

export function resolveWorkspaceCheckpoint(workflow: WorkflowInstance, idOrPrefix: string | undefined): string | null {
  const checkpoints = listWorkspaceCheckpoints(workflow);
  if (checkpoints.length === 0) return null;
  const selected = idOrPrefix
    ? checkpoints.find((name) => name === idOrPrefix || name.startsWith(idOrPrefix))
    : checkpoints[checkpoints.length - 1];
  return selected ? path.join(getWorkspaceCheckpointRoot(workflow.id), selected) : null;
}

export function formatWorkspaceCheckpoints(workflow: WorkflowInstance | null): string {
  const checkpoints = listWorkspaceCheckpoints(workflow);
  if (!workflow) return "⚪ 진행 중인 workflow가 없습니다.";
  if (checkpoints.length === 0) return "⚪ Workspace checkpoint가 없습니다.";
  return [
    banner("📌 Workspace checkpoints"),
    table([
      ["#", "Checkpoint"],
      ...checkpoints.map((name, index) => [String(index + 1), name]),
    ]),
    "복구: /workflow restore <checkpoint-prefix>",
  ].join("\n");
}

export function restoreWorkspaceCheckpoint(checkpointDir: string | undefined): string {
  if (!checkpointDir || !fs.existsSync(checkpointDir)) return "Workspace checkpoint 없음 — phase만 복구했습니다.";

  const meta = JSON.parse(fs.readFileSync(path.join(checkpointDir, "meta.json"), "utf-8")) as { gitRoot: string; untracked?: string[] };
  const root = meta.gitRoot;
  execFileSync("git", ["-C", root, "reset", "--hard", "HEAD"], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "clean", "-fd"], { stdio: "pipe" });

  const stagedPatch = path.join(checkpointDir, "staged.patch");
  if (fs.existsSync(stagedPatch) && fs.statSync(stagedPatch).size > 0) {
    execFileSync("git", ["-C", root, "apply", "--index", stagedPatch], { stdio: "pipe" });
  }

  const unstagedPatch = path.join(checkpointDir, "unstaged.patch");
  if (fs.existsSync(unstagedPatch) && fs.statSync(unstagedPatch).size > 0) {
    execFileSync("git", ["-C", root, "apply", unstagedPatch], { stdio: "pipe" });
  }

  const untrackedDir = path.join(checkpointDir, "untracked");
  for (const relative of meta.untracked ?? []) {
    const source = path.join(untrackedDir, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  return `Workspace files restored from checkpoint: ${path.basename(checkpointDir)}`;
}

export function getWorkspaceStatusSignature(root: string | null | undefined): string | null {
  if (!root || !fs.existsSync(root)) return null;
  const status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z"], { encoding: "utf-8" });
  if (!status) return null;
  return createHash("sha256").update(status).digest("hex");
}

export function isWorkspaceDirty(root: string | null | undefined): boolean {
  return getWorkspaceStatusSignature(root) !== null;
}

export function shouldOfferInputCheckpoint(workflow: WorkflowInstance, text: string, lastSignature: string | null): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/workflow")) return false;
  if (isApprovalText(trimmed)) return false;
  if (!["implement", "code_review", "review_approved", "document", "commit", "push"].includes(workflow.phase)) return false;
  const workspace = validateWorkflowWorkspace(workflow);
  if (!workspace.ok) return false;
  const signature = getWorkspaceStatusSignature(workflow.gitRoot);
  return !!signature && signature !== lastSignature;
}

export function shortInputReason(text: string): string {
  return text.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9가-힣_-]/g, "").slice(0, 40) || "input";
}
