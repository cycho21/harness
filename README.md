# harness

[English README](README.en.md)

Pi 기반 LLM 개발 세션에 **workflow 거버넌스**, **기계적 guard**, **external memory**, **field failure log**를 추가하는 하네스입니다.

이 저장소는 하네스 개발용 source repo입니다. 실제 프로젝트에 설치되는 런타임 템플릿은 `target/` 아래에 격리되어 있습니다. 따라서 이 저장소 루트에서 작업해도 하네스 extension/skill/context가 자동 로드되지 않습니다.

TUI 시인성 개선을 위해 배포 템플릿에 project-local 테마 `target/.pi/themes/workflow-console.json`을 포함합니다. 이 테마는 어두운 배경을 유지하면서 상태/강조 요소에 cyan, pink, yellow, green 계열을 더 선명하게 쓰는 colorful console 팔레트입니다. 설치된 프로젝트에서는 `.pi/themes/workflow-console.json`으로 배치되며, Pi의 `/settings`에서 `workflow-console`을 선택해 사용할 수 있습니다.

TUI 개선용 harness extension helper `target/.pi/extensions/workflow/markdown-box.ts`는 semantic fenced block 타입 `note`, `warning`, `error`, `plan`, `review`, `decision`, `tip`을 박스형 line rendering으로 변환하는 재사용 유틸리티를 제공합니다. 또한 `target/.pi/extensions/assistant-markdown-box.ts`는 LLM assistant 응답의 자연어 fenced block info string(`text`, `plain`, `plaintext`, `txt`)을 TUI에서 따뜻한 amber 배경 패널로 렌더링합니다. 실제 code fence는 기존 Pi Markdown 렌더러에 맡기며, provider context/session에 저장되는 assistant 메시지 원문은 바꾸지 않습니다.

설치된 프로젝트의 루트에는 기본적으로 다음만 노출됩니다.

```text
AGENTS.md
.pi/
```

workflow 내부 구현, DPAA, skills, personas, schemas 등은 `.pi/` 아래에 위치합니다. Claude Code workflow gate를 설치한 경우 `.claude/`와 `.harness/`도 함께 배치됩니다.

---

## 구성 요소

```text
harness
├─ workflow component
│  ├─ .pi/extensions/workflow.ts
│  ├─ .pi/extensions/workflow/
│  ├─ .harness/workflow-policy.json
│  ├─ .pi/WORKFLOW.md
│  ├─ .pi/dpaa/
│  ├─ .pi/sbadr/
│  ├─ .pi/setup_corenlp.sh
│  ├─ .pi/workflows/
│  ├─ .pi/skills/
│  └─ .pi/schemas/harness-field-log-event.schema.json
│
└─ memory component
   ├─ .pi/extensions/memory.ts
   └─ .pi/schemas/harness-memory-entry.schema.json
```

### Workflow component

개발 단계를 관리하고, 중요한 경계에서 guard를 실행합니다.

주요 역할:

- workflow phase 관리
- DPAA plan ambiguity gate
- SBADR 영어 플랜 구문 모호성 분석 (Stanford CoreNLP 기반)
- Pi/Claude 공통 요구사항 수집 프로토콜 (`/requirements-room`, `/feature-interview`, `/feature-planning-room`)과 역할별 산출물 생성
- code quality gate
- push policy scan
- workspace mismatch 방지
- field failure log 생성
- mechanical reminders 주입
- extension 수정 시 사용자 승인 요구

Workflow extension 개발 시 `target/.pi/extensions/workflow.ts`는 entrypoint와 상위 조립 계층으로 유지합니다. 새 guard 판단은 `target/.pi/extensions/workflow/gates.ts`, reminder 판단은 `workflow/reminders.ts`, command catalog와 harness repo code-quality 감지는 `workflow/catalog.ts`, state/persistence는 `workflow/state.ts`와 `workflow/storage.ts`에 둡니다. runtime process state와 stale steer metadata는 `workflow/runtime-state.ts`, phase tool policy, runtime extension 수정 승인 판단, `/workflow` 오타 제안은 `workflow/runtime-policy.ts`, footer/board/result box UI helper는 `workflow/runtime-ui.ts`, 일반 UI 유틸리티는 `workflow/ui.ts` 또는 `workflow/interview-ui.ts`에 둡니다. guard token CustomEntry는 audit-only 기록이며 session restart 후 권한으로 복원하지 않습니다. 새 기능을 추가할 때 `workflow.ts`에 업무 로직을 직접 늘리지 말고 먼저 적절한 하위 모듈을 선택합니다.

DPAA와 SBADR은 상호 보완적입니다.

요구사항 수집/강화 인터뷰는 별도 명령으로 제공합니다.

```text
/requirements-room <feature-name or rough idea>
/feature-interview <feature-name or rough idea>
/feature-planning-room <feature-name or rough idea>
```

중복/legacy/고급 회의용 skill인 `code-review-gate`, `push-with-review`, `feature-interview`, `feature-planning-room`, `requirements-room`은 기본 모델 자동 호출 후보에서 제외하고 command-only로 유지합니다. 필요할 때만 명시적인 `/skill:<name>` 또는 대응 slash command로 사용합니다.

`/requirements-room`은 새 다직군 요구사항 회의 진행기입니다. 기존 기본 interview나 초안 성격의 planning-room과 분리되어, 기획/디자인/프론트엔드/백엔드/QA·통합/운영 관점을 짧은 round로 진행하고, 역할 간 계약, 충돌, 결정, 가정, open question을 요구사항 패키지로 정리합니다. `.ai/interview/requirements-room-protocol.md`를 공통 프로토콜로 사용하며 산출물은 `.ai/interview/<feature-slug>/requirements-room/` 아래에 저장됩니다.

`/feature-interview`는 1:1 심층 인터뷰형입니다. 이 명령은 `.ai/interview/feature-interview-protocol.md`를 공통 프로토콜로 사용하므로 Pi의 `feature-interview` skill과 Claude Code의 `/feature-interview` 명령이 같은 기준으로 동작합니다.

`/feature-planning-room`은 CLI 우선, GUI 확장 가능 회의실형 기능 기획 명령 초안입니다. `.ai/interview/feature-planning-room-protocol.md`를 공통 프로토콜로 사용하고, 참석자 roster, 설문조사식 CLI 질문지, round 기반 진행, 역할 간 질문, decision log, conflict log, ambiguity register, `session-state.json`, `session-events.jsonl`을 생성하도록 설계되어 향후 GUI chat이 같은 산출물을 렌더링할 수 있습니다.

산출물은 `.ai/interview/<feature-slug>/` 아래에 저장됩니다. 한국어 `.ko.md` 파일은 사람용 source of truth이고, 영어 `.md` 파일은 DPAA/SBADR 친화적인 machine-check artifact입니다.

| | DPAA | SBADR |
|---|---|---|
| 방식 | rule-based, 서버 불필요 | Stanford CoreNLP 의존 파싱 |
| 대상 | 한/영 플랜 다층 품질 검사 | 영어 플랜 구문 모호성 정밀 분석 |
| 분석 범위 | structural, referential, temporal, verification 등 | PP attachment, coordination, analytical, noun phrase |

CoreNLP는 별도 설치가 필요합니다 (Java 17+ 필수, ~500 MB). 쪵게이트 실행 시 자동 설치됩니다. 수동 설치:

```bash
# macOS/Linux
bash .pi/setup_corenlp.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .pi/setup_corenlp.ps1
```

### Memory component

LLM 개발 세션에서 장기 기억을 사용할 수 있게 하는 작은 external memory layer입니다.

주요 역할:

- durable project fact/decision 저장
- 관련 memory top-N만 prompt에 주입
- 어떤 memory가 주입됐는지 explain
- feedback/metrics 기록
- secret-like memory 저장 거부

---

## 설치

설치할 프로젝트 루트에서 실행합니다.

### Windows PowerShell

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

### macOS/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh
```

설치 후 같은 프로젝트 루트에서 Pi를 실행합니다.

```bash
pi
```

설치 상태 확인:

```text
/workflow doctor
```

개발 repo의 테스트에는 fake LLM action loop가 실제 Pi workflow extension command/tool/event를 호출해 전체 workflow와 guard 복구 흐름을 검증하는 E2E 성격의 테스트가 포함됩니다.

```bash
python -m pytest tests/test_workflow_fake_llm_session.py -q
```

Workflow guard/reminder/catalog 변경 후에는 최소 smoke test로 최근 회귀가 잦은 영역을 확인합니다. 이 묶음은 Windows `.bat` wrapping, code quality tooling error 처리, reminder 신호, TDD write/edit 감지를 함께 검증합니다.

```bash
python -m pytest tests/test_workflow_reminders.py tests/test_workflow_run_command.py tests/test_code_quality_gate.py tests/test_workflow_tool_policy.py -q
```

기본 설치는 Pi용 전체 설치입니다.

```text
--component all
= workflow + memory
```

`all`은 Pi workflow와 memory를 뜻합니다. Claude Code용 workflow gate는 명시적으로 `--component claude-workflow`를 지정해 설치합니다.

---

## component별 설치

필요하면 workflow, memory, claude-workflow만 따로 설치할 수 있습니다.

### workflow만 설치

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component workflow
```

### memory만 설치

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component memory
```

### Claude Code workflow gate만 설치

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --component claude-workflow
```

설치되는 `.claude/settings.json`은 Claude Code hook을 설정합니다. Bash sandbox는 UX 저하가 커 기본 운영 모델에서 제외하고, workflow hook/reminder와 tool-call gate를 중심으로 동작합니다.

- `UserPromptSubmit`: 현재 phase, 다음 phase, 단계 생략 금지, subagent 사용 지침을 계속 상기
- `PreToolUse`: `.claude/**`, `.harness/state.json`, `.harness/authority/**` 등 gate 파일에 대한 file tool 수정을 차단하고 phase별 tool 사용을 검사
- `PostToolUse`: 산출물 조건을 재평가해 workflow state 자동 전이
- `.harness/workflow-policy.json`: Pi/Claude adapter가 공유하는 phase 순서, auto-advance, 승인 경계, transition policy, reminder/context 정책. phase 순서와 승인 경계의 SSOT입니다.
- DPAA/SBADR 런타임(`.pi/dpaa`, `.pi/sbadr`)과 `codeQualityGuard`, push policy scan, checkpoint/restore, field-log 기능을 함께 설치

운영 모델:

- sandbox로 Bash를 강하게 가두지 않습니다. UX를 해치지 않기 위해 Claude Code hook/reminder와 PreToolUse 검사를 기본 guardrail로 사용합니다.
- 정상 작업은 workflow의 다음 phase로만 전이해야 하며, 단계를 생략하는 수동 복구는 비정상/복구 상황으로만 다룹니다.
- context 소모가 큰 implement/code_review/대량 로그 분석은 subagent를 우선 사용해 main agent context pollution을 줄입니다.

Windows PowerShell 예:

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Component claude-workflow
```

기존 설치를 깨끗하게 다시 설치하려면 `-Clean`을 사용합니다. 이 옵션은 하네스가 관리하는 런타임 경로를 먼저 삭제한 뒤 다시 복사합니다. `AGENTS.md`, `.pi/LOCAL.md`, `.ai/interview` 산출물은 보존됩니다.

```powershell
$p=Join-Path $env:TEMP 'init-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.ps1 -OutFile $p; $env:HARNESS_DEST=(Get-Location).Path; powershell -NoProfile -ExecutionPolicy Bypass -File $p -Clean
```

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/init-target-harness.sh | sh -s -- --clean
```

---

## 업데이트

설치된 프로젝트 루트에서 실행합니다.

### Windows PowerShell

```powershell
$p=Join-Path $env:TEMP 'update-harness.ps1'; Invoke-WebRequest https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

### macOS/Linux

```bash
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh
```

component별 업데이트:

```bash
# workflow만 업데이트
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component workflow

# memory만 업데이트
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component memory

# Claude Code workflow gate만 업데이트
curl -fsSL https://raw.githubusercontent.com/cycho21/harness/main/scripts/update-harness.sh | sh -s -- --component claude-workflow
```

업데이트는 upstream-managed 파일만 덮어씁니다. 프로젝트 소유 파일은 보존됩니다.

주의: `.pi/skills`, `.pi/personas`, `.pi/workflows`, `.pi/themes`, `.pi/extensions/workflow` 같은 upstream-managed 디렉터리는 업데이트 시 통째로 갱신될 수 있습니다. 프로젝트별 사용자 정의는 `.pi/local/` 또는 `.pi/config/` 아래에 두세요.

설치/업데이트 entrypoint는 Windows PowerShell/cmd와 Python 하위 프로세스가 UTF-8을 사용하도록 강제합니다. 레거시 Windows 로컬 코드페이지 기반 출력/입력에 의존하지 않습니다.

---

## Workflow 개요

기본 phase는 다음과 같습니다.

```text
interview
→ plan
→ plan_review
→ implement
→ code_review
→ review_approved
→ document
→ commit
→ push
→ done
```

현재 승인 모델은 “모든 phase마다 승인”이 아니라 **위험 경계에서만 승인**하는 구조입니다. Guard가 전이를 막으면 메시지에 LLM 기본 처리 방침을 함께 표시합니다. 기본값은 사용자에게 skip을 먼저 요청하지 않고 현재 phase 안에서 원인을 수정한 뒤 전이를 재시도하는 것입니다. 사용자 확인은 제품/아키텍처 판단, 승인 경계, accepted-risk 예외가 필요한 경우에만 요구합니다. 1차 표준화 범위는 전이 guard 메시지(`gates.ts`)와 관련 workflow 실패/steer 문구, 정적 테스트, README 한/영 문서입니다. AGENTS.md, `.pi/WORKFLOW.md`, `.harness/workflow-policy.json`, tool/phase policy 차단 메시지 전체 정리는 2차 후속 작업으로 분리합니다.

### 자동 진행 구간

```text
interview → plan → plan_review
implement → code_review
review_approved → document → commit
```

### 사용자 승인이 필요한 경계

```text
plan_review → implement
commit → push
```

추가로 다음은 별도 사용자 확인이 필요합니다.

```text
/workflow skip <gate> <reason>
/workflow state <phase>
/workflow abort
git push 위험 변경 재확인
.pi/extensions/** 수정
```

`/workflow status`, `/workflow start`, `/workflow load`, `/workflow approve`, `/workflow state <phase>` 출력에는 `[LLM WORKFLOW ACTION]` 블록이 포함됩니다. 이 블록은 현재 phase, 다음 phase, 자동 전이/승인 경계 여부, LLM이 지금 해야 할 일을 명시합니다. 자동 전이 구간이 끝나고 agent가 idle이며 pending message가 없을 때만 extension이 continuation prompt를 한 번 보내 LLM이 현재 phase 작업을 이어가게 합니다. 이 continuation은 승인 경계를 넘지 않고, stale/중복 marker guard로 보호됩니다. phase가 바뀌면 이전 phase의 steer marker를 정리하고, 뒤늦게 도착한 stale steer는 extension/user 입력 source와 무관하게 소비해 과거 `plan_review` 또는 `code_review` 안내가 현재 phase를 덮어쓰지 않게 합니다. 또한 `plan_review`, `code_review`, `review_approved` 같은 read-only phase에서 `write/edit`이 호출되면 follow-up steering을 큐에 넣지 않고 tool call을 즉시 차단하며, workflow continuation도 busy 상태에서는 follow-up queue에 넣지 않아 `Follow-up: ⚠️ ...` 경고나 stale continuation이 TUI에 누적되지 않게 합니다. `push` phase에서 실제 `git push`가 성공하면 bash `tool_result`를 완료 이벤트로 소비해 `push → done`으로 자동 전이합니다. `workflow_approve`는 `push → done`을 만들 수 없으며, 실제 push 성공 관측 전에는 active workflow를 유지합니다. 이때 완료 이력은 저장하되 active workflow는 즉시 해제해 이후 prompt에 과거 phase continuation이 다시 주입되지 않게 합니다. `/workflow state <phase>`는 정상 진행 명령이 아니라 수동 복구 전용입니다. 정상 진행에서 사용자는 `/workflow approve`를 직접 입력하라는 안내를 받지 않고, 승인 경계에서 TUI yes/no 확인창으로 결정합니다. 자동 전이 구간은 사용자 확인 없이 진행됩니다. Workflow approval dashboard는 전환 메타데이터를 안전하게 문자열로 정규화해 일부 값이 비어 있어도 `undefined`를 노출하지 않습니다.

`/workflow start <목표>`가 `interview` phase를 시작하면 UI 세션에서는 interview wizard가 자동으로 열립니다. Wizard는 기존 5개 인터뷰 질문을 하나씩 보여주며, 대부분의 질문에서 선택지와 자유입력을 함께 받고 선택 질문은 `모름/건너뛰기`를 허용합니다. 필수 질문은 선택지 또는 자유입력 없이 다음으로 진행할 수 없습니다. Editor 위 progress widget은 현재/완료/남은 질문을 표시하고, footer status는 workflow title, 현재 phase, 다음 phase, 전체 phase progress를 표시합니다. Wizard 중 preview 키로 답변 요약을 볼 수 있으며 마지막 질문 후 같은 요약 preview가 자동 표시됩니다. UI가 없거나 wizard가 취소/실패하면 기존 채팅 기반 interview continuation으로 fallback됩니다.

---

## Workflow 상세

| Phase | 의미 | 다음 단계 조건 |
|---|---|---|
| `interview` | 요구사항/모호성 확인 | 자동으로 `plan`까지 진행 가능 |
| `plan` | 구현 계획/DPAA artifact 작성 | 자동으로 `plan_review`까지 진행 |
| `plan_review` | 계획 검토/승인 대기 | 사용자 승인 + DPAA PASS 필요 |
| `implement` | 승인된 계획만 구현 | 구현과 좁은 검증 완료 후 사용자 승인 없이 `code_review` 자동 진입 가능 |
| `code_review` | main review + 독립 reviewer/subagent review + quality gate | 사용자 승인 대신 `submit_review_package`와 quality gate 통과 필요 |
| `review_approved` | 리뷰 패키지와 품질 gate 통과 | 자동으로 `document` 진행 |
| `document` | 필요한 문서/feature docs 작성 | 사용자 승인 없이 자동으로 `commit` 준비 가능 |
| `commit` | diff 요약, 검증 요약, commit message 준비 | 사용자 승인 + policy scan 후 `push` |
| `push` | 원격 반영 준비 완료 | git push guard 통과 및 성공한 `git push` result 후 `done` 자동 전이 |
| `done` | workflow 완료 후 active workflow 해제 | 새 workflow 시작 가능 |

---

## Review package

`code_review → review_approved`는 단순 사용자 승인으로 넘어가지 않습니다. LLM은 review phase에서 다음을 수행하고 `submit_review_package` tool을 호출해야 합니다.

필수 내용:

```text
mainReviewSummary
reviewerReviewSummary    # 독립 reviewer/subagent 리뷰 요약
qualityGateSummary
critical
major
minor
```

통과 조건:

```text
Critical = 0
Major ≤ 2
main review summary 존재
independent reviewer/subagent summary 존재
quality gate summary 존재
codeQualityGuard 통과
```

통과하면 자동으로 다음 체인이 진행됩니다.

```text
code_review → review_approved → document → commit
```

---

## Mechanical reminders

하네스는 일부 항목을 hard gate로 막지 않고, 기계적으로 확인한 결과를 LLM prompt에 reminder로 주입합니다.

예:

```text
[Workflow Mechanical Reminders]
...
[/Workflow Mechanical Reminders]
```

현재 reminder 종류:

1. Documentation reminder
   - `docs/feat/*.md`
   - `docs/feat/INDEX.md`
   - `docs/feat/html/*.html`
   - `docs/feat/html/index.html`
   - md보다 오래된 html

2. Verification reminder
   - commit phase에서 변경 파일이 있는데 최근 test/lint/typecheck/build 실행 흔적이 없을 때

3. Review package reminder
   - code_review phase에서 review package가 아직 제출되지 않았을 때

4. Commit summary reminder
   - commit phase에서 변경 파일이 있는데 diff summary / risk summary / commit message 준비가 필요할 때

5. Field-log evidence reminder
   - harness runtime/tooling 변경인데 field failure log 근거가 없을 때

reminder는 기본적으로 차단하지 않습니다. 대신 LLM은 반드시 처리하거나, 해당 항목이 필요 없는 이유를 명시해야 합니다.

추가로 `.harness/workflow-policy.json`의 짧은 `[WORKFLOW HARD RULES]` 블록을 Pi/Claude prompt에 주입합니다. 이 블록은 현재 phase 준수, phase skip 금지, implement/push 전 승인, code_review 내부 fix loop, subagent 우선 사용, main context 최소화를 간결하게 상기시킵니다.

`implement`, `code_review`, `document`, `commit`에서는 현재 phase의 `[CONTEXT STRATEGY]`도 함께 주입합니다. main agent가 보관할 요약, 피해야 할 raw context, subagent 반환 형식을 짧게 표시합니다.

---

## Hard guards

hard guard는 자동 진행 중에도 우회할 수 없습니다.

| Guard | 위치 | 의미 |
|---|---|---|
| DPAA | `plan_review → implement` | 사용자 승인창 표시 전 계획 모호성/검증 가능성 검사. acceptance는 숫자 metric뿐 아니라 `command exits 0`, `tests pass`, `README updated`, `no blockers/errors` 같은 binary/observable 조건도 검증 가능 조건으로 인정합니다. `FAIL`은 `plan`으로 자동 복귀해 수정하고, `WARN`은 advisory로 표시하되 전이는 허용 |
| Code quality | review package 제출 시 | `codeQualityGuard` 또는 설정된 품질 명령 실행 |
| Workspace | `git push` | workflow 시작 workspace/branch와 현재 상태 일치 검사 |
| Push policy scan | `commit → push`, `git push` | 위험 변경 확인 |
| Push phase | `git push` | 현재 workflow phase가 `push`인지 검사 |
| Review completion | `code_review → review_approved`, `commit → push` | review package/quality gate와 순차 전이 이력으로 검사 |
| Extension modification approval | `.pi/extensions/**` 수정 | 사용자 승인 없는 extension 수정 차단 |

Guard block 메시지는 `Why blocked`, `Default handling for the LLM`, `Next actions`, 조건부 `Exception path`, `Caution` 순서로 표시됩니다. `Exception path`는 skip 경로가 있는 guard에서만 표시됩니다. `Default handling for the LLM`은 skip-first 금지, 수정 가능한 실패의 원인 수정 후 재시도, 사용자 질문 조건 제한을 먼저 제시합니다. Workspace guard는 파일 수정·workflow state 변경·evidence 시뮬레이션을 금지하고 올바른 directory/branch 복귀를 요청합니다. Policy-scan guard는 위험 변경을 숨기거나 조용히 수정하지 말고 위험 요약과 interactive policy approval path를 제시하도록 안내합니다.

예외적으로 gate를 건너뛰려면 명시적 skip이 필요합니다. 정상 경로에서는 token 발급을 권한 증명으로 삼지 않고, workflow의 현재 phase와 허용된 다음 전이 여부를 기준으로 판단합니다. guard token CustomEntry는 audit-only이며 session restart 뒤 runtime 권한으로 복원하지 않습니다. 사용자가 gate skip을 명시적으로 승인한 경우 LLM은 slash command를 대신 실행할 수 없으므로 `workflow_skip_gate` tool로 동일한 1회성 accepted-risk 예외를 기록할 수 있습니다. 두 경로 모두 TUI 확인창을 거치며, skip 후에는 다시 `workflow_approve`로 전이를 재시도해야 합니다. `/workflow state <phase>`는 phase만 복구하고 DPAA/code review/push guard evidence를 생성하지 않습니다. 대화형 UI가 없는 세션에서는 accepted-risk skip, `/workflow state`, `/workflow abort`처럼 사용자 승인이 필요한 복구/파괴적 명령을 승인하지 않습니다.

```text
/workflow skip <dpaa|code-quality|policy-scan> <reason>
workflow_skip_gate(gate, reason)
```

---

## Push 정책

`commit → push`로 넘어갈 때 push 의사와 위험 변경을 함께 확인합니다.

```text
commit → push
  └─ 위험 변경 있으면 policy scan confirmation
```

실제 `git push` 시에는 다시 scan합니다.

```text
동일 workspace risk signature → 추가 확인 없이 통과
변경사항이 달라짐 → 다시 확인 또는 차단
```

즉 같은 위험 변경에 대해 중복으로 묻지 않지만, 승인 후 workspace가 바뀌면 다시 확인합니다.

---

## Extension 수정 보호

다음 경로를 수정하려면 사용자 승인이 필요합니다.

```text
.pi/extensions/**
```

이 harness 개발 저장소에서 `target/.pi/extensions/**`는 배포 템플릿 소스이므로 일반 개발 대상입니다. 설치된 프로젝트의 실행 runtime인 `.pi/extensions/**`만 보호 승인 대상입니다.

조회는 허용됩니다.

```text
rg/read/grep 등
```

하지만 수정성 tool call은 승인 없이는 차단됩니다.

```text
edit/write/apply_patch
bash rm/mv/cp/sed -i/tee/> 등
```

승인은 파일이 아니라 extension in-memory에서 해당 tool call 1회에만 적용됩니다. 승인 파일이나 token 파일은 신뢰하지 않습니다.

---

## Field failure logs

하네스가 적용된 프로젝트에서는 gate 실패/skip/정책 차단 등 factual failure event를 로컬에 기록합니다.

```text
.project-memory/harness/events.jsonl
.project-memory/harness/exports/
```

확인:

```text
/workflow failures
```

redacted export:

```text
/workflow failures export
```

`.project-memory/`는 첫 write 시 `.git/info/exclude`에 추가되어 실수로 commit되지 않도록 보호됩니다.

---

## External memory

memory component는 별도 저장소를 사용합니다.

```text
.project-memory/memory/
  entries.jsonl
  metrics.jsonl
  feedback.jsonl
  injection-state.json
```

현재 MVP 명령:

```text
/memory remember <durable project fact or decision>
/memory list
/memory search <query>
/memory show <id>
/memory disable <id>
/memory enable <id>
/memory delete <id>
/memory explain
/memory stats
/memory feedback <id> helpful|irrelevant|wrong|stale
/memory missed <query-or-description>
```

원칙:

```text
모든 memory를 매번 주입하지 않음
관련 top-N만 deterministic하게 주입
metrics에는 raw prompt가 아니라 hash/id/count 중심으로 기록
secret-like memory는 저장 거부
```

아직 의도적으로 자동화하지 않은 것:

```text
candidate 자동 추출
approve/reject workflow
merge/supersede/compact
AGENTS.md promotion
semantic/vector retrieval
```

---

## Customization boundary

### 의존성

| 의존성 | 용도 | 비고 |
|---|---|---|
| Python 3.10+ | DPAA, SBADR | 하네스가 venv 자동 생성 |
| Java 17+ | SBADR (CoreNLP) | 하네스가 CoreNLP 자동 설치 |
| git | 워크플로우 | 필수 |

### Upstream-managed

업데이트 시 하네스가 관리하고 덮어쓸 수 있는 영역입니다.

```text
.pi/extensions/
.pi/dpaa/
.pi/sbadr/
.pi/setup_corenlp.sh
.pi/setup_corenlp.ps1
.pi/workflows/
.pi/skills/
.pi/personas/
.pi/WORKFLOW.md
.pi/GOVERNANCE.md
.pi/pyproject.toml
.pi/schemas/
```

### Project-owned

프로젝트가 소유하고 유지하는 영역입니다.

```text
AGENTS.md
.pi/config/
.pi/local/
.pi/LOCAL.md
```

### Generated / ignored

```text
.pi/.venv/
.pi/.cache/
.pi/dpaa-runs/
.project-memory/
```

---

## 주요 명령

### Workflow

```text
/workflow start <title>
/workflow status
/workflow approve
/workflow doctor
/workflow failures
/workflow failures export
/workflow list
/workflow load <id>
/workflow unload
/workflow undo
/workflow redo
/workflow history
/workflow checkpoint
/workflow checkpoints
/workflow restore <id>
/workflow state <phase>
/workflow skip <gate> <reason>
/workflow abort
/workflow dpaa-audit
```

### Requirements discovery

```text
/requirements-room <feature-name or rough idea>
/feature-interview <feature-name or rough idea>
/feature-planning-room <feature-name or rough idea>
```

### Memory

```text
/memory remember <text>
/memory list
/memory search <query>
/memory show <id>
/memory disable <id>
/memory enable <id>
/memory explain
/memory stats
/memory feedback <id> helpful|irrelevant|wrong|stale
/memory missed <description>
```

---

## 개발 repo에서 템플릿 미리보기

이 repo에서 설치 템플릿을 미리 보려면:

```bash
cd target
pi
```

일반 사용에서는 대상 프로젝트 루트에서 initializer를 실행한 뒤 그 프로젝트에서 `pi`를 실행합니다.

---

## 다음 개선 후보

다음 항목은 의도적으로 이후 작업으로 남겨두었습니다.

```text
external memory 고도화
field log import/analyze workflow
macOS/Linux real E2E 검증
review automation 심화
```

자세한 내용은:

```text
docs/deferred-improvements.md
```
