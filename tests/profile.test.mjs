// 계정 칸 이름·사진 (lib/profile.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Profile } from '../lib/profile.mjs';

test('이름·사진 저장, 종류 검사, 바꾸면 예전 사진 지움, 지우기', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-profile-'));
  try {
    const p = new Profile({ dir });
    assert.deepEqual([p.read().name, p.read().avatar], ['', null], '처음엔 비어 있음');
    assert.equal(p.setName('  Heathcliff\n').name, 'Heathcliff');
    assert.equal(p.setName('x'.repeat(80)).name.length, 40);
    p.setName('Heathcliff');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
    const v = p.setAvatar(svg, 'image/svg+xml');
    assert.match(v.avatar, /^\/api\/profile\/avatar\?v=/);
    assert.ok(fs.existsSync(path.join(dir, 'profile-avatar.svg')));
    assert.throws(() => p.setAvatar(Buffer.from('MZ'), 'application/x-msdownload'), (e) => e.status === 415);
    assert.throws(() => p.setAvatar(Buffer.from('not svg'), 'image/svg+xml'), (e) => e.status === 400);
    p.setAvatar(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    assert.ok(!fs.existsSync(path.join(dir, 'profile-avatar.svg')), '종류가 바뀌면 예전 파일은 지움');
    assert.equal(new Profile({ dir }).read().name, 'Heathcliff', '다시 읽어도 유지');
    // SVG·그림은 허브 주소에서 스크립트가 돌지 않게 sandbox 로 보냄
    let head = null; const res = { writeHead: (s, h) => { head = h; }, on() {}, once() {}, emit() {}, write() { return true; }, end() {} };
    p.serveAvatar(res);
    assert.match(head['Content-Security-Policy'], /sandbox/);
    assert.equal(head['Content-Type'], 'image/png');
    assert.equal(p.clearAvatar().avatar, null);
    assert.throws(() => p.serveAvatar(res), (e) => e.status === 404);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
