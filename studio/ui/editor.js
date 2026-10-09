/* ODDIN 스튜디오 편집기 (2026-10-10 사용자 "오딘에 딱 맞는 영상편집 툴 … 간단한 싱크 수정/디자인/모션 수정" → 같은 날 "오딘과 연동되는 프로그램으로", replica/recon.md·architecture.md)
   프리미어·AE에서 그 세 가지에 쓰던 흐름을 새로 짠 것. 편집 파일 *.oddin-edit.json 하나를 AI 와 사용자가 같이 고친다.
   - 여는 곳: 시작 화면(home.js)·주소 ?path=·ODDIN 경로 메뉴(엔진 /api/open). window.studioEditor.open(path)
   - 원본 넣기: 왼쪽 원본 패널(폴더 둘러보기·끌어 넣기·올리기) · 탐색기에서 타임라인/화면으로 끌어 놓기(프로그램 창은 실제 경로, 브라우저는 편집 폴더로 올림)
   - 미리보기: 원본 <video>(원본마다 A/B 두 개로 컷 경계 끊김을 줄임) · 그림 <img> · HTML 장면 <iframe>(scene-seek.js 로 시각 맞춤) + 글자 레이어(video-core.js renderOverlay — 렌더와 같은 그리기)
   - 타임라인: 트랙·막대·파형·썸네일·재생 헤드·마커, 끌어 옮기기·가장자리 자르기·자석·리플·자막 붙여 두기
   - 속성: 글·스타일(역할별 공유)·변형·키프레임·이징·등장/퇴장, 영상 클립 확대(펀치 인)·음량·페이드
   - 저장은 자동(바뀐 뒤 0.7초), AI 가 파일을 바꾸면 다시 읽음. 렌더는 엔진(studio/engine/edit.mjs)이 MP4 로 */
(() => {
  'use strict';
  const V = window.OddinVideo; if (!V) return;
  Object.assign(IC, {
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
    skipb: '<path d="M6 5v14M18 5 9 12l9 7z"/>', skipf: '<path d="M18 5v14M6 5l9 7-9 7z"/>',
    stepb: '<path d="M15 6l-6 6 6 6"/>', stepf: '<path d="M9 6l6 6-6 6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>', ripple: '<path d="M3 12h6M15 12h6M9 8v8M15 8v8"/><path d="M11 12h2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    diamond: '<path d="M12 3 21 12 12 21 3 12z"/>', scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
    marker: '<path d="M6 3h12v13l-6 5-6-5z"/>', type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>', sound: '<path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    eyeoff: '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.4-1.6"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', bolt2: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', render: '<path d="M4 4h16v12H4z"/><path d="M8 20h8M12 16v4"/><path d="m10 8 4 2-4 2z" fill="currentColor"/>',
  });

  /* ---------- 상태 ---------- */
  const E = {
    open: false, path: '', doc: null, mtime: 0, dirty: false, saving: false, saveAgain: false, conflict: false, problems: [],
    sel: new Set(), t: 0, playing: false, t0: 0, p0: 0, raf: 0, zoom: 80, snap: true, ripple: false, chain: true,
    undo: [], redo: [], sessionId: null, peaks: new Map(), thumbs: new Map(), render: null, k: 1, drag: null, el: null, watchT: 0, inspHold: false, loop: null,
  };
  const FR = () => 1 / E.doc.fps;
  const snapT = (t) => V.snap(Math.max(0, t), E.doc.fps);
  const enc = encodeURIComponent;
  const $v = (s) => E.el?.querySelector(s);
  const dur = () => Math.max(V.duration(E.doc), 1);
  const tc = (t) => V.fmtTime(t, E.doc.fps);
  const dbGain = (db) => Math.pow(10, (Number(db) || 0) / 20);
  const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
  const isAbs = (p) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);
  const mediaAbs = (id) => { const p = E.doc.media[id]?.path || ''; return isAbs(p) ? p : `${dirOf(E.path)}/${p}`; };
  const fileUrl = (p) => `api/file?path=${enc(p)}`;
  const rawUrl = (p) => `api/raw/${String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')}`;
  const items = () => { const out = []; for (const tr of E.doc.tracks) for (const x of tr.items || tr.clips) out.push({ tr, x }); return out; };
  const find = (id) => { for (const tr of E.doc.tracks) { const x = (tr.items || tr.clips).find((y) => y.id === id); if (x) return { tr, x }; } return null; };
  const startOf = (x) => x.start, endOf = (tr, x) => (tr.kind === 'text' ? x.end : V.clipEnd(x));
  const setEnd = (tr, x, e) => { if (tr.kind === 'text') x.end = e; else x.out = x.in + (e - x.start); };
  const selected = () => [...E.sel].map(find).filter(Boolean);

  /* ---------- 열기·닫기 ---------- */
  async function open(path, { sessionId = null } = {}) {
    let r; try { r = await api(`api/edit?path=${enc(path)}`); } catch (e) { return toast(`편집 파일을 열지 못했어요: ${e.message}`, true); }
    if (E.open) close(true);
    const sid = sessionId || new URLSearchParams(location.search).get('sid') || readSid(r.path);
    Object.assign(E, { userZoom: false, open: true, path: r.path, doc: r.doc, mtime: r.mtime, dirty: false, conflict: false, problems: r.problems || [], sel: new Set(), t: 0, playing: false, undo: [], redo: [], sessionId: sid, render: null, loop: null, binDir: E.binDir && E.binPathOf === r.path ? E.binDir : dirOf(r.path), binPathOf: r.path });
    build(); fitZoom(); refresh();
    if (E.problems.length) toast(`편집 파일을 고쳐 읽었어요: ${E.problems.slice(0, 2).join(' · ')}`);
    loadAssets();
    if (!E.fonts) api('api/fonts').then((l) => { E.fonts = l; if (E.open) renderInsp(); }).catch(() => {});
    clearInterval(E.watchT); E.watchT = setInterval(watch, 2000);
    try { localStorage.setItem('oddin.studio.last', E.path); } catch {}
    api('api/recent', { method: 'POST', body: JSON.stringify({ path: E.path, title: E.doc.title }) }).catch(() => {});
    const u = new URL(location.href); if (u.searchParams.get('path') !== E.path) { u.searchParams.set('path', E.path); u.searchParams.delete('video'); history.pushState(null, '', u); }
    document.title = `${E.doc.title || '편집'} · ODDIN 스튜디오`;
    renderBin();
  }
  async function create(videoPath) {
    try {
      const r = await api('api/new', { method: 'POST', body: JSON.stringify({ video: videoPath }) });
      toast(r.existed ? '같은 이름의 편집 파일이 있어 그것을 열어요' : r.srt ? '새 편집을 만들고 같은 이름의 SRT를 자막으로 넣었어요' : '새 편집을 만들었어요');
      return open(r.path);
    } catch (e) { toast(`편집을 만들지 못했어요: ${e.message}`, true); }
  }
  // 편집 파일마다 AI 부탁을 이어 갈 ODDIN 세션(이 브라우저에 기억)
  function readSid(p) { try { return JSON.parse(localStorage.getItem('oddin.studio.sids') || '{}')[p] || null; } catch { return null; } }
  function writeSid(p, sid) { try { const m = JSON.parse(localStorage.getItem('oddin.studio.sids') || '{}'); m[p] = sid; localStorage.setItem('oddin.studio.sids', JSON.stringify(m)); } catch {} }
  function close(silent = false, { home = true } = {}) {
    if (!E.open) return;
    pause(); clearInterval(E.watchT);
    if (E.dirty) save();
    for (const els of POOL.values()) for (const el of els) { try { if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') { el.pause(); el.removeAttribute('src'); el.load(); } else el.remove(); } catch {} }
    POOL.clear();
    E.el?.remove(); E.el = null; E.open = false;
    document.removeEventListener('keydown', onKey, true);
    document.title = 'ODDIN 스튜디오';
    if (home) { const u = new URL(location.href); if (u.searchParams.has('path')) { u.searchParams.delete('path'); history.pushState(null, '', u); } window.studioHome?.show(); }
    if (!silent) toast('편집을 닫았어요 (저장돼요)');
  }
  async function watch() {
    if (!E.open || E.dirty || E.saving || E.drag) return;
    try {
      const { mtime } = await api(`api/mtime?path=${enc(E.path)}`);
      if (Math.abs(mtime - E.mtime) > 1) await reload('파일이 바뀌어서(AI 수정 등) 다시 읽었어요');
    } catch {}
  }
  async function reload(msg) {
    const r = await api(`api/edit?path=${enc(E.path)}`);
    E.doc = r.doc; E.mtime = r.mtime; E.dirty = false; E.conflict = false; pruneSel(); loadAssets(); refresh();
    if (msg) toast(msg);
  }

  /* ---------- 저장·되돌리기 ---------- */
  const snapshot = () => JSON.stringify(E.doc);
  function sortTracks() { for (const tr of E.doc.tracks) (tr.items || tr.clips).sort((a, b) => a.start - b.start); }
  function commit(before) {
    if (snapshot() === before) return false;
    E.undo.push(before); if (E.undo.length > 200) E.undo.shift(); E.redo = [];
    sortTracks(); markDirty(); return true;
  }
  function edit(fn, { keepInsp = false } = {}) { const before = snapshot(); fn(E.doc); if (commit(before)) { E.inspHold = keepInsp; refresh(); E.inspHold = false; } }
  function markDirty() { E.dirty = true; clearTimeout(E.saveT); E.saveT = setTimeout(save, 700); renderTop(); }
  async function save(force = false) {
    if (!E.open) return;
    if (E.saving) { E.saveAgain = true; return; }
    E.saving = true; renderTop();
    try {
      const r = await api('api/edit', { method: 'PUT', body: JSON.stringify({ path: E.path, doc: E.doc, baseMtime: E.mtime, force }) });
      E.mtime = r.mtime; E.dirty = false; E.conflict = false;
    } catch (e) {
      if (/바꿨어요/.test(e.message)) E.conflict = true; else toast(`저장하지 못했어요: ${e.message}`, true);
    } finally { E.saving = false; renderTop(); if (E.saveAgain) { E.saveAgain = false; save(); } }
  }
  function undo() { if (!E.undo.length) return; E.redo.push(snapshot()); E.doc = JSON.parse(E.undo.pop()); pruneSel(); markDirty(); refresh(); }
  function redo() { if (!E.redo.length) return; E.undo.push(snapshot()); E.doc = JSON.parse(E.redo.pop()); pruneSel(); markDirty(); refresh(); }
  function pruneSel() { for (const id of [...E.sel]) if (!find(id)) E.sel.delete(id); }

  /* ---------- 파형·썸네일 ---------- */
  function loadAssets() {
    for (const [id, m] of Object.entries(E.doc.media)) {
      const p = mediaAbs(id);
      if (m.kind === 'video' && m.audio !== false && !E.peaks.has(p)) { E.peaks.set(p, null); api(`api/peaks?path=${enc(p)}`).then((r) => { const b = atob(r.peaks), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); E.peaks.set(p, a); drawLanes(); }).catch(() => {}); }
      if (((m.kind === 'video' && m.width > 0) || m.kind === 'image') && !E.thumbs.has(p)) {
        E.thumbs.set(p, null);
        api(`api/thumbs?path=${enc(p)}&meta=1`).then((meta) => { const img = new Image(); img.onload = () => { E.thumbs.set(p, { ...meta, img }); drawLanes(); }; img.src = `api/thumbs?path=${enc(p)}`; }).catch(() => {});
      }
    }
  }
  /** 그 시퀀스 시각에 소리가 나는 원본과 원본 시각(발화 시작 찾기용) */
  function sourceAt(t) {
    for (const tr of E.doc.tracks) if (tr.kind !== 'text' && !tr.muted) for (const c of tr.clips) if (t >= c.start && t < V.clipEnd(c) && E.doc.media[c.media]?.kind === 'video' && E.doc.media[c.media]?.audio !== false) return { path: mediaAbs(c.media), st: c.in + (t - c.start), clip: c };
    return null;
  }
  /** 발화 시작 찾기: 앞뒤 0.3초에서 조용하다가 소리가 올라오는 첫 지점(파형 기준) */
  function speechOnset(t) {
    const src = sourceAt(t); if (!src) return null;
    const pk = E.peaks.get(src.path); if (!pk) return null;
    const i0 = Math.max(0, Math.round((src.st - 0.3) * 100)), i1 = Math.min(pk.length - 1, Math.round((src.st + 0.3) * 100));
    if (i1 - i0 < 5) return null;
    let lo = 255, hi = 0; for (let i = i0; i <= i1; i++) { lo = Math.min(lo, pk[i]); hi = Math.max(hi, pk[i]); }
    if (hi - lo < 6) return null;
    const th = lo + Math.max(5, (hi - lo) * 0.3);
    for (let i = i0 + 2; i <= i1; i++) if (pk[i] >= th && pk[i - 1] < th) return snapT(t + ((i - 1) / 100 - src.st));
    return null;
  }

  /* ---------- 화면 뼈대 ---------- */
  const HEAD = 132;
  function build() {
    E.el?.remove();
    const el = document.createElement('section'); el.id = 'vedit'; el.setAttribute('aria-label', 'ODDIN 영상 편집기'); el.tabIndex = -1;
    el.innerHTML = `
      <header class="ve-top"></header>
      <div class="ve-mid">
        <aside class="ve-bin" aria-label="원본"${binOpen() ? '' : ' hidden'}></aside>
        <div class="ve-view"><div class="ve-stage-wrap"><div class="ve-stage"><div class="ve-vids"></div><div class="ve-ov"></div><div class="ve-guides"></div></div></div><div class="ve-drop" hidden><div>${icon('plus')}<b>여기에 놓으면 재생 헤드에 넣어요</b><span>영상·소리·그림·HTML 장면·SRT·글꼴</span></div></div></div>
        <aside class="ve-insp" aria-label="속성"></aside>
      </div>
      <div class="ve-trans"></div>
      <div class="ve-tl"><div class="ve-scroll"><div class="ve-grid"></div></div></div>
      <div class="ve-ai" hidden></div>`;
    document.body.appendChild(el); E.el = el;
    document.addEventListener('keydown', onKey, true);
    bindBin(); bindDrop();
    new ResizeObserver(() => { if (E.open) { layoutStage(); drawLanes(); } }).observe(el.querySelector('.ve-view'));
    // 타임라인 너비가 정해지거나 바뀌면 전체가 보이게 맞춘다(사용자가 확대·축소했으면 그대로)
    new ResizeObserver(() => { if (E.open && !E.userZoom) { fitZoom(); renderTimeline(); frame(); } }).observe(el.querySelector('.ve-scroll'));
    el.querySelector('.ve-scroll').addEventListener('scroll', () => { drawLanes(); }, { passive: true });
    el.querySelector('.ve-scroll').addEventListener('wheel', onWheel, { passive: false });
    bindTimeline(); bindStage(); bindInsp(); bindTop();
    el.focus({ preventScroll: true });
  }
  function refresh() { if (!E.open) return; renderTop(); renderTrans(); layoutStage(); renderTimeline(); frame(); if (!E.inspHold) renderInsp(); }

  /* ---------- 위쪽 줄 ---------- */
  function renderTop() {
    const top = $v('.ve-top'); if (!top) return;
    const st = E.conflict ? '<span class="ve-st err">다른 곳에서 바뀜</span>' : E.saving ? '<span class="ve-st">저장 중…</span>' : E.dirty ? '<span class="ve-st">바뀜</span>' : '<span class="ve-st ok">저장됨</span>';
    const r = E.render;
    const rend = r ? (r.status === 'running' ? `<span class="ve-rend"><span class="ve-bar"><i style="width:${Math.round(r.progress * 100)}%"></i></span>${esc(r.stage || '')} ${Math.round(r.progress * 100)}%<button type="button" class="btn sm" data-ve="rcancel">중지</button></span>`
      : r.status === 'done' ? `<span class="ve-rend ok">${icon('check')}렌더 완료<button type="button" class="btn sm" data-ve="rview">결과 보기</button></span>` : r.status === 'failed' ? `<span class="ve-rend err" title="${esc(r.error || '')}">${icon('alert')}렌더 실패</span>` : '') : '';
    top.innerHTML = `<button type="button" class="icon-btn ve-logo" data-ve="home" title="시작 화면으로 (저장돼요)">${icon('left')}</button><button type="button" class="btn sm${binOpen() ? ' on' : ''}" data-ve="bin" title="원본 패널: 폴더에서 영상·소리·그림·HTML 장면을 끌어 넣기">${icon('folder')}원본</button><b class="ve-title" title="${esc(E.path)}">${esc(E.doc.title || '편집')}</b>${st}
      ${E.conflict ? '<button type="button" class="btn sm" data-ve="reload">다시 읽기</button><button type="button" class="btn sm" data-ve="force">내 것으로 덮기</button>' : ''}
      <span class="grow"></span>${rend}
      <button type="button" class="icon-btn" data-ve="undo" title="되돌리기 (Ctrl+Z)" ${E.undo.length ? '' : 'disabled'}>${icon('undo')}</button>
      <button type="button" class="icon-btn" data-ve="redo" title="다시 하기 (Ctrl+Shift+Z)" ${E.redo.length ? '' : 'disabled'}>${icon('redo')}</button>
      <button type="button" class="btn sm" data-ve="ai" title="이 편집을 AI에게 부탁 — 고른 것·재생 헤드 시각을 같이 넘겨요">${icon('sparkle')}AI에게</button>
      <button type="button" class="btn sm" data-ve="srt" title="자막을 SRT 파일로 받기">SRT</button>
      <button type="button" class="btn sm primary" data-ve="render" title="MP4로 렌더 (편집 파일 옆에 저장)" ${r?.status === 'running' ? 'disabled' : ''}>${icon('render')}렌더</button>
      ${window.hubTheme ? `<button type="button" class="icon-btn" data-ve="theme" title="테마(색·모양)">${icon('palette')}</button>` : ''}`;
  }
  function bindTop() {
    E.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ve]'); if (!b || b.disabled) return;
      const a = b.dataset.ve;
      if (a === 'close' || a === 'home') return close(true);
      if (a === 'bin') { setBinOpen(!binOpen()); return; }
      if (a === 'theme') return window.hubTheme?.open();
      if (a === 'undo') return undo();
      if (a === 'redo') return redo();
      if (a === 'reload') return reload('다시 읽었어요');
      if (a === 'force') return save(true);
      if (a === 'srt') { await save(); return window.open(`api/srt?path=${enc(E.path)}`, '_blank'); }
      if (a === 'render') return startRender();
      if (a === 'rcancel') return api(`api/render/${E.render.id}/cancel`, { method: 'POST', body: '{}' }).catch((x) => toast(x.message, true));
      if (a === 'rview') return viewResult();
      if (a === 'ai') return openAi();
      if (a === 'play') return toggle();
      if (a === 'start') return seek(0);
      if (a === 'end') return seek(dur());
      if (a === 'fb') return seek(E.t - FR());
      if (a === 'ff') return seek(E.t + FR());
      if (a === 'snap') { E.snap = !E.snap; return renderTrans(); }
      if (a === 'ripple') { E.ripple = !E.ripple; return renderTrans(); }
      if (a === 'chain') { E.chain = !E.chain; return renderTrans(); }
      if (a === 'zin') return setZoom(E.zoom * 1.5);
      if (a === 'zout') return setZoom(E.zoom / 1.5);
      if (a === 'zfit') { E.userZoom = false; fitZoom(); return refresh(); }
      if (a === 'split') return splitAt();
      if (a === 'marker') return addMarker();
      if (a === 'addtext') return addText();
      if (a === 'loop') { E.loop = E.loop ? null : loopRange(); return renderTrans(); }
    });
  }

  /* ---------- 렌더 ---------- */
  async function startRender() {
    if (E.dirty) { clearTimeout(E.saveT); await save(); }
    if (E.conflict) return toast('다른 곳에서 바뀐 파일이에요. 다시 읽거나 덮어쓴 뒤 렌더하세요', true);
    try { E.render = await api('api/render', { method: 'POST', body: JSON.stringify({ path: E.path }) }); renderTop(); toast('렌더를 시작했어요. 이 PC에서 ffmpeg가 만들어요'); }
    catch (e) { toast(`렌더를 시작하지 못했어요: ${e.message}`, true); }
  }
  function viewResult() {
    const r = E.render; if (!r?.out) return;
    const body = modal(`렌더 결과 · ${r.out.split(/[\\/]/).pop()}`, true);
    body.innerHTML = `<video class="ve-result" src="${esc(fileUrl(r.out))}" controls autoplay playsinline></video>
      <div class="ve-result-acts"><span class="c-muted grow" title="${esc(r.out)}">${esc(r.out)}</span>${STUDIO.desktop?.showItem ? '<button type="button" class="btn sm" data-r="show">탐색기에서 보기</button>' : ''}<a class="btn sm" href="${esc(fileUrl(r.out))}" download>내려받기</a></div>${r.warnings?.length ? `<p class="ve-warn">${icon('alert')}${esc(r.warnings.join(' / '))}</p>` : ''}`;
    body.querySelector('[data-r="show"]')?.addEventListener('click', () => STUDIO.desktop.showItem(r.out));
  }
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type !== 'render' || !E.open || !ev.render || ev.render.path !== E.path) return;
    const was = E.render?.status; E.render = ev.render; renderTop();
    if (was === 'running' && ev.render.status === 'done') { toast(`렌더 완료: ${ev.render.out.split(/[\\/]/).pop()}${ev.render.warnings?.length ? ` · ${ev.render.warnings[0]}` : ''}`); }
    if (was === 'running' && ev.render.status === 'failed') toast(`렌더 실패: ${ev.render.error}`, true);
  });

  /* ---------- AI에게 ---------- */
  function openAi() {
    const box = $v('.ve-ai'); box.hidden = false;
    const sel = selected().map(({ tr, x }) => `${tr.name}: ${tr.kind === 'text' ? `"${x.text.slice(0, 30)}"` : (E.doc.media[x.media]?.name || x.media)} (${tc(x.start)}~${tc(endOf(tr, x))}, id ${x.id})`);
    box.innerHTML = `<div class="ve-ai-card" role="dialog" aria-label="AI에게 부탁"><b>AI에게 부탁 (ODDIN)</b><p class="c-muted">고른 것과 재생 헤드 시각을 같이 넘겨요. AI가 편집 파일을 고치면 편집기가 다시 읽어요.${E.sessionId ? ' 같은 ODDIN 세션에 이어서 해요(작업 중이면 예약).' : ' ODDIN 에 이 폴더로 새 세션을 만들어요.'}</p>
      <div class="ve-ai-ctx">${sel.length ? sel.map((x) => `<div>${esc(x)}</div>`).join('') : '<div class="c-muted">고른 것 없음 — 편집 전체</div>'}<div>재생 헤드 ${tc(E.t)}</div></div>
      <textarea rows="3" placeholder="예: 자막 전부 2프레임 늦춰 / 고른 자막을 쫀득하게 튀어나오게 / 3초부터 5초까지 확대"></textarea>
      <div class="ve-ai-acts"><button type="button" class="btn" data-ai="cancel">닫기</button><button type="button" class="btn primary" data-ai="send">보내기</button></div></div>`;
    const ta = box.querySelector('textarea'); ta.focus();
    box.onclick = async (e) => {
      const b = e.target.closest('[data-ai]'); if (!b) { if (e.target === box) box.hidden = true; return; }
      if (b.dataset.ai === 'cancel') { box.hidden = true; return; }
      const text = ta.value.trim(); if (!text) return ta.focus();
      if (E.dirty) { clearTimeout(E.saveT); await save(); }
      const goal = `[ODDIN 스튜디오에서 부탁] ${text}\n\n편집 파일: ${E.path}\n${sel.length ? `고른 것:\n${sel.map((x) => `- ${x}`).join('\n')}\n` : ''}재생 헤드: ${E.t.toFixed(3)}초 (${tc(E.t)}, ${E.doc.fps}fps)\n\n공유 스킬 oddin-studio(편집 파일 형식·도구)를 따르세요. 파일을 직접 고치면 사용자의 스튜디오 화면이 저절로 다시 읽습니다. 렌더는 사용자가 하니 부탁받지 않으면 하지 마세요.`;
      const send = (sid) => api('api/ai', { method: 'POST', body: JSON.stringify(sid ? { goal, sessionId: sid } : { goal, cwd: dirOf(E.path) }) });
      try {
        let job; try { job = await send(E.sessionId); } catch (x) { if (E.sessionId && x.status === 404) job = await send(null); else throw x; }
        E.sessionId = job.sessionId; writeSid(E.path, job.sessionId); box.hidden = true;
        toast(job.reserved ? 'AI에게 예약했어요 — ODDIN 의 지금 작업이 끝나면 해요' : 'AI에게 보냈어요 — 고치면 편집기가 다시 읽어요');
      } catch (x) { toast(`보내지 못했어요: ${x.message}`, true); }
    };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) box.querySelector('[data-ai="send"]').click(); if (e.key === 'Escape') { e.stopPropagation(); box.hidden = true; } };
  }

  /* ---------- 재생 ---------- */
  function seek(t) { E.t = Math.min(Math.max(0, snapT(t)), dur()); if (E.playing) { E.t0 = E.t; E.p0 = performance.now(); } frame(true); renderInspLive(); }
  function toggle() { E.playing ? pause() : play(); }
  function play() {
    if (E.playing) return;
    if (E.t >= dur() - FR()) E.t = E.loop ? E.loop[0] : 0;
    E.playing = true; E.t0 = E.t; E.p0 = performance.now(); renderTrans();
    const tick = () => {
      if (!E.playing) return;
      // 재생 중인 원본이 있으면 그것을 시계로(소리와 어긋나지 않게), 없으면 시스템 시계
      let t = E.t0 + (performance.now() - E.p0) / 1000;
      const m = E.master;
      if (m && m.el && !m.el.paused && !m.el.seeking && m.el.readyState >= 2) { const mt = m.clip.start + (m.el.currentTime - m.clip.in); if (Math.abs(mt - t) < 0.5) { t = mt; E.t0 = t; E.p0 = performance.now(); } }
      if (E.loop && t >= E.loop[1]) { t = E.loop[0]; E.t0 = t; E.p0 = performance.now(); }
      if (t >= dur()) { E.t = dur(); pause(); frame(true); return; }
      E.t = t; frame(); E.raf = requestAnimationFrame(tick);
    };
    E.raf = requestAnimationFrame(tick);
  }
  function pause() { if (!E.playing) return; E.playing = false; cancelAnimationFrame(E.raf); E.t = snapT(E.t); for (const els of POOL.values()) for (const el of els) if (!el.paused) el.pause(); renderTrans(); frame(true); renderInspLive(); }
  function loopRange() { const s = selected(); if (s.length) return [Math.min(...s.map((v) => v.x.start)), Math.max(...s.map((v) => endOf(v.tr, v.x)))]; return [Math.max(0, E.t - 1), E.t + 2]; }

  /* ---------- 원본 재생기(원본마다 A/B 두 개) ---------- */
  const POOL = new Map(); // 원본 경로 → [el, el]
  let SEEK_SRC = null; // HTML 장면 시각 맞추기 스크립트(ui/scene-seek.js — 엔진 렌더와 같은 것)
  function poolFor(c) {
    const p = mediaAbs(c.media), m = E.doc.media[c.media];
    let a = POOL.get(p);
    if (!a) {
      const tag = m.kind === 'image' ? 'img' : m.kind === 'html' ? 'iframe' : m.width > 0 ? 'video' : 'audio';
      a = [0, 1].map(() => {
        const el = document.createElement(tag); el.className = `ve-v k-${m.kind}`; el._clip = null;
        if (tag === 'img') { el.src = fileUrl(p); el.draggable = false; el.alt = ''; }
        else if (tag === 'iframe') {
          el.src = rawUrl(p); el.setAttribute('tabindex', '-1'); el.setAttribute('title', m.name || 'HTML 장면'); el.style.width = `${m.width || E.doc.width}px`; el.style.height = `${m.height || E.doc.height}px`;
          el.addEventListener('load', async () => {
            try {
              SEEK_SRC ||= await fetch('ui/scene-seek.js').then((r) => r.text());
              el.contentWindow.eval(SEEK_SRC); el._ready = true; el._t = null; frame(true);
            } catch (e) { console.warn('HTML 장면 연결 실패', e); }
          });
        } else { el.preload = 'auto'; el.playsInline = true; el.src = fileUrl(p); }
        if (tag !== 'audio') $v('.ve-vids').appendChild(el);
        return el;
      });
      POOL.set(p, a);
    }
    return a;
  }
  const isAV = (el) => el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
  function elFor(c, pre = false) {
    const els = poolFor(c);
    return els.find((el) => el._clip === c.id) || els.find((el) => !el._clip) || (pre ? null : els.find((el) => el._pre) || els[0]);
  }
  function syncMedia(force) {
    const t = E.t, want = [];
    for (const tr of E.doc.tracks) if (tr.kind !== 'text') for (const c of tr.clips) if (t >= c.start && t < V.clipEnd(c)) want.push({ tr, c });
    const used = new Set();
    E.master = null;
    for (const { tr, c } of want) {
      const el = elFor(c); used.add(el);
      el._clip = c.id; el._pre = false;
      const exp = c.in + (t - c.start), m = E.doc.media[c.media] || {};
      if (isAV(el)) {
        el.muted = !!tr.muted || m.audio === false || tr.kind === 'video' && tr.muted; el.volume = V.clamp(dbGain(c.volume), 0, 1);
        if (tr.kind === 'audio' && el.tagName === 'VIDEO') el.muted = !!tr.muted; // 소리 트랙에 놓은 영상: 소리만
        if (E.playing) {
          if (el.paused) { el.currentTime = exp; el.play().catch(() => {}); }
          else if (Math.abs(el.currentTime - exp) > 0.25) el.currentTime = exp;
          if (!E.master && !el.muted) E.master = { el, clip: c };
        } else { if (!el.paused) el.pause(); if (force || Math.abs(el.currentTime - exp) > 0.02) el.currentTime = exp; }
      } else if (el.tagName === 'IFRAME' && el._ready && (force || el._t == null || Math.abs(el._t - exp) > 0.5 / E.doc.fps)) {
        el._t = exp; try { el.contentWindow.__oddinSeekAny?.(exp); } catch {}
      }
      if (el.tagName !== 'AUDIO') {
        if (tr.hidden || tr.kind !== 'video') { el.style.display = 'none'; continue; }
        const b = V.clipBox(E.doc, c, t), z = E.doc.tracks.indexOf(tr) + 1;
        if (el.tagName === 'IFRAME') { // 장면은 제 크기로 그리고 맞춤 배율만큼 키운다(장면 안 글자·그림이 픽셀 그대로)
          const nw = m.width || E.doc.width, nh = m.height || E.doc.height;
          el.style.cssText = `display:block;position:absolute;left:${b.cx - nw / 2}px;top:${b.cy - nh / 2}px;width:${nw}px;height:${nh}px;transform:rotate(${b.rotation}deg) scale(${b.w / nw},${b.h / nh});opacity:${b.opacity};z-index:${z};border:0;background:transparent;pointer-events:none;color-scheme:normal;`;
        } else el.style.cssText = `display:block;position:absolute;left:${b.cx - b.w / 2}px;top:${b.cy - b.h / 2}px;width:${b.w}px;height:${b.h}px;transform:rotate(${b.rotation}deg);opacity:${b.opacity};z-index:${z};object-fit:fill;pointer-events:none;`;
        el.classList.toggle('sel', E.sel.has(c.id));
      }
    }
    // 쓰지 않는 재생기는 멈추고 숨긴다. 재생 중이면 다음 컷을 미리 감아 둔다(같은 원본의 다른 재생기)
    for (const els of POOL.values()) for (const el of els) if (!used.has(el)) {
      if (isAV(el) && !el.paused) el.pause();
      el._clip = null; if (el.tagName !== 'AUDIO') el.style.display = 'none';
    }
    if (E.playing) for (const tr of E.doc.tracks) if (tr.kind !== 'text') {
      const nx = tr.clips.find((c) => c.start > t && c.start - t < 1.2); if (!nx || want.some((w) => w.c.id === nx.id)) continue;
      const el = elFor(nx, true); if (!el || used.has(el)) continue;
      if (el._pre !== nx.id) { el._pre = nx.id; el._clip = nx.id; if (isAV(el)) { try { el.currentTime = nx.in; } catch {} } }
      used.add(el);
    }
  }
  /** 화면 좌표의 그 시각 맨 위 영상 클립(그림·장면 포함) — 미리보기에서 눌러 고르기 */
  function clipAtPoint(clientX, clientY) {
    const st = $v('.ve-stage').getBoundingClientRect(), x = (clientX - st.left) / E.k, y = (clientY - st.top) / E.k;
    const list = V.activeClips(E.doc, E.t).reverse();
    for (const { clip } of list) {
      const b = V.clipBox(E.doc, clip, E.t), a = -b.rotation * Math.PI / 180, dx = x - b.cx, dy = y - b.cy;
      const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(rx) <= b.w / 2 && Math.abs(ry) <= b.h / 2) return clip.id;
    }
    return null;
  }
  function frame(force = false) {
    if (!E.open) return;
    syncMedia(force);
    V.renderOverlay($v('.ve-ov'), E.doc, E.t, { interactive: true, selected: E.sel });
    const ph = $v('.ve-ph'); if (ph) ph.style.left = `${HEAD + E.t * E.zoom}px`;
    const tm = $v('.ve-time'); if (tm) tm.textContent = `${tc(E.t)} / ${tc(dur())}`;
    if (E.playing) follow();
  }
  // 재생 헤드가 화면 밖으로 나가면 따라간다
  function follow() {
    const sc = $v('.ve-scroll'); const x = E.t * E.zoom, w = sc.clientWidth - HEAD;
    if (x < sc.scrollLeft || x > sc.scrollLeft + w - 40) sc.scrollLeft = Math.max(0, x - w * 0.2);
  }

  /* ---------- 미리보기 화면 ---------- */
  function layoutStage() {
    const view = $v('.ve-view'), wrap = $v('.ve-stage-wrap'), st = $v('.ve-stage'); if (!view) return;
    const W = E.doc.width, H = E.doc.height, k = Math.min((view.clientWidth - 24) / W, (view.clientHeight - 24) / H);
    E.k = Math.max(0.05, k);
    wrap.style.width = `${W * E.k}px`; wrap.style.height = `${H * E.k}px`;
    st.style.width = `${W}px`; st.style.height = `${H}px`; st.style.transform = `scale(${E.k})`; st.style.background = E.doc.background;
    $v('.ve-guides').innerHTML = `<i class="ve-safe"></i><i class="ve-cx"></i><i class="ve-cy"></i>`;
  }
  function bindStage() {
    const st = $v('.ve-stage');
    st.addEventListener('pointerdown', (e) => {
      const ov = e.target.closest('[data-ov]');
      let id = ov?.dataset.ov || null;
      if (!id) id = clipAtPoint(e.clientX, e.clientY);
      if (!id) { if (!e.shiftKey) { E.sel.clear(); refresh(); } return; }
      const f = find(id); if (!f) return;
      if (e.shiftKey) { E.sel.has(id) ? E.sel.delete(id) : E.sel.add(id); refresh(); return; }
      if (!E.sel.has(id)) { E.sel = new Set([id]); refresh(); }
      e.preventDefault(); st.setPointerCapture(e.pointerId);
      const before = snapshot(), x0 = e.clientX, y0 = e.clientY;
      const lt = E.t - f.x.start, keys = f.x.keys || {};
      const bx = V.valueAt(f.x.x, keys.x, lt), by = V.valueAt(f.x.y, keys.y, lt);
      E.drag = { stage: true };
      const move = (ev) => {
        let nx = bx + (ev.clientX - x0) / E.k, ny = by + (ev.clientY - y0) / E.k;
        if (E.snap) { if (Math.abs(nx) < 12 / E.k) nx = 0; if (Math.abs(ny) < 12 / E.k) ny = 0; }
        setProp(f.x, 'x', Math.round(nx)); setProp(f.x, 'y', Math.round(ny)); frame(); renderInspLive();
      };
      const up = () => { st.removeEventListener('pointermove', move); st.removeEventListener('pointerup', up); E.drag = null; if (commit(before)) refresh(); };
      st.addEventListener('pointermove', move); st.addEventListener('pointerup', up);
    });
  }
  /** 속성 값 바꾸기: 키프레임이 있으면 재생 헤드에 키를 넣거나 고치고, 없으면 기본값 */
  function setProp(x, prop, v) {
    const keys = x.keys || (x.keys = {});
    if (keys[prop]?.length) {
      const lt = Math.max(0, snapT(E.t - x.start));
      const k = keys[prop].find((q) => Math.abs(q.t - lt) < FR() / 2);
      if (k) k.v = v; else { keys[prop].push({ t: lt, v, ease: 'ease' }); keys[prop].sort((a, b) => a.t - b.t); }
    } else x[prop] = v;
  }
  function keyAt(x, prop) { const lt = E.t - x.start; return (x.keys?.[prop] || []).find((q) => Math.abs(q.t - lt) < FR() / 2) || null; }
  function toggleKey(x, prop) {
    const keys = x.keys || (x.keys = {}); const lt = Math.max(0, snapT(E.t - x.start));
    const k = keyAt(x, prop);
    if (k) { keys[prop] = keys[prop].filter((q) => q !== k); if (!keys[prop].length) { x[prop] = k.v; delete keys[prop]; } }
    else { const v = V.valueAt(x[prop], keys[prop], lt); (keys[prop] ||= []).push({ t: lt, v, ease: 'ease' }); keys[prop].sort((a, b) => a.t - b.t); }
  }

  /* ---------- 재생 줄 ---------- */
  function renderTrans() {
    const el = $v('.ve-trans'); if (!el) return;
    const on = (b) => (b ? ' on' : '');
    el.innerHTML = `<div class="ve-tg">
        <button type="button" class="icon-btn" data-ve="start" title="처음 (Home)">${icon('skipb')}</button>
        <button type="button" class="icon-btn" data-ve="fb" title="1프레임 뒤로 (←)">${icon('stepb')}</button>
        <button type="button" class="icon-btn ve-play" data-ve="play" title="재생/멈춤 (Space)">${icon(E.playing ? 'pause' : 'play')}</button>
        <button type="button" class="icon-btn" data-ve="ff" title="1프레임 앞으로 (→)">${icon('stepf')}</button>
        <button type="button" class="icon-btn" data-ve="end" title="끝 (End)">${icon('skipf')}</button>
        <span class="ve-time">${tc(E.t)} / ${tc(dur())}</span><small class="c-muted">${E.doc.fps}fps · ${E.doc.width}×${E.doc.height}</small></div>
      <div class="ve-tg">
        <button type="button" class="btn sm${on(E.loop)}" data-ve="loop" title="고른 구간(없으면 재생 헤드 주변)만 반복">구간 반복</button>
        <button type="button" class="btn sm" data-ve="split" title="재생 헤드에서 자르기 (S)">${icon('scissors')}자르기</button>
        <button type="button" class="btn sm" data-ve="addtext" title="재생 헤드에 글자 넣기 (T)">${icon('type')}글자</button>
        <button type="button" class="btn sm" data-ve="marker" title="마커 (M)">${icon('marker')}마커</button>
        <span class="ve-sep"></span>
        <button type="button" class="btn sm tog${on(E.snap)}" data-ve="snap" title="자석: 재생 헤드·다른 가장자리·마커에 붙기">${icon('magnet')}자석</button>
        <button type="button" class="btn sm tog${on(E.ripple)}" data-ve="ripple" title="리플: 옮기거나 자르면 뒤 것이 따라와요(빈칸 없이)">${icon('ripple')}리플</button>
        <button type="button" class="btn sm tog${on(E.chain)}" data-ve="chain" title="자막 붙여 두기: 붙어 있는 자막은 경계를 같이 움직여요">${icon('link')}붙여 두기</button>
        <span class="ve-sep"></span>
        <button type="button" class="icon-btn" data-ve="zout" title="타임라인 줄이기 (-)">−</button>
        <button type="button" class="btn sm" data-ve="zfit" title="전체 보기">맞춤</button>
        <button type="button" class="icon-btn" data-ve="zin" title="타임라인 늘리기 (+)">+</button></div>`;
  }

  /* ---------- 타임라인 ---------- */
  const LANE_H = { video: 58, audio: 46, text: 36 };
  function fitZoom() { const sc = $v('.ve-scroll'), w = sc?.clientWidth > HEAD + 100 ? sc.clientWidth : Math.max(900, window.innerWidth); E.zoom = Math.max(4, Math.min(600, (w - HEAD - 40) / dur())); }
  function setZoom(z, anchorT = null) {
    const sc = $v('.ve-scroll'), at = anchorT ?? E.t, px = at * E.zoom - sc.scrollLeft;
    E.zoom = Math.max(2, Math.min(800, z)); E.userZoom = true; renderTimeline(); sc.scrollLeft = Math.max(0, at * E.zoom - px); drawLanes(); frame();
  }
  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const sc = $v('.ve-scroll'), r = sc.getBoundingClientRect(), t = (e.clientX - r.left - HEAD + sc.scrollLeft) / E.zoom;
    setZoom(E.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), Math.max(0, t));
  }
  function renderTimeline() {
    const g = $v('.ve-grid'); if (!g) return;
    const W = HEAD + dur() * E.zoom + 200;
    const rows = E.doc.tracks.map((tr, i) => {
      const bars = (tr.items || tr.clips).map((x) => barHtml(tr, x)).join('');
      return `<div class="ve-row k-${tr.kind}${tr.hidden ? ' hid' : ''}" style="height:${LANE_H[tr.kind]}px" data-ti="${i}">
        <div class="ve-head" style="width:${HEAD}px">${icon(tr.kind === 'video' ? 'film' : tr.kind === 'audio' ? 'sound' : 'type')}<span class="ve-tn" title="두 번 눌러 이름 바꾸기">${esc(tr.name)}</span>
          <button type="button" class="ve-hb${tr.kind === 'audio' || tr.kind === 'video' ? (tr.muted ? ' on' : '') : ' x'}" data-th="muted" title="소리 끄기">${tr.kind === 'text' ? '' : 'M'}</button>
          <button type="button" class="ve-hb${tr.hidden ? ' on' : ''}${tr.kind === 'audio' ? ' x' : ''}" data-th="hidden" title="숨기기">${tr.kind === 'audio' ? '' : icon('eyeoff')}</button>
          <button type="button" class="ve-hb${tr.locked ? ' on' : ''}" data-th="locked" title="잠그기">${icon('lock')}</button></div>
        <div class="ve-lane" data-track="${esc(tr.id)}"><canvas class="ve-lc"></canvas>${bars}</div></div>`;
    }).join('');
    const marks = E.doc.markers.map((m) => `<i class="ve-mk" style="left:${HEAD + m.t * E.zoom}px" title="${esc(m.label || '마커')} · ${tc(m.t)} · 두 번 눌러 지우기" data-mk="${esc(m.id)}"></i>`).join('');
    g.style.width = `${W}px`;
    g.innerHTML = `<div class="ve-rul-row"><div class="ve-corner" style="width:${HEAD}px">${icon('film')}<span>${E.doc.tracks.length}트랙</span></div><div class="ve-ruler"><canvas class="ve-rc"></canvas></div></div>${rows}
      <div class="ve-add-row" style="padding-left:${HEAD + 6}px"><button type="button" class="ve-add" data-addtrack="text">+ 자막 트랙</button><button type="button" class="ve-add" data-addtrack="audio">+ 소리 트랙</button><button type="button" class="ve-add" data-addtrack="video">+ 영상 트랙</button></div>
      ${marks}<div class="ve-ph" style="left:${HEAD + E.t * E.zoom}px"></div>`;
    drawLanes();
  }
  function barHtml(tr, x) {
    const s = x.start, e = endOf(tr, x), left = s * E.zoom, w = Math.max(2, (e - s) * E.zoom);
    const label = tr.kind === 'text' ? x.text : (E.doc.media[x.media]?.name || E.doc.media[x.media]?.path?.split(/[\\/]/).pop() || x.media);
    const keys = E.sel.has(x.id) ? Object.entries(x.keys || {}).flatMap(([p, ks]) => ks.map((k) => `<i class="ve-kf" style="left:${k.t * E.zoom}px" title="${p} ${k.v} · ${V.EASE_KO[k.ease] || k.ease}"></i>`)).join('') : '';
    const anim = tr.kind === 'text' && x.anim ? `${x.anim.in !== 'none' ? `<i class="ve-an in" style="width:${Math.min(x.anim.inDur, (e - s) / 2) * E.zoom}px"></i>` : ''}${x.anim.out !== 'none' ? `<i class="ve-an out" style="width:${Math.min(x.anim.outDur, (e - s) / 2) * E.zoom}px"></i>` : ''}` : '';
    return `<div class="ve-bar k-${tr.kind}${E.sel.has(x.id) ? ' sel' : ''}${tr.locked ? ' locked' : ''}" data-id="${esc(x.id)}" style="left:${left}px;width:${w}px" title="${esc(label)} · ${tc(s)}~${tc(e)} (${Math.round((e - s) * E.doc.fps)}f)">${anim}<span class="ve-bl">${esc(label)}</span>${keys}<i class="ve-eg l"></i><i class="ve-eg r"></i></div>`;
  }
  // 보이는 부분만 캔버스에: 시간자·썸네일·파형
  function drawLanes() {
    if (!E.open) return;
    const sc = $v('.ve-scroll'); if (!sc) return;
    const x0 = sc.scrollLeft, vw = Math.max(10, sc.clientWidth - HEAD), t0 = x0 / E.zoom, t1 = (x0 + vw) / E.zoom;
    const dpr = window.devicePixelRatio || 1;
    const prep = (cv, h) => { cv.style.left = `${x0}px`; cv.style.width = `${vw}px`; cv.style.height = `${h}px`; cv.width = Math.round(vw * dpr); cv.height = Math.round(h * dpr); const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, vw, h); return c; };
    const css = getComputedStyle(E.el), col = (n, d) => css.getPropertyValue(n).trim() || d;
    // 시간자
    const rc = $v('.ve-rc'); if (rc) {
      const c = prep(rc, 26); const step = [1 / E.doc.fps, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * E.zoom >= 60) || 600;
      c.fillStyle = col('--muted', '#999'); c.strokeStyle = col('--line2', '#444'); c.font = '10px ' + col('--mono', 'monospace');
      for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) { const x = (t - t0) * E.zoom; c.beginPath(); c.moveTo(x + 0.5, 14); c.lineTo(x + 0.5, 26); c.stroke(); c.fillText(tc(t), x + 3, 11); }
      const sub = step / 5; if (sub * E.zoom >= 6) for (let t = Math.floor(t0 / sub) * sub; t <= t1; t += sub) { const x = (t - t0) * E.zoom; c.beginPath(); c.moveTo(x + 0.5, 21); c.lineTo(x + 0.5, 26); c.stroke(); }
      if (E.loop) { c.fillStyle = col('--accent', '#7af') + '55'; c.fillRect((E.loop[0] - t0) * E.zoom, 22, (E.loop[1] - E.loop[0]) * E.zoom, 4); }
    }
    for (const row of E.el.querySelectorAll('.ve-row')) {
      const tr = E.doc.tracks[Number(row.dataset.ti)]; const cv = row.querySelector('.ve-lc'); if (!tr || !cv) continue;
      const h = LANE_H[tr.kind], c = prep(cv, h);
      if (tr.kind === 'text') continue;
      for (const cl of tr.clips) {
        const s = cl.start, e = V.clipEnd(cl); if (e < t0 || s > t1) continue;
        const p = mediaAbs(cl.media), th = E.thumbs.get(p), pk = E.peaks.get(p);
        const bx0 = Math.max(s, t0), bx1 = Math.min(e, t1);
        c.save(); c.beginPath(); c.rect((bx0 - t0) * E.zoom, 0, (bx1 - bx0) * E.zoom, h); c.clip();
        if (tr.kind === 'video' && th?.img) {
          const tw = th.w * ((h - 18) / th.h), ty = 2, thh = h - 18;
          for (let x = (s - t0) * E.zoom; x < (bx1 - t0) * E.zoom; x += tw) {
            if (x + tw < (bx0 - t0) * E.zoom) continue;
            const st = cl.in + (x / E.zoom + t0 - s), i = Math.min(th.count - 1, Math.max(0, Math.floor(st / th.step)));
            c.globalAlpha = 0.75; c.drawImage(th.img, i * th.w, 0, th.w, th.h, x, ty, tw, thh); c.globalAlpha = 1;
          }
        }
        if (pk) {
          const wy = tr.kind === 'video' ? h - 15 : 4, wh = tr.kind === 'video' ? 13 : h - 8, mid = wy + wh / 2;
          c.fillStyle = tr.muted ? col('--faint', '#666') : col(tr.kind === 'video' ? '--codex' : '--ok', '#6c6');
          const g = dbGain(cl.volume);
          for (let x = Math.floor((bx0 - t0) * E.zoom); x < (bx1 - t0) * E.zoom; x++) {
            const ta = cl.in + (x / E.zoom + t0 - s), tb = ta + 1 / E.zoom;
            let m = 0; for (let i = Math.floor(ta * 100); i <= Math.floor(tb * 100) && i < pk.length; i++) if (i >= 0 && pk[i] > m) m = pk[i];
            const a = Math.min(1, Math.sqrt(m / 127) * g) * (wh / 2);
            c.fillRect(x, mid - a, 1, Math.max(1, a * 2));
          }
        }
        c.restore();
      }
    }
  }
  function bindTimeline() {
    const sc = $v('.ve-scroll');
    const tAt = (clientX) => { const r = sc.getBoundingClientRect(); return Math.max(0, (clientX - r.left - HEAD + sc.scrollLeft) / E.zoom); };
    sc.addEventListener('dblclick', (e) => {
      const mk = e.target.closest('[data-mk]'); if (mk) { edit((d) => { d.markers = d.markers.filter((m) => m.id !== mk.dataset.mk); }); return; }
      const tn = e.target.closest('.ve-tn'); if (tn) { const tr = E.doc.tracks[Number(tn.closest('.ve-row').dataset.ti)]; const n = prompt('트랙 이름', tr.name); if (n && n.trim()) edit(() => { tr.name = n.trim(); }); return; }
      const bar = e.target.closest('.ve-bar'); if (bar) { const f = find(bar.dataset.id); if (f?.tr.kind === 'text') { E.sel = new Set([f.x.id]); refresh(); $v('.ve-insp [data-f="text"]')?.focus(); } }
    });
    sc.addEventListener('click', (e) => {
      const hb = e.target.closest('[data-th]'); if (hb && !hb.classList.contains('x')) { const tr = E.doc.tracks[Number(hb.closest('.ve-row').dataset.ti)]; edit(() => { tr[hb.dataset.th] = !tr[hb.dataset.th]; }); return; }
      const at = e.target.closest('[data-addtrack]'); if (at) { const kind = at.dataset.addtrack; edit((d) => { const n = d.tracks.filter((t) => t.kind === kind).length + 1; d.tracks.push(kind === 'text' ? { id: V.uid('t'), kind, name: `자막 ${n}`, style: Object.keys(d.styles)[0] || null, items: [], muted: false, hidden: false, locked: false } : { id: V.uid(kind[0]), kind, name: `${kind === 'video' ? '영상' : '소리'} ${n}`, clips: [], muted: false, hidden: false, locked: false }); }); }
    });
    sc.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, [data-th], .ve-head, .ve-corner')) return;
      const bar = e.target.closest('.ve-bar');
      if (!bar) { // 시간자·빈 곳: 재생 헤드 옮기기(끌며 보기)
        if (!e.target.closest('.ve-ruler, .ve-lane, .ve-ph, .ve-mk')) return;
        if (!e.shiftKey && e.target.closest('.ve-lane')) { E.sel.clear(); }
        e.preventDefault(); sc.setPointerCapture(e.pointerId);
        const go = (ev) => { const t = tAt(ev.clientX); seek(E.snap ? snapTo(t, null, 8 / E.zoom) : t); };
        go(e); renderTimeline(); renderInsp();
        const up = () => { sc.removeEventListener('pointermove', go); sc.removeEventListener('pointerup', up); };
        sc.addEventListener('pointermove', go); sc.addEventListener('pointerup', up); return;
      }
      const id = bar.dataset.id, f = find(id); if (!f) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { E.sel.has(id) ? E.sel.delete(id) : E.sel.add(id); renderTimeline(); renderInsp(); frame(); return; }
      if (!E.sel.has(id)) { E.sel = new Set([id]); renderInsp(); }
      if (f.tr.locked) { renderTimeline(); frame(); return; }
      const r = bar.getBoundingClientRect(), edge = e.clientX - r.left < 7 ? 'l' : r.right - e.clientX < 7 ? 'r' : 'm';
      e.preventDefault(); sc.setPointerCapture(e.pointerId);
      const before = snapshot(), t0 = tAt(e.clientX);
      const group = edge === 'm' ? selected().filter((v) => !v.tr.locked) : [f];
      const orig = new Map(group.map(({ tr, x }) => [x.id, { start: x.start, end: endOf(tr, x), in: x.in, out: x.out }]));
      const tr = f.tr, x = f.x, o = orig.get(x.id);
      const neighbours = chainNeighbours(tr, x);
      let moved = false;
      E.drag = { tl: true };
      const move = (ev) => {
        let d = snapT(tAt(ev.clientX) - t0);
        if (!moved && Math.abs(ev.clientX - e.clientX) < 3) return; moved = true;
        const thr = 8 / E.zoom;
        if (edge === 'm') {
          if (E.snap) { const s = snapTo(o.start + d, group.map((g) => g.x.id), thr), e2 = snapTo(o.end + d, group.map((g) => g.x.id), thr); d = Math.abs(s - (o.start + d)) <= Math.abs(e2 - (o.end + d)) ? s - o.start : e2 - o.end; }
          d = Math.max(d, -Math.min(...[...orig.values()].map((v) => v.start)));
          for (const g of group) { const q = orig.get(g.x.id); g.x.start = snapT(q.start + d); if (g.tr.kind === 'text') g.x.end = snapT(q.end + d); }
        } else if (edge === 'l') {
          let ns = o.start + d; if (E.snap) ns = snapTo(ns, [x.id], thr); ns = snapT(ns);
          const still = tr.kind !== 'text' && E.doc.media[x.media]?.kind === 'image'; // 그림은 원본 구간이 없어 앞으로도 늘릴 수 있다
          if (tr.kind !== 'text' && !still) ns = Math.max(ns, o.start - o.in); // 원본 앞을 넘지 않게
          ns = Math.min(ns, o.end - FR()); ns = Math.max(0, ns);
          if (still) x.out = x.in + (o.end - ns);
          else if (tr.kind !== 'text') x.in = snapT(o.in + (ns - o.start), 1e9);
          x.start = ns;
          if (E.chain && !E.ripple && neighbours.prev && tr.kind === 'text') neighbours.prev.x.end = Math.max(neighbours.prev.o.start + FR(), ns);
        } else {
          let ne = o.end + d; if (E.snap) ne = snapTo(ne, [x.id], thr); ne = snapT(ne);
          ne = Math.max(ne, o.start + FR());
          if (tr.kind !== 'text') { const m = E.doc.media[x.media]; if (m?.duration) ne = Math.min(ne, o.start + (m.duration - o.in)); }
          setEnd(tr, x, ne);
          if (E.chain && !E.ripple && neighbours.next && tr.kind === 'text') neighbours.next.x.start = Math.min(neighbours.next.o.end - FR(), ne);
        }
        renderTimeline(); frame(); renderInspLive();
      };
      const up = () => {
        sc.removeEventListener('pointermove', move); sc.removeEventListener('pointerup', up); E.drag = null;
        if (moved && E.ripple) rippleAfter(tr, x, o, edge);
        if (!commit(before)) { renderTimeline(); frame(); } else refresh();
      };
      sc.addEventListener('pointermove', move); sc.addEventListener('pointerup', up);
    });
  }
  // 자막 붙여 두기: 이 자막과 맞닿은(반 프레임 이내) 앞뒤 자막
  function chainNeighbours(tr, x) {
    if (tr.kind !== 'text') return {};
    const i = tr.items.indexOf(x), h = FR() / 2, out = {};
    const p = tr.items[i - 1], n = tr.items[i + 1];
    if (p && Math.abs(p.end - x.start) <= h) out.prev = { x: p, o: { start: p.start, end: p.end } };
    if (n && Math.abs(n.start - x.end) <= h) out.next = { x: n, o: { start: n.start, end: n.end } };
    return out;
  }
  // 리플: 길이·자리가 바뀐 만큼 같은 트랙의 뒤 것을 민다
  // 앞을 자르면(프리미어 리플 트림): 이 막대 자리는 그대로 두고 줄어든 만큼 뒤 것을 당긴다. 뒤를 자르면 바뀐 만큼 뒤 것을 민다
  function rippleAfter(tr, x, o, edge) {
    let shift = 0;
    if (edge === 'l') { const d = x.start - o.start; if (!d) return; x.start = o.start; if (tr.kind === 'text') x.end = snapT(o.end - d); shift = -d; }
    else if (edge === 'r') shift = endOf(tr, x) - o.end;
    if (!shift) return;
    for (const y of tr.items || tr.clips) if (y !== x && y.start >= o.end - 1e-6) { y.start = snapT(Math.max(0, y.start + shift)); if (tr.kind === 'text') y.end = snapT(y.end + shift); }
  }
  /** 자석: 가까운 붙을 곳(재생 헤드·다른 막대 가장자리·마커·0) */
  function snapTo(t, skipIds, thr) {
    let best = t, bd = thr;
    const tryT = (v) => { const dd = Math.abs(v - t); if (dd < bd) { bd = dd; best = v; } };
    tryT(E.t); tryT(0);
    for (const m of E.doc.markers) tryT(m.t);
    for (const tr of E.doc.tracks) for (const y of tr.items || tr.clips) if (!skipIds || !skipIds.includes(y.id)) { tryT(y.start); tryT(endOf(tr, y)); }
    return best;
  }

  /* ---------- 편집 동작 ---------- */
  function splitAt() {
    const t = snapT(E.t);
    const targets = (E.sel.size ? selected() : items()).filter(({ tr, x }) => !tr.locked && t > x.start + FR() / 2 && t < endOf(tr, x) - FR() / 2);
    if (!targets.length) return toast('재생 헤드 아래에 자를 것이 없어요');
    edit(() => {
      for (const { tr, x } of targets) {
        const y = JSON.parse(JSON.stringify(x)); y.id = V.uid(tr.kind === 'text' ? 'x' : 'c');
        const cut = t - x.start;
        if (tr.kind === 'text') { y.start = t; x.end = t; } else { y.start = t; y.in = x.in + cut; x.out = x.in + cut; }
        // 키프레임은 시각에 맞게 나눈다
        for (const [p, ks] of Object.entries(x.keys || {})) { y.keys[p] = ks.filter((k) => k.t >= cut).map((k) => ({ ...k, t: k.t - cut })); x.keys[p] = ks.filter((k) => k.t < cut); if (!y.keys[p].length) delete y.keys[p]; if (!x.keys[p].length) delete x.keys[p]; }
        (tr.items || tr.clips).push(y);
      }
    });
    toast(`${targets.length}개를 잘랐어요`);
  }
  function deleteSel(ripple) {
    const s = selected().filter((v) => !v.tr.locked); if (!s.length) return;
    edit(() => {
      for (const { tr, x } of s) {
        const list = tr.items || tr.clips, i = list.indexOf(x); if (i < 0) continue;
        list.splice(i, 1);
        if (ripple) { const len = endOf(tr, x) - x.start; for (const y of list) if (y.start >= x.start) { y.start = snapT(y.start - len); if (tr.kind === 'text') y.end = snapT(y.end - len); } }
      }
      E.sel.clear();
    });
  }
  function nudge(frames) {
    const s = selected().filter((v) => !v.tr.locked); if (!s.length) return seek(E.t + frames * FR());
    edit(() => { for (const { tr, x } of s) { const d = Math.max(-x.start, frames * FR()); x.start = snapT(x.start + d); if (tr.kind === 'text') x.end = snapT(x.end + d); } });
  }
  function setEdge(which, rippleKey = false) {
    const ripple = rippleKey || E.ripple;
    const s = selected().filter((v) => !v.tr.locked); if (!s.length) return toast('먼저 자막이나 클립을 고르세요');
    const t = snapT(E.t);
    edit(() => {
      for (const { tr, x } of s) {
        const o = { start: x.start, end: endOf(tr, x), in: x.in }, nb = chainNeighbours(tr, x);
        if (which === 'start') {
          if (t >= o.end) continue;
          if (tr.kind !== 'text' && E.doc.media[x.media]?.kind === 'image') { x.out = x.in + (o.end - t); x.start = t; }
          else if (tr.kind !== 'text') { const ns = Math.max(t, o.start - o.in); x.in = o.in + (ns - o.start); x.start = ns; } else x.start = t;
          if (E.chain && !ripple && nb.prev) nb.prev.x.end = Math.max(nb.prev.o.start + FR(), x.start);
          if (ripple) rippleAfter(tr, x, o, 'l');
        } else {
          if (t <= o.start) continue;
          setEnd(tr, x, t);
          if (E.chain && !ripple && nb.next) nb.next.x.start = Math.min(nb.next.o.end - FR(), t);
          if (ripple) rippleAfter(tr, x, o, 'r');
        }
      }
    });
  }
  function addMarker() { edit((d) => { d.markers.push({ id: V.uid('k'), t: snapT(E.t), label: '' }); }); }
  function addText() {
    let tr = selected().find((v) => v.tr.kind === 'text')?.tr || E.doc.tracks.find((t) => t.kind === 'text' && !t.locked);
    edit((d) => {
      if (!tr) { tr = { id: V.uid('t'), kind: 'text', name: '자막', style: Object.keys(d.styles)[0] || null, items: [], muted: false, hidden: false, locked: false }; d.tracks.push(tr); }
      const t = snapT(E.t), nx = tr.items.find((y) => y.start > t), end = Math.min(nx ? nx.start : t + 2, t + 2);
      const it = { id: V.uid('x'), start: t, end: Math.max(end, t + FR() * 6), text: '새 글자', style: null, override: {}, x: 0, y: Math.round(E.doc.height * 0.36), scale: 1, rotation: 0, opacity: 1, anim: { in: 'none', out: 'none', inDur: 0.2, outDur: 0.15 }, keys: {} };
      tr.items.push(it); E.sel = new Set([it.id]);
    });
    setTimeout(() => { const ta = $v('.ve-insp [data-f="text"]'); ta?.focus(); ta?.select(); }, 30);
  }
  function snapOnset() {
    const s = selected().filter((v) => v.tr.kind === 'text'); if (!s.length) return toast('자막을 고르세요');
    let n = 0;
    edit(() => { for (const { tr, x } of s) { const t = speechOnset(x.start); if (t != null && t < x.end - FR() && Math.abs(t - x.start) > FR() / 2) { const nb = chainNeighbours(tr, x); x.start = t; if (E.chain && nb.prev) nb.prev.x.end = t; n++; } } });
    toast(n ? `${n}개를 발화 시작에 맞췄어요` : '맞출 곳을 찾지 못했어요(파형이 아직 없거나 이미 맞음)');
  }

  /* ---------- 자막 점검 ---------- */
  function checks() {
    const out = { gaps: [], overlaps: [], long: [], fonts: [] };
    const h = FR() / 2;
    for (const tr of E.doc.tracks) if (tr.kind === 'text') {
      for (let i = 1; i < tr.items.length; i++) {
        const a = tr.items[i - 1], b = tr.items[i], g = b.start - a.end;
        if (g > h && g < 1.0) out.gaps.push({ tr, a, b, g });
        else if (g < -h) out.overlaps.push({ tr, a, b, g });
      }
      for (const it of tr.items) {
        const s = V.styleOf(E.doc, tr, it);
        if (!s.oneLine) continue;
        const c = checks.ctx || (checks.ctx = document.createElement('canvas').getContext('2d'));
        c.font = `${s.italic ? 'italic ' : ''}${s.weight} ${s.size}px "${s.font}", "Pretendard Variable", sans-serif`;
        const w = Math.max(...it.text.split('\n').map((l) => c.measureText(l).width + l.length * s.letterSpacing)) * it.scale + (s.stroke ? s.stroke.width * 2 : 0) + (s.bg ? s.bg.padX * 2 : 0);
        if (w > E.doc.width * 0.94) out.long.push({ tr, it, w });
      }
    }
    for (const f of V.fontsOf(E.doc)) if (!V.fontAvailable(f)) out.fonts.push(f);
    return out;
  }

  /* ---------- 속성 패널 ---------- */
  const FONTS = [{ family: 'Noto Sans KR' }, { family: 'Malgun Gothic', ko: '맑은 고딕' }]; // 엔진이 이 PC 글꼴 목록을 주면 바꾼다(api/fonts)
  const num = (k, v, { step = 1, unit = '', key = false, x = null, min = null, max = null } = {}) => `<label class="ve-f"><span class="ve-fl" data-scrub="${k}" data-step="${step}" title="좌우로 끌어 바꾸기">${esc(LABEL[k] || k)}${unit ? ` <small>${unit}</small>` : ''}</span><input type="number" data-f="${k}" value="${Math.round(v * 1000) / 1000}" step="${step}"${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}>${key ? `<button type="button" class="ve-kb${x && keyAt(x, k) ? ' on' : ''}${x?.keys?.[k]?.length ? ' has' : ''}" data-key="${k}" title="키프레임 넣기/빼기 (재생 헤드)">${icon('diamond')}</button><button type="button" class="ve-kn" data-kn="${k}:-1" title="이전 키">‹</button><button type="button" class="ve-kn" data-kn="${k}:1" title="다음 키">›</button>` : ''}</label>`;
  const LABEL = { x: '가로 위치', y: '세로 위치', scale: '크기', rotation: '회전', opacity: '불투명도', size: '글자 크기', weight: '두께', letterSpacing: '자간', lineHeight: '행간', maxWidth: '최대 너비', strokeWidth: '테두리 두께', shX: '그림자 X', shY: '그림자 Y', shBlur: '그림자 흐림', padX: '배경 가로 여백', padY: '배경 세로 여백', radius: '배경 둥글기', volume: '음량', fadeIn: '소리 들어오기', fadeOut: '소리 나가기', inDur: '등장 길이', outDur: '퇴장 길이', gAngle: '그라디언트 각도' };
  function renderInsp() {
    const el = $v('.ve-insp'); if (!el) return;
    const s = selected();
    if (!s.length) { el.innerHTML = docPanel(); return; }
    const kinds = new Set(s.map((v) => v.tr.kind));
    if (s.length > 1) { el.innerHTML = `<h4>${s.length}개 고름</h4><p class="c-muted">함께 옮기기(끌기·, . 밀기)·지우기·자르기·[ ] 가 같이 돼요.</p>${kinds.size === 1 && kinds.has('text') ? `${styleBlock(s[0].tr, s[0].x, true)}${animBlock(s[0].x)}<p class="c-muted">스타일·등장 효과는 고른 자막 모두에 적용돼요.</p>` : ''}`; return; }
    const { tr, x } = s[0];
    el.innerHTML = tr.kind === 'text' ? textPanel(tr, x) : clipPanel(tr, x);
  }
  // 재생 중·끄는 중: 숫자만 고친다(포커스·입력 유지)
  function renderInspLive() {
    const s = selected(); if (s.length !== 1) return;
    const { x } = s[0], lt = E.t - x.start;
    for (const p of V.PROPS) {
      const inp = $v(`.ve-insp input[data-f="${p}"]`); if (!inp || document.activeElement === inp) continue;
      const v = V.valueAt(x[p], x.keys?.[p], lt); inp.value = Math.round(v * 1000) / 1000;
      const kb = $v(`.ve-insp [data-key="${p}"]`); if (kb) kb.classList.toggle('on', !!keyAt(x, p));
    }
    const ez = $v('.ve-insp .ve-ease'); if (ez) ez.outerHTML = easeBlock(x);
    for (const k of ['start', 'end']) { const inp = $v(`.ve-insp input[data-tc="${k}"]`); if (inp && document.activeElement !== inp) inp.value = tc(k === 'start' ? x.start : endOf(s[0].tr, x)); }
  }
  function timeBlock(tr, x) {
    const e = endOf(tr, x);
    return `<div class="ve-sec"><h5>시간</h5><div class="ve-row2"><label class="ve-f"><span class="ve-fl">시작</span><input data-tc="start" value="${tc(x.start)}"></label><label class="ve-f"><span class="ve-fl">끝</span><input data-tc="end" value="${tc(e)}"></label></div>
      <div class="ve-acts"><button type="button" class="btn sm" data-act="edge:start" title="시작을 재생 헤드로 ([)">[ 시작을 여기로</button><button type="button" class="btn sm" data-act="edge:end" title="끝을 재생 헤드로 (])">끝을 여기로 ]</button>${tr.kind === 'text' ? '<button type="button" class="btn sm" data-act="onset" title="파형에서 가까운 발화 시작을 찾아 시작을 맞춰요">발화 시작에 맞추기</button>' : ''}</div>
      <small class="c-muted">길이 ${Math.round((e - x.start) * E.doc.fps)}프레임 (${(e - x.start).toFixed(2)}초)</small></div>`;
  }
  function transformBlock(x, video = false) {
    return `<div class="ve-sec"><h5>위치·크기·움직임 <small class="c-muted">◆ = 재생 헤드에 키프레임</small></h5>${V.PROPS.filter((p) => !(video && p === 'opacity')).map((p) => num(p, V.valueAt(x[p], x.keys?.[p], E.t - x.start), { step: p === 'scale' ? 0.01 : p === 'opacity' ? 0.05 : 1, unit: p === 'rotation' ? '°' : p === 'scale' ? '배' : p === 'opacity' ? '' : 'px', key: true, x })).join('')}
      ${video ? num('opacity', x.opacity, { step: 0.05 }) : ''}${easeBlock(x)}
      <div class="ve-acts">${video ? '<button type="button" class="btn sm" data-act="punch" title="재생 헤드에서 6프레임 동안 1.15배로 쫀득하게 확대">펀치 인</button><button type="button" class="btn sm" data-act="punchout" title="재생 헤드에서 원래 크기로">펀치 아웃</button>' : ''}<button type="button" class="btn sm" data-act="center" title="가운데로">가운데</button><button type="button" class="btn sm" data-act="clearkeys" title="이 레이어의 키프레임 모두 지우기">키 모두 지우기</button></div></div>`;
  }
  function easeBlock(x) {
    const ks = V.PROPS.map((p) => keyAt(x, p)).filter(Boolean);
    if (!ks.length) return '<div class="ve-ease"></div>';
    const cur = ks[0].ease;
    return `<div class="ve-ease"><span class="ve-fl">이 키 다음 움직임</span><div class="ve-chips">${Object.entries(V.EASE_KO).map(([k, l]) => `<button type="button" class="ve-chip${cur === k ? ' on' : ''}" data-ease="${k}">${l}</button>`).join('')}</div></div>`;
  }
  function animBlock(x) {
    const sel = (k) => `<select data-f="anim.${k}">${V.ANIM.map((a) => `<option value="${a}"${x.anim?.[k] === a ? ' selected' : ''}>${V.ANIM_KO[a]}</option>`).join('')}</select>`;
    return `<div class="ve-sec"><h5>등장·퇴장</h5><div class="ve-row2"><label class="ve-f"><span class="ve-fl">등장</span>${sel('in')}</label><label class="ve-f"><span class="ve-fl">퇴장</span>${sel('out')}</label></div>
      <div class="ve-row2">${num('inDur', Math.round((x.anim?.inDur ?? 0.2) * E.doc.fps), { step: 1, unit: 'f' })}${num('outDur', Math.round((x.anim?.outDur ?? 0.15) * E.doc.fps), { step: 1, unit: 'f' })}</div></div>`;
  }
  function styleBlock(tr, x, multi = false) {
    const s = V.styleOf(E.doc, tr, x), name = x.style || tr.style;
    const scope = E.styleScope || 'style';
    const styles = Object.keys(E.doc.styles);
    const color = (k, v, label) => `<label class="ve-f"><span class="ve-fl">${label}</span><input type="color" data-f="${k}" value="${hex6(v)}"><input class="ve-hex" data-f="${k}" value="${esc(v || '')}" spellcheck="false"></label>`;
    return `<div class="ve-sec"><h5>글자 모양</h5>
      <div class="ve-row2"><label class="ve-f"><span class="ve-fl">스타일(역할)</span><select data-f="style"><option value="">트랙 스타일(${esc(tr.style || '없음')})</option>${styles.map((n) => `<option value="${esc(n)}"${x.style === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value="__new">+ 새 스타일…</option></select></label></div>
      <div class="ve-seg"><button type="button" class="${scope === 'style' ? 'on' : ''}" data-scope="style" ${name ? '' : 'disabled'}>스타일 "${esc(name || '-')}" 전체에</button><button type="button" class="${scope === 'item' ? 'on' : ''}" data-scope="item">${multi ? '고른 자막만' : '이 자막만'}</button></div>
      ${!V.fontAvailable(s.font) ? `<p class="ve-warn">${icon('alert')}이 PC에 "${esc(s.font)}" 글꼴이 없어 다른 글꼴로 보여요(렌더도 같음)</p>` : ''}
      <label class="ve-f"><span class="ve-fl">글꼴</span><input data-f="font" list="veFonts" value="${esc(s.font)}" spellcheck="false"></label><datalist id="veFonts">${(E.fonts || FONTS).map((f) => `<option value="${esc(f.family)}"${f.ko ? ` label="${esc(f.ko)}"` : ''}>`).join('')}</datalist>
      <div class="ve-row2">${num('size', s.size, { step: 1, unit: 'px', min: 4 })}<label class="ve-f"><span class="ve-fl">두께</span><select data-f="weight">${[300, 400, 500, 600, 700, 800, 900].map((w) => `<option${s.weight == w ? ' selected' : ''}>${w}</option>`).join('')}</select></label></div>
      ${color('color', s.color, '글자색')}
      <label class="ve-chk"><input type="checkbox" data-f="gOn"${s.gradient ? ' checked' : ''}>그라디언트</label>
      ${s.gradient ? `<div class="ve-row2">${color('gFrom', s.gradient.from, '시작색')}${color('gTo', s.gradient.to, '끝색')}</div>${num('gAngle', s.gradient.angle, { step: 5, unit: '°' })}` : ''}
      <div class="ve-row2">${color('strokeColor', s.stroke?.color || '#000000', '테두리색')}${num('strokeWidth', s.stroke?.width || 0, { step: 1, unit: 'px', min: 0 })}</div>
      <div class="ve-row2">${color('shColor', s.shadow?.color || '#00000099', '그림자색')}${num('shBlur', s.shadow?.blur || 0, { step: 1, unit: 'px', min: 0 })}</div>
      <div class="ve-row2">${num('shX', s.shadow?.x || 0, { step: 1, unit: 'px' })}${num('shY', s.shadow?.y || 0, { step: 1, unit: 'px' })}</div>
      <label class="ve-chk"><input type="checkbox" data-f="bgOn"${s.bg ? ' checked' : ''}>배경 상자</label>
      ${s.bg ? `${color('bgColor', s.bg.color, '배경색')}<div class="ve-row2">${num('padX', s.bg.padX, { unit: 'px' })}${num('padY', s.bg.padY, { unit: 'px' })}</div>${num('radius', s.bg.radius, { unit: 'px', min: 0 })}` : ''}
      <div class="ve-row2">${num('letterSpacing', s.letterSpacing, { step: 0.5, unit: 'px' })}${num('lineHeight', s.lineHeight, { step: 0.05 })}</div>
      <div class="ve-row2"><label class="ve-f"><span class="ve-fl">정렬</span><select data-f="align">${['left', 'center', 'right'].map((a) => `<option value="${a}"${s.align === a ? ' selected' : ''}>${{ left: '왼쪽', center: '가운데', right: '오른쪽' }[a]}</option>`).join('')}</select></label><label class="ve-chk"><input type="checkbox" data-f="oneLine"${s.oneLine ? ' checked' : ''}>한 줄 고정</label></div>
      ${s.oneLine ? '' : num('maxWidth', s.maxWidth, { unit: 'px', min: 40 })}
      ${multi ? '' : `<div class="ve-acts"><button type="button" class="btn sm" data-act="copystyle">스타일 복사</button><button type="button" class="btn sm" data-act="pastestyle" ${E.clipStyle ? '' : 'disabled'}>붙여넣기</button></div>`}</div>`;
  }
  function textPanel(tr, x) {
    return `<h4>${icon('type')}${esc(tr.name)} <small class="c-muted">${esc(x.id)}</small></h4>
      <div class="ve-sec"><textarea data-f="text" rows="2" spellcheck="false">${esc(x.text)}</textarea></div>
      ${timeBlock(tr, x)}${styleBlock(tr, x)}${animBlock(x)}${transformBlock(x)}`;
  }
  function clipPanel(tr, x) {
    const m = E.doc.media[x.media] || {};
    const kindKo = { image: '그림', html: 'HTML 장면' }[m.kind] || (m.width > 0 ? '영상' : '소리');
    const sound = m.kind === 'video' && m.audio !== false;
    return `<h4>${icon(m.kind === 'image' ? 'image' : m.kind === 'html' ? 'code' : tr.kind === 'video' ? 'film' : 'sound')}${esc(m.name || m.path || x.media)}</h4>
      <p class="c-muted ve-src" title="${esc(m.path || '')}">${kindKo}${m.kind === 'image' ? ` · ${m.width}×${m.height}` : ` · 원본 ${tc(x.in)} ~ ${tc(x.out)} · 원본 길이 ${tc(m.duration || 0)}`}${tr.kind === 'audio' && m.width > 0 ? ' · 소리 트랙이라 소리만 써요' : ''}</p>
      ${m.kind === 'html' ? `<div class="ve-acts"><button type="button" class="btn sm" data-act="scenereload" title="장면 파일을 고쳤으면 다시 읽기">장면 다시 읽기</button>${STUDIO.desktop?.openPath && !STUDIO.remote ? '<button type="button" class="btn sm" data-act="sceneopen" title="장면 HTML 을 기본 프로그램으로 열기">장면 파일 열기</button>' : ''}</div>` : ''}
      ${timeBlock(tr, x)}
      ${sound ? `<div class="ve-sec"><h5>소리</h5><div class="ve-row2">${num('volume', x.volume, { step: 0.5, unit: 'dB', min: -60, max: 24 })}</div><div class="ve-row2">${num('fadeIn', Math.round(x.fadeIn * E.doc.fps), { unit: 'f', min: 0 })}${num('fadeOut', Math.round(x.fadeOut * E.doc.fps), { unit: 'f', min: 0 })}</div><small class="c-muted">${tr.kind === 'video' && tr.muted ? '이 영상 트랙은 소리를 꺼 뒀어요(트랙 M) · ' : ''}말끝이 뚝 끊기면 나가기 2~3프레임</small></div>` : ''}
      ${tr.kind === 'video' ? `<div class="ve-sec"><h5>화면 맞춤</h5><div class="ve-seg"><button type="button" class="${x.fit === 'cover' ? 'on' : ''}" data-fit="cover">꽉 채우기</button><button type="button" class="${x.fit === 'contain' ? 'on' : ''}" data-fit="contain">다 보이게</button><button type="button" class="${x.fit === 'none' ? 'on' : ''}" data-fit="none" title="원본 픽셀 크기 그대로(로고·스티커)">원래 크기</button></div></div>${transformBlock(x, true)}` : ''}`;
  }
  function docPanel() {
    const c = checks();
    const row = (label, list, act) => list.length ? `<div class="ve-chk-row"><b>${label} ${list.length}</b>${act}<div class="ve-chk-list">${list.slice(0, 30).map((v) => `<button type="button" class="ve-chk-it" data-goto="${v.b ? v.b.id : v.it.id}">${tc(v.b ? v.b.start : v.it.start)} · ${esc((v.b ? v.b.text : v.it.text).slice(0, 24))}${v.g != null ? ` · ${Math.round(Math.abs(v.g) * E.doc.fps)}f` : ''}</button>`).join('')}</div></div>` : '';
    return `<h4>${icon('film')}편집 전체</h4>
      <label class="ve-f"><span class="ve-fl">제목</span><input data-doc="title" value="${esc(E.doc.title)}"></label>
      <div class="ve-row2"><label class="ve-f"><span class="ve-fl">화면</span><input value="${E.doc.width}×${E.doc.height}" disabled></label><label class="ve-f"><span class="ve-fl">fps</span><input value="${E.doc.fps}" disabled></label></div>
      <label class="ve-f"><span class="ve-fl">배경색</span><input type="color" data-doc="background" value="${hex6(E.doc.background)}"></label>
      <div class="ve-sec"><h5>자막 점검</h5>
        ${!c.gaps.length && !c.overlaps.length && !c.long.length && !c.fonts.length ? `<p class="ve-ok">${icon('check')}빈칸·겹침·한 줄 넘침·없는 글꼴 없음</p>` : ''}
        ${c.fonts.length ? `<p class="ve-warn">${icon('alert')}이 PC에 없는 글꼴: ${c.fonts.map(esc).join(', ')}</p><div class="ve-acts"><button type="button" class="btn sm" data-act="fontsfix" title="사용자 글꼴 폴더에 파일은 있는데 등록이 풀린 글꼴이면 등록해요">글꼴 찾아 설치</button><button type="button" class="btn sm" data-act="fontsfile" title="글꼴 파일(.ttf·.otf)을 골라 설치">파일로 설치…</button></div>` : ''}
        ${row('자막 사이 빈칸', c.gaps, '<button type="button" class="btn sm" data-act="closegaps" title="1초 미만 빈칸을 앞 자막 끝을 늘려 붙여요">모두 붙이기</button>')}
        ${row('겹침', c.overlaps, '<button type="button" class="btn sm" data-act="fixoverlaps" title="앞 자막 끝을 뒤 자막 시작으로">모두 고치기</button>')}
        ${row('한 줄 넘침', c.long, '')}</div>
      <div class="ve-sec"><h5>단축키</h5><p class="c-muted ve-keys">Space 재생 · ←→ 1프레임(Shift 10) · S 자르기 · [ ] 시작/끝을 재생 헤드로 · Q W 리플로 · , . 고른 것 1프레임 밀기 · Delete 지우기(Shift 빈칸 닫기) · T 글자 · M 마커 · Ctrl+Z/Y · Ctrl+휠 확대</p></div>`;
  }
  const hex6 = (c) => { const m = String(c || '').match(/^#([0-9a-f]{6})/i) || String(c || '').match(/^#([0-9a-f]{3})$/i); if (!m) return '#000000'; return m[1].length === 3 ? `#${m[1].split('').map((q) => q + q).join('')}` : `#${m[1]}`; };
  function bindInsp() {
    const el = $v('.ve-insp');
    // 스타일 값 쓰기: "스타일 전체에" 면 doc.styles[name], 아니면 자막의 override
    const styleTarget = (tr, x) => { const name = x.style || tr.style; if ((E.styleScope || 'style') === 'style' && name) return (E.doc.styles[name] ||= {}); return (x.override ||= {}); };
    const STYLE_KEYS = { font: 'font', size: 'size', weight: 'weight', color: 'color', letterSpacing: 'letterSpacing', lineHeight: 'lineHeight', align: 'align', oneLine: 'oneLine', maxWidth: 'maxWidth' };
    function applyField(k, raw, checked) {
      const s = selected(); if (!s.length) return;
      const v = Number(raw);
      edit(() => {
        for (const { tr, x } of s) {
          if (k === 'text') { x.text = raw; continue; }
          if (V.PROPS.includes(k)) { if (Number.isFinite(v)) setProp(x, k, k === 'opacity' ? V.clamp(v, 0, 1) : v); continue; }
          if (k === 'volume') { x.volume = V.clamp(v, -60, 24); continue; }
          if (k === 'fadeIn' || k === 'fadeOut') { x[k] = Math.max(0, v) / E.doc.fps; continue; }
          if (k === 'anim.in' || k === 'anim.out') { x.anim[k.slice(5)] = raw; continue; }
          if (k === 'inDur' || k === 'outDur') { x.anim[k] = Math.max(0, v) / E.doc.fps; continue; }
          if (k === 'style') { if (raw === '__new') { const n = prompt('새 스타일 이름(역할: 해설·발화·강조 등)'); if (!n) return; E.doc.styles[n] = JSON.parse(JSON.stringify(V.styleOf(E.doc, tr, x))); x.style = n; x.override = {}; } else x.style = raw || null; continue; }
          if (tr.kind !== 'text') continue;
          const st = styleTarget(tr, x), cur = V.styleOf(E.doc, tr, x);
          if (STYLE_KEYS[k]) st[k] = k === 'oneLine' ? checked : ['size', 'weight', 'letterSpacing', 'lineHeight', 'maxWidth'].includes(k) ? v : raw;
          else if (k === 'gOn') st.gradient = checked ? { from: cur.color, to: '#ffd400', angle: 180 } : null;
          else if (k === 'gFrom' || k === 'gTo' || k === 'gAngle') st.gradient = { ...(cur.gradient || { from: cur.color, to: '#ffd400', angle: 180 }), [k === 'gFrom' ? 'from' : k === 'gTo' ? 'to' : 'angle']: k === 'gAngle' ? v : raw };
          else if (k === 'strokeColor' || k === 'strokeWidth') st.stroke = { ...(cur.stroke || { color: '#000000', width: 0 }), [k === 'strokeColor' ? 'color' : 'width']: k === 'strokeWidth' ? Math.max(0, v) : raw };
          else if (['shColor', 'shBlur', 'shX', 'shY'].includes(k)) st.shadow = { ...(cur.shadow || { x: 0, y: 0, blur: 0, color: '#00000099' }), [{ shColor: 'color', shBlur: 'blur', shX: 'x', shY: 'y' }[k]]: k === 'shColor' ? raw : v };
          else if (k === 'bgOn') st.bg = checked ? { color: '#000000b3', padX: 18, padY: 8, radius: 10 } : null;
          else if (['bgColor', 'padX', 'padY', 'radius'].includes(k)) st.bg = { ...(cur.bg || { color: '#000000b3', padX: 18, padY: 8, radius: 10 }), [{ bgColor: 'color', padX: 'padX', padY: 'padY', radius: 'radius' }[k]]: k === 'bgColor' ? raw : v };
        }
      }, { keepInsp: ['text', 'size', 'letterSpacing', 'lineHeight', 'maxWidth', 'strokeWidth', 'shBlur', 'shX', 'shY', 'padX', 'padY', 'radius', 'gAngle', 'font', ...V.PROPS, 'volume', 'fadeIn', 'fadeOut', 'inDur', 'outDur'].includes(k) || /Color$|^color$|^g(From|To)$/.test(k) });
    }
    el.addEventListener('input', (e) => {
      const f = e.target.dataset.f; if (!f) return;
      if (V.PROPS.includes(f)) setTimeout(renderInspLive, 0);
      if (e.target.type === 'number' && e.target.value === '') return;
      if (e.target.classList.contains('ve-hex')) { if (!/^#([0-9a-f]{3,8})$/i.test(e.target.value)) return; }
      if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') return; // change 에서
      applyField(f, e.target.value);
    });
    el.addEventListener('change', (e) => {
      const f = e.target.dataset.f, d = e.target.dataset.doc, tcK = e.target.dataset.tc;
      if (f && (e.target.type === 'checkbox' || e.target.tagName === 'SELECT')) { applyField(f, e.target.value, e.target.checked); renderInsp(); }
      if (d) edit((doc) => { doc[d] = e.target.value; });
      if (tcK) {
        const s = selected(); if (s.length !== 1) return;
        const t = parseTc(e.target.value); if (t == null) { renderInsp(); return toast('시간은 분:초:프레임(00:12:15) 또는 초(12.5)로 적어 주세요', true); }
        const { tr, x } = s[0];
        edit(() => { if (tcK === 'start') { if (t < endOf(tr, x)) { if (tr.kind !== 'text') x.in = Math.max(0, x.in + (t - x.start)); x.start = t; } } else if (t > x.start) setEnd(tr, x, t); });
      }
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const s = selected(), one = s.length === 1 ? s[0] : null;
      if (b.dataset.key && one) return edit(() => toggleKey(one.x, b.dataset.key));
      if (b.dataset.kn && one) { const [p, dir] = b.dataset.kn.split(':'); const ks = one.x.keys?.[p] || []; const lt = E.t - one.x.start; const k = Number(dir) > 0 ? ks.find((q) => q.t > lt + 1e-4) : [...ks].reverse().find((q) => q.t < lt - 1e-4); if (k) seek(one.x.start + k.t); return; }
      if (b.dataset.ease && one) return edit(() => { for (const p of V.PROPS) { const k = keyAt(one.x, p); if (k) k.ease = b.dataset.ease; } });
      if (b.dataset.scope) { E.styleScope = b.dataset.scope; return renderInsp(); }
      if (b.dataset.fit && one) return edit(() => { one.x.fit = b.dataset.fit; });
      if (b.dataset.goto) { const f = find(b.dataset.goto); if (f) { E.sel = new Set([f.x.id]); seek(f.x.start); refresh(); scrollTo(f.x.start); } return; }
      const act = b.dataset.act; if (!act) return;
      if (act === 'edge:start') return setEdge('start');
      if (act === 'edge:end') return setEdge('end');
      if (act === 'onset') return snapOnset();
      if (act === 'fontsfix') {
        const want = new Set(checks().fonts.map((f) => String(f).toLowerCase()));
        const list = await api('api/fonts/installable').catch(() => []);
        const files = list.filter((x) => x.families.some((f) => want.has(f.toLowerCase()) || (x.ko && want.has(x.ko.toLowerCase())))).map((x) => x.file);
        return files.length ? installFonts(files) : toast('이 PC에서 그 글꼴 파일을 찾지 못했어요 — "파일로 설치…"로 글꼴 파일을 골라 주세요', true);
      }
      if (act === 'fontsfile') { const f = await pickPath({ title: '설치할 글꼴 파일', kinds: ['font'], multi: true, start: dirOf(E.path), confirm: '설치' }); if (f?.length) installFonts(f); return; }
      if (act === 'scenereload' && one) { for (const el of POOL.get(mediaAbs(one.x.media)) || []) { el._ready = false; try { el.contentWindow.location.reload(); } catch { el.src = el.src; } } return toast('장면을 다시 읽어요'); }
      if (act === 'sceneopen' && one) return STUDIO.desktop?.openPath(mediaAbs(one.x.media));
      if (act === 'center' && one) return edit(() => { setProp(one.x, 'x', 0); setProp(one.x, 'y', 0); });
      if (act === 'clearkeys' && one) return edit(() => { for (const p of Object.keys(one.x.keys || {})) { one.x[p] = V.valueAt(one.x[p], one.x.keys[p], E.t - one.x.start); } one.x.keys = {}; });
      if (act === 'punch' && one) return edit(() => { const x = one.x, lt = Math.max(0, snapT(E.t - x.start)), ks = (x.keys ||= {}).scale ||= []; const v0 = V.valueAt(x.scale, ks, lt); ks.push({ t: lt, v: v0, ease: 'snap' }, { t: lt + 6 * FR(), v: Math.round(v0 * 1.15 * 1000) / 1000, ease: 'hold' }); ks.sort((a, b) => a.t - b.t); });
      if (act === 'punchout' && one) return edit(() => { const x = one.x, lt = Math.max(0, snapT(E.t - x.start)), ks = (x.keys ||= {}).scale ||= []; const v0 = V.valueAt(x.scale, ks, lt); ks.push({ t: lt, v: v0, ease: 'expo' }, { t: lt + 6 * FR(), v: 1, ease: 'hold' }); ks.sort((a, b) => a.t - b.t); });
      if (act === 'copystyle' && one) { E.clipStyle = JSON.parse(JSON.stringify(V.styleOf(E.doc, one.tr, one.x))); toast('스타일을 복사했어요'); return renderInsp(); }
      if (act === 'pastestyle' && E.clipStyle) return edit(() => { for (const { x } of s) x.override = JSON.parse(JSON.stringify(E.clipStyle)); });
      if (act === 'closegaps') return edit(() => { for (const g of checks().gaps) g.a.end = g.b.start; });
      if (act === 'fixoverlaps') return edit(() => { for (const g of checks().overlaps) g.a.end = Math.max(g.a.start + FR(), g.b.start); });
    });
    // 숫자 이름을 좌우로 끌어 값 바꾸기(프리미어처럼)
    el.addEventListener('pointerdown', (e) => {
      const l = e.target.closest('[data-scrub]'); if (!l) return;
      const inp = l.parentElement.querySelector('input[type=number]'); if (!inp) return;
      e.preventDefault(); l.setPointerCapture(e.pointerId);
      const x0 = e.clientX, v0 = Number(inp.value) || 0, step = Number(l.dataset.step) || 1, before = snapshot();
      E.drag = { insp: true };
      const move = (ev) => { const v = Math.round((v0 + (ev.clientX - x0) * step * (ev.shiftKey ? 10 : 1)) * 1000) / 1000; inp.value = v; applyLive(l.dataset.scrub, v); };
      const up = () => { l.removeEventListener('pointermove', move); l.removeEventListener('pointerup', up); E.drag = null; if (commit(before)) { E.inspHold = true; refresh(); E.inspHold = false; } };
      l.addEventListener('pointermove', move); l.addEventListener('pointerup', up);
    });
    function applyLive(k, v) { // 끄는 동안: 되돌리기 기록 없이 바로 보이게
      const s = selected(); for (const { x } of s) { if (V.PROPS.includes(k)) setProp(x, k, v); else if (k === 'volume') x.volume = v; }
      if (!V.PROPS.includes(k) && k !== 'volume') { const inp = el.querySelector(`input[data-f="${k}"]`); if (inp) applyField(k, String(v)); return; }
      frame(); drawLanes();
    }
  }
  function parseTc(s) {
    s = String(s).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return snapT(Number(s));
    const m = s.match(/^(?:(\d+):)?(\d+):(\d+)$/); if (!m) return null;
    const mm = Number(m[1] || 0), ss = Number(m[2]), ff = Number(m[3]);
    return snapT(mm * 60 + ss + ff / Math.round(E.doc.fps));
  }
  function scrollTo(t) { const sc = $v('.ve-scroll'); sc.scrollLeft = Math.max(0, t * E.zoom - (sc.clientWidth - HEAD) * 0.3); drawLanes(); }

  /* ---------- 키보드 ---------- */
  function onKey(e) {
    if (!E.open) return;
    const tag = e.target.tagName, typing = /INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable;
    if (!E.el.contains(e.target) && e.target !== document.body) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && (k === 'z' || k === 'Z')) { if (typing && tag !== 'SELECT') return; e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && (k === 'y' || k === 'Y')) { if (typing) return; e.preventDefault(); return redo(); }
    if (mod && (k === 's' || k === 'S')) { e.preventDefault(); clearTimeout(E.saveT); return save(); }
    if (typing) { if (k === 'Escape') e.target.blur(); return; }
    const fr = e.shiftKey ? 10 : 1;
    const map = {
      ' ': () => toggle(), ArrowLeft: () => (e.altKey ? nudge(-fr) : seek(E.t - fr * FR())), ArrowRight: () => (e.altKey ? nudge(fr) : seek(E.t + fr * FR())),
      Home: () => seek(0), End: () => seek(dur()), s: () => splitAt(), S: () => splitAt(), Delete: () => deleteSel(e.shiftKey), Backspace: () => deleteSel(e.shiftKey),
      '[': () => setEdge('start'), ']': () => setEdge('end'), q: () => setEdge('start', true), w: () => setEdge('end', true),
      ',': () => nudge(-fr), '.': () => nudge(fr), '<': () => nudge(-10), '>': () => nudge(10), m: () => addMarker(), t: () => addText(),
      '+': () => setZoom(E.zoom * 1.5), '=': () => setZoom(E.zoom * 1.5), '-': () => setZoom(E.zoom / 1.5), l: () => play(), k: () => pause(),
      j: () => seek(E.t - 1), Escape: () => { if (!$v('.ve-ai').hidden) { $v('.ve-ai').hidden = true; return; } if (E.sel.size) { E.sel.clear(); refresh(); } else close(); },
    };
    const fn = map[k] || map[k.toLowerCase?.()];
    if (fn && !mod) { e.preventDefault(); e.stopPropagation(); fn(); }
  }

  /* ---------- 원본 패널 (2026-10-10 사용자 "원본 끌어 넣기") ---------- */
  // 왼쪽 패널: 이 편집에 쓴 원본 · 폴더 둘러보기(편집 파일 폴더에서 시작). 줄을 타임라인·화면으로 끌거나 + 로 재생 헤드에 넣는다.
  // SRT 는 자막 트랙으로, 글꼴 파일은 설치, 다른 편집 파일은 열기. 올리기(원격·폰)는 편집 폴더로 복사한 뒤 넣는다.
  const BIN_KEY = 'oddin.studio.bin';
  function binOpen() { try { const v = localStorage.getItem(BIN_KEY); return v == null ? window.innerWidth >= 1100 : v === '1'; } catch { return window.innerWidth >= 1100; } }
  function setBinOpen(on) { try { localStorage.setItem(BIN_KEY, on ? '1' : '0'); } catch {} const b = $v('.ve-bin'); if (b) b.hidden = !on; renderTop(); layoutStage(); if (on) renderBin(); }
  const PATH_TYPE = 'application/x-oddin-path';
  const sep = (p) => String(p).replace(/\\/g, '/');
  /** 편집 파일에 적을 원본 경로: 편집 폴더 안이면 상대, 밖이면 절대(/) — 엔진 relOrAbs 와 같은 규칙 */
  function relOrAbs(p) { const d = sep(dirOf(E.path)).replace(/\/+$/, '') + '/', f = sep(p); return f.toLowerCase().startsWith(d.toLowerCase()) ? f.slice(d.length) : f; }
  async function renderBin() {
    const el = $v('.ve-bin'); if (!el || el.hidden || !E.open) return;
    const used = Object.entries(E.doc.media);
    const list = E.binList && E.binList.path === E.binDir ? E.binList : null;
    const upTitle = STUDIO.remote || !STUDIO.desktop ? '이 기기의 파일을 편집 폴더로 올려서 재생 헤드에 넣기' : '파일을 편집 폴더로 복사해서 재생 헤드에 넣기';
    const usedRows = used.map(([id, m]) => binRow({ path: mediaAbs(id), name: m.name || m.path.split(/[\\/]/).pop(), kind: m.kind === 'video' ? (m.width > 0 ? 'video' : 'audio') : m.kind, used: id, info: m.kind === 'image' ? `${m.width}×${m.height}` : tc(m.duration || 0) })).join('');
    const dirRows = list ? (list.entries.filter((x) => x.path.toLowerCase() !== E.path.toLowerCase()).map((x) => binRow(x)).join('') || '<div class="empty-row">넣을 파일이 없어요</div>') : '<div class="empty-row">읽는 중…</div>';
    el.innerHTML = `<div class="vb-head"><b>${icon('folder')}원본</b><span class="grow"></span>
        <button type="button" class="icon-btn sm" data-b="pick" title="다른 폴더 고르기">${icon('folder')}</button>
        <label class="icon-btn sm vb-up" title="${upTitle}">${icon('upload')}<input type="file" multiple accept="video/*,audio/*,image/*,.html,.htm,.srt,.ttf,.otf" hidden></label>
        <button type="button" class="icon-btn sm" data-b="refresh" title="다시 읽기">${icon('refresh')}</button></div>
      ${used.length ? `<div class="vb-sec"><h6>이 편집에 쓴 원본 ${used.length}</h6>${usedRows}</div>` : ''}
      <div class="vb-sec vb-dir"><div class="vb-path"><button type="button" class="icon-btn sm" data-b="up" title="위 폴더" ${list?.parent ? '' : 'disabled'}>${icon('up')}</button><span title="${esc(E.binDir)}">${esc(E.binDir.split(/[\\/]/).filter(Boolean).pop() || E.binDir)}</span></div>
      <div class="vb-list">${dirRows}</div></div>
      <p class="vb-tip c-muted">줄을 타임라인이나 화면으로 끌어 넣어요. ${STUDIO.desktop ? '탐색기에서 바로 끌어 놓아도 돼요.' : '탐색기에서 끌어 놓으면 편집 폴더로 올려서 넣어요.'}</p>`;
    if (!list) {
      try { E.binList = await api(`api/list?path=${enc(E.binDir)}`); } catch (e) { E.binList = { path: E.binDir, parent: null, entries: [] }; toast(`폴더를 읽지 못했어요: ${e.message}`, true); }
      if (E.binList.path === E.binDir) renderBin();
    }
  }
  const ROW_TIP = { srt: '누르면 자막 트랙으로 넣어요', font: '누르면 이 PC에 설치해요', edit: '누르면 이 편집을 열어요' };
  function binRow(x) {
    const k = x.kind, add = k !== 'dir' && k !== 'edit';
    const info = x.info || (k === 'dir' ? '' : x.size ? fmtSize(x.size) : '');
    const tip = k === 'dir' ? x.path : `${x.path}\n${ROW_TIP[k] || '끌어서 넣거나 + 를 누르세요'}`;
    const addTip = k === 'srt' ? '자막 트랙으로 넣기' : k === 'font' ? '글꼴 설치' : '재생 헤드에 넣기';
    return `<div class="vb-row k-${k}${x.used ? ' used' : ''}" data-path="${esc(x.path)}" data-kind="${k}" ${k !== 'dir' ? 'draggable="true"' : ''} title="${esc(tip)}">${icon(KIND_ICON[k] || 'file')}<span class="n">${esc(x.name)}</span><small>${esc(info)}</small>${add ? `<button type="button" class="vb-add" data-add title="${addTip}">${icon('plus')}</button>` : ''}</div>`;
  }
  function bindBin() {
    const el = $v('.ve-bin'); if (!el) return;
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-b]');
      if (b) {
        if (b.dataset.b === 'refresh') { E.binList = null; return renderBin(); }
        if (b.dataset.b === 'up' && E.binList?.parent) { E.binDir = E.binList.parent; E.binList = null; return renderBin(); }
        if (b.dataset.b === 'pick') { const d = await pickPath({ title: '원본 폴더 고르기', mode: 'dir', start: E.binDir, confirm: '이 폴더 보기' }); if (d) { E.binDir = d; E.binList = null; renderBin(); } return; }
      }
      const row = e.target.closest('.vb-row'); if (!row) return;
      const k = row.dataset.kind, p = row.dataset.path;
      if (k === 'dir') { E.binDir = p; E.binList = null; return renderBin(); }
      if (k === 'edit') return open(p);
      if (e.target.closest('[data-add]') || k === 'srt' || k === 'font') return addPaths([p], { at: E.t });
      // 이 편집에 쓴 원본: 그 원본을 쓰는 클립을 고르고 처음으로
      const id = Object.keys(E.doc.media).find((m) => mediaAbs(m).toLowerCase() === p.toLowerCase());
      if (id) { const clips = items().filter(({ tr, x }) => tr.kind !== 'text' && x.media === id); if (clips.length) { E.sel = new Set(clips.map((c) => c.x.id)); seek(clips[0].x.start); refresh(); scrollTo(clips[0].x.start); } }
    });
    el.addEventListener('dblclick', (e) => { const row = e.target.closest('.vb-row'); if (row && !['dir', 'edit', 'srt', 'font'].includes(row.dataset.kind)) addPaths([row.dataset.path], { at: E.t }); });
    el.addEventListener('dragstart', (e) => { const row = e.target.closest('.vb-row'); if (!row || row.dataset.kind === 'dir') return; e.dataTransfer.setData(PATH_TYPE, JSON.stringify([row.dataset.path])); e.dataTransfer.setData('text/plain', row.dataset.path); e.dataTransfer.effectAllowed = 'copy'; });
    el.addEventListener('change', async (e) => {
      const inp = e.target.closest('input[type=file]'); if (!inp || !inp.files.length) return;
      const files = [...inp.files]; inp.value = '';
      await dropFiles(files.map((f) => ({ file: f, forceUpload: true })), { at: E.t });
    });
  }

  /* ---------- 끌어 놓기 ---------- */
  function dragKind(e) { const t = [...(e.dataTransfer?.types || [])]; return t.includes(PATH_TYPE) ? 'path' : t.includes('Files') ? 'files' : null; }
  function laneAt(e) {
    const lane = e.target.closest?.('.ve-lane'); if (!lane) return null;
    const sc = $v('.ve-scroll'), r = sc.getBoundingClientRect();
    let t = Math.max(0, (e.clientX - r.left - HEAD + sc.scrollLeft) / E.zoom); if (E.snap) t = snapTo(t, null, 8 / E.zoom);
    return { trackId: lane.dataset.track, at: snapT(t), lane };
  }
  function bindDrop() {
    const el = E.el; let mark = null, depth = 0;
    const clear = () => { el.querySelectorAll('.ve-lane.drop-on').forEach((x) => x.classList.remove('drop-on')); mark?.remove(); mark = null; const d = $v('.ve-drop'); if (d) d.hidden = true; };
    el.addEventListener('dragenter', (e) => { if (dragKind(e)) depth++; });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; clear(); } });
    el.addEventListener('dragover', (e) => {
      const kind = dragKind(e); if (!kind) return;
      const lane = laneAt(e), inView = e.target.closest('.ve-view, .ve-bin');
      if (!lane && !inView) { e.dataTransfer.dropEffect = 'none'; return; }
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      el.querySelectorAll('.ve-lane.drop-on').forEach((x) => { if (x !== lane?.lane) x.classList.remove('drop-on'); });
      if (lane) {
        lane.lane.classList.add('drop-on'); $v('.ve-drop').hidden = true;
        if (!mark) { mark = document.createElement('i'); mark.className = 've-dropmark'; $v('.ve-grid').appendChild(mark); }
        mark.style.left = `${HEAD + lane.at * E.zoom}px`; mark.dataset.t = tc(lane.at);
      } else { mark?.remove(); mark = null; if (e.target.closest('.ve-view')) $v('.ve-drop').hidden = false; }
    });
    el.addEventListener('drop', async (e) => {
      const kind = dragKind(e); if (!kind) return;
      e.preventDefault(); e.stopPropagation(); depth = 0;
      const lane = laneAt(e), opts = lane ? { at: lane.at, trackId: lane.trackId } : { at: E.t };
      clear();
      if (kind === 'path') { let ps = []; try { ps = JSON.parse(e.dataTransfer.getData(PATH_TYPE)); } catch {} return addPaths(ps, opts); }
      return dropFiles([...e.dataTransfer.files].map((f) => ({ file: f })), opts);
    });
  }
  // 편집기 밖에 놓쳐도 브라우저가 파일을 열어 버리지 않게
  window.addEventListener('dragover', (e) => { if (E.open && dragKind(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (E.open && dragKind(e)) e.preventDefault(); });
  /** 탐색기에서 온 파일: 프로그램 창(이 PC)이면 실제 경로, 아니면 편집 폴더로 올린 뒤 그 경로 */
  async function dropFiles(list, opts) {
    const paths = [];
    for (const it of list) {
      const real = !it.forceUpload && !STUDIO.remote ? STUDIO.desktop?.pathForFile?.(it.file) : null;
      if (real) { paths.push(real); continue; }
      try { paths.push(await upload(it.file)); } catch (e) { toast(`${it.file.name}: ${e.message}`, true); }
    }
    if (paths.length) await addPaths(paths, opts);
  }
  async function upload(file) {
    const dir = dirOf(E.path); toast(`올리는 중: ${file.name} (${fmtSize(file.size)})`);
    const r = await fetch(`api/upload?dir=${enc(dir)}&name=${enc(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `올리지 못했어요(${r.status})`);
    E.binList = null; return j.path;
  }
  const MEDIA_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mts|m2ts|wmv|mxf|mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff|png|jpe?g|webp|gif|bmp|tiff?|html?)$/i;
  /** 경로들을 넣는다: 영상·소리·그림·장면은 차례로 이어서(되돌리기 한 번), SRT 는 자막 트랙, 글꼴은 설치, 편집 파일은 열기 */
  async function addPaths(paths, { at = E.t, trackId = null } = {}) {
    const media = [], name = (p) => p.split(/[\\/]/).pop();
    for (const p of paths) {
      if (/\.oddin-edit\.json$/i.test(p)) return open(p);
      if (/\.srt$/i.test(p)) {
        try {
          const text = await fetch(fileUrl(p)).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.text(); });
          const nm = name(p).replace(/\.srt$/i, ''); let res = null;
          edit((d) => { res = V.srtTrack(d, text, nm); });
          toast(`자막 ${res?.count || 0}개를 "${nm}" 트랙으로 넣었어요`);
        } catch (e) { toast(`SRT 를 읽지 못했어요: ${e.message}`, true); }
        continue;
      }
      if (/\.(ttf|otf|ttc)$/i.test(p)) { await installFonts([p]); continue; }
      if (!MEDIA_RE.test(p)) { toast(`넣을 수 없는 파일이에요: ${name(p)}`, true); continue; }
      try { media.push({ p, info: await api(`api/probe?path=${enc(p)}`) }); } catch (e) { toast(`${name(p)}: ${e.message}`, true); }
    }
    if (!media.length) return;
    const placed = [];
    edit((d) => {
      let t = at;
      for (const { p, info } of media) {
        const r = V.placeMedia(d, info, { path: relOrAbs(p), name: name(p), at: t, trackId });
        const tr = d.tracks.find((x) => x.id === r.track), c = tr.clips.find((x) => x.id === r.clip);
        placed.push(r.clip); t = V.clipEnd(c);
      }
    });
    E.sel = new Set(placed); loadAssets(); refresh(); renderBin();
    toast(media.length === 1 ? `넣었어요: ${name(media[0].p)}` : `${media.length}개를 차례로 넣었어요`);
  }
  async function installFonts(files) {
    try {
      const r = await api('api/fonts/install', { method: 'POST', body: JSON.stringify(files ? { files } : { all: true }) });
      E.fonts = await api('api/fonts').catch(() => E.fonts);
      const msg = r.installed.length ? `글꼴 ${r.installed.length}개를 설치했어요${STUDIO.desktop ? '' : ' — 미리보기에 바로 안 보이면 창을 새로 고치세요'}` : (r.skipped[0]?.reason || '설치할 글꼴이 없어요');
      toast(msg, !r.installed.length && !!r.skipped.length);
      renderInsp();
    } catch (e) { toast(`글꼴을 설치하지 못했어요: ${e.message}`, true); }
  }

  /* ---------- 여는 곳 ---------- */
  // 시험·자동화용: 화면 단추와 같은 동작을 코드로(마우스 없이)
  const select = (ids) => { E.sel = new Set([].concat(ids || [])); refresh(); };
  window.studioEditor = { open, create, close, state: () => E, cmd: { select, seek, play, pause, splitAt, deleteSel, nudge, setEdge, snapOnset, addMarker, addText, undo, redo, save, addPaths, toggleKey: (id, p) => { const f = find(id); if (f) edit(() => toggleKey(f.x, p)); }, setProp: (id, p, v) => { const f = find(id); if (f) edit(() => setProp(f.x, p, v)); }, checks, speechOnset, installFonts } };
  // 엔진이 "이 파일을 열어 달라"고 하면(명령줄 open·ODDIN 경로 메뉴) 이 창에서 연다
  STUDIO.on((ev) => {
    if (ev.type === 'open' && ev.path) { if (/\.oddin-edit\.json$/i.test(ev.path)) open(ev.path); else create(ev.path); try { STUDIO.desktop?.focus?.(); } catch {} }
    if (ev.type === 'fonts' && E.open) api('api/fonts').then((l) => { E.fonts = l; renderInsp(); }).catch(() => {});
  });
  window.addEventListener('popstate', () => { const p = new URLSearchParams(location.search).get('path'); if (p && p !== E.path) open(p); else if (!p && E.open) close(true); });
})();
