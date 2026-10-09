// 나눠 보기 실시간 연결 하나로(2026-10-10 "화면분할 찐빠"): 칸마다 /api/events 를 따로 열면 브라우저의 같은 주소 동시 연결 6개 한도를 채워
// 화면이 멈췄다 → 가운데 창 연결 하나가 가운데+칸 세션을 함께 받고(session=a,b), 칸을 열고 닫을 때는 /api/events/sessions 로 거르기만 바꾼다.
// 칸은 처음 상태만 /api/events/snapshot 으로 받는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './_port.mjs';
import { clientEvent, sessionList } from '../lib/events.mjs';

test('세션 거르기 값: 하나·여럿·배열, 정렬·중복 제거·잘못된 값 빼기·8개까지', () => {
  assert.deepEqual(sessionList('s-b'), ['s-b']);
  assert.deepEqual(sessionList('s-b,s-a,s-b, ,../x'), ['s-a', 's-b']);
  assert.deepEqual(sessionList(['rm-p1-s-c', 's-a']), ['rm-p1-s-c', 's-a']);
  assert.deepEqual(sessionList(null), []);
  assert.equal(sessionList(Array.from({ length: 12 }, (_, i) => `s-${i}`)).length, 8);
});

test('여러 세션 거르기: 고른 세션들은 자세히, 나머지는 요약, 기록(log)은 고른 세션 것만', () => {
  const job = (id, sessionId) => ({ id, sessionId, title: id, status: 'running', tasks: [{ id: 't1', title: 'x', assignee: 'claude', status: 'running', prompt: '긴 지시', text: '결과' }] });
  const hello = { type: 'hello', sessions: [], jobs: [job('j1', 's-a'), job('j2', 's-b'), job('j3', 's-c')] };
  const out = clientEvent(hello, 's-a,s-b');
  assert.equal(out.jobs.find((j) => j.id === 'j1').summaryOnly, undefined);
  assert.equal(out.jobs.find((j) => j.id === 'j2').summaryOnly, undefined);
  assert.equal(out.jobs.find((j) => j.id === 'j3').summaryOnly, true);
  const sessionOf = (id) => ({ j1: 's-a', j2: 's-b', j3: 's-c' })[id];
  assert.ok(clientEvent({ type: 'log', jobId: 'j2', entry: {} }, 's-a,s-b', sessionOf));
  assert.equal(clientEvent({ type: 'log', jobId: 'j3', entry: {} }, 's-a,s-b', sessionOf), null);
  assert.equal(clientEvent({ type: 'log', jobId: 'j1', entry: {} }, 's-a', sessionOf).jobId, 'j1', '예전처럼 세션 하나도 된다');
});

test('서버: 연결 번호(stream)로 거르기 바꾸기, 모르는 번호는 404, 처음 상태 받기(snapshot)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-splitev-'));
  const port = await freePort(), data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(dir, 'runs'));
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...cfg, port }));
  const env = { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: data, HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: path.join(dir, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const ac = new AbortController();
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/hub/version'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const a = await (await post('/api/sessions', { title: '가' })).json(), b = await (await post('/api/sessions', { title: '나' })).json();
    const res = await fetch(`${base}/api/events?compact=1&session=${a.id},${b.id}`, { signal: ac.signal });
    const reader = res.body.getReader(); let text = '';
    while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    const hello = JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
    assert.equal(hello.type, 'hello'); assert.match(hello.stream, /^[0-9a-f]{32}$/);
    const ok = await post('/api/events/sessions', { stream: hello.stream, sessions: `${b.id},${a.id},${a.id}` });
    assert.equal(ok.status, 200); assert.deepEqual((await ok.json()).sessions, [a.id, b.id].sort());
    assert.equal((await post('/api/events/sessions', { stream: 'f'.repeat(32), sessions: a.id })).status, 404);
    assert.equal((await post('/api/events/sessions', { sessions: a.id })).status, 404, '번호 없이는 못 바꾼다');
    const snap = await (await fetch(`${base}/api/events/snapshot?compact=1&session=${a.id}`)).json();
    assert.equal(snap.type, 'hello'); assert.equal(snap.stream, undefined, '처음 상태에는 연결 번호가 없다');
    assert.ok(snap.sessions.some((s) => s.id === a.id) && snap.sessions.some((s) => s.id === b.id));
  } finally {
    ac.abort(); child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
});
