# 내장 터미널·파일 보기·미리보기 연결 규약

서버 기능만 제공한다. 화면 담당은 이 규약대로 `public/`에 화면을 연결한다. 허브 본체는 Node 22 ESM이며 새 패키지를 사용하지 않는다. `lib/terminal.mjs`는 셸·출력·중지를, `lib/files.mjs`는 파일 읽기를, `lib/preview.mjs`는 미리보기와 API 연결을 담당한다. `lib/opener.mjs`는 변경하지 않고 경로 해석과 허용 범위 검사를 재사용한다.

## 공통

모든 경로는 현재 연결된 허브 기준이다. 기존 Tailscale 게이트를 통과한 원격 화면도 터미널·파일 읽기·미리보기를 사용할 수 있다. 터미널 권한은 허브 PC에서 명령을 실행하는 전체 권한이다. 허브는 계속 `127.0.0.1`에만 바인딩한다.

JSON 요청은 `Content-Type: application/json`을 사용한다. 오류는 원칙적으로 `{ "error": "짧은 한국어 안내" }`이며 HTTP 상태를 함께 확인한다. 지원하지 않는 요청 방식은 405다. 게이트 오류에는 기존 `code`가 추가될 수 있다. SSE는 기존 `GET /api/events`의 `data: <JSON>\n\n` 형식을 사용한다. 작업 이벤트와 같은 연결에서 터미널 이벤트도 수신한다.

구버전 서버에서는 아래 API가 404다. 화면은 기능 지원 여부를 `GET /api/terminals`로 확인하고, 없는 서버에는 “서버 업데이트 후 다시 열어 주세요”를 표시한다. 화면 코드만 새로고침해도 실행 중인 서버 모듈은 업데이트되지 않는다.

## 터미널 API

| 요청 | 본문·매개변수 | 응답 |
|---|---|---|
| `POST /api/terminals` | `{ "sessionId": "세션ID", "shell": "powershell" }` | 201, 터미널 상태 |
| `GET /api/terminals?sessionId=세션ID` | 세션 필터 생략 시 전체 | 상태 배열 |
| `POST /api/terminals/:id/input` | `{ "text": "Write-Output '안녕하세요'" }` | 입력 직후 상태 |
| `POST /api/terminals/:id/interrupt` | `{}` 또는 빈 본문 | 중지 요청 처리 직후 상태 |
| `DELETE /api/terminals/:id` | 없음 | `{ "removed": true }` |
| `GET /api/terminals/:id/buffer` | 없음 | 상태·최근 출력·마지막 순번 |

셸 값은 `powershell`(기본), `cmd`, `bash`다. `bash`는 Program Files 또는 사용자 Programs 아래의 Git Bash가 설치된 경우에만 지원한다. 클라이언트에서 실행 파일 경로나 실행 인자를 지정할 수는 없다. 시작 폴더는 해당 세션의 `cwd`다. 같은 세션에 여러 터미널을 만들 수 있다. `config.json`의 `terminal.maxTerminals`는 허브 전체의 동시에 살아 있는 터미널 상한이며 기본 8, 설정 가능 범위 1~64다.

상태 예시:

```json
{
  "id": "터미널ID",
  "sessionId": "세션ID",
  "shell": "powershell",
  "cwd": "F:\\작업\\프로젝트",
  "pid": 12345,
  "running": false,
  "ready": true,
  "closed": false,
  "code": null,
  "commandCode": 0,
  "seq": 12
}
```

`running`은 입력한 명령 실행 여부다. `ready`는 입력 가능한 셸 준비 여부이며, `closed`는 셸 프로세스가 종료됐는지를 나타낸다. `code`는 셸 자체의 종료 코드, `commandCode`는 최근 명령의 종료 코드다. 실행 시작 때 `commandCode`는 `null`로 바뀐다. 성공은 0, 명령 실패는 해당 종료 코드, 중지한 명령은 130이다. 준비 전과 종료 후에는 입력할 수 없다.

입력은 공백뿐인 문자열을 제외한 UTF-8 64KB 이하 글이다. 개행이 있는 명령도 가능하다. 실행 중인 명령에 추가 입력을 보내면 409이며, 입력 대기형 프로그램의 표준 입력으로 전달하는 기능은 제공하지 않는다. 명령 중지 요청의 HTTP 성공은 중지 작업을 요청했다는 뜻이다. **실제 완료는 `term_state.running: false`로 확인한다.** 중지에 사용되는 프로세스 조회는 수 초 걸릴 수 있다.

SSE 예시:

```json
{ "type": "term", "id": "터미널ID", "sessionId": "세션ID", "chunk": "안녕하세요\n", "stream": "stdout", "seq": 13 }
```

```json
{ "type": "term_state", "id": "터미널ID", "sessionId": "세션ID", "shell": "powershell", "cwd": "F:\\작업", "pid": 12345, "running": false, "ready": true, "closed": false, "code": null, "commandCode": 0, "seq": 13 }
```

```json
{ "type": "term_exit", "id": "터미널ID", "sessionId": "세션ID", "code": 1 }
```

`stream`은 `stdout` 또는 `stderr`다. `chunk`는 임의 크기의 문자열이며 줄 단위 이벤트라고 가정하면 안 된다. ANSI 색 코드는 삭제하지 않고 그대로 전달한다. 화면은 ANSI를 안전한 텍스트·스타일로 변환하고, 출력 문자열을 `innerHTML`에 넣지 않는다. 셸 종료 때 `term_state` 후 `term_exit`가 온다. 닫기 버튼은 화면 탭을 숨기는 것과 달리 서버에 DELETE를 보내야 한다.

버퍼 예시:

```json
{
  "terminal": { "id": "터미널ID", "seq": 13, "running": false },
  "chunks": [
    { "type": "term", "id": "터미널ID", "sessionId": "세션ID", "chunk": "안녕하세요\n", "stream": "stdout", "seq": 13 }
  ],
  "seq": 13,
  "limit": 2000
}
```

버퍼는 최근 2000개 개행과 최대 2MB의 출력만 메모리에 보관한다. 오래된 첫 조각은 일부 잘릴 수 있다. 줄 없는 대량 출력도 마지막 2MB를 보관한다. 실시간 이벤트는 전체 출력을 전달한다. 재연결은 SSE를 먼저 구독해 이벤트를 잠시 모으고, 버퍼를 가져와 화면을 복원한 뒤 **버퍼 `seq`보다 큰 출력 이벤트만** 이어 붙인다. 상태 이벤트에는 출력 순번을 기준으로 한 중복 제거를 적용하지 않는다. 버퍼와 터미널은 허브 재시작 후 복원되지 않는다. 이미 종료된 셸의 버퍼는 DELETE 전까지 조회할 수 있다.

터미널 오류:

| 상태 | 대표 안내 |
|---|---|
| 400 | “지원하지 않는 셸이에요”, “Git Bash를 찾지 못했어요”, “명령은 비어 있지 않은 64KB 이하의 글로 보내 주세요” |
| 404 | “세션을 찾지 못했어요”, “터미널을 찾지 못했어요” |
| 409 | “명령이 실행 중이에요. 먼저 중지해 주세요”, “터미널이 닫혔거나 준비 중이에요” |
| 429 | “터미널은 동시에 8개까지 열 수 있어요” (설정값 반영) |
| 500·504 | “셸을 시작하지 못했어요”, “셸 시작 시간이 초과됐어요” |

## 파일 읽기·폴더 목록 API

`GET /api/file?path=절대경로&rel=원래상대경로&base=기준폴더`는 `/api/open`·`/view/`·폴더 목록과 같은 범위(server.mjs `openRoots`)를 사용한다: 작업 공간·허브·공유 허브·등록 프로젝트·드라이브 ODDIN 폴더, 그리고 모든 세션 폴더·옮겨 간 프로젝트 폴더·**작업이 실제로 실행된 폴더**(보관한 것 포함, `jobs.workFolders`). 플래너가 작업을 프로젝트 폴더로 옮겨도(applyWorkdir) 예전 결과물이 계속 열린다(2026-10-05 "업데이트 후 시안 그림·영상이 안 열림" 수정). URL 매개변수는 `URLSearchParams`로 인코딩한다. `rel`과 `base`는 선택값이다. 상대 경로는 기준 폴더 → 상위 3단계 → 허브가 아는 폴더 순으로 해석한다. 그 후 허용 범위를 검사하므로 상위 폴더 검색이 읽기 권한을 넓히지 않는다. 바깥 폴더를 향하는 정션·심볼릭 링크도 실제 경로 검사로 거절한다.

결과 페이지 보기(2026-10-05): `GET /view/<절대 경로 조각마다 인코딩, 구분자 />`는 같은 허용 범위의 파일을 **페이지 그대로** 보낸다(HTML은 text/html, CSS·JS·그림·영상·글꼴은 제 형식, 범위 요청 지원). 주소가 폴더 구조를 따르므로 페이지 안 상대 경로가 이어지고, 폴더 주소는 끝에 / 를 붙이도록 302 후 index.html 을 보낸다. 허브 화면·API 와 섞이지 않게 `Content-Security-Policy: sandbox allow-scripts …`(allow-same-origin 없음, 고유 출처 없음)로 보낸다. 원격(Tailscale) 화면에서 HTML 경로 링크를 누르면 새 탭에 이 주소로 열고, 경로 오른쪽 클릭·파일 보기 창 머리에 "페이지로 열기"가 있다. 그래서 작업자는 결과를 원격에서 보이게 하려고 public/ 복사·게시를 하지 않는다(작업 지시문 규칙).

파일 종류를 먼저 알아야 하는 화면은 `GET /api/file?...&meta=1`을 사용한다. 미디어는 메타 JSON으로 돌아오며, 텍스트와 이진 파일은 일반 GET과 같은 JSON이다. 미디어 표시에는 `meta=1`을 뺀 원래 URL을 사용한다.

텍스트 응답 예시:

```json
{
  "path": "F:\\작업\\index.mjs",
  "name": "index.mjs",
  "size": 32,
  "modifiedAt": "2026-10-03T12:00:00.000Z",
  "language": "javascript",
  "contentType": "text/plain; charset=utf-8",
  "kind": "text",
  "streaming": false,
  "encoding": "utf-8",
  "bom": false,
  "tooLarge": false,
  "content": "console.log('안녕하세요');"
}
```

UTF-8 BOM은 내용에서 제거하고 `bom: true`로 표시한다. UTF-16 BOM이 있으면 디코딩한 내용과 `utf-16le` 또는 `utf-16be`를 반환해 화면에 인코딩을 표시한다. 알려진 텍스트 확장자에서 UTF-8 검증에 실패하면 `encoding: "unknown"`, `content: null`, “UTF-8이 아닌 파일이에요. 인코딩을 확인해 주세요”를 반환한다. CP949 등은 자동 변환하지 않는다. 텍스트가 1MB를 초과하면 `tooLarge: true`, `content: null`과 “텍스트는 1MB까지 볼 수 있어요”를 반환한다.

이미지·영상·오디오·PDF는 `kind: image | video | audio | pdf`, `streaming: true`다. 일반 GET은 파일 바이트를 알맞은 Content-Type으로 스트리밍한다. `HEAD`는 같은 미디어 헤더만 반환한다. `Range: bytes=시작-끝`, `bytes=시작-`, `bytes=-끝에서길이`를 지원한다. 범위 응답은 206·`Content-Range`·`Content-Length`, 일반 응답은 200·전체 길이이며, 둘 다 `Accept-Ranges: bytes`를 보낸다. 잘못된 범위·다중 범위는 본문 없는 416과 `Content-Range: bytes */전체크기`다. 스트리밍 응답은 `X-File-Language`로 언어 추정값도 전달한다.

그 밖의 이진 파일은 `kind: "binary"`, `streaming: false`, `contentType: "application/octet-stream"`인 메타 정보만 반환하며 원본 다운로드는 제공하지 않는다. `language`는 확장자 기준 하이라이트 언어이고 미확인 확장자는 `plaintext`다. 마크다운은 `markdown`, JS는 `javascript`, TS는 `typescript`, PowerShell은 `powershell`, HTML은 `html`, SVG는 `xml`이다.

**HTML·SVG는 파일 API에서 미디어로 제공하지 않는다. 항상 JSON 텍스트로만 반환한다.** 모든 응답은 `X-Content-Type-Options: nosniff`를 사용한다. 파일 화면에서도 HTML 실행이나 SVG 원본 삽입을 하지 않는다. 마크다운 렌더러는 원시 HTML·스크립트·위험한 링크를 제거한다.

`GET /api/files/list?path=절대폴더&hidden=1` 응답 예시:

```json
{
  "path": "F:\\작업",
  "entries": [
    { "name": "src", "path": "F:\\작업\\src", "kind": "directory", "size": 0, "modifiedAt": "2026-10-03T12:00:00.000Z", "hidden": false, "language": "plaintext" },
    { "name": "index.mjs", "path": "F:\\작업\\index.mjs", "kind": "file", "size": 32, "modifiedAt": "2026-10-03T12:00:00.000Z", "hidden": false, "language": "javascript" }
  ],
  "truncated": false,
  "limit": 2000
}
```

숨김은 점으로 시작하는 이름과 Windows Hidden 속성을 포함한다. 기본은 숨김 제외, `hidden=1`이면 포함한다. `kind`는 `directory | file | link`다. `size`는 파일 시스템의 바이트 크기이며 폴더의 합계 용량을 뜻하지 않는다. 최대 2000개만 반환하고 생략하면 `truncated: true`다. 반환된 항목만 폴더 우선·이름 순으로 정렬한다. 페이지 나누기는 제공하지 않는다. 목록 속 링크도 파일을 읽을 때 다시 범위 검사한다. 기존 `GET /api/dir`은 변경하지 않는다.

### 파일 열기·보기 범위 설정 (2026-10-05)

입력창 아래 **권한** 메뉴 아래쪽 "파일 열기·보기 범위"에서 고른다(`lib/file-access.mjs`, PC마다 `data/file-access.json`). `허브가 아는 폴더만`(기본)과 `모든 폴더`(이 PC의 모든 드라이브 루트를 범위에 더함) 두 가지다. `GET/POST /api/file-access {allowAll}`, 바뀌면 `file-access` 이벤트, `/api/options`의 `fileAccess`로도 내려간다. 작업자(CLI) 권한과는 별개로, 허브 화면에서 파일을 열고 보는 범위만 바꾼다.

### 이름만 적힌 결과 파일

보고에 하위 폴더 없이 이름만 적혀(`스토리보드.md`) 기준 폴더·상위·아는 폴더에 없으면, 기준 폴더 아래(깊이 6·폴더 4000개·1.5초까지, 숨김·node_modules 제외)에서 같은 이름을 찾아 가장 최근에 고친 것을 쓴다(`opener.findBelow`).

### 다른 PC 작업의 파일

다른 PC 작업(rm- id)의 결과 파일은 `&job=rm-…`을 붙이면 서버가 그 PC에서 받아 흘려보낸다(`federation.proxy`, Range·크기 머리 전달). 다른 PC 요청 판별은 아는 PC 표시만 본다 — 파일 이름에 우연히 `rm-xx-`(transform-3d-)가 있어도 넘기지 않는다.

### 결과 그림·영상 바로 보기

`public/media.js`가 작업 보고(없으면 작업별 결과)에 적힌 그림(png·jpg·gif·webp·bmp·avif)·영상(mp4·m4v·webm·mov) 경로를 작업 카드 끝에 썸네일·재생기로 보여 준다. 그림은 9개까지 보이고 나머지는 "더 보기". 누르면 허브 확대창(`window.hubOpenViewer`, 영상도 재생, ▢ 버튼으로 이 PC 기본 프로그램 열기). 없는 파일(404)은 조용히 빼고, 범위 밖(403)은 안내 줄을 띄운다. 다시 그려도 재생이 끊기지 않게 작업별 DOM을 보관해 `window.hubMounts`로 끼운다.

파일 오류는 형식 오류 400 “읽을 수 없는 경로 형식이에요”, 범위 밖 403 “허브가 아는 폴더 밖이에요 · 입력창 아래 권한 메뉴에서 "모든 폴더"를 켜면 열 수 있어요”, 없음 404 “경로를 찾지 못했어요”다. 폴더를 파일 API로 읽으면 400 “파일을 골라 주세요”, 파일을 목록 API에 보내면 400 “폴더를 골라 주세요”다.

## 미리보기 API·HTTP 프록시

터미널 출력의 `http://localhost:포트`, `http://127.0.0.1:포트`, `http://[::1]:포트`, `http://0.0.0.0:포트`를 발견해 세션별로 보관한다. ANSI와 출력 조각 사이에 나뉜 URL도 처리한다. 마지막 512자를 이어서 검사하고 세션당 최대 64개를 보관한다. HTTPS·외부 호스트 URL은 등록하지 않는다.

`GET /api/preview/targets?sessionId=세션ID` 응답 예시:

```json
{
  "sessionId": "세션ID",
  "targets": [
    { "port": 5173, "source": "detected", "url": "http://127.0.0.1:5173/", "proxyUrl": "/preview/5173/", "detectedAt": "2026-10-03T12:00:00.000Z", "listening": true }
  ],
  "ports": [
    { "port": 5173, "addresses": ["127.0.0.1"], "pids": [12345], "selectable": true },
    { "port": 7700, "addresses": ["127.0.0.1"], "pids": [23456], "selectable": false }
  ],
  "websocket": false
}
```

`ports`는 이 PC의 TCP LISTEN 목록을 `netstat -ano -p TCP`로 조회한 값이다. 다른 인터페이스에만 바인딩된 포트도 보일 수 있지만, 프록시는 항상 `127.0.0.1`로 연결하므로 그런 서버는 연결에 실패할 수 있다. `listening`은 LISTEN 목록에 해당 포트가 있다는 뜻이며 정상 HTTP 응답까지 검사한 값은 아니다.

사용자가 주소 표시줄이나 포트 목록에서 골랐으면 `POST /api/preview/targets`에 `{ "sessionId": "세션ID", "port": 5173 }`을 보낸다. 201로 해당 대상 정보가 돌아오고 `source`는 `selected`다. 발견·선택한 포트만 프록시를 사용할 수 있다. 세션을 삭제하면 그 세션의 허용 항목도 프록시 권한에서 제외된다. 같은 허브의 다른 세션에서 등록한 포트도 프록시 경로를 공유한다. 포트 선택은 서버를 실행하는 기능이 아니다.

1024 미만·65535 초과·현재 허브 포트·7700·정해진 민감 포트는 403 “이 포트는 미리보기로 열 수 없어요”다. 민감 포트 목록은 `lib/preview.mjs`의 `SENSITIVE`이며 DB·원격 관리·Docker·디버거 등의 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 5985, 5986, 6379, 9200, 9222, 9229, 11211, 27017을 포함한다. 아직 등록하지 않은 포트는 403 “개발 서버를 발견하거나 포트를 먼저 골라 주세요”다.

`/preview/5173/some/path?q=1`은 `http://127.0.0.1:5173/some/path?q=1`로 HTTP 요청을 전달한다. 경로와 쿼리, 메서드와 본문을 전달한다. 접두 경로 뒤의 `/`가 없으면 308로 붙인다. 같은 개발 서버로 향하는 리다이렉트는 프록시 경로로 바꾸고 다른 서버로 향하는 리다이렉트는 Location을 제거한다. 요청 대상 호스트는 고정되어 있으며 요청으로 다른 IP를 고를 수 없다. 연결 실패·30초 응답 대기는 502 “개발 서버에 연결하지 못했어요”다.

허브 쿠키·Authorization·Tailscale 사용자 헤더·전달 헤더는 개발 서버로 넘기지 않는다. 개발 서버의 Set-Cookie도 제거한다. 프록시 응답에는 `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-downloads`를 설정해 개발 서버 스크립트를 허브 출처에서 격리한다. 개발 서버가 인증 쿠키나 출처 저장소를 요구하면 작동하지 않을 수 있다.

## 화면 요구 사항

- **터미널 탭**: 오른쪽 또는 아래쪽 패널에 여러 터미널 탭·새로 만들기·셸 선택·현재 폴더·입력줄·중지·닫기를 제공한다. 실행 중에는 입력을 막고 중지 버튼을 활성화한다. 출력은 ANSI 색을 표시하고 stderr를 구분한다. 종료 코드와 준비·실행·종료 상태를 표시한다. 재연결은 위 버퍼·순번 규칙을 따른다.
- **파일 보기 창**: 파일명·전체 경로·수정 시각·크기·인코딩을 표시한다. 코드 하이라이트, 안전한 마크다운 렌더, 이미지, 영상·오디오 컨트롤, PDF 뷰를 제공한다. 목록의 숨김 표시 토글·잘린 목록 안내를 제공한다. 이진·큰 텍스트·알 수 없는 인코딩은 내용 영역에 서버 안내를 표시한다. HTML·SVG는 코드로 보여 주고, HTML 은 머리의 "페이지로 열기"로 `/view/` 페이지를 새 탭에 연다.
- **미리보기 창**: 주소 표시줄·새로고침·발견된 대상·열린 포트 목록을 제공한다. 주소 표시줄 입력에서 로컬 HTTP 포트만 추출해 선택 API를 호출하고, `proxyUrl` 안에서 개발 서버의 경로를 붙인다. 원격 화면은 자기 기기의 localhost를 열지 않고 반드시 허브의 상대 `/preview/<port>/...`를 사용한다. iframe에는 서버 정책과 같은 sandbox 값을 설정하며 `allow-same-origin`을 추가하지 않는다. 외부 주소는 별도 링크로 처리한다. 웹소켓 미지원과 경로·출처 제한 때문에 깨진 화면일 수 있음을 표시한다.

## 실제 확인·한계

기본 PowerShell을 `-NoLogo -NoProfile -Command -`로 파이프 실행한 비교에서는 프롬프트가 나오지 않았고, UTF-8 입력의 한글이 깨졌다. 출력은 약 422ms·929ms에 두 번 도착했으므로 모든 출력이 항상 버퍼링된다고 가정하지 않았다. 본 구현은 `-EncodedCommand`로 UTF-8 셸 제어기를 시작하고, C# 읽기 스레드·비동기 PowerShell runspace를 사용한다. 명령은 UTF-8 base64로 보내고, 출력과 완료 표시를 구분한다. 변수·폴더를 같은 runspace에 유지하며 출력 컬렉션을 계속 비워 장시간 명령의 누적 메모리를 제한한다. 구현에 참고한 공식 규약: [PowerShell 비동기 호출](https://learn.microsoft.com/dotnet/api/system.management.automation.powershell.begininvoke), [명령 추가·실행과 범위](https://learn.microsoft.com/en-us/powershell/scripting/developer/hosting/adding-and-invoking-commands?view=powershell-7.2).

cmd는 코드 페이지를 65001로 바꿔도 UTF-8 파이프의 한글 입력이 사라지고 `More?`에서 멈추는 현상을 실제 확인했다. 입력을 UTF-8 임시 배치 파일로 저장한 뒤 ASCII 파이프 명령으로 호출해 해결한다. 따라서 cmd 입력은 배치 문법을 사용한다. 예를 들어 `for` 변수는 `%i` 대신 `%%i`다. 임시 배치 파일은 터미널을 닫을 때 제거한다.

중지는 Windows 부모 PID 조회로 셸의 자손을 찾아 해당 PID의 트리만 종료한다. 셸 지원용 `conhost.exe`·`OpenConsole.exe`는 중지에서 보존한다. PowerShell 내부 명령은 runspace의 `Stop()`도 호출한다. Git Bash의 MSYS 자손은 POSIX 부모·Windows PID도 조회하고 신호를 먼저 보내서 셸의 자식 대기가 풀리도록 한다. 닫기와 허브 정상 종료·프로세스 종료 훅은 터미널 트리를 정리한다. OS 강제 종료·전원 차단에서는 종료 훅이 실행되지 않을 수 있다.

- PTY가 없으므로 전체 화면 프로그램·커서 제어·콘솔 전용 입력·대화형 인증·터미널 크기 변경은 지원하지 않는다. 입력줄 중심 작업에 맞춘 기능이다. 자체 버퍼링을 하는 외부 프로그램의 출력은 서버가 강제로 즉시 내보낼 수 없다.
- UTF-8을 강제해도 자체 CP949 출력이나 별도 인코딩을 사용하는 외부 프로그램은 깨질 수 있다. 해당 프로그램의 UTF-8 옵션을 사용한다.
- cmd·Bash에서 셸 자체의 긴 내부 루프는 자식 프로세스 종료만으로 중지되지 않을 수 있다. 이 경우 터미널 닫기로 트리 전체를 종료한다. 기본 PowerShell은 내부 명령 중지를 지원한다. 셸에서 완전히 분리·재부모화한 외부 프로세스는 트리 정리 범위에서 벗어날 수 있다.
- 미리보기는 HTTP만 지원하고 WebSocket/HMR은 지원하지 않는다. 루트 절대 경로·서비스 워커·특정 base URL·쿠키·출처 저장소·ES 모듈 CORS를 요구하는 앱은 경로 프록시와 sandbox 때문에 깨질 수 있다. 앱의 base 경로를 `/preview/<port>/`에 맞추거나 허브 PC에서 직접 개발 서버를 연다. HTML·CSS·스크립트의 URL을 임의로 다시 쓰지는 않는다.
- 목록·포트 조회와 셸 시작은 Windows 기본 도구를 사용한다. PowerShell에 필요한 .NET 구성 요소가 없거나 시스템 정책이 동적 컴파일을 막으면 셸 시작이 실패한다. macOS·Linux 터미널과 LISTEN 조회는 현재 지원하지 않는다.

## 시험·운영 반영

새 기능 시험은 `node --test tests/terminal.test.mjs tests/files.test.mjs`, 전체 회귀는 `npm test`다. 파일 시험은 실제 허브를 **7714**로 띄우되 `HUB_PORT`, `HUB_DATA_DIR`, `HUB_RUNS_DIR`, `HUB_CONFIG_FILE`을 모두 임시 경로에 지정하고 `HUB_SKIP_CLI_INSTALL=1`을 사용한다. 실제 AI CLI를 호출하지 않는다. 미리보기 시험의 가짜 HTTP 대상은 루프백 임의 포트다. 시험 프로세스는 해당 PID만 종료한다.

운영 반영은 새 모듈·설정·최소 server 연결을 함께 합친 뒤, 진행 중 작업이 끝났을 때 사용자가 서버를 재시작해야 한다. 다른 담당의 `server.mjs`·`config.json` 변경은 함께 보존한다. 터미널 상한 기본 8을 확인하고, 화면을 새로고침해 API를 연결한다. 이번 작업에서는 운영 허브에 요청을 보내거나 재시작하지 않았다.
