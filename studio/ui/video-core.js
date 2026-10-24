/* ODDIN 스튜디오 공용 코어 (2026-10-10, replica/architecture.md · docs/studio.md)
   편집기 화면(studio/ui/editor.js) · 렌더 페이지(studio/ui/render.html) · 엔진(studio/engine/edit.mjs, vm 으로 읽음)이 같은 코드를 쓴다
   → 미리보기와 렌더 결과가 같은 계산·같은 그리기로 나온다.
   - 편집 파일 형식 정리(normalize) · 길이 · 스타일 합치기
   - 키프레임 값(valueAt) · 이징(EASE — 서버의 ffmpeg 식 EASE_EXPR 과 같은 공식) · 등장/퇴장 효과
   - 글자·자막 레이어 그리기(renderOverlay) · SRT 읽기/쓰기 · 시간 표기
   - 원본 넣기(placeMedia — 화면 끌어 넣기·CLI add 공통) · SRT 를 자막 트랙으로(srtTrack)
   - 편집기 중심 제작(2026-10-24 사용자 "AI가 편집기로 조립하는 게 이상적 — 없는 기능은 더 추가해줘"):
     영상 클립 불투명도 키프레임·화면 들어오기/나가기(clipOpacity), 소리 크기 키프레임(clipGain), 클립 이름표(label)·원본 만든 방법(source),
     "통째로 구운 편집" 찾기(editability) */
(function (root) {
  'use strict';
  const PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
  const BASE = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  // 클립(영상·소리)은 소리 크기(dB)도 키프레임으로 움직인다 — 음악 줄였다 키우기
  // 3D 기울이기(rotationX·rotationY)·깊이(z — 카메라), 클립은 소리 크기·속도, 글자·도형은 선 그리기(trim)
  const CLIP_PROPS = [...PROPS, 'rotationX', 'rotationY', 'z', 'volume', 'speed'], ITEM_PROPS = [...PROPS, 'rotationX', 'rotationY', 'z', 'trimStart', 'trimEnd'];
  const CLIP_BASE = { ...BASE, rotationX: 0, rotationY: 0, z: 0, volume: 0, speed: 1, trimStart: 0, trimEnd: 1 };
  const KEY_RANGE = { volume: [-60, 24], speed: [0.05, 16], trimStart: [0, 1], trimEnd: [0, 1] };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  // 원본 종류: 영상·소리(video) · 그림(image, 길이 없음) · HTML 장면(html). 화면 맞춤: 꽉 채우기·다 보이게·원래 크기
  const KINDS = ['video', 'image', 'html', 'adjust', 'edit'], FITS = ['cover', 'contain', 'none'];
  const kindOf = (p) => (/\.oddin-edit\.json$/i.test(p) ? 'edit' : /\.html?$/i.test(p) ? 'html' : /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(p) ? 'image' : 'video');

  /* ---------- 이징: p(0~1) → 진행(0~1). 서버 EASE_EXPR 과 같은 공식 ---------- */
  const C1 = 1.70158, C3 = C1 + 1;
  const EASE = {
    linear: (p) => p,
    ease: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    in: (p) => p * p * p,
    out: (p) => 1 - Math.pow(1 - p, 3),
    hold: () => 0,
    snap: (p) => 1 + C3 * Math.pow(p - 1, 3) + C1 * Math.pow(p - 1, 2),
    expo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    // 2026-10-24 더함(렌더는 잘게 나눈 직선으로 옮긴다 — edit.mjs expandKeys)
    sine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
    circ: (p) => (p < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * p, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * p + 2, 2)) + 1) / 2),
    back: (p) => { const c2 = C1 * 1.525; return p < 0.5 ? (Math.pow(2 * p, 2) * ((c2 + 1) * 2 * p - c2)) / 2 : (Math.pow(2 * p - 2, 2) * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2; },
    elastic: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
    bounce: (p) => { const n = 7.5625, d = 2.75; if (p < 1 / d) return n * p * p; if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75; if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375; return n * (p -= 2.625 / d) * p + 0.984375; },
    bezier: (p) => p, // 실제 모양은 키의 bz:[x1,y1,x2,y2] (easeFn)
  };
  /** 3차 베지어 이징(CSS cubic-bezier 와 같음) — 그래프 편집기 대신 숫자 넷으로 */
  const bzCache = new Map();
  function bezierFn(bz) {
    const [x1, y1, x2, y2] = bz, key = bz.join(','); if (bzCache.has(key)) return bzCache.get(key);
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (s) => ((ax * s + bx) * s + cx) * s, Y = (s) => ((ay * s + by) * s + cy) * s, dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
    const f = (p) => { if (p <= 0) return 0; if (p >= 1) return 1; let s = p; for (let i = 0; i < 8; i++) { const e = X(s) - p, d = dX(s); if (Math.abs(e) < 1e-7) break; if (Math.abs(d) < 1e-6) break; s -= e / d; } if (s < 0 || s > 1 || Math.abs(X(s) - p) > 1e-5) { let a = 0, b = 1; s = p; for (let i = 0; i < 40; i++) { if (X(s) < p) a = s; else b = s; s = (a + b) / 2; } } return Y(s); };
    if (bzCache.size > 200) bzCache.clear(); bzCache.set(key, f); return f;
  }
  const easeFn = (k) => (k.ease === 'bezier' && Array.isArray(k.bz) ? bezierFn(k.bz) : EASE[k.ease] || EASE.linear);
  const EASE_KO = { linear: '일정하게', ease: '부드럽게', in: '천천히 시작', out: '천천히 멈춤', hold: '정지(뚝 바뀜)', snap: '쫀득(살짝 튐)', expo: '빠르게 붙음', sine: '사인', circ: '원형', back: '살짝 뒤로 갔다', elastic: '탄성', bounce: '튕김', bezier: '곡선(bz)' };
  const ANIM = ['none', 'fade', 'pop', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'zoom', 'type', 'blur', 'drop', 'rise', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'spin', 'flip'];
  const ANIM_KO = { none: '없음', fade: '페이드', pop: '팝', slideUp: '아래에서 위로', slideDown: '위에서 아래로', slideLeft: '오른쪽에서', slideRight: '왼쪽에서', zoom: '줌', type: '타자(하나씩)', blur: '흐림에서', drop: '떨어져 튕김', rise: '아래에서 솟음(가림)', wipeLeft: '지우며(←)', wipeRight: '지우며(→)', wipeUp: '지우며(↑)', wipeDown: '지우며(↓)', spin: '돌며', flip: '뒤집으며' };
  const UNITS = ['all', 'char', 'word', 'line'], LOOPS = ['none', 'pulse', 'shake', 'wave', 'float', 'blink', 'spin', 'swing'];

  /** 키프레임 값: keys 가 없으면 base. t 는 그 클립·자막 시작 기준 초 */
  function valueAt(base, keys, t) {
    if (!Array.isArray(keys) || !keys.length) return base;
    if (t <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a.t && t < b.t) {
        const span = b.t - a.t; if (span <= 0) return b.v;
        return a.v + (b.v - a.v) * easeFn(a)((t - a.t) / span);
      }
    }
    return last.v;
  }

  /* ---------- 스타일 ---------- */
  const STYLE_DEFAULT = { font: 'Noto Sans KR', size: 64, weight: 800, color: '#ffffff', gradient: null, stroke: { color: '#000000', width: 8 }, shadow: { x: 0, y: 4, blur: 12, color: '#00000099' }, bg: null, align: 'center', lineHeight: 1.2, letterSpacing: 0, maxWidth: 960, oneLine: true, italic: false };
  function styleOf(doc, track, item) {
    const st = doc.styles || {};
    const pick = (name) => (name && st[name] && typeof st[name] === 'object' ? st[name] : {});
    const out = Object.assign({}, STYLE_DEFAULT, pick(track && track.style), pick(item && item.style), (item && item.override) || {});
    out.stroke = out.stroke && Number(out.stroke.width) > 0 ? { color: out.stroke.color || '#000000', width: num(out.stroke.width, 0) } : null;
    out.shadow = out.shadow && (out.shadow.blur || out.shadow.x || out.shadow.y) ? { x: num(out.shadow.x, 0), y: num(out.shadow.y, 0), blur: num(out.shadow.blur, 0), color: out.shadow.color || '#00000099' } : null;
    out.bg = out.bg && out.bg.color ? { color: out.bg.color, padX: num(out.bg.padX, 16), padY: num(out.bg.padY, 8), radius: num(out.bg.radius, 8) } : null;
    out.gradient = out.gradient && out.gradient.from && out.gradient.to ? { from: out.gradient.from, to: out.gradient.to, angle: num(out.gradient.angle, 180) } : null;
    return out;
  }

  /* ---------- 정리: 빠진 값 채우기·잘못된 값 고치기 ---------- */
  let seq = 0;
  const uid = (p) => `${p}${Date.now().toString(36).slice(-4)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  /** 키 목록 하나 정리: 시각 순, 같은 시각은 뒤 것, 이징 이름·베지어 숫자 */
  function cleanKeyList(list, fix, base) {
    const ks = (Array.isArray(list) ? list : []).map((k) => {
      const out = { t: r4(Math.max(0, num(k && k.t, 0))), v: fix(num(k && k.v, base)), ease: EASE[k && k.ease] ? k.ease : 'ease' };
      if (out.ease === 'bezier') { const b = Array.isArray(k.bz) && k.bz.length === 4 && k.bz.every((x) => Number.isFinite(Number(x))) ? k.bz.map(Number) : [0.25, 0.1, 0.25, 1]; out.bz = [clamp(b[0], 0, 1), b[1], clamp(b[2], 0, 1), b[3]]; }
      return out;
    }).sort((a, b) => a.t - b.t);
    const uniq = []; for (const k of ks) { if (uniq.length && Math.abs(uniq[uniq.length - 1].t - k.t) < 1e-4) uniq[uniq.length - 1] = k; else uniq.push(k); }
    return uniq;
  }
  function cleanKeys(keys, props = PROPS) {
    const out = {};
    if (!keys || typeof keys !== 'object') return out;
    for (const p of props) {
      const r = KEY_RANGE[p], ks = cleanKeyList(keys[p], (v) => (r ? clamp(v, r[0], r[1]) : v), CLIP_BASE[p]);
      if (ks.length) out[p] = ks;
    }
    return out;
  }
  /** 위치·크기·회전·불투명도(+ three: 3D 기울이기, 깊이 z 는 준 때만 — 없으면 카메라에 안 비치는 2D 층) */
  function transformOf(o, three = false) {
    const t = {}; for (const p of PROPS) t[p] = num(o && o[p], BASE[p]); t.opacity = clamp(t.opacity, 0, 1);
    if (three) { for (const p of ['rotationX', 'rotationY']) if (num(o && o[p], 0)) t[p] = num(o[p], 0); if (o && o.z != null && o.z !== '' && Number.isFinite(Number(o.z))) t.z = Number(o.z); }
    return t;
  }
  /** 편집 파일 정리. 고친 점은 problems 에 사람 말로 */
  function normalize(input) {
    const problems = [];
    const d = input && typeof input === 'object' ? input : {};
    const doc = {
      oddinEdit: 1, title: String(d.title || '편집'),
      width: clamp(Math.round(num(d.width, 1080)), 16, 7680), height: clamp(Math.round(num(d.height, 1920)), 16, 7680),
      fps: clamp(num(d.fps, 30), 1, 120), background: typeof d.background === 'string' ? d.background : '#000000',
      media: {}, styles: {}, tracks: [], markers: [],
    };
    // 2026-10-24: 카메라(2.5D)·모션 블러·소리 마무리·출력 형식 — 있을 때만
    const cam = cleanCamera(d.camera); if (cam) doc.camera = cam;
    if (d.motionBlur) doc.motionBlur = { samples: clamp(Math.round(num(d.motionBlur.samples, 8)), 2, 16), shutter: clamp(num(d.motionBlur.shutter, 0.5), 0.1, 1), all: !!d.motionBlur.all };
    if (d.audio && typeof d.audio === 'object') doc.audio = { loudness: d.audio.loudness == null ? null : clamp(num(d.audio.loudness, -14), -40, -5), limit: d.audio.limit !== false };
    if (d.output && typeof d.output === 'object') doc.output = cleanOutput(d.output);
    for (const [id, m] of Object.entries(d.media && typeof d.media === 'object' ? d.media : {})) {
      if (!m || typeof m.path !== 'string' || (!m.path && m.kind !== 'adjust')) { problems.push(`원본 ${id}: 경로가 없어 뺐어요`); continue; }
      const kind = KINDS.includes(m.kind) ? m.kind : kindOf(m.path);
      // source = 이 재료를 어떻게 만들었는지(AI 가 스크립트로 그린 그림·음악 등 — 다시 만들 때 쓰는 명령·설명). 편집기는 보여 주기만 한다
      doc.media[id] = { path: m.path, kind, duration: kind === 'image' || kind === 'adjust' ? 0 : num(m.duration, 0), width: kind === 'adjust' ? doc.width : num(m.width, 0), height: kind === 'adjust' ? doc.height : num(m.height, 0), fps: num(m.fps, 0), audio: (kind === 'video' || kind === 'edit') && m.audio !== false, ...(m.name ? { name: String(m.name) } : {}), ...(m.source ? { source: String(m.source).slice(0, 400) } : {}) };
    }
    for (const [name, s] of Object.entries(d.styles && typeof d.styles === 'object' ? d.styles : {})) if (s && typeof s === 'object') doc.styles[String(name)] = s;
    // id 가 없는(또는 겹친) 칸은 정해진 id — 같은 파일이면 읽을 때마다 같은 id(렌더 지문·최신 렌더 확인이 흔들리지 않게, 2026-10-24). 파일에 적힌 id 와 겹치지 않게 먼저 모은다
    const ids = new Set(), reserved = new Set(), okId = (id) => typeof id === 'string' && /^[\w-]{1,40}$/.test(id);
    for (const tr of Array.isArray(d.tracks) ? d.tracks : []) { if (!tr) continue; if (okId(tr.id)) reserved.add(tr.id); for (const x of [...(Array.isArray(tr.items) ? tr.items : []), ...(Array.isArray(tr.clips) ? tr.clips : [])]) if (x && okId(x.id)) reserved.add(x.id); }
    for (const mk of Array.isArray(d.markers) ? d.markers : []) if (mk && okId(mk.id)) reserved.add(mk.id);
    let auto = 0;
    const fresh = (id, p) => { let v = okId(id) && !ids.has(id) ? id : null; if (!v) do { v = `${p}${++auto}`; } while (ids.has(v) || reserved.has(v)); ids.add(v); return v; };
    for (const tr of Array.isArray(d.tracks) ? d.tracks : []) {
      const kind = ['video', 'audio', 'text'].includes(tr && tr.kind) ? tr.kind : null;
      if (!kind) { problems.push('종류를 모르는 트랙을 뺐어요'); continue; }
      const t = { id: fresh(tr.id, kind[0]), kind, name: String(tr.name || { video: '영상', audio: '소리', text: '자막' }[kind]), muted: !!tr.muted, hidden: !!tr.hidden, locked: !!tr.locked };
      if (kind !== 'text') { const au = cleanTrackAudio(tr.audio); if (au) t.audio = au; }
      if (kind === 'text') {
        t.style = tr.style ? String(tr.style) : null;
        t.items = (Array.isArray(tr.items) ? tr.items : []).map((it) => normItem(it, doc, fresh)).sort((a, b) => a.start - b.start);
      } else {
        t.clips = (Array.isArray(tr.clips) ? tr.clips : []).filter((c) => {
          if (c && doc.media[c.media]) return true;
          problems.push(`없는 원본(${c && c.media})을 쓰는 클립을 뺐어요`); return false;
        }).map((c) => {
          const m = doc.media[c.media];
          let inn = Math.max(0, num(c.in, 0)), out = Math.max(inn + 1 / doc.fps, num(c.out, m.duration || inn + 1));
          if (m.duration && out > m.duration + 0.001) { out = m.duration; if (inn >= out) inn = Math.max(0, out - 1 / doc.fps); problems.push(`클립 ${c.id || ''}: 원본 길이를 넘어 끝을 줄였어요`); }
          return normClip(c, { id: fresh(c.id, 'c'), media: c.media, start: r4(Math.max(0, num(c.start, 0))), in: r4(inn), out: r4(out) }, doc);
        }).sort((a, b) => a.start - b.start);
      }
      doc.tracks.push(t);
    }
    if (!doc.tracks.length) doc.tracks.push({ id: fresh('v1', 'v'), kind: 'video', name: '영상', muted: false, hidden: false, locked: false, clips: [] });
    for (const mk of Array.isArray(d.markers) ? d.markers : []) if (mk && Number.isFinite(Number(mk.t))) doc.markers.push({ id: fresh(mk.id, 'k'), t: r4(Math.max(0, Number(mk.t))), label: String(mk.label || '') });
    doc.markers.sort((a, b) => a.t - b.t);
    return { doc, problems };
  }
  const clipEnd = (c) => c.start + clipLen(c);
  function duration(doc) {
    let d = 0;
    for (const t of doc.tracks) for (const x of t.clips || t.items || []) d = Math.max(d, t.kind === 'text' ? x.end : clipEnd(x));
    return r4(d);
  }

  /* ---------- 프로 기능 (2026-10-24 사용자 "전부 다 넣어주고, 오딘 친화적으로만 해주면 돼") ----------
     편집 파일에 적는 값 → 미리보기(이 파일)·렌더(edit.mjs·fx.mjs·audio-mix.mjs)가 같은 정의로 쓴다. 형식은 스킬 references/edit-format.md */
  const DIRS = ['left', 'right', 'up', 'down'], DIRV = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }, OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };
  const perspOf = (doc) => (doc && doc.camera && doc.camera.perspective) || Math.round(Math.hypot((doc && doc.width) || 1920, (doc && doc.height) || 1080) * 1.2);

  /* 속도·되감기·멈춤: speed(배속, 0.05~16), keys.speed(속도 램프 — 타임라인 시각 기준), reverse, freeze(초 — in 프레임을 그만큼 멈춤) */
  const speedCache = new Map();
  const speedKeys = (c) => { const ks = c.keys && c.keys.speed; return Array.isArray(ks) && ks.length ? ks : null; };
  function speedAt(c, lt) { if (c.freeze > 0) return 0; const ks = speedKeys(c); return ks ? valueAt(num(c.speed, 1), ks, lt) : num(c.speed, 1) || 1; }
  /** 속도 램프의 ∫속도 표(첫 키~끝 키 사이만 — 바깥은 일정한 속도) */
  function speedTable(ks) {
    const key = JSON.stringify(ks); let tb = speedCache.get(key); if (tb) return tb;
    const t0 = ks[0].t, t1 = ks[ks.length - 1].t, n = Math.max(1, Math.min(40000, Math.ceil((t1 - t0) * 480)));
    const ts = new Float64Array(n + 1), ss = new Float64Array(n + 1), v = (t) => valueAt(ks[0].v, ks, t);
    let acc = ks[0].v * t0; ts[0] = t0; ss[0] = acc;
    for (let i = 1; i <= n; i++) { const a = t0 + (t1 - t0) * (i - 1) / n, b = t0 + (t1 - t0) * i / n; acc += (b - a) * (v(a) + 4 * v((a + b) / 2) + v(b)) / 6; ts[i] = b; ss[i] = acc; }
    tb = { t0, t1, v0: ks[0].v, v1: ks[ks.length - 1].v, ts, ss, n };
    if (speedCache.size > 100) speedCache.clear(); speedCache.set(key, tb); return tb;
  }
  /** 클립 시작부터 lt 초 동안 지나간 원본 길이 */
  function srcOffset(c, lt) {
    if (c.freeze > 0) return 0;
    const ks = speedKeys(c); if (!ks) return lt * (num(c.speed, 1) || 1);
    const tb = speedTable(ks);
    if (lt <= tb.t0) return lt * tb.v0;
    if (lt >= tb.t1) return tb.ss[tb.n] + (lt - tb.t1) * tb.v1;
    const f = (lt - tb.t0) / (tb.t1 - tb.t0) * tb.n, i = Math.min(tb.n - 1, Math.floor(f));
    return tb.ss[i] + (tb.ss[i + 1] - tb.ss[i]) * (f - i);
  }
  /** 타임라인 lt(클립 안 시각)에 보여 줄 원본 시각 */
  function sourceTime(c, lt) {
    if (c.freeze > 0) return c.in;
    const o = clamp(srcOffset(c, lt), 0, c.out - c.in);
    return c.reverse ? c.out - o : c.in + o;
  }
  /** 타임라인 위 클립 길이(속도·램프·멈춤 반영) */
  function clipLen(c) {
    if (c.freeze > 0) return c.freeze;
    const span = c.out - c.in, ks = speedKeys(c);
    if (!ks) return span / (num(c.speed, 1) || 1);
    const tb = speedTable(ks);
    if (span <= tb.t0 * tb.v0) return span / tb.v0;
    if (span >= tb.ss[tb.n]) return tb.t1 + (span - tb.ss[tb.n]) / tb.v1;
    let a = 0, b = tb.n; while (b - a > 1) { const m = (a + b) >> 1; if (tb.ss[m] < span) a = m; else b = m; }
    return tb.ts[a] + (tb.ts[b] - tb.ts[a]) * ((span - tb.ss[a]) / ((tb.ss[b] - tb.ss[a]) || 1));
  }

  /* 전환: transIn / transOut = { type, dur, dir, ease, amount, soft } — dir 는 그림이 움직이는 방향.
     밀어내기(push) = 앞 클립 transOut slide + 뒤 클립 transIn slide 같은 방향 */
  const TRANS = ['fade', 'slide', 'wipe', 'iris', 'zoom', 'blur', 'whip', 'spin', 'flip'];
  const TRANS_KO = { fade: '디졸브', slide: '밀기', wipe: '지우기', iris: '원형', zoom: '확대', blur: '흐림', whip: '휙 넘기기', spin: '회전', flip: '뒤집기' };
  function cleanTrans(tr) {
    if (!tr) return null; if (typeof tr === 'string') tr = { type: tr };
    if (typeof tr !== 'object' || !TRANS.includes(tr.type)) return null;
    const out = { type: tr.type, dur: clamp(num(tr.dur, 0.5), 1 / 120, 10) };
    if (['slide', 'wipe', 'whip', 'spin', 'flip'].includes(tr.type)) out.dir = DIRS.includes(tr.dir) ? tr.dir : 'left';
    out.ease = EASE[tr.ease] && !['bezier', 'hold'].includes(tr.ease) ? tr.ease : tr.type === 'whip' ? 'expo' : 'ease';
    if (tr.type === 'zoom') out.amount = clamp(num(tr.amount, 0.3), -0.9, 4);
    if (tr.type === 'blur') out.amount = clamp(num(tr.amount, 30), 0, 500);
    if (tr.type === 'wipe') out.soft = clamp(num(tr.soft, 0.04), 0, 0.5);
    return out;
  }
  /** 전환이 그 시각에 바꾸는 값: o(불투명도 곱)·dx/dy(px)·s(크기 곱)·rot/rx/ry(도)·blur/dblur(px, dangle 방향)·wipe{dir,p,soft}·iris(0~1) */
  function transState(c, lt, len, W, H) {
    const st = { o: 1, dx: 0, dy: 0, s: 1, rot: 0, rx: 0, ry: 0, blur: 0, dblur: 0, dangle: 0, wipe: null, iris: null };
    const one = (tr, p, isIn) => {
      if (!tr || p >= 1) return;
      const e = EASE[tr.ease](clamp(p, 0, 1)), q = 1 - e, d = DIRV[tr.dir] || DIRV.left, sg = isIn ? -1 : 1, sd = tr.dir === 'left' || tr.dir === 'up' ? -1 : 1;
      switch (tr.type) {
        case 'fade': st.o *= e; break;
        case 'slide': st.dx += sg * d[0] * q * W; st.dy += sg * d[1] * q * H; break;
        case 'whip': st.dx += sg * d[0] * q * W; st.dy += sg * d[1] * q * H; st.dblur += q * 90; st.dangle = d[1] ? 90 : 0; break;
        case 'zoom': st.s *= 1 + tr.amount * q; st.o *= e; break;
        case 'blur': st.blur += tr.amount * q; st.o *= e; break;
        case 'spin': st.rot += sg * sd * q * 180; st.s *= Math.max(0.01, e); break;
        case 'flip': if (d[0]) st.ry += sg * sd * q * 90; else st.rx += sg * sd * q * 90; break;
        case 'wipe': st.wipe = { dir: isIn ? tr.dir : OPP[tr.dir], p: e, soft: tr.soft }; break;
        case 'iris': st.iris = e; break;
      }
    };
    if (c.transIn) one(c.transIn, lt / c.transIn.dur, true);
    if (c.transOut) one(c.transOut, (len - lt) / c.transOut.dur, false);
    return st;
  }

  /* 흔들기(AE wiggle 대신 사인 셋을 겹친 정해진 떨림 — 렌더 식과 같은 값) */
  const WN = [[1, 0.55, 0], [2.13, 0.3, 1.9], [3.71, 0.15, 4.3]];
  function wnoise(f, t, seed, axis) { let v = 0; for (const [m, w, ph] of WN) v += w * Math.sin(2 * Math.PI * f * m * t + ph + seed * 1.618 + axis * 2.399); return v; }
  function wiggleAt(fx, lt) { const amp = valueAt(fx.amp, fx.keys && fx.keys.amp, lt); return { dx: amp * wnoise(fx.freq, lt, fx.seed, 0), dy: amp * wnoise(fx.freq, lt, fx.seed, 1), rot: fx.rot * wnoise(fx.freq, lt, fx.seed, 2) }; }

  /* 카메라(2.5D): doc.camera = { x, y, z(앞으로 다가가기), zoom, perspective(px, 0=자동), keys:{x,y,z,zoom}(타임라인 시각), shake:{amp,freq,seed} }.
     z 를 준 층(클립·글자)만 카메라에 비친다 — z 가 클수록 멀어서 작고 덜 움직인다(시차) */
  function cleanCamera(c) {
    if (!c || typeof c !== 'object') return null;
    const out = { x: num(c.x, 0), y: num(c.y, 0), z: num(c.z, 0), zoom: clamp(num(c.zoom, 1), 0.01, 100), perspective: clamp(num(c.perspective, 0), 0, 100000), keys: {} };
    for (const p of ['x', 'y', 'z', 'zoom']) { const ks = cleanKeyList(c.keys && c.keys[p], (v) => (p === 'zoom' ? clamp(v, 0.01, 100) : v), out[p]); if (ks.length) out.keys[p] = ks; }
    if (c.shake && typeof c.shake === 'object') out.shake = { amp: clamp(num(c.shake.amp, 8), 0, 2000), freq: clamp(num(c.shake.freq, 2), 0.01, 50), seed: num(c.shake.seed, 1) };
    return out;
  }
  function cameraAt(doc, t) {
    const c = doc.camera; if (!c) return null;
    const k = c.keys || {};
    let x = valueAt(c.x, k.x, t), y = valueAt(c.y, k.y, t);
    if (c.shake) { x += c.shake.amp * wnoise(c.shake.freq, t, c.shake.seed, 0); y += c.shake.amp * wnoise(c.shake.freq, t, c.shake.seed, 1); }
    return { x, y, z: valueAt(c.z, k.z, t), zoom: valueAt(c.zoom, k.zoom, t), P: perspOf(doc) };
  }
  /** 층의 깊이(z 를 안 줬으면 null = 카메라에 안 비치는 2D 층) */
  function depthAt(o, lt) { const ks = o.keys && o.keys.z; if (o.z == null && !(Array.isArray(ks) && ks.length)) return null; return valueAt(num(o.z, 0), ks, lt); }
  /** 화면 가운데 기준 위치(x,y)·깊이 z 를 카메라로 비춘 위치와 크기 배율 k (t = 타임라인 시각) */
  function project(doc, x, y, z, t) {
    if (z == null || !doc.camera) return { x, y, k: 1 };
    const c = cameraAt(doc, t), k = c.P / Math.max(1, c.P + z - c.z) * c.zoom;
    return { x: (x - c.x) * k, y: (y - c.y) * k, k };
  }

  /* 마스크: { shape: rect|ellipse, x, y, w, h(원본 픽셀, x·y = 왼쪽 위), feather(px), radius(둥근 모서리), invert, keys:{x,y,w,h,feather} } — 따라가기(cli follow)가 keys 를 채운다 */
  const MASKS = ['rect', 'ellipse'];
  function cleanMask(m) {
    if (!m || typeof m !== 'object') return null;
    const out = { shape: MASKS.includes(m.shape) ? m.shape : 'rect', x: num(m.x, 0), y: num(m.y, 0), w: Math.max(1, num(m.w, 100)), h: Math.max(1, num(m.h, 100)), feather: clamp(num(m.feather, 0), 0, 4000), radius: clamp(num(m.radius, 0), 0, 10000), invert: !!m.invert, keys: {} };
    for (const p of ['x', 'y', 'w', 'h', 'feather']) { const ks = cleanKeyList(m.keys && m.keys[p], (v) => (p === 'w' || p === 'h' ? Math.max(1, v) : p === 'feather' ? clamp(v, 0, 4000) : v), out[p]); if (ks.length) out.keys[p] = ks; }
    return out;
  }
  function maskAt(m, lt) { const k = m.keys || {}; return { x: valueAt(m.x, k.x, lt), y: valueAt(m.y, k.y, lt), w: Math.max(1, valueAt(m.w, k.w, lt)), h: Math.max(1, valueAt(m.h, k.h, lt)), feather: Math.max(0, valueAt(m.feather, k.feather, lt)) }; }
  /** 원본 픽셀 (px,py) 의 마스크 값 0~1 — 렌더(geq) 식과 같은 정의(경계까지의 거리 / feather) */
  function maskValue(m, lt, px, py) {
    const a = maskAt(m, lt), cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    let sd;
    if (m.shape === 'ellipse') sd = (1 - Math.hypot((px - cx) / (a.w / 2), (py - cy) / (a.h / 2))) * Math.min(a.w, a.h) / 2;
    else { const r = Math.min(m.radius, a.w / 2, a.h / 2), qx = Math.abs(px - cx) - (a.w / 2 - r), qy = Math.abs(py - cy) - (a.h / 2 - r); sd = -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r); }
    const v = a.feather > 0 ? clamp(sd / a.feather + 0.5, 0, 1) : sd >= 0 ? 1 : 0;
    return m.invert ? 1 - v : v;
  }

  /* 효과: effects = [{ type, …값, keys:{값:[키]}, on:false(끄기) }] — 배열 순서대로. 값 = [기본, 최소, 최대] */
  const FX = {
    color: { brightness: [0, -1, 1], contrast: [1, 0, 4], saturation: [1, 0, 3], gamma: [1, 0.1, 10], hue: [0, -360, 360], temperature: [6500, 1000, 40000], exposure: [0, -4, 4] },
    lut: { file: '', strength: [1, 0, 1] },
    curves: { preset: '', master: '', r: '', g: '', b: '' },
    blur: { radius: [10, 0, 1000] },
    glow: { radius: [24, 0, 500], strength: [0.8, 0, 3], threshold: [0.6, 0, 1] },
    shadow: { x: [0, -2000, 2000], y: [10, -2000, 2000], blur: [20, 0, 500], color: '#000000', opacity: [0.6, 0, 1] },
    sharpen: { amount: [0.8, 0, 5] },
    grain: { amount: [0.15, 0, 1] },
    vignette: { amount: [0.5, 0, 1] },
    pixelate: { size: [16, 1, 512] },
    chroma: { color: '#00ff00', similarity: [0.3, 0.01, 1], blend: [0.08, 0, 1] },
    invert: {},
    mirror: { axis: 'h' },
    tint: { color: '#ff9900', amount: [0.6, 0, 1] },
    rgbsplit: { amount: [6, 0, 300] },
    lens: { k1: [-0.25, -1, 1], k2: [0, -1, 1] },
    wave: { amp: [8, 0, 500], length: [120, 2, 5000], speed: [2, -100, 100], axis: 'x' },
    wiggle: { amp: [12, 0, 4000], freq: [2, 0.01, 60], rot: [0, 0, 360], seed: [1, -1e6, 1e6] },
  };
  const FX_KO = { color: '색 보정', lut: 'LUT', curves: '곡선', blur: '흐림', glow: '빛 번짐', shadow: '그림자', sharpen: '선명하게', grain: '필름 입자', vignette: '비네트', pixelate: '모자이크', chroma: '크로마키', invert: '반전', mirror: '좌우 뒤집기', tint: '색 입히기', rgbsplit: 'RGB 어긋남', lens: '렌즈 왜곡', wave: '물결', wiggle: '흔들기' };
  // 키프레임으로 움직일 수 있는 값
  const FX_KEYS = { color: ['brightness', 'contrast', 'saturation', 'gamma', 'hue', 'temperature', 'exposure'], blur: ['radius'], glow: ['strength'], pixelate: ['size'], tint: ['amount'], rgbsplit: ['amount'], lens: ['k1', 'k2'], wiggle: ['amp'], vignette: ['amount'], wave: ['amp'] };
  const ITEM_FX = ['blur', 'glow', 'shadow', 'color', 'invert', 'tint']; // 글자·도형(브라우저가 그림)에 쓰는 효과
  function cleanFx(f, kind) {
    if (!f || typeof f !== 'object' || !FX[f.type]) return null;
    if (kind === 'item' && !ITEM_FX.includes(f.type)) return null;
    const spec = FX[f.type], out = { type: f.type };
    for (const [k, s] of Object.entries(spec)) out[k] = Array.isArray(s) ? clamp(num(f[k], s[0]), s[1] ?? -Infinity, s[2] ?? Infinity) : typeof f[k] === 'string' ? f[k].slice(0, 500) : s;
    if (f.type === 'mirror' && !['h', 'v'].includes(out.axis)) out.axis = 'h';
    if (f.type === 'wave' && !['x', 'y'].includes(out.axis)) out.axis = 'x';
    const ks = {};
    for (const p of FX_KEYS[f.type] || []) { const s = spec[p], l = cleanKeyList(f.keys && f.keys[p], (v) => clamp(v, s[1], s[2]), s[0]); if (l.length) ks[p] = l; }
    if (Object.keys(ks).length) out.keys = ks;
    if (f.on === false) out.on = false;
    return out;
  }
  function cleanFxList(list, kind) { return (Array.isArray(list) ? list : []).map((f) => cleanFx(f, kind)).filter(Boolean).slice(0, 24); }
  /** 그 시각의 효과 값(키프레임 반영) */
  function effectAt(fx, lt) { if (!fx.keys) return fx; const o = Object.assign({}, fx); for (const p of Object.keys(fx.keys)) o[p] = valueAt(fx[p], fx.keys[p], lt); return o; }
  const hexA = (c, a) => { const m = String(c || '').match(/^#?([0-9a-f]{6})/i); if (!m) return c; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
  const hueOf = (c) => { const m = String(c || '').match(/^#?([0-9a-f]{6})/i); if (!m) return 0; const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  /** 효과의 CSS filter(미리보기·글자 레이어). 렌더 전용 효과(LUT·모자이크 등)는 빠진다 */
  function fxCss(list, lt) {
    const out = [];
    for (const f0 of list || []) {
      if (f0.on === false) continue; const f = effectAt(f0, lt);
      if (f.type === 'blur' && f.radius > 0) out.push(`blur(${(f.radius / 2).toFixed(2)}px)`);
      else if (f.type === 'glow' && f.strength > 0) { const g = `drop-shadow(0 0 ${(f.radius / 2).toFixed(1)}px rgba(255,255,255,${clamp(f.strength / 1.5, 0, 1).toFixed(2)}))`; out.push(g); if (f.strength > 1.2) out.push(g); }
      else if (f.type === 'shadow') out.push(`drop-shadow(${f.x}px ${f.y}px ${(f.blur / 2).toFixed(1)}px ${hexA(f.color, f.opacity)})`);
      else if (f.type === 'color') { const b = (1 + f.brightness) * Math.pow(2, f.exposure); out.push(`brightness(${b.toFixed(3)}) contrast(${f.contrast}) saturate(${f.saturation})${f.hue ? ` hue-rotate(${f.hue}deg)` : ''}`); }
      else if (f.type === 'invert') out.push('invert(1)');
      else if (f.type === 'tint' && f.amount > 0) out.push(`sepia(${f.amount.toFixed(2)}) hue-rotate(${Math.round(hueOf(f.color) - 38)}deg) saturate(${(1 + f.amount).toFixed(2)})`);
    }
    return out.join(' ');
  }
  /* 섞기(블렌드): 영상 클립 blend */
  const BLENDS = ['normal', 'screen', 'multiply', 'overlay', 'add', 'lighten', 'darken', 'softlight', 'hardlight', 'difference', 'exclusion', 'colordodge', 'colorburn'];
  const CSS_BLEND = { screen: 'screen', multiply: 'multiply', overlay: 'overlay', add: 'plus-lighter', lighten: 'lighten', darken: 'darken', softlight: 'soft-light', hardlight: 'hard-light', difference: 'difference', exclusion: 'exclusion', colordodge: 'color-dodge', colorburn: 'color-burn' };
  /** 편집기 미리보기용 영상 클립 CSS(효과·섞기·마스크·전환 가림·3D 기울이기). b = clipBox */
  function clipCss(doc, clip, t, b) {
    const lt = t - clip.start, css = [];
    const f = [fxCss(clip.effects, lt)]; if (b.blur > 0) f.push(`blur(${(b.blur / 2).toFixed(1)}px)`);
    const fs = f.filter(Boolean).join(' '); if (fs) css.push(`filter:${fs}`);
    if (clip.blend) css.push(`mix-blend-mode:${CSS_BLEND[clip.blend] || 'normal'}`);
    const m = doc.media[clip.media] || {}, kx = b.w / (m.width || doc.width), ky = b.h / (m.height || doc.height);
    let cp = '';
    if (b.wipe) { const p = ((1 - b.wipe.p) * 100).toFixed(2); cp = { left: `inset(0 0 0 ${p}%)`, right: `inset(0 ${p}% 0 0)`, up: `inset(${p}% 0 0 0)`, down: `inset(0 0 ${p}% 0)` }[b.wipe.dir]; }
    else if (b.iris != null) cp = `circle(${(b.iris * Math.hypot(b.w, b.h) / 2).toFixed(1)}px at 50% 50%)`;
    else if (clip.mask && !clip.mask.invert) { const a = maskAt(clip.mask, lt); cp = clip.mask.shape === 'ellipse' ? `ellipse(${a.w / 2 * kx}px ${a.h / 2 * ky}px at ${(a.x + a.w / 2) * kx}px ${(a.y + a.h / 2) * ky}px)` : `inset(${a.y * ky}px ${b.w - (a.x + a.w) * kx}px ${b.h - (a.y + a.h) * ky}px ${a.x * kx}px round ${clip.mask.radius * kx}px)`; }
    if (cp) css.push(`clip-path:${cp}`);
    const pre = b.rotationX || b.rotationY ? `perspective(${perspOf(doc)}px) rotateX(${b.rotationX}deg) rotateY(${b.rotationY}deg) ` : '';
    const mir = (clip.effects || []).find((x) => x.type === 'mirror' && x.on !== false);
    return { css: css.length ? `${css.join(';')};` : '', pre, post: mir ? (mir.axis === 'v' ? ' scaleY(-1)' : ' scaleX(-1)') : '' };
  }

  /* 도형 층(글자 트랙의 shape 칸): rect·ellipse·line·arrow·polygon·star·path, 선 그리기 trimStart/trimEnd(키 가능) */
  const SHAPES = ['rect', 'ellipse', 'line', 'arrow', 'polygon', 'star', 'path'];
  function cleanPaint(p) { if (!p) return null; if (typeof p === 'string') return p.slice(0, 60); if (p.from && p.to) return { from: String(p.from), to: String(p.to), angle: num(p.angle, 90) }; return null; }
  function cleanShape(s) {
    if (!s || typeof s !== 'object' || !SHAPES.includes(s.type)) return null;
    const lineish = s.type === 'line' || s.type === 'arrow';
    const out = { type: s.type, w: clamp(num(s.w, 200), 0, 20000), h: clamp(num(s.h, lineish ? 0 : 200), 0, 20000), radius: clamp(num(s.radius, 0), 0, 10000) };
    if (Array.isArray(s.points)) { const pts = s.points.filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).slice(0, 4000).map((p) => [+p[0], +p[1]]); if (pts.length >= 2) out.points = pts; }
    if (typeof s.d === 'string' && s.d.trim()) out.d = s.d.replace(/[^MmLlHhVvCcSsQqTtAaZz0-9.,\-+eE\s]/g, '').slice(0, 40000);
    if (s.type === 'polygon' || s.type === 'star') { out.sides = clamp(Math.round(num(s.sides, s.type === 'star' ? 5 : 6)), 3, 64); if (s.type === 'star') out.inner = clamp(num(s.inner, 0.45), 0.01, 1); }
    const open = lineish || (s.type === 'path' && !out.d?.match(/z\s*$/i) && !s.fill);
    out.fill = s.fill === null || s.fill === 'none' ? null : cleanPaint(s.fill) || (open ? null : '#ffffff');
    const st = s.stroke;
    out.stroke = st && typeof st === 'object' && num(st.width, 0) > 0
      ? { color: String(st.color || '#ffffff'), width: clamp(num(st.width, 4), 0, 500), cap: ['butt', 'round', 'square'].includes(st.cap) ? st.cap : 'round', join: ['miter', 'round', 'bevel'].includes(st.join) ? st.join : 'round', ...(Array.isArray(st.dash) && st.dash.length ? { dash: st.dash.map(Number).filter((v) => Number.isFinite(v) && v >= 0).slice(0, 8) } : {}) }
      : open ? { color: '#ffffff', width: 6, cap: 'round', join: 'round' } : null;
    out.trimStart = clamp(num(s.trimStart, 0), 0, 1); out.trimEnd = clamp(num(s.trimEnd, 1), 0, 1);
    return out;
  }
  const f2 = (v) => Math.round(v * 100) / 100;
  function shapePoints(sh) {
    if (sh.points) return sh.points;
    if (sh.type === 'line' || sh.type === 'arrow') return [[-sh.w / 2, 0], [sh.w / 2, 0]];
    if (sh.type === 'polygon' || sh.type === 'star') { const n = sh.type === 'star' ? sh.sides * 2 : sh.sides, pts = []; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n, k = sh.type === 'star' && i % 2 ? sh.inner : 1; pts.push([Math.cos(a) * sh.w / 2 * k, Math.sin(a) * sh.h / 2 * k]); } return pts; }
    return null;
  }
  /** 도형의 SVG 경로(가운데 기준) */
  function shapePath(sh) {
    if (sh.d) return sh.d;
    const w = sh.w, h = sh.h, pts = shapePoints(sh);
    if (pts) return `M${pts.map((p) => `${f2(p[0])} ${f2(p[1])}`).join(' L')}${sh.type === 'polygon' || sh.type === 'star' ? ' Z' : ''}`;
    if (sh.type === 'ellipse') { const rx = w / 2, ry = h / 2; return `M${f2(-rx)} 0 A${f2(rx)} ${f2(ry)} 0 1 0 ${f2(rx)} 0 A${f2(rx)} ${f2(ry)} 0 1 0 ${f2(-rx)} 0 Z`; }
    const r = Math.min(sh.radius, w / 2, h / 2), x0 = -w / 2, y0 = -h / 2;
    if (!r) return `M${f2(x0)} ${f2(y0)} H${f2(-x0)} V${f2(-y0)} H${f2(x0)} Z`;
    return `M${f2(x0 + r)} ${f2(y0)} H${f2(-x0 - r)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(-x0)} ${f2(y0 + r)} V${f2(-y0 - r)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(-x0 - r)} ${f2(-y0)} H${f2(x0 + r)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(x0)} ${f2(-y0 - r)} V${f2(y0 + r)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(x0 + r)} ${f2(y0)} Z`;
  }
  /** 꺾은선 위 비율 위치·방향(화살촉) */
  function polyAt(pts, frac) {
    let total = 0; const seg = []; for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); total += l; }
    let want = clamp(frac, 0, 1) * total;
    for (let i = 0; i < seg.length; i++) { if (want <= seg[i] || i === seg.length - 1) { const a = pts[i], b = pts[i + 1], k = seg[i] ? want / seg[i] : 0; return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) }; } want -= seg[i]; }
    return { x: 0, y: 0, ang: 0 };
  }
  function shapeSvg(sh, a, b, id) {
    const sw = sh.stroke ? sh.stroke.width : 0, pts = shapePoints(sh), head = sh.type === 'arrow' ? Math.max(14, sw * 3.2) : 0;
    let w = sh.w, h = sh.h; if (pts) for (const p of pts) { w = Math.max(w, Math.abs(p[0]) * 2); h = Math.max(h, Math.abs(p[1]) * 2); }
    const W = Math.ceil(w + sw + head * 2 + 4), H = Math.ceil(h + sw + head * 2 + 4);
    let defs = '', fill = 'none';
    if (sh.fill && typeof sh.fill === 'object') { const g = `og${String(id).replace(/[^\w-]/g, '')}`, r = sh.fill.angle * Math.PI / 180; defs = `<defs><linearGradient id="${g}" x1="${f2(0.5 - 0.5 * Math.sin(r))}" y1="${f2(0.5 + 0.5 * Math.cos(r))}" x2="${f2(0.5 + 0.5 * Math.sin(r))}" y2="${f2(0.5 - 0.5 * Math.cos(r))}"><stop offset="0" stop-color="${esc(sh.fill.from)}"/><stop offset="1" stop-color="${esc(sh.fill.to)}"/></linearGradient></defs>`; fill = `url(#${g})`; }
    else if (sh.fill) fill = esc(sh.fill);
    const trim = a > 0.0001 || b < 0.9999;
    const st = sh.stroke ? ` stroke="${esc(sh.stroke.color)}" stroke-width="${sw}" stroke-linecap="${sh.stroke.cap}" stroke-linejoin="${sh.stroke.join}"${trim ? ` pathLength="1" stroke-dasharray="${f2(Math.max(0, b - a) * 1000) / 1000} 2" stroke-dashoffset="${-a}"` : sh.stroke.dash ? ` stroke-dasharray="${sh.stroke.dash.join(' ')}"` : ''}` : '';
    let tip = '';
    if (head && pts && b > a + 0.001) { const p = polyAt(pts, b), c = Math.cos(p.ang), s = Math.sin(p.ang), L = head, Wd = head * 0.62; tip = `<path d="M${f2(p.x + c * L * 0.35)} ${f2(p.y + s * L * 0.35)} L${f2(p.x - c * L * 0.65 - s * Wd)} ${f2(p.y - s * L * 0.65 + c * Wd)} L${f2(p.x - c * L * 0.65 + s * Wd)} ${f2(p.y - s * L * 0.65 - c * Wd)} Z" fill="${esc(sh.stroke ? sh.stroke.color : '#fff')}"/>`; }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${-W / 2} ${-H / 2} ${W} ${H}" style="display:block;overflow:visible">${defs}<path d="${esc(shapePath(sh))}" fill="${fill}"${st}/>${tip}</svg>`;
  }

  /* 글자 움직임: anim.unit(all|char|word|line)·anim.stagger(단위 사이 초)·anim.order(forward|reverse|center|random), loop(계속 움직임) */
  const LOOP_DEF = { pulse: [0.06, 1.5], shake: [4, 12], wave: [10, 1.2], float: [8, 0.5], blink: [1, 1], spin: [0, 0.5], swing: [8, 1] };
  function cleanLoop(l) {
    if (!l) return null; if (typeof l === 'string') l = { type: l };
    if (typeof l !== 'object' || !LOOP_DEF[l.type]) return null;
    const d = LOOP_DEF[l.type]; return { type: l.type, amp: clamp(num(l.amp, d[0]), -10000, 10000), freq: clamp(num(l.freq, d[1]), 0.01, 60) };
  }
  function loopMods(item, lt, i) {
    const out = { dx: 0, dy: 0, s: 1, rot: 0, o: 1 }, l = item.loop; if (!l) return out;
    const w = 2 * Math.PI * l.freq * lt;
    if (l.type === 'pulse') out.s = 1 + l.amp * Math.sin(w);
    else if (l.type === 'shake') { out.dx = l.amp * wnoise(l.freq, lt, 7 + i * 13.1, 0); out.dy = l.amp * wnoise(l.freq, lt, 7 + i * 13.1, 1); }
    else if (l.type === 'wave') out.dy = -l.amp * Math.sin(w - i * 0.6);
    else if (l.type === 'float') out.dy = l.amp * Math.sin(w);
    else if (l.type === 'blink') out.o = clamp(1 - l.amp * (0.5 - 0.5 * Math.cos(w)), 0, 1);
    else if (l.type === 'spin') out.rot = 360 * l.freq * lt;
    else if (l.type === 'swing') out.rot = l.amp * Math.sin(w);
    return out;
  }
  /** 움직이는 단위: anim.unit, 없으면 '타자' 효과일 때 글자 하나씩 */
  const unitOf = (it) => (it.anim && it.anim.unit) || (it.anim && (it.anim.in === 'type' || it.anim.out === 'type') ? 'char' : 'all');
  const loopPerUnit = (it) => !!(it.loop && (it.loop.type === 'wave' || it.loop.type === 'shake') && unitOf(it) !== 'all');
  /** 글을 움직이는 단위로 나눔: [{ s: 글, u: 움직이는 단위인가 }] (띄어쓰기·줄바꿈은 u=false) */
  function unitsOf(text, unit) {
    const out = [], T = String(text);
    if (unit === 'line') { T.split('\n').forEach((ln, i) => { if (i) out.push({ s: '\n', u: false }); out.push({ s: ln, u: true }); }); return out; }
    if (unit === 'word') { for (const part of T.split(/(\s+)/)) if (part) out.push({ s: part, u: !/^\s+$/.test(part) }); return out; }
    for (const ch of Array.from(T)) out.push({ s: ch, u: !/\s/.test(ch) });
    return out;
  }
  /** 단위 순서(stagger 곱): forward·reverse·center·random(글자 칸 id 로 정해진 섞기) */
  function unitRanks(it, n) {
    const o = it.anim && it.anim.order;
    if (o === 'reverse') return Array.from({ length: n }, (_, i) => n - 1 - i);
    if (o === 'center') return Array.from({ length: n }, (_, i) => Math.abs(i - (n - 1) / 2));
    if (o === 'random') { let h = 2166136261; for (const ch of String(it.id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; const idx = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; const j = h % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; } const r = new Array(n); idx.forEach((v, k) => { r[v] = k; }); return r; }
    return Array.from({ length: n }, (_, i) => i);
  }
  const staggerOf = (it, n) => (it.anim.unit ? num(it.anim.stagger, 0.05) : it.anim.inDur / Math.max(1, n));
  /** 등장·퇴장 하나 적용(p: 0→1 진행, 퇴장은 거꾸로) */
  function applyAnim(out, kind, p) {
    if (kind === 'none' || p >= 1) return;
    const e = EASE.expo(p), q = clamp(p, 0, 1), eq = EASE.expo(q);
    if (kind === 'fade') out.o *= q;
    else if (kind === 'pop') { out.s *= 0.6 + 0.4 * EASE.snap(q); out.o *= Math.min(1, q * 3); }
    else if (kind === 'zoom') { out.s *= 1.3 - 0.3 * e; out.o *= q; }
    else if (kind === 'slideUp') { out.dy += (1 - e) * 90; out.o *= q; }
    else if (kind === 'slideDown') { out.dy -= (1 - e) * 90; out.o *= q; }
    else if (kind === 'slideLeft') { out.dx += (1 - e) * 140; out.o *= q; }
    else if (kind === 'slideRight') { out.dx -= (1 - e) * 140; out.o *= q; }
    else if (kind === 'type') out.o *= q > 0 ? 1 : 0;
    else if (kind === 'blur') { out.blur += (1 - eq) * 14; out.o *= q; }
    else if (kind === 'drop') { out.dy -= (1 - EASE.bounce(q)) * 160; out.o *= Math.min(1, q * 3); }
    else if (kind === 'rise') out.rise = Math.max(out.rise, clamp(1 - eq, 0, 1));
    else if (kind === 'wipeLeft' || kind === 'wipeRight' || kind === 'wipeUp' || kind === 'wipeDown') out.wipe = { dir: kind.slice(4).toLowerCase(), p: eq };
    else if (kind === 'spin') { out.rot += (1 - eq) * -180; out.s *= 0.3 + 0.7 * eq; out.o *= q; }
    else if (kind === 'flip') { out.rx += (1 - eq) * 90; out.o *= Math.min(1, q * 2); }
  }
  const animZero = () => ({ dx: 0, dy: 0, s: 1, o: 1, blur: 0, rot: 0, rx: 0, rise: 0, wipe: null });
  /** 한 단위(글자·낱말·줄)의 그 시각 등장·퇴장 값 */
  function unitMods(item, t, rank, n, stag) {
    const out = animZero(), a = item.anim, len = item.end - item.start;
    const inD = Math.min(a.inDur, len / 2), outD = Math.min(a.outDur, len / 2);
    if (a.in !== 'none') { const t0 = item.start + rank * stag; if (inD > 0) applyAnim(out, a.in, (t - t0) / inD); else if (t < t0) out.o = 0; }
    if (a.out !== 'none') { const t1 = item.end - (n - 1 - rank) * stag; if (outD > 0) applyAnim(out, a.out, (t1 - t) / outD); else if (t >= t1) out.o = 0; }
    return out;
  }

  /* 트랙 소리: tracks[].audio = { volume, pan, eq(이름|띠 목록), comp, denoise, gate, deess, duck:{ by, amount, attack, release, mode } } */
  const EQ_PRESETS = {
    voice: [{ type: 'lowcut', f: 80 }, { type: 'peak', f: 250, g: -2, q: 1 }, { type: 'peak', f: 3000, g: 3, q: 1 }, { type: 'highshelf', f: 10000, g: 2 }],
    clear: [{ type: 'lowcut', f: 100 }, { type: 'peak', f: 400, g: -3, q: 1.2 }, { type: 'peak', f: 5000, g: 2.5, q: 1 }],
    music: [{ type: 'lowshelf', f: 100, g: 2 }, { type: 'highshelf', f: 10000, g: 1.5 }],
    warm: [{ type: 'lowshelf', f: 200, g: 3 }, { type: 'highshelf', f: 8000, g: -2 }],
    bright: [{ type: 'highshelf', f: 6000, g: 4 }],
    bass: [{ type: 'lowshelf', f: 120, g: 6 }],
    phone: [{ type: 'lowcut', f: 300 }, { type: 'highcut', f: 3400 }, { type: 'peak', f: 1500, g: 4, q: 1 }],
    radio: [{ type: 'lowcut', f: 150 }, { type: 'highcut', f: 6000 }, { type: 'peak', f: 1200, g: 3, q: 0.8 }],
    muffled: [{ type: 'highcut', f: 1200 }],
  };
  const EQ_TYPES = ['peak', 'lowshelf', 'highshelf', 'lowcut', 'highcut'];
  function cleanEq(e) {
    const list = typeof e === 'string' ? EQ_PRESETS[e] || [] : Array.isArray(e) ? e : [];
    return list.map((b) => (b && EQ_TYPES.includes(b.type) ? { type: b.type, f: clamp(num(b.f, 1000), 10, 22000), ...(b.type === 'lowcut' || b.type === 'highcut' ? {} : { g: clamp(num(b.g, 0), -30, 30) }), ...(b.type === 'peak' ? { q: clamp(num(b.q, 1), 0.1, 20) } : {}) } : null)).filter(Boolean).slice(0, 16);
  }
  function cleanTrackAudio(a) {
    if (!a || typeof a !== 'object') return null;
    const out = {};
    if (num(a.volume, 0)) out.volume = clamp(num(a.volume, 0), -60, 24);
    if (num(a.pan, 0)) out.pan = clamp(num(a.pan, 0), -1, 1);
    const eq = cleanEq(a.eq); if (eq.length) out.eq = eq;
    if (a.comp) { const c = a.comp === true ? {} : a.comp; out.comp = { threshold: clamp(num(c.threshold, -18), -60, 0), ratio: clamp(num(c.ratio, 3), 1, 20), attack: clamp(num(c.attack, 10), 0.01, 2000), release: clamp(num(c.release, 150), 0.01, 9000), makeup: clamp(num(c.makeup, 0), 0, 36) }; }
    if (a.denoise) out.denoise = clamp(a.denoise === true ? 0.5 : num(a.denoise, 0.5), 0, 1);
    if (a.gate) { const g = a.gate === true ? {} : a.gate; out.gate = { threshold: clamp(num(g.threshold, -45), -80, 0) }; }
    if (a.deess) out.deess = clamp(a.deess === true ? 0.5 : num(a.deess, 0.5), 0, 1);
    if (a.duck && typeof a.duck === 'object' && a.duck.by != null) { const d = a.duck; out.duck = { by: (Array.isArray(d.by) ? d.by : [d.by]).map(String).slice(0, 8), amount: clamp(num(d.amount, -12), -60, 0), attack: clamp(num(d.attack, 0.2), 0.01, 5), release: clamp(num(d.release, 0.5), 0.01, 10), mode: d.mode === 'sidechain' ? 'sidechain' : 'envelope' }; }
    return Object.keys(out).length ? out : null;
  }
  /** 자동 줄이기(덕킹) 구간: by 트랙(이름·id)에 소리가 있는 구간을 합침(줄었다 돌아오는 사이가 겹치면 하나로) */
  function duckRanges(doc, track) {
    const d = track && track.audio && track.audio.duck; if (!d) return [];
    const src = doc.tracks.filter((t) => t !== track && t.kind !== 'text' && !t.muted && d.by.some((b) => b === t.id || b === t.name));
    const rs = src.flatMap((t) => t.clips.filter((c) => { const m = doc.media[c.media]; return m && (t.kind === 'audio' || m.audio !== false); }).map((c) => [c.start, clipEnd(c)])).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of rs) { const last = out[out.length - 1]; if (last && r[0] - d.attack <= last[1] + d.release) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]); }
    return out;
  }
  function duckEnv(ranges, att, rel, t) { let v = 0; for (const [s, e] of ranges) { if (t < s - att) break; v = Math.max(v, Math.min(clamp((t - (s - att)) / att, 0, 1), clamp((e + rel - t) / rel, 0, 1))); } return v; }
  /** 그 시각 그 트랙이 줄어드는 dB(0 = 안 줄임) */
  function duckDb(doc, track, t, ranges) { const d = track && track.audio && track.audio.duck; if (!d) return 0; return d.amount * duckEnv(ranges || duckRanges(doc, track), d.attack, d.release, t); }

  /* 출력: doc.output = { codec: h264|h265|prores|prores4444|vp9|gif, quality: draft|normal|high|master, bitDepth: 8|10, alpha, audio: aac|pcm|opus|none, fps(gif) } */
  const OUT_FORMATS = { h264: { ext: '.mp4', alpha: false, ten: true }, h265: { ext: '.mp4', alpha: false, ten: true }, prores: { ext: '.mov', alpha: false, ten: true }, prores4444: { ext: '.mov', alpha: true, ten: true }, vp9: { ext: '.webm', alpha: true, ten: true }, gif: { ext: '.gif', alpha: false, ten: false } };
  function cleanOutput(o) {
    o = o && typeof o === 'object' ? o : {};
    const codec = OUT_FORMATS[o.codec] ? o.codec : 'h264', f = OUT_FORMATS[codec];
    const out = { codec, quality: ['draft', 'normal', 'high', 'master'].includes(o.quality) ? o.quality : 'normal' };
    out.bitDepth = codec.startsWith('prores') ? 10 : f.ten && Number(o.bitDepth) === 10 ? 10 : 8;
    out.alpha = !!f.alpha && (codec === 'prores4444' || !!o.alpha);
    let au = codec === 'gif' ? 'none' : ['aac', 'pcm', 'opus', 'none'].includes(o.audio) ? o.audio : codec === 'vp9' ? 'opus' : codec.startsWith('prores') ? 'pcm' : 'aac';
    if (f.ext === '.mp4' && au === 'pcm') au = 'aac'; if (f.ext === '.webm' && (au === 'aac' || au === 'pcm')) au = 'opus';
    out.audio = au;
    if (codec === 'gif') out.fps = clamp(num(o.fps, 15), 1, 50);
    return out;
  }

  /* 정리: 클립·글자 칸 (normalize 가 부른다 — 예전 파일은 정리 결과가 그대로라 렌더 지문도 그대로) */
  function normClip(c, base, doc) {
    const out = Object.assign(base, { volume: clamp(num(c.volume, 0), -60, 24), fadeIn: clamp(num(c.fadeIn, 0), 0, 10), fadeOut: clamp(num(c.fadeOut, 0), 0, 10), vfadeIn: clamp(num(c.vfadeIn, 0), 0, 10), vfadeOut: clamp(num(c.vfadeOut, 0), 0, 10),
      fit: FITS.includes(c.fit) ? c.fit : 'cover' }, transformOf(c, true), { keys: cleanKeys(c.keys, CLIP_PROPS) });
    if (c.label) out.label = String(c.label).slice(0, 80);
    const sp = num(c.speed, 1); if (sp !== 1) out.speed = clamp(sp, 0.05, 16);
    if (c.reverse) out.reverse = true;
    if (num(c.freeze, 0) > 0) out.freeze = r4(clamp(num(c.freeze, 0), 1 / doc.fps, 36000));
    if (c.interp === 'blend' || c.interp === 'flow') out.interp = c.interp;
    const ti = cleanTrans(c.transIn), to = cleanTrans(c.transOut); if (ti) out.transIn = ti; if (to) out.transOut = to;
    const fx = cleanFxList(c.effects, 'clip'); if (fx.length) out.effects = fx;
    if (BLENDS.includes(c.blend) && c.blend !== 'normal') out.blend = c.blend;
    const mk = cleanMask(c.mask); if (mk) out.mask = mk;
    if (c.motionBlur) out.motionBlur = true;
    return out;
  }
  function normItem(it, doc, fresh) {
    it = it || {};
    const start = Math.max(0, num(it.start, 0)), end = Math.max(start + 1 / doc.fps, num(it.end, start + 1));
    const a = it.anim && typeof it.anim === 'object' ? it.anim : {};
    const anim = { in: ANIM.includes(a.in) ? a.in : 'none', out: ANIM.includes(a.out) ? a.out : 'none', inDur: clamp(num(a.inDur, 0.2), 0, 5), outDur: clamp(num(a.outDur, 0.15), 0, 5) };
    if (UNITS.includes(a.unit) && a.unit !== 'all') { anim.unit = a.unit; anim.stagger = clamp(num(a.stagger, 0.05), 0, 2); }
    if (['reverse', 'center', 'random'].includes(a.order)) anim.order = a.order;
    const out = Object.assign({ id: fresh(it.id, 'x'), start: r4(start), end: r4(end), text: String(it.text ?? ''), style: it.style ? String(it.style) : null, override: it.override && typeof it.override === 'object' ? it.override : {} },
      transformOf(it, true), { anim, keys: cleanKeys(it.keys, ITEM_PROPS) });
    const sh = cleanShape(it.shape); if (sh) out.shape = sh;
    const lp = cleanLoop(it.loop); if (lp) out.loop = lp;
    const fx = cleanFxList(it.effects, 'item'); if (fx.length) out.effects = fx;
    const mk = cleanMask(it.mask); if (mk) out.mask = mk;
    if (BLENDS.includes(it.blend) && it.blend !== 'normal') out.blend = it.blend;
    return out;
  }

  /* ---------- 위치·크기 계산 (미리보기·렌더 공통) ---------- */
  /** 등장·퇴장 효과: 그 시각의 더하고 곱할 값 */
  function animMods(item, t) {
    const out = animZero(), a = item.anim; if (!a) return out;
    const len = item.end - item.start, inD = Math.min(a.inDur, len / 2), outD = Math.min(a.outDur, len / 2);
    if (inD > 0) applyAnim(out, a.in, (t - item.start) / inD);
    if (outD > 0) applyAnim(out, a.out, (item.end - t) / outD);
    return out;
  }
  /** 자막·글자의 그 시각 상태(보이지 않으면 null) */
  function itemState(item, t, doc) {
    if (t < item.start || t >= item.end) return null;
    const lt = t - item.start, k = item.keys || {}, m = unitOf(item) === 'all' ? animMods(item, t) : animZero(), lp = loopPerUnit(item) ? loopMods({}, lt, 0) : loopMods(item, lt, 0);
    const x = valueAt(item.x, k.x, lt) + m.dx + lp.dx, y = valueAt(item.y, k.y, lt) + m.dy + lp.dy;
    const pr = doc ? project(doc, x, y, depthAt(item, lt), t) : { x, y, k: 1 };
    const sh = item.shape;
    return { x: pr.x, y: pr.y, scale: valueAt(item.scale, k.scale, lt) * m.s * lp.s * pr.k, rotation: valueAt(item.rotation, k.rotation, lt) + lp.rot + m.rot, opacity: clamp(valueAt(item.opacity, k.opacity, lt) * m.o * lp.o, 0, 1),
      rotationX: valueAt(num(item.rotationX, 0), k.rotationX, lt) + m.rx, rotationY: valueAt(num(item.rotationY, 0), k.rotationY, lt), blur: m.blur, rise: m.rise, wipe: m.wipe,
      ...(sh ? { trimStart: valueAt(sh.trimStart, k.trimStart, lt), trimEnd: valueAt(sh.trimEnd, k.trimEnd, lt) } : {}) };
  }
  /** 영상 클립을 화면에 맞춘 기본 크기(fit) */
  function fitSize(doc, media, fit) {
    const mw = media && media.width > 0 ? media.width : doc.width, mh = media && media.height > 0 ? media.height : doc.height;
    if (fit === 'none') return { w: mw, h: mh }; // 원래 픽셀 크기(로고·스티커)
    const k = fit === 'contain' ? Math.min(doc.width / mw, doc.height / mh) : Math.max(doc.width / mw, doc.height / mh);
    return { w: mw * k, h: mh * k };
  }
  /** 영상 클립의 그 시각 상자: 가운데 좌표·크기·회전·불투명도 (렌더의 ffmpeg 식과 같은 정의) */
  function clipBox(doc, clip, t) {
    const lt = t - clip.start, k = clip.keys || {}, len = clipLen(clip);
    const f = fitSize(doc, doc.media[clip.media], clip.fit), tr = transState(clip, lt, len, doc.width, doc.height);
    let x = valueAt(clip.x, k.x, lt) + tr.dx, y = valueAt(clip.y, k.y, lt) + tr.dy, rot = valueAt(clip.rotation, k.rotation, lt) + tr.rot;
    for (const fx of clip.effects || []) if (fx.type === 'wiggle' && fx.on !== false) { const w = wiggleAt(fx, lt); x += w.dx; y += w.dy; rot += w.rot; }
    const pr = project(doc, x, y, depthAt(clip, lt), t), s = valueAt(clip.scale, k.scale, lt) * tr.s * pr.k;
    // blur = 전환 흐림(효과의 흐림은 effects 쪽), dblur = 휙 넘기기 방향 흐림
    return { cx: doc.width / 2 + pr.x, cy: doc.height / 2 + pr.y, w: f.w * s, h: f.h * s, rotation: rot, opacity: clipOpacity(clip, t),
      rotationX: valueAt(num(clip.rotationX, 0), k.rotationX, lt) + tr.rx, rotationY: valueAt(num(clip.rotationY, 0), k.rotationY, lt) + tr.ry, blur: tr.blur + tr.dblur * 0.3, dblur: tr.dblur, dangle: tr.dangle, wipe: tr.wipe, iris: tr.iris };
  }
  /** 영상 클립의 그 시각 불투명도 = 기본값·키프레임 × 화면 들어오기(vfadeIn)·나가기(vfadeOut, 일정하게). 렌더의 ffmpeg 식(edit.mjs opacityExpr)과 같은 정의 */
  function clipOpacity(clip, t) {
    const lt = t - clip.start, len = clipLen(clip);
    let o = valueAt(num(clip.opacity, 1), clip.keys && clip.keys.opacity, lt);
    if (clip.vfadeIn > 0) o *= clamp(lt / clip.vfadeIn, 0, 1);
    if (clip.vfadeOut > 0) o *= clamp((len - lt) / clip.vfadeOut, 0, 1);
    if (clip.transIn || clip.transOut) o *= transState(clip, lt, len, 0, 0).o;
    return clamp(o, 0, 1);
  }
  /** 클립의 그 시각 소리 크기(dB) = 기본값·키프레임(소리 페이드 fadeIn/fadeOut 는 따로 곱한다) */
  function clipGain(clip, t) { return valueAt(num(clip.volume, 0), clip.keys && clip.keys.volume, t - clip.start); }

  /** "통째로 구운 편집" 찾기: 그림이 영상 한 개뿐이고 글자 칸도 없으면 편집기에서 고칠 게 없다(2026-10-24 — AI 가 밖에서 다 만든 영상을 감싸기만 했다).
   *  flattened = 고칠 수 없는 감싸기, notes = 고치면 좋은 점(사람 말) */
  function editability(doc) {
    const D = duration(doc), notes = [];
    if (D < 5) return { flattened: false, notes };
    const vis = [], texts = [], audio = [];
    for (const tr of doc.tracks) {
      if (tr.kind === 'text') { if (!tr.hidden) texts.push(...tr.items.filter((it) => !it.shape)); continue; }
      for (const c of tr.clips) {
        const m = doc.media[c.media] || {};
        if (tr.kind === 'video' && !tr.hidden && m.width > 0 && m.kind !== 'adjust') vis.push(c);
        if (!tr.muted && (tr.kind === 'audio' || m.audio !== false)) audio.push({ tr, c });
      }
    }
    const cover = (list) => list.reduce((a, c) => a + clipLen(c), 0) / D;
    const pics = new Set(vis.map((c) => c.media));
    const onePicture = pics.size === 1 && cover(vis) >= 0.9;
    if (onePicture) notes.push('그림이 영상 한 개뿐이에요 — 장면마다 재료 영상으로 나누고, 확대·이동·전환은 편집 파일의 키프레임으로 두세요');
    if (!texts.length) notes.push('글자·자막 칸이 하나도 없어요 — 글자를 그림에 구워 넣었으면 글자 칸으로 빼세요');
    const byTrack = new Map(); for (const a of audio) { if (!byTrack.has(a.tr)) byTrack.set(a.tr, []); byTrack.get(a.tr).push(a.c); }
    for (const [tr, list] of byTrack) {
      if (list.length === 1 && clipLen(list[0]) >= 0.9 * D && /효과음|sfx|fx/i.test(`${tr.name} ${doc.media[list[0].media]?.path || ''}`)) notes.push(`효과음 트랙 "${tr.name}"이 한 덩어리예요 — 효과음은 소리마다 그 시각에 따로 넣으세요`);
    }
    if (D > 60 && audio.length && audio.length <= 2 && audio.every((a) => clipLen(a.c) >= 0.9 * D)) notes.push('소리가 미리 섞은 한두 덩어리예요 — 음악·효과음·말소리를 나눠 넣어야 크기·시점을 고칠 수 있어요');
    return { flattened: onePicture && !texts.length, notes };
  }
  /** 그 시각에 보이는 영상 클립(아래 트랙부터) */
  function activeClips(doc, t) {
    const out = [];
    for (const tr of doc.tracks) if (tr.kind === 'video' && !tr.hidden) for (const c of tr.clips) if (t >= c.start && t < clipEnd(c)) out.push({ track: tr, clip: c });
    return out;
  }

  /* ---------- 글자·자막 그리기 (DOM) ---------- */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const fontStack = (f) => `"${String(f || 'Noto Sans KR').replace(/"/g, '')}", "Noto Sans KR", "Malgun Gothic", sans-serif`;
  function styleCss(s) {
    const fill = s.gradient ? `background:linear-gradient(${s.gradient.angle}deg,${s.gradient.from},${s.gradient.to});-webkit-background-clip:text;background-clip:text;color:transparent;` : `color:${s.color};`;
    const box = `font-family:${fontStack(s.font)};font-size:${s.size}px;font-weight:${s.weight};font-style:${s.italic ? 'italic' : 'normal'};line-height:${s.lineHeight};letter-spacing:${s.letterSpacing}px;text-align:${s.align};white-space:${s.oneLine ? 'pre' : 'pre-wrap'};${s.oneLine ? '' : `max-width:${s.maxWidth}px;`}`;
    return { box, fill, stroke: s.stroke ? `-webkit-text-stroke:${s.stroke.width * 2}px ${s.stroke.color};color:${s.stroke.color};` : '' };
  }
  const wipeCss = (w) => { const p = ((1 - w.p) * 100).toFixed(2); return { left: `inset(0 0 0 ${p}%)`, right: `inset(0 ${p}% 0 0)`, up: `inset(${p}% 0 0 0)`, down: `inset(0 0 ${p}% 0)` }[w.dir] || ''; };
  /** 글자·도형 칸 마스크(그 칸 상자 기준 px, 가장자리 흐림 없음) */
  function itemMaskCss(m, lt) {
    const a = maskAt(m, lt), x0 = a.x, y0 = a.y, x1 = a.x + a.w, y1 = a.y + a.h;
    if (m.shape === 'ellipse' && !m.invert) return `ellipse(${a.w / 2}px ${a.h / 2}px at ${x0 + a.w / 2}px ${y0 + a.h / 2}px)`;
    const inner = `${x0}px ${y0}px, ${x1}px ${y0}px, ${x1}px ${y1}px, ${x0}px ${y1}px`;
    return m.invert ? `polygon(evenodd, -9999px -9999px, 9999px -9999px, 9999px 9999px, -9999px 9999px, -9999px -9999px, ${x0}px ${y0}px, ${x0}px ${y1}px, ${x1}px ${y1}px, ${x1}px ${y0}px, ${x0}px ${y0}px)` : `polygon(${inner})`;
  }
  /** stage(화면 크기 W×H 의 상자) 안에 그 시각의 글자·도형 레이어를 그린다. 반환: 렌더용 서명(같으면 같은 그림)
   *  2026-10-24: 글자 하나씩·낱말·줄 단위 움직임(anim.unit), 계속 움직임(loop), 도형(shape)·선 그리기, 3D 기울이기·카메라, 효과(CSS filter), 마스크, 섞기(다른 글자·도형과만) */
  function renderOverlay(stage, doc, t, opts) {
    const o = opts || {};
    const seen = new Set(), sig = [], P = perspOf(doc);
    const tracks = doc.tracks.filter((tr) => tr.kind === 'text' && !tr.hidden);
    let z = 1;
    for (const tr of tracks) for (const it of tr.items) {
      z++;
      const st = itemState(it, t, doc); if (!st) continue;
      const key = it.id; seen.add(key);
      let el = stage.querySelector(`:scope > [data-ov="${key}"]`);
      if (!el) { el = stage.ownerDocument.createElement('div'); el.className = 'ov-layer'; el.dataset.ov = key; stage.appendChild(el); }
      const lt = t - it.start;
      let shadow = '', usig = '';
      if (it.shape) {
        const look = JSON.stringify(['shape', it.shape, r4(st.trimStart), r4(st.trimEnd)]);
        if (el.dataset.look !== look) { el.dataset.look = look; el.innerHTML = shapeSvg(it.shape, st.trimStart, st.trimEnd, key); }
        usig = look;
      } else {
        const s = styleOf(doc, tr, it), css = styleCss(s), unit = unitOf(it);
        const look = JSON.stringify([it.text, css, s.shadow, s.bg, unit]);
        if (el.dataset.look !== look) {
          el.dataset.look = look;
          const bg = s.bg ? `background:${s.bg.color};padding:${s.bg.padY}px ${s.bg.padX}px;border-radius:${s.bg.radius}px;` : '';
          const cell = (text) => `${s.stroke ? `<span class="ov-st" aria-hidden="true" style="grid-area:1/1;${css.stroke}">${text}</span>` : ''}<span class="ov-fi" style="grid-area:1/1;${css.fill}">${text}</span>`;
          el.innerHTML = unit === 'all' ? `<div class="ov-box" style="display:inline-grid;${bg}${css.box}">${cell(esc(it.text))}</div>`
            : `<div class="ov-box" style="display:inline-block;${bg}${css.box}">${unitsOf(it.text, unit).map((u) => (u.u ? `<span class="ov-u" style="display:inline-block;white-space:pre"><span class="ov-ui" style="display:inline-grid">${cell(esc(u.s))}</span></span>` : u.s === '\n' ? '<br>' : esc(u.s))).join('')}</div>`;
        }
        shadow = s.shadow ? `drop-shadow(${s.shadow.x}px ${s.shadow.y}px ${s.shadow.blur / 2}px ${s.shadow.color})` : '';
        usig = look;
        if (unit !== 'all') {
          const us = el.querySelectorAll('.ov-u'), n = us.length, ranks = unitRanks(it, n), stag = staggerOf(it, n), per = loopPerUnit(it), parts = [];
          for (let i = 0; i < n; i++) {
            const m = unitMods(it, t, ranks[i], n, stag), lp = per ? loopMods(it, lt, i) : null;
            const dx = m.dx + (lp ? lp.dx : 0), dy = m.dy + (lp ? lp.dy : 0);
            const tf = `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)${m.rot ? ` rotate(${m.rot.toFixed(2)}deg)` : ''}${m.rx ? ` perspective(${P}px) rotateX(${m.rx.toFixed(2)}deg)` : ''} scale(${m.s.toFixed(4)})`;
            const u = us[i], inner = u.firstElementChild, wp = m.wipe ? wipeCss(m.wipe) : '';
            u.style.transform = tf; u.style.opacity = m.o.toFixed(3); u.style.filter = m.blur > 0 ? `blur(${m.blur.toFixed(2)}px)` : '';
            u.style.overflow = m.rise > 0 ? 'hidden' : ''; u.style.verticalAlign = m.rise > 0 ? 'bottom' : ''; inner.style.transform = m.rise > 0 ? `translateY(${(m.rise * 100).toFixed(2)}%)` : '';
            u.style.clipPath = wp;
            parts.push(`${tf}|${m.o.toFixed(3)}|${m.blur.toFixed(2)}|${m.rise.toFixed(3)}|${wp}`);
          }
          usig += parts.join(';');
        }
      }
      const filt = [shadow, fxCss(it.effects, lt), st.blur > 0 ? `blur(${st.blur.toFixed(2)}px)` : ''].filter(Boolean).join(' ');
      const tilt = st.rotationX || st.rotationY ? ` perspective(${P}px) rotateX(${st.rotationX}deg) rotateY(${st.rotationY}deg)` : '';
      const clip = st.wipe ? wipeCss(st.wipe) : it.mask ? itemMaskCss(it.mask, lt) : '';
      const rise = st.rise > 0 ? st.rise : 0;
      el.style.cssText = `position:absolute;left:${doc.width / 2 + st.x}px;top:${doc.height / 2 + st.y}px;transform:translate(-50%,-50%)${tilt} rotate(${st.rotation}deg) scale(${st.scale});opacity:${st.opacity};z-index:${z};pointer-events:${o.interactive ? 'auto' : 'none'};${filt ? `filter:${filt};` : ''}${clip ? `clip-path:${clip};` : ''}${rise ? 'overflow:hidden;' : ''}${it.blend ? `mix-blend-mode:${CSS_BLEND[it.blend] || 'normal'};` : ''}`;
      if (!it.shape) { const bx = el.firstElementChild; if (bx) bx.style.transform = rise ? `translateY(${(rise * 100).toFixed(2)}%)` : ''; }
      el.classList.toggle('sel', !!(o.selected && o.selected.has(key)));
      sig.push(`${key}|${z}|${st.x.toFixed(2)},${st.y.toFixed(2)},${st.scale.toFixed(4)},${st.rotation.toFixed(2)},${st.opacity.toFixed(3)}${tilt}|${filt}|${clip}|${rise.toFixed(3)}|${it.blend || ''}|${usig}`);
    }
    for (const el of [...stage.querySelectorAll(':scope > [data-ov]')]) if (!seen.has(el.dataset.ov)) el.remove();
    return sig.join('\n');
  }
  /** 이 브라우저(PC)에 그 글꼴이 있는지: 대체 글꼴과 글자 폭이 다르면 있음(document.fonts.check 는 시스템 글꼴을 늘 있다고 해서 못 씀) */
  function fontAvailable(name) {
    if (typeof document === 'undefined' || !name) return true;
    const c = fontAvailable.ctx || (fontAvailable.ctx = document.createElement('canvas').getContext('2d'));
    const s = '가나다라마바사 ABCxyz 0123 !?';
    return ['monospace', 'serif', 'sans-serif'].some((fb) => { c.font = `64px ${fb}`; const a = c.measureText(s).width; c.font = `64px "${String(name).replace(/"/g, '')}", ${fb}`; return Math.abs(c.measureText(s).width - a) > 0.5; });
  }
  /** 쓰는 글꼴 이름 목록 */
  function fontsOf(doc) {
    const out = new Set();
    for (const tr of doc.tracks) if (tr.kind === 'text') for (const it of tr.items) if (!it.shape) out.add(styleOf(doc, tr, it).font);
    return [...out];
  }

  /* ---------- SRT · 시간 표기 ---------- */
  function parseSrt(text) {
    const out = [];
    const tc = (s) => { const m = String(s).trim().match(/(\d+):(\d+):(\d+)[,.](\d{1,3})/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + Number(m[4].padEnd(3, '0')) / 1000 : null; };
    for (const block of String(text || '').replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      const i = lines.findIndex((l) => l.includes('-->')); if (i < 0) continue;
      const [a, b] = lines[i].split('-->'); const s = tc(a), e = tc(b);
      if (s == null || e == null || e <= s) continue;
      out.push({ start: s, end: e, text: lines.slice(i + 1).join('\n') });
    }
    return out;
  }
  function toSrt(items) {
    const tc = (v) => { const ms = Math.round(Math.max(0, v) * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
    return items.filter((it) => !it.shape).map((it, i) => `${i + 1}\n${tc(it.start)} --> ${tc(it.end)}\n${it.text}\n`).join('\n');
  }
  const snap = (t, fps) => Math.round(t * fps) / fps;
  function fmtTime(t, fps) {
    const f = Math.round(Math.max(0, t) * fps), F = Math.round(fps);
    const ff = f % F, s = Math.floor(f / F), mm = Math.floor(s / 60), ss = s % 60;
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
  }

  /* ---------- 원본 넣기 (화면 끌어 넣기·CLI add 공통) ---------- */
  /**
   * 원본 하나를 트랙에 넣는다. info = 원본 정보(엔진 probe: kind·duration·width·height·fps·audio), o = { path, name, at, trackId, length }
   * - 같은 경로 원본이 이미 있으면 그 항목을 다시 쓴다
   * - 고른 트랙이 맞는 종류이고 그 자리가 비었으면 거기, 아니면 같은 종류의 빈 트랙, 없으면 새 트랙(영상은 맨 위)
   * - 영상 원본을 소리 트랙에 놓으면 소리만 쓴다. 그림은 기본 3초, 화면보다 작으면 원래 크기
   * 반환: { media, track, clip } (id)
   */
  function placeMedia(doc, info, o) {
    o = o || {};
    const path = String(o.path || ''); if (!path) throw new Error('원본 경로가 없어요');
    let id = Object.keys(doc.media).find((k) => doc.media[k].path === path);
    if (!id) {
      let n = Object.keys(doc.media).length + 1; while (doc.media[`m${n}`]) n++; id = `m${n}`;
      const kind = KINDS.includes(info && info.kind) ? info.kind : kindOf(path);
      doc.media[id] = { path, name: o.name || path.split(/[\\/]/).pop(), kind, duration: kind === 'image' ? 0 : num(info && info.duration, 0), width: num(info && info.width, 0), height: num(info && info.height, 0), fps: num(info && info.fps, 0), audio: (kind === 'video' || kind === 'edit') && !!(info && info.audio) };
    }
    const m = doc.media[id];
    const visual = m.kind !== 'video' || m.width > 0;
    let want = visual ? 'video' : 'audio';
    let tr = o.trackId ? doc.tracks.find((t) => t.id === o.trackId) : null;
    if (tr && tr.kind === 'audio' && m.kind === 'video' && m.audio) want = 'audio';
    else if (tr && tr.kind !== want) tr = null;
    const want0 = o.length == null || o.length === '' ? 3 : num(o.length, 3); // 길이를 안 주면 3초(null 을 0으로 읽지 않게)
    const len = m.kind === 'image' ? Math.max(1 / doc.fps, want0) : Math.max(1 / doc.fps, m.duration || want0);
    const at = snap(Math.max(0, num(o.at, 0)), doc.fps);
    const free = (t) => t.kind === want && !t.locked && !t.clips.some((c) => at < clipEnd(c) - 1e-6 && at + len > c.start + 1e-6);
    if (!tr || !free(tr)) tr = doc.tracks.find(free) || null;
    if (!tr) {
      const n = doc.tracks.filter((t) => t.kind === want).length + 1;
      let tid = `${want[0]}${n}`; while (doc.tracks.some((t) => t.id === tid)) tid = uid(want[0]);
      tr = { id: tid, kind: want, name: `${want === 'video' ? '영상' : '소리'} ${n}`, muted: false, hidden: false, locked: false, clips: [] };
      // 영상 트랙은 배열 뒤쪽이 위에 그려진다 — 새 영상 트랙은 마지막 영상 트랙 바로 뒤(자막·소리 트랙 순서는 그대로)
      if (want === 'video') { let last = -1; doc.tracks.forEach((t, i) => { if (t.kind === 'video') last = i; }); doc.tracks.splice(last + 1, 0, tr); } else doc.tracks.push(tr);
    }
    const small = m.width > 0 && m.height > 0 && m.width <= doc.width && m.height <= doc.height;
    const same = m.width === doc.width && m.height === doc.height;
    const fit = m.kind === 'image' ? (small ? 'none' : 'contain') : m.kind === 'html' ? (same || !m.width ? 'cover' : 'none') : m.kind === 'edit' ? (same ? 'cover' : 'contain') : 'cover';
    let cid = uid('c'); while (doc.tracks.some((t) => (t.clips || t.items).some((x) => x.id === cid))) cid = uid('c');
    tr.clips.push({ id: cid, media: id, start: at, in: 0, out: r4(len), volume: 0, fadeIn: 0, fadeOut: 0, fit, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, keys: {} });
    tr.clips.sort((a, b) => a.start - b.start);
    return { media: id, track: tr.id, clip: cid };
  }
  /** SRT 를 자막 트랙으로: 이름이 같은 자막 트랙이 있으면 내용을 바꾸고, 없으면 새로 만든다. 반환: { track, count } */
  function srtTrack(doc, text, name) {
    const items = parseSrt(text);
    let tr = doc.tracks.find((t) => t.kind === 'text' && (!name || t.name === name));
    if (!tr) { let tid = `t${doc.tracks.length + 1}`; while (doc.tracks.some((t) => t.id === tid)) tid = uid('t'); tr = { id: tid, kind: 'text', name: name || '자막', style: Object.keys(doc.styles || {})[0] || null, muted: false, hidden: false, locked: false, items: [] }; doc.tracks.push(tr); }
    tr.items = items.map((c) => ({ id: uid('x'), start: r4(c.start), end: r4(c.end), text: c.text, style: null, override: {}, x: 0, y: Math.round(doc.height * 0.36), scale: 1, rotation: 0, opacity: 1, anim: { in: 'none', out: 'none', inDur: 0.2, outDur: 0.15 }, keys: {} }));
    return { track: tr.id, count: items.length };
  }
  /** 자막 점검(글자 폭 재기 없이 — 엔진·CLI 용): 1초 미만 빈칸·겹침·두 줄 */
  function textChecks(doc) {
    const out = { gaps: [], overlaps: [], twoLines: [] }, h = 0.5 / doc.fps;
    for (const tr0 of doc.tracks) if (tr0.kind === 'text') {
      const tr = { name: tr0.name, items: tr0.items.filter((it) => !it.shape) };
      for (let i = 1; i < tr.items.length; i++) { const a = tr.items[i - 1], b = tr.items[i], g = b.start - a.end; if (g > h && g < 1) out.gaps.push({ track: tr.name, at: a.end, frames: Math.round(g * doc.fps), text: b.text }); else if (g < -h) out.overlaps.push({ track: tr.name, at: b.start, frames: Math.round(-g * doc.fps), text: b.text }); }
      for (const it of tr.items) if (it.text.includes('\n')) out.twoLines.push({ track: tr.name, at: it.start, text: it.text });
    }
    return out;
  }

  root.OddinVideo = { KINDS, FITS, kindOf, placeMedia, srtTrack, textChecks, PROPS, BASE, CLIP_PROPS, ITEM_PROPS, CLIP_BASE, clipOpacity, clipGain, editability,
    TRANS, TRANS_KO, BLENDS, CSS_BLEND, FX, FX_KO, FX_KEYS, ITEM_FX, UNITS, LOOPS, LOOP_DEF, SHAPES, MASKS, DIRS, EQ_PRESETS, OUT_FORMATS, easeFn, bezierFn, clipLen, srcOffset, sourceTime, speedAt, transState, wnoise, wiggleAt, cameraAt, project, perspOf, depthAt, maskAt, maskValue, effectAt, fxCss, clipCss, duckDb, duckEnv, duckRanges, loopMods, unitsOf, unitOf, unitRanks, unitMods, applyAnim, shapePath, shapeSvg, polyAt,
    cleanOutput, cleanTrans, cleanFx, cleanMask, cleanShape, cleanLoop, cleanTrackAudio, cleanCamera, cleanKeyList, EASE, EASE_KO, ANIM, ANIM_KO, STYLE_DEFAULT, valueAt, styleOf, normalize, duration, clipEnd, animMods, itemState, fitSize, clipBox, activeClips, renderOverlay, fontsOf, fontAvailable, parseSrt, toSrt, snap, fmtTime, uid, clamp };
})(typeof window !== 'undefined' ? window : globalThis);
