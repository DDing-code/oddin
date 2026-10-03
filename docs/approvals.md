# 실행 중 승인·질문·계획과 도구 기록

이 문서는 서버와 화면의 연결 규약이다. `public/` 구현과 독립적으로 사용할 수 있다. Node 22 기본 모듈만 사용한다.

## 작업 설정

`POST /api/jobs`의 `settings.permission`으로 작업마다 선택한다. 빠른 실행·일반 실행·재시도·목표 모드 워커에 동일하게 적용한다. 계획 생성 플래너·라우팅·보고·목표 판정은 기존 자동 실행을 유지한다.

```json
{
  "goal": "파일을 수정하고 검증해주세요",
  "mode": "codex",
  "settings": {
    "permission": "ask",
    "codex": { "model": "auto", "effort": "auto" }
  }
}
```

| 값 | 허브 동작 | Claude | Codex |
|---|---|---|---|
| `auto` | 실행 자동, 질문만 사용자에게 전달 | `bypassPermissions` + 호스트 질문 | `never` + `danger-full-access` |
| `edits` | 파일 변경 자동, CLI가 요청한 명령·네트워크·권한 승인 대기 | `acceptEdits` | `on-request` + `workspace-write` |
| `ask` | 파일 변경·명령 승인 대기, 읽기·검색 자동 | `manual` | `untrusted` + `read-only` |
| `plan` | 계획만 작성 → 사용자 승인 → `edits` 실행 | `plan` → `acceptEdits` | 읽기 전용 계획 턴 → 같은 스레드의 실행 턴 |

기본값은 `config.json`의 `defaults.permission`, 누락 시 `auto`다. 잘못된 값은 400 오류로 거절한다. `ask`의 Codex 샌드박스를 읽기 전용으로 둔 이유는 `workspace-write`에서 작업 폴더의 파일 변경이 승인 콜백 없이 실행되기 때문이다. 실제 `apply_patch` 실험에서 읽기 전용 조합으로 파일 변경 승인을 확인했다.

**CLI가 요청한 승인을 받는 기능이다.** Codex `edits`는 지정된 `on-request` 규약상 모든 명령을 묻지 않는다. 작업 폴더 안에서 샌드박스로 실행 가능한 명령은 자동 실행되고, 샌드박스 밖 실행·네트워크 등 추가 권한이 필요할 때 묻는다. Claude도 CLI의 기존 허용 규칙과 자체 읽기·검색 판정을 따른다. 모든 쓰기를 검토하려면 `ask`를 선택한다.

`auto` 질문은 `prompts.autoAnswerMinutes`(기본 20분)가 지나면 다음 문장을 CLI에 답으로 전달한다.

> 사용자가 답하지 않았습니다. 가장 합리적인 선택으로 진행하고 보고서에 그 선택을 적으세요

이때 상태는 `expired`, `answer.automatic`은 `true`다. 다른 방식의 질문·승인·계획은 자동 답변하지 않는다. 승인 대기 시간은 워커의 실행 제한 시간에서 제외한다. `allow_session`은 **같은 작업·같은 CLI·같은 종류**(`command`, `file`, `network`, `permission`)의 이후 요청에만 적용한다. 다른 작업에는 적용되지 않으며 작업 종료·중지·허브 재시작 시 해제된다. CLI의 영구 허용 규칙이나 전체 세션 허용으로 바꾸지 않는다.

## 조회·응답 API

모든 경로는 기존 원격 접속 게이트·Origin 검사를 그대로 따른다. 허용된 Tailscale 화면에서도 답할 수 있다. `req.hubViewer`는 응답 기록의 `viewer: { remote, login }`에만 쓰며, 로컬 접속 여부로 승인 응답을 막지 않는다.

`GET /api/prompts`는 대기 중인 요청의 **배열**을 반환한다. 화면 최초 접속·SSE 재연결 때 다시 조회한다.

* `?jobId=<작업 ID>`: 해당 작업만 조회
* `?status=all`: 답변·만료·취소를 포함한 전체 이력 조회
* `/api/status`의 `capabilities.prompts`, `capabilities.toolRecords`: 이 서버 기능 지원 여부
* `/api/options`의 `permission: { default, values, autoAnswerMinutes }`: 화면의 초기 선택값·허용 방식·자동 응답 시간. 저장된 사용자 선택이 없으면 `default`를 사용한다.

```json
[
  {
    "id": "요청 UUID",
    "jobId": "작업 ID",
    "taskId": "t1",
    "phase": "worker",
    "tool": "codex",
    "kind": "approval",
    "category": "command",
    "title": "명령 실행을 승인해주세요",
    "detail": { "command": "npm test", "cwd": "F:/프로젝트", "reason": "검증", "files": [] },
    "status": "pending",
    "createdAt": "2026-10-03T12:00:00.000Z",
    "answeredAt": null,
    "answer": null
  }
]
```

`detail`은 종류에 따라 다음 정보를 제공한다. 없는 필드는 생략하거나 null이다.

* 승인: `command`, `cwd`, `reason`, `files: [{ path, diff }]`, `permissions`, `grantRoot`, Claude의 `input`
* 질문: `questions: [{ id, question, header, options: [{ label, description }], multiSelect, allowFreeText, isSecret }]`, Codex의 `isBlocking`
* 계획: `plan`(마크다운 본문)

`POST /api/prompts/:id/answer`는 응답 객체를 본문에 바로 보내며, 성공 시 200과 갱신된 요청 객체를 반환한다.

```json
{ "action": "allow" }
```

```json
{ "action": "allow_session" }
```

```json
{ "action": "deny", "message": "외부 업로드는 하지 마세요" }
```

```json
{ "answers": { "color": ["파랑"], "features": ["검색", "필터"], "memo": ["자유 입력"] } }
```

질문 키는 `questions[].id`다. 값은 문자열 배열 또는 단일 문자열이며, 서버가 배열로 정규화한다. 모든 문항에 답해야 한다. `multiSelect: false`이면 값은 한 개다. 자유 입력 허용 여부는 문항의 `allowFreeText`로 판단한다. Claude에는 자유 입력을 항상 허용한다. Codex는 `isOther: true`이거나 선택지가 없을 때 허용한다. `isSecret: true` 답변은 CLI에 전달하지만 저장 파일·API·SSE에는 `[비공개]`로 가린다.

```json
{ "action": "approve" }
```

```json
{ "action": "revise", "message": "마이그레이션 검증을 계획에 추가해주세요" }
```

```json
{ "action": "reject", "message": "이번 작업은 보류합니다" }
```

`revise`에는 수정 의견이 필요하다. `reject`는 실행하지 않고 해당 워커를 실패로 종료한다. `revise`는 같은 CLI 연결에서 계획을 다시 작성하고 새 요청 ID로 다시 묻는다. Claude가 `ExitPlanMode` 없이 계획 본문만 반환해도 허브가 승인을 받기 전에는 구현 턴으로 넘어가지 않는다.

| HTTP | 오류 문장 |
|---|---|
| 400 | `권한 방식은 auto, edits, ask, plan 중 하나여야 합니다` |
| 400 | `응답 형식이 올바르지 않습니다` |
| 400 | `모든 문항에 답해주세요` |
| 400 | `제시된 선택지에서 골라주세요` |
| 400 | `계획 수정 의견을 적어주세요` |
| 404 | `요청을 찾을 수 없습니다` |
| 409 | `이미 처리되었거나 만료된 요청입니다` |
| 500 | `요청을 저장하지 못했습니다: …`, `응답을 저장하지 못했습니다: …` |

오류 본문은 기존 규약인 `{ "error": "오류 문장" }`이다. 저장 실패 시 CLI에 허용을 보내지 않는다. 사용자가 여러 화면에서 동시에 답하면 먼저 저장된 한 응답만 채택한다.

## SSE·작업 상태와 화면 요구 사항

기존 `GET /api/events`에서 생성·답변·만료·취소마다 다음 이벤트를 보낸다.

```json
{ "type": "prompt", "prompt": { "id": "요청 UUID", "jobId": "작업 ID", "kind": "approval", "status": "pending" } }
```

실제 `prompt`에는 조회 API와 같은 전체 객체가 들어간다. 이벤트는 `prompt.id`로 덮어쓴다. 작업·작업 항목의 상태 문자열은 기존 `running`을 유지하고, 별도 `waiting: true`를 사용한다. 여러 요청 중 하나를 답해도 다른 요청이 남아 있으면 대기 표시를 유지한다. `job` SSE 이벤트에도 이 필드가 포함된다.

화면 담당은 다음 카드와 조작을 구현하면 된다.

1. 작업 입력의 권한 선택: 자동 / 편집 자동 / 항상 확인 / 계획 먼저. `settings.permission`에 선택값을 보낸다.
2. 승인 카드: 담당 AI, 작업 항목, 명령·폴더·파일 차이·이유·추가 권한을 펼쳐 보여주고, 한 번 허용 / 이 작업에서 같은 종류 허용 / 거절과 사유 입력을 제공한다.
3. 질문 카드: 여러 문항을 각각 표시한다. 문항 ID로 답을 모으고 단일·다중 선택과 자유 입력, 비공개 입력을 구분한다. `expiresAt`이 있으면 자동 응답까지 남은 시간을 표시한다. 선택된 기본값을 사용자의 제출로 취급하지 않는다.
4. 계획 카드: 마크다운 계획을 표시하고 승인 / 수정 의견 보내기 / 거절을 제공한다. 새 계획은 새 ID의 카드로 표시한다.
5. `pending`만 응답 가능하다. 제출 중 버튼을 잠그고, 409이면 목록을 다시 조회한다. `answered`, `expired`, `cancelled` 카드는 조작을 끄고 처리 결과를 표시한다. 자동 응답 만료는 “답변 시간이 지나 AI가 판단해서 진행했어요”, 재시작 만료는 “서버가 다시 시작되어 요청이 만료되었어요”로 구분한다.
6. 작업·항목에 `waiting`이 있으면 “승인 대기” 또는 요청 종류에 맞는 “답변 대기”를 표시한다. 기존 중지 버튼을 그대로 사용한다.

저장소는 `HUB_DATA_DIR/prompts.json`이다. 서버 재시작 때 대기 중이던 요청은 `expired`로 바꾸고 작업의 `waiting`을 초기화한다. 이전 CLI를 자동 재개하거나 이전 요청에 다시 답하지 않는다. 중지 시 `cancelled`, CLI 연결 종료 시 `expired`로 대기를 풀며 늦은 응답은 409다. 실행 중 수정 지시는 이전 대기를 취소하고 기존 네이티브 전달 흐름을 따른다.

## Claude 실험·연결 규약

2026-10-03 설치된 CLI의 `--help`에서 `--permission-prompts host`와 `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`을 확인했다. 임시 폴더에서 `claude-haiku-4-5-20251001`로 확인했다. 호스트 통신에는 다음 인자를 함께 쓴다.

```text
-p --input-format stream-json --output-format stream-json
--replay-user-messages --verbose
--permission-prompts host --permission-prompt-tool stdio
--permission-mode <방식>
```

첫 사용자 메시지 전에 `initialize` 제어 요청을 보내고 성공 응답을 기다린다. 최초 실험에서 `--permission-prompt-tool stdio` 없이 질문 도구가 노출되지 않았고, 이 인자와 제어 초기화를 적용한 뒤 `AskUserQuestion`과 `ExitPlanMode`를 확인했다. 초기화 응답에는 계정 정보가 포함될 수 있어 문서에는 계정 정보를 기록하지 않는다.

```json
{ "type": "control_request", "request_id": "호스트 ID", "request": { "subtype": "initialize" } }
```

실제 Write 요청에서 확인한 필드다. 선택적 `display_name`, `description`, `permission_suggestions`도 올 수 있다.

```json
{
  "type": "control_request",
  "request_id": "CLI 요청 ID",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Write",
    "input": { "file_path": "<임시폴더>/a.txt", "content": "빨강" },
    "tool_use_id": "toolu_…"
  }
}
```

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "CLI 요청 ID",
    "response": { "behavior": "allow", "updatedInput": { "file_path": "<임시폴더>/a.txt", "content": "빨강" } }
  }
}
```

거절은 마지막 `response`를 `{ "behavior": "deny", "message": "거절 사유" }`로 바꾼다. 원래 `request_id`를 반드시 돌려준다.

질문 요청의 `tool_name`은 `AskUserQuestion`, `input.questions`는 문항 배열, `requires_user_interaction`은 true였다. **`bypassPermissions`에서도 이 요청이 호스트로 왔다.** `updatedInput`에 원래 입력을 보존하고 다음 `answers`를 더하면 실제 파일에 선택한 값이 기록되었다.

```json
{
  "behavior": "allow",
  "updatedInput": {
    "questions": [{ "question": "어떤 색상을 선택하시겠습니까?", "header": "색상 선택", "options": [{ "label": "빨강", "description": "밝은 색" }, { "label": "파랑", "description": "차분한 색" }], "multiSelect": false }],
    "answers": { "어떤 색상을 선택하시겠습니까?": "빨강" }
  }
}
```

Claude 응답 키는 문항 ID가 아니라 **질문 문장**이다. 허브가 API의 문항 ID를 이 형식으로 변환한다. 다중 선택은 선택값을 `, `로 이어 전달한다.

계획 요청의 도구는 `ExitPlanMode`, 입력에는 `plan` 본문과 `planFilePath`가 있었다. 본문을 우선 사용하고, 본문이 없으면 전달된 `.md` 계획 파일 또는 직전 모델 본문을 사용한다. 승인 때 다음 제어 요청의 성공을 기다린 뒤 `ExitPlanMode`에 allow를 보낸다. 실제 CLI에서 성공 ACK와 이후 파일 생성을 확인했다.

```json
{ "type": "control_request", "request_id": "호스트 ID", "request": { "subtype": "set_permission_mode", "mode": "acceptEdits" } }
```

계획 수정은 deny와 수정 의견을 돌려주며, 최종 텍스트만 끝내는 경우에도 다시 계획 승인으로 연결한다. CLI의 `control_cancel_request`는 해당 요청을 `cancelled`로 처리한다.

레거시 일회성 실행은 `auto`일 때만 유지할 수 있다. **명시적으로 `tools.<tool>.transport: "legacy"`를 고른 auto 실행에는 중간 질문 연결이 없다.** 일반 허브 워커는 네이티브를 사용하며, `auto` 이외 방식은 설정이 legacy여도 네이티브를 강제한다. 승인 연결을 쓰는 네이티브 실행은 실패 시 권한을 우회하는 레거시로 전환하지 않는다.

## Codex 스키마·실험·연결 규약

기준 스키마는 운영 폴더의 `workspace/codex-protocol/`에 있는 `ServerRequest.json`, 각 Params/Response 파일과 합본 스키마다. 해당 폴더는 읽기만 했다. 실제 선택된 앱 CLI는 `codex-cli 0.160.0`이었다. 임시 폴더에서 `gpt-6.1-sol`·high로 PowerShell 쓰기 명령 승인, `apply_patch` 파일 변경 승인, 읽기 전용 계획 턴을 확인했다. 두 쓰기 요청은 거절했고 파일을 만들지 않았다. 계획도 사용자 거절로 구현을 실행하지 않았다.

```json
{ "id": 0, "method": "item/commandExecution/requestApproval", "params": { "kind": "command", "threadId": "스레드 ID", "turnId": "턴 ID", "itemId": "exec-…", "startedAtMs": 1791031086730, "environmentId": "local", "command": "powershell.exe -Command Set-Content …", "cwd": "<임시폴더>", "commandActions": [{ "type": "unknown", "command": "Set-Content …" }] } }
```

```json
{ "id": 0, "result": { "decision": "accept" } }
```

거절은 `decision: "decline"`이다. 스키마는 `acceptForSession`, `cancel`, 정책 수정 객체도 허용하지만 허브는 자체 작업 범위 캐시와 `accept`/`decline`만 사용한다. 일부 실제 요청의 `availableDecisions`에 `decline`이 생략되어 있었지만 스키마상의 `decline` 응답을 CLI가 처리했고 모델이 승인 거절로 보고했다. 거절 사유는 응답 스키마에 필드가 없어 별도 `turn/steer` 텍스트로 추가 전달한다. 추가 전달 실패는 로그에 남기며 승인 거절 자체는 유지한다.

파일 변경 요청은 다음 형태였다. 경로·차이는 같은 `itemId`의 `item/started` 이벤트에서 가져온다.

```json
{ "id": 0, "method": "item/fileChange/requestApproval", "params": { "threadId": "스레드 ID", "turnId": "턴 ID", "itemId": "exec-…", "startedAtMs": 1791031238010, "reason": null, "grantRoot": null } }
```

질문은 스키마와 가짜 CLI로 검증했다. 실제 모델이 질문 도구를 선택하는지는 별도 실제 실험을 하지 않았다. 서버 요청이 오면 방식과 관계없이 사용자에게 전달한다.

```json
{ "id": "질문 요청 ID", "method": "item/tool/requestUserInput", "params": { "threadId": "스레드 ID", "turnId": "턴 ID", "itemId": "항목 ID", "isBlocking": true, "questions": [{ "id": "color", "header": "색상", "question": "어떤 색상인가요?", "options": [{ "label": "빨강", "description": "밝은 색" }], "isOther": true }] } }
```

```json
{ "id": "질문 요청 ID", "result": { "answers": { "color": { "answers": ["빨강"] } } } }
```

추가 권한 요청은 `item/permissions/requestApproval`이다. 허용은 요청한 프로파일을 `{ "permissions": <요청 프로파일>, "scope": "turn" }`로, 거절은 `{ "permissions": {}, "scope": "turn" }`로 돌려준다. 작업 허용 캐시는 허브에만 남기므로 CLI의 session 권한을 확대하지 않는다. 알 수 없는 서버 요청에는 JSON-RPC -32601, 스레드가 다른 요청에는 -32602를 반환한다. MCP elicitation·클라이언트 동적 도구 실행은 이 기능에 포함하지 않는다.

계획은 `thread/start`에서 `sandbox: "read-only"`로 시작한다. 계획이 완료되면 허브가 계획 카드 응답을 기다린다. 승인 후 같은 `threadId`로 다음 `turn/start`에 아래 값을 전달한다. 계획 수정도 읽기 전용의 새 턴이다.

```json
{ "threadId": "같은 스레드 ID", "approvalPolicy": "on-request", "sandboxPolicy": { "type": "workspaceWrite", "networkAccess": false }, "input": [{ "type": "text", "text": "승인된 계획을 실행하세요.", "text_elements": [] }] }
```

## 도구 호출 카드 기록

기존 `runs/<job>/<task>.log.jsonl`, `GET /api/jobs/:id/log/:key`, SSE `log`에 필드를 더한다. 기존 `text`, `name`, `detail`, `at`는 유지한다. `callId`는 불투명 식별자로 취급하며 같은 호출의 시작·끝을 연결한다. `cliCallId`는 원본 CLI ID다. 턴·재시작마다 별도 접두어를 붙여 Codex의 반복되는 항목 ID가 이전 호출과 섞이지 않게 한다.

```json
{
  "type": "log",
  "jobId": "작업 ID",
  "taskId": "t1",
  "entry": {
    "at": "2026-10-03T12:00:00.000Z",
    "kind": "tool",
    "callId": "호출 범위 UUID/exec-…",
    "cliCallId": "exec-…",
    "tool": "codex",
    "name": "Bash",
    "input": { "command": "npm test", "cwd": "F:/프로젝트" },
    "status": "running",
    "output": "",
    "startedAt": "2026-10-03T12:00:00.000Z",
    "endedAt": null,
    "text": "Bash",
    "detail": "npm test"
  }
}
```

종료 이벤트는 같은 `callId`로 `status: "done"|"error"`, `output`, `endedAt`을 채운 전체 객체다. 화면은 `(jobId, taskId, callId)`로 카드를 갱신하고 로그 행을 두 장의 카드로 만들지 않는다. 실행 종료·중지 때 결과를 못 받은 호출은 `error`로 닫는다. 도구 호출 수는 시작 이벤트만 센다.

`output`은 최대 4000자이며 길면 `… 중간 생략 …` 표시와 앞·뒤를 보존한다. 입력 문자열은 필드별 1000자, `detail`은 300자, 파일 차이 내용은 항목별 4000자까지 보낸다. Claude `tool_use`/`tool_result`, Codex `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `dynamicToolCall`의 시작·종료를 처리하며 레거시 snake_case 항목도 정규화한다.

```json
{ "diff": [{ "path": "a.txt", "before": "이전 내용", "after": "새 내용" }] }
```

```json
{ "diff": [{ "path": "a.txt", "unified": "@@ …\n-이전\n+새 내용" }] }
```

Claude Write는 `after`, Edit는 입력의 이전·새 문자열을 보낸다. 이는 도구 입력에 있는 변경 조각이며 파일 전체의 전후 스냅샷은 아니다. Codex는 CLI가 보내준 변경 텍스트를 `unified`에 보존하며 추가 파일 내용은 완전한 unified diff가 아닐 수 있다. 화면은 필드가 없는 호출에도 동작해야 한다. 원본 CLI 이벤트는 각 `attempt-*/events.jsonl`에 별도로 남는다.

## 시험·운영 반영

* `node --test tests/approvals.test.mjs`: 가짜 두 CLI, 승인·질문·계획·시간 초과·중지·연결 종료·저장 실패·도구 기록과 HTTP/SSE.
* `npm test`: 기존 전체 회귀 시험 포함.
* HTTP 시험은 포트 7711과 임시 `HUB_DATA_DIR`, `HUB_RUNS_DIR`, `HUB_CONFIG_FILE`, `HUB_SKIP_CLI_INSTALL=1`을 사용한다.

서버를 병합한 뒤 사용자가 유휴 상태에서 재시작해야 새 API가 적용된다. 운영 7700 서버는 이번 작업에서 요청·재시작·종료하지 않았다. 기존 작업은 생성 당시 설정을 유지하며 저장된 대기 요청은 재시작 시 만료된다. 화면 담당의 카드·권한 선택 구현은 별도로 연결해야 한다. 기존 SSE 소비자는 도구 이벤트가 시작·종료 두 번 온다는 점을 고려하고 `callId`로 합친다.
