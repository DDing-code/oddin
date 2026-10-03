import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, parseInput, expandTemplate, installToClis } from '../lib/catalog.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { balanceShare, usageWarnings, headroom } from '../lib/usage.mjs';
import { finalizeChoice } from '../lib/router.mjs';

const cat = {
  commands: [{ name: 'review', body: '리뷰: $ARGUMENTS / 첫 단어 $1', mode: null, agent: 'reviewer' }, { name: 'explain', body: '설명 $ARGUMENTS', mode: 'claude', agent: null }],
  agents: [{ name: 'reviewer', label: '리뷰어', tool: 'codex' }],
  skills: [{ name: 'hana', description: '하나 리오', tools: ['claude', 'codex'], file: 'C:/x/hana/SKILL.md' }],
};

test('공통 설치: 누락·빈 원본이 기존 설치본을 지우지 않고 정상 삭제 동기화는 유지', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-catalog-'));
  try {
    const source = path.join(root, 'source'), home = path.join(root, 'home');
    const opts = { home, codexHome: path.join(home, '.codex') };
    const commandDir = path.join(home, '.claude', 'commands', 'hub');
    fs.mkdirSync(commandDir, { recursive: true });
    const previous = path.join(commandDir, 'previous.md'); fs.writeFileSync(previous, 'keep\n<!-- ai-hub:managed -->');
    assert.throws(() => installToClis(source, opts), /원본 폴더/); assert(fs.existsSync(previous));
    for (const sub of ['commands', 'agents']) fs.mkdirSync(path.join(source, sub), { recursive: true });
    assert.throws(() => installToClis(source, opts), /비어/); assert(fs.existsSync(previous));
    fs.writeFileSync(path.join(source, 'commands', 'test.md'), '---\ndescription: 시험\n---\n시험');
    const result = installToClis(source, opts); assert.equal(result.commands, 1); assert.equal(result.removed, 1);
    assert(!fs.existsSync(previous)); assert(fs.existsSync(path.join(commandDir, 'test.md')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('frontmatter 파싱', () => {
  const { meta, body } = parseFrontmatter('---\ndescription: "설명: 콜론"\nmode: both\n---\n본문 $ARGUMENTS');
  assert.equal(meta.description, '설명: 콜론'); assert.equal(meta.mode, 'both'); assert.equal(body, '본문 $ARGUMENTS');
});

test('입력 해석: /goal · /커맨드 · /스킬 · @에이전트 · 일반 문장', () => {
  assert.deepEqual(parseInput('/goal 테스트 전부 통과', cat), { kind: 'goal', text: '테스트 전부 통과' });
  const c = parseInput('/review src/app.js 꼼꼼히', cat);
  assert.equal(c.kind, 'command'); assert.equal(c.agent, 'reviewer'); assert.equal(c.prompt, '리뷰: src/app.js 꼼꼼히 / 첫 단어 src/app.js');
  assert.equal(parseInput('/explain', cat).mode, 'claude');
  const s = parseInput('/hana 프로필', cat); assert.equal(s.kind, 'skill'); assert.match(s.prompt, /SKILL\.md/);
  assert.equal(parseInput('/skill hana 사진', cat).name, 'hana');
  assert.deepEqual(parseInput('@reviewer 봐줘', cat), { kind: 'agent', name: 'reviewer', text: '봐줘' });
  assert.equal(parseInput('그냥 요청이에요', cat), null);
  assert.throws(() => parseInput('/없는커맨드아님 x', cat) ?? (() => { throw new Error('null'); })(), /null/);
  assert.throws(() => parseInput('/nope 하나', cat), /모르는 커맨드/);
  assert.throws(() => parseInput('@nobody 일', cat), /모르는 서브 에이전트/);
  assert.throws(() => parseInput('/goal', cat), /목표를 적어/);
});

test('템플릿: 인자가 없으면 지정 없음', () => {
  assert.equal(expandTemplate('대상: $ARGUMENTS', ''), '대상: (지정 없음)');
});

const usage = (c5, c7, x7, fable) => ({
  claude: { windows: [{ key: 'five_hour', label: '5시간', usedPercent: c5 }, { key: 'seven_day', label: '주간', usedPercent: c7 }, ...(fable != null ? [{ key: 'model_fable', label: 'Fable 주간', usedPercent: fable, scope: 'model', model: 'fable' }] : [])] },
  codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: x7 }] },
});

test('남은 한도로 분배 비율, 95% 이상이면 0', () => {
  assert.equal(headroom(usage(57, 16, 1, 99), 'claude'), 43); // 모델 전용 한도는 빼고 계산
  const b = balanceShare(usage(57, 16, 1));
  assert.ok(b.claude < 0.4 && b.codex > 0.6, JSON.stringify(b));
  assert.equal(balanceShare(usage(97, 20, 10)).claude, 0);
  assert.equal(balanceShare(usage(10, 10, 10)).claude, 0.5);
});

test('경고: 80% 주의, 95% 위험, 모델 전용 한도 포함', () => {
  const w = usageWarnings(usage(96, 20, 81, 85));
  assert.deepEqual(w.map((x) => [x.tool, x.label, x.level]), [['claude', '5시간', 'crit'], ['claude', 'Fable 주간', 'warn'], ['codex', '주간', 'warn']]);
});

test('Fable 주간 한도 75% 이상이면 자동 선택은 Opus', () => {
  const config = { defaults: {} };
  const ok = finalizeChoice(config, 'claude', { model: 'auto', effort: 'auto' }, { model: 'fable', effort: 'xhigh' }, usage(10, 10, 10, 30));
  assert.equal(ok.model, 'fable');
  const tight = finalizeChoice(config, 'claude', { model: 'auto', effort: 'auto' }, { model: 'fable', effort: 'xhigh' }, usage(10, 10, 10, 80));
  assert.equal(tight.model, 'opus'); assert.match(tight.reason, /Fable 주간 한도 80%/);
  // 사용자가 Fable을 직접 고정했으면 건드리지 않음
  assert.equal(finalizeChoice(config, 'claude', { model: 'fable', effort: 'high' }, {}, usage(10, 10, 10, 99)).model, 'fable');
});

import { JobManager } from '../lib/jobs.mjs';
test('재배정: 80% 넘은 쪽은 권장 비율만큼만, 전용 역할은 유지', () => {
  const fake = { _cat: { agents: [{ name: 'frontend', tool: 'claude' }, { name: 'tester', tool: 'codex' }] }, config: {} };
  const u = usage(88, 30, 5);
  const share = balanceShare(u, ['claude', 'codex']);
  const job = { notes: [], tasks: [
    { id: 't1', assignee: 'claude', agent: 'frontend' },
    { id: 't2', assignee: 'claude', agent: null },
    { id: 't3', assignee: 'claude', agent: null },
    { id: 't4', assignee: 'codex', agent: 'tester' },
  ] };
  JobManager.prototype.rebalance.call(fake, job, u, ['claude', 'codex'], share, (t) => `${t} 한도`, (t) => t);
  assert.equal(job.tasks[0].assignee, 'claude'); // 전용 역할 유지
  assert.equal(job.tasks.filter((t) => t.assignee === 'claude').length, Math.max(1, Math.round(4 * share.claude)));
  assert.match(job.notes[0], /옮겼어요/);
});

import { dropVerifyOnly } from '../lib/planner.mjs';
import { deepEffortJustified } from '../lib/router.mjs';

test('속도: 검증만 하는 끝 작업은 빼고 앞 작업에 합친다', () => {
  const tasks = [
    { id: 't1', title: 'mul 함수 구현', prompt: '구현', dependsOn: [] },
    { id: 't2', title: 'README 갱신', prompt: '문서', dependsOn: [] },
    { id: 't3', title: '전체 동작 검증', prompt: 'node --test 로 확인', dependsOn: ['t1', 't2'] },
  ];
  const dropped = dropVerifyOnly(tasks);
  assert.deepEqual(dropped.map((t) => t.id), ['t3']);
  assert.match(tasks[0].prompt, /끝내기 전 직접 검증[\s\S]*node --test/);
  // 다른 작업이 기다리는 작업이나 만드는 작업은 남긴다
  assert.equal(dropVerifyOnly([{ id: 'a', title: '조사 결과 확인', prompt: '', dependsOn: [] }, { id: 'b', title: '구현', prompt: '', dependsOn: ['a'] }]).length, 0);
  assert.equal(dropVerifyOnly([{ id: 'a', title: '구현', prompt: '', dependsOn: [] }, { id: 'b', title: '테스트 추가 및 검증', prompt: '', dependsOn: ['a'] }]).length, 0);
});

test('속도: high 보다 높은 강도는 근거가 있을 때만', () => {
  assert.equal(deepEffortJustified('버튼 색 바꾸기'), false);
  assert.equal(deepEffortJustified('간헐적으로 죽는 원인을 찾아서 고쳐'), true);
  assert.equal(deepEffortJustified('전체 구조 개편'), true);
});

test('속도: 작은 요청 판정과 담당 AI', () => {
  const jm = Object.create(JobManager.prototype); jm.config = {};
  const small = (goal, extra = {}) => jm.isSmallRequest({ goal, ...extra });
  assert.equal(small('사이드바 글자 크기 조금 키워줘'), true);
  assert.equal(small('1) 로그인 고치고 2) 테스트 추가해줘'), false);
  assert.equal(small('둘 다 해서 비교해줘'), false);
  assert.equal(small('간헐적으로 서버가 죽는 원인 찾아줘'), false);
  assert.equal(small('x'.repeat(200)), false);
  assert.equal(small('짧은 목표', { goalId: 'g1' }), false);
  jm.config = { fastPath: { enabled: false } };
  assert.equal(small('사이드바 글자 크기 조금 키워줘'), false);
  jm.config = {};
  const cat = { agents: [{ name: 'tester', tool: 'codex' }] };
  const share = { claude: 0.6, codex: 0.4 };
  assert.equal(jm.pickFastTool({ goal: '설명 문구 다듬어줘' }, ['claude', 'codex'], share, cat), 'claude');
  assert.equal(jm.pickFastTool({ goal: '빌드 스크립트 오류 고쳐줘' }, ['claude', 'codex'], share, cat), 'codex');
  assert.equal(jm.pickFastTool({ goal: '이거 봐줘', agentHint: 'tester' }, ['claude', 'codex'], share, cat), 'codex');
  assert.equal(jm.pickFastTool({ goal: '설명 문구 다듬어줘' }, ['codex'], share, cat), 'codex'); // 한도 바닥이면 다른 쪽
});

import { reviveDependents } from '../lib/jobs.mjs';
test('재시도: 실패로 건너뛴 후속 작업도 함께 되살린다', () => {
  const tasks = [
    { id: 't1', status: 'done', dependsOn: [] },
    { id: 't2', status: 'pending', dependsOn: [] },
    { id: 't3', status: 'skipped', error: '선행 작업 실패', dependsOn: ['t1', 't2'] },
    { id: 't4', status: 'skipped', dependsOn: ['t3'] },
    { id: 't5', status: 'skipped', dependsOn: ['t1'] }, // 다른 이유로 건너뛴 것은 그대로
  ];
  assert.deepEqual(reviveDependents(tasks, 't2'), ['t3', 't4']);
  assert.equal(tasks[2].status, 'pending'); assert.equal(tasks[2].error, null);
  assert.equal(tasks[4].status, 'skipped');
});
