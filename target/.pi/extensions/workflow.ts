/**
 * workflow.ts — Pi Extension
 *
 * Implements the harness final-stage gates and advisory workflow layer as a
 * Pi extension.
 *
 * Gates:
 *   1. Push Review Gate — require explicit user confirmation of code review guard before git push
 *   2. Workflow Workspace Gate — active workflow pushes must happen from the bound worktree/branch
 *   3. Push Policy Scan — flag risky build/config/migration/Docker/CI/deletion/large-change pushes
 *
 * Additional behavior:
 *   - resources_discover: register bundled harness skills with Pi
 *   - session_start: show branch and untested-class context
 *   - before_agent_start: inject gate/workflow state into the system prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  addSkipToken,
  advanceWorkflow,
  clearPersistedWorkflow,
  createArtifactSnapshot,
  createWorkflow,
  consumeSkipToken,
  createWorkspaceCheckpoint,
  formatArtifactSnapshotCreated,
  formatGateBlocked,
  formatLatestDpaaAudit,
  formatLoadedWorkflowPrompt,
  formatLoadedWorkflowTemplate,
  formatPushPolicyScanBlocked,
  formatWorkflowPrerequisiteScan,
  formatWorkflowHistory,
  formatWorkflowPrompt,
  formatWorkflowStatus,
  formatWorkflowTemplateList,
  formatWorkspaceCheckpoints,
  formatWorkspaceMismatch,
  getBranch,
  getGitRoot,
  getUntestedClasses,
  getWorkspaceStatusSignature,
  hasGitDashC,
  isApprovalText,
  isGitPush,
  listWorkflowTemplates,
  loadPersistedWorkflow,
  readWorkflowTemplate,
  resolveWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  saveWorkflow,
  scanPushPolicy,
  scanWorkflowPrerequisites,
  shouldOfferInputCheckpoint,
  shortInputReason,
  undoWorkflow,
  redoWorkflow,
  validateWorkflowWorkspace,
  transitionWorkflow,
  WORKFLOW_PHASES,
  type WorkflowInstance,
  type WorkflowPhase,
  type WorkflowTemplate,
} from "./workflow/core";

// This file lives at: <harness-root>/.pi/extensions/workflow.ts
const HARNESS_ROOT = path.resolve(__dirname, "../..");

export default function (pi: ExtensionAPI) {
  // ── In-memory state ────────────────────────────────────────────────────────
  // Process memory only: the LLM cannot forge this token through shell/file writes.
  const state = {
    codeReviewGuardSatisfiedToken: null as {
      critical: number;
      major: number;
      minor: number;
      timestamp: number;
    } | null,
    workflow: null as WorkflowInstance | null,
    loadedWorkflowTemplate: null as WorkflowTemplate | null,
    dpaaGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    codeQualityGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    pushExecutionGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    policyApprovals: [] as Array<{ timestamp: number; totalChanged: number; categories: string[] }>,
    lastInputCheckpointSignature: null as string | null,
  };

  // ── resources_discover: register bundled harness skills ───────────────────
  pi.on("resources_discover", async () => {
    const skillsPath = path.join(HARNESS_ROOT, ".pi", "skills");
    if (!fs.existsSync(skillsPath)) return;
    return { skillPaths: [skillsPath] };
  });

  // ── Command: /workflow — advisory workflow state manager ──────────────────
  pi.registerCommand("workflow", {
    description: "Manage the advisory interview → plan → implementation → review → document → commit → push workflow state.",
    getArgumentCompletions: (prefix) => {
      const commands = ["start", "approve", "status", "list", "load", "unload", "undo", "redo", "history", "abort", "state", "snapshot", "checkpoint", "checkpoints", "restore", "skip", "dpaa-audit"];
      const workflowIds = listWorkflowTemplates().map((template) => template.id);
      return [...commands, ...workflowIds]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      const ensurePrerequisites = async (): Promise<boolean> => {
        const scan = scanWorkflowPrerequisites();
        if (!scan.ok) {
          ctx.ui.notify([
            formatWorkflowPrerequisiteScan(scan),
            "",
            "필수 workflow runtime 파일이 없어 진행할 수 없습니다.",
          ].join("\n"), "warning");
          return false;
        }
        if (scan.warnings.length === 0) return true;
        if (!ctx.hasUI) {
          ctx.ui.notify([
            formatWorkflowPrerequisiteScan(scan),
            "",
            "경고 확인을 위한 대화형 UI가 없어 진행을 중단합니다.",
          ].join("\n"), "warning");
          return false;
        }
        return ctx.ui.confirm(
          "Workflow prerequisite 경고 확인",
          [
            formatWorkflowPrerequisiteScan(scan),
            "",
            "위 경고가 있어도 workflow를 계속 진행하시겠습니까?",
            "",
            "예: 경고를 인지하고 계속 진행합니다.",
            "아니오: workflow start/load를 중단합니다.",
          ].join("\n"),
        );
      };

      if (command === "start") {
        if (state.workflow && state.workflow.phase !== "done") {
          ctx.ui.notify(
            `이미 진행 중인 workflow가 있습니다: ${state.workflow.phase}\n` +
              "먼저 /workflow status, /workflow approve, /workflow abort 중 하나를 사용하세요.",
            "warning",
          );
          return;
        }

        if (!(await ensurePrerequisites())) return;
        state.workflow = createWorkflow(rest.join(" "));
        saveWorkflow(state.workflow);
        ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatLoadedWorkflowTemplate(state.loadedWorkflowTemplate)].join("\n"), "info");
        return;
      }

      if (command === "list") {
        ctx.ui.notify(formatWorkflowTemplateList(listWorkflowTemplates()), "info");
        return;
      }

      if (command === "load") {
        const id = rest[0];
        if (!id) {
          ctx.ui.notify("사용법: /workflow load <id>\n목록 확인: /workflow list", "warning");
          return;
        }
        const template = readWorkflowTemplate(id);
        if (!template) {
          ctx.ui.notify(`workflow template을 찾지 못했습니다: ${id}\n목록 확인: /workflow list`, "warning");
          return;
        }
        if (!(await ensurePrerequisites())) return;
        state.loadedWorkflowTemplate = template;
        ctx.ui.notify([
          formatLoadedWorkflowTemplate(template),
          "",
          "이 workflow는 extension memory에만 load되었습니다.",
          "LLM system prompt에는 다음 agent turn부터 주입됩니다.",
          "workflow phase 권한은 변경하지 않습니다. 단계 진행은 /workflow start, /workflow approve, 자연어 승인 등 기존 규칙을 따릅니다.",
        ].join("\n"), "info");
        return;
      }

      if (command === "unload") {
        state.loadedWorkflowTemplate = null;
        ctx.ui.notify("Loaded workflow template을 memory에서 제거했습니다.", "info");
        return;
      }

      if (command === "approve") {
        if (state.workflow?.phase === "code_review" && !state.codeReviewGuardSatisfiedToken) {
          if (!ctx.hasUI) {
            ctx.ui.notify("Code review guard requires interactive user confirmation before review_approved.", "warning");
            return;
          }
          const approved = await ctx.ui.confirm(
            "Code review guard 승인 확인",
            [
              "Code review guard를 만족했습니까?",
              "",
              "조건:",
              "- Critical 이슈 = 0",
              "- Major 이슈 ≤ 2",
              "- 필요한 수정과 재리뷰 반복이 완료됨",
              "- LLM이 결과를 작성/제출하지 않고 사용자가 직접 확인함",
              "",
              "예: code review guard satisfied token을 in-memory에 발급하고 codeQualityGuard를 실행합니다.",
              "아니오: review_approved 전이를 차단하고 code_review에 머뭅니다.",
            ].join("\n"),
          );
          if (!approved) return;
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
        }
        const from = state.workflow?.phase ?? null;
        const workflowId = state.workflow?.id ?? null;
        const result = await advanceWorkflow(state.workflow, "user_approved");
        if (!result.ok) {
          ctx.ui.notify(result.message, "warning");
          return;
        }
        const to = state.workflow?.phase ?? null;
        const notices: string[] = [result.message];
        if (workflowId && from === "plan_review" && to === "implement") {
          state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          notices.push("DPAA guard satisfied: DPAA guard satisfied token recorded in current-session memory.");
        }
        if (workflowId && from === "code_review" && to === "review_approved") {
          state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          notices.push("Code quality guard satisfied: code quality guard satisfied token recorded in current-session memory.");
        }
        if (workflowId && from === "commit" && to === "push") {
          state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          notices.push("Push execution guard satisfied: push execution guard satisfied token recorded in current-session memory.");
        }
        ctx.ui.notify(notices.join("\n"), "info");
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

      if (command === "dpaa-audit") {
        ctx.ui.notify(formatLatestDpaaAudit(), "info");
        return;
      }

      if (command === "snapshot") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", "warning");
          return;
        }
        const workspace = validateWorkflowWorkspace(state.workflow);
        if (!workspace.ok) {
          ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
          return;
        }
        const reason = rest.join(" ").trim() || "manual snapshot";
        const snapshot = createArtifactSnapshot(state.workflow, "manual", reason);
        if (!snapshot) {
          ctx.ui.notify("스냅샷할 spec/plan 파일이 없습니다. `.ai/interview/spec.md` 또는 `.ai/interview/plan.md`를 먼저 작성하세요.", "warning");
          return;
        }
        ctx.ui.notify(formatArtifactSnapshotCreated(snapshot), "info");
        return;
      }

      if (command === "checkpoint") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", "warning");
          return;
        }
        const workspace = validateWorkflowWorkspace(state.workflow);
        if (!workspace.ok) {
          ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
          return;
        }
        const reason = rest.join(" ").trim() || "manual";
        const checkpoint = createWorkspaceCheckpoint(state.workflow, reason);
        state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
        ctx.ui.notify(checkpoint ? `Workspace checkpoint 생성: ${path.basename(checkpoint)}` : "Workspace checkpoint를 생성하지 못했습니다.", checkpoint ? "info" : "warning");
        return;
      }

      if (command === "checkpoints") {
        ctx.ui.notify(formatWorkspaceCheckpoints(state.workflow), "info");
        return;
      }

      if (command === "restore") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다. /workflow start 를 먼저 실행하세요.", "warning");
          return;
        }
        const workspace = validateWorkflowWorkspace(state.workflow);
        if (!workspace.ok) {
          ctx.ui.notify(formatWorkspaceMismatch(workspace), "warning");
          return;
        }
        const checkpointId = rest[0];
        const checkpoint = resolveWorkspaceCheckpoint(state.workflow, checkpointId);
        if (!checkpoint) {
          ctx.ui.notify("복구할 checkpoint를 찾지 못했습니다. /workflow checkpoints 로 목록을 확인하세요.", "warning");
          return;
        }
        createWorkspaceCheckpoint(state.workflow, `before-restore-${path.basename(checkpoint)}`);
        ctx.ui.notify(restoreWorkspaceCheckpoint(checkpoint), "info");
        state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
        return;
      }

      if (command === "skip") {
        const gate = rest[0] as "dpaa" | "code-quality" | "push-review" | "policy-scan" | undefined;
        const reason = rest.slice(1).join(" ").trim();
        if (!gate || !["dpaa", "code-quality", "push-review", "policy-scan"].includes(gate) || !reason) {
          ctx.ui.notify("사용법: /workflow skip <dpaa|code-quality|push-review|policy-scan> <reason>", "warning");
          return;
        }
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow gate 승인 확인",
          [
            `${gate} gate를 1회 건너뛰는 것을 승인하시겠습니까?`,
            "",
            `사유: ${reason}`,
            "",
            "예: 이번 1회에 한해 gate를 건너뛰고 계속 진행합니다.",
            "아니오: 진행을 중단하고 gate를 유지합니다.",
          ].join("\n"),
        ));
        if (!ok) return;
        addSkipToken(gate, reason);
        ctx.ui.notify(`${gate} gate skip token issued (one-time, TTL 10 minutes)`, "warning");
        return;
      }

      if (command === "abort") {
        if (!state.workflow) {
          ctx.ui.notify("진행 중인 workflow가 없습니다.", "info");
          return;
        }
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow 종료 승인 확인",
          [
            `현재 workflow(${state.workflow.phase})를 종료하시겠습니까?`,
            "",
            "예: in-memory workflow를 종료하고 persisted 참고 기록도 삭제합니다.",
            "아니오: workflow를 유지합니다.",
          ].join("\n"),
        ));
        if (!ok) return;
        state.workflow = null;
        state.dpaaGuardSatisfiedToken = null;
        state.codeQualityGuardSatisfiedToken = null;
        state.pushExecutionGuardSatisfiedToken = null;
        clearPersistedWorkflow();
        ctx.ui.notify("Workflow를 종료했습니다.", "info");
        return;
      }

      if (command === "status") {
        if (state.workflow) {
          ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus(), "", formatLoadedWorkflowTemplate(state.loadedWorkflowTemplate)].join("\n"), "info");
          return;
        }

        const persisted = loadPersistedWorkflow();
        if (!persisted) {
          ctx.ui.notify([formatWorkflowStatus(null), "", formatGuardMemoryStatus(), "", formatLoadedWorkflowTemplate(state.loadedWorkflowTemplate)].join("\n"), "info");
          return;
        }

        ctx.ui.notify([
          formatWorkflowStatus(null),
          "",
          formatGuardMemoryStatus(),
          "",
          formatLoadedWorkflowTemplate(state.loadedWorkflowTemplate),
          "",
          "참고: 이전 workflow 기록이 파일에 남아 있지만 자동 복구하지 않습니다.",
          "파일 기록은 표시/감사용이며 gate 통과 권한으로 신뢰하지 않습니다.",
          "계속하려면 사용자가 직접 명시 명령을 입력하세요:",
          `  /workflow state ${persisted.phase}`,
          `  # last workflow: ${persisted.title}`,
          `  # updated: ${new Date(persisted.updatedAt).toISOString()}`,
        ].join("\n"), "info");
        return;
      }

      if (command === "state") {
        const next = rest[0] as WorkflowPhase | undefined;
        if (!next || !WORKFLOW_PHASES.includes(next)) {
          ctx.ui.notify(`사용법: /workflow state <${WORKFLOW_PHASES.join("|")}>`, "warning");
          return;
        }
        const recoveryClaims: Record<WorkflowPhase, string> = {
          interview: "초기 interview 단계로 복구합니다. guard token은 발급하지 않습니다.",
          plan: "요구사항 확인 후 plan 단계까지 진행했다고 확인합니다. guard token은 발급하지 않습니다.",
          plan_review: "plan 작성 후 review 단계까지 진행했다고 확인합니다. DPAA는 아직 통과한 것으로 간주하지 않습니다.",
          implement: "DPAA guard가 만족되어 implement 단계에 진입했다고 확인하고 DPAA token을 발급합니다.",
          code_review: "DPAA guard가 만족되고 구현이 완료되어 code_review 단계에 진입했다고 확인합니다.",
          review_approved: "DPAA, code quality, code review guard가 모두 만족되었다고 확인하고 관련 token을 발급합니다.",
          document: "review_approved 이후 문서화 단계까지 진행했다고 확인하고 관련 token을 발급합니다.",
          commit: "문서화까지 완료되어 commit 단계까지 진행했다고 확인하고 관련 token을 발급합니다.",
          push: "DPAA, code quality, code review, commit approval이 완료되어 push 단계라고 확인하고 모든 push 전 guard token을 발급합니다.",
          done: "workflow가 완료되었다고 표시합니다. 실행 권한 token은 발급하지 않습니다.",
        };
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow state 수동 변경 승인 확인",
          [
            `workflow memory 상태를 '${next}' 단계로 변경하시겠습니까?`,
            "",
            recoveryClaims[next],
            "",
            "예: 위 내용을 내가 확인하고 phase/token을 복구합니다.",
            "아니오: phase와 token을 변경하지 않습니다.",
            "",
            "주의: 이 명령은 사용자의 명시적 복구 승인으로 간주됩니다. 자동 파일 복구는 여전히 신뢰하지 않습니다.",
          ].join("\n"),
        ));
        if (!ok) return;
        if (!state.workflow) state.workflow = createWorkflow("manual");
        transitionWorkflow(state.workflow, next, "manual_override");
        state.dpaaGuardSatisfiedToken = null;
        state.codeQualityGuardSatisfiedToken = null;
        state.pushExecutionGuardSatisfiedToken = null;
        state.codeReviewGuardSatisfiedToken = null;
        const phaseIndex = WORKFLOW_PHASES.indexOf(next);
        const tokenNotices: string[] = [];
        if (phaseIndex >= WORKFLOW_PHASES.indexOf("implement") && next !== "done") {
          state.dpaaGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          tokenNotices.push("DPAA guard satisfied → DPAA guard satisfied token 발급");
        }
        if (phaseIndex >= WORKFLOW_PHASES.indexOf("review_approved") && next !== "done") {
          state.codeQualityGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
          tokenNotices.push("Code quality guard satisfied → code quality guard satisfied token 발급");
          tokenNotices.push("Code review guard satisfied → code review guard satisfied token 발급");
        }
        if (phaseIndex >= WORKFLOW_PHASES.indexOf("push") && next !== "done") {
          state.pushExecutionGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          tokenNotices.push("Push execution guard satisfied → push execution guard satisfied token 발급");
        }
        saveWorkflow(state.workflow);
        ctx.ui.notify([
          formatWorkflowStatus(state.workflow),
          "",
          tokenNotices.length > 0 ? `수동 state 복구 완료: ${tokenNotices.join(", ")}` : "수동 state 복구 완료: 발급할 권한 token 없음",
          "",
          formatGuardMemoryStatus(),
          "",
          formatLoadedWorkflowTemplate(state.loadedWorkflowTemplate),
        ].join("\n"), "warning");
        return;
      }

      ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus(), "", formatLoadedWorkflowTemplate(state.loadedWorkflowTemplate)].join("\n"), "info");
    },
  });

  // ── User-input checkpoint prompt + natural approval handling ───────────────
  pi.on("input", async (event, ctx) => {
    // Natural-language workflow approvals are accepted only from text the user
    // typed in the interactive editor. Assistant messages do not fire this
    // event, and extension/RPC-injected messages must not advance phases.
    if (event.source !== "interactive") return { action: "continue" };
    if (!state.workflow || state.workflow.phase === "done") return { action: "continue" };

    if (shouldOfferInputCheckpoint(state.workflow, event.text, state.lastInputCheckpointSignature)) {
      const ok = ctx.hasUI
        ? await ctx.ui.confirm("Workspace checkpoint", "The git workspace has uncommitted changes. Create a checkpoint before handling this request?")
        : false;
      if (ok) {
        createWorkspaceCheckpoint(state.workflow, `before-input-${shortInputReason(event.text)}`);
        state.lastInputCheckpointSignature = getWorkspaceStatusSignature(state.workflow.gitRoot);
      }
    }

    if (!isApprovalText(event.text)) return { action: "continue" };

    const from = state.workflow.phase;
    if (from === "code_review" && !state.codeReviewGuardSatisfiedToken) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          "[Workflow] Interactive user approval was received, but Code review guard is not satisfied.",
          "The user must explicitly confirm the code review guard via /workflow approve before review_approved.",
        ].join("\n"),
      };
    }
    const workflowId = state.workflow.id;
    const result = await advanceWorkflow(state.workflow, "natural_language_approval");
    if (!result.ok) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          `[Workflow] Interactive user approval was received, but transition was blocked: ${result.message}`,
          "Resolve the blocker before asking the user to approve the next phase again.",
        ].join("\n"),
      };
    }

    const to = state.workflow.phase;
    const notices: string[] = [
      `[Workflow] Interactive user approval advanced the workflow: '${from}' → '${to}'.`,
    ];
    if (from === "plan_review" && to === "implement") {
      state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval" };
      notices.push("[Workflow] DPAA guard satisfied: DPAA guard satisfied token recorded in current-session memory.");
    }
    if (from === "code_review" && to === "review_approved") {
      state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval" };
      notices.push("[Workflow] Code quality guard satisfied: code quality guard satisfied token recorded in current-session memory.");
    }
    if (from === "commit" && to === "push") {
      state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval" };
      notices.push("[Workflow] Push execution guard satisfied: push execution guard satisfied token recorded in current-session memory.");
    }
    notices.push("Proceed according to the current phase. Ask for user confirmation before moving to the next phase.");

    return {
      action: "transform",
      text: [
        event.text,
        "",
        ...notices,
      ].join("\n"),
    };
  });

  // ── Gate: tool_call(bash) → git push 차단 ─────────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const cmd = String((event.input as any).command ?? "");
    if (!isGitPush(cmd)) return;

    if (state.workflow) {
      if (hasGitDashC(cmd)) {
        return {
          block: true,
          reason: [
            "── 🧭 WORKFLOW WORKSPACE REQUIRED ─────",
            "",
            "  During an active workflow, `git -C <path>` cannot target another workspace.",
            "  Run git commands from the worktree/cwd where this workflow started.",
            "",
            `  Workflow CWD: ${state.workflow.cwd}`,
            `  Workflow Branch: ${state.workflow.branch}`,
            "",
            "──────────────────────────────────────",
          ].join("\n"),
        };
      }

      const workspace = validateWorkflowWorkspace(state.workflow);
      if (!workspace.ok) {
        return {
          block: true,
          reason: formatWorkspaceMismatch(workspace),
        };
      }

      if (state.workflow.phase !== "push") {
        return {
          block: true,
          reason: [
            "── 🚦 WORKFLOW PHASE REQUIRED ────────",
            "",
            "  git push is allowed only during the push phase.",
            "  Complete review/document/commit deliverables, then advance with /workflow approve or interactive natural-language approval.",
            "",
            `  Current phase: ${state.workflow.phase}`,
            "  Required phase: push",
            "",
            "──────────────────────────────────────",
          ].join("\n"),
        };
      }

      if (state.pushExecutionGuardSatisfiedToken?.workflowId !== state.workflow.id) {
        return {
          block: true,
          reason: formatGateBlocked({
            gate: "Push Phase Authority",
            why: "The workflow is in push, but this pi session has no in-memory push execution guard satisfied token.",
            next: ["Return to the proper workflow phase", "Advance commit → push through /workflow approve or interactive natural-language approval", "Or explicitly restore with /workflow state push", "Retry git push after the token is issued"],
          }),
        };
      }
    }

    const policySkip = consumeSkipToken("policy-scan");
    if (!policySkip) {
      const policyScan = scanPushPolicy();
      if (!policyScan.ok) {
        if (!ctx.hasUI) {
          return {
            block: true,
            reason: [
              formatPushPolicyScanBlocked(policyScan),
              "",
              "사용자 대화형 승인이 필요하지만 현재 UI를 사용할 수 없어 git push를 차단했습니다.",
              "대화형 세션에서 다시 시도하거나, 사용자에게 명시 승인받은 뒤 `/workflow skip policy-scan <reason>`을 실행하세요.",
            ].join("\n"),
          };
        }

        const approved = await ctx.ui.confirm(
          "Push policy scan 승인 확인",
          [
            formatPushPolicyScanBlocked(policyScan),
            "",
            "위 위험 변경 사항이 포함된 상태로 git push를 계속 진행하시겠습니까?",
            "",
            "예: 현재 git push를 계속 진행합니다.",
            "아니오: git push를 차단하고 변경 검토를 요구합니다.",
          ].join("\n"),
        );

        if (!approved) {
          return {
            block: true,
            reason: "git push blocked: 사용자가 Push policy scan 경고에 대해 '예'로 승인하지 않았습니다.",
          };
        }

        state.policyApprovals.push({
          timestamp: Date.now(),
          totalChanged: policyScan.totalChanged,
          categories: policyScan.findings.map((finding) => finding.category),
        });
        if (state.policyApprovals.length > 20) state.policyApprovals.shift();
      }
    }

    const skip = consumeSkipToken("push-review");
    if (skip) {
      state.codeReviewGuardSatisfiedToken = null;
      return;
    }

    // ── Gate 1: code code review guard satisfied token 없음 ───────────────────────────
    if (!state.codeReviewGuardSatisfiedToken) {
      return {
        block: true,
        reason: formatGateBlocked({
          gate: "Push Review",
          why: "The push review token is missing before git push.",
          next: ["Run /skill:code-review-gate", "Use /workflow approve in code_review so the user explicitly confirms the review guard", "Retry git push"],
          skip: "/workflow skip push-review <reason>",
        }),
      };
    }

    // ── Gate 2: TTL 만료 (60분) ──────────────────────────────────────────────
    const ageMin = (Date.now() - state.codeReviewGuardSatisfiedToken.timestamp) / 60_000;
    if (ageMin > 60) {
      const elapsed = Math.floor(ageMin);
      state.codeReviewGuardSatisfiedToken = null;
      return {
        block: true,
        reason: formatGateBlocked({
          gate: "Push Review",
          why: `The push review token expired after 60 minutes. (${elapsed} minutes elapsed)`,
          next: ["Run /skill:code-review-gate again", "Use /workflow approve in code_review so the user explicitly confirms the review guard again", "Retry git push"],
          skip: "/workflow skip push-review <reason>",
        }),
      };
    }

    // ── Gate 3: Critical / Major 기준 미달 ───────────────────────────────────
    const { critical, major } = state.codeReviewGuardSatisfiedToken;
    if (critical > 0 || major > 2) {
      const r = state.codeReviewGuardSatisfiedToken;
      state.codeReviewGuardSatisfiedToken = null;
      return {
        block: true,
        reason: formatGateBlocked({
          gate: "Push Review",
          why: `The review did not meet the push threshold. Critical=${r.critical} (required 0), Major=${r.major} (required ≤2)`,
          next: ["Fix the reported issues", "Run /skill:code-review-gate again", "Retry git push"],
          skip: "/workflow skip push-review <reason>",
        }),
      };
    }

    // ✅ 모든 게이트 통과 → 토큰 소비 (단일 push에 1회만 유효)
    state.codeReviewGuardSatisfiedToken = null;
  });

  // ── session_start: 상태 초기화 + 세션 컨텍스트 알림 ───────────────────────
  pi.on("session_start", async (_event, ctx) => {
    state.codeReviewGuardSatisfiedToken = null;

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

  function formatGuardMemoryStatus(): string {
    const workflowId = state.workflow?.id;
    const policyScan = scanPushPolicy();
    const lastPolicy = state.policyApprovals.at(-1);
    return [
      "🧪 Guard memory/status",
      `- DPAA guard: ${workflowId && state.dpaaGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
      `- Code quality guard: ${workflowId && state.codeQualityGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
      `- Code review guard: ${state.codeReviewGuardSatisfiedToken ? `satisfied (C=${state.codeReviewGuardSatisfiedToken.critical}, M=${state.codeReviewGuardSatisfiedToken.major}, m=${state.codeReviewGuardSatisfiedToken.minor})` : "absent"}`,
      `- Push execution guard: ${workflowId && state.pushExecutionGuardSatisfiedToken?.workflowId === workflowId ? "satisfied" : "absent"}`,
      `- Policy scan now: ${policyScan.ok ? `ok (${policyScan.totalChanged} changed)` : `confirmation required (${policyScan.findings.map((finding) => finding.category).join(", ")})`}`,
      `- Last policy approval: ${lastPolicy ? `${new Date(lastPolicy.timestamp).toISOString()} / ${lastPolicy.totalChanged} changed / ${lastPolicy.categories.join(", ")}` : "none"}`,
    ].join("\n");
  }

  // ── before_agent_start: inject gate state into the system prompt ──────────
  //
  // System-prompt injection makes these constraints part of the model's rules,
  // instead of presenting them only as tool rejection messages to work around.
  pi.on("before_agent_start", async (event) => {
    const root = getGitRoot();
    const branch = root ? getBranch(root) : "unknown";

    const authLines = [
      "[Workflow Authority Memory]",
      `DPAA guard satisfied token: ${state.workflow && state.dpaaGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Code quality guard satisfied token: ${state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Code review guard satisfied token: ${state.codeReviewGuardSatisfiedToken ? "present" : "absent"}`,
      `Push execution guard satisfied token: ${state.workflow && state.pushExecutionGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Policy scan approvals this session: ${state.policyApprovals.length}`,
    ].join("\n");

    const injection = [
      "",
      "[Harness Context]",
      `Branch: ${branch}`,
      formatWorkflowPrompt(state.workflow),
      authLines,
      formatLoadedWorkflowPrompt(state.loadedWorkflowTemplate),
    ].join("\n");

    return { systemPrompt: event.systemPrompt + injection };
  });
}
