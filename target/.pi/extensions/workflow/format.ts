import type { WorkflowInstance, WorkflowPhase, WorkflowGate } from "./types";
import { listArtifactSnapshots } from "./artifacts";
import { validateWorkflowWorkspace, formatWorkspaceMismatch } from "./gates";
import { getNextPhase } from "./state";
import { banner, table } from "./ui";
import { isSharedAutoAdvancePhase, sharedContextStrategy, sharedHardRules, sharedPhaseGuidance, sharedSubagentHandoffContract } from "./policy-core";
import { getCatalogCommandsForPhase } from "./catalog";

export function formatWorkflowStatus(workflow: WorkflowInstance | null): string {
  if (!workflow) {
    return [
      banner("⚪ Workflow 없음"),
      "시작: /workflow start <목표>",
    ].join("\n");
  }
  const next = getNextPhase(workflow.phase);
  const ws = validateWorkflowWorkspace(workflow);
  return [
    banner("🧭 Workflow 상태"),
    table([
      ["항목", "값"],
      ["목표", workflow.title],
      ["현재 단계", workflow.phase],
      ["다음 단계", next ?? "없음"],
      ["브랜치", workflow.branch],
      ["작업공간", ws.ok ? "정상" : "⚠️ 불일치"],
      ["실행 취소", workflow.history.length > 0 ? `${workflow.history.length}개 사용 가능` : "없음"],
    ]),
    "",
    formatPhaseGuidanceForUser(workflow),
  ].join("\n");
}

/** User-facing phase summary — no LLM instruction tags. */
export function formatPhaseGuidanceForUser(workflow: WorkflowInstance): string {
  const next = getNextPhase(workflow.phase);
  const lines: string[] = [];
  switch (workflow.phase) {
    case "interview":    lines.push("요구사항 정리 중. 완료 후 plan → plan_review 로 자동 진행됩니다."); break;
    case "plan":         lines.push("플랜 작성 중. 완료 후 plan_review 로 자동 진행됩니다."); break;
    case "plan_review":  lines.push("플랜 검토 대기 중입니다. workflow_approve를 실행하면 DPAA/SBADR 검사를 거쳐 구현 승인 여부를 확인합니다."); break;
    case "implement":    lines.push("구현 중. 완료 후 code_review 로 자동 진행됩니다."); break;
    case "code_review":  lines.push("코드 리뷰 중. submit_review_package 완료 후 review_approved 로 진행됩니다."); break;
    case "review_approved": lines.push("리뷰 완료. 문서화 → commit 준비로 자동 진행됩니다."); break;
    case "document":    lines.push("문서화 중. 완료 후 commit 준비로 자동 진행됩니다."); break;
    case "commit":      lines.push("커밋 준비 완료. workflow_approve 로 push 단계로 진입하세요."); break;
    case "push":        lines.push("Push 준비 완료. workflow_run_command git-push 로 git push 를 실행하세요."); break;
    case "done":        lines.push("✅ 완료됐습니다."); break;
  }
  if (next && workflow.phase !== "done") {
    lines.push(`다음 단계: ${next}`);
  }
  return lines.join("\n");
}

export function formatWorkflowAction(workflow: WorkflowInstance | null): string {
  if (!workflow) {
    return [
      "[LLM WORKFLOW ACTION]",
      "- No active workflow.",
      "- For procedural work, ask whether to start one with /workflow start <goal>.",
      "[/LLM WORKFLOW ACTION]",
    ].join("\n");
  }

  const next = getNextPhase(workflow.phase);
  const displayNext = workflow.phase === "code_review" && next === "review_approved" ? "review-approved (after review package and gates)" : next ?? "none";
  const lines = [
    "[LLM WORKFLOW ACTION]",
    `- Current phase: ${workflow.phase}`,
    `- Next phase: ${displayNext}`,
  ];

  switch (workflow.phase) {
    case "interview":
      lines.push(
        "- Transition mode: automatic preparation chain.",
        "- Required now: clarify requirements, record interview artifacts, then advance through plan to plan_review when ready.",
        "- After workflow_interview_wizard completes: call workflow_score_interview with per-dimension clarity scores (0-100). This is required before interview → plan.",
        "- User-visible next stop after the automatic preparation chain: plan_review awaiting plan approval.",
        "- Do not request user approval before plan_review.",
      );
      break;
    case "plan":
      lines.push(
        "- Transition mode: automatic preparation chain.",
        "- Required now: produce/update the plan and DPAA/SBADR-ready artifacts, then advance to plan_review.",
        "- User-visible state: planning in progress; next stop is plan_review for explicit approval.",
        "- Do not implement until plan_review approval is received.",
      );
      break;
    case "plan_review":
      lines.push(
        "- Transition mode: user approval boundary before implement.",
        "- Required now: present the plan; workflow_approve will show the user an explicit yes/no dialog before implementation.",
        "- Approval runs DPAA/SBADR ambiguity checks before implementation. If checks fail, autonomously repair vague/ambiguous sentences and retry workflow_approve — only ask the user for genuine business decisions that cannot be inferred from context.",
      );
      break;
    case "implement":
      lines.push(
        "- Transition mode: automatic after implementation is complete.",
        "- Required now: implement only the approved scope, run the narrowest relevant verification, summarize changed files.",
        "- If the approved scope is already satisfied, record concrete evidence, state that no code changes are needed, run the narrowest relevant verification, then proceed to code_review instead of inventing edits.",
        "- TDD: if writing new production code, write the failing test first without asking the user. Complete the full cycle (failing test → implement → pass) autonomously.",
        "- Static analysis: write code that already follows the project's Checkstyle/PMD conventions (naming rules, line length, method size, import style). If violations occur anyway, fix them silently without reporting to the user. Do not ask; just fix and re-run.",
      );
      break;
    case "code_review":
      lines.push(
        "- Transition mode: mechanical review gate, not a simple user-approval boundary.",
        "- Required now: run main self-review, independent reviewer/subagent review, and quality gates.",
        "- Prefer async subagent review for independent review so foreground timeouts do not block the main workflow; incorporate the completed async result into submit_review_package.",
        "- Call submit_review_package; stay in code_review for review/fix cycles until the package and all gates pass.",
      );
      break;
    case "review_approved":
      lines.push(
        "- Transition mode: automatic documentation/commit-preparation chain.",
        "- Required now: ensure review findings are closed/accepted, then continue to document/commit preparation.",
        "- Do not ask user approval before document or commit preparation; user approval is required at the commit → push boundary only.",
      );
      break;
    case "document":
      lines.push(
        "- Transition mode: automatic toward commit preparation.",
        "- Required now: update required docs or state why docs are not applicable, then continue to commit preparation.",
        "- Do not ask user approval before commit preparation.",
      );
      break;
    case "commit":
      lines.push(
        "- Transition mode: user approval boundary before push.",
        "- Required now: provide a concise diff summary, risk/verification summary, and a proposed commit message. Create the git commit after the user approves the message.",
        "- When ready for push, workflow_approve runs the policy scan and shows the user a yes/no dialog.",
      );
      break;
    case "push":
      lines.push(
        "- Transition mode: guarded execution phase.",
        "- Required now: run workflow_run_command with commandId 'git-push' immediately in this turn — the extension detects the successful push and auto-advances to done.",
        "- Do NOT call workflow_approve in push phase; it cannot advance push → done and will block.",
        "- If push execution guard is already satisfied (commit → push approval already recorded), run workflow_run_command({ commandId: 'git-push' }) right now without calling workflow_approve again.",
      );
      break;
    case "done":
      lines.push(
        "- Transition mode: complete.",
        "- Required now: do not continue procedural work unless the user starts a new workflow.",
      );
      break;
  }

  if (next && isSharedAutoAdvancePhase(workflow.phase)) {
    lines.push("- Normal advancement: call workflow_approve as an internal transition tool; it must not show a user dialog for this automatic transition.");
  } else if (workflow.phase === "code_review") {
    lines.push("- Normal advancement command: submit_review_package after review evidence is ready.");
  } else if (next) {
    lines.push("- Normal advancement: workflow_approve shows a yes/no dialog only at this approval boundary; do not ask the user to type /workflow approve.");
  }

  lines.push("- workflow_state tool or /workflow state <phase> is manual recovery only (one step at a time); never use for normal advancement.", "[/LLM WORKFLOW ACTION]");
  return lines.join("\n");
}

export function formatWorkflowHistory(workflow: WorkflowInstance | null): string {
  if (!workflow) return "⚪ 진행 중인 workflow가 없습니다.";
  if (workflow.history.length === 0) return "⚪ Workflow 전이 이력이 없습니다.";
  const snapshots = listArtifactSnapshots(workflow.id);
  const sections = [
    banner("🕘 Workflow 전이 이력"),
    table([
      ["#", "전이", "사유"],
      ...workflow.history.map((item, index) => [String(index + 1), `${item.from} → ${item.to}`, item.reason]),
    ]),
  ];
  if (snapshots.length > 0) {
    sections.push(
      "",
      banner("📚 Artifact 버전 이력"),
      table([
        ["버전", "출처", "사유", "DPAA"],
        ...snapshots.map((snapshot) => [
          snapshot.version,
          snapshot.source,
          snapshot.reason,
          snapshot.dpaa ? `${snapshot.dpaa.level}/${snapshot.dpaa.overall}` : "-",
        ]),
      ]),
    );
  }
  return sections.join("\n");
}

export function formatWorkflowPrompt(workflow: WorkflowInstance | null): string {
  if (!workflow) {
    return [
      "• No active workflow.",
      "• For procedural work, suggest /workflow start <goal> to the user.",
    ].join("\n");
  }
  const next = getNextPhase(workflow.phase);
  const workspace = validateWorkflowWorkspace(workflow);
  const lines = [
    `• Workflow phase: ${workflow.phase}`,
    `• Next phase: ${next ?? "none"}`,
    `• Workflow branch: ${workflow.branch}`,
    `• Workflow cwd: ${workflow.cwd}`,
    "• Work only on the current phase; follow the LLM workflow action block for automatic vs approval-required transitions.",
    "• At approval boundaries, use workflow_approve to show a yes/no dialog; do not ask the user to type /workflow approve.",
    formatWorkflowAction(workflow),
    "• Phase changes always create workspace checkpoints; during implement/code_review/review_approved/document/commit/push, dirty workspace user requests may prompt for an extra checkpoint.",
    "• /workflow undo, redo, and restore recover tracked/staged/untracked git workspace changes from checkpoints.",
    formatHardRules(),
    formatContextStrategy(workflow.phase),
    phaseGuidance(workflow.phase),
  ];
  if (!workspace.ok) lines.push(formatWorkspaceMismatch(workspace));
  return lines.join("\n");
}

function formatHardRules(): string {
  const rules = sharedHardRules();
  return rules.length > 0 ? ["[WORKFLOW HARD RULES]", ...rules.map((rule) => `- ${rule}`), "[/WORKFLOW HARD RULES]"].join("\n") : "";
}

function formatContextStrategy(phase: WorkflowPhase): string {
  const strategy = sharedContextStrategy(phase);
  if (!strategy) return "";
  const contract = sharedSubagentHandoffContract();
  return [
    `[CONTEXT STRATEGY: ${phase}]`,
    strategy.delegateTo ? `- Delegate: ${strategy.delegateTo}` : "",
    strategy.mainKeeps.length > 0 ? `- Main keeps: ${strategy.mainKeeps.join(", ")}` : "",
    strategy.mainAvoids.length > 0 ? `- Main avoids: ${strategy.mainAvoids.join(", ")}` : "",
    contract.length > 0 ? `- Subagent returns: ${contract.join(", ")}` : "",
    "[/CONTEXT STRATEGY]",
  ].filter(Boolean).join("\n");
}

export function phaseGuidance(phase: WorkflowPhase): string {
  const shared = sharedPhaseGuidance(phase);
  if (shared) return `• Deliverable: ${shared}`;

  switch (phase) {
    case "interview":
      return "• Deliverable: clarify requirements and keep Korean source artifacts in .ai/interview/*.ko.md.";
    case "plan":
      return "• Deliverable: produce/update the implementation plan; keep English DPAA artifacts faithful to the Korean sources.";
    case "plan_review":
      return "• Deliverable: present the plan for approval. The approval dialog runs DPAA then SBADR; if checks fail, autonomously repair the plan artifacts (vague phrasing, missing metrics, undefined pronouns, syntactic ambiguity) and retry workflow_approve. Ask the user only for genuine business decisions that cannot be inferred from context.";
    case "implement":
      return "• Deliverable: implement the approved plan only. After implementation and narrow verification are complete, advance to code_review automatically; do not ask user approval for this transition.";
    case "code_review":
      return "• Deliverable: run/fix the code review loop. Advancing to review_approved mechanically runs codeQualityGuard (Checkstyle/PMD) + coverageGuard (JaCoCo) after submit_review_package is complete.";
    case "review_approved":
      return "• Deliverable: ensure review findings are addressed/accepted, then continue automatically toward documentation and commit preparation.";
    case "document":
      return "• Deliverable: update required docs/Swagger/feature notes or state why they are not applicable, then continue automatically toward commit preparation.";
    case "commit":
      return "• Deliverable: present commit summary and commit only after approval. Ask for approval before push.";
    case "push":
      return "• Deliverable: push only after policy scan approval and commit → push transition history.";
    case "done":
      return "• Workflow is complete. Start a new workflow for additional procedural work.";
  }
}


// ─── Workflow board widget ─────────────────────────────────────────────────
// Renders a compact status board for ctx.ui.setWidget().
// Each line is a plain string; width enforcement is the caller's responsibility.

export type WorkflowBoardState = {
  workflow: WorkflowInstance | null;
  gateFailures: Map<WorkflowGate, number>;
  dpaaGuardSatisfied: boolean;
  codeQualityGuardSatisfied: boolean;
  reviewPackageSubmitted: boolean;
  pushGuardSatisfied: boolean;
};

export function formatWorkflowBoard(s: WorkflowBoardState): string[] {
  if (!s.workflow) {
    return [
      "⚪ 워크플로우 없음",
      "  /workflow start <목표>",
    ];
  }

  const wf = s.workflow;
  const next = getNextPhase(wf.phase);

  // Gate status indicators — only show gates relevant to the current phase
  const dpaa    = s.dpaaGuardSatisfied       ? "✅" : (s.gateFailures.get("dpaa") ?? 0) > 0         ? "❌" : "⏳";
  const quality = s.codeQualityGuardSatisfied ? "✅" : (s.gateFailures.get("code-quality") ?? 0) > 0 ? "❌" : "⏳";
  const review  = s.reviewPackageSubmitted    ? "✅" : "⏳";
  const push    = s.pushGuardSatisfied        ? "✅" : "⏳";

  type GateEntry = [string, string];
  const relevantGates: GateEntry[] = (() => {
    switch (wf.phase) {
      case "plan_review":                        return [["DPAA", dpaa]];
      case "implement":                          return [["DPAA", dpaa], ["Quality", quality]];
      case "code_review":                        return [["Quality", quality], ["Review", review]];
      case "review_approved": case "document":   return [["Quality", quality], ["Review", review], ["Push", push]];
      case "commit": case "push":                return [["Quality", quality], ["Review", review], ["Push", push]];
      default:                                   return [];
    }
  })();

  // Phase-allowed commands — truncate if too many to fit in 80 chars
  const allCmds = getCatalogCommandsForPhase(wf.phase).map((c) => c.id);
  const MAX_CMDS = 4;
  const cmdsDisplay = allCmds.length <= MAX_CMDS
    ? allCmds.join(", ") || "none"
    : `${allCmds.slice(0, MAX_CMDS).join(", ")} +${allCmds.length - MAX_CMDS}`;

  // User-friendly hint from formatPhaseGuidanceForUser
  const hint = formatPhaseGuidanceForUser(wf).split("\n")[0];
  const gatesLine = relevantGates.length > 0
    ? `Gates: ${relevantGates.map(([label, status]) => `${label} ${status}`).join("  ")}`
    : null;
  const lines: string[] = [
    `🧭 ${wf.phase.padEnd(16)}  → ${next ?? "done"}`,
    `   ${wf.title.slice(0, 60)}`,
    ``,
    ...(gatesLine ? [gatesLine] : []),
    `Cmds:  ${cmdsDisplay}`,
    ``,
    `→ ${hint}`,
  ];

  return lines;
}
