---
name: document-feature
description: Use this skill whenever you finish implementing a feature on a feat/* branch, when the user asks to "document the feature" / "write feature docs" / "summarize this work", or as part of the push-with-review workflow. Always invoke this skill before pushing feat/* branches. Requires three sections — Context & Problem, Flow Diagram, and Decision Log — and prompts the user for items that cannot be inferred automatically. Output language is Korean; skill instructions are English.
---

# Document Feature Skill

Document feature development in `docs/feat/` and register it in INDEX.md.

> **출력 언어**: 사용자에게 하는 모든 응답과 완료 리포트는 한국어로 작성합니다.

## Workflow

### Step 1: Auto-collect

Collect the following using tools. Do not ask the user.

```
git branch --show-current            → parse feature name (feat/xxx → xxx)
git log <main-branch>..HEAD --oneline    → commit list
git diff <main-branch>..HEAD --name-only → changed file list
```

- Assume main-branch is `dev`; fall back to `main` if not found.
- Feature filename: strip `feat/` from branch name, replace `/` with `-`
  - e.g. `feat/adapt_oauth` → `adapt-oauth`
- Read changed service, controller, and entity files to understand the core flow.

### Step 2: Collect user input (ask the user directly)

Ask for items that cannot be inferred automatically, all at once.

**Items that must be collected directly from the user:**
1. **Context & Problem** — "이 feature를 왜 만들었나요? 어떤 문제를 해결하려 했나요?" (background, limitations of the old approach, motivation)
2. **Decision Log** — "주요 설계 결정과 이유를 알려주세요." If there are multiple decisions, ask item by item. For each decision, also record importance: **High** (architectural impact), **Medium** (behavioral change), **Low** (style/optimization).

Keep questions concise and easy to answer.

### Step 3: Generate Flow Diagram

Based on code collected in Step 1, auto-generate a **Mermaid sequenceDiagram or flowchart**.

- Show only the core logic flow (not full CRUD — focus on what changed in this feature)
- Split into two diagrams if complex (e.g. request flow / approval flow)
- Self-review after generation: fix any mismatch with the actual code

### Step 4: Write the document

Write `docs/feat/<feature-name>.md` using the template below.

**Template:**

```markdown
# <Feature 제목>

> 작성일: YYYY-MM-DD | 브랜치: <branch> | 작성자: <git user.name>

## Context & Problem

<사용자 입력 내용을 정제해서 작성>

## Flow Diagram

```mermaid
<자동 생성한 다이어그램>
```

## Decision Log

| 결정 | 선택한 방향 | 이유 | 중요도 |
|------|-------------|------|--------|
| ... | ... | ... | High/Medium/Low |

## 변경 범위

**주요 변경 파일:**
- `path/to/file.java` — 변경 내용 한 줄 요약

**DB 변경:** (없으면 생략)
- 추가/삭제/변경된 테이블 또는 컬럼

**API 변경:** (없으면 생략)
- 추가/변경/삭제된 엔드포인트
```

### Step 5: Update INDEX.md

Create `docs/feat/INDEX.md` if it does not exist; otherwise prepend a new entry at the top.

**INDEX.md format:**

```markdown
# Feature Docs Index

| 날짜 | Feature | 브랜치 | 요약 |
|------|---------|--------|------|
| YYYY-MM-DD | [feature-name](./feature-name.md) | feat/xxx | 한 줄 요약 |
```

Keep the newest entry at the top.

### Step 6: Render HTML

Invoke the `render-docs` skill via the Skill tool, passing the feature name as the argument.

- Target: the md file just created (`<feature-name>`)
- Creates `docs/feat/html/<feature-name>.html`
- Updates `docs/feat/html/index.html`

### Step 7: Update MEMORY.md

Derive the memory path dynamically:

```bash
ROOT=$(git rev-parse --show-toplevel)
# PI project slug: replace \ and : with -
# e.g. D:\JavaProject\DevCenter → D--JavaProject-DevCenter
```

The slug is formed by replacing every `\` and `:` in the absolute path with `-`.
Full path: `~/.pi/projects/<slug>/memory/MEMORY.md`

- If a pointer to `docs/feat/INDEX.md` already exists, update it only.
- Otherwise add: `- [Feature Docs Index](docs/feat/INDEX.md) — 개발된 feature 목록 및 설계 문서`

If the memory file does not exist, create `memory/feature_docs.md` and add a pointer in MEMORY.md.

## Quality Checklist

Self-check after writing the document:

- [ ] Does Context & Problem explain *why* it was built, not just *what* was done?
- [ ] Does the Flow Diagram match the actual code flow?
- [ ] Does each Decision Log entry have a clear reason?
- [ ] Does the change scope match the git diff?
- [ ] Is INDEX.md updated correctly?

If any item fails, fix it before reporting completion.

## Completion Report

```
✓ docs/feat/<name>.md 생성
✓ docs/feat/INDEX.md 업데이트
✓ docs/feat/html/<name>.html 생성
✓ docs/feat/html/index.html 업데이트
✓ MEMORY.md 포인터 등록
```
