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

// ─── Build system detection ──────────────────────────────────────────────────

export type BuildSystemType =
  | "gradle" | "maven"
  | "npm" | "yarn" | "pnpm" | "bun"
  | "poetry" | "pip"
  | "go"
  | "cargo"
  | "make"
  | "harness"
  | "unknown";

export type BuildSystemInfo = {
  type: BuildSystemType;
  testCommand: { executable: string; args: string[] } | null;
  buildCommand: { executable: string; args: string[] } | null;
  qualityCommand: { executable: string; args: string[] } | null;
};

function hasMakeTarget(makeRoot: string, target: string): boolean {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const full = path.join(makeRoot, name);
    if (!fs.existsSync(full)) continue;
    try {
      if (new RegExp(`^${target}\\s*:`, "m").test(fs.readFileSync(full, "utf-8"))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function detectBuildSystem(root: string): BuildSystemInfo {
  const exists = (f: string) => fs.existsSync(path.join(root, f));

  // Harness source repository (this project has no root build file; target/.pi is the deployable source)
  if (exists("AGENTS.md") && exists("target/.pi/extensions/workflow.ts") && exists("tests/test_workflow_extension_runtime.py")) {
    return {
      type: "harness",
      testCommand: { executable: "python", args: ["-m", "pytest", "tests"] },
      buildCommand: null,
      qualityCommand: { executable: "python", args: ["-m", "pytest", "tests"] },
    };
  }

  // Gradle (Java/Kotlin)
  if (exists("gradlew") || exists("gradlew.bat") || exists("build.gradle") || exists("build.gradle.kts")) {
    const gradleBin =
      process.platform === "win32" && exists("gradlew.bat") ? path.join(root, "gradlew.bat")
      : exists("gradlew") ? path.join(root, "gradlew")
      : "gradle";
    let hasQualityGuard = false;
    let hasCoverageGuard = false;
    for (const f of ["build.gradle", "build.gradle.kts"]) {
      try {
        const content = exists(f) ? fs.readFileSync(path.join(root, f), "utf-8") : null;
        if (content && /\btask\s+codeQualityGuard\b/.test(content)) hasQualityGuard = true;
        if (content && /\btask\s+coverageGuard\b/.test(content)) hasCoverageGuard = true;
      } catch { /* ignore */ }
    }
    const qualityArgs = hasQualityGuard
      ? (hasCoverageGuard ? ["codeQualityGuard", "coverageGuard"] : ["codeQualityGuard"])
      : null;
    return {
      type: "gradle",
      testCommand: { executable: gradleBin, args: ["test"] },
      buildCommand: { executable: gradleBin, args: ["build", "-x", "test"] },
      qualityCommand: qualityArgs ? { executable: gradleBin, args: qualityArgs } : null,
    };
  }

  // Maven
  if (exists("pom.xml")) {
    const mvnBin =
      process.platform === "win32" && exists("mvnw.cmd") ? path.join(root, "mvnw.cmd")
      : exists("mvnw") ? path.join(root, "mvnw")
      : "mvn";
    return {
      type: "maven",
      testCommand: { executable: mvnBin, args: ["test"] },
      buildCommand: { executable: mvnBin, args: ["package", "-DskipTests"] },
      qualityCommand: { executable: mvnBin, args: ["verify", "-DskipTests"] },
    };
  }

  // Node.js — detect package manager
  if (exists("package.json")) {
    let pm: BuildSystemType = "npm";
    let pmBin = "npm";
    if (exists("bun.lockb") || exists("bun.lock")) { pm = "bun"; pmBin = "bun"; }
    else if (exists("pnpm-lock.yaml")) { pm = "pnpm"; pmBin = "pnpm"; }
    else if (exists("yarn.lock")) { pm = "yarn"; pmBin = "yarn"; }
    let hasLint = false;
    let hasTest = false;
    let hasBuild = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
      hasLint = !!pkg.scripts?.lint;
      hasTest = !!pkg.scripts?.test;
      hasBuild = !!pkg.scripts?.build;
    } catch { /* ignore */ }
    return {
      type: pm,
      testCommand: hasTest ? { executable: pmBin, args: ["run", "test"] } : null,
      buildCommand: hasBuild ? { executable: pmBin, args: ["run", "build"] } : null,
      qualityCommand: hasLint ? { executable: pmBin, args: ["run", "lint"] } : null,
    };
  }

  // Python (Poetry — check before generic pip)
  if (exists("poetry.lock") || (exists("pyproject.toml") && (() => {
    try { return fs.readFileSync(path.join(root, "pyproject.toml"), "utf-8").includes("[tool.poetry]"); } catch { return false; }
  })())) {
    return {
      type: "poetry",
      testCommand: { executable: "poetry", args: ["run", "pytest"] },
      buildCommand: { executable: "poetry", args: ["build"] },
      qualityCommand: null,
    };
  }

  // Python (pip/setuptools/pyproject)
  if (exists("pyproject.toml") || exists("setup.py") || exists("setup.cfg") || exists("requirements.txt")) {
    return {
      type: "pip",
      testCommand: { executable: "pytest", args: [] },
      buildCommand: null,
      qualityCommand: null,
    };
  }

  // Go
  if (exists("go.mod")) {
    return {
      type: "go",
      testCommand: { executable: "go", args: ["test", "./..."] },
      buildCommand: { executable: "go", args: ["build", "./..."] },
      qualityCommand: { executable: "go", args: ["vet", "./..."] },
    };
  }

  // Rust
  if (exists("Cargo.toml")) {
    return {
      type: "cargo",
      testCommand: { executable: "cargo", args: ["test"] },
      buildCommand: { executable: "cargo", args: ["build"] },
      qualityCommand: { executable: "cargo", args: ["clippy", "--", "-D", "warnings"] },
    };
  }

  // Make (generic fallback)
  if (exists("Makefile") || exists("makefile") || exists("GNUmakefile")) {
    return {
      type: "make",
      testCommand: hasMakeTarget(root, "test") ? { executable: "make", args: ["test"] } : null,
      buildCommand: hasMakeTarget(root, "build") ? { executable: "make", args: ["build"] } : null,
      qualityCommand: hasMakeTarget(root, "lint") ? { executable: "make", args: ["lint"] } : null,
    };
  }

  return { type: "unknown", testCommand: null, buildCommand: null, qualityCommand: null };
}

// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowPrerequisiteScan = {
  ok: boolean;
  root: string;
  missingRequired: string[];
  warnings: string[];
};

export function scanWorkflowPrerequisites(root: string = HARNESS_ROOT): WorkflowPrerequisiteScan {
  const exists = (relativePath: string) => fs.existsSync(path.join(root, relativePath));

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
  const warnings: string[] = [];

  const bs = detectBuildSystem(projectRoot);

  if (bs.type === "unknown" && !process.env.HARNESS_CODE_QUALITY_GUARD_CMD) {
    warnings.push("No recognized build system found. Set HARNESS_CODE_QUALITY_GUARD_CMD to enable the code quality gate.");
  }

  if (bs.type === "gradle") {
    const projectAnyExists = (relativePaths: string[]) =>
      relativePaths.some((p) => fs.existsSync(path.join(projectRoot, p)));
    if (!projectAnyExists(["config/checkstyle/checkstyle.xml", "checkstyle.xml", "config/checkstyle/sun_checks.xml", "config/checkstyle/google_checks.xml"])) {
      warnings.push("Checkstyle config not found; Checkstyle guard may be incomplete.");
    }
    if (!bs.qualityCommand && !process.env.HARNESS_CODE_QUALITY_GUARD_CMD) {
      warnings.push("Gradle codeQualityGuard task not found; add it to build.gradle or set HARNESS_CODE_QUALITY_GUARD_CMD.");
    }
  } else if (bs.type !== "unknown" && bs.qualityCommand === null && !process.env.HARNESS_CODE_QUALITY_GUARD_CMD) {
    warnings.push(`No code quality gate detected for ${bs.type} project. Set HARNESS_CODE_QUALITY_GUARD_CMD to enable.`);
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
  const projectRootForDoctor = getGitRoot() ?? HARNESS_ROOT;
  const bs = detectBuildSystem(projectRootForDoctor);
  const qualityGateLabel = bs.qualityCommand
    ? `${bs.qualityCommand.executable} ${bs.qualityCommand.args.join(" ")}`
    : process.env.HARNESS_CODE_QUALITY_GUARD_CMD
      ? "env:HARNESS_CODE_QUALITY_GUARD_CMD"
      : "NOT CONFIGURED (set HARNESS_CODE_QUALITY_GUARD_CMD)";
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
    ["project build system", bs.type],
    ["code quality gate", qualityGateLabel],
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
    description: "Run code quality checks (lint/checkstyle/vet/clippy) for the detected build system",
    executable: "auto-quality",
    fixedArgs: [],
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
    description: "Run project tests for the detected build system",
    executable: "auto-test",
    fixedArgs: [],
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
    description: "Build the project (skip tests) for the detected build system",
    executable: "auto-build",
    fixedArgs: [],
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

  // Resolve build-system-aware sentinels (auto-test / auto-build / auto-quality)
  if (executable === "auto-test" || executable === "auto-build" || executable === "auto-quality") {
    const bs = detectBuildSystem(cwd);
    const action = executable.slice(5) as "test" | "build" | "quality";
    const cmd = action === "test" ? bs.testCommand : action === "build" ? bs.buildCommand : bs.qualityCommand;
    if (!cmd) {
      return {
        ok: false,
        commandId: spec.id,
        exitCode: null,
        output: `No ${action} command detected for ${bs.type} project. Set HARNESS_CODE_QUALITY_GUARD_CMD or add a recognized build system file.`,
        truncated: false,
        cwd,
        elapsedMs: Date.now() - startMs,
      };
    }
    executable = cmd.executable;
    args = [...cmd.args, ...args];
  }

  // Resolve legacy "auto" executable based on project type (backward compatibility)
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

  // Windows: .bat files must be run through cmd.exe (execFileSync cannot execute .bat directly)
  if (process.platform === "win32" && /\.bat$/i.test(executable)) {
    args = ["/c", executable, ...args];
    executable = "cmd.exe";
  }
  // Windows: shell scripts need explicit sh/bash
  if (process.platform === "win32" && /[/\\]gradlew$/.test(executable)) {
    const sh = process.env.ComSpec ?? "cmd.exe";
    args = ["/c", executable, ...args];
    executable = sh;
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


