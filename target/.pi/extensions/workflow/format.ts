import type { WorkflowInstance, WorkflowPhase } from "./types";
import { listArtifactSnapshots } from "./artifacts";
import { validateWorkflowWorkspace, formatWorkspaceMismatch } from "./gates";
import { getNextPhase } from "./state";
import { banner, table } from "./ui";
import { isSharedAutoAdvancePhase, sharedContextStrategy, sharedHardRules, sharedPhaseGuidance, sharedSubagentHandoffContract, PHASE_ALLOWED_BUILTIN_TOOLS } from "./policy-core";
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
      ["Branch", workflow.branch],
      ["Workspace", ws.ok ? "ok" : "⚠️ mismatch"],
      ["Undo", workflow.history.length > 0 ? `${workflow.history.length}개 사용 가능` : "없음"],
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
    case "plan_review":  lines.push("플랜 검토 대기 중. workflow_approve 로 구현을 시작하세요."); break;
    case "implement":    lines.push("구현 중. 완료 후 code_review 로 자동 진행됩니다."); break;
    case "code_review":  lines.push("코드 리뷰 중. submit_review_package 완료 후 review_approved 로 진행됩니다."); break;
    case "review_approved": lines.push("리뷰 완료. 문서화 → commit 준비로 자동 진행됩니다."); break;
    case "document":    lines.push("문서화 중. 완료 후 commit 준비로 자동 진행됩니다."); break;
    case "commit":      lines.push("커밋 준비 완료. workflow_approve 로 push 단계로 진입하세요."); break;
    case "push":        lines.push("Push 준비 완료. git push 를 실행하세요."); break;
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
        "- Do not request user approval before plan_review.",
      );
      break;
    case "plan":
      lines.push(
        "- Transition mode: automatic preparation chain.",
        "- Required now: produce/update the plan and DPAA/SBADR-ready artifacts, then advance to plan_review.",
        "- Do not implement until plan_review approval is received.",
      );
      break;
    case "plan_review":
      lines.push(
        "- Transition mode: user approval boundary before implement.",
        "- Required now: present the plan and call workflow_approve tool to get explicit yes/no approval from the user.",
        "- Approval validates the plan for ambiguity before implementation begins; if validation fails, clarify the plan with the user.",
      );
      break;
    case "implement":
      lines.push(
        "- Transition mode: automatic after implementation is complete.",
        "- Required now: implement only the approved scope, run the narrowest relevant verification, summarize changed files.",
        "- Then advance to code_review without asking user approval for this transition.",
      );
      break;
    case "code_review":
      lines.push(
        "- Transition mode: mechanical review gate, not a simple user-approval boundary.",
        "- Required now: run main self-review, independent reviewer/subagent review, and quality gates.",
        "- Submit submit_review_package; stay in code_review for review fixes until the package and gates pass.",
      );
      break;
    case "review_approved":
      lines.push(
        "- Transition mode: automatic documentation/commit-preparation chain.",
        "- Required now: ensure review findings are closed/accepted, then continue to document/commit preparation.",
        "- Do not ask user approval before document; approval is required before push from commit.",
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
        "- Required now: provide diff summary, risk/verification summary, and proposed commit message; commit only when appropriate.",
        "- Call workflow_approve tool when ready to push — it runs the policy scan and gets user confirmation.",
      );
      break;
    case "push":
      lines.push(
        "- Transition mode: guarded execution phase.",
        "- Required now: run git push only after policy scan approval and valid commit → push transition history.",
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
    lines.push("- Normal advancement command: workflow_approve tool (shows yes/no dialog) — may trigger this automatic transition chain.");
  } else if (workflow.phase === "code_review") {
    lines.push("- Normal advancement command: submit_review_package after review evidence is ready.");
  } else if (next) {
    lines.push("- Normal advancement command: workflow_approve tool (shows yes/no dialog) or /workflow approve slash command — only after required approval/evidence is present.");
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
        ["Version", "Source", "Reason", "DPAA"],
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
    "• Use workflow_approve tool (shows yes/no dialog) or /workflow approve slash command at approval boundaries.",
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
      return "• Deliverable: present the plan for approval. Approval to implement runs DPAA then SBADR; if either fails, explain the findings to the user and ask clarifying questions before editing artifacts.";
    case "implement":
      return "• Deliverable: implement the approved plan only. After implementation and narrow verification are complete, advance to code_review automatically; do not ask user approval for this transition.";
    case "code_review":
      return "• Deliverable: run/fix the code review loop. Advancing to review_approved mechanically runs codeQualityGuard (Checkstyle/PMD/tests) after submit_review_package is complete.";    
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
  gateFailures: Map<string, number>;
  dpaaGuardSatisfied: boolean;
  codeQualityGuardSatisfied: boolean;
  reviewPackageSubmitted: boolean;
  pushGuardSatisfied: boolean;
};

export function formatWorkflowBoard(s: WorkflowBoardState): string[] {
  if (!s.workflow) {
    return [
      "⚪ No active workflow",
      "  /workflow start <goal>",
    ];
  }

  const wf = s.workflow;
  const next = getNextPhase(wf.phase);

  // Gate status indicators
  const dpaa    = s.dpaaGuardSatisfied       ? "✅ pass" : (s.gateFailures.get("dpaa") ?? 0) > 0         ? "❌ fail" : "⏳ pending";
  const quality = s.codeQualityGuardSatisfied ? "✅ pass" : (s.gateFailures.get("code-quality") ?? 0) > 0 ? "❌ fail" : "⏳ pending";
  const review  = s.reviewPackageSubmitted    ? "✅ pass"  : "⏳ pending";
  const push    = s.pushGuardSatisfied        ? "✅ pass"  : "⏳ pending";

  // Phase-allowed commands — truncate if too many to fit in 80 chars
  const allCmds = getCatalogCommandsForPhase(wf.phase).map((c) => c.id);
  const MAX_CMDS = 4;
  const cmdsDisplay = allCmds.length <= MAX_CMDS
    ? allCmds.join(", ") || "none"
    : `${allCmds.slice(0, MAX_CMDS).join(", ")} +${allCmds.length - MAX_CMDS}`;

  // Next action hint — extract from phaseGuidance directly (avoids formatWorkflowAction parse)
  const hint = phaseGuidance(wf.phase).replace(/^\u2022\s*/, "");
  const lines: string[] = [
    `🧭 ${wf.phase.padEnd(14)}  → ${next ?? "done"}`,
    `   ${wf.title.slice(0, 60)}`,
    ``,
    (wf.phase === "commit" || wf.phase === "push")
      ? `Gates: DPAA ${dpaa}  Quality ${quality}  Review ${review}  Push ${push}`
      : `Gates: DPAA ${dpaa}  Quality ${quality}  Review ${review}`,
    `Tools: ${(PHASE_ALLOWED_BUILTIN_TOOLS[wf.phase] as readonly string[] ?? []).join(", ")}`,
    `Cmds:  ${cmdsDisplay}`,
    ``,
    `→ ${hint}`,
  ];

  return lines;
}
