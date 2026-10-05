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

test('제작·검증 혼합 작업을 지우거나 기획자에게 넘기지 않는다', () => {
  for (const title of ['차트던전 06편 영상 제작·검증', '컷 편집과 재생 확인', '3D 렌더·검증', '빌드·동작 점검', '최종 출력·QA']) {
    const tasks = [
      { id: 't1', title: '디자인 기획', prompt: '명세만 작성', dependsOn: [] },
      { id: 't2', title, prompt: '실제 결과물을 제작하고 검증', dependsOn: ['t1'] },
    ];
    assert.deepEqual(dropVerifyOnly(tasks), [], title);
    assert.equal(tasks[0].prompt, '명세만 작성');
  }
  const tasks = [
    { id: 't1', title: '기획', prompt: '명세만', dependsOn: [] },
    { id: 't2', title: '산출물 확인', prompt: '시각 결과물을 생성', dependsOn: ['t1'], visualOutput: true },
  ];
  assert.deepEqual(dropVerifyOnly(tasks), []);
});
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
  assert.equal(small('사이드바 글자 크기 조금 키워줘'), false); // 기본은 꺼짐 (사용자 요구 2026-10-03)
  jm.config = { fastPath: { enabled: true } };
  assert.equal(small('사이드바 글자 크기 조금 키워줘'), true);
  assert.equal(small('1) 로그인 고치고 2) 테스트 추가해줘'), false);
  assert.equal(small('둘 다 해서 비교해줘'), false);
  assert.equal(small('간헐적으로 서버가 죽는 원인 찾아줘'), false);
  assert.equal(small('x'.repeat(200)), false);
  assert.equal(small('짧은 목표', { goalId: 'g1' }), false);
  jm.config = { fastPath: { enabled: false } };
  assert.equal(small('사이드바 글자 크기 조금 키워줘'), false);
  jm.config = { fastPath: { enabled: true } };
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

test('두 PC 공유 스킬: ~/.ai-shared/skills 를 Claude·Codex 스킬 폴더에 연결, 같은 이름의 이 PC 스킬은 그대로, 빠지면 연결 정리', async () => {
  const { linkSharedSkills, loadSkills } = await import('../lib/catalog.mjs');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-skills-'));
  try {
    const hub = path.join(dir, 'shared'), home = path.join(dir, 'home');
    const skill = (root, n, d) => { fs.mkdirSync(path.join(root, n), { recursive: true }); fs.writeFileSync(path.join(root, n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${d}\n---\n본문`); };
    skill(path.join(hub, 'skills'), 'chart-reels', '차트 릴스'); skill(path.join(hub, 'skills'), 'video-studio', '영상 제작');
    skill(path.join(home, '.claude', 'skills'), 'video-studio', '이 PC 판');
    const r = linkSharedSkills(hub, { home });
    assert.deepEqual(r.linked.sort(), ['chart-reels', 'chart-reels', 'video-studio'].sort());
    assert.equal(r.kept.length, 1, '이 PC의 같은 이름 스킬은 그대로');
    assert.equal(fs.readFileSync(path.join(home, '.agents', 'skills', 'chart-reels', 'SKILL.md'), 'utf8').includes('차트 릴스'), true);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'video-studio', 'SKILL.md'), 'utf8').includes('이 PC 판'), true);
    assert.deepEqual(linkSharedSkills(hub, { home }).linked, [], '다시 해도 그대로');
    assert.ok(loadSkills(hub).find((s) => s.name === 'chart-reels').shared);
    fs.rmSync(path.join(hub, 'skills', 'chart-reels'), { recursive: true });
    assert.deepEqual(linkSharedSkills(hub, { home }).removed.sort(), ['chart-reels', 'chart-reels']);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'chart-reels')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('모든 스킬을 공유 폴더로: 두 도구가 만든 스킬을 옮기고 양쪽에 연결, 같은 이름은 파일 단위로 합치고 백업, 만드는 중인 스킬은 미룸', async () => {
  const { syncSkillFolders } = await import('../lib/catalog.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-adopt-skills-'));
  try {
    const hub = path.join(dir, 'shared'), home = path.join(dir, 'home'), codexHome = path.join(home, '.codex');
    const C = path.join(home, '.claude', 'skills'), A = path.join(home, '.agents', 'skills'), X = path.join(codexHome, 'skills'), S = path.join(hub, 'skills');
    const old = new Date(Date.now() - 3600_000), older = new Date(Date.now() - 7200_000);
    const skill = (root, n, body, extra = {}, t = old) => {
      const d = path.join(root, n); fs.mkdirSync(d, { recursive: true });
      for (const [f, v] of Object.entries({ 'SKILL.md': `---\nname: ${n}\ndescription: ${body}\n---\n${body}`, ...extra })) { fs.writeFileSync(path.join(d, f), v); fs.utimesSync(path.join(d, f), t, t); }
    };
    skill(S, 'shared-one', '이미 공유');
    skill(C, 'claude-made', 'Claude 가 만듦'); skill(X, 'codex-made', 'Codex 가 만듦', { 'ref.txt': '참고' }); skill(A, 'agents-made', '설치 도구가 넣음');
    skill(A, 'source-command-x', 'Claude 커맨드를 가져옴');
    skill(path.join(C, 'synced', 'bucket'), 'account-skill', '계정 스킬'); // Claude 앱이 관리 — SKILL.md 가 바로 안에 없음
    skill(path.join(X, '.system'), 'builtin', '내장');
    fs.symlinkSync(path.join(X, 'codex-made'), path.join(C, 'codex-made'), 'junction'); // sync.mjs 가 만든 옛 연결
    fs.symlinkSync(path.join(C, 'claude-made'), path.join(A, 'claude-made'), 'junction');
    // 같은 이름이 두 곳에: 공유판(오래됨, a.txt) · 이 PC판(최근, b.txt)
    skill(S, 'both', '공유판', { 'a.txt': 'A' }, older);
    skill(X, 'both', '이 PC판', { 'b.txt': 'B' });

    const r = syncSkillFolders(hub, { home, codexHome, settleMs: 0 });
    assert.ok(r.changed);
    assert.deepEqual(r.adopt.failed, []);
    for (const n of ['claude-made', 'codex-made', 'agents-made', 'source-command-x', 'both', 'shared-one']) assert.ok(fs.existsSync(path.join(S, n, 'SKILL.md')), `${n} 공유 폴더에`);
    const linked = (d, n) => fs.lstatSync(path.join(d, n)).isSymbolicLink() && fs.realpathSync(path.join(d, n)).toLowerCase() === fs.realpathSync(path.join(S, n)).toLowerCase();
    for (const n of ['claude-made', 'codex-made', 'agents-made', 'both', 'shared-one']) { assert.ok(linked(C, n), `Claude ${n}`); assert.ok(linked(A, n), `Codex ${n}`); }
    assert.ok(linked(A, 'source-command-x')); assert.ok(!fs.existsSync(path.join(C, 'source-command-x')), 'Claude 커맨드 사본은 Codex 쪽에만');
    assert.deepEqual(fs.readdirSync(X).sort(), ['.system'], 'Codex 폴더에는 내장 스킬만 남음(같은 스킬이 두 번 보이지 않게)');
    assert.ok(fs.existsSync(path.join(C, 'synced', 'bucket', 'account-skill', 'SKILL.md')) && !fs.lstatSync(path.join(C, 'synced')).isSymbolicLink(), 'Claude 앱 계정 스킬은 그대로');
    assert.equal(fs.readFileSync(path.join(S, 'codex-made', 'ref.txt'), 'utf8'), '참고');
    // 합치기: 최근 판의 SKILL.md, 양쪽 파일 모두, 밀린 판·원래 폴더는 백업
    assert.match(fs.readFileSync(path.join(S, 'both', 'SKILL.md'), 'utf8'), /이 PC판/);
    assert.equal(fs.readFileSync(path.join(S, 'both', 'a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(S, 'both', 'b.txt'), 'utf8'), 'B');
    const [stamp] = fs.readdirSync(path.join(hub, 'backups', 'skills'));
    assert.match(fs.readFileSync(path.join(hub, 'backups', 'skills', stamp, 'both.shared', 'SKILL.md'), 'utf8'), /공유판/);
    assert.ok(fs.existsSync(path.join(hub, 'backups', 'skills', stamp, 'both.codex', 'b.txt')));
    assert.equal(syncSkillFolders(hub, { home, codexHome, settleMs: 0 }).changed, false, '다시 해도 그대로');

    // 방금 만들고 있는 스킬은 미뤘다가, 시간이 지나면 옮긴다
    skill(C, 'fresh', '만드는 중', {}, new Date());
    const w = syncSkillFolders(hub, { home, codexHome, settleMs: 60_000 });
    assert.deepEqual(w.adopt.waiting, ['fresh']); assert.ok(!fs.lstatSync(path.join(C, 'fresh')).isSymbolicLink());
    const later = syncSkillFolders(hub, { home, codexHome, settleMs: 60_000, now: Date.now() + 120_000 });
    assert.deepEqual(later.adopt.moved, ['fresh (claude)']); assert.ok(linked(C, 'fresh') && linked(A, 'fresh'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
