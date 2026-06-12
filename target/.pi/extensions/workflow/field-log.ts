import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowInstance, WorkflowPhase } from "./types";
import { getBranch, getGitRoot } from "./git";
import { banner, table } from "./ui";

// This file lives at: <harness-root>/.pi/extensions/workflow/field-log.ts
const HARNESS_ROOT = path.resolve(__dirname, "../../..");
const MEMORY_DIR = path.join(".project-memory", "harness");
const EVENTS_FILE = "events.jsonl";
const AUDIT_FILE = "audit.jsonl";

// Cache stable runtime values that don't change during a session.
const _runtimeCache: { harnessVersion?: string; pythonVersion?: string } = {};

export type FieldLogCategory = "dpaa" | "code-quality" | "push-policy" | "workspace" | "phase" | "init" | "update" | "doctor" | "test" | "tool" | "prompt" | "user-correction" | "unknown";
export type FieldLogEventType = "gate.failed" | "gate.skipped" | "tool.failed" | "test.failed" | "phase.violation" | "phase.transition" | "policy.blocked" | "doctor.failed" | "update.failed" | "user.correction" | "rollback.performed" | "lesson.proposed" | "failure.resolved";
export type FieldLogImprovementKind = "schema" | "dpaa-rule" | "workflow-rule" | "doctor-check" | "init-update" | "prompt-instruction" | "test-coverage" | "docs" | "unknown";

export type WriteFieldLogInput = {
  type: FieldLogEventType;
  category: FieldLogCategory;
  severity: "info" | "warning" | "major" | "critical" | "blocker";
  status?: "open" | "resolved" | "accepted-risk" | "superseded";
  workflow?: WorkflowInstance | null;
  fromPhase?: WorkflowPhase | string;
  toPhase?: WorkflowPhase | string;
  summary: string;
  expected: string;
  actual: string;
  impact: string;
  rootCause?: string | null;
  resolution?: string | null;
  primaryMessage: string;
  exitCode?: number | null;
  command?: string | null;
  findingCodes?: string[];
  files?: Array<{ path: string; role: "input" | "output" | "changed" | "config" | "log" | "test" | "unknown"; sha256?: string }>;
  logExcerpt?: string | null;
  improvementKind?: FieldLogImprovementKind;
  problemForHarnessRepo?: string;
  reproductionHint?: string;
  candidateChange?: string;
  targetFilesHint?: string[];
  acceptanceCriteria?: string[];
  negativeExamples?: string[];
  sensitive?: boolean;
};

export type FieldLogEvent = ReturnType<typeof buildFieldLogEvent>;

export type AuditEventType = "transition" | "guard_block" | "guard_skip" | "approval_boundary_anomaly";

export type WriteAuditLogInput = {
  eventType: AuditEventType;
  workflow?: WorkflowInstance | null;
  workflowId?: string | null;
  phase?: WorkflowPhase | string | null;
  fromPhase?: WorkflowPhase | string | null;
  toPhase?: WorkflowPhase | string | null;
  gate?: string | null;
  result?: string | null;
  severity?: "info" | "warning" | "major" | "critical" | "blocker";
  reasonSummary?: string | null;
};

function projectRoot(): string {
  return process.env.HARNESS_FIELD_LOG_ROOT || getGitRoot() || process.cwd();
}

function ensureProjectMemoryIgnored(root: string): void {
  const exclude = path.join(root, ".git", "info", "exclude");
  try {
    if (!fs.existsSync(path.join(root, ".git"))) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf-8") : "";
    if (!/^\.project-memory\/$/m.test(current)) {
      fs.appendFileSync(exclude, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}.project-memory/\n`, "utf-8");
    }
  } catch {
    // Best-effort only; logging must not block gates.
  }
}

function fieldLogDir(root: string = projectRoot()): string {
  return path.join(root, MEMORY_DIR);
}

function fieldLogPath(root: string = projectRoot()): string {
  return path.join(fieldLogDir(root), EVENTS_FILE);
}

function auditLogPath(root: string = projectRoot()): string {
  return path.join(fieldLogDir(root), AUDIT_FILE);
}

function exportDir(root: string = projectRoot()): string {
  return path.join(fieldLogDir(root), "exports");
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function ensureProjectAnonymousId(root: string): string {
  const dir = fieldLogDir(root);
  const idPath = path.join(dir, "project-id");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(idPath)) return fs.readFileSync(idPath, "utf-8").trim();
  const basis = `${root}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`;
  const id = `proj_${shortHash(basis)}`;
  fs.writeFileSync(idPath, `${id}\n`, "utf-8");
  return id;
}

function commandOutput(command: string, cwd: string = HARNESS_ROOT): string | undefined {
  try {
    return execSync(command, { cwd, encoding: "utf-8", stdio: "pipe" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function detectRepoKind(root: string): "java-spring" | "node" | "python" | "go" | "mixed" | "unknown" {
  const has = (file: string) => fs.existsSync(path.join(root, file));
  const kinds = [
    has("pom.xml") || has("build.gradle") || has("build.gradle.kts") ? "java-spring" : null,
    has("package.json") ? "node" : null,
    has("pyproject.toml") || has("requirements.txt") ? "python" : null,
    has("go.mod") ? "go" : null,
  ].filter(Boolean) as string[];
  if (kinds.length > 1) return "mixed";
  return (kinds[0] as any) ?? "unknown";
}

function redact(value: string, root: string): string {
  const normalizedRoot = root.replace(/\\/g, "/");
  return value
    .replaceAll(root, "<PROJECT_ROOT>")
    .replaceAll(normalizedRoot, "<PROJECT_ROOT>")
    .replace(/https?:\/\/[^\s]+/g, "<URL>");
}

function limit(value: string | null | undefined, max = 2000): string | null {
  if (value == null) return null;
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function hintsFor(category: FieldLogCategory): Pick<WriteFieldLogInput, "improvementKind" | "targetFilesHint"> {
  if (category === "dpaa") return {
    improvementKind: "dpaa-rule",
    targetFilesHint: ["target/.pi/dpaa/rules/", "target/.pi/dpaa/layers/", "target/.pi/dpaa/suggestions/templates.yaml", "tests/test_verification.py"],
  };
  if (category === "code-quality") return {
    improvementKind: "doctor-check",
    targetFilesHint: ["target/.pi/extensions/workflow/gates.ts", "target/.pi/extensions/workflow/catalog.ts", "tests/test_code_quality_gate.py"],
  };
  if (category === "push-policy") return {
    improvementKind: "workflow-rule",
    targetFilesHint: ["target/.pi/extensions/workflow/gates.ts", "tests/test_push_policy_scan.py"],
  };
  if (category === "workspace" || category === "phase") return {
    improvementKind: "workflow-rule",
    targetFilesHint: ["target/.pi/extensions/workflow.ts", "target/.pi/extensions/workflow/gates.ts", "tests/test_workflow_extension_runtime.py"],
  };
  if (category === "doctor") return {
    improvementKind: "doctor-check",
    targetFilesHint: ["target/.pi/extensions/workflow/catalog.ts", "scripts/harness-doctor.sh", "scripts/harness-doctor.ps1"],
  };
  if (category === "init" || category === "update") return {
    improvementKind: "init-update",
    targetFilesHint: ["scripts/init-target-harness.sh", "scripts/init-target-harness.ps1", "scripts/update-harness.sh", "scripts/update-harness.ps1"],
  };
  return { improvementKind: "unknown", targetFilesHint: [] };
}

function buildFieldLogEvent(input: WriteFieldLogInput) {
  const root = projectRoot();
  const workflow = input.workflow;
  const branch = getBranch(root);
  const defaults = hintsFor(input.category);
  const eventId = `hlog_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomBytes(4).toString("hex")}`;
  const redactedFiles = (input.files ?? []).map((file) => ({ ...file, path: redact(file.path, root) }));

  return {
    schemaVersion: 1,
    eventId,
    timestamp: new Date().toISOString(),
    harness: {
      version: (_runtimeCache.harnessVersion ??= commandOutput(`git -C "${HARNESS_ROOT}" rev-parse --short HEAD`) ?? "unknown"),
      gitCommit: commandOutput("git rev-parse --short HEAD") ?? "unknown",
      runtime: {
        host: "pi",
        platform: process.platform,
        nodeVersion: process.version,
        pythonVersion: (_runtimeCache.pythonVersion ??= commandOutput("python --version") ?? commandOutput("python3 --version")),
      },
    },
    project: {
      anonymousId: ensureProjectAnonymousId(root),
      repoKind: detectRepoKind(root),
      branch,
      worktree: redact(root, root),
      gitHead: commandOutput(`git -C "${root}" rev-parse --short HEAD`, root),
    },
    workflow: {
      workflowId: workflow?.id ?? "none",
      phase: workflow?.phase ?? "none",
      fromPhase: input.fromPhase,
      toPhase: input.toPhase,
    },
    event: {
      type: input.type,
      category: input.category,
      severity: input.severity,
      status: input.status ?? "open",
    },
    failure: {
      summary: redact(input.summary, root),
      expected: redact(input.expected, root),
      actual: redact(input.actual, root),
      impact: redact(input.impact, root),
      rootCause: input.rootCause ? redact(input.rootCause, root) : null,
      resolution: input.resolution ? redact(input.resolution, root) : null,
      evidence: {
        primaryMessage: redact(input.primaryMessage, root),
        exitCode: input.exitCode ?? null,
        command: input.command ? redact(input.command, root) : null,
        findingCodes: input.findingCodes ?? [],
        files: redactedFiles,
        logExcerpt: limit(input.logExcerpt ? redact(input.logExcerpt, root) : null, 2000),
      },
    },
    llmAnalysisPacket: {
      problemForHarnessRepo: input.problemForHarnessRepo ?? `PENDING: analyze ${input.category} ${input.type} for harness improvement potential.`,
      reproductionHint: input.reproductionHint ?? "PENDING: derive a minimal reproduction from the evidence fields.",
      improvementKind: input.improvementKind ?? defaults.improvementKind ?? "unknown",
      candidateChange: input.candidateChange ?? "PENDING: propose a concrete harness repo change.",
      targetFilesHint: input.targetFilesHint ?? defaults.targetFilesHint ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? ["Harness improvement has a regression test covering this failure pattern."],
      negativeExamples: input.negativeExamples ?? [],
    },
    privacy: {
      redactionLevel: "paths-only",
      containsSensitiveData: Boolean(input.sensitive),
      exportableToHarnessRepo: !input.sensitive,
      redactionNotes: "Absolute project paths and URLs are redacted. Raw full logs are not embedded.",
    },
  };
}

function auditEventFromFieldLog(input: WriteFieldLogInput): WriteAuditLogInput | null {
  if (input.type === "gate.failed") {
    return {
      eventType: "guard_block",
      workflow: input.workflow,
      phase: input.workflow?.phase,
      fromPhase: input.fromPhase,
      toPhase: input.toPhase,
      gate: input.category,
      result: "blocked",
      severity: input.severity,
      reasonSummary: input.summary,
    };
  }
  if (input.type === "gate.skipped") {
    return {
      eventType: "guard_skip",
      workflow: input.workflow,
      phase: input.workflow?.phase,
      fromPhase: input.fromPhase,
      toPhase: input.toPhase,
      gate: input.category,
      result: "skipped",
      severity: input.severity,
      reasonSummary: input.summary,
    };
  }
  return null;
}

export function writeAuditLogEvent(input: WriteAuditLogInput): string | null {
  try {
    const root = projectRoot();
    ensureProjectMemoryIgnored(root);
    const workflow = input.workflow;
    const event = {
      timestamp: new Date().toISOString(),
      eventType: input.eventType,
      workflowId: input.workflowId ?? workflow?.id ?? "none",
      phase: input.phase ?? workflow?.phase ?? null,
      fromPhase: input.fromPhase ?? null,
      toPhase: input.toPhase ?? null,
      gate: input.gate ?? null,
      result: input.result ?? null,
      severity: input.severity ?? "info",
      reasonSummary: limit(input.reasonSummary ? redact(input.reasonSummary, root) : null, 500),
    };
    const file = auditLogPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
    return event.timestamp;
  } catch {
    // Audit logging must never block workflow progress.
    return null;
  }
}

export function writeFieldLogEvent(input: WriteFieldLogInput): string | null {
  try {
    const root = projectRoot();
    ensureProjectMemoryIgnored(root);
    const event = buildFieldLogEvent(input);
    const file = fieldLogPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
    const auditEvent = auditEventFromFieldLog(input);
    if (auditEvent) writeAuditLogEvent(auditEvent);
    return event.eventId;
  } catch {
    // Field logging must never block the workflow gate itself.
    return null;
  }
}

export function readRecentFieldLogEvents(limitCount = 10): any[] {
  const file = fieldLogPath();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-limitCount).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function formatLatestActionableFailureHint(limitCount = 20): string {
  const latest = readRecentFieldLogEvents(limitCount)
    .reverse()
    .find((event) => event?.event?.status !== "resolved" && !isOptionalEnvironmentFollowUp(event));
  if (!latest) return "";
  const category = String(latest.event?.category ?? "unknown");
  const summary = String(latest.failure?.summary ?? latest.event?.summary ?? "unknown failure").slice(0, 120);
  return `- last actionable failure (${category}) → use trace/continuation-safety before retrying: ${summary}`;
}

function isOptionalEnvironmentFollowUp(event: any): boolean {
  const text = [
    event?.failure?.summary,
    event?.failure?.actual,
    event?.event?.summary,
    event?.event?.primaryMessage,
  ].filter(Boolean).join("\n");
  return /CoreNLP startup failed|dockerDesktopLinuxEngine|setup_corenlp/i.test(text) && /Docker|CoreNLP|optional environment follow-up/i.test(text);
}

export function formatRecentFieldLogs(limitCount = 10): string {
  const events = readRecentFieldLogEvents(limitCount);
  if (events.length === 0) return [banner("🧾 Harness field logs"), "No field log events found."].join("\n");
  return [
    banner("🧾 Harness field logs"),
    formatFieldLogSummary(events),
    "",
    table([
      ["Time", "Category", "Type", "Severity", "Summary"],
      ...events.map((event) => [
        String(event.timestamp ?? "").replace(/T/, " ").replace(/\.\d+Z$/, "Z"),
        event.event?.category ?? "unknown",
        event.event?.type ?? "unknown",
        event.event?.severity ?? "unknown",
        String(event.failure?.summary ?? "").slice(0, 90),
      ]),
    ]),
    "",
    "Export redacted logs: /workflow failures export",
  ].join("\n");
}

export function formatFieldLogSummary(events: any[]): string {
  return [
    "By category: " + formatCounts(events.map((event) => event.event?.category ?? "unknown")),
    "By severity: " + formatCounts(events.map((event) => event.event?.severity ?? "unknown")),
  ].join("\n");
}

function formatCounts(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => `${value}=${count}`)
    .join(", ");
}

export function exportFieldLogs(): string {
  const root = projectRoot();
  ensureProjectMemoryIgnored(root);
  const source = fieldLogPath(root);
  fs.mkdirSync(exportDir(root), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = path.join(exportDir(root), `harness-log-${stamp}.redacted.jsonl`);
  if (!fs.existsSync(source)) {
    fs.writeFileSync(target, "", "utf-8");
    return target;
  }
  const lines = fs.readFileSync(source, "utf-8").split(/\r?\n/).filter(Boolean);
  const exportable = lines.filter((line) => {
    try {
      const event = JSON.parse(line);
      return event.privacy?.exportableToHarnessRepo !== false;
    } catch {
      return false;
    }
  });
  fs.writeFileSync(target, `${exportable.join("\n")}${exportable.length ? "\n" : ""}`, "utf-8");
  return target;
}
