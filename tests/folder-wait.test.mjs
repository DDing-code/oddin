// 폴더 차례(2026-10-19 회사 PC: D:\YM_Inv 에서 다른 세션의 1시간짜리 영상 작업 뒤에 압축 요청이 47분 기다리다 취소됨)
// 기다리는 동안 누구를 기다리는지 알리기 · "기다리지 않고 시작" · 변경 기록을 못 남기는 큰 폴더는 다른 세션끼리 함께
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fwait-'));
process.env.HUB_DATA_DIR = path.join(home, 'data');
process.env.HUB_RUNS_DIR = path.join(home, 'runs');
test.after(() => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {} });

const { ExecutionQueue, workspaceKey } = await import('../lib/execution-queue.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
const { buildWorkerPrompt } = await import('../lib/planner.mjs');
const tick = () => new Promise((r) => setImmediate(r));

test('대기열: 같은 폴더는 차례대로, 큰 폴더(shared)는 다른 세션끼리 함께·같은 세션은 차례대로, 막는 것이 바뀔 때 알림, 바로 시작', async () => {
  const q = new ExecutionQueue(), root = path.join(home, 'studio'), sub = path.join(root, 'cards');
  const a = await q.acquire({ owner: 'a', folder: root, group: 's1' });
  const waits = [];
  let bDone = null; q.acquire({ owner: 'b', folder: sub, group: 's2', onWait: (o) => waits.push(o) }).then((r) => { bDone = r; });
  await tick();
  assert.equal(bDone, null, '하위 폴더도 차례를 기다림'); assert.deepEqual(waits, [['a']]);
  assert.equal(q.force('b'), true); await tick();
  assert.equal(typeof bDone, 'function', '바로 시작'); assert.equal(q.force('nope'), false);
  a(); bDone();
  // shared: 다른 세션끼리 함께, 같은 세션은 차례대로, shared 가 아닌 쪽과는 차례대로
  const s1 = await q.acquire({ owner: 's1a', folder: root, group: 's1', shared: true });
  let other = null, same = null, plain = null;
  q.acquire({ owner: 's2a', folder: root, group: 's2', shared: true }).then((r) => { other = r; });
  q.acquire({ owner: 's1b', folder: root, group: 's1', shared: true }).then((r) => { same = r; });
  q.acquire({ owner: 'p', folder: root, group: 's3', shared: false }).then((r) => { plain = r; });
  await tick();
  assert.equal(typeof other, 'function', '다른 세션은 함께'); assert.equal(same, null, '같은 세션은 차례대로'); assert.equal(plain, null);
  s1(); await tick();
  assert.equal(typeof same, 'function'); assert.equal(plain, null, '아직 다른 세션 것이 돌고 있음');
  other(); same(); await tick();
  assert.equal(typeof plain, 'function');
  plain();
  let cancelled; q.acquire({ owner: 'c', folder: root }).then((r) => { cancelled = r; });
  const hold = await q.acquire({ owner: 'h', folder: path.join(home, 'elsewhere') }); hold();
  await tick(); assert.equal(typeof cancelled, 'function'); cancelled();
});

const manager = (config = {}) => {
  const m = Object.assign(Object.create(JobManager.prototype), {
    config: { tools: {}, defaults: {}, ...config }, _cat: { agents: [] }, sessions: new Map(), jobs: new Map(),
    workspaces: new ExecutionQueue(), logs: [], emitJob() {}, log(job, task, ev) { this.logs.push(ev.text); },
  });
  m.checkpoints = { begin: async (job) => { if (job._big) job.checkpoint = { skipped: [{ path: '', reason: 'too_many_files' }] }; }, end: async () => {} };
  return m;
};
const mkJob = (m, id, sessionId, cwd, extra = {}) => { const j = { id, sessionId, cwd, title: id, goal: id, status: 'running', notes: [], tasks: [], createdAt: new Date().toISOString(), ...extra }; m.jobs.set(id, j); return j; };

test('요청 흐름: 기다리는 동안 카드에 누구를 기다리는지, "기다리지 않고 시작"으로 바로, 기다림이 끝나면 표시를 지움', async () => {
  const m = manager(), cwd = fs.mkdtempSync(path.join(home, 'ws-'));
  const gates = new Map(); m.schedule = (job) => new Promise((r) => gates.set(job.id, r));
  const long = mkJob(m, 'long', 's-video', cwd, { title: '9강 영상 제작' });
  const zip = mkJob(m, 'zip', 's-card', cwd, { title: '압축파일에 아웃트로 카드 포함' });
  const pLong = m.runScheduled(long); await tick();
  const pZip = m.runScheduled(zip); await tick();
  assert.deepEqual(zip.folderWait.behind.map((b) => [b.title, b.sameSession]), [['9강 영상 제작', false]]);
  assert.match(m.logs.join('\n'), /같은 폴더\(.*\)에서 「9강 영상 제작」이 끝나길 기다려요/);
  assert.throws(() => m.skipFolderWait('long'), /폴더 차례를 기다리는 요청이 아니에요/);
  m.skipFolderWait('zip'); await tick(); await tick();
  assert.equal(zip.folderWait, undefined); assert.ok(gates.has('zip'), '바로 시작'); assert.equal(zip.skippedFolderWait, true);
  assert.match(zip.notes.join('\n'), /폴더 차례를 기다리지 않고 바로 시작했어요\(앞 작업: 「9강 영상 제작」\)/);
  gates.get('long')(); gates.get('zip')(); await Promise.all([pLong, pZip]);
});

test('큰 폴더: 지난 요청이 "파일이 너무 많아 스냅샷 못 남김"이면 다른 세션끼리 기다리지 않고 함께, 지시문에 함께 도는 작업을 알림, 설정으로 끔', async () => {
  const m = manager(), cwd = fs.mkdtempSync(path.join(home, 'big-'));
  const gates = new Map(); m.schedule = (job) => new Promise((r) => gates.set(job.id, r));
  // 처음엔 모름 → 첫 요청이 스냅샷을 시도하다 너무 많다고 알게 됨
  assert.equal(m.isBigFolder(workspaceKey(cwd)), false);
  const first = mkJob(m, 'first', 's-video', cwd, { title: '9강 영상 제작', _big: true });
  const p1 = m.runScheduled(first); await tick(); await tick();
  assert.equal(m.isBigFolder(workspaceKey(cwd)), true);
  gates.get('first')(); await p1;
  // 지난 기록만 있어도(재시작 뒤) 큰 폴더로 안다
  const fresh = manager(); fresh.jobs.set('old', { ...first, status: 'done' });
  assert.equal(fresh.isBigFolder(workspaceKey(cwd)), true);
  const video = mkJob(m, 'video', 's-video', cwd, { title: '9강 영상 제작' });
  const card = mkJob(m, 'card', 's-card', cwd, { title: '카드뉴스 압축' });
  const again = mkJob(m, 'again', 's-video', cwd, { title: '10강' });
  const pv = m.runScheduled(video); await tick(); await tick();
  const pc = m.runScheduled(card); const pa = m.runScheduled(again); await tick(); await tick();
  assert.ok(gates.has('card'), '다른 세션은 함께'); assert.equal(card.folderWait, undefined);
  assert.match(card.notes.join('\n'), /같은 폴더에서 다른 세션 작업\(「9강 영상 제작」\)이 돌고 있지만.*함께 시작했어요/);
  assert.ok(!gates.has('again'), '같은 세션은 차례대로'); assert.equal(again.folderWait.behind[0].sameSession, true);
  assert.deepEqual(m.neighbors(card).map((j) => j.id), ['video']);
  const prompt = buildWorkerPrompt({ job: { id: 'card', goal: '압축', cwd, intercepts: [], tasks: [] }, task: { id: 't1', title: 'x', prompt: 'x', assignee: 'codex' }, siblings: [], depResults: [], hubDir: '', memoryCtx: '', neighbors: ['9강 영상 제작'] });
  assert.match(prompt, /같은 폴더에서 다른 세션의 작업\(「9강 영상 제작」\)이 동시에 돌고 있습니다/);
  gates.get('video')(); gates.get('card')(); await Promise.all([pv, pc]); await tick(); await tick();
  gates.get('again')(); await pa;
  // 끄면 예전처럼 차례대로
  const off = manager({ workspaces: { bigFolderParallel: false } }); off.schedule = m.schedule; off.jobs.set('old', { ...first, status: 'done' });
  const x = mkJob(off, 'x', 's1', cwd), y = mkJob(off, 'y', 's2', cwd);
  const px = off.runScheduled(x); await tick(); await tick(); const py = off.runScheduled(y); await tick(); await tick();
  assert.ok(y.folderWait, '설정으로 끄면 기다림');
  gates.get('x')(); await tick(); await tick(); gates.get('y')(); await Promise.all([px, py]);
});
