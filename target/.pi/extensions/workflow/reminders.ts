import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowInstance } from "./types";
import { getGitRoot } from "./git";

export type ReminderRuntimeSignals = {
  recentVerificationCommands?: Array<{ command: string; timestamp: number; phase?: string }>;
  codeQualityGuardSatisfied?: boolean;
  reviewPackageSubmitted?: boolean;
};

export type WorkflowReminder = {
  root: string;
  phase: string;
  sections: Array<{ title: string; items: string[] }>;
};


function projectRoot(workflow?: WorkflowInstance | null): string {
  return workflow?.gitRoot ?? getGitRoot() ?? process.cwd();
}

function safeStat(file: string): fs.Stats | null {
  try { return fs.statSync(file); } catch { return null; }
}

function listFeatureMarkdownFiles(root: string): string[] {
  const dir = path.join(root, "docs", "feat");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
    .sort()
    .map((name) => path.join(dir, name));
}

function fileMentions(file: string, needle: string): boolean {
  try { return fs.readFileSync(file, "utf-8").includes(needle); } catch { return false; }
}

function changedFiles(root: string): string[] {
  try {
    const out = execSync(`git -C "${root}" status --porcelain=v1 --untracked-files=all`, { encoding: "utf-8", stdio: "pipe", maxBuffer: 50 * 1024 * 1024 }).trim();
    if (!out) return [];
    return out.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function scanDocumentationItems(root: string, phase: string): string[] {
  if (!["document", "commit"].includes(phase)) return [];
  const docsDir = path.join(root, "docs", "feat");
  const htmlDir = path.join(docsDir, "html");
  const items: string[] = [];

  const mdFiles = listFeatureMarkdownFiles(root);
  const indexMd = path.join(docsDir, "INDEX.md");
  const htmlIndex = path.join(htmlDir, "index.html");

  if (!fs.existsSync(docsDir)) {
    items.push("docs/feat/ does not exist. If this workflow changed feature/API/schema/architecture behavior, create feature docs; otherwise state why feature docs are not required.");
  }

  if (mdFiles.length > 0 && !fs.existsSync(indexMd)) {
    items.push("docs/feat/INDEX.md is missing even though feature markdown files exist.");
  }
  if (mdFiles.length > 0 && !fs.existsSync(htmlIndex)) {
    items.push("docs/feat/html/index.html is missing even though feature markdown files exist.");
  }

  for (const md of mdFiles) {
    const base = path.basename(md, ".md");
    const relMd = path.relative(root, md).replace(/\\/g, "/");
    const html = path.join(htmlDir, `${base}.html`);
    const relHtml = path.relative(root, html).replace(/\\/g, "/");
    const mdStat = safeStat(md);
    const htmlStat = safeStat(html);

    if (!htmlStat) {
      items.push(`${relHtml} is missing for ${relMd}.`);
    } else if (mdStat && htmlStat.mtimeMs < mdStat.mtimeMs) {
      items.push(`${relHtml} is older than ${relMd}; regenerate rendered HTML.`);
    }

    if (fs.existsSync(indexMd) && !fileMentions(indexMd, path.basename(md))) {
      items.push(`docs/feat/INDEX.md does not mention ${path.basename(md)}.`);
    }
    if (fs.existsSync(htmlIndex) && !fileMentions(htmlIndex, `${base}.html`)) {
      items.push(`docs/feat/html/index.html does not mention ${base}.html.`);
    }
  }

  if (items.length === 0 && mdFiles.length === 0) {
    items.push("No docs/feat/*.md feature document found. If documentation is not required for this change, state the reason explicitly before commit.");
  }

  return items;
}

function scanVerificationItems(root: string, phase: string, signals: ReminderRuntimeSignals): string[] {
  if (phase !== "commit") return [];
  const changed = changedFiles(root);
  if (changed.length === 0) return [];
  const recent = (signals.recentVerificationCommands ?? []).filter((item) => Date.now() - item.timestamp < 2 * 60 * 60_000);
  if (recent.length > 0) return [];
  return [
    "No recent test/lint/typecheck/build/codeQualityGuard command was observed in this Pi session before commit. Run the narrowest relevant verification, or explicitly state why verification is not applicable.",
  ];
}

function scanReviewPackageItems(phase: string, signals: ReminderRuntimeSignals): string[] {
  if (phase !== "code_review") return [];
  if (signals.reviewPackageSubmitted) return [];
  return [
    "No automated review package has been recorded yet. Before review_approved, run main-agent self-review, independent reviewer/subagent review, quality gates, then call submit_review_package with Critical/Major/Minor counts and summaries.",
  ];
}

function scanCommitSummaryItems(root: string, phase: string): string[] {
  if (phase !== "commit") return [];
  const changed = changedFiles(root);
  if (changed.length === 0) return [];
  return [
    `Commit phase has ${changed.length} changed file(s). Provide a concise diff summary, risk/verification summary, and proposed commit message before committing or asking for push approval.`,
  ];
}

function isHarnessDevelopmentRepo(root: string): boolean {
  return fs.existsSync(path.join(root, "target", ".pi", "extensions", "workflow.ts")) && fs.existsSync(path.join(root, "scripts", "init-target-harness.py"));
}

function scanFieldLogItems(root: string, phase: string): string[] {
  if (!["plan_review", "implement", "code_review", "commit"].includes(phase)) return [];
  if (!isHarnessDevelopmentRepo(root)) return [];
  const changed = changedFiles(root).map((file) => file.replace(/\\/g, "/"));
  const harnessRelated = changed.some((file) => /^(target\/\.pi\/extensions|target\/\.pi\/schemas|scripts\/|docs\/external-memory|docs\/harness-field-log|tests\/test_(workflow|memory|field|component))/.test(file));
  if (!harnessRelated) return [];
  const hasFieldLogs = fs.existsSync(path.join(root, ".project-memory", "harness", "events.jsonl"));
  const hasExport = fs.existsSync(path.join(root, ".project-memory", "harness", "exports"));
  if (hasFieldLogs || hasExport) return [];
  return [
    "Harness runtime/tooling files changed, but no local field-log import/export evidence was found under .project-memory/harness/. If this change responds to field failures, import/analyze redacted logs; otherwise state that no field logs were available or applicable.",
  ];
}

export function scanWorkflowReminders(workflow?: WorkflowInstance | null, signals: ReminderRuntimeSignals = {}): WorkflowReminder | null {
  if (!workflow) return null;
  const root = projectRoot(workflow);
  const sections = [
    { title: "Documentation", items: scanDocumentationItems(root, workflow.phase) },
    { title: "Verification", items: scanVerificationItems(root, workflow.phase, signals) },
    { title: "Review Package", items: scanReviewPackageItems(workflow.phase, signals) },
    { title: "Commit Summary", items: scanCommitSummaryItems(root, workflow.phase) },
    { title: "Field Log Evidence", items: scanFieldLogItems(root, workflow.phase) },
  ].filter((section) => section.items.length > 0);

  return sections.length > 0 ? { root, phase: workflow.phase, sections } : null;
}

export function formatWorkflowReminders(reminder: WorkflowReminder | null): string {
  if (!reminder || reminder.sections.length === 0) return "";
  return [
    "",
    "[Workflow Mechanical Reminders]",
    `Phase: ${reminder.phase}`,
    "Mechanical checks found items that need attention. Do not silently skip them:",
    ...reminder.sections.flatMap((section) => [
      `${section.title}:`,
      ...section.items.slice(0, 8).map((item) => `- ${item}`),
      ...(section.items.length > 8 ? [`- ... ${section.items.length - 8} more`] : []),
    ]),
    "Action: address each relevant reminder by doing the work, or explicitly state why it is not applicable for this change.",
    "[/Workflow Mechanical Reminders]",
  ].join("\n");
}


