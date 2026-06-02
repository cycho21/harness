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
import { Type } from "typebox";
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
  exportFieldLogs,
  formatHarnessDoctor,
  formatLatestDpaaAudit,
  formatRecentFieldLogs,
  formatWorkflowReminders,
  formatPushPolicyScanBlocked,
  formatWorkflowPrerequisiteScan,
  formatWorkflowHistory,
  formatWorkflowPrompt,
  formatWorkflowStatus,
  formatWorkspaceCheckpoints,
  formatWorkspaceMismatch,
  getBranch,
  getGitRoot,
  getUntestedClasses,
  getWorkspaceStatusSignature,
  hasGitDashC,
  isApprovalText,
  isGitPush,
  loadPersistedWorkflow,
  resolveWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  saveWorkflow,
  scanWorkflowReminders,
  scanPushPolicy,
  scanWorkflowPrerequisites,
  shouldOfferInputCheckpoint,
  shortInputReason,
  undoWorkflow,
  redoWorkflow,
  writeFieldLogEvent,
  validateWorkflowWorkspace,
  transitionWorkflow,
  isSharedWorkflowPhase,
  sharedWorkflowPhases,
  type WorkflowInstance,
  type WorkflowPhase,
} from "./workflow/core";

// This file lives at: <harness-root>/.pi/extensions/workflow.ts
const HARNESS_ROOT = path.resolve(__dirname, "../..");

export default function (pi: ExtensionAPI) {
  // ── In-memory state ────────────────────────────────────────────────────────
  // Process memory only: the LLM cannot forge this guard evidence through shell/file writes.
  const state = {
    codeReviewGuardSatisfiedToken: null as {
      critical: number;
      major: number;
      minor: number;
      timestamp: number;
    } | null,
    workflow: null as WorkflowInstance | null,
    dpaaGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    codeQualityGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    pushExecutionGuardSatisfiedToken: null as { workflowId: string; issuedAt: number; reason: string } | null,
    policyApprovals: [] as Array<{ timestamp: number; totalChanged: number; categories: string[]; signature: string }>,
    gateFailures: new Map<string, number>(),
    lastInputCheckpointSignature: null as string | null,
    recentVerificationCommands: [] as Array<{ command: string; timestamp: number; phase?: string }>,
    reviewPackageToken: null as null | { workflowId: string; timestamp: number; critical: number; major: number; minor: number; mainSummary: string; reviewerSummary: string; qualitySummary: string },
  };

  function normalizePathText(value: string): string {
    return value.replace(/\\/g, "/");
  }

  function mentionsExtensionPath(value: string): boolean {
    const normalized = normalizePathText(value);
    return /(^|[\s"'=:(])(?:target\/)?\.pi\/extensions(?:\/|$)/.test(normalized) || normalized.includes("/.pi/extensions/") || normalized.includes("/target/.pi/extensions/");
  }

  function collectStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(collectStrings);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
    return [];
  }

  function isLikelyMutatingBash(command: string): boolean {
    if (!mentionsExtensionPath(command)) return false;
    return /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|rmdir|sed\s+-i|perl\s+-pi|python3?|node|npx|tsx)\b/.test(command)
      || /(>|>>|\btee\b)/.test(command);
  }

  function requiresExtensionMutationApproval(toolName: string, input: unknown): boolean {
    const lower = toolName.toLowerCase();
    const strings = collectStrings(input);
    if (!strings.some(mentionsExtensionPath)) return false;
    if (lower === "bash") return strings.some(isLikelyMutatingBash);
    if (/^(edit|write|multi.?edit|apply.?patch)$/.test(lower)) return true;
    return false;
  }

  function formatExtensionMutationApprovalReason(toolName: string, input: unknown): string {
    const targets = collectStrings(input).filter(mentionsExtensionPath).slice(0, 5);
    return [
      "── 🧩 EXTENSION MODIFICATION APPROVAL REQUIRED ─────",
      "",
      "  Modifying harness extension files requires explicit user approval.",
      "  Approval is checked in extension memory for this tool call only; no approval file/token is trusted.",
      "",
      `  Tool: ${toolName}`,
      ...targets.map((target) => `  Target: ${target.slice(0, 240)}`),
      "",
      "─────────────────────────────────────────────────────",
    ].join("\n");
  }

  async function ensureExtensionMutationApproved(toolName: string, input: unknown, ctx: any): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!requiresExtensionMutationApproval(toolName, input)) return { ok: true };
    const reason = formatExtensionMutationApprovalReason(toolName, input);
    if (!ctx.hasUI) {
      return { ok: false, reason: [reason, "", "대화형 사용자 승인이 필요하지만 현재 UI를 사용할 수 없어 extension 수정을 차단했습니다."].join("\n") };
    }
    const approved = await ctx.ui.confirm(
      "Harness extension 수정 승인 확인",
      [
        reason,
        "",
        "위 harness extension 파일 수정을 진행하시겠습니까?",
        "",
        "예: 이번 tool call에 한해 extension 수정을 허용합니다.",
        "아니오: extension 수정을 차단합니다.",
      ].join("\n"),
    );
    return approved ? { ok: true } : { ok: false, reason: "Harness extension modification blocked: user did not approve this tool call." };
  }

  function pushPolicySignature(policyScan: ReturnType<typeof scanPushPolicy>): string {
    return JSON.stringify({
      totalChanged: policyScan.totalChanged,
      findings: policyScan.findings
        .map((finding) => ({ category: finding.category, files: [...finding.files].sort() }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    });
  }

  async function confirmPushPolicyForPushPhase(ctx: any): Promise<boolean> {
    const policySkip = consumeSkipToken("policy-scan");
    if (policySkip) {
      const scan = scanPushPolicy();
      state.policyApprovals.push({ timestamp: Date.now(), totalChanged: scan.totalChanged, categories: scan.findings.map((f) => f.category), signature: pushPolicySignature(scan) });
      if (state.policyApprovals.length > 20) state.policyApprovals.shift();
      return true;
    }

    const policyScan = scanPushPolicy();
    if (policyScan.ok) return true;

    const signature = pushPolicySignature(policyScan);
    const lastApproval = state.policyApprovals.at(-1);
    if (lastApproval?.signature === signature) return true;

    if (!ctx.hasUI) {
      ctx.ui.notify([
        formatPushPolicyScanBlocked(policyScan),
        "",
        "push 단계 진입에는 위험 변경 사항에 대한 사용자 확인이 필요하지만 현재 UI를 사용할 수 없습니다.",
        "대화형 세션에서 다시 시도하거나, 사용자에게 명시 승인받은 뒤 `/workflow skip policy-scan <reason>`을 실행하세요.",
      ].join("\n"), "warning");
      return false;
    }

    const approved = await ctx.ui.confirm(
      "Push policy scan 승인 확인",
      [
        formatPushPolicyScanBlocked(policyScan),
        "",
        "위 위험 변경 사항을 확인했으며 push 단계로 계속 진행하시겠습니까?",
        "",
        "예: 현재 workspace 상태에 대한 policy approval을 기록하고 push 단계로 진행합니다.",
        "아니오: push 단계 진입을 중단하고 변경 검토를 요구합니다.",
      ].join("\n"),
    );
    if (!approved) return false;

    state.policyApprovals.push({
      timestamp: Date.now(),
      totalChanged: policyScan.totalChanged,
      categories: policyScan.findings.map((finding) => finding.category),
      signature,
    });
    if (state.policyApprovals.length > 20) state.policyApprovals.shift();
    return true;
  }

  // ── resources_discover: register bundled harness skills ───────────────────
  pi.on("resources_discover", async () => {
    const skillsPath = path.join(HARNESS_ROOT, ".pi", "skills");
    if (!fs.existsSync(skillsPath)) return;
    return { skillPaths: [skillsPath] };
  });

  // ── Tool: submit_review_package — records main/subagent review evidence ──
  pi.registerTool({
    name: "submit_review_package",
    label: "Submit review package",
    description: "Record the main-agent self-review, independent reviewer/subagent review, and quality-gate summary before automated review approval.",
    parameters: Type.Object({
      mainReviewSummary: Type.String({ description: "Main agent self-review summary and fixes performed." }),
      reviewerReviewSummary: Type.String({ description: "Independent reviewer/subagent findings summary." }),
      qualityGateSummary: Type.String({ description: "Quality gate/test/lint/typecheck result summary." }),
      critical: Type.Number({ description: "Critical issue count after fixes." }),
      major: Type.Number({ description: "Major issue count after fixes." }),
      minor: Type.Number({ description: "Minor issue count after fixes." }),
    }),
    async execute(_toolCallId, params) {
      if (!state.workflow) {
        return { content: [{ type: "text", text: "No active workflow. Start /workflow first." }], details: { ok: false } };
      }
      if (state.workflow.phase !== "code_review") {
        return { content: [{ type: "text", text: `Review package can be submitted only in code_review phase. Current phase: ${state.workflow.phase}` }], details: { ok: false } };
      }
      const critical = Number(params.critical);
      const major = Number(params.major);
      const minor = Number(params.minor);
      const missing = [params.mainReviewSummary, params.reviewerReviewSummary, params.qualityGateSummary].some((value) => !String(value ?? "").trim());
      if (missing || !Number.isFinite(critical) || !Number.isFinite(major) || !Number.isFinite(minor)) {
        return { content: [{ type: "text", text: "Review package rejected: main review, independent reviewer review, quality gate summary, and severity counts are required." }], details: { ok: false } };
      }
      if (critical > 0 || major > 2) {
        state.reviewPackageToken = null;
        return { content: [{ type: "text", text: `Review package rejected: Critical=${critical} (required 0), Major=${major} (required ≤2). Return to implement, fix issues, then review again.` }], details: { ok: false, critical, major, minor } };
      }

      state.reviewPackageToken = {
        workflowId: state.workflow.id,
        timestamp: Date.now(),
        critical,
        major,
        minor,
        mainSummary: String(params.mainReviewSummary),
        reviewerSummary: String(params.reviewerReviewSummary),
        qualitySummary: String(params.qualityGateSummary),
      };

      const result = await advanceWorkflow(state.workflow, "automated_review_package");
      const notices: string[] = [
        `Review package accepted: Critical=${critical}, Major=${major}, Minor=${minor}.`,
      ];
      if (result.ok) {
        state.codeQualityGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "automated_review_package" };
        state.codeReviewGuardSatisfiedToken = { critical, major, minor, timestamp: Date.now() };
        state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
        if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
        notices.push(result.message);
        notices.push("Automated review approved: review package and quality gate satisfied.");
      } else {
        notices.push(result.message);
      }
      return { content: [{ type: "text", text: notices.join("\n") }], details: { ok: result.ok, critical, major, minor, workflowPhase: state.workflow.phase } };
    },
  });

  // ── Command: /workflow — advisory workflow state manager ──────────────────
  pi.registerCommand("workflow", {
    description: "Manage the advisory interview → plan → implementation → review → document → commit → push workflow state.",
    getArgumentCompletions: (prefix) => {
      const GATE_LABELS: Record<string, string> = {
        "dpaa": "DPAA gate (plan_review → implement)",
        "code-quality": "Checkstyle/PMD/test gate (code_review → review_approved)",
        "policy-scan": "push 전 위험 변경 파일 scan gate",
      };

      if (prefix.startsWith("skip ")) {
        const gatePart = prefix.slice("skip ".length);
        return Object.keys(GATE_LABELS)
          .filter((g) => g.startsWith(gatePart))
          .map((g) => {
            const failures = state.gateFailures.get(g) ?? 0;
            const failureHint = failures > 0 ? `  [✗${failures}]` : "";
            return { value: `skip ${g}`, label: `skip ${g}${failureHint}  —  ${GATE_LABELS[g]}` };
          });
      }

      const commands = ["start", "approve", "status", "doctor", "failures", "list", "load", "undo", "redo", "history", "abort", "state", "snapshot", "checkpoint", "checkpoints", "restore", "skip", "dpaa-audit"];
      const persisted = loadPersistedWorkflow();
      return commands
        .filter((value) => value.startsWith(prefix))
        .map((value) => {
          if (value === "load" && persisted) {
            return { value, label: `load  ← [${persisted.phase}] ${persisted.title}` };
          }
          if (value === "skip") {
            const activeFailures = Object.keys(GATE_LABELS).filter((g) => (state.gateFailures.get(g) ?? 0) > 0);
            return { value, label: activeFailures.length > 0 ? `skip  ← 실패 중: ${activeFailures.join(", ")}` : "skip" };
          }
          return { value, label: value };
        });
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

      if (command === "doctor") {
        ctx.ui.notify(formatHarnessDoctor(), "info");
        return;
      }

      if (command === "failures") {
        if (rest[0] === "export") {
          const exported = exportFieldLogs();
          ctx.ui.notify(`Harness field logs exported: ${path.relative(process.cwd(), exported)}`, "info");
          return;
        }
        const limit = Number.parseInt(rest[0] ?? "10", 10);
        ctx.ui.notify(formatRecentFieldLogs(Number.isFinite(limit) ? limit : 10), "info");
        return;
      }

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
        state.codeReviewGuardSatisfiedToken = null;
        state.policyApprovals = [];
        state.reviewPackageToken = null;
        state.gateFailures = new Map();
        saveWorkflow(state.workflow);
        ctx.ui.notify(formatWorkflowStatus(state.workflow), "info");
        return;
      }

      if (command === "list") {
        const activeOrPersisted = state.workflow ?? loadPersistedWorkflow();
        ctx.ui.notify([formatWorkflowStatus(activeOrPersisted), "", formatGuardMemoryStatus()].join("\n"), "info");
        return;
      }

      if (command === "load") {
        if (state.workflow && state.workflow.phase !== "done") {
          ctx.ui.notify(`이미 진행 중인 workflow가 있습니다: ${state.workflow.phase}\n먼저 /workflow abort로 종료하거나 /workflow status로 확인하세요.`, "warning");
          return;
        }
        const persisted = loadPersistedWorkflow();
        if (!persisted) {
          ctx.ui.notify("불러올 저장된 workflow 인스턴스가 없습니다.", "warning");
          return;
        }
        state.workflow = persisted;
        ctx.ui.notify([`✅ Workflow 인스턴스를 메모리에 로드했습니다: [${persisted.phase}] ${persisted.title}`, "", formatWorkflowStatus(state.workflow)].join("\n"), "info");
        return;
      }

      if (command === "approve") {
        if (state.workflow?.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
          ctx.ui.notify("Review package required before review_approved. Run main self-review, independent reviewer/subagent review, quality gates, then call submit_review_package.", "warning");
          return;
        }
        if (state.workflow?.phase === "commit" && !(await confirmPushPolicyForPushPhase(ctx))) return;
        const workflowId = state.workflow?.id ?? null;
        const result = await advanceWorkflow(state.workflow, "user_approved");
        if (!result.ok) {
          if (result.gate) { state.gateFailures.set(result.gate, (state.gateFailures.get(result.gate) ?? 0) + 1); }
          ctx.ui.notify(result.message, "warning");
          return;
        }
        const transitions = result.transitions ?? [];
        transitions.forEach((t) => {
          if (t.from === "plan_review" && t.to === "implement") state.gateFailures.delete("dpaa");
          if (t.from === "code_review" && t.to === "review_approved") state.gateFailures.delete("code-quality");
        });
        const notices: string[] = [result.message];
        if (workflowId && transitions.some((item) => item.from === "plan_review" && item.to === "implement")) {
          state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          notices.push("DPAA guard satisfied: transition evidence recorded in current-session memory.");
        }
        if (workflowId && transitions.some((item) => item.from === "code_review" && item.to === "review_approved")) {
          state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "automated_review_passed" };
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
          state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
          if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
          notices.push("Automated review approved: review/quality evidence recorded in current-session memory.");
          notices.push("Code quality guard satisfied: quality evidence recorded in current-session memory.");
        }
        if (workflowId && transitions.some((item) => item.from === "commit" && item.to === "push")) {
          state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "user_approved" };
          notices.push("Push phase approved: commit → push transition evidence recorded in workflow history.");
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
        const VALID_GATES = ["dpaa", "code-quality", "policy-scan"] as const;
        const GATE_DESC: Record<string, string> = {
          "dpaa": "DPAA 모호성 분석 gate (plan_review → implement 전환 시 실행)",
          "code-quality": "Checkstyle/PMD/테스트 gate (code_review → review_approved 전환 시 실행)",
          "policy-scan": "push 전 위험 변경 파일 scan gate",
        };
        const gate = rest[0] as typeof VALID_GATES[number] | undefined;
        const reason = rest.slice(1).join(" ").trim();
        if (!gate || !VALID_GATES.includes(gate)) {
          const failures = VALID_GATES.filter((g) => (state.gateFailures.get(g) ?? 0) > 0);
          ctx.ui.notify([
            "사용법: /workflow skip <gate> <사유>",
            "",
            "Gate 목록:",
            ...VALID_GATES.map((g) => {
              const f = state.gateFailures.get(g) ?? 0;
              return `  ${g}  —  ${GATE_DESC[g]}${f > 0 ? ` [✗${f}회 실패]` : ""}`;
            }),
            ...(failures.length > 0 ? ["", `현재 실패 중: ${failures.join(", ")}`] : []),
          ].join("\n"), "warning");
          return;
        }
        if (!reason) {
          ctx.ui.notify(`사유를 입력하세요.\n예: /workflow skip ${gate} 테스트 환경에서 checkstyle 미적용 확인`, "warning");
          return;
        }
        const failures2 = state.gateFailures.get(gate) ?? 0;
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow gate skip 승인 확인",
          [
            `[${gate}] gate를 1회 건너뛰겠습니까?`,
            `대상: ${GATE_DESC[gate]}`,
            ...(failures2 > 0 ? [`이번 세션 실패 횟수: ${failures2}회`] : []),
            "",
            `사유: ${reason}`,
            "",
            "예: 다음 1회에 한해 해당 gate 예외를 허용합니다 (TTL 10분).",
            "아니오: gate를 유지합니다.",
          ].join("\n"),
        ));
        if (!ok) return;
        addSkipToken(gate, reason);
        state.gateFailures.delete(gate);
        writeFieldLogEvent({
          type: "gate.skipped",
          category: gate === "policy-scan" ? "push-policy" : gate === "code-quality" ? "code-quality" : gate === "dpaa" ? "dpaa" : "workspace",
          severity: "warning",
          status: "accepted-risk",
          workflow: state.workflow,
          summary: `${gate} gate one-use exception issued by explicit user approval.`,
          expected: "Harness gates run unless the user explicitly approves a one-time exception.",
          actual: `One-use exception issued: ${reason}`,
          impact: "Repeated exceptions may indicate guard false positives or missing workflow affordances.",
          primaryMessage: reason,
          improvementKind: gate === "dpaa" ? "dpaa-rule" : "workflow-rule",
        });
        ctx.ui.notify(`✅ [${gate}] 1회 예외 허용됨 (TTL 10분)\n사유: ${reason}`, "warning");
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
        state.codeReviewGuardSatisfiedToken = null;
        state.policyApprovals = [];
        state.reviewPackageToken = null;
        state.gateFailures = new Map();
        clearPersistedWorkflow();
        ctx.ui.notify("Workflow를 종료했습니다.", "info");
        return;
      }

      if (command === "status") {
        if (state.workflow) {
          ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus()].join("\n"), "info");
          return;
        }

        const persisted = loadPersistedWorkflow();
        if (!persisted) {
          ctx.ui.notify([formatWorkflowStatus(null), "", formatGuardMemoryStatus()].join("\n"), "info");
          return;
        }

        ctx.ui.notify([
          formatWorkflowStatus(null),
          "",
          formatGuardMemoryStatus(),
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
        const phases = sharedWorkflowPhases();
        const next = rest[0] as WorkflowPhase | undefined;
        if (!next || !isSharedWorkflowPhase(next)) {
          ctx.ui.notify(`사용법: /workflow state <${phases.join("|")}>`, "warning");
          return;
        }
        const recoveryClaims: Record<WorkflowPhase, string> = {
          interview: "초기 interview 단계로 복구합니다. guard evidence는 복구하지 않습니다.",
          plan: "요구사항 확인 후 plan 단계까지 진행했다고 확인합니다. guard evidence는 복구하지 않습니다.",
          plan_review: "plan 작성 후 review 단계까지 진행했다고 확인합니다. DPAA는 아직 통과한 것으로 간주하지 않습니다.",
          implement: "DPAA guard가 만족되어 implement 단계에 진입했다고 확인하고 transition evidence를 복구합니다.",
          code_review: "DPAA guard가 만족되고 구현이 완료되어 code_review 단계에 진입했다고 확인합니다.",
          review_approved: "DPAA, code quality, code review guard가 모두 만족되었다고 확인하고 관련 evidence를 복구합니다.",
          document: "review_approved 이후 문서화 단계까지 진행했다고 확인하고 관련 evidence를 복구합니다.",
          commit: "문서화까지 완료되어 commit 단계까지 진행했다고 확인하고 관련 evidence를 복구합니다.",
          push: "DPAA, code quality, code review, commit approval이 완료되어 push 단계라고 확인하고 transition evidence를 복구합니다.",
          done: "workflow가 완료되었다고 표시합니다. 실행 evidence는 복구하지 않습니다.",
        };
        const ok = !ctx.hasUI || (await ctx.ui.confirm(
          "Workflow state 수동 변경 승인 확인",
          [
            `workflow memory 상태를 '${next}' 단계로 변경하시겠습니까?`,
            "",
            recoveryClaims[next],
            "",
            "예: 위 내용을 내가 확인하고 phase/evidence를 복구합니다.",
            "아니오: phase와 evidence를 변경하지 않습니다.",
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
        const phaseIndex = phases.indexOf(next);
        const evidenceNotices: string[] = [];
        if (phaseIndex >= phases.indexOf("implement") && next !== "done") {
          state.dpaaGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          evidenceNotices.push("DPAA guard satisfied → transition evidence 복구");
        }
        if (phaseIndex >= phases.indexOf("review_approved") && next !== "done") {
          state.codeQualityGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
          evidenceNotices.push("Code quality guard satisfied → quality evidence 복구");
          evidenceNotices.push("Code review guard satisfied → review evidence 복구");
        }
        if (phaseIndex >= phases.indexOf("push") && next !== "done") {
          state.pushExecutionGuardSatisfiedToken = { workflowId: state.workflow.id, issuedAt: Date.now(), reason: "manual_state_restore" };
          if (!state.workflow.history.some((item) => item.from === "commit" && item.to === "push")) {
            state.workflow.history.push({ from: "commit", to: "push", reason: "manual_state_restore", timestamp: Date.now() });
          }
          evidenceNotices.push("Push phase approved → transition evidence 복구");
        }
        saveWorkflow(state.workflow);
        ctx.ui.notify([
          formatWorkflowStatus(state.workflow),
          "",
          evidenceNotices.length > 0 ? `수동 state 복구 완료: ${evidenceNotices.join(", ")}` : "수동 state 복구 완료: 복구할 guard evidence 없음",
          "",
          formatGuardMemoryStatus(),
        ].join("\n"), "warning");
        return;
      }

      ctx.ui.notify([formatWorkflowStatus(state.workflow), "", formatGuardMemoryStatus()].join("\n"), "info");
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
    if (state.workflow.phase === "code_review" && state.reviewPackageToken?.workflowId !== state.workflow.id) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          "[Workflow] Review package is required before review_approved.",
          "Run main self-review, independent reviewer/subagent review, quality gates, then call submit_review_package.",
        ].join("\n"),
      };
    }

    if (state.workflow.phase === "commit" && !(await confirmPushPolicyForPushPhase(ctx))) {
      return {
        action: "transform",
        text: [
          event.text,
          "",
          "[Workflow] Interactive user approval was received, but push policy scan requires confirmation before entering push phase.",
          "Review the policy scan warning and approve again after resolving or accepting the risk.",
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

    const transitions = result.transitions ?? [{ from, to: state.workflow.phase }];
    const transitionPath = transitions.map((item, index) => index === 0 ? `'${item.from}' → '${item.to}'` : `→ '${item.to}'`).join(" ");
    const notices: string[] = [
      `[Workflow] Interactive user approval advanced the workflow: ${transitionPath}.`,
    ];
    if (transitions.some((item) => item.from === "plan_review" && item.to === "implement")) {
      state.dpaaGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval" };
      notices.push("[Workflow] DPAA guard satisfied: transition evidence recorded in current-session memory.");
    }
    if (transitions.some((item) => item.from === "code_review" && item.to === "review_approved")) {
      state.codeQualityGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "automated_review_passed" };
      state.codeReviewGuardSatisfiedToken = { critical: 0, major: 0, minor: 0, timestamp: Date.now() };
      state.recentVerificationCommands.push({ command: "codeQualityGuard", timestamp: Date.now(), phase: "code_review" });
      if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
      notices.push("[Workflow] Automated review approved: review/quality evidence recorded in current-session memory.");
      notices.push("[Workflow] Code quality guard satisfied: quality evidence recorded in current-session memory.");
    }
    if (transitions.some((item) => item.from === "commit" && item.to === "push")) {
      state.pushExecutionGuardSatisfiedToken = { workflowId, issuedAt: Date.now(), reason: "natural_language_approval" };
      notices.push("[Workflow] Push phase approved: commit → push transition evidence recorded in workflow history.");
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
    const extensionApproval = await ensureExtensionMutationApproved(event.toolName, event.input, ctx);
    if (!extensionApproval.ok) return { block: true, reason: extensionApproval.reason };

    if (event.toolName !== "bash") return;

    const cmd = String((event.input as any).command ?? "");
    if (/\b(pytest|npm\s+(test|run\s+(test|lint|typecheck|build))|pnpm\s+(test|lint|typecheck|build)|yarn\s+(test|lint|typecheck|build)|gradle(w|\.bat)?\s+.*(test|check|build|codeQualityGuard)|mvn\s+.*(test|verify|package)|go\s+test|cargo\s+(test|clippy)|tsc\b|eslint\b|ruff\b|mypy\b)\b/i.test(cmd)) {
      state.recentVerificationCommands.push({ command: cmd, timestamp: Date.now(), phase: state.workflow?.phase });
      if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
    }
    if (!isGitPush(cmd)) return;

    if (state.workflow) {
      if (hasGitDashC(cmd)) {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "workspace",
          severity: "blocker",
          workflow: state.workflow,
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
            `  Workflow CWD: ${state.workflow.cwd}`,
            `  Workflow Branch: ${state.workflow.branch}`,
            "",
            "──────────────────────────────────────",
          ].join("\n"),
        };
      }

      const workspace = validateWorkflowWorkspace(state.workflow);
      if (!workspace.ok) {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "workspace",
          severity: "blocker",
          workflow: state.workflow,
          summary: "Workflow workspace mismatch blocked git push.",
          expected: "Current cwd/git root/branch match the workflow start workspace.",
          actual: workspace.problems.join(", "),
          impact: "Push is blocked to prevent cross-branch or cross-worktree mistakes.",
          primaryMessage: formatWorkspaceMismatch(workspace),
          command: cmd,
          improvementKind: "workflow-rule",
        });
        return {
          block: true,
          reason: formatWorkspaceMismatch(workspace),
        };
      }

      if (state.workflow.phase !== "push") {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "phase",
          severity: "blocker",
          workflow: state.workflow,
          summary: "git push was attempted outside the push phase.",
          expected: "git push is allowed only during the push phase.",
          actual: `Current phase: ${state.workflow.phase}`,
          impact: "Push is blocked until review/document/commit phases are completed.",
          primaryMessage: `Current phase: ${state.workflow.phase}; required phase: push`,
          command: cmd,
          improvementKind: "workflow-rule",
        });
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

      if (!state.workflow.history.some((item) => item.from === "commit" && item.to === "push")) {
        writeFieldLogEvent({
          type: "phase.violation",
          category: "phase",
          severity: "blocker",
          workflow: state.workflow,
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
            next: ["Return to commit phase", "Advance commit → push through /workflow approve or explicit natural-language approval", "Retry git push"],
          }),
        };
      }

      // Push authority is derived from strict workflow phase/history validation.
      // Diagnostic guard evidence is not the policy source.
    }

    const policySkip = consumeSkipToken("policy-scan");
    if (!policySkip) {
      const policyScan = scanPushPolicy();
      const policySignature = pushPolicySignature(policyScan);
      const policyAlreadyApproved = state.policyApprovals.at(-1)?.signature === policySignature;
      if (!policyScan.ok && !policyAlreadyApproved) {
        const GATE_SKIP_THRESHOLD = 3;
        const failures = (state.gateFailures.get("policy-scan") ?? 0) + 1;
        state.gateFailures.set("policy-scan", failures);

        writeFieldLogEvent({
          type: "policy.blocked",
          category: "push-policy",
          severity: "blocker",
          workflow: state.workflow,
          summary: `Push policy scan blocked git push (attempt ${failures}/${GATE_SKIP_THRESHOLD}).`,
          expected: "Risky push requires policy review or explicit one-use exception.",
          actual: `Policy findings: ${policyScan.findings.map((finding) => finding.category).join(", ")}`,
          impact: "Push is blocked until changes are reviewed or user approves skip.",
          primaryMessage: formatPushPolicyScanBlocked(policyScan),
          command: cmd,
          files: policyScan.findings.flatMap((finding) => finding.files.slice(0, 20).map((file) => ({ path: file, role: "changed" as const }))),
          improvementKind: "workflow-rule",
        });

        if (ctx.hasUI && failures >= GATE_SKIP_THRESHOLD) {
          const approved = await ctx.ui.confirm(
            "Push policy scan 승인 확인",
            [
              formatPushPolicyScanBlocked(policyScan),
              "",
              `Policy scan이 ${failures}회 연속 차단했습니다. 위험 변경 사항을 검토하고 계속 진행하시겠습니까?`,
              "",
              "예: 현재 git push를 계속 진행합니다.",
              "아니오: git push를 차단합니다.",
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
            return; // allow push
          }
        }

        const retryNote = failures < GATE_SKIP_THRESHOLD
          ? `Attempt ${failures}/${GATE_SKIP_THRESHOLD}: Review and reduce the flagged changes, then retry git push.`
          : `Attempt ${failures}/${GATE_SKIP_THRESHOLD}: User was asked but did not approve. Resolve the flagged changes or ask the user to run \`/workflow skip policy-scan <reason>\`.`;
        return {
          block: true,
          reason: [formatPushPolicyScanBlocked(policyScan), "", retryNote].join("\n"),
        };
      }
    }

    // Review authority is enforced during code_review → review_approved and commit → push.
    // `git push` only rechecks workspace, phase, transition history, and push policy.
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

    ctx.ui.addAutocompleteProvider((current) => ({
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/^\/workflow\s+state\s+(\S*)$/);
        if (!match) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        }
        const prefix = match[1] ?? "";
        const items = sharedWorkflowPhases()
          .filter((phase) => phase.startsWith(prefix))
          .map((phase) => ({ value: phase, label: phase }));
        return { prefix, items };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
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
      "[Workflow Guard Evidence]",
      `DPAA guard evidence: ${state.workflow && state.dpaaGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Code quality guard evidence: ${state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Code review guard evidence: ${state.codeReviewGuardSatisfiedToken ? "present" : "absent"}`,
      `Push transition evidence: ${state.workflow && state.pushExecutionGuardSatisfiedToken?.workflowId === state.workflow.id ? "present" : "absent"}`,
      `Policy scan approvals this session: ${state.policyApprovals.length}`,
    ].join("\n");

    const injection = [
      "",
      "[Harness Context]",
      `Branch: ${branch}`,
      formatWorkflowPrompt(state.workflow),
      authLines,
      formatWorkflowReminders(scanWorkflowReminders(state.workflow, {
        recentVerificationCommands: state.recentVerificationCommands,
        codeQualityGuardSatisfied: Boolean(state.workflow && state.codeQualityGuardSatisfiedToken?.workflowId === state.workflow.id),
        reviewPackageSubmitted: Boolean(state.workflow && state.reviewPackageToken?.workflowId === state.workflow.id),
      })),
    ].join("\n");

    return { systemPrompt: event.systemPrompt + injection };
  });
}
