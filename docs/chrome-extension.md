# ODDIN 크롬 연결 (크롬 확장)

평소 쓰는 크롬(로그인된 상태)을 ODDIN 의 Claude·Codex 작업자가 쓰게 해 주는 확장 프로그램이다(2026-10-08 사용자 "크롬에서 로그인한 화면을 쓰거나 하고 싶은데 확장프로그램으로 만들어서 코덱스나 클로드가 조작할 수 있게").
ODDIN 브라우저(`lib/browser.mjs`, 따로 띄우는 Edge)는 그대로 있고, 작업자가 `browser_open` 에 `chrome: true` 를 줄 때만 크롬을 쓴다.

## 설치 (PC마다 한 번)

1. 크롬 주소창에 `chrome://extensions` 를 열고 오른쪽 위 **개발자 모드**를 켠다.
2. **압축해제된 확장 프로그램을 로드합니다**를 누르고 ODDIN 폴더의 `chrome-extension` 폴더를 고른다(예: `C:\oddin\chrome-extension`).
3. 툴바의 ODDIN 아이콘을 누르면 "ODDIN 에 연결됐어요"가 보인다. ODDIN 화면 "브라우저" 탭 위쪽에도 **크롬 연결됨**이 뜬다.

- Edge 도 같은 방법(`edge://extensions`)으로 깔 수 있다. 한 PC 에서는 한 브라우저만 연결된다(먼저 붙은 쪽).
- ODDIN 포트를 바꿨으면 팝업 아래 "ODDIN 포트"에 적는다(기본 7700).
- ODDIN 을 업데이트하면 확장 파일도 바뀐다. `chrome://extensions` 에서 ODDIN 크롬 연결의 새로고침(↻)을 누르면 반영된다.

## 쓰는 법

- 작업을 시킬 때 "내 크롬(로그인된 상태)에서 확인해 줘"처럼 말하면 된다. 작업자는 크롬에 **ODDIN 창을 따로 띄워** 그 안에 자기 탭을 연다. 보던 창·탭은 건드리지 않는다.
- 작업자가 쓰는 동안 크롬 위쪽에 "디버깅 중" 알림줄이 뜬다. **[취소]를 누르면 바로 멈추고 연결이 꺼진다**(팝업에서 다시 켬).
- 팝업에서 "AI가 이 크롬을 쓰게 하기"를 끄면 연결을 끊는다. "모두 닫기"는 AI 가 연 탭을 닫는다.
- ODDIN 화면 "브라우저" 탭에서 크롬 탭도 같이 보이고(이름 앞에 "크롬 ·") 직접 누르고 입력할 수 있다.
- ODDIN 창을 최소화하면 화면을 찍을 수 없다(그림이 안 나온다).

## 지키는 것

- 작업자는 ODDIN 이 연 탭만 다룬다. 사용자가 원래 열어 둔 탭에는 명령이 가지 않는다(`chrome-extension/core.js` `mine`).
- 쓸 수 있는 명령은 페이지 열기·읽기·누르기·입력·화면 찍기 등으로 정해져 있다(`ALLOWED`). 쿠키·저장소를 통째로 꺼내는 명령, 브라우저 끄기, 다른 탭 목록 보기는 막는다.
- 허브의 확장 전용 길(`/api/chrome-ext/*`)은 이 PC 에서만, 그 확장의 출처(`chrome-extension://bbphnjmjmoneaomdoefgepngcjlmimgk`)와 머리 `X-Oddin-Ext` 로만 부를 수 있다. 웹 페이지는 이 머리를 붙일 수 없다(사전 확인에서 막힘). 원격(Tailscale)에서는 막힌다.
- 작업자 지시문(`planner.BROWSER_RULE`): 사용자 크롬에서는 요청 범위 밖의 보내기·게시·구매·결제·삭제·계정/설정 바꾸기를 하지 않고, 비밀번호·인증 코드를 넣지 않으며, 쿠키·토큰을 꺼내거나 적지 않는다.
- 사이트가 자동 조작을 막거나 사람 확인(캡차)을 내면 작업자는 넘어가려 하지 않고 사용자에게 넘긴다.

## 구조

- 확장 `chrome-extension/`: `manifest.json`(MV3, 권한 `debugger`·`tabs`·`storage`·`alarms`, 허브 주소 `http://127.0.0.1/*`. `key` 로 확장 id 가 모든 PC 에서 같다), `core.js`(본체 — chrome·fetch 를 받아서 시험에서도 돈다), `background.js`(서비스 워커: 크롬 소식 잇기·배지·30초 알람으로 다시 깨우기), `popup.html`·`popup.js`.
- 허브 `lib/chrome-ext.mjs` `ChromeExtBrowser`: `BrowserManager`(lib/browser.mjs)를 이어받아 명령을 보내는 길(`send`)만 롱 폴링 대기열로 바꿨다. 그래서 작업자 도구·화면 보기·사용자 직접 입력이 ODDIN 브라우저와 똑같이 돈다. 탭 id 는 크롬 탭 번호(문자열).
- 주고받기(모두 POST, 머리 `X-Oddin-Ext: <확장 id>`):
  - `/api/chrome-ext/hello { instance, version, agent }` → `{ hub }` — 허브가 다시 켜지면 `hub` 가 바뀌고 확장은 예전 탭을 놓는다(탭은 열어 둠). 다른 브라우저의 확장이 지금 기다리는 중이면 409.
  - `/api/chrome-ext/poll { instance, wait }` → `{ cmds: [{ id, method, params, tab? }] }` — 최대 20초 기다림. 확장 쪽이 끊기면(서비스 워커가 꺼짐) 기다리기를 바로 거둔다.
  - `/api/chrome-ext/result { instance, results: [{ id, ok, result | error }], events: [{ method, params, sessionId? }] }`
  - 명령은 CDP 그대로. `tab` 이 없으면 `Target.createTarget`(ODDIN 창에 새 탭)·`Target.attachToTarget`(chrome.debugger 붙이기)·`Target.closeTarget` 만. 소식은 `Runtime.consoleAPICalled`·`Runtime.exceptionThrown`·`Page.javascriptDialogOpening`(디버거)와 `Target.targetInfoChanged`·`Target.targetDestroyed`(탭 바뀜·닫힘).
- 서버(`server.mjs`): `/api/browser/act` 는 `browserFor(owner, b)` 로 고른다 — `open` 의 `chrome` 값 → 그 작업자가 마지막으로 연 곳 → 그 작업자 탭이 있는 곳 → ODDIN 브라우저. `GET /api/browser`·실시간 이벤트는 두 곳의 탭을 합치고(탭마다 `where: 'oddin' | 'chrome'`) `chrome: { connected, version, browser }` 를 붙인다. `frame`·`input` 은 탭 id 로 어느 쪽인지 찾는다.
- 끄기: `config.browser.chrome: false`.

## 직접 확인

- `node --test tests/chrome-ext.test.mjs` — 가짜 크롬으로 허브↔확장을 맞물려 돌린다(열기·읽기·화면·다시 붙기·닫기, 사용자 탭·막힌 명령 거절, [취소], 두 브라우저, 출처 관문, 확장 id).
- 실제 브라우저: 시험 허브(임시 폴더·빈 포트)와 임시 프로필 Edge 에 확장을 넣고 끝까지 돌리는 스크립트 `node scripts/check-chrome-ext.mjs edge [headful]`. 정식 크롬(137 이후)은 명령줄로 확장을 넣는 것을 막아서 Edge 로 확인한다. 2026-10-08 Edge 154 창 있음·없음 모두 13개 통과.
