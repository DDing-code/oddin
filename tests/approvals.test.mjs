import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-approvals-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
const { PromptManager, permissionSetting, ToolRecords, AUTO_ANSWER, codexPolicy } = await import('../lib/prompts.mjs');
const { runWorker } = await import('../lib/workers.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
let serial = 0;
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('시험 조건 대기 시간 초과'); await delay(10); } }
function setup(tool, scenario, permission, extra = {}) {
  const root = path.join(temp, 'case-' + ++serial); fs.mkdirSync(root, { recursive: true });
  const capture = path.join(root, 'capture.jsonl');
  const command = `"${process.execPath}" "${path.resolve('tests/fixtures/approval-cli.mjs')}" --tool ${tool} --capture "${capture}" --scenario ${scenario}`;
  const changes = [], events = [], prompts = new PromptManager({ file: path.join(root, 'prompts.json'), config: extra.config, onChange: (p) => changes.push(p) });
  const h = runWorker({ tool, prompt: '시험 요청', cwd: root, runDir: path.join(root, 'run'), toolCfg: { command, shell: true, transport: permission === 'auto' ? 'native' : 'legacy' }, permission, prompts, jobId: 'j1', taskId: 't1', timeoutMs: extra.timeoutMs || 10000, ackTimeoutMs: 1000, onEvent: (e) => events.push(e) });
  return { root, h, prompts, changes, events, rows: () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
async function pending(f, kind) { await until(() => f.prompts.list().some((p) => !kind || p.kind === kind)); return f.prompts.list().find((p) => !kind || p.kind === kind); }
const spec = (kind = 'approval', jobId = 'j1') => ({ jobId, taskId: 't1', tool: 'claude', phase: 'worker', category: 'command', kind, title: '시험 요청', detail: kind === 'question' ? { questions: [{ id: 'q1', question: '질문', multiSelect: false, allowFreeText: true }] } : {} });

test('권한 기본값·잘못된 값·Codex 스키마 값', () => {
  assert.equal(permissionSetting(), 'auto'); assert.equal(permissionSetting({ defaults: { permission: 'ask' } }), 'ask');
  assert.throws(() => permissionSetting({}, 'wrong'), (e) => e.status === 400);
  assert.deepEqual(codexPolicy('ask').sandboxPolicy, { type: 'readOnly' });
  assert.equal(codexPolicy('edits').approvalPolicy, 'on-request'); assert.equal(codexPolicy('plan').sandbox, 'read-only');
});
for (const tool of ['claude', 'codex']) {
  test(`${tool}: 승인 대기·거절·도구 시작 종료 기록·비자동은 네이티브 강제`, async () => {
    const f = setup(tool, 'command', 'ask');
    try {
      const p = await pending(f, 'approval'); assert.equal(p.detail.command, 'echo 승인시험');
      assert.equal(f.h.getState().transport, tool === 'claude' ? 'stream-json' : 'app-server');
      f.prompts.answer(p.id, { action: 'deny', message: '실행하지 마세요' });
      const r = await f.h.promise; assert.equal(r.ok, true); assert.match(r.text, tool === 'claude' ? /deny/ : /decline/);
      const logs = f.events.filter((e) => e.kind === 'tool'); assert.equal(logs.length, 2); assert.equal(logs[0].callId, logs[1].callId);
      assert.equal(logs[0].status, 'running'); assert.equal(logs[1].status, 'error'); assert.ok(logs[1].output.length <= 4000); assert.match(logs[1].output, /끝$/);
    } finally { f.h.cancel(); f.h.close(); }
  });
  test(`${tool}: auto에서도 질문을 호스트에 전달·자유 입력 응답`, async () => {
    const f = setup(tool, 'question', 'auto');
    try {
      const p = await pending(f, 'question'); assert.equal(p.detail.questions[0].allowFreeText, true);
      f.prompts.answer(p.id, { answers: { color: '보라' } });
      assert.match((await f.h.promise).text, /보라/);
      const answer = f.rows().find((r) => tool === 'claude' ? r.type === 'control_response' : r.id?.startsWith?.('request-') && r.result);
      assert.deepEqual(tool === 'claude' ? answer.response.response.updatedInput.answers : answer.result.answers, tool === 'claude' ? { '어떤 색상인가요?': '보라' } : { color: { answers: ['보라'] } });
    } finally { f.h.cancel(); f.h.close(); }
  });
  test(`${tool}: auto 질문 시간 초과 후 지시 전달`, async () => {
    const f = setup(tool, 'question', 'auto', { config: { prompts: { autoAnswerMinutes: 0.001 } } });
    try { const r = await f.h.promise; assert.equal(r.ok, true); assert.match(r.text, /사용자가 답하지 않았습니다/); assert.equal(f.prompts.list({ status: 'all' })[0].status, 'expired'); assert.equal(f.prompts.list({ status: 'all' })[0].answer.automatic, true); }
    finally { f.h.cancel(); f.h.close(); }
  });
  test(`${tool}: 승인 대기는 실행 제한 시간에 포함하지 않음`, async () => {
    const f = setup(tool, 'command', 'ask', { timeoutMs: 700 });
    try { const p = await pending(f); await delay(850); assert.equal(f.prompts.list().length, 1); f.prompts.answer(p.id, { action: 'allow' }); assert.equal((await f.h.promise).ok, true); }
    finally { f.h.cancel(); f.h.close(); }
  });
  test(`${tool}: 작업 중지 시 요청 취소·늦은 답 거절`, async () => {
    const f = setup(tool, 'question', 'ask');
    try { const p = await pending(f); f.h.cancel(); assert.equal((await f.h.promise).cancelled, true); assert.equal(f.prompts.list({ status: 'all' })[0].status, 'cancelled'); assert.throws(() => f.prompts.answer(p.id, { answers: { color: '빨강' } }), (e) => e.status === 409); }
    finally { f.h.close(); }
  });
  test(`${tool}: 이 작업의 같은 종류만 이후 자동 허용`, async () => {
    const f = setup(tool, 'repeat', 'ask');
    try { const p = await pending(f); f.prompts.answer(p.id, { action: 'allow_session' }); assert.equal((await f.h.promise).ok, true); assert.equal(f.prompts.list({ status: 'all' }).length, 1); }
    finally { f.h.cancel(); f.h.close(); }
  });
  test(`${tool}: edits는 파일 변경 자동·ask는 승인`, async () => {
    for (const mode of ['edits', 'ask']) {
      const f = setup(tool, 'file', mode);
      try { if (mode === 'ask') { const p = await pending(f); assert.equal(p.detail.files[0].path, 'a.txt'); f.prompts.answer(p.id, { action: 'allow' }); } assert.equal((await f.h.promise).ok, true); assert.equal(f.prompts.list({ status: 'all' }).length, mode === 'ask' ? 1 : 0); }
      finally { f.h.cancel(); f.h.close(); }
    }
  });
  test(`${tool}: 계획 수정·다시 승인·같은 연결에서 edits 실행`, async () => {
    const f = setup(tool, 'plan', 'plan');
    try {
      const first = await pending(f, 'plan'); assert.match(first.detail.plan, /시험 계획/);
      f.prompts.answer(first.id, { action: 'revise', message: '검증을 추가하세요' });
      const second = await pending(f, 'plan'); assert.notEqual(second.id, first.id); f.prompts.answer(second.id, { action: 'approve' });
      if (tool === 'codex') { const p = await pending(f, 'approval'); f.prompts.answer(p.id, { action: 'allow' }); }
      const r = await f.h.promise; assert.equal(r.ok, true); assert.equal(r.sessionId, '승인시험-스레드');
      const rows = f.rows();
      if (tool === 'claude') assert.equal(rows.find((r) => r.request?.subtype === 'set_permission_mode').request.mode, 'acceptEdits');
      else { const starts = rows.filter((r) => r.method === 'turn/start'); assert.equal(starts.length, 3); assert.equal(starts[0].params.sandboxPolicy.type, 'readOnly'); assert.equal(starts[2].params.sandboxPolicy.type, 'workspaceWrite'); assert.equal(starts[2].params.approvalPolicy, 'on-request'); }
    } finally { f.h.cancel(); f.h.close(); }
  });
  test(`${tool}: 계획 거절은 구현을 실행하지 않음`, async () => {
    const f = setup(tool, 'plan', 'plan');
    try { const p = await pending(f, 'plan'); f.prompts.answer(p.id, { action: 'reject', message: '보류합니다' }); const r = await f.h.promise; assert.equal(r.ok, false); assert.equal(r.error, '보류합니다'); assert.equal(f.prompts.list({ status: 'all' }).length, 1); }
    finally { f.h.cancel(); f.h.close(); }
  });
}

test('응답 검증·중복·작업별 허용 격리·재시작 만료', async () => {
  const file = path.join(temp, 'persist.json'), m = new PromptManager({ file });
  const promise = m.request(spec(), { permission: 'ask' }), id = m.list()[0].id;
  assert.throws(() => m.answer(id, { action: 'wrong' }), (e) => e.status === 400);
  assert.throws(() => m.answer('none', {}), (e) => e.status === 404);
  m.answer(id, { action: 'allow_session' }, { remote: true, login: '사용자' }); assert.equal((await promise).action, 'allow_session'); assert.deepEqual(m.list({ status: 'all' })[0].viewer, { remote: true, login: '사용자' });
  assert.equal((await m.request(spec())).action, 'allow');
  const other = m.request(spec('approval', 'j2'), { permission: 'ask' }); assert.equal(m.list().length, 1);
  const restored = new PromptManager({ file }); assert.equal(restored.list().length, 0); assert.equal(restored.list({ status: 'all' }).at(-1).status, 'expired');
  m.cancel({ jobId: 'j2' }); await other;
  const q = m.request(spec('question'), { permission: 'ask' }), qid = m.list()[0].id;
  assert.throws(() => m.answer(qid, { answers: {} }), (e) => e.status === 400); m.answer(qid, { answers: { q1: '자유 입력' } }); await q;
});

test('추가 권한 승인·거절은 Codex 프로파일로 응답', async () => {
  for (const action of ['allow', 'deny']) {
    const f = setup('codex', 'permission', 'ask');
    try { const p = await pending(f); assert.equal(p.category, 'permission'); f.prompts.answer(p.id, { action }); const r = await f.h.promise; assert.equal(r.ok, true); const answer = f.rows().find((r) => r.id?.startsWith?.('request-') && r.result); assert.deepEqual(answer.result.permissions, action === 'allow' ? { network: { enabled: true } } : {}); }
    finally { f.h.cancel(); f.h.close(); }
  }
});

test('Claude: ExitPlanMode 없이 끝낸 계획도 승인 뒤 실행', async () => {
  const f = setup('claude', 'plan-text', 'plan');
  try { const p = await pending(f, 'plan'); assert.equal(p.detail.plan, '도구 없이 작성한 계획'); f.prompts.answer(p.id, { action: 'approve' }); const a = await pending(f, 'approval'); f.prompts.answer(a.id, { action: 'allow' }); assert.equal((await f.h.promise).ok, true); }
  finally { f.h.cancel(); f.h.close(); }
});
test('Claude 제어 요청 취소와 두 CLI 연결 종료는 대기를 해제', async () => {
  const cancelled = setup('claude', 'cancel', 'ask');
  try { await pending(cancelled); assert.equal((await cancelled.h.promise).ok, true); assert.equal(cancelled.prompts.list({ status: 'all' })[0].status, 'cancelled'); }
  finally { cancelled.h.cancel(); cancelled.h.close(); }
  for (const tool of ['claude', 'codex']) {
    const f = setup(tool, 'disconnect', 'ask');
    try { await pending(f); assert.equal((await f.h.promise).ok, false); assert.equal(f.prompts.list().length, 0); assert.equal(f.prompts.list({ status: 'all' })[0].status, 'expired'); }
    finally { f.h.cancel(); f.h.close(); }
  }
});
test('비공개 질문 답변은 CLI에만 전달하고 저장·SSE에서는 가림', async () => {
  const file = path.join(temp, 'secret.json'), changes = [], m = new PromptManager({ file, onChange: (p) => changes.push(p) });
  const s = spec('question'); s.detail.questions[0].isSecret = true;
  const promise = m.request(s, { permission: 'ask' }); m.answer(m.list()[0].id, { answers: { q1: '시험용비공개값' } });
  assert.equal((await promise).answers.q1[0], '시험용비공개값'); assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /시험용비공개값/); assert.doesNotMatch(JSON.stringify(changes), /시험용비공개값/);
});
test('응답 저장 실패 시 승인하지 않고 같은 요청을 다시 답할 수 있음', async () => {
  const file = path.join(temp, 'save-error.json'), m = new PromptManager({ file });
  const promise = m.request(spec(), { permission: 'ask' }), p = m.list()[0]; m.file = path.join(file, '불가능.json');
  assert.throws(() => m.answer(p.id, { action: 'allow' }), (e) => e.status === 500); assert.equal(m.list().length, 1);
  m.file = file; m.answer(p.id, { action: 'deny' }); assert.equal((await promise).action, 'deny');
  const waiting = m.request(spec(), { permission: 'ask' }); m.file = path.join(file, '불가능.json'); m.cancel({ jobId: 'j1' }); assert.equal((await waiting).action, 'deny'); assert.equal(m.list().length, 0);
});

test('두 CLI: 계획 승인 대기 중 수정 지시는 이전 요청 취소 후 다시 계획', async () => {
  for (const tool of ['claude', 'codex']) {
    const f = setup(tool, tool === 'claude' ? 'plan-text' : 'plan', 'plan');
    try {
      const first = await pending(f, 'plan');
      const receipt = await f.h.intercept({ text: '수정된 계획을 작성하세요', messageId: '수정시험', attachments: [] }); assert.equal(receipt.status, 'delivered');
      const second = await pending(f, 'plan'); assert.notEqual(first.id, second.id); assert.equal(f.prompts.records.get(first.id).status, 'cancelled');
      f.prompts.answer(second.id, { action: 'approve' }); const approval = await pending(f, 'approval'); f.prompts.answer(approval.id, { action: 'allow' }); assert.equal((await f.h.settle()).ok, true);
    } finally { f.h.cancel(); f.h.close(); }
  }
});

test('도구 기록: 같은 ID 시작·끝·앞뒤 출력 보존·다음 턴 식별자 격리', () => {
  const events = [], r = new ToolRecords('codex', (e) => events.push(e));
  r.codex({ id: '0', type: 'mcpToolCall', server: '시험', tool: '도구', arguments: { x: 1 } }, false);
  r.codex({ id: '0', type: 'mcpToolCall', result: '앞' + 'x'.repeat(5000) + '뒤' }, true);
  assert.equal(events[0].callId, events[1].callId); assert.equal(events[1].status, 'done'); assert.equal(events[1].output.length, 4000); assert.ok(events[1].output.startsWith('앞')); assert.ok(events[1].output.endsWith('뒤'));
  r.nextTurn(); r.codex({ id: '0', type: 'commandExecution', command: 'echo' }, false); assert.notEqual(events[0].callId, events[2].callId);
});

test('작업 설정·waiting·작업 중지 연결', async () => {
  const f = setup('claude', 'read', 'auto'); f.h.cancel(); f.h.close();
  const config = { hubDir: path.join(f.root, 'shared'), defaultCwd: f.root, tools: {}, defaults: { permission: 'ask' } };
  const manager = new JobManager(config);
  manager.run = async () => {};
  try {
    const session = manager.createSession({ cwd: f.root });
    const created = manager._create({ goal: '시험', sessionId: session.id }); const j = manager.jobs.get(created.id); assert.equal(j.settings.permission, 'ask'); j.status = 'running'; j.tasks = [{ id: 't1', status: 'running' }];
    const wait = manager.prompts.request({ ...spec(), jobId: j.id }, { permission: 'ask' }); assert.equal(j.waiting, true); assert.equal(j.tasks[0].waiting, true);
    manager.cancel(j.id); await wait; assert.equal(j.waiting, false); assert.equal(j.tasks[0].waiting, false);
  } finally { clearTimeout(manager._saveTimer); }
});

test('격리 서버 7711: API·SSE·원격 viewer 기록·오류 응답', async () => {
  const root = path.join(temp, 'api'); fs.mkdirSync(root, { recursive: true }); const capture = path.join(root, 'capture.jsonl');
  const command = `"${process.execPath}" "${path.resolve('tests/fixtures/approval-cli.mjs')}" --tool codex --capture "${capture}" --scenario command`;
  const config = { host: '127.0.0.1', port: 7711, hubDir: path.join(root, 'shared'), defaultCwd: root, maxParallel: 1, tools: { codex: { enabled: true, command, shell: true, transport: 'native' }, claude: { enabled: false } }, defaults: { permission: 'ask', codex: { model: '', effort: '' }, claude: { model: '', effort: '' } } };
  const cfg = path.join(root, 'config.json'); fs.writeFileSync(cfg, JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'remote.json'), JSON.stringify({ version: 1, provider: 'tailscale', enabled: true, hosts: ['approval-test.ts.net'], logins: ['owner@example.com'], url: 'https://approval-test.ts.net/', target: 'http://127.0.0.1:7711' }));
  const server = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), windowsHide: true, env: { ...process.env, HUB_PORT: '7711', HUB_DATA_DIR: path.join(root, 'data'), HUB_RUNS_DIR: path.join(root, 'runs'), HUB_CONFIG_FILE: cfg, HUB_SKIP_CLI_INSTALL: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stdout.on('data', (s) => { logs += s; }); server.stderr.on('data', (s) => { logs += s; });
  const url = 'http://127.0.0.1:7711'; const abort = new AbortController(); let stream;
  try {
    await until(() => logs.includes('7711')); const response = await fetch(url + '/api/events', { signal: abort.signal });
    const options = await (await fetch(url + '/api/options')).json(); assert.equal(options.permission.default, 'ask'); assert.deepEqual(options.permission.values, ['auto', 'edits', 'ask', 'plan']);
    let sse = ''; stream = (async () => { for await (const chunk of response.body) sse += new TextDecoder().decode(chunk); })().catch(() => {});
    const jobResponse = await fetch(url + '/api/jobs', { method: 'POST', body: JSON.stringify({ goal: 'echo 승인시험', mode: 'codex', settings: { permission: 'ask' } }) }); assert.equal(jobResponse.status, 201);
    let list;
    for (let i = 0; i < 100; i++) { list = await (await fetch(url + '/api/prompts')).json(); if (list.length) break; await delay(50); }
    assert.equal(list.length, 1); const id = list[0].id;
    const remoteHeaders = { 'x-forwarded-host': 'approval-test.ts.net', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'owner@example.com', origin: 'https://approval-test.ts.net' };
    assert.equal((await fetch(url + '/api/prompts/' + id + '/answer', { method: 'POST', headers: { ...remoteHeaders, 'tailscale-user-login': 'other@example.com' }, body: JSON.stringify({ action: 'allow' }) })).status, 403);
    assert.equal((await fetch(url + '/api/prompts/' + id + '/answer', { method: 'POST', body: JSON.stringify({ action: 'wrong' }) })).status, 400);
    const answered = await fetch(url + '/api/prompts/' + id + '/answer', { method: 'POST', headers: remoteHeaders, body: JSON.stringify({ action: 'allow' }) }); assert.equal(answered.status, 200); const body = await answered.json(); assert.equal(body.status, 'answered'); assert.deepEqual(body.viewer, { remote: true, login: 'owner@example.com' });
    assert.equal((await fetch(url + '/api/prompts/' + id + '/answer', { method: 'POST', body: JSON.stringify({ action: 'allow' }) })).status, 409);
    await until(() => sse.includes('"type":"prompt"') && sse.includes('"status":"answered"') && sse.includes('"status":"done"'));
    assert.equal((await (await fetch(url + '/api/prompts')).json()).length, 0); assert.equal((await (await fetch(url + '/api/prompts?status=all')).json()).length, 1);
  } finally { abort.abort(); await stream; server.kill(); await new Promise((r) => server.exitCode !== null ? r() : server.once('close', r)); }
});
