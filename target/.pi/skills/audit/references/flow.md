# AI Audit Harness — 동작 플로우

---

## 전체 아키텍처

두 Session은 동시에 실행되지 않는다. 메인 Session이 `.ai/audit-input.md`를 생성하면 감사 Session이 읽고 판정한다.

<svg width="700" height="210" viewBox="0 0 700 210" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ah-g" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#6b7280"/>
    </marker>
    <marker id="ah-b" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#2563eb"/>
    </marker>
    <marker id="ah-p" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#7c3aed"/>
    </marker>
    <marker id="ah-gr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#059669"/>
    </marker>
  </defs>

  <!-- 메인 Session -->
  <rect x="10" y="30" width="185" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <line x1="10" y1="58" x2="195" y2="58" stroke="#2563eb" stroke-width="2"/>
  <text x="102" y="50" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#1d4ed8">메인 Session</text>
  <text x="102" y="78" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#1e40af">코드 작성 · 커밋</text>
  <text x="102" y="97" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#1e40af">run 로그 수집</text>
  <text x="102" y="116" text-anchor="middle" font-family="monospace" font-size="10" fill="#1e40af">cli.mjs input</text>
  <text x="102" y="135" text-anchor="middle" font-family="monospace" font-size="10" fill="#1e40af">cli.mjs save-review</text>
  <text x="102" y="154" text-anchor="middle" font-family="monospace" font-size="10" fill="#1e40af">cli.mjs mark-reviewed</text>
  <text x="102" y="173" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6b7280">구현자 역할</text>

  <!-- git repo / .ai/ -->
  <rect x="257" y="15" width="186" height="180" rx="10" fill="#f0fdf4" stroke="#059669" stroke-width="2"/>
  <line x1="257" y1="43" x2="443" y2="43" stroke="#059669" stroke-width="2"/>
  <text x="350" y="35" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#065f46">git repo / .ai/</text>
  <text x="350" y="65" text-anchor="middle" font-family="monospace" font-size="10" fill="#047857">audit-input.md</text>
  <text x="350" y="84" text-anchor="middle" font-family="monospace" font-size="10" fill="#047857">reviews/</text>
  <text x="350" y="103" text-anchor="middle" font-family="monospace" font-size="10" fill="#047857">runs/</text>
  <text x="350" y="122" text-anchor="middle" font-family="monospace" font-size="10" fill="#047857">spec.md</text>
  <text x="350" y="141" text-anchor="middle" font-family="monospace" font-size="10" fill="#047857">refs/ai/reviewer/</text>
  <text x="350" y="160" text-anchor="middle" font-family="monospace" font-size="10" fill="#047857">  last-reviewed</text>

  <!-- 감사 Session -->
  <rect x="505" y="30" width="185" height="150" rx="10" fill="#faf5ff" stroke="#7c3aed" stroke-width="2"/>
  <line x1="505" y1="58" x2="690" y2="58" stroke="#7c3aed" stroke-width="2"/>
  <text x="592" y="50" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#5b21b6">감사 Session</text>
  <text x="592" y="78" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5b21b6">audit-input.md 읽기</text>
  <text x="592" y="97" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5b21b6">diff / log 분석</text>
  <text x="592" y="116" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5b21b6">판정 결정</text>
  <text x="592" y="135" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#5b21b6">보고서 → stdout</text>
  <text x="592" y="154" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#dc2626">파일 수정 금지</text>
  <text x="592" y="173" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#6b7280">감사자 역할</text>

  <!-- Main → .ai (input, dashed = async handoff) -->
  <line x1="195" y1="88" x2="254" y2="88" stroke="#2563eb" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ah-b)"/>
  <text x="224" y="80" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#2563eb">input →</text>

  <!-- .ai → Main (save-review) -->
  <line x1="257" y1="112" x2="198" y2="112" stroke="#059669" stroke-width="1.5" marker-end="url(#ah-gr)"/>
  <text x="227" y="128" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#059669">← review</text>

  <!-- .ai → Audit (read, dashed) -->
  <line x1="443" y1="88" x2="502" y2="88" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ah-p)"/>
  <text x="472" y="80" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#7c3aed">읽기 →</text>

  <!-- Audit → .ai (pipe) -->
  <line x1="505" y1="112" x2="446" y2="112" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#ah-p)"/>
  <text x="475" y="128" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#7c3aed">← pipe</text>
</svg>

---

## 메인 Session 플로우

<svg width="500" height="860" viewBox="0 0 500 860" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ms-arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#4b5563"/>
    </marker>
    <marker id="ms-arr-ok" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/>
    </marker>
    <marker id="ms-arr-no" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#dc2626"/>
    </marker>
  </defs>

  <!-- START -->
  <ellipse cx="250" cy="42" rx="62" ry="20" fill="#1f2937" stroke="#1f2937"/>
  <text x="250" y="47" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="white">START</text>

  <line x1="250" y1="62" x2="250" y2="76" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- init -->
  <rect x="90" y="76" width="320" height="48" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="1.5"/>
  <text x="250" y="96" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#1e40af">초기화 (한 번만)</text>
  <text x="250" y="114" text-anchor="middle" font-family="monospace" font-size="10" fill="#1e40af">node cli.mjs init</text>

  <line x1="250" y1="124" x2="250" y2="138" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- reset-reviewed -->
  <rect x="90" y="138" width="320" height="48" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="1.5"/>
  <text x="250" y="158" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#1e40af">Baseline 설정 (한 번만)</text>
  <text x="250" y="176" text-anchor="middle" font-family="monospace" font-size="10" fill="#1e40af">node cli.mjs reset-reviewed HEAD</text>

  <line x1="250" y1="186" x2="250" y2="204" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- Dev Loop 그룹 -->
  <rect x="48" y="204" width="404" height="228" rx="8" fill="none" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="8,4"/>
  <text x="250" y="222" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#6b7280">↻  Dev Loop</text>

  <!-- 코드 작성 -->
  <rect x="100" y="228" width="300" height="40" rx="6" fill="#f9fafb" stroke="#9ca3af" stroke-width="1.5"/>
  <text x="250" y="253" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#374151">코드 작성</text>

  <line x1="250" y1="268" x2="250" y2="282" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- run -->
  <rect x="100" y="282" width="300" height="40" rx="6" fill="#1e3a5f" stroke="#1e3a5f" stroke-width="1"/>
  <text x="250" y="298" text-anchor="middle" font-family="monospace" font-size="11" fill="#93c5fd">node cli.mjs run -- &lt;cmd&gt;</text>
  <text x="250" y="314" text-anchor="middle" font-family="monospace" font-size="9" fill="#60a5fa">→ .ai/runs/에 로그 저장</text>

  <line x1="250" y1="322" x2="250" y2="336" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- git commit -->
  <rect x="100" y="336" width="300" height="40" rx="6" fill="#1e3a5f" stroke="#1e3a5f" stroke-width="1"/>
  <text x="250" y="352" text-anchor="middle" font-family="monospace" font-size="11" fill="#93c5fd">git commit -m "feat: ..."</text>
  <text x="250" y="368" text-anchor="middle" font-family="monospace" font-size="9" fill="#60a5fa">phase 완료 시 감사 요청으로</text>

  <line x1="250" y1="432" x2="250" y2="450" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- input -->
  <rect x="90" y="450" width="320" height="48" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
  <text x="250" y="470" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#065f46">감사 입력 생성</text>
  <text x="250" y="488" text-anchor="middle" font-family="monospace" font-size="10" fill="#065f46">node cli.mjs input → .ai/audit-input.md</text>

  <!-- 감사 Session 경계 -->
  <line x1="60" y1="514" x2="440" y2="514" stroke="#c4b5fd" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="250" y="528" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#7c3aed">── 감사 Session 실행 (별도 컨텍스트) ──</text>

  <line x1="250" y1="536" x2="250" y2="550" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- save-review -->
  <rect x="90" y="550" width="320" height="48" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>
  <text x="250" y="570" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#065f46">보고서 저장</text>
  <text x="250" y="588" text-anchor="middle" font-family="monospace" font-size="10" fill="#065f46">cli.mjs save-review &lt; report.md</text>

  <line x1="250" y1="598" x2="250" y2="616" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- verdict diamond -->
  <polygon points="250,616 390,652 250,688 110,652" fill="#fefce8" stroke="#ca8a04" stroke-width="1.5"/>
  <text x="250" y="649" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#92400e">verdict</text>
  <text x="250" y="666" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#92400e">== OK?</text>

  <!-- YES 경로 (아래) -->
  <line x1="250" y1="688" x2="250" y2="706" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ms-arr-ok)"/>
  <text x="265" y="700" font-family="sans-serif" font-size="10" fill="#16a34a">YES</text>

  <!-- mark-reviewed -->
  <rect x="90" y="706" width="320" height="48" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
  <text x="250" y="726" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#14532d">pointer 이동</text>
  <text x="250" y="744" text-anchor="middle" font-family="monospace" font-size="10" fill="#14532d">node cli.mjs mark-reviewed</text>

  <line x1="250" y1="754" x2="250" y2="770" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>

  <!-- END / NEXT -->
  <ellipse cx="250" cy="790" rx="80" ry="22" fill="#1f2937" stroke="#1f2937"/>
  <text x="250" y="795" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="white">다음 Phase</text>

  <!-- NO 경로 (왼쪽 루프백) -->
  <text x="104" y="644" text-anchor="end" font-family="sans-serif" font-size="10" fill="#dc2626">NO</text>
  <path d="M 110,652 L 32,652 L 32,268 L 100,268" fill="none" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ms-arr-no)"/>
  <text x="18" y="470" font-family="sans-serif" font-size="10" fill="#dc2626" transform="rotate(-90, 18, 470)">수정 후 재커밋</text>

  <!-- Dev Loop 하단 화살표 -->
  <line x1="250" y1="376" x2="250" y2="432" stroke="#4b5563" stroke-width="1.5" marker-end="url(#ms-arr)"/>
</svg>

---

## 감사 Session 플로우

감사 Session은 **읽기와 판정만** 수행한다. 파일 편집, 패치 제안, refs 이동은 모두 금지된다.

<svg width="500" height="560" viewBox="0 0 500 560" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="as-arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#4b5563"/>
    </marker>
    <marker id="as-ok" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/>
    </marker>
    <marker id="as-nc" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#dc2626"/>
    </marker>
  </defs>

  <!-- START -->
  <ellipse cx="250" cy="38" rx="100" ry="20" fill="#5b21b6" stroke="#5b21b6"/>
  <text x="250" y="43" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="white">audit-input.md 수신</text>

  <line x1="250" y1="58" x2="250" y2="72" stroke="#4b5563" stroke-width="1.5" marker-end="url(#as-arr)"/>

  <!-- 컨텍스트 파악 -->
  <rect x="60" y="72" width="380" height="80" rx="8" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="250" y="93" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#5b21b6">컨텍스트 파악</text>
  <text x="118" y="112" font-family="sans-serif" font-size="10" fill="#5b21b6">• auditor-persona — 역할·판정 규칙</text>
  <text x="118" y="128" font-family="sans-serif" font-size="10" fill="#5b21b6">• spec.md — 태스크 정의 · 성공 기준</text>
  <text x="118" y="143" font-family="sans-serif" font-size="10" fill="#5b21b6">• git log · diff · changed files</text>

  <line x1="250" y1="152" x2="250" y2="166" stroke="#4b5563" stroke-width="1.5" marker-end="url(#as-arr)"/>

  <!-- 5개 질문 검토 -->
  <rect x="60" y="166" width="380" height="110" rx="8" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="250" y="187" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#5b21b6">5개 질문 검토</text>
  <text x="118" y="206" font-family="sans-serif" font-size="10" fill="#5b21b6">1. 의도한 태스크를 해결했는가?</text>
  <text x="118" y="222" font-family="sans-serif" font-size="10" fill="#5b21b6">2. 필수 제약을 준수했는가?</text>
  <text x="118" y="238" font-family="sans-serif" font-size="10" fill="#5b21b6">3. 스코프를 이탈한 변경이 있는가?</text>
  <text x="118" y="254" font-family="sans-serif" font-size="10" fill="#5b21b6">4. 실제 검증 증거가 있는가?</text>
  <text x="118" y="270" font-family="sans-serif" font-size="10" fill="#5b21b6">5. 근거 없는 완료 주장을 하지 않았는가?</text>

  <line x1="250" y1="276" x2="250" y2="294" stroke="#4b5563" stroke-width="1.5" marker-end="url(#as-arr)"/>

  <!-- 판정 diamond -->
  <polygon points="250,294 400,330 250,366 100,330" fill="#fefce8" stroke="#ca8a04" stroke-width="1.5"/>
  <text x="250" y="327" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#92400e">verdict</text>
  <text x="250" y="344" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#92400e">== OK?</text>

  <!-- YES (오른쪽) -->
  <line x1="400" y1="330" x2="462" y2="330" stroke="#16a34a" stroke-width="1.5" marker-end="url(#as-ok)"/>
  <text x="428" y="322" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#16a34a">YES</text>
  <rect x="430" y="346" width="62" height="36" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
  <text x="461" y="360" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#14532d">OK</text>
  <text x="461" y="375" text-anchor="middle" font-family="sans-serif" font-size="8" fill="#14532d">pointer 이동 가능</text>

  <!-- NO (아래) -->
  <line x1="250" y1="366" x2="250" y2="384" stroke="#dc2626" stroke-width="1.5" marker-end="url(#as-nc)"/>
  <text x="264" y="379" font-family="sans-serif" font-size="10" fill="#dc2626">NO</text>

  <!-- NC / STOP 두 박스 -->
  <rect x="60" y="384" width="172" height="52" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="146" y="404" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#991b1b">Needs correction</text>
  <text x="146" y="420" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#991b1b">P1 이슈 — 수정 요청</text>
  <text x="146" y="433" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#991b1b">pointer 이동 금지</text>

  <rect x="268" y="384" width="172" height="52" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="354" y="404" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#991b1b">Stop and re-plan</text>
  <text x="354" y="420" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#991b1b">방향 자체가 틀림</text>
  <text x="354" y="433" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#991b1b">pointer 이동 금지</text>

  <!-- 양쪽 → 보고서 출력 -->
  <line x1="146" y1="436" x2="146" y2="466" stroke="#4b5563" stroke-width="1.5"/>
  <line x1="354" y1="436" x2="354" y2="466" stroke="#4b5563" stroke-width="1.5"/>
  <line x1="461" y1="382" x2="461" y2="466" stroke="#4b5563" stroke-width="1.5"/>
  <line x1="146" y1="466" x2="461" y2="466" stroke="#4b5563" stroke-width="1.5"/>
  <line x1="250" y1="466" x2="250" y2="482" stroke="#4b5563" stroke-width="1.5" marker-end="url(#as-arr)"/>

  <!-- 보고서 출력 -->
  <rect x="90" y="482" width="320" height="48" rx="8" fill="#f3f4f6" stroke="#6b7280" stroke-width="1.5"/>
  <text x="250" y="501" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#374151">보고서 → stdout</text>
  <text x="250" y="520" text-anchor="middle" font-family="monospace" font-size="10" fill="#374151">cli.mjs save-review &lt; 로 메인 Session에 전달</text>

  <!-- 금지 배너 -->
  <rect x="60" y="540" width="380" height="18" rx="4" fill="#fef2f2" stroke="#fca5a5" stroke-width="1"/>
  <text x="250" y="553" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#dc2626">⚠  파일 편집 금지  ·  패치 제안 금지  ·  refs 이동 금지</text>
</svg>

---

## refs 포인터 안전장치

`refs/ai/reviewer/last-reviewed`가 감사 범위의 경계선 역할을 한다.
OK 판정이 없으면 포인터는 이동하지 않는다.

<svg width="660" height="190" viewBox="0 0 660 190" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ptr-arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#2563eb"/>
    </marker>
    <marker id="ok-arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/>
    </marker>
  </defs>

  <!-- 시간축 -->
  <line x1="40" y1="80" x2="620" y2="80" stroke="#d1d5db" stroke-width="2"/>
  <text x="630" y="85" font-family="sans-serif" font-size="11" fill="#9ca3af">time</text>

  <!-- C1: reviewed -->
  <circle cx="100" cy="80" r="14" fill="#d1fae5" stroke="#059669" stroke-width="2"/>
  <text x="100" y="85" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#065f46">C1</text>
  <text x="100" y="103" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#6b7280">reviewed</text>

  <!-- C2: last-reviewed (before) -->
  <circle cx="200" cy="80" r="14" fill="#d1fae5" stroke="#059669" stroke-width="2"/>
  <text x="200" y="85" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#065f46">C2</text>
  <text x="200" y="103" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#6b7280">reviewed</text>

  <!-- C3: pending -->
  <circle cx="320" cy="80" r="14" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="320" y="85" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#991b1b">C3</text>
  <text x="320" y="103" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#dc2626">pending</text>

  <!-- C4: pending -->
  <circle cx="440" cy="80" r="14" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="85" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#991b1b">C4</text>
  <text x="440" y="103" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#dc2626">pending</text>

  <!-- C5: HEAD / pending -->
  <circle cx="560" cy="80" r="14" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="560" y="85" text-anchor="middle" font-family="monospace" font-size="10" font-weight="bold" fill="#991b1b">C5</text>
  <text x="560" y="100" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#dc2626">HEAD</text>
  <text x="560" y="112" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#dc2626">pending</text>

  <!-- audit range brace -->
  <line x1="214" y1="55" x2="546" y2="55" stroke="#7c3aed" stroke-width="1.5"/>
  <line x1="214" y1="55" x2="214" y2="66" stroke="#7c3aed" stroke-width="1.5"/>
  <line x1="546" y1="55" x2="546" y2="66" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="48" text-anchor="middle" font-family="sans-serif" font-size="10" fill="#7c3aed">감사 대상 범위 (C2..HEAD)</text>

  <!-- last-reviewed 포인터 (C2 위치, before) -->
  <line x1="200" y1="138" x2="200" y2="98" stroke="#2563eb" stroke-width="2" marker-end="url(#ptr-arr)"/>
  <rect x="110" y="143" width="180" height="32" rx="5" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
  <text x="200" y="157" text-anchor="middle" font-family="monospace" font-size="9" fill="#1e40af">refs/ai/reviewer/</text>
  <text x="200" y="170" text-anchor="middle" font-family="monospace" font-size="9" fill="#1e40af">last-reviewed</text>

  <!-- OK 판정 후 이동 화살표 -->
  <path d="M 290,159 Q 380,175 470,159" fill="none" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ok-arr)"/>
  <text x="380" y="182" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#16a34a">verdict OK → mark-reviewed</text>

  <!-- 이동 후 포인터 (C5) -->
  <line x1="560" y1="138" x2="560" y2="98" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ok-arr)"/>
</svg>
