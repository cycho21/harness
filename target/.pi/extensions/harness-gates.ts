/**
 * harness-gates.ts — Pi Extension
 *
 * 기존 harness의 final-stage 게이트를 Pi extension으로 구현.
 * 핵심 개선: 파일 기반 토큰 → 프로세스 메모리 토큰 (LLM이 bash로 위조 불가)
 *
 * 구현 게이트:
 *   1. Code Review Gate  — git commit 전 /skill:code-review 필수
 *   2. Commit Message Gate — Conventional Commits 형식 강제
 *
 * 추가 기능:
 *   - resources_discover: 기존 harness skills 경로를 Pi에 자동 등록
 *   - session_start: 브랜치/미테스트 클래스 컨텍스트 주입
 *   - before_agent_start: 매 턴 gate 상태를 system prompt에 주입
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// 이 파일이 있는 곳: <harness-root>/.pi/extensions/harness-gates.ts
const HARNESS_ROOT = path.resolve(__dirname, "../..");

export default function (pi: ExtensionAPI) {
  // ── In-memory state ────────────────────────────────────────────────────────
  // 프로세스 메모리에만 존재 → LLM이 bash 도구로 접근/위조 불가
  const state = {
    reviewResult: null as {
      critical: number;
      major: number;
      minor: number;
      timestamp: number;
    } | null,
    workflow: null as WorkflowInstance | null,
  };

  // ── resources_discover: 기존 harness skills Pi에 등록 ──────────────────────
  pi.on("resources_discover", async () => {
    const skillsPath = path.join(HARNESS_ROOT, ".pi", "skills");
    if (!fs.existsSync(skillsPath)) return;
    return { skillPaths: [skillsPath] };
  });

  // ── Tool: submit_review_result ─────────────────────────────────────────────
  // code-review 스킬 완료 후 LLM이 반드시 호출해야 하는 도구.
  // 이 호출이 in-memory 토큰을 생성하며, 토큰 없이는 git commit이 차단됨.
  pi.registerTool({
    name: "submit_review_result",
    label: "리뷰 결과 제출",
    description: [
      "코드 리뷰 완료 후 반드시 호출해야 하는 도구.",
      "호출 시 in-memory 커밋 허가 토큰이 생성됩니다.",
      "이 토큰 없이는 git commit이 infrastructure 레벨에서 차단됩니다.",
      "리뷰 섹션(Critical/Major/Minor)별 이슈 수를 정확히 전달하세요.",
    ].join(" "),
    parameters: Type.Object({
      critical: Type.Number({ description: "🔴 Critical 이슈 개수 (0이어야 커밋 허용)" }),
      major:    Type.Number({ description: "🟡 Major 이슈 개수 (2 이하여야 커밋 허용)" }),
      minor:    Type.Number({ description: "🔵 Minor 이슈 개수" }),
    }),
    async execute(_id, params) {
      state.reviewResult = { ...params, timestamp: Date.now() };

      const ok = params.critical === 0 && params.major <= 2;
      const verdict = ok ? "✅ 커밋 가능" : "❌ 이슈 수정 필요";
      const lines = [
        `리뷰 토큰 발급됨 [${verdict}]`,
        `  Critical : ${params.critical}개  (기준: 0)`,
        `  Major    : ${params.major}개  (기준: ≤2)`,
        `  Minor    : ${params.minor}개`,
        ok
          ? "→ git commit 허용됩니다 (TTL 60분)"
          : "→ 이슈 수정 후 /skill:code-review 재실행 후 커밋하세요",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  // ── Command: /workflow — advisory workflow state manager ──────────────────
  pi.registerCommand("workflow", {
    description: "인터뷰→계획→구현→리뷰→푸시 workflow 상태를 관리합니다",
    getArgumentCompletions: (prefix) => {
      const commands = ["start", "approve", "status", "undo", "redo", "history", "abort", "state"];
      return commands
        .filter((command) => command.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (command === "start") {
        if (state.workflow && state.workflow.phase !== "done") {
          ctx.ui.notify(
            `이미 진행 중인 workflow가 있습니다: ${state.workflow.phase}\n` +
              "먼저 /workflow status, /workflow approve, /workflow abort 중 하나를 사용하세요.",
            "warning",
          );
          return;
        }

        state.workflow = createWorkflow(rest.join(" "));
        ctx.ui.notify(formatWorkflowStatus(state.workflow), "info");
        return;
      }

      if (command === "approve") {
        const result = advanceWorkflow(state.workflow, "user_approved");
        if (!result.ok) {
          ctx.ui.notify(result.message, "warning");
          return;
        }
        ctx.ui.notify(result.message, "info");
        return;
      }

      if (command === "undo") {
        const result = undoWorkflow(state.workflow);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }

      if (command === "redo") {
        const result = redoWorkflow(state.workflow);
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }

      if (command === "history") {
        ctx.ui.notify(formatWorkflowHistory(state.workflow), "info");
        return;
      }

      if (command === "abort") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다.", "info");
          return;
        }
        const ok = !ctx.hasUI || (await ctx.ui.confirm("Abort workflow", `현재 workflow(${state.workflow.phase})를 종료할까요?`));
        if (!ok) return;
        state.workflow = null;
        ctx.ui.notify("Workflow를 종료했습니다.", "info");
        return;
      }

      if (command === "state") {
        const next = rest[0] as WorkflowPhase | undefined;
        if (!next || !WORKFLOW_PHASES.includes(next)) {
          ctx.ui.notify(`사용법: /workflow state <${WORKFLOW_PHASES.join("|")}>`, "warning");
          return;
        }
        if (!state.workflow) state.workflow = createWorkflow("manual");
        transitionWorkflow(state.workflow, next, "manual_override");
        ctx.ui.notify(formatWorkflowStatus(state.workflow), "info");
        return;
      }

      ctx.ui.notify(formatWorkflowStatus(state.workflow), "info");
    },
  });

  // ── Natural approval: "응, 진행해" → workflow advance ─────────────────────
  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    if (!state.workflow || state.workflow.phase === "done") return { action: "continue" };
    if (!isApprovalText(event.text)) return { action: "continue" };

    const result = advanceWorkflow(state.workflow, "natural_language_approval");
    if (!result.ok) return { action: "continue" };

    return {
      action: "transform",
      text: [
        event.text,
        "",
        `[Workflow] 사용자 승인으로 '${state.workflow.phase}' 단계로 전이되었습니다.`,
        `현재 단계에 맞는 작업을 진행하세요. 다음 단계로 넘어가기 전에는 사용자 확인을 요청하세요.`,
      ].join("\n"),
    };
  });

  // ── Gate: tool_call(bash) → git commit 차단 ────────────────────────────────
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const cmd = String((event.input as any).command ?? "");
    if (!isGitCommit(cmd)) return;

    // ── Gate 1: Conventional Commits 형식 검사 ──────────────────────────────
    const rawMsg = extractCommitMessage(cmd);
    if (rawMsg !== null && !isConventionalCommit(rawMsg)) {
      return {
        block: true,
        reason: [
          "── 📝 COMMIT MESSAGE FORMAT ───────────",
          "",
          `  현재: "${rawMsg}"`,
          `  필요: "<type>(<scope>): <description>"`,
          "",
          "  type: feat | fix | chore | refactor | docs | test | perf | ci | style | revert",
          "  scope: 소문자 영숫자 + 하이픈 (선택)",
          "  description: 1~100자",
          "",
          "──────────────────────────────────────",
        ].join("\n"),
      };
    }

    // ── Gate 2: 코드 리뷰 토큰 없음 ─────────────────────────────────────────
    if (!state.reviewResult) {
      return {
        block: true,
        reason: [
          "── 🔍 CODE REVIEW REQUIRED ────────────",
          "",
          "  커밋 전 코드 리뷰가 필요합니다.",
          "",
          "  ① /skill:code-review 실행",
          "  ② 리뷰 완료 → submit_review_result 도구 호출",
          "  ③ Critical 0 + Major ≤2 확인",
          "  ④ 커밋 재시도",
          "",
          "  [파일 토큰 없음 — 메모리 토큰만 허용]",
          "  bash로 파일 생성하는 방식의 우회는 동작하지 않습니다.",
          "",
          "──────────────────────────────────────",
        ].join("\n"),
      };
    }

    // ── Gate 3: TTL 만료 (60분) ──────────────────────────────────────────────
    const ageMin = (Date.now() - state.reviewResult.timestamp) / 60_000;
    if (ageMin > 60) {
      const elapsed = Math.floor(ageMin);
      state.reviewResult = null;
      return {
        block: true,
        reason: [
          `── ⏰ 리뷰 만료 (${elapsed}분 경과) ────────`,
          "",
          "  리뷰 토큰의 유효 시간(60분)이 초과되었습니다.",
          "  /skill:code-review 를 다시 실행하세요.",
          "",
          "──────────────────────────────────────",
        ].join("\n"),
      };
    }

    // ── Gate 4: Critical / Major 기준 미달 ───────────────────────────────────
    const { critical, major } = state.reviewResult;
    if (critical > 0 || major > 2) {
      const r = state.reviewResult;
      state.reviewResult = null;
      return {
        block: true,
        reason: [
          "── 🔍 CODE REVIEW 미통과 ────────────",
          "",
          `  Critical : ${r.critical}개  (기준: 0)`,
          `  Major    : ${r.major}개  (기준: ≤2)`,
          "",
          "  ① 지적된 이슈 수정",
          "  ② /skill:code-review 재실행",
          "  ③ 커밋 재시도",
          "",
          "──────────────────────────────────────",
        ].join("\n"),
      };
    }

    // ✅ 모든 게이트 통과 → 토큰 소비 (단일 커밋에 1회만 유효)
    state.reviewResult = null;
  });

  // ── session_start: 상태 초기화 + 세션 컨텍스트 알림 ───────────────────────
  pi.on("session_start", async (_event, ctx) => {
    state.reviewResult = null;

    const root = getGitRoot();
    if (!root) return;

    const branch = getBranch(root);
    const untested = getUntestedClasses(root);

    const parts = [`브랜치: ${branch}`];
    if (untested.length === 0) {
      parts.push("미테스트 클래스: 없음 ✅");
    } else {
      const preview = untested.slice(0, 5).join(", ");
      const extra = untested.length > 5 ? ` 외 ${untested.length - 5}개` : "";
      parts.push(`미테스트 클래스: ${preview}${extra}`);
    }

    ctx.ui.notify(`Harness Gates 로드 | ${parts.join(" | ")}`, "info");
  });

  // ── before_agent_start: 매 턴 gate 상태를 system prompt에 주입 ─────────────
  //
  // 거절 메시지(context)로만 규칙을 전달하는 방식과 달리,
  // system prompt에 주입하면 LLM이 이를 "극복할 장애물"이 아닌
  // "자신이 따라야 할 규칙"으로 인식합니다.
  pi.on("before_agent_start", async (event) => {
    const root = getGitRoot();
    const branch = root ? getBranch(root) : "unknown";

    let reviewStatus: string;
    if (!state.reviewResult) {
      reviewStatus = "미실행 ❌";
    } else {
      const ageMin = Math.floor((Date.now() - state.reviewResult.timestamp) / 60_000);
      const { critical, major } = state.reviewResult;
      reviewStatus = `완료 ✅  (Critical: ${critical}, Major: ${major}, ${ageMin}분 전)`;
    }

    const injection = [
      "",
      "[Harness Gate — 현재 상태]",
      `브랜치: ${branch}`,
      `코드 리뷰 토큰: ${reviewStatus}`,
      "",
      "[Workflow State — advisory]",
      formatWorkflowPrompt(state.workflow),
      "",
      "[Gate 규칙 — infrastructure 레벨 강제, 우회 불가]",
      "• git commit 전 /skill:code-review 실행 필수",
      "• 리뷰 완료 후 submit_review_result 도구를 반드시 호출할 것",
      "  (이 호출이 메모리 토큰을 생성하며, 토큰 없이는 commit이 차단됨)",
      "• 토큰은 프로세스 메모리에만 존재 — bash 파일 생성으로 우회 불가",
      "• 커밋 메시지는 Conventional Commits 형식 필수",
      "  <type>(<scope>): <description>",
    ].join("\n");

    return { systemPrompt: event.systemPrompt + injection };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

type WorkflowPhase =
  | "interview"
  | "plan"
  | "plan_review"
  | "implement"
  | "code_review"
  | "document"
  | "commit"
  | "push"
  | "done";

type WorkflowTransition = {
  from: WorkflowPhase;
  to: WorkflowPhase;
  reason: string;
  timestamp: number;
};

type WorkflowInstance = {
  id: string;
  title: string;
  phase: WorkflowPhase;
  history: WorkflowTransition[];
  undone: WorkflowTransition[];
  startedAt: number;
  updatedAt: number;
};

const WORKFLOW_PHASES: WorkflowPhase[] = [
  "interview",
  "plan",
  "plan_review",
  "implement",
  "code_review",
  "document",
  "commit",
  "push",
  "done",
];

function createWorkflow(title: string): WorkflowInstance {
  const now = Date.now();
  return {
    id: `wf-${new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`,
    title: title || "workflow",
    phase: "interview",
    history: [],
    undone: [],
    startedAt: now,
    updatedAt: now,
  };
}

function getNextPhase(phase: WorkflowPhase): WorkflowPhase | null {
  const index = WORKFLOW_PHASES.indexOf(phase);
  return index >= 0 ? WORKFLOW_PHASES[index + 1] ?? null : null;
}

function transitionWorkflow(workflow: WorkflowInstance, to: WorkflowPhase, reason: string): void {
  const from = workflow.phase;
  if (from !== to) {
    workflow.history.push({ from, to, reason, timestamp: Date.now() });
    workflow.undone = [];
  }
  workflow.phase = to;
  workflow.updatedAt = Date.now();
}

function advanceWorkflow(workflow: WorkflowInstance | null, reason: string): { ok: boolean; message: string } {
  if (!workflow) return { ok: false, message: "진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요." };
  const next = getNextPhase(workflow.phase);
  if (!next) return { ok: false, message: `이미 마지막 단계입니다: ${workflow.phase}` };
  transitionWorkflow(workflow, next, reason);
  return { ok: true, message: `Workflow 전이: ${workflow.history.at(-1)?.from} → ${workflow.phase}` };
}

function undoWorkflow(workflow: WorkflowInstance | null): { ok: boolean; message: string } {
  if (!workflow) return { ok: false, message: "진행 중인 workflow가 없습니다." };
  const last = workflow.history.pop();
  if (!last) return { ok: false, message: "되돌릴 workflow 전이가 없습니다." };
  workflow.phase = last.from;
  workflow.undone.push(last);
  workflow.updatedAt = Date.now();
  return { ok: true, message: `Workflow undo: ${last.to} → ${last.from}` };
}

function redoWorkflow(workflow: WorkflowInstance | null): { ok: boolean; message: string } {
  if (!workflow) return { ok: false, message: "진행 중인 workflow가 없습니다." };
  const next = workflow.undone.pop();
  if (!next) return { ok: false, message: "다시 실행할 workflow 전이가 없습니다." };
  workflow.phase = next.to;
  workflow.history.push(next);
  workflow.updatedAt = Date.now();
  return { ok: true, message: `Workflow redo: ${next.from} → ${next.to}` };
}

function formatWorkflowStatus(workflow: WorkflowInstance | null): string {
  if (!workflow) return "Workflow: 없음\n시작: /workflow start <목표>";
  const next = getNextPhase(workflow.phase);
  return [
    `Workflow: ${workflow.id}`,
    `목표: ${workflow.title}`,
    `현재 단계: ${workflow.phase}`,
    `다음 단계: ${next ?? "없음"}`,
    `Undo 가능: ${workflow.history.length > 0 ? "yes" : "no"}`,
    `Redo 가능: ${workflow.undone.length > 0 ? "yes" : "no"}`,
  ].join("\n");
}

function formatWorkflowHistory(workflow: WorkflowInstance | null): string {
  if (!workflow) return "진행 중인 workflow가 없습니다.";
  if (workflow.history.length === 0) return "Workflow 전이 이력이 없습니다.";
  return workflow.history
    .map((item, index) => `${index + 1}. ${item.from} → ${item.to} (${item.reason})`)
    .join("\n");
}

function formatWorkflowPrompt(workflow: WorkflowInstance | null): string {
  if (!workflow) {
    return [
      "• 진행 중인 workflow 없음",
      "• 새 작업을 절차적으로 진행하려면 /workflow start <목표> 를 사용자에게 제안하세요.",
    ].join("\n");
  }
  const next = getNextPhase(workflow.phase);
  return [
    `• 현재 단계: ${workflow.phase}`,
    `• 다음 단계: ${next ?? "없음"}`,
    "• 현재 단계의 산출물을 먼저 제시하고, 다음 단계 전에는 사용자 확인을 요청하세요.",
    "• 사용자는 /workflow approve 또는 '응, 진행해' 같은 자연어 승인으로 다음 단계 전이를 승인할 수 있습니다.",
    "• 이 workflow는 advisory layer입니다. commit/push의 최종 차단은 기존 Harness Gate가 계속 담당합니다.",
  ].join("\n");
}

function isApprovalText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const approvals = ["응", "네", "예", "좋아", "좋습니다", "진행해", "진행해줘", "계속해", "다음", "승인", "approve", "approved", "ok", "okay", "go ahead", "continue"];
  return approvals.some((token) => normalized === token || normalized.includes(token));
}

/** bash 명령이 git commit인지 판별 (hook-common.sh의 is_git_commit과 동일 로직) */
function isGitCommit(cmd: string): boolean {
  const normalized = cmd
    .replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/git\s+-C\s+\S+/g, "git");
  return /(?:^|[|;&\s])git\s+commit(?:\s|$)/.test(normalized);
}

/** -m 옵션의 커밋 메시지 추출. heredoc/-F 방식이면 null 반환 (검사 불가) */
function extractCommitMessage(cmd: string): string | null {
  const sq = cmd.match(/-m\s+'([^']+)'/);
  if (sq) return sq[1];
  const dq = cmd.match(/-m\s+"([^"]+)"/);
  if (dq) return dq[1];
  return null;
}

/** Conventional Commits 형식 검사 (guard-commit-message.sh 패턴과 동일) */
function isConventionalCommit(msg: string): boolean {
  return /^(feat|fix|chore|refactor|docs|test|perf|ci|style|revert)(\([a-z0-9][a-z0-9-]*\))?!?:\s.{1,100}$/.test(
    msg.trim()
  );
}

function getGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

function getBranch(root: string): string {
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
function getUntestedClasses(root: string): string[] {
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
