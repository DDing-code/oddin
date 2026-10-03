import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('../desktop/lib/hubs.cjs');

test('원격 허브 주소: 이 PC(루프백 http)와 Tailscale https 만 받고 origin 만 남긴다', () => {
  assert.equal(H.normalizeUrl('http://127.0.0.1:7700/'), 'http://127.0.0.1:7700');
  assert.equal(H.normalizeUrl('home-pc.tail1234.ts.net'), 'https://home-pc.tail1234.ts.net');
  assert.equal(H.normalizeUrl('https://home-pc.tail1234.ts.net/some/path?x=1#s=abc'), 'https://home-pc.tail1234.ts.net');
  assert.throws(() => H.normalizeUrl('http://home-pc.tail1234.ts.net'), /https/);
  assert.throws(() => H.normalizeUrl('https://example.com'), /Tailscale/);
  assert.throws(() => H.normalizeUrl('http://192.168.0.5:7700'), /https/);
  assert.throws(() => H.normalizeUrl('https://user:pw@home.tail.ts.net'), /계정/);
  assert.throws(() => H.normalizeUrl('file:///C:/x'), /http/);
  assert.throws(() => H.normalizeUrl(''), /입력/);
});

test('허브 목록: 이 PC 허브는 항상 첫 번째, 잘못된 항목·중복은 버린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-desktop-'));
  const file = path.join(dir, 'hubs.json');
  fs.writeFileSync(file, JSON.stringify({ current: 'h-gone', hubs: [
    { id: 'h-a', name: '집 PC', url: 'https://home.tail.ts.net/' },
    { id: 'h-b', name: '중복', url: 'https://home.tail.ts.net' },
    { id: 'bad id!', name: 'x', url: 'https://x.tail.ts.net' },
    { id: 'h-c', name: '나쁜 주소', url: 'https://evil.example.com' },
  ] }));
  const st = H.loadState(file, { localUrl: 'http://127.0.0.1:7700' });
  assert.deepEqual(st.hubs.map((h) => h.id), ['local', 'h-a']);
  assert.equal(st.current, 'local'); // 없는 허브를 가리키면 이 PC로
  assert.equal(st.hubs[0].local, true);
  H.addHub(st, { name: '', url: 'laptop.tail.ts.net' });
  assert.equal(st.hubs.at(-1).name, 'laptop');
  assert.throws(() => H.addHub(st, { name: 'x', url: 'https://home.tail.ts.net/' }), /이미/);
  st.current = 'h-a';
  H.removeHub(st, 'h-a');
  assert.equal(st.current, 'local');
  assert.throws(() => H.removeHub(st, 'local'), /이 PC/);
  H.renameHub(st, 'local', '작업용 PC');
  H.saveState(file, st);
  const again = H.loadState(file, { localUrl: 'http://127.0.0.1:7700' });
  assert.equal(again.hubs[0].name, '작업용 PC');
  assert.equal(again.hubs.length, 2);
});

test('원격 세션 요약: 필요한 필드만, 최근 순, 최대 30개', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ id: `s-${i}`, title: `세션 ${i}`, cwd: 'F:\\x', updatedAt: new Date(2026, 9, 3, 0, i).toISOString(), status: i === 39 ? 'running' : 'done', jobIds: ['j'], secret: 'x' }));
  list.push({ id: '../evil', title: 'x', updatedAt: '9999' });
  const out = H.summarizeSessions(list);
  assert.equal(out.length, 30);
  assert.equal(out[0].id, 's-39');
  assert.equal(out[0].status, 'running');
  assert.deepEqual(Object.keys(out[0]).sort(), ['cwd', 'id', 'pinned', 'status', 'title', 'updatedAt']);
  assert.ok(!out.some((s) => s.id === '../evil'));
  assert.deepEqual(H.summarizeSessions(null), []);
});

test('창 주소와 출처 판정', () => {
  const st = { current: 'local', hubs: [{ id: 'local', url: 'http://127.0.0.1:7700', local: true }, { id: 'h-a', url: 'https://home.tail.ts.net' }] };
  assert.equal(H.hubPageUrl(st.hubs[1], 's-abc_1'), 'https://home.tail.ts.net/#s=s-abc_1');
  assert.throws(() => H.hubPageUrl(st.hubs[1], 'x"><script>'), /세션/);
  assert.equal(H.isHubOrigin(st, 'https://home.tail.ts.net/#s=1'), true);
  assert.equal(H.isHubOrigin(st, 'https://home.tail.ts.net.evil.com/'), false);
  assert.equal(H.isHubOrigin(st, 'http://127.0.0.1:7701/'), false);
  assert.equal(H.looksLikeHub({ config: {}, tools: null }), true);
  assert.equal(H.looksLikeHub({ ok: true }), false);
  assert.match(H.explainHttpError(403, { error: '허용되지 않은 계정' }), /허용되지 않은 계정/);
  assert.match(H.explainHttpError(421, null), /허용 목록/);
});
