# AI 커밋 감사 하네스 설계

**날짜:** 2026-05-20
**목표:** 두 개의 독립 PI 세션(개발/감사)이 같은 워크트리에서 협업하는 커밋 단위 감사 워크플로우를 지원하는 로컬 하네스를 구축한다.

---

## 1. 핵심 설계 원칙

이 하네스는 **AI가 AI를 대화로 심판하는 구조가 아니다.**
커밋된 증거(diff, 로그, 검증 출력)만으로 판단하는 **감사 추적 워크플로우**다.

- 하네스 자체는 AI API를 호출하지 않는다
- 모든 판단은 외부 Audit Session이 `.ai/audit-input.md`를 읽고 내린다
- Dev Session의 "생각"이 Audit Session에 묻어나지 않도록 파일 인터페이스로만 소통한다

---

## 2. 두 세션 워크플로우

```
Dev Session                          Audit Session
    │                                      │
    │ 코드 작성 → 검증 → 커밋               │
    │                                      │
    │ (phase 완료)                         │
    │ node scripts/ai-audit/cli.mjs run    │
    │ node scripts/ai-audit/cli.mjs input  │
    │                                      │
    │        .ai/audit-input.md ──────────▶│ "검사해"
    │                                      │ 감사 수행
    │                                      │ 보고서 작성
    │        .ai/reviews/*.md ◀────────────│
    │                                      │
    │ (verdict == OK)                      │
    │ mark-reviewed                        │
    │   └─ refs/ai/reviewer/last-reviewed  │
    │        → HEAD                        │
    │                                      │
    │ (verdict != OK)                      │
    │ 수정 후 재커밋 → 재감사              │
```

**트리거는 항상 사람이다.** 자동화 없음. Dev Session이 멈추면 사람이 Audit Session에 "검사해"라고 말한다.

---

## 3. 감사 기준점 — last-reviewed ref

```
refs/ai/reviewer/last-reviewed
```

로컬 git ref. 마지막으로 감사 통과(OK)한 커밋을 가리킨다.

감사 범위:
```
refs/ai/reviewer/last-reviewed..HEAD
```

이 ref가 없으면 기본값으로 `git merge-base HEAD main`(또는 master, HEAD~1) 사용.

**규칙:**
- `OK` verdict → `mark-reviewed`로만 이동 가능
- `Needs correction` / `Stop and re-plan` → 절대 이동 불가
- `reset-reviewed`로 수동 이동 시 경고 메시지 출력

---

## 4. 파일 구조

```
project/
├── .ai/
│   ├── spec.md              # 현재 task 정의 (Dev Session이 작성)
│   ├── auditor-persona.md   # Audit Session 역할 정의
│   ├── audit-input.md       # 감사 컨텍스트 (input 커맨드 생성)
│   ├── runs/                # 검증 명령 실행 로그
│   │   └── YYYY-MM-DD-HHMMSS-<slug>.txt
│   └── reviews/             # 감사 보고서 아카이브
│       └── YYYY-MM-DD-HHMMSS-<verdict-slug>.md
│
└── scripts/
    └── ai-audit/
        ├── cli.mjs          # CLI 진입점
        ├── git.mjs          # git 유틸 + last-reviewed ref 관리
        ├── fs-utils.mjs     # 파일시스템 유틸
        ├── templates.mjs    # 기본 마크다운 템플릿
        └── verdict.mjs      # 감사 판정 파서
```

---

## 5. CLI 커맨드

```bash
node scripts/ai-audit/cli.mjs <command>
```

| 커맨드 | 역할 |
|--------|------|
| `init` | `.ai/` 디렉토리 구조 + 기본 파일 생성 |
| `status` | HEAD, last-reviewed, 감사 범위, 최신 판정 출력 |
| `input` | `.ai/audit-input.md` 생성 |
| `run -- <cmd>` | 명령 실행 + 출력 `.ai/runs/`에 저장 |
| `save-review` | stdin에서 감사 보고서 읽어 `.ai/reviews/`에 저장 |
| `mark-reviewed` | last-reviewed → HEAD (OK verdict일 때만) |
| `reset-reviewed [commit]` | last-reviewed 수동 지정 (경고 포함) |

---

## 6. audit-input.md 구조

Audit Session이 읽는 단일 컨텍스트 파일. 순서 고정:

```
# Audit Session Input
## Auditor Bootstrap   ← "너는 독립 감사 세션이다" 지시
## Auditor Persona     ← .ai/auditor-persona.md 내용
## Task Spec           ← .ai/spec.md 내용
## Review Range        ← base/head 커밋 해시
## Git Status          ← git status --short
## Git Log             ← git log --oneline base..HEAD
## Diff Stat           ← git diff --stat base..HEAD
## Changed Files       ← 변경된 파일 목록
## Diff                ← git diff base..HEAD (전체)
## Recent Run Outputs  ← .ai/runs/ 최신 10개
## Recent Previous Reviews ← .ai/reviews/ 최신 3개
## Final Instruction   ← "보고서만 작성. 파일 수정 금지."
```

---

## 7. 감사 보고서 계약

Audit Session이 반환해야 하는 형식:

```markdown
# Audit Report

## Review Range
Base: `<hash>`
Head: `<hash>`

## Verdict
`OK` | `Needs correction` | `Stop and re-plan`

## Task Restatement
## Scope Assessment
## Constraint Audit (표)
## Critical Issues (P0 / P1)
## Non-Blocking Notes (P2)
## Verification Evidence
## Fix Contract
```

**판정 3종:**
- `OK` — 모든 요구사항 충족, last-reviewed 이동 가능
- `Needs correction` — P1 이슈 존재, 수정 후 재감사
- `Stop and re-plan` — 방향 자체가 잘못됨, 작업 중단

---

## 8. Dev Session 커밋 규율

감사가 의미 있으려면 Dev Session이 이 규칙을 지켜야 한다:

1. **phase 경계마다 커밋** — 중간 상태 커밋 금지
2. **검증 먼저** — `run` 커맨드로 테스트 통과 기록 후 커밋
3. **atomic commit** — 하나의 논리적 변경 = 하나의 커밋
4. **커밋 메시지** — 무엇을 했는지 명확하게 (Audit Session이 판단 기준으로 사용)
5. **spec 기반** — `.ai/spec.md`에 없는 것은 구현하지 않음

---

## 9. 구현 제약

- Node.js >= 18, ESM 모듈
- `child_process.execFileSync` / `spawnSync` 사용 (shell interpolation 금지)
- git 인수는 항상 배열로 전달
- Windows / macOS / Linux 크로스플랫폼
- Bash / PowerShell 의존 없음
- 하네스 자체는 외부 AI API 호출 없음

---

## 10. 제외 범위

- 자동 감사 트리거 (파일 감시, CI 연동 등)
- 실시간 세션 간 통신
- 감사 보고서 내용 자동 생성
- 외부 AI API 호출
- 웹 UI / 대시보드
