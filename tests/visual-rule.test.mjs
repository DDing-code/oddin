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

test('현황 답변·서버 진단의 과거 영상 언급으로 화면 확인 작업을 붙이지 않는다', () => {
  const m = manager({ designRule: { enabled: true, mode: 'split', check: true } });
  const make = (task = {}) => ({ mode: 'auto', goal: '오딘을 쓸 때랑 단독으로 쓸 때 속도와 품질 차이가 심해', notes: [], tasks: [
    { id: 't1', title: '오딘 속도·품질 진단', assignee: 'codex', prompt: '이전 영상 제작은 재개하지 않는다. 스크린샷 검증과 모델 실행 로그를 비교한다.', dependsOn: [], ...task },
  ] });
  assert.deepEqual(m.enforceDesignRule(make(), ['claude', 'codex'], name, usage()), [], '예전 계획도 재작성 과제의 단어만으로 붙이지 않음');
  assert.deepEqual(m.enforceDesignRule(make({ title: '영상 엔진 적용 현황 답변', visualOutput: false }), ['claude', 'codex'], name, usage()), [], '결과물이 없는 명시적 판정');
  const visual = make({ title: '일곱 번째 편 완성', visualOutput: true });
  assert.equal(m.enforceDesignRule(visual, ['claude', 'codex'], name, usage())[0].visualCheck, true, '제목이 모호해도 실제 시각 결과물 판정은 유지');
});

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

// 사용자 규칙 2026-10-04 "디자인은 페이블 / 눈으로 확인은 아스트라" → split + check (지금 설정)
const SPLIT_CHECK = { designRule: { enabled: true, mode: 'split', tool: 'claude', model: 'fable', check: { tool: 'codex', model: 'gpt-6-astra' } } };

test('눈으로 확인 단계: 디자인은 기획(Fable)→구현(Sol)→확인(Astra), 영상 같은 시각 작업은 구현→확인, 일반·기획만 작업엔 없음, 뒤 작업은 확인 뒤로', () => {
  const m = manager(SPLIT_CHECK);
  const job = { mode: 'auto', notes: [], tasks: [
    { id: 't1', title: '대시보드 디자인 CSS 구현', prompt: '버튼 색 바꾸고 CSS 구현', assignee: 'claude', dependsOn: [] },
    { id: 't2', title: '먹방 영상 컷 편집', prompt: '영상 편집', assignee: 'codex', dependsOn: [] },
    { id: 't3', title: '배포 스크립트 실행', prompt: '배포', assignee: 'codex', dependsOn: ['t1'] },
    { id: 't4', title: '로고 시안 기획', prompt: '로고 방향만 정리', assignee: 'codex', dependsOn: [] },
  ] };
  const added = m.enforceDesignRule(job, ['claude', 'codex'], name, usage());
  const by = Object.fromEntries(job.tasks.map((t) => [t.id, t]));
  assert.deepEqual(added.map((t) => t.id).sort(), ['t1d', 't1v', 't2v']);
  assert.equal(by.t1d.assignee, 'claude'); assert.equal(by.t1d.designPlan, true);
  assert.equal(by.t1.assignee, 'codex'); assert.equal(by.t1.designImpl, true);
  assert.deepEqual([by.t1v.assignee, by.t1v.visualCheck, by.t1v.dependsOn], ['codex', true, ['t1', 't1d']]);
  assert.match(by.t1v.prompt, /\[눈으로 확인 단계\].*「대시보드 디자인 CSS 구현」/s); assert.match(by.t1v.prompt, /디자인 기획" 작업의 명세/);
  assert.deepEqual(by.t2v.dependsOn, ['t2']); assert.doesNotMatch(by.t2v.prompt, /디자인 기획" 작업의 명세/);
  assert.deepEqual(by.t3.dependsOn, ['t1', 't1v'], '뒤 작업은 확인 뒤로');
  assert.equal(by.t4.designPlan, true); assert.equal(by.t4v, undefined, '기획만 하는 작업엔 확인 없음');
  assert.match(job.notes.join('\n'), /눈으로 확인 규칙: 눈으로 보는 결과물 2개는 구현 뒤 Codex·gpt-6-astra가/);
  // 확인 담당을 못 쓰면 붙이지 않고 이유를 남김
  const j2 = { mode: 'auto', notes: [], tasks: [{ id: 't1', title: '썸네일 이미지 만들기', prompt: '썸네일', assignee: 'claude', dependsOn: [] }] };
  m.enforceDesignRule(j2, ['claude'], name, usage());
  assert.equal(j2.tasks.some((t) => t.visualCheck), false); assert.match(j2.notes.join('\n'), /눈으로 확인은 Codex·gpt-6-astra 담당이지만 지금 쓸 수 없어/);
  // check 를 끄면 예전 분리만
  const off = manager({ designRule: { ...SPLIT_CHECK.designRule, check: false } });
  const j3 = { mode: 'auto', notes: [], tasks: [{ id: 't1', title: '썸네일 이미지 만들기', prompt: '썸네일', assignee: 'codex', dependsOn: [] }] };
  off.enforceDesignRule(j3, ['claude', 'codex'], name, usage());
  assert.equal(j3.tasks.some((t) => t.visualCheck), false);
});

test('눈으로 확인 모델: Astra(한도 80%여도), 사용자가 고른 모델은 그대로, 계획 담당에게 확인 작업은 만들지 말라고 알림', () => {
  const m = manager(SPLIT_CHECK);
  const run = (settings, u = usage()) => { const t = { id: 't1v', title: '눈으로 확인: 썸네일', prompt: '확인', assignee: 'codex', visualCheck: true }; const job = { mode: 'auto', settings, tasks: [t], input: '' }; m.applyChoice(job, t, { reason: '눈으로 확인' }, u); return t; };
  const a = run(AUTO());
  assert.deepEqual([a.settings.model, a.settings.effort], ['gpt-6-astra', 'high']); // 눈으로 확인은 강도를 올리지 않음(2026-10-05) assert.match(a.reason, /눈으로 확인 규칙: gpt-6-astra/);
  assert.equal(run(AUTO(), usage(80)).settings.model, 'gpt-6-astra');
  assert.equal(run({ claude: { model: 'auto', effort: 'auto' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } }).settings.model, 'gpt-6.1-sol');
  const text = catalogText(SPLIT_CHECK, {});
  assert.match(text, /"눈으로 확인: …" 작업\(codex·gpt-6-astra, 렌더·스크린샷으로 확인하고 어긋난 곳 수정\)을 자동으로 붙입니다\. 확인 작업은 직접 만들지 마세요/);
  assert.match(text, /\*\*기획만\*\* 담당 claude·모델 fable/);
  assert.equal(designRule({}).check, undefined);
});
