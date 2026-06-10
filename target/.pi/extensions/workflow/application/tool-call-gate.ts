import * as fs from "node:fs";
import * as path from "node:path";

import type { WorkflowRuntimeState } from "../runtime-state";
import { ensureExtensionMutationApproved } from "./extension-mutation-approval";
import { isProductionClassPath } from "../domain/production-class-policy";
import { consumeSkipToken, formatGateBlocked, formatPushPolicyScanBlocked, scanPushPolicy, validateWorkflowWorkspace } from "../gates";
import { getGitRoot, hasGitDashC, isGitPush } from "../git";
import { formatWorkspaceMismatch } from "../format";
import { getPhaseWritePathPolicy, isWritePathBlocked, PHASE_ALLOWED_BUILTIN_TOOLS } from "../policy-core";
import { writeFieldLogEvent } from "../field-log";

export type WorkflowToolCallEvent = {
  toolName: string;
  input: unknown;
};

export type WorkflowToolCallContext = {
  hasUI?: boolean;
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
  };
};

export type WorkflowToolCallDeps = {
  steerLlm: (message: string, deliverAs?: "followUp" | "steer") => Promise<void>;
};

export type WorkflowToolCallDecision = void | { block: true; reason: string };

export async function handleWorkflowToolCall(
  state: WorkflowRuntimeState,
  event: WorkflowToolCallEvent,
  ctx: WorkflowToolCallContext,
  deps: WorkflowToolCallDeps,
): Promise<WorkflowToolCallDecision> {
  const extensionApproval = await ensureExtensionMutationApproved(state, event.toolName, event.input, ctx);
  if (!extensionApproval.ok) return { block: true, reason: extensionApproval.reason };

  const writeDecision = handleWriteToolPolicy(state, event, deps);
  if (writeDecision) return writeDecision;

  if (event.toolName !== "bash") return;

  const cmd = String((event.input as any).command ?? "");
  recordVerificationCommand(state, cmd);
  if (!isGitPush(cmd)) return;

  const pushDecision = await handleGitPushToolCall(state, cmd, ctx, deps);
  if (pushDecision) return pushDecision;
}

function handleWriteToolPolicy(
  state: WorkflowRuntimeState,
  event: WorkflowToolCallEvent,
  deps: WorkflowToolCallDeps,
): WorkflowToolCallDecision {
  if (state.workflow?.phase === "implement" && (event.toolName === "write" || event.toolName === "edit")) {
    const filePath = String((event.input as any).path ?? "");
    const gitRoot = state.workflow.gitRoot ?? getGitRoot();
    if (gitRoot && isProductionClassPath(filePath, gitRoot)) {
      const className = path.basename(filePath, ".java");
      const testPath = filePath
        .replace(/[\\/]src[\\/]main[\\/]java[\\/]/, "/src/test/java/".replace(/\//g, path.sep))
        .replace(/\.java$/, "Test.java");
      const isNewFile = !fs.existsSync(path.resolve(filePath));
      const testExists = fs.existsSync(path.resolve(testPath));
      if (!testExists) {
        if (isNewFile) {
          return {
            block: true,
            reason: [
              `🧪 TDD: ${className}Test.java를 먼저 작성하세요.`,
              `새 클래스를 작성하기 전에 테스트를 먼저 작성하세요.`,
              `예상 테스트 경로: ${testPath}`,
              `[INSTRUCTION] 사용자에게 승인을 구하지 말고 즉시 자율적으로 위 경로에 테스트 파일을 작성한 뒤 원래 작업을 계속하세요.`,
            ].join("\n"),
          };
        } else {
          void deps.steerLlm(
            `🧪 TDD 참고: ${className}에 대한 테스트 파일이 없습니다 (${testPath}). 가능하면 테스트를 먼저 작성하세요.`,
            "steer",
          );
        }
      }
    }
  }

  if (state.workflow && (event.toolName === "write" || event.toolName === "edit")) {
    const phase = state.workflow.phase;
    const phaseAllowed = PHASE_ALLOWED_BUILTIN_TOOLS[phase] as readonly string[] | undefined;
    if (phaseAllowed && !phaseAllowed.includes(event.toolName)) {
      if (phase === "commit" || phase === "push") {
        return {
          block: true,
          reason: `⚠️ ${phase} 페이즈에서는 파일 수정이 허용되지 않습니다. 코드 변경이 필요하면 implement 페이즈로 돌아가세요.`,
        };
      }
      if (phase === "done") {
        void deps.steerLlm("workflow가 완료됐습니다. 추가 변경이 필요하면 /workflow start로 새 workflow를 시작하세요.");
      }
      const phaseGuide: Record<string, string> = {
        plan_review: "plan_review 페이즈입니다. 파일을 수정하기 전에 plan 검토를 완료하고 workflow_approve로 implement 단계로 진행하세요.",
        code_review: "code_review 페이즈입니다. 소스 수정이 필요하다면 implement 페이즈로 돌아가거나, 리뷰를 먼저 완료하세요.",
        review_approved: "review_approved 페이즈입니다. 문서화 작업만 필요하며 소스 수정은 이 단계에서 하지 않습니다.",
      };
      const guide = phaseGuide[phase] ?? `${phase} 페이즈에서는 소스 수정이 계획에 없습니다.`;
      return { block: true, reason: `⚠️ ${guide}` };
    }

    const pathPolicy = getPhaseWritePathPolicy(state.workflow.phase);
    if (pathPolicy) {
      const filePath = String((event.input as any).path ?? "");
      if (filePath) {
        const gitRoot = state.workflow.gitRoot ?? getGitRoot();
        const relPath = gitRoot
          ? path.relative(gitRoot, path.resolve(gitRoot, filePath)).replace(/\\/g, "/")
          : filePath.replace(/\\/g, "/");
        if (isWritePathBlocked(relPath, pathPolicy)) {
          const hint = pathPolicy.mode === "deny"
            ? `${state.workflow.phase} 페이즈에서는 문서(마크다운, HTML 등)만 작성할 수 있습니다. 소스 코드 수정이 필요하다면 implement 페이즈로 돌아가세요.`
            : `이 페이즈에서 허용된 경로: ${pathPolicy.patterns.join(", ")}.`;
          return { block: true, reason: `⚠️ ${hint}` };
        }
      }
    }
  }
}

function recordVerificationCommand(state: WorkflowRuntimeState, cmd: string): void {
  if (/\b(pytest|npm\s+(test|run\s+(test|lint|typecheck|build))|pnpm\s+(test|lint|typecheck|build)|yarn\s+(test|lint|typecheck|build)|gradle(w|\.bat)?\s+.*(test|check|build|codeQualityGuard)|mvn\s+.*(test|verify|package)|go\s+test|cargo\s+(test|clippy)|tsc\b|eslint\b|ruff\b|mypy\b)\b/i.test(cmd)) {
    state.recentVerificationCommands.push({ command: cmd, timestamp: Date.now(), phase: state.workflow?.phase });
    if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
  }
}

async function handleGitPushToolCall(
  state: WorkflowRuntimeState,
  cmd: string,
  ctx: WorkflowToolCallContext,
  deps: WorkflowToolCallDeps,
): Promise<WorkflowToolCallDecision> {
  if (state.workflow) {
    const workflowDecision = handleWorkflowBoundPush(state, cmd, deps);
    if (workflowDecision) return workflowDecision;
  }

  const policySkip = consumeSkipToken("policy-scan");
  if (policySkip) return;

  const policyScan = scanPushPolicy();
  const policySignature = pushPolicySignature(policyScan);
  const policyAlreadyApproved = state.policyApprovals.at(-1)?.signature === policySignature;
  if (policyScan.ok || policyAlreadyApproved) return;

  writeFieldLogEvent({
    type: "policy.blocked",
    category: "push-policy",
    severity: "blocker",
    workflow: state.workflow,
    summary: "Push policy scan blocked git push.",
    expected: "Risky push requires policy review or explicit one-use exception.",
    actual: `Policy findings: ${policyScan.findings.map((finding) => finding.category).join(", ")}`,
    impact: "Push is blocked until changes are reviewed or user approves skip.",
    primaryMessage: formatPushPolicyScanBlocked(policyScan),
    command: cmd,
    files: policyScan.findings.flatMap((finding) => finding.files.slice(0, 20).map((file) => ({ path: file, role: "changed" as const }))),
    improvementKind: "workflow-rule",
  });

  if (ctx.hasUI) {
    const approved = await ctx.ui.confirm(
      "Push policy scan 승인 확인",
      [
        formatPushPolicyScanBlocked(policyScan),
        "",
        "위험 변경 사항을 확인했으며 git push를 계속 진행하시겠습니까?",
        "",
        "예: 현재 workspace 상태를 승인하고 push합니다.",
        "아니오: push를 차단합니다. 변경 사항을 검토하거나 `/workflow skip policy-scan <사유>`로 예외 처리하세요.",
      ].join("\n"),
    );
    if (approved) {
      state.gateFailures.delete("policy-scan");
      state.policyApprovals.push({
        timestamp: Date.now(),
        totalChanged: policyScan.totalChanged,
        categories: policyScan.findings.map((finding) => finding.category),
        signature: policySignature,
      });
      if (state.policyApprovals.length > 20) state.policyApprovals.shift();
      return;
    }
  }

  return {
    block: true,
    reason: [
      formatPushPolicyScanBlocked(policyScan),
      "",
      "위험 변경 사항을 검토하고 줄인 뒤 git push를 재시도하세요.",
      "또는 `/workflow skip policy-scan <사유>`로 명시 예외 처리하세요.",
    ].join("\n"),
  };
}

function handleWorkflowBoundPush(
  state: WorkflowRuntimeState,
  cmd: string,
  deps: WorkflowToolCallDeps,
): WorkflowToolCallDecision {
  const workflow = state.workflow;
  if (!workflow) return;

  if (hasGitDashC(cmd)) {
    writeFieldLogEvent({
      type: "phase.violation",
      category: "workspace",
      severity: "blocker",
      workflow,
      summary: "git push used git -C during an active workflow.",
      expected: "Push commands run from the workflow-bound worktree/cwd.",
      actual: "git push command used -C to target a path.",
      impact: "Push is blocked to prevent bypassing workflow workspace binding.",
      primaryMessage: cmd,
      command: cmd,
      improvementKind: "workflow-rule",
    });
    return {
      block: true,
      reason: [
        "── 🧭 WORKFLOW WORKSPACE REQUIRED ─────",
        "",
        "  During an active workflow, `git -C <path>` cannot target another workspace.",
        "  Run git commands from the worktree/cwd where this workflow started.",
        "",
        `  Workflow CWD: ${workflow.cwd}`,
        `  Workflow Branch: ${workflow.branch}`,
        "",
        "──────────────────────────────────────",
      ].join("\n"),
    };
  }

  const workspace = validateWorkflowWorkspace(workflow);
  if (!workspace.ok) {
    writeFieldLogEvent({
      type: "phase.violation",
      category: "workspace",
      severity: "blocker",
      workflow,
      summary: "Workflow workspace mismatch blocked git push.",
      expected: "Current cwd/git root/branch match the workflow start workspace.",
      actual: workspace.problems.join(", "),
      impact: "Push is blocked to prevent cross-branch or cross-worktree mistakes.",
      primaryMessage: formatWorkspaceMismatch(workspace),
      command: cmd,
      improvementKind: "workflow-rule",
    });
    return { block: true, reason: formatWorkspaceMismatch(workspace) };
  }

  if (workflow.phase !== "push") {
    writeFieldLogEvent({
      type: "phase.violation",
      category: "phase",
      severity: "blocker",
      workflow,
      summary: "git push was attempted outside the push phase.",
      expected: "git push is allowed only during the push phase.",
      actual: `Current phase: ${workflow.phase}`,
      impact: "Push is blocked until review/document/commit phases are completed.",
      primaryMessage: `Current phase: ${workflow.phase}; required phase: push`,
      command: cmd,
      improvementKind: "workflow-rule",
    });
    void deps.steerLlm(
      `🚦 git push는 push 페이즈에서만 실행할 수 있습니다. 현재 페이즈: ${workflow.phase}.\n` +
      `workflow_approve를 호출해 단계를 진행하고, commit → push 전환 후 다시 시도하세요.`,
      "steer",
    );
    return {
      block: true,
      reason: `git push blocked: current phase is "${workflow.phase}", required phase is "push". workflow_approve로 단계를 진행하세요.`,
    };
  }

  if (!workflow.history.some((item) => item.from === "commit" && item.to === "push")) {
    writeFieldLogEvent({
      type: "phase.violation",
      category: "phase",
      severity: "blocker",
      workflow,
      summary: "git push was attempted without commit → push transition history.",
      expected: "Workflow history contains commit → push before git push.",
      actual: "Missing commit → push transition history.",
      impact: "Push is blocked to prevent skipped workflow phases.",
      primaryMessage: "Missing workflow transition history: commit → push",
      command: cmd,
      improvementKind: "workflow-rule",
    });
    return {
      block: true,
      reason: formatGateBlocked({
        gate: "Workflow Transition History",
        why: "The workflow is in push, but commit → push transition history is missing.",
        next: [
          "Use workflow_state tool or /workflow state commit to return to commit phase (manual recovery)",
          "Then call workflow_approve to show the user the commit → push approval dialog",
          "Only after the commit → push transition is recorded in workflow history, retry git push",
        ],
      }),
    };
  }
}

function pushPolicySignature(policyScan: ReturnType<typeof scanPushPolicy>): string {
  return JSON.stringify({
    totalChanged: policyScan.totalChanged,
    findings: policyScan.findings
      .map((finding) => ({ category: finding.category, files: [...finding.files].sort() }))
      .sort((a, b) => a.category.localeCompare(b.category)),
  });
}
