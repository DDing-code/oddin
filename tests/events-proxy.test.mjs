// 다른 PC 세션을 열면 0.1초 만에 새 세션으로 돌아가던 문제(2026-10-07): 화면 실시간 연결(/api/events?session=rm-…)은
// 이 PC 것인데 rm- id 가 붙어 있다고 그 PC로 넘겨져, 그 PC의 세션 목록(다른 id)이 와서 화면이 지금 세션을 잃었다.
// /api/events 는 넘기지 않고, 다른 /api 요청(그 세션 작업 목록 등)은 그대로 그 PC로 넘기는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './_port.mjs';

test('실시간 연결은 다른 PC 세션을 보고 있어도 이 PC 것, 그 세션의 다른 요청은 그 PC로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-evproxy-'));
  const seen = [];
  // 가짜 "회사" 허브: 받은 요청만 적고 빈 목록으로 답한다
  const peer = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/api/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ type: 'hello', sessions: [{ id: 's-company', title: '회사 세션', jobIds: [], updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() }], jobs: [] })}\n\n`); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.url.startsWith('/api/peers/whoami') ? JSON.stringify({ id: 'company-hub', name: '회사' }) : '[]');
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const port = await freePort(), data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(data, 'peers.json'), JSON.stringify({ self: { id: 'home-hub', name: '집' }, peers: [{ id: 'cmp1', name: '회사', url: `http://127.0.0.1:${peer.address().port}`, remoteId: 'company-hub' }] }));
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...cfg, port }));
  const env = { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: data, HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: path.join(dir, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/hub/version'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    // 이 PC가 회사 허브 이벤트를 받아 rm- 세션을 갖출 때까지
    for (let i = 0; i < 100; i++) { const s = await (await fetch(base + '/api/sessions?all=1')).json(); if (s.some((x) => x.id === 'rm-cmp1-s-company')) break; await new Promise((r) => setTimeout(r, 100)); }
    const before = seen.filter((u) => u.startsWith('/api/events')).length;
    const ac = new AbortController();
    const res = await fetch(base + '/api/events?compact=1&session=rm-cmp1-s-company', { signal: ac.signal });
    const reader = res.body.getReader(); let text = '';
    while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
    ac.abort();
    const hello = JSON.parse(text.split('\n\n')[0].replace(/^data: /, ''));
    assert.equal(hello.type, 'hello');
    assert.ok(hello.sessions.some((s) => s.id === 'rm-cmp1-s-company'), '이 PC의 목록(다른 PC 세션은 rm- id)이 와야 지금 세션을 잃지 않는다');
    assert.equal(seen.filter((u) => u.startsWith('/api/events')).length, before, '화면 실시간 연결은 회사로 넘기지 않음');
    await (await fetch(base + '/api/sessions/rm-cmp1-s-company/jobs')).text();
    assert.ok(seen.includes('/api/sessions/s-company/jobs'), '그 세션의 다른 요청은 그대로 회사로');
  } finally { child.kill(); peer.close(); peer.closeAllConnections?.(); await new Promise((r) => setTimeout(r, 200)); fs.rmSync(dir, { recursive: true, force: true }); }
});
