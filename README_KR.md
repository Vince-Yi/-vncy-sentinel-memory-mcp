# Sentinel-Memory MCP

**Prompt Gap** — 초기 지시에서 누락됐으나 작업 중 필수로 밝혀진 정보 — 을 기록하고 재사용하는 경량 MCP 서버입니다.

벡터 DB 없음. ML 모델 없음. Git으로 추적하는 단순 JSONL 파일만 사용합니다.

---

## 동작 원리

AI 어시스턴트가 작업할 때마다 초기 지시에는 없었지만 결정적으로 필요한 정보를 마주칩니다. Sentinel-Memory는 그 격차를 캡처하고, 다음 관련 작업 시작 시 자동으로 제시합니다.

```
[작업 시작 전]  search_memory()         →  과거 교훈 + 사용자에게 던질 질문
[작업 완료 후]  log_memory()            →  무엇이 빠져 있었는지, 무엇을 기억해야 하는지
[기록이 차면]   compact_memory()        →  topic별 그루핑 반환 (Claude가 요약)
               compact_memory_delete()  →  principle 저장 후 원본 삭제
```

메모리는 프로젝트 내 `.context/memory_log.jsonl`에 저장됩니다. 일반 텍스트 파일이므로 읽고, diff하고, 다른 소스 파일과 동일하게 커밋할 수 있습니다.

---

## 특징

- **ML 의존성 없음** — 임베딩 없음, 모델 다운로드 없음
- **Git 친화적 저장** — 일반 JSONL, 사람이 읽을 수 있으며 완전히 diffable
- **Claude가 관련성 직접 판단** — 전체 기록 반환 후 Claude가 필요한 내용 선별
- **Topic 정규화** — Compact 시 유사 topic 통합
- **Atomic write** — 임시 파일 + rename 방식으로 크래시 안전
- **크로스 플랫폼 파일 락** — 디렉터리 기반 락, Windows/Linux 공통 동작
- **민감 정보 필터** — 저장 전 API 키·토큰 자동 [REDACTED] 처리
- **npx 지원** — npm 배포 후 별도 설치 불필요

---

## 요구사항

- Node.js 18 이상
- MCP 호환 클라이언트 (Cursor, Claude Code 등)

---

## 설치 방법

### Option A — npx (npm 배포 후, 설치 불필요)

프로젝트 루트의 `.cursor/mcp.json.example`을 `.cursor/mcp.json`으로 복사합니다:

```json
{
    "mcpServers": {
        "sentinel-memory": {
            "command": "npx",
            "args": ["-y", "@vncy/sentinel-memory-mcp"]
        }
    }
}
```

Cursor는 MCP 서버 실행 시 workspace 루트를 CWD로 자동 설정하므로 `cwd` 지정이 불필요합니다. `.context/memory_log.jsonl`은 최초 사용 시 프로젝트 루트에 자동 생성됩니다.

### Option B — 로컬 빌드

```bash
git clone https://github.com/your-org/dug-sentinel-memory-mcp.git
cd dug-sentinel-memory-mcp
npm install
npm run build
```

빌드 후 `.cursor/mcp.json`에 직접 경로를 지정합니다:

```json
{
    "mcpServers": {
        "sentinel-memory": {
            "command": "node",
            "args": ["/절대/경로/dug-sentinel-memory-mcp/dist/server.js"]
        }
    }
}
```

> `.cursor/mcp.json`은 `.gitignore`에 등록되어 있습니다. `.cursor/mcp.json.example`을 복사하기만 하면 됩니다. 경로 수정도 커밋도 필요 없습니다.

---

## 개발자별 경로 문제 해결

각 개발자는 자신만의 `.cursor/mcp.json`을 유지합니다 (git-ignored). Cursor가 MCP 서버 실행 시 workspace 루트를 CWD로 자동 설정하므로, 경로 설정 없이도 각자 프로젝트의 `.context/`가 생성됩니다.

```
개발자 A  →  ProjectA 오픈  →  MCP CWD = ProjectA/  →  ProjectA/.context/memory_log.jsonl
개발자 B  →  ProjectB 오픈  →  MCP CWD = ProjectB/  →  ProjectB/.context/memory_log.jsonl
```

---

## 도구 목록

### `search_memory(query, topic?)`

**작업 시작 전 필수 호출.** 과거 기록 전체를 반환합니다 (topic 지정 시 완전 일치 필터). Claude가 출력을 읽고 관련 교훈을 선별합니다.

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `query` | string | 작업 설명 또는 검색 키워드 |
| `topic` | string (선택) | 완전 일치 topic 필터 |

### `log_memory(topic, missing_context, lesson, ask_next_time?, type?, compact_threshold?)`

**작업 완료 후 필수 호출.** 무엇이 빠져 있었는지, 무엇을 기억해야 하는지 기록합니다.

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `topic` | string | 모듈·기능 태그 (예: `auth`, `payment`) |
| `missing_context` | string | 초기 지시에서 누락됐으나 필수였던 정보 |
| `lesson` | string | 다음 작업 시 반드시 적용해야 할 규칙 |
| `ask_next_time` | string (선택) | 다음번 사용자에게 먼저 확인할 질문 |
| `type` | string (선택) | `"log"` (기본) 또는 `"principle"` (압축 결과) |
| `compact_threshold` | int (선택) | 압축 기준 건수 (기본값: 50) |

### `compact_memory(target_topic?, compact_threshold?)`

**기록 건수가 임계값을 초과하면 필수 호출.** topic별로 그루핑된 기록 목록을 반환합니다. Claude가 원칙으로 요약합니다.

### `compact_memory_delete(ids)`

`log_memory(type="principle")` 성공 **후에만** 호출합니다. id 목록에 해당하는 원본 log 기록을 삭제합니다.

---

## 워크플로우 (.cursorrules)

`.cursorrules` 파일이 모든 작업에 3단계 루프를 강제합니다:

```
당신은 이 프로젝트의 메모리 관리자입니다.
모든 작업은 .context/memory_log.jsonl을 기반으로 수행합니다.

중요: Step 1을 완료하기 전에는 코드를 작성하거나 파일을 수정하지 마십시오.

[작업 시작 전 - 필수]
1. 현재 작업 설명과 함께 search_memory를 호출한다.
2. 반환된 기록을 읽고 현재 작업과 관련 있는 lesson을 선별한다.
3. 관련 기록이 있으면:
   - lesson을 작업 방식에 직접 반영한다.
   - 진행 전 ask_next_time에 명시된 질문을 사용자에게 확인한다.
4. 관련 기록이 없으면:
   - 추측하지 말고 먼저 사용자에게 핵심 요구사항을 질문한다.

[작업 완료 후 - 필수]
5. log_memory를 호출한다:
   - missing_context  ←  초기 지시에서 빠져 있었으나 결정적으로 필요한 정보
   - lesson           ←  동일 유형의 향후 작업 시 적용해야 할 규칙
   - ask_next_time    ←  유사 작업 시작 전 사용자에게 확인할 질문

[Topic 작성 기준]
- 모듈·기능 단위의 중간 범위로 작성한다. (언어·프레임워크 무관)
- 올바른 예: auth, payment, api-gateway, ui-form, db-migration
- 너무 좁은 예 (금지): login_bug_fix_2026, verify_token_v2
- 너무 넓은 예 (금지): code, backend, fix
- 기존 topic 목록을 먼저 확인하고, 유사한 topic이 있으면 신규 생성 대신 재사용한다.
  예) "auth-login"이 이미 있으면 "authentication" 대신 "auth-login"을 사용

[Compact - 기록 50건 초과 시 필수]
6.  compact_memory를 호출하여 topic별 그루핑된 기록을 받는다.
7.  유사한 topic을 통합한다. (예: "auth", "auth-login" → "auth")
8.  각 topic의 lesson 목록을 핵심 원칙 1문장으로 요약한다.
9.  각 topic의 ask_next_time을 이어붙여 512 bytes 이내로 병합한다.
10. log_memory(type="principle", ...)로 요약 결과를 저장한다.
11. principle 저장 성공 확인 후 compact_memory_delete(ids=[...])로 원본을 삭제한다.

이 순서를 건너뛰는 것은 허용되지 않는다.
```

---

## 데이터 포맷

`.context/memory_log.jsonl`에 한 줄 = 레코드 하나로 저장됩니다.

**일반 기록 (type=log):**
```json
{
    "id": "a1b2c3d4e5f6a7b8",
    "type": "log",
    "topic": "payment",
    "missing_context": "VAT 세율이 국가별로 다름 — 초기 지시에 미기재",
    "lesson": "결제 모듈 수정 시 반드시 국가별 세율 파일 확인",
    "ask_next_time": "이번 수정이 적용될 국가 범위는?",
    "meta": { "created": "2026-02-27T10:30:00.000Z" }
}
```

**압축 원칙 (type=principle, Compact 후):**
```json
{
    "id": "b2c3d4e5f6a7b8c9",
    "type": "principle",
    "topic": "payment",
    "missing_context": "",
    "lesson": "결제 모듈: 국가별 세율 확인, 환불 API 분리, PG 타임아웃 10초",
    "ask_next_time": "적용 국가 범위? PG사 종류?",
    "meta": {
        "created": "2026-03-15T09:00:00.000Z",
        "compacted_at": "2026-03-15T09:00:00.000Z",
        "source_count": 7
    }
}
```

| 필드 | 상한 | 초과 시 |
|------|------|---------|
| `topic` | 64 bytes (UTF-8) | 오류 |
| `missing_context` | 1,024 bytes (UTF-8) | 오류 |
| `lesson` | 1,024 bytes (UTF-8) | 오류 |
| `ask_next_time` | 512 bytes (UTF-8) | 오류 |

---

## 파일 구조

```
대상 프로젝트 루트/
├── .cursor/
│   ├── mcp.json              ← git-ignored, mcp.json.example 복사 후 수정
│   └── mcp.json.example      ← 커밋된 템플릿
└── .context/
    └── memory_log.jsonl      ← 자동 생성. 이 파일을 커밋하세요.

dug-sentinel-memory-mcp/      ← 이 저장소
├── src/
│   ├── server.ts             ← MCP 도구 4종
│   ├── store.ts              ← JSONL CRUD + 파일 락 + atomic write
│   └── sanitizer.ts          ← 민감 정보 필터
├── dist/                     ← 컴파일 결과물 (npm run build 생성)
├── .cursor/
│   └── mcp.json.example      ← 설정 템플릿
├── docs/
│   ├── Design.md
│   └── Design_KR.md
├── package.json
├── tsconfig.json
├── .cursorrules
└── .gitignore
```

---

## 보안 유의사항

- `missing_context`와 `lesson` 필드는 저장 전 API 키·토큰·시크릿 패턴을 스캔합니다. 탐지된 패턴은 `[REDACTED]`로 치환됩니다.
- `.context/memory_log.jsonl`은 평문 텍스트입니다. 공유 저장소에 push하기 전에 `git diff .context/`로 내용을 확인하세요.
- 민감한 프로젝트의 경우 `.gitignore`에 `.context/`를 추가하는 것을 고려하세요.

---

## 라이선스

MIT
