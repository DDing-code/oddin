/* 연결된 PC 화면 (lib/peers.mjs · lib/shared-sync.mjs · lib/shared-setup.mjs 짝, 2026-10-05 집·회사 PC 두 대)
   - 오른쪽 패널 'PC' 탭: 이 PC 이름, 연결된 PC(다른 ODDIN 허브) 목록·상태·추가·이름 바꾸기·끊기,
     공유 기억(~/.ai-shared) 동기화 상태·지금 맞추기, 이 PC의 Claude·Codex 공유 기억 훅 상태·설치
   - 실시간: hub:event 의 peers / shared-sync 로 갱신 */
// 탭 아이콘: 모니터 (사용량 탭의 계기판과 겹치지 않게). 아래 함수 안의 IC 는 도우미라 전역 아이콘 목록은 여기서 더한다
if (typeof IC === 'object' && IC && !IC.monitor) IC.monitor = '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>';
(() => {
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IC = (n) => (typeof icon === 'function' ? icon(n) : '');
  const say = (m, err) => (typeof toast === 'function' ? toast(m, err) : null);
  const call = (url, opt) => (typeof api === 'function' ? api(url, opt) : fetch(url, opt).then((r) => r.json()));
  const P = { view: null, setup: null, loading: false, busy: '', error: '' };
  const when = (iso) => {
    if (!iso) return '아직 안 함';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? '방금' : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : new Date(iso).toLocaleString('ko-KR');
  };
  const countsText = (c) => !c ? '' : [c.pulled && `받음 ${c.pulled}`, c.pushed && `보냄 ${c.pushed}`, c.merged && `목록 합침 ${c.merged}`, c.conflicts && `겹침 ${c.conflicts}`, c.deleted && `지움 ${c.deleted}`].filter(Boolean).join(' · ') || '바뀐 것 없음';

  async function load() {
    if (P.loading) return; P.loading = true;
    try { [P.view, P.setup] = await Promise.all([call('/api/peers'), call('/api/shared/setup').catch(() => null)]); P.error = ''; }
    catch (e) { P.error = e.message; }
    P.loading = false; refresh();
  }
  function refresh() { if (typeof S !== 'undefined' && S.insp?.tab === 'peers' && typeof renderInspector === 'function') renderInspector(); }
  async function act(key, fn, ok) {
    P.busy = key; refresh();
    try { const r = await fn(); if (ok) say(typeof ok === 'function' ? ok(r) : ok); await load(); }
    catch (e) { say(e.message, true); }
    P.busy = ''; refresh();
  }

  function render(body) {
    if (!P.view && !P.error) { load(); body.innerHTML = '<div class="pc-pane"><div class="ch-skel" aria-busy="true"><i></i><i></i><i></i></div></div>'; return; }
    if (!P.view) { body.innerHTML = `<div class="pc-pane"><div class="mem-cur err">${IC('alert')}<span>불러오지 못했어요: ${E(P.error)}</span></div></div>`; return; }
    const v = P.view, sync = new Map((v.sync?.peers || []).map((x) => [x.id, x]));
    let h = '<div class="pc-pane">';
    h += `<div class="ilabel">이 PC</div><form class="pc-self" data-pc-self><input name="n" maxlength="30" value="${E(v.self.name)}" aria-label="이 PC 이름" title="다른 PC에서 이 이름으로 보여요"><button class="btn" type="submit" ${P.busy === 'self' ? 'disabled' : ''}>저장</button></form>`;
    h += `<p class="pc-hint">${E(v.self.hostname)} · ODDIN ${E(v.self.commit || '판 모름')} · 다른 PC에서 이 이름(예: 집, 회사)으로 보여요. <button class="linkish" data-pc-update="self" ${P.busy === 'update:self' ? 'disabled' : ''}>${P.busy === 'update:self' ? '받는 중…' : '이 PC 새 판 받기'}</button></p>`;

    h += `<div class="ilabel">연결된 PC ${v.peers.length || ''}</div>`;
    if (!v.peers.length) h += '<div class="mem-empty">아직 없어요. 다른 PC의 ODDIN 주소(Tailscale)를 아래에 넣으면 기억을 함께 써요.</div>';
    for (const p of v.peers) {
      const st = p.status, sy = sync.get(p.id) || {};
      const tone = !st ? 'wait' : st.online ? 'ok' : 'off';
      h += `<div class="pc-peer"><div class="pc-row"><span class="pc-dot ${tone}" title="${tone === 'ok' ? '연결됨' : tone === 'off' ? '연결 안 됨' : '확인 전'}"></span><b>${E(p.name)}</b><span class="pc-url" title="${E(p.url)}">${E(p.url.replace(/^https?:\/\//, ''))}</span><span class="grow"></span>`
        + `<button class="icon-btn" data-pc-rename="${E(p.id)}" title="이름 바꾸기">${IC('pencil')}</button><button class="icon-btn" data-pc-remove="${E(p.id)}" title="연결 끊기">${IC('x')}</button></div>`;
      if (st && !st.online) h += `<div class="pc-err">${IC('alert')}<span>${E(st.error || '연결 안 됨')}</span></div>`;
      if (st?.online) {
        const same = st.commit && st.commit === v.self.commit;
        h += `<div class="pc-sync">${IC('bolt')}<span>ODDIN ${E(st.commit || '판 모름')}${st.commit ? same ? ' · 이 PC와 같은 판' : ' · 이 PC와 다른 판' : ''}</span><span class="grow"></span><button class="btn sm" data-pc-update="${E(p.id)}" ${P.busy === `update:${p.id}` ? 'disabled' : ''} title="그 PC의 ODDIN이 GitHub에서 새 판을 받아요. 서버가 바뀌면 작업이 끝난 뒤 재시작">${P.busy === `update:${p.id}` ? '<span class="spin-xs"></span>받는 중' : '새 판 받기'}</button></div>`;
      }
      h += `<div class="pc-sync ${sy.ok === false ? 'err' : ''}">${IC('refresh')}<span>공유 기억 ${E(when(sy.lastAt))}${sy.lastAt ? ` · ${E(countsText(sy.counts))}` : ''}${sy.ok === false && sy.error ? ` · ${E(sy.error)}` : ''}</span></div></div>`;
    }
    h += `<form class="pc-add" data-pc-add><input name="u" placeholder="https://회사pc이름.tailnet.ts.net" autocomplete="off" aria-label="연결할 PC 주소"><input name="n" placeholder="이름 (예: 회사)" maxlength="30" autocomplete="off" aria-label="연결할 PC 이름"><button class="btn" type="submit" ${P.busy === 'add' ? 'disabled' : ''}>${IC('plus')}연결</button></form>`;
    h += '<p class="pc-hint">상대 PC의 ODDIN에서 원격 접속이 켜져 있어야 해요(설정 › 원격 접속). 연결하면 두 PC가 지침·메모리·공통 커맨드·에이전트를 1분마다, 바뀔 때마다 맞춰요.</p>';

    if (v.peers.length) {
      h += `<div class="ilabel">공유 기억</div><div class="pc-actions"><button class="btn" data-pc-sync ${P.busy === 'sync' || v.sync?.running ? 'disabled' : ''}>${v.sync?.running ? '<span class="spin-xs"></span>맞추는 중' : `${IC('refresh')}지금 맞추기`}</button></div>`;
      h += `<p class="pc-hint">둘 다 고친 파일은 목록(MEMORY.md)이면 줄을 합치고, 아니면 최근에 고친 쪽을 써요. 밀린 판과 지운 파일은 ${E((v.sync?.root || '~/.ai-shared') + '\\backups\\sync')}에 남아요.</p>`;
    }

    const su = P.setup;
    if (su) {
      const item = (ok, label) => `<li class="${ok ? 'ok' : 'no'}">${IC(ok ? 'check' : 'minus')}<span>${label}</span></li>`;
      h += `<div class="ilabel">이 PC의 Claude·Codex</div><ul class="pc-setup">${item(su.ready, '공유 기억 받음')}${item(su.claude.ok, 'Claude 훅 (세션 시작·끝 동기화, 매 메시지 기억 확인)')}${item(su.codex.ok, 'Codex 훅')}${item(su.claudeMd.ok, 'CLAUDE.md 공유 지침·메모리 불러오기')}</ul>`;
      if (!su.done) h += `<div class="pc-actions"><button class="btn" data-pc-setup ${!su.ready || P.busy === 'setup' ? 'disabled' : ''}>${IC('bolt')}빠진 것 설치</button></div><p class="pc-hint">${su.ready ? '기존 설정은 그대로 두고 빠진 훅·줄만 더해요(원본은 .bak-oddin 으로 보관). Codex는 새 훅을 처음 쓸 때 한 번 신뢰할지 물어요.' : '연결된 PC와 먼저 맞추면 설치할 수 있어요.'} ODDIN 작업은 훅이 없어도 공유 기억을 바로 써요.</p>`;
    }
    body.innerHTML = h + '</div>';
  }
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'peers', label: '연결된 PC', icon: 'monitor', render });

  document.addEventListener('submit', (e) => {
    const add = e.target.closest('[data-pc-add]'), self = e.target.closest('[data-pc-self]');
    if (!add && !self) return;
    e.preventDefault();
    if (add) {
      const url = add.u.value.trim(), name = add.n.value.trim(); if (!url) return;
      act('add', () => call('/api/peers', { method: 'POST', body: JSON.stringify({ url, name }) }), (p) => `${p.name} 연결했어요. 공유 기억을 맞추는 중이에요`);
    } else {
      const name = self.n.value.trim(); if (!name) return;
      act('self', () => call('/api/peers/self', { method: 'POST', body: JSON.stringify({ name }) }), '이 PC 이름을 바꿨어요');
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pc-sync],[data-pc-setup],[data-pc-remove],[data-pc-rename],[data-pc-update]'); if (!b) return;
    if (b.hasAttribute('data-pc-update')) {
      const id = b.dataset.pcUpdate, name = id === 'self' ? '이 PC' : P.view?.peers.find((x) => x.id === id)?.name || '그 PC';
      act(`update:${id}`, () => call(id === 'self' ? '/api/hub/update' : `/api/peers/${encodeURIComponent(id)}/update`, { method: 'POST', body: '{}' }), (r) => `${name}: ${r.message}${r.updated ? ` (${r.from} → ${r.to}, 파일 ${r.files}개)` : ''}`);
    } else if (b.hasAttribute('data-pc-sync')) act('sync', () => call('/api/shared/sync', { method: 'POST', body: '{}' }), (r) => (r.results || []).every((x) => x.ok) ? '공유 기억을 맞췄어요' : `일부 못 맞췄어요: ${(r.results || []).find((x) => !x.ok)?.error || (r.results || []).find((x) => !x.ok)?.errors?.[0] || ''}`);
    else if (b.hasAttribute('data-pc-setup')) act('setup', () => call('/api/shared/setup', { method: 'POST', body: '{}' }), (r) => r.changed?.length ? `설치했어요: ${r.changed.join(', ')}` : '이미 다 있어요');
    else if (b.hasAttribute('data-pc-remove')) {
      const p = P.view?.peers.find((x) => x.id === b.dataset.pcRemove);
      if (p && confirm(`${p.name} 연결을 끊을까요? 공유 기억 파일은 지우지 않아요.`)) act('remove', () => call(`/api/peers/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), '연결을 끊었어요');
    } else {
      const p = P.view?.peers.find((x) => x.id === b.dataset.pcRename);
      const name = p && prompt('새 이름', p.name);
      if (name && name.trim()) act('rename', () => call(`/api/peers/${encodeURIComponent(p.id)}`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) }));
    }
  });
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'peers' && ev.self) { P.view = { self: ev.self, peers: ev.peers, sync: ev.sync }; refresh(); }
    else if (ev.type === 'shared-sync' && P.view) { P.view.sync = ev.status; if (!ev.status.running) call('/api/shared/setup').then((s) => { P.setup = s; refresh(); }).catch(() => {}); refresh(); }
    else if (ev.type === 'hello' && P.view) load();
  });
})();
