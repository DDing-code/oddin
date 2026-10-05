// ODDIN 어도비 플러그인: 허브 쪽 연결(lib/adobe-bridge.mjs)·설치(lib/adobe-install.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdobeBridge, appKey } from '../lib/adobe-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fakeRes() {
  let close = null;
  const res = { writableEnded: false, body: null, on(ev, f) { if (ev === 'close') close = f; }, closeNow() { close?.(); } };
  const json = (r, o) => { r.body = o; r.writableEnded = true; };
  return { res, json };
}

test('앱 이름: 여러 표기를 premiere · aftereffects 로', () => {
  assert.equal(appKey('PPRO'), 'premiere'); assert.equal(appKey('Premiere Pro'), 'premiere'); assert.equal(appKey('ae'), 'aftereffects');
  assert.equal(appKey('photoshop'), null);
});

test('명령 주고받기: 기다리던 플러그인이 바로 받고, 결과가 run 으로 돌아온다', async () => {
  const events = [];
  const b = new AdobeBridge({ emit: (e) => events.push(e) });
  try {
    await assert.rejects(b.run({ app: 'premiere', script: 'return 1' }), (e) => e.status === 409 && /꺼져 있거나/.test(e.message), '아무도 안 붙었으면 바로 알려 줌');
    b.hello({ app: 'premiere', instance: 'pr-1', version: '1.0.0', appVersion: '26.2', project: 'C:/p.prproj' });
    assert.ok(events.some((e) => e.type === 'adobe' && e.apps[0].online));
    const { res, json } = fakeRes();
    b.next({ app: 'premiere', instance: 'pr-1', wait: '25' }, res, json);
    assert.equal(res.writableEnded, false, '명령이 없으면 기다린다');
    const pending = b.run({ app: 'PPRO', script: 'return app.project.path' });
    assert.equal(res.body.cmd.script, 'return app.project.path', '기다리던 요청에 바로 실림');
    b.result({ id: res.body.cmd.id, ok: true, result: 'C:/p.prproj' });
    const r = await pending;
    assert.equal(r.ok, true); assert.equal(r.result, 'C:/p.prproj'); assert.equal(r.app, 'premiere');
    assert.equal(b.status().apps[0].done, 1);
    // 기다리는 요청이 없을 때 온 명령은 쌓였다가 다음 기다림에 바로 나간다
    const p2 = b.run({ app: 'premiere', file: 'C:/x.jsx' });
    const r2 = fakeRes(); b.next({ app: 'premiere', instance: 'pr-1' }, r2.res, r2.json);
    assert.equal(r2.res.body.cmd.file, 'C:/x.jsx');
    b.result({ id: r2.res.body.cmd.id, ok: false, error: '문법 오류 (3번째 줄)' });
    assert.deepEqual([(await p2).ok, (await p2).error], [false, '문법 오류 (3번째 줄)']);
    assert.deepEqual(b.result({ id: 'nope' }), { ok: false, unknown: true });
    // 다른 앱은 따로
    await assert.rejects(b.run({ app: 'aftereffects', script: 'x' }), /애프터이펙트/);
  } finally { b.close(); }
});

test('답이 없으면 정한 시간 뒤 실패로 돌려주고, 오래 소식 없는 플러그인은 꺼진 것으로 본다', async () => {
  let now = 1_000_000;
  const b = new AdobeBridge({ now: () => now });
  try {
    b.hello({ app: 'ae', instance: 'ae-1' });
    const r = await new Promise((ok) => { b.run({ app: 'aftereffects', script: 'while(1){}', timeoutSeconds: 0.05 }).then(ok); setTimeout(() => {}, 100); });
    assert.equal(r.ok, false); assert.equal(r.timedOut, true);
    assert.equal(b.status().apps[0].waiting, 0, '쌓인 명령도 치움');
    now += 60_000;
    assert.equal(b.status().apps[0].online, false);
    await assert.rejects(b.run({ app: 'aftereffects', script: 'x' }), (e) => e.status === 409);
  } finally { b.close(); }
});

test('설치: 두 앱용 폴더를 따로 만들고, 우리가 만들지 않은 폴더는 건드리지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-adobe-'));
  process.env.HUB_ADOBE_EXT_DIR = dir;
  try {
    const { installAdobePlugins, adobeInstallStatus, refreshAdobePlugins } = await import('../lib/adobe-install.mjs');
    assert.equal(adobeInstallStatus(root).apps.every((a) => !a.installed), true);
    assert.equal(refreshAdobePlugins(root), null, '설치한 적 없으면 허브 시작 때 설치하지 않음');
    const r = installAdobePlugins(root, { port: 7788 });
    assert.equal(r.ok, true);
    for (const app of ['premiere', 'aftereffects']) {
      const d = path.join(dir, `com.oddin.${app}`);
      const manifest = fs.readFileSync(path.join(d, 'CSXS', 'manifest.xml'), 'utf8');
      assert.match(manifest, new RegExp(`ExtensionBundleId="com.oddin.${app}"`));
      assert.match(manifest, app === 'premiere' ? /Host Name="PPRO"/ : /Host Name="AEFT"/);
      assert.ok(!manifest.includes('@VERSION@'));
      assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'app.json'), 'utf8')).hub, 'http://127.0.0.1:7788');
      for (const f of ['panel.html', 'panel.js', 'worker.html', 'bridge.js', 'logo.svg', 'host/oddin.jsx']) assert.ok(fs.existsSync(path.join(d, f)), f);
    }
    // 프리미어가 읽는 스크립트는 ASCII 만 (한 글자라도 한글이면 모든 명령이 깨진다)
    assert.ok(!/[^\x00-\x7e]/.test(fs.readFileSync(path.join(dir, 'com.oddin.premiere', 'host', 'oddin.jsx'), 'utf8')));
    assert.ok(adobeInstallStatus(root).apps.every((a) => a.upToDate));
    // 남이 만든 같은 이름 폴더는 그대로
    fs.rmSync(path.join(dir, 'com.oddin.aftereffects', '.oddin-plugin'));
    const r2 = installAdobePlugins(root);
    assert.equal(r2.apps.find((a) => a.app === 'aftereffects').ok, false);
    assert.equal(r2.apps.find((a) => a.app === 'premiere').ok, true);
  } finally { delete process.env.HUB_ADOBE_EXT_DIR; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('화면 없이 뜬 AE는 고르지 않고, 명령을 실행하는 동안은 붙어 있는 것으로 본다', async () => {
  let now = 5_000_000;
  const b = new AdobeBridge({ now: () => now });
  try {
    b.hello({ app: 'aftereffects', instance: 'ae-bg', headless: true });
    await assert.rejects(b.run({ app: 'aftereffects', script: 'x' }), (e) => e.status === 409, '백그라운드 AE만 있으면 없는 것과 같다');
    b.hello({ app: 'aftereffects', instance: 'ae-ui' });
    const p = b.run({ app: 'aftereffects', script: 'render()', timeoutSeconds: 600 });
    const r = fakeRes(); b.next({ app: 'aftereffects', instance: 'ae-ui' }, r.res, r.json);
    assert.equal(r.res.body.cmd.script, 'render()');
    now += 10 * 60_000 - 1000; // 긴 렌더: 기다림 요청이 오래 없어도
    assert.equal(b.status().apps.find((a) => a.instance === 'ae-ui').online, true);
    b.result({ id: r.res.body.cmd.id, ok: true, result: 'done' });
    assert.equal((await p).result, 'done');
  } finally { b.close(); }
});

test('플러그인 연결 코드(adobe/plugin/bridge.js)가 허브와 실제로 주고받는다', async () => {
  const http = await import('node:http');
  const vm = await import('node:vm');
  const { createRequire } = await import('node:module');
  const b = new AdobeBridge();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c;
    const json = (r, o) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (u.pathname === '/api/adobe/hello') return json(res, b.hello(JSON.parse(body)));
    if (u.pathname === '/api/adobe/next') return b.next(Object.fromEntries(u.searchParams), res, json);
    if (u.pathname === '/api/adobe/result') return json(res, b.result(JSON.parse(body)));
    res.writeHead(404); res.end('{}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bridge-'));
  fs.copyFileSync(path.join(root, 'adobe', 'plugin', 'bridge.js'), path.join(dir, 'bridge.js'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ hub: `http://127.0.0.1:${server.address().port}`, version: '1.0.0' }));
  const seen = [];
  // 가짜 CEP: 앱 안 스크립트 엔진 대신 받은 코드를 기록하고 ODDIN.run 결과 모양으로 답한다
  const cep = {
    getHostEnvironment: () => JSON.stringify({ appName: 'PPRO', appVersion: '26.2' }),
    evalScript: (code, cb) => setTimeout(() => {
      seen.push(code);
      if (/String\(ODDIN\.version\)/.test(code)) return cb('1.0.0');
      if (/ODDIN\.info\(\)/.test(code)) return cb(JSON.stringify({ project: 'C:/p.prproj' }));
      if (code.startsWith('ODDIN.run(')) return cb(JSON.stringify({ ok: true, result: code.includes('\\ud55c') ? 'ascii-ok' : 'plain' }));
      cb('');
    }, 5),
  };
  const ctx = { window: { __adobe_cep__: cep }, location: { pathname: '/' + dir.replace(/\\/g, '/') + '/worker.html' }, require: createRequire(import.meta.url), Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, console, process };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8'), ctx);
  try {
    ctx.window.ODDINBridge.start('worker');
    const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
    assert.ok(await until(() => b.status().apps.some((a) => a.online && a.project === 'C:/p.prproj')), '플러그인이 붙고 열린 프로젝트를 알려 줌');
    const r = await b.run({ app: 'premiere', script: 'return "한"' });
    assert.deepEqual([r.ok, r.result], [true, 'ascii-ok'], '한글은 \\uXXXX 로 바꿔 앱에 보냄');
    assert.ok(seen.some((c) => c.startsWith('ODDIN.run(function () {') && !/[^\x00-\x7e]/.test(c)));
  } finally { ctx.window.ODDINBridge.stop(); b.close(); server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('앱이 예전 판 도우미를 들고 있으면 새 도우미를 먼저 읽혀 보낸다 (앱을 다시 켜지 않아도 새 명령)', async () => {
  const b = new AdobeBridge({ installed: (app) => (app === 'premiere' ? { version: '1.1.0', host: 'C:\\ext\\com.oddin.premiere\\host\\oddin.jsx' } : null) });
  try {
    b.hello({ app: 'premiere', instance: 'pr-old', version: '1.0.0' });
    const p = b.run({ app: 'premiere', script: 'return ODDIN.pr.status();' });
    const r = fakeRes(); b.next({ app: 'premiere', instance: 'pr-old' }, r.res, r.json);
    assert.equal(r.res.body.cmd.script, '$.evalFile("C:/ext/com.oddin.premiere/host/oddin.jsx");\nreturn ODDIN.pr.status();');
    b.result({ id: r.res.body.cmd.id, ok: true, result: {} }); await p;
    // 같은 판이면 그대로
    b.hello({ app: 'premiere', instance: 'pr-old', version: '1.1.0' });
    const p2 = b.run({ app: 'premiere', script: 'return 1;' });
    const r2 = fakeRes(); b.next({ app: 'premiere', instance: 'pr-old' }, r2.res, r2.json);
    assert.equal(r2.res.body.cmd.script, 'return 1;');
    b.result({ id: r2.res.body.cmd.id, ok: true, result: 1 }); await p2;
  } finally { b.close(); }
});

test('이름 붙은 명령: 도우미에 프리미어·애프터이펙트 명령이 있고 출력 파일은 덮어쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(root, 'adobe', 'plugin', 'host', 'oddin.jsx'), 'utf8');
  const pr = src.slice(src.indexOf('ODDIN.pr = {'), src.indexOf('ODDIN.ae = {')), ae = src.slice(src.indexOf('ODDIN.ae = {'));
  for (const n of ['status', 'open', 'save', 'saveAs', 'importFiles', 'newSequence', 'setActive', 'clips', 'place', 'marker', 'exportMedia']) assert.ok(pr.includes(`\n  ${n}: function`), `pr.${n}`);
  for (const n of ['status', 'open', 'save', 'newComp', 'importFile', 'layers', 'addLayer', 'addText', 'frame', 'render']) assert.ok(ae.includes(`\n  ${n}: function`), `ae.${n}`);
  assert.match(src, /File already exists \(pass overwrite:true/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'adobe', 'version.json'), 'utf8')).version, src.match(/ODDIN\.version = '([\d.]+)'/)[1], '도우미 판 = 플러그인 판');
});
