/**
 * memory.ts — Pi Extension
 *
 * Small, user-governable external memory layer for LLM-augmented development.
 * MVP intentionally favors manual active memories, deterministic retrieval, and
 * tracking over broad automatic memory writing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type MemoryType = "fact" | "decision" | "convention" | "preference" | "constraint" | "lesson" | "pitfall" | "workflow" | "domain-knowledge" | "open-question";
type MemoryStatus = "candidate" | "active" | "disabled" | "deprecated" | "rejected" | "superseded";
type MemoryUseAs = "constraint" | "decision" | "preference" | "warning" | "context";
type FeedbackKind = "helpful" | "irrelevant" | "wrong" | "stale";

type MemoryEntry = {
  schemaVersion: 1;
  memoryId: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  scope: { level: "personal" | "project" | "team" | "workspace"; projectAnonymousId?: string; workspaceRoot?: string; appliesToBranches?: string[] };
  type: MemoryType;
  status: MemoryStatus;
  confidence: "low" | "medium" | "high" | "explicit";
  importance: "low" | "normal" | "high" | "critical";
  content: { summary: string; details?: string; do?: string[]; dont?: string[] };
  index: { topics: string[]; files: string[]; symbols?: string[]; appliesToPhases: string[]; language?: string[] };
  provenance: { source: string; createdBy: string; updatedBy?: string; evidence?: Array<{ kind: string; summary: string; ref?: string }> };
  governance: { userEditable: boolean; userDeletable: boolean; autoInject: "never" | "when-relevant" | "always"; requiresApprovalBeforeActive?: boolean; expiresAt?: string; supersedes?: string[]; supersededBy?: string };
  privacy: { sensitivity: "public" | "internal" | "confidential" | "secret"; redactionLevel: "none" | "paths-only" | "paths-and-identifiers" | "full-summary-only"; exportable: boolean; containsSecrets?: boolean; notes?: string };
  retrieval?: { useCount?: number; lastScore?: number; lastMatchedReason?: string };
  lifecycle: { lastVerifiedAt?: string; validUntil?: string; staleness: "fresh" | "aging" | "stale"; conflictsWith: string[]; mergeGroup?: string };
  rendering: { useAs: MemoryUseAs; stableRenderHash: string };
};

type MemoryMatch = { entry: MemoryEntry; score: number; matchedReasons: string[]; renderHash: string };
type SaveMemoryResult = { ok: true; entry: MemoryEntry } | { ok: false; message: string; reason: string };
type MemoryFileHealth = { label: string; file: string; exists: boolean; ok: boolean; count?: number; error?: string };

const MEMORY_POLICY = [
  "",
  "[External Memory Policy v1]",
  "External memory may be provided in a later block.",
  "Use active constraints/decisions only when relevant.",
  "Do not treat candidate memory as fact.",
  "If memory conflicts with current user instruction or current code, ask or prefer the latest explicit user instruction.",
  "[/External Memory Policy]",
].join("\n");

export default function (pi: ExtensionAPI) {
  const state = {
    lastInjection: null as null | {
      timestamp: string;
      requestHash: string;
      selectedMemoryIds: string[];
      selectedRenderHashes: string[];
      dynamicBlockHash: string;
      matchedReasons: Record<string, string[]>;
    },
  };

  pi.registerTool({
    name: "memory_remember",
    label: "Remember external memory",
    description: [
      "Save durable, reusable project memory for future prompts.",
      "Use for explicit user memory intent or high-value lessons/rules that should persist across sessions.",
      "Do not use for raw secrets, credentials, one-off transient facts, or unverified guesses.",
    ].join(" "),
    parameters: Type.Object({
      text: Type.String({ description: "Durable memory text to save. Must not contain raw secrets or credentials." }),
    }),
    async execute(_toolCallId, params) {
      const text = String(params.text ?? "").trim();
      if (!text) {
        return { content: [{ type: "text", text: "Memory not saved: text is required." }], details: { ok: false } };
      }
      const saved = saveMemoryText(text, "memory_remember");
      if (!saved.ok) {
        return { content: [{ type: "text", text: saved.message }], details: { ok: false, reason: saved.reason } };
      }
      return {
        content: [{ type: "text", text: formatSavedMemoryToolResult(saved.entry) }],
        details: { ok: true, memoryId: saved.entry.memoryId, status: saved.entry.status, path: entriesFile() },
      };
    },
  });

  pi.registerCommand("memory", {
    description: "Manage external memory used for task-specific LLM context.",
    getArgumentCompletions: (prefix) => [
      "list", "search", "show", "remember", "disable", "enable", "delete", "explain", "doctor", "stats", "feedback", "missed",
    ].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command = "list", ...rest] = trimmed.split(/\s+/).filter(Boolean);
      const body = trimmed.slice(command.length).trim();

      if (command === "remember") {
        if (!body) return ctx.ui.notify("Usage: /memory remember <durable memory text>", "warning");
        const saved = saveMemoryText(body, "remember");
        if (!saved.ok) return ctx.ui.notify(saved.message, "warning");
        return ctx.ui.notify(`Memory saved: ${saved.entry.memoryId}\n${renderEntryLine(saved.entry)}`, "info");
      }

      if (command === "list") {
        const entries = readEntries().filter((entry) => ["active", "disabled", "deprecated", "superseded"].includes(entry.status));
        return ctx.ui.notify(formatMemoryList(entries.slice(-20)), "info");
      }

      if (command === "search") {
        if (!body) return ctx.ui.notify("Usage: /memory search <query>", "warning");
        const matches = searchMemory(body, { includeDisabled: true, limit: 10 });
        appendMetric(metricFromMatches("search", body, matches, matches));
        return ctx.ui.notify(formatMatches(matches), "info");
      }

      if (command === "show") {
        const id = rest[0];
        const entry = id ? findEntry(id) : null;
        return ctx.ui.notify(entry ? JSON.stringify(entry, null, 2) : `Memory not found: ${id ?? "<missing id>"}`, entry ? "info" : "warning");
      }

      if (command === "disable" || command === "enable" || command === "delete") {
        const id = rest[0];
        if (!id) return ctx.ui.notify(`Usage: /memory ${command} <id>`, "warning");
        const existing = findEntry(id);
        if (!existing) return ctx.ui.notify(`Memory not found: ${id}`, "warning");
        if (command === "enable") {
          const blockers = enableBlockers(existing);
          if (blockers.length > 0) return ctx.ui.notify(`Memory ${id} cannot be enabled:\n- ${blockers.join("\n- ")}`, "warning");
        }
        const status: MemoryStatus = command === "enable" ? "active" : command === "delete" ? "deprecated" : "disabled";
        const updated = updateEntry(id, (entry) => ({
          ...entry,
          status,
          updatedAt: nowIso(),
          governance: { ...entry.governance, autoInject: status === "active" ? "when-relevant" : "never" },
        }));
        if (!updated) return ctx.ui.notify(`Memory not found: ${id}`, "warning");
        appendAudit(command, id, { status });
        if (command !== "enable" && wasRecentlyInjected(id)) appendFeedback(id, command === "delete" ? "wrong" : "irrelevant", "inferred from immediate user action after injection");
        return ctx.ui.notify(`Memory ${id} ${command === "delete" ? "deprecated" : status}.`, "info");
      }

      if (command === "feedback") {
        const id = rest[0];
        const kind = rest[1] as FeedbackKind | undefined;
        if (!id || !kind || !["helpful", "irrelevant", "wrong", "stale"].includes(kind)) {
          return ctx.ui.notify("Usage: /memory feedback <id> helpful|irrelevant|wrong|stale", "warning");
        }
        appendFeedback(id, kind, body.split(/\s+/).slice(2).join(" "));
        if (kind === "wrong") updateEntry(id, (entry) => ({ ...entry, status: "disabled", updatedAt: nowIso(), governance: { ...entry.governance, autoInject: "never" } }));
        if (kind === "stale") updateEntry(id, (entry) => ({ ...entry, updatedAt: nowIso(), lifecycle: { ...entry.lifecycle, staleness: "stale" }, governance: { ...entry.governance, autoInject: "never" } }));
        appendMetric({ operation: "feedback", selectedMemoryIds: [id], feedback: kind });
        return ctx.ui.notify(`Memory feedback recorded: ${id} ${kind}`, "info");
      }

      if (command === "missed") {
        if (!body) return ctx.ui.notify("Usage: /memory missed <query-or-description>", "warning");
        appendJsonl(feedbackFile(), { schemaVersion: 1, timestamp: nowIso(), kind: "missed", descriptionHash: sha256(body), descriptionPreview: body.slice(0, 160) });
        appendMetric({ operation: "feedback", requestHash: sha256(body), missed: true });
        return ctx.ui.notify("Missed-memory feedback recorded. Use /memory search to locate or /memory remember to add it.", "info");
      }

      if (command === "explain") {
        return ctx.ui.notify(formatExplain(state.lastInjection ?? readInjectionState()), "info");
      }

      if (command === "doctor") {
        return ctx.ui.notify(formatDoctor(), "info");
      }

      if (command === "stats") {
        return ctx.ui.notify(formatStats(), "info");
      }

      return ctx.ui.notify("Usage: /memory list|search|show|remember|disable|enable|delete|explain|doctor|stats|feedback|missed", "warning");
    },
  });

  pi.on("before_agent_start", async (event) => {
    const request = extractRequestText(event as any);
    const matches = request ? searchMemory(request, { includeDisabled: false, limit: 12 }) : [];
    const selected = selectMemories(request, matches, 3);
    const dynamic = renderMemoryBlock(selected);
    const injection = { timestamp: nowIso(), requestHash: sha256(request), selectedMemoryIds: selected.map((m) => m.entry.memoryId), selectedRenderHashes: selected.map((m) => m.renderHash), dynamicBlockHash: sha256(dynamic), matchedReasons: Object.fromEntries(selected.map((m) => [m.entry.memoryId, m.matchedReasons])) };
    state.lastInjection = injection;
    writeJson(injectionStateFile(), injection);
    appendMetric(metricFromMatches("inject", request, matches, selected, dynamic));
    return { systemPrompt: event.systemPrompt + MEMORY_POLICY + dynamic };
  });
}

function projectRoot(): string {
  if (process.env.HARNESS_MEMORY_ROOT) return process.env.HARNESS_MEMORY_ROOT;
  try { return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return process.cwd(); }
}

function memoryDir(): string { return path.join(projectRoot(), ".project-memory", "memory"); }
function entriesFile(): string { return path.join(memoryDir(), "entries.jsonl"); }
function auditFile(): string { return path.join(memoryDir(), "audit.jsonl"); }
function metricsFile(): string { return path.join(memoryDir(), "metrics.jsonl"); }
function feedbackFile(): string { return path.join(memoryDir(), "feedback.jsonl"); }
function injectionStateFile(): string { return path.join(memoryDir(), "injection-state.json"); }
function nowIso(): string { return new Date().toISOString(); }
function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256Prefixed(value: string): string { return `sha256:${sha256(value)}`; }

function ensureDir(file: string): void { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function appendJsonl(file: string, value: any): void { ensureProjectMemoryIgnored(); ensureDir(file); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf-8"); }
function readJsonl(file: string): any[] { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
function writeJson(file: string, value: any): void { ensureDir(file); fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8"); }
function readJson(file: string): any | null { try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; } }

function saveMemoryText(text: string, source: string): SaveMemoryResult {
  const body = normalizeWhitespace(text);
  if (!body) return { ok: false, message: "Memory not saved: text is required.", reason: "empty-input" };
  if (mayContainSecret(body)) {
    appendMetric({ operation: source, rejected: "secret-like-input", requestHash: sha256(body) });
    return { ok: false, message: "Memory not saved: secret-like text was detected. Redact the secret first, then save memory again.", reason: "secret-like-input" };
  }
  ensureProjectMemoryIgnored();
  const entry = createMemory(body);
  appendJsonl(entriesFile(), entry);
  appendAudit("create", entry.memoryId, { source });
  appendMetric({ operation: source, selectedMemoryIds: [entry.memoryId], selectedRenderHashes: [entry.rendering.stableRenderHash] });
  return { ok: true, entry };
}

function formatSavedMemoryToolResult(entry: MemoryEntry): string {
  return [
    `Memory saved: ${entry.memoryId}`,
    `status=${entry.status}`,
    `summary=${entry.content.summary}`,
    `path=${entriesFile()}`,
  ].join("\n");
}

function ensureProjectMemoryIgnored(): void {
  const root = projectRoot();
  const exclude = path.join(root, ".git", "info", "exclude");
  try {
    if (!fs.existsSync(path.join(root, ".git"))) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf-8") : "";
    if (!/^\.project-memory\/$/m.test(current)) {
      fs.appendFileSync(exclude, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.project-memory/\n`, "utf-8");
    }
  } catch {
    // Ignore protection is best-effort; memory storage still works in non-git dirs.
  }
}

function readEntries(): MemoryEntry[] { return readJsonl(entriesFile()) as MemoryEntry[]; }
function findEntry(id: string): MemoryEntry | null { return readEntries().find((entry) => entry.memoryId === id) ?? null; }

function rewriteEntries(entries: MemoryEntry[]): void {
  ensureDir(entriesFile());
  fs.writeFileSync(entriesFile(), entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), "utf-8");
}

function updateEntry(id: string, updater: (entry: MemoryEntry) => MemoryEntry): MemoryEntry | null {
  const entries = readEntries();
  const index = entries.findIndex((entry) => entry.memoryId === id);
  if (index < 0) return null;
  entries[index] = withRenderHash(updater(entries[index]));
  rewriteEntries(entries);
  return entries[index];
}

function createMemory(text: string): MemoryEntry {
  const timestamp = nowIso();
  const memoryId = `mem_${timestamp.replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomBytes(3).toString("hex")}`;
  const summary = normalizeWhitespace(text).slice(0, 500);
  const type = inferType(summary);
  const useAs = inferUseAs(type, summary);
  const containsSecrets = mayContainSecret(summary);
  const entry: MemoryEntry = {
    schemaVersion: 1,
    memoryId,
    createdAt: timestamp,
    updatedAt: timestamp,
    scope: { level: "project", workspaceRoot: "<PROJECT_ROOT>" },
    type,
    status: containsSecrets ? "disabled" : "active",
    confidence: "explicit",
    importance: summary.includes("절대") || /must|never|required/i.test(summary) ? "high" : "normal",
    content: { summary },
    index: { topics: extractTopics(summary), files: extractFiles(summary), symbols: [], appliesToPhases: extractPhases(summary) },
    provenance: { source: "user-explicit", createdBy: "user", evidence: [{ kind: "user-message", summary: "Created through /memory remember." }] },
    governance: { userEditable: true, userDeletable: true, autoInject: containsSecrets ? "never" : "when-relevant", requiresApprovalBeforeActive: false },
    privacy: { sensitivity: containsSecrets ? "secret" : "internal", redactionLevel: "paths-only", exportable: false, containsSecrets, notes: containsSecrets ? "Potential secret-like text detected; auto-injection and export disabled." : undefined },
    retrieval: { useCount: 0 },
    lifecycle: { lastVerifiedAt: timestamp, staleness: "fresh", conflictsWith: [] },
    rendering: { useAs, stableRenderHash: "sha256:" + "0".repeat(64) },
  };
  return withRenderHash(entry);
}

function withRenderHash(entry: MemoryEntry): MemoryEntry {
  const stable = stableRender(entry);
  return { ...entry, rendering: { ...entry.rendering, stableRenderHash: sha256Prefixed(stable) } };
}

function inferType(text: string): MemoryType {
  if (/결정|decision/i.test(text)) return "decision";
  if (/절대|금지|must not|never/i.test(text)) return "constraint";
  if (/선호|prefer|preference|좋아/i.test(text)) return "preference";
  if (/pitfall|주의|실패|깨짐|broken|failed/i.test(text)) return "pitfall";
  if (/workflow|phase|gate/i.test(text)) return "workflow";
  return "fact";
}

function inferUseAs(type: MemoryType, text: string): MemoryUseAs {
  if (type === "constraint") return "constraint";
  if (type === "decision") return "decision";
  if (type === "preference" || /prefer/i.test(text)) return "preference";
  if (type === "pitfall") return "warning";
  return "context";
}

function normalizeWhitespace(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function tokenize(value: string): string[] { return Array.from(new Set(value.toLowerCase().match(/[a-z0-9가-힣_.\/-]{2,}/g) ?? [])); }
function extractTopics(value: string): string[] { return tokenize(value).filter((token) => !token.includes("/") && !token.includes(".")).slice(0, 20); }
function extractFiles(value: string): string[] { return Array.from(new Set(value.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [])).slice(0, 20); }
function extractPhases(value: string): string[] {
  const phases = ["interview", "plan", "plan_review", "implement", "code_review", "review_approved", "document", "commit", "push", "done"];
  const lower = value.toLowerCase();
  const found = phases.filter((phase) => lower.includes(phase));
  return found.length ? found : ["any"];
}
function mayContainSecret(value: string): boolean { return /(api[_-]?key|secret|token|password|passwd|authorization|bearer\s+[a-z0-9._-]+|BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY|AKIA[0-9A-Z]{16})/i.test(value); }

function enableBlockers(entry: MemoryEntry): string[] {
  const blockers: string[] = [];
  if (entry.privacy.containsSecrets || entry.privacy.sensitivity === "secret" || mayContainSecret(`${entry.content.summary} ${entry.content.details ?? ""}`)) blockers.push("secret-like content is present; create a redacted replacement instead");
  if (entry.lifecycle.staleness === "stale") blockers.push("memory is marked stale; edit or replace it before enabling");
  if (entry.lifecycle.conflictsWith.length > 0) blockers.push(`memory conflicts with: ${entry.lifecycle.conflictsWith.join(", ")}`);
  if (entry.governance.supersededBy) blockers.push(`memory is superseded by ${entry.governance.supersededBy}`);
  return blockers;
}

function searchMemory(query: string, options: { includeDisabled: boolean; limit: number }): MemoryMatch[] {
  const queryTokens = tokenize(query);
  const entries = readEntries().filter((entry) => {
    if (entry.lifecycle?.staleness === "stale") return false;
    if (["rejected", "deprecated", "superseded"].includes(entry.status)) return false;
    if (!options.includeDisabled && entry.status !== "active") return false;
    if (!options.includeDisabled && entry.governance.autoInject === "never") return false;
    return true;
  });
  return entries.map((entry) => scoreEntry(entry, queryTokens, query)).filter((match) => match.score > 0).sort((a, b) => b.score - a.score || a.entry.memoryId.localeCompare(b.entry.memoryId)).slice(0, options.limit);
}

function scoreEntry(entry: MemoryEntry, queryTokens: string[], rawQuery: string): MemoryMatch {
  const reasons: string[] = [];
  let score = 0;
  const haystack = tokenize([entry.content.summary, entry.content.details ?? "", entry.index.topics.join(" "), entry.index.files.join(" "), entry.index.symbols?.join(" ") ?? ""].join(" "));
  const overlap = queryTokens.filter((token) => haystack.includes(token));
  if (overlap.length) { score += Math.min(6, overlap.length * 2); reasons.push("keyword"); }
  if (entry.index.files.some((file) => rawQuery.includes(file))) { score += 5; reasons.push("file"); }
  if (entry.index.appliesToPhases.some((phase) => phase !== "any" && rawQuery.toLowerCase().includes(phase))) { score += 2; reasons.push("phase"); }
  if (["constraint", "decision"].includes(entry.rendering.useAs)) score += 1;
  if (entry.importance === "critical") score += 2;
  if (entry.importance === "high") score += 1;
  if (entry.confidence === "explicit") score += 1;
  return { entry, score, matchedReasons: reasons, renderHash: entry.rendering.stableRenderHash };
}

function selectMemories(request: string, matches: MemoryMatch[], limit: number): MemoryMatch[] {
  if (!request) return [];
  const previous = readInjectionState();
  const stickyIds = new Set<string>(previous?.selectedMemoryIds ?? []);
  return matches
    .map((match) => ({ ...match, score: match.score + (stickyIds.has(match.entry.memoryId) ? 1 : 0) }))
    .filter((match) => match.score >= 3)
    .sort((a, b) => b.score - a.score || stableRender(a.entry).localeCompare(stableRender(b.entry)))
    .slice(0, limit)
    .sort((a, b) => renderPriority(a.entry) - renderPriority(b.entry) || a.entry.memoryId.localeCompare(b.entry.memoryId));
}

function renderPriority(entry: MemoryEntry): number {
  return { constraint: 0, decision: 1, warning: 2, preference: 3, context: 4 }[entry.rendering.useAs];
}

function stableRender(entry: MemoryEntry): string {
  return `${entry.memoryId} | ${entry.type} | ${entry.importance} | ${entry.rendering.useAs} | ${entry.content.summary}`;
}

function renderMemoryBlock(matches: MemoryMatch[]): string {
  if (matches.length === 0) return "";
  return [
    "",
    "[External Memory Context v1]",
    ...matches.map((match) => `- ${stableRender(match.entry)}`),
    "[/External Memory Context]",
  ].join("\n");
}

function renderEntryLine(entry: MemoryEntry): string { return `- ${entry.memoryId} | ${entry.status} | ${entry.type} | ${entry.importance} | ${entry.content.summary}`; }
function formatMemoryList(entries: MemoryEntry[]): string { return entries.length ? ["🧠 External memory", ...entries.map(renderEntryLine)].join("\n") : "🧠 External memory\nNo memories found."; }
function formatMatches(matches: MemoryMatch[]): string { return matches.length ? ["🔎 Memory search", ...matches.map((m) => `${renderEntryLine(m.entry)}\n  score=${m.score}; reasons=${m.matchedReasons.join(",") || "unknown"}`)].join("\n") : "🔎 Memory search\nNo matches."; }
function formatExplain(injection: any): string {
  if (!injection || !injection.selectedMemoryIds?.length) return "🧠 Memory explain\nNo memory was injected for the latest prompt.";
  return [
    "🧠 Memory explain",
    `Request hash: ${injection.requestHash}`,
    `Dynamic block hash: ${injection.dynamicBlockHash}`,
    ...injection.selectedMemoryIds.map((id: string, index: number) => `- ${id} | ${injection.selectedRenderHashes?.[index] ?? "unknown"} | reasons=${(injection.matchedReasons?.[id] ?? []).join(",") || "unknown"}`),
  ].join("\n");
}

function appendAudit(action: string, memoryId: string, data: any = {}): void { appendJsonl(auditFile(), { schemaVersion: 1, timestamp: nowIso(), action, memoryId, ...data }); }
function appendMetric(data: any): void { appendJsonl(metricsFile(), { schemaVersion: 1, timestamp: nowIso(), ...data }); }
function appendFeedback(memoryId: string, kind: FeedbackKind, note = ""): void { appendJsonl(feedbackFile(), { schemaVersion: 1, timestamp: nowIso(), memoryId, kind, noteHash: sha256(note), notePreview: note.slice(0, 160) }); }

function metricFromMatches(operation: string, request: string, candidates: MemoryMatch[], selected: MemoryMatch[], dynamic = ""): any {
  const reasonCounts: Record<string, number> = {};
  for (const match of selected) for (const reason of match.matchedReasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const previous = readInjectionState();
  const previousIds = JSON.stringify(previous?.selectedMemoryIds ?? []);
  const selectedIds = selected.map((m) => m.entry.memoryId);
  return {
    operation,
    requestHash: sha256(request),
    candidateCount: candidates.length,
    selectedMemoryIds: selectedIds,
    selectedRenderHashes: selected.map((m) => m.renderHash),
    stickySetReused: previousIds === JSON.stringify(selectedIds),
    dynamicBlockHash: sha256(dynamic),
    cacheChurn: !previous ? "none" : previousIds === JSON.stringify(selectedIds) ? "none" : "high",
    matchedReasons: reasonCounts,
    excludedCounts: { belowThreshold: Math.max(0, candidates.length - selected.length) },
  };
}

function wasRecentlyInjected(id: string): boolean {
  const injection = readInjectionState();
  if (!injection?.timestamp) return false;
  return injection.selectedMemoryIds?.includes(id) && Date.now() - Date.parse(injection.timestamp) < 10 * 60_000;
}
function readInjectionState(): any { return readJson(injectionStateFile()); }

function inspectJsonlFile(label: string, file: string): MemoryFileHealth {
  if (!fs.existsSync(file)) return { label, file, exists: false, ok: true, count: 0 };
  try {
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) JSON.parse(line);
    return { label, file, exists: true, ok: true, count: lines.length };
  } catch (error) {
    return { label, file, exists: true, ok: false, error: String(error).slice(0, 200) };
  }
}

function inspectJsonFile(label: string, file: string): MemoryFileHealth {
  if (!fs.existsSync(file)) return { label, file, exists: false, ok: true };
  try {
    JSON.parse(fs.readFileSync(file, "utf-8"));
    return { label, file, exists: true, ok: true };
  } catch (error) {
    return { label, file, exists: true, ok: false, error: String(error).slice(0, 200) };
  }
}

function formatFileHealth(item: MemoryFileHealth): string {
  const state = item.exists ? (item.ok ? "ok" : "parse-error") : "missing";
  const count = typeof item.count === "number" ? ` count=${item.count}` : "";
  const error = item.error ? ` error=${item.error}` : "";
  return `- ${item.label}: ${state}${count} path=${item.file}${error}`;
}

function formatDoctor(): string {
  const entries = readEntries();
  const countsByStatus = countBy(entries, (entry) => entry.status);
  const statusSummary = Object.entries(countsByStatus).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
  const injection = readInjectionState();
  const recentIds = injection?.selectedMemoryIds ?? [];
  const recentReasons = Array.from(new Set(recentIds.flatMap((id: string) => injection?.matchedReasons?.[id] ?? [])));
  const fileHealth = [
    inspectJsonlFile("entries.jsonl", entriesFile()),
    inspectJsonlFile("audit.jsonl", auditFile()),
    inspectJsonlFile("metrics.jsonl", metricsFile()),
    inspectJsonlFile("feedback.jsonl", feedbackFile()),
    inspectJsonFile("injection-state.json", injectionStateFile()),
  ];
  return [
    "🩺 Memory doctor",
    `Project root: ${projectRoot()}`,
    `Memory dir: ${memoryDir()}`,
    "File health:",
    ...fileHealth.map(formatFileHealth),
    `Entry counts: total=${entries.length}${statusSummary === "none" ? "" : ` (${statusSummary})`}`,
    entries.length ? "" : "No memory entries saved.",
    "Recent injection:",
    `- ids=${recentIds.length ? recentIds.join(",") : "none"}`,
    `- reasons=${recentReasons.length ? recentReasons.join(",") : "none"}`,
    `- matched=${recentIds.map((id: string) => `${id}:${(injection?.matchedReasons?.[id] ?? []).join(",") || "unknown"}`).join("; ") || "none"}`,
    `- Dynamic block hash: ${injection?.dynamicBlockHash ?? "none"}`,
    `- Request hash: ${injection?.requestHash ?? "none"}`,
  ].filter((line) => line !== "").join("\n");
}

function formatStats(): string {
  const entries = readEntries();
  const metrics = readJsonl(metricsFile());
  const feedback = readJsonl(feedbackFile());
  const injections = metrics.filter((m) => m.operation === "inject");
  const avgSelected = injections.length ? injections.reduce((sum, m) => sum + (m.selectedMemoryIds?.length ?? 0), 0) / injections.length : 0;
  const stickyReuse = injections.length ? injections.filter((m) => m.stickySetReused).length / injections.length : 0;
  const countsByStatus = countBy(entries, (entry) => entry.status);
  const feedbackCounts = countBy(feedback, (item) => item.kind ?? "unknown");
  return [
    "📊 Memory stats",
    `- memories: ${entries.length} (${Object.entries(countsByStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`,
    `- injections: ${injections.length}`,
    `- avg selected memories: ${avgSelected.toFixed(2)}`,
    `- sticky reuse rate: ${(stickyReuse * 100).toFixed(1)}%`,
    `- feedback: ${Object.entries(feedbackCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
  ].join("\n");
}
function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> { return items.reduce((acc, item) => { const key = keyFn(item); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {} as Record<string, number>); }

function extractRequestText(event: any): string {
  const direct = event.userPrompt ?? event.prompt ?? event.input ?? event.request;
  if (typeof direct === "string") return direct;
  if (Array.isArray(event.messages)) {
    const last = [...event.messages].reverse().find((message) => message?.role === "user");
    if (typeof last?.content === "string") return last.content;
  }
  return "";
}
