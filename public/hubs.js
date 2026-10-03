/* AI Hub — 데스크탑 프로그램(window.hubDesktop) 안에서만 동작하는 허브 전환·원격 세션 화면
   desktop.js 다음에 읽힌다. 연결 규약은 docs/desktop.md "화면 ↔ 프로그램 연결 규약".
   - 사이드바 맨 위 .brand 안에 허브 전환 버튼(허브 이름·연결 상태 점·원격 표시) → 허브 팝오버
   - #tree 와 .side-bottom 사이 #hubRemote 에 다른 허브의 세션 목록 (side.js 의 renderTree 가 #tree 를 통째로 다시 그리므로 따로 둔다)
   - 원격 허브 추가 창 · 허브 관리 창 (<dialog>, .modal-win 과 같은 외형의 작은 창)
   일반 브라우저(window.hubDesktop 없음)에서는 아무것도 만들거나 바꾸지 않는다.
   시험용: window.hubsUI = { init, refresh }, window 의 'hubdesktop-ready' 이벤트로도 시작한다. */
'use strict';
(() => {
  if (typeof IC === 'object' && IC) {
    if (!IC.globe) IC.globe = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>';
  }

  const STATUS_KO = { online: '연결됨', offline: '연결 안 됨', checking: '확인 중' };
  const SESS_KO = { empty: '빈 세션' };
  const FIRST = 6; // 허브당 처음 펼쳐 보여 주는 세션 수
  const HUB = {
    api: null, hubs: [], current: null, remote: [], loaded: false, hubsErr: '', remoteErr: '',
    loading: false, inflight: null, at: 0, unsubs: [],
    closed: false, closedHubs: new Set(), expanded: new Set(),
    pop: null, dlg: null, busy: null,
  };

  /* ---------- 공용 도우미 (app.js 전역을 있으면 쓰고 없어도 깨지지 않게) ---------- */
  const ic = (n) => (typeof icon === 'function' ? icon(n) : '');
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const say = (m, err = false) => { if (typeof toast === 'function') toast(m, err); };
  const when = (iso) => { if (!iso) return ''; try { return typeof ago === 'function' ? ago(iso) : new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  const host = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const stKo = (s) => STATUS_KO[s] || STATUS_KO.checking;
  const sessKo = (s) => (typeof ST_KO !== 'undefined' && ST_KO && ST_KO[s]) || SESS_KO[s] || String(s || '');
  const errMsg = (e, d) => (e && typeof e === 'object' && e.message) ? String(e.message) : (typeof e === 'string' && e) || d;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const curHub = () => HUB.hubs.find((h) => h.id === HUB.current) || null;

  /* ================= 시작 · 새로고침 ================= */
  function init() {
    const D = window.hubDesktop;
    if (!D || typeof D !== 'object' || !document.getElementById('side')) return;
    if (HUB.api === D) return;
    teardown();
    HUB.api = D;
    document.body.classList.add('hub-desktop');
    HUB.closed = store.get('hub.remote.closed', '0') === '1';
    try { HUB.closedHubs = new Set(JSON.parse(store.get('hub.remote.hubs', '[]')).map(String)); } catch { HUB.closedHubs = new Set(); }
    paintBrand(); paintRemote();
    subscribe(D, 'onHubsChanged', () => refresh({ quiet: true }));
    subscribe(D, 'onCommand', (c) => {
      const t = c && typeof c === 'object' ? c.type : c;
      if (t === 'add-hub') openAddHub();
      else if (t === 'remote-settings') openRemoteSettings();
      // 'open-session' 은 desktop.js 가 처리한다
    });
    const onFocus = () => { if (document.visibilityState === 'hidden' || !HUB.api) return; if (Date.now() - HUB.at > 3000) refresh({ quiet: true }); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    HUB.unsubs.push(() => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); });
    refresh();
  }
  function subscribe(D, name, cb) {
    if (typeof D[name] !== 'function') return;
    try { const off = D[name](cb); if (typeof off === 'function') HUB.unsubs.push(off); } catch {}
  }
  function teardown() {
    for (const off of HUB.unsubs) { try { off(); } catch {} }
    HUB.unsubs = [];
    closeHubPop(); closeDlg();
    Object.assign(HUB, { api: null, hubs: [], current: null, remote: [], loaded: false, hubsErr: '', remoteErr: '', loading: false, inflight: null, at: 0, expanded: new Set(), busy: null });
  }

  /** 허브 목록과 다른 허브의 세션을 다시 읽는다. 허브 목록은 먼저 오는 대로 위 버튼에 바로 반영한다. */
  function refresh({ quiet = false } = {}) {
    const D = HUB.api; if (!D) return Promise.resolve();
    if (HUB.inflight) return HUB.inflight;
    HUB.loading = true;
    if (!quiet) paintRemote();
    const hubsP = Promise.resolve().then(() => D.getHubs()).then((v) => {
      const o = v && typeof v === 'object' ? v : {};
      HUB.hubs = Array.isArray(o.hubs) ? o.hubs.filter((h) => h && h.id != null).map((h) => ({ ...h, id: String(h.id) })) : [];
      HUB.current = o.current == null ? null : String(o.current);
      HUB.hubsErr = '';
      paintBrand(); if (HUB.pop) paintHubPop();
    });
    const remoteP = Promise.resolve().then(() => D.remoteSessions()).then((v) => {
      HUB.remote = Array.isArray(v) ? v.filter((g) => g && g.hubId != null).map((g) => ({ ...g, hubId: String(g.hubId), sessions: Array.isArray(g.sessions) ? g.sessions : [] })) : [];
      HUB.remoteErr = '';
    });
    const run = Promise.allSettled([hubsP, remoteP]).then(([h, r]) => {
      if (h.status === 'rejected') HUB.hubsErr = errMsg(h.reason, '허브 목록을 불러오지 못했어요');
      if (r.status === 'rejected') HUB.remoteErr = errMsg(r.reason, '원격 세션을 불러오지 못했어요');
      HUB.loaded = true; HUB.loading = false; HUB.at = Date.now();
      if (HUB.inflight === run) HUB.inflight = null;
      paintAll();
    });
    HUB.inflight = run;
    return run;
  }
  function paintAll() { paintBrand(); paintRemote(); if (HUB.pop) paintHubPop(); paintManage(); }

  /* ================= 사이드바 맨 위: 허브 전환 버튼 ================= */
  function paintBrand() {
    const brand = document.querySelector('#side .side-top .brand'); if (!brand || !HUB.api) return;
    let btn = brand.querySelector('.hub-btn');
    if (!btn) {
      brand.querySelectorAll(':scope > :not(.remote-badge)').forEach((n) => n.remove());
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'hub-btn';
      btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => (HUB.pop ? closeHubPop(true) : openHubPop(btn)));
      brand.prepend(btn);
    }
    const cur = curHub();
    const name = cur ? cur.name : 'AI Hub';
    const remote = cur ? !cur.local : HUB.api.isLocalHub === false;
    const st = HUB.busy === 'switch' ? 'checking' : cur ? (cur.status || 'checking') : 'checking';
    const stText = HUB.busy === 'switch' ? '전환 중' : cur ? stKo(st) : (HUB.hubsErr || '확인 중');
    btn.innerHTML = `<span class="mark"><i></i><i></i><span class="hub-st ${st}"></span></span><span class="hub-name">${E(name)}</span>${remote ? `<span class="hub-tag">${ic('globe')}<span>원격</span></span>` : ''}${ic('down')}`;
    btn.title = `${cur ? `${name} 허브 · ${stText}${remote ? ' · 원격' : ''}\n${cur.url}` : stText}\n눌러서 허브 바꾸기`;
    btn.setAttribute('aria-label', `허브 ${name} · ${stText}${remote ? ' · 원격' : ''}. 허브 바꾸기`);
    btn.setAttribute('aria-busy', HUB.busy === 'switch' ? 'true' : 'false');
  }

  /* ---------- 허브 팝오버 ---------- */
  function openHubPop(anchor) {
    if (HUB.pop) closeHubPop();
    if (typeof S !== 'undefined' && S && S.pop && typeof closePop === 'function') closePop();
    const el = document.createElement('div');
    el.className = 'hub-pop'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', '허브');
    document.body.appendChild(el);
    HUB.pop = { el, anchor };
    anchor.classList.add('on'); anchor.setAttribute('aria-expanded', 'true');
    paintHubPop();
    el.addEventListener('click', onPopClick);
    el.addEventListener('keydown', onPopKey);
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('resize', onWinResize);
    (el.querySelector('.hub-pi[aria-checked="true"]') || el.querySelector('button.hub-pi'))?.focus({ preventScroll: true });
  }
  function closeHubPop(refocus = false) {
    const p = HUB.pop; if (!p) return;
    HUB.pop = null;
    p.el.remove();
    p.anchor.classList.remove('on'); p.anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('resize', onWinResize);
    if (refocus && p.anchor.isConnected) p.anchor.focus({ preventScroll: true });
  }
  const onWinResize = () => closeHubPop();
  function onDocDown(e) { const p = HUB.pop; if (!p) return; if (p.el.contains(e.target) || p.anchor.contains(e.target)) return; closeHubPop(); }
  function paintHubPop() {
    const p = HUB.pop; if (!p) return;
    const focused = document.activeElement?.closest?.('.hub-pi')?.dataset.key || '';
    const rows = ['<div class="ph">허브</div>'];
    if (!HUB.hubs.length) {
      rows.push(`<div class="hub-pi off" aria-disabled="true"><span class="pic">${ic(HUB.hubsErr ? 'alert' : 'clock')}</span><div class="l"><b>${HUB.hubsErr ? '허브 목록을 불러오지 못했어요' : '허브 목록을 불러오는 중'}</b>${HUB.hubsErr ? `<span>${E(HUB.hubsErr)}</span>` : ''}</div></div>`);
    }
    for (const h of HUB.hubs) {
      const cur = h.id === HUB.current; const st = h.status || 'checking';
      const tip = cur ? '지금 보고 있는 허브' : st === 'offline' ? `연결 안 됨${h.error ? ` · ${h.error}` : ''}` : `${h.name} 허브로 전환`;
      rows.push(`<button type="button" class="hub-pi ${st === 'offline' ? 'off' : ''}" role="menuitemradio" aria-checked="${cur}" data-hp="switch" data-key="${E(h.id)}" title="${E(tip)}"><span class="pic"><i class="hub-dot ${st}"></i></span><div class="l"><b>${E(h.name)}</b><span>${E(host(h.url))} · ${E(stKo(st))}</span></div>${cur ? `<span class="ck">${ic('check')}</span>` : ''}</button>`);
    }
    rows.push('<div class="psep"></div>');
    rows.push(`<button type="button" class="hub-pi" role="menuitem" data-hp="add" data-key="add"><span class="pic">${ic('plus')}</span><div class="l"><b>원격 허브 추가…</b></div></button>`);
    rows.push(`<button type="button" class="hub-pi" role="menuitem" data-hp="manage" data-key="manage"><span class="pic">${ic('gear')}</span><div class="l"><b>허브 관리…</b></div></button>`);
    rows.push(`<button type="button" class="hub-pi" role="menuitem" data-hp="settings" data-key="settings"><span class="pic">${ic('globe')}</span><div class="l"><b>원격 접속 설정</b><span>이 허브를 다른 PC에서 열 수 있게</span></div></button>`);
    p.el.innerHTML = rows.join('');
    const r = p.anchor.getBoundingClientRect(); const w = p.el.offsetWidth, hgt = p.el.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 6; if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    p.el.style.left = `${left}px`; p.el.style.top = `${Math.max(8, top)}px`;
    if (focused) p.el.querySelector(`.hub-pi[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }
  function onPopClick(e) {
    const b = e.target.closest('[data-hp]'); if (!b) return;
    const act = b.dataset.hp; const anchor = HUB.pop?.anchor;
    if (act === 'switch') { const id = b.dataset.key; closeHubPop(true); if (id !== HUB.current) switchTo(id); }
    else if (act === 'add') { closeHubPop(); openAddHub(anchor); }
    else if (act === 'manage') { closeHubPop(); openManage(anchor); }
    else if (act === 'settings') { closeHubPop(); openRemoteSettings(); }
  }
  function onPopKey(e) {
    const p = HUB.pop; if (!p) return;
    const items = [...p.el.querySelectorAll('button.hub-pi')]; const i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHubPop(true); }
    else if (e.key === 'Tab') closeHubPop(true);
  }
  async function switchTo(id, sessionId = null, el = null) {
    const D = HUB.api; if (!D || HUB.busy) return;
    HUB.busy = 'switch';
    if (el) { el.classList.add('busy'); el.setAttribute('aria-busy', 'true'); }
    paintBrand();
    try {
      await D.switchHub(id, sessionId ? { sessionId } : {});
      if (typeof closeOverlays === 'function') closeOverlays();
    } catch (err) {
      say(errMsg(err, '허브로 전환하지 못했어요'), true);
    } finally {
      HUB.busy = null;
      if (el) { el.classList.remove('busy'); el.removeAttribute('aria-busy'); }
      paintBrand();
    }
  }
  function openRemoteSettings() {
    closeHubPop(); closeDlg();
    if (typeof openSettings === 'function') openSettings('remoteSec');
    else say('설정 화면을 열 수 없어요', true);
  }

  /* ================= 사이드바: 원격 세션 구역 ================= */
  function remoteBox() {
    let box = document.getElementById('hubRemote');
    if (!box) {
      const side = document.getElementById('side'); if (!side) return null;
      box = document.createElement('div'); box.id = 'hubRemote';
      const bottom = side.querySelector('.side-bottom');
      if (bottom) bottom.before(box); else side.appendChild(box);
    }
    if (!box.dataset.hubBound) {
      box.dataset.hubBound = '1';
      box.setAttribute('aria-label', '원격 세션');
      box.addEventListener('click', onRemoteClick);
      box.addEventListener('keydown', onRemoteKey);
    }
    return box;
  }
  const sortSessions = (list) => list.map((s, i) => [s, i]).sort((a, b) => (b[0].pinned ? 1 : 0) - (a[0].pinned ? 1 : 0) || a[1] - b[1]).map((x) => x[0]);

  function paintRemote() {
    if (!HUB.api) return;
    const box = remoteBox(); if (!box) return;
    box.hidden = false;
    const groups = HUB.remote;
    const anyRemote = HUB.hubs.some((h) => !h.local) || groups.length > 0;
    if (!HUB.loaded) {
      box.className = '';
      box.innerHTML = secHead(0) + '<div class="hub-sec-b"><div class="rm-skel" aria-hidden="true"><i></i><i></i></div></div>';
      return;
    }
    if (!anyRemote && !HUB.remoteErr && !HUB.hubsErr) {
      box.className = 'lite';
      box.innerHTML = `<button type="button" class="hub-empty" data-h="add" title="다른 PC에서 실행 중인 허브를 Tailscale 주소로 등록해요">${ic('globe')}<span>다른 PC의 허브 연결</span></button>`;
      return;
    }
    const total = groups.reduce((a, g) => a + (g.online ? g.sessions.length : 0), 0);
    box.className = HUB.closed ? 'closed' : '';
    if (HUB.closed) { box.innerHTML = secHead(total); return; }
    let body = '';
    const err = HUB.remoteErr || HUB.hubsErr;
    if (err) body += `<div class="hub-note">${ic('alert')}<span>${E(err)}</span><button type="button" class="rm-link" data-h="refresh">다시 시도</button></div>`;
    for (const g of groups) body += groupHtml(g);
    if (!groups.length && !err) body += '<div class="empty-row">보여 줄 다른 허브가 없어요</div>';
    box.innerHTML = secHead(total) + `<div class="hub-sec-b">${body}</div>`;
  }
  function secHead(total) {
    return `<div class="hub-sec-h"><button type="button" class="sec-t" data-h="toggle" aria-expanded="${!HUB.closed}">원격 세션${total ? `<span class="hub-cnt">${total}</span>` : ''}<span class="chev">${ic('down')}</span></button>
      <button type="button" class="sec-btn" data-h="refresh" title="다시 확인" aria-label="원격 세션 다시 확인" aria-busy="${HUB.loading ? 'true' : 'false'}">${ic('refresh')}</button>
      <button type="button" class="sec-btn" data-h="add" title="원격 허브 추가" aria-label="원격 허브 추가">${ic('plus')}</button></div>`;
  }
  function groupHtml(g) {
    const id = g.hubId; const closed = HUB.closedHubs.has(id); const online = !!g.online;
    const name = g.hubName || id;
    const list = sortSessions(g.sessions);
    const running = list.filter((s) => s.status === 'running').length;
    const tip = `${name} 허브 · ${online ? '연결됨' : '연결 안 됨'}${g.error ? `\n${g.error}` : ''}`;
    const meta = running ? `<span class="spin-xs" title="${running}개 작업 중"></span>`
      : online ? `<span class="gcount">${list.length || ''}</span>` : '<span class="hub-off">연결 안 됨</span>';
    const act = online ? `<button type="button" class="mini" data-h="open" data-hub="${E(id)}" title="${E(name)} 허브로 전환">${ic('open')}</button>`
      : `<button type="button" class="mini" data-h="refresh" title="다시 연결 확인">${ic('refresh')}</button>`;
    let h = `<div class="group"><div class="ghead hub-ghead ${closed ? 'closed' : ''} ${online ? '' : 'off'}" title="${E(tip)}">
      <button type="button" class="hub-gt" data-h="hub" data-hub="${E(id)}" aria-expanded="${!closed}"><span class="chev">${ic('right')}</span><span class="g-ic"><i class="hub-dot ${online ? 'online' : 'offline'}"></i></span><span class="gname">${E(name)}</span></button>${meta}<span class="gacts">${act}</span></div>`;
    if (!closed) {
      h += '<div class="gbody">';
      if (!online) h += `<div class="hub-offrow" title="${E(g.error || '')}">${ic('alert')}<span>연결 안 됨${g.error ? ` · ${E(g.error)}` : ''}</span><button type="button" class="rm-link" data-h="refresh">${ic('refresh')}<span>다시 시도</span></button></div>`;
      else if (!list.length) h += '<div class="empty-row">아직 세션 없음</div>';
      else {
        const open = HUB.expanded.has(id); const show = open ? list : list.slice(0, FIRST);
        h += show.map((s) => rowHtml(g, s)).join('');
        if (list.length > show.length) h += `<button type="button" class="hub-more" data-h="more" data-hub="${E(id)}">${list.length - show.length}개 더 보기</button>`;
        else if (open && list.length > FIRST) h += `<button type="button" class="hub-more" data-h="less" data-hub="${E(id)}">접기</button>`;
      }
      h += '</div>';
    }
    return h + '</div>';
  }
  function rowHtml(g, s) {
    const st = String(s.status || '');
    const sic = st === 'running' ? '<span class="spin-xs"></span>'
      : st === 'failed' ? `<span class="c-err">${ic('alert')}</span>`
      : st === 'partial' ? `<span class="c-warn">${ic('alert')}</span>`
      : s.pinned ? `<span class="c-muted" title="고정된 세션">${ic('pin')}</span>` : '';
    const title = s.title || '새 세션';
    let at = ''; try { at = s.updatedAt ? new Date(s.updatedAt).toLocaleString('ko-KR') : ''; } catch {}
    const tip = `${title}\n${s.cwd || ''}\n${sessKo(st)}${at ? ` · ${at}` : ''}${s.pinned ? ' · 고정됨' : ''}\n${g.hubName || g.hubId} 허브에서 열기`;
    return `<button type="button" class="sess hub-sess" data-h="sess" data-hub="${E(g.hubId)}" data-sid="${E(s.id)}" title="${E(tip)}"><span class="s-ic">${sic}</span><span class="t">${E(title)}</span><span class="meta ${st === 'running' ? 'run' : ''}">${st === 'running' ? '작업 중' : E(when(s.updatedAt))}</span></button>`;
  }
  function onRemoteClick(e) {
    const b = e.target.closest('[data-h]'); if (!b) return;
    const act = b.dataset.h; const hub = b.dataset.hub;
    if (act === 'toggle') { HUB.closed = !HUB.closed; store.set('hub.remote.closed', HUB.closed ? '1' : '0'); return paintRemote(); }
    if (act === 'refresh') return refresh();
    if (act === 'add') return openAddHub(b);
    if (act === 'hub') {
      if (HUB.closedHubs.has(hub)) HUB.closedHubs.delete(hub); else HUB.closedHubs.add(hub);
      store.set('hub.remote.hubs', JSON.stringify([...HUB.closedHubs]));
      paintRemote();
      return document.querySelector(`#hubRemote .hub-gt[data-hub="${CSS.escape(hub)}"]`)?.focus({ preventScroll: true });
    }
    if (act === 'more') { HUB.expanded.add(hub); return paintRemote(); }
    if (act === 'less') { HUB.expanded.delete(hub); return paintRemote(); }
    if (act === 'open') return switchTo(hub, null, b);
    if (act === 'sess') return switchTo(hub, b.dataset.sid, b);
  }
  function onRemoteKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...e.currentTarget.querySelectorAll('.hub-gt, .hub-sess, .hub-more')];
    const i = items.indexOf(document.activeElement); if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  }

  /* ================= 창 (<dialog>) ================= */
  function openDlg({ kind, title, cls = '', body, foot, opener }) {
    closeDlg(); closeHubPop();
    const d = document.createElement('dialog');
    d.className = `hub-dlg ${cls}`.trim();
    d.setAttribute('aria-labelledby', 'hubDlgTitle');
    d.innerHTML = `<form novalidate><div class="hub-dlg-h"><b id="hubDlgTitle">${E(title)}</b><span class="grow"></span><button type="button" class="icon-btn" data-d="close" title="닫기" aria-label="닫기">${ic('x')}</button></div><div class="hub-dlg-b">${body}</div><div class="hub-dlg-f">${foot}</div></form>`;
    document.body.appendChild(d);
    const openerEl = opener && typeof opener.focus === 'function' ? opener : (document.activeElement !== document.body ? document.activeElement : null);
    HUB.dlg = { kind, el: d, opener: openerEl, token: {}, lock: false };
    d.addEventListener('cancel', (e) => { e.preventDefault(); if (!HUB.dlg?.lock) closeDlg(); });
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-d="close"]')) closeDlg(); });
    d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' && !HUB.dlg?.lock) { e.preventDefault(); closeDlg(); } });
    try { d.showModal(); } catch { d.setAttribute('open', ''); }
    return d;
  }
  function closeDlg() {
    const x = HUB.dlg; if (!x) return;
    HUB.dlg = null;
    try { x.el.close(); } catch {}
    x.el.remove();
    if (x.opener?.isConnected) { try { x.opener.focus({ preventScroll: true }); } catch {} }
  }
  function dlgMsg(text, err = false) {
    const m = HUB.dlg?.el.querySelector('.hub-msg'); if (!m) return;
    m.textContent = text; m.className = `hub-msg ${err ? 'err' : 'ok'}`;
    clearTimeout(dlgMsg.t); dlgMsg.t = setTimeout(() => { if (m.isConnected) m.textContent = ''; }, 3200);
  }

  /* ---------- 원격 허브 추가 ---------- */
  function openAddHub(opener) {
    if (!HUB.api) return;
    const d = openDlg({
      kind: 'add', title: '원격 허브 추가', opener,
      body: `<div class="hub-field"><label for="hubAddName">이름</label><input id="hubAddName" class="hub-in" maxlength="40" placeholder="예: 집 PC" autocomplete="off" spellcheck="false"><div class="hub-ferr" id="hubAddNameErr" role="alert"></div></div>
        <div class="hub-field"><label for="hubAddUrl">주소</label><input id="hubAddUrl" class="hub-in mono" placeholder="https://기기이름.tailnet이름.ts.net" autocomplete="off" spellcheck="false" autocapitalize="off" inputmode="url"><div class="hub-ferr" id="hubAddUrlErr" role="alert"></div></div>
        <ul class="hub-tips">
          <li>${ic('globe')}<span>주소는 <code>https://기기이름.tailnet이름.ts.net</code> 형식이에요. 상대 PC 허브의 설정 › 원격 접속 화면에 적혀 있어요.</span></li>
          <li>${ic('bolt')}<span>상대 PC의 허브에서 <b>원격 접속</b>이 켜져 있어야 해요.</span></li>
          <li>${ic('check')}<span>두 기기 모두 <b>같은 Tailscale 계정</b>으로 로그인되어 있어야 해요.</span></li>
        </ul>`,
      foot: `<span class="grow"></span><button type="button" class="btn" data-d="close">취소</button><button type="submit" class="btn primary" id="hubAddGo">${ic('plus')}연결</button>`,
    });
    const form = d.querySelector('form'); const name = d.querySelector('#hubAddName'); const url = d.querySelector('#hubAddUrl');
    const nErr = d.querySelector('#hubAddNameErr'); const uErr = d.querySelector('#hubAddUrlErr'); const go = d.querySelector('#hubAddGo');
    const setErr = (el, box, msg) => { box.innerHTML = msg ? `${ic('alert')}<span>${E(msg)}</span>` : ''; el.classList.toggle('bad', !!msg); el.setAttribute('aria-invalid', msg ? 'true' : 'false'); };
    name.addEventListener('input', () => setErr(name, nErr, ''));
    url.addEventListener('input', () => setErr(url, uErr, ''));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const n = name.value.trim(); let u = url.value.trim();
      setErr(name, nErr, ''); setErr(url, uErr, '');
      if (!u) { setErr(url, uErr, '주소를 입력해 주세요'); url.focus(); return; }
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && /^[\w.-]+(?::\d+)?\/?$/.test(u)) u = `https://${u}`;
      const token = HUB.dlg?.token;
      go.disabled = true; name.disabled = url.disabled = true;
      go.innerHTML = '<span class="spinner"></span>연결 확인 중…'; go.setAttribute('aria-busy', 'true');
      try {
        const hub = await HUB.api.addHub({ name: n, url: u });
        if (HUB.dlg?.token !== token) return;
        closeDlg();
        say(`${(hub && hub.name) || n || '새'} 허브를 추가했어요`);
        refresh({ quiet: true });
      } catch (err) {
        if (HUB.dlg?.token !== token) return;
        const msg = errMsg(err, '허브를 추가하지 못했어요');
        if (/이름/.test(msg)) { setErr(name, nErr, msg); name.focus(); } else { setErr(url, uErr, msg); url.focus(); url.select(); }
      } finally {
        if (HUB.dlg?.token === token) { go.disabled = false; name.disabled = url.disabled = false; go.innerHTML = `${ic('plus')}연결`; go.removeAttribute('aria-busy'); }
      }
    });
    name.focus();
  }

  /* ---------- 허브 관리 ---------- */
  function openManage(opener) {
    if (!HUB.api) return;
    const d = openDlg({
      kind: 'manage', cls: 'wide', title: '허브 관리', opener,
      body: `<div class="hub-list" id="hubList" role="list"></div><p class="fine">원격 허브는 Tailscale 주소(…ts.net)로만 등록할 수 있어요. 등록을 해제해도 그 PC의 허브와 세션은 그대로 남아요.</p>`,
      foot: `<button type="button" class="btn" data-d="add">${ic('plus')}원격 허브 추가</button><span class="hub-msg" aria-live="polite"></span><span class="grow"></span><button type="button" class="btn" data-d="close">닫기</button>`,
    });
    d.addEventListener('click', onManageClick);
    paintManage();
    (d.querySelector('.hub-row .icon-btn') || d.querySelector('[data-d="add"]'))?.focus({ preventScroll: true });
  }
  function paintManage(force = false) {
    const x = HUB.dlg; if (!x || x.kind !== 'manage') return;
    const list = x.el.querySelector('#hubList'); if (!list) return;
    if (!force && list.querySelector('input')) return; // 이름을 바꾸는 중이면 그대로 둔다
    list.innerHTML = HUB.hubs.map(manageRow).join('') || `<div class="empty-row">${E(HUB.hubsErr || '허브 목록을 불러오는 중…')}</div>`;
  }
  function manageRow(h) {
    const cur = h.id === HUB.current; const st = h.status || 'checking';
    return `<div class="hub-row" role="listitem" data-id="${E(h.id)}"><i class="hub-dot ${st}" title="${E(stKo(st))}"></i>
      <div class="hub-row-main"><div class="hub-row-t"><b class="hub-nm">${E(h.name)}</b>${cur ? '<span class="hub-chip cur">현재</span>' : ''}${h.local ? '<span class="hub-chip">이 PC</span>' : ''}</div>
      <div class="hub-row-s"><span class="mono" title="${E(h.url)}">${E(host(h.url))}</span><span>·</span><span class="${st === 'offline' ? 'c-err' : ''}" title="${E(h.error || '')}">${E(stKo(st))}${st === 'offline' && h.error ? ` · ${E(h.error)}` : ''}</span></div></div>
      <div class="hub-row-acts"><button type="button" class="icon-btn" data-m="rename" title="이름 바꾸기" aria-label="${E(h.name)} 이름 바꾸기">${ic('pencil')}</button>
      <button type="button" class="icon-btn ${h.local ? 'off' : ''}" data-m="remove" ${h.local ? 'aria-disabled="true"' : ''} title="${h.local ? '이 PC 허브는 해제할 수 없어요' : '등록 해제'}" aria-label="${E(h.name)} ${h.local ? '해제 불가' : '등록 해제'}">${ic('trash')}</button></div></div>`;
  }
  async function onManageClick(e) {
    const x = HUB.dlg; if (!x || x.kind !== 'manage') return;
    if (e.target.closest('[data-d="add"]')) { const op = x.opener; closeDlg(); return openAddHub(op); }
    const b = e.target.closest('[data-m]'); if (!b) return;
    const row = b.closest('.hub-row'); const hub = HUB.hubs.find((h) => h.id === row?.dataset.id); if (!hub) return;
    if (b.dataset.m === 'rename') return renameRow(row, hub);
    if (b.dataset.m === 'remove') {
      if (hub.local) return dlgMsg('이 PC 허브는 해제할 수 없어요', true);
      if (!confirm(`"${hub.name}" 허브 등록을 해제할까요?\n그 PC의 허브와 세션은 그대로 남고, 이 프로그램의 목록에서만 빠져요.`)) return;
      b.setAttribute('aria-busy', 'true');
      try { await HUB.api.removeHub(hub.id); if (HUB.dlg === x) dlgMsg(`${hub.name} 허브 등록을 해제했어요`); await refresh({ quiet: true }); }
      catch (err) { if (HUB.dlg === x) { dlgMsg(errMsg(err, '해제하지 못했어요'), true); b.removeAttribute('aria-busy'); } }
    }
  }
  function renameRow(row, hub) {
    const x = HUB.dlg; const nm = row.querySelector('.hub-nm'); if (!x || !nm || row.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.className = 'hub-in'; inp.value = hub.name; inp.maxLength = 40; inp.setAttribute('aria-label', `${hub.name} 허브의 새 이름`);
    nm.replaceWith(inp); x.lock = true; inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true; x.lock = false;
      const v = inp.value.trim();
      if (!save || !v || v === hub.name) { paintManage(true); return; }
      inp.disabled = true;
      try { await HUB.api.renameHub(hub.id, v); hub.name = v; if (HUB.dlg === x) dlgMsg('이름을 바꿨어요'); }
      catch (err) { if (HUB.dlg === x) dlgMsg(errMsg(err, '이름을 바꾸지 못했어요'), true); }
      if (HUB.dlg === x) paintManage(true);
      refresh({ quiet: true });
    };
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  /* ================= 노출 · 시작 ================= */
  window.hubsUI = { init, refresh };
  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('hubdesktop-ready', init);
  if (document.readyState !== 'loading') init();
})();
