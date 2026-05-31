import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function isApprovalText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const approvals = ["응", "네", "예", "좋아", "좋습니다", "진행해", "진행해줘", "계속해", "다음", "승인", "approve", "approved", "ok", "okay", "go ahead", "continue"];
  return approvals.some((token) => normalized === token || normalized.includes(token));
}

export function isGitPush(cmd: string): boolean {
  const normalized = cmd
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/git\s+-C\s+\S+/g, "git");
  return /(?:^|[|;&\s])git\s+push(?:\s|$)/.test(normalized);
}

export function hasGitDashC(cmd: string): boolean {
  return /(?:^|[|;&\s])git\s+-C\s+\S+/.test(cmd);
}

export function getGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

export function getBranch(root: string): string {
  try {
    return execSync(`git -C "${root}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * 테스트 없는 production Java 클래스 목록 반환.
 * hook-common.sh의 is_unimportant_file 패턴과 동일한 제외 규칙 적용.
 */
export function getUntestedClasses(root: string): string[] {
  const EXCLUDE_SUFFIX =
    /(DTO|Request|Response|Config|Configuration|Application|Properties|Exception|Error|Enum|Record|Constants|Client|Publisher|Checker|Aspect|Controller|Result)$/;
  const EXCLUDE_PREFIX = /^Q[A-Z]|^Migration/;

  try {
    const out = execSync(
      `find "${root}" -path "*/src/main/java/*.java" ! -name "package-info.java" 2>/dev/null`,
      { encoding: "utf-8", stdio: "pipe" }
    ).trim();
    if (!out) return [];

    const untested: string[] = [];
    for (const mainFile of out.split("\n").filter(Boolean)) {
      const className = path.basename(mainFile, ".java");
      if (EXCLUDE_SUFFIX.test(className) || EXCLUDE_PREFIX.test(className)) continue;
      if (/\/dto\/|\/entity\/|\/model\/|\/repository\//.test(mainFile)) continue;

      const testDir = mainFile
        .replace("/src/main/java/", "/src/test/java/")
        .replace(`/${path.basename(mainFile)}`, "");
      const testFile = path.join(testDir, `${className}Test.java`);
      if (!fs.existsSync(testFile)) {
        untested.push(className);
      }
    }
    return untested;
  } catch {
    return [];
  }
}
