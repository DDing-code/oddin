# ODDIN 스튜디오

2026-10-10 사용자 요구: "오딘에 딱 맞는 영상편집 툴을 만들거야 … 간단한 싱크 수정/디자인/모션 수정" → 같은 날 "오딘 내에 만드는 게 아니라 오딘과 연동(프리미어/애프터이펙트 플러그인처럼)되는 프로그램으로 만들고 싶은데… 몽타주 뭐시기나 하이퍼프레임처럼 내가 사용한 스킬을 최적화해서 합치고 싶어", "원본 끌어 넣기랑 프리미어 가져오기도 만들어줘 + 폰트 설치".
분석·설계: `replica/recon.md`(프리미어·AE 화면·흐름·사용자 기준), `replica/features.csv`(기능 표 — `python <스킬>/replica-diff/parity.py replica/features.csv`), `replica/architecture.md`.

## 무엇인가

**따로 켜는 영상 편집 프로그램**이다. ODDIN 안에 있지 않고, 켜지면 ODDIN 허브에 붙는다(프리미어·AE 플러그인처럼). AI 작업자가 1차 편집을 만들고, 사용자는 스튜디오 창(집·회사 PC) 또는 ODDIN 주소의 `/studio/`(원격·폰)에서 **싱크·디자인·모션**을 손본 뒤 MP4로 뽑는다. 편집 하나 = 원본 옆 **`<이름>.oddin-edit.json` 파일 하나**. AI와 사용자가 같은 파일을 고친다 — 편집기는 2초마다 파일을 확인해 바뀌면 다시 읽고, 사용자의 변경은 0.7초 뒤 자동 저장한다(그 사이 다른 곳이 바꿨으면 409 → "다시 읽기 / 내 것으로 덮기").

AI 쪽 사용법(합친 공유 스킬): `~/.ai-shared/skills/oddin-studio/` — 라우터 `SKILL.md`, 제작 흐름 `pipelines/<이름>/PIPELINE.md`(edit·mukbang·pixel-shorts·chart-reels·instatoon·motion-scene·sound), 지식 `references/`(편집 형식·HTML 장면·어도비·Remotion·사용자 품질 기준). OpenMontage(AGPL — 코드는 쓰지 않고 3층 구조만)·HyperFrames(Apache-2.0 — HTML 장면 방식) 를 참고했다. 합치기 전 원래 스킬 13개는 `~/.ai-shared/backups/skills/merged-into-oddin-studio-20261010/`.

## 구조 (`studio/`)

| 부분 | 파일 | 하는 일 |
| --- | --- | --- |
| 엔진 | `engine/server.mjs` (Node 22, 의존성 없음, 127.0.0.1:7710 — `config.json` `studio.port`) | 화면(`ui/`)·API(`/api/*`)·실시간 알림(`/api/events`, SSE). 켜지면 허브에 `hello`(15초마다) |
| 편집 | `engine/edit.mjs` | 편집 파일 읽기·저장(409)·새로(영상·빈 편집)·원본 넣기·SRT·점검·렌더 |
| 원본 | `engine/media.mjs` | ffprobe 정보(영상·소리·그림·HTML 장면)·파형(초당 100개)·썸네일 띠, 캐시 `studio/data/cache` |
| HTML 장면 | `engine/scene.mjs` + `ui/scene-seek.js` | HTML 파일 → 프레임마다 시각 맞춰 찍기 → 영상(.mov 투명·.mp4) |
| 장면 출처 | `engine/scene-origin.mjs` (127.0.0.1:7711 — 엔진 포트 + 1, `STUDIO_SCENE_PORT`) · `engine/http.mjs`(두 서버 공용 파일 보내기) | HTML 장면만 내주는 두 번째 서버. 파일 읽기만, API 없음(아래 "장면 출처 분리") |
| 글꼴 | `engine/fonts.mjs` | 등록된 글꼴 목록(PowerShell 로 레지스트리 UTF-8) · 등록이 풀린 글꼴 찾기 · 사용자 글꼴로 설치 |
| 프리미어 | `engine/premiere.mjs` + 플러그인 `ODDIN.pr.editExport`(`adobe/plugin/host/oddin.jsx`) | 열린 시퀀스 → 편집 파일 |
| 허브 잇기 | `engine/hub.mjs` · 허브 `lib/studio-link.mjs` | hello·열기 범위·AI 작업·프리미어 명령 / 허브의 `/studio/` 비추기·켜기·설치 |
| 켜기 | `engine/launch.mjs` | 명령줄·허브·창 공통: 엔진이 꺼져 있으면 숨겨서 켠다 |
| 화면 | `ui/index.html`·`shell.js`·`home.js`·`editor.js`·`video-core.js`·`render.html` | 시작 화면·편집기·공용 코어(미리보기와 렌더가 같은 계산·그리기)·렌더용 글자 페이지 |
| 창 | `app/` (Electron 44.5.1, 자체 `package.json`) | 엔진 화면을 띄우는 껍데기 — 끌어 놓은 파일의 실제 경로·탐색기 보기·바로가기 |
| 명령줄 | `cli.mjs` | AI·사람용(아래) |
| 제작 흐름 | `pipelines/*.json` | 시작 화면 "AI 제작 흐름" 카드 → ODDIN 작업으로 맡김(스킬 파이프라인을 따르라는 지시문) |

엔진은 따로 도는 프로세스라 창을 닫아도 남는다(AI 가 계속 쓸 수 있게). 끄기: `node studio/cli.mjs quit` 또는 ODDIN PC 탭 "ODDIN 스튜디오 › 끄기". 렌더 중이면 거절한다.

## 여는 곳

- 프로그램: 시작 메뉴·바탕화면 "ODDIN 스튜디오"(ODDIN PC 탭 "프로그램 설치"가 `studio/app`에 Electron 을 받고 바로가기를 만든다). 설치 전에는 Edge 앱 창으로 열린다.
- ODDIN 화면: 경로 오른쪽 클릭 → 편집 파일 "ODDIN 스튜디오에서 열기", 영상 "ODDIN 스튜디오로 편집하기"(`public/studio-link.js`) · 작업 카드(결과에 편집 파일 경로) · 검색 팔레트 · PC 탭. 이 PC 화면이면 허브가 엔진을 켜고 창에서 연다(`POST /api/studio/start {open}`), 원격·폰이면 `/studio/?path=` 새 탭.
- 명령줄: `node studio/cli.mjs open <편집파일|영상>` — 창이 있으면 그 창에서, 없으면 창을 띄운다.
- 주소: `http://127.0.0.1:7710/?path=<편집파일>` · `?video=<영상>`(새 편집).

## 화면

- **시작 화면**: 새로 만들기(영상으로 시작 · 빈 편집(크기·fps) · **프리미어에서 가져오기**(열린 프로젝트의 시퀀스 고르기 → 편집 파일을 둘 폴더) · HTML 장면 → 영상) · 최근 편집 · AI 제작 흐름(파이프라인 카드 → 입력 → ODDIN 에 맡기기, 진행 상태) · 글꼴(등록이 풀린 글꼴 "모두 설치", 글꼴 파일로 설치) · 연결 상태(ffmpeg·ODDIN).
- **원본 패널**(왼쪽, "원본" 단추로 열고 닫음): 이 편집에 쓴 원본 · 폴더 둘러보기(편집 폴더부터). 줄을 **타임라인 트랙이나 화면으로 끌어 넣기**, `+`·두 번 누르기 = 재생 헤드에 넣기, SRT 줄 = 자막 트랙으로, 글꼴 파일 = 설치, 다른 편집 파일 = 열기. 올리기 단추 = 이 기기 파일을 편집 폴더로 복사해 넣기(원격·폰).
- **탐색기에서 끌어 놓기**: 타임라인 트랙(그 시각·그 트랙) 또는 화면(재생 헤드). 프로그램 창이면 실제 경로를 그대로 쓰고, 브라우저(원격 등)면 편집 폴더로 올린 뒤 넣는다. 여러 개면 차례로 이어 붙이고 되돌리기는 한 번.
- **넣는 규칙**(`video-core.js placeMedia` — 화면·명령줄 공통): 같은 경로 원본은 다시 씀 · 고른 트랙이 맞는 종류이고 비었으면 거기, 아니면 같은 종류의 빈 트랙, 없으면 새 트랙(영상 트랙은 마지막 영상 트랙 바로 뒤 = 위에 그려짐) · 영상을 소리 트랙에 놓으면 소리만 · 그림은 3초, 화면보다 작으면 원래 크기(`fit:"none"`).
- **미리보기**: 원본 `<video>`(원본마다 A/B 두 개로 컷 경계 끊김을 줄임) · 그림 `<img>` · HTML 장면 `<iframe>`(장면 출처에서 띄우고 postMessage 로 시각 맞추기) + 글자 레이어. 눌러 고르기는 화면 좌표로 맨 위 클립을 찾는다(회전 포함).
- **타임라인·속성·단축키**: 이전과 같다(트랙·막대 끌기·가장자리 자르기·자석·리플·자막 붙여 두기·썸네일·파형·마커 / 글·시간·글자 모양·등장/퇴장·위치·크기·회전·불투명도·키프레임·이징 7종·펀치 인/아웃 / Space·←→·S·[ ]·Q W·, .·Delete·T·M·J K L·Ctrl+Z/Y/S). 화면 맞춤에 "원래 크기" 추가. 그림 클립은 앞으로도 늘릴 수 있다. HTML 장면 클립은 "장면 다시 읽기"·"장면 파일 열기".
- **자막 점검**에 없는 글꼴이 있으면 "글꼴 찾아 설치"(등록이 풀린 파일) · "파일로 설치…".
- **AI에게**: 고른 것·재생 헤드 시각을 붙여 ODDIN 에 작업으로(엔진 `POST /api/ai` → 허브 `/api/jobs`, `reserve:true` — 그 세션이 작업 중이면 예약). 편집 파일마다 세션을 이 브라우저에 기억해 이어 간다.

## 엔진 API (`studio/engine/server.mjs`)

| 경로 | 하는 일 |
| --- | --- |
| GET `/api/status` · `/api/events`(`?app=1` = 프로그램 창) | 상태 · 실시간 알림(render·scene·edit_saved·open·fonts) |
| POST `/api/open {path, launch}` · `/api/quit {force}` | 창에서 열기(창이 없으면 띄움) · 엔진 끄기 |
| GET·PUT `/api/edit` · GET `/api/mtime` · POST `/api/new {video}` · `/api/blank {dir,title,width,height,fps}` | 편집 파일 |
| POST `/api/add {path, files[], at, track, length}` · `/api/import-srt {path, srt\|text, name}` · GET `/api/check` · `/api/srt` | 원본 넣기 · SRT · 점검 |
| GET `/api/probe` · `/api/peaks` · `/api/thumbs` · `/api/file` · `/api/raw/<경로>` · `/api/list` · POST `/api/upload?dir=&name=` | 원본 · 파일(구간 요청) · 경로 그대로 읽기 · 폴더 목록 · 올리기(20GB 까지, 미디어·SRT·글꼴만). `/api/file`·`/api/raw` 의 HTML·SVG 는 스크립트 없이 보기만(`Content-Security-Policy: sandbox`) |
| GET `/api/fonts` · `/api/fonts/installable` · POST `/api/fonts/install {files\|all}` | 글꼴 |
| POST `/api/render` · `/api/render/:id/cancel` · GET `/api/renders` · POST `/api/scene {path,out,width,height,fps,duration,alpha,wait}` · GET `/api/scenes` | 렌더 · HTML 장면 → 영상 |
| GET `/api/scene-url?path=<장면>&edit=<편집 파일>` → `{ url, live }` | 미리보기가 HTML 장면을 띄울 주소. 이 PC 는 장면 출처 주소(`live:true`), 원격은 스크립트 없는 `api/raw/…`(`live:false`) |
| GET `/api/premiere/status` · POST `/api/premiere/import {sequence, outDir}` | 프리미어(이 PC 화면에서만) |
| POST `/api/ai {goal, sessionId\|cwd}` · GET `/api/ai/:id` · GET `/api/pipelines` · POST `/api/pipelines/run {id, inputs}` | ODDIN 에 맡기기 |

**지키기**: Host 는 `127.0.0.1:포트`·`localhost:포트`만. 쓰기 요청은 출처가 자기이거나 출처 없음(명령줄)이거나 허브 프록시(`x-oddin-via: hub`)만 — 다른 웹페이지가 몰래 부르지 못한다. 브라우저가 **다른 출처의 페이지에서 보낸 `/api/*` 요청**(`Sec-Fetch-Site: cross-site`·`same-site`)은 읽기도 403(이 화면은 `same-origin`, 주소창은 `none`, 머리가 없으면 브라우저가 아닌 호출 — 통과. 허브가 비춘 요청은 허브가 이미 걸러 통과). 허브가 `x-oddin-remote: 1`을 붙인 원격 요청은 허브 열기 범위(`/api/studio/roots`)의 폴더만 연다. 이 PC 창·명령줄은 어디든.

### 장면 출처 분리 (2026-10-12)

**왜**: HTML 장면은 받아 온 템플릿일 수 있다. 예전에는 미리보기 iframe 과 렌더 탭이 장면을 엔진 주소(`/api/raw/<경로>`)로 열어서, 장면 안의 스크립트가 **엔진과 같은 출처**로 돌았다 — `parent`(편집기 화면)나 `fetch('/api/…')`로 아무 파일 읽기·ODDIN 작업 만들기·렌더·글꼴 설치를 부를 수 있었다.

**어떻게**:
- 엔진이 두 번째 HTTP 서버(**장면 출처**, `engine/scene-origin.mjs`)를 `127.0.0.1` 의 다른 포트에 띄운다. 기본 = 엔진 포트 + 1(7711), `STUDIO_SCENE_PORT` 로 바꾸고, 쓰는 중이면 빈 포트(`/api/status` 의 `scenePort`). **파일 읽기만** 하고 API 가 없다. GET·HEAD 만, Host 는 `127.0.0.1:포트`·`localhost:포트`만(DNS 리바인딩), `nosniff`.
- 주소는 `http://127.0.0.1:<장면 포트>/m/<mount>/<루트 기준 상대 경로>` 뿐. `mount` = 엔진이 등록한 폴더(루트)의 토큰 — 엔진을 켤 때 만든 비밀값으로 폴더 경로를 HMAC 한 24자(같은 폴더는 같은 토큰, 엔진을 다시 켜면 바뀜). **루트** = 편집 파일 폴더 안에 장면이 있으면 그 편집 파일 폴더, 아니면 장면 파일의 폴더. 루트 밖(`..`·절대 경로·정션/심볼릭 링크 너머 — realpath 로 확인)은 404. 장면이 쓰는 그림·글꼴·json 은 같은 출처의 상대 경로라 그대로 되고, CDN(https)도 된다.
- `.html` 은 `</body>` 앞(없으면 끝)에 시각 맞춤 스크립트(`ui/scene-seek.js`)와 postMessage 다리를 넣어 내준다. **미리보기**(`ui/editor.js`)는 `GET /api/scene-url` 로 받은 주소를 iframe 에 넣고(sandbox 속성 없음 — 다른 출처라 안을 못 만진다), 장면의 `{ oddinSceneReady: true }` 를 기다렸다가 `{ oddinSeek: 초, id }` 를 보낸다(답 `{ oddinSeeked: 초, id }`). "장면 다시 읽기"·엔진이 다시 켜졌을 때는 주소를 새로 받는다.
- **렌더**(`scene.mjs`·`edit.mjs`·`/api/scene`)의 숨은 브라우저 탭도 같은 장면 출처 주소를 연다. 고정 씨앗(`PRE_JS`)·시각 맞춤은 전처럼 CDP 로 넣는다.
- **엔진 쪽**: 위 "지키기"의 `Sec-Fetch-Site` 거절(장면 출처는 같은 127.0.0.1 의 다른 포트라 `same-site`) + `/api/file`·`/api/raw` 의 HTML·SVG 는 `Content-Security-Policy: sandbox` — 엔진 출처에서는 남의 문서의 스크립트가 돌 길이 없다.

**알아 둘 것**: 장면은 자기 루트 안의 파일은 읽을 수 있다(그림·글꼴을 쓰려면 필요) — 믿지 못할 장면을 중요한 파일과 같은 폴더에 두지 않는다. 루트 밖 자원(`../` 로 편집 폴더 위, 따로 뽑는 장면의 윗 폴더)은 더는 읽히지 않는다. 원격(ODDIN `/studio/` 비춤)은 이 PC의 장면 출처에 닿을 수 없어 미리보기의 HTML 장면이 스크립트 없는 멈춘 화면으로 보인다(렌더는 PC 에서 하므로 그대로).

## 허브 쪽 (`lib/studio-link.mjs`, `server.mjs`)

| 경로 | 하는 일 |
| --- | --- |
| POST `/api/studio/hello` · `/bye` · GET `/api/studio/roots` | 엔진 알림 · 열기 범위(이 PC 에서만) |
| GET `/api/studio/status` | 켜짐·판·창 수·프로그램 설치 여부·설치 기록 |
| POST `/api/studio/start {open, window}` · `/stop` · `/install` | 켜기(엔진 + 창) · 끄기 · 프로그램 설치(제어 — 원격은 ODDIN 화면에서만, 설치는 이 PC 에서만) |
| `/studio/*` | 엔진 화면·API 비추기(스트리밍·SSE). 클라이언트의 `x-oddin-*` 머리는 지우고 `x-oddin-via: hub`·`x-oddin-remote` 를 붙인다. 문서를 열 때 화면 쿠키를 줘 원격 스튜디오 화면도 바꾸기 요청을 할 수 있다(`hub-auth.isControl`: `/studio/` 의 GET 외는 제어). 꺼져 있으면 "켜기" 안내 페이지 |

## 렌더

1. HTML 장면 원본은 먼저 투명 영상(PNG 코덱 .mov)으로 만들어 둔다(`scene.mjs sceneClip`, 장면 파일·폴더 파일들·크기·fps·길이가 같으면 캐시 `data/cache/scenes`).
2. 모든 클립 경계(프레임에 붙임)로 시간 조각을 나눈다. 조각마다 ffmpeg 하나: 그 시각 보이는 클립(영상은 `-ss` 정확한 자르기, 그림은 `-loop 1`) → `fps` → 확대 전 고정 크기 `scale` → `format=rgba` → (회전) → (불투명도) → **크기가 바뀌는 `scale ... eval=frame`은 맨 끝** → `overlay`. 소리: `volume`·`afade`·`apad/atrim` → `amix(normalize=0)`. 조각은 H.264(crf 12)+PCM mkv, 동시에 `config.video.parallel`(기본 3)개.
3. 조각을 concat 으로 잇고, 글자 레이어가 있으면 엔진 브라우저(Edge 헤드리스, 프로필 `studio/data/browser-profile`)가 `ui/render.html`로 프레임마다 그린 투명 PNG(서명이 같으면 재사용)를 합성 → libx264(crf 18)+AAC 192k. 결과는 편집 파일 옆 `<이름>.mp4`(있으면 `<이름> (2).mp4`).
4. 키프레임 이징은 JS(`video-core.js EASE`)와 ffmpeg 식(`EASE_EXPR`·`keyExpr`)이 같은 공식 — 시험이 값을 대조한다.

## HTML 장면

장면 = HTML 파일 하나(같은 폴더의 그림·글꼴 상대 경로 가능 — 장면은 엔진과 다른 출처에서 뜨고 자기 루트 안만 읽는다, 위 "장면 출처 분리"). 길이·크기 `<html data-duration="5" data-width="1080" data-height="1920">`(또는 `<meta name="oddin-scene" content="duration=5;width=1080;height=1920">`, HyperFrames 식 `data-composition-id` 루트). 시각 맞추기(`ui/scene-seek.js`, 미리보기·렌더 공통): 페이지의 `window.oddinSeek(t)` → HyperFrames 식 `window.__timelines`(GSAP) → `gsap` 전역 타임라인 → CSS·Web Animations → `<video>`. 렌더 때 `Math.random` 은 고정 씨앗. 배경은 투명.

## 프리미어 가져오기

플러그인 명령 `ODDIN.pr.editExport({id|name})`(ASCII 전용 `oddin.jsx`, 플러그인 1.2.0)이 시퀀스 크기·fps(timebase)·트랙·클립(시퀀스 위치·원본 in/out·미디어 경로·속도·꺼짐)·클립 구성 요소 날것(matchName·표시 이름·속성 값·키프레임)·마커를 넘기고, `engine/premiere.mjs`가 뜻을 정한다(고칠 때 플러그인을 다시 깔지 않게). 옮기는 것: 컷·원본 구간, 모션(위치 0~1 → 픽셀, 크기 %, 회전), 키프레임 값(시각은 클립 원본 시각 → 클립 시작 기준, 이징은 "일정하게"), 불투명도, 소리 크기(Level → dB, `20·log10(v)+15` — 커뮤니티 공식, 추정), 글자 클립의 글(Source Text), 마커. 영상 트랙은 소리를 끄고 소리 트랙이 낸다(프리미어 구조). 못 옮기는 것은 문제 목록으로 알린다: 속도·꺼 둔 클립·효과·전환·그래픽/조정 레이어·**캡션 트랙**(스크립트로 읽을 수 없음 → 프리미어에서 SRT 로 내보내 원본 패널에서 넣기). 편집 파일은 프로젝트 폴더에 `<시퀀스 이름>.oddin-edit.json`(있으면 `(2)`).

## 글꼴 설치

윈도는 글꼴 파일이 폴더에 있어도 레지스트리에 등록돼 있지 않으면 어떤 프로그램도 못 쓴다(2026-10-10 이 PC 사용자 글꼴 폴더에 등록이 풀린 파일 116개 — 배민 도현·부크크·Pretendard·Paperlogy 등 — 를 다시 등록). 설치는 지금 사용자 계정에만(관리자 아님): 사용자 글꼴 폴더(`%LOCALAPPDATA%\Microsoft\Windows\Fonts`, 밖의 파일은 복사·덮어쓰지 않음) + HKCU 등록 + `AddFontResource` + `WM_FONTCHANGE` 알림. 이미 켜져 있던 프로그램(프리미어 등)은 다시 켜야 보인다. 되돌리기: 윈도 설정 › 글꼴에서 지우기.

## 명령줄 (`studio/cli.mjs`)

```
node studio/cli.mjs status | open <편집|영상> | new <영상> | blank <폴더> | add <편집> <원본…> [--at 초] [--track id] [--len 초]
node studio/cli.mjs check <편집> | import-srt <편집> <SRT> [이름] | srt <편집> | from-premiere [--seq 이름] [--out 폴더]
node studio/cli.mjs scene <장면.html> [--dur 초] [--size 1080x1920] [--fps 30] [--out x.mov|x.mp4] | render <편집> [--wait]
node studio/cli.mjs fonts [--missing] | fonts install <파일…|--all> | pipelines | quit
node studio/cli.mjs speakers <촬영본> [--words 전사.json] [--keep 구간.json|편집파일] [--out 결과.json] [--all] [--no-video]
```

## 종이 편집표 (`studio/engine/paper.mjs`, 2026-10-12)

사용자 "숏폼이어도 PD 목소리가 들어갈 때가 있고, 리드만 할 때가 있는데 실제 편집 PD처럼 하는 과정이 필요". `cli.mjs paper <촬영본> --script 대본.txt --words 전사.json [--out 표.md]` — 컷을 자르기 전에 대본과 촬영본을 줄 단위로 맞춘다.

- 대본(`readScript`): 한 줄에 대사 하나, 줄 앞의 `PD:`·`Q:`·`질문:` = 화면 밖 사람의 대사, `출연자:`·`A:`·표시 없음 = 출연자, `자막:`·`내레이션:` = 촬영 대사 아님.
- 말 덩어리(아래 "누가 말했나")를 발화로 묶고(`utterances`) 가장 닮은 대본 줄에 붙인다(`matchLine`).
- 화면 밖 목소리의 종류: **선창**(출연자가 같은 문장을 뒤에 따라 함 → 뺌) · **내용**(대본에 PD 대사 → 씀) · **질문으로 보임**(표시는 없는데 출연자가 따라 하지 않고 다음 줄로 대답 → 확인) · **확인 필요**. 대본에 없는 화면 밖 말은 **지시·잡담**(뺌). 선창이 세 번 넘게 확인되고 대본에 PD 표시가 없으면 "읽어 주고 따라 하기" 촬영으로 보고 질문으로 단정하지 않는다.
- 줄마다 고를 것: 온전한(낱말 80% 이상) 출연자 테이크 중 마지막. `--out`을 주면 표(.md)·자료(.json)·고른 구간(.keep.json — PD 내용 목소리는 `speaker:"pd"`)을 쓴다. `speakers --keep`은 `speaker:"pd"` 구간을 일부러 남긴 것으로 보고 넘어간다.
- 작업자 절차는 공유 스킬 `oddin-studio`의 shortform 파이프라인. 시험 `tests/paper.test.mjs`.

## 누가 말했나 (`studio/engine/speakers.mjs`, 2026-10-12)

촬영본에서 **화면 속 출연자의 말**과 **화면 밖(PD·코치) 목소리**를 가른다. 사용자 "오딘한테 영상편집 맡겼는데 PD 리드멘트가 다 들어갔어" — 작업자 AI는 소리를 못 듣고, 받아쓴 글에는 PD가 먼저 읽어 준 문장과 출연자가 따라 한 문장이 똑같이 나와서, 글자만 보고 고르다 PD 쪽을 넣었다(그 전에는 글자만 보고 지우다 출연자 말을 잘랐다). 엔진을 켜지 않고 명령줄에서 바로 돈다(4K 7분 원본에 40초쯤, 의존성 없음 — ffmpeg 만).

- **말 덩어리**: 10ms 마다 크기를 재서 말 구간을 찾고, 붙어 있어도 크기가 6dB 넘게 다르면 다른 덩어리로 나눈다(선창 바로 뒤에 따라 해도 갈림).
- **소리 크기**: 덩어리 크기 분포에서 가장 큰 목소리 무리 바로 아래의 골짜기를 가르는 선으로 삼는다(옷깃 마이크면 출연자가 뚜렷이 크다. 출연자·코치·PD 셋이어도 맨 위만 가른다).
- **화면 움직임**: 영상을 320×320 흑백 15fps 로 줄여 칸(32×32)마다 움직임을 재고, 어느 무리가 말할 때 화면 속 사람이 움직이는지 본다(칸은 절반의 덩어리로 고르고 나머지 절반으로 잰다). 큰 목소리와 맞으면 `level+motion`, 작은 목소리와 맞으면(카메라 옆 PD가 더 크게 녹음됨) `motion`. 골짜기가 없으면 "이 크기 위는 움직이고 아래는 안 움직인다"가 가장 잘 맞는 크기를 선으로 삼는다(`fitByMotion`).
- **두 마이크**(같은 날 고침): 두 채널이 서로 다른 마이크인 원본(출연자 옷깃 마이크 / PD 마이크 — `dualMics`: 말하는 동안 좌우 차이 폭이 8dB 이상)은 **좌우 차이**로 가른다(`diffSplit`). 좌우 차이는 말소리 크기와 상관없이 사람마다 일정해서 크기보다 확실하다. 무리 a = 왼쪽 채널이 더 큰 목소리, b = 오른쪽, c = 어느 쪽도 아닌 먼 소리(화면 밖). 누가 화면 속인지는 화면 움직임(`channels+motion`)으로, 안 되면 같은 문장을 먼저 읽은 쪽 → 따라 한 쪽 순서(`channels+lead`, `--words` 필요)로 정하고, 그래도 모르면 전부 `unsure`로 두고 `--on a|b`로 직접 정하게 한다. 처음에는 에너지가 큰 채널 하나만 골랐는데 그게 PD 마이크라 판정이 뒤집혔다(분당 1·9번 — 입 닫은 장면이 '화면 속').
- **결과**: 덩어리마다 `on`(화면 속)·`off`(화면 밖)·`unsure`(확인 필요)와 무리(`group` a·b·c). `on`은 확실할 때만 준다 — 선 가까이(2dB 안)이거나 크기와 화면이 어긋나면 `unsure`. 근거(`basis`): `level+motion`·`motion`은 믿을 만하고, `level`(화면 근거 없음)·`single`(한 무리)·`none`은 약하다고 보고에 적는다.
- **`--words`**: 단어 시각이 있는 전사(Whisper 꼴)를 주면 덩어리에 글을 붙이고 "먼저 읽어 주고 따라 한 쌍"을 찾는다. **`--keep`**: 편집본이 남긴 원본 구간(`[{source,start,end,text}]` 또는 편집 파일)을 주면 그 안에 든 화면 밖 목소리를 적고(같은 문장을 화면 속에서 말한 곳도), 있으면 종료 코드 2.
- 한계: 두 사람이 비슷한 크기로 녹음됐고 입이 안 보이면 못 가른다. 화면에 두 사람이 나오는 대화는 대상이 아니다. 완성본(배경음·효과음 섞임)이 아니라 촬영 원본에 돌린다.
- 작업자 절차는 공유 스킬 `oddin-studio`의 edit 파이프라인 "화면 밖 목소리 빼기", 사용자 기준은 그 스킬 `references/quality.md` 4절. 시험 `tests/speakers.test.mjs`·`speakers-stereo.test.mjs`.

## 한계(다음 단계)

- 키프레임 마름모 끌기·크기 손잡이·값 그래프는 아직 없다(숫자·AI 로).
- 프리미어 XML 내보내기(스튜디오 → 프리미어)는 아직 — 지금은 SRT 와 렌더 결과로.
- 영상 클립 불투명도 키프레임은 렌더하지 않는다(고정값만).
- 브라우저가 못 여는 코덱(일부 HEVC·ProRes)은 미리보기가 안 될 수 있다(렌더는 ffmpeg 라 됨).
- 다른 PC 의 스튜디오는 그 PC 의 ODDIN `/studio/` 로 연다(허브끼리 넘기지 않음).
- 원격(`/studio/`)의 HTML 장면 미리보기는 멈춘 화면이다 — 움직이게 하려면 허브가 장면 출처도 다른 출처로 비춰 줘야 한다.

## 시험

`tests/studio.test.mjs`: 이징·키프레임 식 대조, 정리(원본 종류·그림), 원본 넣기 규칙, SRT 트랙·점검, 프리미어 변환(가짜 시퀀스), 문지기, 글꼴, 허브 비추기(머리·쿠키·꺼짐 안내), 장면 출처(루트 안만 — `..`·절대 경로·정션·다른 Host·쓰기 거절, `.html` 에 시각 맞춤 스크립트 / 실제 브라우저에서 다른 출처 iframe 에 postMessage 로 시각 맞추기·부모와 장면이 서로 못 만짐 — 브라우저가 없으면 건너뜀), 엔진 통합(새 편집·409·요청 지키기(`Sec-Fetch-Site`·HTML sandbox·`/api/scene-url`)·원본 넣기·목록·올리기·파형·허브 hello·`/studio/` 비추기·렌더 150프레임 — 그림·HTML 장면 막대 픽셀·자막).
