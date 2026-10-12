// 누가 말했나 — 촬영본에서 화면 속 출연자의 말과 화면 밖(PD·코치) 목소리를 가른다.
// AI 작업자는 소리를 못 듣는다. 받아쓴 글자만 보면 PD 가 먼저 읽어 준 문장과 출연자가 따라 한 문장이 똑같아서 구분이 안 된다
// (2026-10-12 실제 사고: 16편에서 PD 선창이 그대로 들어감). 그래서 숫자 두 가지로 가른다.
//   ① 소리 크기 — 말 덩어리마다 크기를 재서 무리로 나눈다(옷깃 마이크면 출연자가 뚜렷이 크다)
//   ② 화면 움직임 — 그 무리가 말할 때 화면 속 사람이 움직이는가(입·턱). 움직임과 맞는 무리가 화면 속 화자다
// 화면이 없거나 판가름이 안 나면 "가장 큰 목소리 = 화면 속"으로 보고 근거가 약하다고 적는다.
import fs from 'node:fs';
import path from 'node:path';
import { tools, run } from './media.mjs';

const SR = 16000, HOP = 160, WIN = 400;          // 소리: 10ms 간격, 25ms 창
const VSIZE = 320, VFPS = 15, GRID = 32;         // 화면: 320x320 흑백 15fps, 32x32 칸
const CELL = VSIZE / GRID;

const median = (a) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/* ---------- 소리 ---------- */
async function readAudio(file, ffmpeg) {
  const chunks = [];
  await run(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', String(SR), '-f', 's16le', '-'], { onStdout: (b) => chunks.push(b) });
  const buf = Buffer.concat(chunks);
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~3)));
  const n = pcm.length >> 1;
  let e0 = 0, e1 = 0;
  for (let i = 0; i < n; i += 5) { e0 += pcm[2 * i] * pcm[2 * i]; e1 += pcm[2 * i + 1] * pcm[2 * i + 1]; }
  const ch = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { ch[0][i] = pcm[2 * i] / 32768; ch[1][i] = pcm[2 * i + 1] / 32768; }
  // 한쪽만 녹음된 원본(옷깃 마이크 하나)이 흔하다. 두 채널이 다 살아 있으면 서로 다른 마이크일 수 있다(아래 dualMics)
  return { ch, main: e0 >= e1 ? 0 : 1, both: Math.min(e0, e1) > Math.max(e0, e1) * 1e-3 };
}

/**
 * 두 채널이 서로 다른 마이크인가(출연자 옷깃 마이크 / PD 쪽 마이크): 말하는 동안 좌우 크기 차이가 사람에 따라 크게 달라진다.
 * 같은 소리를 양쪽에 넣은 원본은 차이가 거의 일정하다. 2026-10-12 실제 사고 — 에너지가 큰 채널 하나만 골랐더니 PD 마이크 쪽을 골라 판정이 뒤집혔다.
 */
export function dualMics(dbL, dbR) {
  const n = Math.min(dbL.length, dbR.length), mx = new Float32Array(n);
  for (let f = 0; f < n; f++) mx[f] = Math.max(dbL[f], dbR[f]);
  const sorted = Float32Array.from(mx).sort(), thr = Math.max(sorted[Math.floor(n * 0.1)] + 8, sorted[Math.min(n - 1, Math.floor(n * 0.98))] - 38);
  const d = []; for (let f = 0; f < n; f += 2) if (mx[f] > thr + 6) d.push(dbL[f] - dbR[f]);
  if (d.length < 200) return { dual: false, spread: 0 };
  d.sort((a, b) => a - b);
  const spread = d[Math.floor(d.length * 0.9)] - d[Math.floor(d.length * 0.1)];
  return { dual: spread >= 8, spread };
}

/** 10ms 마다의 크기(dB) */
export function frameLevels(x) {
  const frames = Math.max(0, Math.floor((x.length - WIN) / HOP));
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0; const o = f * HOP;
    for (let i = 0; i < WIN; i++) s += x[o + i] * x[o + i];
    db[f] = 10 * Math.log10(s / WIN + 1e-12);
  }
  return db;
}

/**
 * 말 덩어리: 문턱을 넘는 구간을 짧게(80ms) 이어 조각을 만들고, 조각 크기가 비슷하면(6dB 안) 한 덩어리로 묶는다.
 * 크기가 확 다른 조각은 붙어 있어도 다른 덩어리 — PD 선창 바로 뒤에 출연자가 따라 해도 갈린다.
 */
export function findIslands(db, { gapFrames = 22, minFrames = 12, step = 6, aux = null, auxStep = 6 } = {}) {
  if (!db.length) return { islands: [], floor: -120, threshold: -120 };
  const sorted = Float32Array.from(db).sort();
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const floor = pct(0.1), top = pct(0.98);
  const threshold = Math.max(floor + 8, top - 38);
  const level = (a, b) => { const v = Array.from(db.subarray(a, b + 1)).sort((p, q) => q - p); return v[Math.floor(v.length * 0.2)]; };
  // aux(두 마이크의 좌우 차이): 그 구간에서 소리가 큰 프레임들의 가운데값 — 크기가 비슷해도 좌우 차이가 다르면 다른 사람이다
  const auxOf = (a, b) => { if (!aux) return 0; const lv = level(a, b) - 10, v = []; for (let f = a; f <= b; f++) if (db[f] >= lv) v.push(aux[f]); v.sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0; };
  const pieces = []; let cur = null;
  for (let f = 0; f < db.length; f++) {
    if (db[f] > threshold) { if (!cur) cur = { a: f, b: f }; cur.b = f; }
    else if (cur && f - cur.b > 8) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  for (const p of pieces) { p.len = p.b - p.a + 1; p.level = level(p.a, p.b); p.aux = auxOf(p.a, p.b); }
  const islands = []; let isl = null;
  const close = () => { if (isl && isl.b - isl.a + 1 >= minFrames) islands.push(isl); isl = null; };
  for (const p of pieces) {
    const tiny = p.len < 10; // 0.1초 안 되는 조각은 크기를 믿을 수 없다 — 가까운 덩어리에 붙인다
    if (isl && p.a - isl.b <= gapFrames && (tiny || isl.solid === 0 || (Math.abs(p.level - isl.level) < step && (!aux || Math.abs(p.aux - isl.aux) < auxStep)))) {
      isl.b = p.b;
      if (!tiny) { isl.level = (isl.level * isl.solid + p.level * p.len) / (isl.solid + p.len); isl.aux = (isl.aux * isl.solid + p.aux * p.len) / (isl.solid + p.len); isl.solid += p.len; }
    } else { close(); isl = { a: p.a, b: p.b, level: p.level, aux: p.aux, solid: tiny ? 0 : p.len }; }
  }
  close();
  return {
    floor, threshold,
    islands: islands.map((i) => ({ start: i.a * HOP / SR, end: (i.b * HOP + WIN) / SR, level: level(i.a, i.b), ...(aux ? { diff: auxOf(i.a, i.b) } : {}) })),
  };
}

/**
 * 크기 무리: 길이로 무게를 준 크기 분포에서 봉우리를 찾아 가장 큰 봉우리와 그 아래를 가르는 골짜기를 문턱으로 삼는다.
 * (둘로만 가르는 방식은 출연자·코치·PD 처럼 셋일 때 엉뚱한 데를 자른다)
 */
export function levelSplit(islands) {
  const speech = islands.filter((i) => i.end - i.start >= 0.3);
  if (speech.length < 4) return { ok: false, reason: '말이 너무 적어요', top: null };
  const lo = Math.floor(Math.min(...speech.map((i) => i.level))) - 3, hi = Math.ceil(Math.max(...speech.map((i) => i.level))) + 3;
  const bins = (hi - lo) * 2 + 1, hist = new Float64Array(bins), bin = (v) => Math.min(bins - 1, Math.max(0, Math.round((v - lo) * 2)));
  let total = 0;
  for (const i of speech) { hist[bin(i.level)] += i.end - i.start; total += i.end - i.start; }
  const smooth = new Float64Array(bins); // 1dB 쯤으로 부드럽게
  for (let b = 0; b < bins; b++) { let s = 0; for (let k = -6; k <= 6; k++) { const j = b + k; if (j >= 0 && j < bins) s += hist[j] * Math.exp(-(k * k) / 8); } smooth[b] = s; }
  // 가장 큰 목소리 무리의 자리: 말한 시간의 위쪽 10% 지점(그 사람이 전체 말의 10%는 했다고 본다)
  let acc = 0, top = hi;
  for (const i of [...speech].sort((a, b) => b.level - a.level)) { acc += i.end - i.start; if (acc >= total * 0.1) { top = i.level; break; } }
  const need = Math.max(3, total * 0.08), eps = total * 0.002, bT = bin(top);
  let best = null, below = 0;
  const cum = new Float64Array(bins + 1); for (let b = 0; b < bins; b++) cum[b + 1] = cum[b] + hist[b];
  for (let b = bT - 4; b >= Math.max(1, bT - 36); b--) { // 꼭대기에서 2~18dB 아래를 훑어 가장 빈 자리(골짜기)를 찾는다
    below = cum[b];
    if (below < need) break;            // 그 아래에 말이 거의 없으면 더 볼 것 없다
    if (total - below < need) continue;
    if (best == null || smooth[b] + eps < (smooth[best] + eps) * 0.8) best = b;
  }
  // 얕은 골짜기 후보들(분포가 살짝 꺼진 자리 전부): 확정은 못 하지만, 화면 움직임이 가장 잘 갈리는 후보를 고르는 데 쓴다
  const cands = [];
  for (let b = bT - 4; b >= Math.max(1, bT - 36); b--) if (cum[b] >= need && total - cum[b] >= need && smooth[b] <= smooth[b - 1] && smooth[b] < smooth[b + 1]) cands.push({ th: lo + b / 2, d: smooth[b] });
  const weak = cands.sort((x, y) => x.d - y.d).slice(0, 6).map((x) => x.th);
  if (best == null) return { ok: false, reason: '목소리 크기가 한 무리예요', top, weak };
  let a = best, z = best; const flat = smooth[best] * 1.5 + eps; // 골짜기 한가운데를 가르는 선으로
  while (a - 1 > 0 && smooth[a - 1] <= flat) a--;
  while (z + 1 < bT && smooth[z + 1] <= flat) z++;
  const mid = Math.round((a + z) / 2);
  let up = mid, dn = mid;
  for (let b = mid; b < bins; b++) if (smooth[b] > smooth[up]) up = b;
  for (let b = mid; b >= Math.max(0, mid - 24); b--) if (smooth[b] > smooth[dn]) dn = b;
  const depth = (smooth[mid] + eps) / (Math.min(smooth[up], smooth[dn]) + eps), gap = (up - dn) / 2;
  // 골짜기가 얕으면 확정하지 않되 후보로 넘긴다 — 화면 움직임이 그 선을 뒷받침하면 쓴다(출연자와 읽어 주는 사람의 크기가 가까운 촬영)
  if (gap < 4 || depth > 0.6) return { ok: false, reason: `크기 차이가 뚜렷하지 않아요(무리 사이 ${gap}dB)`, top, weak };
  return { ok: true, threshold: lo + mid / 2, loud: lo + up / 2, quiet: lo + dn / 2, gap, top };
}

/** 두 마이크일 때: 덩어리의 좌우 차이(dB)를 두 무리로 가른다(길이로 무게를 준 Otsu). 두 무리의 가운데가 6dB 넘게 떨어져야 인정 */
export function diffSplit(islands) {
  const sp = islands.filter((i) => i.end - i.start >= 0.3 && Number.isFinite(i.diff));
  const total = sp.reduce((a, i) => a + i.end - i.start, 0), need = Math.max(3, total * 0.08);
  if (sp.length < 4) return { ok: false, reason: '말이 너무 적어요', top: null };
  const v = [...sp].sort((a, b) => a.diff - b.diff); let best = null, wl = 0, sl = 0;
  const all = v.reduce((a, i) => a + i.diff * (i.end - i.start), 0);
  for (let k = 0; k < v.length - 1; k++) {
    const w = v[k].end - v[k].start; wl += w; sl += v[k].diff * w;
    if (wl < need || total - wl < need || v[k + 1].diff - v[k].diff < 0.01) continue;
    const ml = sl / wl, mh = (all - sl) / (total - wl), score = wl * (total - wl) * (mh - ml) ** 2;
    if (!best || score > best.score) best = { score, ml, mh, thr: (v[k].diff + v[k + 1].diff) / 2 };
  }
  if (!best || best.mh - best.ml < 6) return { ok: false, reason: '두 채널의 차이로는 목소리가 갈리지 않아요', top: null };
  return { ok: true, threshold: best.thr, loud: round(best.mh, 1), quiet: round(best.ml, 1), gap: round(best.mh - best.ml, 1), top: null, by: 'channels' };
}

/* ---------- 화면 움직임 ---------- */
async function readMotion(file, ffmpeg, duration) {
  const frameBytes = VSIZE * VSIZE, cells = GRID * GRID;
  const cap = Math.ceil((duration + 2) * VFPS) + 8;
  const motion = new Float32Array(cap * cells);
  let prev = null, cur = Buffer.alloc(frameBytes), filled = 0, n = 0;
  const onFrame = () => {
    if (prev && n < cap) {
      const row = new Float32Array(cells);
      for (let y = 0; y < VSIZE; y++) { const cy = (y / CELL) | 0, o = y * VSIZE; for (let x = 0; x < VSIZE; x++) { const d = cur[o + x] - prev[o + x]; row[cy * GRID + ((x / CELL) | 0)] += d < 0 ? -d : d; } }
      const med = median(row); // 카메라 흔들림(화면 전체 움직임)은 뺀다
      for (let c = 0; c < cells; c++) motion[n * cells + c] = Math.max(0, (row[c] - med) / (CELL * CELL));
    }
    n++; const t = prev || Buffer.alloc(frameBytes); prev = cur; cur = t;
  };
  await run(ffmpeg, ['-v', 'error', '-hwaccel', 'auto', '-i', file, '-an', '-vf', `fps=${VFPS},scale=${VSIZE}:${VSIZE}:flags=area,format=gray`, '-f', 'rawvideo', '-'], {
    onStdout: (b) => { let o = 0; while (o < b.length) { const k = Math.min(frameBytes - filled, b.length - o); b.copy(cur, filled, o, o + k); filled += k; o += k; if (filled === frameBytes) { filled = 0; onFrame(); } } },
  });
  return { motion, frames: Math.min(n, cap), cells };
}

/** 무리(덩어리 묶음)가 말할 때 가장 뚜렷이 움직이는 칸들과 그 세기. 절반으로 칸을 고르고 나머지 절반으로 잰다(우연히 맞는 칸을 거른다) */
function motionFor(group, quietFrames, mv) {
  const { motion, frames, cells } = mv;
  const framesOf = (list) => { const out = []; for (const i of list) for (let f = Math.ceil(i.start * VFPS) + 1; f < Math.min(frames, Math.floor(i.end * VFPS)); f++) out.push(f); return out; };
  const stat = (fs_) => { const m = new Float64Array(cells); for (const f of fs_) { const o = f * cells; for (let c = 0; c < cells; c++) m[c] += motion[o + c]; } for (let c = 0; c < cells; c++) m[c] /= Math.max(1, fs_.length); return m; };
  const long = group.filter((i) => i.end - i.start >= 0.5);
  if (long.length < 4 || quietFrames.length < 20) return null;
  const pick = framesOf(long.filter((_, k) => k % 2 === 0)), test = framesOf(long.filter((_, k) => k % 2 === 1));
  if (pick.length < 20 || test.length < 20) return null;
  const base = stat(quietFrames), a = stat(pick), b = stat(test);
  const order = [...Array(cells).keys()].sort((p, q) => (a[q] - base[q]) - (a[p] - base[p])).slice(0, 14);
  const gain = mean(order.map((c) => b[c] - base[c])), noise = mean(order.map((c) => base[c])) + 0.05;
  return { cells: order, gain, strength: gain / noise };
}
const islandMotion = (i, cellsIdx, mv) => {
  let s = 0, k = 0;
  for (let f = Math.ceil(i.start * VFPS) + 1; f < Math.min(mv.frames, Math.floor(i.end * VFPS) + 1); f++) { for (const c of cellsIdx) s += mv.motion[f * mv.cells + c]; k++; }
  return k ? s / (k * cellsIdx.length) : null;
};

/**
 * 크기 분포에 골짜기가 없을 때(출연자·코치 크기가 맞닿음): 가장 큰 목소리(꼭대기 3dB 안)가 말할 때 움직이는 칸을 기준으로
 * 덩어리마다 화면 움직임을 재고, "이 크기 위는 움직이고 아래는 안 움직인다"가 가장 잘 맞는 크기를 가르는 선으로 삼는다.
 */
function fitByMotion(islands, top, quietFrames, mv) {
  const A = motionFor(islands.filter((i) => i.level >= top - 3), quietFrames, mv);
  if (!A || A.strength < 0.6) return null;
  const qm = []; for (let f = 0; f < quietFrames.length; f += 3) { let v = 0; for (const c of A.cells) v += mv.motion[quietFrames[f] * mv.cells + c]; qm.push(v / A.cells.length); }
  const base = median(qm), ref = median(islands.filter((i) => i.level >= top - 3 && i.end - i.start >= 0.5).map((i) => islandMotion(i, A.cells, mv)).filter((v) => v != null));
  if (!(ref > base)) return null;
  const pts = islands.filter((i) => i.end - i.start >= 0.5).map((i) => ({ level: i.level, w: i.end - i.start, m: (islandMotion(i, A.cells, mv) - base) / (ref - base) })).filter((q) => Number.isFinite(q.m));
  const total = pts.reduce((a, q) => a + q.w, 0), need = Math.max(3, total * 0.08), tries = [];
  for (let th = top - 3; th >= top - 18; th -= 0.5) {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (const q of pts) { const pos = q.m >= 0.4, pred = q.level >= th; if (pos && pred) tp += q.w; else if (pos) fn += q.w; else if (pred) fp += q.w; else tn += q.w; }
    if (tp + fp < need || fn + tn < need || tp + fn < need || fp + tn < need) continue;
    tries.push({ th, j: tp / (tp + fn) + tn / (tn + fp) - 1 });
  }
  if (!tries.length) return null;
  const k = tries.reduce((b, t, n) => (t.j > tries[b].j ? n : b), 0), max = tries[k].j;
  if (max < 0.45) return null;
  // 비슷하게 잘 맞는 선들(가장 좋은 것에서 0.1 안) 가운데 그 크기의 말이 가장 드문 자리를 고른다 — 두 무리 사이의 빈 곳.
  // 한가운데를 고르면 출연자의 보통 말소리 바로 위에 선이 걸려 온통 '확인 필요'가 됐다(분당 5번).
  let a = k, z = k;
  while (a > 0 && tries[a - 1].j >= max - 0.1) a--;
  while (z + 1 < tries.length && tries[z + 1].j >= max - 0.1) z++;
  const dens = (th) => pts.reduce((s, q) => s + (Math.abs(q.level - th) <= 1 ? q.w : 0), 0);
  let pick = k; for (let n = a; n <= z; n++) if (dens(tries[n].th) < dens(tries[pick].th) - 1e-9) pick = n;
  const threshold = tries[pick].th;
  const wmed = (list) => { const v = list.sort((x, y) => x.level - y.level); let acc = 0; const half = v.reduce((p, q) => p + q.w, 0) / 2; for (const q of v) { acc += q.w; if (acc >= half) return q.level; } return v.at(-1)?.level ?? threshold; };
  const loud = wmed(pts.filter((q) => q.level >= threshold)), quiet = wmed(pts.filter((q) => q.level < threshold));
  return { ok: true, threshold, loud: round(loud, 1), quiet: round(quiet, 1), gap: round(loud - quiet, 1), top, fit: round(max) };
}

/* ---------- 받아쓴 글 ---------- */
export function readWords(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const segs = Array.isArray(j) ? j : j.segments || j.words || j.results || [];
  const out = [];
  for (const s of segs) {
    if (Array.isArray(s.words) && s.words.length) for (const w of s.words) out.push({ text: String(w.word ?? w.text ?? '').trim(), start: Number(w.start), end: Number(w.end) });
    else if (s.start != null && s.end != null) out.push({ text: String(s.word ?? s.text ?? '').trim(), start: Number(s.start), end: Number(s.end) });
  }
  return out.filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
}
const tokens = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
/** 두 글이 같은 문장인가(짧은 쪽 낱말이 긴 쪽에 얼마나 들어 있나) */
export function sameLine(a, b) {
  const x = tokens(a), y = tokens(b); if (!x.length || !y.length) return 0;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]; const pool = [...l]; let hit = 0;
  for (const w of s) { const k = pool.indexOf(w); if (k >= 0) { hit++; pool.splice(k, 1); } }
  return hit / s.length * Math.min(1, s.length / Math.max(1, l.length) + 0.5);
}

/* ---------- 편집본이 쓴 구간과 대조 ---------- */
/** 남긴 구간 목록: [{start,end,text?,source?}] · {ranges:[…]} · 편집 파일(*.oddin-edit.json, 그 원본을 쓴 클립의 in~out) */
export function readKeep(file, mediaFile = '') {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const same = (p) => !p || !mediaFile || path.basename(String(p)).toLowerCase() === path.basename(mediaFile).toLowerCase();
  if (j && j.tracks && j.media) {
    const ids = Object.entries(j.media).filter(([, m]) => same(m.path)).map(([id]) => id), out = [];
    for (const t of j.tracks) for (const c of t.clips || []) if (ids.includes(c.media) && c.in != null && c.out != null && !t.muted && !(c.volume <= -60)) out.push({ start: Number(c.in), end: Number(c.out), text: c.id });
    return out;
  }
  const list = Array.isArray(j) ? j : j.ranges || j.keep || j.clips || [];
  return list.filter((r) => same(r.source || r.path || r.file)).map((r) => ({ start: Number(r.start ?? r.in ?? r.source_start), end: Number(r.end ?? r.out ?? r.source_end), text: r.text || r.id || '', ...(r.speaker === 'pd' || r.allowOff ? { speaker: 'pd' } : {}) })).filter((r) => Number.isFinite(r.start) && r.end > r.start);
}
/** 남긴 구간 안에 들어간 화면 밖 목소리(0.2초 이상 겹치거나 덩어리의 절반 이상) */
export function checkKeep(islands, keep) {
  const out = [];
  keep.forEach((k, idx) => {
    if (k.speaker === 'pd') return; // 종이 편집표에서 '내용'으로 정한 PD 목소리(질문·대화)는 일부러 남긴 것이다
    for (const i of islands) {
      if (i.who === 'on') continue;
      const ov = Math.min(k.end, i.end) - Math.max(k.start, i.start);
      if (ov >= 0.2 || (ov > 0 && ov >= (i.end - i.start) * 0.5)) out.push({ keep: idx, keepStart: k.start, keepEnd: k.end, keepText: k.text || '', who: i.who, start: i.start, end: i.end, overlap: round(ov), level: i.level, text: i.text || '' });
    }
  });
  return out;
}

/* ---------- 묶어서 ---------- */
export async function analyzeSpeakers(file, { words = null, keep = null, video = true, on = null, config = {} } = {}) {
  const { ffmpeg } = tools(config);
  if (!ffmpeg) throw new Error('ffmpeg를 찾지 못했어요');
  if (!fs.existsSync(file)) throw new Error(`파일이 없어요: ${file}`);
  const au = await readAudio(file, ffmpeg);
  const duration = au.ch[0].length / SR;
  const dbs = [frameLevels(au.ch[0]), frameLevels(au.ch[1])];
  // 두 채널이 서로 다른 마이크면(출연자 옷깃 마이크 / PD 마이크) 좌우 차이가 사람을 가르는 가장 확실한 근거다
  const mics = au.both ? dualMics(dbs[0], dbs[1]) : { dual: false, spread: 0 };
  let db = dbs[au.main], aux = null;
  if (mics.dual) { const n = Math.min(dbs[0].length, dbs[1].length); db = new Float32Array(n); aux = new Float32Array(n); for (let f = 0; f < n; f++) { db[f] = Math.max(dbs[0][f], dbs[1][f]); aux[f] = dbs[0][f] - dbs[1][f]; } }
  const { islands, floor, threshold } = findIslands(db, { aux });
  let split = mics.dual ? diffSplit(islands) : levelSplit(islands);
  const channels = mics.dual && split.ok;
  if (mics.dual && !split.ok) split = levelSplit(islands);
  const feat = (i) => (channels ? i.diff : i.level);
  for (const i of islands) { i.start = round(i.start); i.end = round(i.end); i.level = round(i.level, 1); if (i.diff != null) i.diff = round(i.diff, 1); i.side = feat(i) >= (split.ok ? split.threshold : (split.top ?? -200) - 8) ? 'loud' : 'quiet'; }
  if (channels) {
    // 좌우 차이는 말소리 크기와 상관없이 사람(마이크 위치)마다 일정하다. 두 마이크 주인의 자리(가운데값)를 큰 소리 덩어리로 잡고,
    // 어느 쪽에도 가깝지 않은 것(두 마이크에 비슷하게 들어온 먼 소리·다른 사람)은 따로 'mid'로 둔다 — 마이크를 찬 두 사람 누구도 아니다.
    const center = (side) => {
      const g = islands.filter((i) => i.side === side && i.end - i.start >= 0.3); if (!g.length) return null;
      const cut = [...g].sort((x, y) => y.level - x.level)[Math.floor(g.length * 0.4)].level;
      return median(g.filter((i) => i.level >= cut).map((i) => i.diff));
    };
    const cA = center('loud'), cB = center('quiet');
    if (cA != null && cB != null && cA - cB >= 6) {
      const half = Math.max(4, (cA - cB) / 3);
      for (const i of islands) {
        if (i.diff >= cA - half) { i.side = 'loud'; i.margin = i.diff - (cA - half); }
        else if (i.diff <= cB + half) { i.side = 'quiet'; i.margin = (cB + half) - i.diff; }
        else { i.side = 'mid'; i.margin = 0; }
      }
      split.loud = round(cA, 1); split.quiet = round(cB, 1); split.gap = round(cA - cB, 1);
    }
  }
  // 받아쓴 글이 있으면 덩어리에 붙인다(누가 먼저 읽고 누가 따라 했는지 보는 데도 쓴다)
  if (words?.length) for (const i of islands) i.text = words.filter((w) => { const c = (w.start + w.end) / 2; return c >= i.start - 0.06 && c <= i.end + 0.06; }).map((w) => w.text).join(' ').trim();
  let single = !split.ok && split.top != null; // 크기 분포에 골짜기가 없음

  // 화면: 어느 무리가 화면 속 사람의 움직임과 맞는가
  let visual = { used: false, reason: video ? '' : '화면 분석을 껐어요' }, mv = null;
  if (video && (split.ok || single)) {
    try { mv = await readMotion(file, ffmpeg, duration); } catch (e) { visual.reason = `화면을 읽지 못했어요: ${e.message}`; }
    if (mv && mv.frames < VFPS * 2) { visual.reason = '영상이 없어요(소리만)'; mv = null; }
  }
  let onSide = 'loud', basis = channels ? 'channels' : split.ok ? 'level' : single ? 'single' : 'none', cellsIdx = null, base = 0, ref = 0;
  if (mv) {
    const busy = new Uint8Array(mv.frames);
    for (const i of islands) for (let f = Math.max(0, Math.floor((i.start - 0.2) * VFPS)); f < Math.min(mv.frames, Math.ceil((i.end + 0.2) * VFPS)); f++) busy[f] = 1;
    const quiet = []; for (let f = 1; f < mv.frames; f++) if (!busy[f]) quiet.push(f);
    if (single && split.weak?.length) { // 얕은 골짜기 후보들 가운데 "위쪽이 말할 때만 화면이 움직인다"가 가장 뚜렷한 선을 고른다(출연자·읽어 주는 사람·PD 셋이 가까울 때)
      let pickW = null;
      for (const th of split.weak) {
        const Lw = motionFor(islands.filter((i) => i.level >= th), quiet, mv), Qw = motionFor(islands.filter((i) => i.level < th), quiet, mv);
        if (!Lw || Lw.strength < 0.6) continue;
        const ratio = Lw.strength / Math.max(0.2, Qw?.strength ?? 0);
        if (ratio >= 1.5 && (!pickW || ratio > pickW.ratio)) pickW = { th, ratio };
      }
      if (pickW) {
        const wm = (list) => median(list.filter((i) => i.end - i.start >= 0.3).map((i) => i.level));
        const up = wm(islands.filter((i) => i.level >= pickW.th)), dn = wm(islands.filter((i) => i.level < pickW.th));
        split = { ok: true, threshold: pickW.th, loud: round(up, 1), quiet: round(dn, 1), gap: round(up - dn, 1), top: split.top, fit: round(pickW.ratio) };
        single = false; basis = 'level'; for (const i of islands) i.side = i.level >= split.threshold ? 'loud' : 'quiet';
      }
    }
    if (single) { // 골짜기가 없으면 화면 움직임으로 가르는 선을 찾는다
      const fit = fitByMotion(islands, split.top, quiet, mv);
      if (fit) { split = fit; single = false; basis = 'level'; for (const i of islands) i.side = i.level >= split.threshold ? 'loud' : 'quiet'; }
    }
    const L = motionFor(islands.filter((i) => i.side === 'loud'), quiet, mv), Q = motionFor(islands.filter((i) => i.side === 'quiet'), quiet, mv);
    visual = { used: true, loud: L ? round(L.strength) : null, quiet: Q ? round(Q.strength) : null };
    const l = L?.strength ?? 0, q = Q?.strength ?? 0;
    if (Math.max(l, q) < 0.6) visual.reason = '말할 때 화면 속 움직임이 뚜렷하지 않아요(입이 가려졌거나 화면에 사람이 없음)';
    else if (single) { if (l >= 0.6) cellsIdx = L.cells; }
    else if (channels) { // 어느 마이크 쪽이 화면 속인지는 크기로 알 수 없다 — 화면으로만 정한다
      if (l > q * 1.3) { basis = 'channels+motion'; cellsIdx = L.cells; }
      else if (q > l * 1.3) { onSide = 'quiet'; basis = 'channels+motion'; cellsIdx = Q.cells; }
      else visual.reason = '두 목소리 모두에서 화면이 비슷하게 움직여요(둘 다 화면 안에 있을 수 있음)';
    }
    else if (q > l * 1.8 && q >= 1) { onSide = 'quiet'; basis = 'motion'; cellsIdx = Q.cells; }
    else if (l > q * 1.3) { basis = 'level+motion'; cellsIdx = L.cells; }
    else visual.reason = '두 목소리 모두에서 화면이 비슷하게 움직여요(둘 다 화면 안에 있을 수 있음)';
    if (cellsIdx) {
      const qm = []; for (let f = 0; f < quiet.length; f += 3) { let s = 0; for (const c of cellsIdx) s += mv.motion[quiet[f] * mv.cells + c]; qm.push(s / cellsIdx.length); }
      base = median(qm);
      ref = median(islands.filter((i) => i.side === onSide && i.end - i.start >= 0.5).map((i) => islandMotion(i, cellsIdx, mv)).filter((v) => v != null));
    }
  }
  // 직접 정하기(--on a|b): 화면으로 못 정했거나 판정이 뒤집혔을 때. a = 큰 목소리(두 마이크면 왼쪽 채널이 더 큰 목소리), b = 그 반대
  let forced = false;
  if (on === 'a' || on === 'b') { const want = on === 'a' ? 'loud' : 'quiet'; if (want !== onSide) cellsIdx = null; onSide = want; forced = true; }
  // 두 마이크인데 화면으로 못 정했으면: 같은 문장을 한쪽이 먼저 읽고 다른 쪽이 따라 한 방향으로 정한다(따라 하는 쪽이 출연자)
  if (channels && basis === 'channels' && !forced && words?.length) {
    const dir = { 'quiet>loud': 0, 'loud>quiet': 0 };
    for (let a = 0; a < islands.length; a++) {
      const A = islands[a]; if (A.side === 'mid' || tokens(A.text).length < 2) continue;
      for (let b = a + 1; b < islands.length && islands[b].start - A.end < 20; b++) {
        const B = islands[b]; if (B.side === 'mid' || B.side === A.side) continue;
        if (sameLine(A.text, B.text) >= 0.6) { dir[`${A.side}>${B.side}`]++; break; }
      }
    }
    const up = dir['quiet>loud'], down = dir['loud>quiet'];
    if (Math.max(up, down) >= 3 && Math.max(up, down) >= 2 * Math.min(up, down) + 1) { onSide = up > down ? 'loud' : 'quiet'; basis = 'channels+lead'; }
  }
  const unknown = channels && basis === 'channels' && !forced; // 두 사람은 갈랐지만 누가 화면 속인지 모름
  for (const i of islands) {
    const levelOn = i.side === onSide, len = i.end - i.start;
    const margin = i.margin ?? (split.ok ? Math.abs(feat(i) - split.threshold) : 0);
    i.group = i.side === 'loud' ? 'a' : i.side === 'mid' ? 'c' : 'b';
    let m = null;
    if (cellsIdx && len >= 0.4 && ref > base) { const v = islandMotion(i, cellsIdx, mv); if (v != null) m = round((v - base) / (ref - base)); }
    i.motion = m;
    // '화면 속'은 확실할 때만 준다 — 여기에 화면 밖 목소리가 섞이면 그대로 영상에 들어간다. 애매하면 '확인 필요'.
    if (unknown) i.who = 'unsure';
    else if (i.side === 'mid') i.who = i.level >= floor + 12 ? 'off' : 'unsure'; // 두 마이크 누구의 목소리도 아님(먼 소리·다른 사람)
    else if (single) i.who = levelOn && !(m != null && m < 0.25) ? 'on' : 'unsure'; // 한 무리: 큰데 화면이 안 움직이는 것과 한참 작은 것은 확인 필요
    else if (!split.ok) i.who = 'unsure';
    else if (levelOn) i.who = margin >= 5 ? 'on' : margin >= 2 ? (m == null || m >= 0.25 ? 'on' : 'unsure') : (m != null && m >= 0.6 ? 'on' : 'unsure');
    else i.who = (m != null && m >= 0.6) || margin < 2 ? 'unsure' : 'off'; // 작은 목소리인데 화면 속 사람이 움직임 = 작게 말했을 수도, 듣다가 움직였을 수도
    delete i.side; delete i.margin;
  }

  // "먼저 읽어 주고 따라 한" 쌍
  let pairs = [];
  if (words?.length) {
    for (let a = 0; a < islands.length; a++) {
      const A = islands[a]; if (A.who !== 'off' || tokens(A.text).length < 2) continue;
      for (let b = a + 1; b < islands.length && islands[b].start - A.end < 20; b++) {
        const B = islands[b]; if (B.who !== 'on') continue;
        if (sameLine(A.text, B.text) >= 0.6) { pairs.push({ lead: [A.start, A.end], repeat: [B.start, B.end], text: A.text }); break; }
      }
    }
  }
  const sum = (who) => round(islands.filter((i) => i.who === who).reduce((p, i) => p + i.end - i.start, 0), 1);
  const result = {
    file, duration: round(duration), basis, // level+motion: 크기와 화면이 맞음 / level: 크기만(화면 근거 없음) / motion: 화면 기준(화면 속 사람이 더 작은 목소리) / single: 한 무리뿐 / none: 못 가름
    levels: split.ok ? { threshold: round(split.threshold, 1), loud: split.loud, quiet: split.quiet, gap: split.gap, ...(split.fit ? { by: 'motion', fit: split.fit } : {}), ...(channels ? { by: 'channels' } : {}) } : { reason: split.reason, top: split.top },
    mics: { dual: mics.dual, spread: round(mics.spread, 1) }, onGroup: unknown || !split.ok ? null : onSide === 'loud' ? 'a' : 'b', forced,
    noiseFloor: round(floor, 1), speechThreshold: round(threshold, 1),
    visual,
    seconds: { on: sum('on'), off: sum('off'), unsure: sum('unsure') },
    islands, pairs,
  };
  if (keep) { result.leaks = checkKeep(islands, keep); for (const l of result.leaks) { const pr = pairs.find((q) => q.lead[0] === l.start); if (pr) l.instead = pr.repeat; } } // 같은 문장을 출연자가 따라 한 곳
  return result;
}

const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const NAME = { on: '화면 속', off: '화면 밖', unsure: '확인 필요' };
/** 사람이 읽는 보고 */
export function speakersReport(r, { all = false } = {}) {
  const out = [];
  out.push(`${path.basename(r.file)} · ${mmss(r.duration)} · 화면 속 ${r.seconds.on}초 / 화면 밖 ${r.seconds.off}초 / 확인 필요 ${r.seconds.unsure}초`);
  if (r.basis === 'none') out.push(`가르지 못했어요: ${r.levels.reason}`);
  else if (r.basis === 'single') out.push(`목소리가 한 무리로만 잡혀요(${r.levels.reason}) — 화면 밖 목소리가 거의 없거나 두 사람이 비슷한 크기로 녹음됐어요. 비슷한 크기라면 크기로는 못 가르니, 큰데 화면이 안 움직이는 덩어리와 한참 작은 덩어리를 '확인 필요'로 뒀어요.`);
  else if (r.levels.by === 'channels') {
    out.push(`두 채널이 서로 다른 마이크예요(좌우 차이 폭 ${r.mics.spread}dB) — 좌우 차이로 두 목소리를 갈랐어요: a 무리 ${r.levels.loud}dB / b 무리 ${r.levels.quiet}dB (왼쪽−오른쪽, 가르는 선 ${r.levels.threshold}dB)`);
    out.push(r.forced ? `화면 속 = ${r.onGroup} 무리(직접 정함)` : r.onGroup ? `근거: ${r.basis === 'channels+lead' ? '같은 문장을 먼저 읽은 쪽과 따라 한 쪽의 순서로 정했어요(따라 한 쪽이 출연자, 화면 근거는 없음)' : '좌우 차이와 화면 움직임이 서로 맞아요'} — 화면 속 = ${r.onGroup} 무리 (c 무리 = 두 마이크 누구의 목소리도 아닌 먼 소리)` : `누가 화면 속인지는 화면으로 정하지 못했어요. 아래 목록에서 a·b 무리의 시각을 하나씩 골라 화면(입)을 직접 보고 --on a 또는 --on b 로 다시 돌리세요. 그 전에는 모두 '확인 필요'예요.`);
  }
  else out.push(`${r.forced ? `화면 속 = ${r.onGroup} 무리(직접 정함) · ` : ''}근거: ${{ 'level+motion': '소리 크기와 화면 움직임이 서로 맞아요', level: '소리 크기만(화면 근거 없음 — 큰 목소리를 화면 속으로 봄)', motion: '화면 움직임 기준(화면 속 사람 목소리가 더 작게 녹음됨)' }[r.basis]} · 큰 목소리 ${r.levels.loud}dB / 작은 목소리 ${r.levels.quiet}dB / 가르는 선 ${r.levels.threshold}dB`);
  if (r.visual?.reason) out.push(`화면: ${r.visual.reason}`);
  if (r.pairs?.length) out.push(`먼저 읽어 주고 따라 한 쌍 ${r.pairs.length}개 — 앞쪽(화면 밖)을 빼고 뒤쪽(화면 속)을 쓴다`);
  if (r.leaks) {
    out.push(r.leaks.length ? `\n남긴 구간에 화면 밖 목소리가 ${r.leaks.filter((l) => l.who === 'off').length}곳, 확인 필요 ${r.leaks.filter((l) => l.who === 'unsure').length}곳 들어 있어요:` : '\n남긴 구간에 화면 밖 목소리가 없어요');
    for (const l of r.leaks) out.push(`  [${NAME[l.who]}] 원본 ${mmss(l.start)}~${mmss(l.end)} (${l.level}dB, ${l.overlap}초 겹침) "${l.text}" ← 남긴 구간 ${l.keep + 1} ${mmss(l.keepStart)}~${mmss(l.keepEnd)} ${l.keepText ? `"${l.keepText}"` : ''}${l.instead ? ` → 같은 문장을 화면 속에서 말한 곳 ${mmss(l.instead[0])}~${mmss(l.instead[1])}` : ''}`);
  }
  if (all || !r.leaks) {
    out.push('\n말 덩어리(원본 시각 · 누구 · 무리 · 크기 · 화면 움직임):');
    for (const i of r.islands) out.push(`  ${mmss(i.start)}~${mmss(i.end)}  ${NAME[i.who].padEnd(5)} ${i.group || '-'} ${String(i.level).padStart(6)}dB${i.diff != null ? ` 좌우${String(i.diff).padStart(6)}` : ''}  ${i.motion == null ? '   -' : String(i.motion).padStart(5)}  ${i.text || ''}`);
  }
  return out.join('\n');
}
