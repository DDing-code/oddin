// 눈으로 보는 결과물 규칙 (사용자 요구 2026-10-04 "눈으로 보는건 무조건 아스트라가 하자" → 전부 Astra)
// 실제 모델 호출 없음. Codex 모델 목록·평소 설정은 임시 CODEX_HOME 으로 대신한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-visual-'));
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: EFFORTS },
  { slug: 'gpt-6-astra', visibility: 'list', supported_reasoning_levels: EFFORTS },
] }));
process.env.CODEX_HOME = home;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { isDesignText, designRule, designTarget, catalogText } = await import('../lib/router.mjs');
const { JobManager } = await import('../lib/jobs.mjs');

const WHOLE = { designRule: { enabled: true, mode: 'whole', tool: 'codex', model: 'gpt-6-astra' } };
const AUTO = () => ({ claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } });
const usage = (codex = 10) => ({ claude: { windows: [{ key: 'seven_day', label: '주간', usedPercent: 20 }] }, codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: codex }] } });
const manager = (config = WHOLE, agents = []) => Object.assign(Object.create(JobManager.prototype), { config: { tools: {}, defaults: {}, ...config }, _cat: { agents } });
const name = (t) => (t === 'claude' ? 'Claude' : 'Codex');

test('판정: 디자인뿐 아니라 이미지·영상·3D·화면·색·버튼도 눈으로 보는 결과물, 검색·색인·버그·설계는 아님', () => {
  for (const s of ['5편은 3d로 만들어줘', '썸네일 이미지 만들어', '먹방 영상 컷 편집', '대시보드 버튼 색 바꿔', '화면 예쁘게 꾸며줘', '로고 시안', '애니메이션 GIF']) assert.equal(isDesignText(WHOLE, s), true, s);
  for (const s of ['검색 기능 추가', '파일 탐색 속도', '색인 재구성', '버그 원인 찾아서 고쳐', 'DDingUI 애드온 성능 개선', '시스템 설계 문서', 'API 응답 형식 정리']) assert.equal(isDesignText(WHOLE, s), false, s);
  // 예전 방식(mode 없음)은 디자인만
  assert.equal(isDesignText({}, '먹방 영상 컷 편집'), false);
});

test('규칙: whole 모드는 Codex·Astra 고정, 한도 전환 없음, 플래너에게 나누지 말라고 알림', () => {
  assert.deepEqual([designRule(WHOLE).mode, designRule(WHOLE).tool, designRule(WHOLE).model], ['whole', 'codex', 'gpt-6-astra']);
  const fableHigh = { claude: { windows: [{ key: 'model_fable', scope: 'model', model: 'fable', usedPercent: 90 }] } };
  const t = designTarget(WHOLE, { usage: fableHigh, usable: ['claude', 'codex'], settings: AUTO() });
  assert.deepEqual([t.tool, t.model, t.switched], ['codex', 'gpt-6-astra', false]);
  const text = catalogText(WHOLE, {});
  assert.match(text, /사용자 규칙\(무조건\): 눈으로 보는 결과물.*codex·모델 gpt-6-astra 한 작업자가 기획부터 구현·눈으로 확인까지/);
  assert.match(text, /나누지 말고 assignee 를 "codex", model 을 "gpt-6-astra"/);
  assert.doesNotMatch(text, /디자인 기획: …/);
});

test('배정: 시각 작업은 Claude 에서 Codex 로 옮기고 [눈으로 확인] 지시를 붙임, 나누지 않음, 다른 작업·다른 AI 전용 역할은 그대로', () => {
  const m = manager(WHOLE, [{ name: 'writer', tool: 'claude' }]);
  const job = { mode: 'auto', notes: [], tasks: [
    { id: 't1', title: '대시보드 화면 디자인 개선', prompt: '대시보드를 예쁘게', assignee: 'claude', dependsOn: [] },
    { id: 't2', title: 'API 정리', prompt: '응답 형식 정리', assignee: 'claude', dependsOn: [] },
    { id: 't3', title: '소개 영상 대본', prompt: '영상 대본 작성', assignee: 'claude', dependsOn: [], agent: 'writer' },
  ] };
  const added = m.enforceDesignRule(job, ['claude', 'codex'], name, usage());
  assert.deepEqual(added, []); assert.equal(job.tasks.length, 3);
  assert.deepEqual(job.tasks.map((t) => [t.assignee, !!t.visual]), [['codex', true], ['claude', false], ['claude', false]]);
  assert.match(job.tasks[0].prompt, /\[눈으로 확인\].*렌더·스크린샷·재생해서 직접 눈으로 확인/);
  assert.match(job.notes.join('\n'), /눈으로 보는 결과물 규칙: 작업 1개를 Codex·gpt-6-astra가/);
  // Codex 를 못 쓰면 이유를 남기고 그대로
  const j2 = { mode: 'auto', notes: [], tasks: [{ id: 't1', title: '로고 시안', prompt: '로고', assignee: 'claude', dependsOn: [] }] };
  m.enforceDesignRule(j2, ['claude'], name, usage());
  assert.equal(j2.tasks[0].assignee, 'claude'); assert.match(j2.notes[0], /지금 쓸 수 없어 Claude가 맡아요/);
});

test('모델: 시각 작업은 Astra(한도 75%↑ 안전장치·최상위 제한보다 우선)·평소 강도, Codex만 모드도 같음, 직접 고른 모델·일반 작업은 그대로', () => {
  const m = manager();
  const run = (task, { mode = 'auto', settings = AUTO(), u = usage(), input = '' } = {}) => {
    const job = { mode, settings, tasks: [task], input };
    m.applyChoice(job, task, { model: 'gpt-6.1-sol', effort: 'high', reason: '' }, u);
    return task;
  };
  const v = run({ id: 't1', title: '썸네일 이미지 만들기', prompt: '썸네일', assignee: 'codex' });
  assert.deepEqual([v.settings.model, v.settings.effort, v.visual], ['gpt-6-astra', 'xhigh', true]);
  assert.match(v.reason, /눈으로 보는 결과물 규칙/);
  const busy = run({ id: 't1', title: '썸네일 이미지 만들기', prompt: '썸네일', assignee: 'codex' }, { u: usage(80) });
  assert.equal(busy.settings.model, 'gpt-6-astra', '한도 80%여도 Astra');
  const solo = run({ id: 't1', title: '작업', prompt: '5편은 3d로 만들어줘', assignee: 'codex' }, { mode: 'codex', input: '5편은 3d로 만들어줘' });
  assert.equal(solo.settings.model, 'gpt-6-astra');
  const fixed = run({ id: 't1', title: '썸네일 이미지', prompt: '썸네일', assignee: 'codex' }, { settings: { claude: { model: 'auto', effort: 'auto' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } } });
  assert.equal(fixed.settings.model, 'gpt-6.1-sol', '사용자가 고른 모델 그대로');
  const plain = run({ id: 't1', title: '로그 파서 버그 수정', prompt: '파서 버그', assignee: 'codex' });
  assert.equal(plain.settings.model, 'gpt-6.1-sol'); assert.equal(plain.visual, undefined);
  // 일반 작업에 Astra 를 골라도 최상위 제한으로 Sol
  const job = { mode: 'auto', settings: AUTO(), tasks: [], input: '' };
  const t = { id: 't1', title: '로그 파서 버그 수정', prompt: '파서', assignee: 'codex' }; job.tasks.push(t);
  m.applyChoice(job, t, { model: 'gpt-6-astra', effort: 'high', reason: '' }, usage());
  assert.equal(t.settings.model, 'gpt-6.1-sol');
});

test('예전 방식(mode 없음)은 그대로 기획·구현 분리', () => {
  const m = manager({});
  const job = { mode: 'auto', notes: [], tasks: [{ id: 't1', title: '대시보드 디자인 CSS 구현', prompt: '버튼 색 CSS 구현', assignee: 'codex', dependsOn: [] }] };
  const added = m.enforceDesignRule(job, ['claude', 'codex'], name, usage());
  assert.equal(added.length, 1); assert.equal(added[0].designPlan, true); assert.equal(job.tasks.length, 2);
});
