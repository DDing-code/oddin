# ODDIN 데스크탑 프로그램 · 원격 세션

허브 화면(`public/`)을 Electron 창으로 감싼 프로그램입니다. 허브 서버와 화면은 그대로 쓰고, 프로그램은 `desktop/` 폴더에 따로 있습니다(허브 본체는 계속 의존성 없음).

## 프로그램이 더하는 것
- 독립 창·작업 표시줄 아이콘·트레이 상주(창을 닫으면 트레이로 숨김, 트레이 메뉴의 "종료"로 끔)
- 작업 완료 알림(창이 앞에 없을 때 Windows 알림, 누르면 그 세션으로 이동), 작업 중이면 작업 표시줄 진행 표시
- 탐색기에서 파일·폴더를 끌어다 놓으면 실제 경로가 입력창에 들어감(이 PC 허브일 때). 이미지는 지금처럼 첨부
- 허브 서버가 꺼져 있으면 프로그램이 숨김 실행(`start-hub-hidden.vbs`)으로 켬. 프로그램을 꺼도 서버는 계속 돎
- **원격 세션**: 이 PC 허브와 다른 PC의 허브(Tailscale 주소)를 함께 등록해 두고, 사이드바에서 허브를 바꾸거나 다른 허브의 세션을 바로 열어 이어서 작업

## 원격 세션이 동작하는 조건
- 상대 PC의 허브가 원격 접속을 켠 상태여야 합니다(허브 설정 › 원격 접속, `docs/remote-access.md`). 두 기기 모두 같은 Tailscale 계정에 로그인되어 있어야 합니다.
- 원격 허브 주소는 `https://<기기>.<tailnet>.ts.net` 형식만 받습니다. 이 PC 허브는 `http://127.0.0.1:<포트>`입니다.
- 원격 허브에서는 "폴더 열기"가 허브 PC에서 열리므로 막혀 있고, 경로 복사만 됩니다.

## 화면 ↔ 프로그램 연결 규약 (`window.hubDesktop`)
프로그램 안에서만 존재합니다. 일반 브라우저에서는 `undefined`이므로 화면 코드는 항상 존재 여부를 확인합니다. 모든 비동기 함수는 실패하면 `Error`(한국어 메시지)를 던집니다.

| 이름 | 형식 | 설명 |
|---|---|---|
| `isDesktop` | `true` | 프로그램 안인지 |
| `version` | 문자열 | 프로그램 버전 |
| `getHubs()` | `Promise<{ current, hubs }>` | `hubs`: `[{ id, name, url, local, status, error }]`. `local`=이 PC 허브, `status`='online'·'offline'·'checking' |
| `switchHub(id, { sessionId? })` | `Promise<void>` | 창을 그 허브로 전환. `sessionId`가 있으면 그 세션을 연 상태로 |
| `addHub({ name, url })` | `Promise<hub>` | 원격 허브 등록. 주소 검사 실패·연결 실패 시 오류 메시지 |
| `renameHub(id, name)` | `Promise<hub>` | 이름 바꾸기 |
| `removeHub(id)` | `Promise<void>` | 등록 해제(이 PC 허브는 해제 불가) |
| `remoteSessions()` | `Promise<[{ hubId, hubName, online, error, sessions }]>` | 지금 창에 열린 허브를 **뺀** 나머지 허브들의 세션. `sessions`: `[{ id, title, cwd, updatedAt, status, pinned }]`(최근 순, 허브당 최대 30개). `status`는 'running'·'done'·'partial'·'failed'·'cancelled'·'empty' 등 |
| `onHubsChanged(cb)` | 해제 함수 반환 | 허브 목록·상태·원격 세션이 바뀌면 호출(약 30초마다 다시 확인) |
| `onCommand(cb)` | 해제 함수 반환 | 트레이 메뉴 명령. `cb({ type })`, type: 'add-hub'(허브 추가 창 열기)·'remote-settings'(원격 접속 설정 열기)·'open-session'(`{ sessionId }`) |
| `notify({ title, body, sessionId })` | `void` | 창이 앞에 없을 때만 Windows 알림 |
| `setBusy(count)` | `void` | 실행 중 작업 수(0이면 작업 표시줄 진행 표시 끔) |
| `pathForFile(file)` | 문자열 | 끌어놓은 `File`의 실제 경로(없으면 '') |
| `isLocalHub` | 불리언 | 지금 창의 허브가 이 PC 허브인지 |

화면 쪽 파일
- `public/desktop.js` — 알림·진행 표시·경로 끌어놓기·트레이 명령 연결
- `public/hubs.js`, `public/hubs.css` — 사이드바의 허브 전환과 원격 세션 목록, 허브 추가·관리 창

## 아이콘·로고 (2026-10-04, 시안 B '엮인 O')
- 원본: `desktop/build/icon.svg`(앱 타일), `desktop/build/tray.svg`(작은 크기용, 선이 굵음). 허브 화면 로고는 투명 바탕 `public/mark.svg`(같은 고리, 엮인 자리는 마스크), 탭 아이콘은 `public/icon.svg`(= tray.svg). 데스크탑 로딩·연결 안 됨 화면은 보안 정책(img-src data:)상 mark.svg 를 HTML 안에 직접 넣었다.
- 원본을 고친 뒤: `desktop` 폴더에서 `npx electron scripts/make-icons.cjs build/icon.svg build/tray.svg` → `icon-512.png`·`icon.png`(256)·`icon.ico`(16~256)·`tray.png`·`tray@2x.png` 다시 생성. 그다음 버전을 올려 `npm run dist` → 설치.
- 설치 뒤에도 바탕화면·작업 표시줄에 옛 아이콘이 보이면 Windows 아이콘 캐시 문제다(`ie4uinit.exe -show`, 작업 표시줄 고정 아이콘은 고정을 풀었다 다시 하거나 로그아웃 후 반영).

## 알림음 (2026-10-04, 0.1.4)
- 소리는 화면(`public/sound.js`)이 낸다: 완료(밝은 두 음)·일부 완료·실패(낮은 두 음)·질문·승인 요청(띵·띵·딩). 직접 중지한 작업은 조용히. 같은 브라우저의 여러 탭이 한꺼번에 울리지 않게 4초 안의 같은 일은 한 번만.
- 앱 창은 `webPreferences.autoplayPolicy: no-user-gesture-required`라 누르기 전·숨겨진 상태에서도 울린다(일반 브라우저는 한 번 누르거나 입력한 뒤부터). 화면이 요청하는 Windows 알림은 `silent: true`(두 번 울리지 않게). 다른 허브 완료 알림은 Windows 기본 소리.
- 끄기: 왼쪽 아래 계정 메뉴 "알림음 (작업 끝·질문)".
