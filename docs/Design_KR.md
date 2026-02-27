# Sentinel-Memory MCP 설계 문서

- 작성일: 2026-02-27
- 버전: 0.5.0

---

## 1. 프로젝트 개요

### 1-1. 목적

- LLM(Cursor/Claude)이 작업 중 발생하는 **정보의 격차(Prompt Gap)**를 기록하고 재사용
- 매 작업마다 반복되는 배경 설명을 제거하여 토큰 소비 절감
- Git으로 관리되는 텍스트 파일에 지식을 축적하여 팀 전체가 공유

### 1-2. 핵심 원칙

- 소스코드는 저장하지 않는다
- LLM이 작업 후 스스로 생성한 요약과 질문만 저장한다
- 단일 파일(`.context/memory_log.jsonl`)로 단순하게 관리한다
- 벡터 임베딩 없이 Claude가 직접 관련성을 판단한다
- 기본 50건 단위로 압축하여 파일 크기와 토큰 소비를 제어한다

### 1-3. 기대 효과

| 효과 | 설명 |
|------|------|
| 토큰 절약 | 핵심 로그만 참조. 장황한 배경 설명 불필요 |
| 시행착오 감소 | 과거 실패 이력이 다음 작업 전에 자동으로 제시됨 |
| 온보딩 자동화 | Git pull 시 수개월간의 LLM 노하우 즉시 활용 가능 |
| 의존성 최소화 | ML 라이브러리 없음. `fastmcp` + `filelock` 만으로 동작 |

---

## 2. 시스템 아키텍처

### 2-1. 구조

```
Cursor AI (Claude)
    │
    │  [1] search_memory(query, topic?)
    │      └─ memory_log.jsonl 전체 반환
    │         topic 지정 시 완전 일치 항목만 반환
    │         Claude가 직접 관련 항목 판단 (벡터 검색 없음)
    │
    │  [2] 코드 수정 (Cursor 파일 접근, MCP 미사용)
    │
    │  [3] log_memory(topic, missing_context, lesson, ...)
    │      └─ .context/memory_log.jsonl 에 append/upsert
    │
    │  [4] 기록 50건 초과 시 compact_memory() 필수 호출
    │      └─ topic별 그루핑 + 유사 topic 병합 제안 반환
    │         → Claude가 요약 → log_memory(type=principle)
    │
    ▼
MCP Server (FastMCP, Python)
    └── core/store.py      ─ JSONL 읽기/쓰기/upsert + filelock + atomic write
    └── core/sanitizer.py  ─ 민감 정보 필터
```

### 2-2. 프로젝트 경로 해결

MCP 서버는 `.cursor/mcp.json`의 `cwd` 설정으로 대상 프로젝트 루트를 전달받는다.

```json
{
    "mcpServers": {
        "sentinel-memory": {
            "command": "C:/tools/sentinel-memory/.venv/Scripts/python.exe",
            "args": ["C:/tools/sentinel-memory/server.py"],
            "cwd": "D:/projects/my-app"
        }
    }
}
```

- `server.py`는 `Path.cwd() / ".context" / "memory_log.jsonl"` 경로 사용
- `.context/` 디렉터리가 없을 경우 최초 쓰기 시 자동 생성
- 프로젝트마다 `.cursor/mcp.json`의 `cwd`만 변경
- 글로벌 설치, 프로젝트별 경로 지정 분리

### 2-3. 작업 흐름 (3-Step Loop)

```
━━━ [Step 1] Pre-Task: 맥락 조회 및 질문 ━━━━━━━━━━━━━━━━

사용자: "결제 모듈 수정해줘"
    │
    ▼
search_memory("결제 모듈")
    │
    ├─ 기록 있음 ──► memory_log.jsonl 전체를 Claude에게 전달
    │                 Claude가 관련 lesson + ask_next_time 선별 후 제시
    │                 예) "지난번에 VAT 계산 로직 누락으로 오류 발생.
    │                      이번에도 세금 계산 대상 국가를 확인할까요?"
    │
    └─ 기록 없음 ──► Gap Analysis 질문 생성
                      예) "이 모듈의 외부 API 의존성이 있나요?"
                          "이전에 시도했다가 실패한 방식이 있나요?"


━━━ [Step 2] Post-Task: 지식 추출 및 기록 ━━━━━━━━━━━━━━━

작업 완료 후 LLM이 스스로 분석하여 log_memory 호출

log_memory(
    topic           = "payment",
    missing_context = "VAT 계산이 국가별로 다름을 초기 지시에 명시 안 됨",
    lesson          = "결제 모듈 수정 시 반드시 국가 코드별 세율 파일 확인",
    ask_next_time   = "이번 수정이 적용될 국가 범위가 어디까지인가요?"
)


━━━ [Step 3] Compact: 지식 압축 (기본 50건 단위, 필수) ━━━━

기록이 compact_threshold 초과 시 Claude가 compact_memory 필수 호출

compact_memory(compact_threshold=50)
    │
    ├─ topic별 기록 묶음 + 유사 topic 병합 제안을 Claude에게 반환
    ├─ Claude: 유사 topic 통합 여부 결정 후 lesson 목록 요약
    └─ log_memory(type="principle", ...) 로 저장 후 원본 삭제
```

---

## 3. MCP 도구 정의

### 3-1. search_memory

```
입력:
    query  (string)         검색 키워드 또는 작업 설명
    topic  (string, 선택)   특정 topic으로 사전 필터링

출력: memory_log.jsonl 전체 내용 (topic 지정 시 해당 topic만)
```

- 벡터 연산 없음. 파일 전체를 그대로 반환
- `topic` 지정 시 저장된 값과 **완전 일치**하는 기록만 반환 (부분 일치 미지원)
- Claude가 반환된 기록에서 관련 항목을 직접 판단
- 파일이 비어있을 시 Gap Analysis 질문 안내 텍스트 반환

**출력 예시 (기록 있음):**

```
[memory_log - 3건]

#1 type=log | topic=payment | 2026-02-27
missing_context: VAT 계산이 국가별로 다름을 초기 지시에 명시 안 됨
lesson: 결제 모듈 수정 시 반드시 국가 코드별 세율 파일 확인
ask_next_time: 이번 수정이 적용될 국가 범위가 어디까지인가요?

#2 type=principle | topic=payment | compacted: 2026-03-15 (7건 통합)
lesson: 결제 모듈: 국가별 세율 확인, 환불 API 별도, PG사 타임아웃 10초
ask_next_time: 적용 국가 범위와 PG사 종류를 먼저 확인할 것
...
```

**출력 예시 (기록 없음):**

```
관련된 과거 기록이 없습니다.
사용자에게 다음을 질문하십시오:
1. 이 모듈의 핵심 제약사항이 있나요?
2. 의존하는 외부 라이브러리 버전 요구사항이 있나요?
3. 이전에 시도했다가 실패한 방식이 있나요?
```

> 출력 형식은 가독용 예시. 파싱 타겟이 아니며 공식 스펙이 아님.

---

### 3-2. log_memory

```
입력:
    topic             (string)        작업 주제 태그 (trim 후 길이 1 이상 필수)
                                      예) auth, payment, css-layout
    missing_context   (string)        초기 지시에서 누락되었으나 필수였던 정보
    lesson            (string)        다음에 반드시 적용해야 할 규칙·제약
    ask_next_time     (string, 선택)  다음 작업 시작 전 사용자에게 던질 확인 질문
    type              (string, 선택)  "log"(기본) 또는 "principle"(Compact 결과)
    compact_threshold (int,    선택)  Compact 기준 건수 (기본값 50)

출력: 저장 완료 메시지 + 현재 기록 건수 + compact 필수 알림(초과 시)
```

**ID 생성 규칙:**

| type | ID 입력 | 의미 |
|------|---------|------|
| `log` | `topic + missing_context` | 같은 누락 정보 재발 시 upsert |
| `principle` | `topic + lesson` | 같은 원칙이 재저장되면 upsert |

- 해시: UTF-8로 인코딩한 바이트에 SHA-256 적용, 앞 16자 사용
- `topic`이 빈 문자열 또는 공백만 있는 경우 `ValueError`
- 저장 후 기록 건수가 `compact_threshold` 초과 시 compact_memory 필수 알림 포함
- 파일 쓰기: atomic write (임시 파일 생성 후 rename) + `filelock`

---

### 3-3. compact_memory

```
입력:
    target_topic      (string, 선택)  특정 topic만 처리 (미지정 시 전체)
    compact_threshold (int,    선택)  기본값 50

출력: topic별 그루핑된 기록 목록 + 유사 topic 병합 제안
      (Claude가 요약 후 log_memory 호출)
```

- 기록 건수가 `compact_threshold` 초과 시 **필수** 호출
- **Claude에게 위임**: 도구는 topic별 그루핑 데이터 + 유사 topic 후보 목록만 반환
- Claude가 in-context에서:
    1. 유사 topic 통합 여부 결정 (예: `"auth"`, `"auth-login"` → `"auth"`)
    2. 통합된 topic별로 lesson 요약 → `log_memory(type="principle")` 저장
    3. 원본 log ask_next_time을 이어붙여 512 bytes 상한 내 병합하여 저장
- **삭제 순서**: principle 저장 성공 후에만 원본 삭제 수행
- **삭제 범위**: compact 호출 시점의 스냅샷 id 목록만 삭제 (이후 추가된 log 미포함)
- Git이 before/after 변경 이력 보존

**흐름:**

```
compact_memory(compact_threshold=50) 호출
    │
    ▼
topic별 기록 묶음 + 유사 topic 후보 반환 (Claude에게 전달)
    │
    ▼
Claude: 유사 topic 통합 결정
        각 topic의 lesson 목록 → 핵심 원칙 1문장으로 요약
        각 topic의 ask_next_time → 이어붙여 512 bytes 상한 내 병합
    │
    ▼
log_memory(type="principle", topic=..., lesson=요약문, ask_next_time=병합문)
    │
    ▼ (principle 저장 성공 확인 후)
원본 log 기록 삭제 (store.delete_by_ids, 스냅샷 id 목록 기준)
```

---

## 4. 데이터 포맷

### 4-1. .context/memory_log.jsonl (단일 통합 파일)

한 줄 = 하나의 기억 레코드. **벡터 필드 없음.**

**일반 기록 (type=log):**

```json
{
    "id": "a1b2c3d4e5f6a7b8",
    "type": "log",
    "topic": "payment",
    "missing_context": "VAT 계산이 국가별로 다름을 초기 지시에 명시 안 됨",
    "lesson": "결제 모듈 수정 시 반드시 국가 코드별 세율 파일 확인 필요",
    "ask_next_time": "이번 수정이 적용될 국가 범위가 어디까지인가요?",
    "meta": {
        "created": "2026-02-27T10:30:00+00:00"
    }
}
```

**압축 원칙 (type=principle):**

```json
{
    "id": "b2c3d4e5f6a7b8c9",
    "type": "principle",
    "topic": "payment",
    "missing_context": "",
    "lesson": "결제 모듈: 국가별 세율 확인, 환불 정책 분리, PG사 타임아웃 10초 고정",
    "ask_next_time": "적용 국가 범위와 PG사 종류를 먼저 확인할 것",
    "meta": {
        "created": "2026-03-15T09:00:00+00:00",
        "compacted_at": "2026-03-15T09:00:00+00:00",
        "source_count": 7
    }
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `id` | string | O | type별 규칙으로 생성된 SHA-256 앞 16자 (UTF-8 바이트 기준) |
| `type` | string | O | `log` 또는 `principle` |
| `topic` | string | O | 작업 주제 태그 (UTF-8 64 bytes 이하, trim 후 1자 이상) |
| `missing_context` | string | O | 누락되었던 필수 정보 (UTF-8 1,024 bytes 이하) |
| `lesson` | string | O | 다음에 적용할 규칙 (UTF-8 1,024 bytes 이하) |
| `ask_next_time` | string | - | 다음 작업 시작 전 확인 질문 (UTF-8 512 bytes 이하) |
| `meta.created` | string | O | ISO 8601 UTC. `log`=저장 시각, `principle`=principle 생성 시각 |
| `meta.compacted_at` | string | - | Compact 실행 시각 (`principle` 전용) |
| `meta.source_count` | int | - | 통합된 원본 기록 수 (`principle` 전용) |

> 바이트 상한은 UTF-8 바이트 길이 기준. 초과 시 저장 전 `ValueError` 발생 (truncate 미지원).

---

## 5. 모듈 상세

### 5-1. core/store.py

**역할:** `.context/memory_log.jsonl` CRUD, 크기 검증, 파일 락

**정책:**

- `.context/` 디렉터리가 없을 경우 최초 쓰기 시 자동 생성 (`mkdir(parents=True, exist_ok=True)`)
- 파일 쓰기: 임시 파일 생성 후 rename (atomic write). 실패 시 명시적 예외 반환
- JSONL 읽기 시 파싱 실패 줄은 스킵하고 계속 로드. 스킵된 줄 수를 로그에 기록
- 파일 락: 읽기/쓰기 I/O 구간만 잠금. Compact의 요약·log_memory 호출 단계는 락 밖에서 수행
- `delete_by_ids`: compact 호출 시점 스냅샷 id 목록만 삭제. principle 저장 성공 후에만 호출

**크기 상한 (UTF-8 바이트 기준):**

| 필드 | 상한 | 초과 시 |
|------|------|---------|
| `topic` | 64 bytes | `ValueError` |
| `missing_context` | 1,024 bytes | `ValueError` |
| `lesson` | 1,024 bytes | `ValueError` |
| `ask_next_time` | 512 bytes | `ValueError` |

**주요 함수:**

| 함수 | 설명 |
|------|------|
| `upsert_log(record)` | ID 기준 upsert, filelock + atomic write 적용 |
| `delete_by_ids(ids)` | Compact 시 원본 삭제, filelock 적용 |
| `read_all(topic=None)` | 전체 또는 topic 완전 일치 필터 읽기 |
| `count()` | 기록 건수 반환 |

**파일 락:**

```python
from filelock import FileLock
lock = FileLock(str(MEMORY_LOG_PATH) + ".lock")
with lock:
    # 읽기/쓰기 I/O 구간만 (락 구간 최소화)
```

### 5-2. core/sanitizer.py

**역할:** log_memory 입력에서 민감 정보 제거

- 적용 필드: `missing_context`, `lesson` 두 필드만 (오탐 위험 최소화)
- `topic`, `ask_next_time`은 적용 제외 (짧은 구조화된 값, 오탐 위험 높음)
- API 키·토큰 패턴 탐지 시 `[REDACTED]`로 치환
- REDACTED 치환 후 ID 해시가 원본과 달라질 수 있음 (새 레코드로 저장 허용, 의도적 설계 선택)

---

## 6. .cursorrules (강제 워크플로우)

```
당신은 이 프로젝트의 '메모리 관리자'입니다.
모든 작업은 .context/memory_log.jsonl을 기반으로 수행합니다.

[작업 시작 전 - 필수]
1. search_memory 도구를 호출하여 관련 과거 기록을 조회한다.
2. 반환된 기록에서 현재 작업과 관련 있는 lesson을 직접 판단한다.
3. 관련 기록이 있으면 lesson을 참고하고, ask_next_time의 질문을 사용자에게 확인한다.
4. 관련 기록이 없으면 추측하지 말고 사용자에게 핵심 제약사항을 질문한다.

[작업 완료 후 - 필수]
5. log_memory 도구를 호출한다.
   - 초기 지시에서 빠져 있었으나 필수였던 정보 → missing_context
   - 다음 작업 시 반드시 알아야 할 규칙 → lesson
   - 다음에 먼저 확인해야 할 질문 → ask_next_time

[topic 작성 기준]
- 모듈·기능 단위의 중간 범위로 작성한다. (언어·프레임워크 무관)
- 올바른 예: auth, payment, api-gateway, ui-form, db-migration
- 너무 좁은 예 (금지): login_bug_fix_2026, verify_token_v2
- 너무 넓은 예 (금지): code, backend, fix
- 기존 topic 목록을 먼저 확인하고, 유사한 topic이 있으면 신규 생성 대신 재사용한다.
  예) "auth-login"이 이미 있으면 "authentication" 대신 "auth-login"을 사용

[Compact - 기록 50건 초과 시 필수]
6. compact_memory 도구를 호출하여 topic별 기록을 받는다.
7. 유사한 topic이 있으면 통합한다. (예: "auth", "auth-login" → "auth")
8. 각 topic의 lesson 목록을 핵심 원칙 1문장으로 요약한다.
9. 각 topic의 ask_next_time을 이어붙여 512 bytes 상한 내 병합한다.
10. log_memory(type="principle", ...)로 요약 결과를 저장한다.
11. principle 저장 성공 확인 후 원본 log 기록 삭제를 요청한다.

이 순서를 건너뛰는 것은 허용되지 않는다.
```

---

## 7. 크기 및 성능 계획

### 7-1. memory_log.jsonl 예상 크기 (벡터 제거 후)

| 상황 | 크기 |
|------|------|
| 기록 1건 (텍스트만) | ~0.5 KB |
| 50건 (Compact 전 최대) | ~25 KB |
| Compact 후 (원칙 5~10건) | ~3~5 KB |
| 장기 운영 평형 상태 | 10 ~ 30 KB |

### 7-2. search_memory 컨텍스트 점유

| 기록 수 | 크기 | 토큰 수 (대략) | Claude 컨텍스트 비율 |
|---------|------|----------------|----------------------|
| 50건 (Compact 전 최대) | ~25 KB | ~6,250 토큰 | 3.1% (200K 대비) |
| Compact 후 10건 | ~5 KB | ~1,250 토큰 | 0.6% |

- Compact 전에도 컨텍스트 점유 3% 이하로 토큰 부담 없음
- 벡터 필드 제거로 기존 대비 파일 크기 75% 감소

### 7-3. 의존성 비교

| 항목 | 이전 설계 | 현재 설계 |
|------|-----------|-----------|
| ML 라이브러리 | sentence-transformers (~2.5 GB) | 없음 |
| 핵심 의존성 | fastmcp, numpy, sentence-transformers | fastmcp, filelock |
| 설치 시간 | 5~15분 | 수 초 |
| 첫 실행 모델 다운로드 | 필요 | 없음 |

---

## 8. 보안 고려사항

- `sanitizer.py`로 `missing_context`, `lesson` 필드 필터링 후 저장 (오탐 최소화 위해 두 필드만 적용)
- `filelock`으로 동시 쓰기 시 파일 손상 방지
- `server.py` 상단 stdout UTF-8 강제 설정 (Windows 한글 깨짐 방지)
- `.context/` 디렉터리는 git 추적 (소스코드 미포함)
- 민감 프로젝트는 `.gitignore`에 `.context/` 추가 고려
- 원격 저장소 push 전 `git diff .context/` 확인 권장
- REDACTED 치환 후 ID 변경으로 중복 저장 가능 (허용, 의도적 설계 선택)

---

## 9. 설계 결정 사항

| 항목 | 결정 | 비고 |
|------|------|------|
| 벡터 임베딩 | 제거 | Claude가 직접 관련성 판단 |
| 검색 방식 | 전체 반환 후 Claude 판단 | topic 파라미터로 사전 필터링 가능 |
| topic 필터 | 완전 일치만 | 부분 일치 미지원 |
| topic 정규화 | Compact 시 Claude가 유사 topic 통합 | cursorrules에 기존 topic 재사용 지침 포함 |
| `log` ID | `topic + missing_context` SHA-256 앞 16자 (UTF-8) | 같은 누락 정보 upsert |
| `principle` ID | `topic + lesson` SHA-256 앞 16자 (UTF-8) | 같은 원칙 재저장 시 upsert |
| 바이트 상한 기준 | UTF-8 바이트 길이 | 초과 시 ValueError, truncate 미지원 |
| `topic` 유효성 | trim 후 1자 이상 필수 | 빈 topic 금지 |
| `topic` 태그 | 자유 입력 + .cursorrules 가이드로 범위 제어 | Compact 시 유사 topic 통합 |
| Compact 기준 | 기본값 50건, 파라미터로 조정 가능 | `compact_threshold` |
| Compact 트리거 | 50건 초과 시 필수 | 권장이 아닌 강제 |
| Compact 방식 | 현재 세션 AI(Cursor/Claude)에게 위임 | Claude가 in-context 요약 후 저장 |
| Compact 원본 삭제 순서 | principle 저장 성공 후에만 삭제 | 원자성 보장 |
| Compact 삭제 범위 | 호출 시점 스냅샷 id 목록만 | 이후 추가된 log 미포함 |
| `principle` ask_next_time | 원본 log의 ask_next_time 이어붙여 512 bytes 상한 | 초과분 truncate |
| `principle` 검색 | `log`와 동등하게 전체 반환 | type 구분 없이 동일 처리 |
| `meta.created` 의미 | `log`=저장 시각, `principle`=principle 생성 시각 | |
| sanitizer 적용 필드 | `missing_context`, `lesson`만 | 오탐 위험 최소화 |
| REDACTED 후 upsert | 새 ID로 저장 허용 | 중복 증가 허용, 의도적 선택 |
| JSONL 손상 처리 | 손상 줄 스킵 후 계속 로드 | 스킵 줄 수 로그 기록 |
| 쓰기 방식 | atomic write (임시 파일 + rename) | 디스크 부족 시 명시적 예외 |
| .context 생성 | 최초 쓰기 시 자동 생성 | `mkdir(parents=True, exist_ok=True)` |
| 파일 락 범위 | 읽기/쓰기 I/O 구간만 | Compact 요약 단계는 락 밖 |
| 출력 형식 | 가독용 예시 | 파싱 타겟 아님 |
| 지원 언어 | 모든 언어 (C++, C#, TS, JS, Python 등) | 언어 중립적 필드 구조 |
| 프로젝트 경로 | `.cursor/mcp.json`의 `cwd`로 전달 | 서버는 `Path.cwd()` 사용 |
| 동시 쓰기 보호 | `filelock` 라이브러리 | Windows/Linux 공통 동작 |
| stdout 인코딩 | UTF-8 강제 설정 | Windows 한글 대응 |

---

## 10. 파일 구조

```
대상 프로젝트 루트/
├── .cursor/
│   └── mcp.json               ← cwd로 프로젝트 경로 지정
└── .context/
    └── memory_log.jsonl       ← git 추적 대상

dug-sentinel-memory-mcp/      ← MCP 서버 (글로벌 설치)
├── docs/
│   └── 001_설계문서.md
├── core/
│   ├── __init__.py
│   ├── sanitizer.py           ─ 민감 정보 필터 (missing_context, lesson 적용)
│   └── store.py               ─ JSONL 읽기/쓰기/upsert + filelock + atomic write
├── server.py                  ─ MCP 도구 3종
│                                (search_memory / log_memory / compact_memory)
├── requirements.txt           ─ fastmcp, filelock
├── .cursorrules
└── .gitignore
```
