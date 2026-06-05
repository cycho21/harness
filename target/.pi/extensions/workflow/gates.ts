import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkflowInstance, WorkflowPhase, DpaaReport, DpaaRunReceipt } from "./types";
import { createArtifactSnapshot, escapeForDoubleQuotedArg, findPlanForDpaa, updateSnapshotWithDpaa, writeDpaaReceipt } from "./artifacts";
import { detectBuildSystem } from "./catalog";
import { getBranch, getGitRoot } from "./git";
import { sha256File } from "./storage";
import { banner, table } from "./ui";
import { writeFieldLogEvent } from "./field-log";

// This file lives at: <harness-root>/.pi/extensions/workflow/gates.ts
const HARNESS_ROOT = path.resolve(__dirname, "../../..");
const PI_ROOT = path.join(HARNESS_ROOT, ".pi");
const DPAA_VENV_DIR = path.join(PI_ROOT, ".venv");
const CORENLP_DIR = path.join(PI_ROOT, "corenlp");

export type WorkflowGate = "dpaa" | "code-quality" | "policy-scan";

function quoteCommand(command: string): string {
  return `"${escapeForDoubleQuotedArg(command)}"`;
}

function venvPythonPath(): string {
  return process.platform === "win32"
    ? path.join(DPAA_VENV_DIR, "Scripts", "python.exe")
    : path.join(DPAA_VENV_DIR, "bin", "python");
}

function isUsablePython(command: string): boolean {
  try {
    execSync(`${quoteCommand(command)} -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePythonCommand(): string {
  for (const command of ["python", "python3"]) {
    if (isUsablePython(command)) return command;
  }
  throw new Error("Python >= 3.10 not found. Install Python 3.10+ or make `python`/`python3` available on PATH.");
}

function canImportDpaa(command: string): boolean {
  try {
    execSync(`${quoteCommand(command)} -c "import dpaa.cli"`, {
      cwd: HARNESS_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: process.env.PYTHONPATH ? `${PI_ROOT}${path.delimiter}${process.env.PYTHONPATH}` : PI_ROOT,
      },
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function installDpaaIntoVenv(venvPython: string): void {
  execSync(`${quoteCommand(venvPython)} -m pip install -e ${quoteCommand(PI_ROOT)}`, {
    cwd: HARNESS_ROOT,
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 1024 * 1024 * 20,
  });
}

function ensureDpaaPythonCommand(): string {
  const existingVenvPython = venvPythonPath();
  if (fs.existsSync(existingVenvPython) && isUsablePython(existingVenvPython)) {
    if (!canImportDpaa(existingVenvPython)) installDpaaIntoVenv(existingVenvPython);
    return existingVenvPython;
  }

  const basePython = resolvePythonCommand();
  fs.mkdirSync(PI_ROOT, { recursive: true });
  execSync(`${quoteCommand(basePython)} -m venv ${quoteCommand(DPAA_VENV_DIR)}`, {
    cwd: HARNESS_ROOT,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const venvPython = venvPythonPath();
  installDpaaIntoVenv(venvPython);
  return venvPython;
}

const skipTokens: Array<{
  gate: WorkflowGate;
  reason: string;
  issuedAt: number;
  expiresAt: number;
}> = [];

export function addSkipToken(gate: WorkflowGate, reason: string): void {
  skipTokens.push({ gate, reason, issuedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000 });
}

// ─── SBADR helpers ───────────────────────────────────────────────────────────

function isCoreNlpInstalled(): boolean {
  if (!fs.existsSync(CORENLP_DIR)) return false;
  return fs.readdirSync(CORENLP_DIR).some(
    (f) => f.startsWith("stanford-corenlp-") && f.endsWith(".jar") && !f.includes("javadoc") && !f.includes("sources") && !f.includes("models"),
  );
}

function installCoreNlp(): void {
  const isWin = process.platform === "win32";
  const script = path.join(PI_ROOT, isWin ? "setup_corenlp.ps1" : "setup_corenlp.sh");
  if (!fs.existsSync(script)) throw new Error(`CoreNLP setup script not found: ${script}`);
  const cmd = isWin
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${escapeForDoubleQuotedArg(script)}"`
    : `bash "${escapeForDoubleQuotedArg(script)}"`;
  execSync(cmd, { stdio: "inherit", encoding: "utf-8" });
}

interface SbadrReport {
  verdict: string;
  score: number;
  sentence_count: number;
  ambiguous_count: number;
  findings: Array<{ type: string; sentence_text: string; detail: string; suggestion: string }>;
}

function canImportSbadr(command: string): boolean {
  try {
    execSync(`${quoteCommand(command)} -c "import sbadr.cli"`, {
      cwd: HARNESS_ROOT,
      encoding: "utf-8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: process.env.PYTHONPATH ? `${PI_ROOT}${path.delimiter}${process.env.PYTHONPATH}` : PI_ROOT },
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function runSbadrAnalysis(pythonCommand: string, planPath: string): { ok: boolean; report: SbadrReport | null; error?: string } {
  const reportPath = path.join(os.tmpdir(), `sbadr-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    execSync(
      `${quoteCommand(pythonCommand)} -m sbadr.cli analyze "${escapeForDoubleQuotedArg(planPath)}" --output "${escapeForDoubleQuotedArg(reportPath)}" --no-text`,
      {
        cwd: HARNESS_ROOT,
        encoding: "utf-8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONPATH: process.env.PYTHONPATH ? `${PI_ROOT}${path.delimiter}${process.env.PYTHONPATH}` : PI_ROOT },
        stdio: ["pipe", "pipe", "inherit"],  // stderr inherited so CoreNLP startup progress is visible
      },
    );
  } catch { /* SBADR exits non-zero on WARN/FAIL; report still written */ }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as SbadrReport;
    return { ok: report.verdict !== "FAIL", report };
  } catch (err) {
    return { ok: true, report: null, error: String(err) };
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function runPreTransitionGate(
  workflow: WorkflowInstance,
  from: WorkflowPhase,
  to: WorkflowPhase,
  opts?: { approvedPlanSha256?: string },
): Promise<{ ok: boolean; message: string; gate?: WorkflowGate; planSha256?: string }> {
  // MVP 3: hash staleness check — if plan was approved but has since changed, block
  if (from === "plan_review" && to === "implement" && opts?.approvedPlanSha256) {
    const currentPlanPath = findPlanForDpaa();
    if (currentPlanPath) {
      const currentHash = sha256File(currentPlanPath);
      if (currentHash !== opts.approvedPlanSha256) {
        return {
          ok: false,
          gate: "dpaa",
          message: formatGateBlocked({
            gate: "DPAA (Stale Approval)",
            why: `The plan file has changed since DPAA was approved. Approved hash: ${opts.approvedPlanSha256.slice(0, 12)}…, current hash: ${currentHash.slice(0, 12)}…`,
            next: [
              "Show the plan changes to the user and explain what changed",
              "Update the plan if the changes are intentional, then use the workflow approval dialog again",
              "DPAA will re-run against the updated plan before implementation is allowed",
            ],
            skip: "/workflow skip dpaa <reason>",
          }),
        };
      }
    }
  }
  if (from === "plan_review" && to === "implement") {
    const result = await runDpaaGate(workflow, from, to);
    return result.ok ? result : { ...result, gate: "dpaa" };
  }
  if (from === "code_review" && to === "review_approved") {
    const result = runCodeQualityGate(workflow);
    return result.ok ? result : { ...result, gate: "code-quality" };
  }
  return { ok: true, message: "" };
}

export function runCodeQualityGate(workflow: WorkflowInstance): { ok: boolean; message: string } {
  const skip = consumeSkipToken("code-quality");
  if (skip) {
    writeFieldLogEvent({
      type: "gate.skipped",
      category: "code-quality",
      severity: "warning",
      status: "accepted-risk",
      workflow,
      summary: "Code quality gate was skipped by explicit user approval.",
      expected: "Code quality gate runs before review_approved.",
      actual: `One-use exception consumed: ${skip.reason}`,
      impact: "Harness may need better project-specific code quality configuration if skips repeat.",
      primaryMessage: skip.reason,
      improvementKind: "doctor-check",
    });
    return { ok: true, message: `Code quality guard skipped by user approval: ${skip.reason}` };
  }

  const root = workflow.gitRoot ?? getGitRoot();
  if (!root) {
    return { ok: true, message: "Code quality guard skipped: no git root detected" };
  }

  const configured = process.env.HARNESS_CODE_QUALITY_GUARD_CMD?.trim();
  const buildSystem = detectBuildSystem(root);

  if (!configured && buildSystem.type === "unknown") {
    return { ok: true, message: "Code quality guard skipped: no recognized build system detected. Set HARNESS_CODE_QUALITY_GUARD_CMD to enable." };
  }

  if (!configured && buildSystem.qualityCommand === null) {
    return { ok: true, message: `Code quality guard skipped: no quality gate configured for ${buildSystem.type} project. Set HARNESS_CODE_QUALITY_GUARD_CMD to enable.` };
  }

  // Resolve display label for messages
  const qc = buildSystem.qualityCommand;
  const command = configured ?? `${qc!.executable} ${qc!.args.join(" ")}`;

  try {
    if (configured) {
      // Developer-controlled env var: allow shell syntax (execSync)
      execSync(configured, {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: "pipe",
        maxBuffer: 1024 * 1024 * 10,
      });
    } else {
      // Build system quality command: use execFileSync (structured argv, no shell interpolation)
      // Windows: .bat files need cmd /c wrapper
      let exe = qc!.executable;
      let eArgs = qc!.args;
      if (process.platform === "win32" && /\.bat$/i.test(exe)) {
        eArgs = ["/c", exe, ...eArgs];
        exe = "cmd.exe";
      }
      execFileSync(exe, eArgs, {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        stdio: "pipe",
        maxBuffer: 1024 * 1024 * 10,
      });
    }
    return { ok: true, message: `Code quality guard satisfied: ${command}` };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    // exit code null = process could not start (tooling/env issue) → treat as skippable, not a code quality failure
    if (err.status == null) {
      const envOutput = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
      writeFieldLogEvent({
        type: "gate.failed", category: "code-quality", severity: "warning", workflow,
        summary: "Code quality gate subprocess could not start (exit code unknown). Treating as tooling error — gate skipped.",
        expected: "Quality guard process exits with numeric code.",
        actual: envOutput || "exit code null",
        impact: "Gate bypassed due to Node.js subprocess environment issue. Run manually to verify.",
        primaryMessage: envOutput || `${command} — exit code unknown`,
        command, improvementKind: "doctor-check",
      });
      return { ok: true, message: `Code quality guard skipped: subprocess environment error (exit unknown). Run ${command} manually to verify.` };
    }
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const tail = output.split(/\r?\n/).slice(-80).join("\n");
    writeFieldLogEvent({
      type: "gate.failed",
      category: "code-quality",
      severity: "blocker",
      workflow,
      summary: "Code quality guard failed before review approval.",
      expected: "Code quality guard exits successfully before code_review → review_approved.",
      actual: `Command failed: ${command}. Exit: ${err.status ?? "unknown"}`,
      impact: "Workflow cannot advance to review_approved until quality failures are fixed or explicitly skipped.",
      primaryMessage: output || `Command failed: ${command}`,
      exitCode: err.status ?? null,
      command,
      logExcerpt: tail,
      improvementKind: "doctor-check",
    });
    return {
      ok: false,
      message: [
        formatGateBlocked({
          gate: "Code Quality",
          why: `Mechanical code quality guard failed before code_review → review_approved. codeQualityGuard command: ${command}. Exit: ${err.status ?? "unknown"}`,
          next: [
            "Fix the Checkstyle/PMD/test failures reported by the guard",
            "Re-run the review package / workflow transition after fixes",
            `Detected build system: ${buildSystem.type}. If no quality gate is configured, set HARNESS_CODE_QUALITY_GUARD_CMD`,
          ],
          skip: "/workflow skip code-quality <reason>",
        }),
        "",
        "Recent output",
        "──────────────────────────────────────",
        tail || "(no output)",
      ].join("\n"),
    };
  }
}

export function runDpaaGate(workflow: WorkflowInstance, from: WorkflowPhase, to: WorkflowPhase): { ok: boolean; message: string; planSha256?: string } {
  const skip = consumeSkipToken("dpaa");
  if (skip) {
    writeFieldLogEvent({
      type: "gate.skipped",
      category: "dpaa",
      severity: "warning",
      status: "accepted-risk",
      workflow,
      fromPhase: from,
      toPhase: to,
      summary: "DPAA gate was skipped by explicit user approval.",
      expected: "DPAA validates the plan before implementation.",
      actual: `One-use exception consumed: ${skip.reason}`,
      impact: "Repeated DPAA skips may indicate false positives or missing workflow affordances.",
      primaryMessage: skip.reason,
      improvementKind: "dpaa-rule",
    });
    return { ok: true, message: `DPAA gate skipped by user approval: ${skip.reason}` };
  }

  const planPath = findPlanForDpaa();
  if (!planPath) {
    writeFieldLogEvent({
      type: "gate.failed",
      category: "dpaa",
      severity: "blocker",
      workflow,
      fromPhase: from,
      toPhase: to,
      summary: "DPAA gate could not find a plan file.",
      expected: "A DPAA-readable plan exists before plan_review → implement.",
      actual: "No .ai/interview/plan.md or docs/superpowers/plans/*.md was found.",
      impact: "Workflow cannot enter implementation because there is no deterministic plan input.",
      primaryMessage: "No plan file was found for DPAA.",
      improvementKind: "workflow-rule",
      targetFilesHint: ["target/.pi/extensions/workflow/artifacts.ts", "target/.pi/skills/dpaa/SKILL.md", "tests/test_workflow_prerequisites.py"],
    });
    return {
      ok: false,
      message: formatGateBlocked({
        gate: "DPAA",
        why: "No plan file was found for the required DPAA check before plan_review → implement.",
        next: ["Create `.ai/interview/plan.md` or `docs/superpowers/plans/*.md`", "Use the workflow approval dialog again"],
        skip: "/workflow skip dpaa <reason>",
      }),
    };
  }

  const snapshot = createArtifactSnapshot(workflow, "dpaa", "dpaa-check-before-implementation", planPath);
  const checkedPlanPath = snapshot?.planPath ?? planPath;
  const reportPath = path.join(os.tmpdir(), `dpaa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  let exitCode = 0;
  let pythonCommand: string;
  try {
    pythonCommand = ensureDpaaPythonCommand();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFieldLogEvent({
      type: "gate.failed",
      category: "dpaa",
      severity: "blocker",
      workflow,
      fromPhase: from,
      toPhase: to,
      summary: "DPAA Python environment preparation failed.",
      expected: "Harness auto-creates .pi/.venv and installs DPAA dependencies.",
      actual: message,
      impact: "Workflow cannot run DPAA until Python or dependency setup is fixed.",
      primaryMessage: message,
      improvementKind: "doctor-check",
      targetFilesHint: ["target/.pi/extensions/workflow/gates.ts", "target/.pi/extensions/workflow/catalog.ts", "scripts/harness-doctor.sh", "scripts/harness-doctor.ps1"],
    });
    return {
      ok: false,
      message: formatGateBlocked({
        gate: "DPAA",
        why: `Failed to prepare DPAA Python environment: ${message}`,
        next: ["Install Python 3.10+", "Ensure `python` or `python3` is available", "Use the workflow approval dialog again"],
        skip: "/workflow skip dpaa <reason>",
      }),
    };
  }

  try {
    execFileSync(pythonCommand, ["-m", "dpaa.cli", checkedPlanPath, "--output", reportPath, "--no-text"], {
      cwd: HARNESS_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONPATH: process.env.PYTHONPATH ? `${PI_ROOT}${path.delimiter}${process.env.PYTHONPATH}` : PI_ROOT,
      },
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
    const message = error instanceof Error ? error.message : String(error);
    writeFieldLogEvent({
      type: "gate.failed",
      category: "dpaa",
      severity: "blocker",
      workflow,
      fromPhase: from,
      toPhase: to,
      summary: "DPAA report could not be read after execution.",
      expected: "DPAA writes a JSON report for the gate to parse.",
      actual: message,
      impact: "Workflow cannot determine whether DPAA passed or failed.",
      primaryMessage: message,
      command: `${pythonCommand} -m dpaa.cli`,
      files: [{ path: checkedPlanPath, role: "input" }],
      improvementKind: "test-coverage",
    });
    return {
      ok: false,
      message: `Failed to read DPAA report: ${message}`,
    };
  } finally {
    fs.rmSync(reportPath, { force: true });
  }

  if (report.level === "PASS") {
    // ── SBADR analysis ────────────────────────────────────────────────────────
    if (!isCoreNlpInstalled()) {
      console.error("[harness] Stanford CoreNLP not found. Installing (~500 MB)...");
      try {
        installCoreNlp();
      } catch (err) {
        console.error(`[harness] CoreNLP install failed: ${err}. Skipping SBADR.`);
        return { ok: true, message: "DPAA check passed (SBADR skipped: CoreNLP install failed)", planSha256: sha256File(checkedPlanPath) };
      }
    }
    if (!canImportSbadr(pythonCommand)) {
      // sbadr was added to pyproject.toml after the venv was created; reinstall to pick it up
      installDpaaIntoVenv(pythonCommand);
    }
    console.error("[harness] Running SBADR syntactic ambiguity analysis (CoreNLP startup may take ~60s)...");
    const sbadr = runSbadrAnalysis(pythonCommand, checkedPlanPath);
    if (!sbadr.report) {
      return { ok: true, message: `DPAA check passed (SBADR skipped: ${sbadr.error ?? "report unreadable"})`, planSha256: sha256File(checkedPlanPath) };
    }
    const sr = sbadr.report;

    const sbadrFindings = sr.findings.slice(0, 5).map((f, i) =>
      `${i + 1}. [${f.type}] "${f.sentence_text.slice(0, 90)}"
   → ${f.detail}
   💡 ${f.suggestion}`,
    );

    if (sr.verdict === "FAIL") {
      writeFieldLogEvent({
        type: "gate.failed",
        category: "dpaa",
        severity: "blocker",
        workflow,
        fromPhase: from,
        toPhase: to,
        summary: `SBADR detected critical syntactic ambiguity in the English plan (score=${sr.score.toFixed(3)}).`,
        expected: "English plan sentences must be syntactically unambiguous before implementation.",
        actual: `SBADR verdict=FAIL, score=${sr.score.toFixed(3)}, ambiguous=${sr.ambiguous_count}/${sr.sentence_count} sentences`,
        impact: "Ambiguous plan sentences lead to misimplementation. Implementation is blocked until ambiguity is resolved.",
        primaryMessage: sr.findings[0]?.detail ?? "SBADR returned FAIL",
        improvementKind: "dpaa-rule",
        files: [{ path: checkedPlanPath, role: "input" }],
        logExcerpt: sr.findings.slice(0, 5).map((f) => `[${f.type}] ${f.detail} → ${f.suggestion}`).join("\n"),
      });
      return {
        ok: false,
        message: [
          formatGateBlocked({
            gate: "SBADR",
            why: `SBADR detected critical syntactic ambiguity in the English plan (score=${sr.score.toFixed(3)}, ${sr.ambiguous_count}/${sr.sentence_count} sentences ambiguous). Ambiguous sentences can lead to misimplementation.`,
            next: [
              "Explain each finding to the user and decide together how to rephrase the ambiguous sentence",
              "Or propose a concrete rewrite based on the suggestion and ask the user to confirm",
              "Update the plan and use the workflow approval dialog again",
            ],
            skip: "/workflow skip dpaa <reason>  (SBADR shares the dpaa gate one-use exception)",
          }),
          table([
            ["Item", "Value"],
            ["Verdict", sr.verdict],
            ["Score", sr.score.toFixed(3)],
            ["Ambiguous sentences", `${sr.ambiguous_count} / ${sr.sentence_count}`],
            ["Plan", path.relative(process.cwd(), checkedPlanPath)],
          ]),
          "",
          "Top Findings",
          "──────────────────────────────────────",
          ...sbadrFindings,
        ].join("\n"),
      };
    }

    if (sr.verdict === "WARN") {
      return {
        ok: true,
        message: [
          "DPAA check passed",
          "",
          `⚠️  SBADR WARN: potential syntactic ambiguity detected in the English plan (score=${sr.score.toFixed(3)}, ${sr.ambiguous_count}/${sr.sentence_count} sentences).`,
          "Show the findings below to the user and decide together whether to fix them. If proceeding without fixes, state the reason explicitly.",
          "",
          "Top Findings",
          "──────────────────────────────────────",
          ...sbadrFindings,
        ].join("\n"),
      };
    }

    return { ok: true, message: "DPAA + SBADR check passed", planSha256: sha256File(checkedPlanPath) };
    // ── end SBADR ─────────────────────────────────────────────────────────────
  }

  writeFieldLogEvent({
    type: "gate.failed",
    category: "dpaa",
    severity: report.level === "FAIL" ? "blocker" : "major",
    workflow,
    fromPhase: from,
    toPhase: to,
    summary: `DPAA returned ${report.level} before implementation.`,
    expected: "DPAA PASS is required before plan_review → implement.",
    actual: `DPAA level=${report.level}, penalty=${report.overall}, findings=${report.findings.length}`,
    impact: "Implementation is blocked until the plan/spec ambiguity is resolved or explicitly skipped.",
    primaryMessage: report.findings[0]?.message ?? `DPAA returned ${report.level}`,
    exitCode,
    command: `${pythonCommand} -m dpaa.cli`,
    findingCodes: report.findings.map((finding) => `${finding.layer}.${finding.rule}`).slice(0, 20),
    files: [{ path: checkedPlanPath, role: "input" }],
    logExcerpt: report.findings.slice(0, 5).map((finding) => `[${finding.layer}/${finding.rule}] ${finding.message} -> ${finding.suggestion}`).join("\n"),
    improvementKind: "dpaa-rule",
  });

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
        next: ["Explain the top findings to the user", "Ask targeted clarification questions", "Update plan/spec after the answer", "Use the workflow approval dialog again"],
        skip: "/workflow skip dpaa <reason>",
      }),
      table([
        ["Item", "Value"],
        ["Verdict", report.level],
        ["Penalty", String(report.overall)],
        ["Plan", path.relative(process.cwd(), checkedPlanPath)],
        ["Receipt", receipt ? `${receipt.timestamp} / ${receipt.planSha256.slice(0, 12)}` : "not saved"],
        ["Snapshot", snapshot ? snapshot.version : "none"],
      ]),
      "",
      "Top Findings",
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
    why: `The current workspace does not match the worktree/branch where this workflow started. Problems: ${validation.problems.join(", ")}.`,
    next: [
      "Tell the user which directory and branch this workflow started in, and ask them to navigate there before continuing",
      "Do not attempt to change directories yourself or simulate workspace state",
      "Do not proceed with implementation until the workspace matches",
      `Expected CWD: ${validation.expectedCwd ?? "unknown"} — Actual CWD: ${validation.actualCwd}`,
      `Expected branch: ${validation.expectedBranch ?? "unknown"} — Actual branch: ${validation.actualBranch}`,
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
      maxBuffer: 50 * 1024 * 1024,
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
      "Present each flagged category to the user clearly and explain the risk",
      "Ask the user to confirm they are aware of each risky change before proceeding",
      "If the user confirms, answer yes to the confirmation prompt; if they want to cancel, answer no",
      "For non-interactive sessions only: if the user explicitly approves all risks, run `/workflow skip policy-scan <reason>` and retry git push",
      "If the file count is excessive, ask the user whether to split the change into smaller commits",
      "Flagged changes:",
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
    banner(`🚦 ${args.gate.toUpperCase()} GATE BLOCKED`),
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
  ].join("\n");
}

