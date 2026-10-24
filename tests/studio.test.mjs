// ODDIN 스튜디오(2026-10-10, docs/studio.md): 공용 코어(studio/ui/video-core.js)·ffmpeg 식·원본 넣기·프리미어 변환·허브 비추기·엔진 API·렌더
// + 장면 출처 분리(2026-10-12): HTML 장면은 엔진과 다른 출처에서만 돌고, 엔진 API 는 다른 출처의 요청을 거절한다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './_port.mjs';
import { core, keyExpr, EASE_EXPR } from '../studio/engine/edit.mjs';
import { tools } from '../studio/engine/media.mjs';
import { listFonts, fontNames } from '../studio/engine/fonts.mjs';
import { premiereToEdit, sourceText, levelToDb } from '../studio/engine/premiere.mjs';
import { SceneOrigin } from '../studio/engine/scene-origin.mjs';
import { StudioLink } from '../lib/studio-link.mjs';
import { isControl } from '../lib/hub-auth.mjs';
import { BrowserManager, findBrowser } from '../lib/browser.mjs';

const V = core();
const plain = (v) => JSON.parse(JSON.stringify(v));
// 날것 요청: 주소를 정리하지 않고 그대로 보낸다(fetch 는 .. 을 먼저 접고 Host·Sec-Fetch-* 머리를 못 바꾼다)
const rawReq = (port, p, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); });
  q.on('error', reject); q.end();
});
const encPath = (p) => String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
// ffmpeg 식을 JS 로 풀어 계산(if·lt·lte·gte·pow·sin·cos·sqrt·max·min·clip — 2026-10-24 새 이징까지)
function evalExpr(expr, t) {
  const js = expr.replace(/\bif\(/g, 'IF(').replace(/\blte\(/g, 'LTE(').replace(/\blt\(/g, 'LT(').replace(/\bgte\(/g, 'GTE(').replace(/\bclip\(/g, 'CLIP(').replace(/\b(pow|sin|cos|sqrt|max|min|abs)\(/g, 'Math.$1(');
  return new Function('t', 'IF', 'LT', 'LTE', 'GTE', 'CLIP', `return ${js};`)(t, (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0), (a, b) => (a <= b ? 1 : 0), (a, b) => (a >= b ? 1 : 0), (x, a, b) => Math.min(b, Math.max(a, x)));
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

test('편집 파일 정리: 빠진 값 채우기·없는 원본 빼기·원본 길이 넘으면 줄이기·원본 종류', () => {
  const { doc, problems } = V.normalize({
    width: 1080, height: 1920, fps: 30, media: { m1: { path: 'a.mp4', duration: 10, width: 1920, height: 1080 }, m2: { path: 'logo.PNG', width: 200, height: 80, duration: 5 }, m3: { path: 'intro.html', duration: 3 } },
    tracks: [
      { kind: 'video', clips: [{ id: 'c2', media: 'm1', start: 5, in: 8, out: 15 }, { id: 'c1', media: 'm1', start: 0, in: 0, out: 5 }, { id: 'bad', media: 'nope', start: 0 }, { id: 'g', media: 'm2', start: 1, in: 0, out: 30, fit: 'none' }] },
      { kind: 'text', items: [{ start: 3, end: 1, text: '거꾸로' }, { start: 1, end: 2, text: '첫째', anim: { in: 'pop', out: '이상한값' } }] },
      { kind: 'weird' },
    ],
  });
  const p = plain(problems).join(' ');
  assert.match(p, /없는 원본/); assert.match(p, /원본 길이를 넘어/); assert.match(p, /종류를 모르는 트랙/);
  const v = doc.tracks.find((t) => t.kind === 'video'), tx = doc.tracks.find((t) => t.kind === 'text');
  assert.deepEqual(plain(v.clips.map((c) => c.id)), ['c1', 'g', 'c2']);
  assert.equal(v.clips.find((c) => c.id === 'c2').out, 10);
  assert.deepEqual([doc.media.m1.kind, doc.media.m2.kind, doc.media.m3.kind], ['video', 'image', 'html']);
  assert.equal(doc.media.m2.duration, 0, '그림은 길이가 없다'); assert.equal(doc.media.m2.audio, false);
  assert.equal(v.clips.find((c) => c.id === 'g').out, 30, '그림 클립은 원본 길이에 묶이지 않는다');
  assert.equal(v.clips.find((c) => c.id === 'g').fit, 'none');
  assert.deepEqual(plain(V.fitSize(doc, doc.media.m2, 'none')), { w: 200, h: 80 });
  assert.equal(tx.items[0].text, '첫째'); assert.equal(tx.items[0].anim.out, 'none');
  assert.equal(V.duration(doc), 31);
});

test('원본 넣기(placeMedia): 빈 트랙·새 영상 트랙은 위로·소리만·그림 기본값·같은 원본 다시 쓰기', () => {
  const { doc } = V.normalize({ width: 1080, height: 1920, fps: 30, media: { m1: { path: 'a.mp4', duration: 10, width: 1080, height: 1920, audio: true } }, tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c1', media: 'm1', start: 0, in: 0, out: 10 }] }, { id: 't1', kind: 'text', items: [] }] });
  const vid = { kind: 'video', duration: 4, width: 1920, height: 1080, fps: 30, video: true, audio: true };
  const r1 = plain(V.placeMedia(doc, vid, { path: 'b.mp4', at: 2, trackId: 'v1' }));
  assert.notEqual(r1.track, 'v1', '자리가 차 있으면 다른 영상 트랙');
  assert.deepEqual(plain(doc.tracks.map((t) => t.kind)), ['video', 'video', 'text'], '새 영상 트랙은 마지막 영상 트랙 바로 뒤(위에 그려짐)');
  const r2 = plain(V.placeMedia(doc, vid, { path: 'b.mp4', at: 20 }));
  assert.equal(r2.media, r1.media, '같은 경로면 원본 항목을 다시 쓴다'); assert.equal(r2.track, 'v1', '빈 자리가 있는 첫 영상 트랙');
  const snd = plain(V.placeMedia(doc, { kind: 'video', duration: 3, width: 0, height: 0, video: false, audio: true }, { path: 'bgm.mp3', at: 0 }));
  assert.equal(doc.tracks.find((t) => t.id === snd.track).kind, 'audio', '소리 파일은 소리 트랙');
  const onAudio = plain(V.placeMedia(doc, vid, { path: 'c.mp4', at: 5, trackId: snd.track }));
  assert.equal(onAudio.track, snd.track, '영상 원본을 소리 트랙에 놓으면 소리만');
  const img = plain(V.placeMedia(doc, { kind: 'image', width: 300, height: 120 }, { path: 'logo.png', at: 1.01 }));
  const ic = doc.tracks.find((t) => t.id === img.track).clips.find((c) => c.id === img.clip);
  assert.deepEqual([ic.start, ic.out - ic.in, ic.fit], [1, 3, 'none'], '그림: 프레임에 붙인 시작·3초·원래 크기');
  const big = plain(V.placeMedia(doc, { kind: 'image', width: 4000, height: 3000 }, { path: 'big.jpg', at: 40, length: 2 }));
  assert.equal(doc.tracks.find((t) => t.id === big.track).clips.find((c) => c.id === big.clip).fit, 'contain');
  const n = V.normalize(plain(doc)); assert.deepEqual(plain(n.problems), [], '넣은 뒤에도 형식이 맞다');
});

test('SRT 를 자막 트랙으로(srtTrack)·자막 점검(textChecks)', () => {
  const { doc } = V.normalize({ width: 1080, height: 1920, fps: 30, tracks: [{ id: 't1', kind: 'text', name: '자막', items: [] }] });
  const r = plain(V.srtTrack(doc, '1\n00:00:00,500 --> 00:00:01,000\n하나\n\n2\n00:00:01,100 --> 00:00:02,000\n둘\n줄\n\n3\n00:00:01,900 --> 00:00:03,000\n셋\n', '자막'));
  assert.deepEqual([r.track, r.count], ['t1', 3], '같은 이름 트랙이면 바꾼다');
  const c = plain(V.textChecks(doc));
  assert.equal(c.gaps.length, 1); assert.equal(c.gaps[0].frames, 3);
  assert.equal(c.overlaps.length, 1); assert.equal(c.twoLines.length, 1);
  const r2 = plain(V.srtTrack(doc, '1\n00:00:05,000 --> 00:00:06,000\n효과음\n', '효과'));
  assert.notEqual(r2.track, 't1', '이름이 다르면 새 자막 트랙');
});

test('SRT 읽기·쓰기 되돌림', () => {
  const srt = '1\n00:00:01,500 --> 00:00:03,000\n첫 줄\n둘째 줄\n\n2\n00:01:02,040 --> 00:01:04,000\n다음\n';
  const items = plain(V.parseSrt(srt));
  assert.deepEqual(items.map((i) => [i.start, i.end]), [[1.5, 3], [62.04, 64]]);
  assert.deepEqual(plain(V.parseSrt(V.toSrt(items))), items);
  assert.equal(V.fmtTime(62.04, 25), '01:02:01');
});

test('프리미어 가져오기: 크기·fps·컷·모션·키프레임·불투명도·소리 크기·글자·마커·못 옮긴 것 알림', () => {
  const motion = (pos, scale, rot, keys = {}) => ({ mn: 'AE.ADBE Motion', dn: 'Motion', props: [{ dn: 'Position', v: pos, keys: keys.pos || [] }, { dn: 'Scale', v: scale, keys: keys.scale || [] }, { dn: 'Scale Width', v: 100, keys: [] }, { dn: 'Uniform Scale', v: true, keys: [] }, { dn: 'Rotation', v: rot, keys: [] }] });
  const seq = {
    id: '7', name: '먹방 1편', project: 'D:/작업/먹방.prproj', width: 1080, height: 1920, fps: 254016000000 / 8475667200, // 29.97
    video: [
      { name: 'V1', muted: false, clips: [
        { name: 'a', start: 0, end: 2, inPoint: 10, outPoint: 12, media: 'D:/원본/a.mp4', speed: 1, comps: [{ mn: 'AE.ADBE Opacity', dn: '불투명도', props: [{ dn: '불투명도', v: 80, keys: [] }] }, motion([0.5, 0.75], 120, 5, { scale: [{ t: 10.5, v: 100 }, { t: 11, v: 130 }] })] },
        { name: 'b', start: 2, end: 3, inPoint: 0, outPoint: 1, media: 'D:/원본/b.mp4', speed: 2, comps: [] },
        { name: 'off', start: 3, end: 4, inPoint: 0, outPoint: 1, media: 'D:/원본/a.mp4', disabled: true, comps: [] },
        { name: '그래픽', start: 0.5, end: 1.5, inPoint: 0, outPoint: 1, media: '', comps: [{ mn: 'AE.ADBE Text', dn: 'Text', props: [{ dn: 'Source Text', v: JSON.stringify({ textEditValue: '맛있다!' }), keys: [] }] }, motion([0.5, 0.5], 100, 0)] },
      ] },
    ],
    audio: [{ name: 'A1', muted: false, clips: [{ name: 'a', start: 0, end: 2, inPoint: 10, outPoint: 12, media: 'D:/원본/a.mp4', comps: [{ mn: 'audioVolume', dn: 'Volume', props: [{ dn: 'Bypass', v: false }, { dn: 'Level', v: 0.17782794 * 2, keys: [] }] }] }] }],
    markers: [{ t: 1.25, name: '웃음', comment: '' }],
  };
  const probes = new Map([[path.resolve('D:/원본/a.mp4'), { kind: 'video', duration: 60, width: 1920, height: 1080, fps: 29.97, audio: true }], [path.resolve('D:/원본/b.mp4'), { kind: 'video', duration: 5, width: 1080, height: 1920, fps: 30, audio: true }]]);
  const { doc, problems } = premiereToEdit(seq, probes, 'D:/작업/먹방 1편.oddin-edit.json', { relOrAbs: (e, f) => f });
  assert.deepEqual([doc.width, doc.height, doc.fps], [1080, 1920, 29.97]);
  const v1 = doc.tracks.find((t) => t.id === 'v1');
  assert.equal(v1.muted, true, '영상 트랙 소리는 끄고 소리 트랙이 낸다');
  assert.equal(v1.clips.length, 2, '꺼 둔 클립·파일 없는 클립은 뺀다');
  const a = v1.clips[0];
  assert.deepEqual([a.start, a.in, a.out, a.fit, a.scale, a.rotation, a.opacity, a.x, a.y], [0, 10, 12, 'none', 1.2, 5, 0.8, 0, 480]);
  assert.deepEqual(a.keys.scale, [{ t: 0.5, v: 1, ease: 'linear' }, { t: 1, v: 1.3, ease: 'linear' }], '키프레임 시각은 클립 시작 기준');
  const tx = doc.tracks.find((t) => t.kind === 'text');
  assert.equal(tx.items[0].text, '맛있다!');
  const a1 = doc.tracks.find((t) => t.kind === 'audio');
  assert.ok(Math.abs(a1.clips[0].volume - 6) < 0.2, `소리 크기 +6dB 근처: ${a1.clips[0].volume}`);
  assert.deepEqual(doc.markers.map((m) => [m.t, m.label]), [[1.25, '웃음']]);
  const pj = problems.join(' / ');
  for (const re of [/꺼 둔 클립/, /속도/, /캡션 트랙/, /키프레임/]) assert.match(pj, re);
  const n = V.normalize(doc); assert.deepEqual(plain(n.problems), []);
  assert.equal(sourceText('그냥 글'), '그냥 글'); assert.equal(levelToDb(0.17782794), 0); assert.equal(levelToDb(0), -60);
});

test('원격 문지기: 스튜디오 비춤의 바꾸기·켜기·설치는 제어, 보기는 아님', () => {
  assert.equal(isControl('/studio/api/render', 'POST'), true);
  assert.equal(isControl('/studio/api/edit', 'PUT'), true);
  assert.equal(isControl('/studio/api/peaks', 'GET'), false);
  assert.equal(isControl('/api/studio/start', 'POST'), true);
  assert.equal(isControl('/api/studio/install', 'POST'), true);
  assert.equal(isControl('/api/studio/status', 'GET'), false);
});

test('이 PC 글꼴: 윈도에 등록된 것만(맑은 고딕은 있어야)', { skip: process.platform !== 'win32' && '윈도 전용' }, () => {
  const list = listFonts();
  assert.ok(list.length > 5);
  assert.ok(list.some((f) => /Malgun Gothic/.test(f.family)), '맑은 고딕');
  const malgun = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'malgun.ttf');
  if (fs.existsSync(malgun)) assert.ok(fontNames(malgun).some((n) => n.family === 'Malgun Gothic' && n.ko === '맑은 고딕'));
});

test('허브 비추기(StudioLink.proxy): 원격 표시·클라이언트 x-oddin 머리 지우기·문서에 화면 쿠키·꺼져 있으면 안내', async () => {
  const port = await freePort();
  let seen = null;
  const up = http.createServer((req, res) => { seen = { url: req.url, h: req.headers }; res.writeHead(200, { 'Content-Type': req.url.startsWith('/api') ? 'application/json' : 'text/html; charset=utf-8' }); res.end(req.url.startsWith('/api') ? '{"ok":true}' : '<html></html>'); });
  await new Promise((r) => up.listen(port, '127.0.0.1', r));
  const link = new StudioLink({ root: path.resolve(fileURLToPath(new URL('..', import.meta.url))), port });
  const hubPort = await freePort();
  const hub = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); link.proxy(req, res, { pathname: u.pathname, search: u.search, remote: req.headers['x-test-remote'] === '1', cookie: 'oddin_ui=t; Path=/' }); });
  await new Promise((r) => hub.listen(hubPort, '127.0.0.1', r));
  try {
    const r1 = await fetch(`http://127.0.0.1:${hubPort}/studio/?path=a`, { headers: { 'x-oddin-remote': '0', 'x-oddin-via': 'evil', 'x-test-remote': '1' } });
    assert.equal(r1.status, 200); assert.match(r1.headers.get('set-cookie') || '', /oddin_ui=t/);
    assert.equal(seen.url, '/?path=a'); assert.equal(seen.h['x-oddin-remote'], '1', '원격이면 1(클라이언트 값 무시)'); assert.equal(seen.h['x-oddin-via'], 'hub'); assert.equal(seen.h.host, `127.0.0.1:${port}`);
    const r2 = await fetch(`http://127.0.0.1:${hubPort}/studio/api/status`);
    assert.equal(r2.headers.get('set-cookie'), null, 'API 응답에는 쿠키를 주지 않는다'); assert.equal(seen.h['x-oddin-remote'], '0');
    up.close(); await new Promise((r) => setTimeout(r, 100));
    const r3 = await fetch(`http://127.0.0.1:${hubPort}/studio/`);
    assert.equal(r3.status, 503); assert.match(await r3.text(), /스튜디오가 꺼져 있어요/);
  } finally { up.close(); hub.close(); }
  link.hello({ port, version: '9.9', pid: 1, app: { windows: 2 } });
  assert.deepEqual([link.status().online, link.status().windows, link.status().version], [true, 2, '9.9']);
});

test('장면 출처: 등록한 루트 안 파일만 내준다 — 밖·..·절대 경로·정션 너머·모르는 토큰·다른 Host·쓰기는 거절, .html 에는 시각 맞춤 스크립트', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-scene-origin-'));
  const root = path.join(dir, '편집 폴더'), sub = path.join(root, '장면'), out = path.join(dir, '밖');
  for (const d of [sub, out]) fs.mkdirSync(d, { recursive: true });
  const edit = path.join(root, '시험.oddin-edit.json'), scene = path.join(sub, '장면.html'), png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  fs.writeFileSync(edit, '{}');
  fs.writeFileSync(scene, '<!doctype html><html><body><p>장면</p></body></html>');
  fs.writeFileSync(path.join(sub, '조각.html'), '<p>몸통 없음</p>');
  fs.writeFileSync(path.join(root, '그림.png'), png);
  fs.writeFileSync(path.join(out, '비밀.txt'), 'secret');
  fs.writeFileSync(path.join(out, '밖 장면.html'), '<html><body></body></html>');
  let linked = true; try { fs.symlinkSync(out, path.join(root, '바로가기'), 'junction'); } catch { linked = false; }
  const so = new SceneOrigin({ port: await freePort() }), port = await so.start();
  const rel = (url) => decodeURIComponent(new URL(url).pathname).split('/').slice(3).join('/');
  try {
    // 주소: 편집 파일 폴더 안의 장면은 그 폴더가 루트(편집 폴더의 그림을 같이 쓴다). 편집 파일을 안 주거나 장면이 그 밖에 있으면 장면 파일의 폴더
    const u = new URL(so.urlFor(scene, edit)), tok = u.pathname.split('/')[2];
    assert.equal(u.origin, `http://127.0.0.1:${port}`); assert.match(tok, /^[0-9a-f]{24}$/); assert.equal(rel(u), '장면/장면.html');
    assert.equal(so.urlFor(scene, edit), u.href, '같은 폴더는 같은 토큰');
    assert.equal(rel(so.urlFor(scene)), '장면.html'); assert.notEqual(new URL(so.urlFor(scene)).pathname.split('/')[2], tok);
    assert.equal(rel(so.urlFor(path.join(out, '밖 장면.html'), edit)), '밖 장면.html', '편집 폴더 밖의 장면은 제 폴더가 루트');
    assert.notEqual(new SceneOrigin().mount(root), tok, '토큰은 엔진을 켤 때 만든 비밀값에 묶인다(밖에서 못 맞힌다)');
    // .html: 시각 맞춤 스크립트와 postMessage 다리를 </body> 앞에(없으면 끝에). 여기서는 스크립트가 돌아야 하니 sandbox 를 붙이지 않는다
    const h = await rawReq(port, u.pathname), html = h.body.toString('utf8');
    assert.equal(h.status, 200); assert.match(h.headers['content-type'], /^text\/html/); assert.equal(h.headers['x-content-type-options'], 'nosniff'); assert.equal(h.headers['content-security-policy'], undefined);
    assert.ok(html.startsWith('<!doctype html><html><body><p>장면</p>'), '원래 내용은 그대로'); assert.equal(Number(h.headers['content-length']), h.body.length);
    for (const s of ['__oddinSeekAny', 'oddinSeek', 'oddinSeeked', 'oddinSceneReady']) assert.ok(html.includes(s), s);
    const at = html.indexOf('<script data-oddin-seek>'); assert.ok(at > 0 && at < html.lastIndexOf('</body>'), '</body> 앞');
    const frag = (await rawReq(port, `/m/${tok}/${encPath('장면/조각.html')}`)).body.toString('utf8');
    assert.ok(frag.startsWith('<p>몸통 없음</p>') && frag.trimEnd().endsWith('</script>'), '</body> 가 없으면 끝에');
    const head = await rawReq(port, u.pathname, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    // 같은 루트의 다른 파일(그림·구간 요청), localhost 이름으로도
    const g = await rawReq(port, `/m/${tok}/${encPath('그림.png')}`);
    assert.equal(g.status, 200); assert.equal(g.headers['content-type'], 'image/png'); assert.deepEqual(g.body, png); assert.equal(g.headers['x-content-type-options'], 'nosniff');
    const part = await rawReq(port, `/m/${tok}/${encPath('그림.png')}`, { headers: { Range: 'bytes=1-3' } });
    assert.equal(part.status, 206); assert.deepEqual(part.body, png.subarray(1, 4));
    assert.equal((await rawReq(port, u.pathname, { headers: { Host: `localhost:${port}` } })).status, 200);
    // 거절: 루트 밖으로 나가려는 주소(.. · 인코딩한 .. · 역슬래시 · 절대 경로 · 빈 칸), 모르는 토큰, 폴더, 없는 파일, API·화면 주소(여기에는 없다)
    const secret = encPath('밖/비밀.txt');
    const bad = [`/m/${tok}/../${secret}`, `/m/${tok}/%2e%2e/${secret}`, `/m/${tok}/..%2f${secret}`, `/m/${tok}/..%5c${secret}`, `/m/${tok}/${encPath('장면')}/../../${secret}`,
      `/m/${tok}/${encodeURIComponent(path.join(out, '비밀.txt'))}`, `/m/${tok}/${encPath(path.join(out, '비밀.txt'))}`, `/m/${tok}//${secret}`,
      `/m/${'0'.repeat(24)}/${encPath('그림.png')}`, `/m/${tok}`, `/m/${tok}/`, `/m/${tok}/${encPath('장면')}`, `/m/${tok}/${encPath('없는 파일.png')}`, '/api/status', '/api/file?path=x', '/', '/ui/editor.js'];
    if (linked) { bad.push(`/m/${tok}/${encPath('바로가기/비밀.txt')}`); assert.equal(fs.readFileSync(path.join(root, '바로가기', '비밀.txt'), 'utf8'), 'secret', '정션은 이어져 있다(그래도 거절해야 한다)'); }
    for (const p of bad) assert.equal((await rawReq(port, p)).status, 404, p);
    assert.equal((await rawReq(port, u.pathname, { headers: { Host: 'evil.example' } })).status, 403, '다른 이름으로 들어온 요청(DNS 리바인딩)');
    assert.equal((await rawReq(port, u.pathname, { headers: { Host: `127.0.0.1:${port + 1}` } })).status, 403);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await rawReq(port, u.pathname, { method })).status, 405, method);
    // 쓰는 중인 포트를 달라고 하면 빈 포트를 잡는다
    const second = new SceneOrigin({ port }), p2 = await second.start(); second.stop(); assert.ok(p2 > 0 && p2 !== port);
  } finally { so.stop(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
});

test('장면 출처: 다른 출처의 iframe 에 postMessage 로 시각을 맞춘다 — 부모와 장면은 서로의 안을 못 만진다', { skip: !findBrowser() && '브라우저(Edge·Chrome) 없음', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-scene-msg-'));
  fs.mkdirSync(path.join(dir, 'scene'));
  // 부모 화면 노릇(스튜디오 화면처럼 127.0.0.1 의 다른 포트). 장면이 여기 /api 로 보낸 요청의 Sec-Fetch-Site 도 적어 둔다 — 엔진이 거절하는 값이어야 한다
  let probeSite = null;
  const host = http.createServer((req, res) => { if (req.url.startsWith('/api/probe')) probeSite = req.headers['sec-fetch-site'] ?? '(없음)'; res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><head><title>부모</title></head><body></body></html>'); });
  const hostPort = await freePort(); await new Promise((r) => host.listen(hostPort, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'scene', '장면.html'), [
    '<!doctype html><html data-duration="1" data-width="640" data-height="360"><head><meta charset="utf-8">',
    '<style>html,body{margin:0}#b{position:absolute;left:0;top:0;height:20px;background:#0f0;animation:g 1s linear both}@keyframes g{from{width:0}to{width:640px}}</style></head><body><div id="b"></div><script>',
    'let touched = "blocked"; try { touched = "read:" + parent.document.title; } catch (e) {}',
    `fetch("http://127.0.0.1:${hostPort}/api/probe", { mode: "no-cors" }).catch(() => {});`,
    'addEventListener("message", (e) => { if (e.data && e.data.measure) e.source.postMessage({ width: document.getElementById("b").getBoundingClientRect().width, touched }, "*"); });',
    '</script></body></html>'].join('\n'));
  const so = new SceneOrigin({ port: await freePort() }); await so.start();
  const B = new BrowserManager({ profile: path.join(dir, 'profile'), headless: true, width: 800, height: 600 });
  try {
    const url = so.urlFor(path.join(dir, 'scene', '장면.html'));
    const tab = await B.tabOf('scene-test');
    const nav = await B.send('Page.navigate', { url: `http://127.0.0.1:${hostPort}/` }, tab.session, 30_000); assert.ok(!nav.errorText, nav.errorText);
    for (let i = 0; i < 100; i++) { try { if (await B.evaluate(tab, 'document.readyState === "complete" && document.title === "부모"')) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    // 편집기 미리보기와 같은 흐름: 준비 알림을 기다렸다가 → 시각 보내기 → 끝났다는 답 → (시험용) 막대 너비 묻기
    const out = await B.evaluate(tab, `new Promise((resolve) => {
      const out = { ready: false, origin: null, inside: null, seeked: null, width: null, touched: null };
      const f = document.createElement('iframe'); f.style.cssText = 'width:640px;height:360px;border:0';
      addEventListener('message', (e) => {
        if (e.source !== f.contentWindow) return; const d = e.data || {};
        if (d.oddinSceneReady) { out.ready = true; out.origin = e.origin; try { out.inside = 'read:' + f.contentWindow.document.title; } catch (x) { out.inside = 'blocked'; } f.contentWindow.postMessage({ oddinSeek: 0.5, id: 7 }, e.origin); }
        else if (d.oddinSeeked != null) { out.seeked = [d.oddinSeeked, d.id]; f.contentWindow.postMessage({ measure: true }, '*'); }
        else if (d.width != null) { out.width = d.width; out.touched = d.touched; resolve(out); }
      });
      f.src = ${JSON.stringify(url)}; document.body.appendChild(f);
      setTimeout(() => resolve(out), 30000);
    })`, 60_000);
    assert.equal(out.ready, true, '장면이 다 읽히면 준비됐다고 알린다'); assert.equal(out.origin, so.origin);
    assert.equal(out.inside, 'blocked', '부모는 장면 안을 직접 못 만진다(그래서 postMessage)');
    assert.deepEqual(out.seeked, [0.5, 7], '시각을 맞추면 같은 id 로 답한다');
    assert.ok(Math.abs(out.width - 320) < 2, `0.5초에 막대가 반: ${out.width}`);
    assert.equal(out.touched, 'blocked', '장면은 부모 화면을 못 만진다');
    for (let i = 0; i < 30 && probeSite == null; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(probeSite, 'same-site', '장면이 127.0.0.1 의 다른 포트로 보낸 요청은 same-site — 엔진이 거절하는 값');
  } finally {
    try { await B.stop(); } catch {}
    so.stop(); host.close();
    // 브라우저 프로필은 꺼진 뒤에도 잠깐 잠겨 있다 — 통째로 다시 지워 본다(rmSync 의 maxRetries 는 새로 생긴 파일을 못 따라가 17초를 쓰고도 남겼다)
    for (let i = 0; i < 20; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  }
});

const FF = tools({});
test('엔진: 새 편집(SRT → 자막)·저장 충돌·요청 지키기(다른 출처·HTML sandbox·장면 출처)·원본 넣기·목록·올리기·파형·허브 연결·렌더(그림·HTML 장면·자막)', { skip: (!FF.ffmpeg || !FF.ffprobe) && 'ffmpeg 없음', timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-studio-'));
  const media = path.join(dir, '영상 시험'), data = path.join(dir, 'data'), hubData = path.join(dir, 'hub-data');
  for (const d of [media, data, hubData, path.join(dir, 'runs')]) fs.mkdirSync(d, { recursive: true });
  const video = path.join(media, '원본.mp4');
  const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*330*t)*between(mod(t,2),0.5,1.5)':s=48000:d=4", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=black:s=120x60,format=rgba,geq=r=255:g=200:b=0:a='if(lt(X,10),0,230)'", '-frames:v', '1', path.join(media, '로고.png')], { windowsHide: true });
  fs.writeFileSync(path.join(media, '원본.srt'), '1\n00:00:00,500 --> 00:00:01,500\n첫 자막\n\n2\n00:00:02,500 --> 00:00:03,500\n둘째 자막\n');
  fs.writeFileSync(path.join(media, '장면.html'), '<!doctype html><html data-duration="1" data-width="640" data-height="360"><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}#b{position:absolute;left:0;top:300px;height:20px;background:#0f0;animation:g 1s linear both}@keyframes g{from{width:0}to{width:640px}}</style></head><body><div id="b"></div></body></html>');
  // 장면 출처 포트도 따로 정한다(기본값 = 엔진 포트 + 1 은 바로 옆에서 잡은 허브 포트와 겹칠 수 있다)
  const [port, hubPort, scenePort] = [await freePort(), await freePort(), await freePort()];
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...cfg, port: hubPort, studio: { port } }));
  fs.writeFileSync(path.join(hubData, 'file-access.json'), JSON.stringify({ allowAll: true }));
  const engine = spawn(process.execPath, [fileURLToPath(new URL('../studio/engine/server.mjs', import.meta.url))], { env: { ...process.env, STUDIO_PORT: String(port), STUDIO_SCENE_PORT: String(scenePort), STUDIO_DATA_DIR: data, ODDIN_HUB: `http://127.0.0.1:${hubPort}`, HUB_CONFIG_FILE: path.join(dir, 'config.json') }, stdio: 'ignore' });
  const hub = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, HUB_PORT: String(hubPort), HUB_DATA_DIR: hubData, HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: path.join(dir, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opt = {}) => { const res = await fetch(base + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } }); const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, body: j }; };
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    // 요청 지키기: 다른 페이지 출처의 쓰기·다른 Host 는 거절
    assert.equal((await call('/api/blank', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } })).status, 403);
    const badHost = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'evil.example' } }, (x) => { x.resume(); res(x.statusCode); }); q.end(); });
    assert.equal(badHost, 403);
    // 브라우저가 다른 출처의 페이지에서 보낸 요청(Sec-Fetch-Site)은 API 읽기도 거절 — 이 화면(same-origin)·주소창(none)·브라우저 아닌 호출(머리 없음)·허브가 비춘 요청은 통과
    for (const [site, want] of [['cross-site', 403], ['same-site', 403], ['same-origin', 200], ['none', 200]]) assert.equal((await rawReq(port, '/api/status', { headers: { 'Sec-Fetch-Site': site } })).status, want, site);
    assert.equal((await rawReq(port, '/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site', 'x-oddin-via': 'hub' } })).status, 200, '허브가 비춘 요청은 허브가 이미 걸렀다');
    assert.equal((await rawReq(port, '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, '화면 문서는 다른 곳의 링크로도 열린다(API 만 막는다)');
    const made = await call('/api/new', { method: 'POST', body: JSON.stringify({ video }) });
    assert.equal(made.status, 201, JSON.stringify(made.body)); assert.match(made.body.path, /원본\.oddin-edit\.json$/); assert.ok(made.body.srt);
    assert.equal((await call('/api/new', { method: 'POST', body: JSON.stringify({ video }) })).body.existed, true);
    const f = made.body.path, q = `?path=${encodeURIComponent(f)}`;
    const e = (await call(`/api/edit${q}`)).body;
    assert.equal(e.doc.width, 640); assert.deepEqual(e.doc.tracks.find((t) => t.kind === 'text').items.map((i) => i.text), ['첫 자막', '둘째 자막']);
    e.doc.tracks[0].clips[0].keys = { scale: [{ t: 1, v: 1, ease: 'snap' }, { t: 1.3, v: 1.3, ease: 'hold' }] };
    const s1 = await call('/api/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: e.doc, baseMtime: e.mtime }) });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    const stale = await call('/api/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: e.doc, baseMtime: e.mtime }) });
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'CHANGED');
    // 원본 넣기(그림·HTML 장면) — 명령줄 add 와 같은 API
    const add = await call('/api/add', { method: 'POST', body: JSON.stringify({ path: f, files: [path.join(media, '로고.png'), path.join(media, '장면.html')], at: 1 }) });
    assert.equal(add.status, 200, JSON.stringify(add.body)); assert.equal(add.body.placed.length, 2);
    assert.deepEqual(add.body.placed.map((x) => [x.start, x.end]), [[1, 4], [4, 5]]);
    const chk = (await call(`/api/check${q}`)).body; assert.equal(chk.missingMedia.length, 0); assert.equal(chk.duration, 5);
    // 장면 출처 분리: 엔진 출처로 내주는 HTML 은 스크립트 없이 보기만(sandbox), 스크립트가 도는 장면 주소는 다른 포트(파일 읽기만)
    const sceneFile = path.join(media, '장면.html');
    const rawHtml = await rawReq(port, `/api/raw/${encPath(sceneFile)}`);
    assert.equal(rawHtml.status, 200); assert.equal(rawHtml.headers['content-security-policy'], 'sandbox');
    assert.equal((await rawReq(port, `/api/file?path=${encodeURIComponent(sceneFile)}`)).headers['content-security-policy'], 'sandbox');
    const rawPng = await rawReq(port, `/api/raw/${encPath(path.join(media, '로고.png'))}`);
    assert.equal(rawPng.status, 200); assert.equal(rawPng.headers['content-security-policy'], undefined, '그림·영상은 그대로');
    for (const p of ['/', '/ui/render.html']) assert.equal((await rawReq(port, p)).headers['content-security-policy'], undefined, `스튜디오 화면(${p})은 그대로`);
    assert.equal((await call('/api/status')).body.scenePort, scenePort);
    const su = (await call(`/api/scene-url?path=${encodeURIComponent(sceneFile)}&edit=${encodeURIComponent(f)}`)).body;
    assert.equal(su.live, true); const sUrl = new URL(su.url);
    assert.equal(sUrl.origin, `http://127.0.0.1:${scenePort}`); assert.match(decodeURIComponent(sUrl.pathname), /^\/m\/[0-9a-f]{24}\/장면\.html$/);
    const served = await rawReq(scenePort, sUrl.pathname);
    assert.equal(served.status, 200); assert.ok(served.body.toString('utf8').includes('__oddinSeekAny'), '시각 맞춤 스크립트를 넣어 내준다'); assert.equal(served.headers['content-security-policy'], undefined);
    assert.equal((await rawReq(scenePort, sUrl.pathname.replace(/[^/]+$/, encodeURIComponent('로고.png')))).status, 200, '같은 루트(편집 파일 폴더)의 그림');
    assert.equal((await rawReq(scenePort, '/api/status')).status, 404, '장면 출처에는 API 가 없다');
    assert.equal((await call(`/api/scene-url?path=${encodeURIComponent(path.join(media, '로고.png'))}`)).status, 400, 'HTML 장면만');
    const ls = (await call(`/api/list?path=${encodeURIComponent(media)}`)).body;
    assert.deepEqual(ls.entries.map((x) => x.kind).sort(), ['edit', 'html', 'image', 'srt', 'video']);
    const up = await fetch(`${base}/api/upload?dir=${encodeURIComponent(media)}&name=${encodeURIComponent('올린 로고.png')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(path.join(media, '로고.png')) });
    assert.equal(up.status, 201); assert.ok(fs.existsSync(path.join(media, '올린 로고.png')));
    assert.equal((await fetch(`${base}/api/upload?dir=${encodeURIComponent(media)}&name=x.exe`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'MZ' })).status, 400, '미디어가 아닌 파일은 거절');
    const pk = (await call(`/api/peaks?path=${encodeURIComponent(video)}`)).body; const b = Buffer.from(pk.peaks, 'base64');
    assert.ok(Math.abs(b.length - 400) <= 2); assert.equal(b[20], 0); assert.ok(b[100] > 40);
    // 허브: 엔진이 알리면 켜짐, /studio/ 로 비춤(이 PC 요청이면 원격 아님)
    for (let i = 0; i < 100; i++) { try { const st = await fetch(`http://127.0.0.1:${hubPort}/api/studio/status`).then((x) => x.json()); if (st.online) break; } catch {} await new Promise((x) => setTimeout(x, 200)); }
    const hs = await fetch(`http://127.0.0.1:${hubPort}/api/studio/status`).then((x) => x.json());
    assert.equal(hs.online, true, '엔진이 허브에 자기를 알린다'); assert.equal(hs.port, port);
    const viaHub = await fetch(`http://127.0.0.1:${hubPort}/studio/api/status`).then((x) => x.json());
    assert.equal(viaHub.app, 'oddin-studio'); assert.equal(viaHub.remote, false);
    // 원격(허브가 x-oddin-remote 를 붙인 요청)은 이 PC의 장면 출처에 닿을 수 없다 → 스크립트 없는 보기 주소(live:false)
    const far = await rawReq(port, `/api/scene-url?path=${encodeURIComponent(sceneFile)}`, { headers: { 'x-oddin-via': 'hub', 'x-oddin-remote': '1' } });
    assert.equal(far.status, 200, far.body.toString()); const farUrl = JSON.parse(far.body);
    assert.equal(farUrl.live, false); assert.match(farUrl.url, /^api\/raw\/.+\.html$/);
    // 렌더(글자·장면은 브라우저로 — 없으면 둘 다 빼고)
    if (!findBrowser()) {
      const cur = (await call(`/api/edit${q}`)).body; cur.doc.tracks = cur.doc.tracks.filter((t) => t.kind !== 'text').map((t) => ({ ...t, clips: t.clips.filter((c) => cur.doc.media[c.media].kind !== 'html') }));
      assert.equal((await call('/api/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: cur.doc, baseMtime: cur.mtime }) })).status, 200);
    }
    const rs = await call('/api/render', { method: 'POST', body: JSON.stringify({ path: f }) });
    assert.equal(rs.status, 202, JSON.stringify(rs.body));
    let st;
    for (let i = 0; i < 900; i++) { st = (await call('/api/renders')).body.find((x) => x.id === rs.body.id); if (st.status !== 'running') break; await new Promise((x) => setTimeout(x, 200)); }
    assert.equal(st.status, 'done', st.error || '');
    const pr = spawnSync(FF.ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,width,height', '-of', 'json', st.out], { encoding: 'utf8' });
    const streams = JSON.parse(pr.stdout).streams, vs = streams.find((x) => x.codec_type === 'video');
    assert.equal(Number(vs.nb_read_frames), 150); assert.equal(vs.width, 640); assert.ok(streams.some((x) => x.codec_type === 'audio'));
    if (findBrowser()) { // 4.5초(장면 0.5초)의 초록 막대가 반쯤 자랐는지
      const px = spawnSync(FF.ffmpeg, ['-v', 'error', '-ss', '4.5', '-i', st.out, '-frames:v', '1', '-vf', 'crop=640:1:0:310,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout;
      const green = (x) => px[x * 3 + 1] > 180 && px[x * 3] < 90 && px[x * 3 + 2] < 90;
      assert.ok(green(100) && green(250), 'HTML 장면 막대 앞쪽'); assert.ok(!green(500), 'HTML 장면 막대는 아직 끝까지 안 자람');
    }
    assert.ok(!fs.existsSync(path.join(data, 'render', rs.body.id)), '조각 임시 폴더는 지운다');
  } finally {
    try { await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' }); } catch {}
    await new Promise((x) => setTimeout(x, 1500));
    engine.kill(); hub.kill();
    await new Promise((x) => setTimeout(x, 500));
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
});
