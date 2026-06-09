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
 * Cross-platform: Node.js fs API로 구현 (Windows의 find/2>/dev/null 의존성 제거).
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
      // 추상치 (JPA Audit)
      "Projection",
      // 폼 데이터
      "Form",
    ].join("|") + ")$",
    "i",
  );
  const EXCLUDE_PREFIX = /^Q[A-Z]|^Migration/;
  // 경로 구분자를 정규화해 Windows(\\ )와 Unix(/) 모두 처리
  const EXCLUDE_PATH = /[\/\\](dto|entity|model|repository)[\/\\]/;
  const MAIN_JAVA_SEGMENT = /[\/\\]src[\/\\]main[\/\\]java[\/\\]/;

  /** 지정된 디렉터리 트리에서 src/main/java 경로에 속하는 .java 파일을 재귀 탐색 */
  function collectJavaFiles(dir: string, depth: number): string[] {
    if (depth > 12) return [];
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const SKIP_DIRS = new Set(["node_modules", ".git", "build", "target", ".gradle", ".idea", ".vscode"]);
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".java") {
        if (entry.isDirectory()) continue; // 숨김 디렉터리 스킵
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        results.push(...collectJavaFiles(fullPath, depth + 1));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".java") &&
        entry.name !== "package-info.java" &&
        MAIN_JAVA_SEGMENT.test(fullPath)
      ) {
        results.push(fullPath);
      }
    }
    return results;
  }

  try {
    const mainFiles = collectJavaFiles(root, 0);
    const untested: string[] = [];
    for (const mainFile of mainFiles) {
      const className = path.basename(mainFile, ".java");
      if (EXCLUDE_SUFFIX.test(className) || EXCLUDE_PREFIX.test(className)) continue;
      if (EXCLUDE_PATH.test(mainFile)) continue;

      // Windows/Unix 모두 동작하는 경로 치환
      const sep = path.sep;
      const mainSegment = `${sep}src${sep}main${sep}java${sep}`;
      const testSegment = `${sep}src${sep}test${sep}java${sep}`;
      const testDir = mainFile
        .replace(mainSegment, testSegment)
        .replace(`${sep}${path.basename(mainFile)}`, "");
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
