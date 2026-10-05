# 연결된 PC · 공유 기억 동기화

2026-10-05 사용자 요구: 집 PC와 회사 PC(둘 다 항상 켜짐)를 ODDIN 하나로 함께 쓰고, 어디서나 같은 기억(공유 메모리)을 쓴다.
각 PC의 일(파일·어도비 플러그인)은 그 PC에서 실행한다. 이 문서는 1단계(연결·기억 통일)를 다룬다. 한 화면 합치기·PC별 작업 배정은 다음 단계.

## 연결
- 오른쪽 패널 **PC** 탭: 이 PC 이름(예: 집, 회사), 연결된 PC 목록·상태, 주소로 연결(`https://<기기>.<tailnet>.ts.net`), 이름 바꾸기·끊기.
- 상대 PC의 ODDIN 에서 원격 접속이 켜져 있어야 한다(`docs/remote-access.md`). 두 PC가 같은 Tailscale 계정이면 서버끼리 그 주소로 이야기한다(Tailscale Serve 가 계정 정보를 붙여 원격 게이트를 통과).
- 목록은 PC마다 `data/peers.json`(저장소에 안 올라감). `self.id` 로 자기 자신 연결을 막는다. 같은 PC 시험용으로 `http://127.0.0.1:<포트>` 도 받는다.
- 1분마다 상태 확인(`/api/peers/whoami`), 화면에는 `peers` 실시간 이벤트로 알린다.

## 공유 기억 동기화 (`lib/shared-sync.mjs`)
- 범위: `~/.ai-shared` 의 `AGENTS.md`·`README.md`·`memory/`·`commands/`·`agents/`·`sync/`.
  빼는 것(PC마다 따로): `backups/`, `hub/`(허브 작업 보드), `sync/state.json`·`sync.log`·`.lock`·`memory-check-state/`, `memory/projects/INDEX.md`(sync.mjs 가 PC 경로로 다시 만듦), 4MB 넘는 파일, 정션·링크.
- 때: 1분마다(`config.sharedSync.intervalSeconds`), `~/.ai-shared` 가 바뀌면 3초 뒤(`watch`), PC를 연결할 때, PC 탭 "지금 맞추기".
- 방식: 상대마다 마지막으로 맞춘 내용(파일별 해시, `data/shared-sync.json`)을 기준으로
  - 한쪽만 바뀜 → 그쪽 것을 다른 쪽에 쓴다(지운 것도 지운다).
  - 둘 다 바뀜 → `MEMORY.md` 는 줄을 합친다(최근 판 기준, 같은 파일을 가리키는 줄은 하나, 가리키는 파일이 없어진 줄은 뺌). 다른 파일은 최근에 고친 쪽을 쓰고 밀린 판을 남긴다. 한쪽은 지우고 한쪽은 고쳤으면 고친 쪽을 살린다.
  - 지우거나 덮어쓴 이전 판은 그 PC의 `~/.ai-shared/backups/sync/<시각>/` 에 `.<지움|덮어씀|밀림>-<PC이름>` 을 붙여 남긴다.
- 상대 쓰기(`POST /api/shared/file`)는 기대한 지금 내용(`ifSha`)이 맞을 때만 적용(아니면 409, 다음 차례에 다시). 경로는 범위 안 상대 경로만(`safeRel`).
- 끄기: `config.sharedSync.enabled:false`.

## 새 PC의 Claude·Codex 훅 (`lib/shared-setup.mjs`)
- PC 탭 "이 PC의 Claude·Codex": 공유 기억 받음 / Claude 훅 / Codex 훅 / CLAUDE.md 불러오기 줄 상태, "빠진 것 설치".
- 집 PC와 같은 훅(세션 시작 `sync.mjs`, 매 메시지 `memory-check.mjs`, 끝 `sync.mjs --quiet`)과 `~/.claude/CLAUDE.md` 의 `@~/.ai-shared/AGENTS.md`·`@~/.ai-shared/memory/global/MEMORY.md` 줄 중 빠진 것만 더하고, 원본은 `.bak-oddin-<시각>` 으로 남긴 뒤 `sync.mjs` 를 한 번 돌린다.
- Codex 는 새 훅을 처음 쓸 때 한 번 신뢰할지 묻는다. ODDIN 작업은 훅이 없어도 공유 기억을 바로 읽는다(`jobs.memoryFor`).

## 업데이트 (`lib/hub-update.mjs`)
- 두 PC의 ODDIN을 같은 버전으로: 연결된 PC 탭의 PC 줄 "업데이트"(그 PC 허브에 대신 요청), 이 PC 줄 "이 PC 업데이트". 각 줄에 지금 버전(커밋 날짜, 마우스를 올리면 커밋 번호)과 이 PC와 같은지 표시.
- 허브 폴더에서 `git fetch` → fast-forward `pull`. 커밋 안 한 추적 파일 변경이나 이 PC에만 있는 커밋이 있으면 받지 않는다(409).
- 받은 파일 중 서버 쪽(`public/`·`docs/`·`tests/`·`desktop/`·`*.md` 밖)이 바뀌었으면 `scripts/restart-hub.mjs --detach` 로 진행 중인 작업이 끝난 뒤 그 허브만 재시작. 화면 파일만 바뀌면 열린 화면이 알아서 새로 읽는다.

## API
| 경로 | 설명 |
|---|---|
| `GET /api/peers/whoami` | `{ id, name, hostname, version }` |
| `GET /api/peers` | `{ self, peers:[{id,name,url,status}], sync }` |
| `POST /api/peers` `{url,name}` | 연결(상대 whoami 확인, 자기 자신 거절), 바로 한 번 맞춤 |
| `POST /api/peers/self` `{name}` | 이 PC 이름 |
| `POST /api/peers/:id` `{name}` · `DELETE /api/peers/:id` | 이름 바꾸기 · 끊기(파일은 그대로) |
| `GET /api/shared/manifest` | `{ machine, files:{경로:{sha,mtime,size}} }` |
| `GET /api/shared/file?rel=` · `POST /api/shared/file` | 파일 읽기(base64) · 쓰기/지우기(`ifSha`, `backup`) |
| `POST /api/shared/sync` · `GET /api/shared/status` | 지금 맞추기 · 상태 |
| `GET/POST /api/shared/setup` | 훅 상태 · 빠진 것 설치 |
| `GET /api/hub/version[?check=1]` · `POST /api/hub/update` | 이 허브 버전(확인하면 뒤처진 수) · 업데이트 |
| `GET /api/peers/:id/version` · `POST /api/peers/:id/update` | 연결된 PC 버전 확인 · 업데이트(대신 요청) |

시험: `tests/hub-update.test.mjs`(임시 git 저장소로 받기·재시작 판단·거절), `tests/shared-sync.test.mjs`(허브 두 개 7716·7717, 처음 맞추기·한쪽 변경·목록 합치기·충돌·지우기·쓰기 검사·새 PC 훅 설치).
