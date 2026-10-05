/* 기억 관리 화면 (lib/memory-blocks.mjs 짝, 2026-10-05 "메모리를 블록별로 정리·공유/로컬 나누기·세션별 실시간 연결/해제")
   - 사이드바 "공유 메모리" → 기억 관리 창: 왼쪽 블록 목록(공유·이 PC만 개수), 오른쪽 블록 안 메모리 — 블록 옮기기, 공유↔이 PC만, 본문 보기,
     블록 만들기·이름 바꾸기·지우기(빈 블록만)·블록 통째로 공유/이 PC만
   - 오른쪽 패널 '기억' 탭 위쪽: 이 세션에 넣는 기억 — 블록마다 [자동·연결·해제], 새 기억 저장 [공유·이 PC만·저장 안 함]
   - 실시간: hub:event 의 memory-blocks / session 으로 갱신 */
(() => {
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IC = (n) => (typeof icon === 'function' ? icon(n) : '');
  const say = (m, err) => (typeof toast === 'function' ? toast(m, err) : null);
  const call = (url, opt) => (typeof api === 'function' ? api(url, opt) : fetch(url, opt).then((r) => r.json()));
  const post = (url, body) => call(url, { method: 'POST', body: JSON.stringify(body || {}) });
  const M = { data: null, loading: null, sel: null, view: null, open: false };
  const TYPE_KO = { user: '사용자', feedback: '피드백', project: '프로젝트', reference: '참고' };
  const SCOPE_KO = { shared: '공유', local: '이 PC만' };

  async function load() {
    if (M.loading) return M.loading;
    M.loading = call('/api/memory/blocks').then((d) => { M.data = d; return d; }).finally(() => { M.loading = null; });
    return M.loading;
  }
  const blocks = () => M.data?.blocks || [];
  const blockById = (id) => blocks().find((b) => b.id === id);
  const globalBlocks = () => blocks().filter((b) => b.kind === 'global');

  /* ---------------- 기억 관리 창 ---------------- */
  async function openManager(sel) {
    M.open = true;
    const body = typeof modal === 'function' ? modal('기억 관리 — 블록 · 공유 / 이 PC만', true) : null;
    if (!body) return;
    body.innerHTML = '<div class="mb-wrap"><span class="c-muted">불러오는 중…</span></div>';
    try { await load(); } catch (e) { body.innerHTML = `<div class="mb-wrap"><div class="mem-cur err">${IC('alert')}<span>${E(e.message)}</span></div></div>`; return; }
    if (sel) M.sel = sel;
    if (!blockById(M.sel)) M.sel = blocks()[0]?.id || null;
    paint();
  }
  function paint() {
    const body = document.getElementById('modalBody');
    if (!M.open || !body || document.getElementById('modal')?.hidden) { M.open = false; return; }
    const b = blockById(M.sel);
    const row = (x) => `<button type="button" class="mb-b ${x.id === M.sel ? 'on' : ''}" data-mb-sel="${E(x.id)}" title="${E(x.kind === 'project' ? `프로젝트 메모리 폴더 ${x.slug}` : x.id)}">${x.kind === 'project' ? IC('folder') : IC('book')}<span class="mb-bn">${E(x.name)}</span><span class="mb-bc">${x.shared ? `<i class="sh">${x.shared}</i>` : ''}${x.local ? `<i class="lo">${x.local}</i>` : ''}${!x.shared && !x.local ? '<i>0</i>' : ''}</span></button>`;
    const left = `<aside class="mb-left"><div class="mb-cap">전역 블록</div>${globalBlocks().map(row).join('')}<form class="mb-new" data-mb-new><input name="n" maxlength="40" placeholder="새 블록 이름" aria-label="새 블록 이름"><button class="icon-btn" type="submit" title="블록 만들기">${IC('plus')}</button></form><div class="mb-cap">프로젝트 블록</div>${blocks().filter((x) => x.kind === 'project').map(row).join('') || '<div class="mb-empty">없음</div>'}<p class="mb-legend"><i class="sh"></i>공유(연결된 PC와 함께) <i class="lo"></i>이 PC만</p></aside>`;
    let right = '<section class="mb-right"><div class="mb-empty">왼쪽에서 블록을 고르세요</div></section>';
    if (b) {
      const g = b.kind === 'global';
      const allLocal = b.memories.length && b.memories.every((m) => m.root === 'local');
      right = `<section class="mb-right"><div class="mb-head"><h3>${E(b.name)}</h3><span class="mb-sub">${b.kind === 'project' ? `프로젝트 메모리 · ${E(b.slug)}` : '전역 블록'} · 메모리 ${b.memories.length}개</span><span class="grow"></span>`
        + (g && b.id !== '미분류' ? `<button class="btn sm" data-mb-rename="${E(b.id)}">${IC('pencil')}이름</button>` : '')
        + (b.memories.length ? `<button class="btn sm" data-mb-blockroot="${E(b.id)}" data-root="${allLocal ? 'shared' : 'local'}" title="${allLocal ? '이 블록의 메모리를 모두 공유로(연결된 PC에도 보냄)' : '이 블록의 메모리를 모두 이 PC만으로(연결된 PC에서는 빠짐)'}">${allLocal ? '블록 전체 공유로' : '블록 전체 이 PC만'}</button>` : '')
        + (g && !b.memories.length && b.id !== '미분류' ? `<button class="btn sm" data-mb-del="${E(b.id)}">${IC('trash')}지우기</button>` : '')
        + '</div>';
      if (!b.memories.length) right += '<div class="mb-empty">비어 있어요. 다른 블록의 메모리를 이 블록으로 옮길 수 있어요.</div>';
      right += `<ul class="mb-list">${b.memories.map((m) => {
        const key = `${m.root}|${m.rel}`, open = M.view?.key === key;
        const move = g ? `<select class="mb-move" data-mb-move="${E(key)}" aria-label="블록 옮기기" title="다른 블록으로 옮기기">${globalBlocks().map((x) => `<option value="${E(x.id)}" ${x.id === b.id ? 'selected' : ''}>${E(x.name)}</option>`).join('')}</select>` : '';
        return `<li class="${open ? 'open' : ''}"><div class="mb-m"><button type="button" class="mb-t" data-mb-view="${E(key)}">${E(m.title)}</button><span class="mb-type">${E(TYPE_KO[m.type] || m.type || '')}</span>`
          + `<button type="button" class="mb-scope ${m.root}" data-mb-root="${E(key)}" title="${m.root === 'shared' ? '눌러서 이 PC만으로(연결된 PC에서는 빠짐)' : '눌러서 공유로(연결된 PC에도 보냄)'}">${SCOPE_KO[m.root]}</button>${move}</div>`
          + `<div class="mb-d">${E(m.description)}</div>${open ? `<pre class="mb-body">${E(M.view.text || '불러오는 중…')}</pre>` : ''}</li>`;
      }).join('')}</ul></section>`;
    }
    body.innerHTML = `<div class="mb-wrap">${left}${right}</div>`;
  }
  async function act(fn, ok) {
    try { const r = await fn(); M.data = null; await load(); if (ok) say(typeof ok === 'function' ? ok(r) : ok); paint(); refreshTab(); }
    catch (e) { say(e.message, true); }
  }
  const parseKey = (key) => { const [root, rel] = key.split('|'); return { root, rel }; };
  document.addEventListener('click', async (e) => {
    if (!M.open) return;
    const t = e.target.closest('[data-mb-sel],[data-mb-view],[data-mb-root],[data-mb-rename],[data-mb-blockroot],[data-mb-del]'); if (!t || !document.getElementById('modalBody')?.contains(t)) return;
    if (t.dataset.mbSel) { M.sel = t.dataset.mbSel; M.view = null; paint(); }
    else if (t.dataset.mbView) {
      const key = t.dataset.mbView;
      if (M.view?.key === key) { M.view = null; paint(); return; }
      M.view = { key, text: '' }; paint();
      try { const r = await call(`/api/memory/text?${new URLSearchParams(parseKey(key))}`); if (M.view?.key === key) { M.view.text = r.text; paint(); } } catch (err) { say(err.message, true); }
    } else if (t.dataset.mbRoot) {
      const k = parseKey(t.dataset.mbRoot), to = k.root === 'shared' ? 'local' : 'shared';
      act(() => post('/api/memory/move', { ...k, toRoot: to }), to === 'local' ? '이 PC만으로 옮겼어요(연결된 PC에서는 빠져요)' : '공유로 옮겼어요(연결된 PC에도 보내요)');
    } else if (t.dataset.mbRename) {
      const to = prompt('새 블록 이름', t.dataset.mbRename);
      if (to && to.trim() && to.trim() !== t.dataset.mbRename) act(async () => { const r = await post('/api/memory/blocks/rename', { from: t.dataset.mbRename, to: to.trim() }); M.sel = r.to; return r; }, '블록 이름을 바꿨어요');
    } else if (t.dataset.mbBlockroot) {
      const root = t.dataset.root;
      if (confirm(root === 'local' ? '이 블록의 메모리를 모두 이 PC만으로 옮길까요? 연결된 PC에서는 빠져요(백업은 남아요).' : '이 블록의 메모리를 모두 공유로 옮길까요? 연결된 PC에도 보내요.')) act(() => post('/api/memory/blocks/root', { id: t.dataset.mbBlockroot, root }), (r) => `메모리 ${r.moved}개를 옮겼어요`);
    } else if (t.dataset.mbDel) act(async () => { const r = await post('/api/memory/blocks/delete', { name: t.dataset.mbDel }); M.sel = null; return r; }, '블록을 지웠어요');
  });
  document.addEventListener('change', (e) => {
    const s = e.target.closest('[data-mb-move]'); if (!s || !M.open) return;
    const k = parseKey(s.dataset.mbMove);
    act(() => post('/api/memory/move', { ...k, block: s.value }), `"${s.value}" 블록으로 옮겼어요`);
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-mb-new]'); if (!f) return;
    e.preventDefault(); const name = f.n.value.trim(); if (!name) return;
    act(async () => { const r = await post('/api/memory/blocks', { name }); M.sel = r.name; return r; }, '블록을 만들었어요');
  });
  // 사이드바 "공유 메모리"가 이 창을 연다 (app.js 의 읽기 전용 창 대신)
  window.openMemory = () => openManager();
  window.hubMemoryBlocks = { open: openManager, sessionHtml, load };

  /* ---------------- 세션별 연결/해제 (오른쪽 '기억' 탭 위쪽) ---------------- */
  function sessionHtml(s) {
    if (!s) return '';
    if (!M.data) { load().then(refreshTab).catch(() => {}); return '<div class="ilabel">이 세션에 넣는 기억</div><div class="ch-skel" aria-busy="true"><i></i><i></i></div>'; }
    const set = s.memory?.blocks || {}, save = s.memory?.save || 'shared';
    const seg = (id, v) => `<span class="seg2 mbs-seg" role="group" aria-label="${E(id)} 연결">${[['auto', '자동'], ['on', '연결'], ['off', '해제']].map(([k, l]) => `<button type="button" class="${(set[id] || 'auto') === k ? 'on' : ''} v-${k}" data-mbs-block="${E(id)}" data-v="${k}">${l}</button>`).join('')}</span>`;
    const row = (b) => `<li class="${set[b.id] || 'auto'}"><span class="mbs-n" title="${E(b.kind === 'project' ? b.slug : b.id)}">${b.kind === 'project' ? IC('folder') : ''}${E(b.name)}<em>${b.memories.length}</em>${set[b.id] === 'on' ? '<i class="mbs-live" title="매 단계 최신 내용을 넣어요"></i>' : ''}</span>${seg(b.id, set[b.id])}</li>`;
    const list = blocks().filter((b) => b.memories.length || set[b.id]);
    let h = '<div class="ilabel">이 세션에 넣는 기억</div><p class="mem-hint">자동 = 요청과 관련 있을 때만 · <b>연결</b> = 매 단계 최신 내용을 항상 넣음 · <b>해제</b> = 이 세션엔 넣지 않음</p>';
    h += `<ul class="mbs-list">${list.map(row).join('')}</ul>`;
    h += `<div class="ilabel">이 세션에서 새로 생긴 기억</div><div class="mbs-save"><span class="seg2" role="group" aria-label="새 기억 저장 위치">${[['shared', '공유'], ['local', '이 PC만'], ['none', '저장 안 함']].map(([k, l]) => `<button type="button" class="${save === k ? 'on' : ''}" data-mbs-save="${k}">${l}</button>`).join('')}</span><button type="button" class="linkish" data-mbs-manage>기억 관리</button></div>`;
    h += '<p class="mem-hint">공유 = 연결된 PC와 함께 씀 · 이 PC만 = 이 PC에만 저장 · 저장 안 함 = 결정 노트만 남김</p>';
    return `<div class="mbs-pane">${h}</div>`;
  }
  function refreshTab() { if (typeof S !== 'undefined' && S.insp?.tab === 'memory' && typeof renderInspector === 'function') renderInspector(); }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mbs-block],[data-mbs-save],[data-mbs-manage]'); if (!b || typeof S === 'undefined' || !S.current) return;
    if (b.hasAttribute('data-mbs-manage')) return openManager();
    const sid = S.current;
    const body = b.dataset.mbsBlock ? { blocks: { [b.dataset.mbsBlock]: b.dataset.v } } : { save: b.dataset.mbsSave };
    try {
      const s = await post(`/api/sessions/${encodeURIComponent(sid)}/memory`, body);
      if (S.sessions?.get(sid)) S.sessions.set(sid, { ...S.sessions.get(sid), memory: s.memory });
      refreshTab();
    } catch (err) { say(err.message, true); }
  });
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'memory-blocks') { M.data = null; load().then(() => { paint(); refreshTab(); }).catch(() => {}); }
    else if (ev.type === 'hello') { M.data = null; }
  });
})();
