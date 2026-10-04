# ODDIN (오딘) — Claude Code + Codex 로컬 공동 작업 허브

> **O**rchestrated **D**ual-**D**riven **I**ntelligence **N**etwork. 북유럽 신화의 오딘은 두 까마귀 후긴(생각)과 무닌(기억)을 세상에 보내 소식을 모읍니다. ODDIN은 Claude Code와 Codex 두 AI를 보내 일을 나눠 맡기고, 둘이 함께 쓰는 공유 메모리에 기억을 남깁니다. (예전 이름: AI Hub · 폴더 이름 `ai-hub`는 그대로)

명령 하나를 넣으면 **플래너가 일을 쪼개 Claude Code와 Codex에 나눠 주고**, 둘이 병렬로 실행한 뒤 **보고서**를 만듭니다. 두 도구는 이미 `~/.ai-shared`로 지침·메모리·스킬을 공유하므로, 허브는 그 위에서 "지휘"만 합니다.

```
사용자 명령 ─▶ 플래너(계획 JSON) ─▶ ┌ Claude Code  (claude -p)  ┐ ─▶ 보고서 ─▶ 대시보드
                                     └ Codex        (codex exec) ┘      └▶ ~/.ai-shared/hub/BOARD.md (두 도구가 함께 봄)
```

## 시작

```bat
start-hub.cmd
```
→ 브라우저에서 <http://127.0.0.1:7700> (이 PC에서만 열리는 주소. 다른 컴퓨터에서 열려면 아래 "다른 컴퓨터에서 열기")

- 창 없이: `wscript start-hub-hidden.vbs` (로그 `logs\server.log`)
- 로그온 시 자동 시작 등록: `powershell -ExecutionPolicy Bypass -File install-autostart.ps1` (해제는 `-Remove`)
- CLI 상태 확인: `npm run check` · 테스트: `npm test`

## 데스크탑 프로그램 (2026-10-03)
허브 화면을 독립 창으로 쓰는 프로그램입니다. 시작 메뉴·바탕화면의 **ODDIN** 아이콘으로 켭니다. 자세한 내용: [docs/desktop.md](docs/desktop.md)

- 허브 서버가 꺼져 있으면 프로그램이 숨김 실행으로 켭니다. 프로그램을 꺼도 서버는 계속 돕니다.
- 창을 닫으면 트레이로 숨습니다. 완전히 끄려면 트레이 아이콘 메뉴의 **종료**를 누릅니다.
- 작업이 끝나면 Windows 알림이 뜨고, 누르면 그 세션으로 이동합니다.
- 탐색기에서 파일·폴더를 끌어다 놓으면 실제 경로가 입력창에 들어갑니다. 이미지는 지금처럼 첨부됩니다.
- **원격 세션**: 사이드바 맨 위 허브 이름을 눌러 다른 PC의 허브(Tailscale 주소)를 추가하면, 그 허브의 세션이 사이드바 "원격 세션"에 나오고 눌러서 바로 이어서 작업할 수 있습니다. 상대 PC 허브에서 원격 접속이 켜져 있어야 합니다(아래 "다른 컴퓨터에서 열기").
- 다시 빌드: `npm run desktop:build` (결과 `desktop\dist\win-unpacked\ODDIN.exe`, 바로가기도 다시 만듦) · 개발 실행: `npm run desktop`
- 설치 파일: `npm --prefix desktop run installer` → `desktop\dist\ODDIN-Setup-<버전>.exe` (만든 PC의 허브 폴더를 가리키므로 다른 PC에서는 그 PC에서 다시 만든다 — 아래 "다른 PC에 설치")

## 다른 PC에 설치
GitHub 저장소 <https://github.com/DDing-code/oddin>에서 받아 그 PC에서 허브를 따로 돌립니다. 이 PC 허브를 원격으로 쓰기만 할 거면 설치할 필요 없이 아래 "다른 컴퓨터에서 열기"를 보세요. 명령은 PowerShell 기준이고, 예시 폴더 `C:\oddin`은 원하는 곳으로 바꿔도 됩니다.

1. 준비물: Git(`winget install Git.Git`), Node.js 22 이상(`winget install OpenJS.NodeJS.LTS`), Claude Code CLI·Codex CLI 중 하나 이상(설치 후 로그인 — 아래 "사전 조건")
2. 받기:
   ```powershell
   git clone https://github.com/DDing-code/oddin.git C:\oddin
   ```
3. CLI 확인: `npm --prefix C:\oddin run check`
4. 시작: `C:\oddin\start-hub.cmd` → <http://127.0.0.1:7700> · 로그온 때 자동 시작: `powershell -ExecutionPolicy Bypass -File C:\oddin\install-autostart.ps1`
5. 데스크탑 프로그램(선택) — 한 줄씩 실행:
   ```powershell
   npm --prefix C:\oddin\desktop ci
   npm --prefix C:\oddin\desktop run installer
   npm --prefix C:\oddin\desktop run install-local
   ```
6. 새 버전 받기: `git -C C:\oddin pull` 다음 `npm --prefix C:\oddin run restart`

- 기본 작업 폴더는 허브 폴더 옆 `oddin-workspace`(`config.json`의 `defaultCwd: "../oddin-workspace"`), 공유 지침·메모리 폴더는 `~/.ai-shared`(`hubDir`)입니다. 두 값은 `~`(사용자 폴더)나 허브 폴더 기준 상대 경로로 쓰고, 한 PC 전용 절대 경로를 넣지 않습니다.
- `~/.ai-shared`가 없는 PC에서도 허브는 돕니다. 공유 메모리·공통 커맨드 목록만 비어 있습니다.
- 작업 기록(`data/`·`runs/`·`logs/`)은 PC마다 따로 남고 저장소에 올라가지 않습니다.

## 다른 컴퓨터에서 열기
**Tailscale**(본인 기기끼리만 연결되는 비공개 망)로 `https://<PC이름>.<tailnet>.ts.net/` 주소를 엽니다. 같은 네트워크든 밖이든 방법은 같습니다. 자세한 안내·문제 해결: [docs/remote-access.md](docs/remote-access.md)

1. 허브 폴더에서 `npm run restart` (원격 확인 기능이 든 새 서버로 재시작. **반드시 먼저**)
2. `npm run remote -- enable --install` → Tailscale 설치(UAC 승인) → 브라우저에서 Tailscale 로그인
3. 허브의 **설정 › 원격 접속 › 켜기** (HTTPS 허용 안내가 나오면 링크에서 한 번 허용 후 다시 켜기)
4. 다른 기기에 Tailscale 설치 → **같은 계정**으로 로그인 → 설정 화면에 나온 주소 열기

- 끄기: 설정 › 원격 접속 › **원격 접속 끄기** 또는 `npm run remote -- disable`
- 설정 전 임시책: Chrome 원격 데스크톱으로 허브 PC 화면에 들어가 <http://127.0.0.1:7700>
- ⚠️ 원격 접속은 곧 **이 PC에서 승인 없이 명령을 실행하는 권한**입니다. 본인 기기만 연결하세요. 서버 주소를 `0.0.0.0`으로 바꾸거나 포트포워딩·Funnel·공개 터널을 쓰지 마세요(이 PC는 방화벽 없이 인터넷에 바로 연결되어 있음).

## 사전 조건
| 도구 | 확인 | 안 될 때 |
|---|---|---|
| Codex CLI | `codex login status` | `codex login` |
| Claude Code CLI | `claude auth status` → `loggedIn: true` | `claude auth login` (브라우저 로그인) |

둘 중 하나만 로그인돼 있어도 동작합니다. 그 경우 모든 작업이 가능한 쪽에 배정됩니다.

## 사용
화면은 데스크탑 앱처럼 생겼습니다.

- **왼쪽 사이드바**: 새 세션·검색(Ctrl+K)·작업 보드·공유 메모리 메뉴, 고정된 세션, 폴더별 또는 날짜별 세션 목록(마우스를 올리면 `⋯` 메뉴, 오른쪽 클릭 메뉴, 두 번 눌러 이름 바꾸기, 새 결과는 파란 점), 사용량 게이지, 계정·설정 줄
- **오른쪽 패널**(Ctrl+J): 작업 진행(진행 막대·작업별 모델), 바뀐 파일(누가 고쳤는지), 사용량 상세, 세션 정보. 좁은 화면에서는 위에 겹쳐 뜬다
- 양쪽 가장자리를 끌어 너비를 바꿀 수 있고, 두 번 누르면 기본 너비로 돌아간다
- **가운데**: 요청 말풍선, 계획 요약, 작업 목록(눌러서 진행 기록 펼치기), 보고서
- **입력창 아래 버튼**: 분배 방식(자동 분배 / Claude만 / Codex만 / 둘 다 비교), Claude 모델·추론 강도, Codex 모델·추론 강도, 이미지 첨부(버튼·붙여넣기·끌어놓기)

1. 왼쪽 **새 세션** 또는 폴더 옆 **+** 로 작업 폴더를 정한다.
2. 입력창 아래 버튼으로 이번 요청에 쓸 분배 방식·모델·강도를 고른다. 고른 값은 다음 요청에도 유지된다.
3. Enter로 보낸다. 같은 세션에서 이어 보내면 이전 요청과 결과를 기억한다.
4. 실행 중에 입력창이 비어 있으면 보내기 버튼이 중지 버튼으로 바뀐다. 실패한 작업은 **다시** 버튼으로 재시도.
5. 실행 중에 입력창에 글을 쓰면 **수정 지시 보내기**가 된다. 아래 "실행 중 수정 지시" 참고.

## 폴더·파일 열기 (2026-10-03)
보고서·작업 결과·오른쪽 패널에 나온 경로를 누르면 허브 PC의 탐색기로 엽니다.

- 폴더는 탐색기로 열고, 이미지·영상·소리·문서·편집 프로젝트 파일은 기본 프로그램으로 엽니다.
- 실행 파일·스크립트 같은 나머지 파일은 실행하지 않고 탐색기에서 위치만 보여 줍니다.
- 보고서 속 상대 경로(예: `server.mjs`)는 세션 폴더에 없으면 상위 폴더와 허브가 아는 폴더에서 실제 위치를 찾습니다.
- 오른쪽 클릭하면 열지 않고 전체 경로를 복사합니다. 위쪽 폴더 칩과 세션·폴더 메뉴의 **폴더 열기**도 같습니다.
- 세션 폴더·작업 공간·허브·공유 허브·등록된 프로젝트 폴더 안의 경로만 엽니다. 그 밖은 거절합니다.
- 원격 접속 화면에서는 열지 않고 경로만 복사합니다. 허브 PC 앞에서 볼 때만 열립니다.
- 구현은 `lib/opener.mjs`와 `POST /api/open`입니다. 시험은 `tests/opener.test.mjs`입니다.

## 승인·변경 되돌리기·터미널·git 세션 (2026-10-03)
Claude 데스크탑에 있던 기능을 허브에도 넣었습니다. 자세한 규약은 각 문서에 있습니다.

- **권한 방식**: 입력창 아래 "권한" 버튼에서 자동·편집만 자동·매번 확인·계획 먼저를 고릅니다. 승인·질문·계획 승인 카드는 입력창 바로 위에 뜨고, 다른 세션이 기다리면 사이드바에 종이 표시됩니다. 자동 방식에서도 AI의 질문은 사용자에게 오고, 답이 없으면 20분 뒤 AI가 알아서 진행합니다. [docs/approvals.md](docs/approvals.md)
- **도구 호출 카드**: 작업 기록에서 명령·출력·파일 수정 내용을 카드로 펼쳐 봅니다.
- **변경 비교·되돌리기**: 작업마다 시작·끝 스냅샷을 남깁니다(사용자 저장소의 `.git`은 건드리지 않음). 오른쪽 패널 "변경" 탭에서 줄 단위로 비교하고, 작업 단위나 파일 단위로 되돌리고, 되돌리기를 취소할 수 있습니다. 20MB 넘는 파일은 스냅샷에서 빠집니다. [docs/checkpoints.md](docs/checkpoints.md)
- **터미널·파일 보기·미리보기**: 오른쪽 패널 "도구" 탭. 세션 폴더에서 PowerShell·cmd·bash를 열고, 파일을 허브 안에서 보고, 개발 서버를 미리 봅니다. 원격 접속 화면에서는 경로를 누르면 허브 안 보기 창이 열립니다. 대화형 TUI 프로그램은 PTY가 없어 제대로 안 될 수 있습니다. [docs/tools.md](docs/tools.md)
- **세션 관리**: 세션 메뉴에서 보관·갈래 만들기·내보내기(마크다운·JSON). 보관함에서 복원합니다.
- **세션 격리(git worktree)**: git 저장소 폴더에서 새 세션을 격리로 시작하면 별도 브랜치·작업 사본에서 일합니다. 오른쪽 패널 "Git" 탭에서 커밋·기준 브랜치로 병합(충돌 시 원래대로 되돌림)·PR(GitHub 비교 화면)·CI 상태를 봅니다. push·병합은 확인 후에만. [docs/git-sessions.md](docs/git-sessions.md)
- **모델 사용 규칙**: Fable·GPT-6 Astra는 기획·디자인 기획·중요한 글쓰기에만 자동으로 고릅니다. 나머지는 Opus 5.5·GPT-6.1-Sol. 디자인이 섞인 요청은 "디자인 기획(Fable)" → "구현·검증(Sol)"으로 나뉩니다. 끄기: `config.json`의 `premiumModels.enabled`·`designRule.enabled`를 `false`.

## 실행 중 수정 지시
작업이 끝나기를 기다리지 않고, 진행 중인 작업에 추가 지시를 보내 방향을 바꾼다(Claude Code에서 실행 중에 메시지를 끼워 넣는 것과 같다). 자세한 내용은 [docs/intercept.md](docs/intercept.md).

- 진행 중인 대화의 입력창에 쓰고 Enter를 누른다. 지시는 그 대화의 실행 중인 작업과 대기 중인 작업, 계획·보고서 담당 모두에게 간다. 끝난 작업은 다시 실행하지 않는다.
- 전달 방식: Codex는 실행 중인 턴에 지시를 더하고(steer), Claude는 현재 턴을 멈춘 뒤 같은 세션에 이어서 보낸다. 아직 시작하지 않은 작업은 시작 프롬프트에 넣는다.
- 카드의 `현재 작업에 전달됨`은 AI가 **받았다는 확인**이다. 결과 반영 여부는 결과에서 직접 확인한다.
- 중지는 보내기 옆 작은 ■ 버튼이나 카드의 **중지**로 한다. 쓰던 글은 남는다.
- **서버를 다시 시작해야 켜진다**(`npm run restart`, 진행 중 작업이 끝난 뒤 실행됨). 옛 서버에서는 "지원하지 않아요" 안내만 나오고 보내지 않는다.
- 최종 검증(2026-10-03): Claude·Codex 모두 같은 CLI 세션을 유지하며 실제 결과 파일에 수정 지시를 반영했다. Claude의 백그라운드 조기 완료 결함도 수정했다. 검증 범위와 남은 제약은 [workspace/intercept-verification.md](workspace/intercept-verification.md).

## 커맨드 · 서브 에이전트 · 목표 · 스킬
입력창에서 `/`나 `@`를 치면 목록이 뜬다. 왼쪽 메뉴의 **커맨드 · 에이전트**에서도 볼 수 있다.

| 입력 | 하는 일 |
|---|---|
| `/goal <목표와 완료 기준>` | 목표를 달성할 때까지 계획 → 실행 → 달성 판정을 반복한다. 기본 최대 6라운드, 위쪽 막대에서 중지·이어서 |
| `/review` `/fix` `/test` `/plan` `/explain` `/doc` `/refactor` `/commit` `/remember` `/compare` | 공통 커맨드. 원본 `~/.ai-shared/commands/*.md` |
| `@reviewer` `@debugger` `@tester` `@frontend` `@writer` `@researcher` `@architect` | 서브 에이전트에게 맡긴다. 자동 분배 때는 플래너가 작업마다 알맞은 역할을 붙인다. 원본 `~/.ai-shared/agents/*.md` |
| `/<스킬 이름> <할 일>` | 공유 스킬을 써서 처리한다 (`/skill <이름> <할 일>`도 된다) |

같은 커맨드와 에이전트를 Claude Code(`/hub:review`, 서브 에이전트 `hub-reviewer`)와 Codex(`/prompts:hub-review`, `/prompts:hub-agent-reviewer`)에서도 쓸 수 있다. 서버가 시작할 때와 원본 폴더가 바뀔 때 자동으로 설치한다.

## 속도 규칙 (2026-10-03)
- **작은 요청은 바로 처리**: 짧고(160자 이하·3줄 이하) 단순한 요청은 계획·모델 선택·보고 없이 AI 하나가 바로 처리한다. 화면·글은 Claude, 코드·실행은 Codex, 애매하면 한도 여유가 많은 쪽. 여러 항목 나열, "둘 다·비교·나눠", 원인 불명 버그·큰 구조 변경은 제외. `config.json`의 `fastPath: { enabled: false }`로 끄고 `maxChars`로 길이를 바꾼다.
- **사슬 줄이기**: 플래너는 의존을 최대 2단계로 두고, 같은 AI가 이어 할 조사와 구현은 한 작업으로 합친다. 검증·확인만 하는 끝 작업은 만들지 않으며, 만들면 허브가 빼고 그 내용을 앞 작업의 "끝내기 전 직접 검증"에 합친다(작업 카드 노란 줄에 표시).
- **xhigh는 근거가 있을 때만**: 자동 선택은 기본 high. 원인 불명 버그, 큰 설계·구조 변경, 목표 모드 재시도처럼 근거가 있거나 역할이 정한 경우만 xhigh 이상을 쓴다. 하한(Opus·high / Sol·high)은 그대로.
- **일시적 시작 실패 재시도**: Codex 단계가 연달아 이어질 때 상태 DB 잠금으로 바로 실패하면 2초 뒤 한 번 다시 시작한다. 실패한 작업을 "다시" 누르면 그 때문에 건너뛴 후속 작업도 같이 다시 돈다.

## 한도에 맞춘 자동 조정
- Claude는 5시간·주간·**Fable 주간** 한도, Codex는 주간 한도를 보여 준다.
- 자동 분배는 남은 한도 비율로 Claude·Codex 작업 비중을 나눈다. 80% 넘은 쪽은 권장 비율만큼만 맡기고, 95% 넘은 쪽은 이번 작업에서 빼고 다른 AI로 넘긴다. 단독 모드도 95%를 넘으면 다른 AI로 바꾼다(`config.json`의 `usageGuard.autoSwitch: false`로 끌 수 있다).
- Fable 주간 한도가 75%를 넘으면 자동 선택이 Fable 대신 Opus를 쓴다.
- 80%·95%를 넘으면 입력창 위 경고 줄과 알림이 뜬다. 바꾼 내용은 작업 카드의 노란 줄에 적힌다.
- 목표 모드는 두 AI가 모두 95%를 넘으면 멈추고, 한도가 풀린 뒤 "이어서"로 계속한다.

## 어디에 무엇이 남나
| 위치 | 내용 |
|---|---|
| `runs/<jobId>/` | GOAL.md, plan/ (플래너 프롬프트·응답), `<taskId>/prompt.md·events.jsonl·result.md`, REPORT.md |
| `data/jobs.json` | 작업 목록 (서버 재시작 후에도 유지) |
| `~/.ai-shared/hub/BOARD.md`, `jobs/<id>.md` | 두 도구가 서로 한 일을 보는 공용 보드 |
| `~/.ai-shared/memory/…` | 각 에이전트가 공용 지침대로 직접 저장하는 장기 메모리 (허브는 읽기만) |

## 설정 (`config.json`)
- `port`, `maxParallel`(동시 실행 수), `taskTimeoutMinutes`
- `planner`: `auto`(Codex 우선) | `claude` | `codex`
- `defaults.<claude|codex>.model/effort`: 화면에서 고르기 전 기본값 (`auto` = 알잘딱 자동, 빈 값 = 각 CLI 평소 설정)
- `autoFloor`: 자동 선택의 하한. 기본 Claude `opus`·`high`, Codex `gpt-6.1-sol`·`high`. 자동은 이보다 낮은 모델·강도를 고르지 않는다.
- Codex CLI는 Codex 앱이 받아 둔 최신판(`~/.codex/packages/app-server-daemon/releases/<버전>/bin/codex.exe`)을 자동으로 쓴다. 오래된 CLI는 `gpt-6.1-sol`을 거부한다.
- `tools.<name>.extraArgs`, `specialties`(플래너가 배정할 때 참고하는 "잘하는 일")
- `defaultCwd`: 프로젝트를 고르지 않았을 때 작업 폴더

## 주의
- 워커는 승인 없이 실행됩니다 (`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`). 신뢰하는 로컬 프로젝트에서만 쓰세요.
- 원격으로 연 화면도 같은 권한입니다. 다른 컴퓨터에서 열 때는 위 "다른 컴퓨터에서 열기"의 Tailscale 방식만 쓰세요.
- 에이전트는 사용자에게 되묻지 못하므로, 모호한 명령은 플래너가 "분배 요약"에 해석을 적고 진행합니다. 결과가 엇나가면 명령을 더 구체적으로.
