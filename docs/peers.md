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

## 공유 폴더 — 읽기용 사본 (`lib/shared-folders.mjs`)
- 2026-10-05 사용자 "따로 개발한 플러그인 같은 건 파일까지 공유해야 어떻게 구현됐는지 알 수 있다". 각 PC가 연결된 PC 탭에서 공유할 폴더(경로·이름)를 정하면, 상대 PC의 ODDIN 이 2분마다(`config.sharedFolders.intervalSeconds`)·PC 연결 때·"지금 받기"로 `~/.ai-shared/peer-files/<원본 PC 이름>/<폴더 이름>/`에 사본을 맞춘다. 목록은 `peer-files/INDEX.md`, 공유 메모리 `reference-peer-files`가 이 위치를 알려 준다.
- 한 방향(원본 → 사본). 사본을 고쳐도 다음 차례에 원본 내용으로 돌아가고, 원본에서 지운 파일은 사본에서도 지운다. 공유를 그만두면 상대 PC의 사본 폴더를 지운다(원본은 그대로).
- 공유 방식: 기본 **코드·문서만**(코드·설정·문서·스크립트 확장자만 — 2026-10-05 회사 YM_Inv 가 그림·PDF 로 100MB 를 채워 코드가 밀려났다), 폴더마다 "그림 포함"으로 바꿀 수 있다(`POST /api/shared-folders/:id` `{mode}`).
- 늘 빼는 것: node_modules·.git·dist·build·out·캐시·가상환경 폴더, 2MB 넘는 파일, 영상·소리·압축·실행 파일·프로젝트 바이너리(psd·aep·prproj 등). 폴더당 5,000개·100MB까지.
- 구글 드라이브로 이미 두 PC에 보이는 폴더는 공유 폴더 대신 아래 "드라이브 작업 폴더"로 등록한다.
- `peer-files`는 공유 기억 동기화 범위 밖이라 다시 돌려보내지 않는다. 파일 보기 창에서 열 수 있다(허브 폴더 안).
- API: `GET /api/shared-folders`(이 PC 공유·받은 사본), `POST /api/shared-folders` `{path,name}`, `DELETE /api/shared-folders/:id`, `GET /api/shared-folders/offer`(상대 PC용 목록), `GET /api/shared-folders/:id/manifest`, `GET /api/shared-folders/:id/file?rel=`, `POST /api/shared-folders/pull`. 시험 `tests/shared-folders.test.mjs`.

## 드라이브 ODDIN 폴더 — 공유 기억 사본·자산 (`lib/drive-hub.mjs`)
- 2026-10-05 사용자 "'오딘' 공유폴더를 만들고 거기에 정리된 메모리랑 자산들을 넣자". 구글 드라이브 `내 드라이브/ODDIN` 하나에 두 PC가 함께 쓸 것을 모은다(두 PC가 같은 구글 계정이라 같은 폴더가 보임 — 집 D:, 회사 G:). 연결된 PC 탭 "드라이브에 ODDIN 폴더 만들기"(`POST /api/drive-hub`)로 한 번 만들면 다른 PC는 표식 파일 `ODDIN/.oddin.json`(id·만든 PC)을 보고 알아서 쓰기 시작한다.
- 구성: `README.md`(설명) · `공유 기억/`(`~/.ai-shared` 공유 범위 사본: AGENTS.md·memory·commands·agents·sync, PC마다 따로인 파일 제외) · `자산/<PC 이름>/<폴더>/`(각 PC의 공유 폴더를 원본 PC가 올린 것) · `자산/공용/`(사람이 직접 넣는 함께 쓸 파일).
- 공유 기억: 로컬 `~/.ai-shared`가 계속 작업본이다(CLI 훅·Claude 메모리 정션이 빠르고 드라이브가 꺼져도 동작). `SharedSync`가 드라이브 `공유 기억/`을 상대 하나(id `drive:<ODDIN id>`)로 같은 3방향 방식으로 맞춘다 — 20초마다(`config.sharedSync.driveIntervalSeconds`)·로컬 파일이 바뀔 때. 밀린 판은 드라이브가 아니라 이 PC `backups/sync/`에. 드라이브가 만드는 `이름 (1).md` 충돌 사본·`desktop.ini`·`.tmp.drive*`는 맞추지 않는다.
- 합류: 만든 PC는 바로 다 올린다. 다른 PC는 처음 본 뒤 5분(`joinMs`) 동안 같은 파일만 기준으로 삼고 올리지 않는다 — 만든 PC가 올리는 중인 파일을 또 올려 드라이브에 같은 이름 파일이 둘 생기지 않게.
- PC끼리 쉬기: 각 PC는 드라이브 합류가 끝나고 마지막 맞추기가 성공하면 `GET /api/shared/manifest`에 `driveHub`(ODDIN id)를 싣는다. 상대 manifest의 `driveHub`가 내 것과 같으면 PC끼리 직접 맞추기는 쉬고(연결된 PC 줄 "구글 드라이브 ODDIN 폴더로 맞추는 중") 드라이브로만 맞춘다. 한쪽 드라이브가 멈추면 다시 직접 맞춘다.
- 자산: `SharedFolders.publish`가 이 PC 공유 폴더를 `자산/<이 PC>/<폴더>/`로 한 방향으로 올린다(원본과 같게, 코드·문서만/그림 포함 방식 그대로, 그만두면 지움). 상대 offer의 `driveHub`가 같으면 `peer-files`로 받지 않고 예전 사본을 지운 뒤 목록(`peer-files/INDEX.md`)에 드라이브 위치를 적는다. `자산/`은 작업 폴더 목록에 "드라이브 · ODDIN 자산"으로 나오고 PC 탭에서 "여기서 작업"으로 연다.
- 끄기 `config.driveHub.enabled:false`. 시험 서버(`HUB_SKIP_CLI_INSTALL=1`)는 `HUB_DRIVE_ROOT`(가짜 드라이브 위치)를 주지 않으면 진짜 드라이브를 쓰지 않는다.
- API: `GET /api/drive-hub`(드라이브 위치·ODDIN 폴더·드라이브 맞추기 상태·자산 목록), `POST /api/drive-hub`(만들기, 이미 있으면 그대로). 시험 `tests/drive-hub.test.mjs`.

## 드라이브 작업 폴더 — 두 PC가 같은 폴더에서 작업 (`lib/drive-folders.mjs`)
- 2026-10-05 사용자 "PC탭에서 구글 드라이브로 맞춰지는 폴더를 등록하면 거기 안에서 작업". 구글 드라이브 앱이 두 PC에 맞추는 폴더(내 드라이브·"다른 컴퓨터"로 백업한 폴더)를 연결된 PC 탭 "드라이브 작업 폴더"에 경로·이름으로 등록하면, 두 PC의 ODDIN이 각자 자기 경로에서 그 폴더를 작업 폴더로 쓴다. 공유 폴더(읽기용 사본)와 달리 실제 파일을 양쪽에서 고친다(드라이브가 10~20초 안에 맞춤, 2026-10-05 집↔회사 실측).
- 목록은 공유 기억 `~/.ai-shared/sync/drive-folders.json`(공유 기억 동기화로 두 PC에 같음): 폴더마다 `id`·`name`·`fingerprint`(맨 위 항목 이름 목록, `desktop.ini`·`.tmp.drive*` 등 드라이브 부속 파일 제외)·`paths{PC id: 경로}`.
- 다른 PC 경로 찾기: 등록하면 목록을 바로 맞추고 연결된 PC에 `POST /api/drive-folders/resolve`를 보낸다. 각 PC는 시작 5초 뒤·2분마다·"다른 PC 경로 다시 찾기"로 아직 경로가 없는 폴더를 자기 드라이브(드라이브 문자 D~Z에서 `내 드라이브`/`My Drive`·`다른 컴퓨터`/`Other computers`를 찾음, 시험은 `HUB_DRIVE_ROOT`)의 내 드라이브 2단계·다른 컴퓨터/*/*·알려진 프로젝트 폴더 중 지문이 가장 비슷한(0.6 이상) 폴더로 채운다. 이름이 비슷해도 내용이 다르면 고르지 않는다(이름이 같은 영상 작업물 폴더와 문서 보관함 폴더를 구별). 점수가 거의 같으면(0.05 안) 이 PC의 원본 폴더(알려진 프로젝트) → 내 드라이브 → 다른 컴퓨터 백업 순으로 고른다 — 원본 PC의 드라이브에는 자기 백업도 "다른 컴퓨터"에 보이기 때문(원본 폴더를 먼저). 못 찾으면 "경로 직접 지정".
- 같은 기억: 경로가 정해질 때마다 모든 PC 경로를 `sync/config.json`의 `memoryAliases`에서 한 프로젝트 메모리 폴더로 잇는다(처음 등록한 PC 경로의 메모리).
- 작업 폴더 목록·플래너 후보에 "드라이브 · 이름"으로 위쪽에 나온다(`lib/projects.mjs`). PC 탭의 "여기서 작업"은 이 PC 경로로 새 세션을 연다.
- 같은 파일 동시 수정 방지: 작업자가 시작하기 전(`jobs.driveGuard`) 연결된 PC가 같은 드라이브 폴더에서 진행 중인 요청이 있는지 `GET /api/drive-folders/busy`로 묻고, 상대가 먼저 시작했으면(요청 생성 시각, 같으면 PC 이름순) 끝날 때까지 20초마다 확인하며 기다린다. 최대 `config.driveFolders.waitMinutes`(기본 30분) 뒤에는 그대로 시작하고, 기다린 사실은 요청 메모에 남는다.
- 작업 지시문(`buildWorkerPrompt`의 `driveFolder`)에 "두 PC가 함께 쓰는 폴더, 다른 PC 경로, 큰 임시 파일·node_modules·가상환경·git 저장소 만들지 말 것"을 붙인다.
- API: `GET /api/drive-folders`(드라이브 위치·폴더·이 PC 경로·다른 PC 경로·진행 중), `POST /api/drive-folders` `{path,name}`, `POST /api/drive-folders/:id/path` `{path}`, `DELETE /api/drive-folders/:id`(등록만 뺌), `POST /api/drive-folders/resolve`, `GET /api/drive-folders/busy`. 시험 `tests/drive-folders.test.mjs`.

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
