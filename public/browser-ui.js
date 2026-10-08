/* ODDIN 브라우저 보기 (2026-10-08 개선안 7번 "AI가 쓰는 브라우저를 오딘 화면에서 보기") — 서버 lib/browser.mjs
   - 오른쪽 패널 "브라우저" 탭: 탭 목록(어느 작업이 쓰는지)·실시간 화면·주소창·뒤로/새로고침·키 입력·최근 동작 기록
   - "크게 보기": 화면을 크게 띄워 직접 조작(누르기·굴리기·글자 입력 — 화면을 누른 뒤 키보드로 바로 입력, 한글은 "글자 보내기" 칸)
   - 작업 카드: 그 작업이 브라우저를 쓰고 있으면 "브라우저 보기" 버튼
   - 실시간 화면은 보이는 동안에만 그림을 다시 받는다(/api/browser/frame, 앞 그림을 다 받은 뒤 약 0.6초마다). 원격·폰에서도 같다.
   - 다시 그릴 때 화면 그림·주소창에 치던 글은 그대로 둔다(부분만 고침). */
(() => {
  if (document.documentElement.classList.contains('embed')) return;
  if (!IC.browser) IC.browser = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/>';
  const B = { state: null, tab: null, timer: 0, loading: 0, enabled: true, src: '' };
  const tabs = () => B.state?.tabs || [];
  const cur = () => tabs().find((t) => t.id === B.tab) || tabs().at(-1) || null;
  const jobOf = (owner) => { const jid = String(owner || '').split('/')[0]; return S.jobs.get(jid) || [...S.jobs.values()].find((j) => String(j.id).endsWith(`-${jid}`)) || null; };
  function ownerLabel(owner) {
    if (!owner) return '';
    if (owner === '사용자' || String(owner).startsWith('user')) return '직접 연 탭';
    const j = jobOf(owner), tid = String(owner).split('/')[1], t = j?.tasks?.find((x) => x.id === tid);
    if (!j) return 'AI 작업';
    return `${t?.title || (j.goal || '').split('\n')[0] || '작업'}${t?.assignee ? ` · ${t.assignee === 'claude' ? 'Claude' : 'Codex'}` : ''}`;
  }
  const whoShort = (owner) => (owner === '크롬' ? '크롬' : owner === '사용자' ? '나' : String(owner).startsWith('user') ? '나' : (jobOf(owner)?.tasks?.find((x) => x.id === String(owner).split('/')[1])?.assignee === 'codex' ? 'Codex' : jobOf(owner) ? 'Claude' : 'AI'));
  const ACT_KO = { open: '열기', read: '읽기', snapshot: '읽기', click: '누르기', type: '입력', press: '키', scroll: '스크롤', screenshot: '화면 찍기', eval: '스크립트', back: '뒤로', forward: '앞으로', reload: '새로고침', wait: '기다리기', close: '닫기', text: '글자', key: '키', connect: '연결' };
  // 크롬 연결(서버 lib/chrome-ext.mjs, 확장 chrome-extension/): 사용자 크롬(로그인된 상태)에 깐 ODDIN 확장이 붙어 있는지
  const chromeChip = () => { const c = B.state?.chrome; if (!c) return ''; return `<small class="bw-chrome ${c.connected ? 'on' : ''}" title="${c.connected ? `${esc(c.browser || '크롬')}의 ODDIN 확장이 연결됐어요 — AI가 로그인된 크롬에서 탭을 열 수 있어요` : '크롬에 ODDIN 확장을 깔고 켜 두면 AI가 로그인된 크롬을 쓸 수 있어요(ODDIN 폴더 chrome-extension)'}">${c.connected ? '크롬 연결됨' : '크롬 연결 안 됨'}</small>`; };

  async function load() {
    try { B.state = await api('/api/browser'); B.enabled = true; } catch (e) { B.enabled = !/꺼져 있어요/.test(e.message); B.state = null; }
    if (!cur() && tabs().length) B.tab = tabs().at(-1).id;
    paint();
  }
  function send(b) {
    const body = { tab: cur()?.id || 'new', ...b };
    return api('/api/browser/input', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => { if (r?.id) B.tab = r.id; B.loading = 0; tick(); })
      .catch((e) => toast(e.message, true));
  }

  /* ---------- 그리기: 뼈대 한 번 + 부분 고치기 ---------- */
  const shell = (big) => `<div class="bw ${big ? 'big' : ''}"><div class="bw-head"></div><div class="bw-tabs"></div><div class="bw-main"></div><ul class="bw-log"></ul></div>`;
  const headHtml = (big) => `<span class="bw-dot ${B.state?.running ? 'on' : ''}"></span><b>ODDIN 브라우저</b><small class="c-muted">${B.state?.running ? `탭 ${tabs().length}개` : '꺼져 있어요 · AI가 쓰면 저절로 켜져요'}</small>${chromeChip()}<span class="grow"></span>${B.state?.running ? '' : `<button type="button" class="btn sm" data-bw="start">켜기</button>`}${big ? '' : `<button type="button" class="icon-btn" data-bw="big" title="크게 보기">${icon('expand')}</button>`}`;
  const tabsHtml = () => {
    const t = cur();
    return tabs().map((x) => `<button type="button" class="bw-tab ${x.id === t?.id ? 'on' : ''}" data-bw-tab="${esc(x.id)}" title="${esc(x.url)}"><b>${esc(x.title || x.url || '빈 탭')}</b><small>${x.where === 'chrome' ? '크롬 · ' : ''}${esc(ownerLabel(x.owner))}</small></button>`).join('') + (B.state?.running ? `<button type="button" class="bw-tab add" data-bw="newtab" title="새 탭">${icon('plus')}</button>` : '');
  };
  const KEYBTN = { Enter: '↵ Enter', Tab: 'Tab', Escape: 'Esc', Backspace: '⌫' };
  const mainHtml = (t) => t
    ? `<form class="bw-bar" data-bw-go><button type="button" class="icon-btn" data-bw="back" title="뒤로">${icon('left')}</button><button type="button" class="icon-btn" data-bw="reload" title="새로고침">${icon('refresh')}</button><input name="u" value="${esc(t.url || '')}" spellcheck="false" autocomplete="off" aria-label="주소" enterkeyhint="go"><button type="button" class="icon-btn" data-bw="close" title="이 탭 닫기">${icon('x')}</button></form>
      <div class="bw-view" tabindex="0" title="누르면 그 자리를 눌러요. 굴리면 스크롤. 누른 뒤 키보드로 바로 입력할 수 있어요"><img class="bw-img" alt="브라우저 화면" ${B.src ? `src="${esc(B.src)}"` : ''}><span class="bw-wait">불러오는 중…</span></div>
      <div class="bw-keys"><input class="bw-text" placeholder="글자 보내기 (먼저 입력 칸을 누르세요)" aria-label="보낼 글자" enterkeyhint="send"><button type="button" class="btn sm" data-bw="text">보내기</button>${Object.entries(KEYBTN).map(([k, l]) => `<button type="button" class="btn sm ghost" data-bw-key="${k}">${l}</button>`).join('')}</div>`
    : `<div class="bw-empty">${icon('browser')}<p>${B.enabled ? 'AI가 웹 페이지를 열면 여기서 실시간으로 보여요.<br>직접 보려면 주소를 넣으세요.' : 'ODDIN 브라우저가 꺼져 있어요(설정 browser.oddin).'}</p>${B.enabled ? `<form class="bw-bar" data-bw-go><input name="u" placeholder="주소 (예: wowhead.com)" spellcheck="false" autocomplete="off" aria-label="주소" enterkeyhint="go"><button type="submit" class="btn sm">열기</button></form>` : ''}</div>`;
  const logHtml = () => (B.state?.log || []).slice(-8).reverse().map((e) => `<li><span class="who ${whoShort(e.owner) === '나' ? 'me' : ''}">${esc(whoShort(e.owner))}</span><span class="act">${esc(ACT_KO[e.action] || e.action)}</span><span class="det">${esc(e.detail || '')}</span><time>${typeof hm === 'function' ? hm(e.at) : ''}</time></li>`).join('');

  function paintRoot(root, big) {
    if (!root.querySelector(':scope > .bw')) { root.innerHTML = shell(big); bind(root); }
    const t = cur();
    root.querySelector('.bw-head').innerHTML = headHtml(big);
    const tb = root.querySelector('.bw-tabs'); tb.innerHTML = tabsHtml(); tb.hidden = !tabs().length;
    const main = root.querySelector('.bw-main'), key = t ? `tab:${t.id}` : `empty:${B.enabled}`;
    if (main.dataset.key !== key) { main.dataset.key = key; main.innerHTML = mainHtml(t); bindMain(main); }
    else if (t) { const u = main.querySelector('input[name=u]'); if (u && document.activeElement !== u) u.value = t.url || ''; }
    const lg = root.querySelector('.bw-log'); lg.innerHTML = logHtml(); lg.hidden = !lg.innerHTML;
  }
  function paint() {
    const body = document.getElementById('inspBody');
    if (body && S.insp?.tab === 'browser' && typeof inspOpen === 'function' && inspOpen()) paintRoot(body, false);
    const big = document.getElementById('bwBig');
    if (big && !big.hidden) paintRoot(big.querySelector('.bw-wrap'), true);
    tick();
  }
  // 위쪽 단추·탭(바뀌지 않는 뼈대에 한 번만 건다)
  function bind(root) {
    root.addEventListener('click', async (e) => {
      const tb = e.target.closest('[data-bw-tab]'); if (tb) { B.tab = tb.dataset.bwTab; B.src = ''; return paint(); }
      const b = e.target.closest('[data-bw]'); if (!b) return;
      const a = b.dataset.bw;
      if (a === 'big') return openBig();
      if (a === 'start') { b.disabled = true; try { B.state = await api('/api/browser/start', { method: 'POST', body: '{}' }); paint(); } catch (err) { toast(err.message, true); b.disabled = false; } return; }
      if (a === 'newtab') { B.src = ''; return send({ type: 'open', url: 'about:blank', tab: 'new' }); }
      if (a === 'text') { const x = root.querySelector('.bw-text'); if (x?.value) { send({ type: 'text', text: x.value }); x.value = ''; } return; }
      if (a === 'close' && !confirm('이 탭을 닫을까요? AI가 쓰던 탭이면 AI가 다시 열어야 해요.')) return;
      send({ type: a });
    });
  }
  function bindMain(main) {
    main.querySelectorAll('[data-bw-go]').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); const u = f.u.value.trim(); if (!u) return; f.u.blur(); send({ type: 'open', url: u, ...(cur() ? {} : { tab: 'new' }) }); }; });
    main.querySelectorAll('input[name=u]').forEach((u) => { u.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); u.form.requestSubmit(); } }; });
    main.querySelectorAll('[data-bw-key]').forEach((b) => { b.onclick = () => send({ type: 'key', key: b.dataset.bwKey }); });
    const text = main.querySelector('.bw-text');
    if (text) text.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (text.value) { send({ type: 'text', text: text.value }); text.value = ''; } else send({ type: 'key', key: 'Enter' }); } };
    const view = main.querySelector('.bw-view'), img = main.querySelector('.bw-img');
    if (!view || !img) return;
    img.onload = () => { B.loading = 0; view.classList.add('ready'); };
    img.onerror = () => { B.loading = 0; };
    if (img.complete && img.naturalWidth) view.classList.add('ready');
    view.onclick = (e) => {
      if (!img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      const x = (e.clientX - r.left) * (img.naturalWidth / r.width), y = (e.clientY - r.top) * (img.naturalHeight / r.height);
      if (x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) return;
      view.focus({ preventScroll: true }); ripple(view, e.clientX - view.getBoundingClientRect().left, e.clientY - view.getBoundingClientRect().top);
      send({ type: 'click', x: Math.round(x), y: Math.round(y) });
    };
    view.addEventListener('wheel', (e) => { e.preventDefault(); clearTimeout(view.wt); view.dy = (view.dy || 0) + e.deltaY; view.wt = setTimeout(() => { send({ type: 'scroll', dy: Math.round(view.dy) }); view.dy = 0; }, 120); }, { passive: false });
    // 폰: 손가락으로 위아래 밀면 스크롤
    let ty = null;
    view.addEventListener('touchstart', (e) => { ty = e.touches[0]?.clientY ?? null; }, { passive: true });
    view.addEventListener('touchend', (e) => { const y = e.changedTouches[0]?.clientY; if (ty != null && y != null && Math.abs(ty - y) > 30) { e.preventDefault(); const r = img.getBoundingClientRect(); send({ type: 'scroll', dy: Math.round((ty - y) * (img.naturalHeight / (r.height || 1))) }); } ty = null; });
    view.onkeydown = (e) => {
      if (e.isComposing || e.key === 'Process') return; // 한글 조합은 아래 칸으로
      const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean);
      const special = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key);
      if (mods.length && /^[a-z0-9]$/i.test(e.key)) { e.preventDefault(); e.stopPropagation(); return send({ type: 'key', key: [...mods, e.key.toLowerCase()].join('+') }); }
      if (special) { e.preventDefault(); e.stopPropagation(); return send({ type: 'key', key: [...mods, e.shiftKey && e.key === 'Tab' ? 'Shift' : '', e.key].filter(Boolean).join('+') }); }
      if (e.key.length === 1 && !mods.length) { e.preventDefault(); e.stopPropagation(); send({ type: 'text', text: e.key }); }
    };
  }
  function ripple(view, x, y) { const d = document.createElement('i'); d.className = 'bw-ripple'; d.style.left = `${x}px`; d.style.top = `${y}px`; view.appendChild(d); setTimeout(() => d.remove(), 500); }

  // 실시간 화면: 보이는 보기 창의 그림만 다시 받는다(앞 그림을 다 받은 뒤에 다음 것)
  function tick() {
    clearTimeout(B.timer);
    const imgs = [...document.querySelectorAll('.bw-img')].filter((i) => i.offsetParent !== null);
    const t = cur();
    if (B.loading && Date.now() - B.loading > 6000) B.loading = 0; // 응답이 안 오면 다시
    if (t && imgs.length && !document.hidden && B.state?.running && !B.loading) {
      B.loading = Date.now(); B.src = `/api/browser/frame?tab=${encodeURIComponent(t.id)}&t=${Date.now()}`;
      imgs.forEach((i) => { i.src = B.src; });
    }
    B.timer = setTimeout(tick, imgs.length ? 600 : 2500);
  }
  function openBig(tabId) {
    if (tabId && tabId !== B.tab) { B.tab = tabId; B.src = ''; }
    let el = document.getElementById('bwBig');
    if (!el) {
      el = document.createElement('div'); el.id = 'bwBig'; el.hidden = true;
      el.innerHTML = `<div class="bw-big-box" role="dialog" aria-label="ODDIN 브라우저"><button type="button" class="icon-btn bw-big-x" title="닫기 (Esc)">${icon('x')}</button><div class="bw-wrap"></div></div>`;
      document.body.appendChild(el);
      el.querySelector('.bw-big-x').onclick = () => { el.hidden = true; };
      el.addEventListener('mousedown', (e) => { if (e.target === el) el.hidden = true; });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden && !e.target.closest?.('.bw-view')) el.hidden = true; });
    }
    el.hidden = false; paint(); load();
  }
  window.hubBrowser = { open: openBig, load };

  /* ---------- 오른쪽 패널 탭 · 작업 카드 · 검색 팔레트 ---------- */
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'browser', label: '브라우저', icon: 'browser', render(body) { paintRoot(body, false); if (!B.state) load(); else tick(); } });
  const tabsOfJob = (j) => { const id = String(j.id).replace(/^rm-[A-Za-z0-9]+-/, ''); return tabs().filter((t) => String(t.owner || '').split('/')[0] === id); };
  window.hubJobExtras = window.hubJobExtras || [];
  window.hubJobExtras.push((j) => {
    const mine = tabsOfJob(j); if (!mine.length || String(j.id).startsWith('rm-')) return '';
    const t = mine.at(-1);
    return `<div class="handoff-row bw-job">${icon('browser')}<span class="t"><b>브라우저 사용 중</b> · ${esc(t.title || t.url || '')}</span><button type="button" class="btn" data-bw-open="${esc(t.id)}">보기</button></div>`;
  });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-bw-open]'); if (b) { e.preventDefault(); openBig(b.dataset.bwOpen); } });
  window.hubCommands = window.hubCommands || [];
  window.hubCommands.push(() => [{ label: 'ODDIN 브라우저 보기', desc: `AI가 쓰는 브라우저 · 탭 ${tabs().length}개`, icon: 'browser', run: () => openBig() }]);

  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'browser') {
      const before = new Set(tabs().map((t) => t.id));
      B.state = { running: ev.running, browser: ev.browser, headless: ev.headless, tabs: ev.tabs || [], log: ev.log || [], oddin: ev.oddin, chrome: ev.chrome || null };
      const added = tabs().filter((t) => !before.has(t.id));
      if (added.length && !String(added.at(-1).owner).startsWith('user') && !document.getElementById('bwBig')?.matches(':not([hidden])')) { B.tab = added.at(-1).id; B.src = ''; } // AI가 새 탭을 열면 그 탭을 보여 준다(크게 보기 중이면 그대로)
      if (!cur() && tabs().length) B.tab = tabs().at(-1).id;
      if (!B.state.running) B.src = '';
      paint();
      if ((added.length || tabs().length !== before.size) && typeof queueRerender === 'function') for (const j of S.jobs.values()) if (j.sessionId === S.current && ['running', 'planning'].includes(j.status)) queueRerender(j.id);
    } else if (ev.type === 'hello') load();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
