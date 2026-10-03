# 기억: 세션 결정 노트 · 장기 기억 정리 · 공용 메모판

2026-10-04 사용자 요청("컨텍스트 일관성이나 장기기억은 어떻게 하지?" → 1·2·3 모두).
작업자는 매번 새로 켜지는 CLI라 서로의 대화를 모른다. 그래서 허브가 세 층의 기억을 따로 챙긴다.

| 범위 | 무엇 | 어디 |
|---|---|---|
| 한 요청 안 | 공용 메모판: 작업자들이 정한 규칙·인터페이스 | `runs/<작업>/notes/<작업ID>.md` (작업자마다 자기 파일만) |
| 같은 세션 | 결정 노트: 이 세션에서 정한 것·알아낸 것 | `job.sessionNotes` 스냅샷, 사용자 수정 `session.notesEdit` |
| 세션을 넘어 | 장기 기억: 공유 메모리 파일 | `~/.ai-shared/memory/global` · `projects/<폴더>` |

## 흐름
1. 작업자 지시문(`planner.buildWorkerPrompt`)에 공용 메모판 경로와 시작 시점 내용이 들어간다. 작업자는 다른 작업자도 알아야 할 결정을 자기 파일에 `- 내용`으로 덧붙이고, 공유 메모리는 직접 고치지 않는다. 오래 기억할 것은 결과 요약 ④에 "기억할 것: …"으로 적는다.
2. 작업이 끝날 때마다 허브가 메모판을 모아 `job.board`로 보여 준다(작업 카드의 "공용 메모판").
3. 요청이 `done`·`partial`로 끝나면 `jobs.curate`가 정리 CLI를 한 번 부른다(플래너와 같은 AI, 실행 기록 폴더에서, 파일 수정 없이 JSON만).
   - 입력: 요청·작업 결과·보고·메모판·기존 결정 노트(번호)·관련 메모리(인덱스와 본문, 본문 최대 1만 2천 자).
   - 출력: `notes`(번호 기준 add·update·remove)와 `memory`(create·update·delete, 최대 8개).
4. 허브가 적용한다.
   - 결정 노트: `memory-curate.applyNoteOps` → `job.sessionNotes`(최대 60개, 한 항목 300자, 비밀로 보이는 내용 거름).
   - 장기 기억: `applyMemoryOps`. frontmatter(name·description·metadata.type)와 같은 폴더 `MEMORY.md` 한 줄을 함께 쓴다. 없던 프로젝트 폴더·인덱스는 만든다.
     - update·delete 는 정리 담당이 본문을 **끝까지 본** 메모리(전역·이 프로젝트)만. 보지 못한 같은 이름 파일은 덮어쓰지 않는다.
     - delete 는 `~/.ai-shared/backups/memory-trash/<작업>/`로 옮긴다.
     - 이름은 영어 소문자·숫자·하이픈, 본문 6천 자 이하, 자격 증명으로 보이는 내용은 건너뛴다(`looksSecret`).
   - 되돌리기 기록: `runs/<작업>/memory/memory-undo.json`(파일 원본과 인덱스 줄·위치).
5. 다음 요청은 같은 세션의 정리를 최대 2분 30초 기다린 뒤 맥락을 만든다(`jobs.waitCuration`). `session-tools.historyContext`는 결정 노트를 잘리지 않게 앞에 두고, 이전 명령·결과는 최근 것부터 남은 예산만큼 넣는다. 잘린 명령은 "결정 노트에 있다"고 안내한다.

## 결정 노트 고르기
`session-tools.notesFor(session, job)`:
- job 이전(같은 세션 + 갈래면 원본의 갈라진 시점까지)에서 가장 최근 `sessionNotes` 스냅샷.
- 사용자가 '기억' 탭에서 고친 `session.notesEdit`가 그 스냅샷의 정리 시각(`curation.at`)보다 새것이면 그것.
- 갈래 세션은 갈라진 시점의 노트를 그대로 이어받는다.

## API
- `GET /api/sessions/:id/notes` → `{ notes, editedAt }`
- `PUT /api/sessions/:id/notes` `{ notes: [{ id?, text }] }` → 목록 통째로 바꾸기(빈 줄 제외, 비밀 거절)
- `POST /api/jobs/:id/memory/undo` → `{ undo: [{ file, status: 'restored'|'conflict' }] }`. 그 뒤에 다른 곳에서 바뀐 파일은 건드리지 않는다(conflict).
- `/api/status`의 `capabilities.memoryCuration`

## 화면 (`public/memory-ui.js`, `memory.css`)
- 작업 카드 끝: "공용 메모판 N줄"(접기), "기억 · 결정 노트 +2 · 고침 1 · 장기 기억 [제목] · 되돌리기". 정리 중이면 "기억 정리 중…". 건너뛴 장기 기억은 마우스를 올리면 이유가 보인다.
- 오른쪽 '기억' 탭: 세션 결정 노트(지우기 ×, 직접 더하기), 이 세션에서 저장한 장기 기억 목록.

## 설정 (`config.json`, 없으면 모두 켜짐)
- `memory.curate: false` — 정리 단계를 끈다(작업자 지시문도 예전처럼 "공유 메모리 규칙대로 저장").
- `memory.longTerm: false` — 결정 노트만 정리하고 장기 기억은 쓰지 않는다.

## 시험
`tests/memory-curate.test.mjs`. 실제 CLI 확인은 공유 폴더 사본(`hubDir`)을 쓰는 시험 서버로 한다(진짜 메모리를 건드리지 않게).
