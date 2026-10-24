// 프로 기능(2026-10-24 사용자 "전부 다 넣어주고, 오딘 친화적으로만 해주면 돼", docs/studio.md "프로 기능"):
// 속도·램프·되감기·멈춤, 이징(베지어 포함), 전환, 효과, 섞기, 마스크·따라가기, 3D 기울이기·카메라, 모션 블러, 조정 레이어, 편집 안 편집,
// 글자 단위 움직임·도형·선 그리기, 트랙 소리(EQ·압축·잡음·자동 줄이기)·음량 맞추기, 출력 형식(H.265 10비트·ProRes 4444·VP9 투명·GIF)
// 미리보기(video-core.js)와 렌더(fx.mjs 식·sendcmd)가 같은 정의인지 식을 풀어 대조하고, 엔진으로 작은 영상을 실제로 뽑아 픽셀·소리를 잰다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './_port.mjs';
import { core, keyExpr, EASE_EXPR, opacityExpr, outputArgs } from '../studio/engine/edit.mjs';
import { transExprs, clipExprs, tiltFilter, maskCovExpr, sendcmdScript, rampSetpts } from '../studio/engine/fx.mjs';
import { duckExpr, trackFilters } from '../studio/engine/audio-mix.mjs';
import { simplify } from '../studio/engine/track.mjs';
import { tools } from '../studio/engine/media.mjs';
import { findBrowser } from '../lib/browser.mjs';

const V = core();
const plain = (v) => JSON.parse(JSON.stringify(v));
const FF = tools({});
// ffmpeg 식을 JS 로 풀어 계산
function ev(expr, vars = {}) {
  const js = String(expr).replace(/\bif\(/g, 'IF(').replace(/\blte\(/g, 'LTE(').replace(/\blt\(/g, 'LT(').replace(/\bgte\(/g, 'GTE(').replace(/\bgt\(/g, 'GT(').replace(/\bclip\(/g, 'CLIP(')
    .replace(/\b(pow|sin|cos|sqrt|max|min|abs|hypot|trunc)\(/g, 'Math.$1(').replace(/\bPI\b/g, 'Math.PI').replace(/\bin\b/g, 'IN');
  const names = Object.keys(vars).map((k) => (k === 'in' ? 'IN' : k));
  return new Function(...names, 'IF', 'LT', 'LTE', 'GT', 'GTE', 'CLIP', `return ${js};`)(...Object.values(vars), (c, a, b) => (c ? a : b), (a, b) => +(a < b), (a, b) => +(a <= b), (a, b) => +(a > b), (a, b) => +(a >= b), (x, a, b) => Math.min(b, Math.max(a, x)));
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('이징: 새 이징(사인·원형·뒤로·탄성·튕김)이 화면과 렌더 식에서 같고, 베지어 키는 잘게 나눈 직선으로 거의 같다', () => {
  for (const name of ['sine', 'circ', 'back', 'elastic', 'bounce']) for (let p = 0; p <= 1.0001; p += 0.05) near(V.EASE[name](p), ev(EASE_EXPR[name].replaceAll('P', `(${p})`)), 1e-9, `${name} p=${p}`);
  const keys = plain(V.normalize({ tracks: [{ kind: 'text', items: [{ text: 'a', keys: { x: [{ t: 0, v: 0, ease: 'bezier', bz: [0.7, 0, 0.3, 1] }, { t: 2, v: 100 }] } }] }] }).doc.tracks[0].items[0].keys.x);
  assert.deepEqual(keys[0].bz, [0.7, 0, 0.3, 1]);
  const ex = keyExpr(0, keys, 0);
  for (let t = 0; t <= 2; t += 0.05) near(V.valueAt(0, keys, t), ev(ex, { t }), 0.5, `bezier t=${t.toFixed(2)}`);
  near(V.bezierFn([0.42, 0, 0.58, 1])(0.5), 0.5, 1e-6, 'ease-in-out 가운데');
  assert.ok(V.bezierFn([0.7, 0, 0.3, 1])(0.2) < 0.1, '천천히 시작');
});

test('속도: 배속·속도 램프(∫속도)·되감기·멈춤의 길이와 원본 시각, 렌더 setpts 식', () => {
  const c = { start: 0, in: 1, out: 5, speed: 2 };
  near(V.clipLen(c), 2, 1e-9, '2배속 길이'); near(V.sourceTime(c, 0.5), 2, 1e-9, '0.5초 → 원본 2초');
  const rv = { start: 0, in: 1, out: 3, reverse: true };
  near(V.sourceTime(rv, 0.5), 2.5, 1e-9, '되감기'); near(V.clipLen(rv), 2, 1e-9);
  const fz = { start: 0, in: 2, out: 2.1, freeze: 1.5 };
  near(V.clipLen(fz), 1.5, 1e-9); near(V.sourceTime(fz, 1), 2, 1e-9);
  const rp = { start: 0, in: 0, out: 4, keys: { speed: [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 3 }] } }; // 1→3배 1초 동안: ∫ = lt + lt²
  near(V.srcOffset(rp, 0.5), 0.75, 1e-4, '램프 0.5초'); near(V.srcOffset(rp, 1), 2, 1e-4); near(V.clipLen(rp), 1 + 2 / 3, 1e-4, '램프 길이');
  const ex = rampSetpts(rp, 0.2, 1, 30);
  near(ex.srcStart, V.srcOffset(rp, 0.2), 1e-9, '조각 입력 시작');
  for (const o of [0.1, 0.4, 0.8]) { const u = V.srcOffset(rp, 0.2 + o) - V.srcOffset(rp, 0.2), body = ex.expr.match(/^setpts='\((.*)\)\/TB'$/)[1]; near(ev(body.replaceAll('(T-STARTT)', `(${u})`)), o, 2e-3, `setpts 역함수 o=${o}`); }
  // 정리: 예전 파일은 그대로(새 칸이 생기지 않음), 새 값은 범위 안으로
  const { doc } = V.normalize({ fps: 30, media: { m: { path: 'a.mp4', duration: 9, width: 10, height: 10 } }, tracks: [{ kind: 'video', clips: [{ id: 'a', media: 'm', start: 0, in: 0, out: 2 }, { id: 'b', media: 'm', start: 2, in: 0, out: 2, speed: 99, reverse: 1, freeze: 0.5, interp: 'flow' }] }] });
  const [a, b] = doc.tracks[0].clips;
  assert.deepEqual(Object.keys(plain(a)), ['id', 'media', 'start', 'in', 'out', 'volume', 'fadeIn', 'fadeOut', 'vfadeIn', 'vfadeOut', 'fit', 'x', 'y', 'scale', 'rotation', 'opacity', 'keys'], '예전 칸만');
  assert.equal(b.speed, 16); assert.equal(b.reverse, true); assert.equal(b.freeze, 0.5); assert.equal(b.interp, 'flow');
  assert.equal(V.duration(doc), 2.5);
});

test('전환: 화면(transState·clipOpacity)과 렌더 식(transExprs·opacityExpr)이 같은 값 — 모든 종류·방향', () => {
  const W = 320, H = 180;
  for (const type of ['fade', 'slide', 'zoom', 'blur', 'whip', 'spin', 'flip']) for (const dir of ['left', 'right', 'up', 'down']) {
    const { doc } = V.normalize({ width: W, height: H, fps: 30, media: { m: { path: 'a.mp4', duration: 9, width: W, height: H } }, tracks: [{ kind: 'video', clips: [{ media: 'm', start: 1, in: 0, out: 3, transIn: { type, dur: 0.6, dir, ease: 'out' }, transOut: { type, dur: 0.4, dir } }] }] });
    const c = doc.tracks[0].clips[0], L = V.clipLen(c);
    for (const off of [0, 1.1]) {
      const ex = transExprs(c, off, L, W, H), oe = opacityExpr(c, off);
      for (let t = 0; t < L - off; t += 0.037) {
        const st = V.transState(c, off + t, L, W, H), tag = `${type}/${dir} off=${off} t=${t.toFixed(3)}`;
        near(ex.dx ? ev(ex.dx, { t }) : 0, st.dx, 1e-4, `${tag} dx`); near(ex.dy ? ev(ex.dy, { t }) : 0, st.dy, 1e-4, `${tag} dy`);
        near(ex.s ? ev(ex.s, { t }) : 1, st.s, 1e-6, `${tag} s`); near(ex.rot ? ev(ex.rot, { t }) : 0, st.rot, 1e-4, `${tag} rot`);
        near(ex.rx ? ev(ex.rx, { t }) : 0, st.rx, 1e-4, `${tag} rx`); near(ex.ry ? ev(ex.ry, { t }) : 0, st.ry, 1e-4, `${tag} ry`);
        near(ev(oe, { T: t }), V.clipOpacity(c, c.start + off + t), 1e-6, `${tag} 불투명도`);
      }
    }
  }
  const wipe = V.transState({ transIn: V.cleanTrans({ type: 'wipe', dir: 'left' }) }, 0.25, 2, W, H);
  assert.equal(wipe.wipe.dir, 'left'); near(wipe.wipe.p, V.EASE.ease(0.5), 1e-9, '지우기 진행');
  assert.equal(V.transState({ transOut: V.cleanTrans({ type: 'wipe', dir: 'left' }) }, 1.9, 2, W, H).wipe.dir, 'right', '나가기는 반대쪽이 남는다');
});

test('흔들기·카메라(2.5D)·3D 기울이기: clipBox 와 렌더 식(clipExprs·perspective 모서리)이 같다', () => {
  const W = 640, H = 360;
  const { doc } = V.normalize({ width: W, height: H, fps: 30, camera: { zoom: 1.2, keys: { x: [{ t: 0, v: -50 }, { t: 4, v: 80, ease: 'sine' }], z: [{ t: 0, v: 0 }, { t: 4, v: 200 }] }, shake: { amp: 5, freq: 3 } },
    media: { m: { path: 'a.mp4', duration: 9, width: 320, height: 180 } },
    tracks: [{ kind: 'video', clips: [{ media: 'm', start: 0.5, in: 0, out: 4, z: 300, x: 20, scale: 0.8, keys: { y: [{ t: 0, v: 0 }, { t: 2, v: 40, ease: 'back' }] }, effects: [{ type: 'wiggle', amp: 12, freq: 2, rot: 5, seed: 3 }], transIn: { type: 'spin', dur: 0.5 } }] }] });
  const c = doc.tracks[0].clips[0], fit = V.fitSize(doc, doc.media.m, c.fit);
  for (const a of [0.5, 2.1]) {
    const ex = clipExprs(doc, c, a - c.start, a);
    for (let t = 0; t < 1.5; t += 0.07) {
      const b = V.clipBox(doc, c, a + t), tag = `a=${a} t=${t.toFixed(2)}`;
      near(ev(ex.x, { t }), b.cx - W / 2, 1e-3, `${tag} x`); near(ev(ex.y, { t }), b.cy - H / 2, 1e-3, `${tag} y`);
      near(ev(ex.s, { t }), b.w / fit.w, 1e-6, `${tag} s`); near(ev(ex.rot, { t }), b.rotation, 1e-3, `${tag} rot`);
    }
  }
  const p = V.project(doc, 100, 0, 300, 0); near(p.k, V.perspOf(doc) / (V.perspOf(doc) + 300) * 1.2, 1e-9, '멀수록 작게');
  assert.deepEqual(plain(V.project(doc, 100, 0, null, 0)), { x: 100, y: 0, k: 1 }, 'z 없는 층은 카메라에 안 비침');
  // 3D 기울이기: perspective 모서리 = CSS perspective(P) rotateX(a) rotateY(b) 를 실제 크기에서 계산한 것
  const P = 1000, pre = 0.5, cw = 200, ch = 120, rxD = 25, ryD = -40, s = 0.8;
  const f = tiltFilter({ rx: String(rxD), ry: String(ryD), s: String(s), P, pre, cw, ch });
  const val = (k) => ev(f.match(new RegExp(`${k}='([^']*)'`))[1]);
  const css = (sx, sy) => { // 실제 크기(판 크기 × s/pre)에서 CSS 순서로 → 판 크기로 되돌림
    const m = s / pre, A = rxD * Math.PI / 180, B = ryD * Math.PI / 180, x = sx * cw * m, y = sy * ch * m;
    const x1 = x * Math.cos(B), z1 = -x * Math.sin(B), y2 = y * Math.cos(A) - z1 * Math.sin(A), z2 = y * Math.sin(A) + z1 * Math.cos(A);
    return [cw + x1 * P / (P - z2) / m, ch + y2 * P / (P - z2) / m];
  };
  [[-1, -1, 0], [1, -1, 1], [-1, 1, 2], [1, 1, 3]].forEach(([sx, sy, i]) => { const [X, Y] = css(sx, sy); near(val(`x${i}`), X, 1e-3, `모서리 ${i} x`); near(val(`y${i}`), Y, 1e-3, `모서리 ${i} y`); });
});

test('마스크·자동 줄이기·sendcmd·출력 형식: 정의가 렌더 식과 같다', () => {
  for (const m0 of [{ shape: 'rect', x: 10, y: 20, w: 100, h: 60, feather: 12, radius: 15 }, { shape: 'ellipse', x: 30, y: 10, w: 80, h: 120, feather: 6, invert: true }, { shape: 'rect', x: 0, y: 0, w: 50, h: 50 }]) {
    const m = V.cleanMask(m0), a = V.maskAt(m, 0), ex = maskCovExpr(m, a, 'SX', 'SY');
    for (let py = 0; py < 150; py += 7) for (let px = 0; px < 150; px += 7) near(ev(ex, { SX: px, SY: py }), V.maskValue(m, 0, px, py), 1e-6, `${m.shape} (${px},${py})`);
  }
  const doc = plain(V.normalize({ fps: 30, media: { v: { path: 'v.wav', duration: 2 }, m: { path: 'm.wav', duration: 20 } }, tracks: [
    { kind: 'audio', name: '말', clips: [{ media: 'v', start: 1, in: 0, out: 1 }, { media: 'v', start: 2.3, in: 0, out: 1 }, { media: 'v', start: 8, in: 0, out: 1 }] },
    { kind: 'audio', name: '음악', audio: { duck: { by: '말', amount: -15, attack: 0.3, release: 0.6 } }, clips: [{ media: 'm', start: 0, in: 0, out: 20 }] }] }).doc);
  const tr = doc.tracks[1], rs = V.duckRanges(doc, tr);
  assert.deepEqual(plain(rs), [[1, 3.3], [8, 9]], '가까운 말소리는 하나로');
  const ex = duckExpr(rs, 0.3, 0.6);
  for (let t = 0; t < 11; t += 0.05) near(-15 * ev(ex, { t }), V.duckDb(doc, tr, t), 1e-6, `duck t=${t.toFixed(2)}`);
  assert.ok(trackFilters(V.cleanTrackAudio({ eq: 'phone', comp: true, denoise: 0.4, pan: 0.5 })).join(',').match(/highpass=f=300.*lowpass=f=3400.*afftdn.*acompressor.*pan=stereo/), 'EQ·잡음·압축·좌우 순서');
  // sendcmd: 값이 바뀐 프레임만, 같은 사슬 앞에서
  const sc = sendcmdScript([{ target: 'gblur@a', param: 'sigma', at: (lt) => (lt < 0.5 ? 0 : lt) }], { frc: 10, frames: 10, off: 0.2 });
  assert.match(sc.split('\n')[0], /^0-0\.05 \[enter\] gblur@a sigma 0;$/); assert.ok(sc.includes('gblur@a sigma 0.5;'));
  // 출력 형식
  assert.deepEqual(plain(V.cleanOutput({ codec: 'prores4444' })), { codec: 'prores4444', quality: 'normal', bitDepth: 10, alpha: true, audio: 'pcm' });
  assert.equal(V.cleanOutput({ codec: 'h264', alpha: true }).alpha, false, 'H.264 는 투명 없음');
  assert.equal(V.cleanOutput({ codec: 'vp9', alpha: true, audio: 'aac' }).audio, 'opus');
  assert.ok(outputArgs(V.cleanOutput({ codec: 'h265', bitDepth: 10 }), 'libx264').video.join(' ').includes('yuv420p10le'));
  assert.ok(outputArgs(V.cleanOutput({ codec: 'h264', quality: 'master' }), 'libx264').video.join(' ').includes('-crf 10'));
});

test('글자 단위 움직임·계속 움직임·도형: 단위 나누기, 차례(stagger), 선 그리기 경로', () => {
  assert.deepEqual(plain(V.unitsOf('가나 다', 'char').map((u) => u.u)), [true, true, false, true]);
  assert.deepEqual(plain(V.unitsOf('one  two', 'word').map((u) => u.s)), ['one', '  ', 'two']);
  const { doc } = V.normalize({ fps: 30, tracks: [{ kind: 'text', items: [
    { id: 'a', start: 0, end: 4, text: 'abcd', anim: { in: 'fade', inDur: 0.5, unit: 'char', stagger: 0.2, order: 'reverse' } },
    { id: 'b', start: 0, end: 4, text: '타자', anim: { in: 'type', inDur: 1 } },
    { id: 'c', start: 0, end: 2, shape: { type: 'arrow', w: 100, stroke: { color: '#f00', width: 4 } }, keys: { trimEnd: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } },
    { id: 'd', start: 0, end: 2, text: 'x', loop: 'wave' }] }] });
  const [a, b, c, d] = doc.tracks[0].items, rk = V.unitRanks(a, 4);
  assert.deepEqual(plain(rk), [3, 2, 1, 0], '거꾸로');
  near(V.unitMods(a, 0.3, rk[3], 4, 0.2).o, 0.6, 1e-9, '마지막 글자가 먼저(0.3초 = 60%)'); assert.equal(V.unitMods(a, 0.3, rk[0], 4, 0.2).o, 0, '첫 글자는 아직');
  assert.equal(V.unitOf(b), 'char', '타자는 글자 하나씩'); assert.equal(V.unitOf(d), 'all');
  const st = V.itemState(c, 0.5, doc); near(st.trimEnd, V.EASE.ease(0.5), 1e-9, '선 그리기 키');
  assert.match(V.shapePath(V.cleanShape({ type: 'rect', w: 100, h: 50, radius: 10 })), /^M-40 -25 H40 A10 10 0 0 1 50 -15/);
  assert.equal(V.cleanShape({ type: 'line', w: 80 }).fill, null, '선은 채우기 없음');
  assert.match(V.shapeSvg(c.shape, 0, 0.5, 'c'), /pathLength="1" stroke-dasharray="0\.5 2"/);
  assert.ok(!/[<>"']/.test(V.cleanShape({ type: 'path', d: 'M0 0 L10 10<script>"' }).d), '경로에는 숫자·명령만(꺾쇠·따옴표 없음)');
  assert.equal(V.loopMods(d, 0.25, 0).dy, -10 * Math.sin(2 * Math.PI * 1.2 * 0.25), '물결');
  assert.deepEqual(plain(simplify([{ t: 0, x: 0, y: 0 }, { t: 1, x: 1, y: 1 }, { t: 2, x: 2, y: 2 }, { t: 3, x: 10, y: 3 }])).map((p) => p.t), [0, 2, 3], '일직선 키는 줄임');
});

const PY = (() => { for (const b of ['python', 'py']) { try { if (spawnSync(b, ['--version'], { windowsHide: true }).status === 0) return b; } catch {} } return null; })();

test('엔진: 프로 기능이 렌더에 그대로(속도·효과·섞기·마스크·전환·기울이기·카메라·조정·편집 안 편집·모션 블러·소리·출력 형식·따라가기)', { skip: (!FF.ffmpeg || !FF.ffprobe) && 'ffmpeg 없음', timeout: 600_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-pro-')), mat = path.join(dir, 'm'), data = path.join(dir, 'data');
  for (const d of [mat, data]) fs.mkdirSync(d, { recursive: true });
  const ff = (args) => { const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', ...args], { windowsHide: true }); assert.equal(r.status, 0, String(r.stderr)); };
  const W = 160, H = 90;
  ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=6,format=yuv444p,geq=lum='clip(16+30*T,0,255)':cb=128:cr=128`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', path.join(mat, 'luma.mp4')]);
  for (const [n, c] of [['red', 'red'], ['gray', '0x808080'], ['white', 'white'], ['blue', 'blue']]) ff(['-f', 'lavfi', '-i', `color=c=${c}:s=${W}x${H}:r=30:d=6`, '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-qp', '0', path.join(mat, `${n}.mp4`)]);
  ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=6,drawbox=x=0:y=0:w=${W / 2}:h=${H}:color=white:t=fill`, '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-qp', '0', path.join(mat, 'half.mp4')]);
  // 따라가기용: 어두운 바탕에 흰 네모(20px)가 프레임마다 오른쪽으로 2px, 아래로 1px
  ff(['-f', 'lavfi', '-i', `color=c=0x202020:s=320x180:r=30:d=2,format=yuv420p,geq=lum='if(between(X,40+2*N,59+2*N)*between(Y,50+N,69+N),235,30+mod(X*7+Y*13,9))':cb=128:cr=128`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-qp', '0', path.join(mat, 'move.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6', '-c:a', 'pcm_s16le', path.join(mat, 'music.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', path.join(mat, 'voice.wav')]);
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)|0.3*sin(2*PI*300*t)':s=48000:d=2", '-c:a', 'pcm_s16le', path.join(mat, 'tone.wav')]);
  const [port, scenePort, hubPort] = [await freePort(), await freePort(), await freePort()];
  const engine = spawn(process.execPath, [fileURLToPath(new URL('../studio/engine/server.mjs', import.meta.url))], { env: { ...process.env, STUDIO_PORT: String(port), STUDIO_SCENE_PORT: String(scenePort), STUDIO_DATA_DIR: data, ODDIN_HUB: `http://127.0.0.1:${hubPort}`, STUDIO_ENCODER: 'libx264', ...(process.env.STUDIO_TEST_KEEP ? { STUDIO_KEEP_TMP: '1' } : {}) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opt = {}) => { const res = await fetch(base + p, { ...opt, headers: { 'Content-Type': 'application/json' } }); const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: res.status, body: j }; };
  const post = (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) });
  const media = { lu: { path: 'm/luma.mp4', duration: 6, width: W, height: H, audio: false }, red: { path: 'm/red.mp4', duration: 6, width: W, height: H, audio: false }, gray: { path: 'm/gray.mp4', duration: 6, width: W, height: H, audio: false },
    white: { path: 'm/white.mp4', duration: 6, width: W, height: H, audio: false }, blue: { path: 'm/blue.mp4', duration: 6, width: W, height: H, audio: false }, half: { path: 'm/half.mp4', duration: 6, width: W, height: H, audio: false },
    mv: { path: 'm/move.mp4', duration: 2, width: 320, height: 180, audio: false }, mu: { path: 'm/music.wav', duration: 6 }, vo: { path: 'm/voice.wav', duration: 1 }, tone: { path: 'm/tone.wav', duration: 2 }, adj: { path: '', kind: 'adjust' } };
  const save = (name, d) => { const f = path.join(dir, `${name}.oddin-edit.json`); fs.writeFileSync(f, JSON.stringify({ oddinEdit: 1, title: name, width: W, height: H, fps: 30, media, ...d })); return f; };
  const render = async (f, output = null) => {
    const rs = await post('/api/render', { path: f, ...(output ? { output } : {}) }); assert.equal(rs.status, 202, JSON.stringify(rs.body));
    let st; for (let i = 0; i < 3000; i++) { st = (await call('/api/renders')).body.find((x) => x.id === rs.body.id); if (st.status !== 'running') break; await new Promise((x) => setTimeout(x, 150)); }
    assert.equal(st.status, 'done', `${path.basename(f)}: ${st.error || ''}`); return st.out;
  };
  const px = (file, t, x, y, { alpha = false, vp9 = false } = {}) => { const r = spawnSync(FF.ffmpeg, ['-v', 'error', ...(vp9 ? ['-c:v', 'libvpx-vp9'] : []), '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgba`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }); return [...r.stdout.subarray(0, alpha ? 4 : 3)]; };
  const probe = (file, q) => spawnSync(FF.ffprobe, ['-v', 'error', '-show_entries', q, '-of', 'default=nw=1', file], { encoding: 'utf8' }).stdout;
  const band = (file, hz, a, b, ch = null) => { const r = spawnSync(FF.ffmpeg, ['-v', 'info', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', `${ch != null ? `pan=mono|c0=c${ch},` : ''}bandpass=f=${hz}:width_type=q:w=6,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }); const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)?.[1]; return m === '-inf' ? -200 : Number(m); }; // 조용한 채널은 -inf
  const src = (rgb) => rgb[0] / 34.93; // 밝기 → 원본 시각(luma.mp4: Y = 16 + 30·초)
  try {
    for (let i = 0; i < 300; i++) { try { await fetch(base + '/api/status'); break; } catch { await new Promise((x) => setTimeout(x, 100)); } }
    // 1) 속도·되감기·멈춤·램프
    let out = await render(save('speed', { tracks: [{ kind: 'video', clips: [
      { media: 'lu', start: 0, in: 0, out: 4, speed: 2 }, { media: 'lu', start: 2, in: 1, out: 3, reverse: true }, { media: 'lu', start: 4, in: 2, out: 2.1, freeze: 1 },
      { media: 'lu', start: 5, in: 0, out: 4, keys: { speed: [{ t: 0, v: 1, ease: 'linear' }, { t: 1, v: 3 }] } }] }] }));
    near(Number(probe(out, 'format=duration').match(/[\d.]+/)[0]), 5 + 5 / 3, 0.05, '전체 길이');
    for (const [t, want] of [[0.5, 1], [1.5, 3], [2.5, 2.5], [3.5, 1.5], [4.5, 2], [5.5, 0.75], [6, 2], [6.5, 3.5]]) near(src(px(out, t, 80, 45)), want, 0.12, `속도 t=${t}`);
    // 2) 효과(뒤집기·반전·채도·흐림·모자이크·그림자) + 섞기 + 마스크
    out = await render(save('fx', { tracks: [
      { kind: 'video', clips: [{ media: 'gray', start: 0, in: 0, out: 3 }] },
      { kind: 'video', clips: [
        { media: 'half', start: 0, in: 0, out: 0.5, effects: [{ type: 'mirror' }] },
        { media: 'red', start: 0.5, in: 0, out: 0.5, effects: [{ type: 'invert' }] },
        { media: 'red', start: 1, in: 0, out: 0.5, effects: [{ type: 'color', saturation: 0 }] },
        { media: 'half', start: 1.5, in: 0, out: 0.5, effects: [{ type: 'blur', radius: 12 }] },
        { media: 'red', start: 2, in: 0, out: 0.5, blend: 'screen' },
        { media: 'red', start: 2.5, in: 0, out: 0.5, mask: { x: 0, y: 0, w: 80, h: 90 } }] }] }));
    let p = px(out, 0.25, 20, 45); assert.ok(p[0] < 30, `좌우 뒤집기: 왼쪽이 검정 ${p}`); p = px(out, 0.25, 140, 45); assert.ok(p[0] > 220, `오른쪽이 흰색 ${p}`);
    p = px(out, 0.75, 80, 45); assert.ok(p[0] < 40 && p[1] > 200 && p[2] > 200, `반전: 빨강 → 하늘 ${p}`);
    p = px(out, 1.25, 80, 45); assert.ok(Math.abs(p[0] - p[1]) < 12 && Math.abs(p[1] - p[2]) < 12, `채도 0: 회색 ${p}`);
    p = px(out, 1.75, 80, 45); assert.ok(p[0] > 60 && p[0] < 200, `흐림: 경계가 중간색 ${p}`);
    p = px(out, 2.25, 80, 45); assert.ok(p[0] > 240 && p[1] > 110 && p[1] < 150, `섞기 screen: 회색 위 빨강 → (255,128,128) ${p}`);
    p = px(out, 2.75, 40, 45); assert.ok(p[0] > 230 && p[1] < 30, `마스크 안: 빨강 ${p}`); p = px(out, 2.75, 120, 45); assert.ok(Math.abs(p[0] - 128) < 15 && Math.abs(p[1] - 128) < 15, `마스크 밖: 바탕 회색 ${p}`);
    // 3) 전환(밀기·지우기·디졸브) + 키로 움직이는 마스크 + 조정 레이어
    out = await render(save('trans', { background: '#000000', tracks: [
      { kind: 'video', clips: [{ media: 'white', start: 0, in: 0, out: 1, transIn: { type: 'slide', dir: 'left', dur: 1, ease: 'linear' } }, { media: 'white', start: 1, in: 0, out: 1, transIn: { type: 'wipe', dir: 'right', dur: 1, ease: 'linear', soft: 0 } },
        { media: 'white', start: 2, in: 0, out: 1, transIn: { type: 'fade', dur: 1, ease: 'linear' } }, { media: 'white', start: 3, in: 0, out: 1, mask: { x: 0, y: 0, w: 40, h: 90, keys: { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 120 }] } } },
        { media: 'red', start: 4, in: 0, out: 1 }] },
      { kind: 'video', clips: [{ media: 'adj', start: 4, in: 0, out: 1, effects: [{ type: 'invert' }], mask: { x: 0, y: 0, w: 160, h: 45 } }] }] }));
    assert.ok(px(out, 0.5, 40, 45)[0] < 30 && px(out, 0.5, 120, 45)[0] > 220, '밀기: 반쯤 들어온 그림은 오른쪽 절반');
    assert.ok(px(out, 1.5, 40, 45)[0] > 220 && px(out, 1.5, 120, 45)[0] < 30, '지우기(→): 왼쪽 절반만');
    p = px(out, 2.5, 80, 45)[0]; assert.ok(p > 100 && p < 160, `디졸브 반: ${p}`);
    assert.ok(px(out, 3.1, 15, 45)[0] > 220 && px(out, 3.9, 15, 45)[0] < 30 && px(out, 3.9, 140, 45)[0] > 220, '움직이는 마스크가 오른쪽으로');
    p = px(out, 4.5, 80, 20); assert.ok(p[0] < 40 && p[1] > 200, `조정 레이어(위 절반 반전) ${p}`); p = px(out, 4.5, 80, 70); assert.ok(p[0] > 220 && p[1] < 40, `아래 절반은 그대로 ${p}`);
    // 4) 3D 기울이기 · 카메라 시차 · 모션 블러 · 편집 안 편집
    const inner = save('inner', { background: '#0000ff', tracks: [{ kind: 'video', clips: [{ media: 'red', start: 0, in: 0, out: 2, scale: 0.5 }] }] });
    out = await render(save('comp', { media: { ...media, nest: { path: 'inner.oddin-edit.json' } }, camera: { keys: { x: [{ t: 0, v: 0 }, { t: 0.001, v: 60, ease: 'hold' }] } }, motionBlur: { samples: 8, shutter: 1 }, tracks: [
      { kind: 'video', clips: [{ media: 'white', start: 0, in: 0, out: 1, rotationY: 70, scale: 0.8 }, { media: 'white', start: 1, in: 0, out: 1, z: 0, scale: 0.25 }, { media: 'white', start: 1, in: 0, out: 1, z: 900, scale: 0.25, y: 30 }] },
      { kind: 'video', clips: [{ media: 'white', start: 2, in: 0, out: 1, scale: 0.2, motionBlur: true, keys: { x: [{ t: 0, v: -200, ease: 'linear' }, { t: 1, v: 200 }] } }, { media: 'nest', start: 3, in: 0, out: 2 }] }] }));
    assert.ok(px(out, 0.5, 80, 45)[0] > 220 && px(out, 0.5, 20, 45)[0] < 30, '70° 기울인 판은 가운데만 보임(옆은 바탕)');
    // 카메라가 오른쪽으로 60: z=0 층은 60, z=900 층은 60·P/(P+900) 만큼 왼쪽으로 (P = 1.2·대각선)
    const P = Math.round(Math.hypot(W, H) * 1.2), k = P / (P + 900);
    assert.ok(px(out, 1.5, 80 - 60, 45)[0] > 220 && px(out, 1.5, 80, 45)[0] < 30, '가까운 층은 카메라만큼 밀림');
    const farX = Math.round(80 - 60 * k), farY = Math.round(45 + 30 * k); assert.ok(px(out, 1.5, farX, farY)[0] > 200, `먼 층은 덜 밀리고 작게 (${farX},${farY})`);
    const mb = px(out, 2.5, 99, 45)[0]; assert.ok(mb > 15 && mb < 240, `모션 블러: 지나간 자리가 반투명 ${mb}`);
    p = px(out, 3.5, 80, 45); assert.ok(p[0] > 220 && p[2] < 40, `편집 안 편집: 가운데 빨강 ${p}`); p = px(out, 3.5, 5, 5); assert.ok(p[2] > 200 && p[0] < 40, `가장자리 파랑 ${p}`);
    // 5) 소리: 자동 줄이기 · EQ(전화) · 좌우 · 속도 · 음량 맞추기
    out = await render(save('audio', { audio: { loudness: -18 }, tracks: [
      { kind: 'video', clips: [{ media: 'gray', start: 0, in: 0, out: 6 }] },
      { kind: 'audio', name: '말', clips: [{ media: 'vo', start: 2, in: 0, out: 1 }] },
      { kind: 'audio', name: '음악', audio: { duck: { by: '말', amount: -20, attack: 0.1, release: 0.1 }, pan: -1 }, clips: [{ media: 'mu', start: 0, in: 0, out: 6 }] },
      { kind: 'audio', name: '빠른', clips: [{ media: 'tone', start: 4, in: 0, out: 2, speed: 2 }] }] }));
    const before = band(out, 220, 0.5, 1.5, 0), during = band(out, 220, 2.25, 2.75, 0);
    assert.ok(before - during > 15, `자동 줄이기: ${before} → ${during}`);
    const lch = band(out, 220, 0.5, 1.5, 0), rch = band(out, 220, 0.5, 1.5, 1); assert.ok(lch - rch > 20, `왼쪽으로(pan -1): ${lch} / ${rch}`);
    const on = band(out, 300, 4.2, 4.8, 1), off = band(out, 300, 5.2, 5.8, 1); assert.ok(on > -40 && off < -60, `2배속 소리는 1초에 끝(음높이 그대로, 오른쪽 채널 — 음악은 왼쪽): ${on} / ${off}`);
    const L = spawnSync(FF.ffmpeg, ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/I:\s+(-?[\d.]+) LUFS/g).pop();
    near(Number(L.match(/-?[\d.]+/)[0]), -18, 1.5, '음량 맞추기');
    // 6) 출력 형식: ProRes 4444 투명 · H.265 10비트 · VP9 투명 · GIF
    const tf = save('alpha', { background: 'transparent', tracks: [{ kind: 'video', clips: [{ media: 'red', start: 0, in: 0, out: 1, scale: 0.5 }] }] });
    out = await render(tf, { codec: 'prores4444' });
    assert.match(out, /\.mov$/); assert.match(probe(out, 'stream=pix_fmt'), /yuva444p1[02]le/);
    assert.equal(px(out, 0.5, 5, 5, { alpha: true })[3], 0, '바깥은 투명'); assert.ok(px(out, 0.5, 80, 45, { alpha: true })[3] > 250, '그림은 불투명');
    out = await render(tf, { codec: 'vp9', alpha: true }); assert.match(out, /\.webm$/);
    assert.ok(px(out, 0.5, 5, 5, { alpha: true, vp9: true })[3] < 10 && px(out, 0.5, 80, 45, { alpha: true, vp9: true })[3] > 240, 'VP9 투명');
    assert.equal((await call(`/api/verify?path=${encodeURIComponent(out)}`)).body.current, true, 'webm 도 렌더 표시를 읽는다');
    out = await render(tf, { codec: 'h265', bitDepth: 10, quality: 'high' }); assert.match(probe(out, 'stream=codec_name,pix_fmt'), /hevc[\s\S]*yuv420p10le/);
    out = await render(tf, { codec: 'gif', fps: 10 }); assert.match(out, /\.gif$/); assert.ok(fs.statSync(out).size > 100);
    // 7) 따라가기: 움직이는 흰 네모(2px/프레임 →, 1px/프레임 ↓)
    const tk = save('track', { width: 320, height: 180, tracks: [{ kind: 'video', clips: [{ id: 'mv', media: 'mv', start: 0, in: 0, out: 2 }] }, { kind: 'text', items: [{ id: 'lab', start: 0, end: 2, text: 'x', x: 0, y: 0 }] }] });
    const fr = (await post('/api/follow', { path: tk, clip: 'mv', rect: [40, 50, 20, 20], to: 1.5 })).body;
    assert.ok(fr.frames >= 44 && !fr.lost, JSON.stringify({ frames: fr.frames, lost: fr.lost, err: fr.error }));
    const pt = fr.points.find((q) => Math.abs(q.t - 1) < 0.02); near(pt.x, 40 + 60, 1.5, '1초 뒤 x'); near(pt.y, 50 + 30, 1.5, '1초 뒤 y');
    const fa = (await post('/api/follow', { path: tk, clip: 'mv', rect: [40, 50, 20, 20], to: 1.5, apply: 'item:lab' })).body; assert.equal(fa.applied, 'item:lab');
    const td = (await call(`/api/edit?path=${encodeURIComponent(tk)}`)).body.doc, lab = td.tracks[1].items[0];
    near(V.valueAt(0, lab.keys.x, 1) - V.valueAt(0, lab.keys.x, 0), 60, 2, '글자가 네모를 따라감');
    await post('/api/follow', { path: tk, clip: 'mv', rect: [40, 50, 20, 20], to: 1.5, apply: 'mask' });
    assert.ok((await call(`/api/edit?path=${encodeURIComponent(tk)}`)).body.doc.tracks[0].clips[0].mask.keys.x.length >= 2, '마스크 키');
    // 8) 명령줄: fx · trans · shape · adjust
    const cli = (args) => spawnSync(process.execPath, [fileURLToPath(new URL('../studio/cli.mjs', import.meta.url)), ...args], { encoding: 'utf8', env: { ...process.env, STUDIO_PORT: String(port) } });
    for (const a of [['fx', tk, 'mv', 'blur', 'radius=8'], ['fx', tk, 'mv', 'color', 'saturation=0', 'keys={"brightness":[{"t":0,"v":0},{"t":1,"v":0.3}]}'], ['trans', tk, 'mv', 'in', 'slide', '--dir', 'up', '--dur', '0.4'], ['shape', tk, 'star', '--at', '0.5', '--dur', '1', 'w=40', 'h=40', 'fill="#ff0"'], ['adjust', tk, '--at', '0', '--dur', '1', 'invert']]) {
      const r = cli(a); assert.equal(r.status, 0, `${a.join(' ')}\n${r.stdout}${r.stderr}`);
    }
    const cd = (await call(`/api/edit?path=${encodeURIComponent(tk)}`)).body.doc, mvc = cd.tracks.flatMap((t) => t.clips || []).find((c) => c.id === 'mv');
    assert.deepEqual(mvc.effects.map((e) => e.type), ['blur', 'color']); assert.equal(mvc.effects[1].keys.brightness.length, 2); assert.equal(mvc.transIn.dir, 'up');
    assert.ok(cd.tracks.some((t) => t.items?.some((it) => it.shape?.type === 'star'))); assert.ok(Object.values(cd.media).some((m) => m.kind === 'adjust'));
    // 9) 글자·도형(브라우저가 있으면): 도형 색·선 그리기·타자 효과
    if (findBrowser()) {
      out = await render(save('shapes', { background: '#000000', tracks: [{ kind: 'text', items: [
        { start: 0, end: 2, shape: { type: 'rect', w: 40, h: 40, fill: '#00ff00' }, x: -50 },
        { start: 0, end: 2, shape: { type: 'line', w: 100, stroke: { color: '#ffffff', width: 8, cap: 'butt' } }, y: 30, keys: { trimEnd: [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 1 }] } }] }] }));
      p = px(out, 0.5, 30, 45); assert.ok(p[1] > 200 && p[0] < 40, `도형 사각형 초록 ${p}`);
      assert.ok(px(out, 0.5, 40, 75)[0] > 200 && px(out, 0.5, 120, 75)[0] < 40 && px(out, 1.5, 120, 75)[0] > 200, '선이 점점 그려진다');
    }
    // 10) 파이썬 도우미: 프로 기능 함수로 짠 편집이 정리 문제 없이 읽힌다
    if (PY) {
      const py = path.join(dir, 'b.py'), ef = path.join(dir, 'py.oddin-edit.json');
      fs.writeFileSync(py, `import sys\nsys.path.insert(0, r"${fileURLToPath(new URL('../studio/sdk', import.meta.url))}")\nfrom oddin_edit import Edit\ne = Edit("p", ${W}, ${H})\nv = e.track("video"); t = e.track("text")\nc = e.clip(v, e.media(r"${path.join(mat, 'red.mp4')}"), 0, out=2, speed=2, trans_in="fade")\ne.trans(c, "out", "slide", 0.3, dir="left"); f = e.fx(c, "blur", radius=4); e.fx_key(f, "radius", 0.5, 10)\ne.mask(c, 0, 0, 80, 90, feather=10); e.adjust(v, 0, 1, [{"type": "invert"}])\ne.shape(t, 0, 1, "arrow", w=60); e.text(t, 0, 1, "hi", unit="char", loop="wave")\ne.camera(zoom=1.1); e.camera_key("z", 0, 0); e.loudness(-14); e.output("h265", bit_depth=10)\nprint(e.save(r"${ef}"))\n`);
      const r = spawnSync(PY, ['-X', 'utf8', py], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
      const rd = (await call(`/api/edit?path=${encodeURIComponent(ef)}`)).body;
      assert.deepEqual(rd.problems, []); assert.equal(rd.doc.tracks[0].clips[0].speed, 2); assert.equal(rd.doc.output.codec, 'h265'); assert.equal(V.duration(rd.doc), 1);
    }
  } finally {
    try { await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}' }); } catch {}
    await new Promise((x) => setTimeout(x, 500)); engine.kill();
    if (process.env.STUDIO_TEST_KEEP) console.log('시험 폴더', dir); else try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
