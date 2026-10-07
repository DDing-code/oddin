// 다른 PC 제어 막기·작업 넘기기 (lib/hub-auth.mjs · planner.machinesRule · server /api/handoff)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubAuth, isControl, controlGate, canonicalRoute } from '../lib/hub-auth.mjs';
import { machinesRule } from '../lib/planner.mjs';
import { freePort } from './_port.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const req = (headers = {}, method = 'GET') => ({ headers, method });

test('제어 기능 판정: 터미널·어도비(상태 빼고)·파일 열기·열기 범위 바꾸기·업데이트·재시작', () => {
  for (const [p, m] of [['/api/terminals', 'POST'], ['/api/terminals/abc/input', 'POST'], ['/api/terminals', 'GET'], ['/api/adobe/check', 'GET'], ['/api/adobe/run', 'POST'], ['/api/adobe/next', 'GET'], ['/api/open', 'POST'], ['/api/file-access', 'POST'], ['/api/hub/restart', 'POST'], ['/api/hub/update', 'POST'], ['/api/peers/123/update', 'POST']]) assert.equal(isControl(p, m), true, `${m} ${p}`);
  for (const [p, m] of [['/api/adobe/status', 'GET'], ['/api/file-access', 'GET'], ['/api/jobs', 'POST'], ['/api/file', 'GET'], ['/api/download', 'GET'], ['/api/hub/version', 'GET'], ['/api/sessions', 'GET']]) assert.equal(isControl(p, m), false, `${m} ${p}`);
});

test('화면 쿠키: 화면을 열 때(문서 탐색)만 주고, 원격(https)이면 Secure · 가진 요청만 화면으로 인정', () => {
  const a = new HubAuth({ file: path.join(dir, 'a.json'), selfId: () => 'A' });
  assert.equal(a.cookieFor(req({})), null, '스크립트 요청에는 안 줌');
  assert.equal(a.cookieFor(req({ 'sec-fetch-dest': 'iframe' })), null);
  const c = a.cookieFor(req({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }), { secure: true });
  assert.match(c, /^oddin_ui=v1\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  const token = c.split(';')[0].split('=').slice(1).join('=');
  assert.ok(a.hasUi(req({ cookie: `x=1; oddin_ui=${token}` })));
  assert.ok(!a.hasUi(req({ cookie: 'oddin_ui=v1.가짜' })));
  assert.ok(!a.hasUi(req({})));
  assert.equal(new HubAuth({ file: path.join(dir, 'a.json') }).uiToken(), a.uiToken(), '재시작해도 같은 쿠키');
});

test('연결된 허브끼리 서명: 맡긴 키로만, 같은 주소·5분 안, 처음 받은 키만 믿음', () => {
  const A = new HubAuth({ file: path.join(dir, 'sa.json'), selfId: () => 'hub-A' });
  const B = new HubAuth({ file: path.join(dir, 'sb.json'), selfId: () => 'hub-B' });
  assert.deepEqual(A.sign('peer-B', 'POST', '/api/terminals'), {}, '키를 맡기기 전에는 서명 없음');
  const key = A.keyFor('peer-B');
  assert.deepEqual(B.accept('hub-A', key), { ok: true });
  assert.deepEqual(B.accept('hub-A', key), { ok: true }, '같은 키는 다시 받아도 됨');
  assert.throws(() => B.accept('hub-A', 'f'.repeat(64)), (e) => e.status === 409, '다른 키로 바꿔치기 안 됨');
  assert.throws(() => B.accept('hub-A', 'zz'), (e) => e.status === 400);
  A.markRegistered('peer-B');
  const route = canonicalRoute('/api/terminals?sessionId=s-1&path=E:/작업 폴더');
  const h = A.sign('peer-B', 'POST', route);
  assert.equal(h['X-Oddin-From'], 'hub-A');
  const r = (headers, method = 'POST') => ({ method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
  assert.ok(B.verify(r(h), route, ['hub-A']));
  assert.ok(!B.verify(r(h), '/api/terminals?sessionId=s-2', ['hub-A']), '다른 주소');
  assert.ok(!B.verify(r(h, 'GET'), route, ['hub-A']), '다른 방식');
  assert.ok(!B.verify(r(h), route, ['someone']), '연결된 PC 가 아님');
  const old = { 'X-Oddin-From': 'hub-A', 'X-Oddin-Sig': `${Date.now() - 10 * 60_000}.${h['X-Oddin-Sig'].split('.')[1]}` };
  assert.ok(!B.verify(r(old), route, ['hub-A']), '오래된 서명');
  B.forget('peer-A', 'hub-A');
  assert.ok(!B.verify(r(A.sign('peer-B', 'POST', route)), route, ['hub-A']), '연결을 지우면 키도 지움');
  // 보내는 쪽 fetch 가 고친 주소와 받는 쪽이 읽은 주소가 같다
  const u = new URL('https://x.ts.net/api/download?path=E:/작업 폴더/a b.png');
  assert.equal(canonicalRoute('/api/download?path=E:/작업 폴더/a b.png'), u.pathname + u.search);
});

test('문지기: 원격 제어는 화면 쿠키나 허브 서명만, 다른 PC로 넘기는 제어는 화면만, 로컬·일반 기능은 그대로', () => {
  const auth = new HubAuth({ file: path.join(dir, 'g.json'), selfId: () => 'me' });
  const cookie = `oddin_ui=${auth.uiToken()}`;
  const g = (o) => controlGate(o.req || req(), { pathname: o.p, route: o.p, method: o.m || 'POST', remote: !!o.remote, proxied: !!o.proxied, auth, knownIds: [] });
  assert.equal(g({ p: '/api/terminals' }), null, '로컬 AI·로컬 화면은 그대로');
  assert.equal(g({ p: '/api/jobs', remote: true }), null, '작업 만들기 같은 일반 기능은 원격도 그대로');
  assert.equal(g({ p: '/api/terminals', remote: true }).status, 403, '원격 스크립트(다른 PC의 AI)는 막음');
  assert.match(g({ p: '/api/adobe/check', m: 'GET', remote: true }).error, /작업 넘기기/);
  assert.equal(g({ p: '/api/terminals', remote: true, req: req({ cookie }) }), null, '원격 화면(폰·다른 PC 화면)은 됨');
  assert.equal(g({ p: '/api/terminals', proxied: true }).status, 403, '이 PC의 AI 가 rm- 대리로 다른 PC 터미널을 여는 것도 막음');
  assert.equal(g({ p: '/api/terminals', proxied: true, req: req({ cookie }) }), null, '화면에서 다른 PC 세션 터미널은 됨');
});

test('작업자 지시문 [여러 PC]: 연결된 PC가 있으면 직접 조작 금지와 넘기기 명령, 없으면 없음', () => {
  const t = machinesRule({ self: '회사', peers: ['집'], handoff: 'C:\\oddin\\scripts\\handoff.mjs' }, { id: '20261007-1' });
  assert.match(t, /"회사" PC에서 실행 중/);
  assert.match(t, /원격 데스크톱·SSH/);
  assert.ok(t.includes('node "C:\\oddin\\scripts\\handoff.mjs" --pc <PC 이름> --job 20261007-1'));
  assert.equal(machinesRule(null, { id: 'x' }), '');
  assert.equal(machinesRule({ self: '집', peers: [] }, { id: 'x' }), '');
});

test('서버: 화면을 열면 쿠키를 주고, 작업 넘기기는 연결된 PC가 없으면 알려 준다', async () => {
  const port = await freePort(), base = path.join(dir, 'srv');
  for (const d of ['data', 'runs']) fs.mkdirSync(path.join(base, d), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ ...cfg, port }));
  const env = { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(base, 'data'), HUB_RUNS_DIR: path.join(base, 'runs'), HUB_CONFIG_FILE: path.join(base, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' };
  const child = spawn(process.execPath, [fileFromHere('../server.mjs')], { env, stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) { try { await fetch(url + '/api/hub/version'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const page = await fetch(url + '/', { headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' } });
    assert.match(page.headers.get('set-cookie') || '', /^oddin_ui=v1\./);
    await page.text();
    const api = await fetch(url + '/');
    assert.equal(api.headers.get('set-cookie'), null, '스크립트로 읽으면 쿠키 없음');
    await api.text();
    const h = await fetch(url + '/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pc: '집', goal: '시험' }) });
    assert.equal(h.status, 404);
    assert.match((await h.json()).error, /연결된 PC: 없음/);
  } finally { child.kill(); }
});
function fileFromHere(rel) { return fileURLToPath(new URL(rel, import.meta.url)); }
