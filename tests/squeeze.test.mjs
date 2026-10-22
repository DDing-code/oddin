// 리셋 시간 대비 한도 — 쥐어짜기(2026-10-22 사용자 "리셋 시간 대비 한도가 많이 남았으면 좀 쥐어짜서 쓰게 해줘")
// 실제 모델 호출 없음. Codex 모델 목록·평소 설정은 임시 CODEX_HOME 으로 대신한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-squeeze-'));
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: EFFORTS },
  { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: EFFORTS },
] }));
process.env.CODEX_HOME = home;
process.env.HUB_DATA_DIR = path.join(home, 'data');
process.env.HUB_RUNS_DIR = path.join(home, 'runs');
test.after(() => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {} });

const { windowPace, spare, spendRate, balanceShare } = await import('../lib/usage.mjs');
const { finalizeChoice, designTarget, raiseToStandalone, usageText } = await import('../lib/router.mjs');
const { JobManager } = await import('../lib/jobs.mjs');

const H = 3_600_000, D = 24 * H, NOW = Date.now();
const at = (ms) => new Date(NOW + ms).toISOString();
// Claude: 5시간·주간·Fable 주간, Codex: 주간(w10080)
const claude = ({ five = 20, fiveLeft = 3 * H, week = 80, weekLeft = 3 * H, fable = 69 } = {}) => ({ windows: [
  { key: 'five_hour', label: '5시간', usedPercent: five, resetsAt: at(fiveLeft) },
  { key: 'seven_day', label: '주간', usedPercent: week, resetsAt: at(weekLeft) },
  { key: 'model_fable', label: 'Fable 주간', usedPercent: fable, resetsAt: at(weekLeft), scope: 'model', model: 'fable' },
] });
const codex = (week = 21, left = 5.2 * D) => ({ windows: [{ key: 'w10080', label: '주간', usedPercent: week, resetsAt: at(left) }] });

test('창 속도·쥐어짜기 단계: 리셋 전에 버려질 몫(남은 % − 남은 시간 비율)으로 판단, 5시간 한도가 차면·모르면·끄면 평소', () => {
  const p = windowPace({ key: 'seven_day', label: '주간', usedPercent: 80, resetsAt: at(3 * H) }, NOW);
  assert.equal(Math.round(p.slack), 18); assert.equal(p.long, true);
  assert.equal(windowPace({ key: 'seven_day', usedPercent: 80 }, NOW), null, '리셋 시각을 모르면 판단하지 않음');
  // 오늘 실제 상황: Claude 주간 80%·3시간 뒤 리셋 → 1단계(남은 20%가 그대로 버려질 판)
  const now = { claude: claude(), codex: codex() };
  const c = spare(now, 'claude', { now: NOW });
  assert.equal(c.level, 1); assert.match(c.note, /^주간 한도가 리셋\(3시간 뒤\)까지 20% 남아 아끼지 않고 씀$/);
  assert.equal(spare(now, 'claude', { model: 'fable', now: NOW }).level, 1, 'Fable 전용 창(slack 29)과 Claude 주간 중 빠듯한 쪽');
  assert.equal(spare(now, 'codex', { now: NOW }).level, 0, 'Codex 주간 21%·5일 남음은 고르게 쓰는 중');
  // 많이 남음 → 2단계, 같은 80%여도 6일 남았으면 평소
  assert.equal(spare({ codex: codex(40, 1 * D) }, 'codex', { now: NOW }).level, 2);
  assert.equal(spare({ claude: claude({ weekLeft: 6 * D }) }, 'claude', { now: NOW }).level, 0);
  // 5시간 한도가 80% 이상이면 곧 막히니 평소, 남은 게 5% 미만도 평소, 끄면 평소
  assert.deepEqual(spare({ claude: claude({ five: 85 }) }, 'claude', { now: NOW }), { level: 0, slack: null, note: '5시간 한도가 차서' });
  assert.equal(spare({ claude: claude({ week: 97, weekLeft: 10 * 60_000 }) }, 'claude', { now: NOW }).level, 0);
  assert.equal(spare(now, 'claude', { now: NOW, config: { squeeze: { enabled: false } } }).level, 0);
  assert.equal(spare(null, 'claude').level, 0);
});

test('분배 비율: 리셋까지 시간당 쓸 수 있는 몫으로 — 곧 리셋되는 쪽에 일을 더, 끄면 예전처럼 남은 한도로', () => {
  const now = { claude: claude(), codex: codex() };
  assert.ok(spendRate(now, 'claude', NOW) > spendRate(now, 'codex', NOW));
  const s = balanceShare(now, ['claude', 'codex'], { now: NOW });
  assert.ok(s.claude > 0.5, `Claude 가 더 받음: ${s.claude}`); assert.match(s.note, /^리셋까지 남은 시간 대비 남은 한도 기준 권장 분배/);
  const old = balanceShare(now, ['claude', 'codex'], { now: NOW, config: { squeeze: { enabled: false } } });
  assert.equal(Math.round(old.claude * 100), 20); assert.match(old.note, /^남은 한도 기준/);
  assert.equal(balanceShare({ claude: claude({ week: 96 }), codex: codex() }, ['claude', 'codex'], { now: NOW }).claude, 0, '95% 넘게 쓴 쪽은 곧 리셋이어도 그대로 뺌');
});

test('라우터 안전장치: 75%·Fable 75%·90% 강도 제한·디자인 기획 넘기기를 리셋 전에 남는 몫이면 풀기', () => {
  const AUTO = { model: 'auto', effort: 'auto' };
  const soon = { claude: claude({ week: 80, fable: 80 }), codex: codex() };
  const late = { claude: claude({ week: 80, weekLeft: 6 * D, fable: 80 }), codex: codex() };
  const a = finalizeChoice({}, 'claude', AUTO, { model: 'fable', effort: 'xhigh' }, soon);
  assert.equal(a.model, 'fable', '곧 리셋 → Fable 그대로'); assert.match(a.reason, /Fable 주간 80%지만 주간 한도가 리셋\(3시간 뒤\)까지 20% 남아/);
  assert.equal(finalizeChoice({}, 'claude', AUTO, { model: 'fable', effort: 'xhigh' }, late).model, 'opus', '6일 남았으면 예전처럼 Opus');
  const hi = { codex: codex(92, 2 * H) };
  assert.equal(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'high', hi).effort, 'high', '92%·2시간 남음은 남은 8%라 slack 이 작아 그대로');
  const hi2 = { codex: codex(90, 30 * 60_000) };
  assert.equal(spare(hi2, 'codex').level, 0);
  const roomy = { codex: codex(91, 1 * H) }; // 남은 9% − 0.6 = 8.4 → 평소
  assert.equal(raiseToStandalone({}, 'codex', 'gpt-6.1-sol', 'high', roomy).effort, 'high');
  const DR = { designRule: { enabled: true, mode: 'split', tool: 'claude', model: 'fable', switchAt: 75 } };
  const settings = { claude: AUTO, codex: AUTO };
  const keep = designTarget(DR, { usage: soon, usable: ['claude', 'codex'], settings });
  assert.equal(keep.switched, false); assert.match(keep.note, /fable 주간 한도 80%지만 .*\(Claude·fable 유지\)/);
  assert.equal(designTarget(DR, { usage: late, usable: ['claude', 'codex'], settings }).switched, true, '6일 남았으면 예전처럼 Astra 로');
  const text = usageText(soon);
  assert.match(text, /claude: 5시간 20% 사용\(리셋 3시간 뒤\), 주간 80% 사용\(리셋 3시간 뒤\)/);
  assert.match(text, /→ 리셋 전에 다 못 쓸 한도가 남았어요\(주간 한도가 리셋\(3시간 뒤\)까지 20% 남아 아끼지 않고 씀\)/);
  assert.doesNotMatch(usageText(late), /→ 리셋 전에/);
});

const AUTO = () => ({ claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } });
const manager = (config = {}) => Object.assign(Object.create(JobManager.prototype), { config: { tools: {}, defaults: {}, ...config }, _cat: { agents: [] }, sessions: new Map(), jobs: new Map() });

test('작업 배정: 1단계는 최상위 모델 허용·강도 xhigh, 2단계는 최상위 모델로 올림, 질문·작은 수정·속도 우선·직접 고른 값은 그대로', () => {
  const m = manager();
  const run = (usage, choice, jobExtra = {}, taskExtra = {}) => { const t = { id: 't1', title: '로그 파서 수정', prompt: '파서', assignee: 'codex', ...taskExtra }; m.applyChoice({ mode: 'auto', settings: { ...AUTO(), pace: 'quality' }, tasks: [t], input: '', ...jobExtra }, t, { reason: '', ...choice }, usage); return t; };
  const lvl1 = { codex: codex(75, 0.3 * D) }; // 남은 25 − 4.3 ≈ 20.7 → 1단계
  const lvl2 = { codex: codex(40, 1 * D) };   // 60 − 14.3 ≈ 45.7 → 2단계
  const normal = { codex: codex(21, 5.2 * D) };
  let t = run(normal, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual([t.settings.model, t.settings.effort], ['gpt-6.1-sol', 'high'], '평소는 그대로');
  assert.equal(run(normal, { model: 'gpt-6-astra', effort: 'high' }).settings.model, 'gpt-6.1-sol', '평소엔 최상위 모델을 막음');
  t = run(lvl1, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual([t.settings.model, t.settings.effort], ['gpt-6.1-sol', 'xhigh']); assert.match(t.reason, /아끼지 않고 씀 — 강도 xhigh/);
  assert.equal(run(lvl1, { model: 'gpt-6-astra', effort: 'high' }).settings.model, 'gpt-6-astra', '1단계는 계획이 고른 최상위 모델을 막지 않음');
  t = run(lvl2, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual([t.settings.model, t.settings.effort], ['gpt-6-astra', 'xhigh']); assert.match(t.reason, /최상위 모델로/);
  // 질문·작은 수정·속도 우선은 빨리 끝내는 게 먼저
  assert.equal(run(lvl2, { model: 'gpt-6.1-sol', effort: 'high' }, { answer: true }).settings.effort, 'high');
  assert.equal(run(lvl2, { model: 'gpt-6.1-sol', effort: 'high' }, { fast: true }).settings.model, 'gpt-6.1-sol');
  assert.equal(run(lvl2, { model: 'gpt-6.1-sol', effort: 'high' }, { settings: { ...AUTO(), pace: 'speed' } }).settings.effort, 'high');
  // 직접 고른 값은 그대로
  t = run(lvl2, { model: 'gpt-6.1-sol', effort: 'high' }, { settings: { ...AUTO(), codex: { model: 'gpt-6.1-sol', effort: 'high' }, pace: 'quality' } });
  assert.deepEqual([t.settings.model, t.settings.effort], ['gpt-6.1-sol', 'high']);
  // 목표 모드·눈으로 확인의 "high 까지"도 풀림, 상한(maxEffort)은 넘지 않음
  assert.equal(run(lvl1, { model: 'gpt-6.1-sol', effort: 'high' }, { goalRound: 3 }).settings.effort, 'xhigh');
  assert.equal(run(normal, { model: 'gpt-6.1-sol', effort: 'xhigh' }, { goalRound: 3 }).settings.effort, 'high');
  // 끄면 예전 그대로
  const off = manager({ squeeze: { enabled: false } });
  const t2 = { id: 't1', title: '로그 파서 수정', prompt: '파서', assignee: 'codex' };
  off.applyChoice({ mode: 'auto', settings: { ...AUTO(), pace: 'quality' }, tasks: [t2], input: '' }, t2, { model: 'gpt-6.1-sol', effort: 'high', reason: '' }, lvl2);
  assert.deepEqual([t2.settings.model, t2.settings.effort], ['gpt-6.1-sol', 'high']);
});

test('눈으로 확인·재배정: 확인 담당 한도가 남으면 확인을 붙이고, 많이 썼어도 곧 리셋되는 쪽에서 일을 빼지 않음', () => {
  const m = manager();
  const c = { tool: 'codex', model: 'gpt-6-astra' };
  const job = { input: '화면 고쳐줘', goal: '화면 고쳐줘', settings: { pace: 'quality' } };
  const t = { title: '화면 고치기', checkScope: 'full' };
  assert.equal(m.needsVisualCheck(job, t, c, { codex: codex(21) }), false, '평소: 디자인 구현·첫 시안·요청이 아니면 스스로 확인');
  assert.equal(m.needsVisualCheck(job, t, c, { codex: codex(40, 1 * D) }), true, '확인 담당 한도가 남으면 따로 확인');
  assert.equal(m.needsVisualCheck({ ...job, fast: true }, t, c, { codex: codex(40, 1 * D) }), false);
  // 재배정: Claude 85%라도 3시간 뒤 리셋이면 Codex 로 옮기지 않음
  const tasks = () => [1, 2, 3, 4].map((i) => ({ id: `t${i}`, title: `작업 ${i}`, assignee: 'claude', dependsOn: [] }));
  const share = { claude: 0.25, codex: 0.75 };
  const soonJob = { tasks: tasks(), notes: [] };
  m.rebalance(soonJob, { claude: claude({ week: 85, fable: 50 }), codex: codex() }, ['claude', 'codex'], share, () => '', (x) => x);
  assert.equal(soonJob.tasks.filter((x) => x.assignee === 'codex').length, 0);
  const lateJob = { tasks: tasks(), notes: [] };
  m.rebalance(lateJob, { claude: claude({ week: 85, weekLeft: 6 * D, fable: 50 }), codex: codex() }, ['claude', 'codex'], share, () => 'Claude 한도', (x) => x);
  assert.equal(lateJob.tasks.filter((x) => x.assignee === 'codex').length, 3, '리셋이 멀면 예전처럼 옮김');
});
