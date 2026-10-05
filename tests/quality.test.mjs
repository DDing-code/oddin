// "단독보다 멍청함" 개선 (2026-10-04): 작업 폴더 · 지시문 다이어트 · 평소 강도 · 대화 이어 쓰기 · 쪼개기 줄이기
// 실제 모델 호출 없음. Codex 평소 설정은 임시 CODEX_HOME 의 config.toml 로 대신한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quality-'));
fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-small', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high'] },
] }));
process.env.CODEX_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { raiseToStandalone } = await import('../lib/router.mjs');
const { validWorkdir } = await import('../lib/projects.mjs');
const { buildPlanPrompt, buildWorkerPrompt } = await import('../lib/planner.mjs');
const { SessionTools } = await import('../lib/session-tools.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
const { ROOT } = await import('../lib/util.mjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quality-dirs-'));
const mk = (...p) => { const d = path.join(temp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const defaultCwd = mk('oddin-workspace'), project = mk('projects', 'pixel'), other = mk('projects', 'other');
const config = () => ({ defaultCwd, hubDir: mk('shared'), tools: {}, defaults: {} });
const usage = (codex = 10) => ({ codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: codex }] }, claude: { windows: [{ key: 'seven_day', label: '주간', usedPercent: 10 }] } });

test('평소 강도: Codex 는 config.toml 의 xhigh 까지 올림, 한도 90%↑·이미 높음·Claude 는 그대로, 지원 안 하면 지원하는 최고값', () => {
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'high', usage()), { effort: 'xhigh', note: '평소 단독 설정 강도(xhigh)에 맞춤 — 품질 우선' });
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'high', usage(92)), { effort: 'high' });
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'xhigh', usage()), { effort: 'xhigh' });
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-small', 'medium', usage()), { effort: 'high', note: '평소 단독 설정 강도(xhigh)에 맞춤 — 품질 우선' });
  assert.deepEqual(raiseToStandalone({}, 'claude', 'opus', 'high', usage()), { effort: 'high' });
});

test('작업 방식: 품질 우선(기본)은 평소 강도로 올리고, 속도 우선은 근거 없는 xhigh 를 high 로 낮춤', () => {
  const m = Object.assign(Object.create(JobManager.prototype), { config: { tools: {}, defaults: {} }, _cat: { agents: [] } });
  const run = (pace, effort) => {
    const job = { settings: { claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' }, pace }, tasks: [], input: '버튼 색 바꾸기' };
    const task = { id: 't1', title: '버튼 색 바꾸기', prompt: '버튼 색 바꾸기', assignee: 'codex' };
    job.tasks.push(task);
    m.applyChoice(job, task, { model: 'gpt-6.1-sol', effort, reason: '' }, usage());
    return task;
  };
  const q = run('quality', 'high');
  assert.equal(q.settings.effort, 'xhigh'); assert.match(q.reason, /품질 우선/);
  assert.equal(run(undefined, 'high').settings.effort, 'xhigh');
  const s = run('speed', 'xhigh');
  assert.equal(s.settings.effort, 'high'); assert.match(s.reason, /속도 우선/);
});

test('작업 폴더 검사: 있는 폴더만, 드라이브 루트·홈·시스템·허브 기록 폴더·상대 경로는 거절', () => {
  const cfg = config();
  assert.equal(validWorkdir(project, cfg).dir, path.resolve(project));
  assert.equal(validWorkdir(`"${project}"`, cfg).dir, path.resolve(project));
  assert.match(validWorkdir('', cfg).error, /비어/);
  assert.match(validWorkdir('projects/pixel', cfg).error, /절대 경로/);
  assert.match(validWorkdir(path.parse(project).root, cfg).error, /드라이브 루트/);
  assert.match(validWorkdir(os.homedir(), cfg).error, /홈/);
  assert.match(validWorkdir('C:\\Windows\\System32', cfg).error, /시스템/);
  assert.match(validWorkdir(path.join(ROOT, 'runs'), cfg).error, /허브 내부/);
  assert.match(validWorkdir(path.join(cfg.hubDir, 'memory'), cfg).error, /허브 내부/);
  assert.match(validWorkdir(path.join(temp, '없는폴더'), cfg).error, /없는 폴더/);
});

function fakeManager(cfg) {
  const m = Object.assign(Object.create(JobManager.prototype), { config: cfg, sessions: new Map(), jobs: new Map(), _cat: { agents: [] }, emit() {}, save() {} });
  m.sessionTools = new SessionTools(m);
  m.log = () => {};
  return m;
}

test('작업 폴더 옮기기: 기본 작업 폴더 세션만, 다음 요청은 옮겨 간 폴더에서 시작, 직접 고른 폴더·worktree 는 그대로', () => {
  const m = fakeManager(config());
  const s = { id: 's1', cwd: defaultCwd, jobIds: [] }; m.sessions.set('s1', s);
  const job = { id: 'j1', sessionId: 's1', cwd: defaultCwd, notes: [] };
  assert.equal(m.applyWorkdir(job, project), true);
  assert.equal(job.cwd, path.resolve(project)); assert.equal(s.workdir, path.resolve(project));
  assert.match(job.notes[0], /작업 폴더를 .*pixel.*로 옮겼어요/);
  assert.equal(m.startDir(s), path.resolve(project));
  // 같은 폴더면 옮기지 않음(세션 기억만 유지)
  assert.equal(m.applyWorkdir({ id: 'j2', sessionId: 's1', cwd: project, notes: [] }, project), false);
  // 잘못된 경로는 이유를 남기고 그대로
  const bad = { id: 'j3', sessionId: 's1', cwd: defaultCwd, notes: [] };
  assert.equal(m.applyWorkdir(bad, 'C:\\Windows'), false); assert.match(bad.notes[0], /쓰지 않았어요: 시스템 폴더/);
  // 예전 기본 폴더(ai-hub/workspace)도 기본으로 친다
  assert.equal(m.isDefaultDir(path.join(ROOT, 'workspace')), true);
  // 사용자가 직접 고른 폴더 세션
  const s2 = { id: 's2', cwd: other, jobIds: [] }; m.sessions.set('s2', s2);
  const j4 = { id: 'j4', sessionId: 's2', cwd: other, notes: [] };
  assert.equal(m.applyWorkdir(j4, project), false); assert.equal(j4.cwd, other); assert.match(j4.notes[0], /직접 고른 폴더/);
  assert.equal(m.startDir(s2), other);
  // worktree 세션
  const s3 = { id: 's3', cwd: defaultCwd, git: { worktree: defaultCwd }, jobIds: [] }; m.sessions.set('s3', s3);
  assert.equal(m.applyWorkdir({ id: 'j5', sessionId: 's3', cwd: defaultCwd, notes: [] }, project), false);
  // 세션 기억 폴더가 사라졌으면 세션 폴더로
  s.workdir = path.join(temp, '사라진폴더'); assert.equal(m.startDir(s), defaultCwd);
  m.config.workdir = { auto: false };
  assert.equal(m.applyWorkdir({ id: 'j6', sessionId: 's1', cwd: defaultCwd, notes: [] }, project), false);
});

test('대화 이어 쓰기 후보: 직전 완료 요청의 같은 AI·같은 폴더 마지막 작업, AI마다 한 번, 오래됐거나 다른 폴더면 없음', () => {
  const m = fakeManager(config());
  const s = { id: 's1', cwd: defaultCwd, jobIds: [] }; m.sessions.set('s1', s);
  const now = Date.now();
  const add = (id, createdAt, extra) => { const j = { id, sessionId: 's1', cwd: project, status: 'done', createdAt, finishedAt: new Date(now - 60_000).toISOString(), tasks: [], ...extra }; m.jobs.set(id, j); s.jobIds.push(id); return j; };
  add('j1', '2026-10-04T00:00:00.000Z', { tasks: [{ id: 't1', assignee: 'codex', status: 'done', sessionId: 'cx-old', finishedAt: '1' }] });
  add('j2', '2026-10-04T01:00:00.000Z', { tasks: [
    { id: 't1', assignee: 'codex', status: 'done', sessionId: 'cx-a', finishedAt: '2026-10-04T01:01:00Z' },
    { id: 't2', assignee: 'codex', status: 'done', sessionId: 'cx-b', finishedAt: '2026-10-04T01:05:00Z' },
    { id: 't3', assignee: 'claude', status: 'failed', sessionId: 'cl-x', finishedAt: '2026-10-04T01:06:00Z' },
  ] });
  const job = { id: 'j3', sessionId: 's1', cwd: project, createdAt: '2026-10-04T02:00:00.000Z' };
  assert.deepEqual(m.continuation(job, { assignee: 'codex' }), { jobId: 'j2', taskId: 't2', sessionId: 'cx-b' });
  assert.equal(m.continuation(job, { assignee: 'codex' }), null, '같은 AI·역할은 한 작업만');
  assert.equal(m.continuation(job, { assignee: 'claude' }), null, '실패한 작업은 이어 쓰지 않음');
  assert.equal(m.continuation({ ...job, id: 'j4', cwd: other }, { assignee: 'codex' }), null, '다른 폴더');
  m.jobs.get('j2').finishedAt = new Date(now - 30 * 3_600_000).toISOString();
  assert.equal(m.continuation({ ...job, id: 'j5' }, { assignee: 'codex' }), null, '24시간 지남');
  m.jobs.get('j2').finishedAt = new Date(now).toISOString();
  m.config.continuity = { resume: false };
  assert.equal(m.continuation({ ...job, id: 'j6' }, { assignee: 'codex' }), null, '끔');
});

test('세션 맥락 다이어트: 최근 N건·건당 글자 제한, 노트만', () => {
  const m = fakeManager(config());
  const s = { id: 's1', cwd: defaultCwd, jobIds: [] }; m.sessions.set('s1', s);
  for (let i = 1; i <= 5; i++) { const j = { id: `j${i}`, sessionId: 's1', goal: `요청 ${i}`, status: 'done', createdAt: `2026-10-0${i}T00:00:00.000Z`, report: `보고 ${i} ` + 'ㄱ'.repeat(5000) }; if (i === 4) Object.assign(j, { sessionNotes: [{ id: 'n00000001', text: '다크 테마' }], curation: { at: '2026-10-04T01:00:00.000Z' } }); m.jobs.set(j.id, j); s.jobIds.push(j.id); }
  const job = { id: 'j6', sessionId: 's1', createdAt: '2026-10-06T00:00:00.000Z' };
  const w = m.workerHistory(job);
  assert.match(w, /- 다크 테마/); assert.match(w, /### 이전 명령 5/); assert.match(w, /### 이전 명령 4/); assert.doesNotMatch(w, /### 이전 명령 3/);
  assert.match(w, /오래된 이전 명령 3건은 생략/);
  assert.ok(w.length < 8_000, `작업자 맥락 ${w.length}자`);
  assert.ok(!w.includes('ㄱ'.repeat(3100)), '건당 3천 자 제한');
  const p = m.planHistory(job);
  assert.match(p, /### 이전 명령 3/); assert.doesNotMatch(p, /### 이전 명령 2 /); // 1만 2천 자 안에 최근 3건
  assert.ok(p.length < 12_500, `플래너 맥락 ${p.length}자`);
  assert.equal(m.historyContext(job, 6000, { notesOnly: true }), '## 세션 결정 노트 (이 세션에서 정해진 것 — 잘리지 않음. 이번 요청이 노트와 다르면 이번 요청을 따르세요)\n- 다크 테마');
});

test('구현 후속 요청은 화면 검수·디자인 기획 대신 구현 대화를 이어 쓴다', () => {
  const m = fakeManager(config()), now = new Date().toISOString();
  const prev = { id: 'p', cwd: project, createdAt: '2026-01-01T00:00:00Z', finishedAt: now, status: 'done', tasks: [
    { id: 'd', assignee: 'codex', status: 'done', sessionId: 'design-thread', designPlan: true, finishedAt: '1' },
    { id: 'i', assignee: 'codex', status: 'done', sessionId: 'implementation-thread', finishedAt: '2' },
    { id: 'v', assignee: 'codex', status: 'done', sessionId: 'review-thread', visualCheck: true, finishedAt: '3' },
  ] };
  m.jobs.set('p', prev); m.sessions.set('s', { id: 's', jobIds: ['p'] });
  const job = () => ({ id: 'next', sessionId: 's', cwd: project, createdAt: now });
  const next = job();
  assert.equal(m.continuation(next, { assignee: 'codex', designPlan: true }).sessionId, 'design-thread');
  assert.equal(m.continuation(next, { assignee: 'codex' }).sessionId, 'implementation-thread', '기획 대화를 이었다고 같은 AI의 구현을 막지 않음');
  assert.equal(m.continuation(next, { assignee: 'codex', visualCheck: true }).sessionId, 'review-thread');
  assert.equal(m.continuation(next, { assignee: 'codex' }), null, '같은 CLI를 두 작업에 주지 않음');
  prev.tasks = prev.tasks.filter((t) => t.visualCheck);
  assert.equal(m.continuation(job(), { assignee: 'codex' }), null, '다른 역할의 대화로 대신 잇지 않음');
});

test('계획 지시문: 기본 작업 1개·요청 원문 인용·비율 맞추려 쪼개지 않기, 작업 폴더 안내는 기본 폴더 세션에서만', () => {
  const base = { goal: '5편은 3d로', cwd: defaultCwd, config: { tools: {} }, status: {}, healthy: ['claude', 'codex'], memoryCtx: '', settings: {} };
  const a = buildPlanPrompt({ ...base, workdirAuto: true, cwdLabel: '허브 기본 작업 폴더', projects: [{ path: project }, { path: defaultCwd, label: '허브 작업 공간 (기본)' }], share: { note: 'Claude 40% · Codex 60%' } });
  for (const re of [/기본은 작업 1개/, /같은 결과물의 조사·기획·구현·검증을 다른 작업으로 나누지 마세요/, /사용자 요청 원문을 먼저 그대로 인용/, /지어내지 마세요/, /비율을 맞추려고 작업을 나누지 마세요/, /# 작업 폴더 \(workdir\)/, new RegExp(project.replace(/\\/g, '\\\\')), /"workdir":""/]) assert.match(a, re);
  for (const re of [/1~6개/, /부하를 고르게/, /작업 크기를 비슷하게/, /비율에 가깝게 배정/]) assert.doesNotMatch(a, re);
  const b = buildPlanPrompt({ ...base, cwd: other });
  assert.match(b, /사용자가 고른 폴더 — workdir 는 빈 문자열로/); assert.doesNotMatch(b, /알려진 프로젝트 폴더/);
});

test('작업자 지시문: 이어 쓰는 대화는 [이어서] 안내와 노트만', () => {
  const job = { id: 'J', cwd: project, goal: '이어서 해', summary: '', intercepts: [] };
  const task = { id: 't1', title: '이어서', assignee: 'codex', prompt: '이어서 해' };
  const p = buildWorkerPrompt({ job, task, depResults: [], siblings: [task], hubDir: 'C:/hub', memoryCtx: '', historyCtx: '## 세션 결정 노트\n- 다크 테마', continued: { jobId: 'J0' } });
  assert.match(p, /\[이어서\] 이 대화는 같은 세션의 직전 요청\(J0\)을 이어서/); assert.match(p, /- 다크 테마/);
  assert.doesNotMatch(buildWorkerPrompt({ job, task, depResults: [], siblings: [task], hubDir: 'C:/hub', memoryCtx: '' }), /\[이어서\]/);
});

// 공유 메모리 선택기(~/.ai-shared/sync/memory-context.cjs)가 없는 PC에서는 건너뛴다.
const sharedContext = path.join(os.homedir(), '.ai-shared', 'sync', 'memory-context.cjs');
test('메모리 다이어트: 작업자 지시문에 전역 메모리 목록이 없고 단계별 한도 안', { skip: !fs.existsSync(sharedContext) && `${sharedContext} 가 없어 건너뜀` }, () => {
  const cfg = config();
  const mem = path.join(cfg.hubDir, 'memory');
  fs.mkdirSync(path.join(mem, 'global'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'global', 'MEMORY.md'), '# 공용 메모리 (전역)\n' + Array.from({ length: 200 }, (_, i) => `- [무관 ${i}](x${i}.md) — 영상 트레이딩 폰트 ${i}`).join('\n'));
  fs.writeFileSync(path.join(mem, 'global', 'pixel-engine.md'), '---\nname: pixel-engine\ndescription: 픽셀 쇼츠 엔진 3d\nmetadata:\n  type: project\n---\n픽셀 엔진은 E:/02 에 있다');
  fs.mkdirSync(path.join(cfg.hubDir, 'sync'), { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.ai-shared', 'sync', 'memory-context.cjs'), path.join(cfg.hubDir, 'sync', 'memory-context.cjs'));
  const m = fakeManager(cfg);
  const job = { id: 'jm', cwd: project, goal: '픽셀 3d', intercepts: [], runDir: mk('runs', 'jm') };
  const text = m.memoryFor(job, 'worker', { id: 't1', title: '픽셀 3d', prompt: '픽셀 쇼츠 3d' });
  assert.doesNotMatch(text, /전역 인덱스/); assert.doesNotMatch(text, /무관 150/);
  assert.match(text, /픽셀 엔진은 E:\/02 에 있다/);
  assert.ok(text.length <= 8_000, `작업자 메모리 ${text.length}자`);
  assert.ok(m.memoryFor(job, 'report').length <= 5_000);
  m.config.context = { globalIndex: true };
  assert.match(m.memoryFor(job, 'worker', { id: 't1', title: '픽셀', prompt: '픽셀' }), /전역 인덱스/);
});
