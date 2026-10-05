// 드라이브 ODDIN 폴더: 공유 기억을 드라이브로 맞추기(집이 만들고 회사가 합류), PC끼리 맞추기 쉬기, 공유 폴더를 드라이브 자산으로 올리기
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriveHub } from '../lib/drive-hub.mjs';
import { SharedSync } from '../lib/shared-sync.mjs';
import { SharedFolders } from '../lib/shared-folders.mjs';

const put = (root, files) => { for (const [rel, text] of Object.entries(files)) { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { return null; } };
const peersOf = (id, name, list = [], call = async () => { throw new Error('부르면 안 됨'); }) => ({ list: () => list, self: () => ({ id, name }), call });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-drive-hub-'));
  const driveRoot = path.join(dir, 'drive'); fs.mkdirSync(path.join(driveRoot, '내 드라이브'), { recursive: true });
  const base = { 'AGENTS.md': '지침', 'memory/global/MEMORY.md': '# 목록\n- [가](a.md) — 가\n', 'memory/global/a.md': '가 1', 'sync/state.json': '{}' };
  const A = path.join(dir, 'home'), B = path.join(dir, 'office'); put(A, base); put(B, base);
  return { dir, driveRoot, A, B, hub: new DriveHub({ driveRoot }) };
}

test('드라이브 ODDIN 폴더 만들기·자산 목록', () => {
  const { dir, hub } = setup();
  try {
    assert.equal(hub.info(), null);
    const h = hub.create('home');
    assert.equal(h.created, true); assert.equal(h.createdBy, 'home');
    assert.ok(fs.existsSync(path.join(h.root, 'README.md'))); assert.ok(fs.existsSync(h.memory)); assert.ok(fs.existsSync(h.assets));
    assert.ok(!fs.existsSync(path.join(h.assets, '공용')), 'PC·공용 칸 없이 분류만');
    assert.equal(hub.create('office').created, false, '이미 있으면 그대로');
    put(path.join(h.assets, '이미지'), { 'a.png': '1', 'b.png': '2', 'desktop.ini': 'x' });
    const as = hub.assets();
    assert.deepEqual(as.categories.map((c) => [c.name, c.items]), [['이미지', 2]]); assert.equal(as.total, 0);
    // 예전 판이 만든 빈 자산/공용 과 설명서는 정리한다
    fs.mkdirSync(path.join(h.assets, '공용')); fs.writeFileSync(path.join(h.root, 'README.md'), '# ODDIN 공유 폴더\n예전');
    const again = new DriveHub({ driveRoot: hub.driveRoot }); again.info();
    assert.ok(!fs.existsSync(path.join(h.assets, '공용'))); assert.match(fs.readFileSync(path.join(h.root, 'README.md'), 'utf8'), /PC 구분 없이/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('공유 기억을 드라이브로: 만든 PC가 올리고, 다른 PC는 기다렸다 합류, 고친 것·목록 합치기·충돌 사본 무시', async () => {
  const { dir, A, B, hub } = setup();
  try {
    const h = hub.create('home');
    const sa = new SharedSync({ root: A, peers: peersOf('home', '집'), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), stateFile: path.join(dir, 'a.json') });
    const sb = new SharedSync({ root: B, peers: peersOf('office', '회사'), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), stateFile: path.join(dir, 'b.json'), joinMs: 60_000 });
    const [ra] = await sa.syncAll();
    assert.equal(ra.ok, true); assert.equal(ra.counts.pushed, 3, 'PC마다 따로인 sync/state.json 은 올리지 않음');
    assert.equal(read(h.memory, 'memory/global/a.md'), '가 1'); assert.equal(read(h.memory, 'sync/state.json'), null);
    assert.equal(sa.driveHubId(), h.id, '만든 PC는 바로 드라이브로 맞춤');

    // 회사: 회사에만 있는 파일은 합류 기간 동안 올리지 않는다
    put(B, { 'memory/global/b.md': '나' });
    const [rb] = await sb.syncAll();
    assert.equal(rb.joining, true); assert.equal(read(h.memory, 'memory/global/b.md'), null); assert.equal(sb.driveHubId(), null);
    sb.state.peers[`drive:${h.id}`].joinUntil = Date.now() - 1;
    const [rb2] = await sb.syncAll();
    assert.equal(rb2.ok, true); assert.equal(read(h.memory, 'memory/global/b.md'), '나'); assert.equal(sb.driveHubId(), h.id);
    await sa.syncAll(); assert.equal(read(A, 'memory/global/b.md'), '나');

    // 집에서 고침 → 드라이브 → 회사
    put(A, { 'memory/global/a.md': '가 2' }); await sa.syncAll(); await sb.syncAll();
    assert.equal(read(B, 'memory/global/a.md'), '가 2');

    // 두 PC가 목록을 함께 고침 → 줄 합치기
    put(A, { 'memory/global/c.md': '다', 'memory/global/MEMORY.md': '# 목록\n- [가](a.md) — 가\n- [다](c.md) — 다\n' });
    put(B, { 'memory/global/d.md': '라', 'memory/global/MEMORY.md': '# 목록\n- [가](a.md) — 가\n- [라](d.md) — 라\n' });
    await sa.syncAll(); await sb.syncAll(); await sa.syncAll();
    for (const root of [A, B, h.memory]) { const t = read(root, 'memory/global/MEMORY.md'); assert.match(t, /\(c\.md\)/); assert.match(t, /\(d\.md\)/); }

    // 드라이브 충돌 사본 "이름 (1).md"·desktop.ini 는 받지 않는다
    put(h.memory, { 'memory/global/a (1).md': '사본', 'memory/desktop.ini': 'x' });
    await sa.syncAll();
    assert.equal(read(A, 'memory/global/a (1).md'), null); assert.equal(read(A, 'memory/desktop.ini'), null);
    assert.ok(!fs.existsSync(path.join(h.memory, 'backups')), '밀린 판 보관은 드라이브가 아니라 이 PC');
    const st = sa.status().drive;
    assert.equal(st.joined, true); assert.equal(st.ok, true); assert.equal(st.folder, h.memory);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('두 PC가 같은 드라이브 폴더를 쓰면 PC끼리 맞추기는 쉰다', async () => {
  const { dir, A, hub } = setup();
  try {
    const h = hub.create('home');
    const calls = [];
    const peer = { id: 'p1', name: '회사' };
    let remoteHub = h.id;
    const call = async (_p, route, opts = {}) => {
      calls.push(`${opts.method || 'GET'} ${route}`);
      if (route === '/api/shared/manifest') return { machine: '회사', driveHub: remoteHub, files: {} };
      if (opts.method === 'POST') return { rel: opts.body.rel, sha: 'x' };
      throw new Error('여기까지 오면 안 됨');
    };
    const sa = new SharedSync({ root: A, peers: peersOf('home', '집', [peer], call), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), stateFile: path.join(dir, 'a.json') });
    await sa.syncAll(); // 첫 차례: 이 PC 드라이브 맞추기 전이라 PC 쪽은 직접 맞춤, 그 뒤 드라이브 맞춤
    calls.length = 0;
    const res = await sa.syncAll();
    assert.deepEqual(res.find((r) => r.peer === 'p1'), { peer: 'p1', ok: true, via: 'drive' });
    assert.deepEqual(calls, ['GET /api/shared/manifest'], '목록만 묻고 파일은 주고받지 않음');
    assert.equal(read(A, 'memory/global/a.md'), '가 1');
    assert.equal(sa.status().peers[0].via, 'drive');
    remoteHub = null; // 상대 드라이브가 멈추면 다시 직접 맞춘다
    calls.length = 0; await sa.syncAll();
    assert.ok(calls.some((c) => c.startsWith('POST /api/shared/file')), '직접 맞추기로 돌아감');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('공유 폴더를 드라이브 자산/소스/<폴더>로 올리고 목록에 적고, 같은 드라이브를 쓰는 PC는 드라이브 사본을 쓴다', async () => {
  const { dir, hub } = setup();
  try {
    const h = hub.create('home');
    const src = path.join(dir, 'plugin'); put(src, { 'main.js': '1', 'lib/x.js': '2', 'shot.png': 'png', 'node_modules/y/index.js': 'z' });
    const homeHub = path.join(dir, 'home-shared');
    const sf = new SharedFolders({ hubDir: homeHub, peers: peersOf('home', '집'), intervalMs: 0, hub: () => hub.info(), file: path.join(dir, 'sf-home.json') });
    const f = sf.add({ path: src, name: '프리미어 플러그인' });
    assert.equal(sf.offer().driveHub, h.id);
    await sf.pullAll();
    const out = path.join(h.assets, '소스', '프리미어 플러그인');
    assert.ok(fs.readFileSync(path.join(h.assets, '목록.md'), 'utf8').includes('- [프리미어 플러그인](<소스/프리미어 플러그인>) — 집 PC가 공유하는 폴더'));
    assert.ok(fs.readFileSync(path.join(homeHub, 'memory', 'global', 'reference-oddin-assets.md'), 'utf8').includes('소스/프리미어 플러그인'));
    assert.equal(sf.offer().folders[0].driveRel, '소스/프리미어 플러그인');
    assert.equal(read(out, 'main.js'), '1'); assert.equal(read(out, 'lib/x.js'), '2');
    assert.equal(read(out, 'shot.png'), null, '기본은 코드·문서만'); assert.ok(!fs.existsSync(path.join(out, 'node_modules')));
    fs.rmSync(path.join(src, 'lib', 'x.js')); put(src, { 'main.js': '3' }); sf.publish();
    assert.equal(read(out, 'main.js'), '3'); assert.equal(read(out, 'lib/x.js'), null, '원본에서 지운 파일은 사본에서도');
    assert.equal(sf.own()[0].published.ok, true);

    // 회사 쪽: 집 공유 폴더를 peer-files 로 받지 않고 드라이브 위치를 목록에 적는다
    const officeHub = path.join(dir, 'office-shared');
    const offer = { machine: '집', driveHub: h.id, folders: [{ id: f.id, name: '프리미어 플러그인', files: 1, driveRel: '소스/프리미어 플러그인' }] };
    const officeCall = async (_p, route) => { if (route === '/api/shared-folders/offer') return offer; throw new Error('파일을 받으면 안 됨'); };
    const so = new SharedFolders({ hubDir: officeHub, peers: peersOf('office', '회사', [{ id: 'home', name: '집' }], officeCall), intervalMs: 0, hub: () => hub.info(), file: path.join(dir, 'sf-office.json') });
    await so.pullAll();
    const m = so.mirrors()[0];
    assert.equal(m.drive, true); assert.equal(m.dir, out); assert.equal(m.ok, true);
    assert.ok(!fs.existsSync(path.join(officeHub, 'peer-files', '집')));
    assert.match(read(path.join(officeHub, 'peer-files'), 'INDEX.md'), /프리미어 플러그인/);

    // 공유를 그만두면 드라이브 사본도 지운다
    sf.remove(f.id); sf.publish();
    assert.ok(!fs.existsSync(out)); assert.doesNotMatch(fs.readFileSync(path.join(h.assets, '목록.md'), 'utf8'), /프리미어 플러그인/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('드라이브 폴더가 안 보이거나 파일이 한꺼번에 사라져 보이면 이 PC 기억을 지우지 않는다', async () => {
  const { dir, A, hub } = setup();
  try {
    const h = hub.create('home');
    const many = {}; for (let i = 0; i < 20; i++) many[`memory/global/m${i}.md`] = `기억 ${i}`;
    put(A, many);
    const sa = new SharedSync({ root: A, peers: peersOf('home', '집'), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), stateFile: path.join(dir, 'a.json') });
    await sa.syncAll();
    assert.equal(read(h.memory, 'memory/global/m5.md'), '기억 5');
    // 폴더가 안 보임(이름 바뀜·드라이브 준비 전)
    fs.renameSync(h.memory, `${h.memory}-잠깐`);
    const [r1] = await sa.syncAll();
    assert.equal(r1.ok, false); assert.match(r1.error, /안 보여요/); assert.equal(read(A, 'memory/global/m5.md'), '기억 5');
    fs.renameSync(`${h.memory}-잠깐`, h.memory);
    // 파일 대부분이 사라져 보임
    for (let i = 0; i < 15; i++) fs.rmSync(path.join(h.memory, 'memory', 'global', `m${i}.md`));
    const [r2] = await sa.syncAll();
    assert.equal(r2.ok, false); assert.match(r2.error, /한꺼번에 사라져/); assert.equal(read(A, 'memory/global/m3.md'), '기억 3');
    // 몇 개만 지운 것은 정상으로 맞춘다
    for (let i = 0; i < 15; i++) put(h.memory, { [`memory/global/m${i}.md`]: `기억 ${i}` });
    await sa.syncAll();
    fs.rmSync(path.join(h.memory, 'memory', 'global', 'm1.md'));
    const [r3] = await sa.syncAll();
    assert.equal(r3.ok, true); assert.equal(read(A, 'memory/global/m1.md'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('두 PC가 같은 지침·메모리 파일을 고쳐도 덮어쓰지 않고 줄 단위로 합친다', async () => {
  const { dir, A, B, hub } = setup();
  try {
    const h = hub.create('home');
    const agents = ['# 공용 지침', '- 규칙 1', '- 규칙 2', '- 규칙 3'].join('\n') + '\n';
    put(A, { 'AGENTS.md': agents, 'memory/global/note.md': '가\n나\n다\n' }); put(B, { 'AGENTS.md': agents, 'memory/global/note.md': '가\n나\n다\n' });
    const sa = new SharedSync({ root: A, peers: peersOf('home', '집'), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), stateFile: path.join(dir, 'a.json') });
    const sb = new SharedSync({ root: B, peers: peersOf('office', '회사'), intervalMs: 0, watch: false, driveIntervalMs: 0, hub: () => hub.info(), stateFile: path.join(dir, 'b.json'), joinMs: 0 });
    await sa.syncAll(); await sb.syncAll();
    // 다른 곳을 고침 → 둘 다 반영
    put(A, { 'AGENTS.md': agents.replace('- 규칙 1', '- 규칙 1 (집에서 고침)') });
    put(B, { 'AGENTS.md': agents + '- 규칙 4 (회사에서 더함)\n' });
    await sa.syncAll(); const [rb] = await sb.syncAll(); await sa.syncAll();
    assert.equal(rb.counts.merged, 1);
    for (const root of [A, B, h.memory]) assert.equal(read(root, 'AGENTS.md'), '# 공용 지침\n- 규칙 1 (집에서 고침)\n- 규칙 2\n- 규칙 3\n- 규칙 4 (회사에서 더함)\n');
    // 같은 곳을 다르게 고침 → 최근 판 + 다른 판을 표시해 둘 다 남김
    put(A, { 'memory/global/note.md': '가\n나 (집)\n다\n' });
    await sa.syncAll();
    put(B, { 'memory/global/note.md': '가\n나 (회사)\n다\n' });
    await sb.syncAll(); await sa.syncAll();
    const note = read(A, 'memory/global/note.md');
    assert.equal(read(B, 'memory/global/note.md'), note);
    assert.ok(note.includes('나 (집)') && note.includes('나 (회사)') && note.includes('ODDIN 합치기'), note);
    assert.ok(fs.existsSync(path.join(B, 'backups', 'sync')), '합치기 전 판은 백업');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
