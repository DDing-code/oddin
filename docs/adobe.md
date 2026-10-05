# ODDIN 어도비 플러그인 (프리미어 · 애프터이펙트)

2026-10-05 사용자 요구: "따로 만든 애프터이펙트/프리미어 플러그인을 합쳐서 새로 만들어줘. 가운데 오딘 로고랑 연결 상황 여부만 있으면 될듯" → "로고는 지금 쓰는 거 쓰고 AE/PR 용 따로 설치해줘 양쪽에 다".

## 구조

- 플러그인 소스 `adobe/plugin/`(두 앱 공통) + 앱별 설정 `adobe/manifests/premiere.xml`·`aftereffects.xml`, 판 `adobe/version.json`.
  - `worker.html` + `bridge.js`: 앱이 켜질 때 함께 뜨는 보이지 않는 창(CEP `StartOn`). 허브에 붙어 명령을 기다리고 `evalScript`로 실행해 결과를 돌려준다. Node(`--enable-nodejs --mixed-context`)로 요청하므로 허브의 출처 검사에 걸리지 않는다.
  - `panel.html` + `panel.js`: 창 › 확장 › ODDIN. 가운데 로고(허브 `public/mark.svg`)와 연결 상태 한 줄만. 워커가 6초 넘게 안 보이면 패널이 대신 명령을 받는다.
  - `host/oddin.jsx`: 앱 안 도우미(`ODDIN.run`·`ODDIN.json`·`ODDIN.info`). **ASCII만**(프리미어는 이 파일을 UTF-8로 읽지 않아 한글 한 글자로 모든 명령이 깨진 기록이 있다). 판이 바뀌면 다음 명령 때 다시 읽으므로 앱을 다시 켤 필요가 없다.
- 허브 `lib/adobe-bridge.mjs`: 플러그인 쪽 `POST /api/adobe/hello`·`GET /api/adobe/next`(롱 폴링 25초)·`POST /api/adobe/result`, 작업자 쪽 `GET /api/adobe/status`·`POST /api/adobe/run`(이 PC에서만 — 앱 스크립트는 PC 명령까지 실행할 수 있다). 같은 앱이 여러 개면 화면이 있는 것 중 가장 최근 것, 화면 없이 뜬 AE(`-noui`·`-m`·`-re`, Dynamic Link·렌더 엔진)는 고르지 않는다. 시간이 지나도 명령을 다시 보내지 않는다.
- 작업자용 `scripts/adobe.mjs status | install | run <앱> (--code | --file) [--timeout 초]`, 공유 스킬 `~/.ai-shared/skills/oddin-adobe`.

## 설치

`lib/adobe-install.mjs`가 `%APPDATA%\Adobe\CEP\extensions\com.oddin.premiere`·`com.oddin.aftereffects`로 따로 복사한다(관리자 권한 불필요). 붙을 허브 주소는 `app.json`. 우리가 만든 폴더(`.oddin-plugin` 표시)만 지우고 새로 놓는다. 예전 플러그인(집 UXP 연결 패널, 회사 DDstudio `io.kea.workflow`)은 건드리지 않는다.

- PC 탭 › 어도비 플러그인 › "두 앱에 설치/다시 설치", 또는 `POST /api/adobe/install`(다른 PC에서 대신 눌러도 됨).
- 허브가 켜질 때 이미 설치된 플러그인이 예전 판이면 새 판으로 바꾼다(처음 설치는 사용자가 정할 때만).
- 서명하지 않은 CEP 확장이라 어도비 개발 모드(`HKCU\Software\Adobe\CSXS.<n>` 의 `PlayerDebugMode`="1")가 켜져 있어야 앱이 읽는다. 어도비 보안 설정이므로 ODDIN은 읽기만 하고 바꾸지 않는다 — 꺼져 있으면 PC 탭이 알려 주고, 켜는 것은 사용자가 한다.
- 처음 설치·manifest가 바뀐 뒤에는 앱을 완전히 껐다 켠다. 패널·워커 화면 코드가 바뀌어도 다시 켜야 하고, `host/oddin.jsx`만 바뀌면 다시 켤 필요가 없다.

## 시험

`tests/adobe.test.mjs`: 명령 주고받기·시간 초과·백그라운드 AE 제외·렌더 중 연결 유지·설치(두 앱 폴더, 남의 폴더 보호, ASCII 검사)·`bridge.js`를 가짜 CEP로 실제 허브 API에 붙여 보는 통합 시험.
