import type { WorkflowInstance, WorkflowPhase } from "./types";
import { listArtifactSnapshots } from "./artifacts";
import { validateWorkflowWorkspace, formatWorkspaceMismatch } from "./gates";
import { getNextPhase } from "./state";
import { banner, table } from "./ui";
import { sharedContextStrategy, sharedHardRules, sharedPhaseGuidance, sharedSubagentHandoffContract } from "./policy-core";

export function formatWorkflowStatus(workflow: WorkflowInstance | null): string {
  if (!workflow) {
    return [
      banner("⚪ Workflow 없음"),
      "시작: /workflow start <목표>",
    ].join("\n");
  }
  const next = getNextPhase(workflow.phase);
  return [
    banner("🧭 Workflow 상태"),
    table([
      ["항목", "값"],
      ["ID", workflow.id],
      ["목표", workflow.title],
      ["현재 단계", workflow.phase],
      ["다음 단계", next ?? "없음"],
      ["시작 CWD", workflow.cwd],
      ["Git root", workflow.gitRoot ?? "없음"],
      ["Branch", workflow.branch],
      ["Workspace", validateWorkflowWorkspace(workflow).ok ? "ok" : "mismatch"],
      ["File restore", "undo/redo/restore use git workspace checkpoints"],
      ["Undo 가능", workflow.history.length > 0 ? "yes" : "no"],
      ["Redo 가능", workflow.undone.length > 0 ? "yes" : "no"],
    ]),
  ].join("\n");
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
    "• Work only on the current phase; ask for approval before advancing.",
    "• Approval can be /workflow approve or natural language such as '응, 진행해'.",
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
      return "• Deliverable: implement the approved plan only. Ask for approval before entering code_review.";
    case "code_review":
      return "• Deliverable: run/fix the code review loop. Advancing to review_approved mechanically runs codeQualityGuard (Checkstyle/PMD/tests) before the guard is satisfied.";
    case "review_approved":
      return "• Deliverable: ensure review findings are addressed/accepted. Ask for approval before documentation.";
    case "document":
      return "• Deliverable: update required docs/Swagger/feature notes. Ask for approval before commit.";
    case "commit":
      return "• Deliverable: present commit summary and commit only after approval. Ask for approval before push.";
    case "push":
      return "• Deliverable: push only after policy scan approval and commit → push transition history.";
    case "done":
      return "• Workflow is complete. Start a new workflow for additional procedural work.";
  }
}

