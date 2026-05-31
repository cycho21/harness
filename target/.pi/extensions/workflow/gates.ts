import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowInstance, WorkflowPhase, DpaaReport, DpaaRunReceipt } from "./types";
import { createArtifactSnapshot, escapeForDoubleQuotedArg, findPlanForDpaa, updateSnapshotWithDpaa, writeDpaaReceipt } from "./artifacts";
import { getBranch, getGitRoot } from "./git";
import { table } from "./ui";

// This file lives at: <harness-root>/.pi/extensions/workflow/gates.ts
const HARNESS_ROOT = path.resolve(__dirname, "../../..");

export type WorkflowGate = "dpaa" | "code-quality" | "push-review" | "policy-scan";

const skipTokens: Array<{
  gate: WorkflowGate;
  reason: string;
  issuedAt: number;
  expiresAt: number;
}> = [];

export function addSkipToken(gate: WorkflowGate, reason: string): void {
  skipTokens.push({ gate, reason, issuedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 });
}

export async function runPreTransitionGate(workflow: WorkflowInstance, from: WorkflowPhase, to: WorkflowPhase): Promise<{ ok: boolean; message: string }> {
  if (from === "plan_review" && to === "implement") {
    return runDpaaGate(workflow, from, to);
  }
  if (from === "code_review" && to === "review_approved") {
    return runCodeQualityGate(workflow);
  }
  return { ok: true, message: "" };
}

export function runCodeQualityGate(workflow: WorkflowInstance): { ok: boolean; message: string } {
  const skip = consumeSkipToken("code-quality");
  if (skip) {
    return { ok: true, message: `Code quality guard skipped by user approval: ${skip.reason}` };
  }

  const root = workflow.gitRoot ?? getGitRoot();
  if (!root) {
    return { ok: true, message: "Code quality guard skipped: no git root detected" };
  }

  const configured = process.env.HARNESS_CODE_QUALITY_GUARD_CMD?.trim();
  const hasGradle = fs.existsSync(path.join(root, "gradlew")) || fs.existsSync(path.join(root, "gradlew.bat")) || fs.existsSync(path.join(root, "build.gradle")) || fs.existsSync(path.join(root, "build.gradle.kts"));
  if (!configured && !hasGradle) {
    return { ok: true, message: "Code quality guard skipped: no Gradle project detected" };
  }

  const command = configured || (process.platform === "win32" && fs.existsSync(path.join(root, "gradlew.bat")) ? "gradlew.bat codeQualityGuard" : "./gradlew codeQualityGuard");
  try {
    execSync(command, {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: "pipe",
      maxBuffer: 1024 * 1024 * 10,
    });
    return { ok: true, message: `Code quality guard satisfied: ${command}` };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const tail = output.split(/\r?\n/).slice(-80).join("\n");
    return {
      ok: false,
      message: [
        formatGateBlocked({
          gate: "Code Quality",
          why: `Mechanical code quality guard failed before code_review → review_approved. Command: ${command}. Exit: ${err.status ?? "unknown"}`,
          next: [
            "Fix Checkstyle/PMD/test failures reported by the guard",
            "Re-run /workflow approve after fixes",
            "If the project has no codeQualityGuard task, add it to build.gradle or set HARNESS_CODE_QUALITY_GUARD_CMD",
          ],
          skip: "/workflow skip code-quality <reason>",
        }),
        "",
        "최근 출력",
        "──────────────────────────────────────",
        tail || "(no output)",
      ].join("\n"),
    };
  }
}

export function runDpaaGate(workflow: WorkflowInstance, from: WorkflowPhase, to: WorkflowPhase): { ok: boolean; message: string } {
  const skip = consumeSkipToken("dpaa");
  if (skip) {
    return { ok: true, message: `DPAA gate skipped by user approval: ${skip.reason}` };
  }

  const planPath = findPlanForDpaa();
  if (!planPath) {
    return {
      ok: false,
      message: formatGateBlocked({
        gate: "DPAA",
        why: "No plan file was found for the required DPAA check before plan_review → implement.",
        next: ["Create `.ai/interview/plan.md` or `docs/superpowers/plans/*.md`", "Run /workflow approve again"],
        skip: "/workflow skip dpaa <reason>",
      }),
    };
  }

  const snapshot = createArtifactSnapshot(workflow, "dpaa", "dpaa-check-before-implementation", planPath);
  const checkedPlanPath = snapshot?.planPath ?? planPath;
  const reportPath = path.join(os.tmpdir(), `dpaa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  let exitCode = 0;
  try {
    execSync(`python -m dpaa.cli "${escapeForDoubleQuotedArg(checkedPlanPath)}" --output "${escapeForDoubleQuotedArg(reportPath)}" --no-text`, {
      cwd: HARNESS_ROOT,
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: "pipe",
    });
  } catch (error) {
    // DPAA returns a non-zero exit code when ambiguity findings fail the gate.
    // The JSON report is still written and is parsed below.
    exitCode = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 1;
  }

  let report: DpaaReport;
  let receipt: DpaaRunReceipt | null = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as DpaaReport;
    if (snapshot) updateSnapshotWithDpaa(snapshot, report, reportPath, exitCode);
    receipt = writeDpaaReceipt({ workflow, from, to, planPath: checkedPlanPath, reportPath, report, exitCode, snapshot });
  } catch (error) {
    return {
      ok: false,
      message: `Failed to read DPAA report: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    fs.rmSync(reportPath, { force: true });
  }

  if (report.level === "PASS") {
    return { ok: true, message: "DPAA check passed" };
  }

  const findings = report.findings.slice(0, 5).map((finding, index) => {
    const line = finding.line ? `line ${finding.line}` : "line unknown";
    return `${index + 1}. [${finding.layer}/${finding.rule}] ${line}: ${finding.message}\n   → ${finding.suggestion}`;
  });

  return {
    ok: false,
    message: [
      formatGateBlocked({
        gate: "DPAA",
        why: `DPAA returned ${report.level} before plan_review → implement.`,
        next: ["Explain the top findings to the user", "Ask targeted clarification questions", "Update plan/spec after the answer", "Run /workflow approve again"],
        skip: "/workflow skip dpaa <reason>",
      }),
      table([
        ["항목", "값"],
        ["결과", report.level],
        ["Penalty", String(report.overall)],
        ["대상 plan", path.relative(process.cwd(), checkedPlanPath)],
        ["검증 기록", receipt ? `${receipt.timestamp} / ${receipt.planSha256.slice(0, 12)}` : "저장 실패"],
        ["스냅샷", snapshot ? snapshot.version : "없음"],
      ]),
      "",
      "상위 Findings",
      "──────────────────────────────────────",
      ...findings,
    ].join("\n"),
  };
}

export type WorkflowWorkspaceValidation = {
  ok: boolean;
  expectedCwd?: string;
  actualCwd: string;
  expectedGitRoot?: string | null;
  actualGitRoot: string | null;
  expectedBranch?: string;
  actualBranch: string;
  problems: string[];
};

export function validateWorkflowWorkspace(workflow: WorkflowInstance | null): WorkflowWorkspaceValidation {
  const actualCwd = process.cwd();
  const actualGitRoot = getGitRoot();
  const actualBranch = actualGitRoot ? getBranch(actualGitRoot) : "unknown";
  if (!workflow) return { ok: true, actualCwd, actualGitRoot, actualBranch, problems: [] };

  const problems: string[] = [];
  if (workflow.gitRoot && actualGitRoot && path.resolve(workflow.gitRoot) !== path.resolve(actualGitRoot)) {
    problems.push("git root mismatch");
  }
  if (workflow.gitRoot && !actualGitRoot) {
    problems.push("current cwd is not inside a git worktree");
  }
  if (workflow.branch !== "unknown" && actualBranch !== workflow.branch) {
    problems.push("branch mismatch");
  }

  return {
    ok: problems.length === 0,
    expectedCwd: workflow.cwd,
    actualCwd,
    expectedGitRoot: workflow.gitRoot,
    actualGitRoot,
    expectedBranch: workflow.branch,
    actualBranch,
    problems,
  };
}

export function formatWorkspaceMismatch(validation: WorkflowWorkspaceValidation): string {
  if (validation.ok) return "";
  return formatGateBlocked({
    gate: "Workflow Workspace",
    why: "The current workspace does not match the worktree/branch where this workflow started.",
    next: [
      "Run pi from the worktree/cwd where this workflow started",
      "Verify that the current branch is correct",
      `Problems: ${validation.problems.join(", ")}`,
      `Expected CWD: ${validation.expectedCwd ?? "unknown"}`,
      `Actual CWD: ${validation.actualCwd}`,
      `Expected Git root: ${validation.expectedGitRoot ?? "unknown"}`,
      `Actual Git root: ${validation.actualGitRoot ?? "unknown"}`,
      `Expected branch: ${validation.expectedBranch ?? "unknown"}`,
      `Actual branch: ${validation.actualBranch}`,
    ],
  });
}

export type PushPolicyScanResult = {
  ok: boolean;
  totalChanged: number;
  maxChanged: number;
  findings: Array<{ category: string; files: string[] }>;
};

export function scanPushPolicy(root: string | null = getGitRoot()): PushPolicyScanResult {
  const maxChanged = Number.parseInt(process.env.HARNESS_POLICY_MAX_CHANGED_FILES ?? "30", 10);
  const limit = Number.isFinite(maxChanged) && maxChanged > 0 ? maxChanged : 30;
  if (!root) return { ok: true, totalChanged: 0, maxChanged: limit, findings: [] };

  let out = "";
  try {
    out = execSync(`git -C "${root}" status --porcelain=v1 --untracked-files=all`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return { ok: true, totalChanged: 0, maxChanged: limit, findings: [] };
  }

  const entries = out
    ? out.split("\n").map((line) => {
        const status = line.slice(0, 2);
        const rawPath = line.slice(3).trim();
        const file = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()!.trim() : rawPath;
        return { status, file: file.replace(/\\/g, "/") };
      })
    : [];

  const categories: Array<{ category: string; match: (entry: { status: string; file: string }) => boolean }> = [
    { category: "Build descriptor changed (build.gradle / pom.xml)", match: ({ file }) => /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/.test(file) },
    { category: "Application config changed (application.yml)", match: ({ file }) => /(^|\/)application\.ya?ml$/.test(file) },
    { category: "DB migration changed (db/migration)", match: ({ file }) => /(^|\/)db\/migration\//.test(file) },
    { category: "Dockerfile changed", match: ({ file }) => /(^|\/)(Dockerfile|.*\.Dockerfile)$/.test(file) },
    { category: "CI config changed", match: ({ file }) => /(^\.github\/workflows\/|^\.gitlab-ci\.ya?ml$|(^|\/)Jenkinsfile$|^azure-pipelines\.ya?ml$|^\.circleci\/|^bitbucket-pipelines\.ya?ml$)/.test(file) },
    { category: "Deleted files", match: ({ status }) => status.includes("D") },
  ];

  const findings = categories
    .map(({ category, match }) => ({ category, files: entries.filter(match).map((entry) => entry.file) }))
    .filter((finding) => finding.files.length > 0);

  if (entries.length > limit) {
    findings.push({
      category: `Excessive file changes (${entries.length} > ${limit})`,
      files: entries.slice(0, limit + 1).map((entry) => entry.file),
    });
  }

  return { ok: findings.length === 0, totalChanged: entries.length, maxChanged: limit, findings };
}

export function formatPushPolicyScanBlocked(scan: PushPolicyScanResult): string {
  const sections = scan.findings.flatMap((finding) => [
    `- ${finding.category}`,
    ...finding.files.slice(0, 12).map((file) => `  • ${file}`),
    ...(finding.files.length > 12 ? [`  • ... ${finding.files.length - 12} more`] : []),
  ]);

  return formatGateBlocked({
    gate: "Push Policy Scan",
    why: `Risky workspace changes were detected before git push. Changed files: ${scan.totalChanged} (limit: ${scan.maxChanged}).`,
    next: [
      "Review the flagged files with the user before pushing",
      "Call out build/config/migration/Docker/CI/deletion impact explicitly",
      "Answer the confirmation prompt explicitly: 예 continues the push, 아니오 blocks it",
      "For non-interactive sessions only: if the user explicitly approves, run `/workflow skip policy-scan <reason>` and retry git push",
      "Split the change or remove unrelated files if the file count is excessive",
      ...sections,
    ],
    skip: "/workflow skip policy-scan <reason>",
  });
}

export function consumeSkipToken(gate: WorkflowGate): { reason: string } | null {
  const now = Date.now();
  const index = skipTokens.findIndex((token) => token.gate === gate && token.expiresAt > now);
  if (index < 0) {
    for (let i = skipTokens.length - 1; i >= 0; i -= 1) {
      if (skipTokens[i].expiresAt <= now) skipTokens.splice(i, 1);
    }
    return null;
  }
  const [token] = skipTokens.splice(index, 1);
  return { reason: token.reason };
}

export function formatGateBlocked(args: { gate: string; why: string; next: string[]; skip?: string }): string {
  return [
    `── 🚦 ${args.gate.toUpperCase()} GATE BLOCKED ─────`,
    "",
    "Why blocked:",
    `  ${args.why}`,
    "",
    "Next actions:",
    ...args.next.map((item, index) => `  ${index + 1}. ${item}`),
    ...(args.skip ? [
      "",
      "Exception path:",
      "  If this gate is unnecessary for the current task,",
      "  explain why to the user and ask for explicit approval before requesting:",
      `  ${args.skip}`,
    ] : []),
    "",
    "Caution:",
    "  Do not bypass this gate without explicit user approval.",
    "──────────────────────────────────────",
  ].join("\n");
}

