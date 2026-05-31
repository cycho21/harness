import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGitRoot } from "./git";

export function getDpaaReceiptDir(): string {
  return path.join(getWorkflowStateDir(), "dpaa-runs");
}

export function getWorkflowStateDir(): string {
  return path.join(getAgentDir(), "workflow-state", projectHash(getGitRoot() ?? process.cwd()));
}

export function getWorkflowStatePath(): string {
  return path.join(getWorkflowStateDir(), "state.json");
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function projectHash(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "snapshot";
}
