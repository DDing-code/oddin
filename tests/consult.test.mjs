// 작업 도중 다른 AI에게 묻기(lib/consult.mjs · scripts/oddin-ask-mcp.mjs). 실제 모델 호출 없음
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-consult-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} });

const { JobManager } = await import('../lib/jobs.mjs');
const { Consults, consultMode, buildConsultPrompt } = await import('../lib/consult.mjs');
const { buildWorkerPrompt, consultRule } = await import('../lib/planner.mjs');
const { mcpServers, codexMcpArgs, claudeMcpFile } = await import('../lib/native-workers.mjs');
const { Checkpoints } = await import('../lib/checkpoints.mjs');

const fixture = fileURLToPath(new URL('./fixtures/intercept-cli.mjs', import.meta.url));
const askScript = fileURLToPath(new URL('../scripts/oddin-ask-mcp.mjs', import.meta.url));
const cwd = fs.mkdtempSync(path.join(temp, 'work-'));
const now = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let serial = 0;

/** 가짜 작업자: 넘겨받은 설정을 적어 두고, delay 뒤 답한다(취소하면 바로 끝) */
function fakeWorker(calls, { delay = 20, fail = null } = {}) {
  return (opts) => {
    calls.push(opts);
    let done, timer;
    const promise = new Promise((r) => { done = r; });
    const finish = (res) => { clearTimeout(timer); if (res.ok) { fs.mkdirSync(opts.runDir, { recursive: true }); fs.writeFileSync(path.join(opts.runDir, 'result.md'), res.text); } done(res); };
    timer = setTimeout(() => {
      opts.onEvent?.({ kind: 'init', sessionId: `S-${calls.length}`, model: 'mock-model' });
      finish(fail ? { ok: false, error: fail } : { ok: true, text: `의견 ${calls.length}: 그렇게 하면 됩니다`, sessionId: `S-${calls.length}` });
    }, delay);
    return { promise, cancel() { finish({ ok: false, cancelled: true, error: '사용자 중지' }); }, close() {} };
  };
}
function setup({ consult = {}, settings = {}, assignee = 'claude', deps = {} } = {}) {
  const m = new JobManager({ defaultCwd: cwd, hubDir: path.join(temp, 'shared'), tools: { claude: { enabled: true }, codex: { enabled: true } }, defaults: {}, maxParallel: 1, consult });
  const id = `j${++serial}`, calls = [], events = [];
  const task = { id: 't1', title: '로그인 고치기', assignee, status: 'running', prompt: '토큰 갱신 버그를 고친다', dependsOn: [] };
  const job = { id, sessionId: 's1', title: id, goal: '로그인이 가끔 풀리는 문제를 고쳐 줘', cwd, mode: 'auto', status: 'running', createdAt: now, tasks: [task], notes: [], intercepts: [], attachments: [], runDir: path.join(temp, 'runs', id), settings: { claude: { model: '', effort: '' }, codex: { model: '', effort: '' }, consult: 'ask', ...settings } };
  fs.mkdirSync(job.runDir, { recursive: true });
  m.jobs.set(id, job);
  m.on('event', (ev) => { if (ev.type === 'log') events.push(ev.entry); });
  m.consults = new Consults(m, { runWorker: fakeWorker(calls), toolStatus: async () => ({ claude: { ok: true }, codex: { ok: true } }), usageStatus: async () => null, changes: async () => null, ...deps });
  return { m, job, task, calls, events, owner: `${id}/t1` };
}

test('방식 고르기: 요청 설정이 먼저, 없으면 설정 파일 기본값, 꺼 두면 늘 꺼짐', () => {
  assert.equal(consultMode({}, {}), 'off');
  assert.equal(consultMode({}, { consult: 'ask' }), 'ask');
  assert.equal(consultMode({ consult: { default: 'committee' } }, {}), 'committee');
  assert.equal(consultMode({ consult: { default: 'committee' } }, { consult: 'off' }), 'off');
  assert.equal(consultMode({ consult: { enabled: false } }, { consult: 'ask' }), 'off');
  assert.equal(consultMode({}, { consult: '아무거나' }), 'off');
});

test('작업 지시문: 켰을 때만 규칙이 들어가고, 꼭 받기는 고치기 전 분석·끝내기 전 검토를 시킨다', () => {
  const job = { id: 'j1', cwd: 'D:/x', goal: '버그 수정', input: '버그 수정', tasks: [], mode: 'auto', settings: {}, intercepts: [] };
  const task = { id: 't1', assignee: 'claude', title: '수정', prompt: '고쳐', dependsOn: [] };
  const base = { job, task, depResults: [], siblings: [task], hubDir: 'H', memoryCtx: '' };
  assert.doesNotMatch(buildWorkerPrompt(base), /ask_other_ai/);
  const ask = buildWorkerPrompt({ ...base, consult: { mode: 'ask', other: 'Codex', max: 3 } });
  assert.match(ask, /\[다른 AI 의견\][^\n]*Codex에게 두 번째 의견/); assert.match(ask, /최대 3번/); assert.match(ask, /쓰지 말 때/);
  const both = buildWorkerPrompt({ ...base, consult: { mode: 'committee', other: 'Codex', max: 4 } });
  assert.match(both, /\[두 AI가 함께 판단\]/); assert.match(both, /뻔해 보여도 아래 ①과 ③은 건너뛰지 마세요/); assert.match(both, /내 결론·계획은 적지 마세요/); assert.match(both, /review:true/); assert.match(both, /받아들이지 않은 것과 이유/);
  assert.equal(consultRule(null), ''); assert.equal(consultRule({ mode: 'off' }), '');
});

test('도구 붙이기: 브라우저와 함께 한 파일(Claude)·-c 설정(Codex)으로, 묻기 도구에는 긴 대기 시간을 준다', () => {
  const browserTool = { command: 'node', args: ['b.mjs'], env: { ODDIN_TASK: 'j1/t1' } };
  const ask = { name: 'oddin-ask', command: 'node', args: ['a.mjs'], env: { ODDIN_TASK: 'j1/t1' }, timeoutMs: 600_000 };
  const list = mcpServers({ browserTool, mcpTools: [ask] });
  assert.deepEqual(list.map((x) => x.name), ['oddin-browser', 'oddin-ask']);
  const args = codexMcpArgs(list);
  assert.ok(args.includes("mcp_servers.oddin_ask.command='node'")); assert.ok(args.includes('mcp_servers.oddin_ask.tool_timeout_sec=600'));
  assert.ok(!args.some((a) => a.startsWith('mcp_servers.oddin_browser.tool_timeout_sec')));
  const runDir = path.join(temp, 'mcp-file');
  const cfg = JSON.parse(fs.readFileSync(claudeMcpFile({ runDir, browserTool, mcpTools: [ask] }), 'utf8'));
  assert.deepEqual(cfg.mcpServers['oddin-browser'], { type: 'stdio', ...browserTool });
  assert.deepEqual(cfg.mcpServers['oddin-ask'], { type: 'stdio', command: 'node', args: ['a.mjs'], env: { ODDIN_TASK: 'j1/t1' }, timeout: 600_000 });
  assert.equal(claudeMcpFile({ runDir }), null);
  assert.deepEqual(mcpServers({}), []);
});

test('묻기: 다른 쪽 AI를 읽기 전용으로 돌려 답을 받고, 작업에 기록을 남긴다', async () => {
  const { m, job, task, calls, events, owner } = setup();
  const s = await m.consults.start({ owner, question: 'refresh 토큰을 어디서 갱신하는 게 맞나요? src/auth.js 를 봐 주세요', context: '두 군데 후보가 있어요' });
  assert.equal(s.ok, true); assert.equal(s.status, 'running'); assert.equal(s.tool, 'codex', 'Claude 작업자는 Codex 에게 묻는다');
  const r = await m.consults.wait({ owner, id: s.id, waitMs: 3000 });
  assert.equal(r.status, 'done'); assert.match(r.answer, /그렇게 하면 됩니다/);
  const o = calls[0];
  assert.equal(o.readOnly, true); assert.equal(o.tool, 'codex'); assert.equal(o.cwd, cwd); assert.equal(o.resumeSessionId, null);
  assert.match(o.prompt, /읽기 전용입니다/); assert.match(o.prompt, /# 사용자 요청 원문[\s\S]*로그인이 가끔 풀리는/); assert.match(o.prompt, /# 질문\nrefresh 토큰/); assert.match(o.prompt, /두 군데 후보/);
  assert.ok(o.runDir.endsWith(path.join('t1', 'consult-1')));
  const c = task.consults[0];
  assert.equal(c.status, 'done'); assert.equal(c.tool, 'codex'); assert.equal(c.sessionId, 'S-1'); assert.ok(c.ms >= 0); assert.equal(c.model, 'mock-model');
  assert.deepEqual(events.filter((e) => e.kind === 'consult').map((e) => e.state), ['asked', 'done']);
  // 끝난 지 오래돼 메모리에서 빠져도 실행 기록에서 답을 읽어 준다
  m.consults.runs.clear();
  assert.match((await m.consults.wait({ owner, id: s.id })).answer, /그렇게 하면 됩니다/);
  assert.equal(job.tasks[0].consults.length, 1);
  // 화면의 "답 보기"
  const shown = m.consults.answer(job.id, 't1', s.id);
  assert.equal(shown.tool, 'codex'); assert.match(shown.answer, /그렇게 하면 됩니다/);
  assert.throws(() => m.consults.answer(job.id, 't1', 'c9-none'), (e) => e.status === 404);
});

test('하위 작업이 끝나면 그 작업의 남은 의견 요청만 끈다', async () => {
  const calls = [];
  const { m, job, task, owner } = setup({ deps: { runWorker: fakeWorker(calls, { delay: 5000 }) } });
  const other = { id: 't2', title: '다른 일', assignee: 'codex', status: 'running', prompt: 'y', dependsOn: [] };
  job.tasks.push(other);
  const a = await m.consults.start({ owner, question: 'q1' }), b = await m.consults.start({ owner: `${job.id}/t2`, question: 'q2' });
  await sleep(30);
  m.consults.cancel(job.id, 't1');
  assert.equal((await m.consults.wait({ owner, id: a.id, waitMs: 2000 })).status, 'cancelled');
  assert.equal((await m.consults.wait({ owner: `${job.id}/t2`, id: b.id })).status, 'running', '다른 하위 작업의 요청은 그대로');
  assert.equal(task.consults[0].error, '중지됨');
  m.consults.cancel(job.id);
  await m.consults.wait({ owner: `${job.id}/t2`, id: b.id, waitMs: 2000 });
});

test('Codex 작업자는 Claude 에게 묻고, 같은 작업의 다음 질문은 앞선 의견 대화를 이어 쓴다', async () => {
  const { m, calls, owner } = setup({ assignee: 'codex' });
  const a = await m.consults.start({ owner, question: '첫 질문' }); await m.consults.wait({ owner, id: a.id, waitMs: 3000 });
  const b = await m.consults.start({ owner, question: '고친 뒤 다시 봐 주세요', review: true }); await m.consults.wait({ owner, id: b.id, waitMs: 3000 });
  assert.equal(calls[0].tool, 'claude'); assert.equal(calls[1].resumeSessionId, 'S-1');
  assert.match(calls[1].prompt, /\[이어서\]/); assert.doesNotMatch(calls[1].prompt, /# 사용자 요청 원문/);
  assert.match(calls[1].prompt, /바뀐 내용 검토를 구합니다/); assert.match(calls[1].prompt, /허브가 바뀐 내용을 뽑지 못했습니다/);
});

test('검토: 허브가 뽑은 바뀐 파일과 비교 내용을 함께 넘긴다', async () => {
  const changes = { files: [{ path: 'src/auth.js', status: 'modified', additions: 3, deletions: 1 }], unified: 'diff --git a/src/auth.js b/src/auth.js\n+const fresh = true;\n', truncated: false };
  const { m, calls, owner } = setup({ deps: { changes: async () => changes } });
  const s = await m.consults.start({ owner, question: '빠뜨린 것이 있나요', review: true }); await m.consults.wait({ owner, id: s.id, waitMs: 3000 });
  assert.match(calls[0].prompt, /- src\/auth\.js · modified \+3 −1/); assert.match(calls[0].prompt, /\+const fresh = true;/);
  assert.equal(fs.readFileSync(path.join(calls[0].runDir, 'changes.diff'), 'utf8'), changes.unified);
  assert.deepEqual(calls[0].addDirs, [calls[0].runDir], '의견을 주는 쪽이 비교 파일을 읽을 수 있게');
});

test('받지 않는 경우: 꺼짐·횟수 초과·상대 AI 없음·한도 — 오류가 아니라 혼자 진행하라는 글로 돌려준다', async () => {
  const off = setup({ settings: { consult: 'off' } });
  const r0 = await off.m.consults.start({ owner: off.owner, question: 'q' });
  assert.equal(r0.refused, true); assert.match(r0.message, /꺼져 있어요/); assert.equal(off.calls.length, 0);
  const lim = setup({ consult: { maxPerTask: 1 } });
  const a = await lim.m.consults.start({ owner: lim.owner, question: 'q1' }); await lim.m.consults.wait({ owner: lim.owner, id: a.id, waitMs: 3000 });
  assert.match((await lim.m.consults.start({ owner: lim.owner, question: 'q2' })).message, /횟수\(1번\)를 다 썼어요/);
  const down = setup({ deps: { toolStatus: async () => ({ claude: { ok: true }, codex: { ok: false } }) } });
  assert.match((await down.m.consults.start({ owner: down.owner, question: 'q' })).message, /Codex를 지금 쓸 수 없어요/);
  const full = setup({ deps: { usageStatus: async () => ({ codex: { windows: [{ usedPercent: 93 }] } }) } });
  assert.match((await full.m.consults.start({ owner: full.owner, question: 'q' })).message, /Codex 한도를 93% 써서/);
  assert.equal(full.task.consults?.length || 0, 0, '받지 않은 요청은 횟수에 넣지 않는다');
  // 질문에 바로 답하는 요청·옮겨 온 기록에는 붙이지 않는다
  assert.equal(off.m.consults.mode({ ...off.job, settings: { consult: 'ask' }, answer: true }), 'off');
  // 꼭 받기는 고치기 전·끝내기 전 두 번이 늘 되게 한다
  const com = setup({ consult: { committeeMax: 1 }, settings: { consult: 'committee' } });
  assert.equal(com.m.consults.limit(com.job), 2);
  assert.deepEqual(com.m.consults.info(com.job, com.task), { mode: 'committee', other: 'Codex', max: 2 });
});

test('잘못된 호출: 없는 작업·끝난 작업·빈 질문은 오류', async () => {
  const { m, task, owner } = setup();
  await assert.rejects(m.consults.start({ owner: 'nope/t1', question: 'q' }), (e) => e.status === 404);
  await assert.rejects(m.consults.start({ owner, question: '  ' }), (e) => e.status === 400);
  task.status = 'done';
  await assert.rejects(m.consults.start({ owner, question: 'q' }), (e) => e.status === 409);
  await assert.rejects(m.consults.wait({ owner, id: 'c9-zzzz' }), (e) => e.status === 404);
});

test('같은 질문이 다시 오면 돌고 있는 요청에 붙고, 다른 질문은 앞 답부터 받으라고 한다', async () => {
  const calls = [];
  const { m, owner } = setup({ deps: { runWorker: fakeWorker(calls, { delay: 300 }) } });
  const a = await m.consults.start({ owner, question: '같은 질문' });
  const b = await m.consults.start({ owner, question: '같은 질문' });
  assert.equal(b.id, a.id); assert.equal(b.joined, true);
  const c = await m.consults.start({ owner, question: '다른 질문' });
  assert.equal(c.refused, true); assert.equal(c.id, a.id); assert.match(c.message, /ask_result/);
  assert.equal((await m.consults.wait({ owner, id: a.id })).status, 'running', '안 기다리면 진행 중');
  assert.equal((await m.consults.wait({ owner, id: a.id, waitMs: 3000 })).status, 'done');
  assert.equal(calls.length, 1, '한 번만 돌았다');
});

test('전체 실행 한도가 꽉 차 있어도 의견 요청은 돈다(부른 쪽이 자리를 쥐고 기다리므로)', async () => {
  const { m, owner } = setup();
  const held = await m.execution.acquire({ owner: 'someone' }); // maxParallel 1 — 부른 작업자가 쥔 자리
  const s = await m.consults.start({ owner, question: 'q' });
  assert.equal((await m.consults.wait({ owner, id: s.id, waitMs: 3000 })).status, 'done');
  held();
});

test('작업을 중지하면 의견 요청도 끈다 · 실패한 요청은 이유를 남긴다', async () => {
  const calls = [];
  const { m, job, task, owner } = setup({ deps: { runWorker: fakeWorker(calls, { delay: 5000 }) } });
  const s = await m.consults.start({ owner, question: 'q' });
  await sleep(30);
  m.consults.cancel(job.id);
  const r = await m.consults.wait({ owner, id: s.id, waitMs: 3000 });
  assert.equal(r.status, 'cancelled'); assert.equal(task.consults[0].status, 'cancelled');
  const bad = setup({ deps: { runWorker: fakeWorker([], { fail: '모델이 답하지 않았어요' }) } });
  const f = await bad.m.consults.start({ owner: bad.owner, question: 'q' });
  const fr = await bad.m.consults.wait({ owner: bad.owner, id: f.id, waitMs: 3000 });
  assert.equal(fr.status, 'failed'); assert.match(fr.error, /모델이 답하지 않았어요/);
});

test('작업 실행: 켠 요청에만 도구와 규칙을 붙이고, "꼭 받기"인데 의견 없이 끝나면 알림을 남긴다', async () => {
  const run = async (consult) => {
    const { m, job, task } = setup({ settings: { consult } });
    task.status = 'pending';
    const seen = {};
    m.askTool = (j, t) => m.consults.toolSpec(j, t, { script: 'ask.mjs', hub: 'http://127.0.0.1:1' });
    m.memoryFor = () => ''; m.continuation = () => null;
    m.trackWorker = async (j, launch) => { seen.launch = launch; return { ok: true, text: '끝', sessionId: 'W1' }; };
    await m.runTask(job, task, [], '');
    seen.prompt = fs.readFileSync(path.join(job.runDir, 't1', 'prompt.md'), 'utf8');
    return { job, task, seen };
  };
  const off = await run('off');
  assert.doesNotMatch(off.seen.prompt, /ask_other_ai/); assert.deepEqual(off.job.notes, []);
  const ask = await run('ask');
  assert.match(ask.seen.prompt, /\[다른 AI 의견\]/); assert.deepEqual(ask.job.notes, [], '필요할 때만은 안 물어도 된다');
  const com = await run('committee');
  assert.match(com.seen.prompt, /\[두 AI가 함께 판단\]/); assert.equal(com.task.status, 'done');
  assert.deepEqual(com.job.notes, ['"로그인 고치기" 작업이 다른 AI 의견을 받지 않고 끝났어요.']);
  // 도구 설정: 작업 번호·허브 주소·기다리는 시간, 묻는 상대 이름
  const spec = com.job && new Consults({ config: { consult: {} }, jobs: new Map() }).toolSpec({ id: 'j9', settings: { consult: 'ask' } }, { id: 't1', assignee: 'codex' }, { script: 'ask.mjs', hub: 'http://127.0.0.1:7700' });
  assert.deepEqual(spec, { name: 'oddin-ask', command: process.execPath, args: ['ask.mjs'], env: { ODDIN_TASK: 'j9/t1', ODDIN_HUB: 'http://127.0.0.1:7700', ODDIN_ASK_WAIT_MS: '540000', ODDIN_ASK_OTHER: 'Claude' }, timeoutMs: 600_000 });
  assert.equal(new Consults({ config: {}, jobs: new Map() }).toolSpec({ id: 'j9', settings: {} }, { id: 't1', assignee: 'codex' }, { script: 'a', hub: 'h' }), null);
});

test('다시 켜면 돌던 의견 요청은 끊긴 것으로 남는다', () => {
  const file = path.join(process.env.HUB_DATA_DIR, 'jobs.json');
  const job = { id: 'jr', sessionId: 's9', title: 'jr', goal: 'g', cwd, mode: 'auto', status: 'running', createdAt: now, notes: [], intercepts: [], attachments: [], settings: {}, runDir: path.join(temp, 'runs', 'jr'),
    tasks: [{ id: 't1', title: 't', assignee: 'claude', status: 'running', prompt: 'x', dependsOn: [], consults: [{ id: 'c1-aaaa', n: 1, tool: 'codex', status: 'running' }, { id: 'c0-bbbb', n: 0, tool: 'codex', status: 'done' }] }] };
  fs.writeFileSync(file, JSON.stringify([job]));
  try {
    const m = new JobManager({ defaultCwd: cwd, hubDir: path.join(temp, 'shared'), tools: {}, defaults: {} });
    assert.deepEqual(m.jobs.get('jr').tasks[0].consults.map((c) => c.status), ['cancelled', 'done']);
  } finally { fs.writeFileSync(file, '[]'); }
});

test('의견 지시문: 꼭 받기의 첫 질문은 독립 분석, 요청 범위를 넓히지 말라는 규칙', () => {
  const job = { id: 'j1', cwd: 'D:/x', goal: '결제 오류 수정', intercepts: [] }, task = { id: 't1', assignee: 'codex', title: '결제', prompt: '고친다' };
  const p = buildConsultPrompt({ job, task, question: '원인이 무엇일까요', mode: 'committee' });
  assert.match(p, /Codex가 독립 분석을 구합니다/); assert.match(p, /요청 범위를 넓히는 제안/); assert.match(p, /⑤ 확신/);
  assert.match(buildConsultPrompt({ job, task, question: 'q', review: true, changes: { files: [] } }), /바뀐 파일이 없습니다/);
});

test('실제 실행기로: 읽기 전용(샌드박스 read-only)으로 띄우고 답을 받는다', async () => {
  const cap = path.join(temp, 'cap.jsonl');
  const { m, owner } = setup({ deps: { runWorker: undefined } });
  m.config.tools.codex = { enabled: true, command: `"${process.execPath}" "${fixture}" --tool codex --capture "${cap}"`, transport: 'native', shell: true };
  const s = await m.consults.start({ owner, question: 'FIXTURE_QUESTION 어떻게 보나요' });
  const r = await m.consults.wait({ owner, id: s.id, waitMs: 15_000 });
  assert.equal(r.status, 'done', r.error || ''); assert.match(r.answer, /최신 지시/);
  const inputs = fs.readFileSync(cap, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'input').map((x) => x.message);
  const start = inputs.find((x) => x.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.cwd, cwd);
  assert.match(inputs.find((x) => x.method === 'turn/start').params.input[0].text, /FIXTURE_QUESTION/);
  await sleep(300); // 가짜 CLI 가 끝나고 폴더를 놓을 때까지
});

test('바뀐 내용 뽑기: 시작 스냅샷과 지금 폴더를 견준다(스냅샷이 없으면 null)', async () => {
  const cp = new Checkpoints({}, { dataDir: path.join(temp, 'cp-data'), runsDir: path.join(temp, 'cp-runs'), hubRoot: path.join(temp, 'cp-hub') });
  const work = fs.mkdtempSync(path.join(temp, 'cp-work-'));
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(work, 'keep.txt'), 'same\n');
  const job = { id: 'job-live', sessionId: 's', cwd: work, notes: [] };
  assert.equal(await cp.live(job), null);
  await cp.begin(job);
  assert.deepEqual((await cp.live(job)).files, []);
  await sleep(20);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
  const live = await cp.live(job);
  assert.deepEqual(live.files.map((f) => `${f.status}:${f.path}`).sort(), ['added:b.txt', 'modified:a.txt']);
  assert.match(live.unified, /\+two/); assert.equal(live.truncated, false);
  const tiny = await cp.live(job, { limit: 10 });
  assert.equal(tiny.truncated, true); assert.equal(tiny.unified, ''); assert.equal(tiny.files.length, 2, '너무 크면 파일 목록만');
  await cp.end(job);
  assert.equal(job.checkpoint.status, 'ready'); assert.equal(job.checkpoint.files.length, 2, '중간에 뽑아도 끝 스냅샷은 그대로');
});

// ---- 도구 스크립트(MCP) ----
function hubStub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const b = JSON.parse(body || '{}'); seen.push({ url: req.url, body: b });
      const out = handler(req.url, b, seen);
      res.writeHead(out.code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
function mcp(hub, env = {}) {
  const child = spawn(process.execPath, [askScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ODDIN_HUB: hub, ODDIN_TASK: 'j1/t1', ODDIN_ASK_OTHER: 'Codex', ODDIN_ASK_POLL_MS: '200', ...env } });
  const waiting = new Map(); let buf = '', id = 0;
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { rpc, stop: () => { child.stdin.end(); child.kill(); } };
}

test('도구 스크립트: 묻고, 답이 올 때까지 허브에 물으며 기다려 돌려준다', async () => {
  const hub = await hubStub((url, b, seen) => {
    if (url === '/api/consult') return { body: { ok: true, id: 'c1-ab12', status: 'running', tool: 'codex' } };
    const waits = seen.filter((x) => x.url === '/api/consult/wait').length;
    return { body: waits < 3 ? { id: b.id, status: 'running', tool: 'codex' } : { id: b.id, status: 'done', tool: 'codex', ms: 72_000, answer: '① 결론: 갱신은 한 곳에서만 하세요' } };
  });
  const c = mcp(hub.url, { ODDIN_ASK_WAIT_MS: '20000' });
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'oddin-ask');
    const tools = (await c.rpc('tools/list', {})).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['ask_other_ai', 'ask_result']); assert.deepEqual(tools[0].inputSchema.required, ['question']);
    const r = await c.rpc('tools/call', { name: 'ask_other_ai', arguments: { question: '어디서 갱신하나요', context: '후보 둘', review: true } });
    assert.equal(r.result.isError, undefined);
    assert.match(r.result.content[0].text, /^\[Codex 의견 · 1분 12초\]\n① 결론/); assert.match(r.result.content[0].text, /참고 의견입니다/);
    assert.deepEqual(hub.seen[0].body, { owner: 'j1/t1', question: '어디서 갱신하나요', context: '후보 둘', review: true });
    assert.equal(hub.seen.filter((x) => x.url === '/api/consult/wait').length, 3);
  } finally { c.stop(); hub.server.close(); }
});

test('도구 스크립트: 너무 늦으면 요청 번호를 돌려주고 ask_result 로 이어 받는다 · 받지 않는 사정은 그 글 그대로', async () => {
  let done = false, refuse = false;
  const hub = await hubStub((url, b) => {
    if (url === '/api/consult') return { body: refuse ? { ok: false, refused: true, message: '이 작업에서 물을 수 있는 횟수(3번)를 다 썼어요.' } : { ok: true, id: 'c2-cd34', status: 'running', tool: 'claude' } };
    return { body: done ? { id: b.id, status: 'done', tool: 'claude', ms: 4000, answer: '늦게 온 답' } : { id: b.id, status: 'running', tool: 'claude' } };
  });
  const c = mcp(hub.url, { ODDIN_ASK_WAIT_MS: '1000' });
  try {
    await c.rpc('initialize', {});
    const late = await c.rpc('tools/call', { name: 'ask_other_ai', arguments: { question: 'q' } });
    assert.match(late.result.content[0].text, /아직 Claude가 답을 쓰는 중이에요\(요청 번호 c2-cd34\)/); assert.match(late.result.content[0].text, /ask_result/);
    done = true;
    const got = await c.rpc('tools/call', { name: 'ask_result', arguments: { id: 'c2-cd34' } });
    assert.match(got.result.content[0].text, /\[Claude 의견 · 4초\]\n늦게 온 답/);
    refuse = true;
    const no = await c.rpc('tools/call', { name: 'ask_other_ai', arguments: { question: 'q' } });
    assert.equal(no.result.content[0].text, '이 작업에서 물을 수 있는 횟수(3번)를 다 썼어요.'); assert.equal(no.result.isError, undefined);
    assert.equal((await c.rpc('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  } finally { c.stop(); hub.server.close(); }
});

test('도구 스크립트: 허브가 오류로 답하면 혼자 진행하라고 알린다', async () => {
  const hub = await hubStub(() => ({ code: 409, body: { error: '진행 중인 작업만 의견을 물을 수 있어요' } }));
  const c = mcp(hub.url);
  try {
    await c.rpc('initialize', {});
    const r = await c.rpc('tools/call', { name: 'ask_other_ai', arguments: { question: 'q' } });
    assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /진행 중인 작업만[\s\S]*혼자 판단해 진행/);
  } finally { c.stop(); hub.server.close(); }
});
