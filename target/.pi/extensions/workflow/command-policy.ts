import {
  COMMAND_CATALOG,
  PHASE_ALLOWED_BUILTIN_TOOLS,
  formatCatalogCommandResult,
  getCatalogCommand,
  getCatalogCommandsForPhase,
  getGitRoot,
  isPhaseAllowed,
  runCatalogCommand,
  type WorkflowPhase,
} from "./core";

export type WorkflowCatalogCommandState = {
  workflow: { phase: WorkflowPhase } | null;
  recentVerificationCommands: Array<{ command: string; timestamp: number; phase?: WorkflowPhase }>;
};

export async function executeWorkflowCatalogCommand(
  state: WorkflowCatalogCommandState,
  commandId: string,
  ctx: any,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const spec = getCatalogCommand(commandId);
  if (!spec) {
    const available = COMMAND_CATALOG.map((s) => `${s.id} — ${s.description}`).join("\n");
    return {
      content: [{ type: "text", text: `Unknown command ID: "${commandId}".\nAvailable:\n${available}` }],
      details: { ok: false, reason: "unknown-command" },
    };
  }

  const phase = state.workflow?.phase ?? null;
  if (phase && !isPhaseAllowed(spec, phase)) {
    const allowed = getCatalogCommandsForPhase(phase).map((s) => s.id).join(", ") || "none";
    return {
      content: [{ type: "text", text: [
        `Command "${spec.id}" is not allowed in workflow phase "${phase}".`,
        `Allowed in this phase: ${allowed}`,
      ].join("\n") }],
      details: { ok: false, reason: "phase-not-allowed", phase, commandId: spec.id },
    };
  }

  if (spec.requiresApproval && ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      `Run: ${spec.id}`,
      `${spec.description}\nRisk level: ${spec.riskLevel}`,
    );
    if (!ok) {
      return {
        content: [{ type: "text", text: `Command "${spec.id}" cancelled by user.` }],
        details: { ok: false, reason: "user-cancelled" },
      };
    }
  }

  const result = runCatalogCommand(spec, getGitRoot());
  const formatted = formatCatalogCommandResult(result, spec);

  if (["code-quality", "project-test"].includes(spec.id)) {
    state.recentVerificationCommands.push({ command: spec.id, timestamp: Date.now(), phase: phase ?? undefined });
    if (state.recentVerificationCommands.length > 20) state.recentVerificationCommands.shift();
  }

  return {
    content: [{ type: "text", text: formatted }],
    details: { ok: result.ok, commandId: spec.id, exitCode: result.exitCode, elapsedMs: result.elapsedMs, truncated: result.truncated },
  };
}

export function formatWorkflowToolsListing(phase: WorkflowPhase | null): string {
  const builtins = phase ? PHASE_ALLOWED_BUILTIN_TOOLS[phase] ?? [] : ["all"];
  const catalogCmds = phase ? getCatalogCommandsForPhase(phase) : COMMAND_CATALOG;
  const extensionToolNames = [
    "submit_review_package",
    "workflow_run_command",
    "workflow_approve",
    "workflow_state",
    "workflow_propose_edit",
    "workflow_apply_approved_edit",
  ];
  return [
    phase ? `⚙️ Phase: ${phase}` : "No active workflow (showing all)",
    "",
    `Built-in tools: ${(builtins as readonly string[]).join(", ") || "none"}`,
    "",
    "Extension tools (always available):",
    ...extensionToolNames.map((n) => `  ${n}`),
    "",
    "Catalog commands (via workflow_run_command):",
    ...catalogCmds.map((s) => `  ${s.id.padEnd(20)} ${s.description}  [${s.riskLevel}]`),
  ].join("\n");
}
