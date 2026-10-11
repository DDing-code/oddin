// 가볍게 맞추기(2026-10-11 "작업을 안할 때도 자원을 많이 먹는데?"):
// 드라이브를 훑지 않고 표시 파일·알림으로 바뀐 파일만 받기, 이 PC에서 바뀐 것만 올리기, 쉴 때 느리게, node_modules 빼기, 안 쓰는 브라우저 끄기
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DriveHub } from '../lib/drive-hub.mjs';
import { SharedSync, scanShared, sha, MARK_DIR } from '../lib/shared-sync.mjs';
import { BrowserManager } from '../lib/browser.mjs';
import { timed, loadReport } from '../lib/load-log.mjs';

const put = (root, files) => { for (const [rel, text] of Object.entries(files)) { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { return null; } };
const peersOf = (id, name, list = [], call = async () => { throw new Error('부르면 안 됨'); }) => ({ list: () => list, self: () => ({ id, name }), call });
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await delay(15); } return false; };
const A_MD = 'memory/global/a.md';

/** 집(만든 PC)과 회사가 같은 드라이브 폴더로 맞추고 있는 상태. wire = 집이 올리면 회사에 바로 알림 */
async function pair({ wire = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sync-light-'));
  const driveRoot = path.join(dir, 'drive'); fs.mkdirSync(path.join(driveRoot, '내 드라이브'), { recursive: true });
  const base = { 'AGENTS.md': '지침', 'memory/global/MEMORY.md': '# 목록\n- [가](a.md) — 가\n', [A_MD]: '가 1', 'skills/x/SKILL.md': '스킬' };
  const A = path.join(dir, 'home'), B = path.join(dir, 'office'); put(A, base); put(B, base);
  const hub = new DriveHub({ driveRoot }), h = hub.create('home');
  const opts = { intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), catchSteps: [10, 20, 30, 40, 60, 80] };
  let sb;
  const callB = async (_p, route, o = {}) => {
    if (route === '/api/shared/hello') return sb.hello();
    if (route === '/api/shared/changed') return sb.onChanged(o.body);
    throw new Error(`부르면 안 됨: ${route}`);
  };
  const sa = new SharedSync({ ...opts, root: A, peers: wire ? peersOf('home', '집', [{ id: 'p-office', name: '회사' }], callB) : peersOf('home', '집'), stateFile: path.join(dir, 'a.json') });
  sb = new SharedSync({ ...opts, root: B, peers: peersOf('office', '회사'), stateFile: path.join(dir, 'b.json'), joinMs: 0 });
  await sa.syncAll(); await sb.syncAll();
  // 서로의 표시 파일을 한 번씩 본 상태로(켠 직후의 첫 확인)
  await sa.enqueue(() => sa.checkMarkers()); await sb.enqueue(() => sb.checkMarkers()); await sa.enqueue(() => sa.checkMarkers());
  sa.runs.length = 0; sb.runs.length = 0;
  const done = () => { sa.close(); sb.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, A, B, h, sa, sb, done };
}

test('맞추지 않는 폴더(node_modules·__pycache__): 훑지도 올리지도 않고, 예전 기준에 남아 있어도 지우지 않는다', async () => {
  const { dir, A, h, sa, done } = await pair();
  try {
    const nm = 'skills/x/runtime/node_modules/a/index.js', pc = 'skills/x/__pycache__/a.pyc';
    put(A, { [nm]: 'lib', [pc]: 'cache' });
    assert.deepEqual(Object.keys(scanShared(A)).filter((k) => /node_modules|__pycache__/.test(k)), []);
    await sa.syncAll();
    assert.equal(read(h.memory, nm), null, '드라이브에 올리지 않음');
    // 예전 버전이 이미 올려 두고 기준에도 적어 둔 상태에서 새 버전으로 바뀐 경우: 드라이브 쪽 사본을 지우지 않는다
    put(h.memory, { [nm]: 'lib' });
    const file = path.join(dir, 'a.json'), st = JSON.parse(fs.readFileSync(file, 'utf8'));
    st.peers[`drive:${h.id}`].base[nm] = sha(Buffer.from('lib'));
    fs.writeFileSync(file, JSON.stringify(st));
    const again = new SharedSync({ root: A, peers: peersOf('home', '집'), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => new DriveHub({ driveRoot: path.join(dir, 'drive') }).info(), stateFile: file });
    assert.equal(again.state.peers[`drive:${h.id}`].base[nm], undefined, '기준에서 뺌');
    fs.rmSync(path.join(A, 'skills/x/runtime'), { recursive: true, force: true }); // 이 PC에서 지워도
    const [r] = await again.syncAll(); await again.enqueue(() => again.localCheck('시험'));
    assert.equal(r.ok, true); assert.equal(r.counts.deleted, 0);
    assert.equal(read(h.memory, nm), 'lib', '드라이브 사본은 그대로');
    again.close();
  } finally { done(); }
});

test('올리면 표시 파일에 적고, 다른 PC는 표시 파일만 보고 그 파일만 받는다(드라이브를 훑지 않음)', async () => {
  const { A, B, h, sa, sb, done } = await pair();
  try {
    assert.equal(sb.markerPeers, 1, '표시 파일을 쓰는 다른 PC가 있음');
    const seq0 = JSON.parse(read(h.memory, `${MARK_DIR}/home.json`)).seq; // 처음 올릴 때 이미 한 번 적었다
    put(A, { [A_MD]: '가 2', 'memory/global/new.md': '새 기억' });
    await sa.enqueue(() => sa.localCheck('시험'));
    assert.equal(read(h.memory, A_MD), '가 2'); assert.equal(read(h.memory, 'memory/global/new.md'), '새 기억');
    assert.deepEqual(sa.runs.map((r) => r.kind), ['파일 2개'], '이 PC에서 바뀐 두 파일만 봄');
    const mark = JSON.parse(read(h.memory, `${MARK_DIR}/home.json`));
    assert.equal(mark.seq, seq0 + 1); assert.deepEqual(mark.changes.filter((c) => c.seq === mark.seq).map((c) => c.rel).sort(), [A_MD, 'memory/global/new.md']);
    assert.equal(mark.changes.find((c) => c.rel === A_MD).sha, sha(Buffer.from('가 2')));
    // 회사: 표시 파일을 확인하면 받을 목록에 오르고, 곧 그 파일만 받는다
    await sb.enqueue(() => sb.checkMarkers());
    assert.equal(sb.status().drive.waiting, 2);
    assert.ok(await until(() => read(B, 'memory/global/new.md') === '새 기억' && read(B, A_MD) === '가 2'));
    assert.ok(await until(() => sb.status().drive.waiting === 0));
    assert.ok(sb.runs.length && sb.runs.every((r) => /^파일 \d+개$/.test(r.kind)), `훑지 않음: ${JSON.stringify(sb.runs.map((r) => r.kind))}`);
    // 받은 것을 다시 올리지 않는다(주고받기가 되풀이되지 않음)
    sb.runs.length = 0; await sb.enqueue(() => sb.localCheck('시험'));
    assert.deepEqual(sb.runs, []); assert.equal(read(h.memory, `${MARK_DIR}/office.json`) && JSON.parse(read(h.memory, `${MARK_DIR}/office.json`)).seq, 0);
    // 표시 파일이 그대로면 다시 읽어도 아무 일도 없다
    await sb.enqueue(() => sb.checkMarkers()); assert.equal(sb.status().drive.waiting, 0);
    // 지운 것도 같은 길로
    fs.rmSync(path.join(A, 'memory/global/new.md'));
    await sa.enqueue(() => sa.localCheck('시험')); await sb.enqueue(() => sb.checkMarkers());
    assert.ok(await until(() => read(B, 'memory/global/new.md') === null));
  } finally { done(); }
});

test('알림 받은 파일: 알린 내용이 드라이브에 올라오기 전에는 건드리지 않고(옛 내용을 받거나 지우지 않음), 올라오면 받는다', async () => {
  const { B, h, sb, done } = await pair();
  try {
    const tell = (id, seq) => sb.onChanged({ hub: h.id, from: 'home', seq, changes: [{ rel: A_MD, sha: id, seq }] });
    assert.deepEqual(sb.onChanged({ hub: '다른폴더', from: 'home', seq: 1, changes: [{ rel: A_MD, sha: null, seq: 1 }] }), { ok: true, ignored: true });
    // 고쳤다는 알림이 먼저 오고 파일은 아직 안 옴
    assert.equal(tell(sha(Buffer.from('가 2')), 1).waiting, 1);
    put(B, { 'memory/global/mine.md': '회사 것' }); // 그사이 이 PC의 다른 파일은 평소대로 올라간다
    await sb.enqueue(() => sb.localCheck('시험'));
    assert.equal(read(h.memory, 'memory/global/mine.md'), '회사 것');
    await delay(120);
    assert.equal(read(B, A_MD), '가 1'); assert.equal(sb.status().drive.waiting, 1, '아직 기다림');
    put(h.memory, { [A_MD]: '가 2' }); // 드라이브에 올라옴
    assert.ok(await until(() => read(B, A_MD) === '가 2')); assert.ok(await until(() => sb.status().drive.waiting === 0));
    // 지웠다는 알림: 드라이브에서 실제로 사라진 뒤에만 이 PC에서 지운다(지운 판은 backups 에)
    tell(null, 2);
    await delay(80);
    assert.equal(read(B, A_MD), '가 2');
    fs.rmSync(path.join(h.memory, ...A_MD.split('/')));
    assert.ok(await until(() => read(B, A_MD) === null));
    assert.ok(fs.existsSync(path.join(B, 'backups', 'sync')), '지운 판 보관');
    // 끝내 안 오면 기다리기를 그만둔다(안전망 훑기에 맡김)
    tell(sha(Buffer.from('안 옴')), 3);
    assert.ok(await until(() => sb.status().drive.waiting === 0, 4000));
    assert.equal(read(B, A_MD), null);
  } finally { done(); }
});

test('다른 PC가 방금 고쳤다고 알린 파일은 그 내용이 올라온 뒤에 맞춘다(먼저 올려 서로 덮지 않음)', async () => {
  const { B, h, sb, done } = await pair();
  try {
    sb.catchSteps = [60_000]; // 이 시험에서는 저절로 따라잡지 않게
    sb.onChanged({ hub: h.id, from: 'home', seq: 1, changes: [{ rel: A_MD, sha: sha(Buffer.from('집에서 고침\n')), seq: 1 }] });
    put(B, { [A_MD]: '회사에서도 고침\n' });
    await sb.enqueue(() => sb.localCheck('시험'));
    assert.equal(read(h.memory, A_MD), '가 1', '집 것이 올라오기 전에는 올리지 않음');
    put(h.memory, { [A_MD]: '집에서 고침\n' });
    await sb.catchUp();
    const merged = read(B, A_MD);
    assert.match(merged, /집에서 고침/); assert.match(merged, /회사에서도 고침/); assert.equal(read(h.memory, A_MD), merged, '두 쪽 내용을 합쳐 올림');
    assert.equal(sb.status().drive.waiting, 0);
  } finally { done(); }
});

test('PC끼리 바로 알리기: 올린 직후 연결된 PC가 표시 파일을 보기 전에 받기 시작한다(파일은 드라이브로만)', async () => {
  const { A, B, h, sa, sb, done } = await pair({ wire: true });
  try {
    const seq0 = sb.peerState(`drive:${h.id}`).seen.home;
    put(A, { [A_MD]: '가 3' });
    await sa.enqueue(() => sa.localCheck('시험'));
    assert.ok(await until(() => read(B, A_MD) === '가 3'), '표시 파일 확인 없이 받음');
    assert.equal(sb.peerState(`drive:${h.id}`).seen.home, seq0 + 1, '본 번호를 적어 둠');
    sb.runs.length = 0; await sb.enqueue(() => sb.checkMarkers());
    assert.equal(sb.status().drive.waiting, 0, '표시 파일을 다시 봐도 받을 것이 없음');
    // 알림을 못 받았으면(상대가 꺼져 있었음) 표시 파일로 받는다
    sa.notifyOn = false; put(A, { [A_MD]: '가 4' });
    await sa.enqueue(() => sa.localCheck('시험'));
    await delay(60); assert.equal(read(B, A_MD), '가 3');
    await sb.enqueue(() => sb.checkMarkers());
    assert.ok(await until(() => read(B, A_MD) === '가 4'));
  } finally { done(); }
});

test('주기: 쉬는 중이면 느리게, 쓰는 중이면 표시 파일 확인·안전망 훑기(기억/스킬 따로)', async () => {
  const { h, sb, done } = await pair();
  try {
    let on = false, marks = 0;
    const check = sb.checkMarkers.bind(sb); sb.checkMarkers = async () => { marks++; return check(); };
    Object.assign(sb, { active: () => on, idleFactor: 6, driveIntervalMs: 1000, coreScanMs: 2000, skillScanMs: 4000, intervalMs: 1000 });
    const ago = (ms) => Date.now() - ms;
    sb.ran = { markers: ago(3000), core: ago(5000), skills: ago(5000), local: ago(3000), peers: ago(3000) };
    await sb.tick();
    assert.equal(marks, 0); assert.deepEqual(sb.runs, [], '쉬는 중: 6배 주기가 안 됐으면 아무것도 안 함');
    on = true;
    await sb.tick();
    assert.equal(marks, 1);
    assert.deepEqual(sb.runs.map((r) => r.kind), ['기억 훑기', '스킬 훑기']);
    sb.runs.length = 0; await sb.tick();
    assert.equal(marks, 1); assert.deepEqual(sb.runs, [], '방금 했으면 다시 하지 않음');
    assert.equal(sb.status().idle, false); on = false; assert.equal(sb.status().idle, true);
    // 상태 파일은 바뀐 것이 있을 때만 다시 쓴다
    const file = sb.stateFile, before = fs.statSync(file).mtimeMs;
    await delay(30); await sb.enqueue(() => sb.syncDrive({ tops: ['memory'] }, '시험'));
    assert.equal(fs.statSync(file).mtimeMs, before, '바뀐 것 없으면 안 씀');
    assert.ok(h.id);
  } finally { done(); }
});

test('안 쓰는 브라우저: 진행 중인 작업의 탭은 두고, 오래 안 쓴 탭은 닫고, 탭이 없으면 끈다', async () => {
  class Fake extends BrowserManager {
    constructor(o) { super(o); this.on = true; this.sent = []; }
    get running() { return this.on; }
    async send(method, params) { this.sent.push([method, params?.targetId]); return {}; }
    async stop() { this.stopped = true; this.on = false; }
  }
  const live = new Set(['job-live/t1']);
  const b = new Fake({ idleMs: 1000, isLive: (owner) => live.has(owner) });
  const old = Date.now() - 5000;
  for (const [id, owner, usedAt] of [['a', 'job-done/t1', old], ['b', 'job-live/t1', old], ['c', 'user-1', Date.now()]]) b.tabs.set(id, { id, owner, usedAt, at: new Date(usedAt).toISOString(), console: [] });
  b.usedAt = old;
  await b.sweep();
  assert.deepEqual(b.sent, [['Target.closeTarget', 'a']], '끝난 작업의 안 쓰는 탭만 닫음');
  assert.deepEqual([...b.tabs.keys()], ['b', 'c']); assert.ok(!b.stopped);
  live.clear(); b.tabs.get('c').usedAt = old;
  await b.sweep();
  assert.deepEqual([...b.tabs.keys()], []); assert.equal(b.stopped, true, '탭이 없고 안 쓰면 끔');
  const off = new Fake({ idleMs: 0 }); off.tabs.set('a', { id: 'a', owner: 'x', usedAt: old, at: new Date(old).toISOString() }); off.usedAt = old;
  await off.sweep(); assert.ok(!off.stopped, 'idleMs 0 이면 끄지 않음');
});

test('쓴 시간 기록: 이름별로 더하고 CPU 평균을 낸다', async () => {
  await timed('시험-일', async () => { let x = 0; for (let i = 0; i < 2e6; i++) x += i; return x; });
  await timed('시험-일', async () => {});
  const r = loadReport(), t = r.tasks.find((x) => x.name === '시험-일');
  assert.equal(t.runs, 2); assert.ok(t.cpuMs >= 0 && t.wallMs >= 0);
  assert.ok(r.memoryMB.rss > 0); assert.ok('sinceStart' in r.cpuPercent);
});

test('서버: 가벼운 확인·알림 받기·쓰는 중 알림·무엇이 시간을 쓰는지 보기', { timeout: 60000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { ROOT } = await import('../lib/util.mjs');
  const { freePort } = await import('./_port.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sync-light-srv-')), port = await freePort();
  for (const d of ['data', 'runs', 'shared/memory/global', 'work', 'drive/내 드라이브']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  put(path.join(dir, 'shared'), { 'AGENTS.md': '지침', [A_MD]: '가 1' });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  Object.assign(config, { port, defaultCwd: path.join(dir, 'work'), hubDir: path.join(dir, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, sharedSync: { intervalSeconds: 0, driveIntervalSeconds: 0, watch: false }, sharedFolders: { intervalSeconds: 0 }, federation: { enabled: false } });
  const configFile = path.join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  let log = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(dir, 'data'), HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1', HUB_DRIVE_ROOT: path.join(dir, 'drive') } });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  t.after(async () => { child.kill(); await closed; fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  for (let n = 0; !log.includes(`http://127.0.0.1:${port}`); n++) { assert.ok(n < 200 && child.exitCode === null, log || '시험 서버가 시작되지 않았어요'); await delay(50); }
  const base = `http://127.0.0.1:${port}`;
  const get = async (route) => (await fetch(base + route)).json();
  const post = async (route, body) => { const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  // 드라이브 ODDIN 폴더를 만들면 만든 PC는 바로 올리고, 가벼운 확인에 폴더 id 를 싣는다
  const made = await post('/api/drive-hub');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const mem = made.body.memory;
  assert.ok(await until(async () => (await get('/api/shared/hello')).driveHub === made.body.id, 8000), '드라이브로 맞추는 중');
  assert.ok(await until(() => read(mem, A_MD) === '가 1', 8000), '만든 PC가 올림');
  assert.ok(await until(async () => !(await get('/api/shared/status')).running, 8000));
  const hello = await get('/api/shared/hello');
  assert.equal(hello.markers, true); assert.ok(!('files' in hello), '목록은 보내지 않음');
  // 다른 PC가 "올렸다"고 알리면 받을 목록에 올리고, 드라이브에 그 내용이 오면 받는다
  const next = '가 2 (회사)';
  const told = await post('/api/shared/changed', { hub: made.body.id, from: 'office', seq: 1, changes: [{ rel: A_MD, sha: sha(Buffer.from(next)), seq: 1 }] });
  assert.equal(told.status, 200); assert.equal(told.body.waiting, 1);
  put(mem, { [A_MD]: next });
  assert.ok(await until(() => read(path.join(dir, 'shared'), A_MD) === next, 8000), '알린 파일을 받음');
  assert.deepEqual((await post('/api/shared/changed', { hub: '다른-폴더', from: 'office', seq: 2, changes: [] })).body, { ok: true, ignored: true });
  // 쓰는 중 알림과 부하 보기
  const load = await get('/api/hub/load');
  assert.equal(load.active, true); assert.ok(Array.isArray(load.tasks)); assert.ok(load.sync.some((r) => /^파일 \d+개$/.test(r.kind)), JSON.stringify(load.sync));
  assert.equal((await post('/api/hub/touch')).body.ok, true);
  assert.ok((await get('/api/hub/load')).idleSeconds <= 2);
  const st = await get('/api/shared/status');
  assert.equal(st.idle, false); assert.equal(st.drive.waiting, 0); assert.ok(st.recent.length);
});

test('안 쓰는 브라우저(실제 Edge/Chrome): 쓰는 동안은 그대로, 안 쓰면 꺼지고, 다시 쓰면 켜진다', { skip: !(await import('../lib/browser.mjs')).findBrowser() && '이 PC에 Edge/Chrome 이 없어요', timeout: 60000 }, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-idle-browser-'));
  const live = new Set(['job-a/t1']);
  const b = new BrowserManager({ profile, idleMs: 1500, isLive: (o) => live.has(o) });
  t.after(async () => { try { await b.stop(); } catch {} await delay(300); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {} });
  await b.act('job-a/t1', { action: 'open', url: 'about:blank' });
  await delay(3500);
  assert.equal(b.running, true, '진행 중인 작업의 탭은 오래 안 써도 둔다'); assert.equal(b.tabs.size, 1);
  live.clear();
  assert.ok(await until(() => !b.running, 8000), '작업이 끝나고 안 쓰면 꺼짐');
  assert.equal(b.tabs.size, 0);
  assert.equal((await b.act('job-b/t1', { action: 'eval', expression: '40 + 2' })).value, 42, '다시 쓰면 저절로 켜짐');
  assert.equal(b.running, true);
});

test('잦은 작업 소식(도구 호출 수)은 0.3초 모아 한 번만 알리고, 그사이 바로 알리면 모아 둔 것은 버린다', async () => {
  const { JobManager } = await import('../lib/jobs.mjs');
  const job = { id: 'j1' };
  let sent = 0;
  const m = { jobs: new Map([[job.id, job]]), emitJobSoon: JobManager.prototype.emitJobSoon, emitJob(j) { const soon = this._soon?.get(j.id); if (soon) { clearTimeout(soon); this._soon.delete(j.id); } sent++; } };
  for (let i = 0; i < 8; i++) m.emitJobSoon(job, 60);
  assert.equal(sent, 0, '바로 보내지 않음');
  await delay(140);
  assert.equal(sent, 1, '여덟 번을 한 번으로');
  m.emitJobSoon(job, 60); m.emitJob(job); // 상태가 바뀌어 바로 알림
  await delay(140);
  assert.equal(sent, 2, '모아 둔 것을 또 보내지 않음');
  m.emitJobSoon(job, 60); m.jobs.delete(job.id); // 그사이 지워진 작업
  await delay(140);
  assert.equal(sent, 2);
});

test('기록 저장: 우리가 쓴 파일은 다시 읽어 검사하지 않지만, 밖에서 망가진 파일은 덮지 않는다', async () => {
  const { writeJsonAtomic } = await import('../lib/util.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-save-')), file = path.join(dir, 'state.json');
  try {
    writeJsonAtomic(file, { n: 1 }); writeJsonAtomic(file, { n: 2 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2);
    await delay(20); fs.writeFileSync(file, '{ 망가짐'); // 다른 프로그램이 망가뜨림
    assert.throws(() => writeJsonAtomic(file, { n: 3 }), (e) => e.code === 'STATE_READ_FAILED');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ 망가짐', '망가진 원본을 그대로 둠');
    writeJsonAtomic(file, { n: 4 }, { repair: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 4);
    assert.ok(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')), '망가진 판을 따로 남김');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
