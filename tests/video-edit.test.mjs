// ODDIN 영상 편집기(2026-10-10, replica/architecture.md): 공용 코어(public/video-core.js)·ffmpeg 식·서버 API·렌더
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './_port.mjs';
import { core, keyExpr, EASE_EXPR, tools, listFonts } from '../lib/video-edit.mjs';
import { isControl } from '../lib/hub-auth.mjs';
import { findBrowser } from '../lib/browser.mjs';

const V = core();
const plain = (v) => JSON.parse(JSON.stringify(v));
// ffmpeg 식을 JS 로 풀어 계산(if·lt·gte·pow)
function evalExpr(expr, t) {
  const js = expr.replace(/\bif\(/g, 'IF(').replace(/\blt\(/g, 'LT(').replace(/\bgte\(/g, 'GTE(').replace(/\bpow\(/g, 'Math.pow(');
  return new Function('t', 'IF', 'LT', 'GTE', `return ${js};`)(t, (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0), (a, b) => (a >= b ? 1 : 0));
}

test('이징: 화면(JS)과 렌더(ffmpeg 식)가 같은 값', () => {
  for (const [name, fn] of Object.entries(V.EASE)) {
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const e = evalExpr(EASE_EXPR[name].replaceAll('P', `(${p})`), 0);
      assert.ok(Math.abs(fn(p) - e) < 1e-9, `${name} p=${p}: ${fn(p)} vs ${e}`);
    }
  }
  assert.ok(V.EASE.snap(0.5) > 1, '쫀득은 살짝 넘친다');
});

test('키프레임: valueAt 과 keyExpr(조각 시작 기준 이동 포함)이 같은 값', () => {
  const keys = [{ t: 0.2, v: 1, ease: 'snap' }, { t: 0.5, v: 1.3, ease: 'hold' }, { t: 1, v: 0.8, ease: 'expo' }, { t: 1.6, v: 1.1, ease: 'linear' }];
  for (const off of [0, 0.35, 1.2]) {
    const ex = keyExpr(1, keys, off);
    for (let t = 0; t < 2; t += 0.037) assert.ok(Math.abs(V.valueAt(1, keys, t + off) - evalExpr(ex, t)) < 1e-5, `off=${off} t=${t.toFixed(3)}`);
  }
  assert.equal(keyExpr(1.5, [], 0), '1.5');
});

test('편집 파일 정리: 빠진 값 채우기·없는 원본 빼기·원본 길이 넘으면 줄이기·정렬', () => {
  const { doc, problems } = V.normalize({
    width: 1080, height: 1920, fps: 30, media: { m1: { path: 'a.mp4', duration: 10, width: 1920, height: 1080 } },
    tracks: [
      { kind: 'video', clips: [{ id: 'c2', media: 'm1', start: 5, in: 8, out: 15 }, { id: 'c1', media: 'm1', start: 0, in: 0, out: 5 }, { id: 'bad', media: 'nope', start: 0 }] },
      { kind: 'text', items: [{ start: 3, end: 1, text: '거꾸로' }, { start: 1, end: 2, text: '첫째', anim: { in: 'pop', out: '이상한값' } }] },
      { kind: 'weird' },
    ],
  });
  const p = plain(problems).join(' ');
  assert.match(p, /없는 원본/); assert.match(p, /원본 길이를 넘어/); assert.match(p, /종류를 모르는 트랙/);
  const v = doc.tracks.find((t) => t.kind === 'video'), tx = doc.tracks.find((t) => t.kind === 'text');
  assert.deepEqual(plain(v.clips.map((c) => c.id)), ['c1', 'c2']);
  assert.equal(v.clips[1].out, 10);
  assert.equal(tx.items[0].text, '첫째'); assert.equal(tx.items[0].anim.out, 'none');
  assert.ok(tx.items[1].end > tx.items[1].start, '끝이 시작보다 앞이면 고친다');
  assert.equal(V.duration(doc), 7);
});

test('등장·퇴장 효과와 자막 상태', () => {
  const it = { start: 1, end: 3, x: 0, y: 100, scale: 1, rotation: 0, opacity: 1, anim: { in: 'pop', out: 'fade', inDur: 0.2, outDur: 0.2 }, keys: {} };
  assert.equal(V.itemState(it, 0.5), null);
  const a = V.itemState(it, 1.02); assert.ok(a.scale < 1 && a.opacity < 1, '팝 시작은 작고 흐리다');
  const m = V.itemState(it, 2); assert.deepEqual([m.scale, m.opacity, m.y], [1, 1, 100]);
  assert.ok(V.itemState(it, 2.95).opacity < 0.5, '페이드 퇴장');
});

test('SRT 읽기·쓰기 되돌림', () => {
  const srt = '1\n00:00:01,500 --> 00:00:03,000\n첫 줄\n둘째 줄\n\n2\n00:01:02,040 --> 00:01:04,000\n다음\n';
  const items = plain(V.parseSrt(srt));
  assert.deepEqual(items.map((i) => [i.start, i.end]), [[1.5, 3], [62.04, 64]]);
  assert.equal(items[0].text, '첫 줄\n둘째 줄');
  assert.deepEqual(plain(V.parseSrt(V.toSrt(items))), items);
  assert.equal(V.fmtTime(62.04, 25), '01:02:01');
});

test('원격 문지기: 저장·렌더는 제어, 보기·파형은 아님', () => {
  assert.equal(isControl('/api/video/render', 'POST'), true);
  assert.equal(isControl('/api/video/edit', 'PUT'), true);
  assert.equal(isControl('/api/video/peaks', 'GET'), false);
});

test('이 PC 글꼴: 윈도에 등록된 것만(맑은 고딕은 있어야)', { skip: process.platform !== 'win32' && '윈도 전용' }, () => {
  const list = listFonts();
  assert.ok(list.length > 5);
  assert.ok(list.some((f) => /Malgun Gothic/.test(f.family)), '맑은 고딕');
});

const FF = tools({});
test('서버: 영상으로 새 편집(SRT → 자막)·저장 충돌·SRT·파형·렌더(자막 포함)', { skip: (!FF.ffmpeg || !FF.ffprobe) && 'ffmpeg 없음', timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-video-'));
  const media = path.join(dir, '영상 시험'), data = path.join(dir, 'data');
  fs.mkdirSync(media, { recursive: true }); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(data, 'file-access.json'), JSON.stringify({ allowAll: true }));
  const video = path.join(media, '원본.mp4');
  const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*330*t)*between(mod(t,2),0.5,1.5)':s=48000:d=4", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  fs.writeFileSync(path.join(media, '원본.srt'), '1\n00:00:00,500 --> 00:00:01,500\n첫 자막\n\n2\n00:00:02,500 --> 00:00:03,500\n둘째 자막\n');
  const port = await freePort();
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...cfg, port }));
  const env = { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: data, HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: path.join(dir, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opt = {}) => { const res = await fetch(base + p, { ...opt, headers: { 'Content-Type': 'application/json' } }); const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, body: j }; };
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/hub/version'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    const made = await call('/api/video/new', { method: 'POST', body: JSON.stringify({ video }) });
    assert.equal(made.status, 201, JSON.stringify(made.body)); assert.match(made.body.path, /원본\.oddin-edit\.json$/); assert.ok(made.body.srt);
    const again = await call('/api/video/new', { method: 'POST', body: JSON.stringify({ video }) });
    assert.equal(again.body.existed, true, '같은 이름이 있으면 그것을 연다');
    const f = made.body.path, q = `?path=${encodeURIComponent(f)}`;
    const e = (await call(`/api/video/edit${q}`)).body;
    assert.equal(e.doc.width, 640); assert.equal(e.doc.fps, 30);
    const txt = e.doc.tracks.find((t) => t.kind === 'text');
    assert.deepEqual(txt.items.map((i) => i.text), ['첫 자막', '둘째 자막']);
    // 저장 → 다른 곳에서 바뀐 뒤 옛 mtime 으로 저장하면 409
    txt.items[0].anim = { in: 'pop', out: 'fade', inDur: 0.2, outDur: 0.15 };
    e.doc.tracks[0].clips[0].keys = { scale: [{ t: 1, v: 1, ease: 'snap' }, { t: 1.3, v: 1.3, ease: 'hold' }] };
    const s1 = await call('/api/video/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: e.doc, baseMtime: e.mtime }) });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const stale = await call('/api/video/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: e.doc, baseMtime: e.mtime }) });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'CHANGED');
    assert.equal((await call('/api/video/edit', { method: 'PUT', body: JSON.stringify({ path: path.join(media, 'x.json'), doc: e.doc }) })).status, 400, '편집 파일 이름이 아니면 거절');
    assert.equal((await call(`/api/video/mtime${q}`)).body.mtime, s1.body.mtime);
    assert.match((await call(`/api/video/srt${q}`)).body, /00:00:00,500 --> 00:00:01,500\n첫 자막/);
    const pk = (await call(`/api/video/peaks?path=${encodeURIComponent(video)}`)).body;
    const b = Buffer.from(pk.peaks, 'base64');
    assert.ok(Math.abs(b.length - 400) <= 2, `파형 개수 ${b.length}`); assert.equal(b[20], 0); assert.ok(b[100] > 40, '소리 있는 곳');
    // 렌더(자막은 ODDIN 브라우저로 그림 — 브라우저가 없으면 자막 없이)
    if (!findBrowser()) { txt.items = []; const s2 = await call('/api/video/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: e.doc, baseMtime: s1.body.mtime }) }); assert.equal(s2.status, 200); }
    const rs = await call('/api/video/render', { method: 'POST', body: JSON.stringify({ path: f }) });
    assert.equal(rs.status, 202, JSON.stringify(rs.body));
    let st;
    for (let i = 0; i < 600; i++) { st = (await call('/api/video/renders')).body.find((x) => x.id === rs.body.id); if (st.status !== 'running') break; await new Promise((x) => setTimeout(x, 200)); }
    assert.equal(st.status, 'done', st.error || '');
    const pr = spawnSync(FF.ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,width,height', '-of', 'json', st.out], { encoding: 'utf8' });
    const streams = JSON.parse(pr.stdout).streams, vs = streams.find((x) => x.codec_type === 'video');
    assert.equal(Number(vs.nb_read_frames), 120); assert.equal(vs.width, 640); assert.ok(streams.some((x) => x.codec_type === 'audio'));
    assert.ok(!fs.existsSync(path.join(data, 'video-render', rs.body.id)), '조각 임시 폴더는 지운다');
  } finally {
    child.kill();
    await new Promise((x) => setTimeout(x, 500));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
});
