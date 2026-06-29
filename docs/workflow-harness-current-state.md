# Workflow Harness 현재 상태

> 작성일: 2026-06-29  
> 범위: Pi workflow harness의 현재 운영 모델, guard/evidence 구조, 자동 전이 정책, 최근 정리된 승인 경계 버그 반영 상태  
> 기준 소스: `README.md`, `.harness/workflow-policy.json`, `target/.pi/extensions/workflow/**`

---

## 1. 한 문장 요약

Workflow harness는 AI coding agent를 “자율적으로 움직이는 실행자”로 두되, phase, guard, evidence, review package, policy scan으로 감싸서 **검증 가능한 폐쇄 루프 안에서 작업을 끝내게 만드는 runtime controller**다.

핵심은 다음 세 가지다.

1. **자동 진행은 넓게 허용한다.**
   - `interview → plan → plan_review → implement`
   - `implement → code_review`
   - `review_approved → document → commit`
2. **사용자 승인은 위험 경계 하나에 집중한다.**
   - 현재 유일한 사용자 승인 경계: `commit → push`
3. **실패는 사용자에게 넘기기 전에 repair loop로 되돌린다.**
   - DPAA/SBADR 실패: `plan_review → plan`
   - review/quality 실패: `code_review → implement`

---

## 2. 현재 phase 모델

<svg width="980" height="150" viewBox="0 0 980 150" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Workflow phase model">
  <defs>
    <marker id="arrow-phase" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#334155" />
    </marker>
    <style>
      .phase { fill:#eff6ff; stroke:#2563eb; stroke-width:1.5; rx:12; }
      .phaseText { font: 13px sans-serif; fill:#0f172a; text-anchor:middle; dominant-baseline:middle; }
      .arrow { stroke:#334155; stroke-width:1.5; marker-end:url(#arrow-phase); }
      .note { font: 12px sans-serif; fill:#475569; text-anchor:middle; }
    </style>
  </defs>
  <text x="490" y="22" class="note">기본 phase 순서</text>
  <g transform="translate(20,50)">
    <rect class="phase" x="0" y="0" width="85" height="44" />
    <text class="phaseText" x="42.5" y="22">interview</text>
    <line class="arrow" x1="88" y1="22" x2="113" y2="22" />
    <rect class="phase" x="116" y="0" width="70" height="44" />
    <text class="phaseText" x="151" y="22">plan</text>
    <line class="arrow" x1="189" y1="22" x2="214" y2="22" />
    <rect class="phase" x="217" y="0" width="95" height="44" />
    <text class="phaseText" x="264.5" y="22">plan_review</text>
    <line class="arrow" x1="315" y1="22" x2="340" y2="22" />
    <rect class="phase" x="343" y="0" width="90" height="44" />
    <text class="phaseText" x="388" y="22">implement</text>
    <line class="arrow" x1="436" y1="22" x2="461" y2="22" />
    <rect class="phase" x="464" y="0" width="95" height="44" />
    <text class="phaseText" x="511.5" y="22">code_review</text>
    <line class="arrow" x1="562" y1="22" x2="587" y2="22" />
    <rect class="phase" x="590" y="0" width="120" height="44" />
    <text class="phaseText" x="650" y="22">review_approved</text>
    <line class="arrow" x1="713" y1="22" x2="738" y2="22" />
    <rect class="phase" x="741" y="0" width="85" height="44" />
    <text class="phaseText" x="783.5" y="22">document</text>
    <line class="arrow" x1="829" y1="22" x2="854" y2="22" />
    <rect class="phase" x="857" y="0" width="70" height="44" />
    <text class="phaseText" x="892" y="22">commit</text>
  </g>
  <g transform="translate(360,112)">
    <rect class="phase" x="0" y="0" width="70" height="34" />
    <text class="phaseText" x="35" y="17">push</text>
    <line class="arrow" x1="73" y1="17" x2="108" y2="17" />
    <rect class="phase" x="112" y="0" width="70" height="34" />
    <text class="phaseText" x="147" y="17">done</text>
    <text class="note" x="91" y="-12">commit → push 승인 후 실제 push 성공 시 완료</text>
  </g>
</svg>

현재 phase 목록은 `.harness/workflow-policy.json`의 `phases`가 source of truth다.

```text
interview → plan → plan_review → implement → code_review → review_approved → document → commit → push → done
```

---

## 3. 자동 전이와 사용자 승인 경계

<svg width="980" height="250" viewBox="0 0 980 250" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Automatic segments and approval boundary">
  <defs>
    <marker id="arrow-auto" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#0f766e" />
    </marker>
    <marker id="arrow-risk" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#dc2626" />
    </marker>
    <style>
      .box { rx:14; stroke-width:1.5; }
      .autoBox { fill:#ecfdf5; stroke:#0f766e; }
      .riskBox { fill:#fef2f2; stroke:#dc2626; }
      .gateBox { fill:#fff7ed; stroke:#ea580c; }
      .label { font: 14px sans-serif; fill:#0f172a; text-anchor:middle; dominant-baseline:middle; }
      .small { font: 12px sans-serif; fill:#475569; text-anchor:middle; }
      .autoLine { stroke:#0f766e; stroke-width:2; marker-end:url(#arrow-auto); }
      .riskLine { stroke:#dc2626; stroke-width:2.3; marker-end:url(#arrow-risk); }
    </style>
  </defs>
  <text x="490" y="25" class="small">승인 모델: 대부분은 자동 전이, 사용자의 명시 승인은 commit → push에 집중</text>

  <rect class="box autoBox" x="50" y="55" width="250" height="70" />
  <text class="label" x="175" y="82">자동 준비 체인</text>
  <text class="small" x="175" y="105">interview → plan → plan_review</text>

  <line class="autoLine" x1="305" y1="90" x2="375" y2="90" />

  <rect class="box gateBox" x="380" y="55" width="220" height="70" />
  <text class="label" x="490" y="82">DPAA/SBADR gate</text>
  <text class="small" x="490" y="105">PASS면 implement 자동 진입</text>

  <line class="autoLine" x1="605" y1="90" x2="675" y2="90" />

  <rect class="box autoBox" x="680" y="55" width="250" height="70" />
  <text class="label" x="805" y="82">자동 실행/문서 체인</text>
  <text class="small" x="805" y="105">implement → review → document → commit</text>

  <rect class="box riskBox" x="350" y="160" width="280" height="65" />
  <text class="label" x="490" y="185">유일한 사용자 승인 경계</text>
  <text class="small" x="490" y="207">commit → push</text>

  <line class="riskLine" x1="805" y1="130" x2="625" y2="180" />
  <line class="riskLine" x1="490" y1="225" x2="490" y2="242" />
</svg>

현재 정책상 `approvalBoundaries`는 다음 하나뿐이다.

```json
["commit:push"]
```

중요한 정리:

- `plan_review → implement`는 사용자 승인 경계가 아니다.
- `plan_review → implement`는 DPAA/SBADR gate가 통과하면 자동 전이된다.
- `commit → push`에서만 TUI yes/no 승인과 policy scan이 결합된다.

---

## 4. Closed loop: 실패 시 복구 루프

<svg width="980" height="360" viewBox="0 0 980 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Repair loops">
  <defs>
    <marker id="arrow-loop" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#7c3aed" />
    </marker>
    <style>
      .node { fill:#f5f3ff; stroke:#7c3aed; stroke-width:1.5; rx:14; }
      .gate { fill:#fffbeb; stroke:#d97706; stroke-width:1.5; rx:14; }
      .ok { fill:#ecfdf5; stroke:#059669; stroke-width:1.5; rx:14; }
      .text { font: 14px sans-serif; fill:#111827; text-anchor:middle; dominant-baseline:middle; }
      .hint { font: 12px sans-serif; fill:#4b5563; text-anchor:middle; }
      .line { stroke:#7c3aed; stroke-width:2; fill:none; marker-end:url(#arrow-loop); }
      .pass { stroke:#059669; stroke-width:2; fill:none; marker-end:url(#arrow-loop); }
      .fail { stroke:#dc2626; stroke-width:2; fill:none; marker-end:url(#arrow-loop); }
    </style>
  </defs>

  <text x="490" y="25" class="hint">Closed loop는 선택된 목표를 완료 조건까지 수렴시키는 루프다.</text>

  <rect class="node" x="70" y="65" width="150" height="55" />
  <text class="text" x="145" y="92">plan</text>
  <rect class="gate" x="310" y="65" width="170" height="55" />
  <text class="text" x="395" y="92">plan_review</text>
  <rect class="gate" x="570" y="65" width="170" height="55" />
  <text class="text" x="655" y="92">DPAA/SBADR</text>
  <rect class="ok" x="815" y="65" width="120" height="55" />
  <text class="text" x="875" y="92">implement</text>

  <path class="line" d="M220 92 H305" />
  <path class="line" d="M480 92 H565" />
  <path class="pass" d="M740 92 H810" />
  <path class="fail" d="M655 122 C655 190, 145 190, 145 125" />
  <text class="hint" x="400" y="180">FAIL → plan으로 자동 복귀 → 모호성/검증 가능성 보수 → 재시도</text>

  <rect class="node" x="70" y="250" width="150" height="55" />
  <text class="text" x="145" y="277">implement</text>
  <rect class="gate" x="310" y="250" width="170" height="55" />
  <text class="text" x="395" y="277">code_review</text>
  <rect class="gate" x="570" y="250" width="170" height="55" />
  <text class="text" x="655" y="277">review + quality</text>
  <rect class="ok" x="815" y="250" width="120" height="55" />
  <text class="text" x="875" y="277">document</text>

  <path class="line" d="M220 277 H305" />
  <path class="line" d="M480 277 H565" />
  <path class="pass" d="M740 277 H810" />
  <path class="fail" d="M655 250 C655 205, 145 205, 145 245" />
  <text class="hint" x="420" y="225">Critical/Major 또는 품질 실패 → implement로 복귀 → 수정 → 재리뷰</text>
</svg>

현재 하네스는 실패를 “대화로 넘기는 이벤트”가 아니라 “다음 수정 위치로 되돌리는 상태 전이”로 취급한다.

| 실패 지점 | 자동 복귀 | LLM 기본 행동 |
|---|---|---|
| DPAA/SBADR fail | `plan_review → plan` | 계획 문장, metric, 참조, 모호성을 고치고 재시도 |
| 품질 gate fail | `code_review → implement` | 원인 수정 후 테스트/품질 재실행 |
| Critical/Major review finding | `code_review → implement` | 지적 위치 수정 후 리뷰 루프 재진입 |
| push policy fail | `commit` 유지 | 위험 요약, 승인/수정, 재시도 |

---

## 5. Guard와 Evidence 구조

<svg width="980" height="360" viewBox="0 0 980 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Guard evidence matrix">
  <defs>
    <style>
      .header { fill:#0f172a; }
      .htext { font: 13px sans-serif; fill:white; text-anchor:middle; dominant-baseline:middle; font-weight:700; }
      .cell { fill:#ffffff; stroke:#cbd5e1; stroke-width:1; }
      .soft { fill:#f8fafc; stroke:#cbd5e1; stroke-width:1; }
      .gate { fill:#fff7ed; stroke:#fb923c; stroke-width:1; }
      .ev { fill:#ecfdf5; stroke:#10b981; stroke-width:1; }
      .txt { font: 12px sans-serif; fill:#0f172a; text-anchor:middle; dominant-baseline:middle; }
      .small { font: 11px sans-serif; fill:#475569; text-anchor:middle; dominant-baseline:middle; }
    </style>
  </defs>
  <text x="490" y="25" class="small">Guard는 전이를 막고, Evidence는 전이 권한을 증명한다.</text>

  <rect class="header" x="40" y="50" width="180" height="34" />
  <text class="htext" x="130" y="67">Transition</text>
  <rect class="header" x="220" y="50" width="220" height="34" />
  <text class="htext" x="330" y="67">Guard</text>
  <rect class="header" x="440" y="50" width="260" height="34" />
  <text class="htext" x="570" y="67">Evidence</text>
  <rect class="header" x="700" y="50" width="240" height="34" />
  <text class="htext" x="820" y="67">Failure handling</text>

  <rect class="soft" x="40" y="84" width="180" height="52" /><text class="txt" x="130" y="110">interview → plan</text>
  <rect class="gate" x="220" y="84" width="220" height="52" /><text class="txt" x="330" y="103">interview ambiguity</text><text class="small" x="330" y="121">clarity scores ≥ 60</text>
  <rect class="ev" x="440" y="84" width="260" height="52" /><text class="txt" x="570" y="110">workflow_score_interview token</text>
  <rect class="cell" x="700" y="84" width="240" height="52" /><text class="txt" x="820" y="110">follow-up interview</text>

  <rect class="soft" x="40" y="136" width="180" height="52" /><text class="txt" x="130" y="162">plan_review → implement</text>
  <rect class="gate" x="220" y="136" width="220" height="52" /><text class="txt" x="330" y="155">DPAA/SBADR</text><text class="small" x="330" y="173">plan quality + ambiguity</text>
  <rect class="ev" x="440" y="136" width="260" height="52" /><text class="txt" x="570" y="162">DPAA guard token + receipt</text>
  <rect class="cell" x="700" y="136" width="240" height="52" /><text class="txt" x="820" y="162">return to plan</text>

  <rect class="soft" x="40" y="188" width="180" height="52" /><text class="txt" x="130" y="214">code_review → approved</text>
  <rect class="gate" x="220" y="188" width="220" height="52" /><text class="txt" x="330" y="207">review + quality</text><text class="small" x="330" y="225">Critical=0, Major≤2</text>
  <rect class="ev" x="440" y="188" width="260" height="52" /><text class="txt" x="570" y="214">submit_review_package</text>
  <rect class="cell" x="700" y="188" width="240" height="52" /><text class="txt" x="820" y="214">return to implement</text>

  <rect class="soft" x="40" y="240" width="180" height="52" /><text class="txt" x="130" y="266">commit → push</text>
  <rect class="gate" x="220" y="240" width="220" height="52" /><text class="txt" x="330" y="259">policy scan</text><text class="small" x="330" y="277">risk + dirty tracked files</text>
  <rect class="ev" x="440" y="240" width="260" height="52" /><text class="txt" x="570" y="266">push execution approval</text>
  <rect class="cell" x="700" y="240" width="240" height="52" /><text class="txt" x="820" y="266">user approval / fix</text>

  <rect class="soft" x="40" y="292" width="180" height="52" /><text class="txt" x="130" y="318">push → done</text>
  <rect class="gate" x="220" y="292" width="220" height="52" /><text class="txt" x="330" y="311">push phase guard</text><text class="small" x="330" y="329">actual git push only</text>
  <rect class="ev" x="440" y="292" width="260" height="52" /><text class="txt" x="570" y="318">successful push result</text>
  <rect class="cell" x="700" y="292" width="240" height="52" /><text class="txt" x="820" y="318">stay in push until success</text>
</svg>

Evidence는 “토큰이 있으니 권한이 있다”가 아니라, 현재 workflow phase와 정상 전이 이력, gate 결과를 함께 확인하는 보조 증거다. 정책 source of truth는 `.harness/workflow-policy.json`의 phase/transition policy다.

---

## 6. Runtime 구성도

<svg width="980" height="420" viewBox="0 0 980 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Runtime architecture">
  <defs>
    <marker id="arrow-arch" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#334155" />
    </marker>
    <style>
      .layer { fill:#f8fafc; stroke:#64748b; stroke-width:1.5; rx:18; }
      .module { fill:white; stroke:#94a3b8; stroke-width:1; rx:10; }
      .app { fill:#eff6ff; stroke:#2563eb; }
      .domain { fill:#fefce8; stroke:#ca8a04; }
      .runtime { fill:#f0fdf4; stroke:#16a34a; }
      .storage { fill:#fdf2f8; stroke:#db2777; }
      .txt { font: 13px sans-serif; fill:#0f172a; text-anchor:middle; dominant-baseline:middle; }
      .title { font: 15px sans-serif; fill:#0f172a; text-anchor:middle; dominant-baseline:middle; font-weight:700; }
      .line { stroke:#334155; stroke-width:1.4; marker-end:url(#arrow-arch); fill:none; }
    </style>
  </defs>

  <rect class="layer runtime" x="40" y="45" width="900" height="70" />
  <text class="title" x="490" y="68">Pi Runtime Adapter</text>
  <rect class="module runtime" x="80" y="80" width="170" height="28" /><text class="txt" x="165" y="94">workflow.ts entrypoint</text>
  <rect class="module runtime" x="280" y="80" width="170" height="28" /><text class="txt" x="365" y="94">runtime-ui.ts</text>
  <rect class="module runtime" x="480" y="80" width="170" height="28" /><text class="txt" x="565" y="94">runtime-policy.ts</text>
  <rect class="module runtime" x="680" y="80" width="200" height="28" /><text class="txt" x="780" y="94">runtime-state.ts</text>

  <rect class="layer app" x="40" y="145" width="900" height="95" />
  <text class="title" x="490" y="168">Application / Use-case Layer</text>
  <rect class="module app" x="70" y="185" width="180" height="32" /><text class="txt" x="160" y="201">workflow-command-router</text>
  <rect class="module app" x="270" y="185" width="150" height="32" /><text class="txt" x="345" y="201">tool-call-gate</text>
  <rect class="module app" x="440" y="185" width="135" height="32" /><text class="txt" x="507" y="201">continuation</text>
  <rect class="module app" x="595" y="185" width="150" height="32" /><text class="txt" x="670" y="201">prompt-context</text>
  <rect class="module app" x="765" y="185" width="145" height="32" /><text class="txt" x="837" y="201">mutation approval</text>

  <rect class="layer domain" x="40" y="270" width="430" height="95" />
  <text class="title" x="255" y="293">Domain Policy</text>
  <rect class="module domain" x="75" y="315" width="170" height="32" /><text class="txt" x="160" y="331">ambiguity-gate-policy</text>
  <rect class="module domain" x="265" y="315" width="170" height="32" /><text class="txt" x="350" y="331">production-class-policy</text>

  <rect class="layer storage" x="510" y="270" width="430" height="95" />
  <text class="title" x="725" y="293">State / Artifacts / Logs</text>
  <rect class="module storage" x="545" y="315" width="100" height="32" /><text class="txt" x="595" y="331">state</text>
  <rect class="module storage" x="660" y="315" width="100" height="32" /><text class="txt" x="710" y="331">artifacts</text>
  <rect class="module storage" x="775" y="315" width="130" height="32" /><text class="txt" x="840" y="331">field-log</text>

  <path class="line" d="M490 115 V142" />
  <path class="line" d="M490 240 V267" />
  <path class="line" d="M510 240 C560 255, 640 260, 710 270" />
</svg>

현재 구현은 `workflow.ts`를 entrypoint와 조립 계층으로 두고, 세부 책임을 `target/.pi/extensions/workflow/` 아래로 분리한다.

| 영역 | 대표 파일 | 책임 |
|---|---|---|
| Runtime wiring | `workflow.ts`, `runtime-ui.ts`, `runtime-policy.ts` | Pi 이벤트, TUI, active tool policy 연결 |
| Application | `application/workflow-command-router.ts`, `application/tool-call-gate.ts` | slash command, tool call, continuation, prompt 조립 |
| Domain policy | `domain/ambiguity-gate-policy.ts`, `domain/production-class-policy.ts` | 순수 정책 판단 |
| Gate/transition | `gates.ts`, `transitions.ts`, `gate-runner.ts` | 전이 전 검사, 실패 메시지, repair loop |
| Evidence/log | `runtime-state.ts`, `field-log.ts`, `artifacts.ts` | guard token, field log, artifact descriptor |

---

## 7. LLM-facing prompt 계약

<svg width="980" height="300" viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Prompt contract">
  <defs>
    <marker id="arrow-prompt" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#475569" />
    </marker>
    <style>
      .source { fill:#eef2ff; stroke:#4f46e5; stroke-width:1.4; rx:14; }
      .prompt { fill:#f8fafc; stroke:#64748b; stroke-width:1.4; rx:14; }
      .agent { fill:#ecfdf5; stroke:#059669; stroke-width:1.4; rx:14; }
      .txt { font: 13px sans-serif; fill:#111827; text-anchor:middle; dominant-baseline:middle; }
      .small { font: 11px sans-serif; fill:#475569; text-anchor:middle; dominant-baseline:middle; }
      .line { stroke:#475569; stroke-width:1.6; fill:none; marker-end:url(#arrow-prompt); }
    </style>
  </defs>

  <text x="490" y="26" class="small">LLM은 정책 파일을 직접 해석하기보다, runtime이 생성하는 prompt 계약을 따라 움직인다.</text>

  <rect class="source" x="55" y="70" width="190" height="60" />
  <text class="txt" x="150" y="92">workflow policy</text>
  <text class="small" x="150" y="112">phase / approval / hard rules</text>

  <rect class="source" x="55" y="170" width="190" height="60" />
  <text class="txt" x="150" y="192">runtime state</text>
  <text class="small" x="150" y="212">phase / tokens / failures</text>

  <rect class="prompt" x="360" y="70" width="260" height="60" />
  <text class="txt" x="490" y="92">[LLM WORKFLOW ACTION]</text>
  <text class="small" x="490" y="112">current phase + required action</text>

  <rect class="prompt" x="360" y="170" width="260" height="60" />
  <text class="txt" x="490" y="192">guard memory/status</text>
  <text class="small" x="490" y="212">evidence + actionable failure</text>

  <rect class="agent" x="750" y="120" width="170" height="70" />
  <text class="txt" x="835" y="145">LLM behavior</text>
  <text class="small" x="835" y="166">advance / fix / review / ask</text>

  <path class="line" d="M245 100 H355" />
  <path class="line" d="M245 200 H355" />
  <path class="line" d="M620 100 C680 105, 705 125, 745 145" />
  <path class="line" d="M620 200 C680 195, 705 175, 745 160" />
</svg>

최근 수정으로 prompt 계약에서 중요한 불일치가 제거됐다.

| 이전 문제 | 현재 상태 |
|---|---|
| `plan_review → implement`를 사용자 승인 경계로 안내 | DPAA/SBADR 자동 gate로 안내 |
| `yes/no dialog before implementation` 표현 | 제거됨 |
| `implementation approval dialog` 표현 | 제거됨 |
| `present the plan for approval` 표현 | 제거됨 |
| 사용자 승인 경계 설명 | `commit → push`만 명시 |

---

## 8. Open loop / Closed loop 관점에서 본 현재 위치

<svg width="980" height="360" viewBox="0 0 980 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Open and closed loop current state">
  <defs>
    <marker id="arrow-loop2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#0f172a" />
    </marker>
    <style>
      .open { fill:#eef2ff; stroke:#4f46e5; stroke-width:1.5; rx:16; }
      .closed { fill:#ecfdf5; stroke:#059669; stroke-width:1.5; rx:16; }
      .future { fill:#fff7ed; stroke:#ea580c; stroke-width:1.5; rx:16; }
      .txt { font: 14px sans-serif; fill:#111827; text-anchor:middle; dominant-baseline:middle; }
      .small { font: 12px sans-serif; fill:#475569; text-anchor:middle; dominant-baseline:middle; }
      .line { stroke:#0f172a; stroke-width:1.6; fill:none; marker-end:url(#arrow-loop2); }
      .dash { stroke:#94a3b8; stroke-width:1.5; stroke-dasharray:6 5; fill:none; marker-end:url(#arrow-loop2); }
    </style>
  </defs>

  <text x="490" y="25" class="small">현재 harness는 closed loop delivery가 강하고, open loop discovery는 다음 확장 지점이다.</text>

  <rect class="open" x="65" y="80" width="240" height="100" />
  <text class="txt" x="185" y="110">Open loop discovery</text>
  <text class="small" x="185" y="136">다음 문제/개선/기능 후보 탐색</text>
  <text class="small" x="185" y="158">현재: 개념 정리 단계</text>

  <rect class="closed" x="370" y="80" width="240" height="100" />
  <text class="txt" x="490" y="110">Closed loop delivery</text>
  <text class="small" x="490" y="136">선택된 목표를 gate까지 수렴</text>
  <text class="small" x="490" y="158">현재: 구현되어 동작 중</text>

  <rect class="future" x="675" y="80" width="240" height="100" />
  <text class="txt" x="795" y="110">Future orchestrator</text>
  <text class="small" x="795" y="136">discover → select → workflow start</text>
  <text class="small" x="795" y="158">후보: /workflow discover</text>

  <path class="dash" d="M305 130 H365" />
  <path class="line" d="M610 130 H670" />

  <rect class="closed" x="250" y="240" width="480" height="70" />
  <text class="txt" x="490" y="264">현재 안정화된 핵심</text>
  <text class="small" x="490" y="288">interview → plan → gate → implement → review → document → commit → push</text>
  <path class="line" d="M490 180 V235" />
</svg>

현재 harness는 closed loop delivery에 집중되어 있다. 즉, 사용자가 선택한 작업을 완료 조건까지 밀어붙이는 구조는 이미 강하다.

Open loop discovery는 아직 별도 phase나 명령으로 정식 구현되지는 않았다. 다만 다음 확장 지점은 명확하다.

- `/workflow discover`
- 후보 작업 backlog 생성
- 가치/위험/크기 평가
- 사용자가 선택한 후보를 기존 workflow closed loop로 전달

---

## 9. 현재 강점

<svg width="980" height="300" viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current strengths">
  <defs>
    <style>
      .card { fill:#ffffff; stroke:#cbd5e1; stroke-width:1.3; rx:16; }
      .top { fill:#ecfdf5; stroke:#059669; stroke-width:1.3; rx:16; }
      .txt { font: 14px sans-serif; fill:#0f172a; text-anchor:middle; dominant-baseline:middle; font-weight:700; }
      .small { font: 12px sans-serif; fill:#475569; text-anchor:middle; dominant-baseline:middle; }
      .score { font: 22px sans-serif; fill:#059669; text-anchor:middle; dominant-baseline:middle; font-weight:700; }
    </style>
  </defs>
  <text x="490" y="25" class="small">현재 상태 평가: 운영 가능한 closed-loop workflow controller</text>

  <rect class="card" x="55" y="65" width="180" height="170" />
  <text class="score" x="145" y="95">●</text>
  <text class="txt" x="145" y="128">Phase discipline</text>
  <text class="small" x="145" y="156">next phase only</text>
  <text class="small" x="145" y="178">manual state는 복구 전용</text>

  <rect class="card" x="280" y="65" width="180" height="170" />
  <text class="score" x="370" y="95">●</text>
  <text class="txt" x="370" y="128">Guard evidence</text>
  <text class="small" x="370" y="156">DPAA / review / policy</text>
  <text class="small" x="370" y="178">token은 audit 보조</text>

  <rect class="card" x="505" y="65" width="180" height="170" />
  <text class="score" x="595" y="95">●</text>
  <text class="txt" x="595" y="128">Repair loops</text>
  <text class="small" x="595" y="156">plan/code fix loop</text>
  <text class="small" x="595" y="178">skip-first 금지</text>

  <rect class="card" x="730" y="65" width="180" height="170" />
  <text class="score" x="820" y="95">●</text>
  <text class="txt" x="820" y="128">Prompt contract</text>
  <text class="small" x="820" y="156">LLM action block</text>
  <text class="small" x="820" y="178">stale steer guard</text>
</svg>

- phase 이동이 명확하다.
- 전이별 gate/evidence가 분리되어 있다.
- 실패 시 기본 처리 방침이 LLM-facing 메시지에 포함된다.
- code review는 사용자 승인 대신 review package와 quality gate를 요구한다.
- push는 실제 `git push` 성공 관측으로만 `done` 처리된다.

---

## 10. 현재 주의 지점

<svg width="980" height="320" viewBox="0 0 980 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current risks">
  <defs>
    <style>
      .risk { fill:#fff7ed; stroke:#ea580c; stroke-width:1.4; rx:14; }
      .warn { fill:#fef2f2; stroke:#dc2626; stroke-width:1.4; rx:14; }
      .txt { font: 14px sans-serif; fill:#111827; text-anchor:middle; dominant-baseline:middle; font-weight:700; }
      .small { font: 12px sans-serif; fill:#475569; text-anchor:middle; dominant-baseline:middle; }
    </style>
  </defs>
  <text x="490" y="25" class="small">안정화됐지만, 다음 정리 후보는 남아 있다.</text>

  <rect class="risk" x="70" y="60" width="250" height="85" />
  <text class="txt" x="195" y="88">문서 중복</text>
  <text class="small" x="195" y="112">README, target/.harness README, policy</text>
  <text class="small" x="195" y="130">동일 정책의 반복 설명이 많음</text>

  <rect class="risk" x="365" y="60" width="250" height="85" />
  <text class="txt" x="490" y="88">Prompt drift</text>
  <text class="small" x="490" y="112">LLM-facing 문구가 정책과 어긋나면</text>
  <text class="small" x="490" y="130">agent 행동이 다시 흔들릴 수 있음</text>

  <rect class="risk" x="660" y="60" width="250" height="85" />
  <text class="txt" x="785" y="88">Subagent reliability</text>
  <text class="small" x="785" y="112">독립 리뷰 subagent timeout 가능</text>
  <text class="small" x="785" y="130">inline dual review fallback 필요</text>

  <rect class="warn" x="215" y="190" width="250" height="85" />
  <text class="txt" x="340" y="218">DPAA runtime health</text>
  <text class="small" x="340" y="242">venv/package metadata 손상 시</text>
  <text class="small" x="340" y="260">gate report 생성 실패 가능</text>

  <rect class="warn" x="515" y="190" width="250" height="85" />
  <text class="txt" x="640" y="218">Open loop 부재</text>
  <text class="small" x="640" y="242">다음 개선 후보 자동 탐색은</text>
  <text class="small" x="640" y="260">아직 정식 기능이 아님</text>
</svg>

주의할 점은 기능 자체보다 **정책과 prompt 설명의 동기화**다. 방금 수정한 버그도 실제 정책은 `commit → push`만 승인 경계였지만, LLM-facing 문구가 오래된 모델을 설명해서 발생했다.

---

## 11. 최근 반영된 상태: approval boundary guidance fix

최근 반영된 정리 내용은 다음과 같다.

| 항목 | 이전 | 현재 |
|---|---|---|
| 사용자 승인 경계 | `plan_review → implement`, `commit → push`처럼 설명되는 곳이 있었음 | `commit → push`만 |
| plan_review action | plan approval / implementation approval dialog | DPAA/SBADR gate 실행 |
| DPAA fail message | user approval 전 실패처럼 표현 | automatic implementation transition 전 실패 |
| 테스트 fixture | 구현 승인 표현 포함 | DPAA 전이 표현으로 정리 |
| 회귀 테스트 | 일부 LLM action 문구만 확인 | stale approval 표현 금지까지 확인 |

검증된 상태:

```text
Targeted regression: 139 passed
Project test:        364 passed, 1 skipped
Code quality:        364 passed, 1 skipped
```

---

## 12. 다음 단계 후보

<svg width="980" height="300" viewBox="0 0 980 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Next steps roadmap">
  <defs>
    <marker id="arrow-road" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#334155" />
    </marker>
    <style>
      .step { fill:#f8fafc; stroke:#64748b; stroke-width:1.5; rx:14; }
      .now { fill:#ecfdf5; stroke:#059669; stroke-width:1.5; rx:14; }
      .next { fill:#eff6ff; stroke:#2563eb; stroke-width:1.5; rx:14; }
      .future { fill:#f5f3ff; stroke:#7c3aed; stroke-width:1.5; rx:14; }
      .txt { font: 14px sans-serif; fill:#111827; text-anchor:middle; dominant-baseline:middle; font-weight:700; }
      .small { font: 12px sans-serif; fill:#475569; text-anchor:middle; dominant-baseline:middle; }
      .line { stroke:#334155; stroke-width:1.7; marker-end:url(#arrow-road); }
    </style>
  </defs>

  <text x="490" y="25" class="small">README/블로그 개편 전, 코드와 운영 모델을 설명 가능한 상태로 더 정리하는 경로</text>

  <rect class="now" x="55" y="100" width="190" height="80" />
  <text class="txt" x="150" y="126">현재 완료</text>
  <text class="small" x="150" y="150">approval boundary 정합성</text>
  <text class="small" x="150" y="168">prompt drift 1차 제거</text>

  <line class="line" x1="248" y1="140" x2="325" y2="140" />

  <rect class="next" x="330" y="100" width="190" height="80" />
  <text class="txt" x="425" y="126">다음 cleanup</text>
  <text class="small" x="425" y="150">문서/policy 중복 축소</text>
  <text class="small" x="425" y="168">prompt contract 테스트 강화</text>

  <line class="line" x1="523" y1="140" x2="600" y2="140" />

  <rect class="future" x="605" y="100" width="190" height="80" />
  <text class="txt" x="700" y="126">컨셉 문서화</text>
  <text class="small" x="700" y="150">Loop Engineering README</text>
  <text class="small" x="700" y="168">기술 블로그 1편</text>

  <line class="line" x1="798" y1="140" x2="875" y2="140" />

  <rect class="step" x="880" y="100" width="85" height="80" />
  <text class="txt" x="922" y="126">Open</text>
  <text class="txt" x="922" y="146">Loop</text>
  <text class="small" x="922" y="168">discover</text>
</svg>

추천 순서:

1. **문구 source of truth 정리**
   - workflow policy, README, prompt action block 간 중복을 줄인다.
2. **prompt contract test 확대**
   - LLM 행동을 흔드는 문구는 테스트로 pinning한다.
3. **Loop Engineering README 개편**
   - open loop / closed loop / evidence / guard / repair loop 중심으로 재구성한다.
4. **기술 블로그 연재화**
   - “AI에게 맡기는 것이 아니라 루프를 설계한다”는 관점으로 현재 경험을 정리한다.
5. **Open loop discovery 실험**
   - `/workflow discover` 또는 별도 discovery artifact로 다음 문제/기능 후보를 생성한다.

---

## 13. 결론

현재 workflow harness는 다음 상태다.

- **Closed-loop delivery controller는 동작 가능한 수준으로 정리되어 있다.**
- **사용자 승인 경계는 `commit → push` 하나로 수렴했다.**
- **`plan_review → implement`는 DPAA/SBADR 자동 gate 전이다.**
- **review/quality 실패는 implement repair loop로 되돌아간다.**
- **push는 실제 push 성공 관측으로만 done 처리된다.**
- **다음 큰 주제는 open loop discovery와 문서/블로그용 개념 정리다.**

이 문서는 README 전면 개편과 기술 블로그 초안의 중간 산출물로 사용할 수 있다.
