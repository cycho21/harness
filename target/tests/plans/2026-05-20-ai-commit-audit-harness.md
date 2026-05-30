# AI 커밋 감사 하네스 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 개의 독립 PI 세션(개발/감사)이 커밋 단위로 협업할 수 있도록 git ref 기반 감사 추적 + audit-input.md 생성 하네스를 구축한다.

**Architecture:** Node.js ESM CLI. `scripts/ai-audit/cli.mjs`가 진입점. 모듈별 단일 책임 (git/fs/templates/verdict). `.ai/` 디렉토리가 감사 상태와 컨텍스트를 보관. `refs/ai/reviewer/last-reviewed` git ref가 감사 기준점.

**Tech Stack:** Node.js >= 18 (ESM), child_process.execFileSync, no external dependencies

**Spec:** `docs/superpowers/specs/2026-05-20-ai-commit-audit-harness.md`

---

## File Map

| 파일 | 역할 | 작업 |
|------|------|------|
| `scripts/ai-audit/fs-utils.mjs` | 파일시스템 유틸 (mkdir, read, write, timestamp, slugify) | 신규 생성 |
| `scripts/ai-audit/git.mjs` | git 유틸 + last-reviewed ref 관리 | 신규 생성 |
| `scripts/ai-audit/templates.mjs` | 기본 마크다운 템플릿 (spec, auditor-persona) | 신규 생성 |
| `scripts/ai-audit/verdict.mjs` | 감사 판정 파서 (OK / Needs correction / Stop and re-plan) | 신규 생성 |
| `scripts/ai-audit/cli.mjs` | CLI 진입점 (init/status/input/run/save-review/mark-reviewed/reset-reviewed) | 신규 생성 |
| `.gitignore` | `.ai/runs/`, `.ai/reviews/`, `.ai/audit-input.md` 제외 여부 확인 | 수정 |

---

## Task 1: fs-utils.mjs

**Files:**
- Create: `scripts/ai-audit/fs-utils.mjs`

- [ ] **Step 1: 파일 생성**

`scripts/ai-audit/fs-utils.mjs`:
```js
import fs from 'fs';
import path from 'path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }
  return false;
}

export function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
}

export function listFilesSorted(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .sort();
}

export function getTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
```

- [ ] **Step 2: 동작 확인**

```bash
node -e "
import('./scripts/ai-audit/fs-utils.mjs').then(m => {
  console.log(m.getTimestamp());
  console.log(m.slugify('npm test --verbose'));
});
"
```

Expected:
```
2026-05-20-143022
npm-test-verbose
```

- [ ] **Step 3: 커밋**

```bash
git add scripts/ai-audit/fs-utils.mjs
git commit -m "feat(ai-audit): fs-utils.mjs — 파일시스템 유틸 구현"
```

---

## Task 2: git.mjs

**Files:**
- Create: `scripts/ai-audit/git.mjs`

- [ ] **Step 1: 파일 생성**

`scripts/ai-audit/git.mjs`:
```js
import { execFileSync } from 'child_process';

export const LAST_REVIEWED_REF = 'refs/ai/reviewer/last-reviewed';

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch (e) {
    const msg = e.stderr?.trim() || e.message;
    throw new Error(`git ${args[0]} failed: ${msg}`);
  }
}

export function isGitRepo() {
  try { git(['rev-parse', '--git-dir']); return true; } catch { return false; }
}

export function revParse(ref) {
  return git(['rev-parse', '--verify', ref]);
}

export function hasRef(ref) {
  try { revParse(ref); return true; } catch { return false; }
}

export function getHead() {
  return revParse('HEAD');
}

export function getLastReviewedRef() {
  return hasRef(LAST_REVIEWED_REF) ? revParse(LAST_REVIEWED_REF) : null;
}

export function setLastReviewedRef(commit) {
  git(['update-ref', LAST_REVIEWED_REF, commit]);
}

export function getDefaultBase() {
  for (const branch of ['main', 'master']) {
    if (hasRef(branch)) {
      try { return git(['merge-base', 'HEAD', branch]); } catch { /* continue */ }
    }
  }
  try { return revParse('HEAD~1'); } catch { return getHead(); }
}

export function getAuditBase() {
  const last = getLastReviewedRef();
  return last ?? getDefaultBase();
}

export function getAuditRange() {
  const base = getAuditBase();
  const head = getHead();
  return { base, head, range: `${base}..HEAD` };
}

export function getGitLog(base, head) {
  return git(['log', '--oneline', `${base}..${head}`]);
}

export function getDiffStat(base, head) {
  return git(['diff', '--stat', `${base}..${head}`]);
}

export function getChangedFiles(base, head) {
  return git(['diff', '--name-only', `${base}..${head}`]);
}

export function getDiff(base, head) {
  return git(['diff', `${base}..${head}`]);
}

export function getStatusShort() {
  return git(['status', '--short']);
}

export function getPendingCommitCount(base, head) {
  const out = git(['rev-list', '--count', `${base}..${head}`]);
  return parseInt(out, 10) || 0;
}
```

- [ ] **Step 2: 동작 확인**

```bash
node -e "
import('./scripts/ai-audit/git.mjs').then(m => {
  console.log('isGitRepo:', m.isGitRepo());
  console.log('HEAD:', m.getHead().slice(0,8));
  console.log('auditBase:', m.getAuditBase().slice(0,8));
});
"
```

Expected: `isGitRepo: true`, HEAD와 auditBase 해시 출력

- [ ] **Step 3: 커밋**

```bash
git add scripts/ai-audit/git.mjs
git commit -m "feat(ai-audit): git.mjs — git 유틸 + last-reviewed ref 관리 구현"
```

---

## Task 3: templates.mjs + verdict.mjs

**Files:**
- Create: `scripts/ai-audit/templates.mjs`
- Create: `scripts/ai-audit/verdict.mjs`

- [ ] **Step 1: templates.mjs 생성**

`scripts/ai-audit/templates.mjs`:
```js
export const DEFAULT_SPEC = `# Task Spec

## Goal

Describe the exact task the Primary Session must complete.

## Must preserve

- Existing public behavior unless explicitly changed
- Existing CLI flags and output format
- Existing tests unless intentionally updated
- No unrelated refactors
- No unrelated formatting-only changes
- No debug metadata in final user-facing output
- No unsupported completion claims

## Success criteria

- The requested behavior is implemented
- Required verification commands pass
- Relevant sample output or test output is saved under \`.ai/runs/\`
- The diff is scoped to the task

## Out of scope

- Broad refactors
- Unrequested design changes
- Unrelated docs or template rewrites
- New features not required by this task
`;

export const DEFAULT_AUDITOR_PERSONA = `# AI Commit Auditor Persona

## Role

You are an independent AI audit session.

You are not the builder. You are not the implementer. You are not a pair programmer.
You are not here to improve the design unless the current work violates the task spec.

Your role is to audit whether the Primary Session stayed faithful to the original task,
respected constraints, provided sufficient verification evidence, and avoided unjustified scope expansion.

You are a commit-range auditor.

## Core Mission

Audit the changes from the last approved commit to the current HEAD.

1. Did the Primary Session solve the intended task?
2. Did it preserve the required constraints?
3. Did it change anything out of scope?
4. Did it provide real verification evidence?
5. Did it make claims not supported by code, diff, logs, tests, or outputs?
6. Should the reviewed range be marked as approved?

## Strict Non-Goals

Do not implement code. Do not rewrite files. Do not propose broad architecture changes.
Do not suggest style improvements unless they affect correctness or scope.
Do not expand the task. Do not move refs/ai/reviewer/last-reviewed.

## Verdict Rules

### OK
Use only when: spec satisfied, no P0/P1 issues, verification evidence exists, scope controlled.

### Needs correction
Use when: direction is mostly right, one or more P1 issues remain.
The last-reviewed pointer must NOT move.

### Stop and re-plan
Use when: wrong problem being solved, implementation direction fundamentally flawed.

## Output Format

Return exactly one audit report in this format:

\`\`\`
# Audit Report

## Review Range
Base: \`<hash>\`
Head: \`<hash>\`

## Verdict
\`OK\` | \`Needs correction\` | \`Stop and re-plan\`

## Task Restatement
## Scope Assessment
## Constraint Audit
## Critical Issues (P0 / P1)
## Non-Blocking Notes (P2)
## Verification Evidence
## Fix Contract
\`\`\`

## Tone

Be concise. Be strict. Be evidence-based.
Do not be encouraging. Do not praise unless necessary to explain OK verdict.
Your job is to protect the task spec, not the Primary Session's ego.
`;
```

- [ ] **Step 2: verdict.mjs 생성**

`scripts/ai-audit/verdict.mjs`:
```js
const VALID_VERDICTS = ['OK', 'Needs correction', 'Stop and re-plan'];

export function parseVerdict(markdown) {
  const match = markdown.match(/##\s*Verdict\s*\n+`?([^\n`]+)`?/);
  if (!match) return null;
  const candidate = match[1].trim();
  return VALID_VERDICTS.includes(candidate) ? candidate : null;
}

export function isOkVerdict(markdown) {
  return parseVerdict(markdown) === 'OK';
}

export function verdictSlug(verdict) {
  if (!verdict) return 'unknown-verdict';
  return verdict.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '');
}
```

- [ ] **Step 3: verdict 파서 확인**

```bash
node -e "
import('./scripts/ai-audit/verdict.mjs').then(m => {
  const ok = '## Verdict\n\n\`OK\`';
  const nc = '## Verdict\n\nNeeds correction';
  const bad = '## Verdict\n\nSomething else';
  console.log(m.parseVerdict(ok));       // OK
  console.log(m.parseVerdict(nc));       // Needs correction
  console.log(m.parseVerdict(bad));      // null
  console.log(m.verdictSlug('OK'));      // ok
  console.log(m.verdictSlug(null));      // unknown-verdict
});
"
```

- [ ] **Step 4: 커밋**

```bash
git add scripts/ai-audit/templates.mjs scripts/ai-audit/verdict.mjs
git commit -m "feat(ai-audit): templates.mjs + verdict.mjs — 기본 템플릿 및 판정 파서 구현"
```

---

## Task 4: cli.mjs — init + status

**Files:**
- Create: `scripts/ai-audit/cli.mjs`

- [ ] **Step 1: cli.mjs 생성 (init + status)**

`scripts/ai-audit/cli.mjs`:
```js
#!/usr/bin/env node
import path from 'path';
import { execFileSync } from 'child_process';
import {
  ensureDir, writeFileIfMissing, readFileIfExists,
  listFilesSorted, getTimestamp, slugify,
} from './fs-utils.mjs';
import {
  isGitRepo, getHead, getLastReviewedRef, setLastReviewedRef,
  getAuditBase, getAuditRange, getGitLog, getDiffStat,
  getChangedFiles, getDiff, getStatusShort, getPendingCommitCount, revParse,
} from './git.mjs';
import { DEFAULT_SPEC, DEFAULT_AUDITOR_PERSONA } from './templates.mjs';
import { parseVerdict, isOkVerdict, verdictSlug } from './verdict.mjs';

function getRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
}

function aiDir() { return path.join(getRoot(), '.ai'); }

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'init':     await cmdInit(); break;
  case 'status':   await cmdStatus(); break;
  case 'input':    await cmdInput(args); break;
  case 'run':      await cmdRun(args); break;
  case 'save-review': await cmdSaveReview(); break;
  case 'mark-reviewed': await cmdMarkReviewed(args); break;
  case 'reset-reviewed': await cmdResetReviewed(args); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: node scripts/ai-audit/cli.mjs <init|status|input|run|save-review|mark-reviewed|reset-reviewed>');
    process.exit(1);
}

async function cmdInit() {
  if (!isGitRepo()) { console.error('Not a git repository.'); process.exit(1); }
  const ai = aiDir();
  ensureDir(ai);
  ensureDir(path.join(ai, 'runs'));
  ensureDir(path.join(ai, 'reviews'));
  const specCreated = writeFileIfMissing(path.join(ai, 'spec.md'), DEFAULT_SPEC);
  const personaCreated = writeFileIfMissing(path.join(ai, 'auditor-persona.md'), DEFAULT_AUDITOR_PERSONA);
  console.log('AI audit harness initialized.');
  console.log(`  .ai/spec.md            ${specCreated ? 'created' : 'already exists'}`);
  console.log(`  .ai/auditor-persona.md ${personaCreated ? 'created' : 'already exists'}`);
  console.log(`  .ai/runs/              ready`);
  console.log(`  .ai/reviews/           ready`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Edit .ai/spec.md with your current task definition');
  console.log('  2. node scripts/ai-audit/cli.mjs reset-reviewed HEAD');
}

async function cmdStatus() {
  if (!isGitRepo()) { console.error('Not a git repository.'); process.exit(1); }
  const head = getHead();
  const lastReviewed = getLastReviewedRef();
  const base = getAuditBase();
  const pending = getPendingCommitCount(base, head);
  const changedFiles = getChangedFiles(base, head).split('\n').filter(Boolean);
  const ai = aiDir();

  const reviews = listFilesSorted(path.join(ai, 'reviews'));
  const latestReview = reviews.at(-1);
  let latestVerdict = null;
  if (latestReview) {
    const content = readFileIfExists(path.join(ai, 'reviews', latestReview));
    latestVerdict = content ? parseVerdict(content) : null;
  }

  const runs = listFilesSorted(path.join(ai, 'runs'));

  console.log('AI Audit Status');
  console.log('');
  console.log(`Git repo:              yes`);
  console.log(`HEAD:                  ${head.slice(0, 12)}`);
  console.log(`Last reviewed:         ${lastReviewed ? lastReviewed.slice(0, 12) : '(not set)'}`);
  console.log(`Audit range:           ${base.slice(0, 12)}..HEAD`);
  console.log(`Commits pending audit: ${pending}`);
  console.log('');
  console.log('Changed files pending audit:');
  if (changedFiles.length === 0) {
    console.log('  (none)');
  } else {
    changedFiles.forEach(f => console.log(`  - ${f}`));
  }
  console.log('');
  console.log('Latest audit review:');
  console.log(`  path:    ${latestReview ?? '(none)'}`);
  console.log(`  verdict: ${latestVerdict ?? '(none)'}`);
  console.log('');
  console.log('Run logs:');
  console.log(`  count:  ${runs.length}`);
  console.log(`  latest: ${runs.at(-1) ?? '(none)'}`);
}
```

- [ ] **Step 2: init 실행 확인**

```bash
node scripts/ai-audit/cli.mjs init
```

Expected:
```
AI audit harness initialized.
  .ai/spec.md            created
  .ai/auditor-persona.md created
  .ai/runs/              ready
  .ai/reviews/           ready

Next steps:
  1. Edit .ai/spec.md with your current task definition
  2. node scripts/ai-audit/cli.mjs reset-reviewed HEAD
```

- [ ] **Step 3: status 실행 확인**

```bash
node scripts/ai-audit/cli.mjs status
```

Expected: HEAD, last-reviewed, 감사 범위, 변경 파일 목록 출력

- [ ] **Step 4: 커밋**

```bash
git add scripts/ai-audit/cli.mjs
git commit -m "feat(ai-audit): cli.mjs — init + status 커맨드 구현"
```

---

## Task 5: cli.mjs — input

**Files:**
- Modify: `scripts/ai-audit/cli.mjs`

- [ ] **Step 1: cmdInput 함수 추가**

`cmdInput` 함수를 cli.mjs 하단에 추가:

```js
async function cmdInput(args) {
  if (!isGitRepo()) { console.error('Not a git repository.'); process.exit(1); }

  let customBase = null;
  let outFile = path.join(aiDir(), 'audit-input.md');
  let runsLimit = 10;
  let reviewsLimit = 3;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i+1]) customBase = args[++i];
    else if (args[i] === '--out' && args[i+1]) outFile = args[++i];
    else if (args[i] === '--runs' && args[i+1]) runsLimit = parseInt(args[++i], 10);
    else if (args[i] === '--reviews' && args[i+1]) reviewsLimit = parseInt(args[++i], 10);
  }

  const ai = aiDir();
  const base = customBase ?? getAuditBase();
  const head = getHead();

  const persona = readFileIfExists(path.join(ai, 'auditor-persona.md')) ?? '(auditor-persona.md not found — run init)';
  const spec = readFileIfExists(path.join(ai, 'spec.md')) ?? '(spec.md not found — run init)';
  const gitStatus = getStatusShort();
  const gitLog = getGitLog(base, head);
  const diffStat = getDiffStat(base, head);
  const changedFiles = getChangedFiles(base, head);
  const diff = getDiff(base, head);

  const runFiles = listFilesSorted(path.join(ai, 'runs')).slice(-runsLimit);
  const runsContent = runFiles.length === 0
    ? '(none)'
    : runFiles.map(f => {
        const content = readFileIfExists(path.join(ai, 'runs', f)) ?? '';
        return `### ${f}\n\n${content}`;
      }).join('\n\n---\n\n');

  const reviewFiles = listFilesSorted(path.join(ai, 'reviews')).slice(-reviewsLimit);
  const reviewsContent = reviewFiles.length === 0
    ? '(none)'
    : reviewFiles.map(f => {
        const content = readFileIfExists(path.join(ai, 'reviews', f)) ?? '';
        return `### ${f}\n\n${content}`;
      }).join('\n\n---\n\n');

  const output = `# Audit Session Input

## Auditor Bootstrap

You are an independent AI audit session.

You are not the implementer.
You must not edit files.
You must not provide patches.
You must audit only the provided commit range.
Return exactly one audit report using the required format.

---

## Auditor Persona

${persona}

---

## Task Spec

${spec}

---

## Review Range

Base: ${base}
Head: ${head}
Range: ${base}..HEAD

---

## Git Status

\`\`\`
${gitStatus || '(clean)'}
\`\`\`

---

## Git Log

\`\`\`
${gitLog || '(no commits in range)'}
\`\`\`

---

## Diff Stat

\`\`\`
${diffStat || '(no changes)'}
\`\`\`

---

## Changed Files

\`\`\`
${changedFiles || '(none)'}
\`\`\`

---

## Diff

\`\`\`diff
${diff || '(no diff)'}
\`\`\`

---

## Recent Run Outputs

${runsContent}

---

## Recent Previous Reviews

${reviewsContent}

---

# Final Instruction

Produce the audit report only.

Do not edit files.
Do not provide implementation patches.
Do not move \`refs/ai/reviewer/last-reviewed\`.
If verdict is not \`OK\`, explicitly state that the pointer must not move.
`;

  writeFile(outFile, output);
  console.log(`Audit input written: ${outFile}`);
  console.log(`Range: ${base.slice(0,8)}..${head.slice(0,8)}`);
}
```

- [ ] **Step 2: input 실행 확인**

```bash
node scripts/ai-audit/cli.mjs input
```

Expected:
```
Audit input written: .ai/audit-input.md
Range: xxxxxxxx..yyyyyyyy
```

- [ ] **Step 3: 생성된 파일 구조 확인**

```bash
node -e "const fs=require('fs'); const c=fs.readFileSync('.ai/audit-input.md','utf-8'); const sections=['Auditor Bootstrap','Auditor Persona','Task Spec','Review Range','Git Status','Git Log','Diff Stat','Changed Files','Diff','Recent Run Outputs','Recent Previous Reviews','Final Instruction']; sections.forEach(s => console.log(s+':', c.includes('## '+s) ? 'OK' : 'MISSING'));"
```

Expected: 모든 섹션 `OK`

- [ ] **Step 4: 커밋**

```bash
git add scripts/ai-audit/cli.mjs
git commit -m "feat(ai-audit): cli.mjs — input 커맨드 구현"
```

---

## Task 6: cli.mjs — run

**Files:**
- Modify: `scripts/ai-audit/cli.mjs`

- [ ] **Step 1: cmdRun 함수 추가**

```js
async function cmdRun(args) {
  const dashDash = args.indexOf('--');
  const cmd = dashDash >= 0 ? args.slice(dashDash + 1) : args;
  if (cmd.length === 0) { console.error('Usage: run -- <command> [args...]'); process.exit(1); }

  const timestamp = getTimestamp();
  const slug = slugify(cmd.join(' '));
  const filename = `${timestamp}-${slug}.txt`;
  const outPath = path.join(aiDir(), 'runs', filename);
  ensureDir(path.join(aiDir(), 'runs'));

  const started = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execFileSync(cmd[0], cmd.slice(1), {
      encoding: 'utf-8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (e) {
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    exitCode = e.status ?? 1;
  }

  const log = `# Command Run

Command:
${cmd.join(' ')}

Started:
${started}

Exit Code:
${exitCode}

## STDOUT

${stdout || '(empty)'}

## STDERR

${stderr || '(empty)'}
`;

  writeFile(outPath, log);
  console.log(`Run log saved: ${outPath}`);

  if (exitCode !== 0) process.exit(exitCode);
}
```

- [ ] **Step 2: run 커맨드 확인**

```bash
node scripts/ai-audit/cli.mjs run -- node --version
```

Expected: `.ai/runs/` 에 로그 파일 생성, 파일에 Node.js 버전 포함

```bash
ls .ai/runs/
```

Expected: `2026-05-20-HHMMSS-node-version.txt`

- [ ] **Step 3: 실패 명령도 로그 저장 확인**

```bash
node scripts/ai-audit/cli.mjs run -- node -e "process.exit(42)"; echo "exit: $?"
```

Expected: 로그 파일 존재, exit code 42

- [ ] **Step 4: 커밋**

```bash
git add scripts/ai-audit/cli.mjs
git commit -m "feat(ai-audit): cli.mjs — run 커맨드 구현"
```

---

## Task 7: cli.mjs — save-review + mark-reviewed + reset-reviewed

**Files:**
- Modify: `scripts/ai-audit/cli.mjs`

- [ ] **Step 1: 나머지 커맨드 함수 추가**

```js
async function cmdSaveReview() {
  if (!isGitRepo()) { console.error('Not a git repository.'); process.exit(1); }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const reportContent = Buffer.concat(chunks).toString('utf-8');

  const verdict = parseVerdict(reportContent);
  const slug = verdictSlug(verdict);
  const timestamp = getTimestamp();
  const filename = `${timestamp}-${slug}.md`;
  const outPath = path.join(aiDir(), 'reviews', filename);
  ensureDir(path.join(aiDir(), 'reviews'));

  const base = getAuditBase();
  const head = getHead();

  const header = `<!--
audit-review:
  saved_at: ${timestamp}
  base: ${base}
  head: ${head}
  verdict: ${verdict ?? 'UNKNOWN'}
-->

`;

  writeFile(outPath, header + reportContent);

  console.log(`Saved audit review: ${outPath}`);
  console.log(`Verdict: ${verdict ?? 'UNKNOWN'}`);

  if (verdict === 'OK') {
    console.log('You may now run: node scripts/ai-audit/cli.mjs mark-reviewed');
  } else {
    console.log('Do not move refs/ai/reviewer/last-reviewed.');
  }
}

async function cmdMarkReviewed(args) {
  if (!isGitRepo()) { console.error('Not a git repository.'); process.exit(1); }
  const force = args.includes('--force');

  const reviews = listFilesSorted(path.join(aiDir(), 'reviews'));
  if (reviews.length === 0) {
    console.error('No audit reviews found. Run save-review first.');
    process.exit(1);
  }

  const latestFile = path.join(aiDir(), 'reviews', reviews.at(-1));
  const content = readFileIfExists(latestFile) ?? '';
  const verdict = parseVerdict(content);

  if (!force && verdict !== 'OK') {
    console.error('Refusing to mark reviewed.');
    console.error(`Latest audit verdict is: ${verdict ?? 'UNKNOWN'}`);
    console.error('The last-reviewed pointer must not move unless verdict is OK.');
    process.exit(1);
  }

  if (force && verdict !== 'OK') {
    console.warn('WARNING: --force used. Bypassing verdict check.');
    console.warn(`Verdict was: ${verdict ?? 'UNKNOWN'}`);
  }

  const oldRef = getLastReviewedRef();
  const head = getHead();
  setLastReviewedRef(head);

  console.log(`refs/ai/reviewer/last-reviewed updated.`);
  console.log(`  old: ${oldRef ? oldRef.slice(0, 12) : '(not set)'}`);
  console.log(`  new: ${head.slice(0, 12)}`);
}

async function cmdResetReviewed(args) {
  if (!isGitRepo()) { console.error('Not a git repository.'); process.exit(1); }

  const commit = args[0] ?? 'HEAD';
  const resolved = revParse(commit);

  console.warn('WARNING: This manually changes the audit base pointer.');
  console.warn('Use this only when initializing or repairing audit state.');

  setLastReviewedRef(resolved);
  console.log(`refs/ai/reviewer/last-reviewed → ${resolved.slice(0, 12)} (${commit})`);
}
```

- [ ] **Step 2: save-review 확인 — OK verdict**

```bash
printf '# Audit Report\n\n## Verdict\n\n`OK`\n' | node scripts/ai-audit/cli.mjs save-review
```

Expected:
```
Saved audit review: .ai/reviews/2026-05-20-HHMMSS-ok.md
Verdict: OK
You may now run: node scripts/ai-audit/cli.mjs mark-reviewed
```

- [ ] **Step 3: mark-reviewed 확인**

```bash
node scripts/ai-audit/cli.mjs mark-reviewed
```

Expected: `refs/ai/reviewer/last-reviewed updated.` + old/new 해시 출력

- [ ] **Step 4: save-review + mark-reviewed 거부 확인 — Needs correction**

```bash
printf '# Audit Report\n\n## Verdict\n\nNeeds correction\n' | node scripts/ai-audit/cli.mjs save-review
node scripts/ai-audit/cli.mjs mark-reviewed
```

Expected: `Refusing to mark reviewed.` + exit code 1

- [ ] **Step 5: reset-reviewed 확인**

```bash
node scripts/ai-audit/cli.mjs reset-reviewed HEAD
node scripts/ai-audit/cli.mjs status
```

Expected: status에서 `Last reviewed`가 HEAD 해시와 일치

- [ ] **Step 6: 커밋**

```bash
git add scripts/ai-audit/cli.mjs
git commit -m "feat(ai-audit): cli.mjs — save-review + mark-reviewed + reset-reviewed 구현"
```

---

## Task 8: .gitignore + README

**Files:**
- Modify: `.gitignore`
- Create: `.ai/README.md`

- [ ] **Step 1: .gitignore에 감사 런타임 파일 추가**

`.gitignore` 하단에 추가:

```
# AI audit harness runtime files
.ai/audit-input.md
.ai/runs/
.ai/reviews/
```

단, `.ai/spec.md`와 `.ai/auditor-persona.md`는 트래킹해야 하므로 제외하지 않음.

- [ ] **Step 2: .ai/README.md 생성**

`.ai/README.md`:
```markdown
# AI Audit Harness

## Workflow

### 1. 초기화

```bash
node scripts/ai-audit/cli.mjs init
```

### 2. spec 작성 + baseline 설정

```bash
# .ai/spec.md 편집 — 현재 task 정의
git add .ai/spec.md .ai/auditor-persona.md
git commit -m "spec: define task"
node scripts/ai-audit/cli.mjs reset-reviewed HEAD
```

### 3. 개발 (Dev Session)

```bash
# 코드 작성 후 검증 기록
node scripts/ai-audit/cli.mjs run -- ./gradlew test

# 커밋 (phase 완료 시)
git add .
git commit -m "feat: implement subtask"
```

### 4. 감사 입력 생성

```bash
node scripts/ai-audit/cli.mjs input
# → .ai/audit-input.md 생성됨
```

### 5. Audit Session에서 감사

Audit Session에서: `.ai/audit-input.md` 읽고 감사 보고서 작성

### 6. 보고서 저장

```bash
node scripts/ai-audit/cli.mjs save-review < audit-report.md
```

### 7a. OK인 경우

```bash
node scripts/ai-audit/cli.mjs mark-reviewed
```

### 7b. OK가 아닌 경우

pointer를 이동하지 않음. Dev Session이 수정 후 재커밋.
4번부터 반복.

## 커맨드 참조

| 커맨드 | 설명 |
|--------|------|
| `init` | .ai/ 초기화 |
| `status` | 현재 감사 상태 확인 |
| `input` | audit-input.md 생성 |
| `run -- <cmd>` | 검증 명령 실행 + 로그 저장 |
| `save-review` | 감사 보고서 저장 (stdin) |
| `mark-reviewed` | last-reviewed → HEAD (OK만) |
| `reset-reviewed [commit]` | 기준점 수동 설정 |
```

- [ ] **Step 3: 확인**

```bash
cat .gitignore | grep -A4 "AI audit"
```

Expected: 세 줄이 존재

- [ ] **Step 4: 커밋**

```bash
git add .gitignore .ai/README.md
git commit -m "feat(ai-audit): .gitignore 설정 + .ai/README.md 워크플로우 문서"
```

---

## Task 9: 전체 워크플로우 통합 검증

- [ ] **Step 1: 상태 초기화 확인**

```bash
node scripts/ai-audit/cli.mjs init
node scripts/ai-audit/cli.mjs status
```

Expected: 모든 필드 출력, last-reviewed 설정 전이면 `(not set)`

- [ ] **Step 2: baseline 설정**

```bash
node scripts/ai-audit/cli.mjs reset-reviewed HEAD
node scripts/ai-audit/cli.mjs status
```

Expected: `Last reviewed`가 HEAD와 동일

- [ ] **Step 3: 검증 실행 + input 생성**

```bash
node scripts/ai-audit/cli.mjs run -- node --version
node scripts/ai-audit/cli.mjs input
```

Expected: `.ai/runs/`에 로그, `.ai/audit-input.md` 생성

- [ ] **Step 4: OK 감사 → mark-reviewed 전체 흐름**

```bash
printf '# Audit Report\n\n## Verdict\n\nOK\n' | node scripts/ai-audit/cli.mjs save-review
node scripts/ai-audit/cli.mjs mark-reviewed
node scripts/ai-audit/cli.mjs status
```

Expected: `Latest audit review: ... verdict: OK`, last-reviewed = HEAD

- [ ] **Step 5: 비-OK 감사 → 거부 흐름**

```bash
printf '# Audit Report\n\n## Verdict\n\nNeeds correction\n' | node scripts/ai-audit/cli.mjs save-review
node scripts/ai-audit/cli.mjs mark-reviewed
echo "exit code: $?"
```

Expected: `Refusing to mark reviewed.`, exit code 1

- [ ] **Step 6: 최종 커밋**

```bash
git add -A
git commit -m "test(ai-audit): 전체 워크플로우 통합 검증 완료"
```
