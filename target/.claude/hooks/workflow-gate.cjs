#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const POLICY_FILE = '.harness/workflow-policy.json';
const workflowPolicy = loadWorkflowPolicy();
const WORKFLOW_PHASES = workflowPolicy.phases;
const AUTO_ADVANCE_FROM_PHASES = new Set(workflowPolicy.autoAdvanceFromPhases);
const APPROVAL_BOUNDARIES = new Set(workflowPolicy.approvalBoundaries);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const STATE_FILE = '.harness/state.json';
const PERSISTED_FILE = '.harness/workflow.json';
const PLAN_REVIEW_FILE = '.harness/authority/plan-review.json';
const REVIEW_PACKAGE_FILE = '.harness/authority/review-package.json';
const POLICY_APPROVAL_FILE = '.harness/authority/push-approval.json';
const SESSION_AUTHORITY_DIR = '.harness/.authority-runtime';
const HARNESS_MEMORY_DIR = '.project-memory/harness';
const FIELD_LOG_FILE = '.project-memory/harness/events.jsonl';
const PI_ROOT = '.pi';
const DPAA_RECEIPT_DIR = '.harness/dpaa-runs';

const PROTECTED_PATTERNS = [
  '.claude/**',
  '.harness/state.json',
  '.harness/workflow.json',
  '.harness/authority/**',
  '.harness/.authority-runtime/**',
  '.harness/policy.yaml',
  '.harness/workflow-policy.json',
  '.pi/extensions/**',
  'target/.pi/extensions/**',
];
const INTERVIEW_PATTERNS = ['.ai/interview/**', '.harness/proposal/interview.*'];
const PLAN_PATTERNS = ['.ai/interview/**', 'docs/superpowers/plans/**', '.harness/proposal/**'];
const DOC_PATTERNS = ['**/*.md', 'docs/**', 'README.md', 'README.*.md', '.ai/interview/**', '.harness/proposal/**'];

const command = process.argv[2] || 'status';
const args = process.argv.slice(3);
const input = readStdinJson();

try {
  switch (command) {
    case 'check-tool-call': checkToolCall(input); break;
    case 'user-prompt': handleUserPrompt(input); break;
    case 'reevaluate': reevaluate('artifact_condition', input); break;
    case 'start': startWorkflow(args.join(' ').trim() || 'workflow'); break;
    case 'approve': approveWorkflow(); break;
    case 'status': printStatus(); break;
    case 'list': printList(); break;
    case 'load': loadPersistedIntoState(); break;
    case 'history': printHistory(); break;
    case 'snapshot': createArtifactSnapshot(args.join(' ').trim() || 'manual snapshot'); break;
    case 'submit-review-package': submitReviewPackage(args.join(' ')); break;
    case 'undo': undoWorkflow(); break;
    case 'redo': redoWorkflow(); break;
    case 'skip': skipGateCommand(args.join(' ')); break;
    case 'failures': printFailures(args[0]); break;
    case 'checkpoint': createManualCheckpoint(args.join(' ').trim() || 'manual'); break;
    case 'checkpoints': printCheckpoints(); break;
    case 'restore': restoreCheckpoint(args[0]); break;
    case 'dpaa-audit': printDpaaAudit(); break;
    case 'abort': abortWorkflow(); break;
    case 'state': setWorkflowState(args[0]); break;
    case 'doctor': doctor(); break;
    default: deny(`Unknown workflow gate command: ${command}`);
  }
} catch (error) {
  deny(`Workflow gate error: ${error.message}`);
}

function isGitDashCPush(commandText) { return /\bgit\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+push\b/i.test(commandText); }
function isGitPush(commandText) { return /\bgit(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+push\b/i.test(commandText); }
function contextMessage(message, hookEventName) { return { systemMessage: message, hookSpecificOutput: { hookEventName, additionalContext: message } }; }

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function loadWorkflowPolicy() {
  const fallback = {
    phases: ['interview', 'plan', 'plan_review', 'implement', 'code_review', 'review_approved', 'document', 'commit', 'push', 'done'],
    autoAdvanceFromPhases: ['interview', 'plan', 'implement', 'review_approved', 'document'],
    approvalBoundaries: ['plan_review:implement', 'commit:push'],
    phaseGuidance: {},
    reminderPolicy: { hardRules: [] },
    transitionPolicy: {
      strictNextPhaseOnly: true,
      forbidSkippedPhases: true,
      manualStateRestoreIsRecoveryOnly: true,
      tokenIssuanceIsNotThePolicySource: true,
    },
    contextStrategy: {},
    subagentHandoffContract: [],
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, POLICY_FILE), 'utf8'));
    return {
      ...fallback,
      ...parsed,
      phases: Array.isArray(parsed.phases) && parsed.phases.length > 0 ? parsed.phases : fallback.phases,
      autoAdvanceFromPhases: Array.isArray(parsed.autoAdvanceFromPhases) ? parsed.autoAdvanceFromPhases : fallback.autoAdvanceFromPhases,
      approvalBoundaries: Array.isArray(parsed.approvalBoundaries) ? parsed.approvalBoundaries : fallback.approvalBoundaries,
      transitionPolicy: normalizeTransitionPolicy(parsed.transitionPolicy, fallback.transitionPolicy),
      phaseGuidance: parsed.phaseGuidance && typeof parsed.phaseGuidance === 'object' ? parsed.phaseGuidance : fallback.phaseGuidance,
      reminderPolicy: parsed.reminderPolicy && typeof parsed.reminderPolicy === 'object' ? parsed.reminderPolicy : fallback.reminderPolicy,
      contextStrategy: parsed.contextStrategy && typeof parsed.contextStrategy === 'object' ? parsed.contextStrategy : fallback.contextStrategy,
      subagentHandoffContract: Array.isArray(parsed.subagentHandoffContract) ? parsed.subagentHandoffContract.filter((item) => typeof item === 'string' && item.trim().length > 0) : fallback.subagentHandoffContract,
    };
  } catch {
    return fallback;
  }
}

function normalizeTransitionPolicy(value, fallback) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    strictNextPhaseOnly: typeof source.strictNextPhaseOnly === 'boolean' ? source.strictNextPhaseOnly : fallback.strictNextPhaseOnly,
    forbidSkippedPhases: typeof source.forbidSkippedPhases === 'boolean' ? source.forbidSkippedPhases : fallback.forbidSkippedPhases,
    manualStateRestoreIsRecoveryOnly: typeof source.manualStateRestoreIsRecoveryOnly === 'boolean' ? source.manualStateRestoreIsRecoveryOnly : fallback.manualStateRestoreIsRecoveryOnly,
    tokenIssuanceIsNotThePolicySource: typeof source.tokenIssuanceIsNotThePolicySource === 'boolean' ? source.tokenIssuanceIsNotThePolicySource : fallback.tokenIssuanceIsNotThePolicySource,
  };
}

function checkToolCall(event) {
  const workflow = loadWorkflow();
  const phase = workflow.phase;
  const toolName = event.tool_name || event.toolName || '';
  const toolInput = event.tool_input || event.toolInput || {};

  if (toolName === 'Bash') {
    checkBash(phase, String(toolInput.command || ''));
    return allow();
  }
  if (!WRITE_TOOLS.has(toolName)) return allow();

  const target = normalizeRelPath(toolInput.file_path || toolInput.path || toolInput.notebook_path || '');
  if (!target) deny(`Blocked by workflow gate. Could not determine write target for ${toolName}.`);
  if (matchesAny(target, PROTECTED_PATTERNS)) deny(`Blocked by workflow gate. Protected path cannot be modified: ${target}`);

  if (phase === 'interview') {
    if (!matchesAny(target, INTERVIEW_PATTERNS)) deny('Blocked by workflow gate. Current phase: interview. Clarify requirements in .ai/interview/** before planning or editing code.');
    return allow();
  }
  if (phase === 'plan') {
    if (!matchesAny(target, PLAN_PATTERNS)) deny('Blocked by workflow gate. Current phase: plan. Write the implementation plan in .ai/interview/plan.md or docs/superpowers/plans/**.');
    return allow();
  }
  if (phase === 'plan_review') deny('Blocked by workflow gate. Current phase: plan_review. Wait for explicit approval before implementation.');

  if (phase === 'implement' || phase === 'code_review') {
    if (matchesAny(target, PLAN_PATTERNS)) return allow();
    const allowed = approvedAllowedFiles();
    if (allowed.length > 0 && !matchesAny(target, allowed)) {
      deny(`Blocked by workflow gate. Current phase: ${phase}. File is outside approved allowed_files: ${target}`);
    }
    return allow();
  }

  if (phase === 'review_approved') return allow();

  if (phase === 'document') {
    if (!matchesAny(target, DOC_PATTERNS)) deny('Blocked by workflow gate. Current phase: document. Only documentation/interview artifacts may be edited.');
    return allow();
  }

  if (phase === 'commit') deny('Blocked by workflow gate. Current phase: commit. Present commit summary and wait for approval before push.');
  if (phase === 'push') deny('Blocked by workflow gate. Current phase: push. Push is controlled by approval/policy checks; do not edit files.');
  if (phase === 'done') deny('Blocked by workflow gate. Current phase: done. Start a new workflow before more changes.');
  allow();
}

function checkBash(phase, commandText) {
  if (!commandText.trim()) return;
  if (/\bgit\s+(tag|reset\s+--hard|clean\s+-fd)\b/i.test(commandText)) deny('Blocked by workflow gate. Destructive git commands are disabled.');
  if (isGitDashCPush(commandText)) deny('Blocked by workflow gate. git -C <path> push is disabled during workflow; run push from the workflow worktree.');
  if (isGitPush(commandText) && phase !== 'push') deny(`Blocked by workflow gate. git push is allowed only in push phase. Current phase: ${phase}.`);
  if (isGitPush(commandText)) {
    const workflow = loadWorkflow();
    const workspace = validateWorkflowWorkspace(workflow);
    if (!workspace.ok) deny(formatWorkspaceMismatch(workspace));
    if (!hasWorkflowTransition(workflow, 'commit', 'push')) deny('Blocked by workflow gate. Missing workflow transition history: commit → push. Advance through /workflow:approve instead of setting push directly.');
    // Push authority is derived from strict workflow phase/history validation, not from session tokens.
  }
  if (/\bgit\s+commit\b/i.test(commandText) && phase !== 'commit') deny(`Blocked by workflow gate. git commit is allowed only in commit phase. Current phase: ${phase}.`);

  for (const pattern of PROTECTED_PATTERNS) {
    const rough = pattern.replace('/**', '').replace('**', '');
    if (rough && commandText.includes(rough) && /\b(rm|mv|cp|touch|chmod|chown|python|python3|node|perl|ruby|sh|bash|powershell|pwsh|sed)\b|>|>>/i.test(commandText)) {
      deny(`Blocked by workflow gate. Bash command appears to modify protected path: ${rough}`);
    }
  }

  if ((phase === 'interview' || phase === 'plan' || phase === 'plan_review') && /\b(src|lib|app|packages|target)\//.test(commandText) && /\b(rm|mv|cp|touch|chmod|python|node|perl|ruby|sed\s+-i)\b|>|>>/i.test(commandText)) {
    deny(`Blocked by workflow gate. Current phase: ${phase}. Source modifications are not allowed before implementation.`);
  }
}

function handleUserPrompt(event) {
  const workflow = loadWorkflowOrNull();
  if (!workflow || workflow.phase === 'done') return allow();
  const text = String(event.prompt || event.message || event.text || '').trim();
  if (isApprovalText(text) && isApprovalBoundary(workflow.phase)) {
    const result = advanceWorkflow(workflow, 'natural_language_approval', { approval: true, event });
    const updated = loadWorkflowOrNull() || workflow;
    const message = result.ok ? result.message : `Workflow approval blocked: ${result.message}`;
    console.log(JSON.stringify(contextMessage(`${message}\n\n${formatWorkflowPrompt(updated)}`, 'UserPromptSubmit')));
    return allow();
  }
  console.log(JSON.stringify(contextMessage(formatWorkflowPrompt(workflow), 'UserPromptSubmit')));
  return allow();
}

function startWorkflow(title) {
  const rawState = readJson(STATE_FILE, null);
  const templateOnly = rawState && !rawState.workflowId && normalizePhase(rawState.phase || rawState.state) === 'interview' && (!Array.isArray(rawState.history) || rawState.history.length === 0);
  const existing = loadWorkflowOrNull();
  if (existing && existing.phase !== 'done' && !templateOnly) deny(`Workflow already active: ${existing.phase}. Use status/abort first.`);
  const workflow = createWorkflow(title);
  saveWorkflow(workflow);
  console.log(formatWorkflowStatus(workflow));
}

function approveWorkflow() {
  const workflow = loadWorkflow();
  const result = advanceWorkflow(workflow, 'user_approved', { approval: true, event: input });
  if (!result.ok) deny(result.message);
  console.log(result.message);
}

function reevaluate(reason, event = {}) {
  const workflow = loadWorkflow();
  const result = advanceWorkflow(workflow, reason, { approval: false, event });
  if (result.ok && result.transitions.length > 0) {
    console.log(JSON.stringify(contextMessage(result.message, 'PostToolUse')));
  }
}

function advanceWorkflow(workflow, reason, options) {
  const transitions = [];
  while (true) {
    const from = workflow.phase;
    const to = getNextPhase(from);
    if (!to) return transitions.length ? ok(transitions) : { ok: false, message: `Already at final phase: ${from}`, transitions };

    if (APPROVAL_BOUNDARIES.has(`${from}:${to}`) && !options.approval) break;
    if (!isTransitionAllowedByPolicy(from, to)) return transitions.length ? ok(transitions) : { ok: false, message: `Workflow transition blocked by policy: ${from} → ${to}`, transitions };
    const gate = runPreTransitionGate(workflow, from, to, options);
    if (!gate.ok) return transitions.length ? ok(transitions) : { ok: false, message: gate.message, transitions };

    const checkpointBefore = createWorkspaceCheckpoint(workflow, `${from}-to-${to}`);
    workflow.history.push({ from, to, reason, timestamp: Date.now(), checkpointBefore });
    workflow.phase = to;
    workflow.updatedAt = Date.now();
    transitions.push({ from, to });
    if (!AUTO_ADVANCE_FROM_PHASES.has(to)) break;
  }
  return ok(transitions);

  function ok(items) {
    saveWorkflow(workflow);
    const pathText = items.map((item, index) => index === 0 ? `${item.from} → ${item.to}` : `→ ${item.to}`).join(' ');
    return { ok: true, transitions: items, message: `Workflow 전이: ${pathText}` };
  }
}

function runPreTransitionGate(workflow, from, to, options) {
  if (from === 'interview' && to === 'plan') {
    return hasInterviewArtifact() ? pass() : block('Interview artifact required: create .ai/interview/spec.md or .ai/interview/spec.ko.md.');
  }
  if (from === 'plan' && to === 'plan_review') {
    return hasPlanArtifact() ? pass() : block('Plan artifact required: create .ai/interview/plan.md or docs/superpowers/plans/*.md.');
  }
  if (from === 'plan_review' && to === 'implement') {
    if (!options.approval) return block('Explicit user approval required for plan_review → implement.');
    if (!isPlanReviewApproved()) return block(`Plan review approval required in ${PLAN_REVIEW_FILE}.`);
    const skipped = consumeSkipToken('dpaa', workflow.id, options.event || {});
    return skipped ? pass(`DPAA skipped: ${skipped.reason}`) : runDpaaGate(workflow, from, to);
  }
  if (from === 'implement' && to === 'code_review') {
    return fileExists('.harness/proposal/implementation-summary.md') || hasImplementationChangedFiles() ? pass() : block('Implementation evidence required: implementation changed files or .harness/proposal/implementation-summary.md.');
  }
  if (from === 'code_review' && to === 'review_approved') {
    if (!isReviewPackageApproved()) return block(`Review package required in ${REVIEW_PACKAGE_FILE}.`);
    const skipped = consumeSkipToken('code-quality', workflow.id, options.event || {});
    return skipped ? pass(`Code quality skipped: ${skipped.reason}`) : runCodeQualityGate(workflow);
  }
  if (from === 'review_approved' && to === 'document') return pass();
  if (from === 'document' && to === 'commit') return hasDocsEvidence() ? pass() : block('Documentation evidence required: docs changes or .harness/proposal/docs-summary.md.');
  if (from === 'commit' && to === 'push') {
    if (!options.approval) return block('Explicit user approval required for commit → push.');
    const policy = scanPushPolicy();
    const skipped = consumeSkipToken('policy-scan', workflow.id, options.event || {});
    const approved = isPushApproved(policy);
    if (!policy.ok && !approved && !skipped) return block(formatPushPolicyBlocked(policy));
    return approved || policy.ok || skipped ? pass() : block(`Push approval required in ${POLICY_APPROVAL_FILE}.`);
  }
  return pass();
}

function printStatus() { console.log(formatWorkflowStatus(loadWorkflowOrNull())); }
function printList() {
  const catalog = listWorkflowCatalog();
  console.log([
    formatWorkflowStatus(loadWorkflowOrNull()),
    '',
    'Persisted workflow: ' + (fileExists(PERSISTED_FILE) ? PERSISTED_FILE : 'none'),
    '',
    'Workflow catalog:',
    catalog.length ? catalog.map((item) => `- ${item.id}: ${item.title}`).join('\n') : '(none found under .pi/workflows)'
  ].join('\n'));
}
function printHistory() {
  const workflow = loadWorkflowOrNull();
  if (!workflow || workflow.history.length === 0) return console.log('No workflow history.');
  console.log(workflow.history.map((h, i) => `${i + 1}. ${h.from} → ${h.to} (${h.reason})`).join('\n'));
}
function undoWorkflow() {
  const workflow = loadWorkflowOrNull();
  if (!workflow || workflow.history.length === 0) return deny('No workflow transition to undo.');
  const last = workflow.history.pop();
  last.checkpointAfter = createWorkspaceCheckpoint(workflow, `${last.to}-before-undo`);
  let restored = '';
  if (last.checkpointBefore) restored = restoreWorkspaceCheckpoint(last.checkpointBefore);
  workflow.undone = workflow.undone || [];
  workflow.undone.push(last);
  workflow.phase = last.from;
  workflow.updatedAt = Date.now();
  saveWorkflow(workflow);
  console.log([`Workflow undo: ${last.to} → ${last.from}`, restored].filter(Boolean).join('\n'));
}
function redoWorkflow() {
  const workflow = loadWorkflowOrNull();
  const next = workflow?.undone?.pop();
  if (!workflow || !next) return deny('No workflow transition to redo.');
  next.checkpointBefore = createWorkspaceCheckpoint(workflow, `${next.from}-before-redo`);
  let restored = '';
  if (next.checkpointAfter) restored = restoreWorkspaceCheckpoint(next.checkpointAfter);
  workflow.history.push(next);
  workflow.phase = next.to;
  workflow.updatedAt = Date.now();
  saveWorkflow(workflow);
  console.log([`Workflow redo: ${next.from} → ${next.to}`, restored].filter(Boolean).join('\n'));
}
function submitReviewPackage(raw) {
  const workflow = loadWorkflow();
  const data = parseKeyValueArgs(raw);
  const critical = Number(data.critical || 0);
  const major = Number(data.major || 0);
  const minor = Number(data.minor || 0);
  if (critical > 0 || major > 0) return deny(`Review package blocked: critical=${critical}, major=${major}. Resolve or explicitly document accepted risk before approval.`);
  writeJson(REVIEW_PACKAGE_FILE, { status: 'approved', summary: data.summary || raw || 'review package submitted', critical, major, minor, self_review: data.self_review || '', independent_review: data.independent_review || '', submitted_at: new Date().toISOString() });
  writeFieldLogEvent(workflow, 'review.submitted', 'code-quality', 'Review package submitted.', raw);
  console.log(`Review package approved: critical=${critical}, major=${major}, minor=${minor}`);
}
function parseKeyValueArgs(raw) { const out = {}; for (const part of String(raw || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i)] = part.slice(i + 1).replace(/^['"]|['"]$/g, ''); } return out; }
function createArtifactSnapshot(reason) {
  const workflow = loadWorkflow();
  const sources = ['.ai/interview/spec.md', '.ai/interview/spec.ko.md', '.ai/interview/plan.md', '.ai/interview/plan.ko.md'].filter(fileExists);
  if (sources.length === 0) return deny('No spec/plan artifacts to snapshot.');
  const dir = path.join(abs('.ai/interview/runs'), workflow.id, `${Date.now()}-${slugify(reason)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of sources) fs.copyFileSync(abs(rel), path.join(dir, path.basename(rel)));
  writeJson(path.relative(cwd, path.join(dir, 'meta.json')), { workflowId: workflow.id, reason, createdAt: new Date().toISOString(), sources });
  console.log(`Artifact snapshot created: ${path.relative(cwd, dir)}`);
}
function skipGateCommand(raw) {
  const trimmed = String(raw || '').trim();
  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  return skipGate(match?.[1], match?.[2] || '');
}
function skipGate(gate, reason) {
  const workflow = loadWorkflow();
  const valid = ['dpaa', 'code-quality', 'policy-scan'];
  if (!valid.includes(gate)) return deny(`Usage: skip <${valid.join('|')}> <reason>`);
  if (!String(reason || '').trim()) return deny(`Reason required. Usage: skip ${gate} <reason>`);
  issueSkipToken(gate, workflow.id, reason, input);
  writeFieldLogEvent(workflow, 'gate.skipped', gate, `${gate} one-use exception issued.`, reason);
  console.log(`✅ [${gate}] one-use exception issued for this session (1 use, 10 minutes). Reason: ${reason}`);
}
function listWorkflowCatalog() {
  const dir = abs('.pi/workflows');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      const firstHeading = text.split(/\r?\n/).find((line) => line.startsWith('# '));
      return { id: name.replace(/\.md$/, ''), title: firstHeading ? firstHeading.replace(/^#\s+/, '').trim() : name };
    });
}
function printFailures(mode) {
  const file = abs(FIELD_LOG_FILE);
  if (!fs.existsSync(file)) return console.log('No harness field logs.');
  if (mode === 'export') return console.log(`Harness field logs exported: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-10);
  console.log(lines.map((line) => { try { const e = JSON.parse(line); return `${e.timestamp} [${e.category}] ${e.summary}`; } catch { return line; } }).join('\n'));
}
function loadPersistedIntoState() {
  const workflow = readJson(PERSISTED_FILE, null);
  if (!workflow) deny('No persisted workflow instance found.');
  workflow.phase = normalizePhase(workflow.phase);
  saveWorkflow(workflow);
  console.log(`✅ Workflow loaded: [${workflow.phase}] ${workflow.title}`);
}
function abortWorkflow() {
  clearWorkflow();
  clearSessionAuthority();
  console.log('Workflow aborted.');
}
function setWorkflowState(phase) {
  if (!WORKFLOW_PHASES.includes(phase)) deny(`Usage: state <${WORKFLOW_PHASES.join('|')}>`);
  const workflow = loadWorkflowOrNull() || createWorkflow('manual');
  const from = workflow.phase;
  workflow.phase = phase;
  workflow.history.push({ from, to: phase, reason: 'manual_override', timestamp: Date.now() });
  workflow.updatedAt = Date.now();
  saveWorkflow(workflow);
  console.log(formatWorkflowStatus(workflow));
}
function doctor() {
  const settings = readJson('.claude/settings.json', {});
  const deny = settings.permissions?.deny || [];
  const hooks = settings.hooks || {};
  const checks = [
    ['settings json', fileExists('.claude/settings.json')],
    ['hook script', fileExists('.claude/hooks/workflow-gate.cjs')],
    ['UserPromptSubmit hook', !!hooks.UserPromptSubmit],
    ['PreToolUse hook', !!hooks.PreToolUse],
    ['PostToolUse hook', !!hooks.PostToolUse],
    ['shared workflow policy', fileExists(POLICY_FILE)],
    ['sandbox disabled by default', !settings.sandbox],
    ['authority runtime permission deny', deny.includes('Read(.harness/.authority-runtime/**)')],
    ['state', !!loadWorkflowOrNull()],
    ['authority dir', fs.existsSync(abs('.harness/authority'))],
    ['python >=3.10', ['python', 'python3'].some(isUsablePython)],
    ['java', commandAvailable('java', ['-version'])],
    ['DPAA runtime', fileExists('.pi/dpaa/cli.py')],
    ['SBADR runtime', fileExists('.pi/sbadr/cli.py')],
    ['CoreNLP', isCoreNlpInstalled(abs(path.join(PI_ROOT, 'corenlp')))],
    ['interview artifact', hasInterviewArtifact()],
    ['plan artifact', hasPlanArtifact()],
  ];
  console.log(checks.map(([name, ok]) => `${ok ? 'PASS' : 'WARN'} ${name}`).join('\n'));
}

function createWorkflow(title) {
  const now = Date.now();
  return { id: `wf-${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`, title, phase: 'interview', cwd, gitRoot: gitRoot(), branch: gitBranch(), history: [], undone: [], startedAt: now, updatedAt: now };
}
function loadWorkflow() { return loadWorkflowOrNull() || createAndPersistDefault(); }
function loadWorkflowOrNull() {
  const state = readJson(STATE_FILE, null);
  const persisted = readJson(PERSISTED_FILE, null);
  const candidate = state && (state.phase || state.state) ? { ...(persisted || {}), ...state, history: state.history ?? persisted?.history, undone: state.undone ?? persisted?.undone } : persisted;
  if (!candidate) return null;
  if (state?.workflowId) candidate.id = state.workflowId;
  if (!candidate.id) candidate.id = candidate.workflowId || `wf-${Date.now()}`;
  if (!candidate.title) candidate.title = 'workflow';
  candidate.phase = normalizePhase(candidate.phase || candidate.state);
  candidate.cwd = candidate.cwd || cwd;
  candidate.gitRoot = candidate.gitRoot === undefined ? gitRoot() : candidate.gitRoot;
  candidate.branch = candidate.branch || gitBranch();
  candidate.history = Array.isArray(candidate.history) ? candidate.history : [];
  candidate.undone = Array.isArray(candidate.undone) ? candidate.undone : [];
  candidate.startedAt = candidate.startedAt || Date.now();
  candidate.updatedAt = candidate.updatedAt || Date.now();
  return candidate;
}
function createAndPersistDefault() { const wf = createWorkflow('workflow'); saveWorkflow(wf); return wf; }
function saveWorkflow(workflow) {
  writeJson(STATE_FILE, { state: workflow.phase, phase: workflow.phase, workflowId: workflow.id, title: workflow.title, gitRoot: workflow.gitRoot, branch: workflow.branch, history: workflow.history, undone: workflow.undone || [] });
  writeJson(PERSISTED_FILE, workflow);
}
function clearWorkflow() { fs.rmSync(abs(STATE_FILE), { force: true }); fs.rmSync(abs(PERSISTED_FILE), { force: true }); }
function normalizePhase(value) { const phase = String(value || 'interview').toLowerCase(); return WORKFLOW_PHASES.includes(phase) ? phase : 'interview'; }
function getNextPhase(phase) { const i = WORKFLOW_PHASES.indexOf(phase); return i >= 0 ? WORKFLOW_PHASES[i + 1] || null : null; }

function formatWorkflowStatus(workflow) {
  if (!workflow) return '⚪ Workflow 없음\n시작: node .claude/hooks/workflow-gate.cjs start <goal>';
  return [
    '🧭 Workflow 상태',
    `ID: ${workflow.id}`,
    `목표: ${workflow.title}`,
    `현재 단계: ${workflow.phase}`,
    `다음 단계: ${getNextPhase(workflow.phase) || '없음'}`,
    `Branch: ${workflow.branch}`,
  ].join('\n');
}
function formatWorkflowPrompt(workflow) {
  return [formatWorkflowStatus(workflow), '', formatHardRules(), formatContextStrategy(workflow.phase), phaseGuidance(workflow.phase), formatApprovalBoundaries()].filter(Boolean).join('\n');
}
function formatApprovalBoundaries() {
  const boundaries = Array.isArray(workflowPolicy.approvalBoundaries) ? workflowPolicy.approvalBoundaries : [];
  const rendered = boundaries.map((item) => item.replace(':', ' → ')).join(', ');
  return rendered ? `Approval boundaries: ${rendered}. Use /workflow:approve or explicit natural language approval.` : 'Approval boundaries: none.';
}
function formatHardRules() {
  const rules = workflowPolicy.reminderPolicy?.hardRules;
  return Array.isArray(rules) && rules.length > 0
    ? ['[WORKFLOW HARD RULES]', ...rules.filter(Boolean).map((rule) => `- ${rule}`), '[/WORKFLOW HARD RULES]'].join('\n')
    : '';
}
function formatContextStrategy(phase) {
  const strategy = workflowPolicy.contextStrategy?.[phase];
  if (!strategy || typeof strategy !== 'object') return '';
  const keeps = Array.isArray(strategy.mainKeeps) ? strategy.mainKeeps.filter(Boolean) : [];
  const avoids = Array.isArray(strategy.mainAvoids) ? strategy.mainAvoids.filter(Boolean) : [];
  const contract = Array.isArray(workflowPolicy.subagentHandoffContract) ? workflowPolicy.subagentHandoffContract.filter(Boolean) : [];
  return [
    `[CONTEXT STRATEGY: ${phase}]`,
    strategy.delegateTo ? `- Delegate: ${strategy.delegateTo}` : '',
    keeps.length > 0 ? `- Main keeps: ${keeps.join(', ')}` : '',
    avoids.length > 0 ? `- Main avoids: ${avoids.join(', ')}` : '',
    contract.length > 0 ? `- Subagent returns: ${contract.join(', ')}` : '',
    '[/CONTEXT STRATEGY]',
  ].filter(Boolean).join('\n');
}
function phaseGuidance(phase) {
  const shared = workflowPolicy.phaseGuidance?.[phase];
  if (shared) return `Deliverable: ${shared}`;
  return `Current phase: ${phase}`;
}
function isTransitionAllowedByPolicy(from, to) {
  const policy = workflowPolicy.transitionPolicy || {};
  if (policy.strictNextPhaseOnly || policy.forbidSkippedPhases) return getNextPhase(from) === to;
  return WORKFLOW_PHASES.includes(from) && WORKFLOW_PHASES.includes(to);
}
function isApprovalBoundary(phase) {
  const next = getNextPhase(phase);
  return Boolean(next && APPROVAL_BOUNDARIES.has(`${phase}:${next}`));
}
function hasWorkflowTransition(workflow, from, to) { return Array.isArray(workflow?.history) && workflow.history.some((item) => item.from === from && item.to === to); }
function isApprovalText(text) { return /^(응|네|예|ㅇㅇ|승인|진행|계속|좋아|go|yes|approved|approve|proceed)([\s.!。~]|$)/i.test(String(text || '').trim()); }

function approvedAllowedFiles() {
  const review = readJson(PLAN_REVIEW_FILE, {});
  return Array.isArray(review.approved_allowed_files) ? review.approved_allowed_files : [];
}
function isPlanReviewApproved() { const r = readJson(PLAN_REVIEW_FILE, {}); return r.status === 'approved' && Array.isArray(r.approved_allowed_files) && r.approved_allowed_files.length > 0; }
function isReviewPackageApproved() { const r = readJson(REVIEW_PACKAGE_FILE, {}); return r.status === 'approved' || r.status === 'passed'; }
function isPushApproved(policy) { const r = readJson(POLICY_APPROVAL_FILE, {}); if (r.status !== 'approved') return false; return !policy || policy.ok || r.signature === pushPolicySignature(policy); }
function hasInterviewArtifact() { return fileExists('.ai/interview/spec.md') || fileExists('.ai/interview/spec.ko.md') || fileExists('.harness/proposal/interview.md') || fileExists('.harness/proposal/interview.yaml'); }
function hasPlanArtifact() { return fileExists('.ai/interview/plan.md') || fileExists('.ai/interview/plan.ko.md') || latestPlanInDocs() || fileExists('.harness/proposal/plan.yaml'); }
function hasDocsEvidence() { return fileExists('.harness/proposal/docs-summary.md') || gitChangedFiles().some((f) => matchesAny(f, DOC_PATTERNS)); }
function hasChangedFiles() { return gitChangedFiles().length > 0; }
function hasImplementationChangedFiles() {
  const allowed = approvedAllowedFiles();
  return gitChangedFiles().some((file) => {
    if (matchesAny(file, [...PLAN_PATTERNS, ...INTERVIEW_PATTERNS, '.harness/proposal/**', '.harness/authority/**'])) return false;
    return allowed.length === 0 || matchesAny(file, allowed);
  });
}
function latestPlanInDocs() { const dir = abs('docs/superpowers/plans'); return fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.endsWith('.md')); }
function rawGitChangedFiles() {
  try {
    const tracked = childProcess.execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/);
    const untracked = childProcess.execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/);
    return [...tracked, ...untracked].map(normalizeRelPath).filter(Boolean).filter((f, i, all) => all.indexOf(f) === i);
  } catch { return []; }
}
function gitChangedFiles() { return rawGitChangedFiles().filter((f) => !isRuntimeArtifactPath(f)); }
function gitChangedFilesForPushPolicy() { return rawGitChangedFiles().filter((f) => !isVolatileRuntimePath(f)); }
function isRuntimeArtifactPath(rel) { return matchesAny(rel, ['.harness/state.json', '.harness/workflow.json', '.harness/authority/**', '.harness/.authority-runtime/**', '.harness/checkpoints/**', '.harness/dpaa-runs/**']); }
function isVolatileRuntimePath(rel) { return matchesAny(rel, ['.harness/state.json', '.harness/workflow.json', '.harness/.authority-runtime/**', '.harness/checkpoints/**', '.harness/dpaa-runs/**']); }
function gitRoot() { try { return childProcess.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } }
function gitBranch() { try { return childProcess.execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown'; } catch { return 'unknown'; } }
function validateWorkflowWorkspace(workflow) {
  const currentRoot = gitRoot();
  const currentBranch = gitBranch();
  const expectedRoot = workflow.gitRoot || currentRoot;
  const expectedBranch = workflow.branch || currentBranch;
  if (expectedRoot && currentRoot && normalizeFsPath(expectedRoot) !== normalizeFsPath(currentRoot)) return { ok: false, expectedRoot, currentRoot, expectedBranch, currentBranch, reason: 'git root mismatch' };
  if (expectedBranch && currentBranch && expectedBranch !== 'unknown' && currentBranch !== 'unknown' && expectedBranch !== currentBranch) return { ok: false, expectedRoot, currentRoot, expectedBranch, currentBranch, reason: 'branch mismatch' };
  return { ok: true, expectedRoot, currentRoot, expectedBranch, currentBranch };
}
function formatWorkspaceMismatch(result) { return `Blocked by workflow gate. Workspace mismatch before git push: ${result.reason}. Expected root=${result.expectedRoot || 'unknown'} branch=${result.expectedBranch || 'unknown'}; current root=${result.currentRoot || 'unknown'} branch=${result.currentBranch || 'unknown'}.`; }
function normalizeFsPath(value) { try { return fs.realpathSync.native(String(value)); } catch { return path.resolve(String(value)); } }

function runCodeQualityGate(workflow) {
  const root = workflow.gitRoot || gitRoot();
  const configured = (process.env.HARNESS_CODE_QUALITY_GUARD_CMD || '').trim();
  const hasGradle = root && (fileExistsAt(root, 'gradlew') || fileExistsAt(root, 'gradlew.bat') || fileExistsAt(root, 'build.gradle') || fileExistsAt(root, 'build.gradle.kts'));
  if (!configured && !hasGradle) return pass('Code quality guard skipped: no Gradle project detected.');
  const cmd = configured || (process.platform === 'win32' && fileExistsAt(root, 'gradlew.bat') ? 'gradlew.bat codeQualityGuard' : './gradlew codeQualityGuard');
  try {
    childProcess.execSync(cmd, { cwd: root || cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
    return pass(`Code quality guard satisfied: ${cmd}`);
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    writeFieldLogEvent(workflow, 'gate.failed', 'code-quality', `Code quality guard failed: ${cmd}`, output);
    return block([`Code quality guard failed before code_review → review_approved. Command: ${cmd}`, output.split(/\r?\n/).slice(-40).join('\n')].filter(Boolean).join('\n'));
  }
}

function runDpaaGate(workflow, from, to) {
  const planPath = findPlanForDpaa();
  if (!planPath) {
    writeFieldLogEvent(workflow, 'gate.failed', 'dpaa', 'No DPAA-readable plan file found.', 'Expected .ai/interview/plan.md or docs/superpowers/plans/*.md');
    return block('DPAA gate blocked: create .ai/interview/plan.md or docs/superpowers/plans/*.md before implementation.');
  }
  let python;
  try { python = ensureDpaaPythonCommand(); }
  catch (error) { writeFieldLogEvent(workflow, 'gate.failed', 'dpaa', 'DPAA Python environment preparation failed.', error.message); return block(`DPAA environment failed: ${error.message}`); }

  const reportPath = path.join(os.tmpdir(), `dpaa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  let exitCode = 0;
  try {
    childProcess.execFileSync(python, ['-m', 'dpaa.cli', planPath, '--output', reportPath, '--no-text'], { cwd: cwd, encoding: 'utf8', env: dpaaEnv(), stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
  } catch (error) { exitCode = typeof error.status === 'number' ? error.status : 1; }

  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (error) { writeFieldLogEvent(workflow, 'gate.failed', 'dpaa', 'DPAA report could not be read.', error.message); return block(`Failed to read DPAA report: ${error.message}`); }
  finally { fs.rmSync(reportPath, { force: true }); }

  writeDpaaReceipt(workflow, from, to, planPath, report, exitCode);
  if (report.level !== 'PASS') {
    const findings = (report.findings || []).slice(0, 5).map((f, i) => `${i + 1}. [${f.layer}/${f.rule}] ${f.message} -> ${f.suggestion}`).join('\n');
    writeFieldLogEvent(workflow, 'gate.failed', 'dpaa', `DPAA returned ${report.level}.`, findings);
    return block([`DPAA returned ${report.level} before plan_review → implement.`, findings].filter(Boolean).join('\n'));
  }
  return runSbadrGateIfAvailable(workflow, python, planPath);
}

function runSbadrGateIfAvailable(workflow, python, planPath) {
  const setup = abs(path.join(PI_ROOT, process.platform === 'win32' ? 'setup_corenlp.ps1' : 'setup_corenlp.sh'));
  const coreNlpDir = abs(path.join(PI_ROOT, 'corenlp'));
  if (!isCoreNlpInstalled(coreNlpDir) && fs.existsSync(setup)) {
    try {
      if (process.platform === 'win32') childProcess.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setup], { cwd, stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 });
      else childProcess.execFileSync('bash', [setup], { cwd, stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 });
    } catch (error) {
      return pass(`DPAA check passed (SBADR skipped: CoreNLP install failed: ${error.message})`);
    }
  }
  if (!canImport(python, 'sbadr.cli')) {
    try { installDpaaIntoVenv(python); } catch { return pass('DPAA check passed (SBADR skipped: sbadr import unavailable)'); }
  }
  const reportPath = path.join(os.tmpdir(), `sbadr-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    childProcess.execFileSync(python, ['-m', 'sbadr.cli', 'analyze', planPath, '--output', reportPath, '--no-text'], { cwd, encoding: 'utf8', env: dpaaEnv(), stdio: 'pipe', maxBuffer: 20 * 1024 * 1024 });
  } catch { /* SBADR may return non-zero but still write report. */ }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.verdict === 'FAIL') {
      const findings = (report.findings || []).slice(0, 5).map((f, i) => `${i + 1}. [${f.type}] ${f.detail} -> ${f.suggestion}`).join('\n');
      writeFieldLogEvent(workflow, 'gate.failed', 'dpaa', 'SBADR detected critical syntactic ambiguity.', findings);
      return block([`SBADR returned FAIL before implementation (score=${Number(report.score || 0).toFixed(3)}).`, findings].filter(Boolean).join('\n'));
    }
    return pass(report.verdict === 'WARN' ? `DPAA passed; SBADR WARN score=${Number(report.score || 0).toFixed(3)}.` : 'DPAA + SBADR check passed.');
  } catch (error) {
    return pass(`DPAA check passed (SBADR skipped: ${error.message})`);
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
}

function ensureDpaaPythonCommand() {
  if (!fs.existsSync(abs(PI_ROOT))) throw new Error('.pi runtime not installed; install workflow component or include .pi/dpaa for DPAA.');
  const venvPython = process.platform === 'win32' ? abs(path.join(PI_ROOT, '.venv', 'Scripts', 'python.exe')) : abs(path.join(PI_ROOT, '.venv', 'bin', 'python'));
  if (fs.existsSync(venvPython) && isUsablePython(venvPython)) {
    if (!canImport(venvPython, 'dpaa.cli')) installDpaaIntoVenv(venvPython);
    return venvPython;
  }
  const base = ['python', 'python3'].find(isUsablePython);
  if (!base) throw new Error('Python >= 3.10 not found.');
  fs.mkdirSync(abs(PI_ROOT), { recursive: true });
  childProcess.execFileSync(base, ['-m', 'venv', abs(path.join(PI_ROOT, '.venv'))], { cwd, stdio: 'pipe' });
  installDpaaIntoVenv(venvPython);
  return venvPython;
}

function installDpaaIntoVenv(python) { childProcess.execFileSync(python, ['-m', 'pip', 'install', '-e', abs(PI_ROOT)], { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 20 * 1024 * 1024 }); }
function isUsablePython(cmd) { try { childProcess.execFileSync(cmd, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)'], { stdio: 'pipe' }); return true; } catch { return false; } }
function canImport(python, mod) { try { childProcess.execFileSync(python, ['-c', `import ${mod}`], { cwd, env: dpaaEnv(), stdio: 'pipe' }); return true; } catch { return false; } }
function dpaaEnv() { return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: process.env.PYTHONPATH ? `${abs(PI_ROOT)}${path.delimiter}${process.env.PYTHONPATH}` : abs(PI_ROOT) }; }
function isCoreNlpInstalled(dir) { return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith('stanford-corenlp-') && f.endsWith('.jar') && !f.includes('javadoc') && !f.includes('sources') && !f.includes('models')); }
function findPlanForDpaa() { if (fileExists('.ai/interview/plan.md')) return abs('.ai/interview/plan.md'); if (fileExists('docs/superpowers/plans/plan.md')) return abs('docs/superpowers/plans/plan.md'); const dir = abs('docs/superpowers/plans'); if (!fs.existsSync(dir)) return null; return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null; }
function writeDpaaReceipt(workflow, from, to, planPath, report, exitCode) { const receipt = { timestamp: new Date().toISOString(), workflowId: workflow.id, from, to, projectRoot: cwd, planPath, planSha256: sha256File(planPath), exitCode, level: report.level, overall: report.overall, findingsCount: (report.findings || []).length }; const dir = abs(DPAA_RECEIPT_DIR); fs.mkdirSync(dir, { recursive: true }); writeJson(path.join(DPAA_RECEIPT_DIR, `${Date.now()}-${String(report.level || 'unknown').toLowerCase()}.json`), receipt); }
function printDpaaAudit() { const dir = abs(DPAA_RECEIPT_DIR); if (!fs.existsSync(dir)) return console.log('No DPAA run receipts.'); const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); if (!files.length) return console.log('No DPAA run receipts.'); console.log(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')); }

function scanPushPolicy() {
  const changed = gitChangedFilesForPushPolicy();
  const findings = [];
  for (const file of changed) {
    if (matchesAny(file, ['.claude/**', '.harness/**', '.pi/extensions/**', 'target/.pi/extensions/**'])) findings.push({ file, category: 'harness-policy' });
    if (matchesAny(file, ['**/.env', '**/.env.*', '**/*secret*', '**/*credential*'])) findings.push({ file, category: 'secret-risk' });
  }
  return { ok: findings.length === 0, totalChanged: changed.length, changed, findings, signature: '' };
}
function pushPolicySignature(scan) { return crypto.createHash('sha256').update(JSON.stringify({ changed: scan.changed || [], findings: scan.findings || [] })).digest('hex'); }
function formatPushPolicyBlocked(scan) { const sig = pushPolicySignature(scan); writeFieldLogEvent(loadWorkflowOrNull(), 'policy.blocked', 'push-policy', 'Push policy scan blocked risky changes.', JSON.stringify(scan.findings)); return ['Push policy scan blocked commit → push.', ...scan.findings.map((f) => `- [${f.category}] ${f.file}`), `Approve risk in ${POLICY_APPROVAL_FILE} with signature ${sig} or reduce changes.`].join('\n'); }

function createManualCheckpoint(reason) { const workflow = loadWorkflow(); saveWorkflow(workflow); const dir = createWorkspaceCheckpoint(workflow, reason); console.log(dir ? `Workspace checkpoint created: ${path.basename(dir)}` : 'No git workspace available for checkpoint.'); }
function checkpointRoot(workflow) { return abs(path.join('.harness', 'checkpoints', workflow.id)); }
function createWorkspaceCheckpoint(workflow, reason) {
  const root = workflow.gitRoot || gitRoot(); if (!root) return null;
  const id = `${Date.now()}-${slugify(reason)}`; const dir = path.join(checkpointRoot(workflow), id); fs.mkdirSync(dir, { recursive: true });
  const max = 100 * 1024 * 1024;
  fs.writeFileSync(path.join(dir, 'staged.patch'), childProcess.execFileSync('git', ['-C', root, 'diff', '--binary', '--cached'], { maxBuffer: max }));
  fs.writeFileSync(path.join(dir, 'unstaged.patch'), childProcess.execFileSync('git', ['-C', root, 'diff', '--binary'], { maxBuffer: max }));
  const untracked = childProcess.execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: max }).split('\0').filter(Boolean).filter((rel) => !normalizeRelPath(rel).startsWith('.harness/checkpoints/'));
  for (const rel of untracked) { const src = path.join(root, rel); if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue; const dst = path.join(dir, 'untracked', rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ workflowId: workflow.id, reason, createdAt: new Date().toISOString(), gitRoot: root, untracked }, null, 2));
  return dir;
}
function printCheckpoints() { const workflow = loadWorkflowOrNull(); if (!workflow) return console.log('No active workflow.'); const root = checkpointRoot(workflow); if (!fs.existsSync(root)) return console.log('No workspace checkpoints.'); console.log(fs.readdirSync(root).sort().join('\n') || 'No workspace checkpoints.'); }
function restoreCheckpoint(prefix) { const workflow = loadWorkflow(); const root = checkpointRoot(workflow); if (!prefix || !fs.existsSync(root)) return deny('Checkpoint not found.'); const name = fs.readdirSync(root).find((n) => n.startsWith(prefix)); if (!name) return deny('Checkpoint not found.'); console.log(restoreWorkspaceCheckpoint(path.join(root, name))); }
function restoreWorkspaceCheckpoint(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const root = meta.gitRoot;
  const stagedPatch = readPatchBeforeClean(path.join(dir, 'staged.patch'));
  const unstagedPatch = readPatchBeforeClean(path.join(dir, 'unstaged.patch'));
  const untrackedCopies = [];
  for (const rel of meta.untracked || []) {
    const src = path.join(dir, 'untracked', rel);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) untrackedCopies.push([rel, fs.readFileSync(src)]);
  }
  childProcess.execFileSync('git', ['-C', root, 'reset', '--hard', 'HEAD'], { stdio: 'pipe' });
  childProcess.execFileSync('git', ['-C', root, 'clean', '-fd'], { stdio: 'pipe' });
  applyPatchBuffer(root, stagedPatch, true);
  applyPatchBuffer(root, unstagedPatch, false);
  for (const [rel, data] of untrackedCopies) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
  }
  return `Workspace files restored from checkpoint: ${path.basename(dir)}`;
}
function readPatchBeforeClean(p) { return fs.existsSync(p) && fs.statSync(p).size > 0 ? fs.readFileSync(p) : null; }
function applyPatchBuffer(root, buffer, index) { if (!buffer || buffer.length === 0) return; const tmp = path.join(os.tmpdir(), `workflow-restore-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`); fs.writeFileSync(tmp, buffer); try { childProcess.execFileSync('git', ['-C', root, 'apply', ...(index ? ['--index'] : []), tmp], { stdio: 'pipe' }); } finally { fs.rmSync(tmp, { force: true }); } }

function issueTransitionTokens(workflow, from, to, reason, event) {
  if (from === 'plan_review' && to === 'implement') issueSessionToken('dpaa', workflow.id, reason, event);
  if (from === 'code_review' && to === 'review_approved') {
    issueSessionToken('code_quality', workflow.id, reason, event);
    issueSessionToken('code_review', workflow.id, reason, event);
  }
  if (from === 'commit' && to === 'push') issueSessionToken('push_execution', workflow.id, reason, event);
}
function sessionAuthorityPath(event) {
  const sessionId = sanitizeSessionId(event?.session_id || process.env.CLAUDE_SESSION_ID || 'manual');
  const project = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
  return path.join(abs(SESSION_AUTHORITY_DIR), project, `${sessionId}.json`);
}
function sanitizeSessionId(value) { return String(value || 'manual').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'manual'; }
function readSessionAuthority(event) { return readJson(path.relative(cwd, sessionAuthorityPath(event)), { session_id: sanitizeSessionId(event?.session_id || process.env.CLAUDE_SESSION_ID || 'manual'), tokens: {} }); }
function writeSessionAuthority(event, data) { const file = sessionAuthorityPath(event); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
function issueSessionToken(name, workflowId, reason, event) {
  const authority = readSessionAuthority(event);
  authority.workflow_id = workflowId;
  authority.updated_at = new Date().toISOString();
  authority.tokens = authority.tokens || {};
  authority.tokens[name] = { workflow_id: workflowId, issued_at: Date.now(), reason };
  writeSessionAuthority(event, authority);
}
function issueSkipToken(gate, workflowId, reason, event) {
  const authority = readSessionAuthority(event);
  authority.workflow_id = workflowId;
  authority.updated_at = new Date().toISOString();
  authority.skip_tokens = authority.skip_tokens || [];
  authority.skip_tokens.push({ gate, workflow_id: workflowId, reason, issued_at: Date.now(), expires_at: Date.now() + 10 * 60_000, consumed: false });
  writeSessionAuthority(event, authority);
}
function consumeSkipToken(gate, workflowId, event) {
  const authority = readSessionAuthority(event);
  const now = Date.now();
  const token = (authority.skip_tokens || []).find((t) => t.gate === gate && t.workflow_id === workflowId && !t.consumed && t.expires_at > now);
  if (!token) return null;
  token.consumed = true;
  token.consumed_at = now;
  writeSessionAuthority(event, authority);
  return token;
}
function hasSessionToken(name, workflowId, event) {
  const authority = readSessionAuthority(event);
  const token = authority.tokens?.[name];
  if (token?.workflow_id === workflowId) return true;
  // CLI slash-command execution may not receive hook stdin; accept the manual bucket as a fallback.
  if ((event?.session_id || process.env.CLAUDE_SESSION_ID) !== undefined) {
    const manual = readSessionAuthority({ session_id: 'manual' });
    return manual.tokens?.[name]?.workflow_id === workflowId;
  }
  return false;
}
function clearSessionAuthority() { fs.rmSync(abs(SESSION_AUTHORITY_DIR), { recursive: true, force: true }); }
function writeFieldLogEvent(workflow, type, category, summary, detail) { const event = { timestamp: new Date().toISOString(), type, category, workflowId: workflow?.id || null, phase: workflow?.phase || null, summary, detail: detail ? String(detail).slice(0, 8000) : undefined }; fs.mkdirSync(abs(HARNESS_MEMORY_DIR), { recursive: true }); fs.appendFileSync(abs(FIELD_LOG_FILE), JSON.stringify(event) + '\n', 'utf8'); }
function commandAvailable(cmd, args = ['--version']) { try { childProcess.execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } }
function fileExistsAt(root, rel) { return !!root && fs.existsSync(path.join(root, rel)); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function slugify(value) { return String(value || 'snapshot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot'; }
function pass(message = '') { return { ok: true, message }; }
function block(message) { return { ok: false, message }; }
function readJson(rel, fallback) { try { const p = abs(rel); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; } catch { return fallback; } }
function writeJson(rel, data) { const p = abs(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
function fileExists(rel) { return fs.existsSync(abs(rel)); }
function abs(rel) { return path.join(cwd, rel); }
function matchesAny(file, patterns) { return (patterns || []).filter(Boolean).some((pattern) => globMatch(file, pattern)); }
function globMatch(file, pattern) { const f = normalizeRelPath(file); const p = normalizeRelPath(pattern); if (!p) return false; if (p === f) return true; const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DS::').replace(/\*/g, '[^/]*').replace(/::DS::/g, '.*'); return new RegExp(`^${escaped}$`).test(f); }
function normalizeRelPath(value) { let p = String(value || '').replace(/\\/g, '/'); if (!p) return ''; if (path.isAbsolute(p)) p = path.relative(cwd, p).replace(/\\/g, '/'); return p.replace(/^\.\//, ''); }
function allow() { process.exit(0); }
function deny(reason) { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })); process.exit(0); }
