import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../lib/util.mjs';
import { RemoteAccess, checkRemoteRequest, normalizeRemoteConfig, decodeUserName, parseTailscaleStatus, remoteSnapshot, runCommand, sendRemoteBlocked } from '../lib/remote.mjs';
import { hasRemoteGate } from '../scripts/remote-access.mjs';
import { isIdle } from '../scripts/restart-hub.mjs';

const host = 'test-host.example.ts.net';
const raw = { version: 1, provider: 'tailscale', enabled: true, url: `https://${host}/`, hosts: [host], logins: ['owner@example.com'], target: 'http://127.0.0.1:7700' };
const remote = normalizeRemoteConfig(raw);
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/tailscale-${name}.json`, import.meta.url), 'utf8'));
function request({ method = 'GET', url = '/api/jobs', headers = {}, socket = '127.0.0.1' } = {}) {
  return { method, url, headers: { host: '127.0.0.1:7700', ...headers }, socket: { remoteAddress: socket } };
}
const remoteHeaders = { host, 'tailscale-user-login': 'owner@example.com' };
function gate(req, settings = remote) { return checkRemoteRequest(req, { port: 7700, remote: settings }); }

test('로컬 요청: 루프백 Host, 로컬 Origin, Origin 없는 CLI 허용', () => {
  for (const method of ['GET', 'HEAD', 'POST']) for (const origin of [undefined, 'http://127.0.0.1:7700', 'http://localhost:7700']) {
    const req = request({ method, headers: origin ? { origin } : {} });
    assert.equal(gate(req), null); assert.equal(req.hubViewer.remote, false);
  }
  for (const origin of ['http://evil.example', 'https://127.0.0.1:7700', 'null', 'http://127.0.0.1:7701']) assert.equal(gate(request({ method: 'POST', headers: { origin } })).code, 'bad_origin');
});
test('DNS 리바인딩: 꺼짐이면 remote_off, 켜짐이면 remote_host', () => {
  const req = request({ headers: { host: 'evil.example:7700' } });
  assert.equal(gate(req, {}).code, 'remote_off');
  assert.deepEqual([gate(req).status, gate(req).code], [421, 'remote_host']);
});
test('원격 계정·Host 검사: 누락, 다른 계정, 중복 헤더는 차단', () => {
  const req = request({ headers: { ...remoteHeaders, host: `${host.toUpperCase()}.:443`, 'tailscale-user-login': ' OWNER@EXAMPLE.COM ' } });
  assert.equal(gate(req), null); assert.equal(req.hubViewer.remote, true);
  for (const login of [undefined, 'other@example.com', 'owner@example.com,other@example.com']) assert.equal(gate(request({ headers: { host, 'tailscale-user-login': login } })).code, 'remote_user');
  assert.equal(gate(request({ headers: { ...remoteHeaders, host: `${host},evil.example` } })).code, 'remote_host');
  assert.equal(gate(request({ headers: remoteHeaders }), {}).code, 'remote_off');
});
test('Tailscale이 Host를 로컬 주소로 바꾼 경우에도 원격으로 검사', () => {
  const req = request({ headers: { 'x-forwarded-host': host, 'tailscale-user-login': 'owner@example.com' } });
  assert.equal(gate(req), null); assert.equal(req.hubViewer.remote, true);
  assert.equal(gate(request({ headers: { 'x-forwarded-proto': 'https' } })).code, 'remote_host');
});
test('원격 쓰기 Origin 검사와 원격 관리 API의 로컬 전용 제한', () => {
  assert.equal(gate(request({ method: 'POST', headers: { ...remoteHeaders, origin: `https://${host}` } })), null);
  assert.equal(gate(request({ method: 'POST', headers: { ...remoteHeaders, origin: 'https://evil.example' } })).code, 'bad_origin');
  for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(gate(request({ method, url: '/api/remote/enable', headers: remoteHeaders })).code, 'remote_local_only');
});
test('직접 네트워크 소켓은 올바른 헤더가 있어도 차단', () => {
  assert.equal(gate(request({ headers: remoteHeaders, socket: '192.0.2.5' })).code, 'remote_socket');
  for (const socket of ['::1', '::ffff:127.0.0.1']) assert.equal(gate(request({ socket })), null);
});
test('잘못된 설정은 실패 시 차단하고 파일 변경을 즉시 다시 읽음', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-remote-unit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = [], controller = new RemoteAccess({ dataDir: dir, findExe: () => null, log: (s) => logs.push(s) });
  assert.equal(controller.readConfig().enabled, false);
  fs.writeFileSync(controller.file, '{');
  assert.equal(controller.readConfig().enabled, false); controller.readConfig(); assert.equal(logs.length, 1);
  controller.saveConfig(raw); assert.equal(controller.readConfig().enabled, true);
  fs.writeFileSync(controller.file, JSON.stringify({ ...raw, logins: [] })); assert.equal(controller.readConfig().enabled, false);
  for (const change of [{ target: 'http://evil.example' }, { url: `https://${host}/?token=synthetic` }, { provider: 'other' }, { enabled: 'true' }]) assert.equal(normalizeRemoteConfig({ ...raw, ...change }).enabled, false);
});
test('사용자 이름 UTF-8 Q/B 헤더 디코딩', () => {
  assert.equal(decodeUserName('=?utf-8?q?=ED=99=8D=EA=B8=B8=EB=8F=99?='), '홍길동');
  assert.equal(decodeUserName(`=?UTF-8?B?${Buffer.from('홍길동').toString('base64')}?=`), '홍길동');
});
test('Tailscale 상태·Serve·다음 단계 파싱과 원격 응답의 인증 링크 제거', () => {
  const status = fixture('status-running'), serve = fixture('serve-on');
  const ts = parseTailscaleStatus(status, serve, { exe: 'synthetic-tailscale' });
  assert.deepEqual([ts.state, ts.dnsName, ts.login, ts.httpsEnabled, ts.serving, ts.funnel], ['Running', host, 'owner@example.com', true, true, false]);
  const snap = remoteSnapshot(remote, ts);
  assert.equal(snap.ready, true); assert.equal(snap.next.step, 'ready'); assert.equal(Object.hasOwn(snap, 'logins'), false);
  const needsLogin = parseTailscaleStatus(fixture('status-needslogin'), {}, { exe: 'synthetic-tailscale' });
  assert.equal(remoteSnapshot(remote, needsLogin).next.step, 'login');
  assert.equal(needsLogin.authUrl, 'https://login.tailscale.com/');
  assert.equal(remoteSnapshot(remote, needsLogin, { viewer: { remote: true } }).tailscale.authUrl, null);
  assert.equal(remoteSnapshot(remote, parseTailscaleStatus(null)).next.step, 'install');
  for (const state of ['Stopped', 'Starting']) assert.equal(remoteSnapshot(remote, parseTailscaleStatus({ BackendState: state }, {}, { exe: 'synthetic' })).next.step, 'start');
  assert.equal(remoteSnapshot(remote, parseTailscaleStatus({ ...status, CertDomains: [] }, serve, { exe: 'synthetic' })).next.step, 'enable-https');
  const trailingSlash = structuredClone(serve); trailingSlash.Web[`${host}:443`].Handlers['/'].Proxy += '/';
  assert.equal(parseTailscaleStatus(status, trailingSlash, { exe: 'synthetic' }).serving, true);
  assert.equal(remoteSnapshot({ ...remote, enabled: false }, ts).next.step, 'enable');
  assert.equal(parseTailscaleStatus({}, {}, { exe: 'synthetic' }).state, 'Unknown');
});
test('Funnel true는 경고·준비 완료 차단, false는 꺼짐; 다른 443 처리기는 충돌', () => {
  const status = fixture('status-running'), serve = fixture('serve-on');
  let ts = parseTailscaleStatus(status, { ...serve, AllowFunnel: { [`${host}:443`]: true } }, { exe: 'synthetic' });
  assert.equal(ts.funnel, true); assert.equal(remoteSnapshot(remote, ts).ready, false);
  ts = parseTailscaleStatus(status, { ...serve, AllowFunnel: { [`${host}:443`]: false } }, { exe: 'synthetic' }); assert.equal(ts.funnel, false);
  const conflict = structuredClone(serve); conflict.Web[`${host}:443`].Handlers['/'] = { Text: 'other service' };
  ts = parseTailscaleStatus(status, conflict, { exe: 'synthetic' }); assert.equal(remoteSnapshot(remote, ts).next.step, 'conflict');
  ts = parseTailscaleStatus(status, { Foreground: { synthetic: conflict } }, { exe: 'synthetic' }); assert.equal(ts.conflict, true);
});
function fakeController(t, { conflict = false, failOff = false, httpsLink = false, missingLogin = false, https = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-remote-cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const status = fixture('status-running'); if (missingLogin) status.User = {}; if (!https) status.CertDomains = [];
  let serve = conflict ? { TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } } : {};
  const calls = [];
  const controller = new RemoteAccess({ dataDir: dir, findExe: () => 'synthetic', log: () => {}, run: async (exe, args) => {
    calls.push(args);
    if (args[0] === 'version') return { code: 0, stdout: '1.102.4\n' };
    if (args[0] === 'status') return { code: 0, stdout: JSON.stringify(status) };
    if (args.join(' ') === 'serve status --json') return { code: 0, stdout: JSON.stringify(serve) };
    if (args.includes('--bg')) { if (httpsLink) return { code: null, httpsRequired: true, stdout: 'synthetic' }; serve = fixture('serve-on'); return { code: 0 }; }
    if (args.includes('off')) { assert.equal(controller.readConfig().enabled, false); if (failOff) return { code: 1 }; serve = {}; return { code: 0 }; }
    throw new Error('예상하지 않은 명령');
  } });
  return { controller, calls };
}
test('켜기 검증·기존 계정 유지·끄기 실패 시에도 앱 접속 차단', async (t) => {
  const { controller, calls } = fakeController(t, { failOff: true });
  controller.saveConfig({ ...raw, enabled: false, logins: ['second@example.com'] });
  const enabled = await controller.enable(); assert.equal(enabled.result.ok, true); assert.equal(enabled.ready, true); assert.equal(enabled.allowedCount, 2);
  const disabled = await controller.disable(); assert.equal(disabled.result.ok, false); assert.equal(controller.readConfig().enabled, false);
  assert(calls.some((a) => a.join(' ') === 'serve --bg --https=443 http://127.0.0.1:7700'));
  assert(calls.some((a) => a.join(' ') === 'serve --https=443 off'));
  assert(!calls.some((a) => a.includes('funnel') || a.includes('reset')));
});
test('충돌은 기본 거부, --force일 때만 변경; 로그인·HTTPS 없으면 실행 없음', async (t) => {
  const conflict = fakeController(t, { conflict: true });
  assert.equal((await conflict.controller.enable()).result.step, 'conflict'); assert(!conflict.calls.some((a) => a.includes('--bg')));
  assert.equal((await conflict.controller.enable({ force: true })).result.ok, true);
  assert(conflict.calls.some((a) => a.includes('--yes')));
  for (const options of [{ missingLogin: true }, { https: false }]) {
    const f = fakeController(t, options); assert.equal((await f.controller.enable()).result.ok, false); assert(!f.calls.some((a) => a.includes('--bg')));
  }
  const link = fakeController(t, { httpsLink: true }); assert.equal((await link.controller.enable()).result.step, 'enable-https'); assert.equal(link.controller.readConfig().enabled, false);
});
test('허용 계정 취소와 마지막 계정 제거는 즉시 게이트 차단', (t) => {
  const { controller } = fakeController(t); controller.saveConfig(raw);
  controller.changeLogin('Other@Example.com', true); assert.equal(controller.readConfig().logins.length, 2);
  controller.changeLogin('owner@example.com', false); assert.equal(controller.check(request({ headers: remoteHeaders })).code, 'remote_user');
  controller.changeLogin('other@example.com', false); assert.equal(controller.readConfig().enabled, false);
});
test('구버전 서버 사전 검사: 단순 HTTP 200이어도 계약이 없으면 거부', async (t) => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  assert.equal(await hasRemoteGate(`http://127.0.0.1:${server.address().port}`), false);
});
test('차단 페이지 치환·API JSON·파일 없음 대체 응답', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-blocked-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const denial = { status: 403, code: 'remote_user', error: '<script>&' };
  fs.writeFileSync(path.join(dir, 'remote-blocked.html'), '%%CODE%% %%MESSAGE%%');
  let sent; const send = (...args) => { sent = args; };
  sendRemoteBlocked({}, denial, '/', send, dir); assert.equal(sent[2], 'remote_user &lt;script&gt;&amp;');
  sendRemoteBlocked({}, denial, '/uploads/x.png', send, dir); assert.deepEqual(sent[2], { error: denial.error, code: denial.code });
  fs.unlinkSync(path.join(dir, 'remote-blocked.html')); sendRemoteBlocked({}, denial, '/', send, dir); assert.equal(sent[3], 'text/plain; charset=utf-8');
});
test('CLI 상태 캐시는 30초, force는 다시 조회; 명령 시간 제한은 해당 자식만 종료', async (t) => {
  const f = fakeController(t); await f.controller.status(); const n = f.calls.length; await f.controller.status(); assert.equal(f.calls.length, n); await f.controller.status({ force: true }); assert(f.calls.length > n);
  const run = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }); assert.equal(run.timedOut, true);
});
test('재시작 유휴 판정: 대기 작업·실행 중인 하위 작업·목표 판정 보호', () => {
  assert.equal(isIdle([], []), true);
  for (const status of ['queued', 'planning', 'running', 'reporting']) assert.equal(isIdle([{ status }], []), false);
  assert.equal(isIdle([{ status: 'done', tasks: [{ status: 'running' }] }], []), false);
  assert.equal(isIdle([], [{ goal: { status: 'active' } }]), false);
  assert.equal(isIdle([], [{ goal: { status: 'paused', checking: true } }]), false);
  assert.equal(isIdle({}, []), false);
});

test('격리 시험 서버: API·Origin·SSE·이미지와 재시작 없는 설정 취소', { timeout: 35_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-remote-server-'));
  // OS가 빈 포트를 고르게 하고 운영 7700/통합 작업자 7701을 건드리지 않는다.
  const reserve = http.createServer(); await new Promise((r) => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const config = { ...raw, target: `http://127.0.0.1:${port}` };
  fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify(config));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HUB_SKIP_CLI_INSTALL: '1', HUB_PORT: String(port), HUB_DATA_DIR: dir, HUB_RUNS_DIR: path.join(dir, 'runs') }, windowsHide: true, shell: false, stdio: 'ignore' });
  t.diagnostic(`숨김 시험 서버 PID ${child.pid}, 포트 ${port}`);
  t.after(async () => { if (child.exitCode === null) { const closed = new Promise((r) => child.once('exit', r)); child.kill(); await closed; } fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let n = 0; n < 80; n++) { try { const res = await fetch(base, { signal: AbortSignal.timeout(300) }); if (res.ok) { up = true; break; } } catch {} await delay(100); }
  assert.equal(up, true);
  const httpRequest = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }); req.on('error', reject); req.end(body);
  });
  let res = await httpRequest('/api/remote', { headers: remoteHeaders }); const status = JSON.parse(res.body);
  assert.equal(res.status, 200); assert.equal(status.viewer.remote, true); assert.equal(status.canManage, false); assert.equal(Object.hasOwn(status, 'logins'), false); assert.equal(status.tailscale.authUrl, null);
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN'); assert.equal(res.headers['referrer-policy'], 'same-origin');
  assert.equal(await hasRemoteGate(base), true);
  res = await httpRequest('/api/memory', { headers: { host: 'evil.example' } }); assert.equal(res.status, 421);
  for (const route of ['/api/jobs', '/api/events', '/uploads/missing.png', '/style.css']) { res = await httpRequest(route, { headers: { host } }); assert.equal(res.status, 403); }
  for (const [origin, expected] of [[`https://${host}`, 201], ['https://evil.example', 403]]) {
    res = await httpRequest('/api/sessions', { method: 'POST', headers: { ...remoteHeaders, origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: dir }) }); assert.equal(res.status, expected);
  }
  res = await httpRequest('/api/remote/enable', { method: 'POST', headers: remoteHeaders, body: '{}' }); assert.equal(JSON.parse(res.body).code, 'remote_local_only');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000000808020000', 'hex');
  res = await httpRequest('/api/uploads', { method: 'POST', headers: { ...remoteHeaders, origin: `https://${host}`, 'x-filename': 'test.png' }, body: png }); assert.equal(res.status, 201);
  const id = JSON.parse(res.body).id;
  res = await httpRequest(`/uploads/${id}`, { headers: remoteHeaders }); assert.equal(res.status, 200); assert.equal(res.headers['content-type'], 'image/png'); assert.deepEqual(res.body, png);
  let stream, streamRes, content = '';
  const ended = new Promise((resolve, reject) => {
    stream = http.get(`${base}/api/events`, { headers: remoteHeaders }, (r) => { streamRes = r; assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN'); r.on('data', (c) => { content += c; }); r.on('end', resolve); r.on('error', reject); }); stream.on('error', reject);
  });
  t.after(() => stream.destroy());
  for (let i = 0; i < 50 && !content.includes('"type":"hello"'); i++) await delay(50);
  assert(content.includes('"type":"hello"'));
  res = await httpRequest('/api/sessions', { method: 'POST', headers: { ...remoteHeaders, origin: `https://${host}` }, body: JSON.stringify({ cwd: dir }) }); assert.equal(res.status, 201);
  await delay(100); assert(content.includes('"type":"session"'));
  fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify({ ...config, enabled: false }));
  res = await httpRequest('/api/remote', { headers: remoteHeaders }); assert.equal(JSON.parse(res.body).code, 'remote_off');
  await Promise.race([ended, delay(3000).then(() => { throw new Error('원격 취소 후 SSE가 닫히지 않았습니다'); })]);
  assert(streamRes.complete); assert.equal((await httpRequest('/')).status, 200);
});
