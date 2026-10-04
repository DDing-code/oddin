import test from 'node:test';
import assert from 'node:assert/strict';
import { isDesignText, applyDesignModel, designRule, catalogText } from '../lib/router.mjs';
import { JobManager } from '../lib/jobs.mjs';

const usage = (fable) => ({ claude: { windows: [{ label: '5시간', usedPercent: 10 }, { label: 'Fable 주간', scope: 'model', model: 'fable', usedPercent: fable }] } });

test('디자인 판별: 디자인 키워드는 잡고, 설계·DDingUI 이름은 거른다', () => {
  const c = {};
  for (const t of ['프로필 디자인 3종', '설정 창 UI 개편', '아이콘 시안', '썸네일 만들어줘', 'CSS 색상 정리', '도트 스프라이트']) assert.ok(isDesignText(c, t), t);
  for (const t of ['API 설계', 'DDingUI 버그 수정', '테스트 실행', '빌드 스크립트']) assert.ok(!isDesignText(c, t), t);
  assert.equal(isDesignText({ designRule: { enabled: false } }, '디자인'), false);
  assert.match(catalogText({}), /기획만.*fable/);
});

test('디자인 모델 고정: 자동이면 Fable, 직접 고정·Codex·한도 95% 이상은 유지', () => {
  const auto = { model: 'auto', effort: 'auto' };
  assert.equal(applyDesignModel({}, 'claude', auto, { model: 'opus', effort: 'high' }, usage(80)).model, 'fable'); // 75% 강등 규칙보다 우선
  assert.equal(applyDesignModel({}, 'claude', auto, { model: 'opus', effort: 'high' }, usage(96)).model, 'opus');
  assert.equal(applyDesignModel({}, 'claude', { model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' }, null).model, 'opus');
  assert.equal(applyDesignModel({}, 'codex', auto, { model: 'gpt-6.1-sol', effort: 'high' }, null).model, 'gpt-6.1-sol');
  const rule = designRule({});
  assert.equal(rule.tool, 'claude'); assert.equal(rule.model, 'fable'); // 한도 전환 기본값은 design-switch.test.mjs
});

test('자동 분배: 디자인 작업은 Claude로 옮기고 다른 AI 전용 역할은 유지', () => {
  const fake = { config: {}, _cat: { agents: [{ name: 'tester', tool: 'codex' }] } };
  const job = { mode: 'auto', notes: [], goal: 'x', tasks: [
    { id: 't1', title: '대시보드 디자인 시안', assignee: 'codex' },
    { id: 't2', title: '서버 API 구현', assignee: 'codex' },
    { id: 't3', title: 'UI 화면 테스트', assignee: 'codex', agent: 'tester' },
  ] };
  const self = Object.assign(Object.create(JobManager.prototype), fake);
  self.enforceDesignRule(job, ['claude', 'codex']);
  assert.deepEqual(job.tasks.map((t) => t.assignee), ['claude', 'codex', 'codex']);
  assert.match(job.notes.join(), /디자인 규칙/);
  // Codex만 모드는 사용자 선택을 따른다
  const only = { mode: 'codex', notes: [], goal: '디자인', tasks: [{ id: 't1', title: '디자인', assignee: 'codex' }] };
  self.enforceDesignRule(only, ['claude', 'codex']);
  assert.equal(only.tasks[0].assignee, 'codex');
});

test('applyChoice: 디자인 기획 작업만 Fable, 나머지는 일반 자동 선택', () => {
  const self = Object.assign(Object.create(JobManager.prototype), { config: { defaults: {} }, _cat: { agents: [] } });
  const job = { goal: '로고 디자인', input: '로고 디자인', settings: { claude: { model: 'auto', effort: 'auto' } }, tasks: [] };
  const task = { id: 't1', title: '로고 디자인', assignee: 'claude', prompt: '로고', agent: null };
  job.tasks.push(task);
  self.applyChoice(job, task, { model: 'opus', effort: 'high' }, usage(10));
  assert.equal(task.model, 'opus'); // 기획 작업이 아니면 Fable 을 쓰지 않는다 (2026-10-03 규칙 갱신)
  const planTask = { id: 't2', title: '디자인 기획: 로고', assignee: 'claude', prompt: '로고', agent: null, designPlan: true };
  job.tasks.push(planTask);
  self.applyChoice(job, planTask, { model: 'opus', effort: 'high' }, usage(10));
  assert.equal(planTask.model, 'fable'); assert.match(planTask.reason, /디자인 규칙/);
  const plain = { id: 't1', title: '스크립트 정리', assignee: 'claude', prompt: 'x', agent: null };
  const job2 = { goal: '스크립트 정리', settings: job.settings, tasks: [plain] };
  self.applyChoice(job2, plain, { model: 'opus', effort: 'high' }, usage(10));
  assert.equal(plain.model, 'opus');
});

test('자동 분배: 디자인과 구현이 섞인 작업은 기획(Claude)과 구현(Codex)으로 나눈다', () => {
  const self = Object.assign(Object.create(JobManager.prototype), { config: {}, _cat: { agents: [] } });
  const job = { mode: 'auto', notes: [], goal: 'x', tasks: [
    { id: 't1', title: '설정 화면 UI 개편하고 CSS로 구현', assignee: 'claude', prompt: '설정 화면을 바꿔', dependsOn: [] },
    { id: 't2', title: '서버 API 구현', assignee: 'codex', prompt: 'API', dependsOn: [] },
  ] };
  const added = self.enforceDesignRule(job, ['claude', 'codex']);
  assert.equal(added.length, 1);
  const [impl, api, plan] = job.tasks;
  assert.equal(plan.id, 't1d'); assert.equal(plan.assignee, 'claude'); assert.equal(plan.designPlan, true);
  assert.match(plan.title, /^디자인 기획: /); assert.match(plan.prompt, /기획만/);
  assert.equal(impl.assignee, 'codex'); assert.equal(impl.designImpl, true); assert.deepEqual(impl.dependsOn, ['t1d']);
  assert.match(impl.prompt, /디자인 명세 준수/);
  assert.equal(api.assignee, 'codex'); assert.ok(!api.design);
  assert.match(job.notes.join(), /기획.*구현/);
  // 플래너가 이미 "디자인 기획" 작업을 앞에 두었으면 새로 만들지 않는다
  const pre = { mode: 'auto', notes: [], goal: 'x', tasks: [
    { id: 'a', title: '디자인 기획: 대시보드', assignee: 'codex', prompt: '명세', dependsOn: [] },
    { id: 'b', title: '대시보드 UI 구현', assignee: 'claude', prompt: '구현', dependsOn: ['a'] },
  ] };
  assert.equal(self.enforceDesignRule(pre, ['claude', 'codex']).length, 0);
  assert.equal(pre.tasks[0].assignee, 'claude'); assert.equal(pre.tasks[0].designPlan, true);
  assert.equal(pre.tasks[1].assignee, 'codex');
  // Claude를 쓸 수 없으면 나누지 않고 안내만
  const noClaude = { mode: 'auto', notes: [], goal: 'x', tasks: [{ id: 't1', title: '로고 디자인 만들어', assignee: 'codex', prompt: 'x', dependsOn: [] }] };
  assert.equal(self.enforceDesignRule(noClaude, ['codex']).length, 0);
  assert.match(noClaude.notes.join(), /쓸 수 없어/);
});

test('최상위 모델(Fable·Astra)은 기획·디자인 기획·중요한 글쓰기에만', async () => {
  const { premiumAllowed, capPremium } = await import('../lib/router.mjs');
  assert.equal(premiumAllowed({}, { title: '서버 API 구현' }), false);
  assert.equal(premiumAllowed({}, { title: '신규 기능 기획서 작성' }), true);
  assert.equal(premiumAllowed({}, { title: 'README 문서 작성' }), true);
  assert.equal(premiumAllowed({}, { title: '디자인 기획: 로고', designPlan: true }), true);
  assert.equal(premiumAllowed({}, { title: '로고 구현 (디자인 기획 명세 따름)', designImpl: true }), false);
  assert.equal(premiumAllowed({}, { title: '정리', agent: 'writer' }), true);
  assert.equal(premiumAllowed({ premiumModels: { enabled: false } }, { title: '버그 수정' }), true);
  assert.equal(capPremium({}, 'claude', 'fable', false).model, 'opus');
  assert.equal(capPremium({}, 'codex', 'gpt-6-astra', false).model, 'gpt-6.1-sol');
  assert.equal(capPremium({}, 'claude', 'fable', true).model, 'fable');
  assert.equal(capPremium({}, 'claude', 'opus', false).model, 'opus');
  // applyChoice: 자동 선택이 최상위를 골라도 일반 작업이면 기본 모델, 직접 고른 모델은 그대로
  const self = Object.assign(Object.create(JobManager.prototype), { config: { defaults: {} }, _cat: { agents: [] } });
  const job = { goal: 'x', input: 'x', settings: { claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } }, tasks: [] };
  const t1 = { id: 't1', title: '큰 리팩터링 구현', assignee: 'codex', prompt: 'x', agent: null };
  const t2 = { id: 't2', title: '출시 전략 기획', assignee: 'claude', prompt: 'x', agent: null };
  job.tasks.push(t1, t2);
  self.applyChoice(job, t1, { model: 'gpt-6-astra', effort: 'xhigh' }, null);
  assert.equal(t1.model, 'gpt-6.1-sol'); assert.match(t1.reason, /최상위 모델/);
  self.applyChoice(job, t2, { model: 'fable', effort: 'high' }, null);
  assert.equal(t2.model, 'fable');
  const fixedJob = { goal: 'x', settings: { claude: { model: 'fable', effort: 'high' } }, tasks: [] };
  const t3 = { id: 't1', title: '버그 수정', assignee: 'claude', prompt: 'x', agent: null }; fixedJob.tasks.push(t3);
  self.applyChoice(fixedJob, t3, { model: 'fable', effort: 'high' }, null);
  assert.equal(t3.settings.model, 'fable');
});
