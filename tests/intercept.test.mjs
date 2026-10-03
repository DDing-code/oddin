import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-intercept-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
const { JobManager } = await import('../lib/jobs.mjs');
const { runWorker } = await import('../lib/workers.mjs');
const { aggregateIntercept } = await import('../lib/intercepts.mjs');
const { invalidateToolStatus } = await import('../lib/tools.mjs');
const { badModels } = await import('../lib/router.mjs');
let serial = 0;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function fixture() {
  const root = path.join(temp, 'case-' + ++serial), capture = path.join(root, 'capture.jsonl'); fs.mkdirSync(root, { recursive: true });
  const command = (tool) => `"${process.execPath}" "${path.resolve('tests/fixtures/intercept-cli.mjs')}" --tool ${tool} --capture "${capture}"`;
  const config = { hubDir: path.join(root, 'shared'), defaultCwd: root, maxParallel: 2, planner: 'codex', fastPath: { enabled: false }, // 계획 단계를 시험하므로 작은 요청 바로 처리는 끔
    tools: { claude: { command: command('claude'), transport: 'native', shell: true }, codex: { command: command('codex'), transport: 'native', shell: true } }, defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } } };
  const manager = new JobManager(config);
  manager.memoryFor = () => '시험 최신 메모리';
  const rows = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, config, manager, capture, rows };
}
async function until(fn, ms = 6000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('시험 조건 대기 시간 초과'); await delay(10); } }
function request(job, text, id = randomUUID()) { return { sessionId: job.sessionId, clientRequestId: id, text }; }
function seeded(f, prompts = ['SLOW WORK_A', 'SLOW WORK_B', 'WORK_C', 'WORK_D']) {
  const s = f.manager.createSession({ cwd: f.root });
  const job = { id: 'job-' + randomUUID(), sessionId: s.id, goal: '원래 목표', title: '시험', cwd: f.root, mode: 'both', status: 'running', activePhase: 'worker', createdAt: new Date().toISOString(), instructionRevision: 0, intercepts: [], phaseRuns: {}, settings: f.config.defaults, runDir: path.join(f.root, 'run-' + randomUUID()), tasks: prompts.map((prompt, i) => ({ id: 't' + (i + 1), title: '작업 ' + i, prompt, assignee: i % 2 ? 'claude' : 'codex', dependsOn: i > 1 ? ['t1', 't2'] : [], status: 'pending', settings: f.config.defaults[i % 2 ? 'claude' : 'codex'] })) };
  fs.mkdirSync(job.runDir, { recursive: true }); f.manager.jobs.set(job.id, job); f.manager.sessions.get(s.id).jobIds.push(job.id); return job;
}
function worker(f, tool, prompt, overrides = {}) { return runWorker({ tool, prompt, cwd: f.root, runDir: path.join(f.root, 'worker-' + tool), toolCfg: f.config.tools[tool], settings: f.config.defaults[tool], managed: true, timeoutMs: 5000, ackTimeoutMs: 150, onEvent() {}, ...overrides }); }

test('두 네이티브 CLI: 현재 턴 전달·동일 세션·연속 지시·중단된 결과 미채택', async () => {
  for (const tool of ['claude', 'codex']) {
    const f = fixture(), h = worker(f, tool, 'SLOW ORIGINAL_MARKER');
    try {
      await until(() => h.getState().ready); const sid = h.getState().sessionId;
      const a = h.intercept({ text: 'DIRECTION_A', messageId: randomUUID() }), b = h.intercept({ text: 'DIRECTION_B', messageId: randomUUID() });
      assert.equal((await a).status, 'delivered'); assert.equal((await b).status, 'delivered');
      const r = await h.settle(); assert.equal(r.ok, true, r.error); assert.equal(r.sessionId, sid); assert.match(r.text, /DIRECTION_B/); assert.doesNotMatch(r.text, /^STALE_INTERRUPTED_RESULT$/);
      const rows = f.rows().filter((r) => r.kind === 'input');
      const ordered = rows.filter((r) => (r.message.type === 'user' || r.message.method === 'turn/steer') && /DIRECTION_[AB]/.test(JSON.stringify(r.message))).map((r) => JSON.stringify(r.message).match(/DIRECTION_[AB]/)[0]);
      assert.deepEqual(ordered, ['DIRECTION_A', 'DIRECTION_B']);
      assert.equal(rows.filter((r) => r.message.method === 'turn/steer').length, tool === 'codex' ? 2 : 0);
      assert.equal(rows.filter((r) => r.message.request?.subtype === 'interrupt').length, tool === 'claude' ? 2 : 0);
    } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
  }
});
test('접수 영속 저장·중복 10회·실행 2개와 대기 2개·다른 세션 격리', async () => {
  const f = fixture(), j = seeded(f), other = seeded(f, ['SLOW OTHER_SESSION']);
  const run = f.manager.schedule(j), runOther = f.manager.schedule(other);
  await until(() => j.tasks.slice(0, 2).every((t) => t.sessionId) && other.tasks[0].sessionId);
  const body = request(j, 'BROADCAST_MARKER'), result = f.manager.acceptIntercept(j.id, body);
  assert.equal(result.duplicate, false); assert.equal(result.intercept.deliveries.length, 4);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.HUB_DATA_DIR, 'jobs.json'))).find((x) => x.id === j.id);
  assert.equal(saved.intercepts[0].clientRequestId, body.clientRequestId);
  for (let n = 0; n < 10; n++) assert.equal(f.manager.acceptIntercept(j.id, body).duplicate, true);
  assert.throws(() => f.manager.acceptIntercept(j.id, { ...body, text: 'DIFFERENT' }), (e) => e.code === 'REQUEST_ID_CONFLICT');
  assert.throws(() => f.manager.acceptIntercept(j.id, { ...body, sessionId: other.sessionId }), (e) => e.code === 'SESSION_MISMATCH');
  await Promise.all([run, runOther]);
  assert(j.tasks.every((t) => t.status === 'done'), JSON.stringify(j.tasks)); assert.equal(j.intercepts[0].status, 'delivered'); assert.equal(j.intercepts.length, 1);
  const inputs = f.rows().filter((r) => r.kind === 'input' && (r.message.type === 'user' || r.message.method === 'turn/start' || r.message.method === 'turn/steer'));
  assert.equal(inputs.filter((r) => JSON.stringify(r.message).includes('BROADCAST_MARKER')).length, 4);
  assert(!other.tasks[0].resultText.includes('BROADCAST_MARKER'));
  j.status = 'done'; f.manager.emitJob(j); assert.equal(f.manager.acceptIntercept(j.id, body).duplicate, true);
  assert.throws(() => f.manager.acceptIntercept(j.id, request(j, 'LATE')), (e) => e.code === 'JOB_NOT_ACTIVE');
  clearTimeout(f.manager._saveTimer);
});
test('전달 직전 전체 중지 우선: 재개·후속 작업 없이 cancelled 유지', async () => {
  const f = fixture(), j = seeded(f), run = f.manager.schedule(j);
  await until(() => j.tasks[0].sessionId && j.tasks[1].sessionId);
  f.manager.acceptIntercept(j.id, request(j, 'CANCEL_MARKER')); f.manager.cancel(j.id);
  await run; assert.equal(j.status, 'cancelled'); assert(j.tasks.every((t) => t.status === 'cancelled')); assert.equal(j.intercepts[0].status, 'cancelled');
  assert.equal(f.manager.running.size, 0); clearTimeout(f.manager._saveTimer);
});

test('두 CLI의 전달·중단·프로세스 종료 경합: 연속 대기 지시가 새 세션을 시작하지 않음', async () => {
  for (const tool of ['claude', 'codex']) {
    const f = fixture(), h = worker(f, tool, 'SLOW ORIGINAL');
    try {
      await until(() => h.getState().ready);
      const queued = [1, 2, 3].map((n) => h.intercept({ text: 'RACE_' + n, messageId: randomUUID() }));
      h.cancel();
      const receipts = await Promise.all(queued); assert(receipts.every((r) => r.status === 'failed'));
      const result = await h.settle(); assert.equal(result.cancelled, true); assert.equal(result.ok, false);
      assert.equal(f.rows().filter((r) => r.message?.method === 'thread/start').length, tool === 'codex' ? 1 : 0);
      assert.equal(f.rows().filter((r) => r.message?.type === 'user').length, tool === 'claude' ? 1 : 0);
    } finally { h.close(); clearTimeout(f.manager._saveTimer); }
  }
});

test('두 CLI가 전달 ACK 대기 중 종료될 때: 늦은 결과로 중지 상태를 되살리지 않음', async () => {
  for (const tool of ['claude', 'codex']) {
    const f = fixture(), h = worker(f, tool, 'SLOW DELAY_ACK', { ackTimeoutMs: 2000 });
    try {
      await until(() => h.getState().ready);
      const pending = h.intercept({ text: 'IN_FLIGHT_CHANGE', messageId: randomUUID() });
      await until(() => f.rows().some((r) => r.message?.request?.subtype === 'interrupt' || r.message?.method === 'turn/steer'));
      h.cancel();
      assert.notEqual((await pending).status, 'delivered');
      const result = await h.settle(); assert.equal(result.ok, false); assert.equal(result.cancelled, true);
      assert.equal(f.rows().filter((r) => r.kind === 'legacy').length, 0);
    } finally { h.close(); clearTimeout(f.manager._saveTimer); }
  }
});
test('ACK 유실·잘못된 턴·지원 불가: 성공으로 표시하거나 중복 전송하지 않음', async () => {
  for (const marker of ['ACK_LOSS', 'WRONG_TURN', 'REJECT_STEER']) {
    const f = fixture(), h = worker(f, 'codex', 'SLOW ' + marker);
    try { await until(() => h.getState().ready); const receipt = await h.intercept({ text: 'ONLY_ONCE', messageId: randomUUID() });
      assert.equal(receipt.status, marker === 'REJECT_STEER' ? 'failed' : 'uncertain');
      assert.equal(f.rows().filter((r) => r.message?.method === 'turn/steer').length, 1);
    } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
  }
});
test('Claude init 누락과 잔여 큐: 수신 확인 없이 전달 성공으로 기록하지 않음', async () => {
  for (const marker of ['NO_INIT', 'STILL_QUEUED']) {
    const f = fixture(), h = worker(f, 'claude', 'SLOW ' + marker);
    try { if (marker !== 'NO_INIT') await until(() => h.getState().ready); const r = await h.intercept({ text: 'FOLLOWUP', messageId: randomUUID() }); assert.equal(r.status, 'uncertain'); }
    finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
  }
});
test('legacy exec: 소유한 PID close 후 같은 thread 재개, cwd·모델·강도 유지', async () => {
  const f = fixture(), h = worker(f, 'codex', 'SLOW ORIGINAL', { toolCfg: { ...f.config.tools.codex, transport: 'legacy' } });
  try { await until(() => h.getState().sessionId); const sid = h.getState().sessionId;
    const receipt = await h.intercept({ text: 'RESUME_DIRECTION', messageId: randomUUID() }); assert.equal(receipt.status, 'delivered'); assert.equal(receipt.mode, 'resume');
    const r = await h.settle(); assert.equal(r.ok, true); assert.equal(r.sessionId, sid); assert.match(r.text, /RESUME_DIRECTION/);
    const row = f.rows().find((x) => x.kind === 'legacy' && x.args.includes('resume'));
    assert(row); assert(!row.args.includes('-C')); assert.equal(row.args.at(-2), sid); assert(row.args.includes('gpt-6.1-sol')); assert(row.args.includes('model_reasoning_effort=high'));
  } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
});
test('네이티브의 미지원 모델 오류도 고정 선택과 명시적 오류 종류를 유지', async () => {
  const f = fixture(), h = worker(f, 'codex', 'MODEL_TEST', { settings: { model: 'gpt-6-astra', effort: 'xhigh' }, toolCfg: { ...f.config.tools.codex, extraArgs: ['--reject-model', 'gpt-6-astra'] }, modelPolicy: { config: f.config, fixed: { model: 'gpt-6-astra', effort: 'xhigh' } } });
  try { const res = await h.promise; assert.equal(res.ok, false); assert.equal(res.errorKind, 'MODEL_UNSUPPORTED'); assert.equal(res.fellBackTo, undefined); assert.equal(f.rows().filter((r) => r.message?.method === 'thread/start').length, 1); }
  finally { h.cancel(); h.close(); badModels.clear(); clearTimeout(f.manager._saveTimer); }
});
test('재시작 복원: 미전달 recorded 실패, sending 불확실, 자동 재실행 없음', () => {
  const f = fixture(), j = seeded(f, []);
  j.intercepts = [{ id: 'i-recovery', status: 'applying', deliveries: [{ key: 'a', status: 'sending' }, { key: 'b', status: 'recorded' }] }]; f.manager.save({ immediate: true }); clearTimeout(f.manager._saveTimer);
  const restored = new JobManager(f.config), value = restored.get(j.id);
  assert.equal(value.status, 'interrupted'); assert.equal(value.canIntercept, false); assert.equal(value.intercepts[0].deliveries[0].status, 'uncertain'); assert.equal(value.intercepts[0].deliveries[1].status, 'failed'); assert.equal(restored.running.size, 0); clearTimeout(restored._saveTimer);
});
test('입력 오류·목표/커맨드 텍스트 유지·저장 실패 시 revision 롤백', () => {
  const f = fixture(), j = seeded(f, []);
  for (const b of [{}, request(j, ''), request(j, 'x'.repeat(20001)), { ...request(j, 'x'), attachments: [1] }]) assert.throws(() => f.manager.acceptIntercept(j.id, b), (e) => e.code === 'INVALID_INTERCEPT');
  const saved = f.manager.acceptIntercept(j.id, request(j, '/goal @reviewer 그대로 텍스트')); assert.match(saved.intercept.text, /^\/goal/); assert.equal(j.goal, '원래 목표');
  const original = f.manager.save; f.manager.save = () => { throw new Error('시험 저장 실패'); };
  assert.throws(() => f.manager.acceptIntercept(j.id, request(j, 'ROLLBACK')), (e) => e.code === 'INTERCEPT_PERSIST_FAILED');
  assert.equal(j.instructionRevision, 1); assert.equal(j.intercepts.length, 1); f.manager.save = original; clearTimeout(f.manager._saveTimer);
});
test('집계: 예약만 있으면 accepted, 실패와 예약은 partial, 수신 확인은 delivered', () => {
  const aggregate = (...states) => aggregateIntercept({ deliveries: states.map((status) => ({ status })) });
  assert.equal(aggregate('recorded'), 'accepted'); assert.equal(aggregate('recorded', 'delivered'), 'delivered'); assert.equal(aggregate('recorded', 'uncertain'), 'partial'); assert.equal(aggregate('failed'), 'failed'); assert.equal(aggregate('sending', 'recorded'), 'applying');
  assert.equal(aggregate('delivered', 'cancelled'), 'partial');
});

test('Claude 일반·수정 턴: 백그라운드 완료 이후의 결과만 완료로 채택', async () => {
  for (const intercepted of [false, true]) {
    const f = fixture(); let held = false, settled = false;
    const h = worker(f, 'claude', intercepted ? 'SLOW ORIGINAL' : 'BACKGROUND', { onEvent: (e) => { if (e.kind === 'background' && e.text) held = true; } });
    h.promise.then(() => { settled = true; });
    try {
      await until(() => h.getState().ready);
      if (intercepted) assert.equal((await h.intercept({ text: 'BACKGROUND CHANGE', messageId: randomUUID() })).status, 'delivered');
      await until(() => held); assert.equal(settled, false);
      const r = await h.settle(); assert.equal(r.ok, true, r.error); assert.match(r.text, /^BACKGROUND_FINAL/);
    } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
  }
});

test('Claude 백그라운드 대기 중 추가 지시: 같은 세션에서 즉시 방향 전환', async () => {
  const f = fixture(); let held = false;
  const h = worker(f, 'claude', 'BACKGROUND_STUCK', { onEvent: (e) => { if (e.kind === 'background' && e.text) held = true; } });
  try {
    await until(() => held); const sid = h.getState().sessionId;
    const receipt = await h.intercept({ text: 'FINAL_PATCH', messageId: randomUUID() });
    assert.equal(receipt.status, 'delivered', receipt.error);
    const r = await h.settle(); assert.equal(r.ok, true, r.error); assert.equal(r.sessionId, sid); assert.match(r.text, /FINAL_PATCH/);
  } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
});

test('Claude 상시 감시용 백그라운드 작업은 최종 완료를 막지 않음', async () => {
  const f = fixture(), h = worker(f, 'claude', 'AMBIENT_BACKGROUND');
  try { const result = await h.settle(); assert.equal(result.ok, true, result.error); assert.match(result.text, /AMBIENT_BACKGROUND/); }
  finally { h.close(); clearTimeout(f.manager._saveTimer); }
});

test('Claude 백그라운드 조기 프로세스 종료·원래 시간 제한·중지: 완료로 오인하지 않음', async () => {
  for (const scenario of ['EXIT', 'TIMEOUT', 'CANCEL']) {
    const f = fixture(); let held = false;
    const h = worker(f, 'claude', scenario === 'EXIT' ? 'BACKGROUND_EXIT' : 'BACKGROUND_STUCK', { timeoutMs: scenario === 'TIMEOUT' ? 1100 : 5000, onEvent: (e) => { if (e.kind === 'background' && e.text) held = true; } });
    try {
      await until(() => held);
      if (scenario === 'CANCEL') h.cancel();
      const r = await h.settle(); assert.equal(r.ok, false); assert.equal(r.timedOut, scenario === 'TIMEOUT'); assert.equal(r.cancelled, scenario === 'CANCEL');
    } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
  }
});

test('일부 수신 뒤 중지: 이미 전달된 기록 유지·미시작 의존 작업만 취소', async () => {
  const f = fixture(), j = seeded(f, ['SLOW A', 'SLOW B', 'C']), run = f.manager.schedule(j);
  try {
    await until(() => j.tasks.slice(0, 2).every((t) => t.sessionId));
    f.manager.acceptIntercept(j.id, request(j, 'SLOW CHANGE'));
    await until(() => j.intercepts[0].deliveries.filter((d) => d.status === 'delivered').length === 2);
    f.manager.cancel(j.id); await run;
    assert.equal(j.status, 'cancelled'); assert.equal(j.intercepts[0].status, 'partial');
    assert.equal(j.intercepts[0].deliveries.filter((d) => d.status === 'delivered').length, 2);
    assert.equal(j.intercepts[0].deliveries.filter((d) => d.status === 'cancelled').length, 1);
    assert.equal(f.manager.running.size, 0);
  } finally { f.manager.cancel(j.id); clearTimeout(f.manager._saveTimer); }
});
test('접수 대기열 20개 제한과 기존 ID 조회 우선', () => {
  const f = fixture(), j = seeded(f, []); let first;
  for (let n = 0; n < 20; n++) { const body = request(j, 'PENDING_' + n); if (!n) first = body; f.manager.acceptIntercept(j.id, body); }
  assert.equal(f.manager.acceptIntercept(j.id, first).duplicate, true);
  assert.throws(() => f.manager.acceptIntercept(j.id, request(j, 'OVERFLOW')), (e) => e.status === 429 && e.code === 'INTERCEPT_BACKLOG_FULL');
  assert.equal(j.instructionRevision, 20); assert.equal(j.intercepts.length, 20); clearTimeout(f.manager._saveTimer);
});
test('전체 계획 실행의 보고 중 지시: 완료 작업 보존·같은 job에 실제 보완 추가', async () => {
  const f = fixture(); invalidateToolStatus();
  const created = f.manager.create({ goal: 'REPORT_RECONCILIATION', mode: 'auto' }), j = f.manager.get(created.id);
  await until(() => j.activePhase === 'report' && f.manager.running.has(`${j.id}/phase:report`), 12000);
  const originalTasks = [...j.tasks]; f.manager.acceptIntercept(j.id, request(j, 'IMPLEMENT_CHANGE'));
  await until(() => !['queued', 'planning', 'running', 'reporting'].includes(j.status), 12000);
  assert.equal(j.status, 'done', j.error || JSON.stringify(j.tasks)); assert.equal(j.tasks.length, 3); assert.equal(j.tasks[0], originalTasks[0]); assert.match(j.tasks[2].resultText, /SUPPLEMENT_WORK/); assert.equal(j.tasks[2].sessionId, j.tasks[0].sessionId);
  clearTimeout(f.manager._saveTimer);
});
test('계획·배정 단계에도 지시 전달, 단계 완료 채택 전에 수신 확인', async () => {
  for (const phase of ['plan', 'route']) {
    const f = fixture(), j = seeded(f, []); j.status = 'planning'; j.activePhase = phase;
    const h = worker(f, 'codex', phase === 'plan' ? '당신은 로컬 플래너 SLOW' : '당신은 작업마다 라우터 SLOW');
    const tracked = f.manager.trackWorker(j, h, phase);
    await until(() => h.getState().ready);
    f.manager.acceptIntercept(j.id, request(j, 'PHASE_INSTRUCTION'));
    const r = await tracked; assert.equal(r.ok, true); assert.equal(j.phaseRuns[phase].revision, 1); assert.equal(j.intercepts[0].status, 'delivered'); assert.equal(f.manager.running.size, 0); clearTimeout(f.manager._saveTimer);
  }
});
test('마지막 워커 완료 경계에서 먼저 접수하면 같은 job에 보완 후 완료', async () => {
  const f = fixture(); invalidateToolStatus(); let sent = false;
  const onEvent = (e) => { if (e.type !== 'job') return; const j = f.manager.get(e.job.id); if (j?.goal === 'COMPLETION_BOUNDARY' && j.status === 'running' && j.tasks.length === 1 && j.tasks[0].status === 'done' && !sent) { sent = true; f.manager.acceptIntercept(j.id, request(j, 'BOUNDARY_CHANGE')); } };
  f.manager.on('event', onEvent); const first = f.manager.create({ goal: 'COMPLETION_BOUNDARY', mode: 'codex' }), j = f.manager.get(first.id);
  await until(() => !['queued', 'planning', 'running', 'reporting'].includes(j.status), 12000);
  assert(sent); assert.equal(j.status, 'done', j.error); assert.equal(j.tasks.length, 2); assert.equal(j.tasks[1].sessionId, j.tasks[0].sessionId); f.manager.off('event', onEvent); clearTimeout(f.manager._saveTimer);
});
test('목표 판정 중 전달·다음 라운드 상속·라운드 수 유지', async () => {
  const f = fixture(); invalidateToolStatus();
  const first = f.manager.startGoal({ text: 'GOAL_ORIGINAL', mode: 'codex', maxRounds: 2 }), j = f.manager.get(first.id), s = f.manager.sessions.get(j.sessionId);
  await until(() => f.manager.running.has(`${j.id}/phase:goal-check`), 12000);
  assert.equal(f.manager.publicSession(s).status, 'running'); assert.equal(f.manager.canIntercept(j), true);
  f.manager.acceptIntercept(j.id, request(j, 'NEXT_ROUND'));
  await until(() => s.jobIds.length === 2, 12000); const next = f.manager.get(s.jobIds[1]);
  assert.equal(next.goalId, j.goalId); assert.equal(next.intercepts.length, 1); assert.match(next.intercepts[0].text, /NEXT_ROUND/); assert.equal(j.goalRound, 1); assert.equal(next.goalRound, 2);
  await until(() => s.goal.status !== 'active', 12000); assert.equal(s.goal.status, 'stopped'); assert.equal(s.jobIds.length, 2); clearTimeout(f.manager._saveTimer);
});
test('목표 판정 중 전체 중지: 늦은 판정이 목표를 완료하거나 재개하지 않음', async () => {
  const f = fixture(); invalidateToolStatus();
  const first = f.manager.startGoal({ text: 'GOAL_STOP', mode: 'codex', maxRounds: 2 }), j = f.manager.get(first.id), s = f.manager.sessions.get(j.sessionId);
  await until(() => f.manager.running.has(`${j.id}/phase:goal-check`), 12000);
  f.manager.stopGoal(s.id); await until(() => !f.manager.running.size);
  assert.equal(s.goal.status, 'stopped'); assert.equal(j.status, 'cancelled'); assert.equal(s.jobIds.length, 1); clearTimeout(f.manager._saveTimer);
});
test('격리 HTTP: 202 저장·200 재전송·GET/SSE 복원·Origin 차단·첨부 전달', async () => {
  const f = fixture(), dataDir = path.join(f.root, 'http-data'), runsDir = path.join(f.root, 'http-runs'), configFile = path.join(f.root, 'http-config.json');
  const reserve = http.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const base = `http://127.0.0.1:${port}`; write(configFile, JSON.stringify({ ...f.config, port, host: '127.0.0.1' }));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: dataDir, HUB_RUNS_DIR: runsDir, HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1' }, shell: false, windowsHide: true, stdio: 'ignore' });
  const api = async (route, body, headers = {}) => { const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: res.status, value: await res.json() }; };
  let stream;
  try {
    const end = Date.now() + 6000; for (;;) { try { await api('/api/options'); break; } catch (e) { if (Date.now() >= end) throw e; await delay(30); } }
    assert.equal((await api('/api/status')).value.capabilities.intercept, 1);
    const created = await api('/api/jobs', { goal: 'SLOW HTTP_ORIGINAL', mode: 'both' }); assert.equal(created.status, 201); const j = created.value;
    let snapshot;
    for (let n = 0; n < 150; n++) { snapshot = (await api('/api/jobs/' + j.id)).value; if (snapshot.tasks.length === 2 && snapshot.tasks.every((t) => t.sessionId)) break; await delay(20); }
    assert(snapshot.tasks.every((t) => t.sessionId));
    const denied = await api(`/api/jobs/${j.id}/intercepts`, request(j, 'BLOCKED'), { origin: 'https://evil.example' }); assert.equal(denied.status, 403);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const up = await fetch(base + '/api/uploads', { method: 'POST', body: png, headers: { 'x-filename': 'intercept.png' } }); const attachment = await up.json(); assert.equal(up.status, 201);
    const body = { ...request(j, 'HTTP_MARKER'), attachments: [{ id: attachment.id, name: attachment.name }] };
    const accepted = await api(`/api/jobs/${j.id}/intercepts`, body); assert.equal(accepted.status, 202); assert.equal(accepted.value.intercept.text, 'HTTP_MARKER');
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'))).find((x) => x.id === j.id); assert.equal(disk.intercepts.length, 1);
    assert.equal((await api(`/api/jobs/${j.id}/intercepts`, body)).status, 200);
    assert.equal((await api(`/api/jobs/${j.id}/intercepts`, { ...body, text: 'conflict' })).value.code, 'REQUEST_ID_CONFLICT');
    assert.equal((await api(`/api/jobs/${j.id}/intercepts`)).value.revision, 1);
    let hello = ''; stream = http.get(base + '/api/events', (res) => res.on('data', (d) => { hello += d; })); await until(() => hello.includes(body.clientRequestId));
    assert(hello.includes('"instructionRevision":1'));
    for (let n = 0; n < 150; n++) { snapshot = (await api('/api/jobs/' + j.id)).value; if (snapshot.status === 'done') break; await delay(20); }
    assert.equal(snapshot.status, 'done', JSON.stringify(snapshot)); assert.equal(snapshot.intercepts[0].status, 'delivered');
    const messages = f.rows().filter((r) => r.kind === 'input' && JSON.stringify(r.message).includes('HTTP_MARKER'));
    assert(messages.some((r) => r.message.params?.input?.some((c) => c.type === 'localImage'))); assert(messages.some((r) => r.message.message?.content?.some((c) => c.type === 'image')));
    assert.equal((await api(`/api/jobs/${j.id}/intercepts`, request(j, 'TOO_LATE'))).value.code, 'JOB_NOT_ACTIVE');
    assert.equal((await api(`/api/jobs/${j.id}/intercepts`, body)).status, 200);
  } finally { stream?.destroy(); if (child.exitCode === null) { const exit = new Promise((r) => child.once('exit', r)); child.kill(); await exit; } clearTimeout(f.manager._saveTimer); }
});
test.after(async () => {
  await delay(1200);
  if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('hub-intercept-')) throw new Error('시험 폴더 범위 오류');
  fs.rmSync(temp, { recursive: true, force: true });
});
test('시작 직후 일시적 잠금 오류로 다시 시작하면 처음 프롬프트의 수신 확인은 새 시도로 받는다', async () => {
  for (const tool of ['codex', 'claude']) {
    const f = fixture(), flag = path.join(f.root, 'flaky-' + tool);
    const h = worker(f, tool, 'ORIGINAL_PROMPT', { toolCfg: { ...f.config.tools[tool], extraArgs: ['--flaky-once', flag] }, ackTimeoutMs: 5000, timeoutMs: 20000 });
    try {
      const receipt = await h.initialReceipt();
      assert.equal(receipt.status, 'delivered', JSON.stringify(receipt));
      const res = await h.settle(); assert.equal(res.ok, true, JSON.stringify(res));
      assert.ok(fs.existsSync(flag), '첫 실행이 일시적 오류로 끝나야 함');
    } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
  }
});
test('보고 단계: 일시적 오류 재시작 뒤 성공하면 앞선 수정 지시 전달 실패로 처리하지 않음', async () => {
  const f = fixture(), job = seeded(f), now = new Date().toISOString(), flag = path.join(f.root, 'flaky-report');
  job.instructionRevision = 1;
  job.intercepts = [{ id: 'i-early', clientRequestId: 'c-early', seq: 1, revision: 1, text: '앞선 수정 지시', attachments: [], status: 'delivered', acceptedAt: now, updatedAt: now, deliveries: [], error: null }];
  const h = worker(f, 'codex', '당신은 AI 작업 보고 시험', { toolCfg: { ...f.config.tools.codex, extraArgs: ['--flaky-once', flag] }, ackTimeoutMs: 5000, timeoutMs: 20000 });
  try {
    const res = await f.manager.trackWorker(job, h, 'report');
    assert.equal(res.ok, true, res.error);
    const d = job.intercepts[0].deliveries.find((x) => x.key === 'phase:report');
    assert.equal(d.status, 'delivered', JSON.stringify(d));
    assert.ok(fs.existsSync(flag));
  } finally { h.cancel(); clearTimeout(f.manager._saveTimer); }
});

test('Codex 생각 요약은 추론 과정 기록(thinking)으로 남는다', async () => {
  const f = fixture(), events = [];
  const h = worker(f, 'codex', 'REASONING 작업', { onEvent: (e) => events.push(e), ackTimeoutMs: 2000 });
  try {
    const res = await h.settle(); assert.equal(res.ok, true, JSON.stringify(res));
    const t = events.find((e) => e.kind === 'thinking');
    assert.ok(t, '생각 기록 없음'); assert.match(t.text, /Inspecting files/); assert.match(t.text, /Planning edits/);
  } finally { h.cancel(); h.close(); clearTimeout(f.manager._saveTimer); }
});
