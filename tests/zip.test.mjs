// 내려받기: 폴더 ZIP(한글 이름·하위 폴더·.git 빼기·크기 미리 계산) · 파일 그대로 · 경로 정보 (lib/zip.mjs · lib/files.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { planZip, writeZip, zipSize, attachment } from '../lib/zip.mjs';
import { serveDownload, statPath } from '../lib/files.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-zip-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const root = path.join(temp, '결과물');
const put = (rel, data) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
put('대본.txt', '첫 장면\n둘째 장면\n');
put('그림/01 표지.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]));
put('그림/세부/메모.md', '# 메모');
put('빈파일.txt', '');
put('.git/HEAD', 'ref: x');
put('node_modules/a/index.js', 'x');

// ZIP 읽기(저장 방식만): 가운데 목록을 따라 각 파일을 꺼내고 CRC 를 확인한다
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, '끝 표시가 있어야 함');
  const count = buf.readUInt16LE(eocd + 10), cd = buf.readUInt32LE(eocd + 16);
  const out = {}; let p = cd;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    assert.equal(buf.readUInt16LE(p + 8) & 0x0800, 0x0800, 'UTF-8 이름 표시');
    const crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 24), nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    assert.equal(buf.readUInt32LE(off + 14), crc, '앞 머리와 가운데 목록의 CRC 가 같음');
    const lnlen = buf.readUInt16LE(off + 26), data = buf.subarray(off + 30 + lnlen, off + 30 + lnlen + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, `${name} CRC`);
    out[name] = data;
    p += 46 + nlen;
  }
  return out;
}

test('폴더 ZIP: 한글 이름·하위 폴더 그대로, .git·node_modules 는 빼고, 크기는 미리 맞게', async () => {
  const { entries } = planZip(root);
  const chunks = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  await writeZip(entries, sink);
  const buf = Buffer.concat(chunks);
  assert.equal(buf.length, zipSize(entries), '미리 계산한 크기와 같음(다운로드 진행률)');
  const files = unzip(buf);
  assert.deepEqual(Object.keys(files).sort(), ['그림/01 표지.png', '그림/세부/메모.md', '대본.txt', '빈파일.txt'].sort());
  assert.equal(files['대본.txt'].toString(), '첫 장면\n둘째 장면\n');
  assert.deepEqual([...files['그림/01 표지.png']], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
  assert.equal(files['빈파일.txt'].length, 0);
  assert.throws(() => planZip(root, { maxBytes: 5, maxFiles: 100 }), (e) => e.status === 413);
  assert.throws(() => planZip(root, { maxBytes: 1e9, maxFiles: 2 }), (e) => e.status === 413);
});

test('내려받기 머리: 한글 이름은 filename* 로, 옛 프로그램용 이름도 함께', () => {
  const h = attachment('스토리보드 v2.pdf');
  assert.match(h, /^attachment; filename="[^"]*\.pdf"; filename\*=UTF-8''/);
  assert.ok(h.includes(encodeURIComponent('스토리보드 v2.pdf')));
  assert.ok(!/[^\x20-\x7e]/.test(h), '머리는 ASCII 만');
});

test('서버: 파일은 그대로(이어받기 포함), 폴더는 ZIP, 허용 범위 밖은 거절, 경로 정보', async () => {
  const roots = [temp];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), params = Object.fromEntries(u.searchParams);
    try { await serveDownload(req, res, params, roots); } catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/?path=`;
  try {
    const f = await fetch(base + encodeURIComponent(path.join(root, '대본.txt')));
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'application/octet-stream');
    assert.ok(f.headers.get('content-disposition').includes(encodeURIComponent('대본.txt')));
    assert.equal(await f.text(), '첫 장면\n둘째 장면\n');
    const part = await fetch(base + encodeURIComponent(path.join(root, '대본.txt')), { headers: { Range: 'bytes=0-2' } });
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 3);
    const z = await fetch(base + encodeURIComponent(root));
    assert.equal(z.status, 200); assert.equal(z.headers.get('content-type'), 'application/zip');
    assert.ok(z.headers.get('content-disposition').includes(encodeURIComponent('결과물.zip')));
    const zb = Buffer.from(await z.arrayBuffer());
    assert.equal(Number(z.headers.get('content-length')), zb.length);
    assert.equal(Object.keys(unzip(zb)).length, 4);
    const inl = await fetch(base + encodeURIComponent(path.join(root, '대본.txt')) + '&inline=1');
    assert.match(inl.headers.get('content-type'), /^text\/plain/); assert.match(inl.headers.get('content-disposition'), /^inline/); assert.equal(inl.headers.get('content-security-policy'), 'sandbox');
    put('page.html', '<script>1</script>');
    const pg = await fetch(base + encodeURIComponent(path.join(root, 'page.html')) + '&inline=1');
    assert.equal(pg.headers.get('content-type'), 'application/octet-stream', '웹 페이지는 바로 보기 대신 내려받기'); assert.match(pg.headers.get('content-disposition'), /^attachment/); await pg.arrayBuffer(); await inl.text();
    const out = await fetch(base + encodeURIComponent(os.homedir()));
    assert.equal(out.status, 403, '허브가 아는 폴더 밖은 거절');
  } finally { srv.close(); }
  const s = statPath({ path: root }, roots);
  assert.equal(s.kind, 'dir'); assert.equal(s.name, '결과물'); assert.equal(s.count, 6); // 대본·그림·빈파일·.git·node_modules·page.html
  const fsx = statPath({ path: path.join(root, '대본.txt') }, roots);
  assert.equal(fsx.kind, 'file'); assert.equal(fsx.size, Buffer.byteLength('첫 장면\n둘째 장면\n'));
});
