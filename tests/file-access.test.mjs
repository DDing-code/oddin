// 파일 열기·보기 범위 (lib/file-access.mjs) · 이름만 적힌 결과 파일 찾기 (lib/opener.mjs findBelow)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileAccess, fileRoots, driveRoots } from '../lib/file-access.mjs';
import { isAllowed, resolveRelative, findBelow } from '../lib/opener.mjs';
import { resolveFile } from '../lib/files.mjs';

test('범위 설정: 기본은 아는 폴더만, 저장하면 다시 읽어도 유지', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fa-'));
  try {
    const file = path.join(dir, 'file-access.json');
    const fa = new FileAccess({ file });
    assert.equal(fa.read().allowAll, false);
    assert.equal(fa.save({ allowAll: true }).allowAll, true);
    assert.equal(new FileAccess({ file }).read().allowAll, true, '다시 켜도 유지');
    assert.equal(fa.save({ allowAll: 'yes' }).allowAll, false, 'true 만 켬');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('모든 폴더를 켜면 드라이브 루트까지 허용, 끄면 아는 폴더만', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fa-'));
  const known = path.join(dir, 'known'), outside = path.join(dir, 'outside');
  fs.mkdirSync(known); fs.mkdirSync(outside);
  const pic = path.join(outside, 'a.png'); fs.writeFileSync(pic, 'PNG');
  try {
    const off = fileRoots([known, known.toUpperCase(), null], { allowAll: false });
    assert.deepEqual(off, [known], '중복·빈 값은 뺀다');
    assert.equal(isAllowed(pic, off), false);
    assert.throws(() => resolveFile({ path: pic }, off), (e) => e.status === 403 && /모든 폴더/.test(e.message), '안내 문구에 해결 방법');
    const on = fileRoots([known], { allowAll: true });
    assert.ok(driveRoots().length >= 1 && on.length > off.length);
    assert.equal(isAllowed(pic, on), true);
    assert.equal(resolveFile({ path: pic }, on).toLowerCase(), fs.realpathSync.native(pic).toLowerCase());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('보고에 이름만 적힌 파일은 작업 폴더 아래에서 찾는다 (여러 개면 가장 최근 것)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-below-'));
  try {
    const deep = path.join(dir, '완성본', 'bull-potion'); fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, '스토리보드.md'), 'x');
    const old = path.join(dir, '시안', 'old'); fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, '스토리보드.md'), 'old');
    const past = new Date(Date.now() - 86_400_000); fs.utimesSync(path.join(old, '스토리보드.md'), past, past);
    fs.mkdirSync(path.join(dir, 'node_modules', 'p'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'p', 'only.png'), 'x');
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true }); fs.writeFileSync(path.join(dir, 'notes', 't1.md'), 'x');
    assert.equal(findBelow(dir, '스토리보드.md'), path.join(deep, '스토리보드.md'));
    assert.equal(findBelow(dir, 'notes/t1.md'), path.join(dir, 'notes', 't1.md'), '하위 경로 그대로도');
    assert.equal(findBelow(dir, 'only.png'), null, 'node_modules 는 보지 않는다');
    assert.equal(findBelow(dir, 'none.png'), null);
    // 열기·보기의 상대 경로 해석이 이 찾기를 쓴다
    assert.equal(resolveRelative({ path: path.join(dir, '스토리보드.md'), rel: '스토리보드.md', base: dir }, []), path.join(deep, '스토리보드.md'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
