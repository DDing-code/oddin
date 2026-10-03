# Git 세션과 세션 관리 연결 규약

허브 본체는 Node 22 ESM이며 추가 패키지를 사용하지 않는다. 기능 본체는 `lib/gitops.mjs`와 `lib/session-tools.mjs`, 기존 세션 연결은 `lib/jobs.mjs`, HTTP 연결은 `server.mjs`에 있다. 이 작업은 서버만 구현한다. `public/` 화면 연결은 별도 담당이 아래 규약으로 구현한다.

## 격리 위치와 기준

`POST /api/sessions`의 `isolate:true`는 선택 폴더가 속한 저장소의 **현재 커밋**에서 새 브랜치와 worktree를 만든다. 원본의 미커밋 변경은 복사하지 않는다.

```text
<원본 저장소 상위>/.ai-hub-worktrees/<저장소 이름>/<제목 슬러그>-<세션 ID 끝 8자>
ai-hub/<UTC 날짜 YYYY-MM-DD>-<제목 슬러그>-<세션 ID 끝 8자>
```

저장소 바깥 형제 폴더를 선택했다. 사용자 저장소에 관리 폴더나 ignore 규칙을 추가하지 않고, 허브의 `data`를 옮기거나 정리해도 작업 코드가 사라지지 않게 하기 위해서다. 선택한 저장소가 기존 worktree여도 그 worktree 바깥의 형제 폴더에 만든다. 저장소 상위 폴더에 쓰기 권한이 필요하다. 같은 제목도 세션 ID로 구분한다.

`git.repo`는 사용자가 선택한 원본 checkout의 저장소 루트, `git.worktree`는 새 checkout의 루트다. 저장소 하위 폴더를 선택하면 `session.cwd`는 새 worktree의 같은 하위 폴더다. 해당 폴더가 기준 커밋에 없으면 새 worktree와 브랜치를 취소하고 오류를 반환한다. 작업 생성 시 전달한 `cwd`보다 저장된 세션 `cwd`를 우선한다.

`baseBranch`는 생성 당시 현재 브랜치, `baseCommit`은 생성 당시 HEAD이며 병합 후에도 바뀌지 않는다. 커밋이 없는 저장소와 분리된 HEAD에서는 격리를 거절한다. 일반 폴더는 HTTP 201로 정상 생성하며 `git:null`, `warnings:["git 저장소가 아니라 격리 없이 시작해요"]`를 반환한다. Git 설정 오류가 있는 저장소를 일반 폴더로 취급하지 않는다.

`config.json`의 `gitOps.defaultIsolate:false`가 기본값이다. 새 세션 API에서 `isolate`를 생략할 때 적용되며, 명시적 `false`가 우선한다. 세션 없이 바로 만드는 기존 작업은 일반 세션으로 시작한다.

## 화면 요구 사항

- 새 세션 대화상자: **Git worktree로 격리** 선택. 저장소의 커밋된 상태에서 시작한다는 짧은 안내와 생성 응답의 `warnings`를 표시한다.
- 세션 상단: 브랜치와 격리 표시, 갈래라면 **OO 세션에서 갈라짐** 및 원본 작업 연결. `forkTitle`은 생성 당시 원본 제목이다.
- 오른쪽 Git 탭: 현재 브랜치, 변경 파일과 수, 기준 대비 앞/뒤 커밋, origin, 커밋 메시지 입력, 커밋·기준 브랜치로 병합·push·PR 만들기·CI 새로고침·worktree 정리 버튼.
- Git 상태 조회는 탭 진입과 Git 작업 완료 후 실행한다. SSE는 세션 메타데이터를 전달하며 파일 상태를 자동 감시하지 않는다. `busy:true`이면 해당 저장소의 변경 버튼을 잠시 막는다.
- Git 변경 버튼은 격리 세션에서만 활성화한다. 실행 중 세션과 같은 저장소에 실행 중 작업이 있으면 서버가 409로 거절한다. 화면은 요청 대기 중 버튼을 비활성화하고 자동 재요청하지 않는다.
- 세션 메뉴: 보관, 갈래 만들기(기준 작업 선택과 격리 선택), 마크다운/JSON 내보내기. 보관·삭제의 **worktree도 정리**는 기본 해제다. 직접 삭제는 `?cleanup=1`로 연결한다.
- 사이드바: 보관함은 `GET /api/sessions?archived=1`, 일반 목록은 기본 GET. 보관함에는 복원 메뉴를 제공하고 보관 중 요청 입력을 막는다.
- `git.cleanedAt`가 있으면 **worktree 정리됨**을 표시한다. 복원해도 작업 폴더를 다시 만들지 않는다. 기존 기록·내보내기는 유지하고 새 요청은 막는다. 새 갈래를 만들면 원본 저장소에서 새 세션을 만든다.
- 충돌 오류의 `files`를 표시한다. 사용자가 원본을 직접 충돌 해소해야 한다는 안내 대신 **충돌이 있어 병합을 취소했어요**와 파일 목록을 보여 준다.
- PR 응답의 `url`은 화면이 브라우저로 연다. 서버는 브라우저를 실행하지 않는다. `created:false`이면 **비교 화면에서 PR 만들기**, `created:true`이면 **PR 열기**로 표시한다.
- CI의 `unavailable`은 실패 아이콘 대신 **확인 불가**와 Actions 링크를 표시한다. `none`은 **아직 검사 없음**이다.
- `/api/status.capabilities`에 `gitSessions`, `sessionArchive`, `sessionFork`, `sessionExport`가 모두 `true`인지 확인하고, 지원하지 않는 서버에서는 해당 조작을 숨기거나 비활성화한다.

## 세션 응답과 SSE

```json
{
  "id": "s-예시",
  "title": "로그인 수정",
  "cwd": "F:/projects/.ai-hub-worktrees/app/로그인-수정-12345678",
  "createdAt": "2026-10-03T12:00:00.000Z",
  "updatedAt": "2026-10-03T12:00:00.000Z",
  "jobIds": [],
  "jobCount": 0,
  "status": "empty",
  "archived": false,
  "warnings": [],
  "forkOf": null,
  "git": {
    "repo": "F:/projects/app",
    "worktree": "F:/projects/.ai-hub-worktrees/app/로그인-수정-12345678",
    "branch": "ai-hub/2026-10-03-로그인-수정-12345678",
    "baseBranch": "main",
    "baseCommit": "0123456789012345678901234567890123456789",
    "isolated": true
  }
}
```

실제 Windows 경로는 절대 경로이며 역슬래시로 반환될 수 있다. 일반 Git 세션은 `isolated:false`, `worktree:null`이다. 이전 버전 세션은 저장된 `git`가 없어도 Git 탭 조회로 현재 상태를 확인할 수 있다. 저장소가 아니면 `git:null`이다. `git.prUrl`은 `gh`로 PR을 만들었을 때, `git.cleanedAt`은 정리 성공 시 추가된다.

기존 `session` SSE 이벤트를 유지한다.

```json
{"type":"session","session":{"id":"s-예시","archived":true,"git":{"isolated":true,"branch":"ai-hub/2026-10-03-예시","cleanedAt":"2026-10-03T12:10:00.000Z"},"forkOf":{"sessionId":"s-원본","jobId":"작업-ID"},"forkTitle":"원본 제목"}}
```

위 이벤트는 필드 설명용 축약 예시다. 실제 `session`은 전체 공개 세션 응답이다. 보관하면 목록에서 제거하고 복원하면 일반 목록에 넣는다. 기존 `hello.sessions`는 보관하지 않은 세션만 전달한다. 삭제 성공 시 기존 `session_removed`를 보낸다. 보관해도 작업 데이터는 유지되므로 `hello.jobs`와 `/api/jobs`는 보관 세션 작업을 포함한다. 화면은 현재 선택 목록/세션을 기준으로 작업을 표시해야 한다.

## API

모든 요청은 기존 원격 접속 게이트를 통과한다. JSON 본문, JSON 응답, 기본 성공 HTTP 200이며 새 세션·갈래 생성은 201이다. 아래 예시의 `:id`는 세션 ID다.

| 방식·경로 | 요청 | 응답/동작 |
|---|---|---|
| `POST /api/sessions` | `{cwd?,title?,isolate?,forkOf?}` | 새 세션 전체 |
| `GET /api/sessions` | 없음 | 보관하지 않은 세션 배열 |
| `GET /api/sessions?archived=1` | 없음 | 보관한 세션 배열 |
| `GET /api/sessions/:id/git` | 없음 | 아래 Git 상태 |
| `POST /api/sessions/:id/git/commit` | `{message?}` | `{committed:true,commit,files}` 또는 `{committed:false,message}` |
| `POST /api/sessions/:id/git/merge` | `{}` | `{merged:true,fastForward,commit,baseBranch}` |
| `POST /api/sessions/:id/git/push` | `{}` | `{pushed:true,branch,commit}` |
| `POST /api/sessions/:id/git/pr` | `{title?,body?}` | `{pushed:true,branch,commit,created,mode,url,warning?}` |
| `GET /api/sessions/:id/git/ci` | 없음 | 아래 CI 상태 |
| `POST /api/sessions/:id/git/cleanup` | `{}` | `{removed:true,branchKept:true,branch}` |
| `POST /api/sessions/:id/archive` | `{cleanup?:boolean}` | 보관된 세션 전체 |
| `POST /api/sessions/:id/unarchive` | `{}` | 복원된 세션 전체 |
| `POST /api/sessions/:id/fork` | `{jobId?,isolate?,cwd?,title?}` | 새 갈래 세션 전체 |
| `GET /api/sessions/:id/export.md` | 없음 | 마크다운 다운로드 |
| `GET /api/sessions/:id/export.json` | 없음 | JSON 다운로드 |
| `DELETE /api/sessions/:id` | 없음 | `{removed:boolean}`, worktree 유지 |
| `DELETE /api/sessions/:id?cleanup=1` | 없음 | 정리 후 삭제. 변경 있으면 둘 다 취소 |

보관 요청에서 `cleanup`을 생략하면 worktree를 남긴다. 이미 정리된 worktree의 cleanup 재요청은 `{removed:false,branchKept:true,branch}`로 성공한다. 일반 세션의 cleanup은 격리 전용 오류다. Git 변경 API는 사용자 버튼 클릭으로만 호출한다. 다음 작업이나 자동 보고에서 커밋·push·병합을 실행하지 않는다.

Git 상태 예시:

```json
{
  "available": true,
  "repo": "F:/projects/app",
  "worktree": "F:/projects/.ai-hub-worktrees/app/로그인-12345678",
  "branch": "ai-hub/2026-10-03-로그인-12345678",
  "baseBranch": "main",
  "baseCommit": "0123456789012345678901234567890123456789",
  "isolated": true,
  "head": "1123456789012345678901234567890123456789",
  "changedFiles": 2,
  "files": [{"path":"src/app.mjs","status":" M"},{"path":"new.mjs","status":"??"}],
  "ahead": 1,
  "behind": 0,
  "baseBranchAhead": 1,
  "baseBranchBehind": 0,
  "origin": "https://github.com/owner/repo.git",
  "github": {"owner":"owner","repo":"repo","url":"https://github.com/owner/repo"},
  "inProgress": false,
  "busy": false
}
```

`files.status`는 Git porcelain의 상태 코드 두 글자를 그대로 전달한다. `ahead/behind`는 생성 당시 `baseCommit` 대비이며, `baseBranchAhead/Behind`는 **현재 로컬** 기준 브랜치 대비다. 네트워크 fetch는 자동 실행하지 않는다. 비교 불가 시 수치는 `null`이다. 이름 변경은 목적 경로 한 건으로 계산한다. origin의 사용자 정보·비밀번호·쿼리 문자열은 응답에서 제거한다.

저장소가 아니면 `{available:false,reason:"not-repository",isolated:false}`, 정리했으면 `{available:false,reason:"cleaned",...git}`다. 변경 상태는 저장된 세션 `git` 메타데이터와 별개이며 조회 시마다 읽는다.

CI 예시:

```json
{"status":"success","source":"github-public","sha":"1123456789012345678901234567890123456789","url":"https://github.com/owner/repo/actions","checks":[{"name":"검사","status":"completed","conclusion":"success","url":"https://github.com/owner/repo/actions/runs/1"}]}
```

상태 값은 `none | pending | success | failure | unavailable`. 검사 실패·취소·시간 초과는 `failure`, 미완료 검사는 `pending`, 성공·neutral·skipped만 남으면 `success`다. 실패 응답은 HTTP 200의 `{status:"unavailable",message:"CI 상태를 확인할 수 없어요",url,checks:[]}`이며 GitHub origin이 없으면 `url:null`이다.

`gh`가 PATH에 있으면 PR의 `headRefOid`가 현재 로컬 HEAD와 일치할 때 PR 검사를 조회한다. PR이 없거나 HEAD가 다르거나 검사 조회에 실패하면 해당 커밋의 run list를 조회한다. 따라서 push하지 않은 로컬 커밋에 이전 PR의 성공 결과를 표시하지 않는다. `gh`가 없거나 조회에 실패하면 인증 헤더 없이 GitHub 공개 `/repos/<owner>/<repo>/commits/<sha>/check-runs`를 조회한다. 비공개 저장소·API 한도·네트워크 오류는 확인 불가와 Actions 주소로 표시한다. 공개 API는 Checks 기록만 조회하며 별도 commit status 기록은 합산하지 않는다. 최대 1000개 검사까지만 조회하고 초과하면 확인 불가를 반환한다.

## 병합·push·정리 안전장치

- 원본 checkout이 `baseBranch`여야 한다. 브랜치를 자동 전환하지 않는다.
- 원본과 worktree 모두 tracked/untracked 미커밋 변경이 없고, merge/rebase/cherry-pick 등의 진행 상태가 없어야 병합한다.
- 가능하면 `--ff-only`, 분기되었으면 `--no-ff --no-commit` 뒤 병합 커밋을 만든다. 충돌과 병합 커밋 실패는 `merge --abort`로 취소한다. 충돌 파일 목록을 보존하고 원본 HEAD·작업 폴더·인덱스 복구를 검사한다. 복구를 확인하지 못하면 500을 반환한다. 강제 reset이나 원본 변경 삭제는 사용하지 않는다.
- 같은 Git 공용 디렉터리의 Git 변경을 직렬화한다. push 대기 중 같은 저장소 새 작업/세션 시작을 막고, 같은 저장소의 실행 중 작업이 있으면 Git 변경을 막는다. 외부 편집기/직접 Git 명령까지 잠그지는 못하므로 병합 중 수동 Git 조작을 피한다.
- 커밋은 worktree의 `git add -A` 뒤 실행한다. 사용자 메시지 또는 `<세션 제목> 작업 반영`을 사용한다. 커밋 실패 시 변경은 보존되며 stage된 상태로 남을 수 있다. `.env` 계열·credentials 경로 변경은 커밋하지 않는다.
- push는 `origin`의 세션 브랜치로만, 강제 push 없이 실행한다. PR은 GitHub origin을 확인한 뒤 push한다. `gh`가 있으면 `gh pr create`, 없으면 URL의 브랜치를 인코딩해 `https://github.com/<owner>/<repo>/compare/<base>...<branch>?expand=1`을 반환한다. `gh` 생성만 실패해도 push 결과는 유지하고 비교 주소로 이어갈 수 있다.
- 기존 Git/gh 인증을 사용하고 인증 파일을 열거나 복사·저장하지 않는다. 대화형 인증은 대기하지 않으며 실패하면 Git 인증 확인 안내를 반환한다. CLI의 원시 stderr/stdout은 API 오류에 노출하지 않는다.
- 정리는 Git에 등록된 세션 worktree에만 수행하고 `--force`를 사용하지 않는다. 현재 브랜치가 바뀌었거나 미커밋 변경·진행 중 Git 작업이 있으면 거절한다. 다른 세션이 같은 worktree를 쓰거나 다른 격리 세션의 기준 checkout으로 사용하는 경우에도 거절한다.
- 정리해도 브랜치를 지우지 않는다. 보관·삭제의 기본은 worktree 유지다. 삭제 후 남긴 worktree는 세션에서 다시 관리하지 않으므로 `git worktree list`로 확인하고 사용자가 직접 관리한다.

## 갈래와 내보내기

```json
{"forkOf":{"sessionId":"s-원본","jobId":"원본-작업-ID"},"isolate":true,"title":"다른 접근"}
```

위 본문으로 `POST /api/sessions`에 직접 갈래 생성도 가능하다. `cwd`를 생략하면 원본 세션 폴더를 사용한다. 정리된 원본 worktree는 원본 저장소 폴더를 사용한다. `/fork`에서 `isolate` 생략은 같은 폴더의 일반 세션이다. `jobId` 생략은 생성 시점 마지막 작업이며 빈 원본은 `jobId:null`이다.

새 세션의 `jobIds`는 빈 배열이고 `forkOf:{sessionId,jobId}`를 저장한다. 다음 요청의 `historyContext`는 원본의 선택 작업까지 요청/결과, 원본의 상위 갈래 맥락, 새 세션의 이전 요청을 기존 형식으로 합친다. 전체 24,000자 제한과 작업 결과 6,000자 제한을 유지한다. 선택 작업 **이후**의 원본 작업은 포함하지 않는다. 기록 참조 방식이므로 특정 시점의 코드 스냅샷은 아니며, 격리는 생성할 때 원본 폴더의 현재 HEAD를 기준으로 한다. 실행 중 작업에서 갈라지면 이후 조회 시 갱신된 결과를 이어받을 수 있다.

갈래가 참조하는 원본 세션/선택 작업까지의 작업은 삭제할 수 없다. 원본 보관은 가능하다. 갈래를 먼저 삭제하거나 원본을 보관해 기록을 유지한다. 이는 기록을 복사하지 않으면서 원본 삭제로 맥락이 사라지는 일을 방지한다.

내보내기는 `Content-Disposition: attachment; filename="<세션 ID>.md"` 또는 `.json`, `Cache-Control:no-store`다. 마크다운에는 세션 정보, 갈래 맥락, 각 요청, 계획 요약, 각 작업 결과, 보고서, 바뀐 파일 목록을 넣는다. JSON 형식은 `{version:1,exportedAt,session,inheritedContext,jobs:[{id,title,createdAt,status,request,summary,tasks,report,changedFiles}]}`다.

바뀐 파일은 작업의 파일 목록과 저장된 Edit/Write 등 도구 로그의 경로만 취합한다. Bash로만 수정한 파일 등 도구 경로 기록이 없는 경우 누락될 수 있다. 파일 내용·환경 파일·CLI 원시 인증 자료를 읽거나 포함하지 않는다. 보관·정리 후에도 내보낼 수 있다. 내보내기는 기록 보관용이며 가져오기 API는 제공하지 않는다.

## 오류 응답

```json
{"error":"충돌이 있어 병합을 취소했어요","code":"GIT_MERGE_CONFLICT","files":["src/app.mjs"]}
```

| HTTP | 코드 | 표시 문장/의미 |
|---|---|---|
| 404 | `SESSION_NOT_FOUND` | 세션이 없어요 |
| 405 | `METHOD_NOT_ALLOWED` | 이 API에서 지원하지 않는 요청 방식이에요 |
| 400 | `INVALID_JSON` | JSON 본문을 확인해 주세요 |
| 400 | `FORK_SOURCE_REQUIRED` / `FORK_JOB_INVALID` | 갈래 원본/원본의 작업을 골라 주세요 |
| 400 | `GIT_COMMIT_MESSAGE` | 커밋 메시지를 4000자 이내로 입력해 주세요 |
| 409 | `SESSION_RUNNING` | 실행 중인 작업을 마친 뒤 시도해 주세요 |
| 409 | `SESSION_ARCHIVED` | 보관함에서 복원한 뒤 요청해 주세요 |
| 409 | `SESSION_FORK_REFERENCED` | 갈래 세션이 참조하는 기록은 삭제할 수 없어요 |
| 409 | `GIT_BUSY` | 이 저장소의 Git 작업이 끝난 뒤 다시 시도해 주세요 |
| 409 | `GIT_BASE_REQUIRED` | 격리하려면 먼저 커밋이 있는 브랜치를 선택해 주세요 |
| 409 | `GIT_BASE_CHANGED` | 원본 저장소를 기준 브랜치로 돌린 뒤 병합해 주세요 |
| 409 | `GIT_DIRTY` | 커밋 안 된 변경이 있어요. 먼저 커밋하거나 정리해 주세요 (`files` 포함) |
| 409 | `GIT_IN_PROGRESS` | 저장소에서 진행 중인 Git 작업을 먼저 마쳐 주세요 |
| 409 | `GIT_MERGE_CONFLICT` | 충돌이 있어 병합을 취소했어요 (`files` 포함) |
| 409 | `GIT_MERGE_FAILED` | 병합하지 못했거나 병합 커밋을 못 만들어 원래 상태로 돌아옴 |
| 500 | `GIT_ROLLBACK_FAILED` | 병합 취소를 확인하지 못했어요. 저장소 상태를 확인해 주세요 |
| 409 | `GIT_NOT_ISOLATED` | 격리 세션에서만 사용할 수 있어요 |
| 409 | `GIT_WORKTREE_REMOVED` | 정리된 worktree예요. 새 갈래 세션을 만들어 주세요 |
| 409 | `GIT_WORKTREE_SHARED` | 다른 세션이 이 worktree를 사용하고 있어요 |
| 409 | `GIT_BRANCH_CHANGED` | 세션 브랜치가 바뀌었어요. 원래 브랜치로 돌아온 뒤 시도해 주세요 |
| 409 | `GIT_WORKTREE_MISMATCH` | 등록된 worktree 경로와 일치하지 않아요 |
| 409 | `GIT_NO_ORIGIN` | origin 원격이 없어요 |
| 409 | `GIT_NOT_GITHUB` | GitHub origin이 있어야 PR을 만들 수 있어요 |
| 409 | `GIT_PUSH_FAILED` | push하지 못했어요. Git 인증과 원격 상태를 확인해 주세요 |
| 409 | `GIT_SENSITIVE_FILE` | 환경 설정·인증 파일은 여기서 커밋할 수 없어요 |
| 409 | `GIT_FOLDER_UNTRACKED` | 선택한 폴더가 기준 커밋에 없어요. 저장소 루트에서 시작해 주세요 |
| 409 | `GIT_UNAVAILABLE` / `GIT_FAILED` | Git 설치·저장소 상태·설정을 확인해 주세요 |
| 409 | `FORK_CYCLE` / `FORK_SOURCE_MISSING` | 갈래 원본 기록이 손상되어 맥락을 읽을 수 없음 |

## 검증과 운영 반영

`node --test tests/gitops.test.mjs tests/sessions.test.mjs`, 전체 회귀는 `npm test`다. Git 시험은 OS 임시 폴더의 로컬 저장소와 bare 원격만 쓴다. 실제 외부 push/PR은 실행하지 않는다. gh와 GitHub 공개 API는 주입한 응답으로 시험한다. 세션 API는 7713 포트, 임시 `HUB_DATA_DIR`, `HUB_RUNS_DIR`, `HUB_CONFIG_FILE`, `HUB_SKIP_CLI_INSTALL=1`로 검증하며 띄운 서버 PID만 종료한다. 실제 모델 호출은 사용하지 않는다.

운영 반영 시 다른 담당의 `lib/jobs.mjs`·`server.mjs` 변경과 최소 연결부를 병합하고 `npm test`를 다시 실행한다. 실행 중 7700 허브를 작업자가 재시작하지 않는다. 사용자가 작업 종료 후 재시작하고 화면 담당 변경을 적용해야 버튼이 연결된다. 기존 데이터 마이그레이션 명령은 필요 없다. 기존 세션의 생략 필드는 `archived:false`, `forkOf:null`로 공개하고 Git 탭은 현재 상태를 읽는다.

참조: [GitHub Checks 공개 조회](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [gh pr checks](https://cli.github.com/manual/gh_pr_checks), [gh run list](https://cli.github.com/manual/gh_run_list), [gh pr create](https://cli.github.com/manual/gh_pr_create).
