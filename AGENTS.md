# ai-hub — Claude Code + Codex 공동 작업 허브

로컬 대시보드(`http://127.0.0.1:7700`)에서 명령 하나를 넣으면 플래너가 작업을 쪼개 Claude Code(`claude -p`)와 Codex(`codex exec`)에 나눠 실행하고 보고서를 만든다. 의존성 없음, Node 22.

## 구조
- `server.mjs` HTTP+SSE 서버, 정적 대시보드(`public/`)
- `lib/remote.mjs` Tailscale Serve 요청 게이트·원격 설정·상태·켜기/끄기. `scripts/remote-access.mjs` 연결 관리, `scripts/restart-hub.mjs` 유휴 대기 후 허브 PID만 숨김 재시작(사용자 실행).
- `lib/jobs.mjs` 작업 상태 머신·스케줄러(의존 그래프, 동시 실행 `maxParallel`)
- `lib/planner.mjs` 계획/워커/보고 프롬프트, 계획 JSON 파싱
- `lib/workers.mjs` 두 CLI 실행기(stdin 프롬프트, JSONL 이벤트 파싱, 취소=taskkill 트리)
- `lib/tools.mjs` CLI 설치·로그인 상태 (60초 캐시)
- `lib/memory.mjs` 공유 메모리 읽기, 허브 보드(`~/.ai-shared/hub/BOARD.md`, `jobs/<id>.md`) 기록
- `lib/options.mjs` 작업별 모델·추론 강도 선택지(Codex는 `~/.codex/models_cache.json`·`config.toml`)와 검증
- `lib/usage.mjs` 구독 한도: Claude는 CLI 제어 프로토콜 `get_usage`(모델 호출 없음), Codex는 최신 `~/.codex/sessions` 기록의 `rate_limits`
- `lib/catalog.mjs` 공통 커맨드(`~/.ai-shared/commands`)·서브 에이전트(`~/.ai-shared/agents`)·스킬 목록, 입력 해석(`/goal`·`/커맨드`·`/스킬`·`@에이전트`), Claude Code·Codex 설치(표식 `ai-hub:managed` 파일만 덮어씀)
- `lib/goals.mjs` 목표 모드 라운드 지시문과 달성 판정. 진행 상태는 세션의 `goal` 필드, 반복은 `jobs.mjs`의 `afterGoalRound`
- `lib/usage.mjs`의 `balanceShare`·`headroom`·`usageWarnings` = 한도 기반 분배 비율·경고. 재배정은 `jobs.mjs`의 `rebalance`
- `lib/attachments.mjs` 이미지 업로드(서명 검사, 5MB·4장), Claude는 stream-json image 블록, Codex는 `-i`
- `data/jobs.json`·`data/sessions.json` 작업·세션(폴더별 대화, 같은 세션의 다음 요청은 이전 요청·보고를 맥락으로 받음), `data/uploads/` 첨부 이미지, `runs/<jobId>/` 실행 기록
- `public/` 데스크탑 앱형 화면. `app.js` = 대화·입력·작업 카드, `side.js` = 왼쪽 사이드바(고정·폴더별/날짜별·⋯/우클릭 메뉴·바로 이름 바꾸기·안 읽음 표시·계정/설정), 오른쪽 패널(작업·파일·사용량·정보 탭), Ctrl+K 검색, 양쪽 너비 조절. `side.js`는 `app.js` 다음에 읽히고 시작은 DOMContentLoaded.
- `workspace/` 프로젝트를 고르지 않았을 때 기본 작업 폴더
- `desktop/` 데스크탑 프로그램(Electron, 자체 `package.json`·`node_modules` — 허브 본체는 계속 의존성 없음). `main.cjs` 창·트레이·알림·허브 전환·원격 세션 조회, `preload.cjs` 화면 연결 객체 `window.hubDesktop`, `lib/hubs.cjs` 허브 목록·주소 검사(시험 `tests/desktop-hubs.test.mjs`), `pages/` 연결 중·연결 안 됨 화면. 규약 `docs/desktop.md`. 빌드 `npm run desktop:build`
- `public/desktop.js` 프로그램 안에서만 동작(알림·진행 표시·경로 끌어놓기·트레이 명령), `public/hubs.js`·`hubs.css` 사이드바 허브 전환·원격 세션 목록(일반 브라우저에서는 아무것도 바꾸지 않음)

## 규칙
- host는 `127.0.0.1` 고정. 원격 접속은 Tailscale Serve로만 제공하며 `0.0.0.0` 바인딩·Funnel을 사용하지 않는다. 실행 중인 허브는 작업자가 재시작하지 않는다.
- 공유 메모리(`~/.ai-shared/memory`)는 대시보드에서 읽기만 한다. 쓰기는 각 에이전트가 공용 지침 3절대로 직접 한다.
- 메모리 선택/경로 해석은 공용 `~/.ai-shared/sync/memory-context.cjs`를 재사용한다. `JobManager.memoryFor`는 계획·배정·각 워커·재시도·보고 직전에 최신 자료를 읽고 실행 폴더의 `memory-context.json`에 출처·해시·생략·오류를 기록한다. CLI 훅도 같은 선택기를 사용한다.
- 생성 파일(`data/`, `runs/`, `logs/`, `workspace/`)은 커밋하지 않는다.
- 워커에 넘기는 프롬프트 형식은 `lib/planner.mjs`의 `buildWorkerPrompt` 한 곳에서만 바꾼다.
- 테스트: `npm test`. CLI 상태: `npm run check`.
- 시험 서버: `HUB_PORT`, `HUB_DATA_DIR`, `HUB_RUNS_DIR`, `HUB_CONFIG_FILE`을 모두 분리하고 `HUB_SKIP_CLI_INSTALL=1`로 CLI 공통 설치·감시를 생략한다. 실제 CLI의 로그인 홈은 바꾸지 않는다. 원본 경로가 누락되거나 완전히 빈 경우 설치기도 기존 설치본 정리를 보류한다.
- 작업 기본 모델·강도는 `config.json`의 `defaults` (`auto` = 자동, 빈 값 = 각 CLI 평소 설정). 자동 선택 로직은 `lib/router.mjs`, 하한은 `autoFloor` (사용자 요구: Opus·high / GPT-6.1-Sol·high 이상).
- 디자인 고정 규칙(사용자 요구 2026-10-03): 디자인 작업(시안·UI·색·아이콘·로고·폰트·일러스트·도트 등, "설계" 제외)은 자동 분배에서 Claude로 옮기고, Claude 모델이 자동이면 Fable로 고정한다. Fable 75% 강등보다 우선하며 Fable 전용 한도 95% 이상·지원 안 됨일 때만 기존 선택 유지. 사용자가 Codex만 모드나 모델을 직접 고르면 그 선택을 따른다. 판별·고정은 `lib/router.mjs`의 `isDesignText`·`applyDesignModel`, 담당 이동은 `jobs.mjs`의 `enforceDesignRule`, 설정은 `config.json`의 `designRule`(`enabled:false`로 끔).
- Codex 실행 파일은 `lib/util.mjs`의 `codexCommand`가 Codex 앱의 최신 CLI로 고른다. PATH 버전은 고정값으로 가정하지 않는다. 실행 파일·버전·요청 설정은 실행 폴더의 `invocation.json`·`invocations.jsonl`로 확인한다. 미지원 모델 재실행도 사용자 하한·고정값·기존 등급·강도를 유지해야 한다.
