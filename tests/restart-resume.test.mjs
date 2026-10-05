// "지금 바꾸기": 진행 중인 작업을 멈춰 저장 → 새 버전으로 시작 → 같은 CLI 대화로 이어 하기 (실제 모델 호출 없음)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-restart-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { JobManager } = await import('../lib/jobs.mjs');
const { buildWorkerPrompt } = await import('../lib/planner.mjs');
const { DATA_DIR } = await import('../lib/util.mjs');
const cwd = fs.mkdtempSync(path.join(temp, 'work-'));
const config = { defaultCwd: cwd, hubDir: path.join(temp, 'shared'), tools: {}, defaults: {} };
const now = new Date().toISOString();
const job = (id, status, tasks, extra = {}) => ({ id, sessionId: 's1', title: id, goal: '영상 만들기', cwd, mode: 'auto', status, createdAt: now, tasks, notes: [], intercepts: [], attachments: [], runDir: path.join(temp, 'runs', id), settings: {}, ...extra });
const task = (id, status, extra = {}) => ({ id, title: id, assignee: 'codex', status, prompt: 'x', dependsOn: [], ...extra });

test('지금 바꾸기: 진행 중인 작업에 표시를 남겨 저장하고, 작업자만 끄고, 그 뒤 변화는 저장하지 않는다', () => {
  assert.ok(DATA_DIR.startsWith(temp), '시험은 임시 데이터 폴더만 쓴다');
  const m = new JobManager(config);
  m.sessions.set('s1', { id: 's1', title: 's', cwd, jobIds: ['j1', 'j2', 'j3'], createdAt: now, updatedAt: now, goal: { id: 'g1', status: 'active' } });
  m.jobs.set('j1', job('j1', 'running', [task('t1', 'running', { sessionId: 'S-1' }), task('t2', 'pending')], { mode: 'both' })); // 보고서 단계(실제 AI) 없는 비교 모드
  m.jobs.set('j2', job('j2', 'planning', []));
  m.jobs.set('j3', job('j3', 'done', [task('t1', 'done')]));
  let cancelled = 0;
  m.running.set('j1/t1', { handle: { cancel: () => cancelled++ } });
  const stopped = m.prepareRestart();
  assert.deepEqual(stopped.map((x) => x.id).sort(), ['j1', 'j2']);
  assert.equal(cancelled, 1, '작업자 CLI 를 끔');
  assert.equal(m.frozen, true);
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf8'));
  assert.equal(saved.find((j) => j.id === 'j1').resumeOnStart, true);
  assert.equal(saved.find((j) => j.id === 'j3').resumeOnStart, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'))[0].goal.resumeOnStart, true);
  // 끈 작업자가 '취소'로 끝나도 저장되지 않는다
  m.jobs.get('j1').tasks[0].status = 'cancelled'; m.save({ immediate: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf8')).find((j) => j.id === 'j1').tasks[0].status, 'running');
  assert.throws(() => m._create({ goal: '새 일', cwd }), (e) => e.status === 503, '바꾸는 중에는 새 요청을 받지 않음');
});

test('새 버전 시작: 멈춘 작업은 같은 CLI 대화로 이어 하고, 계획 전이던 작업은 처음부터, 목표는 다시 진행', async () => {
  const m = new JobManager(config); // 위 시험이 저장한 jobs.json 을 읽는다
  const j1 = m.jobs.get('j1'), j2 = m.jobs.get('j2');
  assert.equal(j1.status, 'interrupted');
  assert.match(m.sessions.get('s1').goal.reason, /새 버전/);
  const ran = [], finished = [];
  m.checkpoints = { end: async () => {}, begin: async () => {} };
  m.workerHistory = () => '';
  m.schedule = async (job) => { for (const t of job.tasks) if (t.status === 'pending') { ran.push({ id: t.id, resume: t.resumeSessionId || null, flag: !!t.resumedAfterRestart }); t.status = 'done'; t.resultText = `${t.id} 끝`; } };
  m.finish = (job) => finished.push(job.id);
  m.run = async (job) => { ran.push({ restarted: job.id, status: job.status }); };
  const ids = m.resumeAfterRestart();
  assert.deepEqual(ids.sort(), ['j1', 'j2']);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ran.find((x) => x.id === 't1'), { id: 't1', resume: 'S-1', flag: true }, '대화가 있던 작업은 그 대화를 이어 씀');
  assert.deepEqual(ran.find((x) => x.id === 't2'), { id: 't2', resume: null, flag: false }, '시작 전이던 작업은 새로');
  assert.deepEqual(ran.find((x) => x.restarted), { restarted: 'j2', status: 'queued' }, '계획 전이면 처음부터');
  assert.equal(j1.status, 'done'); assert.ok(finished.includes('j1'));
  assert.equal(j1.resumeOnStart, undefined);
  assert.equal(m.sessions.get('s1').goal.status, 'active', '목표도 다시 진행');
  assert.equal(j2.tasks.length, 0);
});

test('이어 하는 작업자 지시문에는 "다시 이어서" 안내가 붙는다', () => {
  const base = { job: { id: 'j1', cwd, goal: '영상', intercepts: [] }, task: task('t1', 'running'), depResults: [], siblings: [], hubDir: config.hubDir, memoryCtx: '' };
  assert.match(buildWorkerPrompt({ ...base, resumed: true }), /\[다시 이어서\][^\n]*쓰다 만 출력 파일부터/);
  assert.doesNotMatch(buildWorkerPrompt(base), /다시 이어서/);
});
