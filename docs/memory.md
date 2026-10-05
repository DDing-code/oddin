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

## 블록 · 공유/이 PC만 · 세션별 연결 (2026-10-05, `lib/memory-blocks.mjs`)
사용자 요구: "메모리를 블록별로 정리하고 공유/로컬 메모리를 나누고 세션별로 실시간 동기화/해제".
- **블록**: 전역 `MEMORY.md`의 `## 제목` 하나가 블록 하나(제목 앞 줄은 "기본", 목록에 없는 파일은 "미분류"). 새 줄이 끝에 붙으면 맨 끝 `## 미분류`에 들어간다. 프로젝트 메모리 폴더(`projects/<폴더>`)는 폴더 하나가 블록 하나(`project:<폴더>`, 이름은 대응표 경로 끝).
- **공유 / 이 PC만**: 공유 `~/.ai-shared/memory`(연결된 PC와 맞춤, `docs/peers.md`), 이 PC만 `~/.ai-shared/memory-local`(같은 구조, 맞추지 않음 — 동기화 범위 `SHARED_TOP` 밖). 메모리·블록 단위로 옮긴다(파일과 목록 줄을 함께). 공유→이 PC만으로 옮기면 연결된 PC에서는 지워지고 그쪽 `backups/sync`에 남는다.
- **세션별 연결**: 세션의 `memory.blocks`에 블록마다 `on`(연결 — 관련성과 상관없이 매 단계 최신 내용을 넣음, 개수 한도 밖·본문 예산은 나눠 씀) / `off`(해제 — 목록·본문 모두 뺌, 한국어 규칙은 예외) / 없음(자동 — 예전처럼 관련 있을 때만). `jobs.sessionBlocks` → 공용 선택기 `buildMemoryContext({ blocks: { on, off } })`. 이 PC만 메모리도 함께 읽는다(목록 머리 "이 PC만 · …").
- **새 기억 저장 위치**: 세션의 `memory.save` = `shared`(기본) / `local`(정리 담당의 새 기억을 `memory-local`에) / `none`(장기 기억은 건너뛰고 결정 노트만). 정리 담당은 새 전역 기억의 `block`(전역 블록 중 하나, 없으면 미분류)을 고르고 허브가 그 블록 끝에 줄을 넣는다(`placeIndexLine`).
- **화면**: 사이드바 "공유 메모리" → 기억 관리 창(`public/memory-blocks.js`): 블록 목록(공유·이 PC만 개수), 메모리별 공유↔이 PC만·블록 옮기기·본문 보기, 블록 만들기·이름 바꾸기(세션 설정도 따라 바뀜)·지우기(빈 블록만)·블록 통째로 공유/이 PC만. 오른쪽 "기억" 탭 위쪽: 이 세션에 넣는 기억 [자동·연결·해제], 새 기억 저장 [공유·이 PC만·저장 안 함].
- **API**: `GET /api/memory/blocks`, `POST /api/memory/move` `{root, rel, block?, toRoot?}`, `POST /api/memory/blocks` `{name}`, `POST /api/memory/blocks/rename` `{from, to}`, `POST /api/memory/blocks/root` `{id, root}`, `POST /api/memory/blocks/delete` `{name}`, `GET /api/memory/text?root&rel`, `POST /api/sessions/:id/memory` `{blocks, save}`.
- 시험: `tests/memory-blocks.test.mjs`.

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

## ODDIN 자산 (2026-10-05)
- 공유를 허용한 세션(`session.memory.save` 공유)이고 구글 드라이브 ODDIN 폴더가 있으면 기억 정리가 "③ 자산"도 고른다. 허브가 다시 쓸 결과물을 드라이브 `ODDIN/자산/<분류>/<이름>`에 복사하고 `자산/목록.md`·공유 기억 `global/reference-oddin-assets.md`를 고친다. 규칙·안전장치는 `docs/peers.md` "드라이브 ODDIN 폴더", 코드 `lib/oddin-assets.mjs`.
