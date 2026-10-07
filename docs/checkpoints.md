# 체크포인트·변경 비교·되돌리기 연결 규약

서버 기능만 구현되어 있다. 화면 담당은 아래 API와 SSE로 변경 탭·충돌 확인·되돌리기 취소를 연결한다. `public/` 변경은 포함하지 않는다.

## 저장과 실행 순서

`lib/checkpoints.mjs`의 `Checkpoints`가 세션 작업 폴더의 실제 경로를 해시해 `<HUB_DATA_DIR>/checkpoints/<sha256>.git`에 그림자 Git 저장소를 만든다. Windows에서는 실제 경로의 대소문자를 무시한다. 정션으로 접근해도 같은 실제 폴더는 같은 저장소를 사용한다.

1. 질문은 읽기 전용으로 실행하며 체크포인트를 만들지 않는다. 쓰기 요청은 계획 후 실제 작업 폴더의 실행 잠금을 잡고 `begin(job)`을 기다린 뒤 작업자를 시작한다. `end(job)`까지 마친 뒤 잠금을 푼다.
2. 파일 목록·크기를 조사하고 일반 파일만 커밋한다. 커밋 해시를 `job.checkpoint.before`에 기록한다.
3. 성공·실패·중지 모두 공통 `finish(job)`에서 `end(job)`을 기다린다. 중지 요청을 받은 시점이 아니라 작업 제어 흐름이 실제 종료된 뒤 `after`를 만든다.
4. 변경 목록과 메타데이터가 저장된 뒤 `status: "ready"` 이벤트를 보낸다. `/goal`의 각 라운드는 별도 job으로 같은 처리를 받는다. 목표 달성 판정은 라운드 종료 스냅샷 이후 실행된다.
5. 기존 job의 하위 작업 재시도는 최초 `before`를 유지하고 `after`를 새로 만든다. 비교·되돌리기는 그 job의 원래 실행과 재시도를 합친 결과를 대상으로 한다.

Git 명령에는 항상 전용 `--git-dir`와 `--work-tree`를 지정한다. 사용자 `.git` 폴더와 worktree의 `.git` 파일은 조사 대상에서 제외한다. 사용자 인덱스·참조·설정·훅에는 쓰지 않는다. 글로벌 Git 설정과 외부 diff·textconv도 사용하지 않는다.

파일마다 Git 프로세스를 띄우지 않는다. `hash-object --no-filters --stdin-paths` 한 번과 `update-index -z --index-info` 한 번으로 원본 바이트를 저장한다. `git add`를 우회하므로 `.gitignore`, LFS/clean 필터, `.gitattributes`의 줄바꿈 변환, 중첩 저장소가 스냅샷 내용을 바꾸지 않는다. CRLF와 이진 내용도 그대로 복원된다. 변경의 이진 여부·이름 변경 판정은 Git diff 결과를 따른다.

각 스냅샷은 부모 없는 커밋이고 다음 참조에 연결된다. 삭제한 작업의 옛 커밋이 다른 작업의 부모로 계속 보존되지 않는다.

```text
refs/checkpoints/jobs/<job ID sha256>/before
refs/checkpoints/jobs/<job ID sha256>/after
refs/checkpoints/rewinds/r-<UUID>
```

저장소의 `hub.json`에는 job·세션 ID, 스냅샷 해시, 경고, 복원 백업과 취소 상태를 저장한다. 백업 ID는 서버 재시작 뒤에도 사용할 수 있다. 기존 job에 체크포인트가 없으면 소급 생성하지 않는다. 서버가 비정상 종료돼 `after`가 없는 작업은 비교·복원을 제공하지 않는다.

## 설정과 제외

`config.json` 기본값:

```json
{
  "checkpoints": {
    "enabled": true,
    "maxFileMB": 20,
    "maxFiles": 20000,
    "exclude": []
  }
}
```

`enabled: false`면 새 작업 스냅샷을 만들지 않는다. 기존 저장된 비교와 백업 조회는 유지된다. `maxFileMB`와 `maxFiles`는 양수로 설정한다. MB는 1,048,576바이트다. 기본 크기를 **초과**한 파일만 제외하므로 정확히 20MB인 파일은 포함한다.

기본 제외는 경로의 모든 깊이에 적용된다:

- `.git`, `node_modules`, `dist`, `build`, `.next`, `.venv`, `__pycache__`, `.cache` 디렉터리와 같은 이름의 파일.
- `.env`, `.env.*` 파일 또는 디렉터리. 내용은 읽거나 저장하지 않는다.
- 허브 데이터·실행 기록 폴더. 작업 폴더 안에 있어도 재귀 스냅샷을 만들지 않는다.
- 심볼릭 링크·정션·특수 파일. 외부 위치로 따라가지 않는다.

사용자 `exclude`는 작업 폴더 기준 `/` 상대 경로 패턴이다. `*`는 한 경로 조각, `?`는 한 글자, `**`는 여러 깊이다. 패턴과 일치한 디렉터리는 하위 탐색도 생략한다. 예: `private/**`, `**/*.log`, `*.tmp`, `assets/raw/`. `!` 재포함과 중괄호 확장은 지원하지 않는다. `*.tmp`는 루트 파일용이고 모든 깊이에 적용하려면 `**/*.tmp`를 쓴다. 기본 제외를 재포함할 수 없다.

일반 제외 패턴은 목록을 부풀리지 않는다. 크기·링크·특수 파일 등의 생략은 `skipped`에 남긴다:

```json
[
  { "path": "source.mov", "reason": "large_file", "bytes": 41943040 },
  { "path": "external", "reason": "symlink" },
  { "path": "", "reason": "too_many_files" }
]
```

그 밖의 `reason`은 `special_file`, `changed_during_scan`, `missing_during_scan`이다. before/after 중 어느 한쪽에서 생략된 경로는 비교·복원 목록에서도 제외한다. 작은 파일이 나중에 큰 파일로 바뀌어도 삭제로 오인하지 않는다.

기본 제외 폴더를 뺀 일반 파일 수를 센다. 큰 파일도 개수에 포함한다. 20,000개를 넘으면 해당 스냅샷 전체를 건너뛰고 경고를 남긴다. Git 미설치·권한·파일 조사 실패·명령 시간 초과도 작업 실행을 막지 않는다. Git 명령당 시간 제한은 120초이고 해당 자식 프로세스만 종료한다.

## 체크포인트 상태와 SSE

job 조회와 `hello`의 job 객체에도 `checkpoint`가 포함된다. `before`, `after`는 Git 커밋 해시 또는 `null`이고 `files`는 아래 변경 목록과 같다.

| 상태 | 의미 | 화면 동작 |
|---|---|---|
| 필드 없음 / `unavailable` | 기능 비활성·옛 작업 | 체크포인트 없음 |
| `capturing` | 시작 스냅샷 생성 중 | 저장 중 표시 |
| `pending` | before 완료, 작업 실행 또는 after 처리 중 | 비교·되돌리기 비활성 |
| `ready` | 비교 자료 저장 완료 | 목록·비교·되돌리기 제공 |
| `warning` | 캡처 실패·개수 초과 | `warning` 표시, 되돌리기 비활성 |

`/api/events`의 기존 SSE 스트림에 다음 JSON이 온다. 별도 SSE 이름 없이 기존 `data:` 형식이다.

```json
{
  "type": "checkpoint",
  "jobId": "20261003-example",
  "checkpoint": {
    "status": "ready",
    "repo": "<cwd sha256>",
    "before": "<40자리 해시>",
    "after": "<40자리 해시>",
    "files": [],
    "skipped": [],
    "overlaps": ["다른-job-ID"],
    "startedAt": "2026-10-03T12:00:00.000Z",
    "finishedAt": "2026-10-03T12:01:00.000Z",
    "beforeDurationMs": 500,
    "afterDurationMs": 600
  }
}
```

경고에는 `warning`과 `code`가 추가된다. 겹친 작업이 새로 시작하면 기존 작업에도 갱신 이벤트가 온다. 연결 복구 시에는 job 목록을 다시 받아 상태를 복원한다.

복원·취소 성공 이벤트:

```json
{ "type": "rewind", "jobId": "20261003-example", "backup": "r-<UUID>", "restored": ["src/a.mjs"], "status": "ready" }
```

```json
{ "type": "rewind", "jobId": "20261003-example", "backup": "r-<UUID>", "undoBackup": "r-<다른 UUID>", "restored": ["src/a.mjs"], "status": "undone" }
```

참조 삭제에 실패하면 `{ "type": "checkpoint_cleanup", "jobId": "...", "warning": "체크포인트 참조를 정리하지 못했습니다" }`가 온다.

## 변경 목록과 비교 API

### 작업

`GET /api/jobs/:id/changes`

```json
{
  "status": "ready",
  "files": [
    { "path": "src/a.mjs", "status": "modified", "additions": 3, "deletions": 1, "binary": false },
    { "path": "src/new.mjs", "oldPath": "src/old.mjs", "status": "renamed", "additions": 0, "deletions": 0, "binary": false },
    { "path": "logo.png", "status": "added", "additions": null, "deletions": null, "binary": true }
  ],
  "skipped": [],
  "overlaps": [],
  "warning": null,
  "before": "<해시>",
  "after": "<해시>"
}
```

파일 `status`는 `added`, `modified`, `deleted`, `renamed`다. 이진 파일의 줄 수는 `null`이고 텍스트는 숫자다. 이름 변경은 Git의 유사도 판정이며, 내용이 크게 바뀌면 삭제+추가로 나타날 수 있다. 변경 목록은 저장된 before→after 비교이며 되돌린 뒤에도 유지된다.

`GET /api/jobs/:id/changes/diff?path=src%2Fa.mjs`

```json
{ "path": "src/a.mjs", "unified": "diff --git ...\n@@ -1 +1 @@\n-전\n+후\n", "binary": false, "before": "전\n", "after": "후\n" }
```

추가 파일의 `before`, 삭제 파일의 `after`는 빈 문자열이다. 이름 변경은 `path` 또는 `oldPath`로 조회할 수 있다. 이진 파일은 `{ "path": "logo.png", "unified": "이진 파일 변경", "binary": true }`만 반환한다. before+after+unified의 UTF-8 바이트 합이 1MB를 넘으면 413을 반환한다. 이진 파일 본문은 API로 내보내지 않는다. 파일은 저장소의 blob에서 읽으므로 현재 파일이 삭제되어도 비교가 가능하다.

### 세션 전체

`GET /api/sessions/:id/changes`

세션 `jobIds` 순서에서 체크포인트가 있는 첫 job의 before와 마지막 job의 after를 비교한다. 작업별 변경을 단순 합산하지 않으므로 여러 번 바꿨다가 원복한 파일은 목록에서 빠진다. 같은 목록 응답에 `firstJobId`, `lastJobId`, `repo`가 추가된다. 중간 작업의 `skipped`·`overlaps`도 합친다. 첫 before 또는 마지막 after가 준비되지 않았으면 409, 체크포인트가 하나도 없으면 `unavailable`을 반환한다. 준비 안 된 마지막 작업을 조용히 빼고 이전 상태를 전체 결과처럼 보여 주지 않는다.

`GET /api/sessions/:id/changes/diff?path=src%2Fa.mjs`

세션 양끝의 같은 파일을 비교한다. 응답과 상한은 작업 diff와 동일하다. 세션 전체 복원 API는 제공하지 않는다. 복원은 작업 단위 또는 그 작업의 선택 파일 단위다.

## 복원과 충돌

`POST /api/jobs/:id/rewind`

전체 작업: `{}`. 파일 하나: `{ "paths": ["src/a.mjs"] }`. 선택 파일: `{ "paths": ["src/a.mjs", "src/b.mjs"] }`. 사용자가 확인한 충돌 덮어쓰기: `{ "paths": ["src/a.mjs"], "force": true }`.

`paths`를 생략하면 변경 파일 전체다. 빈 배열이나 변경 목록에 없는 경로는 400이다. 파일 하나가 이름 변경이면 이전·이후 경로를 함께 복원한다. 경로는 `/` 상대 경로로 보내며 `..`, 절대 경로, `.git`, 역슬래시, 드라이브·스트림 표기는 거절한다.

성공:

```json
{ "restored": ["src/a.mjs", "src/new.mjs", "src/old.mjs"], "conflicts": [], "backup": "r-<UUID>" }
```

현재 파일의 원본 바이트 해시·실행 비트와 after를 비교한다. 파일의 유무도 비교한다. 하나라도 다르면 **200 충돌 응답**이고 아무 파일도 복원하지 않는다:

```json
{
  "restored": [],
  "conflicts": [{ "path": "src/a.mjs", "reason": "current_changed", "message": "작업 이후 이 파일이 다시 바뀌었습니다" }],
  "backup": null
}
```

화면은 HTTP 200만 보고 성공 처리하지 말고 `conflicts.length`를 확인한다. `force: true`는 이 내용 충돌만 무시한다. 실행 중 작업·연결 경로·디렉터리 충돌·백업 실패는 무시하지 않는다.

복원 전에 현재 폴더를 `rewind-backup` 스냅샷으로 기록한다. 백업 메타데이터를 저장한 다음 선택 파일만 before로 복원한다. 새로 만든 파일은 삭제하고 지운 파일은 복구한다. 선택되지 않은 파일은 그대로 둔다. 현재 충돌 파일이 큰 파일로 바뀌어 백업에서 제외되면 강제 복원도 거부한다. 폴더 전체 파일 수 초과도 복원을 중단한다. 백업 뒤 파일이 다시 바뀌면 강제 요청이어도 복원을 보류하고 새 충돌을 반환한다.

`POST /api/rewinds/:backup/undo` 본문 `{}` 또는 확인 후 `{ "force": true }`.

```json
{ "restored": ["src/a.mjs"], "conflicts": [], "backup": "r-<원래 UUID>", "undoBackup": "r-<새 UUID>", "status": "undone" }
```

복원했던 파일만 백업 당시 상태로 되돌린다. 현재 내용과 복원 직후 예상 상태가 다르면 같은 충돌 응답으로 보류한다. 취소도 현재 상태를 별도 백업한다. `undoBackup`에 다시 undo를 호출하면 취소 직전 상태를 복구할 수 있다. 이미 취소한 백업의 재호출은 `restored: []`, `status: "undone"`이며 추가 쓰기를 하지 않는다.

복원 백업의 `kind`는 `rewind-backup`이고 `status`는 `prepared`(백업 저장, 복원 완료 미확정), `ready`(복원 완료), `undone`(취소 완료)다. 쓰기 실패가 나도 `prepared` 백업은 남는다. 재시작 후 이 백업을 사용해 필요한 복원을 시도할 수 있다. 실제 복원 도중 디스크·권한 오류가 나면 일부 파일만 쓰였을 수 있으므로 완료로 표시하지 말고 목록 API에서 해당 job의 최신 백업을 조회해 안내한다. 파일별 임시 파일을 먼저 준비하므로 폴더 전체 원본을 메모리에 한꺼번에 올리지 않는다.

## 목록·용량·정리

`GET /api/checkpoints`

```json
{
  "bytes": 123456,
  "repositories": [{
    "id": "<cwd sha256>", "cwd": "F:\\프로젝트", "bytes": 123456,
    "updatedAt": "2026-10-03T12:00:00.000Z", "unused": false,
    "jobs": [{ "jobId": "...", "sessionId": "...", "status": "ready", "before": "...", "after": "...", "files": [], "skipped": [], "overlaps": [] }],
    "backups": [{ "id": "r-<UUID>", "jobId": "...", "sessionId": "...", "hash": "...", "ref": "...", "paths": ["src/a.mjs"], "status": "ready", "createdAt": "..." }]
  }]
}
```

`bytes`는 Git 객체와 메타데이터의 실제 파일 바이트 합이다. 현재 용량 조사만 하며 자동 삭제하지 않는다. 화면은 `updatedAt`으로 오래된 저장소를 표시하고 `unused`와 함께 용량을 보여 준다. 오래됐어도 살아 있는 작업·백업 참조를 임의 삭제하지 않는다.

세션 삭제는 기존 `DELETE /api/sessions/:id`를 그대로 쓴다. 관련 job·복원 백업의 Git 참조 정리를 비동기로 예약한다. 단일 job 삭제도 같은 처리를 한다. 실행 중 job을 삭제해도 늦은 after가 참조를 되살리지 않는다. 다른 세션이 같은 폴더를 쓰면 그 참조는 유지한다. 삭제 직후 목록에는 정리 전 자료가 잠깐 보일 수 있다.

`POST /api/checkpoints/cleanup` 본문 `{}`.

사용 중 폴더는 건너뛰고, 참조가 없는 저장소는 삭제하며 나머지는 `git gc --prune=now`로 압축·미참조 객체 정리한다. 응답은 `{ "removed": ["<cwd 해시>"], "compacted": ["<cwd 해시>"], "bytes": 1234, "repositories": [...] }`다. 자동 기간 만료·살아 있는 백업 삭제는 구현하지 않는다.

## 오류 규약

서버의 공통 오류 응답은 `{ "error": "짧은 한국어 안내", "code": "기계 판별 코드" }`다. 기존 원격 게이트의 Host·Origin·사용자 검사가 체크포인트 API보다 먼저 실행된다.

| HTTP | code | 오류 문장 / 처리 |
|---|---|---|
| 400 | `CHECKPOINT_PATH_INVALID` | 작업 폴더 밖의 경로는 사용할 수 없습니다 |
| 400 | `CHECKPOINT_REQUEST_INVALID` | 되돌릴 파일 목록과 덮어쓰기 여부를 확인하세요 |
| 400 / 404 | `CHECKPOINT_FILE_NOT_FOUND` | 변경된 파일만 되돌릴 수 있습니다 / 변경된 파일이 아닙니다 |
| 404 | `JOB_NOT_FOUND` / `SESSION_NOT_FOUND` | 작업이 없습니다 / 세션이 없습니다 |
| 404 | `REWIND_NOT_FOUND` | 되돌리기 백업이 없습니다 |
| 409 | `CHECKPOINT_NOT_READY` | 비교할 체크포인트가 아직 없습니다 |
| 409 | `CHECKPOINT_BUSY` | 같은 폴더의 작업이 끝난 뒤 되돌리세요 |
| 409 | `CHECKPOINT_UNSAFE_PATH` | 연결된 경로는 복원할 수 없습니다 / 같은 경로에 폴더가 있어 복원할 수 없습니다 / 작업 폴더의 실제 위치가 바뀌어 복원할 수 없습니다 |
| 409 | `CHECKPOINT_BACKUP_INCOMPLETE` | 제외된 파일이 있어 안전하게 백업할 수 없습니다 |
| 413 | `DIFF_TOO_LARGE` | 비교 내용은 1MB 이하만 볼 수 있습니다 |
| 413 | `CHECKPOINT_TOO_MANY_FILES` | 파일이 20000개를 넘어 스냅샷을 건너뛰었습니다 |
| 503 | `CHECKPOINT_TIMEOUT` | 체크포인트 처리 시간이 초과되었습니다 |
| 503 | `CHECKPOINT_GIT_FAILED` | 체크포인트 Git을 실행하지 못했습니다 / 체크포인트 Git 처리에 실패했습니다 |
| 500 | `CHECKPOINT_FAILED` | 체크포인트를 처리하지 못했습니다 |

개수 경고의 숫자는 설정값을 따른다. 캡처 오류는 job의 `checkpoint.warning`으로 전달되어 작업 자체를 실패시키지 않는다. 복원·API 처리 오류는 해당 요청을 중단한다.

## 화면 구현 요구

1. 오른쪽 변경 탭에서 작업 또는 세션 전체 범위를 선택한다. 파일 목록에 한글 상태(추가·수정·삭제·이름 변경), 경로, 줄 수를 표시한다. 이진 줄 수를 0으로 오인하지 않는다.
2. 파일 선택 시 `encodeURIComponent(path)`로 diff를 조회한다. `unified` 또는 `before`·`after`로 줄 단위 보기를 구현하고, 모든 파일 내용은 텍스트로 렌더링한다. 이진은 "이진 파일 변경", 413은 상한 안내를 표시한다.
3. `overlaps`가 있으면 "같은 시간에 다른 작업이 함께 돌았음"과 작업 ID를 표시한다. `skipped`는 경로와 이유를 접어서 보여 준다. `warning`을 숨기지 않는다.
4. 작업별 되돌리기 버튼과 파일별 되돌리기를 제공한다. 준비 완료 전이나 같은 폴더 작업 실행 중에는 비활성 표시하고 서버의 409도 처리한다. 이름 변경은 양쪽 경로가 함께 복원됨을 표시한다.
5. 충돌 응답이면 파일 목록과 "작업 이후 이 파일이 다시 바뀌었습니다"를 보여 준다. 사용자가 "그래도 덮어쓰기"를 선택한 경우에만 동일 범위에 `force: true`를 보내며, 선택 취소 시 아무 요청도 추가하지 않는다.
6. 복원 성공 후 "작업을 되돌렸습니다" 알림과 "되돌리기 취소" 버튼을 표시한다. 백업 ID를 저장하고 undo 요청에 쓴다. 취소에도 충돌 확인을 적용한다. 목록 API의 백업으로 재접속 뒤 취소 기능을 복구한다.
7. 되돌린 뒤 기존 before→after 비교는 작업 이력으로 유지한다. 현재 상태와 비교라고 표시하지 않는다. SSE 갱신은 해당 job 카드·변경 탭에 반영한다.
8. 저장소 용량·갱신 시각·사용 여부와 정리 버튼을 제공한다. 정리 후 목록을 응답값으로 갱신한다.

## 한계와 운영 반영

- 같은 폴더의 여러 작업·외부 편집은 서로 섞일 수 있다. `overlaps`는 허브에서 실제 스냅샷/작업 구간이 겹친 ID다. 외부 프로그램·다른 허브 프로세스의 변경은 식별하지 못한다. 파일의 변경 주체를 보장하지 않는다.
- 같은 그림자 저장소의 스냅샷·복원·정리는 서버 안에서 직렬화한다. 같은/상하위 실제 폴더의 서로 다른 쓰기 요청도 작업 관리자에서 직렬화한다. 한 요청 내부의 의존성이 없는 작업은 기존 동시 실행 설정을 따른다. 한 데이터 폴더를 여러 허브 서버가 동시에 쓰는 구성은 지원하지 않는다.
- 폴더 전체의 원자적 파일 시스템 스냅샷은 아니다. 조사·해시·복원 중 외부 편집이 가능하다. 백업 후 재검사와 파일별 임시 파일 교체를 사용하지만 검사와 교체 사이의 외부 쓰기까지 차단할 수는 없다.
- 심볼릭 링크, 정션, 빈 디렉터리, ACL, 소유자, 수정 시각, Windows 추가 데이터 스트림은 복원하지 않는다. 파일 실행 비트는 Unix에서 보존한다. 일반 파일 대신 폴더가 있는 경로는 강제로 재귀 삭제하지 않는다. 파일↔폴더 구조 충돌은 수동 정리가 필요하다.
- 백업과 복원은 로컬 일반 파일 대상이다. Git이 PATH에 있어야 한다. 기본 20MB를 넘는 영상·이진 파일은 비교·복원 대상이 아니다. 스냅샷에는 제외되지 않은 파일의 전체 내용이 로컬에 보관되므로 프로젝트에 맞는 `exclude`를 설정한다.
- 운영 반영은 공용 파일 연결 줄과 새 모듈·설정·시험·문서를 함께 합친다. 운영 작업이 끝난 뒤 사용자가 허브를 재시작해야 서버 코드가 적용된다. 이 작업에서는 운영 허브를 재시작하거나 요청하지 않았다. 화면은 별도 담당이 이 규약으로 연결해야 한다.

## 시험과 성능 측정

`node --test tests/checkpoints.test.mjs`는 임시 폴더에서 추가·수정·삭제·이름 변경·이진·큰 파일 제외, 원본 `.git` 무손상, 중첩 저장소, CRLF, 충돌·강제 복원·취소, 겹침, 파일 수 제한, 작업 관리자 시작·종료·재시도·목표 라운드, 삭제·정리, API·SSE를 시험한다. 실제 AI 모델 호출은 하지 않는다. 시작 흐름 시험의 CLI 상태 조회는 기존 가짜 CLI를 사용한다.

HTTP 시험 서버는 7712 포트와 임시 `HUB_DATA_DIR`, `HUB_RUNS_DIR`, `HUB_CONFIG_FILE`, `HUB_SKIP_CLI_INSTALL=1`을 사용한다. 시험이 띄운 자식 PID만 종료한다.

최종 검증: `node --test tests/checkpoints.test.mjs` 15/15 통과, `npm test` 105/105 통과, `git diff --check`와 서버·작업 관리자·체크포인트 모듈의 `node --check` 통과.

성능 측정은 2026-10-03 Windows, Node 22.17.1, Git 2.50.1에서 실시한다. 실제 운영 `workspace` 파일은 읽기만 하고 그림자 저장소는 임시 폴더에 둔다. 측정 결과는 아래에 기록한다. 조사·해시·커밋 시간을 합친 값이며 디스크 캐시·동시 편집·파일 수·파일 크기에 따라 달라진다. 파일 생성 시간은 제외한다.

| 대상 | 포함 파일 / 생략 | before | after | 비교·용량 조회까지 합계 | 그림자 저장소 |
|---|---|---|---|---|---|
| `F:\01_프로젝트\90_개발\ai-hub\workspace` | 4,236 / 5 | 25,284ms | 4,393ms | 30,106ms | 394,534,753바이트 |
| 임시 100개 폴더 × 100개 텍스트 파일 | 10,000 / 0 | 5,910ms | 5,549ms | 11,560ms | 734,486바이트 |

1만 파일 자료는 파일당 약 3.3KB이고 같은 100가지 내용이 반복되어 객체 중복 제거 효과가 크다. 실제 `workspace`는 서로 다른 이미지·산출물도 포함한다. 첫 측정 시도는 Git 종료 코드 128로 캡처 경고가 발생했고, 이후 같은 조건의 재측정은 위와 같이 성공했다. 첫 실패의 원인은 확정하지 못했으며 이 값은 단일 성공 측정이다. 실패 시에도 작업을 막지 않는 경로는 별도 시험한다.

재현 절차: 임시 데이터 폴더를 만든 뒤 `new Checkpoints({}, { dataDir: 임시폴더 })`로 각각 `begin(job)`·`end(job)`을 기다린다. `beforeDurationMs`, `afterDurationMs`, `tree(...).size`, `skipped.length`, `storage().bytes`를 기록하고 임시 폴더만 삭제한다. 원본 작업 폴더의 파일을 수정하거나 운영 API를 호출하지 않는다. 1만 파일은 임시 작업 폴더에 100개 하위 폴더와 각 100개 텍스트 파일을 생성한다.
