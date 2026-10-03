import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, childEnv } from '../lib/util.mjs';
import { buildPlanPrompt, buildWorkerPrompt } from '../lib/planner.mjs';

test('extractJson: 펜스/잡음 속 JSON 추출', () => {
  assert.deepEqual(extractJson('앞말 ```json\n{"a":1,"b":{"c":"}"}}\n``` 뒷말'), { a: 1, b: { c: '}' } });
  assert.deepEqual(extractJson('설명 {"summary":"x","tasks":[]} 끝'), { summary: 'x', tasks: [] });
  assert.equal(extractJson('json 없음'), null);
});

test('childEnv: 데스크탑 세션 변수 제거', () => {
  process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_SESSION_ID = 'x';
  const env = childEnv();
  assert.equal(env.CLAUDECODE, undefined); assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined); assert.equal(env.NO_COLOR, '1');
});

test('플래너 프롬프트: 단일 도구만 가능하면 강제 배정 문구 포함', () => {
  const config = { tools: { claude: { specialties: ['UI'] }, codex: { specialties: ['백엔드'] } } };
  const status = { claude: { ok: false, installed: true, loggedIn: false }, codex: { ok: true } };
  const p = buildPlanPrompt({ goal: '테스트', cwd: 'C:/x', config, status, healthy: ['codex'], memoryCtx: '' });
  assert.match(p, /assignee 는 "codex"/);
  assert.match(p, /claude: 사용 불가\(로그인 필요\)/);
});

test('워커 프롬프트: 선행 결과와 형제 작업 포함', () => {
  const job = { id: 'j', goal: '목표', summary: '요약', cwd: 'C:/x' };
  const task = { id: 't2', title: '구현', assignee: 'claude', prompt: '구현해', dependsOn: ['t1'] };
  const p = buildWorkerPrompt({ job, task, hubDir: 'C:/hub', memoryCtx: '', siblings: [{ id: 't1', title: '조사', assignee: 'codex', status: 'done' }, task], depResults: [{ id: 't1', title: '조사', assignee: 'codex', text: '조사결과' }] });
  assert.match(p, /조사결과/); assert.match(p, /t1 \(codex, done\): 조사/); assert.doesNotMatch(p, /t2 \(claude/);
});

import { sniff } from '../lib/attachments.mjs';
import { resolveSettings } from '../lib/options.mjs';

test('sniff: 파일 서명으로 이미지 판별, 텍스트는 거부', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000808020000', 'hex');
  assert.deepEqual(sniff(png), { mime: 'image/png', width: 16, height: 8 });
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniff(Buffer.from('hello world, not an image')), null);
});

test('resolveSettings: 기본값 병합, 잘못된 값은 버림', () => {
  const config = { defaults: { claude: { model: '', effort: '' }, codex: { model: '', effort: 'medium' } } };
  const s = resolveSettings(config, { claude: { model: 'haiku', effort: 'low' } });
  assert.deepEqual(s.claude, { model: 'haiku', effort: 'low' });
  assert.equal(s.codex.effort, 'medium');
  const bad = resolveSettings(config, { claude: { model: 'x; rm -rf /', effort: 'turbo' } });
  assert.equal(bad.claude.model, '');
  assert.equal(bad.claude.effort, '');
});

import { finalizeChoice, heuristicTier } from '../lib/router.mjs';

test('자동 선택: 고정값 유지, 자동은 하한(Opus·high / GPT-6.1-Sol·high) 이상 보장', () => {
  const config = { defaults: {} };
  const fixed = finalizeChoice(config, 'claude', { model: 'haiku', effort: 'low' }, { model: 'fable', effort: 'max' }, null);
  assert.deepEqual([fixed.model, fixed.effort, fixed.auto], ['haiku', 'low', false]);
  const free = finalizeChoice(config, 'claude', { model: 'auto', effort: 'auto' }, { model: 'fable', effort: 'xhigh', reason: '어려움' }, { claude: { windows: [{ usedPercent: 20 }] } });
  assert.deepEqual([free.model, free.effort], ['fable', 'xhigh']);
  // 하한보다 낮은 걸 골라도 끌어올린다
  const low = finalizeChoice(config, 'claude', { model: 'auto', effort: 'auto' }, { model: 'haiku', effort: 'low' }, null);
  assert.deepEqual([low.model, low.effort], ['opus', 'high']);
  // 한도가 빠듯하면 최상위는 피하되 하한 아래로는 안 내림
  const tight = finalizeChoice(config, 'claude', { model: 'auto', effort: 'auto' }, { model: 'fable', effort: 'max' }, { claude: { windows: [{ usedPercent: 93 }] } });
  assert.deepEqual([tight.model, tight.effort], ['opus', 'high']); assert.match(tight.reason, /93%/);
  const junk = finalizeChoice(config, 'claude', { model: 'auto', effort: 'auto' }, { model: 'gpt-9000', effort: 'turbo' }, null);
  assert.deepEqual([junk.model, junk.effort], ['opus', 'high']);
});

test('규칙 기반 난이도', () => {
  assert.equal(heuristicTier('색 이름 하나만 말해'), 'light');
  assert.equal(heuristicTier('로그인 버그 원인을 찾아서 고쳐줘'), 'strong');
  assert.equal(heuristicTier('설정 화면에 다크모드 토글 버튼을 추가하고 테스트도 작성해줘'), 'standard');
});
