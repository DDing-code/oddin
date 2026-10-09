/* ODDIN 스튜디오 공용 코어 (2026-10-10, replica/architecture.md · docs/studio.md)
   편집기 화면(studio/ui/editor.js) · 렌더 페이지(studio/ui/render.html) · 엔진(studio/engine/edit.mjs, vm 으로 읽음)이 같은 코드를 쓴다
   → 미리보기와 렌더 결과가 같은 계산·같은 그리기로 나온다.
   - 편집 파일 형식 정리(normalize) · 길이 · 스타일 합치기
   - 키프레임 값(valueAt) · 이징(EASE — 서버의 ffmpeg 식 EASE_EXPR 과 같은 공식) · 등장/퇴장 효과
   - 글자·자막 레이어 그리기(renderOverlay) · SRT 읽기/쓰기 · 시간 표기
   - 원본 넣기(placeMedia — 화면 끌어 넣기·CLI add 공통) · SRT 를 자막 트랙으로(srtTrack) */
(function (root) {
  'use strict';
  const PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
  const BASE = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  // 원본 종류: 영상·소리(video) · 그림(image, 길이 없음) · HTML 장면(html). 화면 맞춤: 꽉 채우기·다 보이게·원래 크기
  const KINDS = ['video', 'image', 'html'], FITS = ['cover', 'contain', 'none'];
  const kindOf = (p) => (/\.html?$/i.test(p) ? 'html' : /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(p) ? 'image' : 'video');

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
  };
  const EASE_KO = { linear: '일정하게', ease: '부드럽게', in: '천천히 시작', out: '천천히 멈춤', hold: '정지(뚝 바뀜)', snap: '쫀득(살짝 튐)', expo: '빠르게 붙음' };
  const ANIM = ['none', 'fade', 'pop', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'zoom'];
  const ANIM_KO = { none: '없음', fade: '페이드', pop: '팝', slideUp: '아래에서 위로', slideDown: '위에서 아래로', slideLeft: '오른쪽에서', slideRight: '왼쪽에서', zoom: '줌' };

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
        const f = EASE[a.ease] || EASE.linear;
        return a.v + (b.v - a.v) * f((t - a.t) / span);
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
  function cleanKeys(keys) {
    const out = {};
    if (!keys || typeof keys !== 'object') return out;
    for (const p of PROPS) {
      const list = Array.isArray(keys[p]) ? keys[p] : [];
      const ks = list.map((k) => ({ t: r4(Math.max(0, num(k && k.t, 0))), v: num(k && k.v, BASE[p]), ease: EASE[k && k.ease] ? k.ease : 'ease' })).sort((a, b) => a.t - b.t);
      const uniq = []; for (const k of ks) { if (uniq.length && Math.abs(uniq[uniq.length - 1].t - k.t) < 1e-4) uniq[uniq.length - 1] = k; else uniq.push(k); }
      if (uniq.length) out[p] = uniq;
    }
    return out;
  }
  function transformOf(o) { const t = {}; for (const p of PROPS) t[p] = num(o && o[p], BASE[p]); t.opacity = clamp(t.opacity, 0, 1); return t; }
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
    for (const [id, m] of Object.entries(d.media && typeof d.media === 'object' ? d.media : {})) {
      if (!m || typeof m.path !== 'string' || !m.path) { problems.push(`원본 ${id}: 경로가 없어 뺐어요`); continue; }
      const kind = KINDS.includes(m.kind) ? m.kind : kindOf(m.path);
      doc.media[id] = { path: m.path, kind, duration: kind === 'image' ? 0 : num(m.duration, 0), width: num(m.width, 0), height: num(m.height, 0), fps: num(m.fps, 0), audio: kind === 'video' && m.audio !== false, ...(m.name ? { name: String(m.name) } : {}) };
    }
    for (const [name, s] of Object.entries(d.styles && typeof d.styles === 'object' ? d.styles : {})) if (s && typeof s === 'object') doc.styles[String(name)] = s;
    const ids = new Set();
    const fresh = (id, p) => { let v = typeof id === 'string' && /^[\w-]{1,40}$/.test(id) && !ids.has(id) ? id : uid(p); ids.add(v); return v; };
    for (const tr of Array.isArray(d.tracks) ? d.tracks : []) {
      const kind = ['video', 'audio', 'text'].includes(tr && tr.kind) ? tr.kind : null;
      if (!kind) { problems.push('종류를 모르는 트랙을 뺐어요'); continue; }
      const t = { id: fresh(tr.id, kind[0]), kind, name: String(tr.name || { video: '영상', audio: '소리', text: '자막' }[kind]), muted: !!tr.muted, hidden: !!tr.hidden, locked: !!tr.locked };
      if (kind === 'text') {
        t.style = tr.style ? String(tr.style) : null;
        t.items = (Array.isArray(tr.items) ? tr.items : []).map((it) => {
          const start = Math.max(0, num(it && it.start, 0)), end = Math.max(start + 1 / doc.fps, num(it && it.end, start + 1));
          const a = it && it.anim && typeof it.anim === 'object' ? it.anim : {};
          return { id: fresh(it && it.id, 'x'), start: r4(start), end: r4(end), text: String((it && it.text) ?? ''), style: it && it.style ? String(it.style) : null,
            override: it && it.override && typeof it.override === 'object' ? it.override : {}, ...transformOf(it),
            anim: { in: ANIM.includes(a.in) ? a.in : 'none', out: ANIM.includes(a.out) ? a.out : 'none', inDur: clamp(num(a.inDur, 0.2), 0, 5), outDur: clamp(num(a.outDur, 0.15), 0, 5) },
            keys: cleanKeys(it && it.keys) };
        }).sort((a, b) => a.start - b.start);
      } else {
        t.clips = (Array.isArray(tr.clips) ? tr.clips : []).filter((c) => {
          if (c && doc.media[c.media]) return true;
          problems.push(`없는 원본(${c && c.media})을 쓰는 클립을 뺐어요`); return false;
        }).map((c) => {
          const m = doc.media[c.media];
          let inn = Math.max(0, num(c.in, 0)), out = Math.max(inn + 1 / doc.fps, num(c.out, m.duration || inn + 1));
          if (m.duration && out > m.duration + 0.001) { out = m.duration; if (inn >= out) inn = Math.max(0, out - 1 / doc.fps); problems.push(`클립 ${c.id || ''}: 원본 길이를 넘어 끝을 줄였어요`); }
          return { id: fresh(c.id, 'c'), media: c.media, start: r4(Math.max(0, num(c.start, 0))), in: r4(inn), out: r4(out), volume: clamp(num(c.volume, 0), -60, 24),
            fadeIn: clamp(num(c.fadeIn, 0), 0, 10), fadeOut: clamp(num(c.fadeOut, 0), 0, 10), fit: FITS.includes(c.fit) ? c.fit : 'cover', ...transformOf(c), keys: cleanKeys(c.keys) };
        }).sort((a, b) => a.start - b.start);
      }
      doc.tracks.push(t);
    }
    if (!doc.tracks.length) doc.tracks.push({ id: fresh('v1', 'v'), kind: 'video', name: '영상', muted: false, hidden: false, locked: false, clips: [] });
    for (const mk of Array.isArray(d.markers) ? d.markers : []) if (mk && Number.isFinite(Number(mk.t))) doc.markers.push({ id: fresh(mk.id, 'k'), t: r4(Math.max(0, Number(mk.t))), label: String(mk.label || '') });
    doc.markers.sort((a, b) => a.t - b.t);
    return { doc, problems };
  }
  const clipEnd = (c) => c.start + (c.out - c.in);
  function duration(doc) {
    let d = 0;
    for (const t of doc.tracks) for (const x of t.clips || t.items || []) d = Math.max(d, t.kind === 'text' ? x.end : clipEnd(x));
    return r4(d);
  }

  /* ---------- 위치·크기 계산 (미리보기·렌더 공통) ---------- */
  /** 등장·퇴장 효과: 그 시각의 더하고 곱할 값 */
  function animMods(item, t) {
    const out = { dx: 0, dy: 0, s: 1, o: 1 };
    const a = item.anim; if (!a) return out;
    const apply = (kind, p) => {
      if (kind === 'none' || p >= 1) return;
      const e = EASE.expo(p), q = clamp(p, 0, 1);
      if (kind === 'fade') out.o *= q;
      else if (kind === 'pop') { out.s *= 0.6 + 0.4 * EASE.snap(q); out.o *= Math.min(1, q * 3); }
      else if (kind === 'zoom') { out.s *= 1.3 - 0.3 * e; out.o *= q; }
      else if (kind === 'slideUp') { out.dy += (1 - e) * 90; out.o *= q; }
      else if (kind === 'slideDown') { out.dy -= (1 - e) * 90; out.o *= q; }
      else if (kind === 'slideLeft') { out.dx += (1 - e) * 140; out.o *= q; }
      else if (kind === 'slideRight') { out.dx -= (1 - e) * 140; out.o *= q; }
    };
    const len = item.end - item.start, inD = Math.min(a.inDur, len / 2), outD = Math.min(a.outDur, len / 2);
    if (inD > 0) apply(a.in, (t - item.start) / inD);
    if (outD > 0) apply(a.out, (item.end - t) / outD);
    return out;
  }
  /** 자막·글자의 그 시각 상태(보이지 않으면 null) */
  function itemState(item, t) {
    if (t < item.start || t >= item.end) return null;
    const lt = t - item.start, k = item.keys || {}, m = animMods(item, t);
    return { x: valueAt(item.x, k.x, lt) + m.dx, y: valueAt(item.y, k.y, lt) + m.dy, scale: valueAt(item.scale, k.scale, lt) * m.s, rotation: valueAt(item.rotation, k.rotation, lt), opacity: clamp(valueAt(item.opacity, k.opacity, lt) * m.o, 0, 1) };
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
    const lt = t - clip.start, k = clip.keys || {};
    const f = fitSize(doc, doc.media[clip.media], clip.fit), s = valueAt(clip.scale, k.scale, lt);
    return { cx: doc.width / 2 + valueAt(clip.x, k.x, lt), cy: doc.height / 2 + valueAt(clip.y, k.y, lt), w: f.w * s, h: f.h * s, rotation: valueAt(clip.rotation, k.rotation, lt), opacity: clip.opacity };
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
  /** stage(화면 크기 W×H 의 상자) 안에 그 시각의 글자 레이어를 그린다. 반환: 렌더용 서명(같으면 같은 그림) */
  function renderOverlay(stage, doc, t, opts) {
    const o = opts || {};
    const seen = new Set(), sig = [];
    const tracks = doc.tracks.filter((tr) => tr.kind === 'text' && !tr.hidden);
    let z = 1;
    for (const tr of tracks) for (const it of tr.items) {
      z++;
      const st = itemState(it, t); if (!st) continue;
      const s = styleOf(doc, tr, it), css = styleCss(s);
      const key = it.id; seen.add(key);
      let el = stage.querySelector(`:scope > [data-ov="${key}"]`);
      if (!el) { el = stage.ownerDocument.createElement('div'); el.className = 'ov-layer'; el.dataset.ov = key; stage.appendChild(el); }
      const look = JSON.stringify([it.text, css, s.shadow, s.bg]);
      if (el.dataset.look !== look) {
        el.dataset.look = look;
        const bg = s.bg ? `background:${s.bg.color};padding:${s.bg.padY}px ${s.bg.padX}px;border-radius:${s.bg.radius}px;` : '';
        const text = esc(it.text);
        el.innerHTML = `<div class="ov-box" style="display:inline-grid;${bg}${css.box}">${s.stroke ? `<span class="ov-st" aria-hidden="true" style="grid-area:1/1;${css.stroke}">${text}</span>` : ''}<span class="ov-fi" style="grid-area:1/1;${css.fill}">${text}</span></div>`;
        el.style.filter = s.shadow ? `drop-shadow(${s.shadow.x}px ${s.shadow.y}px ${s.shadow.blur / 2}px ${s.shadow.color})` : '';
      }
      el.style.cssText = `position:absolute;left:${doc.width / 2 + st.x}px;top:${doc.height / 2 + st.y}px;transform:translate(-50%,-50%) rotate(${st.rotation}deg) scale(${st.scale});opacity:${st.opacity};z-index:${z};pointer-events:${o.interactive ? 'auto' : 'none'};${el.style.filter ? `filter:${el.style.filter};` : ''}`;
      el.classList.toggle('sel', !!(o.selected && o.selected.has(key)));
      sig.push(`${key}|${z}|${st.x.toFixed(2)},${st.y.toFixed(2)},${st.scale.toFixed(4)},${st.rotation.toFixed(2)},${st.opacity.toFixed(3)}|${look}`);
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
    for (const tr of doc.tracks) if (tr.kind === 'text') for (const it of tr.items) out.add(styleOf(doc, tr, it).font);
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
    return items.map((it, i) => `${i + 1}\n${tc(it.start)} --> ${tc(it.end)}\n${it.text}\n`).join('\n');
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
      doc.media[id] = { path, name: o.name || path.split(/[\\/]/).pop(), kind, duration: kind === 'image' ? 0 : num(info && info.duration, 0), width: num(info && info.width, 0), height: num(info && info.height, 0), fps: num(info && info.fps, 0), audio: kind === 'video' && !!(info && info.audio) };
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
    const fit = m.kind === 'image' ? (small ? 'none' : 'contain') : m.kind === 'html' ? (same || !m.width ? 'cover' : 'none') : 'cover';
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
    for (const tr of doc.tracks) if (tr.kind === 'text') {
      for (let i = 1; i < tr.items.length; i++) { const a = tr.items[i - 1], b = tr.items[i], g = b.start - a.end; if (g > h && g < 1) out.gaps.push({ track: tr.name, at: a.end, frames: Math.round(g * doc.fps), text: b.text }); else if (g < -h) out.overlaps.push({ track: tr.name, at: b.start, frames: Math.round(-g * doc.fps), text: b.text }); }
      for (const it of tr.items) if (it.text.includes('\n')) out.twoLines.push({ track: tr.name, at: it.start, text: it.text });
    }
    return out;
  }

  root.OddinVideo = { KINDS, FITS, kindOf, placeMedia, srtTrack, textChecks, PROPS, BASE, EASE, EASE_KO, ANIM, ANIM_KO, STYLE_DEFAULT, valueAt, styleOf, normalize, duration, clipEnd, animMods, itemState, fitSize, clipBox, activeClips, renderOverlay, fontsOf, fontAvailable, parseSrt, toSrt, snap, fmtTime, uid, clamp };
})(typeof window !== 'undefined' ? window : globalThis);
