import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readJson, writeJsonAtomic } from '../lib/util.mjs';
import { SharedSync, MAX_FILE, sha, readFolderShared } from '../lib/shared-sync.mjs';
import { SharedFolders } from '../lib/shared-folders.mjs';
import { editableFrom, applyMemoryOps } from '../lib/memory-curate.mjs';
import { guardDriveWrite } from '../lib/drive-folders.mjs';
import { ExecutionQueue, workspaceKey } from '../lib/execution-queue.mjs';
import { JobManager } from '../lib/jobs.mjs';
import { canRestartResume } from '../lib/workers.mjs';
import { promptBridge } from '../lib/prompts.mjs';
import { clientEvent, writeSse } from '../lib/events.mjs';
import { readLogPage } from '../lib/logs.mjs';
import { toolStatus, invalidateToolStatus } from '../lib/tools.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-harness-safety-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const peers = { list: () => [], self: () => ({ id: 'owner', name: '등록 PC' }) };

test('공유 기억: 초과 파일·읽기 실패·양방향 대량 누락은 삭제로 전파하지 않음', async () => {
  const local = path.join(root, 'sync-local'), remote = path.join(root, 'sync-remote');
  const rel = 'memory/global/large.md';
  for (const dir of [local, remote]) {
    put(path.join(dir, rel), '원본');
    for (let i = 0; i < 20; i++) put(path.join(dir, `memory/global/f${i}.md`), `기억 ${i}`);
  }
  const sync = new SharedSync({ root: local, peers, intervalMs: 0, driveIntervalMs: 0, watch: false, stateFile: path.join(root, 'sync.json') });
  const peer = { id: 'remote', folder: remote, creator: true };
  try {
    await sync.syncPeer(peer);
    put(path.join(local, rel), Buffer.alloc(MAX_FILE + 1));
    assert.equal((await sync.syncPeer(peer)).counts.deleted, 0);
    assert.equal(fs.readFileSync(path.join(remote, rel), 'utf8'), '원본');
    await assert.rejects(readFolderShared(local, rel), (e) => e.status === 413);
    const read = fs.readdirSync;
    fs.readdirSync = function (dir, ...args) {
      if (path.resolve(dir) === path.join(local, 'memory')) throw Object.assign(new Error('시험 읽기 실패'), { code: 'EACCES' });
      return read.call(fs, dir, ...args);
    };
    try { assert.equal((await sync.syncPeer(peer)).ok, false); } finally { fs.readdirSync = read; }
    assert.equal(fs.readdirSync(path.join(remote, 'memory/global')).length, 21);
    for (const dir of [local, remote]) {
      for (let i = 0; i < 20; i++) fs.unlinkSync(path.join(dir, `memory/global/f${i}.md`));
      assert.equal((await sync.syncPeer(peer)).ok, false, '한쪽 전체 누락 시 중단');
      for (let i = 0; i < 20; i++) put(path.join(dir, `memory/global/f${i}.md`), `기억 ${i}`);
    }
    assert.equal(fs.readdirSync(path.join(local, 'memory/global')).length, 21);
  } finally { sync.close(); }
});

test('공유 폴더: 부분 목록과 비정상 제공 목록은 기존 사본을 보존', async () => {
  let offer = { machine: '상대', folders: [{ id: 'f', name: '소스' }] };
  const shared = new SharedFolders({ hubDir: path.join(root, 'folder-hub'), intervalMs: 0, file: path.join(root, 'folders.json'),
    peers: { ...peers, call: async (_p, route) => route.endsWith('/offer') ? offer : { files: {}, truncated: true } } });
  const copy = path.join(shared.mirrorRoot, '상대', '소스', 'keep.txt');
  put(copy, '보존');
  const peer = { id: 'p', name: '상대' };
  await shared.pullPeer(peer); assert.equal(fs.readFileSync(copy, 'utf8'), '보존');
  offer = { machine: '상대' };
  assert.equal((await shared.pullPeer(peer)).ok, false); assert.ok(fs.existsSync(copy));
  shared.data.folders = [{ id: 'missing', name: '연결 끊긴 원본', path: path.join(root, 'missing') }];
  assert.equal(shared.offer().folders.length, 1, '원본 경로가 안 보여도 공유 중단으로 처리하지 않음');
  shared.close();
});

test('기억 정리: 읽은 이후 바뀐 파일에 update·delete·create 모두 적용하지 않음', () => {
  const hubDir = path.join(root, 'memory-hub'), file = path.join(hubDir, 'memory/global/fact.md');
  put(file, '처음 내용');
  const editable = editableFrom(hubDir, null, { selected: [{ file, hash: sha('처음 내용') }] });
  put(file, '사용자가 고친 새 내용');
  for (const op of ['update', 'delete', 'create']) {
    const result = applyMemoryOps({ hubDir, editable, ops: [{ op, scope: 'global', name: 'fact', description: '설명', body: '옛 결론' }] });
    assert.notEqual(result[0].status, 'applied');
    assert.equal(fs.readFileSync(file, 'utf8'), '사용자가 고친 새 내용');
  }
});

test('손상된 JSON 자동 덮어쓰기 차단, 정상본 백업, 명시적 복구 때 손상본 보존', () => {
  const file = path.join(root, 'state.json');
  assert.deepEqual(readJson(file, []), []);
  writeJsonAtomic(file, { old: true }); writeJsonAtomic(file, { next: true });
  assert.deepEqual(readJson(file + '.bak'), { old: true });
  put(file, '{손상');
  assert.throws(() => readJson(file, []), { code: 'STATE_READ_FAILED' });
  assert.throws(() => writeJsonAtomic(file, []), { code: 'STATE_READ_FAILED' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{손상');
  writeJsonAtomic(file, { repaired: true }, { repair: true });
  const backup = fs.readdirSync(root).find((n) => n.startsWith('state.json.corrupt-'));
  assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), '{손상');
});

test('이어가기: 대화를 열기 전 실패만 새로 시작, 실행 후 오류·중지·시간 초과는 반복하지 않음', () => {
  const failure = { ok: false, error: 'thread/resume: thread not found' };
  assert.equal(canRestartResume(failure, {}), true);
  for (const result of [{ ...failure, sessionId: 's' }, { ...failure, cancelled: true }, { ...failure, timedOut: true }, { ok: false, error: 'network disconnected' }]) assert.equal(canRestartResume(result, {}), false);
  assert.equal(canRestartResume(failure, { toolCalls: 1 }), false);
});

test('공유 쓰기: 등록 PC만 허용, 경로 미확인·연결 실패·구버전·다른 작업은 차단', async () => {
  const folder = { id: 'f', confirmed: true, ownerId: 'owner', ownerName: '등록 PC' };
  const peer = { id: 'p', name: '상대' };
  const remote = (call) => ({ ...peers, list: () => [peer], call });
  await guardDriveWrite(folder, remote(async () => ({ _writerPolicy: 'registered-owner-v1' })));
  await assert.rejects(guardDriveWrite({ ...folder, confirmed: false }, peers), (e) => e.status === 409);
  await assert.rejects(guardDriveWrite({ ...folder, ownerId: 'other' }, peers), (e) => e.status === 409);
  await assert.rejects(guardDriveWrite(folder, remote(async () => { throw new Error('offline'); })), (e) => e.status === 503);
  for (const busy of [{}, { _writerPolicy: 'registered-owner-v1', f: { running: true } }]) await assert.rejects(guardDriveWrite(folder, remote(async () => busy)), (e) => e.status === 409);
});

test('공용 실행 대기열: 작업·계획 전체 한도, 메모리 우선순위·취소·폴더 중첩', async () => {
  const q = new ExecutionQueue(1), first = await q.acquire({ owner: 'first' }), order = [];
  const memory = q.acquire({ owner: 'memory', priority: 1 }).then((release) => { order.push('memory'); release(); });
  const work = q.acquire({ owner: 'work' }).then((release) => { order.push('work'); release(); });
  const cancelled = q.acquire({ owner: 'cancel' }); q.cancel('cancel'); assert.equal(await cancelled, null);
  first(); await Promise.all([work, memory]); assert.deepEqual(order, ['work', 'memory']);
  const locks = new ExecutionQueue(), release = await locks.acquire({ owner: 'parent', folder: workspaceKey(root) });
  let entered = false;
  const child = locks.acquire({ owner: 'child', folder: workspaceKey(path.join(root, 'nested')) }).then((r) => { entered = true; r(); });
  await Promise.resolve(); assert.equal(entered, false); release(); await child;
  const m = Object.assign(Object.create(JobManager.prototype), { execution: new ExecutionQueue(1), running: new Map(), log() {} });
  let finish, launches = 0;
  const launch = () => { launches++; const promise = new Promise((r) => { finish = r; }); return { promise, settle: () => promise, getState: () => ({ tool: 'codex' }), close() {} }; };
  const job = (id) => ({ id, instructionRevision: 0, intercepts: [], runDir: path.join(root, id) });
  const a = m.trackWorker(job('a'), launch, 'plan'); await Promise.resolve();
  const b = m.trackWorker(job('b'), launch, 'worker'); await Promise.resolve();
  assert.equal(launches, 1); finish({ ok: true, text: '결과' }); await a;
  await Promise.resolve(); assert.equal(launches, 2); finish({ ok: true, text: '결과' }); await b;
});

test('질문 권한: 조회 허용, 쓰기·셸·외부 변경·계획 승인으로 권한 확대 금지', async () => {
  const bridge = promptBridge({ tool: 'claude' }, () => { throw new Error('승인 요청 없어야 함'); }, () => 'readonly');
  for (const name of ['Read', 'Grep', 'WebFetch', 'WebSearch']) assert.equal((await bridge.claude({ tool_name: name, input: {} })).behavior, 'allow');
  for (const name of ['Write', 'Edit', 'Bash', 'mcp__write', 'ExitPlanMode']) assert.equal((await bridge.claude({ tool_name: name, input: {} })).behavior, 'deny');
});

test('화면 전송: 선택한 대화만 상세·로그 전송, 느린 연결은 버퍼 상한에서 종료', () => {
  const jobs = ['selected', 'other'].map((sessionId) => ({ id: sessionId, sessionId, report: '긴 기록'.repeat(10000), tasks: [{ id: 't1', resultText: '상세 결과' }] }));
  const small = clientEvent({ type: 'hello', jobs }, 'selected');
  assert.equal(small.jobs[0].report, jobs[0].report); assert.equal(small.jobs[1].report, undefined);
  assert.equal(small.jobs[1].tasks[0].resultText, undefined);
  assert.equal(clientEvent({ type: 'log', jobId: 'other' }, 'selected', (id) => id), null);
  assert.ok(JSON.stringify(small).length < JSON.stringify({ jobs }).length * 0.6);
  const res = Object.assign(new EventEmitter(), { writableLength: 0, write: () => false, destroy() { this.destroyed = true; this.emit('close'); } });
  writeSse(res, 'data: x\n\n'); assert.ok(res.hubDrainTimer); res.emit('drain'); assert.equal(res.hubDrainTimer, null);
  res.writableLength = 16 * 1024 * 1024; writeSse(res, 'x'); assert.equal(res.destroyed, true);
});

test('로그: 한글 바이트 경계를 지키며 최근 200개와 이전 기록을 중복 없이 조회', () => {
  const file = path.join(root, 'log.jsonl'), entries = Array.from({ length: 1307 }, (_, i) => ({ i, text: '한글💡'.repeat(33) }));
  put(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  let before, all = [];
  do { const p = readLogPage(file, { before, limit: 200 }); assert.ok(p.entries.length <= 200); all = [...p.entries, ...all]; before = p.nextBefore; } while (before);
  assert.deepEqual(all, entries);
  assert.deepEqual(readLogPage(file, { before: -1 }), { entries: [], nextBefore: null });
});

test('CLI 설치·로그인 조회: 동시 요청과 후속 요청은 같은 조회 결과를 재사용', async () => {
  const script = path.join(root, 'status-cli.mjs'), count = path.join(root, 'count.jsonl');
  put(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(count)}, '1\\n'); console.log(process.argv.includes('--version') ? 'fixture 1' : process.argv.includes('auth') ? '{"loggedIn":true}' : 'Logged in');`);
  const command = `"${process.execPath}" "${script}"`, config = { tools: { claude: { command }, codex: { command } } };
  invalidateToolStatus();
  const results = await Promise.all(Array.from({ length: 5 }, () => toolStatus(config)));
  assert.ok(results.every((x) => x === results[0])); await toolStatus(config);
  assert.equal(fs.readFileSync(count, 'utf8').trim().split('\n').length, 4);
  invalidateToolStatus();
});
