// Fable 전용 주간 한도에 따른 디자인 기획 전환 (사용자 요구 2026-10-04: "페이블 주간사용량 높으면 디자인 기획 아스트라에 넘겨")
// 실제 모델 호출 없음. Codex 모델 목록은 임시 CODEX_HOME 의 고정 자료로 대신한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-design-switch-'));
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: EFFORTS },
  { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: EFFORTS },
] }));
process.env.CODEX_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { designRule, designTarget, applyDesignModel, catalogText, usageText, badModels, markUnsupported } = await import('../lib/router.mjs');
const { balanceShare } = await import('../lib/usage.mjs');
const { buildPlanPrompt } = await import('../lib/planner.mjs');
const { JobManager } = await import('../lib/jobs.mjs');

const AUTO = { model: 'auto', effort: 'auto' };
const autoSettings = () => ({ claude: { ...AUTO }, codex: { ...AUTO } });
const BOTH = ['claude', 'codex'];
/** fable = Fable 전용 주간 사용률(undefined 면 전용 창 없음 = 미확인), 나머지는 전체 한도 */
const usage = (fable, { claudeWeek = 60, claude5h = 7, codexWeek = 9 } = {}) => ({
  claude: { windows: [
    { key: 'five_hour', label: '5시간', usedPercent: claude5h },
    { key: 'seven_day', label: '주간', usedPercent: claudeWeek },
    ...(fable === undefined ? [] : [{ key: 'model_fable', label: 'Fable 주간', scope: 'model', model: 'fable', usedPercent: fable }]),
  ] },
  codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: codexWeek }] },
});
const manager = (config = {}, agents = []) => Object.assign(Object.create(JobManager.prototype), { config, _cat: { agents } });
const name = (t) => (t === 'claude' ? 'Claude' : 'Codex');
const target = (u, opts = {}) => designTarget({}, { usage: u, usable: BOTH, settings: autoSettings(), ...opts });

test('전환 기준: 75% 직전은 Fable, 정확히 75%와 현재 82%는 Codex·Astra', () => {
  const below = target(usage(74.9));
  assert.deepEqual([below.tool, below.model, below.switched, below.note], ['claude', 'fable', false, null]);
  for (const p of [75, 82]) {
    const t = target(usage(p));
    assert.deepEqual([t.tool, t.model, t.switched], ['codex', 'gpt-6-astra', true], `${p}%`);
    assert.match(t.note, new RegExp(`${p}%.*75%.*Codex·gpt-6-astra에 넘김`));
  }
  assert.deepEqual(designRule({}), { tool: 'claude', model: 'fable', switchAt: 75, fallback: { tool: 'codex', model: 'gpt-6-astra' } });
});

test('사용률 미확인은 0%로도 초과로도 보지 않는다: 전환 없이 기본 담당 유지, 이유도 지어내지 않음', () => {
  const nan = usage(82); nan.claude.windows[2].usedPercent = 'abc';
  for (const u of [null, undefined, {}, { claude: { status: 'unavailable', windows: [] } }, usage(undefined), nan]) {
    const t = target(u);
    assert.deepEqual([t.tool, t.model, t.switched, t.percent, t.note], ['claude', 'fable', false, null, null]);
  }
  // 미확인이면 계획 지시문에도 기존 담당이 적힌다
  assert.match(catalogText({}, { usage: usage(undefined), usable: BOTH, settings: autoSettings() }), /기획만\*\* 담당 claude·모델 fable/);
});

test('Claude 전체 주간 사용률과 Fable 전용 사용률을 섞지 않는다', () => {
  // 전체 주간 99%여도 Fable 전용이 낮으면 그대로, 전체가 낮아도 Fable 전용이 높으면 전환
  assert.equal(target(usage(10, { claudeWeek: 99, claude5h: 99 })).switched, false);
  assert.equal(target(usage(82, { claudeWeek: 1, claude5h: 1 })).switched, true);
  // 전용 창이 없으면 전체 주간 값을 대신 쓰지 않는다
  assert.equal(target(usage(undefined, { claudeWeek: 99 })).switched, false);
  // 다른 모델의 전용 창도 대신 쓰지 않는다
  const other = usage(undefined); other.claude.windows.push({ label: 'Opus 주간', scope: 'model', model: 'opus', usedPercent: 99 });
  assert.equal(target(other).switched, false);
});

test('설정으로 기준·대상을 바꾸거나 끌 수 있다', () => {
  const ctx = { usage: usage(82), usable: BOTH, settings: autoSettings() };
  assert.equal(designTarget({ designRule: { switchAt: 90 } }, ctx).switched, false);
  assert.equal(designTarget({ designRule: { switchAt: 80 } }, ctx).switched, true);
  assert.equal(designTarget({ designRule: { fallback: false } }, ctx).switched, false);
  assert.equal(designTarget({ designRule: { enabled: false } }, ctx), null);
});

test('사용자가 직접 고른 모델·분배 방식·강도가 우선한다', () => {
  const u = usage(82);
  // Claude 모델을 직접 고름(Fable 고정 포함) → 전환하지 않음
  for (const model of ['fable', 'opus', '']) assert.equal(target(u, { settings: { claude: { model, effort: 'auto' }, codex: { ...AUTO } } }).switched, false, `claude=${model}`);
  // Codex 모델을 다른 것으로 직접 고름 → Astra 로 덮어쓰지 않고 이유를 남김
  const sol = target(u, { settings: { claude: { ...AUTO }, codex: { model: 'gpt-6.1-sol', effort: 'auto' } } });
  assert.equal(sol.switched, false); assert.equal(sol.tool, 'claude'); assert.match(sol.note, /직접 고르셔서\(gpt-6\.1-sol\).*넘기지 못함/);
  // Codex 를 Astra 로 직접 고른 경우는 전환과 같은 방향
  assert.equal(target(u, { settings: { claude: { ...AUTO }, codex: { model: 'gpt-6-astra', effort: 'high' } } }).switched, true);

  // 분배 방식이 Claude만·Codex만이면 디자인 규칙 자체가 담당을 옮기지 않는다
  const self = manager();
  for (const mode of ['claude', 'codex', 'both']) {
    const job = { mode, notes: [], goal: '로고 디자인 기획', settings: autoSettings(), tasks: [{ id: 't1', title: '디자인 기획: 로고', assignee: mode === 'codex' ? 'codex' : 'claude', prompt: '로고', dependsOn: [] }] };
    assert.equal(self.enforceDesignRule(job, BOTH, name, u).length, 0);
    assert.equal(job.tasks[0].assignee, mode === 'codex' ? 'codex' : 'claude'); assert.ok(!job.tasks[0].designPlan);
  }

  // 사용자가 고정한 강도는 전환 뒤에도 그대로 (자동 강도 낮춤 규칙도 적용되지 않음)
  const job = { mode: 'auto', notes: [], goal: 'x', settings: { claude: { ...AUTO }, codex: { model: 'auto', effort: 'xhigh' } }, tasks: [{ id: 't1', title: '디자인 기획: 로고', assignee: 'claude', prompt: '로고 명세', dependsOn: [], agent: null }] };
  self.enforceDesignRule(job, BOTH, name, u);
  self.applyChoice(job, job.tasks[0], { model: 'fable', effort: 'high', reason: '디자인' }, u);
  assert.deepEqual(job.tasks[0].settings, { model: 'gpt-6-astra', effort: 'xhigh' });
});

test('Astra 미지원·Codex 제외: 전환하지 않고 기존 처리(Fable 유지)로 가며 이유를 남긴다', () => {
  const self = manager();
  const run = (usable, u = usage(82)) => {
    const job = { mode: 'auto', notes: [], goal: 'x', settings: autoSettings(), tasks: [{ id: 't1', title: '디자인 기획: 설정 화면', assignee: 'claude', prompt: '명세', dependsOn: [], agent: null }] };
    self.enforceDesignRule(job, usable, name, u);
    self.applyChoice(job, job.tasks[0], { model: 'opus', effort: 'high', reason: '기획' }, u);
    return job;
  };
  markUnsupported('gpt-6-astra');
  try {
    const t = target(usage(82));
    assert.equal(t.switched, false); assert.match(t.note, /gpt-6-astra 모델이 지원 안 됨이라.*넘기지 못함/);
    const job = run(BOTH);
    assert.equal(job.tasks[0].assignee, 'claude'); assert.equal(job.tasks[0].model, 'fable');
    assert.match(job.tasks[0].reason, /지원 안 됨/); assert.match(job.notes.join('\n'), /지원 안 됨/);
  } finally { badModels.delete('gpt-6-astra'); }
  // Codex 를 쓸 수 없음(로그인 안 됨·한도 95% 이상으로 제외)
  const noCodex = run(['claude']);
  assert.equal(noCodex.tasks[0].assignee, 'claude'); assert.equal(noCodex.tasks[0].model, 'fable');
  assert.match(noCodex.tasks[0].reason, /Codex를 지금 쓸 수 없어/); assert.match(noCodex.notes.join('\n'), /넘기지 못함/);
  // 전환 못 한 상태에서 Fable 전용 한도가 95% 이상이면 기존 규칙대로 기존 선택(Opus) 유지 + 두 이유 모두 남김
  const crit = run(['claude'], usage(96));
  assert.equal(crit.tasks[0].model, 'opus'); assert.match(crit.tasks[0].reason, /전용 한도 96%/); assert.match(crit.tasks[0].reason, /넘기지 못함/);
  // 다시 지원되면 정상 전환
  assert.equal(run(BOTH).tasks[0].model, 'gpt-6-astra');
});

test('기획 분리: 기획만 Astra, 구현·검증은 기본 모델(Sol·Opus) 유지', () => {
  const self = manager();
  const make = () => ({ mode: 'auto', notes: [], goal: 'x', input: 'x', settings: autoSettings(), tasks: [
    { id: 't1', title: '설정 화면 UI 개편하고 CSS로 구현', assignee: 'claude', prompt: '설정 화면을 바꿔', dependsOn: [], agent: null },
    { id: 't2', title: '서버 API 구현', assignee: 'claude', prompt: 'API', dependsOn: [], agent: null },
  ] });
  // 82%: 플래너가 구현 작업에 최상위 모델을 골랐어도 Astra·Fable 은 기획에만
  const u = usage(82); const job = make();
  const added = self.enforceDesignRule(job, BOTH, name, u);
  assert.equal(added.length, 1);
  self.applyChoice(job, job.tasks[0], { model: 'gpt-6-astra', effort: 'high', reason: '구현' }, u);
  self.applyChoice(job, job.tasks[1], { model: 'fable', effort: 'high', reason: 'API' }, u);
  for (const t of added) self.applyChoice(job, t, { reason: '디자인 기획' }, u);
  const [impl, api, plan] = job.tasks;
  assert.match(plan.title, /^디자인 기획: /); assert.equal(plan.designPlan, true);
  assert.deepEqual([plan.assignee, plan.model, plan.effort], ['codex', 'gpt-6-astra', 'high']);
  assert.match(plan.reason, /fable 주간 한도 82%.*넘김/); assert.doesNotMatch(plan.reason, /최상위 모델은/);
  assert.deepEqual([impl.assignee, impl.model, impl.designImpl], ['codex', 'gpt-6.1-sol', true]);
  assert.deepEqual(impl.dependsOn, ['t1d']); assert.match(impl.prompt, /디자인 명세 준수/);
  assert.deepEqual([api.assignee, api.model], ['claude', 'opus']); // 디자인과 무관한 작업은 그대로, Fable 도 쓰지 않음
  assert.match(job.notes.join('\n'), /기획\(Codex·gpt-6-astra\) → 구현·검증\(Codex\)/);
  assert.match(job.notes.join('\n'), /넘김 \(구현·검증은 기본 모델 그대로\)/);
  assert.ok(job.tasks.every((t) => t.designPlan || !['fable', 'gpt-6-astra'].includes(t.model)));

  // 74%: 기존 구조 그대로 (기획 Claude·Fable → 구현 Codex·Sol)
  const low = usage(74); const job2 = make();
  const added2 = self.enforceDesignRule(job2, BOTH, name, low);
  self.applyChoice(job2, job2.tasks[0], { model: 'gpt-6.1-sol', effort: 'high' }, low);
  for (const t of added2) self.applyChoice(job2, t, { reason: '디자인 기획' }, low);
  assert.deepEqual([job2.tasks[2].assignee, job2.tasks[2].model], ['claude', 'fable']);
  assert.deepEqual([job2.tasks[0].assignee, job2.tasks[0].model], ['codex', 'gpt-6.1-sol']);
  assert.doesNotMatch(job2.notes.join('\n'), /넘김/);

  // 플래너가 이미 "디자인 기획" 작업을 Claude·fable 로 계획했어도 82%면 Codex·Astra 로 옮기고 Opus 로 강등하지 않는다
  const pre = { mode: 'auto', notes: [], goal: 'x', settings: autoSettings(), tasks: [
    { id: 'a', title: '디자인 기획: 대시보드', assignee: 'claude', prompt: '명세', dependsOn: [], agent: null },
    { id: 'b', title: '대시보드 UI 구현', assignee: 'claude', prompt: '구현', dependsOn: ['a'], agent: null },
  ] };
  assert.equal(self.enforceDesignRule(pre, BOTH, name, u).length, 0);
  self.applyChoice(pre, pre.tasks[0], { model: 'fable', effort: 'high', reason: '디자인 기획' }, u);
  self.applyChoice(pre, pre.tasks[1], { model: 'opus', effort: 'high', reason: '구현' }, u);
  assert.deepEqual([pre.tasks[0].assignee, pre.tasks[0].model], ['codex', 'gpt-6-astra']);
  assert.doesNotMatch(pre.tasks[0].reason, /opus|대신/);
  assert.deepEqual([pre.tasks[1].assignee, pre.tasks[1].model, pre.tasks[1].dependsOn], ['codex', 'gpt-6.1-sol', ['a']]);
});

test('한도 재배정 뒤에도 디자인 기획 담당은 유지된다', () => {
  const self = manager();
  const flow = (u) => {
    const job = { mode: 'auto', notes: [], goal: 'x', settings: autoSettings(), tasks: [
      { id: 't1', title: '디자인 기획: 프로필 시안', assignee: 'claude', prompt: '명세', dependsOn: [], agent: null },
      { id: 't2', title: '서버 로그 정리', assignee: 'codex', prompt: 'x', dependsOn: [], agent: null },
      { id: 't3', title: '빌드 스크립트 수정', assignee: 'codex', prompt: 'x', dependsOn: [], agent: null },
      { id: 't4', title: '데이터 변환', assignee: 'codex', prompt: 'x', dependsOn: [], agent: null },
    ] };
    // run() 과 같은 순서: 재배정 → 디자인 규칙 → 모델 결정
    self.rebalance(job, u, BOTH, balanceShare(u, BOTH), (t) => `${t} 한도`, name);
    self.enforceDesignRule(job, BOTH, name, u);
    for (const t of job.tasks) self.applyChoice(job, t, { model: t.assignee === 'claude' ? 'opus' : 'gpt-6.1-sol', effort: 'high' }, u);
    return job;
  };
  // Codex 전체 한도가 높아 작업이 Claude 로 옮겨져도, Fable 82%면 디자인 기획은 Codex·Astra
  const moved = flow(usage(82, { codexWeek: 88, claudeWeek: 20 }));
  assert.match(moved.notes.join('\n'), /옮겼어요/);
  assert.deepEqual([moved.tasks[0].assignee, moved.tasks[0].model], ['codex', 'gpt-6-astra']);
  assert.ok(moved.tasks.slice(1).every((t) => !['fable', 'gpt-6-astra'].includes(t.model)));
  // Claude 전체 한도가 높아 Claude 작업을 줄이는 중이어도, Fable 전용이 74%면 디자인 기획은 Claude·Fable
  const kept = flow(usage(74, { claudeWeek: 88, codexWeek: 9 }));
  assert.deepEqual([kept.tasks[0].assignee, kept.tasks[0].model], ['claude', 'fable']);
  // 같은 결정을 다시 적용해도 담당·모델이 바뀌지 않는다 (재시도·보완 계획에서 기존 설정 재사용)
  const again = moved.tasks[0];
  self.enforceDesignRule(moved, BOTH, name, usage(10));
  self.applyChoice(moved, again, { model: 'fable', effort: 'high' }, usage(10));
  assert.deepEqual([again.assignee, again.model], ['codex', 'gpt-6-astra']);
});

test('Claude 전용 역할이 붙은 기획 작업은 역할 지정이 우선', () => {
  const self = manager({}, [{ name: 'frontend', tool: 'claude', model: 'auto', effort: 'auto' }, { name: 'tester', tool: 'codex', model: 'auto', effort: 'auto' }]);
  const u = usage(82);
  const job = { mode: 'auto', notes: [], goal: 'x', settings: autoSettings(), tasks: [
    { id: 't1', title: '디자인 기획: 사이드바', assignee: 'claude', agent: 'frontend', prompt: '명세', dependsOn: [] },
    { id: 't2', title: '디자인 기획: 아이콘', assignee: 'claude', agent: null, prompt: '명세', dependsOn: [] },
  ] };
  self.enforceDesignRule(job, BOTH, name, u);
  assert.equal(job.tasks[0].assignee, 'claude'); assert.match(job.tasks[0].designTarget.note, /@frontend 역할이 Claude 전용/);
  assert.equal(job.tasks[1].assignee, 'codex');
});

test('계획 지시문: 82%면 플래너에게 디자인 기획 담당을 Codex·Astra 로 알린다', () => {
  const status = { claude: { ok: true }, codex: { ok: true } };
  const config = { tools: { claude: { specialties: [] }, codex: { specialties: [] } } };
  const prompt = (u, settings = autoSettings()) => buildPlanPrompt({ goal: '다음 영상 디자인', cwd: 'x', config, status, healthy: BOTH, memoryCtx: '', settings, usage: u });
  const hi = prompt(usage(82));
  assert.match(hi, /기획만\*\* 담당 codex·모델 gpt-6-astra/);
  assert.match(hi, /전용 주간 한도가 82%로 기준 75% 이상/);
  assert.match(hi, /구현·수정·검증에는 고르지 마세요/);
  assert.match(hi, /Fable 주간 82% 사용/);
  assert.match(hi, /디자인 기획 작업만 예외/);
  const lo = prompt(usage(74));
  assert.match(lo, /기획만\*\* 담당 claude·모델 fable/); assert.doesNotMatch(lo, /gpt-6-astra에 넘깁니다/);
  // 사용자가 Claude 모델을 직접 고른 요청은 82%여도 기존 담당 그대로 안내
  assert.match(prompt(usage(82), { claude: { model: 'fable', effort: 'high' }, codex: { ...AUTO } }), /기획만\*\* 담당 claude·모델 fable/);
  assert.match(usageText(usage(82)), /Fable 전용 한도/);
  // applyDesignModel: 전환 대상이 아닌 쪽에는 Astra 를 넣지 않는다
  const t = target(usage(82));
  assert.equal(applyDesignModel({}, 'codex', AUTO, { model: 'gpt-6.1-sol', effort: 'high' }, usage(82), t).model, 'gpt-6-astra');
  assert.equal(applyDesignModel({}, 'codex', AUTO, { model: 'gpt-6.1-sol', effort: 'high' }, usage(82), null).model, 'gpt-6.1-sol');
  assert.equal(applyDesignModel({}, 'codex', { model: 'gpt-6.1-sol', effort: 'high' }, { model: 'gpt-6.1-sol', effort: 'high' }, usage(82), t).model, 'gpt-6.1-sol');
});
