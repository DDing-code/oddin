// "단순 질문에도 10분 넘게"(2026-10-05): 질문 바로 답하기 · 강도 상한 · 기억 정리 대기 단축
// 실제 모델 호출 없음. Codex 평소 설정은 임시 CODEX_HOME 의 config.toml(max)로 대신한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-speed-'));
fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n');
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
] }));
process.env.CODEX_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { raiseToStandalone } = await import('../lib/router.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
const usage = () => ({ codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: 10 }] }, claude: { windows: [{ key: 'seven_day', label: '주간', usedPercent: 10 }] } });
const AUTO = () => ({ claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } });
const manager = (config = {}) => Object.assign(Object.create(JobManager.prototype), { config: { tools: {}, defaults: {}, ...config }, _cat: { agents: [] }, sessions: new Map(), jobs: new Map() });

test('질문 판정: 물음표로 끝나고 작업 요청 말이 없을 때만', () => {
  const m = manager();
  const q = (s, extra = {}) => m.isQuestion({ input: s, goal: s, ...extra });
  for (const s of ['새로운 규칙 및 모델 엔진 적용했어?', '5편 언제 끝나?', '지금 Fable 한도 얼마나 남았어?', '이 폴더 구조가 어떻게 돼？']) assert.equal(q(s), true, s);
  for (const s of ['레퍼런스들에 비해 퀄리티가 왜 이렇게 별로지;;', '이거 고쳐줄 수 있어?', '배경 소품 더 넣어줄래?', '다시 시안 좀 뽑아봐', '원인 조사해줄래?', '오딘이 느려']) assert.equal(q(s), false, s);
  assert.equal(q('적용했어?', { goalId: 'g1' }), false, '목표 모드');
  assert.equal(q('적용했어?', { command: { kind: 'command', name: 'review' } }), false, '커맨드');
  assert.equal(q('ㄱ'.repeat(301) + '?'), false, '긴 글');
  assert.equal(manager({ answerPath: { enabled: false } }).isQuestion({ input: '적용했어?' }), false, '끔');
});

test('질문에 답할 AI: 이 세션에서 마지막으로 일한 AI(눈으로 확인 작업 제외), 못 쓰면 빠른 선택', () => {
  const m = manager();
  m.pickFastTool = () => 'claude';
  const s = { id: 's1', jobIds: ['j1'] }; m.sessions.set('s1', s);
  m.jobs.set('j1', { id: 'j1', status: 'done', tasks: [
    { id: 't1', assignee: 'codex', status: 'done', finishedAt: '2026-10-05T01:00:00Z' },
    { id: 't1v', assignee: 'claude', status: 'done', finishedAt: '2026-10-05T01:10:00Z', visualCheck: true },
  ] });
  assert.equal(m.answerTool({ id: 'j2', sessionId: 's1' }, ['claude', 'codex'], null, {}), 'codex');
  assert.equal(m.answerTool({ id: 'j2', sessionId: 's1' }, ['claude'], null, {}), 'claude', 'Codex 를 못 쓰면');
  assert.equal(m.answerTool({ id: 'j3', sessionId: '없음' }, ['claude', 'codex'], null, {}), 'claude', '새 세션');
});

test('강도 상한: 평소 설정이 max 여도 xhigh 까지만, 상한을 바꿀 수 있음', () => {
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'high', usage()), { effort: 'xhigh', note: '평소 설정(max) 대신 상한 xhigh로 — 품질 우선' });
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'high', usage(), { cap: 'max' }), { effort: 'max', note: '평소 단독 설정 강도(max)에 맞춤 — 품질 우선' });
  assert.deepEqual(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'xhigh', usage()), { effort: 'xhigh' });
});

test('품질 우선이어도 질문 답·디자인 기획·눈으로 확인은 강도를 올리지 않음, 일반 작업은 상한 xhigh', () => {
  const m = manager();
  const run = (task, jobExtra = {}) => { const job = { mode: 'auto', settings: { ...AUTO(), pace: 'quality' }, tasks: [task], input: '', ...jobExtra }; m.applyChoice(job, task, { model: 'gpt-6.1-sol', effort: 'high', reason: '' }, usage()); return task.settings.effort; };
  assert.equal(run({ id: 't1', title: '로그 파서 수정', prompt: '파서', assignee: 'codex' }), 'xhigh');
  assert.equal(run({ id: 't1', title: '적용했어?', prompt: '적용했어?', assignee: 'codex' }, { answer: true }), 'high');
  assert.equal(run({ id: 't1v', title: '눈으로 확인: 시안', prompt: '확인', assignee: 'codex', visualCheck: true }), 'high');
  assert.equal(run({ id: 't1d', title: '디자인 기획: 시안', prompt: '기획', assignee: 'codex', designPlan: true }), 'high');
  // 상한을 max 로 바꾸면 평소 설정(max)까지
  const mx = manager({ quality: { maxEffort: 'max' } });
  const t = { id: 't1', title: '로그 파서 수정', prompt: '파서', assignee: 'codex' };
  mx.applyChoice({ mode: 'auto', settings: { ...AUTO(), pace: 'quality' }, tasks: [t], input: '' }, t, { model: 'gpt-6.1-sol', effort: 'high' }, usage());
  assert.equal(t.settings.effort, 'max');
});

test('기억 정리 대기: 기본 20초, 설정으로 바꿈', async () => {
  const m = manager({ memory: { waitSeconds: 0.05 } });
  m._curations = new Map([['s1', new Promise(() => {})]]);
  const t0 = Date.now(); await m.waitCuration('s1');
  assert.ok(Date.now() - t0 < 1000);
});
