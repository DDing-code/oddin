// 목표 일시정지(2026-10-10 "목표 정지 말고 일시정지도 넣어주고"): 정지는 지금 라운드를 끊지만, 일시정지는 지금 라운드와 달성 판정까지 하고
// 다음 라운드를 시작하지 않고 멈춘다. "이어서"로 다음 라운드부터 계속, 라운드 중에 다시 누르면(일시정지 취소) 그대로 이어 간다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-goal-pause-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
const { JobManager } = await import('../lib/jobs.mjs');
test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

function manager(t) {
  const root = fs.mkdtempSync(path.join(temp, 'case-'));
  const m = new JobManager({ defaultCwd: root, hubDir: path.join(root, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, defaults: {} });
  clearTimeout(m._saveTimer); m._saveTimer = null; m.sessions.clear(); m.jobs.clear();
  t.after(() => clearTimeout(m._saveTimer));
  const s = m.createSession({ cwd: root });
  const session = m.sessions.get(s.id);
  session.goal = { id: 'g-1', text: '영상 10편 만들기', status: 'active', round: 2, maxRounds: 6, progress: 30, remaining: '', next: '', reason: '' };
  const job = (id, extra) => { const runDir = path.join(root, 'runs', id); fs.mkdirSync(runDir, { recursive: true }); const j = { id, sessionId: s.id, goalId: 'g-1', status: 'running', tasks: [], intercepts: [], runDir, cwd: root, settings: {}, ...extra }; m.jobs.set(id, j); session.jobIds.push(id); return j; };
  // 판정: 두 AI 모두 정상·한도 여유, 아직 달성 못 함
  m.goalDeps = { toolStatus: async () => ({ claude: { ok: true }, codex: { ok: true } }), usageStatus: async () => null, checkGoal: async () => ({ done: false, blocked: false, progress: 50, remaining: '5편 남음', next: '다음 편', reason: '절반' }) };
  return { m, session, job };
}

test('라운드 중 일시정지: 그 라운드와 판정까지 하고 다음 라운드를 만들지 않고 멈춘다', async (t) => {
  const { m, session, job } = manager(t);
  const j = job('r2');
  m.pauseGoal(session.id);
  assert.equal(session.goal.status, 'active', '라운드는 끊지 않는다'); assert.equal(session.goal.pauseRequested, true);
  assert.equal(j.status, 'running');
  let next = 0; m.nextGoalRound = () => { next++; };
  j.status = 'done';
  await m.afterGoalRound(j);
  assert.equal(next, 0, '다음 라운드를 시작하지 않는다');
  assert.equal(session.goal.status, 'paused'); assert.equal(session.goal.progress, 50, '판정은 했다');
  assert.match(session.goal.reason, /일시정지했어요.*3라운드부터/);
  assert.equal(session.goal.pauseRequested, undefined);
  // 이어서 → 다음 라운드
  session.jobIds.length = 0; m.jobs.clear();
  m.nextGoalRound = () => { next++; };
  await m.resumeGoal(session.id);
  assert.equal(session.goal.status, 'active'); assert.equal(next, 1);
});

test('일시정지 취소: 라운드 중에 "이어서"를 누르면 일시정지를 거두고 다음 라운드로 그대로 간다', async (t) => {
  const { m, session, job } = manager(t);
  const j = job('r2');
  m.pauseGoal(session.id);
  await m.resumeGoal(session.id);
  assert.equal(session.goal.pauseRequested, undefined); assert.equal(session.goal.status, 'active');
  let next = 0; m.nextGoalRound = () => { next++; };
  j.status = 'done';
  await m.afterGoalRound(j);
  assert.equal(next, 1); assert.equal(session.goal.status, 'active');
});

test('진행 중인 라운드가 없으면 일시정지는 바로 멈추고, 정지는 따로 동작한다', (t) => {
  const { m, session, job } = manager(t);
  job('r1', { status: 'done' });
  m.pauseGoal(session.id);
  assert.equal(session.goal.status, 'paused'); assert.match(session.goal.reason, /3라운드부터/);
  session.goal.status = 'active'; session.goal.pauseRequested = true;
  m.stopGoal(session.id);
  assert.equal(session.goal.status, 'stopped'); assert.equal(session.goal.pauseRequested, undefined);
  assert.equal(m.pauseGoal(session.id).goal.status, 'stopped', '멈춘 목표에는 아무 일도 안 한다');
});
