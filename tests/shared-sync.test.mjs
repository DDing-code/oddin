// 연결된 PC · 공유 기억 동기화: 허브 두 개(7716 "집", 7717 "회사")를 따로 띄워 ~/.ai-shared 를 주고받는다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../lib/util.mjs';
import { unionLines, safeRel, skipped } from '../lib/shared-sync.mjs';
import { peerUrl } from '../lib/peers.mjs';
import { setupStatus, installSharedHooks } from '../lib/shared-setup.mjs';

test('목록 파일 합치기: 최근 판 기준, 같은 파일을 가리키는 줄은 하나, 없어진 파일 줄은 뺀다', () => {
  const newer = '# 목록\n- [가](a.md) — 새 설명\n- [나](b.md) — 나\n';
  const older = '# 목록\n- [가](a.md) — 옛 설명\n- [다](c.md) — 다\n- [지움](gone.md) — x\n';
  const out = unionLines(newer, older, (name) => name !== 'gone.md');
  assert.equal(out, '# 목록\n- [가](a.md) — 새 설명\n- [나](b.md) — 나\n- [다](c.md) — 다\n');
  assert.equal(unionLines('a\n', 'a\n'), 'a\n');
});

test('동기화 경로 검사: 범위 밖·상위 폴더·PC별 파일은 거절', () => {
  assert.equal(safeRel('memory\\global\\a.md'), 'memory/global/a.md');
  for (const bad of ['../x', 'memory/../../x', 'C:/x', '/memory/a.md', 'backups/a', 'hub/BOARD.md', 'sync/state.json', 'memory/projects/INDEX.md', 'sync/memory-check-state/a.json']) assert.throws(() => safeRel(bad), bad);
  assert.equal(skipped('sync/sync.log'), true); assert.equal(skipped('sync/sync.mjs'), false);
  assert.equal(peerUrl('https://desktop-a1.tail123.ts.net/'), 'https://desktop-a1.tail123.ts.net');
  assert.equal(peerUrl('http://127.0.0.1:7717/x'), 'http://127.0.0.1:7717');
  for (const bad of ['http://example.com', 'https://example.com', 'ftp://a.ts.net', 'http://127.0.0.1']) assert.throws(() => peerUrl(bad), bad);
});

test('새 PC 훅 설치: 빠진 Claude·Codex 훅과 CLAUDE.md 줄만 더하고 다시 해도 그대로', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-setup-')), home = path.join(dir, 'home'), hub = path.join(dir, 'shared');
  try {
    assert.equal(setupStatus(hub, home).ready, false);
    assert.throws(() => installSharedHooks(hub, { home, runSync: false }), /공유 기억이 아직/);
    fs.mkdirSync(path.join(hub, 'sync'), { recursive: true });
    for (const f of ['sync.mjs', 'memory-check.mjs']) fs.writeFileSync(path.join(hub, 'sync', f), '');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo 기존' }] }] } }));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# 내 지침\n');
    const r = installSharedHooks(hub, { home, runSync: false });
    assert.equal(r.status.done, true, JSON.stringify(r));
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.equal(s.model, 'opus'); assert.equal(s.hooks.Stop.length, 2, '기존 훅 유지'); assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /memory-check\.mjs"$/);
    const c = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    assert.match(c.hooks.UserPromptSubmit[0].hooks[0].command, /--codex$/); assert.equal(c.hooks.SessionStart[0].matcher, 'startup|resume');
    assert.match(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), /^# 내 지침\n\n# 공용 지침[^\n]*\n@~\/\.ai-shared\/AGENTS\.md\n@~\/\.ai-shared\/memory\/global\/MEMORY\.md\n$/);
    assert.ok(fs.readdirSync(path.join(home, '.claude')).some((n) => n.startsWith('settings.json.bak-oddin-')), '원본 보관');
    assert.deepEqual(installSharedHooks(hub, { home, runSync: false }).changed, [], '다시 해도 그대로');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function startHub(t, dir, port) {
  for (const d of ['data', 'runs', 'shared', 'work']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  Object.assign(config, { port, defaultCwd: path.join(dir, 'work'), hubDir: path.join(dir, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, sharedSync: { intervalSeconds: 0, watch: false } });
  const configFile = path.join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  let log = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(dir, 'data'), HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1' } });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  t.after(async () => { child.kill(); await closed; });
  for (let n = 0; !log.includes(`http://127.0.0.1:${port}`); n++) { assert.ok(n < 100 && child.exitCode === null, log || '시험 서버가 시작되지 않았어요'); await delay(50); }
  return path.join(dir, 'shared');
}

test('두 허브가 공유 기억을 주고받는다: 처음 맞추기·한쪽 변경·목록 합치기·충돌·지우기·검사', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await startHub(t, path.join(dir, 'home'), 7716), B = await startHub(t, path.join(dir, 'office'), 7717);
  const a = 'http://127.0.0.1:7716', b = 'http://127.0.0.1:7717';
  const put = (root, rel, text, mtime) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime)); };
  const read = (root, rel) => { try { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { return null; } };
  const post = async (base, route, body) => { const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  const sync = async () => { const r = await post(a, '/api/shared/sync'); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.results[0]; };

  put(A, 'AGENTS.md', '# 공용 지침\n');
  put(A, 'memory/global/MEMORY.md', '# 목록\n- [가](a.md) — 가\n');
  put(A, 'memory/global/a.md', '가 내용');
  put(A, 'sync/state.json', '{"pc":"home"}'); put(A, 'backups/x.txt', '백업'); put(A, 'hub/BOARD.md', '집 보드');

  // 이 PC 자신은 연결하지 못한다, 다른 허브는 이름과 함께 연결
  assert.equal((await post(a, '/api/peers', { url: a })).status, 400);
  const added = await post(a, '/api/peers', { url: b, name: '회사' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  await post(b, '/api/peers/self', { name: '회사' });
  const who = await (await fetch(b + '/api/peers/whoami')).json(); assert.equal(who.name, '회사');

  let r = await sync();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(read(B, 'memory/global/a.md'), '가 내용'); assert.equal(read(B, 'AGENTS.md'), '# 공용 지침\n');
  assert.equal(read(B, 'sync/state.json'), null, 'PC별 상태 파일은 보내지 않음'); assert.equal(read(B, 'backups/x.txt'), null); assert.equal(read(B, 'hub/BOARD.md'), null);

  // 회사에서만 바꾼 것은 집으로
  put(B, 'memory/global/b.md', '나 내용'); put(B, 'memory/global/MEMORY.md', '# 목록\n- [가](a.md) — 가\n- [나](b.md) — 나\n');
  r = await sync(); assert.equal(r.counts.pulled, 2, JSON.stringify(r));
  assert.equal(read(A, 'memory/global/b.md'), '나 내용'); assert.match(read(A, 'memory/global/MEMORY.md'), /\(b\.md\)/);

  // 둘 다 목록에 한 줄씩 더하면 두 줄 다 남는다
  put(A, 'memory/global/c.md', '다'); put(A, 'memory/global/MEMORY.md', read(A, 'memory/global/MEMORY.md') + '- [다](c.md) — 집에서\n');
  put(B, 'memory/global/d.md', '라'); put(B, 'memory/global/MEMORY.md', read(B, 'memory/global/MEMORY.md') + '- [라](d.md) — 회사에서\n');
  r = await sync(); assert.equal(r.counts.merged, 1, JSON.stringify(r));
  for (const root of [A, B]) { const idx = read(root, 'memory/global/MEMORY.md'); assert.match(idx, /c\.md/); assert.match(idx, /d\.md/); assert.equal((idx.match(/\(a\.md\)/g) || []).length, 1); }
  assert.equal(read(A, 'memory/global/MEMORY.md'), read(B, 'memory/global/MEMORY.md'));

  // 같은 파일을 둘 다 고치면 최근 것을 쓰고 밀린 쪽은 backups/sync 에 남긴다
  const now = Date.now();
  put(A, 'memory/global/a.md', '집에서 고침', now - 60_000); put(B, 'memory/global/a.md', '회사에서 고침', now);
  r = await sync(); assert.equal(r.counts.conflicts, 1, JSON.stringify(r));
  assert.equal(read(A, 'memory/global/a.md'), '회사에서 고침'); assert.equal(read(B, 'memory/global/a.md'), '회사에서 고침');
  const kept = fs.readdirSync(path.join(A, 'backups', 'sync'), { recursive: true }).map(String).find((n) => n.includes('a.md.'));
  assert.ok(kept, '밀린 판 보관'); assert.match(kept, /밀림-회사/);

  // 집에서 지우면 회사에서도 지우고 회사 쪽 backups 에 남긴다
  fs.rmSync(path.join(A, 'memory', 'global', 'c.md'));
  r = await sync(); assert.equal(r.counts.deleted, 1, JSON.stringify(r));
  assert.equal(read(B, 'memory/global/c.md'), null);
  assert.ok(fs.readdirSync(path.join(B, 'backups', 'sync'), { recursive: true }).map(String).some((n) => n.includes('c.md.') && n.includes('지움')));
  r = await sync(); assert.deepEqual(r.counts, { pulled: 0, pushed: 0, merged: 0, conflicts: 0, deleted: 0 }, '다 맞으면 할 일 없음');

  // 쓰기 검사: 범위 밖 경로·기대와 다른 이전 내용은 거절
  assert.equal((await post(b, '/api/shared/file', { rel: '../x.md', content: '' })).status, 400);
  assert.equal((await post(b, '/api/shared/file', { rel: 'sync/state.json', content: '' })).status, 403);
  assert.equal((await post(b, '/api/shared/file', { rel: 'memory/global/a.md', content: Buffer.from('x').toString('base64'), ifSha: 'wrong' })).status, 409);
  assert.equal(read(B, 'memory/global/a.md'), '회사에서 고침');

  const view = await (await fetch(a + '/api/peers')).json();
  assert.equal(view.peers.length, 1); assert.equal(view.peers[0].name, '회사'); assert.equal(view.sync.peers[0].ok, true);
});
