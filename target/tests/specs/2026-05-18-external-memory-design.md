# External Memory System 설계

**날짜:** 2026-05-18
**목표:** 개발 중 발견한 실패 패턴과 학습을 저장해 LLM이 같은 실수를 반복하지 않도록 하고, 컨텍스트 윈도우 부담을 줄인다.

---

## 1. 구조

```
project/
├── .project-memory/
│   ├── INDEX.md          # 항상 로드. 파일별 요약 + 읽을 시점 기술
│   ├── spring-pitfalls.md
│   ├── test-strategy.md
│   └── ...
├── AGENTS.md             # 작업 전 INDEX 읽기 지시사항 추가
└── .pi/
    └── hooks/
        └── post-tool-use-memory.js  # 편집 후 관련 메모리 주입
```

플랫 구조: 폴더 계층 없이 INDEX.md가 분류 역할 담당.

---

## 2. INDEX.md 형식

```markdown
# Project Memory Index

작업 시작 전 이 파일을 읽고, 관련 항목의 원본 파일을 로드하세요.

| 파일 | 요약 | 읽을 시점 |
|------|------|----------|
| spring-pitfalls.md | Bean 등록/의존성 주입 실패 패턴 | Spring 설정·DI 작업 시 |
| test-strategy.md | 통합테스트 vs 단위테스트 결정 기준 | 테스트 작성 전 |
```

---

## 3. 메모리 파일 형식

```markdown
---
tags: [spring, bean, config]
added: 2026-05-18
---

## 상황
어떤 작업 중에 발견했는지

## 실패한 접근
무엇을 했고 왜 틀렸는지

## 올바른 접근
실제로 동작한 방법

## 핵심 규칙
한 줄 요약 (훅에서 리마인더로 주입할 내용)
```

---

## 4. AGENTS.md 추가 지시사항

```markdown
## Project Memory

작업 시작 전:
1. `.project-memory/INDEX.md` 읽기
2. 작업과 관련된 파일 로드

작업 종료 후:
- 새로운 실패 패턴/학습 발견 시 메모리 추가 제안
- 사용자 승인 후 파일 작성 + INDEX.md 업데이트
```

---

## 5. PostToolUse 훅

**파일:** `.pi/hooks/post-tool-use-memory.js`
**트리거:** Write, Edit 이후

동작:
1. 편집된 파일 경로 확인
2. `.project-memory/INDEX.md` 파싱
3. 파일 경로와 태그 매칭 (예: `src/.../UserService.java` → `[spring, service]`)
4. 매칭된 메모리 파일의 "핵심 규칙" 항목을 리마인더로 주입
5. 매칭 없으면 silent (컨텍스트 낭비 없음)

리마인더 예시:
```
[메모리 리마인더] spring-pitfalls.md
→ @Transactional은 서비스 레이어에만. 컨트롤러에 걸면 프록시 미적용.
```

---

## 6. 메모리 작성 워크플로우

**자동 (PI 제안):**
- 작업 종료 시 새 실패 패턴 발견하면 제안
- 승인 후 PI가 파일 작성 + INDEX.md 업데이트

**수동 (사용자 직접):**
- `.project-memory/`에 파일 직접 작성
- INDEX.md 업데이트는 PI에게 요청 가능

---

## 7. 적용 범위

- **범용 프레임워크:** 훅, 지시사항 구조는 어느 프로젝트에나 복사 적용 가능
- **메모리 내용:** 프로젝트별 독립 (`.project-memory/`는 각 프로젝트에 존재)

---

## 8. 제외 범위

- 태그 분류 체계 강제 (INDEX 판단에 위임)
- 메모리 수정 권한 제어 (harness enforcement 없음)
- 외부 벡터 DB / 시맨틱 검색
- Docker 샌드박스, 네트워크 격리
