/* 실행 PC 고르기 (2026-10-05 사용자 "작업을 할 컴퓨터를 정할 수 있게 해줘 하단 메뉴에서 — 작업 지시는 어느 기기에서나 할 수 있지만 작업은 정할 수 있도록")
   - 입력창 아래 "실행 · <PC>" 버튼(#pMachine). 새 세션은 고른 PC에서 시작하고(서버 lib/federation.mjs 가 그 PC에 작업을 만듦),
     이미 있는 세션은 그 세션을 시작한 PC에서 이어 간다(다른 PC 세션은 사이드바에 PC 이름 표시).
   - 고른 값은 S.prefs.machine(연결된 PC id, 없으면 이 PC). app.js submit 이 window.hubMachine() 으로 묻는다.
   - 다른 PC 세션·작업은 서버가 실시간으로 비춰 준다(id 앞 rm-). 그 PC 연결이 끊기거나 다시 붙으면 remote_sync 로 통째로 바꾼다.
   연결된 PC가 없으면 버튼을 숨긴다. */
'use strict';
(() => {
  if (typeof IC === 'object' && IC && !IC.monitor) IC.monitor = '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>';
  const M = { self: null, peers: [] };
  const pill = document.createElement('button');
  pill.type = 'button'; pill.className = 'pill'; pill.id = 'pMachine';
  ($('#pPerm') || $('#pCodex')).after(pill);

  const selfName = () => M.self?.name || '이 PC';
  /** 지금 보내면 작업할 PC: { id, name, self, locked } */
  function cur() {
    const s = S.current && S.sessions.get(S.current);
    if (s) return s.machine ? { id: s.machine.id, name: s.machine.name, locked: true, online: s.machine.online !== false } : { id: M.self?.id, name: selfName(), self: true, locked: true };
    const p = M.peers.find((x) => x.id === S.prefs.machine);
    return p ? { id: p.id, name: p.name, online: !!p.status?.online } : { id: M.self?.id, name: selfName(), self: true };
  }
  function render() {
    const c = cur();
    pill.hidden = !M.peers.length;
    pill.innerHTML = `${icon('monitor')}<span class="v"><span class="nm">실행 · </span>${esc(c.name)}</span>${c.locked ? '' : icon('down')}`;
    pill.classList.toggle('perm-on', !c.self);
    pill.classList.toggle('off', c.online === false);
    pill.title = c.locked ? `이 세션은 ${c.name}${c.self ? '(이 PC)' : ' PC'}에서 작업해요. 세션은 시작한 PC에서 이어 가요 — 다른 PC에서 하려면 새 세션에서 실행 PC를 고르세요`
      : '작업할 컴퓨터 — 지시는 어느 기기에서나, 작업은 고른 PC에서';
    pill.setAttribute('aria-label', `실행 PC: ${c.name}`);
  }
  pill.addEventListener('click', () => {
    const c = cur();
    if (c.locked) return toast(pill.title);
    const items = [{ header: '작업할 컴퓨터 · 지시는 어느 기기에서나 할 수 있어요' }];
    items.push({ label: `${selfName()} (이 PC)`, desc: '이 화면의 ODDIN이 있는 PC에서 작업', checked: !!c.self, run: () => { delete S.prefs.machine; savePrefs(); render(); closePop(); } });
    for (const p of M.peers) {
      const on = !!p.status?.online;
      items.push({ label: p.name, desc: on ? '그 PC의 Claude·Codex가 그 PC 파일·프로그램으로 작업 · 드라이브 작업 폴더는 그 PC 경로로 바꿔요' : '지금 연결 안 됨',
        checked: c.id === p.id, run: () => { if (!on) return toast(`${p.name} PC에 지금 연결되지 않았어요`, true); S.prefs.machine = p.id; savePrefs(); render(); closePop(); } });
    }
    openPop(pill, items, { sel: Math.max(0, c.self ? 0 : 1 + M.peers.findIndex((p) => p.id === c.id)), kind: 'machine' });
  });
  window.hubMachine = () => { const c = cur(); return c.self || c.locked ? null : c.id; };

  async function load() { try { const v = await api('/api/peers'); M.self = v.self; M.peers = v.peers || []; } catch {} render(); }
  // 버튼 줄·대화가 다시 그려질 때(세션을 바꿀 때 포함) 같이
  const baseBar = window.renderBarPills; window.renderBarPills = function () { baseBar.apply(this, arguments); render(); };
  const baseThread = window.renderThread; window.renderThread = function () { const r = baseThread.apply(this, arguments); render(); return r; };
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'peers' && ev.self) { M.self = ev.self; M.peers = ev.peers || []; render(); }
    else if (ev.type === 'hello') load();
    else if (ev.type === 'remote_sync' && ev.machine?.id) {
      for (const [id, s] of S.sessions) if (s.machine?.id === ev.machine.id) S.sessions.delete(id);
      for (const [id, j] of S.jobs) if (j.machine?.id === ev.machine.id) S.jobs.delete(id);
      for (const s of ev.sessions || []) S.sessions.set(s.id, s);
      for (const j of ev.jobs || []) S.jobs.set(j.id, j);
      if (typeof renderTree === 'function') renderTree();
      if (S.current && String(S.current).startsWith('rm-') && typeof renderThread === 'function') renderThread();
    }
  });
  // 작업 넘기기(server.mjs handoff, 2026-10-06): 이 작업에서 다른 PC로 넘긴 일 — 누르면 그 PC 세션이 열린다
  window.hubJobExtras = window.hubJobExtras || [];
  const sessionFor = (sid) => { if (S.sessions.has(sid)) return sid; const m = String(sid || '').match(/^rm-[A-Za-z0-9]+-(.+)$/); return m && S.sessions.has(m[1]) ? m[1] : null; };
  window.hubJobExtras.push((j) => (j.handoffs || []).map((h) => {
    const sid = sessionFor(h.sessionId);
    return `<div class="handoff-row">${icon('monitor')}<span class="t"><b>${esc(h.peer)} PC로 넘김</b> · ${esc(String(h.goal || '').slice(0, 100))}</span>${sid ? `<button type="button" class="btn" data-handoff-open="${esc(sid)}">그 세션 열기</button>` : ''}</div>`;
  }).join(''));
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-handoff-open]'); if (b) { e.preventDefault(); openSession(b.dataset.handoffOpen); } });

  // 세션 실행 PC 옮기기(server.mjs moveSession, 2026-10-07): 대화 기록을 가져가 다른 PC에서 이어서, 원래 세션은 보관함으로
  window.hubJobExtras.push((j) => (j.imported ? `<div class="handoff-row">${icon('monitor')}<span class="t"><b>${esc(j.imported.machine || '다른')} PC에서 옮겨 온 기록</b> · 실행 기록·변경 비교는 그 PC 보관함의 원래 세션에 있어요</span></div>` : ''));
  async function moveTo(s, target) {
    let cwd = '';
    if (target.self) {
      cwd = await window.hubPickFolder?.({ title: `"${s.title}"을 이 PC에서 이어 갈 작업 폴더`, start: S.prefs.cwd || '', confirm: '이 폴더로 옮기기' });
      if (!cwd) return;
    } else {
      const v = prompt(`${target.name} PC에서 쓸 작업 폴더 경로 (비우면 그 PC의 같은 드라이브 폴더나 기본 작업 폴더)`, '');
      if (v === null) return; cwd = v.trim();
    }
    try {
      toast(`${target.name}${target.self ? '(이 PC)' : ' PC'}로 옮기는 중…`);
      const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/move`, { method: 'POST', body: JSON.stringify({ machine: target.self ? 'self' : target.id, cwd }) });
      toast(`${r.machine} PC로 옮겼어요 — 이전 기록 ${r.imported}건을 가져왔고${r.archived ? ' 원래 세션은 보관함으로 보냈어요' : ' 원래 세션은 그대로 있어요'}`);
      setTimeout(() => { if (S.sessions.has(r.sessionId)) openSession(r.sessionId); }, 400);
    } catch (e) { toast(`옮기지 못했어요: ${e.message}`, true); }
  }
  window.hubSessionMenuItems = window.hubSessionMenuItems || [];
  window.hubSessionMenuItems.push((s) => {
    if (!M.peers.length || s.archived) return [];
    const owner = s.machine?.id || null; // 없으면 이 PC 세션
    const targets = [...(owner ? [{ self: true, name: selfName() }] : []), ...M.peers.filter((p) => p.id !== owner).map((p) => ({ id: p.id, name: p.name }))];
    if (!targets.length) return [];
    const live = s.status === 'running';
    return [{ label: '실행 PC 옮기기…', desc: live ? '진행 중인 작업이 끝난 뒤에 옮길 수 있어요' : '대화 기록을 가져가 다른 PC에서 이어서 · 원래 세션은 보관함으로', icon: 'monitor', run: () => {
      if (live) { closePop(); return toast('진행 중인 작업이 끝난 뒤에 옮길 수 있어요', true); }
      openPop(document.querySelector(`#tree [data-sid="${CSS.escape(s.id)}"]`) || document.getElementById('title'), [{ header: `"${s.title}" 어느 PC로 옮길까요?` }, ...targets.map((t) => ({ label: t.self ? `${t.name} (이 PC)` : t.name, icon: 'monitor', run: () => { closePop(); moveTo(s, t); } }))], { below: true });
    } }];
  });
  load();
})();
