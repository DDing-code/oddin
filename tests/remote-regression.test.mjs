import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../lib/util.mjs';

// 실제 작업 실행 없이, 완료된 가짜 기록과 임시 첨부로 접근 통제를 확인한다.
const host = 'regression.example.ts.net';
const headers = { host, 'tailscale-user-login': 'owner@example.com' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const marker = '격리된 시험 기록';
let dir, base, child, config, imageId;
function saveConfig(change = {}) { fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify({ ...config, ...change })); }
function request(route, { method = 'GET', headers: extra = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${route}`, { method, headers: extra }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('시험 요청 시간 초과')));
    req.on('error', reject); req.end(body);
  });
}
const json = (res) => JSON.parse(res.body);
async function until(predicate, message, timeout = 3500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(30); }
  throw new Error(message);
}
function events(extra = {}) {
  const state = { content: '', ended: false, status: null };
  const req = http.get(`${base}/api/events`, { headers: extra }, (res) => {
    state.status = res.statusCode;
    res.on('data', (c) => { state.content += c; });
    res.on('end', () => { state.ended = true; });
    res.on('error', (error) => { state.error = error; });
  });
  req.on('error', (error) => { state.error = error; });
  state.close = () => req.destroy(); return state;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-t4-regression-'));
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  base = `http://127.0.0.1:${port}`;
  config = { version: 1, provider: 'tailscale', enabled: true, url: `https://${host}/`, hosts: [host], logins: ['owner@example.com'], target: base };
  saveConfig();
  const runDir = path.join(dir, 'runs', 'fixture-job'); fs.mkdirSync(runDir, { recursive: true });
  const at = '2026-10-03T00:00:00.000Z';
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify([{ id: 'fixture-session', cwd: dir, title: marker, createdAt: at, updatedAt: at, jobIds: ['fixture-job'] }]));
  fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify([{ id: 'fixture-job', sessionId: 'fixture-session', cwd: dir, title: marker, status: 'done', report: marker, createdAt: at, finishedAt: at, runDir, tasks: [{ id: 't1', status: 'done' }] }]));
  fs.writeFileSync(path.join(runDir, 't1.log.jsonl'), JSON.stringify({ text: marker }) + '\n');
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, HUB_SKIP_CLI_INSTALL: '1', HUB_PORT: String(port), HUB_DATA_DIR: dir, HUB_RUNS_DIR: path.join(dir, 'runs') }, windowsHide: true, shell: false, stdio: 'ignore' });
  console.log(`격리 회귀 서버 PID ${child.pid}, 포트 ${port}`);
  await until(async () => { try { return (await request('/')).status === 200; } catch { return false; } }, '격리 시험 서버가 시작되지 않았습니다', 8000);
  const up = await request('/api/uploads', { method: 'POST', headers: { ...headers, origin: `https://${host}`, 'x-filename': 'regression.png' }, body: png });
  assert.equal(up.status, 201); imageId = json(up).id;
});
after(async () => {
  if (child && child.exitCode === null) { const closed = new Promise((r) => child.once('exit', r)); child.kill(); await closed; }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('원격 회귀: 허용 주소의 정적 화면·기록·로그·첨부 및 Host 재작성', async () => {
  for (const route of ['/', '/app.js', '/remote.js', '/style.css', '/api/options']) assert.equal((await request(route, { headers })).status, 200, route);
  for (const route of ['/api/jobs', '/api/jobs/fixture-job', '/api/jobs/fixture-job/log/t1', '/api/sessions/fixture-session/jobs']) {
    const res = await request(route, { headers }); assert.equal(res.status, 200); assert(res.body.toString().includes(marker), route);
  }
  const image = await request(`/uploads/${imageId}`, { headers });
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/png'); assert.deepEqual(image.body, png);
  const status = json(await request('/api/remote', { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'owner@example.com' } }));
  assert.equal(status.viewer.remote, true); assert.equal(status.canManage, false); assert.equal(Object.hasOwn(status, 'logins'), false);
});

test('원격 회귀: 미허용 클라이언트의 실행·기록·파일·이벤트·수정 지시 180개 요청 차단', async (t) => {
  const identities = [
    { headers: { host }, code: 'remote_user', status: 403 },
    { headers: { host, 'tailscale-user-login': 'other@example.com' }, code: 'remote_user', status: 403 },
    { headers: { host, 'tailscale-user-login': 'owner@example.com,other@example.com' }, code: 'remote_user', status: 403 },
    { headers: { ...headers, host: 'evil.example' }, code: 'remote_host', status: 421 },
    { headers: { 'x-forwarded-host': host }, code: 'remote_user', status: 403 },
    { headers: { 'x-forwarded-host': 'evil.example', 'tailscale-user-login': 'owner@example.com' }, code: 'remote_host', status: 421 },
  ];
  const reads = ['/', '/app.js', '/api/options', '/api/status', '/api/remote', '/api/jobs', '/api/jobs/fixture-job', '/api/jobs/fixture-job/log/t1', '/api/jobs/fixture-job/intercepts', '/api/sessions', '/api/sessions/fixture-session/jobs', '/api/events', '/api/memory', '/api/board', '/api/dir', `/uploads/${imageId}`];
  const writes = [
    ['POST', '/api/jobs'], ['DELETE', '/api/jobs/fixture-job'], ['POST', '/api/jobs/fixture-job/cancel'], ['POST', '/api/jobs/fixture-job/tasks/t1/retry'],
    ['POST', '/api/jobs/fixture-job/intercepts'],
    ['POST', '/api/sessions'], ['PATCH', '/api/sessions/fixture-session'], ['DELETE', '/api/sessions/fixture-session'],
    ['POST', '/api/sessions/fixture-session/goal/resume'], ['POST', '/api/sessions/fixture-session/goal/stop'], ['POST', '/api/uploads'],
    ['POST', '/api/remote/enable'], ['POST', '/api/remote/disable'], ['OPTIONS', '/api/jobs'],
  ];
  const files = ['jobs.json', 'sessions.json', 'remote.json'];
  await delay(200); // 서버 초기 저장이 끝난 뒤 비교한다.
  const beforeFiles = files.map((f) => fs.readFileSync(path.join(dir, f)));
  const uploadsBefore = fs.readdirSync(path.join(dir, 'uploads')).sort();
  let count = 0;
  for (const identity of identities) for (const [method, route] of [...reads.map((r) => ['GET', r]), ...writes]) {
    // 게이트가 잘못 열려도 실제 모델 호출을 시작하지 않는 잘못된 JSON을 쓴다.
    const res = await request(route, { method, headers: identity.headers, body: ['POST', 'PATCH'].includes(method) ? '{' : undefined });
    assert.equal(res.status, identity.status, `${method} ${route}`);
    if (route.startsWith('/api/') || route.startsWith('/uploads/')) assert.equal(json(res).code, identity.code);
    else { assert(res.body.toString().includes(identity.code)); assert(!res.body.toString().includes(marker)); }
    count++;
  }
  files.forEach((f, i) => assert.deepEqual(fs.readFileSync(path.join(dir, f)), beforeFiles[i], f));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'uploads')).sort(), uploadsBefore);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runs')), ['fixture-job']);
  assert.equal(count, 180); t.diagnostic(`${count}개 거절 응답 및 저장 기록 불변 확인`);
});

test('원격 회귀: 허용 사용자도 출처·관리 제한과 잘못된 첨부·본문을 통과하지 못함', async () => {
  for (const origin of ['null', `http://${host}`, 'https://evil.example', `https://${host}:444`]) {
    const res = await request('/api/sessions', { method: 'POST', headers: { ...headers, origin }, body: '{}' });
    assert.equal(res.status, 403); assert.equal(json(res).code, 'bad_origin');
    const intercept = await request('/api/jobs/fixture-job/intercepts', { method: 'POST', headers: { ...headers, origin }, body: '{}' });
    assert.equal(intercept.status, 403); assert.equal(json(intercept).code, 'bad_origin');
  }
  assert.equal((await request('/api/jobs/fixture-job/intercepts', { headers })).status, 200);
  const late = await request('/api/jobs/fixture-job/intercepts', { method: 'POST', headers: { ...headers, origin: `https://${host}` }, body: JSON.stringify({ sessionId: 'fixture-session', clientRequestId: 'remote-intercept-test', text: '완료 후 지시' }) });
  assert.equal(late.status, 409); assert.equal(json(late).code, 'JOB_NOT_ACTIVE');
  for (const route of ['/api/remote/enable', '/api/remote/disable', '/api/remote/../remote/enable']) {
    const res = await request(route, { method: 'POST', headers, body: '{}' });
    assert.equal(res.status, 403); assert.equal(json(res).code, 'remote_local_only');
  }
  assert.equal((await request('/api/uploads', { method: 'POST', headers, body: '이미지가 아닙니다' })).status, 415);
  assert.equal((await request('/api/sessions', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal(json(await request('/api/sessions', { headers })).length, 1);
  assert.equal((await request('/api/sessions', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await request('/')).status, 200);
});

test('원격 회귀: 계정 취소·설정 손상은 스트림 종료, 로컬 유지·복구 후 재연결', async () => {
  const remote = events(headers), local = events(); let reconnected;
  try {
    await until(() => remote.content.includes('"type":"hello"') && local.content.includes('"type":"hello"'), '초기 이벤트가 없습니다');
    saveConfig({ logins: ['second@example.com'] });
    assert.equal(json(await request('/api/jobs', { headers })).code, 'remote_user');
    await until(() => remote.ended, '계정 취소 후 원격 SSE가 닫히지 않았습니다');
    assert.equal(local.ended, false);
    const session = await request('/api/sessions', { method: 'POST', headers: { origin: base }, body: JSON.stringify({ cwd: dir, title: '로컬 유지 확인' }) });
    assert.equal(session.status, 201);
    const sessionId = json(session).id;
    await until(() => local.content.includes(sessionId), '로컬 SSE가 유지되지 않았습니다');
    fs.writeFileSync(path.join(dir, 'remote.json'), '{');
    assert.equal(json(await request('/api/jobs', { headers })).code, 'remote_off');
    assert.equal((await request('/api/jobs')).status, 200);
    saveConfig();
    reconnected = events(headers);
    await until(() => reconnected.content.includes(sessionId) && reconnected.content.includes(marker), '재연결 후 최신 목록을 받지 못했습니다');
    assert.equal(reconnected.status, 200);
    assert.deepEqual((await request(`/uploads/${imageId}`, { headers })).body, png);
    assert.equal(json(await request('/api/jobs', { headers })).length, 1);
  } finally { remote.close(); local.close(); reconnected?.close(); saveConfig(); }
});
