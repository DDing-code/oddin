import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeLocalPath, isAllowed, openLocal, resolveRelative } from '../lib/opener.mjs';

test('경로 정리: /F:/ · file:/// · 슬래시 · 인코딩', () => {
  assert.equal(normalizeLocalPath('/F:/01_프로젝트/a/b.mp4'), 'F:\\01_프로젝트\\a\\b.mp4');
  assert.equal(normalizeLocalPath('file:///C:/x/y%20z.txt'), 'C:\\x\\y z.txt');
  assert.equal(normalizeLocalPath('C:\\x\\..\\y'), 'C:\\y');
  assert.equal(normalizeLocalPath('relative/path'), null);
  assert.equal(normalizeLocalPath('C:/x/"y".txt'), null);
  assert.equal(normalizeLocalPath('C:/x/%22y%22'), null); // 인코딩된 따옴표도 거절
  assert.equal(normalizeLocalPath('https://example.com'), null);
});

test('허브가 아는 폴더 안만 허용', () => {
  assert.equal(isAllowed('F:\\proj\\out\\a.mp4', ['F:\\proj']), true);
  assert.equal(isAllowed('F:\\proj', ['F:\\proj\\']), true);
  assert.equal(isAllowed('F:\\project2\\a.mp4', ['F:\\proj']), false); // 이름이 겹쳐도 다른 폴더
  assert.equal(isAllowed('C:\\Windows\\System32', ['F:\\proj']), false);
});

test('열기 오류: 없는 경로 404, 범위 밖 403, 형식 오류 400 (탐색기는 띄우지 않음)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-open-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.throws(() => openLocal(path.join(dir, 'none.txt'), { roots: [dir] }), (e) => e.status === 404);
  assert.throws(() => openLocal(path.join(dir, 'a.txt'), { roots: ['Z:\\elsewhere'] }), (e) => e.status === 403);
  assert.throws(() => openLocal('not a path', { roots: [dir] }), (e) => e.status === 400);
});

test('상대 경로: 작업 폴더에 없으면 상위·허브 폴더에서 실제 위치를 찾는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-rel-'));
  const ws = path.join(root, 'workspace');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-rel-other-'));
  fs.mkdirSync(path.join(ws, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'out', 'a.mp4'), 'x');
  fs.writeFileSync(path.join(root, 'server.mjs'), 'x');
  fs.writeFileSync(path.join(root, 'lib', 'b.mjs'), 'x');
  fs.writeFileSync(path.join(other, 'only-here.md'), 'x');
  const ask = (rel, roots = []) => resolveRelative({ path: path.join(ws, rel), rel, base: ws }, roots);
  assert.equal(ask('out/a.mp4'), path.join(ws, 'out', 'a.mp4')); // 작업 폴더에 있으면 그대로
  assert.equal(ask('server.mjs'), path.join(root, 'server.mjs')); // 상위 폴더
  assert.equal(ask('./lib/b.mjs'), path.join(root, 'lib', 'b.mjs')); // ./ 와 슬래시 정리
  assert.equal(ask('only-here.md', [other]), path.join(other, 'only-here.md')); // 허브가 아는 다른 폴더
  assert.equal(ask('none.txt'), path.join(ws, 'none.txt')); // 못 찾으면 원래 경로 → openLocal 이 404
  assert.equal(resolveRelative({ path: path.join(root, 'server.mjs') }), path.join(root, 'server.mjs')); // rel 없으면 손대지 않음
  // 상위로 빠져나가도 열기 전에 범위 검사에서 막힌다
  const escaped = resolveRelative({ path: path.join(ws, 'x'), rel: '../../../../../Windows/win.ini', base: ws }, [ws]);
  if (fs.existsSync(escaped)) assert.throws(() => openLocal(escaped, { roots: [ws] }), (e) => e.status === 403);
});
