// ODDIN 스튜디오 프로 기능 렌더(ffmpeg) — 2026-10-24 사용자 "전부 다 넣어주고, 오딘 친화적으로만 해주면 돼"
// 값의 정의는 ui/video-core.js(미리보기와 같은 계산)에 있고, 여기서는 그 값을 ffmpeg 식·필터로 옮긴다.
//  - 움직임(위치·크기·회전·전환·흔들기·카메라·3D 기울이기)은 overlay·scale·rotate·perspective 의 프레임 식
//  - 프레임마다 바뀌는 효과 값·불투명도·전환 흐림은 JS(공용 코어)로 계산해 sendcmd 로 보낸다(같은 사슬 앞쪽이라 프레임이 정확)
//  - 마스크·지우기·원형 전환은 회색 매트: 정해진 마스크는 한 번 계산(geq), 움직이는 마스크·전환은 흰 상자·원을 프레임 식으로 옮긴다
//    (drawbox 는 프레임마다 식을 다시 계산하지 않아 못 쓴다 — 2026-10-24 시험)
import fs from 'node:fs';
import { f6, even } from './media.mjs';
import { core } from './core.mjs';

/* ---------- 이징: ffmpeg 식 (video-core.js EASE 와 같은 공식, 변수 P — PI 는 숫자로 써서 P 바꾸기와 안 겹치게) ---------- */
export const EASE_EXPR = {
  linear: '(P)',
  ease: 'if(lt(P,0.5),4*pow(P,3),1-pow(-2*P+2,3)/2)',
  in: 'pow(P,3)',
  out: '1-pow(1-P,3)',
  hold: '0',
  snap: '1+2.70158*pow(P-1,3)+1.70158*pow(P-1,2)',
  expo: 'if(gte(P,1),1,1-pow(2,-10*P))',
  sine: '(-(cos(3.141592653589793*P)-1)/2)',
  circ: 'if(lt(P,0.5),(1-sqrt(max(0,1-pow(2*P,2))))/2,(sqrt(max(0,1-pow(-2*P+2,2)))+1)/2)',
  back: 'if(lt(P,0.5),(pow(2*P,2)*(3.5949095*2*P-2.5949095))/2,(pow(2*P-2,2)*(3.5949095*(P*2-2)+2.5949095)+2)/2)',
  elastic: 'if(lte(P,0),0,if(gte(P,1),1,pow(2,-10*P)*sin((P*10-0.75)*2.0943951023931953)+1))',
  bounce: 'if(lt(P,0.36363636363636365),7.5625*P*P,if(lt(P,0.7272727272727273),7.5625*pow(P-0.5454545454545454,2)+0.75,if(lt(P,0.9090909090909091),7.5625*pow(P-0.8181818181818182,2)+0.9375,7.5625*pow(P-0.9545454545454546,2)+0.984375)))',
  bezier: '(P)', // 베지어 키는 잘게 나눈 직선으로 바꿔 쓴다(expandBezier)
};
const easeOf = (name, p) => (EASE_EXPR[name] || EASE_EXPR.linear).replaceAll('P', p);
/** 베지어 이징 구간을 32개 직선으로(렌더 식은 3차 방정식을 못 푼다) */
export function expandBezier(keys) {
  if (!keys.some((k) => k.ease === 'bezier')) return keys;
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (a.ease !== 'bezier' || !b) { out.push(a); continue; }
    const f = core().bezierFn(a.bz || [0.25, 0.1, 0.25, 1]);
    for (let j = 0; j < 32; j++) { const p = j / 32; out.push({ t: a.t + (b.t - a.t) * p, v: a.v + (b.v - a.v) * f(p), ease: 'linear' }); }
  }
  return out;
}
/** 키프레임 값을 ffmpeg 식으로. off = (조각 시작) - (클립 시작) — 식의 시각 변수 tv(기본 t, geq 는 T, perspective 는 in/fps) */
export function keyExpr(base, keys, off = 0, tv = 't') {
  if (!Array.isArray(keys) || !keys.length) return f6(base);
  keys = expandBezier(keys);
  const T = `(${tv}+${f6(off)})`;
  let e = f6(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1], span = b.t - a.t;
    const seg = a.ease === 'hold' || span <= 0 ? f6(a.v) : `${f6(a.v)}+(${f6(b.v - a.v)})*(${easeOf(a.ease, `((${T}-${f6(a.t)})/${f6(span)})`)})`;
    e = `if(lt(${T},${f6(b.t)}),${seg},${e})`;
  }
  return `if(lt(${T},${f6(keys[0].t)}),${f6(keys[0].v)},${e})`;
}
export const isConst = (e) => /^-?\d+(\.\d+)?(e-?\d+)?$/.test(String(e));

/* ---------- 전환 ---------- */
const DIRV = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
/** 전환이 바꾸는 값의 ffmpeg 식(video-core.js transState 와 같은 정의). 없는 값은 null */
export function transExprs(c, off, len, W, H, tv = 't') {
  const L = `(${tv}+${f6(off)})`, r = { o: [], dx: [], dy: [], s: [], rot: [], rx: [], ry: [] };
  const one = (tr, isIn) => {
    const p = isIn ? `clip(${L}/${f6(tr.dur)},0,1)` : `clip((${f6(len)}-${L})/${f6(tr.dur)},0,1)`;
    const e = `(${easeOf(tr.ease, p)})`, q = `(1-${e})`, d = DIRV[tr.dir] || DIRV.left, sg = isIn ? -1 : 1, sd = tr.dir === 'left' || tr.dir === 'up' ? -1 : 1;
    if (tr.type === 'fade') r.o.push(e);
    else if (tr.type === 'slide' || tr.type === 'whip') { if (d[0]) r.dx.push(`${f6(sg * d[0] * W)}*${q}`); if (d[1]) r.dy.push(`${f6(sg * d[1] * H)}*${q}`); }
    else if (tr.type === 'zoom') { r.s.push(`(1+${f6(tr.amount)}*${q})`); r.o.push(e); }
    else if (tr.type === 'blur') r.o.push(e);
    else if (tr.type === 'spin') { r.rot.push(`${f6(sg * sd * 180)}*${q}`); r.s.push(`max(0.01,${e})`); }
    else if (tr.type === 'flip') (d[0] ? r.ry : r.rx).push(`${f6(sg * sd * 90)}*${q}`);
  };
  if (c.transIn) one(c.transIn, true);
  if (c.transOut) one(c.transOut, false);
  const j = (a, op) => (a.length ? a.map((x) => `(${x})`).join(op) : null);
  return { o: j(r.o, '*'), dx: j(r.dx, '+'), dy: j(r.dy, '+'), s: j(r.s, '*'), rot: j(r.rot, '+'), rx: j(r.rx, '+'), ry: j(r.ry, '+') };
}
/** 전환이 걸린 구간(클립 안 시각) — 조각을 여기서 나눈다 */
export function transSpans(c, len) {
  const out = [];
  if (c.transIn) out.push([0, Math.min(len, c.transIn.dur)]);
  if (c.transOut) out.push([Math.max(0, len - c.transOut.dur), len]);
  return out;
}

/** 영상 클립 불투명도의 ffmpeg 식(geq 의 T = 조각 안 시각). video-core.js clipOpacity 와 같은 정의(렌더는 이제 JS 값을 sendcmd 로 보낸다 — 이 식은 대조·다른 쓰임용) */
export function opacityExpr(c, off, tv = 'T') {
  const C = core(), len = C.clipLen(c), L = `(${tv}+${f6(off)})`, parts = [keyExpr(c.opacity, c.keys?.opacity, off, tv)];
  if (c.vfadeIn > 0) parts.push(`clip(${L}/${f6(c.vfadeIn)},0,1)`);
  if (c.vfadeOut > 0) parts.push(`clip((${f6(len)}-${L})/${f6(c.vfadeOut)},0,1)`);
  const tr = transExprs(c, off, len, 0, 0, tv); if (tr.o) parts.push(tr.o);
  return `clip(${parts.map((p) => `(${p})`).join('*')},0,1)`;
}
/** 불투명도가 바뀌는 구간(클립 안 시각) */
export function opacitySpans(c) {
  const out = [], ks = c.keys?.opacity, len = core().clipLen(c);
  if (Array.isArray(ks) && ks.length > 1 && ks.some((k) => k.v !== ks[0].v)) out.push([ks[0].t, ks[ks.length - 1].t]);
  if (c.vfadeIn > 0) out.push([0, Math.min(len, c.vfadeIn)]);
  if (c.vfadeOut > 0) out.push([Math.max(0, len - c.vfadeOut), len]);
  return out;
}

/* ---------- 흔들기·카메라 ---------- */
const WN = [[1, 0.55, 0], [2.13, 0.3, 1.9], [3.71, 0.15, 4.3]]; // video-core.js wnoise 와 같은 값
export function wnoiseExpr(f, L, seed, axis) { return `(${WN.map(([m, w, ph]) => `${f6(w)}*sin(${f6(2 * Math.PI * f * m)}*${L}+${f6(ph + seed * 1.618 + axis * 2.399)})`).join('+')})`; }
/** 카메라 값의 식(a = 조각 시작 타임라인 시각) */
export function cameraExprs(doc, a, tv = 't') {
  const c = doc.camera, k = c.keys || {}, T = `(${tv}+${f6(a)})`;
  let x = keyExpr(c.x, k.x, a, tv), y = keyExpr(c.y, k.y, a, tv);
  if (c.shake) { x = `(${x})+${f6(c.shake.amp)}*${wnoiseExpr(c.shake.freq, T, c.shake.seed, 0)}`; y = `(${y})+${f6(c.shake.amp)}*${wnoiseExpr(c.shake.freq, T, c.shake.seed, 1)}`; }
  return { x, y, z: keyExpr(c.z, k.z, a, tv), zoom: keyExpr(c.zoom, k.zoom, a, tv), P: core().perspOf(doc) };
}
function depthExpr(o, off, tv) { const ks = o.keys?.z; if (o.z == null && !(Array.isArray(ks) && ks.length)) return null; return keyExpr(Number(o.z) || 0, ks, off, tv); }
/** 영상 클립의 위치(가운데 기준 x·y)·크기 배율 s·회전 rot·기울이기 rx·ry 식 (video-core.js clipBox 와 같은 정의). a = 조각 시작 타임라인 시각 */
export function clipExprs(doc, c, off, a, tv = 't') {
  const C = core(), k = c.keys || {}, len = C.clipLen(c), tr = transExprs(c, off, len, doc.width, doc.height, tv);
  const add = (e, d) => (d ? `(${e})+(${d})` : e), mul = (e, m) => (m ? `(${e})*(${m})` : e);
  let x = add(keyExpr(c.x, k.x, off, tv), tr.dx), y = add(keyExpr(c.y, k.y, off, tv), tr.dy), s = mul(keyExpr(c.scale, k.scale, off, tv), tr.s), rot = add(keyExpr(c.rotation, k.rotation, off, tv), tr.rot);
  for (const fx of c.effects || []) {
    if (fx.type !== 'wiggle' || fx.on === false) continue;
    const amp = keyExpr(fx.amp, fx.keys?.amp, off, tv), L = `(${tv}+${f6(off)})`;
    x = `(${x})+(${amp})*${wnoiseExpr(fx.freq, L, fx.seed, 0)}`; y = `(${y})+(${amp})*${wnoiseExpr(fx.freq, L, fx.seed, 1)}`;
    if (fx.rot) rot = `(${rot})+${f6(fx.rot)}*${wnoiseExpr(fx.freq, L, fx.seed, 2)}`;
  }
  const z = depthExpr(c, off, tv);
  if (z != null && doc.camera) {
    const cam = cameraExprs(doc, a, tv), kk = `(${f6(cam.P)}/max(1,${f6(cam.P)}+(${z})-(${cam.z}))*(${cam.zoom}))`;
    x = `((${x})-(${cam.x}))*${kk}`; y = `((${y})-(${cam.y}))*${kk}`; s = `(${s})*${kk}`;
  }
  return { x, y, s, rot, rx: add(keyExpr(Number(c.rotationX) || 0, k.rotationX, off, tv), tr.rx), ry: add(keyExpr(Number(c.rotationY) || 0, k.rotationY, off, tv), tr.ry) };
}
/** 3D 기울이기: 2배로 넓힌 투명 판의 네 모서리를 CSS perspective(P) rotateX rotateY 와 같은 식으로 옮긴다.
 *  판은 pre 배율 크기라 원근 거리를 P·pre/s 로 맞춘다(실제 보이는 크기에서 CSS 와 같은 모양). cw·ch = 넓힌 판의 반 크기 */
export function tiltFilter({ rx, ry, s, P, pre, cw, ch }) {
  const A = `((${rx})*0.017453292519943295)`, B = `((${ry})*0.017453292519943295)`, PP = `(${f6(P * pre)}/max(0.0001,${s}))`;
  const pt = (sx, sy) => {
    const cx = `(${f6(sx * cw)})`, cy = `(${f6(sy * ch)})`; // 음수는 괄호로(--128 같은 꼴 피하기)
    const x1 = `(${cx}*cos(${B}))`, y2 = `(${cy}*cos(${A})+${cx}*sin(${B})*sin(${A}))`, z2 = `(${cy}*sin(${A})-${cx}*sin(${B})*cos(${A}))`;
    const den = `max(${PP}-${z2},0.05*${PP})`;
    return [`${f6(cw)}+${x1}*${PP}/${den}`, `${f6(ch)}+${y2}*${PP}/${den}`];
  };
  const [p0, p1, p2, p3] = [pt(-1, -1), pt(1, -1), pt(-1, 1), pt(1, 1)];
  return `perspective=x0='${p0[0]}':y0='${p0[1]}':x1='${p1[0]}':y1='${p1[1]}':x2='${p2[0]}':y2='${p2[1]}':x3='${p3[0]}':y3='${p3[1]}':interpolation=linear:sense=destination:eval=frame`;
}

/* ---------- 필터 그래프 짜기 ---------- */
/** ffmpeg 필터 안 파일 경로('C\:/폴더/파일') */
export const ffPath = (p) => `'${String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\''")}'`;
export class Graph {
  constructor(prefix) { this.p = prefix; this.n = 0; this.lines = []; }
  lab() { return `${this.p}${++this.n}`; }
  add(line) { this.lines.push(line); }
  /** [cur] 에 필터들을 이어 붙여 새 라벨 */
  pipe(cur, filters) { const fs = filters.filter(Boolean); if (!fs.length) return cur; const out = this.lab(); this.add(`[${cur}]${fs.join(',')}[${out}]`); return out; }
  /** 원천(color 등) */
  src(desc) { const out = this.lab(); this.add(`${desc}[${out}]`); return out; }
  split(cur) { const a = this.lab(), b = this.lab(); this.add(`[${cur}]split[${a}][${b}]`); return [a, b]; }
}
/** sendcmd 파일: cmds = [{ target, param, at(lt) }], 프레임 k 의 시각 k/frc(조각 안), lt = off + 시각. 값이 바뀐 프레임만 적는다 */
export function sendcmdScript(cmds, { frc, frames, off }) {
  const last = new Map(), lines = [];
  for (let k = 0; k < frames; k++) {
    const t = k / frc, parts = [];
    for (const c of cmds) {
      let v = c.at(off + t); if (!Number.isFinite(v)) continue;
      v = c.int ? Math.round(v) : Math.round(v * 1e5) / 1e5;
      const key = `${c.target} ${c.param}`;
      if (last.get(key) === v) continue; last.set(key, v); parts.push(`${c.target} ${c.param} ${v}`);
    }
    if (parts.length) lines.push(`${f6(Math.max(0, (k - 0.5) / frc))}-${f6((k + 0.5) / frc)} [enter] ${parts.join(', ')};`);
  }
  return lines.join('\n');
}

/* ---------- 매트(회색, 레이어 크기): 마스크 × 지우기 × 원형 ---------- */
const hexRgb = (c) => { const m = String(c || '').match(/^#?([0-9a-f]{6})/i); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16, (n >> 8) & 255, n & 255]; };
/** 정해진 마스크의 덮임 식(geq lum, 원본 좌표 sx·sy) — video-core.js maskValue 와 같은 정의 */
export function maskCovExpr(m, a, sx, sy) {
  const hw = a.w / 2, hh = a.h / 2, cx = a.x + hw, cy = a.y + hh;
  let sd;
  if (m.shape === 'ellipse') sd = `((1-hypot((${sx}-${f6(cx)})/${f6(hw)},(${sy}-${f6(cy)})/${f6(hh)}))*${f6(Math.min(a.w, a.h) / 2)})`;
  else { const r = Math.min(m.radius, hw, hh), qx = `(abs(${sx}-${f6(cx)})-${f6(hw - r)})`, qy = `(abs(${sy}-${f6(cy)})-${f6(hh - r)})`; sd = `(-(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${f6(r)}))`; }
  const v = a.feather > 0 ? `clip(${sd}/${f6(a.feather)}+0.5,0,1)` : `gte(${sd},0)`;
  return m.invert ? `(1-${v})` : v;
}
/**
 * 레이어(pw×ph)의 매트를 만든다. 없으면 null.
 * o = { pw, ph, fr, len, off, kx, ky(원본 px → 레이어 px), mask, clip, clipLen, id, cmds }
 */
export function buildMatte(g, o) {
  const C = core(), mattes = [], { pw, ph, fr, len, off } = o, d = f6(len + 0.5), frames = Math.ceil((len + 0.5) * fr) + 1;
  const canvas = (color) => g.src(`color=c=${color}:s=${pw}x${ph}:r=${fr}:d=${d},format=gray`);
  const circle = () => g.src(`color=c=black:s=512x512:r=${fr}:d=${f6(1 / fr)},format=gray,geq=lum='255*clip((256-hypot(X-255.5,Y-255.5))/1.5+0.5,0,1)',loop=loop=${frames}:size=1:start=0,setpts=N/(${fr})/TB`);
  const m = o.mask;
  if (m) {
    const keyed = m.keys && Object.keys(m.keys).length;
    if (!keyed) {
      const a = C.maskAt(m, 0);
      mattes.push(g.src(`color=c=black:s=${pw}x${ph}:r=${fr}:d=${f6(1 / fr)},format=gray,geq=lum='255*${maskCovExpr(m, a, `((X+0.5)/${f6(o.kx)})`, `((Y+0.5)/${f6(o.ky)})`)}',loop=loop=${frames}:size=1:start=0,setpts=N/(${fr})/TB`));
    } else {
      // 움직이는 마스크: 흰 상자·원을 프레임 식으로 옮기고, 가장자리는 흐림으로
      const k = m.keys, ex = (p) => keyExpr(m[p], k[p], off);
      const shape = m.shape === 'ellipse' ? circle() : g.src(`color=c=white:s=16x16:r=${fr}:d=${d},format=gray`);
      const sz = g.pipe(shape, [`scale=w='max(1,(${ex('w')})*${f6(o.kx)})':h='max(1,(${ex('h')})*${f6(o.ky)})':eval=frame:flags=${m.shape === 'ellipse' ? 'bilinear' : 'neighbor'}`]);
      const out = g.lab(); g.add(`[${canvas('black')}][${sz}]overlay=x='(${ex('x')})*${f6(o.kx)}':y='(${ex('y')})*${f6(o.ky)}':eval=frame:format=yuv420[${out}]`);
      const fsig = (lt) => C.maskAt(m, lt).feather * o.kx / 2.5;
      const id = `gblur@${o.id}mf`; if (k.feather || m.feather > 0) o.cmds.push({ target: id, param: 'sigma', at: fsig });
      mattes.push(g.pipe(out, ['format=gray', k.feather || m.feather > 0 ? `${id}=sigma=${f6(fsig(off))}` : '', m.invert ? 'negate' : '']));
    }
  }
  // 지우기·원형 전환(이 조각에 걸린 것만)
  const c = o.clip, L = o.clipLen;
  for (const [tr, isIn] of [[c.transIn, true], [c.transOut, false]]) {
    if (!tr || (tr.type !== 'wipe' && tr.type !== 'iris')) continue;
    const w0 = isIn ? 0 : L - tr.dur, w1 = isIn ? tr.dur : L;
    if (!(w1 > off - 1e-6 && w0 < off + len + 1e-6)) continue;
    const p = `(${easeOf(tr.ease, isIn ? `clip((t+${f6(off)})/${f6(tr.dur)},0,1)` : `clip((${f6(L)}-(t+${f6(off)}))/${f6(tr.dur)},0,1)`)})`;
    if (tr.type === 'wipe') {
      const dir = isIn ? tr.dir : { left: 'right', right: 'left', up: 'down', down: 'up' }[tr.dir], horiz = dir === 'left' || dir === 'right';
      const size = horiz ? pw : ph, sp = Math.max(1, tr.soft * size), BW = horiz ? even(pw + 2 * sp) : pw, BH = horiz ? ph : even(ph + 2 * sp);
      // 보이는 쪽을 덮는 흰 상자(크기 고정)를 경계 위치로 옮긴다
      const edgeIn = `(-${f6(sp)}+${f6(size + 2 * sp)}*(1-${p}))`, edgeOut = `(-${f6(sp)}+${f6(size + 2 * sp)}*${p})`;
      const pos = dir === 'left' || dir === 'up' ? edgeIn : `(${edgeOut}-${f6(horiz ? BW : BH)})`;
      const box = g.src(`color=c=white:s=${BW}x${BH}:r=${fr}:d=${d},format=gray`), out = g.lab();
      g.add(`[${canvas('black')}][${box}]overlay=x='${horiz ? pos : 0}':y='${horiz ? 0 : pos}':eval=frame:format=yuv420[${out}]`);
      mattes.push(g.pipe(out, ['format=gray', sp > 1.5 ? `gblur=sigma=${f6(sp / 2.5)}` : '']));
    } else {
      const sp = Math.max(1.5, 0.015 * Math.hypot(pw, ph)), R = `(${p}*${f6(Math.hypot(pw, ph) / 2 + sp)})`;
      const sz = g.pipe(circle(), [`scale=w='max(2,trunc(${R}*2/2)*2)':h='max(2,trunc(${R}*2/2)*2)':eval=frame:flags=bilinear`]), out = g.lab();
      g.add(`[${canvas('black')}][${sz}]overlay=x='${f6(pw / 2)}-w/2':y='${f6(ph / 2)}-h/2':eval=frame:format=yuv420[${out}]`);
      mattes.push(g.pipe(out, ['format=gray']));
    }
  }
  if (!mattes.length) return null;
  let cur = mattes[0];
  for (let i = 1; i < mattes.length; i++) { const out = g.lab(); g.add(`[${cur}][${mattes[i]}]blend=all_mode=multiply[${out}]`); cur = out; }
  return cur;
}
/** 레이어 알파에 매트를 곱한다 */
export function applyMatte(g, cur, matte) {
  const [l1, l2] = g.split(cur), la = g.pipe(l2, ['alphaextract']), ma = g.lab(), out = g.lab();
  g.add(`[${la}][${matte}]blend=all_mode=multiply[${ma}]`);
  g.add(`[${l1}][${ma}]alphamerge,format=rgba[${out}]`);
  return out;
}

/* ---------- 효과(rgba → rgba). ctx = { g, id, pre(레이어 px 배율), fr, len, off, w, h, cmds, resolve(파일), warn } ---------- */
const CURVE_PRESETS = ['color_negative', 'cross_process', 'darker', 'increase_contrast', 'lighter', 'linear_contrast', 'medium_contrast', 'negative', 'strong_contrast', 'vintage'];
const curvePts = (s) => String(s || '').replace(/[^0-9.\s/]/g, '').trim();
export function applyFx(cur, fx, ctx) {
  const C = core(), g = ctx.g, P = ctx.pre, id = ctx.id, keyed = (p) => !!(fx.keys && fx.keys[p]);
  const at = (p, k = 1) => (lt) => C.effectAt(fx, lt)[p] * k;
  const reg = (target, param, fn, int = false) => ctx.cmds.push({ target, param, at: fn, int });
  switch (fx.type) {
    case 'color': {
      const list = ['format=yuva444p'];
      if (['brightness', 'contrast', 'saturation', 'gamma'].some((p) => keyed(p) || fx[p] !== C.FX.color[p][0])) {
        list.push(`eq@${id}e=brightness=${f6(fx.brightness)}:contrast=${f6(fx.contrast)}:saturation=${f6(fx.saturation)}:gamma=${f6(fx.gamma)}`);
        for (const p of ['brightness', 'contrast', 'saturation', 'gamma']) if (keyed(p)) reg(`eq@${id}e`, p, at(p));
      }
      if (fx.hue || keyed('hue')) { list.push(`hue@${id}h=h=${f6(fx.hue)}`); if (keyed('hue')) reg(`hue@${id}h`, 'h', at('hue')); }
      list.push('format=rgba');
      if (fx.temperature !== 6500 || keyed('temperature')) { list.push(`colortemperature@${id}t=temperature=${f6(fx.temperature)}`); if (keyed('temperature')) reg(`colortemperature@${id}t`, 'temperature', at('temperature')); }
      if (fx.exposure || keyed('exposure')) { list.push(`exposure@${id}x=exposure=${f6(fx.exposure)}`, 'format=rgba'); if (keyed('exposure')) reg(`exposure@${id}x`, 'exposure', at('exposure')); }
      return list.length > 2 ? g.pipe(cur, list) : cur;
    }
    case 'lut': {
      const file = fx.file && ctx.resolve(fx.file);
      if (!file || !fs.existsSync(file)) { ctx.warn(`LUT 파일이 없어 건너뜀: ${fx.file || '(빈 값)'}`); return cur; }
      if (fx.strength >= 0.999) return g.pipe(cur, [`lut3d=file=${ffPath(file)}:interp=tetrahedral`, 'format=rgba']);
      const [a, b] = g.split(cur), l = g.pipe(b, [`lut3d=file=${ffPath(file)}:interp=tetrahedral`, 'format=gbrap']), a2 = g.pipe(a, ['format=gbrap']), out = g.lab();
      g.add(`[${l}][${a2}]blend=all_mode=normal:all_opacity=${f6(fx.strength)},format=rgba[${out}]`); return out;
    }
    case 'curves': {
      const o = [];
      if (CURVE_PRESETS.includes(fx.preset)) o.push(`preset=${fx.preset}`);
      for (const k of ['master', 'r', 'g', 'b']) if (curvePts(fx[k])) o.push(`${k}='${curvePts(fx[k])}'`);
      return o.length ? g.pipe(cur, [`curves=${o.join(':')}`, 'format=rgba']) : cur;
    }
    case 'blur': if (keyed('radius')) reg(`gblur@${id}`, 'sigma', at('radius', P / 2)); return fx.radius > 0 || keyed('radius') ? g.pipe(cur, [`gblur@${id}=sigma=${f6(C.effectAt(fx, ctx.off).radius * P / 2)}`, 'format=rgba']) : cur;
    case 'glow': {
      const [a, b] = g.split(g.pipe(cur, ['format=gbrap'])), th = f6(fx.threshold), k = Math.max(1, fx.strength);
      const hi = g.pipe(b, [`colorlevels=rimin=${th}:gimin=${th}:bimin=${th}`, `gblur=sigma=${f6(Math.max(0.5, fx.radius * P / 2))}`, k > 1 ? `colorchannelmixer=rr=${f6(k)}:gg=${f6(k)}:bb=${f6(k)}` : '']), out = g.lab();
      if (keyed('strength')) reg(`blend@${id}`, 'all_opacity', (lt) => Math.min(1, C.effectAt(fx, lt).strength));
      g.add(`[${a}][${hi}]blend@${id}=c0_mode=screen:c1_mode=screen:c2_mode=screen:c3_mode=lighten:all_opacity=${f6(Math.min(1, C.effectAt(fx, ctx.off).strength))},format=rgba[${out}]`); return out;
    }
    case 'shadow': {
      const M = Math.ceil(fx.blur * P * 1.3 + Math.max(Math.abs(fx.x), Math.abs(fx.y)) * P + 4), w2 = even(ctx.w + 2 * M), h2 = even(ctx.h + 2 * M);
      const [rr, gg, bb] = hexRgb(fx.color), [a, b] = g.split(g.pipe(cur, [`pad=w=${w2}:h=${h2}:x=${M}:y=${M}:color=black@0`]));
      const s = g.pipe(b, [`lutrgb=r=${rr}:g=${gg}:b=${bb}:a='val*${f6(fx.opacity)}'`, fx.blur > 0 ? `gblur=sigma=${f6(fx.blur * P / 2)}` : '']);
      const cv = g.src(`color=c=black@0:s=${w2}x${h2}:r=${ctx.fr}:d=${f6(ctx.len + 0.5)},format=rgba`), sh = g.lab(), out = g.lab();
      g.add(`[${cv}][${s}]overlay=x=${Math.round(fx.x * P)}:y=${Math.round(fx.y * P)}:format=auto[${sh}]`);
      g.add(`[${sh}][${a}]overlay=0:0:format=auto,format=rgba[${out}]`);
      ctx.w = w2; ctx.h = h2; return out;
    }
    case 'sharpen': return fx.amount > 0 ? g.pipe(cur, ['format=yuva444p', `unsharp=5:5:${f6(fx.amount)}:5:5:0`, 'format=rgba']) : cur;
    case 'grain': { const a = fx.amount; return a > 0 ? g.pipe(cur, ['format=yuva444p', `noise=c0s=${Math.round(a * 50)}:c0f=t+u:c1s=${Math.round(a * 14)}:c1f=t+u:c2s=${Math.round(a * 14)}:c2f=t+u`, 'format=rgba']) : cur; }
    case 'vignette': {
      const [a, b] = g.split(cur), al = g.pipe(b, ['alphaextract']), v = g.pipe(a, [`vignette=angle='(${keyExpr(fx.amount, fx.keys?.amount, ctx.off)})*1.5707963267948966':eval=frame`]), out = g.lab();
      g.add(`[${v}][${al}]alphamerge,format=rgba[${out}]`); return out;
    }
    case 'pixelate': { if (keyed('size')) { reg(`pixelize@${id}`, 'w', (lt) => Math.max(1, C.effectAt(fx, lt).size * P), true); reg(`pixelize@${id}`, 'h', (lt) => Math.max(1, C.effectAt(fx, lt).size * P), true); } const s = Math.max(1, Math.round(C.effectAt(fx, ctx.off).size * P)); return g.pipe(cur, [`pixelize@${id}=w=${s}:h=${s}`, 'format=rgba']); }
    case 'chroma': { const [r, gg, b] = hexRgb(fx.color); return g.pipe(cur, [`colorkey=color=0x${[r, gg, b].map((v) => v.toString(16).padStart(2, '0')).join('')}:similarity=${f6(fx.similarity)}:blend=${f6(fx.blend)}`, 'format=rgba']); }
    case 'invert': return g.pipe(cur, ['negate', 'format=rgba']);
    case 'mirror': return g.pipe(cur, [fx.axis === 'v' ? 'vflip' : 'hflip']);
    case 'tint': {
      const [r, gg, b] = hexRgb(fx.color).map((v) => v / 255), mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), sat = mx ? (mx - mn) / mx : 0;
      if (keyed('amount')) reg(`colorize@${id}`, 'mix', at('amount'));
      return g.pipe(cur, ['format=gbrap', `colorize@${id}=hue=${f6(hueDeg(fx.color))}:saturation=${f6(Math.max(0.05, sat))}:lightness=0.5:mix=${f6(C.effectAt(fx, ctx.off).amount)}`, 'format=rgba']);
    }
    case 'rgbsplit': { if (keyed('amount')) { reg(`rgbashift@${id}`, 'rh', (lt) => -C.effectAt(fx, lt).amount * P, true); reg(`rgbashift@${id}`, 'bh', (lt) => C.effectAt(fx, lt).amount * P, true); } const a = Math.round(C.effectAt(fx, ctx.off).amount * P); return g.pipe(cur, ['format=gbrap', `rgbashift@${id}=rh=${-a}:bh=${a}:edge=smear`, 'format=rgba']); }
    case 'lens': { for (const p of ['k1', 'k2']) if (keyed(p)) reg(`lenscorrection@${id}`, p, at(p)); const v = C.effectAt(fx, ctx.off); return g.pipe(cur, ['format=gbrap', `lenscorrection@${id}=k1=${f6(v.k1)}:k2=${f6(v.k2)}:i=bilinear`, 'format=rgba']); }
    case 'wave': {
      const amp = `((${keyExpr(fx.amp, fx.keys?.amp, ctx.off, 'T')})*${f6(P)})`, L = f6(Math.max(1, fx.length * P)), sp = f6(fx.speed);
      const X = fx.axis === 'y' ? 'X' : `X+${amp}*sin(6.283185307179586*(Y/${L}-${sp}*T))`, Y = fx.axis === 'y' ? `Y+${amp}*sin(6.283185307179586*(X/${L}-${sp}*T))` : 'Y';
      return g.pipe(cur, ['format=rgba', `geq=r='r(${X},${Y})':g='g(${X},${Y})':b='b(${X},${Y})':a='alpha(${X},${Y})'`]);
    }
    default: return cur; // wiggle 은 위치 식(clipExprs)에서
  }
}
function hueDeg(c) { const [r, g, b] = hexRgb(c).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; }

/* ---------- 섞기(블렌드): ffmpeg blend 모드와 위·아래 순서(포토샵 정의에 맞춤) ---------- */
// [모드, 1 = 레이어가 위(첫 입력)] — overlay·hardlight·dodge·burn 은 바탕이 위, softlight 는 레이어가 위(ffmpeg 공식의 조건 쪽)
export const BLEND_FF = { screen: ['screen', 0], multiply: ['multiply', 0], overlay: ['overlay', 0], add: ['addition', 0], lighten: ['lighten', 0], darken: ['darken', 0], softlight: ['softlight', 1], hardlight: ['hardlight', 0], difference: ['difference', 0], exclusion: ['exclusion', 0], colordodge: ['dodge', 0], colorburn: ['burn', 0] };

/* ---------- 속도 ---------- */
/** 소리 빠르기(atempo 는 0.5~100 — 더 느리면 여러 번) */
export function atempoChain(s) { const out = []; let r = s; while (r < 0.5 - 1e-9) { out.push('atempo=0.5'); r /= 0.5; } out.push(`atempo=${f6(r)}`); return out.join(','); }
/** 속도 램프 조각의 setpts 식: 입력(원본) 시각 τ=T-STARTT → 출력 시각. off = 조각 시작의 클립 안 시각 */
export function rampSetpts(c, off, len, fr) {
  const C = core(), U0 = C.srcOffset(c, off), step = 2 / fr, pairs = [];
  for (let o = 0; o <= len + step; o += step) pairs.push([C.srcOffset(c, off + o) - U0, o]);
  const X = '(T-STARTT)';
  let e = `${f6(pairs[pairs.length - 1][1])}+(${X}-${f6(pairs[pairs.length - 1][0])})*${f6(step / Math.max(1e-6, pairs[pairs.length - 1][0] - pairs[pairs.length - 2][0]))}`;
  for (let i = pairs.length - 2; i >= 0; i--) {
    const [u0, o0] = pairs[i], [u1, o1] = pairs[i + 1], k = (o1 - o0) / Math.max(1e-6, u1 - u0);
    e = `if(lt(${X},${f6(u1)}),${f6(o0)}+(${X}-${f6(u0)})*${f6(k)},${e})`;
  }
  return { expr: `setpts='(${e})/TB'`, srcStart: c.in + U0, srcLen: C.srcOffset(c, off + len) - U0 };
}
