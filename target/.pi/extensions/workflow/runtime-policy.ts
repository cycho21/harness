import { getPhaseAllowedTools } from "./policy-core";
import type { WorkflowPhase } from "./types";

export type ToolHost = {
  getAllTools?: () => Array<{ name: string; sourceInfo: { source: string } }>;
  setActiveTools?: (names: string[]) => void;
};

export function applyPhaseToolPolicyForHost(pi: ToolHost, phase: WorkflowPhase | null): void {
  if (typeof pi.getAllTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const all = pi.getAllTools();
  if (!phase) {
    pi.setActiveTools(all.map((t) => t.name));
    return;
  }
  const extensionTools = all
    .filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk")
    .map((t) => t.name);
  const allowed = getPhaseAllowedTools(phase, extensionTools);
  pi.setActiveTools(allowed);
}

export function normalizePathText(value: string): string {
  return value.replace(/\\/g, "/");
}

export function mentionsRuntimeExtensionPath(value: string): boolean {
  const normalized = normalizePathText(value);
  if (/(^|[\s"'=:(])target\/\.pi\/extensions(?:\/|$)/.test(normalized)) return false;
  if (normalized.includes("/target/.pi/extensions/")) return false;
  return /(^|[\s"'=:(])\.pi\/extensions(?:\/|$)/.test(normalized)
    || normalized.includes("/.pi/extensions/");
}

export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  return [];
}

export function isLikelyMutatingBash(command: string): boolean {
  if (!mentionsRuntimeExtensionPath(command)) return false;
  if (/(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|sed\s+-i|perl\s+-pi)\b/.test(command)) return true;
  const stripped = command
    .replace(/\d*&?>>?\/dev\/(null|zero|stdin|stdout|stderr)/g, "")
    .replace(/\d*>&\d+/g, "");
  return /(>|>>|\btee\b)/.test(stripped);
}

export function requiresExtensionMutationApproval(toolName: string, input: unknown): boolean {
  const lower = toolName.toLowerCase();
  if (lower === "bash") {
    const strings = collectStrings(input);
    if (!strings.some(mentionsRuntimeExtensionPath)) return false;
    return strings.some(isLikelyMutatingBash);
  }
  if (/^(edit|write|multi.?edit|apply.?patch)$/.test(lower)) {
    const pathValue = String((input as any)?.path ?? "");
    return mentionsRuntimeExtensionPath(pathValue);
  }
  return false;
}

export function formatExtensionMutationApprovalReason(toolName: string, input: unknown): string {
  const lower = toolName.toLowerCase();
  const targets = /^(edit|write|multi.?edit|apply.?patch)$/.test(lower)
    ? [String((input as any)?.path ?? "")].filter(Boolean)
    : collectStrings(input).filter(mentionsRuntimeExtensionPath).slice(0, 5);
  return [
    "── 🧩 EXTENSION MODIFICATION APPROVAL REQUIRED ─────",
    "",
    "  Writing or editing the running .pi/extensions/** runtime files requires explicit user approval.",
    "  target/.pi/extensions/** is deployment-template source in this repo and is not protected by this guard.",
    "  Read-only inspection is allowed; approval is checked in extension memory for this mutating tool call only.",
    "",
    `  Tool: ${toolName}`,
    ...targets.map((target) => `  Target: ${target.slice(0, 240)}`),
    "",
    "─────────────────────────────────────────────────────",
  ].join("\n");
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export function suggestWorkflowCommandTypo(input: string): string | null {
  const trimmed = input.trim();
  const match = /^\/(\S+)(.*)$/.exec(trimmed);
  if (!match) return null;
  const [, command, rest] = match;
  if (command === "workflow") return null;
  if (!command.startsWith("wor") && !command.startsWith("work")) return null;
  if (levenshtein(command, "workflow") > 2) return null;
  const corrected = `/workflow${rest ?? ""}`.trimEnd();
  return `알 수 없는 workflow 명령입니다. 혹시 \`${corrected}\`를 의도하셨나요? 자동 실행하지 않았습니다.`;
}
