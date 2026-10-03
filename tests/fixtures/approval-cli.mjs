// 승인 전에는 결과를 만들지 않는 네이티브 CLI 프로토콜 시험기.
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2), value = (k) => args[args.indexOf(k) + 1];
const tool = value('--tool'), capture = value('--capture'), scenario = value('--scenario') || 'command';
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\n');
const note = (x) => fs.appendFileSync(capture, JSON.stringify(x) + '\n');
if (args.includes('--version')) { console.log('시험 CLI 1'); process.exit(0); }
if (args.includes('status')) { console.log(tool === 'claude' ? JSON.stringify({ loggedIn: true }) : 'Logged in'); process.exit(0); }
note({ args });
let turn = 0, count = 0, pending, sid = '승인시험-스레드', tid, phase, permissionMode = value('--permission-mode');
const questions = [{ id: 'color', header: '색상', question: '어떤 색상인가요?', options: [{ label: '빨강', description: '밝은 색' }, { label: '파랑', description: '차분한 색' }], multiSelect: false, isOther: true }];
const item = () => ({ id: 'call-' + count, type: 'commandExecution', command: 'echo 승인시험', cwd: process.cwd(), status: 'inProgress' });
function finish(text = '시험 완료') {
  if (tool === 'claude') emit({ type: 'result', session_id: sid, result: text, is_error: false });
  else { emit({ method: 'item/completed', params: { threadId: sid, item: { type: 'agentMessage', text } } }); emit({ method: 'turn/completed', params: { threadId: sid, turn: { id: tid, status: 'completed' } } }); }
}
function request(kind = scenario) {
  count++; const id = 'request-' + count;
  if (tool === 'claude') {
    const name = kind === 'question' ? 'AskUserQuestion' : kind === 'plan' ? 'ExitPlanMode' : kind === 'file' ? 'Write' : kind === 'read' ? 'Read' : 'Bash';
    const input = kind === 'question' ? { questions } : kind === 'plan' ? { plan: '시험 계획 ' + count } : kind === 'file' ? { file_path: 'a.txt', content: '빨강' } : { command: 'echo 승인시험' };
    pending = { id, kind, call: 'call-' + count };
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: pending.call, name, input }] } });
    emit({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: pending.call } });
  } else {
    const method = kind === 'question' ? 'item/tool/requestUserInput' : kind === 'file' ? 'item/fileChange/requestApproval' : kind === 'permission' ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval';
    pending = { id, kind, item: kind === 'file' ? { id: 'call-' + count, type: 'fileChange', changes: [{ path: 'a.txt', diff: '+빨강' }] } : item() };
    emit({ method: 'item/started', params: { threadId: sid, item: pending.item } });
    emit({ id, method, params: { threadId: sid, turnId: tid, itemId: pending.item.id, cwd: process.cwd(), command: 'echo 승인시험', startedAtMs: Date.now(), ...(kind === 'question' ? { questions, isBlocking: true } : {}), ...(kind === 'permission' ? { permissions: { network: { enabled: true } } } : {}) } });
  }
  if (scenario === 'disconnect') setTimeout(() => process.exit(1), 80);
  if (scenario === 'cancel' && tool === 'claude') setTimeout(() => { emit({ type: 'control_cancel_request', request_id: pending.id }); finish('요청 취소'); }, 80);
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const x = JSON.parse(line); note(x);
  if (tool === 'claude') {
    if (x.type === 'control_request') { if (x.request.subtype === 'set_permission_mode') permissionMode = x.request.mode; emit({ type: 'control_response', response: { request_id: x.request_id, subtype: 'success', response: {} } }); }
    else if (x.type === 'user') {
      emit({ type: 'system', subtype: 'init', session_id: sid }); emit(x); if (scenario === 'plan-text' && permissionMode === 'plan') finish('도구 없이 작성한 계획'); else request(scenario === 'plan-text' ? 'command' : scenario);
    } else if (x.type === 'control_response') {
      const r = x.response.response;
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: pending.call, is_error: r.behavior !== 'allow', content: JSON.stringify(r) + 'A'.repeat(6000) + '끝' }] } });
      if (pending.kind === 'plan' && r.behavior === 'deny' && r.message.includes('수정')) request('plan');
      else if (scenario === 'repeat' && count < 2) request('command');
      else finish(JSON.stringify(r));
    }
  } else {
    const p = x.params || {};
    if (x.method === 'initialize') emit({ id: x.id, result: {} });
    else if (x.method === 'turn/steer') emit({ id: x.id, result: { turnId: tid } });
    else if (x.method === 'thread/start' || x.method === 'thread/resume') emit({ id: x.id, result: { thread: { id: sid } } });
    else if (x.method === 'turn/start') {
      tid = 'turn-' + ++turn; phase = p.sandboxPolicy?.type;
      emit({ id: x.id, result: { turn: { id: tid } } }); emit({ method: 'turn/started', params: { threadId: sid, turn: { id: tid } } });
      if (phase === 'readOnly' && scenario === 'plan') finish('시험 계획 ' + turn); else request(scenario === 'plan' ? 'command' : scenario);
    } else if (x.id === pending?.id && x.result) {
      emit({ method: 'item/completed', params: { threadId: sid, item: { ...pending.item, status: x.result.decision === 'decline' ? 'declined' : 'completed', aggregatedOutput: '앞' + 'A'.repeat(6000) + '끝', exitCode: 0 } } });
      if (scenario === 'repeat' && count < 2) request('command'); else finish(JSON.stringify(x.result));
    }
  }
}
