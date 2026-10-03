import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sessions-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
const { JobManager } = await import('../lib/jobs.mjs');
let serial = 0;
const code = (name) => (e) => e.code === name;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t, repo = false) {
  const root = path.join(temp, 'case-' + ++serial); fs.mkdirSync(root, { recursive: true });
  if (repo) {
    git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', '시험'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, '기준.txt'), '기준'); git(root, 'add', '.'); git(root, 'commit', '-m', '기준');
  }
  const config = { defaultCwd: root, hubDir: path.join(root, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, defaults: {} };
  const m = new JobManager(config); clearTimeout(m._saveTimer); m.sessions.clear(); m.jobs.clear();
  m.run = async (job) => { job.testHistory = m.historyContext(job); job.status = 'done'; };
  t.after(() => clearTimeout(m._saveTimer)); return { root, config, m };
}
function seed(m, session, n = 3) {
  const s = m.sessions.get(session.id), jobs = [];
  for (let i = 1; i <= n; i++) {
    const j = { id: `${session.id}-j${i}`, sessionId: s.id, title: `작업 ${i}`, cwd: s.cwd, goal: `원본 요청 ${i}`, input: `사용자 요청 ${i}`, status: 'done', createdAt: `2026-10-01T00:00:0${i}.000Z`, summary: `계획 ${i}`, report: `보고 ${i}`, tasks: [{ id: 't1', title: '구현', assignee: 'codex', status: 'done', resultText: `작업 결과 ${i}` }], changedFiles: ['파일-' + i + '.mjs'], runDir: path.join(process.env.HUB_RUNS_DIR, `${session.id}-j${i}`) };
    m.jobs.set(j.id, j); s.jobIds.push(j.id); jobs.push(j);
  }
  return jobs;
}

test('보관·복원: 목록 분리·작업 유지·SSE 필드·보관 후 요청 거절', async (t) => {
  const { m } = fixture(t), s = m.createSession({ title: '보관 시험' }); seed(m, s); const events = []; m.on('event', (e) => events.push(e));
  const r = await m.sessionTools.archive(s.id); assert.equal(r.archived, true); assert.equal(r.jobCount, 3); assert.equal(m.listSessions().length, 0); assert.equal(m.listSessions({ archived: true }).length, 1);
  assert.equal(events.at(-1).session.archived, true); assert.equal(events.at(-1).session.git, null); assert.equal(events.at(-1).session.forkOf, null);
  assert.throws(() => m.create({ sessionId: s.id, goal: '새 요청' }), code('SESSION_ARCHIVED'));
  assert.throws(() => m.startGoal({ sessionId: s.id, text: '목표' }), code('SESSION_ARCHIVED'));
  assert.throws(() => m.retryTask(m.sessions.get(s.id).jobIds[0], 't1'), code('SESSION_ARCHIVED'));
  await m.sessionTools.archive(s.id, {}, false); assert.equal(m.listSessions().length, 1); assert.equal(m.sessionJobs(s.id).length, 3);
});
test('실행 중·목표 라운드 전환·종료 중 워커가 있으면 보관·삭제·Git 변경 거절', async (t) => {
  const { m } = fixture(t), s = m.createSession(), [j] = seed(m, s, 1);
  for (const status of ['queued', 'planning', 'running', 'reporting']) {
    j.status = status; await assert.rejects(m.sessionTools.archive(s.id), code('SESSION_RUNNING')); assert.throws(() => m.deleteSession(s.id), code('SESSION_RUNNING'));
  }
  j.status = 'done'; m.sessions.get(s.id).goal = { status: 'active' }; await assert.rejects(m.sessionTools.archive(s.id), code('SESSION_RUNNING'));
  m.sessions.get(s.id).goal.status = 'paused'; m.running.set(`${j.id}/t1`, {}); await assert.rejects(m.sessionTools.archive(s.id), code('SESSION_RUNNING')); m.running.clear();
  assert.equal((await m.sessionTools.archive(s.id)).archived, true);
});
test('갈래: 특정 작업까지·중첩 갈래·원본 기록 복사 없음·다음 요청에 맥락 전달', (t) => {
  const { m } = fixture(t), original = m.createSession({ title: '원본' }), jobs = seed(m, original);
  const fork = m.sessionTools.fork(original.id, { jobId: jobs[1].id }); assert.equal(fork.jobCount, 0); assert.equal(fork.forkTitle, '원본'); assert.deepEqual(fork.forkOf, { sessionId: original.id, jobId: jobs[1].id });
  const request = m.create({ sessionId: fork.id, goal: '갈래 요청' }), job = m.get(request.id);
  assert.match(job.testHistory, /원본 요청 1/); assert.match(job.testHistory, /보고 2/); assert.doesNotMatch(job.testHistory, /원본 요청 3|갈래 요청/); assert.equal(m.jobs.size, 4);
  const nested = m.sessionTools.fork(fork.id); const request2 = m.create({ sessionId: nested.id, goal: '중첩 요청' }); assert.match(m.get(request2.id).testHistory, /갈래 요청/); assert.match(m.get(request2.id).testHistory, /원본 요청 2/);
  assert(m.historyContext(m.get(request2.id), 50).length < 100);
});
test('갈래: 생성 API forkOf·없는 작업·빈 세션·원본 참조 삭제 보호', (t) => {
  const { m } = fixture(t), original = m.createSession(), jobs = seed(m, original);
  const fork = m.createSession({ forkOf: { sessionId: original.id, jobId: jobs[0].id } }); assert.equal(fork.cwd, original.cwd);
  assert.throws(() => m.sessionTools.fork(original.id, { jobId: '없음' }), code('FORK_JOB_INVALID'));
  assert.throws(() => m.deleteSession(original.id), code('SESSION_FORK_REFERENCED')); assert.throws(() => m.remove(jobs[0].id), code('SESSION_FORK_REFERENCED'));
  assert.equal(m.remove(jobs[2].id), true); assert.equal(m.deleteSession(fork.id), true); assert.equal(m.deleteSession(original.id), true);
  const empty = m.createSession(), emptyFork = m.sessionTools.fork(empty.id); seed(m, empty, 1);
  assert.equal(m.historyContext({ id: 'new', sessionId: emptyFork.id, createdAt: '2026-10-03' }), '');
});
test('격리 세션은 실제 작업 cwd로 연결·다른 worktree 선택·보관은 기본 worktree 보존', async (t) => {
  const { m, root } = fixture(t, true), isolated = m.createSession({ title: '격리', isolate: true });
  const j = m.create({ sessionId: isolated.id, cwd: root, goal: '작업' }); assert.equal(j.cwd, isolated.cwd); assert.notEqual(j.cwd, root);
  await m.sessionTools.archive(isolated.id); assert(fs.existsSync(isolated.cwd)); await m.sessionTools.archive(isolated.id, {}, false);
  const fork = m.sessionTools.fork(isolated.id, { isolate: true }); assert.notEqual(fork.cwd, isolated.cwd); assert.equal(fork.git.baseBranch, isolated.git.branch);
  await assert.rejects(m.sessionTools.gitAction(isolated.id, 'cleanup'), code('GIT_WORKTREE_SHARED'));
  const shared = m.sessionTools.fork(isolated.id); await assert.rejects(m.sessionTools.gitAction(isolated.id, 'cleanup'), code('GIT_WORKTREE_SHARED'));
  m.deleteSession(shared.id); m.deleteSession(fork.id); await m.sessionTools.archive(isolated.id, { cleanup: true }); assert(!fs.existsSync(isolated.cwd));
  await m.sessionTools.archive(isolated.id, {}, false); assert.throws(() => m.create({ sessionId: isolated.id, goal: '정리 후' }), code('GIT_WORKTREE_REMOVED'));
  const newFork = m.sessionTools.fork(isolated.id, { isolate: true }); assert(newFork.git.isolated);
});
test('삭제·보관 정리: 변경이 있으면 세션 유지, 기본 삭제는 worktree 유지', async (t) => {
  const { m } = fixture(t, true), s = m.createSession({ isolate: true }); fs.writeFileSync(path.join(s.cwd, '변경.txt'), '변경');
  await assert.rejects(m.sessionTools.delete(s.id, true), code('GIT_DIRTY')); assert(m.sessions.has(s.id));
  await assert.rejects(m.sessionTools.archive(s.id, { cleanup: true }), code('GIT_DIRTY')); assert.equal(m.sessions.get(s.id).archived, false);
  await m.sessionTools.delete(s.id); assert(fs.existsSync(s.cwd));
});
test('내보내기: 요청·계획·작업 결과·보고·파일 경로·갈래 맥락, 원시 실행 자료 제외', (t) => {
  const { m } = fixture(t), s = m.createSession({ title: '내보내기' }), [j] = seed(m, s, 1);
  fs.mkdirSync(j.runDir, { recursive: true }); fs.writeFileSync(path.join(j.runDir, 't1.log.jsonl'), [JSON.stringify({ kind: 'tool', name: 'Edit', detail: 'add 추가.mjs, update 수정.mjs' }), JSON.stringify({ kind: 'tool', name: 'Read', detail: '읽기만.txt' }), '잘못된 줄'].join('\n'));
  j.rawCredential = '내보내면 안 되는 필드'; const md = m.sessionTools.export(s.id);
  for (const text of ['사용자 요청 1', '계획 1', '작업 결과 1', '보고 1', '파일-1.mjs', '추가.mjs', '수정.mjs']) assert(md.includes(text), text);
  assert(!md.includes('읽기만.txt')); const json = m.sessionTools.export(s.id, 'json'); assert.equal(json.version, 1); assert.equal(json.jobs.length, 1); assert(!JSON.stringify(json).includes(j.rawCredential));
  const fork = m.sessionTools.fork(s.id); assert.match(m.sessionTools.export(fork.id), /이어받은 대화 맥락/);
});
test('저장·재시작: archived·git·forkOf와 맥락 복원', async (t) => {
  const { m, config } = fixture(t, true), s = m.createSession({ isolate: true }); const [j] = seed(m, s, 1); const fork = m.sessionTools.fork(s.id);
  await m.sessionTools.archive(s.id); await delay(220); const loaded = new JobManager(config); t.after(() => clearTimeout(loaded._saveTimer));
  assert.equal(loaded.sessions.get(s.id).archived, true); assert.equal(loaded.sessions.get(s.id).git.branch, s.git.branch); assert.equal(loaded.sessions.get(fork.id).forkOf.jobId, j.id);
  assert.match(loaded.historyContext({ id: 'new', sessionId: fork.id, createdAt: '2026-10-03' }), /보고 1/);
});
test('같은 저장소 Git 작업 중 새 요청·새 세션·보관 거절', async (t) => {
  const { m, root } = fixture(t, true), s = m.createSession({ isolate: true }); let finish;
  git(s.cwd, 'remote', 'add', 'origin', path.join(root, 'local-only.git')); m.sessionTools.git.exec = () => new Promise((resolve) => { finish = resolve; });
  const pushing = m.sessionTools.gitAction(s.id, 'push');
  assert.throws(() => m.create({ sessionId: s.id, goal: '경합' }), code('GIT_BUSY')); assert.throws(() => m.createSession({ cwd: root }), code('GIT_BUSY')); await assert.rejects(m.sessionTools.archive(s.id), code('GIT_BUSY'));
  finish({ ok: true }); await pushing;
});

test('7713 격리 시험 서버: API·다운로드 헤더·SSE·보관함·갈래·Git·오류 코드', async (t) => {
  const { root, config } = fixture(t, true), apiRoot = path.join(temp, 'api'); fs.mkdirSync(apiRoot);
  const configFile = path.join(apiRoot, 'config.json'), data = path.join(apiRoot, 'data'), runs = path.join(apiRoot, 'runs');
  fs.mkdirSync(data); fs.writeFileSync(configFile, JSON.stringify({ ...config, port: 7713, host: '127.0.0.1' }));
  const seededSession = { id: 's-api', cwd: root, title: 'API 원본', archived: false, jobIds: ['api-job'], createdAt: '2026-10-01', updatedAt: '2026-10-01' };
  fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify([seededSession])); fs.writeFileSync(path.join(data, 'jobs.json'), JSON.stringify([{ id: 'api-job', sessionId: 's-api', title: 'API 작업', cwd: root, createdAt: '2026-10-01', goal: 'API 요청', report: 'API 보고', summary: 'API 계획', tasks: [], status: 'done' }]));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HUB_PORT: '7713', HUB_DATA_DIR: data, HUB_RUNS_DIR: runs, HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill(); await exited; } });
  const call = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:7713${p}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) }); return { r, body: await r.json() }; };
  for (let n = 0; !output.includes('ODDIN  http://127.0.0.1:7713'); n++) { if (child.exitCode !== null || n > 100) assert.fail(output || '시험 서버 시작 실패'); await delay(30); }
  const created = await call('/api/sessions', 'POST', { cwd: root, title: 'API 격리', isolate: true }); assert.equal(created.r.status, 201); const id = created.body.id; assert.equal(created.body.git.isolated, true);
  const sse = await new Promise((resolve, reject) => {
    const stream = http.get('http://127.0.0.1:7713/api/events', (res) => {
      let data = ''; res.on('data', (c) => { data += c; if (data.includes('"type":"session"')) { stream.destroy(); resolve(data); } });
      res.once('data', () => { call(`/api/sessions/${id}/archive`, 'POST', {}).catch(reject); });
    }); stream.on('error', reject); stream.setTimeout(5000, () => { stream.destroy(); reject(new Error('SSE 시험 시간 초과')); });
  });
  assert.match(sse, /"archived":true/); assert.match(sse, /"isolated":true/); assert.match(sse, /"forkOf":null/);
  assert(!(await call('/api/sessions')).body.some((s) => s.id === id)); assert((await call('/api/sessions?archived=1')).body.some((s) => s.id === id));
  assert.equal((await call(`/api/sessions/${id}/unarchive`, 'POST', {})).body.archived, false);
  assert.equal((await call(`/api/sessions/${id}/git`)).body.branch, created.body.git.branch);
  assert.equal((await call(`/api/sessions/${id}/git/ci`)).body.status, 'unavailable');
  const fork = await call('/api/sessions/s-api/fork', 'POST', { jobId: 'api-job', isolate: true }); assert.equal(fork.r.status, 201); assert.equal(fork.body.forkOf.jobId, 'api-job');
  const download = await fetch('http://127.0.0.1:7713/api/sessions/s-api/export.md'); assert.match(download.headers.get('content-disposition'), /attachment; filename="s-api.md"/); assert((await download.text()).includes('API 보고'));
  assert.equal((await call('/api/sessions/s-api/export.json')).body.jobs[0].request, 'API 요청');
  assert.equal((await call('/api/sessions/s-api', 'DELETE')).body.code, 'SESSION_FORK_REFERENCED');
  assert.equal((await call('/api/sessions/unknown/git')).r.status, 404); assert.equal((await call(`/api/sessions/${id}/git/commit`)).r.status, 405);
  const malformed = await fetch(`http://127.0.0.1:7713/api/sessions/${id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{잘못된 JSON' }); assert.equal(malformed.status, 400); assert.equal((await malformed.json()).code, 'INVALID_JSON');
  fs.writeFileSync(path.join(created.body.cwd, '충분한 시험.txt'), 'API 변경'); const committed = await call(`/api/sessions/${id}/git/commit`, 'POST', { message: 'API 커밋' }); assert.equal(committed.body.committed, true);
  assert.equal((await call(`/api/sessions/${id}/git/merge`, 'POST', {})).body.merged, true);
  assert.equal((await call(`/api/sessions/${id}/git/pr`, 'POST', {})).body.code, 'GIT_NOT_GITHUB');
  assert.equal((await call(`/api/sessions/${id}?cleanup=1`, 'DELETE')).body.removed, true); assert(!fs.existsSync(created.body.cwd));
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
