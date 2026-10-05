import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import crypto from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-checkpoints-'));
process.env.HUB_DATA_DIR = path.join(temp, 'manager-data');
process.env.HUB_RUNS_DIR = path.join(temp, 'manager-runs');
const { Checkpoints } = await import('../lib/checkpoints.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
const { invalidateToolStatus } = await import('../lib/tools.mjs');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
let serial = 0;
function fixture(options = {}) {
  const root = path.join(temp, `case-${++serial}`), cwd = path.join(root, 'project'), dataDir = path.join(root, 'data'), events = [];
  fs.mkdirSync(cwd, { recursive: true });
  const jobs = [];
  const c = new Checkpoints({ checkpoints: options }, { dataDir, runsDir: path.join(root, 'runs'), emit: (ev) => events.push(structuredClone(ev)), jobs: () => jobs });
  const write = (p, text) => { const full = path.join(cwd, p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); };
  const read = (p) => fs.readFileSync(path.join(cwd, p), 'utf8');
  const job = (id = `j-${serial}`) => { const j = { id, cwd, sessionId: `s-${serial}`, status: 'running', notes: [] }; jobs.push(j); return j; };
  const finish = async (j) => { j.status = 'done'; await c.end(j); assert.equal(j.checkpoint.status, 'ready', j.checkpoint.warning); };
  return { root, cwd, dataDir, c, events, jobs, write, read, job, finish };
}

test('추가·수정·삭제·이름 변경·이진·한글 경로 비교와 줄 단위 diff', async () => {
  const f = fixture(); f.write('수정.txt', '하나\n둘\n'); f.write('삭제.txt', '삭제\n'); f.write('old.txt', '이름 변경 내용\n'); f.write('binary.bin', Buffer.from([0, 1, 2]));
  const j = f.job(); await f.c.begin(j);
  f.write('수정.txt', '하나\n셋\n넷\n'); f.write('추가 [1].txt', '추가\n'); fs.unlinkSync(path.join(f.cwd, '삭제.txt')); fs.renameSync(path.join(f.cwd, 'old.txt'), path.join(f.cwd, 'new.txt')); f.write('binary.bin', Buffer.from([0, 3, 4]));
  await f.finish(j);
  const changes = await f.c.changes(j), by = Object.fromEntries(changes.files.map((x) => [x.path, x]));
  assert.equal(by['수정.txt'].status, 'modified'); assert.equal(by['수정.txt'].additions, 2); assert.equal(by['수정.txt'].deletions, 1);
  assert.equal(by['삭제.txt'].status, 'deleted'); assert.equal(by['추가 [1].txt'].status, 'added'); assert.equal(by['new.txt'].status, 'renamed'); assert.equal(by['new.txt'].oldPath, 'old.txt');
  assert.equal(by['binary.bin'].binary, true); assert.equal(by['binary.bin'].additions, null);
  const diff = await f.c.diff(j, '수정.txt'); assert.match(diff.unified, /-둘\n\+셋\n\+넷/); assert.equal(diff.before, '하나\n둘\n'); assert.equal(diff.after, '하나\n셋\n넷\n');
  assert.equal((await f.c.diff(j, 'binary.bin')).unified, '이진 파일 변경');
  assert.match((await f.c.diff(j, '추가 [1].txt')).unified, /\+추가/);
  assert(f.events.some((e) => e.type === 'checkpoint' && e.checkpoint.status === 'ready'));
});

test('작업 전체 되돌리기와 재시작 뒤 취소: 이름 변경 양쪽·이진·관련 없는 파일 유지', async () => {
  const f = fixture(); f.write('a.txt', '전\r\n'); f.write('deleted.txt', '복원\n'); f.write('old.txt', '이름\n'); f.write('b.bin', Buffer.from([0, 1]));
  const j = f.job(); await f.c.begin(j); f.write('a.txt', '후\r\n'); f.write('added.txt', '생성'); fs.unlinkSync(path.join(f.cwd, 'deleted.txt')); fs.renameSync(path.join(f.cwd, 'old.txt'), path.join(f.cwd, 'new.txt')); f.write('b.bin', Buffer.from([0, 9])); await f.finish(j);
  f.write('unrelated.txt', '사용자 변경');
  const r = await f.c.rewind(j); assert.equal(r.conflicts.length, 0); assert(r.backup); assert.equal(f.read('a.txt'), '전\r\n'); assert.equal(f.read('deleted.txt'), '복원\n'); assert.equal(f.read('old.txt'), '이름\n'); assert(!fs.existsSync(path.join(f.cwd, 'added.txt'))); assert(!fs.existsSync(path.join(f.cwd, 'new.txt')));
  const restarted = new Checkpoints({}, { dataDir: f.dataDir });
  const u = await restarted.undo(r.backup); assert.equal(u.status, 'undone'); assert(u.undoBackup); assert.equal(f.read('a.txt'), '후\r\n'); assert.equal(f.read('added.txt'), '생성'); assert.equal(f.read('new.txt'), '이름\n'); assert(!fs.existsSync(path.join(f.cwd, 'deleted.txt'))); assert.equal(f.read('unrelated.txt'), '사용자 변경');
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, 'b.bin')), Buffer.from([0, 9]));
  assert.deepEqual((await restarted.undo(r.backup)).restored, []);
});

test('파일 하나 복원·충돌 시 전체 보류·강제 덮어쓰기·취소 충돌도 보호', async () => {
  const f = fixture(); f.write('a', '전'); f.write('b', '전'); const j = f.job(); await f.c.begin(j); f.write('a', '후'); f.write('b', '후'); await f.finish(j);
  f.write('a', '사용자'); const blocked = await f.c.rewind(j); assert.deepEqual(blocked.restored, []); assert.equal(blocked.backup, null); assert.equal(blocked.conflicts[0].path, 'a'); assert.equal(f.read('b'), '후');
  const r = await f.c.rewind(j, { paths: ['a'], force: true }); assert.deepEqual(r.restored, ['a']); assert.equal(f.read('a'), '전'); assert.equal(f.read('b'), '후');
  f.write('a', '취소 직전 사용자'); const undoBlocked = await f.c.undo(r.backup); assert.equal(undoBlocked.conflicts[0].path, 'a'); assert.equal(f.read('a'), '취소 직전 사용자');
  const undo = await f.c.undo(r.backup, { force: true }); assert.equal(f.read('a'), '사용자'); await f.c.undo(undo.undoBackup); assert.equal(f.read('a'), '취소 직전 사용자');
  await assert.rejects(f.c.rewind(j, { paths: ['unrelated'] }), (e) => e.code === 'CHECKPOINT_FILE_NOT_FOUND');
  await assert.rejects(f.c.rewind(j, { force: 'true' }), (e) => e.status === 400);
});

test('기본 제외·사용자 패턴·20MB 초과·작은 파일이 큰 파일로 바뀐 경우', async () => {
  const f = fixture({ exclude: ['private/**', '**/*.log', '*.tmp'] });
  for (const p of ['node_modules/pkg/a', 'dist/a', 'nested/.git/config', '.next/a', '.venv/a', '.cache/a', 'private/a', 'nested/a.log', 'a.tmp', '.env', '.env.local']) f.write(p, '스냅샷 금지');
  f.write('large.bin', Buffer.alloc(20 * 1024 * 1024 + 1)); f.write('grow', '작음'); const j = f.job(); await f.c.begin(j); f.write('grow', Buffer.alloc(20 * 1024 * 1024 + 1)); f.write('ok', '가능'); await f.finish(j);
  assert.deepEqual(j.checkpoint.files.map((x) => x.path), ['ok']); assert(j.checkpoint.skipped.some((x) => x.path === 'large.bin' && x.reason === 'large_file')); assert(j.checkpoint.skipped.some((x) => x.path === 'grow'));
  const repo = await f.c.location(f.cwd), tree = await f.c.tree(repo, j.checkpoint.before); assert.deepEqual([...tree.keys()], ['grow']);
});

test('파일 수 초과·Git 실행 실패는 경고로 남고 호출을 막지 않음', async () => {
  const f = fixture({ maxFiles: 2 }); ['a', 'b', 'c'].forEach((p) => f.write(p, '내용')); const j = f.job(); await f.c.begin(j); await f.c.end(j);
  assert.equal(j.checkpoint.status, 'warning'); assert.equal(j.checkpoint.code, 'CHECKPOINT_TOO_MANY_FILES'); assert(j.checkpoint.skipped.some((x) => x.reason === 'too_many_files')); assert.equal(f.c.active.size, 0);
  const other = fixture(); const k = other.job(); other.c.snapshot = async () => { throw new Error('실패'); }; await other.c.begin(k); await other.c.end(k); assert.equal(k.checkpoint.warning, '체크포인트를 저장하지 못했습니다');
});

test('허브 소스 스냅샷에서 예전 workspace·기록 제외, 해당 폴더에서 하는 작업은 보존', async () => {
  const f = fixture(); f.c.hubRoot = f.cwd;
  f.write('source.mjs', '소스');
  for (const dir of ['workspace', 'logs', 'data', 'runs']) f.write(`${dir}/generated.txt`, '이전 결과물');
  const j = f.job(); await f.c.begin(j);
  const repo = await f.c.location(f.cwd);
  assert.deepEqual([...(await f.c.tree(repo, j.checkpoint.before)).keys()], ['source.mjs']);
  await f.finish(j);
  const sub = { id: 'workspace-job', cwd: path.join(f.cwd, 'workspace'), status: 'running', notes: [] };
  await f.c.begin(sub);
  const subRepo = await f.c.location(sub.cwd);
  assert.deepEqual([...(await f.c.tree(subRepo, sub.checkpoint.before)).keys()], ['generated.txt']);
  sub.status = 'done'; await f.c.end(sub);
  const other = fixture(); other.write('workspace/actual-source.mjs', '다른 프로젝트 소스');
  const k = other.job(); await other.c.begin(k);
  assert.deepEqual([...(await other.c.tree(await other.c.location(other.cwd), k.checkpoint.before)).keys()], ['workspace/actual-source.mjs']);
  await other.finish(k);
});

test('Git 사용자 속성으로 텍스트 diff를 감추지 않음·실패한 캡처의 저장소 용량도 조회 가능', async () => {
  const f = fixture(); f.write('.gitattributes', '*.txt -diff\n'); f.write('a.txt', '전\n'); const j = f.job(); await f.c.begin(j); f.write('a.txt', '후\n'); await f.finish(j); assert.equal(j.checkpoint.files.find((x) => x.path === 'a.txt').binary, false); assert.match((await f.c.diff(j, 'a.txt')).unified, /-전/);
  const g = fixture(); g.write('a', '내용'); const k = g.job(), original = g.c.git.bind(g.c); g.c.git = async (repo, args, options) => { if (args[0] === 'hash-object') throw new Error('시험 해시 실패'); return original(repo, args, options); }; await g.c.begin(k); k.status = 'failed'; await g.c.end(k); assert.equal(k.checkpoint.status, 'warning'); assert((await g.c.storage()).bytes > 0); assert.equal((await g.c.cleanup()).removed.length, 1);
});

test('원래 Git 저장소·중첩 저장소의 메타데이터 무손상, ignore·속성·필터 우회', async () => {
  const f = fixture(); const git = (...args) => execFileSync('git', args, { cwd: f.cwd, windowsHide: true }); git('init');
  f.write('.gitignore', 'ignored.txt\n'); f.write('.gitattributes', '*.txt text eol=lf filter=unknown\n'); f.write('tracked.txt', '원본\r\n'); f.write('ignored.txt', '무시된 원본\r\n');
  git('add', 'tracked.txt', '.gitignore', '.gitattributes'); git('-c', 'user.name=시험', '-c', 'user.email=test@localhost', 'commit', '-m', '시험');
  fs.mkdirSync(path.join(f.cwd, 'nested')); execFileSync('git', ['init'], { cwd: path.join(f.cwd, 'nested'), windowsHide: true }); f.write('nested/inside.txt', '중첩\r\n');
  const metadata = (dir) => {
    const result = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const full = path.join(d, e.name); if (e.isDirectory()) walk(full); else result[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'); } }; walk(dir); return result;
  };
  const original = metadata(path.join(f.cwd, '.git')), nested = metadata(path.join(f.cwd, 'nested/.git'));
  const j = f.job(); await f.c.begin(j); f.write('tracked.txt', '변경\r\n'); f.write('ignored.txt', '무시된 변경\r\n'); f.write('nested/inside.txt', '중첩 변경\r\n'); await f.finish(j);
  await f.c.rewind(j); assert.equal(f.read('tracked.txt'), '원본\r\n'); assert.equal(f.read('ignored.txt'), '무시된 원본\r\n'); assert.equal(f.read('nested/inside.txt'), '중첩\r\n');
  assert.deepEqual(metadata(path.join(f.cwd, '.git')), original); assert.deepEqual(metadata(path.join(f.cwd, 'nested/.git')), nested);
});

test('같은 폴더 병렬 스냅샷 직렬화·겹친 ID 양방향 기록·실행 중 복원 금지', async () => {
  const f = fixture(); f.write('a', '전'); const a = f.job('a'), b = f.job('b'); await Promise.all([f.c.begin(a), f.c.begin(b)]);
  assert.deepEqual(a.checkpoint.overlaps, ['b']); assert.deepEqual(b.checkpoint.overlaps, ['a']); f.write('a', '후'); await f.finish(a);
  await assert.rejects(f.c.rewind(a), (e) => e.code === 'CHECKPOINT_BUSY'); await f.finish(b); assert.equal((await f.c.rewind(a)).conflicts.length, 0);
});

test('세션 첫 before→마지막 after 누적 변경·누적 diff', async () => {
  const f = fixture(); f.write('a', '처음\n'); const a = f.job('first'); await f.c.begin(a); f.write('a', '중간\n'); await f.finish(a);
  const b = f.job('last'); await f.c.begin(b); f.write('a', '끝\n'); f.write('b', '추가\n'); await f.finish(b);
  const s = { cwd: f.cwd }, changes = await f.c.sessionChanges(s, [a, b]); assert.equal(changes.firstJobId, 'first'); assert.equal(changes.lastJobId, 'last'); assert.equal(changes.files.length, 2);
  const diff = await f.c.sessionChanges(s, [a, b], 'a'); assert.equal(diff.before, '처음\n'); assert.equal(diff.after, '끝\n');
});

test('diff 1MB 상한·경로 탈출·연결된 폴더·큰 충돌 파일의 강제 덮어쓰기 차단', async () => {
  const f = fixture({ maxFileMB: 1 }); f.write('a', '전'); f.write('sub/file', '전'); const j = f.job(); await f.c.begin(j); f.write('a', 'x'.repeat(700_000)); f.write('sub/file', '후'); await f.finish(j);
  await assert.rejects(f.c.diff(j, 'a'), (e) => e.code === 'DIFF_TOO_LARGE');
  for (const p of ['../a', '.git/config', 'C:/a', 'sub\\file']) await assert.rejects(f.c.diff(j, p), (e) => e.code === 'CHECKPOINT_PATH_INVALID');
  f.write('a', Buffer.alloc(2 * 1024 * 1024)); await assert.rejects(f.c.rewind(j, { paths: ['a'], force: true }), (e) => e.code === 'CHECKPOINT_BACKUP_INCOMPLETE'); assert.equal(fs.statSync(path.join(f.cwd, 'a')).size, 2 * 1024 * 1024);
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'file'), '외부'); fs.rmSync(path.join(f.cwd, 'sub'), { recursive: true }); fs.symlinkSync(external, path.join(f.cwd, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.c.rewind(j, { paths: ['sub/file'], force: true }), (e) => e.code === 'CHECKPOINT_UNSAFE_PATH'); assert.equal(fs.readFileSync(path.join(external, 'file'), 'utf8'), '외부');
});

test('참조 정리·용량 목록·사용 중 저장소 보호·삭제 뒤 진행 중 캡처가 참조를 되살리지 않음', async () => {
  const f = fixture(); f.write('a', '전'); const j = f.job(); await f.c.begin(j); f.write('a', '후'); await f.finish(j); const r = await f.c.rewind(j);
  let storage = await f.c.storage(); assert(storage.bytes > 0); assert.equal(storage.repositories[0].jobs.length, 1); assert.equal(storage.repositories[0].backups[0].id, r.backup);
  await f.c.forget(j); await assert.rejects(f.c.undo(r.backup), (e) => e.code === 'REWIND_NOT_FOUND'); storage = await f.c.storage(); assert.equal(storage.repositories[0].unused, true); assert.equal((await f.c.cleanup()).removed.length, 1);
  const k = f.job('active'); const begin = f.c.begin(k), forgotten = f.c.forget(k); await Promise.all([begin, forgotten]); await f.c.end(k); const s = await f.c.storage(); assert(s.repositories.every((x) => x.jobs.length === 0));
});

test('작업 폴더 삭제 뒤에도 저장된 diff 조회와 세션 참조 정리 가능', async () => {
  const f = fixture(); f.write('a', '전\n'); const j = f.job(); await f.c.begin(j); f.write('a', '후\n'); await f.finish(j);
  fs.rmSync(f.cwd, { recursive: true }); assert.match((await f.c.diff(j, 'a')).unified, /-전/); await f.c.forget(j); assert.equal((await f.c.cleanup()).removed.length, 1);
});

test('작업 관리자 종료 연결: 성공·실패·중지와 목표 라운드, 비활성 설정', async () => {
  const f = fixture(), manager = new JobManager({ hubDir: path.join(f.root, 'shared'), defaultCwd: f.cwd });
  let rounds = 0; manager.afterGoalRound = async (job) => { if (job.status !== 'cancelled') rounds++; };
  try {
    for (const status of ['done', 'failed', 'cancelled']) {
      f.write('a', '전'); const j = { ...f.job(`manager-${status}`), status: 'running', tasks: [], createdAt: new Date().toISOString(), runDir: path.join(f.root, status), goalId: 'goal', intercepts: [] }; manager.jobs.set(j.id, j);
      await manager.checkpoints.begin(j); f.write('a', '후'); j.status = status; await manager.finish(j); assert.equal(j.checkpoint.status, 'ready'); assert.equal(j.checkpoint.files[0].path, 'a');
    }
    assert.equal(rounds, 2);
    const disabled = fixture({ enabled: false }), j = disabled.job(); await disabled.c.begin(j); await disabled.c.end(j); assert.equal(j.checkpoint, undefined);
  } finally { clearTimeout(manager._saveTimer); }
});

test('작업 시작 연결: 두 CLI·실패·중지 후 마지막 쓰기·재시도에서 최초 before 유지', async () => {
  const f = fixture(), capture = path.join(f.root, 'capture.jsonl');
  const cli = (tool) => `"${process.execPath}" "${path.resolve('tests/fixtures/intercept-cli.mjs')}" --tool ${tool} --capture "${capture}"`;
  const config = { hubDir: path.join(f.root, 'shared'), defaultCwd: f.cwd, fastPath: { enabled: false }, tools: { claude: { command: cli('claude'), transport: 'native', shell: true }, codex: { command: cli('codex'), transport: 'native', shell: true } }, defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } } };
  invalidateToolStatus(); const manager = new JobManager(config); manager.memoryFor = () => '';
  const until = async (fn) => { const end = Date.now() + 10_000; while (!fn()) { if (Date.now() > end) throw new Error('작업 종료 대기 시간 초과'); await delay(10); } };
  let release;
  manager.schedule = async (j) => {
    assert(j.checkpoint.before, '첫 파일 변경 전 before 필요');
    f.write(j.mode === 'auto' ? 'codex' : j.mode, j.goal);
    if (j.goal === '중지') await new Promise((r) => { release = () => { f.write(j.mode, '중지 뒤 마지막 쓰기'); r(); }; });
    if (j.goal === '실패') throw new Error('시험 실패');
    j.tasks.forEach((t) => { t.status = 'done'; t.resultText = '완료'; });
  };
  try {
    for (const mode of ['claude', 'codex']) {
      f.write(mode, '원본'); const publicJob = manager.create({ goal: '성공', mode }); const j = manager.get(publicJob.id);
      await until(() => j.checkpoint?.status === 'ready'); assert.equal(j.status, 'done'); assert.equal((await manager.checkpoints.diff(j, mode)).before, '원본', JSON.stringify(j.checkpoint));
      const before = j.checkpoint.before; manager.retryTask(j.id, 't1'); await until(() => j.checkpoint?.status === 'ready' && j.status === 'done'); assert.equal(j.checkpoint.before, before);
    }
    const failed = manager.get(manager.create({ goal: '실패', mode: 'codex' }).id); await until(() => failed.checkpoint?.status === 'ready'); assert.equal(failed.status, 'failed'); assert.equal(f.read('codex'), '실패');
    const stopped = manager.get(manager.create({ goal: '중지', mode: 'claude' }).id); await until(() => release); manager.cancel(stopped.id); assert.equal(stopped.checkpoint.after, null); release(); await until(() => stopped.checkpoint?.status === 'ready'); assert.equal(stopped.status, 'cancelled'); assert.equal((await manager.checkpoints.diff(stopped, 'claude')).after, '중지 뒤 마지막 쓰기');
  } finally { clearTimeout(manager._saveTimer); }
});

test('분리된 7712 시험 서버: 작업·세션 API, 충돌·복원·취소 SSE, 세션 삭제 정리', async (t) => {
  const f = fixture(); f.write('a', '전\n'); const j = { ...f.job('api-job'), tasks: [], createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), intercepts: [] }; await f.c.begin(j); f.write('a', '후\n'); await f.finish(j);
  const session = { id: j.sessionId, cwd: f.cwd, jobIds: [j.id], createdAt: j.createdAt, updatedAt: j.createdAt, title: '시험' };
  fs.mkdirSync(f.dataDir, { recursive: true }); fs.writeFileSync(path.join(f.dataDir, 'jobs.json'), JSON.stringify([j])); fs.writeFileSync(path.join(f.dataDir, 'sessions.json'), JSON.stringify([session]));
  const configFile = path.join(f.root, 'config.json'); fs.writeFileSync(configFile, JSON.stringify({ host: '127.0.0.1', port: 7712, hubDir: path.join(f.root, 'shared'), defaultCwd: f.cwd, tools: {} }));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, HUB_PORT: '7712', HUB_DATA_DIR: f.dataDir, HUB_RUNS_DIR: path.join(f.root, 'runs'), HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  t.after(async () => { child.kill(); if (child.exitCode === null) await new Promise((r) => child.once('exit', r)); });
  const end = Date.now() + 8000; while (!output.includes('ODDIN  http://127.0.0.1:7712')) { if (child.exitCode !== null || Date.now() > end) throw new Error(`시험 서버 시작 실패: ${output}`); await delay(20); }
  const api = async (p, body, method = body === undefined ? 'GET' : 'POST') => { const res = await fetch(`http://127.0.0.1:7712${p}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  assert.equal((await api('/api/jobs/api-job/changes')).body.files[0].path, 'a'); assert.equal((await api(`/api/sessions/${j.sessionId}/changes`)).body.files.length, 1); assert.match((await api('/api/jobs/api-job/changes/diff?path=a')).body.unified, /-전/);
  const abort = new AbortController(), stream = await fetch('http://127.0.0.1:7712/api/events', { signal: abort.signal }); const reader = stream.body.getReader(); await reader.read();
  f.write('a', '사용자'); const blocked = await api('/api/jobs/api-job/rewind', {}); assert.equal(blocked.status, 200); assert.equal(blocked.body.conflicts.length, 1);
  const r = await api('/api/jobs/api-job/rewind', { force: true }); assert.equal(r.status, 200); assert.equal(f.read('a'), '전\n');
  let events = ''; const deadline = Date.now() + 3000; while (!events.includes('"type":"rewind"')) { if (Date.now() > deadline) throw new Error('복원 SSE 대기 시간 초과'); const chunk = await reader.read(); events += Buffer.from(chunk.value).toString(); } abort.abort();
  assert.equal((await api(`/api/rewinds/${r.body.backup}/undo`, {})).body.status, 'undone'); assert.equal(f.read('a'), '사용자');
  assert.equal((await api('/api/jobs/no-job/changes')).status, 404); assert.equal((await api('/api/jobs/api-job/changes/diff?path=../a')).status, 400);
  assert((await api('/api/checkpoints')).body.bytes > 0); assert.equal((await api(`/api/sessions/${j.sessionId}`, undefined, 'DELETE')).body.removed, true);
  const cleanupEnd = Date.now() + 3000; while ((await api('/api/checkpoints')).body.repositories.some((r) => r.jobs.length)) { if (Date.now() > cleanupEnd) throw new Error('참조 정리 대기 시간 초과'); await delay(20); }
  assert.equal((await api('/api/checkpoints/cleanup', {})).body.removed.length, 1);
});
