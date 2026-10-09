// 진행 중에 보낸 요청의 예약(2026-10-10 "오딘 작업 중간에 대화하는 거, 클로드처럼 인터셉트할지 예약으로 할지 정할 수 있게"):
// reserve:true 로 만든 요청은 그 세션의 진행 중 작업이 모두 끝난 뒤(중지·실패·재시작 중단 포함) 예약한 순서대로 시작한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reserve-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
const { JobManager } = await import('../lib/jobs.mjs');
const { INTERCEPT_CAPABILITIES } = await import('../lib/intercepts.mjs');
test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

const tick = () => new Promise((r) => setTimeout(r, 20));
function fresh(t, { keep = false } = {}) {
  const root = fs.mkdtempSync(path.join(temp, 'case-'));
  const m = new JobManager({ defaultCwd: root, hubDir: path.join(root, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, defaults: {} });
  clearTimeout(m._saveTimer); m._saveTimer = null;
  if (!keep) { m.sessions.clear(); m.jobs.clear(); }
  t.after(() => clearTimeout(m._saveTimer));
  // 실제 CLI 대신: run 은 시작만 기록하고 end 로 끝낸다 (실제 run 은 끝에 finish 를 부른다)
  const started = [];
  m.run = (job) => new Promise(() => { started.push(job.id); job.status = 'running'; job.activePhase = 'worker'; m.emitJob(job); });
  const end = async (id, status = 'done') => { const j = m.jobs.get(id); j.status = status; m.finish(j); await tick(); };
  return { m, root, started, end };
}
const isReserved = (m, id) => m.jobs.get(id).reserved === true && m.jobs.get(id).status === 'queued';

test('진행 중에 reserve 로 보내면 예약되어 기다리고, 앞 작업이 끝나면 순서대로 시작한다', async (t) => {
  const { m, root, started, end } = fresh(t);
  const a = m.create({ goal: '첫 요청', cwd: root }); await tick();
  assert.deepEqual(started, [a.id]);
  assert.throws(() => m.create({ goal: '둘째', sessionId: a.sessionId }), /실행 중인 작업/);
  const b = m.create({ goal: '둘째', sessionId: a.sessionId, reserve: true });
  assert.equal(b.reserved, true); assert.equal(b.status, 'queued'); assert.equal(b.after, a.id); assert.equal(b.canIntercept, false);
  assert.equal(m.canIntercept(m.jobs.get(b.id)), false, '예약은 끼어들기 대상이 아니다');
  const c = m.create({ goal: '셋째', sessionId: a.sessionId, reserve: true });
  assert.equal(c.after, b.id, '뒤 예약은 앞 예약 다음');
  assert.deepEqual(started, [a.id], '예약은 시작하지 않는다');
  await end(a.id);
  assert.deepEqual(started, [a.id, b.id]);
  assert.equal(m.jobs.get(b.id).reserved, undefined); assert.ok(isReserved(m, c.id), '셋째는 둘째가 끝날 때까지 기다린다');
  assert.ok(m.canIntercept(m.jobs.get(b.id)), '시작한 뒤에는 끼어들기 대상');
  await end(b.id, 'failed');
  assert.deepEqual(started, [a.id, b.id, c.id], '앞 작업이 실패로 끝나도 예약은 시작');
});

test('진행 중인 게 없으면 reserve 여도 바로 시작하고, /goal 은 예약할 수 없다', async (t) => {
  const { m, root, started } = fresh(t);
  const a = m.create({ goal: '바로', cwd: root, reserve: true }); await tick();
  assert.equal(a.reserved, undefined); assert.deepEqual(started, [a.id]);
  assert.throws(() => m.create({ goal: '/goal 다 끝내기', sessionId: a.sessionId, reserve: true }), /예약할 수 없어요/);
});

test('예약 취소는 건너뛰고 다음 예약이 이어지며, 앞 작업을 중지해도 예약은 시작한다', async (t) => {
  const { m, root, started, end } = fresh(t);
  const a = m.create({ goal: '첫', cwd: root }); await tick();
  const b = m.create({ goal: '둘', sessionId: a.sessionId, reserve: true });
  const c = m.create({ goal: '셋', sessionId: a.sessionId, reserve: true });
  m.cancel(b.id); await tick();
  assert.equal(m.jobs.get(b.id).status, 'cancelled'); assert.equal(m.jobs.get(b.id).reserved, undefined);
  assert.ok(isReserved(m, c.id), '앞 작업이 아직 진행 중이라 셋째는 기다린다');
  m.cancel(a.id); await end(a.id, 'cancelled'); // 실제로는 run 이 중지를 보고 finish 를 부른다
  assert.deepEqual(started, [a.id, c.id]);
});

test('재시작: 예약은 중단 처리하지 않고, 이어 하는 작업이 끝난 뒤에 시작한다', async (t) => {
  const { m, root, started } = fresh(t);
  const a = m.create({ goal: '첫', cwd: root }); await tick();
  const b = m.create({ goal: '둘', sessionId: a.sessionId, reserve: true });
  const live = m.prepareRestart(); // 파일로 저장 + 멈춤
  assert.deepEqual(live.map((j) => j.id), [a.id], '예약은 이어 할 작업 목록에 들지 않는다');
  assert.deepEqual(started, [a.id]);
  const again = fresh(t, { keep: true }); // 같은 저장 파일을 읽는 새 허브
  const ra = again.m.jobs.get(a.id), rb = again.m.jobs.get(b.id);
  assert.equal(ra.resumeOnStart, true); assert.equal(rb.status, 'queued'); assert.equal(rb.reserved, true);
  again.m.resumeAfterRestart(); await tick();
  assert.deepEqual(again.started, [a.id], '첫 작업을 이어 하는 동안 예약은 기다린다');
  await again.end(a.id);
  assert.deepEqual(again.started, [a.id, b.id]);
  // 부팅 때 앞 작업이 없으면(예: 그냥 꺼졌다 켜짐 → 중단됨) 바로 시작
  const { m: m3, root: r3, started: s3 } = fresh(t);
  const x = m3.create({ goal: '첫', cwd: r3 }); await tick();
  const y = m3.create({ goal: '둘', sessionId: x.sessionId, reserve: true });
  m3.jobs.get(x.id).status = 'interrupted'; // load() 가 진행 중이던 작업을 이렇게 바꾼다
  m3.resumeAfterRestart(); await tick();
  assert.ok(s3.includes(y.id));
});

test('서버 기능 표시에 reserve 가 있다', () => { assert.equal(INTERCEPT_CAPABILITIES.reserve, 1); });
