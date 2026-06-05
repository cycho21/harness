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
      // JPA / 데이터 컨테이너
      "Entity", "Dto", "VO", "Vo",
      // API 경계
      "Request", "Response", "Payload", "Command", "Query",
      // Spring 설정
      "Config", "Configuration", "Application", "Properties", "Settings",
      // 웹 레이어 (통합테스트로 커버)
      "Controller", "RestController", "Advice", "Resolver",
      // 인프라 / 이벤트
      "Client", "Publisher", "Subscriber", "Consumer", "Producer",
      "Listener", "EventListener", "Event",
      // AOP / 필터 체인
      "Interceptor", "Filter", "Handler", "Aspect",
      // 예외 / 타입
      "Exception", "Error", "Enum", "Record", "Constants", "Constant",
      // 스케줄링
      "Scheduler", "Job", "Task",
      // 변환 / 매핑
      "Converter", "Mapper", "Serializer", "Deserializer", "Transformer",
      // 디자인 패턴 구조체
      "Factory", "Builder", "Adapter", "Proxy", "Decorator", "Wrapper",
      "Provider", "Registry", "Holder", "Context",
      // 조회 보조
      "Specification", "Criteria", "Projection", "Checker",
      // 응답 래퍼
      "Result", "Info", "Detail", "Summary", "Form",
      // 기타 Spring
      "Monitor", "Watcher",
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
