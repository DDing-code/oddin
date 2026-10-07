// 세션 묶음 · 작업 폴더 바꾸기 · 폴더 둘러보기 (lib/session-groups.mjs · jobs.updateSession)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-groups-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const { SessionGroups, listDirs, makeDir, renameDir, checkFolderName } = await import('../lib/session-groups.mjs');
const { isControl } = await import('../lib/hub-auth.mjs');
const { JobManager } = await import('../lib/jobs.mjs');
const mk = (...p) => { const d = path.join(temp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

test('묶음: 만들기·이름 바꾸기·순서·지우기, 다시 읽어도 유지', () => {
  const file = path.join(temp, 'g.json'), g = new SessionGroups({ file });
  assert.throws(() => g.create('  '), (e) => e.status === 400);
  const a = g.create('영상 외주'), b = g.create('와우\n메타');
  assert.equal(b.name, '와우 메타');
  assert.equal(g.rename(a.id, '영상').name, '영상');
  assert.deepEqual(g.reorder([b.id, a.id]).map((x) => x.id), [b.id, a.id]);
  assert.deepEqual(new SessionGroups({ file }).list().map((x) => x.name), ['와우 메타', '영상']);
  g.remove(a.id); assert.equal(g.has(a.id), false);
  assert.throws(() => g.remove(a.id), (e) => e.status === 404);
});

test('세션: 묶음에 넣고 빼기, 없는 묶음은 거절, 새 세션도 묶음에 바로', () => {
  const m = new JobManager({ defaultCwd: mk('ws'), hubDir: mk('shared'), tools: {}, defaults: {} });
  m.groups = new SessionGroups({ file: path.join(temp, 'g2.json') });
  const g = m.groups.create('영상');
  const s = m.createSession({ cwd: mk('proj-a') });
  assert.equal(m.updateSession(s.id, { group: g.id }).group, g.id);
  assert.throws(() => m.updateSession(s.id, { group: 'g-nope' }), (e) => e.status === 404);
  assert.equal(m.updateSession(s.id, { group: null }).group, null);
  assert.equal(m.createSession({ cwd: mk('proj-b'), group: g.id }).group, g.id);
  assert.equal(m.createSession({ cwd: mk('proj-b'), group: 'g-nope' }).group, undefined, '없는 묶음은 무시');
});

test('세션 작업 폴더 바꾸기: 다음 요청부터 그 폴더, 옮겨 간 폴더 기억은 지움, 안 되는 폴더·실행 중은 거절', () => {
  const m = new JobManager({ defaultCwd: mk('ws'), hubDir: mk('shared'), tools: {}, defaults: {} });
  const s = m.createSession({ cwd: mk('ws') });
  m.sessions.get(s.id).workdir = mk('old-project');
  const to = mk('new-project');
  const v = m.updateSession(s.id, { cwd: to });
  assert.equal(v.cwd, to); assert.equal(m.sessions.get(s.id).workdir, null);
  assert.equal(m.startDir(m.sessions.get(s.id)), to, '다음 요청은 바꾼 폴더에서');
  assert.throws(() => m.updateSession(s.id, { cwd: path.join(temp, '없는폴더') }), (e) => e.status === 400 && /없는 폴더/.test(e.message));
  assert.throws(() => m.updateSession(s.id, { cwd: process.env.HUB_DATA_DIR }), (e) => e.status === 400, '허브 기록 폴더는 안 됨');
  // 진행 중인 작업이 있으면 거절
  m.jobs.set('j-live', { id: 'j-live', sessionId: s.id, status: 'running', tasks: [], intercepts: [] });
  m.sessions.get(s.id).jobIds.push('j-live');
  assert.throws(() => m.updateSession(s.id, { cwd: mk('another') }), (e) => e.status === 409);
});

test('폴더 둘러보기: 하위 폴더 이름만(파일·숨김 폴더 빼고), 빈 경로면 드라이브 목록', () => {
  const root = mk('browse');
  for (const d of ['b폴더', 'a', '.git', 'node_modules', '$RECYCLE']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  const r = listDirs(root);
  assert.deepEqual(r.dirs.map((d) => d.name), ['a', 'b폴더']);
  assert.equal(r.parent, path.dirname(root));
  assert.ok(listDirs('').dirs.length >= 1, '드라이브 목록');
  assert.throws(() => listDirs(path.join(root, 'file.txt')), (e) => e.status === 400);
  assert.throws(() => listDirs(path.join(root, '없음')), (e) => e.status === 404);
});

test('폴더 찾아보기 창 새 폴더: 지금 폴더 안에 만들고, 이미 있거나 못 쓰는 이름은 거절', () => {
  const root = mk('newdir');
  assert.equal(makeDir(root, ' 촬영본 정리 ').path, path.join(root, '촬영본 정리'));
  assert.ok(fs.statSync(path.join(root, '촬영본 정리')).isDirectory());
  assert.throws(() => makeDir(root, '촬영본 정리'), (e) => e.status === 409);
  for (const bad of ['a/b', 'a:b', 'con', 'x.', '', 'q?']) assert.throws(() => makeDir(root, bad), (e) => e.status === 400, bad);
  assert.throws(() => makeDir(path.join(root, '없음'), 'x'), (e) => e.status === 404);
  assert.equal(checkFolderName('  벌어보세 v2 '), '벌어보세 v2');
});

test('폴더 이름 바꾸기: ODDIN·사용자·시스템 폴더와 진행 중인 작업 폴더는 막고, 쓰던 세션 경로는 따라 바뀐다', () => {
  const root = mk('rename'), proj = mk('rename', '편집본'), inner = mk('rename', '편집본', '렌더');
  // 막는 것
  assert.throws(() => renameDir(root, 'x', { protect: [inner] }), (e) => e.status === 403 && /ODDIN이 쓰는 폴더/.test(e.message), 'ODDIN 폴더를 품은 폴더');
  assert.throws(() => renameDir(proj, 'x', { busy: () => true }), (e) => e.status === 409);
  assert.throws(() => renameDir(path.join(root, '없음'), 'x'), (e) => e.status === 404);
  mk('rename', '이미있음');
  assert.throws(() => renameDir(proj, '이미있음'), (e) => e.status === 409);
  if (process.platform === 'win32') for (const sys of ['C:\\Windows\\System32', os.homedir(), path.join(os.homedir(), 'Documents'), 'C:\\']) assert.throws(() => renameDir(sys, 'x'), (e) => [400, 403, 404].includes(e.status), sys);
  // 세션이 쓰던 경로 따라 바꾸기
  const m = new JobManager({ defaultCwd: mk('ws'), hubDir: mk('shared'), tools: {}, defaults: {} });
  const a = m.createSession({ cwd: proj }), b = m.createSession({ cwd: inner }), c = m.createSession({ cwd: root });
  const r = renameDir(proj, '편집본_v2', { busy: (d) => m.folderBusy(d) });
  assert.equal(r.path, path.join(root, '편집본_v2'));
  assert.equal(m.renameFolderRefs(r.from, r.path), 2, '그 폴더와 안쪽 폴더를 쓰던 세션 2개');
  assert.equal(m.sessions.get(a.id).cwd, path.join(root, '편집본_v2'));
  assert.equal(m.sessions.get(b.id).cwd, path.join(root, '편집본_v2', '렌더'));
  assert.equal(m.sessions.get(c.id).cwd, root, '바깥 폴더 세션은 그대로');
  // 진행 중인 작업이 있으면 바쁨
  m.jobs.set('j-live', { id: 'j-live', sessionId: a.id, cwd: path.join(root, '편집본_v2'), status: 'running', tasks: [], intercepts: [] });
  assert.equal(m.folderBusy(path.join(root, '편집본_v2')), true);
  assert.equal(m.folderBusy(mk('rename', '딴곳')), false);
});

test('원격에서 폴더 만들기·이름 바꾸기는 제어 기능(ODDIN 화면만), 목록 보기는 그대로', () => {
  assert.equal(isControl('/api/dirs', 'POST'), true);
  assert.equal(isControl('/api/dirs/rename', 'POST'), true);
  assert.equal(isControl('/api/dirs', 'GET'), false);
});
