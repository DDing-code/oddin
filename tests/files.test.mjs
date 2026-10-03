import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../lib/util.mjs';
import { PreviewManager } from '../lib/preview.mjs';
import { parseRange, resolveFile } from '../lib/files.mjs';

const run = promisify(execFile);
const base = 'http://127.0.0.1:7714';
test('파일·터미널·미리보기 API: 7714 격리 서버', { timeout: 150000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tools-api-')), cwd = path.join(dir, 'workspace');
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(dir, 'shared')); fs.mkdirSync(path.join(dir, 'data'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  Object.assign(config, { port: 7714, defaultCwd: cwd, hubDir: path.join(dir, 'shared'), tools: { claude: { enabled: false }, codex: { enabled: false } } });
  const configFile = path.join(dir, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const at = new Date().toISOString(); fs.writeFileSync(path.join(dir, 'data', 'sessions.json'), JSON.stringify([{ id: 'tools-session', cwd, title: '도구 시험', jobIds: [], createdAt: at, updatedAt: at }]));
  let serverLog = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_PORT: '7714', HUB_DATA_DIR: path.join(dir, 'data'), HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: configFile, HUB_SKIP_CLI_INSTALL: '1' } });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.stdout.on('data', (b) => { serverLog += b; }); child.stderr.on('data', (b) => { serverLog += b; });
  const terminals = new Set();
  t.after(async () => {
    for (const id of terminals) await fetch(`${base}/api/terminals/${id}`, { method: 'DELETE' }).catch(() => {});
    child.kill(); await closed; fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let n = 0; !serverLog.includes('ODDIN  http://127.0.0.1:7714'); n++) { assert.ok(n < 100 && child.exitCode === null, serverLog || '시험 서버가 시작되지 않았어요'); await delay(50); }
  const file = (name) => `${base}/api/file?${new URLSearchParams({ path: path.join(cwd, name) })}`;
  const list = (suffix = '') => `${base}/api/files/list?${new URLSearchParams({ path: cwd })}${suffix}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('범위 밖·없는 경로·상대 경로·바깥 정션 거절', async () => {
    fs.writeFileSync(path.join(dir, 'outside.txt'), '범위 밖');
    assert.equal((await fetch(`${base}/api/file?${new URLSearchParams({ path: path.join(dir, 'outside.txt') })}`)).status, 403);
    assert.equal((await fetch(file('none.txt'))).status, 404);
    assert.equal((await fetch(`${base}/api/file?path=relative`)).status, 400);
    fs.writeFileSync(path.join(cwd, 'a.mjs'), '\ufeffconst 이름 = "한글";');
    const response = await fetch(`${base}/api/file?${new URLSearchParams({ rel: 'a.mjs', base: cwd })}`); assert.equal(response.status, 200); assert.equal((await response.json()).language, 'javascript');
    const escape = path.join(cwd, 'escape'); fs.symlinkSync(dir, escape, 'junction');
    assert.throws(() => resolveFile({ path: path.join(escape, 'outside.txt') }, [cwd]), (e) => e.status === 403);
    assert.equal((await fetch(file('escape/outside.txt'))).status, 403); fs.unlinkSync(escape);
  });
  await t.test('텍스트·BOM·인코딩·HTML·SVG는 JSON 텍스트만', async () => {
    const text = await (await fetch(file('a.mjs'))).json(); assert.equal(text.kind, 'text'); assert.equal(text.bom, true); assert.equal(text.encoding, 'utf-8'); assert.equal(text.content, 'const 이름 = "한글";');
    fs.writeFileSync(path.join(cwd, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글 UTF16', 'utf16le')]));
    const utf16 = await (await fetch(file('utf16.txt'))).json(); assert.equal(utf16.encoding, 'utf-16le'); assert.equal(utf16.content, '한글 UTF16');
    fs.writeFileSync(path.join(cwd, 'legacy.txt'), Buffer.from([0xb0, 0xa1]));
    const legacy = await (await fetch(file('legacy.txt'))).json(); assert.equal(legacy.encoding, 'unknown'); assert.equal(legacy.content, null); assert.match(legacy.message, /인코딩/);
    for (const name of ['script.html', 'script.svg']) {
      fs.writeFileSync(path.join(cwd, name), '<script>alert(1)</script>');
      const response = await fetch(file(name)); assert.match(response.headers.get('content-type'), /application\/json/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal((await response.json()).kind, 'text');
    }
  });
  await t.test('이진·1MB 초과 텍스트는 내용 대신 메타 정보', async () => {
    fs.writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 255, 2]));
    const binary = await (await fetch(file('binary.bin'))).json(); assert.equal(binary.kind, 'binary'); assert.equal(binary.size, 4); assert.equal(binary.content, undefined);
    fs.writeFileSync(path.join(cwd, 'large.txt'), '가'.repeat(400000));
    const large = await (await fetch(file('large.txt'))).json(); assert.equal(large.kind, 'text'); assert.equal(large.tooLarge, true); assert.equal(large.content, null);
  });
  await t.test('영상·이미지·오디오·PDF 스트리밍과 Range·HEAD', async () => {
    for (const [name, mime] of [['movie.mp4', 'video/mp4'], ['image.png', 'image/png'], ['sound.wav', 'audio/wav'], ['doc.pdf', 'application/pdf']]) {
      fs.writeFileSync(path.join(cwd, name), Buffer.from('0123456789'));
      const response = await fetch(file(name)); assert.equal(response.headers.get('content-type'), mime); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(await response.text(), '0123456789');
      const meta = await (await fetch(file(name) + '&meta=1')).json(); assert.equal(meta.streaming, true); assert.equal(meta.contentType, mime); assert.equal(meta.language, 'plaintext');
    }
    for (const [range, content, span] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-99', '89', 'bytes 8-9/10']]) {
      const response = await fetch(file('movie.mp4'), { headers: { Range: range } }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), span); assert.equal(await response.text(), content);
    }
    for (const range of ['bytes=20-', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=9007199254740999-']) {
      const response = await fetch(file('movie.mp4'), { headers: { Range: range } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10');
    }
    const head = await fetch(file('movie.mp4'), { method: 'HEAD', headers: { Range: 'bytes=1-3' } }); assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '3'); assert.equal(await head.text(), '');
    assert.throws(() => parseRange('bytes=0-', 0), (e) => e.status === 416);
  });
  await t.test('폴더 목록·숨김 파일·Windows 숨김 속성·2000개 상한', async () => {
    fs.writeFileSync(path.join(cwd, '.hidden'), '숨김'); fs.writeFileSync(path.join(cwd, 'windows-hidden.txt'), '숨김');
    await run('attrib.exe', ['+H', path.join(cwd, 'windows-hidden.txt')], { windowsHide: true });
    const normal = await (await fetch(list())).json(); assert.ok(!normal.entries.some((e) => e.name === '.hidden' || e.name === 'windows-hidden.txt'));
    const all = await (await fetch(list('&hidden=1'))).json(); assert.ok(all.entries.some((e) => e.name === '.hidden' && e.hidden)); assert.ok(all.entries.some((e) => e.name === 'windows-hidden.txt' && e.hidden));
    assert.ok(all.entries.every((e) => typeof e.size === 'number' && e.modifiedAt && e.kind));
    const many = path.join(cwd, 'many'); fs.mkdirSync(many); for (let i = 0; i < 2003; i++) fs.writeFileSync(path.join(many, `${i}.txt`), '');
    const result = await (await fetch(`${base}/api/files/list?${new URLSearchParams({ path: many })}`)).json(); assert.equal(result.entries.length, 2000); assert.equal(result.truncated, true);
    assert.equal((await fetch(`${base}/api/files/list?${new URLSearchParams({ path: dir })}`)).status, 403);
  });
  await t.test('터미널 API·SSE·버퍼·개발 서버 감지·닫기', async () => {
    const abort = new AbortController(), events = await fetch(base + '/api/events', { signal: abort.signal }); const reader = events.body.getReader(); let sse = '';
    const pump = (async () => { try { while (true) { const { done, value } = await reader.read(); if (done) return; sse += Buffer.from(value).toString('utf8'); } } catch { /* 시험이 끝나면 SSE 연결을 닫는다. */ } })();
    try {
      assert.equal((await post('/api/terminals', { sessionId: 'missing' })).status, 404);
      const created = await post('/api/terminals', { sessionId: 'tools-session' }); assert.equal(created.status, 201); const term = await created.json(); terminals.add(term.id);
      const response = await post(`/api/terminals/${term.id}/input`, { text: "Write-Output '한글 API'; Write-Output 'http://localhost:5173/'" }); assert.equal(response.status, 200);
      let buffer; for (let n = 0; n < 100; n++) { buffer = await (await fetch(`${base}/api/terminals/${term.id}/buffer`)).json(); if (!buffer.terminal.running) break; await delay(30); }
      assert.equal(buffer.terminal.commandCode, 0); assert.ok(buffer.chunks.some((e) => e.chunk.includes('한글 API')));
      const listing = await (await fetch(base + '/api/terminals?sessionId=tools-session')).json(); assert.equal(listing.length, 1);
      const targets = await (await fetch(base + '/api/preview/targets?sessionId=tools-session')).json(); assert.ok(targets.targets.some((e) => e.port === 5173 && e.source === 'detected')); assert.ok(targets.ports.some((e) => e.port === 7714 && !e.selectable));
      assert.equal((await post(`/api/terminals/${term.id}/interrupt`, {})).status, 200);
      await fetch(`${base}/api/terminals/${term.id}`, { method: 'DELETE' }); terminals.delete(term.id);
      for (let n = 0; !sse.includes('term_exit') && n < 100; n++) await delay(20);
      assert.match(sse, /"type":"term"/); assert.match(sse, /"type":"term_state"/); assert.match(sse, /"type":"term_exit"/);
    } finally { abort.abort(); await pump; }
  });
  await t.test('미리보기 HTTP: 선택 전 거절·허브/민감 포트 거절·경로/쿼리·헤더·리다이렉트', async () => {
    let received;
    const upstream = http.createServer((req, res) => { received = { url: req.url, headers: req.headers }; if (req.url === '/redirect') { res.writeHead(302, { Location: '/next?q=1' }); res.end(); } else { res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'preview=unsafe' }); res.end('<h1>미리보기</h1>'); } });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve)); const port = upstream.address().port;
    try {
      assert.equal((await fetch(`${base}/preview/${port}/`)).status, 403);
      for (const blocked of [7714, 7700, 9222, 6379, 80]) assert.equal((await post('/api/preview/targets', { sessionId: 'tools-session', port: blocked })).status, 403);
      assert.equal((await post('/api/preview/targets', { sessionId: 'tools-session', port })).status, 201);
      const response = await fetch(`${base}/preview/${port}/some/path?q=한글`, { headers: { Cookie: 'hub=private', Authorization: 'synthetic-private' } });
      assert.equal(response.status, 200); assert.equal(await response.text(), '<h1>미리보기</h1>'); assert.equal(response.headers.get('set-cookie'), null); assert.match(response.headers.get('content-security-policy'), /sandbox/);
      assert.equal(received.url, '/some/path?q=%ED%95%9C%EA%B8%80'); assert.equal(received.headers.cookie, undefined); assert.equal(received.headers.authorization, undefined); assert.equal(received.headers.host, `127.0.0.1:${port}`);
      const redirect = await fetch(`${base}/preview/${port}/redirect`, { redirect: 'manual' }); assert.equal(redirect.headers.get('location'), `/preview/${port}/next?q=1`);
    } finally { await new Promise((resolve) => upstream.close(resolve)); }
    assert.equal((await fetch(`${base}/preview/${port}/`)).status, 502);
  });
  await t.test('인증된 원격 화면도 파일 읽기·터미널 실행·미리보기 선택 허용', async () => {
    const host = 'tools-test.example.ts.net'; fs.writeFileSync(path.join(dir, 'data', 'remote.json'), JSON.stringify({ version: 1, provider: 'tailscale', enabled: true, url: `https://${host}/`, hosts: [host], logins: ['owner@example.com'], target: base }));
    const headers = { host, 'x-forwarded-host': host, 'tailscale-user-login': 'owner@example.com', origin: `https://${host}` };
    assert.equal((await fetch(file('a.mjs'), { headers })).status, 200);
    const response = await fetch(base + '/api/terminals', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'tools-session' }) }); assert.equal(response.status, 201);
    const term = await response.json(); terminals.add(term.id);
    assert.equal((await fetch(`${base}/api/terminals/${term.id}/input`, { method: 'POST', headers, body: JSON.stringify({ text: "'원격 명령'" }) })).status, 200);
    assert.equal((await fetch(base + '/api/preview/targets', { method: 'POST', headers, body: JSON.stringify({ sessionId: 'tools-session', port: 5174 }) })).status, 201);
    assert.equal((await fetch(file('a.mjs'), { headers: { host, 'x-forwarded-host': host } })).status, 403);
    await fetch(`${base}/api/terminals/${term.id}`, { method: 'DELETE', headers }); terminals.delete(term.id);
  });
});

test('미리보기 발견: 분할 출력·ANSI·IPv6·민감 포트·세션별 목록', async () => {
  const preview = new PreviewManager({ hubPort: 7714, getSession: (id) => ['a', 'b'].includes(id), queryPorts: async () => [{ port: 5173, addresses: ['127.0.0.1'], pids: [123] }] });
  preview.detect('a', '\x1b[32mhttp://local'); preview.detect('a', 'host:5173/\x1b[0m\nhttp://[::1]:5174/\nhttp://localhost:9222/\n');
  const a = await preview.targets('a'); assert.equal(a.targets.length, 2); assert.equal(a.targets.find((e) => e.port === 5173).listening, true);
  assert.equal((await preview.targets('b')).targets.length, 0);
  assert.throws(() => preview.select('a', '5173'), (e) => e.status === 400); assert.throws(() => preview.select('no-session', 5173), (e) => e.status === 404);
  assert.equal(preview.allowed(5173), true); assert.equal(preview.allowed(5175), false);
});
