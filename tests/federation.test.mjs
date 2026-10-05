// 실행 PC 고르기·다른 PC 작업 함께 보기: id 바꾸기, 실시간 이벤트 비추기, 요청 넘기기, 다른 PC에 작업 만들기(폴더·첨부)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Federation, mapIds, toLocal, toRemote } from '../lib/federation.mjs';

const peer0 = { id: 'pc1', name: '회사', remoteId: 'office' };

test('id 바꾸기: 세션·작업·요청 id 와 연결 id 만, 작업 안 task id 는 그대로', () => {
  const job = { id: 'j1', sessionId: 's1', tasks: [{ id: 't1', title: '일' }], status: 'done' };
  const l = toLocal(peer0, job);
  assert.equal(l.id, 'rm-pc1-j1'); assert.equal(l.sessionId, 'rm-pc1-s1'); assert.equal(l.tasks[0].id, 't1'); assert.deepEqual(l.machine, { id: 'pc1', name: '회사' });
  const s = toLocal(peer0, { id: 's1', jobIds: ['j1', 'j2'], title: '세션' });
  assert.deepEqual(s.jobIds, ['rm-pc1-j1', 'rm-pc1-j2']); assert.equal(s.id, 'rm-pc1-s1');
  assert.equal(toLocal(peer0, { type: 'prompt', prompt: { id: 'p1', jobId: 'j1' } }).prompt.id, 'rm-pc1-p1');
  assert.deepEqual(toRemote(peer0, { sessionId: 'rm-pc1-s1', note: '그대로 rm-pc1-j1' }), { sessionId: 's1', note: '그대로 j1' });
  assert.equal(mapIds({ id: 'x', title: 't' }, (v) => 'y' + v).id, 'x', '세션·작업이 아닌 객체의 id 는 그대로');
});

function fakePeer() {
  const seen = { jobs: [], uploads: 0, sessions: [{ id: 's1', jobIds: ['j1'], title: '회사 세션', cwd: 'C:/x' }] };
  let sse = null;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); sse = res;
      res.write(`data: ${JSON.stringify({ type: 'hello', sessions: [...seen.sessions, { id: 'rm-zz-s9', jobIds: [], machine: { id: 'zz', name: '집' } }], jobs: [{ id: 'j1', sessionId: 's1', tasks: [{ id: 't1' }], status: 'running' }] })}\n\n`);
      return;
    }
    if (u.pathname === '/api/sessions') return json(seen.sessions);
    if (u.pathname === '/api/sessions/s1/jobs') return json([{ id: 'j1', sessionId: 's1', tasks: [] }]);
    if (u.pathname === '/api/jobs' && req.method === 'POST') { const b = JSON.parse(body); seen.jobs.push(b); seen.sessions.push({ id: 's2', jobIds: ['j2'], title: '새 세션', cwd: b.cwd || 'C:/oddin-workspace' }); return json({ id: 'j2', sessionId: 's2', tasks: [], status: 'queued' }, 201); }
    if (u.pathname === '/api/jobs/j1/cancel' && req.method === 'POST') return json({ id: 'j1', sessionId: 's1', status: 'cancelled', tasks: [] });
    if (u.pathname === '/api/uploads') { seen.uploads++; return json({ id: 'u-remote' }, 201); }
    if (u.pathname === '/api/drive-hub') return json({ hub: { root: 'G:\\내 드라이브\\ODDIN' } });
    json({ error: '없는 API' }, 404);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, url: `http://127.0.0.1:${server.address().port}`, push: (ev) => sse?.write(`data: ${JSON.stringify(ev)}\n\n`) })));
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
function fakeRes() { const r = { status: 0, headers: {}, body: '' }; return { r, writeHead(s, h) { r.status = s; r.headers = h; }, end(b) { r.body = String(b ?? ''); } }; }

test('다른 PC 세션 비추기·요청 넘기기·작업 만들기', async () => {
  const fp = await fakePeer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fed-'));
  const events = [];
  const peer = { ...peer0, url: fp.url };
  const peers = { list: () => [peer], get: (id) => (id === peer.id ? peer : null), self: () => ({ id: 'home', name: '집' }),
    call: async (p, route, { method = 'GET', body } = {}) => { const r = await fetch(p.url + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j; } };
  const upload = path.join(dir, 'a.png'); fs.writeFileSync(upload, 'PNG');
  const driveHere = path.join(dir, 'drive', 'A');
  const drive = { folderOf: (cwd) => (cwd.startsWith(driveHere) ? { id: 'f1', name: '보관함', here: driveHere } : null), read: () => ({ folders: [{ id: 'f1', paths: { office: 'C:\\Users\\USER\\A' } }] }) };
  const fed = new Federation({ peers, broadcast: (ev) => events.push(ev), drive, uploadPath: (id) => (id === 'u1' ? upload : null), isDefaultDir: (p) => p === 'DEFAULT' });
  try {
    assert.ok(await until(() => fed.sessions().length === 1), '그 PC 자신의 세션만(다시 비춘 것은 뺌)');
    const s = fed.sessions()[0];
    assert.equal(s.id, 'rm-pc1-s1'); assert.equal(s.machine.name, '회사'); assert.equal(s.machine.online, true);
    assert.equal(fed.jobs()[0].id, 'rm-pc1-j1');
    assert.ok(events.some((e) => e.type === 'remote_sync' && e.sessions.length === 1));
    // 실시간 작업 이벤트는 id 를 바꿔 이 화면에
    fp.push({ type: 'job', job: { id: 'j1', sessionId: 's1', tasks: [{ id: 't1' }], status: 'done' } });
    fp.push({ type: 'job', job: { id: 'rm-zz-j5', sessionId: 'rm-zz-s9', tasks: [] } }); // 그 PC가 비춘 다른 PC 것 — 다시 비추지 않음
    fp.push({ type: 'usage', usage: {} }); // 그 PC 사정(사용량)은 넘기지 않음
    assert.ok(await until(() => events.some((e) => e.type === 'job' && e.job.status === 'done')));
    const jobEv = events.find((e) => e.type === 'job' && e.job.status === 'done');
    assert.equal(jobEv.job.id, 'rm-pc1-j1'); assert.equal(jobEv.machine.name, '회사');
    assert.ok(!events.some((e) => e.type === 'job' && String(e.job.id).includes('rm-zz')));
    assert.ok(!events.some((e) => e.type === 'usage'));
    // 그 세션 요청 넘기기: 경로의 rm- id 를 떼고 보내고, 답의 id 를 다시 붙임
    const res1 = fakeRes(); await fed.proxy({ method: 'GET', headers: {} }, res1, { pathname: '/api/sessions/rm-pc1-s1/jobs', search: '', raw: null });
    assert.equal(res1.r.status, 200); assert.equal(JSON.parse(res1.r.body)[0].id, 'rm-pc1-j1');
    const res2 = fakeRes(); await fed.proxy({ method: 'POST', headers: { 'content-type': 'application/json' } }, res2, { pathname: '/api/jobs/rm-pc1-j1/cancel', search: '', raw: Buffer.from('{}') });
    assert.equal(JSON.parse(res2.r.body).status, 'cancelled');
    // 다른 PC에 작업 만들기: 드라이브 작업 폴더는 그 PC 경로로, 첨부는 그 PC로 올림
    const job = await fed.createJob({ goal: '편집해 줘', machine: 'pc1', cwd: path.join(driveHere, '편집'), attachments: [{ id: 'u1', name: 'a.png' }] });
    assert.equal(job.id, 'rm-pc1-j2'); assert.equal(job.sessionId, 'rm-pc1-s2'); assert.equal(job.note, null);
    const sent = fp.seen.jobs[0];
    assert.equal(sent.cwd, 'C:\\Users\\USER\\A\\편집'); assert.equal(sent.machine, undefined); assert.deepEqual(sent.attachments, [{ id: 'u-remote', name: 'a.png' }]);
    assert.ok(fed.sessions().some((x) => x.id === 'rm-pc1-s2'), '새 세션을 바로 받아 둠');
    // 그 PC에 없는 폴더 → 그 PC 기본 작업 폴더 + 안내, 기본 폴더 → 그대로 기본
    const j2 = await fed.createJob({ goal: 'x', machine: 'pc1', cwd: path.join(dir, '집에만') });
    assert.match(j2.note, /기본 작업 폴더/); assert.equal(fp.seen.jobs[1].cwd, undefined);
    await fed.createJob({ goal: 'y', machine: 'pc1', cwd: 'DEFAULT' }); assert.equal(fp.seen.jobs[2].cwd, undefined);
    // 다른 PC 세션에 이어서: sessionId 의 표시를 뗌
    await fed.createJob({ goal: '이어서', sessionId: 'rm-pc1-s1' }); assert.equal(fp.seen.jobs[3].sessionId, 's1');
    await assert.rejects(fed.createJob({ goal: 'z', machine: 'nope' }), /찾지 못했어요/);
  } finally { fed.close(); fp.server.closeAllConnections?.(); fp.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
