/* 기억 화면 (lib/memory-curate.mjs 짝)
   - 작업 카드 끝: '공용 메모판'(작업자들이 남긴 결정) 접기 목록, '기억 정리' 줄(결정 노트 증감·저장한 장기 기억·되돌리기)
   - 오른쪽 패널 '기억' 탭: 세션 결정 노트 보기·지우기·더하기, 이 세션에서 저장한 장기 기억 목록
   - 서버가 기억 정리를 모르면(구버전) 작업에 curation·board 가 없어 아무것도 그리지 않는다 */
(() => {
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IC = (n) => (typeof icon === 'function' ? icon(n) : '');
  const say = (m, err) => (typeof toast === 'function' ? toast(m, err) : null);
  const call = (url, opt) => (typeof api === 'function' ? api(url, opt) : fetch(url, opt).then((r) => r.json()));
  const notes = new Map(); // sessionId -> { status: 'loading'|'ready'|'error', list, editedAt, error }
  const scopeKo = (s) => (s === 'global' ? '전역' : '프로젝트');

  /* ---------- 작업 카드 ---------- */
  function boardHtml(j) {
    if (!j.board?.length) return '';
    const who = new Map((j.tasks || []).map((t) => [t.id, t.assignee]));
    return `<details class="mem-board"><summary>${IC('board')}<span>공용 메모판</span><b>${j.board.length}줄</b></summary><ul>${j.board.map((b) =>
      `<li><span class="mb-t ${E(who.get(b.taskId) || '')}">${E(b.taskId)}</span><span>${E(b.text)}</span></li>`).join('')}</ul></details>`;
  }
  function curationHtml(j) {
    const c = j.curation; if (!c) return '';
    if (c.status === 'running') return `<div class="mem-cur run"><span class="spin-xs"></span><span>기억 정리 중… 끝나면 다음 요청이 이 결과를 이어받아요</span></div>`;
    if (c.status === 'failed') return `<div class="mem-cur err">${IC('alert')}<span>기억 정리 실패: ${E(c.error || '')}</span><span class="grow"></span><button class="mem-undo" data-mem-retry="${E(j.id)}" title="이 작업의 결정 노트·장기 기억 정리를 한 번 더">${IC('retry')}다시 정리</button></div>`;
    const n = c.notes || {}, parts = [];
    if (n.added) parts.push(`+${n.added}`); if (n.updated) parts.push(`고침 ${n.updated}`); if (n.removed) parts.push(`뺌 ${n.removed}`);
    const applied = (c.memory || []).filter((m) => m.status === 'applied'), skipped = (c.memory || []).filter((m) => m.status !== 'applied');
    const memTxt = applied.map((m) => `<span class="mem-item" title="${E(`${m.op === 'delete' ? '지움' : m.op === 'update' ? '고침' : '새로 저장'} · ${scopeKo(m.scope)} · ${m.name}.md${m.reason ? `\n${m.reason}` : ''}`)}">${m.op === 'delete' ? '지움 ' : m.op === 'update' ? '고침 ' : ''}${E(m.title || m.name)}</span>`).join('');
    // 공유를 허용한 세션이면 다시 쓸 결과물이 드라이브 ODDIN 자산으로 올라간다
    const savedA = (c.assets || []).filter((a) => a.status === 'saved' || a.status === 'same'), skippedA = (c.assets || []).filter((a) => a.status === 'skipped');
    const assetTxt = savedA.map((a) => `<span class="mem-item" title="${E(`ODDIN 자산 · ${a.rel || ''}${a.status === 'same' ? ' (이미 같은 판)' : ''}${a.description ? `\n${a.description}` : ''}`)}">${E(a.name)}</span>`).join('');
    const skipAll = [...skipped.map((m) => `${m.title || m.name}: ${m.why || '건너뜀'}`), ...skippedA.map((a) => `자산 ${a.name}: ${a.why || '건너뜀'}`)];
    const skipTip = skipAll.length ? ` title="${E(skipAll.join('\n'))}"` : '';
    const canUndo = applied.length || savedA.some((a) => a.created && a.status === 'saved');
    const undo = canUndo ? (c.undoneAt ? `<span class="mem-undone">되돌림</span>` : `<button class="mem-undo" data-mem-undo="${E(j.id)}" title="이 작업이 저장한 장기 기억·새로 올린 자산을 원래대로">${IC('retry')}되돌리기</button>`) : '';
    return `<div class="mem-cur">${IC('book')}<span class="mem-k">기억</span>`
      + `<span class="mem-n" title="세션 결정 노트 ${c.total ?? ''}개 — 다음 요청부터 작업자들이 빠짐없이 받아요">결정 노트 ${parts.length ? parts.join(' · ') : '그대로'}</span>`
      + (applied.length ? `<span class="mem-sep">·</span><span class="mem-l">장기 기억</span>${memTxt}` : '')
      + (savedA.length ? `<span class="mem-sep">·</span><span class="mem-l">ODDIN 자산</span>${assetTxt}` : '')
      + (skipAll.length ? `<span class="mem-skip"${skipTip}>건너뜀 ${skipAll.length}</span>` : '')
      + `<span class="grow"></span>${undo}</div>`;
  }
  window.hubJobExtras = window.hubJobExtras || [];
  window.hubJobExtras.push((j) => boardHtml(j) + curationHtml(j));

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mem-undo]'); if (!b) return;
    b.disabled = true;
    try {
      const r = await call(`/api/jobs/${encodeURIComponent(b.dataset.memUndo)}/memory/undo`, { method: 'POST', body: '{}' });
      const bad = (r.undo || []).filter((x) => x.status !== 'restored').length;
      say(bad ? `되돌렸어요. 그 뒤에 다른 곳에서 바뀐 ${bad}개는 그대로 뒀어요` : '이 작업이 저장한 장기 기억을 되돌렸어요');
    } catch (err) { say(err.message, true); b.disabled = false; }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mem-retry]'); if (!b) return;
    b.disabled = true;
    try { await call(`/api/jobs/${encodeURIComponent(b.dataset.memRetry)}/memory/retry`, { method: 'POST', body: '{}' }); say('기억을 다시 정리하고 있어요'); }
    catch (err) { say(err.message, true); b.disabled = false; }
  });

  /* ---------- 오른쪽 '기억' 탭 ---------- */
  async function load(sid, rerender = true) {
    const cur = notes.get(sid);
    notes.set(sid, { ...(cur || { list: [] }), status: cur?.status === 'ready' ? 'ready' : 'loading' });
    try {
      const r = await call(`/api/sessions/${encodeURIComponent(sid)}/notes`);
      notes.set(sid, { status: 'ready', list: r.notes || [], editedAt: r.editedAt || null });
    } catch (err) { notes.set(sid, { status: 'error', list: cur?.list || [], error: err.message }); }
    if (rerender) refresh(sid);
  }
  function refresh(sid) {
    if (typeof S !== 'undefined' && S.current === sid && S.insp?.tab === 'memory' && typeof renderInspector === 'function') renderInspector();
  }
  async function save(sid, list) {
    try {
      const r = await call(`/api/sessions/${encodeURIComponent(sid)}/notes`, { method: 'PUT', body: JSON.stringify({ notes: list }) });
      notes.set(sid, { status: 'ready', list: r.notes || [], editedAt: r.editedAt || null }); refresh(sid);
    } catch (err) { say(err.message, true); }
  }
  function render(body, s) {
    if (!s) { body.innerHTML = `<div class="insp-empty">${IC('book')}<p>세션을 열면 그 세션의 결정 노트가 여기에 보여요</p></div>`; return; }
    const st = notes.get(s.id);
    if (!st) load(s.id);
    const list = st?.list || [];
    const jobs = typeof sessionJobs === 'function' ? sessionJobs(s.id) : [];
    const running = jobs.some((j) => j.curation?.status === 'running');
    // 이 세션에 넣는 기억(블록 연결·해제, 새 기억 저장 위치) — public/memory-blocks.js
    let h = `<div class="mem-pane">${window.hubMemoryBlocks?.sessionHtml?.(s) || ''}<div class="ilabel">세션 결정 노트 ${list.length ? list.length : ''}</div>`
      + `<p class="mem-hint">요청이 끝날 때마다 이 세션에서 정한 것·알아낸 것을 모아 둬요. 다음 요청부터 작업자들이 이 노트를 빠짐없이 받아요(오래된 보고서는 잘려도 노트는 남아요). 틀린 건 지우고, 꼭 지킬 건 직접 더하세요.</p>`;
    if (running) h += `<div class="mem-cur run"><span class="spin-xs"></span><span>방금 끝난 요청을 정리하는 중…</span></div>`;
    if (!st || (st.status === 'loading' && !list.length)) h += `<div class="ch-skel" aria-busy="true"><i></i><i></i><i></i></div>`;
    else if (st.status === 'error') h += `<div class="mem-cur err">${IC('alert')}<span>불러오지 못했어요: ${E(st.error)}</span></div>`;
    else if (!list.length) h += `<div class="mem-empty">아직 없어요. 요청이 끝나면 정리돼요.</div>`;
    else h += `<ol class="mem-notes">${list.map((n) => `<li><span class="mn-t">${E(n.text)}</span><span class="mn-m">${n.src === 'user' ? '직접 추가' : ''}</span><button class="icon-btn mn-x" data-mem-del="${E(n.id)}" title="이 노트 지우기" aria-label="이 노트 지우기">${IC('x')}</button></li>`).join('')}</ol>`;
    h += `<form class="mem-add" data-mem-add><input name="t" maxlength="300" placeholder="꼭 지킬 결정 직접 더하기 (예: 색은 다크 테마만)" autocomplete="off"><button class="btn" type="submit">${IC('plus')}더하기</button></form>`;
    const saved = jobs.flatMap((j) => (j.curation?.memory || []).filter((m) => m.status === 'applied').map((m) => ({ ...m, job: j })));
    if (saved.length) {
      h += `<div class="ilabel">이 세션에서 저장한 장기 기억 ${saved.length}</div><ul class="mem-saved">${saved.map((m) =>
        `<li title="${E(m.file || '')}"><span class="ms-op">${m.op === 'delete' ? '지움' : m.op === 'update' ? '고침' : '새로'}</span><b>${E(m.title || m.name)}</b><span class="ms-s">${scopeKo(m.scope)}${m.job.curation.undoneAt ? ' · 되돌림' : ''}</span></li>`).join('')}</ul>`;
    }
    body.innerHTML = h + '</div>';
  }
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'memory', label: '기억', icon: 'book', render });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mem-del]'); if (!b || typeof S === 'undefined') return;
    const sid = S.current, st = notes.get(sid); if (!st) return;
    save(sid, st.list.filter((n) => n.id !== b.dataset.memDel));
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-mem-add]'); if (!f || typeof S === 'undefined') return;
    e.preventDefault();
    const text = f.t.value.trim(); if (!text) return;
    const st = notes.get(S.current) || { list: [] };
    save(S.current, [...st.list, { text, src: 'user' }]);
    f.t.value = '';
  });
  // 정리가 끝나거나 다른 창에서 노트를 고치면 다시 읽는다
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'job' && ev.job?.sessionId && notes.has(ev.job.sessionId)) {
      const was = notes.get(ev.job.sessionId)._sig, sig = `${ev.job.id}:${ev.job.curation?.status || ''}`;
      if (ev.job.curation?.status && was !== sig) { notes.get(ev.job.sessionId)._sig = sig; if (ev.job.curation.status !== 'running') load(ev.job.sessionId); else refresh(ev.job.sessionId); }
    } else if (ev.type === 'session' && ev.session?.id && notes.has(ev.session.id)) {
      if (notes.get(ev.session.id).editedAt !== (ev.session.notesEdit?.at || null)) load(ev.session.id);
    } else if (ev.type === 'hello') notes.clear();
  });
})();
