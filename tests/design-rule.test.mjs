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
  assert.match(catalogText({}), /디자인 작업.*fable 로 고정/);
});

test('디자인 모델 고정: 자동이면 Fable, 직접 고정·Codex·한도 95% 이상은 유지', () => {
  const auto = { model: 'auto', effort: 'auto' };
  assert.equal(applyDesignModel({}, 'claude', auto, { model: 'opus', effort: 'high' }, usage(80)).model, 'fable'); // 75% 강등 규칙보다 우선
  assert.equal(applyDesignModel({}, 'claude', auto, { model: 'opus', effort: 'high' }, usage(96)).model, 'opus');
  assert.equal(applyDesignModel({}, 'claude', { model: 'opus', effort: 'high' }, { model: 'opus', effort: 'high' }, null).model, 'opus');
  assert.equal(applyDesignModel({}, 'codex', auto, { model: 'gpt-6.1-sol', effort: 'high' }, null).model, 'gpt-6.1-sol');
  assert.deepEqual(designRule({}), { tool: 'claude', model: 'fable' });
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

test('applyChoice: 디자인 작업은 자동 선택이 Opus여도 Fable', () => {
  const self = Object.assign(Object.create(JobManager.prototype), { config: { defaults: {} }, _cat: { agents: [] } });
  const job = { goal: '로고 디자인', input: '로고 디자인', settings: { claude: { model: 'auto', effort: 'auto' } }, tasks: [] };
  const task = { id: 't1', title: '로고 디자인', assignee: 'claude', prompt: '로고', agent: null };
  job.tasks.push(task);
  self.applyChoice(job, task, { model: 'opus', effort: 'high' }, usage(10));
  assert.equal(task.model, 'fable'); assert.match(task.reason, /디자인 규칙/);
  const plain = { id: 't1', title: '스크립트 정리', assignee: 'claude', prompt: 'x', agent: null };
  const job2 = { goal: '스크립트 정리', settings: job.settings, tasks: [plain] };
  self.applyChoice(job2, plain, { model: 'opus', effort: 'high' }, usage(10));
  assert.equal(plain.model, 'opus');
});
