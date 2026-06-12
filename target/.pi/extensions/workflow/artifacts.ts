import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactSnapshot, DpaaReport, DpaaRunReceipt, WorkflowInstance, WorkflowPhase } from "./types";
import { describeArtifact } from "./artifact-descriptor";
import { getDpaaReceiptDir, sha256File, slugify } from "./storage";
import { banner, table } from "./ui";

export function findPlanForDpaa(): string | null {
  const directCandidates = [
    path.join(process.cwd(), ".ai", "interview", "plan.md"),
    path.join(process.cwd(), "docs", "superpowers", "plans", "plan.md"),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  const planDir = path.join(process.cwd(), "docs", "superpowers", "plans");
  if (!fs.existsSync(planDir) || !fs.statSync(planDir).isDirectory()) return null;

  const plans = fs.readdirSync(planDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(planDir, name))
    .filter((candidate) => fs.statSync(candidate).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return plans[0] ?? null;
}

export function escapeForDoubleQuotedArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function createArtifactSnapshot(
  workflow: WorkflowInstance,
  source: ArtifactSnapshot["source"],
  reason: string,
  explicitPlanPath?: string,
): ArtifactSnapshot | null {
  const specSource = path.join(process.cwd(), ".ai", "interview", "spec.md");
  const planSource = explicitPlanPath ?? findPlanForDpaa();
  const koreanSpecSource = path.join(process.cwd(), ".ai", "interview", "spec.ko.md");
  const koreanPlanSource = path.join(process.cwd(), ".ai", "interview", "plan.ko.md");
  const hasSpec = fs.existsSync(specSource) && fs.statSync(specSource).isFile();
  const hasPlan = !!planSource && fs.existsSync(planSource) && fs.statSync(planSource).isFile();
  const hasKoreanSpec = fs.existsSync(koreanSpecSource) && fs.statSync(koreanSpecSource).isFile();
  const hasKoreanPlan = fs.existsSync(koreanPlanSource) && fs.statSync(koreanPlanSource).isFile();
  if (!hasSpec && !hasPlan && !hasKoreanSpec && !hasKoreanPlan) return null;

  const runDir = getArtifactRunDir(workflow.id);
  const previous = readLatestArtifactVersion(workflow.id);
  const version = nextArtifactVersion(workflow.id, reason);
  const snapshotDir = path.join(runDir, version);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const snapshot: ArtifactSnapshot = {
    workflowId: workflow.id,
    version,
    reason,
    source,
    createdAt: new Date().toISOString(),
    previous,
    path: snapshotDir,
  };

  if (hasKoreanSpec) {
    fs.copyFileSync(koreanSpecSource, path.join(snapshotDir, "spec.ko.md"));
  }

  if (hasKoreanPlan) {
    fs.copyFileSync(koreanPlanSource, path.join(snapshotDir, "plan.ko.md"));
  }

  if (hasSpec) {
    snapshot.specPath = path.join(snapshotDir, "spec.md");
    fs.copyFileSync(specSource, snapshot.specPath);
    snapshot.specSha256 = sha256File(snapshot.specPath);
  }

  if (hasPlan && planSource) {
    snapshot.planPath = path.join(snapshotDir, "plan.md");
    fs.copyFileSync(planSource, snapshot.planPath);
    snapshot.planSha256 = sha256File(snapshot.planPath);
  }

  writeArtifactSnapshotMeta(snapshot);
  writeLatestArtifactSnapshot(snapshot);
  return snapshot;
}

export function updateSnapshotWithDpaa(snapshot: ArtifactSnapshot, report: DpaaReport, reportPath: string, exitCode: number): void {
  const dpaaPath = path.join(snapshot.path, "dpaa.json");
  fs.copyFileSync(reportPath, dpaaPath);
  snapshot.dpaa = {
    level: report.level,
    overall: report.overall,
    findingsCount: report.findings.length,
    exitCode,
    reportSha256: sha256File(dpaaPath),
  };
  writeArtifactSnapshotMeta(snapshot);
  writeLatestArtifactSnapshot(snapshot);
}

export function writeArtifactSnapshotMeta(snapshot: ArtifactSnapshot): void {
  fs.writeFileSync(path.join(snapshot.path, "meta.json"), JSON.stringify(snapshot, null, 2), "utf-8");
}

export function writeLatestArtifactSnapshot(snapshot: ArtifactSnapshot): void {
  fs.mkdirSync(getArtifactRunDir(snapshot.workflowId), { recursive: true });
  fs.writeFileSync(path.join(getArtifactRunDir(snapshot.workflowId), "latest.json"), JSON.stringify(snapshot, null, 2), "utf-8");
}

export function readLatestArtifactVersion(workflowId: string): string | null {
  const latestPath = path.join(getArtifactRunDir(workflowId), "latest.json");
  if (!fs.existsSync(latestPath)) return null;
  try {
    return (JSON.parse(fs.readFileSync(latestPath, "utf-8")) as ArtifactSnapshot).version ?? null;
  } catch {
    return null;
  }
}

export function nextArtifactVersion(workflowId: string, reason: string): string {
  const runDir = getArtifactRunDir(workflowId);
  const existing = fs.existsSync(runDir)
    ? fs.readdirSync(runDir).filter((name) => /^\d{3}-/.test(name))
    : [];
  const next = existing.reduce((max, name) => Math.max(max, Number(name.slice(0, 3)) || 0), 0) + 1;
  return `${String(next).padStart(3, "0")}-${slugify(reason)}`;
}

export function getArtifactRunDir(workflowId: string): string {
  return path.join(process.cwd(), ".ai", "interview", "runs", workflowId);
}

export function formatArtifactSnapshotCreated(snapshot: ArtifactSnapshot): string {
  return [
    banner("📌 Artifact snapshot 생성"),
    table([
      ["항목", "값"],
      ["Version", snapshot.version],
      ["Reason", snapshot.reason],
      ["Source", snapshot.source],
      ["Path", path.relative(process.cwd(), snapshot.path)],
      ["Spec KO", fs.existsSync(path.join(snapshot.path, "spec.ko.md")) ? "yes" : "no"],
      ["Plan KO", fs.existsSync(path.join(snapshot.path, "plan.ko.md")) ? "yes" : "no"],
      ["Spec EN", snapshot.specSha256 ? snapshot.specSha256.slice(0, 12) : "없음"],
      ["Plan EN", snapshot.planSha256 ? snapshot.planSha256.slice(0, 12) : "없음"],
    ]),
  ].join("\n");
}

export function writeDpaaReceipt(args: {
  workflow: WorkflowInstance;
  from: WorkflowPhase;
  to: WorkflowPhase;
  planPath: string;
  reportPath: string;
  report: DpaaReport;
  exitCode: number;
  snapshot?: ArtifactSnapshot | null;
}): DpaaRunReceipt {
  const receipt: DpaaRunReceipt = {
    timestamp: new Date().toISOString(),
    workflowId: args.workflow.id,
    from: args.from,
    to: args.to,
    projectRoot: process.cwd(),
    planPath: args.planPath,
    planSha256: sha256File(args.planPath),
    exitCode: args.exitCode,
    level: args.report.level,
    overall: args.report.overall,
    findingsCount: args.report.findings.length,
    reportSha256: sha256File(args.reportPath),
    reportDescriptor: describeArtifact({
      kind: "dpaa-report",
      filePath: args.reportPath,
      producer: { system: "harness", component: "dpaa" },
      retention: "until-completion",
      summary: `DPAA ${args.report.level}: ${args.report.findings.length} finding(s), penalty=${args.report.overall}.`,
    }),
    snapshotVersion: args.snapshot?.version,
    snapshotPath: args.snapshot?.path,
  };

  const dir = getDpaaReceiptDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${receipt.level.toLowerCase()}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), "utf-8");
  return receipt;
}

export function formatLatestDpaaAudit(): string {
  const receipt = readLatestDpaaReceipt();
  if (!receipt) {
    return "⚪ DPAA 실행 기록이 없습니다.";
  }

  const icon = receipt.level === "PASS" ? "✅" : receipt.level === "WARN" ? "⚠️" : "❌";
  return [
    banner(`${icon} 최근 DPAA 실행 기록`),
    table([
      ["항목", "값"],
      ["시간", receipt.timestamp],
      ["Workflow", receipt.workflowId],
      ["전이", `${receipt.from} → ${receipt.to}`],
      ["결과", receipt.level],
      ["Penalty", `${receipt.overall} (낮을수록 좋음)`],
      ["Exit code", String(receipt.exitCode)],
      ["Findings", String(receipt.findingsCount)],
      ["Plan", path.relative(process.cwd(), receipt.planPath)],
      ["Plan hash", receipt.planSha256],
      ["Report hash", receipt.reportSha256],
      ["Report artifact", receipt.reportDescriptor ? path.relative(process.cwd(), receipt.reportDescriptor.path) : "없음"],
      ["Snapshot", receipt.snapshotVersion ?? "없음"],
    ]),
  ].join("\n");
}

export function listArtifactSnapshots(workflowId: string): ArtifactSnapshot[] {
  const runDir = getArtifactRunDir(workflowId);
  if (!fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir)
    .filter((name) => /^\d{3}-/.test(name))
    .map((name) => path.join(runDir, name, "meta.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf-8")) as ArtifactSnapshot)
    .sort((a, b) => a.version.localeCompare(b.version));
}

export function readLatestDpaaReceipt(): DpaaRunReceipt | null {
  const dir = getDpaaReceiptDir();
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!files[0]) return null;
  return JSON.parse(fs.readFileSync(files[0], "utf-8")) as DpaaRunReceipt;
}

