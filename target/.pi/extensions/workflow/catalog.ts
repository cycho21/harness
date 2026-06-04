import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandSpec, CatalogCommandResult, WorkflowPhase } from "./types";
import { WORKFLOW_PHASES } from "./types";
import { getGitRoot } from "./git";
import { banner, table } from "./ui";

// This file lives at: <harness-root>/.pi/extensions/workflow/catalog.ts
const HARNESS_ROOT = path.resolve(__dirname, "../../..");
const PI_ROOT = path.join(HARNESS_ROOT, ".pi");
const WORKFLOW_DIR = path.join(PI_ROOT, "workflows");

export type WorkflowPrerequisiteScan = {
  ok: boolean;
  root: string;
  missingRequired: string[];
  warnings: string[];
};

export function scanWorkflowPrerequisites(root: string = HARNESS_ROOT): WorkflowPrerequisiteScan {
  const exists = (relativePath: string) => fs.existsSync(path.join(root, relativePath));
  const anyExists = (relativePaths: string[]) => relativePaths.some(exists);

  const required = [
    ".pi/WORKFLOW.md",
    ".pi/extensions/workflow.ts",
    ".pi/extensions/workflow",
    ".pi/skills",
    ".pi/workflows",
    ".pi/dpaa",
    ".pi/sbadr",
    ".pi/pyproject.toml",
    ".pi/schemas/harness-field-log-event.schema.json",
  ];
  const missingRequired = required.filter((item) => !exists(item));

  const projectRoot = getGitRoot() ?? root;
  const projectExists = (relativePath: string) => fs.existsSync(path.join(projectRoot, relativePath));
  const projectAnyExists = (relativePaths: string[]) => relativePaths.some(projectExists);
  const warnings: string[] = [];

  if (!projectAnyExists(["build.gradle", "build.gradle.kts", "pom.xml"])) {
    warnings.push("build.gradle/build.gradle.kts/pom.xml not found; code quality guard may not be runnable.");
  }
  if (!projectAnyExists(["config/checkstyle/checkstyle.xml", "checkstyle.xml", "config/checkstyle/sun_checks.xml", "config/checkstyle/google_checks.xml"])) {
    warnings.push("Checkstyle config not found; Checkstyle guard may be incomplete.");
  }
  if (projectAnyExists(["build.gradle", "build.gradle.kts"])) {
    const buildFiles = ["build.gradle", "build.gradle.kts"]
      .map((file) => path.join(projectRoot, file))
      .filter((file) => fs.existsSync(file));
    const mentionsGuard = buildFiles.some((file) => fs.readFileSync(file, "utf-8").includes("codeQualityGuard"));
    if (!mentionsGuard && !process.env.HARNESS_CODE_QUALITY_GUARD_CMD) {
      warnings.push("Gradle codeQualityGuard task not found; add it to build.gradle or set HARNESS_CODE_QUALITY_GUARD_CMD.");
    }
  }

  return { ok: missingRequired.length === 0, root, missingRequired, warnings };
}

export function formatWorkflowPrerequisiteScan(scan: WorkflowPrerequisiteScan): string {
  const sections = [banner("🧰 Workflow prerequisite scan")];
  sections.push(`Root: ${scan.root}`);
  if (scan.missingRequired.length > 0) {
    sections.push("", "Missing required files/directories:", ...scan.missingRequired.map((item) => `  - ${item}`));
  }
  if (scan.warnings.length > 0) {
    sections.push("", "Warnings:", ...scan.warnings.map((item) => `  - ${item}`));
  }
  if (scan.missingRequired.length === 0 && scan.warnings.length === 0) {
    sections.push("All required workflow files and quality guard hints are present.");
  }
  return sections.join("\n");
}

function commandOk(command: string): boolean {
  try {
    execSync(command, { cwd: HARNESS_ROOT, encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function pythonOk(command: string): boolean {
  return commandOk(`${command} -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"`);
}

export function formatHarnessDoctor(): string {
  const scan = scanWorkflowPrerequisites();
  const venvPython = process.platform === "win32"
    ? path.join(PI_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(PI_ROOT, ".venv", "bin", "python");
  const python = pythonOk("python");
  const python3 = pythonOk("python3");
  const dpaaImport = fs.existsSync(venvPython) && commandOk(`"${venvPython}" -c "import dpaa.cli"`);
  const sbadrImport = fs.existsSync(venvPython) && commandOk(`"${venvPython}" -c "import sbadr.cli"`);
  const coreNlpDir = path.join(PI_ROOT, "corenlp");
  const coreNlpInstalled = fs.existsSync(coreNlpDir) && fs.readdirSync(coreNlpDir).some(
    (f) => f.startsWith("stanford-corenlp-") && f.endsWith(".jar") && !f.includes("javadoc") && !f.includes("sources") && !f.includes("models"),
  );
  const javaOk = commandOk("java -version");
  const checks = [
    ["runtime files", scan.ok ? "OK" : "FAIL"],
    ["git", commandOk("git --version") ? "OK" : "FAIL"],
    ["python >= 3.10", python || python3 ? "OK" : "FAIL"],
    ["python command", python ? "OK" : "WARN"],
    ["python3 command", python3 ? "OK" : "WARN"],
    ["DPAA venv", fs.existsSync(venvPython) ? "OK" : "MISSING (auto-created on first DPAA gate)"],
    ["DPAA import", dpaaImport ? "OK" : "MISSING (auto-installed on first DPAA gate)"],
    ["SBADR import", sbadrImport ? "OK" : "MISSING (auto-installed on first DPAA gate)"],
    ["java >= 17", javaOk ? "OK" : "MISSING (required for SBADR/CoreNLP)"],
    ["CoreNLP", coreNlpInstalled ? "OK" : `MISSING (auto-installed on first DPAA gate; run ${process.platform === "win32" ? ".pi/setup_corenlp.ps1" : ".pi/setup_corenlp.sh"} to install manually)`],
    ["setup_corenlp", fs.existsSync(path.join(PI_ROOT, process.platform === "win32" ? "setup_corenlp.ps1" : "setup_corenlp.sh")) ? "OK" : "MISSING"],
    ["project AGENTS.md", fs.existsSync(path.join(HARNESS_ROOT, "AGENTS.md")) ? "OK" : "FAIL"],
  ];

  return [
    banner("🩺 Harness doctor"),
    table([["Check", "Status"], ...checks]),
    "",
    formatWorkflowPrerequisiteScan(scan),
  ].join("\n");
}

// ─── Structured command catalog ───────────────────────────────────────────────────────────

const PI_EXT_ROOT = path.resolve(__dirname, "../..");
const HARNESS_EXT_ROOT = path.resolve(__dirname, "../../..");

function resolveAutoExecutable(gitRoot: string | null): { executable: string; args: string[] } {
  const root = gitRoot ?? HARNESS_EXT_ROOT;
  if (process.platform === "win32") {
    if (fs.existsSync(path.join(root, "gradlew.bat"))) return { executable: path.join(root, "gradlew.bat"), args: [] };
    if (fs.existsSync(path.join(root, "mvnw.cmd")))   return { executable: path.join(root, "mvnw.cmd"), args: [] };
  }
  if (fs.existsSync(path.join(root, "gradlew"))) return { executable: path.join(root, "gradlew"), args: [] };
  if (fs.existsSync(path.join(root, "mvnw")))   return { executable: path.join(root, "mvnw"), args: [] };
  if (fs.existsSync(path.join(root, "build.gradle")) || fs.existsSync(path.join(root, "build.gradle.kts"))) return { executable: "gradle", args: [] };
  if (fs.existsSync(path.join(root, "pom.xml")))      return { executable: "mvn", args: [] };
  return { executable: "gradle", args: [] }; // fallback
}

export const COMMAND_CATALOG: readonly CommandSpec[] = [
  {
    id: "git-status",
    description: "Show working tree status (short form)",
    executable: "git",
    fixedArgs: ["status", "--short"],
    allowedPhases: "all",
    cwdPolicy: "git-root",
    timeoutMs: 10_000,
    maxOutputBytes: 50_000,
    outputPolicy: "inline",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    id: "git-diff",
    description: "Show unstaged changes",
    executable: "git",
    fixedArgs: ["diff"],
    allowedPhases: "all",
    cwdPolicy: "git-root",
    timeoutMs: 15_000,
    maxOutputBytes: 200_000,
    outputPolicy: "inline",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    id: "git-diff-staged",
    description: "Show staged changes (ready to commit)",
    executable: "git",
    fixedArgs: ["diff", "--cached"],
    allowedPhases: "all",
    cwdPolicy: "git-root",
    timeoutMs: 15_000,
    maxOutputBytes: 200_000,
    outputPolicy: "inline",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    id: "git-log",
    description: "Show recent commit history (last 20)",
    executable: "git",
    fixedArgs: ["log", "--oneline", "-20"],
    allowedPhases: "all",
    cwdPolicy: "git-root",
    timeoutMs: 10_000,
    maxOutputBytes: 20_000,
    outputPolicy: "inline",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    id: "git-stash-list",
    description: "List git stashes",
    executable: "git",
    fixedArgs: ["stash", "list"],
    allowedPhases: "all",
    cwdPolicy: "git-root",
    timeoutMs: 10_000,
    maxOutputBytes: 20_000,
    outputPolicy: "inline",
    riskLevel: "read",
    requiresApproval: false,
  },
  {
    id: "code-quality",
    description: "Run Checkstyle/PMD/tests via codeQualityGuard",
    executable: "auto",
    fixedArgs: ["codeQualityGuard"],
    allowedPhases: ["implement", "code_review"],
    cwdPolicy: "git-root",
    timeoutMs: 300_000,
    maxOutputBytes: 500_000,
    outputPolicy: "summary",
    riskLevel: "low",
    requiresApproval: false,
  },
  {
    id: "project-test",
    description: "Run project tests",
    executable: "auto",
    fixedArgs: ["test"],
    allowedPhases: ["implement", "code_review"],
    cwdPolicy: "git-root",
    timeoutMs: 300_000,
    maxOutputBytes: 500_000,
    outputPolicy: "summary",
    riskLevel: "low",
    requiresApproval: false,
  },
  {
    id: "project-build",
    description: "Build the project (compile only, skip tests)",
    executable: "auto",
    fixedArgs: ["build", "-x", "test"],
    allowedPhases: ["implement", "code_review"],
    cwdPolicy: "git-root",
    timeoutMs: 300_000,
    maxOutputBytes: 500_000,
    outputPolicy: "summary",
    riskLevel: "low",
    requiresApproval: false,
  },
  {
    id: "dpaa-advisory",
    description: "Run DPAA ambiguity analysis on the current plan (advisory only, does not gate)",
    executable: "auto-dpaa",
    fixedArgs: [],
    allowedPhases: ["interview", "plan", "plan_review"],
    cwdPolicy: "harness-root",
    timeoutMs: 120_000,
    maxOutputBytes: 200_000,
    outputPolicy: "summary",
    riskLevel: "read",
    requiresApproval: false,
  },
];

export function getCatalogCommand(id: string): CommandSpec | undefined {
  return COMMAND_CATALOG.find((spec) => spec.id === id);
}

export function getCatalogCommandsForPhase(phase: WorkflowPhase): CommandSpec[] {
  return COMMAND_CATALOG.filter(
    (spec) => spec.allowedPhases === "all" || (spec.allowedPhases as WorkflowPhase[]).includes(phase),
  );
}

export function isPhaseAllowed(spec: CommandSpec, phase: WorkflowPhase): boolean {
  return spec.allowedPhases === "all" || (spec.allowedPhases as WorkflowPhase[]).includes(phase);
}

/**
 * Execute a catalog command with structured argv (no shell interpolation).
 * Shell injection is impossible: executable and args come exclusively from
 * the CommandSpec, never from user/LLM input.
 */
export function runCatalogCommand(
  spec: CommandSpec,
  gitRoot: string | null,
): CatalogCommandResult {
  const startMs = Date.now();
  const cwd =
    spec.cwdPolicy === "git-root" ? (gitRoot ?? HARNESS_EXT_ROOT)
    : spec.cwdPolicy === "harness-root" ? HARNESS_EXT_ROOT
    : process.cwd();

  let executable = spec.executable;
  let args = [...spec.fixedArgs];

  // Resolve "auto" executable based on project type
  if (executable === "auto") {
    const resolved = resolveAutoExecutable(gitRoot);
    executable = resolved.executable;
    args = [...resolved.args, ...args];
  }

  // Resolve "auto-dpaa" to the harness venv python
  if (executable === "auto-dpaa") {
    const venvPy = process.platform === "win32"
      ? path.join(PI_EXT_ROOT, ".venv", "Scripts", "python.exe")
      : path.join(PI_EXT_ROOT, ".venv", "bin", "python");
    executable = fs.existsSync(venvPy) ? venvPy : "python";
    args = ["-m", "dpaa.cli", ...args];
  }

  let output = "";
  let exitCode: number | null = 0;
  let truncated = false;

  try {
    // execFileSync uses argv form — no shell, no injection possible
    output = execFileSync(executable, args, {
      cwd,
      encoding: "utf-8",
      timeout: spec.timeoutMs,
      maxBuffer: spec.maxOutputBytes * 2,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim() || e.message || String(err);
    exitCode = typeof e.status === "number" ? e.status : 1;
  }

  if (output.length > spec.maxOutputBytes) {
    output = output.slice(0, spec.maxOutputBytes);
    truncated = true;
  }

  return {
    ok: exitCode === 0,
    commandId: spec.id,
    exitCode,
    output,
    truncated,
    cwd,
    elapsedMs: Date.now() - startMs,
  };
}

export function formatCatalogCommandResult(result: CatalogCommandResult, spec: CommandSpec): string {
  const status = result.ok ? "\u2705 pass" : "\u274c fail";
  const lines = [
    `${status}  ${spec.id}  (${result.elapsedMs}ms, exit ${result.exitCode ?? 0})`,
  ];
  if (spec.outputPolicy === "inline" || (spec.outputPolicy === "summary" && result.output.length < 2000)) {
    const tail = result.output.split("\n").slice(-80).join("\n").trim();
    if (tail) lines.push("", tail);
  } else if (spec.outputPolicy === "summary") {
    const tail = result.output.split("\n").slice(-30).join("\n").trim();
    if (tail) lines.push("", "(last 30 lines)", tail);
  }
  if (result.truncated) lines.push("", `\u26a0\ufe0f Output truncated at ${spec.maxOutputBytes} bytes`);
  return lines.join("\n");
}


