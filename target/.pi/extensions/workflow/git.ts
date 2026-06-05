import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
  const EXCLUDE_SUFFIX = new RegExp(
    "(" + [
      // JPA / 데이터 컨테이너 — 로직 없음
      "Entity",
      // API 데이터 운반체 — 필드 + getter/setter만
      "Dto", "VO", "Vo", "Request", "Response", "Payload",
      // Spring 설정 — Bean 선언만
      "Config", "Configuration", "Application", "Properties", "Settings",
      // 예외 / 타입 — 직접 로직 없음
      "Exception", "Error", "Enum", "Record",
      // 상수
      "Constants", "Constant",
      // 이벤트 / 메시지 데이터 컨테이너
      "Event", "Message",
      // 븷 추사치 (JPA Audit)
      "Projection",
      // 폼 데이터
      "Form",
    ].join("|") + ")$",
    "i",
  );
  const EXCLUDE_PREFIX = /^Q[A-Z]|^Migration/;

  try {
    const out = execSync(
      `find "${root}" -path "*/src/main/java/*.java" ! -name "package-info.java" 2>/dev/null`,
      { encoding: "utf-8", stdio: "pipe", maxBuffer: 10 * 1024 * 1024 }
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
