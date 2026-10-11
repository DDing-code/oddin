// 전체 점검(2026-10-12)에서 나온 것들: 큰 응답 줄 읽기, "지금 바꾸기" 두 번, 멈춘 채 끝없이 돌기, 끝 상태 판정,
// 끊긴 기억 정리 다시 하기, 목표 판정 표시, 다른 PC 비추기 요약·보는 세션만 자세히
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audit-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} });

const { JobManager, endStatus } = await import('../lib/jobs.mjs');
const { DATA_DIR, lineSplitter } = await import('../lib/util.mjs');
const { bigResponse } = await import('../lib/native-workers.mjs');
const { Federation } = await import('../lib/federation.mjs');
const { isIdle } = await import('../scripts/restart-hub.mjs');
const cwd = fs.mkdtempSync(path.join(temp, 'work-'));
const config = { defaultCwd: cwd, hubDir: path.join(temp, 'shared'), tools: {}, defaults: {}, memory: { curate: false } };
const now = new Date().toISOString();
const job = (id, status, tasks, extra = {}) => ({ id, sessionId: 's1', title: id, goal: '일', cwd, mode: 'both', status, createdAt: now, tasks, notes: [], intercepts: [], attachments: [], runDir: path.join(temp, 'runs', id), settings: {}, ...extra });
const task = (id, status, extra = {}) => ({ id, title: id, assignee: 'codex', status, prompt: 'x', dependsOn: [], ...extra });
const saved = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf8'));

test('줄 읽기: 조각이 어떻게 잘려 와도 같은 줄, 큰 줄도 한 번에 이어 붙임', () => {
  const lines = ['{"a":1}', '', '한글 줄', 'x'.repeat(200_000), '끝'];
  const text = lines.join('\n') + '\n남은 조각';
  for (const size of [1, 7, 4096, 1_000_000]) {
    const got = []; const feed = lineSplitter((l) => got.push(l));
    for (let i = 0; i < text.length; i += size) feed(text.slice(i, i + size));
    assert.deepEqual(got, lines, `조각 ${size}`);
    assert.equal(feed.rest(), '남은 조각'); assert.equal(feed.rest(), '', '꺼내면 비움');
  }
  // 100MB 한 줄이 64KB 조각으로 와도 금방 끝난다(예전 방식은 크기의 제곱 — 50초)
  const big = `{"id":2,"result":{"thread":{"id":"th-1","turns":["${'A'.repeat(60 * 1024 * 1024)}"]}}}\n`;
  const t0 = performance.now(); let seen = null; const feed = lineSplitter((l) => { seen = bigResponse(l); });
  for (let i = 0; i < big.length; i += 65536) feed(big.slice(i, i + 65536));
  assert.deepEqual({ id: seen.id, thread: seen.result.thread.id }, { id: 2, thread: 'th-1' }, '통째로 해석하지 않고 스레드 id 만 꺼냄');
  assert.ok(seen._big > 60 * 1024 * 1024); assert.ok(performance.now() - t0 < 3000, `걸린 시간 ${Math.round(performance.now() - t0)}ms`);
  assert.equal(bigResponse('{"method":"item/completed","params":{}}'), null, '모양이 다르면 평소대로 해석');
});

test('끝 상태: 모두 끝나야 완료 — 취소·건너뜀·중단으로 남은 것이 있으면 일부 완료, 하나도 못 끝냈으면 실패', () => {
  const s = (...st) => endStatus(st.map((x, i) => task(`t${i}`, x)));
  assert.equal(s('done', 'done'), 'done');
  assert.equal(s('done', 'failed'), 'partial'); assert.equal(s('failed', 'failed'), 'failed');
  assert.equal(s('done', 'cancelled', 'skipped'), 'partial', '예전에는 완료로 끝났다');
  assert.equal(s('cancelled', 'skipped'), 'failed'); assert.equal(s('done', 'interrupted'), 'partial');
  assert.equal(endStatus([task('t1', 'done')], true), 'partial', '보고·수정 지시 전달 실패');
  assert.equal(endStatus([]), 'failed');
});

test('"지금 바꾸기"가 두 번 불려도 처음 저장한 상태를 덮지 않고, 멈춘 동안 일정 짜기가 끝없이 돌지 않는다', async () => {
  const m = new JobManager(config);
  m.sessions.set('s1', { id: 's1', title: 's', cwd, jobIds: ['j1'], createdAt: now, updatedAt: now });
  const j = job('j1', 'running', [task('t1', 'running', { sessionId: 'S-1' }), task('t2', 'pending'), task('t3', 'pending')]);
  m.jobs.set('j1', j);
  m.running.set('j1/t1', { handle: { cancel: () => {} } });
  const first = m.prepareRestart();
  // 작업자가 꺼지면서 메모리 안 상태가 바뀐다
  j.tasks[0].status = 'cancelled'; j.tasks[1].status = 'skipped'; j.status = 'cancelled';
  const second = m.prepareRestart();
  assert.deepEqual(second, first, '같은 목록을 돌려줌');
  const d = saved().find((x) => x.id === 'j1');
  assert.equal(d.status, 'running'); assert.deepEqual(d.tasks.map((t) => t.status), ['running', 'pending', 'pending'], '두 번째 호출이 덮지 않음');
  assert.equal(d.resumeOnStart, true);
  // 멈춘 상태에서 바로 시작할 수 있는 대기 작업이 있어도 일정 짜기는 곧 끝난다(예전에는 이벤트 루프를 놓지 않고 계속 돌았다)
  j.status = 'running'; j.tasks[1].status = 'pending';
  let calls = 0; const run = m.runTask.bind(m); m.runTask = async (...a) => { calls++; return run(...a); };
  await Promise.race([m.schedule(j), delay(1500).then(() => { throw new Error('일정 짜기가 끝나지 않음'); })]);
  assert.equal(calls, 0, '멈춘 동안에는 작업자를 띄우려 하지 않음');
  // 재시작이 끝내 안 일어나면 멈춤을 풀고, 멈췄던 작업은 "중단됨"으로 남긴다
  const left = m.unfreeze();
  assert.equal(left.length, 1); assert.equal(m.frozen, false);
  assert.equal(j.status, 'interrupted'); assert.ok(j.tasks.every((t) => t.status === 'interrupted')); assert.equal(j.resumeOnStart, undefined);
  assert.doesNotThrow(() => m.save({ immediate: true }), '다시 저장할 수 있음');
  assert.equal(saved().find((x) => x.id === 'j1').status, 'interrupted');
  clearTimeout(m._saveTimer);
});

test('새로 켤 때: 재시작으로 취소·건너뜀으로 남은 하위 작업도 이어 하고, 끊긴 기억 정리를 다시 하고, 목표 판정 표시를 지운다', () => {
  fs.writeFileSync(path.join(DATA_DIR, 'jobs.json'), JSON.stringify([
    job('r1', 'running', [task('t1', 'done'), task('t2', 'cancelled', { sessionId: 'S-2' }), task('t3', 'skipped')], { resumeOnStart: true }),
    job('c1', 'done', [task('t1', 'done')], { curation: { status: 'running', startedAt: now } }),
    job('c2', 'done', [task('t1', 'done')], { curation: { status: 'done' } }),
  ]));
  fs.writeFileSync(path.join(DATA_DIR, 'sessions.json'), JSON.stringify([{ id: 's1', title: 's', cwd, jobIds: ['r1', 'c1', 'c2'], createdAt: now, updatedAt: now, goal: { id: 'g1', status: 'active', checking: true, pauseRequested: true } }]));
  const m = new JobManager(config);
  const g = m.sessions.get('s1').goal;
  assert.equal(g.checking, false); assert.equal(g.pauseRequested, undefined);
  assert.equal(m.jobs.get('c1').curation.retry, true); assert.equal(m.jobs.get('c2').curation.retry, undefined);
  // 기억 정리 다시 하기: 표시가 있는 것만
  const again = []; m.curate = (jb) => { again.push(jb.id); return Promise.resolve(); };
  assert.deepEqual(m.resumeCurations(), ['c1']); assert.deepEqual(again, ['c1']);
  assert.deepEqual(m.resumeCurations(), [], '한 번만');
  // 이어 하기: 끝난 것(done)만 두고 나머지는 다시 대기로
  const r1 = m.jobs.get('r1'); let scheduled = false;
  m.runScheduled = async () => { scheduled = true; }; m.finish = () => {}; m.checkpoints.end = async () => {};
  m.resumeTasks(r1);
  assert.deepEqual(r1.tasks.map((t) => t.status), ['done', 'pending', 'pending']);
  assert.equal(r1.tasks[1].resumeSessionId, 'S-2', '같은 CLI 대화로');
  clearTimeout(m._saveTimer); void scheduled;
});

test('재시작 도구의 쉬는 중 판정: 기억 정리가 도는 중이면 쉬는 것이 아니다', () => {
  const done = { status: 'done', tasks: [{ status: 'done' }] };
  assert.equal(isIdle([done], []), true);
  assert.equal(isIdle([{ ...done, curation: { status: 'running' } }], []), false);
  assert.equal(isIdle([{ ...done, curation: { status: 'done' } }], []), true);
  assert.equal(isIdle([done], [{ goal: { status: 'active' } }]), false);
});

test('다른 PC 비추기: 요약으로 연결하고, 이 PC 화면이 보는 그 PC 세션만 자세히 받겠다고 알린다', async () => {
  const peer = { id: 'p1', name: '회사', url: 'http://peer.invalid' };
  const calls = [];
  const peers = { list: () => [peer], self: () => ({ id: 'home', name: '집' }), call: async (_p, route, o = {}) => { calls.push([o.method || 'GET', route, o.body || null]); if (route.includes('/jobs?full=1')) return [{ id: 'j9', sessionId: 's-a', title: '전체', status: 'done', tasks: [], report: '보고' }]; return {}; } };
  const sent = [];
  const fed = new Federation({ peers, broadcast: (ev) => sent.push(ev), connect: false });
  // 연결 주소가 요약(compact)인지: listen 이 부르는 fetch 를 가로챈다
  const realFetch = globalThis.fetch; let url = '';
  globalThis.fetch = async (u) => { url = String(u); return { ok: false }; };
  try { await fed.listen(peer, 600_000); } finally { globalThis.fetch = realFetch; } // 다시 잇기는 10분 뒤(시험 중에는 안 일어남)
  assert.match(url, /\/api\/events\?compact=1$/);
  // 처음 묶음(요약)을 받으면 연결 번호를 기억하고, 보고 있던 세션을 알린다
  fed.setViewed(['s-local', 'rm-p1-s-a', 'rm-other-s-x']);
  assert.equal(calls.length, 0, '연결 전에는 알릴 곳이 없음');
  fed.onEvent(peer, { type: 'hello', stream: 'st-1', sessions: [{ id: 's-a', title: 'A', jobIds: ['j9'] }], jobs: [{ id: 'j9', sessionId: 's-a', title: '요약', status: 'done', summaryOnly: true, tasks: [] }] });
  await delay(10);
  assert.deepEqual(calls.at(-1), ['POST', '/api/events/sessions', { stream: 'st-1', sessions: 's-a' }], '그 PC의 원래 id 로');
  const n = calls.length; fed.setViewed(['rm-p1-s-a']); await delay(10);
  assert.equal(calls.length, n, '바뀐 것이 없으면 다시 알리지 않음');
  fed.setViewed([]); await delay(10);
  assert.deepEqual(calls.at(-1)[2], { stream: 'st-1', sessions: '' }, '안 보면 다시 요약으로');
  assert.equal(fed.jobs()[0].summaryOnly, true);
  // 세션 옮기기처럼 전체가 필요하면 그 PC에서 받아 채운다
  await fed.loadFull(peer, 'rm-p1-s-a');
  assert.equal(calls.at(-1)[1], '/api/sessions/s-a/jobs?full=1');
  const full = fed.jobs().find((j) => j.id === 'rm-p1-j9');
  assert.equal(full.report, '보고'); assert.equal(full.sessionId, 'rm-p1-s-a'); assert.equal(full.machine.name, '회사');
  fed.close();
});

test('보안: 허브 자료 폴더·.env 는 열기 범위 안이어도 읽기·내려받기·폴더 ZIP 에서 빼고, 범위 안 링크가 밖을 가리키면 밖', async () => {
  const { isAllowed, isPrivate, normalizeLocalPath } = await import('../lib/opener.mjs');
  const { resolveFile } = await import('../lib/files.mjs');
  const { planZip } = await import('../lib/zip.mjs');
  const root = temp; // 허브 폴더가 통째로 열기 범위인 상황(자료 폴더가 그 안에 있다)
  const secret = path.join(DATA_DIR, 'hub-auth.json'); fs.writeFileSync(secret, '{"secret":"x"}');
  const env = path.join(cwd, '.env'), envLocal = path.join(cwd, '.env.local'), ok = path.join(cwd, 'a.txt'), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-audit-out-'));
  for (const f of [env, envLocal, ok]) fs.writeFileSync(f, 'v'); fs.writeFileSync(path.join(outside, 'o.txt'), 'o');
  try {
    assert.equal(isPrivate(secret), true); assert.equal(isPrivate(env), true); assert.equal(isPrivate(envLocal), true); assert.equal(isPrivate(ok), false);
    assert.equal(isPrivate(path.join(cwd, 'env.md')), false); assert.equal(isPrivate(path.join(cwd, '.envrc')), false);
    assert.equal(isAllowed(secret, [root]), false, '자료 폴더는 열기(탐색기)도 안 됨'); assert.equal(isAllowed(ok, [root]), true);
    assert.throws(() => resolveFile({ path: secret }, [root]), (e) => e.status === 403);
    assert.throws(() => resolveFile({ path: env }, [root]), (e) => e.status === 403);
    assert.equal(resolveFile({ path: ok }, [root]), fs.realpathSync.native(ok));
    const names = planZip(root).entries.map((e) => e.rel);
    assert.ok(names.some((n) => n.endsWith('a.txt'))); assert.ok(!names.some((n) => /hub-auth|\.env/.test(n)), names.join(','));
    // 범위 안에 놓인 정션이 범위 밖을 가리키면 밖이다(예전에는 글자 경로만 보고 통과)
    const link = path.join(cwd, 'link'); let linked = false;
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch {}
    if (linked) { assert.equal(isAllowed(path.join(link, 'o.txt'), [cwd]), false); assert.equal(isAllowed(path.join(link, 'o.txt'), [cwd, outside]), true); fs.rmSync(link, { force: true, recursive: false }); }
    // 같은 파일의 다른 이름·장치 이름은 경로로 받지 않는다
    for (const bad of ['C:/a/b.txt::$DATA', 'C:/a/b.txt:stream', 'C:/a/b.txt.', 'C:/a/nul', 'C:/a/CON.txt', '//server/share/x']) assert.equal(normalizeLocalPath(bad), null, bad);
    assert.equal(normalizeLocalPath('C:/a/b.txt'), path.win32.join('C:', 'a', 'b.txt')); assert.equal(normalizeLocalPath('file:///C:/a/console.log'), path.win32.join('C:', 'a', 'console.log'));
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('보안: 다른 사이트에서 온 요청은 API 에서 받지 않는다(읽기도) — 화면·결과 페이지·브라우저가 아닌 호출은 그대로', async () => {
  const { checkRemoteRequest } = await import('../lib/remote.mjs');
  const req = (url, headers = {}, method = 'GET') => ({ method, url, headers: { host: '127.0.0.1:7700', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const check = (...a) => checkRemoteRequest(req(...a), { port: 7700 });
  assert.equal(check('/api/adobe/check?app=premiere', { 'sec-fetch-site': 'cross-site' })?.code, 'bad_origin', '악성 웹페이지의 <img>·fetch');
  assert.equal(check('/api/usage?force=1', { 'sec-fetch-site': 'same-site' })?.code, 'bad_origin', '이 PC의 다른 포트에서 도는 웹앱');
  assert.equal(check('/studio/api/file?path=C:%5Cx', { 'sec-fetch-site': 'cross-site' })?.code, 'bad_origin');
  assert.equal(check('/api/events', { 'sec-fetch-site': 'cross-site' })?.code, 'bad_origin');
  assert.equal(check('/api/status', { 'sec-fetch-site': 'same-origin' }), null, '허브 화면');
  assert.equal(check('/api/status', { 'sec-fetch-site': 'none' }), null, '주소창에 직접');
  assert.equal(check('/api/status'), null, 'CLI·다른 허브·플러그인(머리 없음)');
  assert.equal(check('/', { 'sec-fetch-site': 'cross-site' }), null, '다른 곳의 링크로 화면 열기');
  assert.equal(check('/view/C%3A/x/index.html', { 'sec-fetch-site': 'cross-site' }), null, '격리된 결과 페이지가 자기 그림·글꼴을 읽는 것');
  assert.equal(check('/api/chrome-ext/poll', { 'sec-fetch-site': 'cross-site', origin: 'chrome-extension://bbphnjmjmoneaomdoefgepngcjlmimgk' }, 'POST'), null, 'ODDIN 크롬 확장');
  // 원격(Tailscale)도 같다
  const remote = { enabled: true, hosts: ['pc.example.ts.net'], logins: ['me@example.com'], url: 'https://pc.example.ts.net/' };
  const r = (url, extra) => checkRemoteRequest({ method: 'GET', url, headers: { host: '127.0.0.1:7700', 'x-forwarded-host': 'pc.example.ts.net', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@example.com', ...extra }, socket: { remoteAddress: '127.0.0.1' } }, { port: 7700, remote });
  assert.equal(r('/api/jobs', { 'sec-fetch-site': 'same-origin' }), null);
  assert.equal(r('/api/jobs', { 'sec-fetch-site': 'cross-site' })?.code, 'bad_origin');
});
