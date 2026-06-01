import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGitRoot } from "./git";
import { banner, table } from "./ui";

// This file lives at: <harness-root>/.pi/extensions/workflow/catalog.ts
const HARNESS_ROOT = path.resolve(__dirname, "../../..");
const PI_ROOT = path.join(HARNESS_ROOT, ".pi");
const WORKFLOW_DIR = path.join(PI_ROOT, "workflows");

export type WorkflowTemplate = {
  id: string;
  title: string;
  path: string;
  content: string;
  summary: string;
};

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
    ".pi/setup_corenlp.sh",
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
    ["CoreNLP", coreNlpInstalled ? "OK" : "MISSING (auto-installed on first DPAA gate; run .pi/setup_corenlp.sh to install manually)"],
    ["project AGENTS.md", fs.existsSync(path.join(HARNESS_ROOT, "AGENTS.md")) ? "OK" : "FAIL"],
  ];

  return [
    banner("🩺 Harness doctor"),
    table([["Check", "Status"], ...checks]),
    "",
    formatWorkflowPrerequisiteScan(scan),
  ].join("\n");
}

export function listWorkflowTemplates(): WorkflowTemplate[] {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  return fs.readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readWorkflowTemplate(path.basename(name, ".md")))
    .filter((template): template is WorkflowTemplate => template !== null);
}

export function readWorkflowTemplate(id: string): WorkflowTemplate | null {
  const safeId = id.trim().replace(/\.md$/, "");
  if (!/^[a-zA-Z0-9._-]+$/.test(safeId)) return null;

  const file = path.join(WORKFLOW_DIR, `${safeId}.md`);
  if (!fs.existsSync(file)) return null;

  const content = fs.readFileSync(file, "utf-8");
  const lines = content.split(/\r?\n/);
  const title = lines.find((line) => line.startsWith("# "))?.replace(/^#\s+/, "").trim() || safeId;
  const summary = lines
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith("```"))
    .slice(0, 3)
    .join(" ")
    .slice(0, 180);

  return { id: safeId, title, path: file, content, summary };
}

export function formatWorkflowTemplateList(templates: WorkflowTemplate[]): string {
  if (templates.length === 0) {
    return [
      banner("📚 Workflow 목록 없음"),
      `디렉터리: ${WORKFLOW_DIR}`,
    ].join("\n");
  }

  return [
    banner("📚 Workflow 목록"),
    table([
      ["ID", "Title", "Summary"],
      ...templates.map((template) => [template.id, template.title, template.summary || "-"]),
    ]),
    "",
    "메모리에 불러오기: /workflow load <id>",
  ].join("\n");
}

export function formatLoadedWorkflowTemplate(template: WorkflowTemplate | null): string {
  if (!template) return "📚 Loaded workflow: 없음";
  return [
    banner("📚 Loaded workflow"),
    table([
      ["항목", "값"],
      ["ID", template.id],
      ["Title", template.title],
      ["Path", path.relative(process.cwd(), template.path)],
    ]),
  ].join("\n");
}

export function formatLoadedWorkflowPrompt(template: WorkflowTemplate | null): string {
  if (!template) return "";
  return [
    "",
    "[Loaded Workflow Template]",
    `ID: ${template.id}`,
    `Title: ${template.title}`,
    "The user explicitly loaded this workflow into memory with /workflow load.",
    "Follow this workflow as procedural guidance unless the user overrides it.",
    "",
    template.content,
  ].join("\n");
}
