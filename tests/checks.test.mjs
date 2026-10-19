// ODDIN 검사(2026-10-19 사용자 "1~3 해줘"): 허브가 확인 명령을 직접 돌려 판정 · 실패하면 같은 작업자에게 한 번 · 이전 대화는 파일로
// 실제 모델 호출 없음. 작업자는 가짜 launch 로 대신하고, 검사 명령은 node 로 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-checks-'));
process.env.HUB_DATA_DIR = path.join(home, 'data');
process.env.HUB_RUNS_DIR = path.join(home, 'runs');
test.after(() => { try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {} });

const { cleanChecks, declaredChecks, unsafeReason, missingScript, runCheck, runTaskChecks, checksSummary, checksConfig } = await import('../lib/checks.mjs');
const { buildWorkerPrompt, checksRule } = await import('../lib/planner.mjs');
const { JobManager } = await import('../lib/jobs.mjs');

const manager = (config = {}) => Object.assign(Object.create(JobManager.prototype), {
  config: { tools: {}, defaults: {}, ...config }, _cat: { agents: [] }, sessions: new Map(), jobs: new Map(),
  emitJob() {}, log() {}, trackWorker: (job, start) => start(),
});
const NODE = `"${process.execPath}"`;

test('명령 다듬기: 따옴표·코드 표시 빼고, 여러 줄·너무 긴 것·겹치는 것 빼고 3개까지, "확인 명령:" 줄 읽기', () => {
  assert.deepEqual(cleanChecks(['`npm test`', ' "node --check a.js" ', 'npm test', 'a\nb', 'x'.repeat(301), 'one', 'two']), ['npm test', 'node --check a.js', 'one']);
  assert.deepEqual(cleanChecks(null), []);
  const text = '① 고쳤어요\n④ 없음\n\n확인 명령: `npm test`\n- **확인 명령**: node --check lib/a.mjs\n확인 명령：python -m pytest tests\n본문 속 확인 명령: 은 줄 처음이 아니라 무시';
  assert.deepEqual(declaredChecks(text), ['npm test', 'node --check lib/a.mjs', 'python -m pytest tests']);
  assert.deepEqual(declaredChecks('**확인 명령:** `npm run validate`\n확인 명령: "C:\\node.exe" -e "process.exit(0)"'), ['npm run validate', '"C:\\node.exe" -e "process.exit(0)"'], '안에도 따옴표가 있으면 벗기지 않음');
  assert.deepEqual(declaredChecks(''), []);
});

test('돌리지 않는 명령: 지우기·되돌리기·push·설치·배포·네트워크·출력 돌려쓰기, 비교 연산은 괜찮음', () => {
  for (const c of ['rm -rf dist', 'git push origin main', 'git reset --hard', 'npm install', 'npm i lodash', 'npx vercel --prod', 'curl https://x', 'echo hi > a.txt', 'type a >> b', 'Remove-Item a', 'del /s x', 'npm run deploy'])
    assert.ok(unsafeReason(c), c);
  for (const c of ['npm test', 'npm run validate', 'node --check lib/a.mjs', 'python -m pytest -q', 'node -e "process.exit(1 >= 0 ? 0 : 1)"', 'git diff --stat', 'git status'])
    assert.equal(unsafeReason(c), null, c);
});

test('없는 npm 스크립트는 미리 거른다', () => {
  const dir = fs.mkdtempSync(path.join(home, 'pkg-'));
  assert.match(missingScript('npm test', dir), /package\.json 이 없어요/);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js', 'validate:kb': 'x' } }));
  assert.equal(missingScript('npm test', dir), null);
  assert.equal(missingScript('npm run validate:kb', dir), null);
  assert.match(missingScript('npm run build', dir), /"build" 스크립트가 없어요/);
  assert.equal(missingScript('node --check a.js', dir), null);
});

test('명령 돌리기: 통과·실패(종료 코드·출력 끝)·시간 초과, 전체 출력은 기록 파일로', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'run-'));
  const ok = await runCheck(`${NODE} -e "console.log('hello')"`, { cwd: dir, logFile: path.join(dir, 'l', '1.log') });
  assert.equal(ok.ok, true); assert.equal(ok.code, 0); assert.match(ok.tail, /hello/);
  assert.match(fs.readFileSync(path.join(dir, 'l', '1.log'), 'utf8'), /hello/);
  const bad = await runCheck(`${NODE} -e "console.error('boom'); process.exit(3)"`, { cwd: dir });
  assert.deepEqual([bad.ok, bad.code, bad.timedOut], [false, 3, false]); assert.match(bad.tail, /boom/);
  const slow = await runCheck(`${NODE} -e "setTimeout(() => {}, 60000)"`, { cwd: dir, timeoutMs: 400 });
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
});

test('검사 묶음: 위험한 명령·없는 스크립트는 건너뛰고(판정에 안 셈), 하나라도 실패면 refuted, 돌린 게 없으면 unverified', async () => {
  const dir = fs.mkdtempSync(path.join(home, 'set-'));
  const events = [];
  const pass = `${NODE} -e "process.exit(0)"`, fail = `${NODE} -e "process.exit(1)"`;
  let r = await runTaskChecks({ cmds: [pass, 'git push origin main'], cwd: dir, onEvent: (e) => events.push(e) });
  assert.equal(r.verified, 'verified'); assert.match(r.results[1].skipped, /돌리지 않았어요/);
  assert.deepEqual(events.map((e) => [e.kind, e.state]), [['check', 'running'], ['check', 'pass'], ['check', 'skipped']]);
  r = await runTaskChecks({ cmds: [pass, fail], cwd: dir });
  assert.equal(r.verified, 'refuted');
  r = await runTaskChecks({ cmds: ['npm test'], cwd: dir });
  assert.equal(r.verified, 'unverified');
  const task = { checkRuns: [{ results: [{ cmd: 'npm test', ok: true, code: 0, ms: 12_000 }, { cmd: 'npm run x', skipped: 'package.json 에 "x" 스크립트가 없어요' }] }], verified: 'verified' };
  assert.match(checksSummary(task), /^ODDIN 검사\(허브가 직접 실행\): 통과 1\/1 — npm test 통과 12초, npm run x\(건너뜀: /);
  assert.equal(checksSummary({}), '');
});

test('작업자 지시문: 검사 안내(계획 명령 / 명령 없음), 실패 돌려보내기는 같은 대화면 짧게 · 새 대화면 원래 과제 + 실패', () => {
  assert.equal(checksRule(null), '');
  assert.match(checksRule({ cmds: ['npm test'] }), /ODDIN이 작업 폴더에서 확인 명령\(`npm test`\)을 직접 돌려/);
  assert.match(checksRule({ cmds: [] }), /결과 맨 끝에 `확인 명령: <명령>` 줄/);
  const job = { id: 'j1', goal: '로그 파서 고쳐줘', cwd: 'C:/p', intercepts: [], tasks: [] };
  const task = { id: 't1', title: '파서 수정', prompt: '파서를 고친다', assignee: 'claude' };
  const base = { job, task, siblings: [], depResults: [], hubDir: '', memoryCtx: '' };
  assert.match(buildWorkerPrompt({ ...base, checks: { cmds: ['npm test'] } }), /확인 명령\(`npm test`\)/);
  assert.doesNotMatch(buildWorkerPrompt(base), /확인 명령/);
  const failed = [{ cmd: 'npm test', code: 1, tail: 'FAIL parser.test' }];
  const short = buildWorkerPrompt({ ...base, checkFix: { resume: true, results: failed } });
  assert.match(short, /^\[ODDIN 검사 실패\] 작업 j1\/t1\n/); assert.match(short, /`npm test` → 종료 코드 1/); assert.match(short, /FAIL parser\.test/);
  assert.doesNotMatch(short, /사용자 요청 원문/);
  const full = buildWorkerPrompt({ ...base, checkFix: { resume: false, results: failed, prevText: '① 고쳤어요' } });
  assert.match(full, /# ODDIN 검사 실패 — 먼저 이것부터/); assert.match(full, /지난 결과 요약:\n① 고쳤어요/); assert.match(full, /# 사용자 요청 원문 \(작업 범위의 기준\)\n로그 파서 고쳐줘/);
});

test('검사를 돌리는 작업: 질문·눈으로 확인·디자인 기획·승인 받는 방식은 빼고, 설정으로 끌 수 있다', () => {
  const m = manager();
  assert.equal(m.checksOn({ settings: {} }, {}), true);
  assert.equal(m.checksOn({ answer: true }, {}), false);
  assert.equal(m.checksOn({}, { visualCheck: true }), false);
  assert.equal(m.checksOn({}, { designPlan: true }), false);
  assert.equal(m.checksOn({ settings: { permission: 'ask' } }, {}), false);
  assert.equal(manager({ checks: { enabled: false } }).checksOn({}, {}), false);
  assert.deepEqual(checksConfig({}), { enabled: true, timeoutMinutes: 10, fixRounds: 1, max: 3 });
});

// 가짜 작업 폴더: check.js 는 fixed.txt 가 있어야 통과
const workspace = () => {
  const dir = fs.mkdtempSync(path.join(home, 'ws-'));
  fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync(__dirname + '/fixed.txt') ? 0 : 1)");
  return dir;
};

test('검사 실패 → 같은 작업자(Claude 는 같은 대화)에게 한 번 돌려보내고, 고치면 다시 검사해 통과', async () => {
  const cwd = workspace(), runDir = path.join(cwd, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const m = manager();
  const job = { id: 'j1', goal: '고쳐줘', cwd, intercepts: [], tasks: [], notes: [], status: 'running' };
  const task = { id: 't1', title: '파서 수정', prompt: '고친다', assignee: 'claude', status: 'done', sessionId: 'cl-1', checks: [`${NODE} check.js`], resultText: '① 고쳤어요' };
  job.tasks.push(task);
  const calls = [];
  const launch = async (prompt) => { calls.push({ prompt, resume: task.resumeSessionId }); fs.writeFileSync(path.join(cwd, 'fixed.txt'), 'ok'); return { ok: true, text: '② fixed.txt 만듦', sessionId: 'cl-1' }; };
  const promptFor = (c, extra = {}) => buildWorkerPrompt({ job, task, siblings: [], depResults: [], hubDir: '', memoryCtx: '', ...extra });
  await m.verifyTask(job, task, { launch, promptFor, runDir });
  assert.equal(calls.length, 1); assert.equal(calls[0].resume, 'cl-1', 'Claude 는 같은 대화를 이어서');
  assert.match(calls[0].prompt, /^\[ODDIN 검사 실패\]/);
  assert.ok(fs.existsSync(path.join(runDir, 'prompt-fix1.md')));
  assert.equal(task.checkRuns.length, 2); assert.equal(task.verified, 'verified'); assert.equal(task.status, 'done');
  assert.equal(task.resumeSessionId, null);
  assert.match(task.resultText, /① 고쳤어요\n\n---\n\[ODDIN 검사 실패 뒤 다시 맡긴 결과\]\n② fixed\.txt 만듦/);
  assert.match(checksSummary(task), /통과 1\/1 — 첫 검사 실패 뒤 고쳐서 2번째 검사/);
  assert.equal(job.notes.length, 0);
});

test('Codex 는 새 대화로 원래 과제 + 실패, 고쳐도 안 되면 한 번으로 끝내고 알림(요청은 일부 완료로)', async () => {
  const cwd = workspace(), runDir = path.join(cwd, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const m = manager();
  const job = { id: 'j2', goal: '고쳐줘', cwd, intercepts: [], tasks: [], notes: [], status: 'running' };
  const task = { id: 't1', title: '파서 수정', prompt: '고친다', assignee: 'codex', status: 'done', sessionId: 'cx-1', checks: [`${NODE} check.js`], resultText: '① 고쳤어요' };
  job.tasks.push(task);
  const calls = [];
  const launch = async (prompt) => { calls.push({ prompt, resume: task.resumeSessionId }); return { ok: true, text: '못 고침' }; };
  const promptFor = (c, extra = {}) => buildWorkerPrompt({ job, task, siblings: [], depResults: [], hubDir: '', memoryCtx: '', ...extra });
  await m.verifyTask(job, task, { launch, promptFor, runDir });
  assert.equal(calls.length, 1); assert.equal(calls[0].resume, null);
  assert.match(calls[0].prompt, /# ODDIN 검사 실패 — 먼저 이것부터/);
  assert.equal(task.checkRuns.length, 2); assert.equal(task.verified, 'refuted'); assert.equal(task.status, 'done');
  assert.match(job.notes.join('\n'), /"파서 수정" 작업은 끝났지만 ODDIN 검사를 통과하지 못했어요/);
});

test('작업자가 적은 "확인 명령:" 이 계획의 명령보다 우선, 명령이 없으면 검사하지 않음', async () => {
  const cwd = workspace(), runDir = path.join(cwd, 'run');
  const m = manager();
  const job = { id: 'j3', goal: 'x', cwd, intercepts: [], tasks: [], notes: [], status: 'running' };
  const task = { id: 't1', title: 'x', prompt: 'x', assignee: 'claude', status: 'done', checks: [`${NODE} check.js`], resultText: `끝\n확인 명령: ${NODE} -e "process.exit(0)"` };
  await m.verifyTask(job, task, { launch: async () => assert.fail('돌려보내면 안 됨'), promptFor: () => '', runDir });
  assert.equal(task.verified, 'verified'); assert.match(task.checkRuns[0].results[0].cmd, /process\.exit\(0\)/);
  const none = { id: 't2', title: 'y', prompt: 'y', assignee: 'claude', status: 'done', resultText: '끝' };
  await m.verifyTask(job, none, { launch: async () => assert.fail(), promptFor: () => '', runDir });
  assert.equal(none.checkRuns, undefined); assert.equal(none.verified, undefined);
});

test('이전 대화는 파일로: 길면 결정 노트 + 직전 요청 요약 + 파일 위치만, 짧거나 끄면 그대로', () => {
  const m = manager();
  const runDir = fs.mkdtempSync(path.join(home, 'hist-'));
  m.sessions.set('s1', { id: 's1', jobIds: ['a', 'b', 'c'] });
  m.jobs.set('a', { id: 'a', createdAt: '2026-10-19T01:00:00Z', goal: '처음 요청', report: '처음 결과', status: 'done' });
  m.jobs.set('b', { id: 'b', createdAt: '2026-10-19T02:00:00Z', goal: '직전 요청 원문', report: '직전 결과 요약입니다', status: 'partial' });
  const job = { id: 'c', sessionId: 's1', createdAt: '2026-10-19T03:00:00Z', runDir };
  m.jobs.set('c', job);
  m.historyContext = (j, limit, opts = {}) => (opts.notesOnly ? '## 세션 결정 노트\n- 파란색으로 정함' : `## 최근 명령과 결과\n${'긴 기록 '.repeat(opts.maxItems === 6 ? 2000 : 800)}`);
  const out = m.workerHistory(job);
  assert.match(out, /^## 세션 결정 노트\n- 파란색으로 정함\n\n## 직전 요청 \(b, partial\)\n직전 요청 원문\n결과 요약: 직전 결과 요약입니다/);
  const file = path.join(runDir, 'context', 'THREAD.md');
  assert.ok(out.includes(file)); assert.ok(out.length < 1000);
  assert.ok(fs.readFileSync(file, 'utf8').length > 10_000, '파일에는 더 긴 기록(최근 6건)');
  m.historyContext = () => '짧은 기록';
  assert.equal(m.workerHistory(job), '짧은 기록');
  m.historyContext = (j, limit, opts = {}) => (opts.notesOnly ? '' : 'x'.repeat(5000));
  m.config.context = { historyFile: false };
  assert.equal(m.workerHistory(job).length, 5000);
});

// 실제 요청 흐름(계획 → 작업 → ODDIN 검사 → 실패면 같은 작업자에게 → 다시 검사 → 보고), CLI 는 모의
async function runJob({ neverFix = false } = {}) {
  const { invalidateToolStatus } = await import('../lib/tools.mjs');
  invalidateToolStatus();
  const root = fs.mkdtempSync(path.join(home, 'e2e-')), cwd = path.join(root, 'project'), capture = path.join(root, 'capture.jsonl');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'check.js'), "process.exit(require('fs').existsSync(__dirname + '/fixed.txt') ? 0 : 1)");
  const cli = path.resolve('tests/fixtures/checks-cli.mjs');
  const command = (tool) => `"${process.execPath}" "${cli}" --tool ${tool} --capture "${capture}"${neverFix ? ' --never-fix' : ''}`;
  const m = new JobManager({ hubDir: path.join(root, 'shared'), defaultCwd: cwd, maxParallel: 2, planner: 'claude', fastPath: { enabled: false }, memory: { curate: false },
    tools: { claude: { command: command('claude'), transport: 'legacy' }, codex: { command: command('codex'), transport: 'legacy' } }, defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } } });
  m.memoryFor = () => '';
  const pub = m.create({ goal: '파서 고쳐줘', mode: 'auto', cwd });
  const job = m.get(pub.id);
  await new Promise((resolve, reject) => {
    const end = () => !['queued', 'planning', 'running', 'reporting'].includes(job.status);
    if (end()) return resolve();
    const timer = setTimeout(() => { m.off('event', on); reject(new Error(`시간 초과: ${job.status}`)); }, 60_000);
    const on = (e) => { if (e.type === 'job' && e.job.id === job.id && end()) { clearTimeout(timer); m.off('event', on); resolve(); } };
    m.on('event', on);
  });
  clearTimeout(m._saveTimer);
  const rows = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse);
  return { job, rows };
}

test('요청 흐름: 계획의 확인 명령 실패 → 같은 대화로 다시 맡겨 고침 → 통과, 보고에 허브 검사 결과', async () => {
  const { job, rows } = await runJob();
  const t = job.tasks[0];
  assert.equal(job.status, 'done', job.error || JSON.stringify(job.tasks));
  assert.deepEqual(t.checks, ['node check.js']);
  assert.equal(t.verified, 'verified'); assert.equal(t.checkRuns.length, 2);
  const fix = rows.find((r) => r.prompt.startsWith('[ODDIN 검사 실패]'));
  assert.ok(fix, '검사 실패를 짧게 돌려보냄'); assert.ok(fix.args.includes('--resume'), 'Claude 는 같은 대화를 이어서');
  const first = rows.find((r) => r.prompt.startsWith('[AI Hub 작업]'));
  assert.match(first.prompt, /확인 명령\(`node check\.js`\)을 직접 돌려/);
  assert.match(job.report, /\[ODDIN 검사 실패 뒤 다시 맡긴 결과\]\n② fixed\.txt 만듦/);
  // 보고 담당·다음 작업에 넘기는 결과에는 허브가 직접 돌린 검사 결과가 붙는다(작업 하나면 보고 AI 없이 결과를 그대로 씀)
  const { buildReportPrompt } = await import('../lib/planner.mjs');
  const report = buildReportPrompt({ job });
  assert.match(report, /ODDIN 검사\(허브가 직접 실행\): 통과 1\/1 — 첫 검사 실패 뒤 고쳐서 2번째 검사/);
  assert.match(report, /검사 실패로 남은 작업은 완료로 보고하지 마세요/);
});

test('요청 흐름: 다시 맡겨도 못 고치면 작업은 끝났어도 요청은 일부 완료, 알림을 남김', async () => {
  const { job } = await runJob({ neverFix: true });
  assert.equal(job.status, 'partial');
  assert.equal(job.tasks[0].verified, 'refuted');
  assert.match(job.notes.join('\n'), /ODDIN 검사를 통과하지 못했어요/);
});
