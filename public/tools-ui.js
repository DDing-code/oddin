/* AI Hub — 터미널 · 파일 보기 · 미리보기 (담당: Fable)
   app.js·side.js·remote.js 다음에 읽힌다. 서버 규약은 lib/terminal.mjs·files.mjs·preview.mjs (docs/tools.md).
   연결 지점만 쓴다: window.hubTabs(오른쪽 패널 탭), 'hub:event'(실시간), window.hubCommands(검색 팔레트),
   window.openPath 감싸기(경로 링크: 원격이면 허브 안 보기 창, 이 PC에서는 오른쪽 클릭 › 허브에서 보기).
   - 터미널: 대화 아래에서 올라오는 패널 (Ctrl+`). 세션마다 여러 개, 셸 선택, ANSI 색, 중지, 종료 코드, 버퍼 이어 보기
   - 파일 보기: 코드(줄 번호·가벼운 강조)·마크다운(렌더/원문)·이미지·영상·소리·PDF·폴더 탐색
   - 미리보기: 개발 서버 창 (이 PC: http://localhost:<포트> 직접 · 원격: 허브의 /preview/<포트>/ 프록시)
   시험용: window.hubTools = { toggleTerminal, newTerminal, viewPath, openPreview } */
'use strict';
(() => {
  /* ================= 아이콘 ================= */
  Object.assign(IC, {
    terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
    browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/>',
    folderOpen: '<path d="M4 10V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v2"/><path d="M2.5 10h19l-2.5 9H5z"/>',
    fileCode: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    download: '<path d="M12 3v12M6 11l6 6 6-6"/><path d="M4 21h16"/>',
    max: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3M21 16v3a2 2 0 0 1-2 2h-3"/>',
    min: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    wrap: '<path d="M3 6h18M3 12h13a3 3 0 0 1 0 6h-3M3 18h6"/><path d="m11 16-2 2 2 2"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    jump: '<path d="M12 5v14M5 12l7 7 7-7"/>',
    eraser: '<path d="m7 21-4-4 11-11 4 4z"/><path d="m14 6 4 4M3 21h18"/>',
    play: '<path d="m6 4 14 8-14 8z"/>',
  });
  if (!IC.globe) IC.globe = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>';

  /* ================= 공용 ================= */
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const remote = () => (typeof isRemoteView === 'function' ? isRemoteView() : false);
  // 결과 페이지 보기 주소(서버 lib/files.mjs 의 serveView): 폴더 구조 그대로라 페이지 안 상대 경로도 이어진다
  const isPage = (p) => /\.html?$/i.test(String(p || '').trim());
  const pageUrl = (p) => '/view/' + String(p).trim().replace(/&amp;/g, '&').replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  const openPage = (p) => window.open(pageUrl(p), '_blank', 'noopener');
  const fmtSize = (n) => (!Number.isFinite(n) ? '' : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1073741824).toFixed(2)}GB`);
  const fmtMs = (ms) => (ms < 1000 ? `${Math.max(0, ms | 0)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${(ms / 60000) | 0}분 ${((ms % 60000) / 1000) | 0}초`);
  const fmtWhen = (iso) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return d.toDateString() === new Date().toDateString() ? `오늘 ${hm(iso)}` : d.toLocaleString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
  const dirName = (p) => { const s = String(p || '').replace(/[\\/]+$/, ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i < 0 ? '' : i <= 2 ? s.slice(0, 3) : s.slice(0, i); };
  const extOf = (p) => { const n = baseName(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const store = { get() { try { return JSON.parse(localStorage.getItem('hub.tools') || '{}'); } catch { return {}; } }, set(p) { try { localStorage.setItem('hub.tools', JSON.stringify(p)); } catch {} } };
  const P = { open: false, h: 280, max: false, shell: 'powershell', wrap: false, ...store.get() };
  const saveP = () => store.set(P);
  const SHELLS = { powershell: { label: 'PowerShell', desc: '기본 · Windows PowerShell' }, cmd: { label: 'cmd', desc: '명령 프롬프트' }, bash: { label: 'Git Bash', desc: 'Git이 설치돼 있을 때' } };
  const MEDIA = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image', mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', avi: 'video', mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', pdf: 'pdf' };
  const UI = { lastTarget: null, dialog: null };
  window.addEventListener('click', (e) => { UI.lastTarget = e.target; }, true);
  const inspShowing = (key) => typeof inspOpen === 'function' && inspOpen() && S.insp?.tab === key;
  let inspT = 0; const repaintInsp = (key) => { if (!inspShowing(key)) return; clearTimeout(inspT); inspT = setTimeout(() => { if (inspShowing(key)) renderInspector(); }, 120); };

  /* ================= ANSI → HTML ================= */
  const URL_RE = /https?:\/\/[^\s<>"'`\x00-\x1f]+/g;
  const LOCAL_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?=[/?#]|$)/i;
  function linkify(s) {
    let out = '', last = 0;
    for (const m of s.matchAll(URL_RE)) {
      let u = m[0], trail = '';
      while (/[.,;:!?)\]'"]$/.test(u)) { trail = u.slice(-1) + trail; u = u.slice(0, -1); }
      out += esc(s.slice(last, m.index));
      out += LOCAL_URL.test(u) ? `<a class="tlink" href="${esc(u)}" data-pv-url="${esc(u)}" title="미리보기로 열기">${esc(u)}</a>` : `<a class="tlink" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`;
      out += esc(trail); last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }
  const sgrNew = () => ({ fg: null, bg: null, b: 0, d: 0, i: 0, u: 0, inv: 0, s: 0 });
  const CUBE = [0, 95, 135, 175, 215, 255];
  function color256(n) { if (n < 16) return { c: n }; if (n >= 232) { const v = 8 + (n - 232) * 10; return { rgb: `${v},${v},${v}` }; } n -= 16; return { rgb: `${CUBE[(n / 36) | 0]},${CUBE[((n / 6) | 0) % 6]},${CUBE[n % 6]}` }; }
  function applySgr(params, st) {
    const p = params === '' ? [0] : params.split(';').map((x) => (x === '' ? 0 : Number(x)));
    for (let k = 0; k < p.length; k++) {
      const n = p[k];
      if (n === 0) Object.assign(st, sgrNew());
      else if (n === 1) st.b = 1; else if (n === 2) st.d = 1; else if (n === 3) st.i = 1; else if (n === 4) st.u = 1; else if (n === 7) st.inv = 1; else if (n === 9) st.s = 1;
      else if (n === 22) { st.b = 0; st.d = 0; } else if (n === 23) st.i = 0; else if (n === 24) st.u = 0; else if (n === 27) st.inv = 0; else if (n === 29) st.s = 0;
      else if (n >= 30 && n <= 37) st.fg = { c: n - 30 }; else if (n >= 90 && n <= 97) st.fg = { c: n - 82 }; else if (n === 39) st.fg = null;
      else if (n >= 40 && n <= 47) st.bg = { c: n - 40 }; else if (n >= 100 && n <= 107) st.bg = { c: n - 92 }; else if (n === 49) st.bg = null;
      else if (n === 38 || n === 48) {
        let col = null;
        if (p[k + 1] === 5) { col = color256(Math.max(0, Math.min(255, p[k + 2] | 0))); k += 2; }
        else if (p[k + 1] === 2) { col = { rgb: `${p[k + 2] & 255},${p[k + 3] & 255},${p[k + 4] & 255}` }; k += 4; }
        if (n === 38) st.fg = col; else st.bg = col;
      }
    }
  }
  // CSI(색·커서 이동)·OSC(제목·링크)·그 밖의 제어 문자. 색(m)만 반영하고 나머지는 지운다
  const ESC_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()#%][0-9A-Za-z]|\x1b[=>78DEHMNOZc]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
  function sgrSpan(s, st) {
    const inner = linkify(s);
    let fg = st.fg, bg = st.bg;
    if (st.inv) { const t = fg; fg = bg || { c: 'bg' }; bg = t || { c: 'fg' }; }
    const cls = [], sty = [];
    if (fg) { if (fg.rgb) sty.push(`color:rgb(${fg.rgb})`); else cls.push(`f${fg.c}`); }
    if (bg) { if (bg.rgb) sty.push(`background:rgb(${bg.rgb})`); else cls.push(`b${bg.c}`); }
    if (st.b) cls.push('bd'); if (st.d) cls.push('dm'); if (st.i) cls.push('it'); if (st.u) cls.push('ul'); if (st.s) cls.push('sk');
    if (!cls.length && !sty.length) return inner;
    return `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${sty.length ? ` style="${sty.join(';')}"` : ''}>${inner}</span>`;
  }
  const sgrOnly = (text, st) => { for (const m of text.matchAll(ESC_RE)) { const e = m[0]; if (e[1] === '[' && e.endsWith('m')) applySgr(e.slice(2, -1), st); } };
  /** 개행 없는 한 줄을 HTML로. st(SGR 상태)는 줄을 지나며 갱신된다. \r 는 마지막 복귀 뒤 내용만 남긴다(진행 표시줄) */
  function ansiLine(text, st) {
    text = text.replace(/\r+$/, '');
    const parts = text.split('\r');
    for (let i = 0; i < parts.length - 1; i++) sgrOnly(parts[i], st);
    text = parts[parts.length - 1];
    let out = '', last = 0;
    for (const m of text.matchAll(ESC_RE)) {
      if (m.index > last) out += sgrSpan(text.slice(last, m.index), st);
      last = m.index + m[0].length;
      const e = m[0]; if (e[1] === '[' && e.endsWith('m')) applySgr(e.slice(2, -1), st);
    }
    if (last < text.length) out += sgrSpan(text.slice(last), st);
    return out;
  }

  /* ================= 터미널: 상태 ================= */
  const MAX_LINES = 5000;
  const TM = { sid: undefined, terms: new Map(), active: new Map(), listAt: new Map(), listing: null, el: null, creating: false };
  const termsOf = (sid) => [...TM.terms.values()].filter((t) => t.sessionId === sid);
  const curSid = () => S.current || null;
  function activeTerm(sid = curSid()) { if (!sid) return null; const list = termsOf(sid); if (!list.length) return null; const t = TM.terms.get(TM.active.get(sid)); return list.includes(t) ? t : list[list.length - 1]; }
  const histKey = (sid) => `hub.term.hist.${sid}`;
  const loadHist = (sid) => { try { const v = JSON.parse(localStorage.getItem(histKey(sid)) || '[]'); return Array.isArray(v) ? v.slice(-80) : []; } catch { return []; } };
  function pushHist(t, cmd) { const h = t.hist.filter((x) => x !== cmd); h.push(cmd); t.hist = h.slice(-80); try { localStorage.setItem(histKey(t.sessionId), JSON.stringify(t.hist)); } catch {} }
  function termLabel(t) {
    const same = termsOf(t.sessionId).filter((x) => x.shell === t.shell);
    return `${SHELLS[t.shell]?.label || t.shell}${same.length > 1 ? ` ${same.indexOf(t) + 1}` : ''}`;
  }
  function ensureTerm(snap) {
    let t = TM.terms.get(snap.id);
    if (!t) {
      t = { id: snap.id, sessionId: snap.sessionId, shell: snap.shell, cwd: snap.cwd, running: false, ready: false, closed: false, code: null, commandCode: null, seq: 0,
        el: null, lines: 0, tail: '', st: sgrNew(), tailHtml: '', pendingHtml: '', pendingLines: 0, raf: 0, stick: true, unseen: 0, loaded: false, loading: null, queue: [],
        hist: loadHist(snap.sessionId), hi: -1, draft: '', startedAt: 0, last: null, exitShown: false, stopping: false };
      TM.terms.set(t.id, t);
    }
    mergeState(t, snap);
    return t;
  }
  function mergeState(t, s) {
    const wasRunning = t.running;
    for (const k of ['shell', 'cwd', 'running', 'ready', 'closed', 'code', 'commandCode']) if (k in s && s[k] !== undefined) t[k] = s[k];
    if (!wasRunning && t.running) { t.startedAt = t.startedAt || Date.now(); t.last = null; }
    if (wasRunning && !t.running) {
      const ms = Date.now() - (t.startedAt || Date.now()); t.startedAt = 0; t.stopping = false;
      t.last = { code: t.commandCode, ms };
      if (t.commandCode === 130) appendMeta(t, `중지됨 · ${fmtMs(ms)}`, 'warn');
      else if (t.commandCode) appendMeta(t, `종료 코드 ${t.commandCode} · ${fmtMs(ms)}`, 'err');
    }
    if (t.closed && !t.exitShown) { t.exitShown = true; t.stopping = false; appendMeta(t, `셸이 종료됐어요${t.code != null ? ` (코드 ${t.code})` : ''}`, 'err'); }
  }
  function commitTail(t) { if (!t.tail) return; t.pendingHtml += `<div class="tl">${ansiLine(t.tail, t.st)}</div>`; t.pendingLines++; t.tail = ''; t.tailHtml = ''; }
  function appendMeta(t, text, tone = '', cmd = false) {
    commitTail(t);
    t.pendingHtml += cmd ? `<div class="tl cmd"><span class="pr">❯</span><span>${esc(text)}</span></div>` : `<div class="tl meta ${tone}">${esc(text)}</div>`;
    t.pendingLines++; scheduleFlush(t);
  }
  function feed(t, chunk, stream = 'stdout') {
    const parts = (t.tail + chunk).split('\n'); t.tail = parts.pop();
    const cls = stream === 'stderr' ? 'tl se' : 'tl'; // stderr 는 살짝 다른 색 (ANSI 색이 있으면 그 색이 우선)
    for (const line of parts) { t.pendingHtml += `<div class="${cls}">${ansiLine(line, t.st)}</div>`; t.pendingLines++; }
    t.tailHtml = t.tail ? ansiLine(t.tail, { ...t.st }) : ''; t.tailStream = stream;
    scheduleFlush(t);
  }
  // 그리기는 프레임마다 한 번. 창이 숨겨져 rAF가 멈춘 동안에도 쌓이지 않게 타이머로도 받친다
  function scheduleFlush(t) { if (!t.raf && t.el) { t.raf = requestAnimationFrame(() => flush(t)); t.timer = setTimeout(() => flush(t), 150); } }
  function flush(t) {
    cancelAnimationFrame(t.raf); clearTimeout(t.timer); t.raf = 0; const el = t.el; if (!el) return;
    const buf = el.firstElementChild, tail = el.lastElementChild;
    if (t.pendingHtml) {
      buf.insertAdjacentHTML('beforeend', t.pendingHtml); t.lines += t.pendingLines;
      if (!t.stick) t.unseen += t.pendingLines;
      t.pendingHtml = ''; t.pendingLines = 0;
      if (t.lines > MAX_LINES) { let n = t.lines - MAX_LINES; while (n-- > 0 && buf.firstChild) buf.firstChild.remove(); t.lines = MAX_LINES; }
    }
    tail.innerHTML = t.tailHtml; tail.hidden = !t.tail; tail.classList.toggle('se', t.tailStream === 'stderr');
    if (t.stick) el.scrollTop = el.scrollHeight;
    paintJump(t);
  }
  function resetOut(t) { t.lines = 0; t.tail = ''; t.tailHtml = ''; t.pendingHtml = ''; t.pendingLines = 0; t.st = sgrNew(); t.unseen = 0; if (t.el) { t.el.firstElementChild.innerHTML = ''; t.el.lastElementChild.hidden = true; } }
  function pushChunk(t, ev) {
    if (!(ev.seq > t.seq)) return;
    if (!t.loaded) { if (t.loading) t.queue.push(ev); return; } // 아직 안 본 터미널은 열 때 버퍼로 한 번에 받는다
    t.seq = ev.seq; feed(t, ev.chunk, ev.stream);
  }
  /** 서버 버퍼(최근 2000줄)로 맞춘다. 처음이면 전체, 이미 보던 중이면 빠진 조각만 */
  function loadBuffer(t) {
    if (t.loading) return t.loading;
    t.loading = (async () => {
      try {
        const b = await api(`/api/terminals/${t.id}/buffer`);
        const fresh = !t.loaded;
        if (fresh) resetOut(t);
        const first = b.chunks.find((c) => c.seq > t.seq);
        if (!fresh && first && first.seq > t.seq + 1) appendMeta(t, '… 연결이 끊긴 사이의 출력 일부가 빠졌어요', 'warn');
        for (const c of b.chunks) if (c.seq > t.seq) { t.seq = c.seq; feed(t, c.chunk, c.stream); }
        t.loaded = true;
        mergeState(t, b.terminal);
        for (const ev of t.queue.splice(0)) pushChunk(t, ev);
        scheduleFlush(t);
      } catch (e) { if (!t.closed) appendMeta(t, `출력을 불러오지 못했어요 · ${e.message}`, 'err'); }
      finally { t.loading = null; }
    })();
    return t.loading;
  }
  async function refreshList(sid, force = false) {
    if (!sid) return;
    if (!force && Date.now() - (TM.listAt.get(sid) || 0) < 3000) return;
    TM.listAt.set(sid, Date.now());
    try {
      const list = await api(`/api/terminals?sessionId=${encodeURIComponent(sid)}`);
      const ids = new Set(list.map((x) => x.id));
      for (const snap of list) ensureTerm(snap);
      for (const t of termsOf(sid)) if (!ids.has(t.id) && !t.creating) dropTerm(t);
      if (sid === curSid()) renderDrawer();
    } catch (e) {
      if (/없는 API/.test(e.message)) { TM.unsupported = true; if (sid === curSid()) renderDrawer(); return; } // 터미널 기능이 없는 옛 서버
      if (!/찾지 못/.test(e.message)) toast(`터미널 목록을 못 읽었어요 · ${e.message}`, true);
    }
  }
  function dropTerm(t) { TM.terms.delete(t.id); t.el?.remove(); t.el = null; if (TM.active.get(t.sessionId) === t.id) TM.active.delete(t.sessionId); }

  /* ================= 터미널: 화면 ================= */
  function buildDrawer() {
    const el = document.createElement('section');
    el.id = 'term'; el.hidden = true; el.setAttribute('aria-label', '터미널');
    el.innerHTML = `<div class="term-grip" title="끌어서 높이 조절 · 두 번 눌러 원래대로"></div>
      <div class="term-bar">
        <div class="term-tabs" role="tablist" aria-label="터미널 탭"></div>
        <button type="button" class="icon-btn sm" data-t="new" title="새 터미널 (Ctrl+Shift+\`)">${icon('plus')}</button>
        <button type="button" class="icon-btn sm" data-t="shell" title="셸 고르기">${icon('down')}</button>
        <span class="grow"></span>
        <button type="button" class="icon-btn sm" data-t="clear" title="화면 지우기 (Ctrl+L)">${icon('eraser')}</button>
        <button type="button" class="icon-btn sm" data-t="max" title="크게 보기">${icon('max')}</button>
        <button type="button" class="icon-btn sm" data-t="hide" title="터미널 닫기 (Ctrl+\`)">${icon('x')}</button>
      </div>
      <div class="term-body"><div class="term-empty" hidden></div><button type="button" class="term-jump" hidden>${icon('jump')}<span></span></button></div>
      <form class="term-in" autocomplete="off">
        <span class="term-ps" title=""></span>
        <input class="term-input" spellcheck="false" autocapitalize="off" aria-label="터미널 명령" placeholder="명령 입력 · ↑↓ 이전 명령 · Ctrl+L 지우기">
        <span class="term-status" aria-live="polite"></span>
        <button type="button" class="btn danger term-stop" data-t="stop" hidden>${icon('stop')}중지</button>
      </form>`;
    $('#main').appendChild(el);
    TM.el = el;
    el.style.setProperty('--th', `${Math.max(120, P.h | 0)}px`);
    el.classList.toggle('max', !!P.max);
    const input = el.querySelector('.term-input');
    el.addEventListener('click', onDrawerClick);
    el.querySelector('.term-in').addEventListener('submit', (e) => { e.preventDefault(); submitCmd(); });
    input.addEventListener('keydown', onInputKey);
    el.querySelector('.term-tabs').addEventListener('keydown', (e) => {
      const tabs = $$('.term-tab', e.currentTarget); const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); tabs[(i + 1) % tabs.length].focus(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); tabs[(i - 1 + tabs.length) % tabs.length].focus(); }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(tabs[i].dataset.tid); }
      if (e.key === 'Delete') { e.preventDefault(); closeTerm(tabs[i].dataset.tid); }
    });
    // 높이 조절
    const grip = el.querySelector('.term-grip');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId); document.body.classList.add('resizing-y');
      const startY = e.clientY, startH = el.getBoundingClientRect().height, maxH = Math.max(160, $('#main').clientHeight - 160);
      const move = (ev) => { const h = Math.round(Math.max(120, Math.min(maxH, startH + (startY - ev.clientY)))); P.h = h; el.classList.remove('max'); P.max = false; el.style.setProperty('--th', `${h}px`); };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); document.body.classList.remove('resizing-y'); saveP(); paintMaxBtn(); scrollBottom(activeTerm()); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    });
    grip.addEventListener('dblclick', () => { P.h = 280; P.max = false; saveP(); el.classList.remove('max'); el.style.setProperty('--th', '280px'); paintMaxBtn(); });
    paintMaxBtn();
  }
  const paintMaxBtn = () => { const b = TM.el?.querySelector('[data-t="max"]'); if (b) { b.innerHTML = icon(P.max ? 'min' : 'max'); b.title = P.max ? '원래 크기' : '크게 보기'; } };
  const drawerOpen = () => !!TM.el && !TM.el.hidden;
  function openDrawer({ focus = true } = {}) {
    if (!TM.el) buildDrawer();
    TM.el.hidden = false; P.open = true; saveP();
    $('#btnTerm')?.setAttribute('aria-pressed', 'true'); $('#btnTerm')?.classList.add('on');
    renderDrawer();
    const sid = curSid(); if (sid) refreshList(sid);
    if (focus) focusTermInput();
    requestAnimationFrame(() => { const sc = $('#scroll'); if (sc) sc.scrollTop = sc.scrollHeight; scrollBottom(activeTerm()); });
  }
  function closeDrawer() {
    if (!TM.el) return;
    const had = TM.el.contains(document.activeElement);
    TM.el.hidden = true; P.open = false; saveP();
    $('#btnTerm')?.setAttribute('aria-pressed', 'false'); $('#btnTerm')?.classList.remove('on');
    if (had) $('#in')?.focus();
  }
  function toggleDrawer() { drawerOpen() ? closeDrawer() : openDrawer(); }
  function focusTermInput() { const i = TM.el?.querySelector('.term-input'); if (i && !i.disabled) i.focus(); }
  function scrollBottom(t) { if (t?.el && t.stick) t.el.scrollTop = t.el.scrollHeight; }
  function setActive(id) {
    const t = TM.terms.get(id); if (!t) return;
    TM.active.set(t.sessionId, id); renderDrawer(); focusTermInput(); repaintInsp('tools');
  }
  function paintJump(t) {
    const b = TM.el?.querySelector('.term-jump'); if (!b || t !== activeTerm()) return;
    const show = !t.stick && t.el && t.el.scrollHeight - t.el.scrollTop - t.el.clientHeight > 40;
    b.hidden = !show; if (show) b.lastElementChild.textContent = t.unseen ? `새 출력 ${t.unseen}줄` : '맨 아래로';
  }
  function ensureOut(t) {
    if (t.el) return t.el;
    const el = document.createElement('div');
    el.className = 'term-out'; el.setAttribute('role', 'log'); el.setAttribute('aria-live', 'off'); el.tabIndex = 0; el.dataset.tid = t.id;
    el.innerHTML = '<div class="tbuf"></div><div class="tl ttail" hidden></div>';
    el.addEventListener('scroll', () => { const at = el.scrollHeight - el.scrollTop - el.clientHeight < 40; if (at !== t.stick) { t.stick = at; if (at) t.unseen = 0; } else if (at) t.unseen = 0; paintJump(t); });
    el.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !String(getSelection()).length && t.running) { e.preventDefault(); interrupt(t); } });
    TM.el.querySelector('.term-body').insertBefore(el, TM.el.querySelector('.term-jump'));
    t.el = el;
    return el;
  }
  /** 탭·출력·입력줄을 현재 세션 기준으로 다시 그린다 */
  function renderDrawer() {
    if (!TM.el) return;
    const sid = curSid(); const list = sid ? termsOf(sid) : []; const act = activeTerm(sid);
    const tabs = TM.el.querySelector('.term-tabs');
    tabs.innerHTML = list.map((t) => `<div class="term-tab ${t === act ? 'on' : ''} ${t.closed ? 'dead' : ''}" role="tab" tabindex="${t === act ? 0 : -1}" aria-selected="${t === act}" data-tid="${t.id}" title="${esc(`${termLabel(t)}\n${t.cwd}${t.running ? '\n실행 중' : t.closed ? '\n종료됨' : ''}`)}">
      <span class="t-ic">${t.running ? '<span class="spin-xs"></span>' : t.closed ? icon('x') : icon('terminal')}</span><span class="t-l">${esc(termLabel(t))}</span><button type="button" class="t-x" data-close="${t.id}" title="터미널 닫기" aria-label="${esc(termLabel(t))} 닫기" tabindex="-1">${icon('x')}</button></div>`).join('');
    // 출력 영역: 터미널마다 하나씩 두고 활성만 보인다 (스크롤 위치·DOM 유지)
    for (const t of list) { ensureOut(t); t.el.hidden = t !== act; }
    for (const el of $$('.term-out', TM.el)) if (!TM.terms.has(el.dataset.tid) || TM.terms.get(el.dataset.tid).sessionId !== sid) el.hidden = true;
    if (act && !act.loaded && !act.loading) loadBuffer(act);
    if (act) { act.stick = act.stick ?? true; scrollBottom(act); }
    // 비어 있을 때
    const empty = TM.el.querySelector('.term-empty'); empty.hidden = !!act;
    if (!act && TM.unsupported) empty.innerHTML = `<div class="te-ic">${icon('alert')}</div><p>지금 실행 중인 허브 서버에는 터미널 기능이 없어요</p><small>서버를 업데이트한 뒤 다시 시작하면 여기서 터미널을 열 수 있어요 (허브 폴더에서 <span class="mono">npm run restart</span>)</small>`;
    else if (!act) {
      const cwd = typeof currentCwd === 'function' ? currentCwd() : '';
      empty.innerHTML = `<div class="te-ic">${icon('terminal')}</div><p><b>${esc(shortPath(cwd, 2) || '작업 폴더')}</b>에서 터미널을 열어요</p>
        <div class="te-shells">${Object.entries(SHELLS).map(([k, v]) => `<button type="button" class="btn ${k === P.shell ? 'primary' : ''}" data-shell="${k}">${icon('terminal')}${v.label}</button>`).join('')}</div>
        <small>${sid ? '' : '아직 세션이 없으면 이 폴더로 세션을 만들고 열어요 · '}출력은 최근 2000줄까지 서버에 남아 다시 열어도 이어서 보여요${remote() ? ' · 원격에서도 허브 PC에서 실행돼요' : ''}</small>`;
    }
    TM.el.querySelector('[data-t="clear"]').disabled = !act;
    renderInputBar(act);
    paintJump(act || {});
    paintTopBtn();
  }
  function renderInputBar(t) {
    const ps = TM.el.querySelector('.term-ps'), inp = TM.el.querySelector('.term-input'), st = TM.el.querySelector('.term-status'), stop = TM.el.querySelector('.term-stop');
    if (!t) { ps.textContent = ''; ps.title = ''; inp.disabled = true; inp.placeholder = '터미널을 먼저 열어 주세요'; st.textContent = ''; stop.hidden = true; return; }
    ps.innerHTML = `${esc(shortPath(t.cwd, 1))}<b>❯</b>`; ps.title = t.cwd;
    inp.disabled = t.closed || !t.ready;
    inp.placeholder = t.closed ? '셸이 종료됐어요 · 새 터미널을 여세요' : !t.ready ? '셸을 시작하는 중…' : t.running ? '실행 중… 끝나거나 중지하면 다음 명령을 보낼 수 있어요 (Ctrl+C 중지)' : '명령 입력 · ↑↓ 이전 명령 · Ctrl+L 지우기';
    if (t.running) { st.className = 'term-status run'; st.innerHTML = `<span class="spin-xs"></span>실행 중<span class="term-dur"> · <span class="live-dur" data-from="${new Date(t.startedAt || Date.now()).toISOString()}">0초</span></span>`; }
    else if (t.closed) { st.className = 'term-status err'; st.textContent = `종료됨${t.code != null ? ` · 코드 ${t.code}` : ''}`; }
    else if (t.last) { st.className = `term-status ${t.last.code === 0 ? 'ok' : t.last.code === 130 ? 'warn' : 'err'}`; st.innerHTML = `${t.last.code === 0 ? icon('check') : icon('alert')}종료 코드 ${t.last.code ?? '?'} · ${fmtMs(t.last.ms)}`; }
    else { st.className = 'term-status'; st.textContent = ''; }
    stop.hidden = !t.running; stop.disabled = !!t.stopping; stop.innerHTML = t.stopping ? '<span class="spin-xs"></span>중지 중' : `${icon('stop')}중지`;
  }
  function paintTopBtn() {
    const b = $('#btnTerm'); if (!b) return;
    const sid = curSid(); const n = sid ? termsOf(sid).length : 0; const run = sid && termsOf(sid).some((t) => t.running);
    b.classList.toggle('on', drawerOpen()); b.classList.toggle('busy', !!run);
    b.title = `터미널 (Ctrl+\`)${n ? ` · ${n}개 열림${run ? ' · 실행 중' : ''}` : ''}`;
  }
  async function onDrawerClick(e) {
    const sh = e.target.closest('[data-shell]'); if (sh) return newTerm(sh.dataset.shell);
    const x = e.target.closest('[data-close]'); if (x) { e.stopPropagation(); return closeTerm(x.dataset.close); }
    const tab = e.target.closest('.term-tab'); if (tab) return setActive(tab.dataset.tid);
    const jump = e.target.closest('.term-jump'); if (jump) { const t = activeTerm(); if (t?.el) { t.stick = true; t.unseen = 0; t.el.scrollTop = t.el.scrollHeight; paintJump(t); } return; }
    const link = e.target.closest('a[data-pv-url]'); if (link) { e.preventDefault(); return openPreview({ url: link.dataset.pvUrl }); }
    const b = e.target.closest('[data-t]'); if (!b) return;
    const t = activeTerm();
    switch (b.dataset.t) {
      case 'new': return newTerm(P.shell);
      case 'shell': return openShellMenu(b);
      case 'clear': return clearTerm(t);
      case 'max': P.max = !P.max; saveP(); TM.el.classList.toggle('max', P.max); paintMaxBtn(); requestAnimationFrame(() => scrollBottom(activeTerm())); return;
      case 'hide': return closeDrawer();
      case 'stop': return t && interrupt(t);
    }
  }
  function openShellMenu(anchor) {
    openPop(anchor, [{ header: '새 터미널 셸' }, ...Object.entries(SHELLS).map(([k, v]) => ({ label: v.label, desc: v.desc, icon: 'terminal', checked: P.shell === k, run: () => { closePop(); P.shell = k; saveP(); newTerm(k); } }))], { kind: 'shell' });
  }
  function onInputKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const inp = e.currentTarget; const t = activeTerm(); if (!t) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!t.hist.length) return;
      // 커서가 여러 줄 입력 안에 있지 않은 단일 줄 입력이므로 바로 이전·다음 명령
      e.preventDefault();
      if (t.hi === -1) t.draft = inp.value;
      if (e.key === 'ArrowUp') t.hi = Math.min(t.hi + 1, t.hist.length - 1); else t.hi = Math.max(t.hi - 1, -1);
      inp.value = t.hi === -1 ? t.draft : t.hist[t.hist.length - 1 - t.hi];
      requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && inp.selectionStart === inp.selectionEnd) { if (t.running) { e.preventDefault(); interrupt(t); } return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); clearTerm(t); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = ''; t.hi = -1; return; }
    if (e.key === 'Tab') { e.preventDefault(); const s = inp.selectionStart; inp.setRangeText('\t', s, inp.selectionEnd, 'end'); }
  }
  async function submitCmd() {
    const t = activeTerm(); const inp = TM.el.querySelector('.term-input'); const text = inp.value;
    if (!t || !text.trim()) return;
    if (t.closed) return toast('이 셸은 종료됐어요. 새 터미널을 여세요', true);
    if (t.running || t.stopping) return toast('실행 중인 명령이 끝나거나 중지한 뒤 보낼 수 있어요');
    appendMeta(t, text, '', true); pushHist(t, text);
    inp.value = ''; t.hi = -1; t.draft = '';
    t.running = true; t.startedAt = Date.now(); t.last = null; t.stick = true; renderInputBar(t); renderDrawer();
    try { mergeState(t, await api(`/api/terminals/${t.id}/input`, { method: 'POST', body: JSON.stringify({ text }) })); }
    catch (e) { t.running = false; t.startedAt = 0; appendMeta(t, e.message, 'err'); }
    renderDrawer();
  }
  async function interrupt(t) {
    if (!t || !t.running || t.stopping) return;
    t.stopping = true; renderInputBar(t); repaintInsp('tools');
    try { mergeState(t, await api(`/api/terminals/${t.id}/interrupt`, { method: 'POST', body: '{}' })); }
    catch (e) { toast(e.message, true); }
    finally { t.stopping = false; renderDrawer(); }
  }
  function clearTerm(t) { if (!t) return; resetOut(t); t.stick = true; paintJump(t); focusTermInput(); }
  async function newTerm(shell = P.shell) {
    if (TM.creating) return;
    TM.creating = true;
    try {
      let sid = curSid();
      if (!sid) {
        const cwd = typeof currentCwd === 'function' ? currentCwd() : '';
        const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) });
        S.sessions.set(s.id, s); await openSession(s.id); sid = s.id;
        toast(`${shortPath(cwd, 2)} 에 세션을 만들고 터미널을 열어요`);
      }
      openDrawer({ focus: false });
      const snap = await api('/api/terminals', { method: 'POST', body: JSON.stringify({ sessionId: sid, shell }) });
      const t = ensureTerm(snap); P.shell = shell; saveP();
      TM.active.set(sid, t.id); renderDrawer(); if (!t.loaded && !t.loading) loadBuffer(t);
      focusTermInput(); repaintInsp('tools');
    } catch (e) { toast(e.message, true); renderDrawer(); }
    finally { TM.creating = false; }
  }
  async function closeTerm(id) {
    const t = TM.terms.get(id); if (!t) return;
    if (t.running && !confirm('실행 중인 명령도 함께 종료돼요. 이 터미널을 닫을까요?')) return;
    const sid = t.sessionId; const list = termsOf(sid); const i = list.indexOf(t);
    try { await api(`/api/terminals/${id}`, { method: 'DELETE' }); } catch (e) { if (!/찾지 못/.test(e.message)) return toast(e.message, true); }
    dropTerm(t);
    const rest = termsOf(sid); if (rest.length) TM.active.set(sid, (rest[i] || rest[i - 1] || rest[rest.length - 1]).id);
    renderDrawer(); repaintInsp('tools'); if (rest.length) focusTermInput();
  }
  function onTermEvent(ev) {
    if (ev.type === 'term') { const t = TM.terms.get(ev.id); if (t) pushChunk(t, ev); else if (ev.sessionId === curSid()) refreshList(ev.sessionId); return; }
    if (ev.type === 'term_state') {
      if (!TM.terms.has(ev.id) && ev.sessionId !== curSid()) return;
      const t = ensureTerm(ev); if (t.sessionId === curSid()) renderDrawer(); else paintTopBtn();
      repaintInsp('tools'); return;
    }
    if (ev.type === 'term_exit') { const t = TM.terms.get(ev.id); if (t) { mergeState(t, { closed: true, running: false, ready: false, code: ev.code }); renderDrawer(); repaintInsp('tools'); } }
  }

  /* ================= 파일 보기 ================= */
  const FV = { el: null, open: false, hist: [], cur: null, data: null, token: 0, mode: 'render', hidden: false, zoom: false };
  function buildFv() {
    const el = document.createElement('div');
    el.id = 'fv'; el.className = 'tw'; el.hidden = true;
    el.innerHTML = `<div class="tw-win" role="dialog" aria-modal="true" aria-label="파일 보기" tabindex="-1">
      <div class="tw-head">
        <button type="button" class="icon-btn" data-f="back" title="뒤로 (Alt+←)" aria-label="뒤로">${icon('back')}</button>
        <div class="fv-crumbs" aria-label="경로"></div>
        <span class="grow"></span>
        <div class="fv-acts"></div>
        <button type="button" class="icon-btn" data-f="close" title="닫기 (Esc)" aria-label="닫기">${icon('x')}</button>
      </div>
      <div class="tw-body fv-body"></div>
      <div class="tw-foot fv-foot"></div>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', onFvClick);
    el.addEventListener('change', (e) => { if (e.target.matches('[data-fv-hidden]')) { FV.hidden = e.target.checked; viewPath(FV.cur.path, { ...FV.cur, push: false }); } });
    el.addEventListener('keydown', onDialogKey);
    FV.el = el;
  }
  function openDialog(el) {
    if (UI.dialog && UI.dialog !== el) hideDialog(UI.dialog);
    if (S.pop) closePop();
    UI.dialog = el; el.hidden = false; $('#app').inert = true; UI.returnTo = UI.lastTarget;
  }
  function hideDialog(el) {
    el.hidden = true; if (UI.dialog === el) { UI.dialog = null; $('#app').inert = false; }
    if (el === FV.el) { FV.open = false; FV.cur = null; FV.hist = []; FV.data = null; FV.el.querySelector('.fv-body').innerHTML = ''; }
    if (el === PW.el) { PW.open = false; PW.el.querySelector('iframe').removeAttribute('src'); }
    const back = UI.returnTo; UI.returnTo = null;
    (back?.isConnected && !document.getElementById('app').inert ? back : $('#in'))?.focus?.({ preventScroll: true });
  }
  function onDialogKey(e) {
    e.stopPropagation(); // 창이 열린 동안 뒤 화면 단축키는 막는다
    const win = e.currentTarget;
    if (e.key === 'Escape') { e.preventDefault(); return hideDialog(win); }
    if (win === FV.el && e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return fvBack(); }
    if (e.key === 'Tab') {
      const f = $$('button:not([hidden]):not(:disabled), a[href], input:not(:disabled), select, textarea, [tabindex="0"]', win).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  }
  const fvQuery = (path, rel, base) => `path=${encodeURIComponent(path)}${rel ? `&rel=${encodeURIComponent(rel)}&base=${encodeURIComponent(base || '')}` : ''}`;
  /** 허브 안 보기 창에서 경로 열기 (파일·폴더·미디어). rel/base 는 보고서의 상대 경로용 */
  async function viewPath(p, { rel = '', base = '', push = true } = {}) {
    if (!FV.el) buildFv();
    const raw = String(p || '').replace(/&amp;/g, '&').trim(); if (!raw) return;
    if (!FV.open) { openDialog(FV.el); FV.open = true; FV.hist = []; FV.el.querySelector('.tw-win').focus(); }
    if (push && FV.cur && FV.cur.path !== raw) FV.hist.push(FV.cur);
    const q = fvQuery(raw, rel, base);
    FV.cur = { path: raw, rel, base, q }; FV.data = null; FV.zoom = false;
    const token = ++FV.token;
    paintFvHead(); FV.el.querySelector('.fv-body').innerHTML = '<div class="fv-skel" aria-busy="true"><i></i><i></i><i></i><i></i></div>'; FV.el.querySelector('.fv-foot').textContent = '불러오는 중…';
    const ext = extOf(raw); const looksDir = /[\\/]$/.test(raw) || !/\.[A-Za-z0-9]{1,8}$/.test(baseName(raw));
    try {
      let data;
      if (MEDIA[ext] && !looksDir) data = await loadMedia(raw, q, ext);
      else if (looksDir) data = await loadDir(q).catch((e) => (/폴더를 골라/.test(e.message) ? loadText(q) : Promise.reject(e)));
      else data = await loadText(q).catch((e) => (/파일을 골라/.test(e.message) ? loadDir(q) : Promise.reject(e)));
      if (token !== FV.token) return;
      FV.data = data; if (data.path) FV.cur.path = data.path;
      paintFvHead(); paintFvBody(); paintFvFoot();
    } catch (e) {
      if (token !== FV.token) return;
      FV.data = { kind: 'error', message: e.message }; paintFvHead(); paintFvBody(); FV.el.querySelector('.fv-foot').textContent = '';
    }
  }
  const loadText = async (q) => { const d = await api(`/api/file?${q}`); return { ...d, kind: d.kind || 'text' }; };
  const loadDir = async (q) => ({ ...(await api(`/api/files/list?${q}${FV.hidden ? '&hidden=1' : ''}`)), kind: 'dir' });
  async function loadMedia(raw, q, ext) {
    // meta=1 은 미디어도 JSON 메타로 돌려준다 (docs/tools.md). 실제 표시는 meta 없는 원래 URL
    const d = await api(`/api/file?${q}&meta=1`);
    if (!d.streaming) return { ...d, kind: d.kind || 'text' }; // 서버가 미디어로 보지 않는 파일
    return { ...d, kind: d.kind === 'pdf' ? 'pdf' : d.kind || MEDIA[ext], url: `/api/file?${q}`, path: d.path || raw, name: d.name || baseName(raw) };
  }
  function crumbsHtml(path) {
    const segs = String(path).split(/[\\/]/).filter(Boolean); if (!segs.length) return esc(path);
    const abs = (i) => (i === 0 ? `${segs[0]}\\` : segs.slice(0, i + 1).join('\\'));
    const items = segs.map((s, i) => ({ s: s.replace(/^([A-Za-z]:)$/, '$1\\'), p: abs(i), last: i === segs.length - 1 }));
    const show = items.length > 5 ? [items[0], { more: items.slice(1, -3) }, ...items.slice(-3)] : items;
    return show.map((it) => it.more ? `<button type="button" class="crumb more" data-crumbs="${esc(JSON.stringify(it.more.map((x) => [x.s, x.p])))}" title="${esc(it.more.map((x) => x.s).join(' › '))}">…</button>`
      : it.last ? `<b class="crumb cur" title="${esc(it.p)}">${esc(it.s)}</b>` : `<button type="button" class="crumb" data-fv-open="${esc(it.p)}" title="${esc(it.p)}">${esc(it.s)}</button>`).join('<span class="sep">›</span>');
  }
  function paintFvHead() {
    const d = FV.data, c = FV.cur;
    FV.el.querySelector('.fv-crumbs').innerHTML = crumbsHtml(c.path);
    FV.el.querySelector('[data-f="back"]').disabled = !FV.hist.length;
    const acts = [];
    if (d?.kind === 'text' && d.language === 'markdown' && d.content != null) acts.push(`<span class="seg2 fv-seg" role="group" aria-label="보기 방식"><button type="button" data-f="mode" data-v="render" class="${FV.mode === 'render' ? 'on' : ''}">렌더</button><button type="button" data-f="mode" data-v="raw" class="${FV.mode === 'raw' ? 'on' : ''}">원문</button></span>`);
    if (d?.kind === 'text' && d.content != null && (d.language !== 'markdown' || FV.mode === 'raw')) acts.push(`<button type="button" class="icon-btn ${P.wrap ? 'on' : ''}" data-f="wrap" title="줄바꿈" aria-pressed="${!!P.wrap}">${icon('wrap')}</button>`);
    if (d?.kind === 'text' && d.content != null) acts.push(`<button type="button" class="icon-btn" data-f="copytext" title="내용 복사">${icon('copy')}</button>`);
    if (d?.kind === 'text' && isPage(c.path)) acts.unshift(`<a class="btn sm fv-page" href="${esc(pageUrl(c.path))}" target="_blank" rel="noopener" title="새 탭에서 결과 페이지 보기 · 원격에서도">${icon('browser')}페이지로 열기</a>`);
    if (d && d.kind !== 'error' && d.kind !== 'dir' && d.kind !== 'text' && d.url) acts.push(`<a class="icon-btn" href="${esc(d.url)}" target="_blank" rel="noopener" title="원본을 새 탭에서 열기" aria-label="원본을 새 탭에서 열기">${icon('open')}</a>`);
    if (!remote()) acts.push(`<button type="button" class="icon-btn" data-f="explorer" title="${d?.kind === 'dir' ? '탐색기로 열기' : '이 PC에서 열기'}">${icon('folder')}</button>`);
    acts.push(`<button type="button" class="icon-btn" data-f="copypath" title="경로 복사">${icon('clip')}</button>`, `<button type="button" class="icon-btn" data-f="reload" title="다시 읽기">${icon('refresh')}</button>`);
    FV.el.querySelector('.fv-acts').innerHTML = acts.join('');
  }
  function paintFvFoot() {
    const d = FV.data; const f = FV.el.querySelector('.fv-foot'); if (!d) { f.textContent = ''; return; }
    const parts = [];
    if (d.kind === 'dir') parts.push('폴더', `${d.entries.length}개 항목${d.truncated ? ` (처음 ${d.limit}개)` : ''}`);
    else if (d.kind === 'text') { parts.push(fmtSize(d.size), `${String(d.encoding || '').toUpperCase() || '텍스트'}${d.bom ? ' · BOM' : ''}`, d.language, d.content != null ? `${lineCount(d.content)}줄` : ''); if (d.modifiedAt) parts.push(`수정 ${fmtWhen(d.modifiedAt)}`); }
    else if (d.kind === 'binary') { parts.push('이진 파일', fmtSize(d.size)); if (d.modifiedAt) parts.push(`수정 ${fmtWhen(d.modifiedAt)}`); }
    else parts.push({ image: '이미지', video: '영상', audio: '소리', pdf: 'PDF' }[d.kind] || d.kind, (d.contentType || '').split(';')[0], fmtSize(d.size));
    f.innerHTML = `<span class="fv-meta">${parts.filter(Boolean).map(esc).join(' <i>·</i> ')}</span><span class="grow"></span><span class="fv-path mono" title="${esc(FV.cur.path)}">${esc(FV.cur.path)}</span>`;
  }
  function paintFvBody() {
    const d = FV.data; const body = FV.el.querySelector('.fv-body'); body.className = 'tw-body fv-body'; body.scrollTop = 0;
    if (!d) return;
    if (d.kind === 'error') { body.innerHTML = notice('alert', d.message || '열 수 없어요', FV.cur.path, `${FV.hist.length ? `<button type="button" class="btn" data-f="back">${icon('back')}뒤로</button>` : ''}${remote() ? '' : `<button type="button" class="btn" data-f="explorer">${icon('folder')}탐색기에서 보기</button>`}<button type="button" class="btn" data-f="copypath">${icon('clip')}경로 복사</button>`, 'err'); return; }
    if (d.kind === 'dir') { body.innerHTML = dirHtml(d); return; }
    if (d.kind === 'binary') { body.innerHTML = notice('file', '내용을 보여 줄 수 없는 파일이에요', `${esc(d.name)} · ${fmtSize(d.size)} · 이진 데이터`, remote() ? '' : `<button type="button" class="btn" data-f="explorer">${icon('folder')}이 PC에서 열기</button>`); return; }
    if (d.kind === 'text') {
      if (d.content == null) { body.innerHTML = notice('file', d.message || '내용을 읽지 못했어요', `${esc(d.name)} · ${fmtSize(d.size)}${d.tooLarge ? ' · 1MB 넘음' : ''}`, remote() ? '' : `<button type="button" class="btn" data-f="explorer">${icon('folder')}이 PC에서 열기</button>`); return; }
      if (d.language === 'markdown' && FV.mode === 'render') { body.innerHTML = `<div class="fv-md md">${md(d.content, dirName(FV.cur.path))}</div>`; return; }
      body.innerHTML = codeHtml(d.content, d.language); if (d.message) body.insertAdjacentHTML('afterbegin', `<div class="fv-warn">${icon('alert')}<span>${esc(d.message)}</span></div>`); return;
    }
    body.classList.add('media');
    if (d.kind === 'image') body.innerHTML = `<div class="fv-media ${FV.zoom ? 'zoom' : ''}"><img src="${esc(d.url)}" alt="${esc(d.name)}" data-f="zoom" title="눌러서 ${FV.zoom ? '맞춤' : '실제 크기'}"></div>`;
    else if (d.kind === 'video') body.innerHTML = `<div class="fv-media"><video controls preload="metadata" src="${esc(d.url)}"></video></div>`;
    else if (d.kind === 'audio') body.innerHTML = `<div class="fv-media audio"><div class="fv-audio">${icon('music')}<b>${esc(d.name)}</b><audio controls preload="metadata" src="${esc(d.url)}"></audio></div></div>`;
    else if (d.kind === 'pdf') body.innerHTML = `<div class="fv-media pdf"><iframe src="${esc(d.url)}" title="${esc(d.name)}"></iframe><div class="fv-pdf-note">PDF가 안 보이면 <a href="${esc(d.url)}" target="_blank" rel="noopener">새 탭에서 열기</a>${remote() ? '' : ' 또는 이 PC에서 열기'}를 쓰세요</div></div>`;
  }
  const notice = (ic, title, sub, acts = '', tone = '') => `<div class="fv-notice ${tone}">${icon(ic)}<b>${esc(title)}</b>${sub ? `<span class="mono">${sub}</span>` : ''}${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
  const fileIcon = (name) => { const e = extOf(name); const k = MEDIA[e]; return k === 'image' ? 'image' : k === 'video' ? 'film' : k === 'audio' ? 'music' : k === 'pdf' ? 'doc' : /^(md|txt|log|csv)$/.test(e) ? 'file' : e ? 'fileCode' : 'file'; };
  function dirHtml(d) {
    const rows = d.entries.map((e) => { const dir = e.kind === 'directory'; return `<button type="button" class="fr ${dir ? 'dir' : ''} ${e.hidden ? 'hid' : ''}" data-fv-open="${esc(e.path)}" title="${esc(e.path)}">
      <span class="f-ic">${icon(dir ? 'folder' : e.kind === 'link' ? 'open' : fileIcon(e.name))}</span><span class="fn">${esc(e.name)}</span><span class="fs">${dir ? '' : e.kind === 'link' ? '링크' : fmtSize(e.size)}</span><span class="ft">${esc(fmtWhen(e.modifiedAt))}</span></button>`; }).join('');
    return `<div class="fv-dir"><div class="fv-dirh"><span>${d.entries.filter((e) => e.kind === 'directory').length}개 폴더 · ${d.entries.filter((e) => e.kind !== 'directory').length}개 파일${d.truncated ? ` · 처음 ${d.limit}개까지만 보여요` : ''}</span><label class="fv-chk"><input type="checkbox" data-fv-hidden ${FV.hidden ? 'checked' : ''}>숨김 파일</label></div>${rows || '<div class="fv-none">빈 폴더예요</div>'}</div>`;
  }
  const splitLines = (content) => { const lines = content.split('\n'); if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); return lines; };
  const lineCount = (content) => splitLines(content).length;
  function codeHtml(content, lang) {
    const lines = splitLines(content);
    const hl = HL[lang] || HL.plaintext; let h = '';
    for (let i = 0; i < lines.length; i++) { const l = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]; h += `<div class="cl"><span class="n" aria-hidden="true">${i + 1}</span><span class="c">${hl(l)}</span></div>`; }
    return `<div class="fv-code ${P.wrap ? 'wrap' : ''}" style="--w:${String(lines.length).length}ch">${h}</div>`;
  }
  async function onFvClick(e) {
    const o = e.target.closest('[data-fv-open]'); if (o) return viewPath(o.dataset.fvOpen);
    const cr = e.target.closest('[data-crumbs]'); if (cr) { const list = JSON.parse(cr.dataset.crumbs); return openPop(cr, list.map(([s, p]) => ({ label: s, desc: p, icon: 'folder', run: () => { closePop(); viewPath(p); } })), { below: true }); }
    const b = e.target.closest('[data-f]'); if (!b) { if (e.target === FV.el) hideDialog(FV.el); return; }
    const d = FV.data, c = FV.cur;
    switch (b.dataset.f) {
      case 'close': return hideDialog(FV.el);
      case 'back': return fvBack();
      case 'reload': return viewPath(c.path, { ...c, push: false });
      case 'mode': FV.mode = b.dataset.v; paintFvHead(); paintFvBody(); return;
      case 'wrap': P.wrap = !P.wrap; saveP(); paintFvHead(); paintFvBody(); return;
      case 'zoom': FV.zoom = !FV.zoom; paintFvBody(); return;
      case 'copypath': return copyText(c.path, '경로를 복사했어요');
      case 'copytext': return d?.content != null && copyText(d.content, '내용을 복사했어요');
      case 'explorer': return baseOpenPath(c.path, 'auto', c.rel, c.base);
    }
  }
  function fvBack() { const prev = FV.hist.pop(); if (prev) viewPath(prev.path, { ...prev, push: false }); }

  /* ---------- 가벼운 문법 강조 (줄 단위) ---------- */
  const R = String.raw;
  const S_DQ = R`"(?:[^"\\]|\\.)*"?`, S_SQ = R`'(?:[^'\\]|\\.)*'?`, S_BT = R`\x60(?:[^\x60\\]|\\.)*\x60?`;
  const NUM = R`\b0x[0-9a-fA-F]+\b|\b\d[\w.]*`, WORD = R`[A-Za-z_$][\w$]*`;
  function mkHl(parts, kw = '', ci = false) {
    const re = new RegExp(parts.map(([, s]) => `(${s})`).join('|'), ci ? 'gi' : 'g');
    const kws = new Set(kw.split(/\s+/).filter(Boolean).map((k) => (ci ? k.toLowerCase() : k)));
    return (line) => {
      if (!line) return '';
      let out = '', last = 0, m; re.lastIndex = 0;
      while ((m = re.exec(line))) {
        if (!m[0]) { re.lastIndex++; continue; }
        if (m.index > last) out += esc(line.slice(last, m.index));
        let cls = ''; for (let i = 1; i < m.length; i++) if (m[i] !== undefined) { cls = parts[i - 1][0]; break; }
        if (cls === 'w') cls = kws.has(ci ? m[0].toLowerCase() : m[0]) ? 'hk' : '';
        out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
        last = m.index + m[0].length;
      }
      return out + esc(line.slice(last));
    };
  }
  const KW_JS = 'const let var function return if else for while do break continue new delete typeof instanceof in of class extends super this import export from default async await yield try catch finally throw switch case static get set null undefined true false void with debugger interface type enum implements declare namespace public private protected readonly abstract as keyof infer never unknown any string number boolean';
  const KW_C = 'int char float double void long short unsigned signed struct union enum typedef return if else for while do break continue switch case default sizeof static const extern volatile goto include define ifdef ifndef endif pragma using namespace class public private protected virtual override new delete this nullptr true false bool auto template typename var val fn let mut pub mod impl trait match loop ref move async await where crate self Self dyn package import func range chan go defer select map nil string int64 float64 byte error interface';
  const cLike = (kw) => mkHl([['hc', R`/\*.*?\*/|/\*.*$|//.*$`], ['hs', `${S_DQ}|${S_SQ}|${S_BT}`], ['hn', NUM], ['w', WORD]], kw);
  const HL = {};
  const prof = (names, f) => names.forEach((n) => (HL[n] = f));
  prof(['plaintext'], (l) => esc(l));
  prof(['javascript', 'jsx', 'typescript', 'tsx'], cLike(KW_JS));
  prof(['java', 'csharp', 'c', 'cpp', 'go', 'rust'], cLike(KW_C));
  prof(['python'], mkHl([['hc', '#.*$'], ['hs', R`"""(?:.*?"""|.*$)|'''(?:.*?'''|.*$)|` + `${S_DQ}|${S_SQ}`], ['hv', R`@\w+`], ['hn', NUM], ['w', WORD]], 'def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda pass break continue yield global nonlocal assert del async await print self'));
  prof(['powershell'], mkHl([['hc', R`<#.*?#>|#.*$`], ['hs', `${S_DQ}|${S_SQ}`], ['hv', R`\$\{[^}]*\}|\$[\w:]+`], ['ha', R`(?<=\s)-[A-Za-z][\w-]*`], ['hn', NUM], ['w', WORD]], 'function param if elseif else foreach for while do switch return break continue try catch finally throw begin process end in filter class enum using until trap exit', true));
  prof(['bash'], mkHl([['hc', '#.*$'], ['hs', `${S_DQ}|${S_SQ}`], ['hv', R`\$\{[^}]*\}|\$\w+|\$[@#?*!$-]`], ['hn', NUM], ['w', WORD]], 'if then else elif fi for while until do done case esac in function return exit export local echo source alias set unset readonly shift break continue true false'));
  prof(['batch'], mkHl([['hc', R`^\s*(?:rem\b.*|::.*)$`], ['hs', S_DQ], ['hv', R`%[^%\s]+%|%~?\w|![^!\s]+!`], ['w', WORD]], 'echo set if else goto call exit for in do not exist defined errorlevel pause start cd pushd popd setlocal endlocal off on', true));
  prof(['css'], mkHl([['hc', R`/\*.*?\*/|/\*.*$`], ['hs', `${S_DQ}|${S_SQ}`], ['ht', R`[\w-]+(?=\s*:)`], ['hn', R`#[0-9a-fA-F]{3,8}\b|-?\b\d[\w.%]*`], ['hk', R`@[\w-]+|!important`]]));
  prof(['json'], mkHl([['ht', R`"(?:[^"\\]|\\.)*"(?=\s*:)`], ['hs', S_DQ], ['hn', R`-?\b\d[\w.+-]*`], ['hk', R`\b(?:true|false|null)\b`]]));
  prof(['html', 'xml'], mkHl([['hc', R`<!--.*?-->|<!--.*$`], ['ht', R`</?[\w:.-]+|/?>`], ['ha', R`\b[\w:.-]+(?=\s*=)`], ['hs', `${S_DQ}|${S_SQ}`]]));
  prof(['yaml', 'toml', 'ini'], mkHl([['hc', R`(?:^|\s)[#;].*$`], ['ht', R`^\s*-?\s*[^\s:=#\-][^:=]*?(?=\s*[:=])`], ['hs', `${S_DQ}|${S_SQ}`], ['hn', R`\b\d[\w.:-]*`], ['hk', R`\b(?:true|false|null|yes|no|on|off)\b`]]));
  prof(['sql'], mkHl([['hc', '--.*$'], ['hs', S_SQ], ['hn', NUM], ['w', WORD]], 'select from where insert into update delete set create table drop alter join left right inner outer on as and or not null group by order limit having union values primary key index if exists begin commit rollback with distinct count', true));
  prof(['lua'], mkHl([['hc', '--.*$'], ['hs', `${S_DQ}|${S_SQ}`], ['hn', NUM], ['w', WORD]], 'and break do else elseif end false for function if in local nil not or repeat return then true until while'));
  prof(['markdown'], mkHl([['hh', R`^#{1,6}\s.*$`], ['hs', R`\x60[^\x60]*\x60`], ['ha', R`\[[^\]]*\]\([^)]*\)`], ['hk', R`\*\*[^*]+\*\*`], ['hc', R`^\s*(?:[-*+]|\d+\.)\s|^>\s?`]]));

  /* ================= 미리보기 ================= */
  const PW = { el: null, open: false, port: null, path: '/', cache: new Map(), fetching: null, probeToken: 0 };
  function buildPw() {
    const el = document.createElement('div');
    el.id = 'pvw'; el.className = 'tw'; el.hidden = true;
    el.innerHTML = `<div class="tw-win" role="dialog" aria-modal="true" aria-label="개발 서버 미리보기" tabindex="-1">
      <div class="tw-head pvw-head">
        <span class="pvw-ic">${icon('browser')}</span>
        <button type="button" class="pvw-port" data-p="ports" title="감지된 개발 서버 · 열린 포트">${icon('bolt')}<span class="pvw-port-l">포트 고르기</span>${icon('down')}</button>
        <form class="pvw-addr"><input class="pvw-url" aria-label="주소" placeholder="http://localhost:5173/  또는 포트 번호" spellcheck="false" autocomplete="off"><kbd>Enter</kbd></form>
        <button type="button" class="icon-btn" data-p="reload" title="새로고침">${icon('refresh')}</button>
        <button type="button" class="icon-btn" data-p="ext" title="새 창에서 열기">${icon('open')}</button>
        <button type="button" class="icon-btn" data-p="close" title="닫기 (Esc)" aria-label="닫기">${icon('x')}</button>
      </div>
      <div class="pvw-note" hidden>${icon('globe')}<span>원격 접속 중이라 허브 서버가 대신 받아서 보여 줘요. 웹소켓(HMR 자동 새로고침)은 안 되고, 절대 경로(/assets/…)로 파일을 부르는 앱은 깨질 수 있어요. 그럴 땐 허브 PC에서 직접 여세요.</span></div>
      <div class="tw-body pvw-body"><iframe title="개발 서버 미리보기" referrerpolicy="no-referrer" hidden></iframe><div class="pvw-stage"></div></div>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', onPwClick);
    el.querySelector('.pvw-addr').addEventListener('submit', (e) => { e.preventDefault(); const v = parseAddr(el.querySelector('.pvw-url').value); if (!v) return toast('localhost 또는 127.0.0.1 주소나 포트 번호만 열 수 있어요', true); navigatePw(v.port, v.path); });
    el.addEventListener('keydown', onDialogKey);
    PW.el = el;
  }
  function parseAddr(v) {
    v = String(v || '').trim(); if (!v) return null;
    if (/^:?\d{2,5}$/.test(v)) return { port: Number(v.replace(':', '')), path: '/' };
    let u; try { u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`); } catch { return null; }
    if (!/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname) || !/^https?:$/.test(u.protocol)) return null;
    return { port: Number(u.port) || 80, path: `${u.pathname}${u.search}${u.hash}` || '/' };
  }
  const pwSrc = (port, path) => (remote() ? `/preview/${port}${path}` : `http://localhost:${port}${path}`);
  async function loadTargets(sid = curSid(), force = false) {
    if (!sid) return null;
    const c = PW.cache.get(sid);
    if (c && !force && Date.now() - c.at < 8000) return c.data;
    if (PW.fetching?.sid === sid) return PW.fetching.p;
    const p = api(`/api/preview/targets?sessionId=${encodeURIComponent(sid)}`).then((data) => { PW.cache.set(sid, { at: Date.now(), data }); return data; }).catch(() => c?.data || null).finally(() => { if (PW.fetching?.sid === sid) PW.fetching = null; });
    PW.fetching = { sid, p };
    return p;
  }
  const COMMON = [3000, 3001, 3002, 5173, 5174, 8080, 4200, 8000, 5000, 4321, 1420, 8787, 1234, 9000];
  // 열려 있는 포트 중 개발 서버일 법한 것부터: 흔한 포트 → 3000~9999 → 그 밖 (임시 포트 49152 이상 제외)
  function devPorts(data) {
    if (!data) return [];
    const taken = new Set(data.targets.map((t) => t.port));
    const rank = (p) => (COMMON.includes(p) ? 0 : p >= 3000 && p < 10000 ? 1 : 2);
    return data.ports.filter((p) => p.selectable && p.port < 49152 && !taken.has(p.port)).map((p) => p.port).sort((a, b) => rank(a) - rank(b) || a - b);
  }
  function pickPort(data) {
    if (!data) return null;
    const live = data.targets.filter((t) => t.listening).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    if (live.length) return live[0].port;
    const open = new Set(data.ports.filter((p) => p.selectable).map((p) => p.port));
    return COMMON.find((p) => open.has(p)) ?? null;
  }
  /** 미리보기 창 열기. { port, path, url } 없으면 감지된 서버 중 하나를 고르거나 선택 화면 */
  async function openPreview(opts = {}) {
    if (!PW.el) buildPw();
    if (!PW.open) { openDialog(PW.el); PW.open = true; PW.el.querySelector('.tw-win').focus(); }
    PW.el.querySelector('.pvw-note').hidden = !remote();
    let port = opts.port, path = opts.path || '/';
    if (opts.url) { const v = parseAddr(opts.url); if (v) { port = v.port; path = v.path; } }
    if (!port) {
      stage('loading', '개발 서버를 찾는 중…');
      const data = await loadTargets(curSid(), true);
      port = pickPort(data);
      // 마지막에 보던 포트가 아직 열려 있으면 그대로, 아니면 고르는 화면
      const lastLive = PW.port && (data?.ports || []).some((p) => p.port === PW.port);
      if (!port) { if (!lastLive) return chooser(data); port = PW.port; path = PW.path; }
    }
    navigatePw(port, path);
  }
  function stage(kind, title, sub = '', acts = '') {
    const st = PW.el.querySelector('.pvw-stage'), fr = PW.el.querySelector('iframe');
    st.hidden = false; fr.hidden = true;
    st.innerHTML = `<div class="pvw-empty ${kind}">${kind === 'loading' ? '<span class="spinner"></span>' : icon(kind === 'fail' ? 'alert' : 'browser')}<b>${title}</b>${sub ? `<span>${sub}</span>` : ''}${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
  }
  function chooser(data, all = false) {
    const sid = curSid(); PW.chooserData = data;
    const detected = data ? [...data.targets].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)).map((t) => ({ port: t.port, tag: t.source === 'selected' ? '직접 고름' : '터미널에서 감지', on: t.listening })) : [];
    const open = devPorts(data); const shown = all ? open : open.slice(0, 6);
    const rows = [...detected, ...shown.map((p) => ({ port: p, tag: COMMON.includes(p) ? '열려 있는 포트 · 흔한 개발 서버 포트' : '열려 있는 포트', on: true }))];
    const list = rows.length ? `<div class="pvw-list">${rows.map((r) => `<button type="button" class="pvw-row" data-port="${r.port}"><i class="${r.on ? 'on' : ''}"></i><b>localhost:${r.port}</b><small>${esc(r.tag)}${r.on ? '' : ' · 지금은 꺼져 있음'}</small>${icon('right')}</button>`).join('')}</div>` : '';
    const more = open.length > shown.length ? `<button type="button" class="mini-link" data-p="more">${icon('down')}열려 있는 포트 ${open.length - shown.length}개 더 보기</button>` : '';
    stage('pick', '개발 서버 주소를 고르세요', !sid ? '세션을 열면 터미널에서 켠 서버 주소가 자동으로 잡혀요. 위 주소 칸에 포트를 직접 넣어도 돼요' : rows.length ? '' : '터미널에서 <code>npm run dev</code> 처럼 서버를 켜면 주소가 여기에 잡혀요. 위 주소 칸에 포트를 직접 넣어도 돼요', list + more + `<button type="button" class="btn" data-p="rescan">${icon('refresh')}다시 찾기</button>`);
    PW.el.querySelector('.pvw-port-l').textContent = '포트 고르기';
  }
  async function navigatePw(port, path = '/') {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return toast('포트 번호가 올바르지 않아요', true);
    PW.port = port; PW.path = path || '/';
    const inp = PW.el.querySelector('.pvw-url'); inp.value = `http://localhost:${port}${PW.path}`;
    PW.el.querySelector('.pvw-port-l').textContent = `:${port}`;
    const token = ++PW.probeToken;
    stage('loading', `localhost:${port} 에 연결하는 중…`);
    const sid = curSid();
    // 세션에 포트를 기록한다 (원격 프록시는 기록된 포트만 허용). 허브 포트·민감한 포트는 서버가 거절한다. 세션이 없으면 이 PC 직접 보기만
    if (sid) { try { await api('/api/preview/targets', { method: 'POST', body: JSON.stringify({ sessionId: sid, port }) }); PW.cache.delete(sid); } catch (e) { if (token !== PW.probeToken) return; if (remote() || /포트/.test(e.message)) { stage('fail', `localhost:${port} 은 미리보기로 열 수 없어요`, esc(e.message), `<button type="button" class="btn" data-p="ports">${icon('bolt')}다른 포트</button>`); return; } } }
    else if (remote()) { stage('fail', '원격에서는 세션을 연 뒤 미리보기를 쓸 수 있어요', '허브가 세션별로 허용한 포트만 대신 받아 줘요'); return; }
    const ok = await probePw(port);
    if (token !== PW.probeToken) return;
    if (ok !== true) { stage('fail', `localhost:${port} 에 연결하지 못했어요`, ok || '개발 서버가 켜져 있는지, 포트가 맞는지 확인하세요', `<button type="button" class="btn" data-p="retry">${icon('refresh')}다시 시도</button><button type="button" class="btn" data-p="ports">${icon('bolt')}다른 포트</button>`); return; }
    const fr = PW.el.querySelector('iframe');
    PW.el.querySelector('.pvw-stage').hidden = true; fr.hidden = false;
    // 원격(프록시)은 서버 CSP와 같은 sandbox 로 허브 출처에서 격리. 이 PC에서 localhost 를 직접 열 땐 다른 출처라 저장소·쿠키를 그대로 쓰게 둔다
    if (remote()) fr.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-downloads'); else fr.removeAttribute('sandbox');
    fr.src = pwSrc(port, PW.path);
    repaintInsp('tools');
  }
  async function probePw(port) {
    try {
      if (remote()) { const r = await fetch(`/preview/${port}/`, { cache: 'no-store' }); if (r.status === 502 || r.status === 403) { const j = await r.json().catch(() => ({})); return j.error || `HTTP ${r.status}`; } return true; }
      await fetch(`http://localhost:${port}/`, { mode: 'no-cors', cache: 'no-store' }); return true;
    } catch { return false; }
  }
  async function onPwClick(e) {
    const row = e.target.closest('[data-port]'); if (row) return navigatePw(Number(row.dataset.port));
    const b = e.target.closest('[data-p]'); if (!b) { if (e.target === PW.el) hideDialog(PW.el); return; }
    switch (b.dataset.p) {
      case 'close': return hideDialog(PW.el);
      case 'reload': { const fr = PW.el.querySelector('iframe'); if (PW.port && !fr.hidden) { try { fr.contentWindow.location.reload(); } catch { fr.src = fr.src; } } else if (PW.port) navigatePw(PW.port, PW.path); return; }
      case 'retry': return PW.port && navigatePw(PW.port, PW.path);
      case 'rescan': stage('loading', '개발 서버를 찾는 중…'); return chooser(await loadTargets(curSid(), true));
      case 'more': return chooser(PW.chooserData, true);
      case 'ext': { if (!PW.port) return; const u = remote() ? `${location.origin}/preview/${PW.port}${PW.path}` : `http://localhost:${PW.port}${PW.path}`; window.open(u, '_blank', 'noopener'); return; }
      case 'ports': return openPortMenu(b);
    }
  }
  async function openPortMenu(anchor) {
    const data = await loadTargets(curSid(), true);
    const items = [];
    if (data?.targets.length) { items.push({ header: '감지된 개발 서버' }); for (const t of [...data.targets].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))) items.push({ label: `localhost:${t.port}`, desc: `${t.source === 'selected' ? '직접 고름' : '터미널에서 감지'} · ${t.listening ? '실행 중' : '지금은 꺼져 있음'}`, icon: t.listening ? 'play' : 'minus', checked: PW.port === t.port, run: () => { closePop(); navigatePw(t.port); } }); }
    const rest = devPorts(data);
    if (rest.length) { items.push({ header: `허브 PC에서 열려 있는 포트${rest.length > 12 ? ` (${rest.length}개 중 12개)` : ''}` }); for (const p of rest.slice(0, 12)) items.push({ label: `localhost:${p}`, desc: COMMON.includes(p) ? '흔한 개발 서버 포트' : '', icon: 'bolt', checked: PW.port === p, run: () => { closePop(); navigatePw(p); } }); }
    if (!items.length) items.push({ header: curSid() ? '감지된 서버가 없어요 · 터미널에서 서버를 켜거나 주소 칸에 포트를 넣으세요' : '세션을 열면 서버를 찾아요 · 주소 칸에 포트를 직접 넣을 수도 있어요' });
    items.push({ sep: true }, { label: '포트 직접 입력…', icon: 'pencil', run: () => { closePop(); const i = PW.el.querySelector('.pvw-url'); i.focus(); i.select(); } });
    openPop(anchor, items, { below: true });
  }

  /* ================= 오른쪽 패널: 도구 탭 ================= */
  function renderToolsPane(body, s) {
    if (!s) { body.innerHTML = `<div class="insp-empty">${icon('terminal')}<p>세션을 열면 터미널과 미리보기를 여기서 다뤄요</p><small>터미널은 Ctrl+\` 로도 열려요</small></div>`; return; }
    const terms = termsOf(s.id); const act = activeTerm(s.id);
    let h = `<div class="card tool-card"><div class="card-h"><b>터미널</b><button type="button" class="mini-link" data-tool="new">${icon('plus')}새 터미널</button></div>`;
    h += terms.length ? `<div class="tool-list">${terms.map((t) => `<div class="tool-row ${t === act ? 'on' : ''}">
        <button type="button" class="tool-main" data-tool="focus" data-tid="${t.id}" title="${esc(t.cwd)}">${t.running ? '<span class="spin-xs"></span>' : t.closed ? `<span class="c-err">${icon('x')}</span>` : icon('terminal')}<span class="tt"><b>${esc(termLabel(t))}</b><small>${esc(shortPath(t.cwd, 2))}${t.running ? ' · 실행 중' : t.closed ? ' · 종료됨' : t.last ? ` · 종료 코드 ${t.last.code}` : ''}</small></span></button>
        ${t.running ? `<button type="button" class="icon-btn sm" data-tool="stop" data-tid="${t.id}" title="중지">${icon('stop')}</button>` : ''}<button type="button" class="icon-btn sm" data-tool="close" data-tid="${t.id}" title="닫기">${icon('x')}</button></div>`).join('')}</div>`
      : `<p class="fine">아직 연 터미널이 없어요. <span class="mono">${esc(shortPath(s.cwd, 2))}</span> 에서 열려요.</p>`;
    h += '</div>';
    const c = PW.cache.get(s.id); const data = c?.data;
    if (!c || Date.now() - c.at > 15000) loadTargets(s.id, true).then(() => repaintInsp('tools'));
    h += `<div class="card tool-card"><div class="card-h"><b>미리보기</b><button type="button" class="mini-link" data-tool="preview">${icon('browser')}열기</button></div>`;
    if (data?.targets.length) h += `<div class="tool-list">${[...data.targets].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)).slice(0, 6).map((t) => `<div class="tool-row"><button type="button" class="tool-main" data-tool="pv" data-port="${t.port}"><i class="pdot ${t.listening ? 'on' : ''}"></i><span class="tt"><b>localhost:${t.port}</b><small>${t.source === 'selected' ? '직접 고름' : '터미널에서 감지'} · ${t.listening ? '실행 중' : '꺼져 있음'}</small></span></button>${remote() ? '' : `<a class="icon-btn sm" href="http://localhost:${t.port}/" target="_blank" rel="noopener" title="새 창에서 열기">${icon('open')}</a>`}</div>`).join('')}</div>`;
    else h += `<p class="fine">${data ? '감지된 개발 서버가 없어요. 터미널에서 <span class="mono">npm run dev</span> 처럼 켜면 주소가 잡혀요.' : '개발 서버를 찾는 중…'}</p>`;
    h += '</div>';
    h += `<div class="card tool-card"><div class="card-h"><b>폴더</b></div><div class="ibtns"><button type="button" class="btn" data-tool="browse">${icon('folderOpen')}허브에서 보기</button>${remote() ? '' : `<button type="button" class="btn" data-open="${esc(s.cwd)}" title="${esc(s.cwd)}">${icon('folder')}탐색기로 열기</button>`}</div></div>`;
    body.innerHTML = h;
  }
  document.getElementById('inspBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]'); if (!b) return;
    const t = b.dataset.tid ? TM.terms.get(b.dataset.tid) : null;
    switch (b.dataset.tool) {
      case 'new': return newTerm(P.shell);
      case 'focus': if (t) { TM.active.set(t.sessionId, t.id); openDrawer(); } return;
      case 'stop': return t && interrupt(t);
      case 'close': return t && closeTerm(t.id);
      case 'preview': return openPreview();
      case 'pv': return openPreview({ port: Number(b.dataset.port) });
      case 'browse': return S.current && viewPath(S.sessions.get(S.current)?.cwd || '');
    }
  });
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'tools', label: '도구', icon: 'terminal', render: renderToolsPane });

  /* ================= 입구: 상단 바 · 팔레트 · 단축키 · 경로 링크 ================= */
  const baseOpenPath = window.openPath;
  window.openPath = async function (p, mode = 'auto', rel = '', base = '') {
    const inFv = FV.open && UI.lastTarget && FV.el?.contains(UI.lastTarget);
    // 원격에서 결과 HTML 링크는 새 탭에 페이지로 (따로 게시하지 않아도 된다)
    if (remote() && !inFv && isPage(p)) return void openPage(p);
    if (inFv || remote()) return viewPath(p, { rel, base });
    return baseOpenPath.call(this, p, mode, rel, base);
  };
  // 경로 링크 오른쪽 클릭: 허브에서 보기 · 탐색기 · 경로 복사 (app.js 의 복사 동작을 대신한다)
  document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest?.('[data-open]'); if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const p = el.dataset.open.replace(/&amp;/g, '&'), rel = el.dataset.rel || '', base = el.dataset.base || '';
    const items = [{ label: '허브에서 보기', desc: '이 화면 안에서 내용 보기', icon: 'eye', run: () => { closePop(); viewPath(p, { rel, base }); } }];
    if (isPage(p)) items.unshift({ label: '페이지로 열기', desc: '새 탭에서 결과 페이지 보기 · 원격에서도', icon: 'browser', run: () => { closePop(); openPage(p); } });
    if (!remote()) items.push({ label: '열기', desc: '탐색기·기본 프로그램 (이 PC)', icon: 'folder', run: () => { closePop(); baseOpenPath(p, 'auto', rel, base); } }, { label: '탐색기에서 위치 보기', icon: 'folderOpen', run: () => { closePop(); baseOpenPath(p, 'reveal', rel, base); } });
    items.push({ sep: true }, { label: '경로 복사', icon: 'copy', run: async () => { closePop(); let v = p; if (rel && !remote()) { try { v = (await api('/api/open', { method: 'POST', body: JSON.stringify({ path: p, rel, base, mode: 'resolve' }) })).path || p; } catch {} } copyText(v, '경로를 복사했어요'); } });
    openPop(pointAnchor(e.clientX, e.clientY), items, { below: true });
  }, true);
  // 상단 바 버튼
  const tb = document.createElement('div'); tb.className = 'tool-btns';
  tb.innerHTML = `<button type="button" class="icon-btn" id="btnTerm" title="터미널 (Ctrl+\`)" aria-pressed="false">${icon('terminal')}<i class="busy-dot"></i></button><button type="button" class="icon-btn" id="btnFiles" title="세션 폴더 보기 (허브 안에서)">${icon('folderOpen')}</button><button type="button" class="icon-btn" id="btnPreview" title="개발 서버 미리보기">${icon('browser')}</button>`;
  $('#btnInsp').before(tb);
  $('#btnTerm').addEventListener('click', toggleDrawer);
  $('#btnFiles').addEventListener('click', () => viewPath(typeof currentCwd === 'function' ? currentCwd() : ''));
  $('#btnPreview').addEventListener('click', () => openPreview());
  // 검색 팔레트 (side.js 의 renderPalette 가 window.hubCommands 를 읽는다)
  window.hubCommands = window.hubCommands || [];
  window.hubCommands.push(() => [
    { label: drawerOpen() ? '터미널 닫기' : '터미널 열기', desc: shortPath(typeof currentCwd === 'function' ? currentCwd() : '', 2), icon: 'terminal', kbd: 'Ctrl `', run: toggleDrawer },
    { label: '새 터미널', desc: `${SHELLS[P.shell].label} · 셸을 바꾸려면 터미널 바의 ▾`, icon: 'plus', kbd: 'Ctrl ⇧ `', run: () => newTerm(P.shell) },
    { label: '세션 폴더 보기', desc: '허브 안 보기 창에서 파일 탐색', icon: 'folderOpen', run: () => viewPath(typeof currentCwd === 'function' ? currentCwd() : '') },
    { label: '개발 서버 미리보기', desc: '감지된 localhost 포트 열기', icon: 'browser', run: () => openPreview() },
  ]);
  // 단축키
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.code !== 'Backquote' || UI.dialog) return;
    e.preventDefault(); if (e.shiftKey) newTerm(P.shell); else toggleDrawer();
  });
  // 오른쪽 패널 탭이 많아 좁을 땐 글자가 숨으므로 이름을 제목으로 남긴다
  const baseTabs = window.renderInspTabs;
  if (typeof baseTabs === 'function') window.renderInspTabs = function () { baseTabs.apply(this, arguments); for (const b of $$('#inspTabs .tab')) { const n = b.textContent.trim(); b.title = n; b.setAttribute('aria-label', n); } };

  /* ================= 세션 전환 · 실시간 이벤트 ================= */
  function onSessionChange(force = false) {
    const sid = curSid();
    if (sid === TM.sid && !force) return;
    TM.sid = sid;
    if (TM.el) renderDrawer(); else paintTopBtn();
    if (sid && (drawerOpen() || force)) refreshList(sid, force);
  }
  for (const name of ['openSession', 'newSession']) {
    const base = window[name]; if (typeof base !== 'function') continue;
    window[name] = function () { const r = base.apply(this, arguments); if (r && typeof r.then === 'function') r.then(() => onSessionChange(), () => onSessionChange()); else onSessionChange(); return r; };
  }
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail; if (!ev) return;
    if (ev.type === 'term' || ev.type === 'term_state' || ev.type === 'term_exit') return onTermEvent(ev);
    if (ev.type === 'hello') {
      // 다시 연결됐으면 보던 터미널의 빠진 출력을 채운다
      onSessionChange(true);
      for (const t of TM.terms.values()) if (t.loaded) loadBuffer(t);
      PW.cache.clear();
      return;
    }
    if (ev.type === 'session_removed') { for (const t of termsOf(ev.sessionId)) dropTerm(t); if (TM.el) renderDrawer(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    if (P.open) openDrawer({ focus: false });
    else paintTopBtn();
  });
  window.hubTools = { toggleTerminal: toggleDrawer, newTerminal: newTerm, viewPath, openPreview, ansiLine: (s) => ansiLine(s, sgrNew()) };
})();
