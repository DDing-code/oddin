// ODDIN 스튜디오(2026-10-10, docs/studio.md): 공용 코어(studio/ui/video-core.js)·ffmpeg 식·원본 넣기·프리미어 변환·허브 비추기·엔진 API·렌더
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
import { StudioLink } from '../lib/studio-link.mjs';
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

const FF = tools({});
test('엔진: 새 편집(SRT → 자막)·저장 충돌·요청 지키기·원본 넣기·목록·올리기·파형·허브 연결·렌더(그림·HTML 장면·자막)', { skip: (!FF.ffmpeg || !FF.ffprobe) && 'ffmpeg 없음', timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-studio-'));
  const media = path.join(dir, '영상 시험'), data = path.join(dir, 'data'), hubData = path.join(dir, 'hub-data');
  for (const d of [media, data, hubData, path.join(dir, 'runs')]) fs.mkdirSync(d, { recursive: true });
  const video = path.join(media, '원본.mp4');
  const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*330*t)*between(mod(t,2),0.5,1.5)':s=48000:d=4", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=black:s=120x60,format=rgba,geq=r=255:g=200:b=0:a='if(lt(X,10),0,230)'", '-frames:v', '1', path.join(media, '로고.png')], { windowsHide: true });
  fs.writeFileSync(path.join(media, '원본.srt'), '1\n00:00:00,500 --> 00:00:01,500\n첫 자막\n\n2\n00:00:02,500 --> 00:00:03,500\n둘째 자막\n');
  fs.writeFileSync(path.join(media, '장면.html'), '<!doctype html><html data-duration="1" data-width="640" data-height="360"><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}#b{position:absolute;left:0;top:300px;height:20px;background:#0f0;animation:g 1s linear both}@keyframes g{from{width:0}to{width:640px}}</style></head><body><div id="b"></div></body></html>');
  const [port, hubPort] = [await freePort(), await freePort()];
  const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...cfg, port: hubPort, studio: { port } }));
  fs.writeFileSync(path.join(hubData, 'file-access.json'), JSON.stringify({ allowAll: true }));
  const engine = spawn(process.execPath, [fileURLToPath(new URL('../studio/engine/server.mjs', import.meta.url))], { env: { ...process.env, STUDIO_PORT: String(port), STUDIO_DATA_DIR: data, ODDIN_HUB: `http://127.0.0.1:${hubPort}`, HUB_CONFIG_FILE: path.join(dir, 'config.json') }, stdio: 'ignore' });
  const hub = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: { ...process.env, HUB_PORT: String(hubPort), HUB_DATA_DIR: hubData, HUB_RUNS_DIR: path.join(dir, 'runs'), HUB_CONFIG_FILE: path.join(dir, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opt = {}) => { const res = await fetch(base + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } }); const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, body: j }; };
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    // 요청 지키기: 다른 페이지 출처의 쓰기·다른 Host 는 거절
    assert.equal((await call('/api/blank', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } })).status, 403);
    const badHost = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'evil.example' } }, (x) => { x.resume(); res(x.statusCode); }); q.end(); });
    assert.equal(badHost, 403);
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
