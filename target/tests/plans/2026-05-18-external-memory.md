# External Memory System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개발 중 발견한 실패 패턴·학습을 `.project-memory/`에 저장하고, 코드 편집 시 관련 메모리를 PostToolUse 훅으로 자동 리마인드한다.

**Architecture:** INDEX.md + PI 판단 방식. PI는 작업 시작 전 INDEX.md를 읽고 관련 파일을 선택적으로 로드한다. PostToolUse 훅은 편집 파일 경로와 메모리 파일의 태그를 매칭해 핵심 규칙을 주입한다.

**Tech Stack:** Node.js (훅), Markdown (메모리 파일), JSON (settings.json)

---

## File Map

| 파일 | 역할 | 작업 |
|------|------|------|
| `.project-memory/INDEX.md` | 메모리 인덱스 (항상 로드) | 신규 생성 |
| `.project-memory/spring-pitfalls.md` | 예시 메모리 파일 | 신규 생성 |
| `.pi/hooks/post-tool-use-memory.js` | PostToolUse 훅 (태그 매칭 → 리마인더) | 신규 생성 |
| `AGENTS.md` | 작업 전 INDEX 읽기 지시사항 | 수정 |
| `.pi/settings.json` | 훅 등록 | 수정 |

---

## Task 1: `.project-memory/` 디렉토리 구조 생성

**Files:**
- Create: `.project-memory/INDEX.md`
- Create: `.project-memory/spring-pitfalls.md`

- [ ] **Step 1: INDEX.md 생성**

`.project-memory/INDEX.md`:
```markdown
# Project Memory Index

작업 시작 전 이 파일을 읽고, 관련 항목의 원본 파일을 로드하세요.

| 파일 | 요약 | 읽을 시점 |
|------|------|----------|
| spring-pitfalls.md | Bean 등록·의존성 주입·트랜잭션 실패 패턴 | Java·Spring 파일 작업 시 |
```

- [ ] **Step 2: 예시 메모리 파일 생성**

`.project-memory/spring-pitfalls.md`:
```markdown
---
tags: [java, spring, service, controller, repository, transactional]
added: 2026-05-18
---

## 상황
Spring Boot 서비스 레이어 구현 중 트랜잭션·DI 관련 실수 반복 발생.

## 실패한 접근
- `@Transactional`을 Controller에 선언 → 프록시 미적용으로 트랜잭션 미동작
- `@Autowired` 필드 주입 사용 → 테스트 시 목 주입 불가

## 올바른 접근
- `@Transactional`은 Service 레이어에만 선언
- 의존성 주입은 생성자 주입(Constructor Injection) 사용

## 핵심 규칙
@Transactional은 Service에만. 생성자 주입 사용. Controller에 @Transactional 금지.
```

- [ ] **Step 3: 커밋**

```bash
git add .project-memory/
git commit -m "feat(memory): .project-memory 디렉토리 구조 및 예시 메모리 초기화"
```

---

## Task 2: AGENTS.md에 Project Memory 지시사항 추가

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: AGENTS.md의 `## Core Execution Rules` 섹션 앞에 추가**

다음 섹션을 `AGENTS.md`의 `## Core Execution Rules` 바로 위에 삽입:

```markdown
## Project Memory

**작업 시작 전 (MANDATORY):**
1. `.project-memory/INDEX.md` 읽기
2. INDEX 테이블에서 현재 작업과 관련된 행 식별
3. 해당 파일 로드 후 작업 시작

**작업 종료 후:**
- 새로운 실패 패턴·학습 발견 시 메모리 추가 제안
- 사용자 승인 후: 파일 작성 + INDEX.md 업데이트

**메모리 파일 형식:**
```markdown
---
tags: [태그1, 태그2]
added: YYYY-MM-DD
---

## 상황
## 실패한 접근
## 올바른 접근
## 핵심 규칙
한 줄 요약
\```
```

- [ ] **Step 2: 커밋**

```bash
git add AGENTS.md
git commit -m "feat(memory): AGENTS.md에 Project Memory 읽기 지시사항 추가"
```

---

## Task 3: PostToolUse 훅 작성

**Files:**
- Create: `.pi/hooks/post-tool-use-memory.js`

- [ ] **Step 1: 훅 파일 생성**

`.pi/hooks/post-tool-use-memory.js`:
```javascript
#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let PROJECT_ROOT;
try {
  PROJECT_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: 'pipe' }).trim();
} catch {
  process.exit(0);
}

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(raw);
    const toolName = event.tool_name || '';

    if (!['Write', 'Edit'].includes(toolName)) process.exit(0);

    const filePath = event.tool_input?.file_path || '';
    if (!filePath) process.exit(0);

    const indexPath = path.join(PROJECT_ROOT, '.project-memory', 'INDEX.md');
    if (!fs.existsSync(indexPath)) process.exit(0);

    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    const memFiles = extractMemoryFiles(indexContent);

    const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
    const reminders = [];

    for (const memFile of memFiles) {
      const fullPath = path.join(PROJECT_ROOT, '.project-memory', memFile);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const tags = extractTags(content);
      const rule = extractCoreRule(content);

      if (!rule) continue;
      if (tags.some(tag => normalizedPath.includes(tag.toLowerCase()))) {
        reminders.push(`[메모리 리마인더] ${memFile}\n→ ${rule}`);
      }
    }

    if (reminders.length > 0) {
      process.stdout.write(reminders.join('\n\n') + '\n');
    }
  } catch (_) {
    // silent fail
  }
  process.exit(0);
});

function extractMemoryFiles(indexContent) {
  return indexContent
    .split('\n')
    .map(line => { const m = line.match(/\|\s*([^\s|]+\.md)\s*\|/); return m ? m[1] : null; })
    .filter(Boolean);
}

function extractTags(content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return [];
  const tagsLine = frontmatter[1].match(/tags:\s*\[([^\]]+)\]/);
  if (!tagsLine) return [];
  return tagsLine[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
}

function extractCoreRule(content) {
  const match = content.match(/##\s*핵심\s*규칙\n+([\s\S]*?)(?=\n##|$)/);
  if (!match) return null;
  return match[1].trim().split('\n')[0].trim();
}
```

- [ ] **Step 2: 훅 동작 검증 — 매칭 케이스**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"D:/JavaProject/DevCenter/src/main/java/com/example/service/UserService.java"}}' | node .pi/hooks/post-tool-use-memory.js
```

Expected output:
```
[메모리 리마인더] spring-pitfalls.md
→ @Transactional은 Service에만. 생성자 주입 사용. Controller에 @Transactional 금지.
```

- [ ] **Step 3: 훅 동작 검증 — 비매칭 케이스**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"D:/JavaProject/DevCenter/docs/README.md"}}' | node .pi/hooks/post-tool-use-memory.js
```

Expected output: (아무것도 출력되지 않음)

- [ ] **Step 4: 훅 동작 검증 — 비대상 툴**

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"D:/JavaProject/DevCenter/src/main/java/UserService.java"}}' | node .pi/hooks/post-tool-use-memory.js
```

Expected output: (아무것도 출력되지 않음)

- [ ] **Step 5: 커밋**

```bash
git add .pi/hooks/post-tool-use-memory.js
git commit -m "feat(memory): PostToolUse 메모리 리마인더 훅 구현"
```

---

## Task 4: settings.json에 훅 등록

**Files:**
- Modify: `.pi/settings.json`

- [ ] **Step 1: PostToolUse 블록에 훅 추가**

`.pi/settings.json`의 `"PostToolUse"` 배열에 다음 항목 추가:

```json
{
  "matcher": "Edit|Write",
  "hooks": [
    {
      "type": "command",
      "command": "node",
      "args": ["${PI_PROJECT_DIR}/.pi/hooks/post-tool-use-memory.js"]
    }
  ]
}
```

최종 `"PostToolUse"` 배열:
```json
"PostToolUse": [
  {
    "matcher": "Edit|Write",
    "hooks": [
      {
        "type": "command",
        "command": "node",
        "args": ["${PI_PROJECT_DIR}/.pi/hooks/code-guardrail.js"]
      }
    ]
  },
  {
    "matcher": "Write",
    "hooks": [
      {
        "type": "command",
        "command": "node",
        "args": ["${PI_PROJECT_DIR}/.pi/hooks/validate-feat-html.js"]
      }
    ]
  },
  {
    "matcher": "Write",
    "hooks": [
      {
        "type": "command",
        "command": "node",
        "args": ["${PI_PROJECT_DIR}/.pi/hooks/validate-feat-index.js"]
      }
    ]
  },
  {
    "matcher": "Edit|Write",
    "hooks": [
      {
        "type": "command",
        "command": "node",
        "args": ["${PI_PROJECT_DIR}/.pi/hooks/post-tool-use-memory.js"]
      }
    ]
  }
]
```

- [ ] **Step 2: 커밋**

```bash
git add .pi/settings.json
git commit -m "feat(memory): settings.json에 PostToolUse 메모리 훅 등록"
```

---

## Task 5: 통합 검증

- [ ] **Step 1: .project-memory 구조 확인**

```bash
ls .project-memory/
```

Expected:
```
INDEX.md  spring-pitfalls.md
```

- [ ] **Step 2: INDEX.md 파싱 확인**

```bash
node -e "
const fs = require('fs');
const c = fs.readFileSync('.project-memory/INDEX.md','utf-8');
const files = c.split('\n').map(l=>{const m=l.match(/\|\s*([^\s|]+\.md)\s*\|/);return m?m[1]:null;}).filter(Boolean);
console.log('Parsed files:', files);
"
```

Expected:
```
Parsed files: [ 'spring-pitfalls.md' ]
```

- [ ] **Step 3: 전체 플로우 smoke test**

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"D:/JavaProject/DevCenter/src/main/java/com/example/controller/UserController.java","old_string":"","new_string":""}}' | node .pi/hooks/post-tool-use-memory.js
```

Expected: `controller` 태그 매칭으로 `spring-pitfalls.md` 리마인더 출력

- [ ] **Step 4: 최종 커밋 확인**

```bash
git log --oneline -5
```

Expected: 위 3개 커밋이 보임

