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
process.env.HUB_DATA_DIR = path.join(home, 'data');
process.env.HUB_RUNS_DIR = path.join(home, 'runs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const { raiseToStandalone } = await import('../lib/router.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
const usage = () => ({ codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: 10 }] }, claude: { windows: [{ key: 'seven_day', label: '주간', usedPercent: 10 }] } });
const AUTO = () => ({ claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } });
const manager = (config = {}) => Object.assign(Object.create(JobManager.prototype), { config: { tools: {}, defaults: {}, ...config }, _cat: { agents: [] }, sessions: new Map(), jobs: new Map() });

test('질문 판정: 상태 질문은 명사·물음표에 흔들리지 않고 작업 요청·복잡한 분석을 구분', () => {
  const m = manager();
  const q = (s, extra = {}) => m.isQuestion({ input: s, goal: s, ...extra });
  for (const s of ['새로운 규칙 및 모델 엔진 적용했어?', '5편 언제 끝나?', '지금 Fable 한도 얼마나 남았어?', '이 폴더 구조가 어떻게 돼？', '커밋 어디까지 했어?', '커밋 어디까지 했어', '배포됐어', '수정한 거 맞지', '왜 중단함', '레퍼런스들에 비해 퀄리티가 왜 이렇게 별로지;;']) assert.equal(q(s), true, s);
  for (const s of ['이거 고쳐줄 수 있어?', '배경 소품 더 넣어줄래?', '다시 시안 좀 뽑아봐', '원인 조사해줄래?', '오딘이 느려', '커밋해줘?', '배포 좀 해줄래?', '지금 배포해도 돼?', '이거 수정 가능해?', '문구 바꿀래?', '어디든 파일 수정', '아키텍처 전체 설계는 어떻게 하면 돼?']) assert.equal(q(s), false, s);
  assert.equal(q('적용했어?', { goalId: 'g1' }), false, '목표 모드');
  assert.equal(q('적용했어?', { command: { kind: 'command', name: 'review' } }), false, '커맨드');
  assert.equal(q('적용했어?', { intercepts: [{ text: '안 했으면 고쳐줘', status: 'accepted' }] }), false, '수정 지시');
  for (const s of ['21초 동그란 테두리랑 텍스트 정렬 안 맞잖아 왜 검수 똑바로 안해', '왜 안했어? 스킬에 커스포지 푸시까지 포함인데']) assert.equal(q(s), false, '불만·누락 지적을 상태 질문으로 축소하지 않음');
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

test('단순 질문·작은 수정은 하한 강도, 나머지 품질 우선과 직접 고른 강도는 유지', () => {
  const m = manager();
  const run = (task, jobExtra = {}) => { const job = { mode: 'auto', settings: { ...AUTO(), pace: 'quality' }, tasks: [task], input: '', ...jobExtra }; m.applyChoice(job, task, { model: 'gpt-6.1-sol', effort: 'high', reason: '' }, usage()); return task.settings.effort; };
  assert.equal(run({ id: 't1', title: '로그 파서 수정', prompt: '파서', assignee: 'codex' }), 'xhigh');
  assert.equal(run({ id: 't1', title: '적용했어?', prompt: '적용했어?', assignee: 'codex' }, { answer: true }), 'high');
  assert.equal(run({ id: 't1', title: '오타 수정', prompt: '오타 수정', assignee: 'codex' }, { fast: true }), 'high');
  assert.equal(run({ id: 't1', title: '적용했어?', prompt: '적용했어?', assignee: 'codex' }, { answer: true, settings: { ...AUTO(), codex: { model: 'auto', effort: 'xhigh' } } }), 'xhigh');
  assert.equal(run({ id: 't1v', title: '눈으로 확인: 시안', prompt: '확인', assignee: 'codex', visualCheck: true }), 'xhigh');
  assert.equal(run({ id: 't1d', title: '디자인 기획: 시안', prompt: '기획', assignee: 'codex', designPlan: true }), 'xhigh');
  assert.equal(run({ id: 't1i', title: '화면 구현', prompt: '구현', assignee: 'codex', designImpl: true }), 'xhigh');
  assert.equal(run({ id: 't1v', title: '눈으로 확인: 시안', prompt: '확인', assignee: 'codex', visualCheck: true }, { settings: { ...AUTO(), pace: 'speed' } }), 'high');
  assert.equal(run({ id: 't1v', title: '눈으로 확인: 시안', prompt: '확인', assignee: 'codex', visualCheck: true }, { settings: { ...AUTO(), codex: { model: 'gpt-6-astra', effort: 'high' }, pace: 'quality' } }), 'high');
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

test('질문 답 지시문: 작업 보고 형식(①②③④) 대신 바로 답하라고', async () => {
  const { buildWorkerPrompt } = await import('../lib/planner.mjs');
  const task = { id: 't1', title: '적용했어?', assignee: 'codex', prompt: '적용했어?' };
  const ask = buildWorkerPrompt({ job: { id: 'J', cwd: 'C:/p', goal: '적용했어?', summary: '', intercepts: [], answer: true }, task, depResults: [], siblings: [task], hubDir: 'C:/hub', memoryCtx: '' });
  assert.match(ask, /이 요청은 질문입니다/); assert.doesNotMatch(ask, /① 한 일 ② 바뀐\/만든 파일/);
  const work = buildWorkerPrompt({ job: { id: 'J', cwd: 'C:/p', goal: '고쳐줘', summary: '', intercepts: [] }, task, depResults: [], siblings: [task], hubDir: 'C:/hub', memoryCtx: '' });
  assert.match(work, /① 한 일 ② 바뀐\/만든 파일/);
});

test('빠른 처리 통합: 질문은 짧은 새 대화, 작은 화면 수정은 기존 작업 대화로 바로 실행하고 직접 확인', async () => {
  const { invalidateToolStatus } = await import('../lib/tools.mjs');
  const project = path.join(home, 'project'), capture = path.join(home, 'capture.jsonl');
  fs.mkdirSync(project, { recursive: true });
  const command = (tool) => `"${process.execPath}" "${path.resolve('tests/fixtures/intercept-cli.mjs')}" --tool ${tool} --capture "${capture}"`;
  const cfg = { hubDir: path.join(home, 'shared'), defaultCwd: path.join(home, 'default'), fastPath: { enabled: true }, checkpoints: { enabled: false },
    designRule: { enabled: true, mode: 'split', adaptive: true, check: true },
    tools: Object.fromEntries(['claude', 'codex'].map((tool) => [tool, { command: command(tool), transport: 'native', shell: true }])), defaults: AUTO() };
  invalidateToolStatus();
  const m = new JobManager(cfg), s = m.createSession({ cwd: project });
  let waits = 0, curations = 0, checkpoints = 0;
  m.waitCuration = async () => { waits++; };
  m.curate = () => { curations++; };
  m.memoryFor = () => '현재 관련 기억';
  m.checkpoints.begin = async () => { checkpoints++; };
  const dir = path.join(home, 'prior'); fs.mkdirSync(dir);
  const before = new Date(Date.now() - 60_000).toISOString();
  const prior = { id: 'prior', sessionId: s.id, cwd: project, runDir: dir, createdAt: before, finishedAt: before, status: 'done', goal: '화면 문구 구현',
    report: '최근 구현 결과 ' + '긴 작업 기록'.repeat(10000), sessionNotes: [{ text: '기존 색상은 유지' }],
    intercepts: [{ revision: 1, seq: 1, text: '설정 화면은 유지', status: 'delivered' }],
    tasks: [{ id: 't1', assignee: 'codex', status: 'done', sessionId: 'implementation-thread', finishedAt: before }] };
  fs.writeFileSync(path.join(dir, 'REPORT.md'), prior.report);
  fs.writeFileSync(path.join(dir, 'GOAL.md'), prior.goal);
  m.jobs.set(prior.id, prior); m.sessions.get(s.id).jobIds.push(prior.id);
  const run = async (goal, mode = 'auto') => {
    const j = m.get(m.create({ goal, mode, sessionId: s.id }).id), end = Date.now() + 20000;
    while (['queued', 'planning', 'running', 'reporting'].includes(j.status)) {
      if (Date.now() > end) throw new Error('빠른 처리 시험 시간 초과');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(j.status, 'done', j.error || JSON.stringify(j.tasks));
    return j;
  };
  try {
    for (const mode of ['auto', 'codex', 'claude']) {
      const q = await run('커밋 어디까지 했어', mode), prompt = fs.readFileSync(path.join(q.runDir, 't1/prompt.md'), 'utf8');
      assert.equal(q.answer, true); assert.equal(q.tasks.length, 1); assert.equal(q.tasks[0].effort, 'high');
      assert.equal(q.tasks[0].continuedFrom, undefined, '긴 구현 대화는 질문에서 재개하지 않음');
      for (const phase of ['plan', 'route', 'report', 'memory']) assert.equal(q.phaseRuns[phase], undefined, `${phase} AI 호출 생략`);
      assert.match(prompt, /기존 색상은 유지|설정 화면은 유지/); assert.ok(prompt.length < 14000, '이전 긴 출력 대신 제한된 맥락');
      assert.ok(prompt.includes(path.join(dir, 'REPORT.md')), '요약 밖 근거 접근');
      if (mode === 'claude') {
        const invocation = JSON.parse(fs.readFileSync(path.join(q.runDir, 't1/attempt-1/invocation.json')));
        assert.ok(invocation.args.includes('--tools'));
        assert.ok(invocation.args.includes('Read,Glob,Grep,WebFetch,WebSearch'));
        assert.ok(!invocation.args.includes('--dangerously-skip-permissions'));
      }
    }
    assert.equal(waits, 0); assert.equal(curations, 0);
    const edit = await run('버튼 문구 오타만 수정해줘');
    assert.equal(edit.fast, true); assert.equal(edit.tasks.length, 1, '별도 디자인 기획·검수 없음');
    assert.equal(edit.tasks[0].continuedFrom?.sessionId, 'implementation-thread', '질문용 대화가 기존 구현 대화를 대체하지 않음');
    assert.equal(edit.tasks[0].effort, 'high');
    assert.equal(edit.phaseRuns.plan, undefined); assert.equal(edit.phaseRuns.report, undefined);
    assert.match(fs.readFileSync(path.join(edit.runDir, 't1/prompt.md'), 'utf8'), /실제 화면도 확인/);
    assert.equal(waits, 1); assert.equal(curations, 1); assert.equal(checkpoints, 1, '읽기 전용 질문은 생략하고 작은 수정의 변경 복원 기록은 유지');
    const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    const starts = calls.map((x) => x.message).filter((x) => x?.method === 'thread/start');
    assert.ok(starts.length >= 2);
    assert.ok(starts.slice(0, 2).every((x) => x.params?.sandbox === 'read-only' && x.params?.approvalPolicy === 'never'), '질문은 실제 읽기 전용 권한');
    const steered = m.get(m.create({ goal: 'SLOW 커밋 어디까지 했어?', mode: 'codex', sessionId: s.id }).id);
    const deadline = Date.now() + 20000;
    while (!steered.tasks[0]?.sessionId && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(steered.answer, true);
    m.acceptIntercept(steered.id, { sessionId: s.id, clientRequestId: 'question-follow-up', text: '그럼 빠진 부분을 고쳐줘' });
    while (['queued', 'planning', 'running', 'reporting'].includes(steered.status) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(steered.status, 'done', steered.error);
    assert.equal(steered.answer, false, '질문 뒤 추가된 구현 지시는 쓰기 가능한 보완 작업으로 실행');
    assert.equal(checkpoints, 2);
    assert.ok(steered.tasks.some((t) => t.id.startsWith('r1_') && t.status === 'done'));
  } finally {
    for (const j of m.jobs.values()) if (['queued', 'planning', 'running', 'reporting'].includes(j.status)) m.cancel(j.id);
    clearTimeout(m._saveTimer);
  }
});
