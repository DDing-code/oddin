// 긴 이미지 자동 나누기 규칙 (public/image-split.js 의 plan) · 서버 첨부 한도 · 지시문 순서 안내
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../lib/attachments.mjs';
import { splitNote } from '../lib/planner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { window: {}, Math, Promise };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'public', 'image-split.js'), 'utf8'), ctx);
const S = ctx.window.hubSplitImage;

test('나눌지: 한 변 8000 초과이거나 2.5배 넘게 길쭉하고 긴 변 3000 초과', () => {
  assert.equal(S.needsSplit(1080, 1920), false, '보통 세로 화면은 그대로');
  assert.equal(S.needsSplit(1920, 1080), false);
  assert.equal(S.needsSplit(1080, 2800), false, '길쭉해도 짧으면 그대로');
  assert.equal(S.needsSplit(1080, 6000), true, '긴 스크린샷');
  assert.equal(S.needsSplit(7000, 7900), false, '크지만 한도 안이고 길쭉하지 않음');
  assert.equal(S.needsSplit(500, 9000), true, '한 변 8000 초과');
  assert.equal(S.needsSplit(12000, 1000), true, '가로로 긴 파노라마');
});

test('조각: 짧은 변의 1.6배 크기로 겹치게 잘라 끝까지 덮고, 모든 조각이 한 변 8000 이하', () => {
  for (const [W, H] of [[1080, 20000], [1440, 9000], [390, 30000], [12000, 1000], [1080, 400000], [9000, 30000]]) {
    const p = S.plan(W, H), n = p.starts.length;
    assert.ok(n >= 2 && n <= 20, `${W}x${H}: ${n}장`);
    assert.ok(p.tile <= S.MAX_SIDE && p.s <= S.MAX_SIDE, `${W}x${H}: 한 변 8000 이하`);
    assert.equal(p.starts[0], 0);
    assert.equal(p.starts[n - 1] + p.tile >= p.L - 1, true, `${W}x${H}: 끝까지 덮음`);
    for (let i = 1; i < n; i++) assert.ok(p.starts[i] - p.starts[i - 1] <= p.tile - S.OVERLAP + 1, `${W}x${H}: 조각 사이가 겹침`);
  }
  const shot = S.plan(1080, 20000);
  assert.equal(shot.vertical, true); assert.equal(shot.tile, 1728, '1080 너비 → 1728 높이 조각');
  assert.equal(shot.scale, 1, '원본 크기 그대로');
  assert.equal(S.plan(1080, 400000).starts.length, 20, '아주 길면 20장에 맞춰 줄임');
});

test('서버: 한 변 8000·5MB 는 그대로, 나눈 조각을 받을 수 있게 장수는 넉넉히', () => {
  assert.equal(LIMITS.maxSide, 8000); assert.equal(LIMITS.maxBytes, 5 * 1024 * 1024);
  assert.ok(LIMITS.maxCount >= 20);
});

test('지시문: 나눈 조각이면 순서대로 이어서 읽으라고 알린다', () => {
  assert.match(splitNote([{ name: '긴화면 (1/2).png' }, { name: '긴화면 (2/2).png' }]), /2장은 긴 이미지 한 장을[^]*긴화면 \(1\/2\)\.png, 긴화면 \(2\/2\)\.png/);
  assert.equal(splitNote([{ name: '사진 (1).png' }, { name: '사진.png' }]), '', '보통 이름은 안내하지 않음');
});
