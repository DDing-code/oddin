/* 화면 나눠 보기 · 새 창 (2026-10-06 사용자 "세션 목록에서 세션을 드래그해서 새창에서 열거나 화면을 분할해서 동시에 보고 싶어")
   - 사이드바 세션을 끌어다 대화 화면 오른쪽 절반에 놓으면 나란히(최대 2칸 더), 왼쪽 절반은 여기서 열기, 나눈 칸 위는 그 칸에서 열기,
     창 밖에 놓으면 새 창. 세션 ⋯ 메뉴에도 "오른쪽에 나란히 열기"·"새 창에서 열기".
   - 나눈 칸·새 창은 같은 화면을 "한 세션만 보기"(?embed=1) 로 띄운다 — 칸마다 실시간 연결·입력창이 따로라 기존 대화 화면 코드를 그대로 쓴다.
   - 나눈 칸 목록은 이 창에만 기억한다(localStorage). */
(() => {
  const EMBED = /[?&]embed=1\b/.test(location.search);
  const paneUrl = (sid) => `/?embed=1#s=${encodeURIComponent(sid)}`;
  const openWindow = (sid) => { const w = window.open(paneUrl(sid), `oddin-${sid}`, 'popup=yes,width=1040,height=880'); if (!w) toast('새 창이 막혔어요. 브라우저의 팝업 허용을 확인해 주세요', true); };

  /* ---------- 한 세션만 보기(나눈 칸·새 창 안쪽) ---------- */
  if (EMBED) {
    document.documentElement.classList.add('embed');
    const tell = () => { try { parent !== window && parent.postMessage({ type: 'oddin-pane', sid: (location.hash.match(/s=([\w-]+)/) || [])[1] || null }, location.origin); } catch {} };
    window.addEventListener('hashchange', tell); window.addEventListener('load', tell);
    // 새 창의 창 제목 = 세션 이름 (작업 표시줄에서 구분되게)
    window.addEventListener('load', () => { const t = document.getElementById('title'); if (!t) return; const set = () => { document.title = `${t.textContent || '세션'} · ODDIN`; }; set(); new MutationObserver(set).observe(t, { childList: true, characterData: true, subtree: true }); });
    // 칸 안에서 다른 세션으로 옮기는 일은 없다 — 사이드바·오른쪽 패널은 CSS 로 숨긴다(split.css)
    return;
  }

  /* ---------- 바깥 창: 나눈 칸 ---------- */
  const KEY = 'oddin.split', MAX = 2;
  const SP = { panes: [], el: null, mf: 1 };
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); SP.panes = Array.isArray(v.panes) ? v.panes.filter((x) => /^[\w-]+$/.test(x)).slice(0, MAX) : []; SP.mf = Number(v.mf) > 0 ? Number(v.mf) : 1; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ panes: SP.panes, mf: SP.mf })); } catch {} };
  const title = (sid) => (typeof S !== 'undefined' && S.sessions.get(sid)?.title) || '세션';

  function render() {
    const app = document.getElementById('app');
    if (!SP.panes.length) { SP.el?.remove(); SP.el = null; app.classList.remove('split'); app.style.removeProperty('--mf'); return; }
    if (!SP.el) {
      SP.el = document.createElement('section'); SP.el.id = 'split'; SP.el.setAttribute('aria-label', '나란히 보는 세션');
      SP.el.innerHTML = '<div class="sp-resizer" title="끌어서 너비 조절 · 두 번 눌러 반반"></div><div class="sp-panes"></div>';
      document.getElementById('main').after(SP.el);
      bindResizer(SP.el.querySelector('.sp-resizer'));
    }
    app.classList.add('split'); app.style.setProperty('--mf', `${SP.mf}fr`);
    const box = SP.el.querySelector('.sp-panes');
    // 이미 떠 있는 칸은 그대로 둔다(다시 그려도 iframe 이 새로 읽히지 않게)
    for (const p of [...box.children]) if (!SP.panes.includes(p.dataset.sid)) p.remove();
    SP.panes.forEach((sid, i) => {
      let p = box.querySelector(`.sp-pane[data-sid="${CSS.escape(sid)}"]`);
      if (!p) {
        p = document.createElement('div'); p.className = 'sp-pane'; p.dataset.sid = sid;
        p.innerHTML = `<div class="sp-head"><span class="sp-title"></span><span class="grow"></span>
          <button type="button" class="icon-btn" data-sp="main" title="가운데와 바꾸기" aria-label="가운데와 바꾸기">${icon('expand')}</button>
          <button type="button" class="icon-btn" data-sp="window" title="새 창으로" aria-label="새 창으로">${icon('open')}</button>
          <button type="button" class="icon-btn" data-sp="close" title="닫기" aria-label="닫기">${icon('x')}</button></div>
          <iframe src="${paneUrl(sid)}" title="세션 ${esc(title(sid))}"></iframe><div class="sp-drop">이 칸에서 열기</div>`;
        box.appendChild(p);
      }
      if (box.children[i] !== p) box.insertBefore(p, box.children[i] || null);
      p.querySelector('.sp-title').textContent = title(sid);
    });
  }

  function openSplit(sid, at = null) {
    if (typeof S !== 'undefined' && sid === S.current && !SP.panes.length) return toast('지금 보고 있는 세션이에요. 다른 세션을 나란히 열어 보세요');
    const i = SP.panes.indexOf(sid);
    if (i >= 0 && at === null) return toast('이미 나란히 열려 있어요');
    if (i >= 0) SP.panes.splice(i, 1);
    if (at !== null && at < SP.panes.length) SP.panes[at] = sid;
    else if (SP.panes.length >= MAX) { SP.panes[MAX - 1] = sid; toast(`나란히는 ${MAX + 1}개까지예요. 마지막 칸을 바꿨어요`); }
    else SP.panes.push(sid);
    save(); render();
  }
  function closePane(sid) { SP.panes = SP.panes.filter((x) => x !== sid); save(); render(); }
  function swapWithMain(sid) {
    const cur = typeof S !== 'undefined' ? S.current : null;
    const i = SP.panes.indexOf(sid);
    if (cur && cur !== sid && i >= 0) SP.panes[i] = cur; else SP.panes = SP.panes.filter((x) => x !== sid);
    save(); render(); openSession(sid);
  }

  function bindResizer(el) {
    el.addEventListener('dblclick', () => { SP.mf = 1; save(); render(); });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const main = document.getElementById('main'), left = main.getBoundingClientRect().left, total = main.offsetWidth + SP.el.offsetWidth;
      document.getElementById('app').classList.add('sp-resizing');
      const move = (ev) => { const w = Math.min(Math.max(ev.clientX - left, 280), total - 280); SP.mf = Math.round((w / (total - w)) * 100) / 100; document.getElementById('app').style.setProperty('--mf', `${SP.mf}fr`); };
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); document.getElementById('app').classList.remove('sp-resizing'); save(); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sp]'); if (!b) return;
    const sid = b.closest('.sp-pane')?.dataset.sid; if (!sid) return;
    if (b.dataset.sp === 'close') closePane(sid);
    else if (b.dataset.sp === 'window') { openWindow(sid); closePane(sid); }
    else swapWithMain(sid);
  });
  // 칸 안에서 세션이 바뀌면(드문 일) 제목만 맞춘다
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'oddin-pane') return;
    const p = [...document.querySelectorAll('.sp-pane')].find((x) => x.querySelector('iframe')?.contentWindow === e.source);
    if (p && e.data.sid && e.data.sid !== p.dataset.sid) { const i = SP.panes.indexOf(p.dataset.sid); if (i >= 0) { SP.panes[i] = e.data.sid; p.dataset.sid = e.data.sid; save(); render(); } }
  });
  window.addEventListener('hub:event', (e) => {
    const t = e.detail?.type;
    if (t === 'session' || t === 'hello' || t === 'remote_sync') render();
    if (t === 'session_removed' && SP.panes.includes(e.detail.sessionId)) closePane(e.detail.sessionId);
  });

  /* ---------- 끌어다 놓기 ---------- */
  const TYPE = 'text/x-oddin-session';
  let drag = null; // { sid, dropped }
  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('#tree .sess[data-sid], #hubRemote .sess[data-sid]'); if (!row) return;
    drag = { sid: row.dataset.sid, dropped: false };
    e.dataTransfer.setData(TYPE, drag.sid);
    e.dataTransfer.setData('text/uri-list', location.origin + paneUrl(drag.sid));
    e.dataTransfer.setData('text/plain', title(drag.sid));
    e.dataTransfer.effectAllowed = 'copyMove';
    // 칸 안 화면(iframe)이 끌기 이벤트를 삼키지 않게 잠시 막고, 놓을 자리를 보여 준다
    setTimeout(() => document.getElementById('app').classList.add('sp-dragging'), 0);
  });
  const zone = () => document.getElementById('spZones') || (() => {
    const z = document.createElement('div'); z.id = 'spZones';
    z.innerHTML = '<div class="spz" data-z="here">여기서 열기</div><div class="spz" data-z="side">나란히 열기</div>';
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
    if (z.classList.contains('sp-pane')) openSplit(sid, SP.panes.indexOf(z.dataset.sid));
    else if (z.dataset.z === 'side') openSplit(sid);
    else { if (SP.panes.includes(sid)) closePane(sid); openSession(sid); }
  });
  document.addEventListener('dragend', (e) => {
    if (!drag) return;
    document.getElementById('app').classList.remove('sp-dragging');
    document.querySelectorAll('.spz.on, .sp-pane.on').forEach((x) => x.classList.remove('on'));
    // 창 밖에 놓으면 새 창
    const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight
      || (e.screenX && (e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight));
    if (!drag.dropped && e.dataTransfer.dropEffect === 'none' && outside) openWindow(drag.sid);
    drag = null;
  });
  zone();

  /* ---------- 세션 ⋯ 메뉴 ---------- */
  window.hubSessionMenuItems = window.hubSessionMenuItems || [];
  window.hubSessionMenuItems.push((s) => [
    { label: '오른쪽에 나란히 열기', desc: '끌어서 대화 화면 오른쪽에 놓아도 돼요', icon: 'split', run: () => { closePop(); openSplit(s.id); } },
    { label: '새 창에서 열기', desc: '끌어서 창 밖에 놓아도 돼요', icon: 'open', run: () => { closePop(); openWindow(s.id); } },
  ]);

  window.hubSplit = { open: openSplit, close: closePane, window: openWindow, panes: () => [...SP.panes] };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
