// 드라이브 작업 폴더: 두 PC(집·회사)를 흉내 — 회사가 등록한 폴더를 집이 자기 구글 드라이브에서 지문으로 찾아 경로를 채운다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriveFolders, detectDrive, fingerprint, similarity } from '../lib/drive-folders.mjs';
import { knownProjects } from '../lib/projects.mjs';
import { buildWorkerPrompt } from '../lib/planner.mjs';

const put = (dir, names) => { fs.mkdirSync(dir, { recursive: true }); for (const n of names) n.endsWith('/') ? fs.mkdirSync(path.join(dir, n), { recursive: true }) : fs.writeFileSync(path.join(dir, n), n); };

test('드라이브 감지·지문·비슷함', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-drive-'));
  try {
    assert.equal(detectDrive(path.join(dir, '없음')), null);
    put(path.join(dir, '내 드라이브'), ['a.txt']); put(path.join(dir, '다른 컴퓨터', '내 컴퓨터'), []);
    const d = detectDrive(dir);
    assert.equal(d.myDrive, path.join(dir, '내 드라이브')); assert.equal(d.computers, path.join(dir, '다른 컴퓨터'));
    put(path.join(dir, 'f'), ['b.md', 'a.md', 'desktop.ini', '.tmp.driveupload/']);
    assert.deepEqual(fingerprint(path.join(dir, 'f')), ['a.md', 'b.md']);
    assert.equal(similarity(['a', 'b'], ['a', 'b']), 1); assert.equal(similarity(['a', 'b'], ['c']), 0); assert.equal(similarity([], ['a']), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('회사가 등록한 폴더를 집이 드라이브에서 찾고, 두 경로를 같은 메모리로 잇는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-drive-folders-'));
  try {
    const hub = path.join(dir, 'shared'); put(path.join(hub, 'sync'), []);
    fs.writeFileSync(path.join(hub, 'sync', 'config.json'), JSON.stringify({ memoryAliases: {} }));
    const files = ['10 Projects/', '80 Operations/', 'README.md', 'tools/', 'scripts/'];
    const officeLocal = path.join(dir, 'office', 'Archive'); put(officeLocal, files);
    const homeDrive = path.join(dir, 'home-drive');
    put(path.join(homeDrive, '내 드라이브', '다른 것'), ['x.txt']);
    put(path.join(homeDrive, '다른 컴퓨터', '내 컴퓨터', 'Archive'), ['공부자료/', '썸네일/', 'AE/']); // 다른 폴더(D쪽)
    put(path.join(homeDrive, '다른 컴퓨터', '내 컴퓨터', 'Archive (1)'), [...files, 'desktop.ini']);
    const office = new DriveFolders({ hubDir: hub, self: () => ({ id: 'office', name: '회사' }), projects: () => [officeLocal], driveRoot: path.join(dir, 'office-drive') });
    const home = new DriveFolders({ hubDir: hub, self: () => ({ id: 'home', name: '집' }), projects: () => [], driveRoot: homeDrive });

    const f = office.add({ path: officeLocal, name: '업무 보관함' });
    assert.equal(f.here, officeLocal);
    assert.throws(() => office.add({ path: officeLocal }), /이미 등록/);
    put(path.join(dir, 'empty'), []); assert.throws(() => office.add({ path: path.join(dir, 'empty') }), /빈 폴더/);

    const r = home.resolve();
    const homePath = path.join(homeDrive, '다른 컴퓨터', '내 컴퓨터', 'Archive (1)');
    assert.deepEqual(r.found.map((x) => x.path), [homePath], '이름이 비슷한 Archive(D쪽)가 아니라 내용이 같은 Archive (1)');
    const lh = home.list()[0];
    assert.equal(lh.here, homePath); assert.deepEqual(lh.others, [{ id: 'office', name: '회사', path: officeLocal }]);

    const aliases = JSON.parse(fs.readFileSync(path.join(hub, 'sync', 'config.json'), 'utf8')).memoryAliases;
    assert.equal(aliases[homePath.replace(/\\/g, '/')], aliases[officeLocal.replace(/\\/g, '/')], '두 경로가 같은 프로젝트 메모리');

    const inside = home.folderOf(path.join(homePath, 'tools'));
    assert.equal(inside.name, '업무 보관함'); assert.equal(inside.others[0].path, officeLocal);
    assert.equal(home.folderOf(path.join(dir, 'office')), null);

    // 작업 폴더 목록에 "드라이브 · 이름"으로 (이 PC에 있는 경로만)
    const projects = knownProjects({ hubDir: hub, defaultCwd: path.join(dir, 'work') }, []);
    assert.ok(projects.some((p) => p.path.toLowerCase() === homePath.toLowerCase() && p.label === '드라이브 · 업무 보관함'));

    // 경로 직접 지정·빼기
    home.setPath(f.id, path.join(homeDrive, '다른 컴퓨터', '내 컴퓨터', 'Archive'));
    assert.match(home.list()[0].here, /Archive$/);
    home.remove(f.id); assert.equal(home.list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('작업 지시문: 드라이브 작업 폴더면 두 PC가 함께 쓴다는 안내', () => {
  const job = { id: 'j1', cwd: 'D:/x', goal: '시안 만들어', input: '시안 만들어', tasks: [], mode: 'auto', settings: {} };
  const task = { id: 't1', assignee: 'codex', title: '시안', prompt: '만들어', dependsOn: [] };
  const withDrive = buildWorkerPrompt({ job, task, depResults: [], siblings: [task], hubDir: 'H', memoryCtx: '', driveFolder: { name: '업무 보관함', others: [{ name: '회사', path: 'C:/Work/Archive' }] } });
  assert.ok(withDrive.includes("구글 드라이브로 두 PC가 함께 쓰는 작업 폴더(업무 보관함)입니다 — 다른 PC에서는 회사: C:/Work/Archive"));
  assert.doesNotMatch(buildWorkerPrompt({ job, task, depResults: [], siblings: [task], hubDir: 'H', memoryCtx: '' }), /구글 드라이브/);
});
