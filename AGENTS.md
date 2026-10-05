# ai-hub (ODDIN) — Claude Code + Codex 공동 작업 허브

화면·프로그램에 보이는 이름은 **ODDIN**(오딘, 2026-10-03 변경)이다. 폴더·패키지·내부 식별자(`ai-hub`, `local.aihub.desktop`, 작업자 지시문의 `[AI Hub …]` 표식)는 그대로 둔다(자동 업데이트·알림·시험 호환).

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
- `lib/memory-curate.mjs` 기억 정리(2026-10-04): 요청이 끝나면 `jobs.curate`가 한 번 정리해 세션 결정 노트 스냅샷(`job.sessionNotes`)을 남기고 장기 기억을 공유 메모리에 적용(되돌리기 기록 `runs/<작업>/memory/memory-undo.json`). 다음 요청은 정리를 기다린 뒤 `session-tools.historyContext`가 노트를 통째로 앞에 둔다. 작업자는 공유 메모리를 직접 쓰지 않고 공용 메모판 `runs/<작업>/notes/<작업ID>.md`에 결정을 남긴다. 화면 `public/memory-ui.js`, 규약 `docs/memory.md`, 끄기 `config.memory.curate:false`
- `lib/usage.mjs`의 `balanceShare`·`headroom`·`usageWarnings` = 한도 기반 분배 비율·경고. 재배정은 `jobs.mjs`의 `rebalance`
- `lib/attachments.mjs` 이미지 업로드(서명 검사, 5MB·4장), Claude는 stream-json image 블록, Codex는 `-i`
- `data/jobs.json`·`data/sessions.json` 작업·세션(폴더별 대화, 같은 세션의 다음 요청은 이전 요청·보고를 맥락으로 받음), `data/uploads/` 첨부 이미지, `runs/<jobId>/` 실행 기록
- `public/` 데스크탑 앱형 화면. `app.js` = 대화·입력·작업 카드, `side.js` = 왼쪽 사이드바(고정·폴더별/날짜별·⋯/우클릭 메뉴·바로 이름 바꾸기·안 읽음 표시·계정/설정), 오른쪽 패널(작업·파일·사용량·정보 탭), Ctrl+K 검색, 양쪽 너비 조절. `side.js`는 `app.js` 다음에 읽히고 시작은 DOMContentLoaded.
- 기본 작업 폴더는 허브 저장소 밖 옆 폴더 `../oddin-workspace`(`config.defaultCwd`, 이 PC에서는 `F:/01_프로젝트/90_개발/oddin-workspace`, 2026-10-04 이동 — 저장소 안이면 작업자가 허브 개발 지침을 프로젝트 지침으로 받았다). 예전 `workspace/` 세션은 그대로 두고 기본 폴더로 친다(`jobs.isDefaultDir`)
- `lib/projects.mjs` 알려진 프로젝트 폴더(`knownProjects`, 폴더 고르기·플래너 후보)와 작업 폴더 검사(`validWorkdir`)
- `lib/prompts.mjs` 실행 중 승인·질문·계획 승인 요청 관리(권한 방식 auto·edits·ask·plan, 자동 응답 시간). 두 CLI 프로토콜 연결은 `workers.mjs`·`native-workers.mjs`. 규약 `docs/approvals.md`, 화면 `public/prompts.js`
- `lib/checkpoints.mjs` 작업별 그림자 git 스냅샷·변경 비교·되돌리기(사용자 `.git`은 건드리지 않음). 시작 스냅샷은 계획 중에 찍고 작업자 실행 직전에만 기다린다. 규약 `docs/checkpoints.md`, 화면 `public/changes.js`
- `lib/gitops.mjs`·`lib/session-tools.mjs` 세션 격리(worktree)·커밋·병합·push·PR·CI, 보관·갈래·내보내기. 규약 `docs/git-sessions.md`, 화면 `public/sessions-ui.js`
- `lib/terminal.mjs`·`lib/files.mjs`·`lib/preview.mjs` 파이프 터미널·파일 보기·미리보기 프록시. 규약 `docs/tools.md`, 화면 `public/tools-ui.js`
- 화면 확장 연결 지점: `window.hubTabs`(오른쪽 패널 탭), `window.hubJobExtras`(작업 카드 끝), `hub:event`(모든 실시간 이벤트). 기능 화면은 새 파일에 두고 공용 파일은 최소로 고친다.
- 자식 프로세스는 `util.guardChild`로 감싼다(입출력 통로 오류로 서버가 죽지 않게).
- 내가 띄운 자식을 강제로 끌 때는 `util.killChildTree`만 쓴다. 이미 끝난 자식의 번호로 `taskkill /T`를 하지 않는다 — Windows가 끝난 번호를 곧 다른 프로세스에 다시 줘서 상관없는 프로세스와 그 자식들이 죽는다(2026-10-05 사용량 조회의 1.5초 뒤 강제 종료·예전 방식 실행기의 끝난 뒤 중지가 실제로 매 시험마다 끝난 번호를 겨눴고, 병렬 시험의 CLI·셸이 가끔 죽었다). 시험 `tests/kill-child.test.mjs`.
- 모델 규칙: 최상위 모델(Fable·Astra)은 기획·디자인 기획·중요한 글쓰기에만(`router.premiumAllowed`·`capPremium`, 설정 `premiumModels`). 디자인이 섞인 작업은 기획(Fable)·구현(Sol)으로 나눈다(`jobs.enforceDesignRule`, 설정 `designRule`). Fable 전용 주간 사용률이 75% 이상이면 디자인 기획만 Codex·`gpt-6-astra`가 맡는다(`router.designTarget`, 아래 규칙).
- `desktop/` 데스크탑 프로그램(Electron, 자체 `package.json`·`node_modules` — 허브 본체는 계속 의존성 없음). `main.cjs` 창·트레이·알림·허브 전환·원격 세션 조회, `preload.cjs` 화면 연결 객체 `window.hubDesktop`, `lib/hubs.cjs` 허브 목록·주소 검사(시험 `tests/desktop-hubs.test.mjs`), `pages/` 연결 중·연결 안 됨 화면. 규약 `docs/desktop.md`. 빌드 `npm run desktop:build`
- `public/sound.js` 알림음(2026-10-04): 작업 끝(완료·일부 완료·실패)·질문·승인 요청 때 Web Audio 합성음, 계정 메뉴 "알림음"으로 켜고 끔(창마다 localStorage). 데스크탑 앱은 autoplayPolicy 로 바로 울리고 Windows 알림은 조용히(`silent`)
- `public/desktop.js` 프로그램 안에서만 동작(알림·진행 표시·경로 끌어놓기·트레이 명령), `public/hubs.js`·`hubs.css` 사이드바 허브 전환·원격 세션 목록(일반 브라우저에서는 아무것도 바꾸지 않음)

## 규칙
- host는 `127.0.0.1` 고정. 원격 접속은 Tailscale Serve로만 제공하며 `0.0.0.0` 바인딩·Funnel을 사용하지 않는다. 실행 중인 허브는 작업자가 재시작하지 않는다.
- 공유 메모리(`~/.ai-shared/memory`)는 대시보드에서 읽기만 한다. 쓰기는 각 에이전트가 공용 지침 3절대로 직접 한다.
- 메모리 선택/경로 해석은 공용 `~/.ai-shared/sync/memory-context.cjs`를 재사용한다. `JobManager.memoryFor`는 계획·배정·각 워커·재시도·보고 직전에 최신 자료를 읽고 실행 폴더의 `memory-context.json`에 출처·해시·생략·오류를 기록한다. CLI 훅도 같은 선택기를 사용한다.
- 생성 파일(`data/`, `runs/`, `logs/`, `workspace/`)은 커밋하지 않는다.
- 다른 PC 설치(2026-10-05): 저장소는 **공개** GitHub 저장소 `DDing-code/oddin`에 올려 다른 PC에서 받아 쓴다(절차 README "다른 PC에 설치"). 누구나 보므로 추적되는 파일과 커밋에 비밀값·토큰·개인 이메일·Tailscale 주소 같은 개인 정보를 넣지 않는다(실제 값은 무시되는 `data/`에만). 또 추적되는 파일(`config.json`·스크립트·시험)에 한 PC 전용 절대 경로를 넣지 않는다. `config.json`의 `hubDir`·`defaultCwd`는 `~`(사용자 폴더) 또는 허브 폴더 기준 상대 경로로 쓰고 `server.mjs`가 풀어 쓴다. 사용자 폴더에 있는 것(`~/.ai-shared` 등)에 기대는 시험은 없으면 건너뛴다(`tests/memory.test.mjs`).
- 워커에 넘기는 프롬프트 형식은 `lib/planner.mjs`의 `buildWorkerPrompt` 한 곳에서만 바꾼다.
- 테스트: `npm test`. CLI 상태: `npm run check`.
- 시험 서버: `HUB_PORT`, `HUB_DATA_DIR`, `HUB_RUNS_DIR`, `HUB_CONFIG_FILE`을 모두 분리하고 `HUB_SKIP_CLI_INSTALL=1`로 CLI 공통 설치·감시를 생략한다. 실제 CLI의 로그인 홈은 바꾸지 않는다. 원본 경로가 누락되거나 완전히 빈 경우 설치기도 기존 설치본 정리를 보류한다.
- 작업 기본 모델·강도는 `config.json`의 `defaults` (`auto` = 자동, 빈 값 = 각 CLI 평소 설정). 자동 선택 로직은 `lib/router.mjs`, 하한은 `autoFloor` (사용자 요구: Opus·high / GPT-6.1-Sol·high 이상).
- **지금 설정(사용자 요구 2026-10-04 "디자인은 페이블 / 눈으로 확인은 아스트라"): `designRule.mode:"split"` + `check`** — 디자인 기획은 Claude·Fable(명세만, Fable 전용 주간 75%↑면 Astra), 구현은 다른 AI(Sol), 눈으로 보는 결과물(VISUAL_RE)을 만든 작업 뒤에는 `jobs.addVisualChecks`가 "눈으로 확인: …" 작업(Codex·`gpt-6-astra`, 렌더·스크린샷 확인 후 어긋난 곳 수정)을 붙이고 그 결과를 쓰던 뒤 작업은 확인 뒤로 미룬다. 확인 작업 모델은 한도 안전장치·최상위 제한보다 우선(`task.visualCheck`), 사용자가 고른 모델은 그대로. 끄기 `check:false`.
- (`mode:"whole"`일 때, 같은 날 잠깐 쓰던 방식) 눈으로 보는 결과물 규칙: UI·화면·디자인·색·버튼·아이콘·로고·폰트·이미지·일러스트·영상·애니메이션·3D·렌더 등("설계" 제외, 판정 `router.isDesignText`의 VISUAL_RE)을 만드는 작업은 Codex·`gpt-6-astra` 한 작업자가 기획부터 구현·눈 확인까지 끝까지 맡는다. 나누지 않고(`jobs.enforceVisualRule`), 과제에 [눈으로 확인] 지시(렌더·스크린샷·재생)를 붙인다. Codex만 모드도 자동 모델이면 Astra, 한도 75%↑ 안전장치·최상위 제한보다 우선(`applyDesignModel`·`premiumAllowed`의 `task.visual`). 사용자가 모델을 직접 고르거나 Claude만 모드·다른 AI 전용 역할이면 그대로. 아래 두 줄은 `mode:"split"`(예전 방식)일 때만.
- 디자인 고정 규칙(사용자 요구 2026-10-03, split 모드): 디자인 작업(시안·UI·색·아이콘·로고·폰트·일러스트·도트 등, "설계" 제외)은 자동 분배에서 Claude로 옮기고, Claude 모델이 자동이면 Fable로 고정한다. 사용자가 Codex만 모드나 모델을 직접 고르면 그 선택을 따른다. 판별·고정은 `lib/router.mjs`의 `isDesignText`·`applyDesignModel`, 담당 이동은 `jobs.mjs`의 `enforceDesignRule`, 설정은 `config.json`의 `designRule`(`enabled:false`로 끔).
- 디자인 기획 한도 전환(사용자 요구 2026-10-04 "페이블 주간사용량 높으면 디자인 기획 아스트라에 넘겨"): **Fable 전용** 주간 사용률(`usage`의 `scope:'model'` 창, Claude 전체 5시간·주간과 다른 값)이 `designRule.switchAt`(기본 75) 이상이면 자동 배정되는 디자인 기획 작업의 담당을 `designRule.fallback`(기본 codex·`gpt-6-astra`)으로 바꾼다. 미만이면 Fable 유지. 사용률 미확인은 0%로도 초과로도 보지 않고 전환하지 않는다. Astra는 기획 명세에만 쓰고 구현·검증은 Sol·Opus 그대로다. 사용자가 Claude·Codex 모델을 직접 골랐거나 Codex 제외·Astra 지원 안 됨이면 전환하지 않고 기존 처리(Fable 유지 — 일반 75% Opus 강등보다 우선, Fable 전용 95% 이상·지원 안 됨이면 기존 선택)로 가며 이유를 작업 `reason`·`job.notes`에 남긴다. 판정은 `router.designTarget` 한 곳, 결정은 작업의 `designTarget`에 적고 `applyChoice`가 따른다. 계획 지시문에는 `catalogText(config, { usage, usable, settings })`로 현재 담당이 들어간다. 시험 `tests/design-switch.test.mjs`.
- Codex 실행 파일은 `lib/util.mjs`의 `codexCommand`가 Codex 앱의 최신 CLI로 고른다. PATH 버전은 고정값으로 가정하지 않는다. 실행 파일·버전·요청 설정은 실행 폴더의 `invocation.json`·`invocations.jsonl`로 확인한다. 미지원 모델 재실행도 사용자 하한·고정값·기존 등급·강도를 유지해야 한다.
- 실행 도중 모델 서버 혼잡 재시도(2026-10-05, 차트던전 07편 사고): 턴이 `Selected model is at capacity`·`overloaded`·503·529 같은 **혼잡 오류**로 끊기면 `workers.runWorker`가 20초→60초→120초 간격으로 최대 3번 다시 시도한다. 네이티브 연결이 살아 있으면 같은 스레드에 새 턴을, 아니면 CLI를 다시 띄워 같은 대화를 이어 쓰고(안 되면 새 대화), 작업자에게 "쓰다 만 출력 파일부터 확인"하라고 알린다. 구독 한도 문구(usage limit·rate limit·quota·한도)는 대상이 아니다. 간격은 `opts.capacityWaitsMs`로 바꾼다(시험용). 시험 `tests/transient.test.mjs`.
- 작업 품질 규칙(2026-10-04 "단독보다 멍청함" 조사 → 1~5 적용, 규약 `docs/context.md`): ① 기본 작업 폴더 세션은 플래너가 `workdir`로 실제 프로젝트 폴더를 고르면 그 폴더에서 실행(`jobs.applyWorkdir`, 세션 `workdir`로 기억), 직접 고른 폴더·worktree 세션은 안 옮김 ② 지시문 다이어트: 전역 메모리 목록 빼기(`skipGlobalIndex`, CLI 지침에 이미 있음)·단계별 메모리 한도(`MEMORY_LIMITS`)·세션 맥락은 결정 노트+최근 2건(작업자)/4건(플래너) ③ 품질 우선(기본, 작업마다 `settings.pace`)이면 자동 강도를 평소 단독 설정(Codex config.toml)까지 올림(`router.raiseToStandalone`), 속도 우선이면 예전처럼 high ④ 같은 세션 후속 요청은 직전 요청의 같은 AI·같은 폴더 CLI 대화를 이어 씀(`jobs.continuation`, 실패하면 새 대화로 한 번 더) ⑤ 플래너 기본은 작업 1개(같은 결과물의 기획·구현·검증 분리 금지, 요청 원문 인용).
