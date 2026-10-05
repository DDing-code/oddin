// 공유 폴더(읽기용 사본): 허브 두 개(7720 "집", 7721 "회사") — 집이 공유한 폴더를 회사가 ~/.ai-shared/peer-files 로 받는다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../lib/util.mjs';
import { scanFolder } from '../lib/shared-folders.mjs';

test('폴더 훑기: node_modules·.git·빌드 결과·큰 파일·미디어는 뺀다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sf-scan-'));
  try {
    for (const [rel, body] of [['main.js', 'a'], ['src/x.js', 'b'], ['node_modules/m/i.js', 'c'], ['.git/HEAD', 'd'], ['dist/b.js', 'e'], ['clip.mp4', 'f'], ['big.txt', 'x'.repeat(2 * 1024 * 1024 + 1)]]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body);
    }
    assert.deepEqual(Object.keys(scanFolder(dir).files).sort(), ['main.js', 'src/x.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function startHub(t, dir, port) {
  for (const d of ['data', 'runs', 'shared', 'work']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  Object.assign(config, { port, defaultCwd: path.join(dir, 'work'), hubDir: path.join(dir, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } }, sharedSync: { intervalSeconds: 0, watch: false }, sharedFolders: { intervalSeconds: 0 } });
  const configFile = path.join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  let log = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(dir, 'data'), HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1' } });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  t.after(async () => { child.kill(); await closed; });
  for (let n = 0; !log.includes(`http://127.0.0.1:${port}`); n++) { assert.ok(n < 100 && child.exitCode === null, log || '시험 서버가 시작되지 않았어요'); await delay(50); }
  return path.join(dir, 'shared');
}

test('집이 공유한 폴더를 회사가 읽기용 사본으로 받고, 원본 변경·삭제·공유 중단을 따라간다', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-folders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await startHub(t, path.join(dir, 'home'), 7720); const office = await startHub(t, path.join(dir, 'office'), 7721);
  const a = 'http://127.0.0.1:7720', b = 'http://127.0.0.1:7721';
  const post = async (base, route, body) => { const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  await post(a, '/api/peers/self', { name: '집' });
  const plugin = path.join(dir, 'plugin');
  for (const [rel, body] of [['manifest.json', '{"name":"집 플러그인"}'], ['main.js', 'console.log(1)'], ['lib/util.js', 'export const x = 1'], ['node_modules/dep/i.js', '무시']]) { fs.mkdirSync(path.dirname(path.join(plugin, rel)), { recursive: true }); fs.writeFileSync(path.join(plugin, rel), body); }

  let r = await post(a, '/api/shared-folders', { path: plugin, name: '프리미어 플러그인' });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.files, 3);
  assert.equal((await post(a, '/api/shared-folders', { path: plugin })).status, 409, '같은 폴더 두 번 공유 안 됨');
  assert.equal((await post(a, '/api/shared-folders', { path: path.join(dir, '없음') })).status, 404);
  const id = r.body.id;
  assert.equal((await fetch(`${a}/api/shared-folders/${id}/file?rel=${encodeURIComponent('../config.json')}`)).status, 400);
  assert.equal((await fetch(`${a}/api/shared-folders/${id}/file?rel=${encodeURIComponent('node_modules/dep/i.js')}`)).status, 404, '공유 범위 밖 파일');

  assert.equal((await post(b, '/api/peers', { url: a, name: '집' })).status, 201);
  const pull = async () => { const x = await post(b, '/api/shared-folders/pull'); assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body.results[0]; };
  let res = await pull(); assert.equal(res.ok, true, JSON.stringify(res));
  const mirror = path.join(office, 'peer-files', '집', '프리미어 플러그인');
  assert.equal(fs.readFileSync(path.join(mirror, 'lib', 'util.js'), 'utf8'), 'export const x = 1');
  assert.ok(!fs.existsSync(path.join(mirror, 'node_modules')));
  assert.match(fs.readFileSync(path.join(office, 'peer-files', 'INDEX.md'), 'utf8'), /\| 집 \| 프리미어 플러그인 \|/);

  // 원본 고침·지움은 따라가고, 사본을 고친 것은 원본 내용으로 돌아간다
  fs.writeFileSync(path.join(plugin, 'main.js'), 'console.log(2)'); fs.rmSync(path.join(plugin, 'lib', 'util.js'));
  fs.writeFileSync(path.join(mirror, 'manifest.json'), '사본에서 고침');
  res = await pull(); assert.deepEqual(res.folders[0], { name: '프리미어 플러그인', got: 2, removed: 1 });
  assert.equal(fs.readFileSync(path.join(mirror, 'main.js'), 'utf8'), 'console.log(2)');
  assert.equal(fs.readFileSync(path.join(mirror, 'manifest.json'), 'utf8'), '{"name":"집 플러그인"}');
  assert.ok(!fs.existsSync(path.join(mirror, 'lib', 'util.js')));
  const list = await (await fetch(`${b}/api/shared-folders`)).json();
  assert.equal(list.mirrors.length, 1); assert.equal(list.mirrors[0].files, 2);

  // 공유를 그만두면 사본도 지운다
  assert.equal((await fetch(`${a}/api/shared-folders/${id}`, { method: 'DELETE' })).status, 200);
  await pull();
  assert.ok(!fs.existsSync(mirror));
  assert.equal((await (await fetch(`${b}/api/shared-folders`)).json()).mirrors.length, 0);
  assert.ok(fs.existsSync(path.join(plugin, 'main.js')), '원본은 그대로');
});
