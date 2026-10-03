# 추론 과정 보기 (process view) 디자인 명세

작업 카드 안에서 AI의 중간 과정(생각 요약·중간 설명·명령·파일 읽기·수정·승인·오류)만 한 곳에 모아 접어 두고, 펼치면 Claude 데스크탑처럼 단계 목록이 보이고 각 명령을 누르면 전문과 출력이 보이는 화면의 명세다. 디자인만 다루며 코드는 포함하지 않는다.

- 대상: `public/app.js`(`jobHtml`·`taskHtml`·`rerenderJob`), `public/prompts.js`(도구 호출 카드·승인 기록 행), 새 파일 `public/process.js`·`public/process.css`
- 자료 형식: `docs/approvals.md`의 "도구 호출 카드 기록" 절. 기록 `kind`는 `message`·`thinking`·`tool`·`tool_error`·`error`·`stderr`·`intercept`·`waiting`·`result`·`init`·`turn`·`memory`·`raw`
- 디자인 읽기: 데스크탑 앱형 다크 대시보드의 운영 화면. 밀도는 높고 모션은 거의 없다. 새 색을 만들지 않고 `style.css`의 `:root` 토큰과 `prompts.css`의 도구 카드 모양을 그대로 쓴다.
- 원칙: 주인공은 보고(결과)다. 과정은 접힌 한 줄로 시작하고, 펼쳐도 블록 안에서 스크롤해 보고를 화면 밖으로 밀어내지 않는다.

---

## 1. 배치

### 1.1 작업 카드 안 순서 (변경 후)

```
.ai-body
 ├ .chips            모드·모델 칩 (그대로)
 ├ .plan             계획 요약 (그대로)
 ├ .tasks            작업 항목 상태판 (행 클릭 → .tdetail: 자동 선택 이유·오류·항목별 결과)
 ├ .proc             ★ 추론 과정 (이 명세) 
 ├ .ics              수정 지시 기록 (그대로)
 ├ .working          "결과를 모아 보고서를 쓰는 중" (그대로)
 ├ .report           보고 (그대로)
 ├ .pv-slot · .jerr  (그대로)
 └ .afoot            꼬리: 상태·시간·비용·버튼 (그대로)
```

- `.proc`은 `.tasks` 바로 아래, 보고 위에 둔다. 위에서 아래로 "무엇을 하기로 했나(계획) → 누가 맡았나(상태판) → 어떻게 진행됐나(추론 과정) → 무엇이 나왔나(보고)"가 되도록 한다.
- `.proc`과 `.report` 사이 간격은 18px(`.report{margin-top:18px}` 그대로). `.proc`은 `.tasks`와 같은 테두리·모서리(`1px var(--line)`, `var(--r)`)의 별도 박스라 결과 본문(테두리 없는 `.md`)과 모양으로 구분된다.
- 자동 분배 모드에서 계획을 세우는 동안(`planning`)에는 `.tasks`가 없으므로 `.working`("계획을 세우는 중") 아래에 `.proc`이 오고, 계획 섹션만 들어 있다.

### 1.2 기존 요소 정리

| 기존 | 변경 |
|---|---|
| `.tdetail` 안의 `.log`(진행 기록 상자) | 제거. `.tdetail`에는 `.why`(자동 선택 이유)·`.terr`·`.tres`(항목별 결과)만 남는다. 다중 작업이면 맨 아래에 텍스트 버튼 "추론 과정에서 보기"를 둔다(누르면 `.proc`과 해당 섹션을 열고 스크롤). |
| `.task` 아래 `.live` "지금: …" 줄 | 다중 작업일 때만 유지(항목별 현재 단계). 단일 작업이면 제거하고 `.proc` 접힌 줄이 대신한다. |
| `.prs`(승인·질문 기록 행, 카드 끝) | 제거. 승인·질문은 타임라인 항목이 된다(3.7). 대기 중 요청은 입력창 위 `#promptDock`과 `.proc` 접힌 줄에서 계속 보인다. |
| `prompts.js`의 `logHtml` 덮어쓰기(도구 카드) | 항목 렌더러로 재사용한다. `toolCard`·`lineHtml`·`diffHtml`·`cutText`·`TOOL_KIND`를 `process.js`가 쓸 수 있게 노출한다. |

### 1.3 항목별로 둘지, 합쳐서 둘지

**결정: 작업 카드당 `.proc` 블록 하나로 합치고, 안쪽을 작업 항목별 섹션으로 나눈다.** 시간순으로 섞지 않는다.

- 사용자 요청이 "추론 과정만 모아서"다. 작업 행마다 흩어져 있으면 열고 닫을 곳이 3~4개가 된다.
- 병렬 작업(Claude·Codex 섞임)을 시간순으로 섞으면 서로 무관한 두 흐름이 번갈아 나와 읽을 수 없다. 사람은 "Codex는 뭘 했고 Claude는 뭘 했나"로 생각한다.
- 섹션은 각각 접고 펼 수 있어 한 작업만 따라가기 쉽다.

섹션 순서: `계획`(자동 분배이고 `jobId/plan` 기록이 있을 때) → `j.tasks` 순서. `taskId`가 없는 승인(계획 승인)은 계획 섹션에 넣는다. 작업이 1개이고 계획 섹션도 없으면 섹션 머리 없이 타임라인만 펼친다.

---

## 2. 접힌 상태 한 줄 (`.proc-h`)

버튼 하나가 한 줄 전체다. 높이 38px, 좌우 안쪽 여백 14px, 글자 13px.

```
[상태]  추론 과정 · 요약 수치 · 경과        지금: 현재 단계 미리보기        [답하기] [›]
```

| 영역 | 규칙 |
|---|---|
| 상태 아이콘 (18px 칸) | 실행 중 `.spinner` · 답 대기 `bell`(색 `--warn`) · 완료 `check`(`--ok`) · 실패 `alert`(`--err`) · 일부 완료 `alert`(`--warn`) · 중지·중단 `minus`(`--muted`). 작업 상태(`j.status`)를 따른다. |
| 제목 | "추론 과정" 고정, `--fg`, 굵기 600. |
| 요약 수치 | `--muted`, 가운뎃점 구분, 0이면 항목을 뺀다. 순서: `작업 N개`(다중일 때만) · `N단계` · `명령 N` · `수정 N` · `오류 N`(`--err`로 표시) · 경과. |
| 경과 | 실행 중이면 `.live-dur`(작업 시작부터), 끝나면 `dur(startedAt, finishedAt)`. |
| 현재 단계 미리보기 | 실행 중에만. "지금:" 접두(`--fg2`) + 가장 최근 보이는 항목의 한 줄 요약(`lastLog` 규칙, 명령이면 명령 첫 줄을 `--mono`). 다중 작업이면 앞에 담당 태그(`.prov`)를 붙인다. `flex:1; min-width:0; text-overflow:ellipsis`로 한 줄에서 자른다. |
| 답하기 버튼 | 대기 중 승인·질문이 있을 때만. `.btn` 소형(`prompts.css`의 `.pr-row .btn`과 같은 크기), 누르면 `#promptDock`의 해당 카드로 초점 이동(기존 `data-pr-focus` 동작). 버튼 클릭은 접기·펼치기를 일으키지 않는다. |
| 꺾쇠 | `.chev`, 펼치면 90도 회전(기존 규칙). |

### 수치 세는 법

- `단계`: 보이는 항목 수. `message`·`thinking`·`tool`(시작 이벤트, `callId`별 1회)·`tool_error`·`error`·`intercept`·승인/질문 요청. 묶음(3.4)으로 합쳐지기 전 수를 센다. `init`·`turn`·`memory`·`raw`·`result`·`waiting`·`stderr`는 세지 않는다.
- `명령`: `TOOL_KIND`가 `cmd`인 도구 호출 수. `수정`: `edit`인 호출 수. `오류`: `status:'error'`인 도구 호출 + `tool_error`·`error` 행 수.
- 다중 작업은 섹션 합계다.

### 상태별 예

| 상태 | 한 줄 |
|---|---|
| 실행 중 (단일) | `(spinner) 추론 과정 · 7단계 · 명령 3 · 1분 12초    지금: npm test` |
| 실행 중 (다중) | `(spinner) 추론 과정 · 작업 3개 · 21단계 · 명령 8 · 수정 2 · 4분 05초    지금: Codex  npm run build` |
| 답 대기 | `(bell) 추론 과정 · 9단계 · 명령 4 · 2분 30초    답을 기다리는 중 · 명령 실행 승인    [답하기]` (미리보기 자리에 대기 문구) |
| 완료 | `(check) 추론 과정 · 14단계 · 명령 5 · 수정 3 · 2분 40초` |
| 실패 | `(alert) 추론 과정 · 6단계 · 명령 2 · 오류 1 · 48초` |
| 중지됨 | `(minus) 추론 과정 · 4단계 · 명령 1 · 중지됨 · 20초` |
| 기록 없음 | `.proc` 자체를 그리지 않는다. 단, 실행 중인데 아직 기록이 없으면 `(spinner) 추론 과정 · 시작하는 중` |

---

## 3. 펼친 상태 타임라인 (`.proc-body`)

### 3.1 공통 격자

```
┃  ●  [아이콘 14px]  내용 ........................................  우측 메타
┃  │
```

- 세로 레일: 아이콘 칸 가운데(x=9px)에 1px `var(--line2)`. 섹션 첫 항목 위·마지막 항목 아래에서는 레일을 끊는다.
- 행 격자: `grid-template-columns: 20px minmax(0,1fr) auto; column-gap: 8px; padding: 5px 14px 5px 12px;` 행 사이 간격 0(레일이 이어지도록). 행 높이 최소 28px.
- 아이콘: 14px, 레일 위에 놓이며 배경 `var(--panel)`로 레일을 가린다. 기본 색 `--muted`, 도구 아이콘은 담당 색(`--claude`/`--codex`, 기존 `.tc.claude .tc-h > .ico` 규칙), 상태 색은 오류 `--err`·대기 `--warn`·수정 지시 `--run`.
- 글자: 본문 13px/1.5 `var(--font)`, 요약 한 줄 12.5px, 명령·경로·패턴 12px `var(--mono)`, 메타 11.5px `tabular-nums`.
- 우측 메타: 도구 행은 상태 아이콘 + 소요 시간(기존 `.tc-m`), 그 밖의 행은 섹션 시작 기준 경과 `+m:ss`(`--faint`). 두 종류 모두 오른쪽 정렬이고 `title`에 절대 시각(`hm(at)`)을 둔다. 소요 시간은 10초 미만이면 소수 한 자리(`2.4초`), 그 이상은 `dur()`.
- 펼친 본문(명령 전문·출력·diff): 내용 칸 안에 들여쓰고 기존 `.tc-cmd`·`.tc-out`·`.tc-diff` 상자를 그대로 쓴다(배경 `--bg`, 모서리 7px, `max-height:300px`).
- 타임라인 안의 `.tc`는 바깥 테두리·배경·`margin`을 없앤다(`.proc .tc{border:0;background:none;margin:0}`). 레일과 아이콘이 경계를 대신한다. 실행 중·오류 상태는 테두리 대신 왼쪽 레일 점 색으로 나타낸다.
- 색은 토큰만: `--fg`·`--fg2`·`--muted`·`--faint`, `--ok`·`--err`·`--warn`·`--run`, 담당 `--claude`·`--codex`, 명령 글자 `#f0c38e`(기존 `.tc-s.mono`), diff 색(기존 `.tc-diff`). 모서리는 바깥 14px(`--r`), 안쪽 상자 7~10px(`--r2`)로 고정.

### 3.2 섹션 머리 (`.proc-sec-h`, 다중 작업일 때만)

```
[담당 태그] 작업 제목 ........... 9단계 · 명령 3 · 1분 05초   [›]
```

- 버튼. 높이 34px, 배경 `rgba(255,255,255,.02)`, 위쪽 `1px var(--line)` 구분선. 담당 태그는 기존 `.prov`. 계획 섹션은 태그 뒤에 "계획"을 제목으로 쓰고 담당은 `j.planner`.
- 상태 아이콘은 섹션 제목 왼쪽에 작업 항목과 같은 `stIcon(t.status)`. 실행 중인 섹션은 머리 오른쪽 수치 대신 "지금: …" 미리보기(2절과 같은 규칙).
- 기본 펼침: 실행 중인 섹션과 오류가 난 섹션은 펼침, 완료된 섹션은 접힘. 작업이 모두 끝났으면 전부 접힘(사용자가 연 것은 유지).

### 3.3 항목 종류별 모습

| 종류 (kind) | 아이콘 | 내용 칸 | 우측 메타 | 비고 |
|---|---|---|---|---|
| 생각 요약 `thinking` | `sparkle` (`--muted`) | 영어 제목을 그대로 보여 준다. 앞뒤 `**`·`#`·공백 제거, 첫 글자 그대로, 끝 마침표 제거. 12.5px, `--muted`, 기울임 없음. 2줄 넘으면 자른다(`-webkit-line-clamp:2`). 연속된 생각 요약은 묶지 않고 각각 한 줄. | `+m:ss` | 번역하지 않는다. 짧은 영어 제목이라 그대로가 가장 정확하고, 번역을 붙이면 두 줄이 된다. |
| 중간 설명 `message` | `chat` (`--muted`) | `md()`로 렌더(목록·코드 포함). 글자 13px `--fg2`. 8줄 넘으면 6줄에서 자르고 "더 보기" 텍스트 버튼. | `+m:ss` | Claude는 생각 대신 한국어 설명이 온다. 이 행이 Claude 쪽의 "생각" 역할이라 숨기지 않는다. |
| 명령 `tool`·`cmd` | `terminal` (담당 색) | 3.5 참고 | 상태·소요 | 누르면 전문·출력 |
| 파일 읽기 `tool`·`read` | `eye` | 굵은 파일명 + 흐린 폴더(기존 `toolSummary`) | 상태·소요 | 3.4 묶음 대상 |
| 검색 `tool`·`search` | `search` | 패턴 `--mono` + 흐린 경로 | 상태·소요 | 3.4 묶음 대상 |
| 파일 수정 `tool`·`edit` | `pencil` | 3.6 참고 | 상태·소요 | 누르면 diff |
| 웹·MCP·에이전트·기타 `tool` | `globe`·`cpu`·`bot`·`bolt` | 기존 `toolSummary` | 상태·소요 | 입력·결과는 기존 카드 본문 |
| 승인·질문 요청 | `shieldq`·`help`·`clipboard` | 3.7 참고 | 답한 시각 | `P.map`의 요청을 시간 위치에 끼워 넣는다 |
| 오류 `tool_error`·`error` | `alert` (`--err`) | 3.8 참고 | `+m:ss` | |
| 수정 지시 `intercept` | `steer` (`--run`) | "수정 지시: " + 본문, `--fg2` | `+m:ss` | 기존 `.ics` 카드는 그대로 두고 여기엔 한 줄만 |
| 경고 `stderr` | `alert` (`--warn`) | 3.4 "경고 N건" 묶음으로만 | | 단독 행으로 그리지 않는다 |
| 대기 `waiting` | | 그리지 않는다. 승인·질문 행이 같은 자리를 맡는다. 해당 시각 ±5초에 요청이 없을 때만 "사용자 응답 기다리는 중" 한 줄(`--warn`). | | |
| 숨김 | | `init`·`turn`·`memory`·`raw`·`result`는 그리지 않는다. 최종 결과는 보고·`.tres`가 맡는다. | | |

### 3.4 묶음 규칙

- **읽기·검색 묶음**: 같은 섹션에서 `read`·`search` 호출이 다른 종류 없이 3개 이상 이어지면 한 행으로 접는다. 아이콘 `eye`, 내용 "파일 7개 읽음 · 검색 2회"(0인 쪽은 뺀다), 우측 메타는 첫 시작부터 마지막 종료까지의 소요. 누르면 안쪽에 개별 행이 들여쓰기 없이 같은 격자로 펼쳐진다. 실행 중인 호출이 묶음 안에 있으면 묶음 행에 스피너를 보이고 자동으로 펼친다.
- **경고 묶음**: `stderr` 행은 첫 발생 위치에 "경고 N건" 한 행(`--warn`)으로 모으고, 누르면 각 줄을 12px `--mono`로 보여 준다. 400자에서 자른다.
- 묶음은 "모두 펼치기"(4절)에서 함께 펼쳐진다.

### 3.5 명령 행 (bash·PowerShell·Codex `commandExecution`)

접힌 한 줄:

```
[terminal]  npm test                                    (check) 3.2초   [›]
[terminal]  git status --short                          (spinner) 12초
[terminal]  node scripts/build.mjs                      (alert) 종료 코드 1 · 4초
```

- 명령 글자: 첫 줄만, `--mono` 12px, 색 `#f0c38e`, 한 줄에서 자른다. 여러 줄 명령이면 끝에 `--faint`로 "+N줄".
- 우측 메타: 실행 중 `.spinner`+`.live-dur`, 성공 `check`(`--ok`)+소요, 실패 `alert`(`--err`)+"종료 코드 N · 소요". 종료 코드는 뒤따르는 `tool_error` 텍스트의 `exit N:` 또는 `output` 끝의 `exit N`에서 읽고, 없으면 "오류".
- 꺾쇠는 본문이 있을 때만(명령이 두 줄 이상이거나 출력이 있거나 오류).

누르면 아래로 펼쳐지는 본문(내용 칸 안, 세로 간격 6px):

1. `.tc-cmd` 명령 전문. `$ ` 접두(기존 `::before`). 작업 폴더가 있으면 그 위에 `folder` 아이콘 + 경로 한 줄(`--faint`, 11.5px).
2. 출력 `.tc-out`. 14줄/1400자까지 보이고 넘치면 끝에 `…`와 "전체 보기 (N줄)" 버튼, 펼친 뒤엔 "접기". 전체도 `max-height:300px` 안에서 스크롤한다(서버가 4000자에서 "… 중간 생략 …"으로 이미 잘라 보내므로 그 표시는 그대로 둔다). 출력이 비어 있으면 "출력 없음"(`--faint`).
3. 실패: 출력 상자가 `.tc-out.err`(붉은 테두리·글자). 출력 아래에 "종료 코드 N" 한 줄(`--err`). 서버가 `error`로 강제 종료한 호출(결과를 못 받음)은 "결과를 받지 못함 · 작업이 끝나거나 중지됨"으로 쓴다.
4. 실행 중: 출력 자리에 "실행 중…"(`.tc-run`). 출력은 종료 이벤트에서 한 번에 오므로 스트리밍처럼 보이게 하지 않는다.

### 3.6 파일 수정 행

접힌 한 줄: `[pencil]  app.js  public/   +12 −3        (check) 0.8초  [›]`. 여러 파일이면 "외 N개". 숫자는 기존 `diffCounts`.

펼치면 파일마다 `.tc-path`(파일명·폴더) + `.tc-diff`. diff가 40줄을 넘으면 앞 30줄만 보이고 "전체 보기 (N줄)" 버튼. diff가 없고 출력만 있으면 출력 상자. Codex의 `unified`가 완전한 diff가 아닐 수 있으므로 줄 앞글자(`+`·`-`·`@@`)만으로 색을 칠하고 그 외 줄은 기본색이다(기존 `diffHtml`).

### 3.7 승인 대기·사용자 답 행

`P.map`의 요청(`jobId`·`taskId` 일치)을 `createdAt` 위치에 끼운다.

| 상태 | 아이콘 | 내용 | 우측 |
|---|---|---|---|
| 대기 | 종류별 아이콘, `--warn`. 레일 위 점은 `--warn`로 2초 주기 깜빡임(모션 감소 환경에선 정지) | "명령 실행 승인 대기" + 요약(`rowSummary`: 명령 첫 줄 `--mono`·파일명·질문 첫 문장). 오른쪽에 "답하기" `.btn` 소형 | `.spin-xs` |
| 허용·승인·답변 | 같은 아이콘, `--ok` | 종류 + " · " + 답(`answerText`: "허용함", "이 작업 동안 허용함", "승인함", "답변함", 질문은 고른 답) | 답한 시각 `hm`, 원격이면 "· 원격" |
| 거절 | `--err` | "거절함" + 사유가 있으면 " · 사유" | 시각 |
| 수정 요청 | `--run` | "수정 요청함 · 의견" | 시각 |
| 만료·자동 진행 | `--muted` | "답이 없어 AI가 판단해 진행" / "서버 재시작으로 만료됨" / "취소됨" | 시각 |

요청 본문(명령 전문·diff·질문 선택지)은 여기서 다시 펼치지 않는다. 대기 중인 것은 `#promptDock` 카드가 맡고, 끝난 것은 바로 다음 도구 행(실제 실행)이 전문을 보여 준다. 거절된 요청은 다음 도구 행이 없으므로 행을 누르면 명령 전문 한 상자만 펼친다.

### 3.8 오류 행

- `tool_error`·`error` 텍스트를 `--err` 13px로. 3줄 넘으면 자르고 "더 보기".
- 직전 항목이 같은 섹션의 `cmd` 도구 호출이고 그 호출이 `status:'error'`이며 2초 안에 왔으면 별도 행을 만들지 않고 그 명령 카드의 "종료 코드 N" 줄로 흡수한다(Codex가 `exit N: …`을 따로 보내는 경우).
- 작업 전체 오류(`t.error`)는 `.tasks`의 `.terr`에 그대로 두고 타임라인에는 종료 표식(3.9)에서만 한 줄 요약한다.

### 3.9 종료 표식 행 (섹션 마지막)

작업이 끝나면 섹션 끝에 레일을 닫는 행을 하나 둔다. 아이콘 없이 레일 끝에 점(6px)만 두고, 글자는 12.5px.

- 완료: "완료 · 2분 40초" (`--ok`)
- 실패: "실패 · 오류 요약 첫 줄" (`--err`)
- 중지·중단: "여기서 중지됨" / "여기서 중단됨" (`--muted`)
- 건너뜀: "건너뜀" (`--muted`)

### 3.10 시간 표시 정리

- 접힌 줄과 섹션 머리: 경과 시간(`dur`·`.live-dur`).
- 도구 행: 소요 시간(시작~종료). 실행 중이면 `.live-dur`.
- 그 밖의 행: 섹션 시작 기준 `+m:ss`. 1시간 넘으면 `+h:mm:ss`.
- 모든 시간 글자에 `title`로 절대 시각. 절대 시각을 본문에 늘어놓지 않는다(작업 꼬리와 승인 행에만 `hm`).

---

## 4. 동작

### 4.1 펼침 기본값

- **기본은 접힘**, 실행 중이든 끝났든 같다. 실행 중 자동 펼침은 하지 않는다. 이유: 병렬 작업·여러 카드가 동시에 커지면 화면이 요동치고, 사용자는 접힌 줄의 "지금: …"로 흐름을 충분히 따라갈 수 있다. 접힌 줄이 실시간으로 바뀌는 것이 Claude 데스크탑의 "작업 중…" 줄과 같은 역할이다.
- 사용자가 실행 중에 펼쳤다면 작업이 끝나도 그대로 둔다(내용을 뺏지 않는다). 끝난 뒤 다시 접는 것은 사용자 몫이다.
- 다중 작업에서 섹션 기본값은 3.2.

### 4.2 긴 기록과 스크롤

- `.proc-body`는 `max-height: min(60vh, 560px); overflow:auto; scrollbar-width:thin`. 보고가 항상 블록 아래 가까이에 남는다.
- 실행 중에 펼치면 바닥(가장 최근 단계)으로 스크롤한 상태로 열린다.
- 새 항목이 들어올 때: 바닥에서 30px 안에 있으면 바닥을 따라간다(기존 `.log` 규칙 재사용). 사용자가 위로 올렸으면 따라가지 않고 `.proc-body` 하단에 떠 있는 작은 알약 "새 단계 N개 ↓"(`.btn` 소형, 배경 `--panel2`)를 보여 준다. 누르면 바닥으로 가고 사라진다. 바닥에 다시 닿아도 사라진다.
- 항목이 200개를 넘으면 앞부분을 "이전 N단계 보기" 한 행으로 접어 둔다(한 번 누를 때 200개씩 더 보인다). 실행 중에도 완료 후에도 같다. 가상화는 하지 않는다.
- `rerenderJob`은 `.log`에 하던 스크롤 보존(바닥 고정 여부와 `scrollTop`)을 `.proc-body`에도 똑같이 적용한다. 150ms 모아 그리기(`queueRerender`)는 그대로.

### 4.3 모두 펼치기·접기

- `.proc-h`가 펼쳐져 있을 때만 그 오른쪽 끝(꺾쇠 왼쪽)에 아이콘 버튼 `updown`(`.icon-btn.sm`)을 둔다. `title`은 상태에 따라 "모두 펼치기" / "모두 접기".
- 모두 펼치기 = 이 블록 안의 모든 섹션·묶음·도구 카드 본문을 연다(출력 "전체 보기"는 열지 않는다). 모두 접기 = 전부 닫고 블록은 펼친 채 둔다.
- 버튼 클릭은 `.proc-h` 토글로 전파되지 않는다.

### 4.4 키보드

- `.proc-h`·섹션 머리·묶음 행·도구 행 머리는 전부 `<button>`에 `aria-expanded`·`aria-controls`. Tab 순서는 문서 순서. Enter·Space로 토글.
- 펼친 도구 본문 안에서 Esc를 누르면 그 카드를 접고 초점을 카드 머리로 돌린다. `.proc-body` 안에서 Esc를 누르면(도구 본문이 아닐 때) 블록을 접고 초점을 `.proc-h`로 돌린다.
- 출력 상자(`.tc-out`·`.tc-diff`)는 `tabindex="0"`으로 키보드 스크롤이 되게 한다(기존 `.term-out:focus-visible` 규칙과 같은 안쪽 2px 테두리).
- 초점 표시는 전역 `:focus-visible{outline:2px solid var(--codex)}`를 따른다. 행 머리는 `outline-offset:-2px`로 안쪽에 그린다(레일과 겹치지 않게).

### 4.5 상태 기억

- 블록·섹션 펼침은 기존 `S.open`에 키로 둔다: 블록 `proc:<jobId>`, 섹션 `proc:<jobId>/<taskId>`(계획은 `proc:<jobId>/plan`). 묶음은 `proc:<jobId>/<taskId>#g<첫 callId>`. 도구 카드와 "전체 보기"는 기존 `P.toolOpen`·`P.toolFull`(callId) 그대로.
- 새로고침 후에는 기억하지 않는다(세션 중에만). 기록 자체가 서버에 있어 다시 열면 되고, 수십 개 작업의 펼침 상태를 저장하면 오래된 카드가 펼쳐진 채 뜨는 쪽이 더 불편하다.
- 세션을 바꿨다 돌아와도 같은 페이지 안이면 `S.open`이 남아 있으므로 유지된다.

### 4.6 기존 토글과의 정리

- `.trow`(`data-toggle`) 클릭은 그대로 `.tdetail`만 연다(자동 선택 이유·오류·항목별 결과). 기록은 더 이상 여기 없다.
- `.tdetail` 안 "추론 과정에서 보기" 버튼과 오른쪽 패널의 작업 클릭(`side.js`가 `S.open.add(jobId/taskId)`하는 곳)은 `proc:<jobId>`와 `proc:<jobId>/<taskId>`도 함께 열고 섹션 머리로 `scrollIntoView({block:'nearest'})`한다.
- `.proc-h`의 "답하기"와 승인 행의 "답하기"는 기존 `data-pr-focus`로 `#promptDock` 카드에 초점을 준다.

### 4.7 좁은 화면 (`max-width: 860px`)

- 접힌 줄: 수치 중 `명령`·`수정`·`오류`를 숨기고 `단계`와 경과만 남긴다. "지금:" 미리보기는 두 번째 줄로 내리고(높이 자동) 한 줄에서 자른다.
- 타임라인: `+m:ss` 열을 숨긴다(도구 소요 시간은 남긴다). 행 좌우 여백 10px, 행 최소 높이 36px(터치).
- 명령·출력·diff 상자는 내용 칸 들여쓰기를 없애고 레일 바로 옆까지 넓힌다.

### 4.8 모션

- 전환은 꺾쇠 회전(.15s)과 레일 점 깜빡임뿐. 펼침·접힘에 높이 애니메이션을 넣지 않는다(기록이 길고 재렌더가 잦다).
- `@media (prefers-reduced-motion: reduce)`에서 깜빡임·회전 전환을 끈다. 스피너는 기존 전역 규칙을 따른다.

---

## 5. 문구

모든 문구는 짧은 한국어, 마침표 없음, 줄표(—) 쓰지 않음.

| 자리 | 문구 |
|---|---|
| 블록 제목 | 추론 과정 |
| 수치 | 작업 N개 · N단계 · 명령 N · 수정 N · 오류 N |
| 시작 직후 | 시작하는 중 |
| 실행 중 미리보기 | 지금: … |
| 대기 | 답을 기다리는 중 · 명령 실행 승인 / 파일 변경 승인 / 추가 권한 / 네트워크 접근 / 질문 / 계획 승인 |
| 버튼 | 답하기 · 모두 펼치기 · 모두 접기 · 더 보기 · 접기 · 전체 보기 (N줄) · 이전 N단계 보기 · 새 단계 N개 ↓ · 추론 과정에서 보기 |
| 계획 섹션 | 계획 |
| 묶음 | 파일 N개 읽음 · 검색 N회 · 경고 N건 |
| 명령 상태 | 실행 중… · 종료 코드 N · 오류 · 출력 없음 · 결과를 받지 못함 · 작업이 끝나거나 중지됨 |
| 여러 줄 명령 | +N줄 |
| 수정 | +N −N · 외 N개 · 적용 중… |
| 승인 답 | 허용함 · 이 작업 동안 허용함 · 거절함 · 승인함 · 수정 요청함 · 답변함 · 답이 없어 AI가 판단해 진행 · 서버 재시작으로 만료됨 · 만료됨 · 취소됨 · 원격 |
| 대기(요청 없음) | 사용자 응답 기다리는 중 |
| 수정 지시 | 수정 지시: … |
| 종료 표식 | 완료 · 실패 · 여기서 중지됨 · 여기서 중단됨 · 건너뜀 |
| 빈 상태 | 기록이 없어요 (끝난 작업인데 기록이 비었을 때) |
| 불러오는 중 | 기록을 불러오는 중 |
| 접근성 이름 | `aria-label="추론 과정"`(블록), `aria-label="추론 과정 · {작업 제목}"`(섹션), "명령 출력", "파일 변경 내용" |

---

## 6. 구현 체크리스트

### 6.1 파일과 연결점

- 새 `public/process.js`·`public/process.css`. `prompts.js` 다음에 읽히는 확장 파일. 전역 `S`·`P`·`icon`·`md`·`dur`·`hm`·`esc`·`rerenderJob`을 쓴다.
- `app.js jobHtml`: `.tasks` 바로 뒤(`icHtml` 앞)에 삽입 지점을 둔다. `window.hubJobProcess = (job) => html` 한 개를 호출하고, 없으면 빈 문자열. 끝에 붙는 `hubJobExtras`와 역할이 다르므로 별도 훅이다.
- `app.js taskHtml`: `.tdetail`에서 `.log` 제거, 다중일 때 "추론 과정에서 보기" 버튼 추가. 단일 작업의 `.live` 줄 제거.
- `app.js rerenderJob`: `.log` 스크롤 보존 선택자를 `.log, .proc-body`로.
- `prompts.js`: `toolCard`·`lineHtml`·`diffHtml`·`cutText`·`TOOL_KIND`·`rowSummary`·`answerText`·`kindOfPrompt`를 `window.hubPrompts = {...}`로 노출. `.prs`를 그리던 `hubJobExtras` 등록을 제거. `logHtml` 덮어쓰기는 예전 로그(`callId` 없음)용으로 남겨 두되 화면에선 `process.js`가 쓴다.
- `IC`에 없는 아이콘은 없다. `sparkle`·`chat`·`terminal`·`eye`·`search`·`pencil`·`globe`·`cpu`·`bot`·`bolt`·`shieldq`·`help`·`clipboard`·`alert`·`steer`·`bell`·`updown`·`check`·`minus`·`right`·`folder` 전부 기존 것.

### 6.2 DOM 예시

```html
<section class="proc s-running open" id="proc-<jobId>" data-proc="<jobId>">
  <button type="button" class="proc-h" aria-expanded="true" aria-controls="procb-<jobId>">
    <span class="st"><span class="spinner"></span></span>
    <b>추론 과정</b>
    <span class="proc-sum">작업 2개 · 13단계 · 명령 5 · 수정 1 · <span class="live-dur" data-from="…"></span></span>
    <span class="proc-now"><em>지금:</em> <span class="prov codex">Codex</span> <code>npm test</code></span>
    <button type="button" class="btn sm" data-pr-focus="<promptId>">답하기</button>      <!-- 대기 중일 때만 -->
    <button type="button" class="icon-btn sm" data-proc-all="<jobId>" title="모두 펼치기"></button>  <!-- 펼침일 때만 -->
    <span class="chev"></span>
  </button>
  <div class="proc-body" id="procb-<jobId>" role="region" aria-label="추론 과정">
    <section class="proc-sec open" data-proc-sec="<jobId>/<taskId>">
      <button type="button" class="proc-sec-h" aria-expanded="true">…</button>
      <ol class="proc-tl">
        <li class="proc-i k-think"><span class="pi-ic"></span><div class="pi-c">Inspecting reference docs</div><span class="pi-m">+0:04</span></li>
        <li class="proc-i k-msg"><span class="pi-ic"></span><div class="pi-c md">…</div><span class="pi-m">+0:09</span></li>
        <li class="proc-i k-group open" data-proc-group="…"><button class="pi-h" aria-expanded="true">…파일 7개 읽음 · 검색 2회…</button><ol class="proc-tl">…</ol></li>
        <li class="proc-i k-tool"><!-- 기존 .tc 마크업 그대로 --></li>
        <li class="proc-i k-prompt s-pending">…</li>
        <li class="proc-i k-err">…</li>
        <li class="proc-i k-end s-done">완료 · 2분 40초</li>
      </ol>
    </section>
    <button type="button" class="proc-new" hidden>새 단계 3개 ↓</button>
  </div>
</section>
```

### 6.3 CSS 토큰·규칙

```css
.proc{--proc-rail:var(--line2);--proc-dot:var(--faint);--proc-x:12px;--proc-ic:14px;
  border:1px solid var(--line);border-radius:var(--r);background:var(--panel);margin-top:10px;overflow:hidden}
.proc-h{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:0 14px;font:13px var(--font);color:var(--fg2);background:none;border:0;text-align:left}
.proc-h b{color:var(--fg);font-weight:600}
.proc-sum{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.proc-now{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.proc-now em{font-style:normal;color:var(--fg2)}  .proc-now code{font:12px var(--mono);color:#f0c38e}
.proc-body{max-height:min(60vh,560px);overflow:auto;scrollbar-width:thin;border-top:1px solid var(--line);position:relative}
.proc-tl{list-style:none;margin:0;padding:4px 0;position:relative}
.proc-tl::before{content:"";position:absolute;left:calc(var(--proc-x) + 9px);top:14px;bottom:14px;width:1px;background:var(--proc-rail)}
.proc-i{display:grid;grid-template-columns:20px minmax(0,1fr) auto;column-gap:8px;align-items:start;padding:5px 14px 5px var(--proc-x);min-height:28px;font-size:13px;line-height:1.5}
.pi-ic{width:var(--proc-ic);height:var(--proc-ic);margin:3px;background:var(--panel);color:var(--muted);position:relative;z-index:1}
.pi-m{font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap;padding-top:2px}
.k-think .pi-c{font-size:12.5px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.k-msg .pi-c{color:var(--fg2)}
.k-err .pi-ic,.k-err .pi-c{color:var(--err)}
.k-prompt.s-pending .pi-ic{color:var(--warn)}
.k-end{color:var(--muted);font-size:12.5px}  .k-end.s-done{color:var(--ok)}  .k-end.s-failed{color:var(--err)}
.proc .tc{border:0;background:none;margin:0}  .proc .tc-h{padding-left:0}
.proc-new{position:sticky;bottom:8px;margin:0 auto;display:block;background:var(--panel2)}
@media (max-width:860px){.proc-sum .opt,.pi-m{display:none}.proc-h{flex-wrap:wrap;padding:6px 10px}.proc-now{flex-basis:100%}.proc-i{padding-left:10px;min-height:36px}}
@media (prefers-reduced-motion:reduce){.proc .chev{transition:none}.k-prompt.s-pending .pi-ic{animation:none}}
```

### 6.4 상태별 규칙 요약

| 상태 | `.proc` 클래스 | 머리 아이콘 | 미리보기 | 섹션 기본 | 종료 표식 |
|---|---|---|---|---|---|
| 기록 없음·대기 전 | 그리지 않음 | | | | |
| planning (자동) | `s-running` | spinner | 계획 로그 마지막 줄 | 계획 섹션 펼침 | 없음 |
| running | `s-running` | spinner | 최근 단계 | 실행 중·오류 섹션 펼침 | 없음 |
| 답 대기 (`t.waiting` 또는 pending 요청) | `s-waiting` | bell `--warn` | "답을 기다리는 중 · 종류" + 답하기 | 해당 섹션 펼침 | 없음 |
| done | `s-done` | check | 없음 | 전부 접힘 | 완료 |
| partial | `s-partial` | alert `--warn` | 없음 | 실패 섹션만 펼침 | 각 상태 |
| failed | `s-failed` | alert `--err` | 없음 | 실패 섹션 펼침 | 실패 · 요약 |
| cancelled·interrupted | `s-stopped` | minus | 없음 | 전부 접힘 | 여기서 중지됨 |

### 6.5 확인 항목

- [ ] 단일 작업(Claude만·Codex만)과 다중 작업(자동 분배 3개, 둘 다 비교)에서 블록이 `.tasks` 아래, 보고 위에 한 번만 그려진다.
- [ ] 접힌 줄 수치가 `init`·`turn`·`memory`·`result`를 세지 않고, 명령 수가 작업 행의 "도구 N"과 모순되지 않는다(도구 N은 모든 도구, 명령 N은 cmd만).
- [ ] 실행 중 접힌 줄의 "지금:"이 새 기록마다 바뀌고, 다중 작업이면 담당 태그가 붙는다.
- [ ] 같은 `callId`의 시작·종료 이벤트가 카드 하나로 합쳐지고, 종료 때 소요 시간·상태가 갱신된다.
- [ ] 명령 행을 누르면 전문(`$ ` 접두)과 출력이 보이고, 14줄 초과 출력에 "전체 보기 (N줄)"가 뜨며, 실패 시 "종료 코드 N"과 붉은 출력 상자가 보인다.
- [ ] 읽기·검색 3개 이상 연속이 "파일 N개 읽음 · 검색 N회"로 접히고, 2개 이하는 개별 행으로 남는다.
- [ ] 파일 수정 행에 `+N −N`이 보이고, 펼치면 diff가 색으로 구분된다. diff 없는 Codex 변경도 깨지지 않는다.
- [ ] 승인 요청이 대기→허용/거절/만료로 바뀔 때 같은 행이 갱신되고, 답하기가 `#promptDock` 카드로 초점을 옮긴다. 카드 끝의 옛 `.prs` 목록은 더 이상 없다.
- [ ] Codex의 `exit N:` `tool_error`가 직전 명령 카드로 흡수되어 중복 행이 없다.
- [ ] 펼친 채 새 기록이 들어올 때 바닥 추적·"새 단계 N개" 알약·스크롤 위치 보존이 `rerenderJob` 150ms 모아 그리기와 함께 동작한다.
- [ ] 모두 펼치기·접기가 섹션·묶음·도구 카드에 적용되고 "전체 보기"는 건드리지 않는다.
- [ ] Tab·Enter·Space·Esc 동작, `aria-expanded`, 초점 링(안쪽 2px)이 모든 머리 버튼에서 보인다.
- [ ] 860px 이하에서 가로 스크롤이 생기지 않고 터치 높이 36px 이상이다. 1280px·1600px 너비에서 긴 명령·경로가 한 줄에서 잘린다.
- [ ] `prefers-reduced-motion`에서 깜빡임·회전 전환이 꺼진다.
- [ ] `callId` 없는 예전 기록(`runs/` 옛 작업)도 `lineHtml` 경로로 타임라인에 그려진다.
- [ ] 화면 문구에 줄표(—)·영어 라벨·마침표가 없다(생각 요약 원문 제외).
