// 목표 모드 빈 라운드(2026-10-08 집 PC WOWMeta 세션: 판정이 다음 지시로 "재개 지시 전까지 일시중지 유지"를 써서
// 3·4라운드 플래너가 작업 없는 계획을 냈고, "계획으로 해석하지 못함"으로 실패하며 라운드만 되풀이했다)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-goal-empty-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
const { JobManager } = await import('../lib/jobs.mjs');
const { roundPrompt } = await import('../lib/goals.mjs');
const { makePlan } = await import('../lib/planner.mjs');
test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} });

function manager(t) {
  const root = fs.mkdtempSync(path.join(temp, 'case-'));
  const m = new JobManager({ defaultCwd: root, hubDir: path.join(root, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, defaults: {} });
  clearTimeout(m._saveTimer); m._saveTimer = null; m.sessions.clear(); m.jobs.clear();
  t.after(() => clearTimeout(m._saveTimer));
  const s = m.createSession({ cwd: root });
  const session = m.sessions.get(s.id);
  session.goal = { id: 'g-1', text: '12.1 가이드 마무리', status: 'active', round: 3, maxRounds: 6, progress: 40, remaining: '', next: '', reason: '' };
  const job = (id, extra) => { const j = { id, sessionId: s.id, goalId: 'g-1', status: 'failed', tasks: [], intercepts: [], ...extra }; m.jobs.set(id, j); session.jobIds.push(id); return j; };
  return { m, session, job };
}

test('빈 계획으로 끝난 라운드는 판정·다음 라운드 없이 목표를 멈춘다', async (t) => {
  const { m, session, job } = manager(t);
  job('r2', { status: 'done' });
  const j = job('r3', { error: '플래너(codex)가 할 일이 없다고 판단했어요: 명시적인 재개 지시가 없으므로 일시중지를 유지합니다.', errorCode: 'EMPTY_PLAN' });
  let next = 0; m.nextGoalRound = () => { next++; };
  await m.afterGoalRound(j);
  assert.equal(session.goal.status, 'paused');
  assert.match(session.goal.reason, /할 일이 없다고 봐서 멈췄어요.*이어서.*일시중지를 유지/);
  assert.equal(next, 0);
});

test('두 라운드 연속 실패면 멈춘다', async (t) => {
  const { m, session, job } = manager(t);
  job('r2', { error: 'CLI 실행 실패' });
  const j = job('r3', { error: '보고 생성 실패' });
  m.nextGoalRound = () => { throw new Error('다음 라운드를 만들면 안 됨'); };
  await m.afterGoalRound(j);
  assert.equal(session.goal.status, 'paused');
  assert.match(session.goal.reason, /두 라운드 연속 실패/);
});

test('"이어서"로 재개한 라운드 지시에는 대기 문구를 넘어가라는 말이 붙는다(한 번만)', async (t) => {
  const { m, session } = manager(t);
  const g = { round: 4, maxRounds: 6, text: '목표', progress: 40, remaining: '남음', next: '재개 지시 전까지 일시중지를 유지한다', intercepts: [] };
  assert.doesNotMatch(roundPrompt(g), /이어서"를 눌러/);
  assert.match(roundPrompt({ ...g, resumed: true }), /"이어서"를 눌러 목표를 재개했습니다.*지금 진행하세요/s);
  session.goal.status = 'paused';
  const made = [];
  m._create = (o) => { made.push(o); return { id: 'x' }; };
  m.resumeGoal(session.id);
  assert.match(made[0].goal, /재개했습니다/);
  assert.equal(session.goal.resumed, undefined, '다음 라운드부터는 붙지 않음');
});

test('작업도 질문도 없는 계획은 EMPTY_PLAN(이유 포함), 읽을 수 없는 응답은 예전처럼 "해석하지 못함"', async () => {
  const runDir = fs.mkdtempSync(path.join(temp, 'plan-'));
  const config = { planner: 'codex', tools: { codex: {}, claude: {} }, defaults: {} };
  const plan = (text) => makePlan({ goal: '목표', cwd: runDir, config, status: {}, healthy: ['codex'], memoryCtx: '', runDir, onWorker: async () => ({ ok: true, text }) });
  await assert.rejects(plan('{"summary":"명시적인 재개 지시가 없으므로 일시중지를 유지합니다.","workdir":"","questions":[],"tasks":[]}'),
    (e) => e.code === 'EMPTY_PLAN' && /할 일이 없다고 판단했어요: 명시적인 재개 지시가 없으므로/.test(e.message));
  await assert.rejects(plan('계획 대신 아무 말'), (e) => !e.code && /계획으로 해석하지 못함/.test(e.message));
});
