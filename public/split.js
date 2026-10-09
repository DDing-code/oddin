/* 화면 나눠 보기 · 새 창 (2026-10-06 사용자 "세션 목록에서 세션을 드래그해서 새창에서 열거나 화면을 분할해서 동시에 보고 싶어"
   → 같은 날 "화면 분할 너무 부실해": 칸마다 상태·세션 바꾸기·크기 조절·배치·포커스를 갖춘 판으로 다시 만듦
   → 2026-10-10 "화면분할 기능이 너무 찐빠가 많이 나": 아래 고침)
   - 칸 늘리기: 사이드바 세션을 끌어 대화 화면 오른쪽에 놓기 · Ctrl+클릭 · 세션 ⋯ "오른쪽에 나란히 열기" · 위쪽 "나란히 보기" 버튼(Ctrl+\) 목록.
     가운데까지 최대 4개(칸 3개). 창 밖에 놓거나 Shift+클릭하면 새 창.
   - 칸 머리: 작업 중·답을 기다림 표시, 제목을 누르면 다른 세션으로 바꾸기, 크게 보기(두 번 눌러도), 가운데와 바꾸기, 새 창, 닫기.
     머리를 끌어 다른 칸에 놓으면 자리 바꾸기, 대화 화면 "여기서 열기"에 놓으면 가운데와 바꾸기.
   - 배치: 가로로 나란히 / 오른쪽에 위아래로. 칸 사이 경계를 끌어 크기 조절(두 번 누르면 똑같이). 나눠 보는 동안 오른쪽 패널은 접었다가 다 닫으면 되돌린다.
   - 포커스: 마지막으로 누른 칸이 강조되고, Alt+1~4 로 칸의 입력창으로 옮겨 간다(1 = 가운데).
   - 칸·새 창은 같은 화면을 "한 세션만 보기"(?embed=1) 로 띄운다 — 기존 대화 화면 코드를 그대로 쓴다.
   - 나눈 칸 목록·크기·배치는 이 창에만 기억한다(localStorage).
   2026-10-10 고친 것:
   - 너비: 가운데와 칸이 똑같이 나눠 갖는다(예전엔 가운데가 절반, 칸 3개가 나머지 절반을 나눠 220px 남짓이었다).
   - 칸 자리 바꾸기·다른 세션으로 바꾸기·가운데와 바꾸기에 iframe 을 다시 읽지 않는다(DOM 을 옮기면 iframe 이 새로 읽혀 쓰던 글이 사라졌다)
     — 자리는 CSS order, 세션 바꾸기는 칸의 주소 #s= 만 바꾼다(칸 안에서 hashchange → openSession).
   - 실시간 연결: 칸은 자기 연결을 열지 않고 가운데 창의 연결 하나로 받는다(app.js connect · hubForward) — 브라우저의 같은 주소 동시 연결 6개 한도.
   - 지워진 세션의 칸은 닫고(다른 PC 세션은 잠깐 끊긴 것일 수 있어 둔다), 좁은 창(860px 이하)에서는 칸을 아예 띄우지 않는다(숨겨도 연결·화면이 살아 있었다). */
(() => {
  const EMBED = /[?&]embed=1\b/.test(location.search);
  const paneUrl = (sid) => `/?embed=1#s=${encodeURIComponent(sid)}`;
  const openWindow = (sid) => { const w = window.open(paneUrl(sid), `oddin-${sid}`, 'popup=yes,width=1040,height=880'); if (!w) toast('새 창이 막혔어요. 브라우저의 팝업 허용을 확인해 주세요', true); };
  const hashSid = () => (location.hash.match(/s=([\w-]+)/) || [])[1] || null;

  /* ---------- 한 세션만 보기(나눈 칸·새 창 안쪽) ---------- */
  if (EMBED) {
    document.documentElement.classList.add('embed');
    // 나눈 칸은 좁다: 입력창 안내 글을 짧게(긴 안내가 두 줄로 잘렸다). 폰 앱의 짧은 안내(push.js)는 칸에서 돌지 않는다
    if (document.documentElement.classList.contains('embed-pane')) {
      window.hubInputPh = () => '무엇을 할까요?';
      const setPh = () => { const i = document.getElementById('in'); if (i && !i.disabled && !document.getElementById('composer')?.classList.contains('ic-mode') && !document.getElementById('composer')?.classList.contains('rs-mode')) i.placeholder = window.hubInputPh(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setPh); else setPh();
    }
    const tell = () => { try { parent !== window && parent.postMessage({ type: 'oddin-pane', sid: hashSid() }, location.origin); } catch {} };
    // 바깥 창이 칸의 세션을 바꿀 때는 주소 #s= 만 바꾼다 → 다시 읽지 않고 그 세션을 연다
    window.addEventListener('hashchange', () => { const sid = hashSid(); if (sid && typeof S !== 'undefined' && sid !== S.current && typeof openSession === 'function') openSession(sid); tell(); });
    window.addEventListener('load', tell);
    // 새 창의 창 제목 = 세션 이름 (작업 표시줄에서 구분되게)
    window.addEventListener('load', () => { const t = document.getElementById('title'); if (!t) return; const set = () => { document.title = `${t.textContent || '세션'} · ODDIN`; }; set(); new MutationObserver(set).observe(t, { childList: true, characterData: true, subtree: true }); });
    return;
  }

  if (!IC.cols) IC.cols = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>';
  if (!IC.rows) IC.rows = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M11 4v16M11 12h10"/>';
  if (!IC.maxi) IC.maxi = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>';
  if (!IC.mini) IC.mini = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>';
  if (!IC.swap) IC.swap = '<path d="M7 7h13l-4-4M17 17H4l4 4"/>';

  /* ---------- 상태 ---------- */
  const KEY = 'oddin.split', MAX = 3, NARROW = 860;
  // m = 가운데 너비를 칸 하나에 견준 몫(1 = 칸 하나와 같은 너비). 예전 저장값 mf(가운데:칸 전체)는 뜻이 달라 쓰지 않는다
  const SP = { panes: [], w: [], m: 1, layout: 'cols', max: null, focus: null, inspWas: false, el: null, lastMain: null };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    SP.panes = Array.isArray(v.panes) ? [...new Set(v.panes.filter((x) => /^[\w-]+$/.test(x)))].slice(0, MAX) : [];
    SP.w = SP.panes.map((_, i) => (Number(v.w?.[i]) > 0 ? Number(v.w[i]) : 1));
    SP.m = Number(v.m) > 0 ? Number(v.m) : 1;
    SP.layout = v.layout === 'rows' ? 'rows' : 'cols';
    SP.inspWas = !!v.inspWas;
  } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ panes: SP.panes, w: SP.w, m: SP.m, layout: SP.layout, inspWas: SP.inspWas })); } catch {} };
  const sess = (sid) => (typeof S !== 'undefined' ? S.sessions.get(sid) : null);
  const title = (sid) => sess(sid)?.title || '세션';
  const app = () => document.getElementById('app');
  const isOpen = () => SP.panes.length > 0;
  const narrow = () => window.innerWidth <= NARROW;
  const waiting = (sid) => { try { return typeof hubSessionWaiting === 'function' && hubSessionWaiting(sid); } catch { return false; } };
  const paneEl = (sid) => SP.el?.querySelector(`.sp-pane[data-sid="${CSS.escape(sid)}"]`) || null;
  const frameOf = (p) => p?.querySelector('iframe') || null;

  // 나눠 보는 동안 오른쪽 패널은 접는다(칸이 좁아지지 않게). 다 닫으면 원래대로
  function inspForSplit(on) {
    const inspOpen = !app().classList.contains('insp-off');
    if (on && inspOpen && window.innerWidth > 1100) { SP.inspWas = true; save(); if (typeof toggleRight === 'function') toggleRight(false); }
    else if (!on && SP.inspWas) { SP.inspWas = false; save(); if (typeof toggleRight === 'function') toggleRight(true); }
  }

  /* ---------- 그리기 ---------- */
  function teardown() { if (SP.el) { SP.el.remove(); SP.el = null; } app().classList.remove('split'); app().style.removeProperty('--mf'); app().style.removeProperty('--sf'); }
  // 실시간 연결이 받을 세션 목록(가운데+칸)이 바뀌었으면 가운데 창 연결의 거르기만 고친다(app.js, 같으면 아무것도 안 함)
  const syncFilter = () => { try { window.updateEventFilter?.(); } catch {} };
  function render() { draw(); syncFilter(); }
  function draw() {
    if (!isOpen()) { if (SP.el) { teardown(); inspForSplit(false); } SP.max = null; setFocus(null); renderTopBtn(); return; }
    if (narrow()) { teardown(); renderTopBtn(); return; } // 좁은 창(폰 등): 칸을 띄우지 않는다. 넓어지면 다시
    if (!SP.el) {
      SP.el = document.createElement('section'); SP.el.id = 'split'; SP.el.setAttribute('aria-label', '나란히 보는 세션');
      SP.el.innerHTML = '<div class="sp-resizer" title="끌어서 너비 조절 · 두 번 눌러 똑같이"></div><div class="sp-panes"></div>';
      document.getElementById('main').after(SP.el);
      bindMainResizer(SP.el.querySelector('.sp-resizer'));
      inspForSplit(true);
    }
    const maxed = !!SP.max && SP.panes.includes(SP.max);
    const cols = SP.layout === 'cols' && !maxed ? SP.panes.length : 1; // 가로로 나란히면 칸 수만큼 몫을 가져간다
    app().classList.add('split'); app().style.setProperty('--mf', `${SP.m}fr`); app().style.setProperty('--sf', `${cols}fr`);
    const box = SP.el.querySelector('.sp-panes');
    box.classList.toggle('rows', SP.layout === 'rows');
    box.classList.toggle('has-max', maxed);
    // 이미 떠 있는 칸은 옮기거나 새로 만들지 않는다: 빠진 세션의 칸은 새 세션에 다시 쓰고(주소만 바꿈), 순서는 CSS order 로
    const els = [...box.children], keep = new Set(SP.panes);
    const orphans = els.filter((p) => !keep.has(p.dataset.sid));
    for (const sid of SP.panes) {
      if (els.some((p) => p.dataset.sid === sid)) continue;
      const p = orphans.shift();
      if (p) retarget(p, sid); else box.appendChild(makePane(sid));
    }
    for (const p of orphans) p.remove();
    SP.panes.forEach((sid, i) => {
      const p = paneEl(sid); if (!p) return;
      p.style.order = String(i); p.style.flex = `${SP.w[i] || 1} 1 0`;
      p.classList.toggle('lead', i === 0); p.classList.toggle('max', SP.max === sid);
    });
    updateHeads(); renderTopBtn();
  }
  // 칸의 세션 바꾸기: iframe 을 다시 읽지 않고 주소 #s= 만 바꾼다(칸 안 split.js 가 hashchange 로 연다). 아직 안 읽혔으면 주소째로
  function retarget(p, sid) {
    p.dataset.sid = sid;
    const f = frameOf(p);
    try {
      if (!p.classList.contains('loading') && !p.classList.contains('blocked') && f.contentWindow?.location) { f.contentWindow.location.hash = `s=${encodeURIComponent(sid)}`; return; }
    } catch {}
    p.classList.add('loading'); f.src = paneUrl(sid);
  }

  function makePane(sid) {
    const p = document.createElement('div'); p.className = 'sp-pane loading'; p.dataset.sid = sid;
    p.innerHTML = `<div class="sp-rz" title="끌어서 크기 조절 · 두 번 눌러 똑같이"></div>
      <div class="sp-head" draggable="true" title="끌어서 다른 칸과 자리 바꾸기 · 두 번 눌러 크게 보기">
        <span class="sp-st"></span>
        <button type="button" class="sp-pick" data-sp="pick" title="다른 세션으로 바꾸기"><span class="sp-title"></span><span class="sp-pc"></span>${icon('down')}</button>
        <span class="grow"></span>
        <button type="button" class="icon-btn" data-sp="max" title="크게 보기" aria-label="크게 보기">${icon('maxi')}</button>
        <button type="button" class="icon-btn" data-sp="main" title="가운데와 바꾸기" aria-label="가운데와 바꾸기">${icon('swap')}</button>
        <button type="button" class="icon-btn" data-sp="window" title="새 창으로" aria-label="새 창으로">${icon('open')}</button>
        <button type="button" class="icon-btn" data-sp="close" title="이 칸 닫기" aria-label="이 칸 닫기">${icon('x')}</button>
      </div>
      <div class="sp-body">
        <iframe src="${paneUrl(sid)}" title="세션 ${esc(title(sid))}"></iframe>
        <div class="sp-loading"><span class="spinner"></span>불러오는 중…</div>
        <div class="sp-drop">이 칸에서 열기</div>
        <div class="sp-blocked" role="status">${icon('alert')}<b>이 칸을 열지 못했어요</b><span>이 PC의 ODDIN이 아직 예전 버전이라 나란히 보기가 막혀 있어요. 위쪽 "새 버전이 준비됐어요"에서 <b>지금 바꾸기</b>를 누르거나 진행 중인 작업이 끝나면 저절로 열려요.</span><button type="button" class="btn" data-sp="reload">${icon('refresh')}다시 열기</button></div>
      </div>`;
    watchFrame(p);
    return p;
  }

  // 칸 머리: 제목·PC·작업 중/답을 기다림 (iframe 은 건드리지 않음)
  function updateHeads() {
    if (!SP.el) return;
    for (const p of SP.el.querySelectorAll('.sp-pane')) {
      const sid = p.dataset.sid, s = sess(sid);
      p.querySelector('.sp-title').textContent = title(sid);
      p.querySelector('.sp-pc').textContent = s?.machine?.name ? ` · ${s.machine.name}` : '';
      const st = p.querySelector('.sp-st'), w = waiting(sid), run = s?.status === 'running';
      const sig = w ? 'wait' : run ? 'run' : 'idle';
      if (st.dataset.v !== sig) {
        st.dataset.v = sig;
        st.innerHTML = w ? `<i class="sp-wait" title="답을 기다려요"></i>` : run ? '<span class="spin-xs" title="작업 중"></span>' : '<i class="sp-idle"></i>';
      }
      p.classList.toggle('is-wait', w);
      const mb = p.querySelector('[data-sp="max"]');
      const mx = SP.max === sid ? 'mini' : 'maxi';
      if (mb.dataset.v !== mx) { mb.dataset.v = mx; mb.innerHTML = icon(mx); mb.title = SP.max === sid ? '원래 크기로' : '크게 보기'; }
      frameOf(p).title = `세션 ${title(sid)}`;
    }
  }

  // 칸이 막혔는지(예전 서버의 화면 끼워 넣기 금지 등): 하얀 빈 칸 대신 이유와 다시 열기. 읽히면 포커스·단축키를 잇는다
  function watchFrame(p) {
    const f = frameOf(p);
    f.addEventListener('load', () => {
      p.classList.remove('loading');
      let ok = false;
      try { ok = !!f.contentDocument?.getElementById('app'); } catch { ok = false; }
      p.classList.toggle('blocked', !ok);
      if (!ok) return;
      try {
        const w = f.contentWindow;
        w.addEventListener('pointerdown', () => setFocus(p.dataset.sid), true);
        w.addEventListener('focusin', () => setFocus(p.dataset.sid));
        w.addEventListener('keydown', onKey, true);
      } catch {}
    });
  }
  const reloadPane = (p) => { const f = frameOf(p); p.classList.add('loading'); f.src = paneUrl(p.dataset.sid); };
  const reloadBlocked = () => document.querySelectorAll('.sp-pane.blocked').forEach(reloadPane);

  /* ---------- 칸 열기·닫기·바꾸기 ---------- */
  function openSplit(sid, at = null) {
    if (typeof S !== 'undefined' && sid === S.current) return toast('지금 가운데에서 보고 있는 세션이에요. 다른 세션을 나란히 열어 보세요');
    if (narrow()) return toast('창이 좁아서 나란히 볼 수 없어요. 창을 넓히거나 새 창으로 열어 보세요');
    const i = SP.panes.indexOf(sid);
    if (i >= 0 && at === null) { setFocus(sid); return toast('이미 나란히 열려 있어요'); }
    if (i >= 0 && at !== null && at < SP.panes.length) { // 열린 칸끼리 자리 바꾸기
      [SP.panes[i], SP.panes[at]] = [SP.panes[at], SP.panes[i]]; [SP.w[i], SP.w[at]] = [SP.w[at], SP.w[i]];
    } else if (at !== null && at < SP.panes.length) { SP.panes[at] = sid; }
    else if (SP.panes.length >= MAX) { SP.panes[MAX - 1] = sid; toast(`가운데까지 ${MAX + 1}개까지 볼 수 있어요. 마지막 칸을 바꿨어요`); }
    else { SP.panes.push(sid); SP.w.push(1); }
    save(); render(); setFocus(sid);
  }
  function closePane(sid) {
    const i = SP.panes.indexOf(sid); if (i < 0) return;
    SP.panes.splice(i, 1); SP.w.splice(i, 1);
    if (SP.max === sid) SP.max = null;
    if (SP.focus === sid) SP.focus = null;
    save(); render();
  }
  function closeAll() { SP.panes = []; SP.w = []; save(); render(); }
  function swapWithMain(sid) {
    const cur = typeof S !== 'undefined' ? S.current : null;
    const i = SP.panes.indexOf(sid);
    if (cur && cur !== sid && i >= 0) SP.panes[i] = cur; else if (i >= 0) { SP.panes.splice(i, 1); SP.w.splice(i, 1); }
    SP.lastMain = sid; save(); render(); openSession(sid);
  }
  function toggleMax(sid) { SP.max = SP.max === sid ? null : sid; render(); }
  function setLayout(l) { SP.layout = l; SP.max = null; save(); render(); }
  function evenOut() { SP.w = SP.panes.map(() => 1); SP.m = 1; save(); render(); }
  // 지워진 세션의 칸은 닫는다. 다른 PC 세션(rm-)은 그 PC가 잠깐 끊긴 것일 수 있어 둔다. 가운데와 같은 세션도 칸에서 뺀다
  function prune() {
    if (typeof S === 'undefined' || !S.sessions.size) return;
    const gone = SP.panes.filter((sid) => sid === S.current || (!sid.startsWith('rm-') && !S.sessions.has(sid)));
    if (!gone.length) return;
    for (const sid of gone) { const i = SP.panes.indexOf(sid); SP.panes.splice(i, 1); SP.w.splice(i, 1); if (SP.max === sid) SP.max = null; }
    save(); render();
  }

  /* ---------- 포커스(마지막으로 누른 칸) · Alt+1~4 ---------- */
  function setFocus(sid) {
    SP.focus = isOpen() ? sid : null;
    document.getElementById('main')?.classList.toggle('sp-focus', isOpen() && !!SP.el && !SP.focus);
    SP.el?.querySelectorAll('.sp-pane').forEach((p) => p.classList.toggle('focus', p.dataset.sid === SP.focus));
  }
  function focusIndex(n) {
    if (n === 0) { setFocus(null); document.getElementById('in')?.focus(); return; }
    const sid = SP.panes[n - 1]; if (!sid || !SP.el) return;
    if (SP.max && SP.max !== sid) { SP.max = sid; render(); }
    setFocus(sid);
    const f = frameOf(paneEl(sid));
    try { f?.contentWindow?.focus(); f?.contentDocument?.getElementById('in')?.focus(); } catch {}
  }
  function onKey(e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key) && isOpen() && SP.el) { e.preventDefault(); focusIndex(Number(e.key) - 1); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); openPicker(document.querySelector('[data-spbar]') || document.getElementById('title')); }
  }
  document.addEventListener('keydown', onKey);
  document.getElementById('main').addEventListener('pointerdown', () => setFocus(null), true);

  /* ---------- 세션 고르기 목록 ---------- */
  function candidates(except = []) {
    const skip = new Set([...(typeof S !== 'undefined' && S.current ? [S.current] : []), ...SP.panes, ...except]);
    return [...S.sessions.values()].filter((s) => !skip.has(s.id) && !s.archived)
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')).slice(0, 24);
  }
  const itemOf = (s, run) => ({
    label: s.title || '세션',
    desc: [waiting(s.id) ? '답을 기다려요' : s.status === 'running' ? '작업 중' : '', s.machine?.name || '', shortPath(s.workdir || s.cwd || '', 2)].filter(Boolean).join(' · '),
    icon: waiting(s.id) ? 'alert' : 'chat', run,
  });
  function openPicker(anchor, { replace = null } = {}) {
    if (narrow()) return toast('창이 좁아서 나란히 볼 수 없어요. 창을 넓히거나 새 창으로 열어 보세요');
    const list = candidates();
    const items = [{ header: replace ? '이 칸에서 볼 세션' : `나란히 열 세션 · 가운데까지 ${MAX + 1}개` }];
    for (const s of list) items.push(itemOf(s, () => { closePop(); replace ? openSplit(s.id, SP.panes.indexOf(replace)) : openSplit(s.id); }));
    if (!list.length) items.push({ header: '열 수 있는 다른 세션이 없어요' });
    if (!replace && isOpen()) {
      items.push({ sep: true }, { header: '배치' },
        { label: '가로로 나란히', icon: 'cols', checked: SP.layout === 'cols', run: () => { closePop(); setLayout('cols'); } },
        { label: '오른쪽에 위아래로', icon: 'rows', checked: SP.layout === 'rows', run: () => { closePop(); setLayout('rows'); } },
        { label: '크기 똑같이', icon: 'split', run: () => { closePop(); evenOut(); } },
        { sep: true }, { label: '나란히 보기 모두 닫기', icon: 'x', danger: true, run: () => { closePop(); closeAll(); } });
    }
    openPop(anchor, items, { below: true });
  }

  // 위쪽 제목 줄: "나란히 보기" 버튼(열린 칸 수)
  function renderTopBtn() { if (typeof renderTop === 'function') try { renderTop(); } catch {} }
  (window.hubTopExtras ||= []).push((s) => {
    // 가운데에서 다른 세션을 열었는데 그 세션이 칸에 있으면, 그 칸에는 방금까지 가운데에 있던 세션을 넣는다(같은 세션이 두 번 보이지 않게)
    const id = s?.id || null;
    if (id !== SP.lastMain) {
      const i = id ? SP.panes.indexOf(id) : -1;
      if (i >= 0) { if (SP.lastMain && !SP.panes.includes(SP.lastMain)) SP.panes[i] = SP.lastMain; else { SP.panes.splice(i, 1); SP.w.splice(i, 1); } save(); setTimeout(render, 0); }
      SP.lastMain = id;
    }
    const n = SP.panes.length;
    if (n) setTimeout(updateHeads, 0); // 세션 목록을 처음 받아 온 뒤에도 칸 제목이 맞게
    return `<button type="button" class="icon-btn sp-bar-btn${n ? ' on' : ''}" data-spbar title="${n ? `나란히 보기 · 칸 ${n}개 (Ctrl+\\)` : '나란히 보기 — 다른 세션을 옆에 열기 (Ctrl+\\)'}" aria-label="나란히 보기">${icon('cols')}${n ? `<span class="sp-n">${n + 1}</span>` : ''}</button>`;
  });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-spbar]'); if (b) { e.stopPropagation(); openPicker(b); } });

  /* ---------- 크기 조절 ---------- */
  function bindMainResizer(el) {
    el.addEventListener('dblclick', () => { SP.m = 1; save(); render(); });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const main = document.getElementById('main'), left = main.getBoundingClientRect().left, total = main.offsetWidth + SP.el.offsetWidth;
      const cols = SP.layout === 'cols' && !SP.el.querySelector('.sp-panes.has-max') ? SP.panes.length : 1;
      app().classList.add('sp-resizing');
      const move = (ev) => { const w = Math.min(Math.max(ev.clientX - left, 320), total - 260 * cols); SP.m = Math.round((w / (total - w)) * cols * 100) / 100; app().style.setProperty('--mf', `${SP.m}fr`); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); app().classList.remove('sp-resizing'); save(); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
  }
  // 칸 사이 경계: 앞 칸(순서상 바로 앞)과 이 칸의 몫만 주고받는다
  document.addEventListener('pointerdown', (e) => {
    const rz = e.target.closest('.sp-rz'); if (!rz) return;
    const p = rz.closest('.sp-pane'), i = SP.panes.indexOf(p.dataset.sid), prev = i > 0 ? paneEl(SP.panes[i - 1]) : null;
    if (i <= 0 || !prev) return;
    e.preventDefault(); rz.setPointerCapture(e.pointerId);
    const rows = SP.layout === 'rows', pos = (ev) => (rows ? ev.clientY : ev.clientX);
    const a = prev.getBoundingClientRect(), b = p.getBoundingClientRect();
    const start = rows ? a.top : a.left, span = rows ? a.height + b.height : a.width + b.width, sum = SP.w[i - 1] + SP.w[i];
    app().classList.add('sp-resizing'); app().classList.toggle('sp-resizing-rows', rows);
    const move = (ev) => {
      const min = rows ? 140 : 260, x = Math.min(Math.max(pos(ev) - start, min), span - min), r = x / span;
      SP.w[i - 1] = Math.round(sum * r * 100) / 100; SP.w[i] = Math.round(sum * (1 - r) * 100) / 100;
      prev.style.flex = `${SP.w[i - 1]} 1 0`; p.style.flex = `${SP.w[i]} 1 0`;
    };
    const up = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); app().classList.remove('sp-resizing', 'sp-resizing-rows'); save(); };
    rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
  });
  document.addEventListener('dblclick', (e) => {
    if (e.target.closest('.sp-rz')) { SP.w = SP.panes.map(() => 1); save(); render(); return; }
    const h = e.target.closest('.sp-head'); if (h && !e.target.closest('button')) toggleMax(h.closest('.sp-pane').dataset.sid);
  });

  /* ---------- 칸 머리 버튼 ---------- */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sp]'); if (!b) return;
    const p = b.closest('.sp-pane'), sid = p?.dataset.sid; if (!sid) return;
    const act = b.dataset.sp;
    if (act === 'reload') return reloadPane(p);
    if (act === 'pick') { e.stopPropagation(); return openPicker(b, { replace: sid }); }
    if (act === 'max') return toggleMax(sid);
    if (act === 'close') return closePane(sid);
    if (act === 'window') { openWindow(sid); return closePane(sid); }
    if (act === 'main') return swapWithMain(sid);
  });

  /* ---------- 칸에 실시간 이벤트 넘기기(app.js connect·paneConnect) ---------- */
  const attached = new Map(); // 칸 window → 그 칸이 보는 세션
  // 칸이 자기 세션을 열 때 부른다: 칸 목록을 맞추고, 가운데 창 연결이 그 세션도 받게 거르기를 고친 뒤 끝난다
  function attach(win, sid) {
    attached.set(win, sid || null);
    const p = SP.el && [...SP.el.querySelectorAll('.sp-pane')].find((x) => frameOf(x)?.contentWindow === win);
    if (p && sid && p.dataset.sid !== sid) { // 칸 안에서 다른 세션으로 옮겨 갔다(Ctrl+K 등)
      const i = SP.panes.indexOf(p.dataset.sid);
      if (i >= 0 && !SP.panes.includes(sid)) { SP.panes[i] = sid; p.dataset.sid = sid; save(); updateHeads(); }
    }
    try { return window.updateEventFilter?.() || Promise.resolve(); } catch { return Promise.resolve(); }
  }
  window.hubSplitSessions = () => {
    for (const [w] of attached) if (w.closed) attached.delete(w); // 닫힌 칸은 뺀다
    return [...new Set([...(SP.el ? SP.panes : []), ...[...attached.values()].filter(Boolean)])];
  };
  window.hubForward = (raw, ev, { resync = false } = {}) => {
    for (const [w] of attached) {
      if (w.closed) { attached.delete(w); continue; }
      try { if (ev.type === 'hello') { if (resync) w.hubPaneResync?.(); } else w.hubPaneEvent?.(raw); } catch { attached.delete(w); }
    }
  };

  // 칸 안에서 세션이 바뀌면(주소가 바뀐 경우) 칸 목록을 맞춘다
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'oddin-pane') return;
    const p = [...document.querySelectorAll('.sp-pane')].find((x) => frameOf(x)?.contentWindow === e.source);
    if (p && e.data.sid && e.data.sid !== p.dataset.sid) { const i = SP.panes.indexOf(p.dataset.sid); if (i >= 0 && !SP.panes.includes(e.data.sid)) { SP.panes[i] = e.data.sid; p.dataset.sid = e.data.sid; save(); render(); } }
  });
  window.addEventListener('hub:event', (e) => {
    const t = e.detail?.type;
    // hub:event 는 app.js 가 hello 를 반영하기 전에 오므로, 세션 목록이 채워진 뒤에 지워진 칸을 정리한다
    if (t === 'hello') { setTimeout(() => { prune(); render(); }, 0); setTimeout(reloadBlocked, 500); } // 새 버전으로 재시작해 다시 연결되면 막혔던 칸을 다시 연다
    else if (t === 'remote_sync') render();
    else if (t === 'session' || t === 'job' || t === 'prompt') updateHeads();
    if (t === 'session_removed' && SP.panes.includes(e.detail.sessionId)) closePane(e.detail.sessionId);
  });
  // 창 너비가 바뀌면: 좁아지면 칸을 내리고(연결·화면 정리), 넓어지면 다시 띄운다
  let rt = 0, wasNarrow = narrow();
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const n = narrow(); if (n !== wasNarrow) { wasNarrow = n; render(); } }, 150); });

  /* ---------- 끌어다 놓기 ---------- */
  const TYPE = 'text/x-oddin-session';
  let drag = null; // { sid, fromPane, dropped }
  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('#tree .sess[data-sid], #hubRemote .sess[data-sid]');
    const head = !row && e.target.closest?.('.sp-head');
    if (!row && !head) return;
    const sid = row ? row.dataset.sid : head.closest('.sp-pane').dataset.sid;
    drag = { sid, fromPane: !!head, dropped: false };
    e.dataTransfer.setData(TYPE, sid);
    e.dataTransfer.setData('text/uri-list', location.origin + paneUrl(sid));
    e.dataTransfer.setData('text/plain', title(sid));
    e.dataTransfer.effectAllowed = 'copyMove';
    // 칸 안 화면(iframe)이 끌기 이벤트를 삼키지 않게 잠시 막고, 놓을 자리를 보여 준다
    setTimeout(() => { app().classList.add('sp-dragging'); app().classList.toggle('sp-dragging-pane', !!head); }, 0);
  });
  const zone = () => document.getElementById('spZones') || (() => {
    const z = document.createElement('div'); z.id = 'spZones';
    z.innerHTML = '<div class="spz" data-z="here"><b>여기서 열기</b><small>가운데 대화를 이 세션으로</small></div><div class="spz" data-z="side"><b>나란히 열기</b><small>오른쪽에 칸을 더해요</small></div>';
    document.getElementById('main').appendChild(z); return z;
  })();
  const isSessionDrag = (e) => !!drag || [...(e.dataTransfer?.types || [])].includes(TYPE);
  document.addEventListener('dragover', (e) => {
    if (!isSessionDrag(e)) return;
    const z = e.target.closest?.('#spZones .spz, .sp-pane'); if (!z) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.spz.on, .sp-pane.on').forEach((x) => x !== z && x.classList.remove('on'));
    z.classList.add('on');
  });
  document.addEventListener('drop', (e) => {
    if (!isSessionDrag(e)) return;
    const z = e.target.closest?.('#spZones .spz, .sp-pane'); if (!z) return;
    e.preventDefault();
    const sid = e.dataTransfer.getData(TYPE) || drag?.sid; if (!sid) return;
    if (drag) drag.dropped = true;
    if (z.classList.contains('sp-pane')) { if (z.dataset.sid !== sid) openSplit(sid, SP.panes.indexOf(z.dataset.sid)); }
    else if (z.dataset.z === 'side') { if (!SP.panes.includes(sid)) openSplit(sid); }
    else if (SP.panes.includes(sid)) swapWithMain(sid);
    else openSession(sid);
  });
  // 창 안 어디든(사이드바 묶음 등) 놓았으면 새 창을 열지 않는다
  document.addEventListener('drop', (e) => { if (drag && isSessionDrag(e)) drag.dropped = true; }, true);
  document.addEventListener('dragend', (e) => {
    if (!drag) return;
    app().classList.remove('sp-dragging', 'sp-dragging-pane');
    document.querySelectorAll('.spz.on, .sp-pane.on').forEach((x) => x.classList.remove('on'));
    // 창 밖에 놓으면 새 창 (칸 머리를 끌어냈으면 그 칸은 닫는다)
    const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight
      || (e.screenX && (e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight));
    if (!drag.dropped && e.dataTransfer.dropEffect === 'none' && outside) { openWindow(drag.sid); if (drag.fromPane) closePane(drag.sid); }
    drag = null;
  });
  zone();

  /* ---------- 사이드바: Ctrl+클릭 = 나란히, Shift+클릭 = 새 창 ---------- */
  document.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const row = e.target.closest('#tree .sess[data-sid], #hubRemote .sess[data-sid]');
    if (!row || e.target.closest('button, input')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) openWindow(row.dataset.sid); else openSplit(row.dataset.sid);
  }, true);

  /* ---------- 세션 ⋯ 메뉴 ---------- */
  window.hubSessionMenuItems = window.hubSessionMenuItems || [];
  window.hubSessionMenuItems.push((s) => [
    { label: '오른쪽에 나란히 열기', desc: 'Ctrl+클릭 · 끌어서 대화 화면 오른쪽에 놓아도 돼요', icon: 'cols', run: () => { closePop(); openSplit(s.id); } },
    { label: '새 창에서 열기', desc: 'Shift+클릭 · 끌어서 창 밖에 놓아도 돼요', icon: 'open', run: () => { closePop(); openWindow(s.id); } },
  ]);

  window.hubSplit = { open: openSplit, close: closePane, closeAll, window: openWindow, panes: () => [...SP.panes], layout: setLayout, focus: focusIndex, picker: openPicker, attach };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
