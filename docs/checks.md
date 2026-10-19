# ODDIN 검사 · 이전 대화 파일 · 눈으로 확인 조건 · 강도 범위

2026-10-19 사용자 "다른 코덱스/클로드 같이 쓰는 오픈소스 참고해서 규칙/구조 수정" → "1~3 해줘. 강도는 high~xhigh 유동적으로".
참고한 구조(코드는 새로 씀): 작업마다 통과 기준 명령을 두고 하네스가 직접 돌려 판정(claw-orchestrator 의 acceptance contract, ralphex 의 작업별 검사 명령),
지난 대화는 지시문에 붙이지 않고 파일로 두기, 검토 단계는 필요할 때만.

## 1. ODDIN 검사 (`lib/checks.mjs`, `jobs.verifyTask`)

"다 됐다"를 작업자 말로만 믿지 않는다. 작업이 끝나면 허브가 확인 명령을 **작업 폴더에서 직접** 돌려 통과·실패를 판정한다.

- 명령의 출처
  - 계획: `tasks[].checks`(최대 3개). 플래너는 그 프로젝트에 이미 있는 짧은 검사만 적고, 모르면 빈 배열(`planner.mjs` 규칙 11).
  - 작업자: 결과 끝의 `확인 명령: <명령>` 줄(최대 3개). **작업자가 적은 것이 계획보다 우선**(실제로 고친 사람이 더 정확히 안다).
  - 지시문(`planner.checksRule`): 계획 명령이 있으면 "ODDIN이 이 명령을 돌린다, 같은 긴 검사를 반복하지 말라", 없으면 "알맞은 명령이 있으면 적어 달라".
- 돌리지 않는 명령(`unsafeReason`): 지우기·되돌리기(`git reset/checkout/clean…`)·push·설치·배포·네트워크(`curl` 등)·파일로 출력 돌려쓰기(`>`, `>>`). 없는 npm 스크립트(`missingScript`)도 건너뛴다. 건너뛴 것은 판정에 세지 않는다.
- 판정 `task.verified`: `verified`(돌린 것 모두 통과) · `refuted`(하나라도 실패) · `unverified`(돌린 것 없음). 기록 `task.checkRuns[]`(판마다 명령별 종료 코드·걸린 시간·출력 끝 1500자), 전체 출력 `runs/<요청>/<작업>/checks/<판>/<n>.log`.
- 실패하면 같은 작업자에게 `checks.fixRounds`(기본 1)번 돌려보낸다.
  - Claude: 같은 대화를 이어서(`--resume`) 실패 내용만 짧게(`buildWorkerPrompt({ checkFix: { resume: true } })` → `[ODDIN 검사 실패] …`).
  - Codex: 임시 대화라 새로 — 원래 과제 전체 + `# ODDIN 검사 실패 — 먼저 이것부터` + 지난 결과 요약.
  - 고친 결과는 `task.resultText` 끝에 `[ODDIN 검사 실패 뒤 다시 맡긴 결과]`로 붙고, 다시 검사한다.
  - 그래도 실패면 작업은 `done` 이지만 요청은 **일부 완료**(`partial`)로 끝나고 알림(`job.notes`)을 남긴다.
- 언제 돌리나(`jobs.checksOn`): 질문(`job.answer`)·눈으로 확인 작업·디자인 기획(명세만)은 빼고, 권한 방식이 `auto` 일 때만(승인 받는 방식에서 허브가 몰래 명령을 돌리지 않게).
- 보고·다음 작업에 넘기는 결과(`planner.taskResultContext`)에 `ODDIN 검사(허브가 직접 실행): 통과 2/2 — …` 한 줄이 붙는다. 보고 담당은 이 줄을 근거로 쓰고, 검사 실패로 남은 작업을 완료로 보고하지 않는다.
- 화면: 작업 카드 끝 `public/checks-ui.js`("ODDIN 검사 · 통과 n/n / 실패 … / 검사 중…", "출력 보기"), 기록 줄 `검사`.
- 설정 `config.checks`: `{ enabled: true, timeoutMinutes: 10, fixRounds: 1, max: 3 }`(전부 기본값이라 config.json 에 없어도 된다).

## 2. 이전 대화는 파일로 (`jobs.compactHistory`)

작업자 지시문에 같은 세션의 이전 명령·결과를 통째로 붙이지 않는다.

- 지시문에는 **결정 노트(잘리지 않음) + 직전 요청 요약(원문 500자·결과 700자) + 파일 위치**만.
- 최근 명령과 결과 원문(최근 6건, 건당 6천 자)은 `runs/<요청>/context/THREAD.md`. 작업자가 필요할 때만 연다.
- 짧으면(`config.context.historyInline`, 기본 2500자 이하) 예전처럼 그대로 넣는다. 끄기 `config.context.historyFile: false`.
- 질문(`job.answer`)과 이어 쓰는 대화(`afterJobId` 맥락)는 예전 그대로.

## 3. 눈으로 확인은 꼭 필요할 때만 (`jobs.addVisualChecks`·`needsVisualCheck`)

눈으로 보는 결과물 뒤에 "눈으로 확인: …" 작업(Codex·gpt-6-astra)을 **따로** 붙이는 경우:

1. 사용자가 요청함 — 원문·수정 지시에 "눈으로 확인/봐/검수", "스크린샷 … 확인", "화면 … 확인해", "검수" 등(`ASKED_VISUAL_CHECK`)
2. 코드로 새 화면을 만드는 큰 구현 — `design: "build"`(기획 → 구현 → 확인), `task.designImpl`
3. 처음 만드는 디자인 시안 — `design: "draft"` 이고 `check` 가 `"self"` 가 아님

그 밖(화면·영상·이미지 손질, 디자인이 아닌 시각 결과물)은 만든 작업자가 스스로 렌더·스크린샷으로 확인한다(`SELF_CHECK_NOTE`, `task.selfChecked`). Astra 가 만든 시안은 예전처럼 스스로 확인.
예전처럼 늘 붙이려면 `config.designRule.check.when: "always"`.

## 4. 강도 범위 high ~ xhigh

- 플래너는 작업마다 `effort` 를 **high 또는 xhigh** 중에서 고른다(`planner.mjs` 규칙 12): 보통 high, 원인을 모르는 버그·여러 모듈에 걸친 큰 설계/구조 변경·이전 시도가 실패한 일·까다로운 알고리즘은 xhigh.
- 자동 강도는 하한(`autoFloor`, high) ~ 상한(`config.quality.maxEffort`, 기본 xhigh) 안으로 자른다(`applyChoice`, 이유 "자동 강도는 xhigh까지"). 직접 고른 강도·역할(@에이전트)이 정한 강도는 그대로.
- 어려운 일·디자인 기획·시안은 예전처럼 평소 단독 강도까지 올린다(같은 상한 안에서, `docs/context.md`).

시험 `tests/checks.test.mjs`(검사·돌려보내기·요청 흐름·이전 대화 파일), `tests/quality.test.mjs`·`tests/visual-rule.test.mjs`(눈으로 확인 조건), `tests/speed.test.mjs`(강도 범위).
