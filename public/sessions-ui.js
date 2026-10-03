// 세션 보관·갈래·내보내기, 세션 격리(worktree)·git 패널. 담당: Fable.
// 연결 지점: window.hubTabs(오른쪽 패널 Git 탭) · window.hubJobExtras(작업 카드 "여기서 갈래 만들기") · window.hubTopExtras(상단 바 칩)
//           window.hubTreeExtras(사이드바 보관함) · window.hubSessionMenuItems(세션 메뉴) · window.hubDeleteSession(격리 세션 삭제) · window.hubCreateSession(격리해서 시작)
// 서버 규약: docs/git-sessions.md (lib/session-tools.mjs · lib/gitops.mjs)
(() => {
  'use strict';

  /* ---------- 아이콘 (app.js IC 에 더함, lucide 모양) ---------- */
  Object.assign(IC, {
    branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    unarchive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M20 8v11a2 2 0 0 1-2 2h-2"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    commit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
    merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
    folderx: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="m9.5 10.5 5 5M14.5 10.5l-5 5"/>',
    okcircle: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  });

  /* ---------- 상태 ---------- */
  const SU = {
    isolate: false, isolateCwd: '',                 // 새 세션(초안)에서 "격리해서 시작" 선택
    archived: new Map(), archiveOpen: false, archiveLoaded: false, archiveLoading: false, archiveError: '',
    git: new Map(),                                  // 세션 id → { data, loading, error, at, stale, ci, ciLoading, ciError, result, busy, moreFiles }
    bar: null, lockedPlaceholder: null,
  };
  const caps = () => S.caps || {};
  const remote = () => typeof isRemoteView === 'function' && isRemoteView();
  const cur = () => S.sessions.get(S.current) || null;
  const isLive = (s) => s && (s.status === 'running' || sessionJobs(s.id).some((j) => LIVE.has(j.status) || j.canIntercept === true));
  const firstLine = (t) => String(t || '').split('\n')[0];
  const safeName = (t) => String(t || '세션').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || '세션';
  const jobTitle = (j) => (j ? firstLine(j.input || j.goal || j.title) : '');
  const fileName = (p) => String(p).split(/[\\/]/).pop();
  const repaintInsp = () => { if (S.insp?.tab === 'git' && typeof renderInspector === 'function') renderInspector(); };
  const openUrl = (u) => { if (!/^https:\/\//i.test(u || '')) return; const w = window.open(u, '_blank', 'noopener'); if (!w) toast('새 창이 막혔어요. 아래 링크를 눌러 여세요', true); };
  const warnNotes = (s) => { for (const w of s?.warnings || []) note(`<span class="su-note-w">${icon('alert')}<span>${esc(w)}</span></span>`); };
  const errorOf = (e) => ({ message: e?.message || String(e), code: e?.code || '', files: Array.isArray(e?.files) ? e.files : [] });
  // app.js 의 api() 는 error 문자열만 남기므로 코드·파일 목록까지 받는 요청 함수
  async function call(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText || '요청 실패'), { code: j.code, files: j.files, status: r.status });
    return j;
  }

  /* ======================= 대화상자 (hubs.js 의 .hub-dlg 와 같은 외형) ======================= */
  function dialog({ title, body, confirm = '확인', cancel = '취소', danger = false, wide = false, onConfirm, onOpen }) {
    document.querySelector('.su-dlg')?.close();
    const opener = document.activeElement !== document.body ? document.activeElement : null;
    const d = document.createElement('dialog');
    d.className = `su-dlg${wide ? ' wide' : ''}`;
    d.setAttribute('aria-labelledby', 'suDlgTitle'); d.setAttribute('aria-label', title);
    d.innerHTML = `<form method="dialog" novalidate><div class="su-dlg-h"><b id="suDlgTitle">${esc(title)}</b><span class="grow"></span><button type="button" class="icon-btn" data-d="close" title="닫기" aria-label="닫기">${icon('x')}</button></div>
      <div class="su-dlg-b">${body}</div>
      <div class="su-dlg-f"><div class="su-ferr" role="alert" aria-live="polite"></div><span class="grow"></span><button type="button" class="btn" data-d="close">${esc(cancel)}</button>${confirm ? `<button type="submit" class="btn primary ${danger ? 'danger' : ''}" data-d="ok"><span class="su-ok-l">${esc(confirm)}</span></button>` : ''}</div></form>`;
    document.body.appendChild(d);
    const ok = d.querySelector('[data-d="ok"]'); const err = d.querySelector('.su-ferr');
    let busy = false; const keepDisabled = new Set();
    const close = () => { if (busy) return; try { d.close(); } catch {} };
    const ctl = {
      el: d, close,
      setError(m) { err.innerHTML = m ? `${icon('alert')}<span>${esc(m)}</span>` : ''; },
      setBusy(v, label) {
        busy = v; d.classList.toggle('busy', v);
        d.querySelectorAll('button,input,textarea,select').forEach((b) => { if (b.dataset.d === 'ok') return; if (v) { if (b.disabled) keepDisabled.add(b); else b.disabled = true; } else if (!keepDisabled.has(b)) b.disabled = false; });
        if (ok) { ok.disabled = v; ok.innerHTML = v ? `<span class="spinner"></span><span class="su-ok-l">${esc(label || confirm)}</span>` : `<span class="su-ok-l">${esc(confirm)}</span>`; }
      },
    };
    d.addEventListener('click', (e) => { if (e.target.closest('[data-d="close"]')) { e.preventDefault(); close(); } else if (e.target === d) close(); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    d.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } });
    d.addEventListener('close', () => { d.remove(); if (opener?.isConnected) { try { opener.focus({ preventScroll: true }); } catch {} } });
    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault(); if (busy || !onConfirm) return close();
      ctl.setError('');
      try { ctl.setBusy(true); const r = await onConfirm(d, ctl); ctl.setBusy(false); if (r !== false) close(); }
      catch (x) { ctl.setBusy(false); ctl.setError(x.message || String(x)); }
    });
    d.showModal();
    try { onOpen?.(d, ctl); } catch {}
    if (!d.contains(document.activeElement)) (d.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,[data-d="ok"]') || d.querySelector('button'))?.focus();
    return ctl;
  }
  const field = (label, inner, hint = '') => `<div class="su-field"><label>${label}</label>${inner}${hint ? `<small class="fine">${hint}</small>` : ''}</div>`;
  const check = (name, label, desc, checked = false) => `<label class="su-check"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span><b>${label}</b>${desc ? `<small>${desc}</small>` : ''}</span></label>`;

  /* ======================= 보관함 ======================= */
  async function loadArchived(force = false) {
    if (!caps().sessionArchive || (SU.archiveLoading) || (SU.archiveLoaded && !force)) return;
    SU.archiveLoading = true; SU.archiveError = '';
    try {
      const list = await api('/api/sessions?archived=1');
      SU.archived = new Map(list.map((s) => [s.id, s]));
      for (const s of list) S.sessions.set(s.id, s); // 보관한 세션도 열 수 있게 (목록은 renderTree 가 archived 를 거른다)
      SU.archiveLoaded = true;
    } catch (e) { SU.archiveError = e.message; }
    finally { SU.archiveLoading = false; renderTree(); }
  }
  function archiveBoxHtml() {
    if (!caps().sessionArchive) return '';
    const list = [...SU.archived.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const n = list.length;
    let inner = '';
    if (SU.archiveOpen) {
      if (SU.archiveLoading && !SU.archiveLoaded) inner = '<div class="empty-row">불러오는 중…</div>';
      else if (SU.archiveError) inner = `<div class="empty-row c-err">${esc(SU.archiveError)}</div>`;
      else if (!n) inner = '<div class="empty-row">보관한 세션이 없어요. 세션 메뉴(⋯)의 보관으로 목록에서 숨길 수 있어요.</div>';
      else inner = list.map((s) => `<div class="sess su-arow ${s.id === S.current ? 'on' : ''}" data-su="open-archived" data-id="${esc(s.id)}" tabindex="0" role="treeitem" title="${esc(`${s.title}\n${s.cwd}\n보관됨 · ${new Date(s.updatedAt).toLocaleString('ko-KR')}`)}">
          <span class="s-ic">${icon(s.git?.isolated ? 'branch' : 'archive')}</span><span class="t">${esc(s.title)}</span><span class="meta">${ago(s.updatedAt)}</span>
          <button class="row-more" data-su="archived-menu" data-id="${esc(s.id)}" title="더보기" tabindex="-1" aria-label="${esc(s.title)} 메뉴">${icon('more')}</button></div>`).join('');
      inner = `<div class="su-arch-b">${inner}<div class="su-arch-note">보관해도 작업 기록과 결과는 그대로 남아요</div></div>`;
    }
    return `<div class="su-arch ${SU.archiveOpen ? 'open' : ''}"><button type="button" class="su-arch-h" data-su="archive-toggle" aria-expanded="${SU.archiveOpen}">${icon('archive')}<span class="lbl">보관함</span>${SU.archiveLoaded ? `<span class="su-cnt">${n || ''}</span>` : ''}<span class="chev">${icon('right')}</span></button>${inner}</div>`;
  }
  function openArchivedMenu(id, anchor) {
    const s = SU.archived.get(id) || S.sessions.get(id); if (!s) return;
    openPop(anchor, [
      { label: '열기', icon: 'open', desc: '기록을 읽기 전용으로 봐요', run: () => { closePop(); openArchived(id); } },
      { label: '복원', icon: 'unarchive', desc: '세션 목록으로 돌려놓아요', run: () => { closePop(); unarchive(id); } },
      ...(caps().sessionExport ? [{ label: '마크다운으로 내보내기', icon: 'download', run: () => { closePop(); exportSession(id, 'md'); } }, { label: 'JSON으로 내보내기', icon: 'file', run: () => { closePop(); exportSession(id, 'json'); } }] : []),
      { sep: true },
      { label: '삭제', icon: 'trash', danger: true, run: () => { closePop(); deleteSession(id); } },
    ], { below: true });
  }
  async function openArchived(id) {
    if (!S.sessions.has(id)) { const s = SU.archived.get(id); if (s) S.sessions.set(id, s); }
    await openSession(id);
  }
  async function archive(id, opener) {
    const s = S.sessions.get(id); if (!s) return;
    if (isLive(s)) return toast('실행 중인 세션은 보관할 수 없어요. 작업이 끝난 뒤 다시 시도하세요', true);
    const doIt = async (cleanup = false) => {
      const r = await call(`/api/sessions/${id}/archive`, { method: 'POST', body: JSON.stringify(cleanup ? { cleanup: true } : {}) });
      S.sessions.set(id, r); SU.archived.set(id, r); SU.archiveLoaded = true;
      if (S.current === id) paintBar(); renderTree();
      toast(cleanup ? '보관하고 worktree를 정리했어요 · 보관함에서 복원할 수 있어요' : '보관했어요 · 사이드바 보관함에서 복원할 수 있어요');
    };
    if (!(s.git?.isolated && !s.git.cleanedAt)) return doIt().catch((e) => toast(e.message, true));
    dialog({
      title: '세션 보관', confirm: '보관',
      body: `<p class="su-p">"<b>${esc(s.title)}</b>" 세션을 목록에서 숨겨요. 작업 기록과 결과는 그대로 남고, 보관함에서 언제든 복원할 수 있어요.</p>
        ${check('cleanup', 'worktree도 정리', `작업 폴더 <span class="mono">${esc(shortPath(s.git.worktree, 2))}</span>를 지워요. 브랜치 <span class="mono">${esc(s.git.branch)}</span>는 남아요. 커밋 안 된 변경이 있으면 정리하지 않고 보관도 취소돼요.`)}`,
      onConfirm: (d) => doIt(d.querySelector('[name=cleanup]').checked),
    });
  }
  async function unarchive(id) {
    try {
      const r = await call(`/api/sessions/${id}/unarchive`, { method: 'POST', body: '{}' });
      S.sessions.set(id, r); SU.archived.delete(id);
      if (S.current === id) paintBar(); renderTree();
      toast('복원했어요');
    } catch (e) { toast(e.message, true); }
  }

  /* ======================= 갈래 (fork) ======================= */
  async function openForkDialog(sessionId, jobId = null, { isolate = false } = {}) {
    const s = S.sessions.get(sessionId); if (!s) return;
    let jobs = sessionJobs(sessionId);
    if (!jobs.length && s.jobCount) { try { for (const j of await api(`/api/sessions/${sessionId}/jobs`)) S.jobs.set(j.id, j); } catch {} jobs = sessionJobs(sessionId); }
    const pick = jobId && jobs.some((j) => j.id === jobId) ? jobId : (jobs.at(-1)?.id || '');
    const canIsolate = caps().gitSessions && s.git !== null;      // git:null 이면 저장소가 아님. 정보가 없는 옛 세션은 서버가 판단
    const base = s.git?.cleanedAt ? s.git.repo : s.cwd;
    const list = jobs.length ? `<div class="su-jobs" role="radiogroup" aria-label="이어받을 마지막 작업">${jobs.map((j, i) => `<label class="su-job ${j.id === pick ? 'on' : ''}"><input type="radio" name="job" value="${esc(j.id)}" ${j.id === pick ? 'checked' : ''}><span class="n">${i + 1}</span><span class="su-job-t"><b>${esc(jobTitle(j))}</b><small>${esc(hm(j.createdAt))} · ${esc(ST_KO[j.status] || j.status)}</small></span>${stIcon(j.status)}</label>`).join('')}</div>`
      : '<div class="su-empty-inline">아직 작업이 없어서 맥락 없이 빈 갈래가 만들어져요</div>';
    dialog({
      title: '갈래 만들기', confirm: '갈래 만들기', wide: true,
      body: `<p class="su-p">고른 작업까지의 대화 맥락을 이어받는 새 세션을 만들어요. 원본 기록은 복사하지 않고 참조만 해요. 그 뒤 작업은 넘어가지 않아요.</p>
        ${field('어느 작업까지 이어받을까요', list)}
        ${field('새 세션 이름', `<input class="su-in" name="title" maxlength="80" value="${esc(`${s.title} 갈래`)}" autocomplete="off" spellcheck="false">`)}
        ${field('어디서 시작할까요', `<div class="su-seg" role="radiogroup"><label class="${!isolate || !canIsolate ? 'on' : ''}"><input type="radio" name="where" value="same" ${!isolate || !canIsolate ? 'checked' : ''}><span>${icon('folder')}같은 폴더</span><small>${esc(shortPath(base, 2))}</small></label>
          <label class="${canIsolate ? '' : 'off'} ${isolate && canIsolate ? 'on' : ''}" title="${canIsolate ? '' : 'git 저장소가 아니라 격리할 수 없어요'}"><input type="radio" name="where" value="isolate" ${isolate && canIsolate ? 'checked' : ''} ${canIsolate ? '' : 'disabled'}><span>${icon('branch')}격리해서 (git worktree)</span><small>${canIsolate ? `${esc(s.git?.branch || '현재 브랜치')}의 커밋된 상태에서 새 브랜치로` : 'git 저장소가 아니에요'}</small></label></div>`,
          s.git?.cleanedAt ? '원본 worktree는 정리돼서 원본 저장소 폴더에서 시작해요.' : '')}`,
      onConfirm: async (d) => {
        const body = { jobId: d.querySelector('[name=job]:checked')?.value || undefined, isolate: d.querySelector('[name=where]:checked')?.value === 'isolate', title: d.querySelector('[name=title]').value.trim() || undefined };
        const r = await call(`/api/sessions/${sessionId}/fork`, { method: 'POST', body: JSON.stringify(body) });
        S.sessions.set(r.id, r);
        await openSession(r.id);
        warnNotes(r);
        toast(r.git?.isolated ? `갈래를 격리해서 만들었어요 · ${r.git.branch}` : '갈래를 만들었어요');
      },
      onOpen: (d) => {
        d.addEventListener('change', (e) => {
          const l = e.target.closest('label'); const grp = l?.parentElement; if (!grp || !e.target.matches('input[type=radio]')) return;
          grp.querySelectorAll('label').forEach((x) => x.classList.toggle('on', x.querySelector('input').checked));
        });
      },
    });
  }
  function goToOrigin(s) {
    const o = s?.forkOf; if (!o) return;
    const origin = S.sessions.get(o.sessionId);
    if (!origin) return toast('원본 세션이 없어요 (삭제됐을 수 있어요)', true);
    openSession(o.sessionId).then(() => { if (o.jobId) setTimeout(() => { try { gotoJob(o.jobId); } catch {} }, 150); });
  }

  /* ======================= 내보내기 ======================= */
  async function exportSession(id, fmt = 'md') {
    const s = S.sessions.get(id) || SU.archived.get(id);
    toast(fmt === 'json' ? 'JSON으로 내보내는 중…' : '마크다운으로 내보내는 중…');
    try {
      const r = await fetch(`/api/sessions/${id}/export.${fmt}`, { cache: 'no-store' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
      const blob = await r.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${safeName(s?.title)}.${fmt}`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast(`${a.download} 내려받기를 시작했어요`);
    } catch (e) { toast(`내보내기 실패 · ${e.message}`, true); }
  }
  function openExportMenu(id, anchor) {
    openPop(anchor, [
      { header: '내보내기 · 요청·계획·결과·보고서·바뀐 파일' },
      { label: '마크다운 (.md)', desc: '읽고 공유하기 좋아요', icon: 'download', run: () => { closePop(); exportSession(id, 'md'); } },
      { label: 'JSON (.json)', desc: '다른 도구에서 다루기 좋아요', icon: 'file', run: () => { closePop(); exportSession(id, 'json'); } },
    ], { below: true });
  }

  /* ======================= 세션 메뉴 · 삭제 ======================= */
  window.hubSessionMenuItems = window.hubSessionMenuItems || [];
  window.hubSessionMenuItems.push((s, { live, anchor }) => {
    const items = [];
    const c = caps(); if (!c.sessionArchive && !c.sessionFork && !c.sessionExport) return items;
    items.push({ sep: true });
    if (c.sessionFork) items.push({ label: '갈래 만들기', icon: 'fork', desc: s.jobCount ? '어느 작업까지 이어받을지 골라요' : '아직 작업이 없어 빈 갈래가 돼요', run: () => { closePop(); openForkDialog(s.id); } });
    // 같은 mousedown 안에서 팝오버를 갈아끼우면 바깥 클릭으로 오인돼 닫히므로 한 틱 뒤에 연다
    if (c.sessionExport) items.push({ label: '내보내기…', icon: 'download', desc: '마크다운 · JSON', run: () => setTimeout(() => openExportMenu(s.id, anchor), 0) });
    if (c.sessionArchive) items.push(s.archived
      ? { label: '복원', icon: 'unarchive', desc: '보관함에서 세션 목록으로', run: () => { closePop(); unarchive(s.id); } }
      : { label: '보관', icon: 'archive', desc: live ? '실행 중에는 보관할 수 없어요' : '목록에서 숨겨요 · 기록은 남아요', run: () => { closePop(); archive(s.id); } });
    return items;
  });
  window.hubDeleteSession = (s) => {
    if (!(s?.git?.isolated && !s.git.cleanedAt)) return false;
    dialog({
      title: '세션 삭제', confirm: '삭제', danger: true,
      body: `<p class="su-p">"<b>${esc(s.title)}</b>" 세션을 목록에서 지울까요? 작업 결과 파일과 실행 기록 폴더는 그대로 남아요.</p>
        ${check('cleanup', 'worktree도 지우기', `작업 폴더 <span class="mono">${esc(shortPath(s.git.worktree, 2))}</span>를 지워요. 브랜치 <span class="mono">${esc(s.git.branch)}</span>는 남아요. 커밋 안 된 변경이 있으면 지우지 않고 세션도 남겨요.`)}`,
      onConfirm: async (d) => {
        const cleanup = d.querySelector('[name=cleanup]').checked;
        await call(`/api/sessions/${s.id}${cleanup ? '?cleanup=1' : ''}`, { method: 'DELETE' });
        toast(cleanup ? '세션과 worktree를 지웠어요' : '세션을 지웠어요 · worktree는 남아 있어요');
      },
    });
    return true;
  };

  /* ======================= 격리해서 시작 (새 세션) ======================= */
  window.hubCreateSession = async (cwd) => {
    if (!SU.isolate || !caps().gitSessions) return null;
    // 첫 요청의 첫 줄을 제목으로 먼저 넘겨야 브랜치·worktree 이름이 "새-세션"이 아니라 요청 내용으로 만들어진다 (서버도 같은 규칙으로 제목을 붙인다)
    const title = firstLine(typeof input !== 'undefined' ? input.value : '').trim().slice(0, 60) || undefined;
    const s = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd, isolate: true, title }) });
    SU.isolate = false; S.sessions.set(s.id, s); S.notes.delete('draft');
    await openSession(s.id);
    warnNotes(s);
    if (s.git?.isolated) toast(`격리 세션을 시작했어요 · ${s.git.branch}`);
    return s.id;
  };
  function isolateChip() {
    if (!caps().gitSessions) return '';
    const cwd = currentCwd(); if (SU.isolateCwd !== cwd.toLowerCase()) { SU.isolateCwd = cwd.toLowerCase(); SU.isolate = false; }
    return `<button type="button" class="chip su-iso ${SU.isolate ? 'on' : ''}" data-su="isolate" aria-pressed="${SU.isolate}" title="${SU.isolate ? '첫 요청을 보내면 git worktree를 만들어 그 안에서 작업해요. 다시 누르면 해제' : 'git 저장소의 커밋된 상태에서 새 브랜치와 작업 폴더(worktree)를 만들어 시작해요. 저장소가 아니면 격리 없이 시작해요'}">${icon('branch')}<span>${SU.isolate ? '격리해서 시작 · worktree' : '격리해서 시작'}</span></button>`;
  }
  function branchChip(s) {
    if (!s?.git?.isolated) return '';
    const cleaned = !!s.git.cleanedAt;
    const short = String(s.git.branch).replace(/^ai-hub\/\d{4}-\d{2}-\d{2}-/, ''); // 칩에는 날짜 접두어를 빼고, 전체 이름은 툴팁에
    return `<button type="button" class="chip su-branch ${cleaned ? 'off' : ''}" data-su="git-tab" title="${esc(`${s.git.branch}\n기준 ${s.git.baseBranch} · ${cleaned ? 'worktree 정리됨' : `worktree ${s.git.worktree}`}\n눌러서 Git 패널 열기`)}">${icon('branch')}<span class="su-bn">${esc(short)}</span>${cleaned ? '<i class="su-mini">정리됨</i>' : ''}</button>`;
  }
  window.hubTopExtras = window.hubTopExtras || [];
  window.hubTopExtras.push((s) => { queueMicrotask(paintBar); return s ? branchChip(s) : isolateChip(); });

  /* ======================= 대화 위 안내 줄 (갈래 · 보관 · 정리됨) ======================= */
  function ensureBar() {
    if (SU.bar?.isConnected) return SU.bar;
    const bar = document.createElement('div'); bar.id = 'suBar'; bar.hidden = true;
    (document.getElementById('goalBar') || document.getElementById('scroll')).insertAdjacentElement('beforebegin', bar);
    bar.addEventListener('click', onAction);
    return (SU.bar = bar);
  }
  function paintBar() {
    const bar = ensureBar(); const s = cur();
    const rows = [];
    if (s?.forkOf) {
      const origin = S.sessions.get(s.forkOf.sessionId); const j = s.forkOf.jobId ? S.jobs.get(s.forkOf.jobId) : null;
      const name = esc(origin?.title || s.forkTitle || '원본');
      const what = s.forkOf.jobId ? (j ? `'<em title="${esc(jobTitle(j))}">${esc(jobTitle(j).slice(0, 40))}${jobTitle(j).length > 40 ? '…' : ''}</em>' 작업에서` : '어느 작업에서') : '빈 상태에서';
      rows.push(`<div class="su-row fork">${icon('fork')}<span class="su-row-t"><b>${name}</b> 세션의 ${what} 갈라졌어요${origin ? '' : ' <small>(원본 세션은 지워졌어요)</small>'}</span>${origin ? `<button type="button" class="btn" data-su="origin">${icon('reuse')}원본으로 가기</button>` : ''}</div>`);
    }
    if (s?.archived) rows.push(`<div class="su-row arch">${icon('archive')}<span class="su-row-t"><b>보관된 세션</b> · 기록은 그대로 남아 있어요. 새 요청은 복원한 뒤 보낼 수 있어요</span><button type="button" class="btn" data-su="unarchive">${icon('unarchive')}복원</button></div>`);
    if (s?.git?.cleanedAt) rows.push(`<div class="su-row clean">${icon('folderx')}<span class="su-row-t"><b>worktree 정리됨</b> · 작업 폴더는 지웠고 브랜치 <span class="mono">${esc(s.git.branch)}</span>는 남아 있어요. 이어서 작업하려면 격리해서 갈래를 만드세요</span><button type="button" class="btn" data-su="fork-isolated">${icon('fork')}격리해서 갈래 만들기</button></div>`);
    bar.innerHTML = rows.join(''); bar.hidden = !rows.length;
    lockComposer(!!(s && (s.archived || s.git?.cleanedAt)), s?.archived ? '보관된 세션이에요 · 복원하면 다시 요청을 보낼 수 있어요' : 'worktree가 정리된 세션이에요 · 격리해서 갈래를 만들어 이어가세요');
  }
  function lockComposer(lock, why) {
    const comp = document.getElementById('composer'); const inp = document.getElementById('in'); if (!comp || !inp) return;
    if (SU.lockedPlaceholder == null) SU.lockedPlaceholder = inp.placeholder;
    comp.classList.toggle('su-locked', lock);
    if (lock) { inp.disabled = true; inp.placeholder = why; }
    else if (inp.disabled && comp.dataset.suLocked === '1') { inp.disabled = false; inp.placeholder = SU.lockedPlaceholder; }
    comp.dataset.suLocked = lock ? '1' : '0';
  }

  /* ======================= 작업 카드: 여기서 갈래 만들기 ======================= */
  window.hubJobExtras = window.hubJobExtras || [];
  window.hubJobExtras.push((j) => (caps().sessionFork && !LIVE.has(j.status) ? `<div class="su-jx"><button type="button" class="su-link" data-su="fork-job" data-job="${esc(j.id)}" title="이 작업까지의 대화를 이어받는 새 세션을 만들어요">${icon('fork')}여기서 갈래 만들기</button></div>` : ''));

  /* ======================= Git 패널 ======================= */
  function gitState(sid) {
    let st = SU.git.get(sid);
    if (!st) { st = { data: null, loading: false, error: '', at: 0, stale: true, ci: null, ciLoading: false, ciError: '', result: null, busy: '', err: null, moreFiles: false }; SU.git.set(sid, st); }
    return st;
  }
  // 불러오는 동안은 패널을 다시 그리지 않고 새로고침 버튼만 돌린다 (입력 중인 커밋 메시지·초점을 흔들지 않게)
  const spinBtn = (sel, on) => document.querySelector(`.su-git [data-su="${sel}"]`)?.setAttribute('aria-busy', on ? 'true' : 'false');
  async function loadGit(sid, { ci = false } = {}) {
    const st = gitState(sid); if (st.loading) return st;
    st.loading = true; st.error = ''; if (st.data) spinBtn('git-refresh', true); else repaintInsp();
    try { st.data = await call(`/api/sessions/${sid}/git`); st.stale = false; }
    catch (e) { st.error = e.message; }
    finally { st.at = Date.now(); st.loading = false; repaintInsp(); spinBtn('git-refresh', false); } // 실패해도 at 을 갱신해 되풀이 요청을 막는다
    if (ci && st.data?.available && st.data.github && st.ci === null) loadCi(sid);
    return st;
  }
  async function loadCi(sid) {
    const st = gitState(sid); if (st.ciLoading) return;
    st.ciLoading = true; st.ciError = ''; if (st.ci) spinBtn('ci-refresh', true); else repaintInsp();
    try { st.ci = await call(`/api/sessions/${sid}/git/ci`); }
    catch (e) { st.ciError = e.message; }
    finally { st.ciLoading = false; repaintInsp(); spinBtn('ci-refresh', false); }
  }
  async function gitAction(sid, kind, body = {}, { done } = {}) {
    const st = gitState(sid); if (st.busy) return;
    st.busy = kind; st.err = null; st.result = null; repaintInsp();
    try {
      const r = await call(`/api/sessions/${sid}/git/${kind}`, { method: 'POST', body: JSON.stringify(body) });
      st.result = { kind, ...r, at: Date.now() };
      done?.(r);
    } catch (e) { st.err = { kind, ...errorOf(e) }; toast(st.err.message, true); }
    finally { st.busy = ''; st.stale = true; repaintInsp(); loadGit(sid); if (['push', 'pr'].includes(kind)) { st.ci = null; loadCi(sid); } }
  }
  const CI_KO = { none: ['아직 검사 없음', 'c-muted', 'minus'], pending: ['진행 중', 'c-run', 'spin'], success: ['통과', 'c-ok', 'okcircle'], failure: ['실패', 'c-err', 'alert'], unavailable: ['확인 불가', 'c-warn', 'info'] };
  function fileKind(code) {
    const c = String(code || '  ');
    if (/U/.test(c) || c === 'AA' || c === 'DD') return ['충돌', 'err'];
    if (c.trim() === '??') return ['새 파일', 'ok'];
    if (/D/.test(c)) return ['삭제', 'err'];
    if (/R/.test(c)) return ['이름 바뀜', ''];
    if (/C/.test(c)) return ['복사', ''];
    if (/A/.test(c)) return ['추가', 'ok'];
    return ['수정', 'warn'];
  }
  const pathHtml = (p, label = p) => (remote()
    ? `<span class="su-path"><span class="mono" title="${esc(p)}">${esc(label)}</span><button type="button" class="icon-btn xs" data-su="copy" data-v="${esc(p)}" title="경로 복사" aria-label="경로 복사">${icon('copy')}</button></span>`
    : `<button type="button" class="link mono" data-open="${esc(p)}" title="${esc(p)}&#10;눌러서 탐색기로 열기 · 오른쪽 클릭으로 경로 복사">${esc(label)}</button>`);
  const errBox = (e, extra = '') => `<div class="su-err" role="alert">${icon('alert')}<div><b>${esc(e.message)}</b>${e.files?.length ? `<ul class="su-flist-sm">${e.files.slice(0, 12).map((f) => `<li class="mono">${esc(f)}</li>`).join('')}${e.files.length > 12 ? `<li>…외 ${e.files.length - 12}개</li>` : ''}</ul>` : ''}${extra}</div></div>`;

  function renderGitTab(body, s) {
    if (!s) { body.innerHTML = `<div class="insp-empty">${icon('branch')}<p>세션을 열면 브랜치와 변경 사항이 여기에 보여요</p><small>새 세션은 상단의 "격리해서 시작"으로 worktree 안에서 시작할 수 있어요</small></div>`; return; }
    if (!caps().gitSessions) { body.innerHTML = `<div class="insp-empty">${icon('branch')}<p>이 허브 버전에는 Git 기능이 없어요</p><small>진행 중인 작업이 끝난 뒤 허브를 다시 시작하세요</small></div>`; return; }
    const st = gitState(s.id); const live = isLive(s);
    if (!st.loading && (st.stale || (!live && Date.now() - st.at > 10_000))) { st.stale = false; queueMicrotask(() => loadGit(s.id, { ci: true })); }
    if (!st.data && st.loading) { body.innerHTML = `<div class="su-skel" aria-busy="true" aria-label="Git 상태 불러오는 중"><i></i><i></i><i></i></div>`; return; }
    if (!st.data && st.error) { body.innerHTML = `<div class="insp-empty">${icon('alert')}<p>Git 상태를 읽지 못했어요</p><small>${esc(st.error)}</small><button type="button" class="btn" data-su="git-refresh">${icon('refresh')}다시 시도</button></div>`; return; }
    const g = st.data; if (!g) { body.innerHTML = ''; return; }
    const sg = s.git || {};
    if (!g.available && g.reason === 'not-repository') {
      body.innerHTML = `<div class="insp-empty">${icon('branch')}<p>git 저장소가 아니에요</p><small>이 폴더는 git으로 관리하지 않아요. 저장소 폴더에서 세션을 시작하면 브랜치·커밋·병합을 여기서 할 수 있어요.</small><div class="su-path-line">${pathHtml(s.cwd, shortPath(s.cwd, 3))}</div></div>`; return;
    }
    const isolated = !!(g.isolated || sg.isolated); const cleaned = !!(sg.cleanedAt || g.reason === 'cleaned');
    const busy = !!st.busy || !!g.busy; const blocked = busy || live || cleaned || !!s.archived;
    const why = s.archived ? '보관된 세션이에요 · 복원한 뒤 사용할 수 있어요' : live ? '실행 중인 작업이 끝난 뒤 사용할 수 있어요' : g.busy ? '이 저장소의 Git 작업이 끝난 뒤 사용할 수 있어요' : '';
    const dis = (cond) => (blocked || cond ? 'disabled' : '');
    const refresh = `<button type="button" class="icon-btn xs" data-su="git-refresh" title="상태 새로고침" aria-label="Git 상태 새로고침" ${st.loading ? 'aria-busy="true"' : ''}>${icon('refresh')}</button>`;
    let h = '';

    // 1) 브랜치
    const branch = g.branch || sg.branch || '(분리된 HEAD)'; const base = sg.baseBranch || g.baseBranch;
    const vsBase = !isolated ? null : g.baseBranchAhead != null ? [g.baseBranchAhead, g.baseBranchBehind, '기준 대비'] : g.ahead != null ? [g.ahead, g.behind, '시작 커밋 대비'] : null;
    h += `<div class="card su-card"><div class="card-h"><span class="su-badges"><span class="badge ${cleaned ? 's-partial' : isolated ? 's-running' : ''}">${icon('branch')}${cleaned ? 'worktree 정리됨' : isolated ? '격리 세션' : 'git 저장소'}</span>${g.inProgress ? `<span class="badge s-partial" title="병합·리베이스 등이 진행 중이에요">진행 중인 Git 작업</span>` : ''}</span>${refresh}</div>
      <div class="su-branch-name mono" title="${esc(branch)}">${esc(branch)}</div>
      <div class="su-kvs">${isolated && base ? `<div class="su-kv"><span>기준 브랜치</span><b class="mono">${esc(base)}</b></div>` : ''}
        ${vsBase ? `<div class="su-kv"><span>${esc(vsBase[2])}</span><b class="su-ab"><i class="up" title="앞선 커밋">↑${vsBase[0]}</i><i class="down" title="뒤처진 커밋">↓${vsBase[1]}</i></b></div>` : ''}
        ${!cleaned ? `<div class="su-kv"><span>변경 파일</span><b>${g.changedFiles ? `${g.changedFiles}개` : '없음'}</b></div>` : ''}
        <div class="su-kv"><span>원격</span>${g.github ? `<a class="su-a" href="${esc(g.github.url)}" target="_blank" rel="noopener noreferrer" title="${esc(g.origin || g.github.url)}">${icon('open')}${esc(g.github.owner)}/${esc(g.github.repo)}</a>` : g.origin ? `<span class="mono su-ell" title="${esc(g.origin)}">${esc(g.origin)}</span>` : '<span class="c-muted">origin 없음</span>'}</div>
        ${isolated ? `<div class="su-kv"><span>worktree</span>${cleaned ? '<span class="c-muted">정리됨</span>' : pathHtml(g.worktree || sg.worktree, shortPath(g.worktree || sg.worktree, 2))}</div><div class="su-kv"><span>원본 저장소</span>${pathHtml(g.repo || sg.repo, shortPath(g.repo || sg.repo, 2))}</div>` : `<div class="su-kv"><span>저장소</span>${pathHtml(g.repo, shortPath(g.repo, 2))}</div>`}
        ${sg.prUrl ? `<div class="su-kv"><span>PR</span><a class="su-a" href="${esc(sg.prUrl)}" target="_blank" rel="noopener noreferrer">${icon('pr')}PR 열기</a></div>` : ''}</div>
      ${why && isolated && !cleaned ? `<div class="su-hint">${live ? '<span class="spin-xs"></span>' : icon('clock')}<span>${esc(why)}</span></div>` : ''}</div>`;

    if (cleaned) {
      h += `<div class="card su-card"><p class="su-p">작업 폴더는 지웠고 브랜치 <span class="mono">${esc(branch)}</span>와 커밋은 저장소에 남아 있어요. 이어서 작업하려면 격리해서 갈래를 만드세요.</p><div class="ibtns"><button type="button" class="btn" data-su="fork-isolated">${icon('fork')}격리해서 갈래 만들기</button></div></div>`;
      body.innerHTML = h; return;
    }

    // 2) 변경 파일
    const files = g.files || []; const shown = st.moreFiles ? files : files.slice(0, 8);
    h += `<div class="card su-card"><div class="card-h"><b>변경 파일 ${files.length ? files.length : ''}</b>${files.length ? '' : '<span class="c-muted">작업 폴더가 깨끗해요</span>'}</div>
      ${files.length ? `<ul class="su-flist">${shown.map((f) => { const [k, cls] = fileKind(f.status); const name = fileName(f.path); const dir = f.path.slice(0, f.path.length - name.length); return `<li title="${esc(f.path)} · ${esc(f.status.trim() || k)}"><span class="fk k-${cls}">${k}</span><span class="su-fn"><b>${esc(name)}</b><small>${esc(dir || '.')}</small></span></li>`; }).join('')}</ul>${files.length > 8 ? `<button type="button" class="su-link" data-su="more-files">${st.moreFiles ? '접기' : `${files.length - 8}개 더 보기`}</button>` : ''}` : ''}</div>`;

    if (!isolated) {
      h += `<div class="card su-card su-note-card">${icon('info')}<div><p class="su-p">커밋·병합·PR은 <b>격리 세션</b>(git worktree)에서만 할 수 있어요. 이 세션은 저장소 폴더에서 바로 작업하는 일반 세션이에요.</p><div class="ibtns"><button type="button" class="btn" data-su="fork-isolated">${icon('fork')}격리해서 갈래 만들기</button></div></div></div>`;
      body.innerHTML = h; return;
    }

    // 3) 커밋
    const r = st.result; const e = st.err;
    h += `<div class="card su-card"><div class="card-h"><b>커밋</b>${g.changedFiles ? `<span class="c-muted">${g.changedFiles}개 변경</span>` : ''}</div>
      <textarea class="su-ta" id="suCommitMsg" rows="2" placeholder="${esc(`${s.title} 작업 반영`)}" maxlength="4000" ${dis(!g.changedFiles)} aria-label="커밋 메시지">${esc(st.msg || '')}</textarea>
      <div class="su-acts"><button type="button" class="btn primary" data-su="commit" ${dis(!g.changedFiles)} title="${esc(why || (!g.changedFiles ? '커밋할 변경이 없어요' : '변경 전체를 커밋해요 (.env·인증 파일 제외)'))}">${st.busy === 'commit' ? '<span class="spinner"></span>' : icon('commit')}커밋</button><small class="fine-inline">.env·인증 파일은 커밋하지 않아요</small></div>
      ${e?.kind === 'commit' ? errBox(e) : r?.kind === 'commit' ? (r.committed ? `<div class="su-ok">${icon('check')}<span>${r.files.length}개 파일을 커밋했어요 · <span class="mono">${esc(r.commit.slice(0, 7))}</span></span></div>` : `<div class="su-hint">${icon('info')}<span>${esc(r.message)}</span></div>`) : ''}</div>`;

    // 4) 기준 브랜치로 반영 (병합 · push · PR)
    const dirty = g.changedFiles > 0; const nothing = (g.baseBranchAhead ?? g.ahead ?? 0) === 0;
    const mergeTip = why || (dirty ? '먼저 커밋하세요' : nothing ? `${base}에 반영할 새 커밋이 없어요` : `${base}에 바로 병합해요`);
    const prTip = why || (dirty ? '먼저 커밋하세요' : !g.github ? 'GitHub origin이 있어야 PR을 만들 수 있어요' : 'origin에 push한 뒤 GitHub 비교 화면을 열어요');
    const pushTip = why || (dirty ? '먼저 커밋하세요' : !g.origin ? 'origin 원격이 없어요' : 'origin에 이 브랜치를 push해요');
    const baseShort = String(base || '').replace(/^ai-hub\/\d{4}-\d{2}-\d{2}-/, ''); // 갈래의 기준이 긴 ai-hub 브랜치면 날짜 접두어는 뺀다
    h += `<div class="card su-card"><div class="card-h"><b class="su-ell" title="${esc(base || '')}">${esc(baseShort || '기준 브랜치')}에 반영</b></div>
      <div class="su-acts wrap">
        <button type="button" class="btn" data-su="merge" ${dis(dirty || nothing)} title="${esc(mergeTip)}">${st.busy === 'merge' ? '<span class="spinner"></span>' : icon('merge')}${baseShort.length > 18 ? '기준 브랜치로 병합' : `${esc(baseShort || '기준')}으로 병합`}</button>
        ${g.github ? `<button type="button" class="btn" data-su="pr" ${dis(dirty)} title="${esc(prTip)}">${st.busy === 'pr' ? '<span class="spinner"></span>' : icon('pr')}PR 만들기</button>` : ''}
        ${g.origin ? `<button type="button" class="btn" data-su="push" ${dis(dirty)} title="${esc(pushTip)}">${st.busy === 'push' ? '<span class="spinner"></span>' : icon('upload')}push</button>` : ''}
      </div>
      <p class="fine">병합은 원본 저장소의 <span class="mono">${esc(base)}</span>에 바로 반영돼요. 충돌이 나면 자동으로 취소하고 원래 상태로 돌려요. push·PR은 확인 뒤에만 실행해요.</p>
      ${e && ['merge', 'pr', 'push'].includes(e.kind) ? errBox(e, e.code === 'GIT_MERGE_CONFLICT' ? '<small class="fine">원본 저장소는 병합 전 상태로 돌아갔어요</small>' : e.code === 'GIT_DIRTY' ? '<small class="fine">원본 저장소나 worktree에 커밋 안 된 변경이 있어요</small>' : '') : ''}
      ${r?.kind === 'merge' ? `<div class="su-ok">${icon('check')}<span>${esc(r.baseBranch)}에 병합했어요 · ${r.fastForward ? 'fast-forward' : '병합 커밋'} <span class="mono">${esc(r.commit.slice(0, 7))}</span></span></div>` : ''}
      ${r?.kind === 'push' ? `<div class="su-ok">${icon('check')}<span>origin에 push했어요 · <span class="mono">${esc(r.commit.slice(0, 7))}</span></span></div>` : ''}
      ${r?.kind === 'pr' ? `<div class="su-ok col">${icon('check')}<div><span>push했어요${r.created ? ' · PR을 만들었어요' : ''}</span>${r.warning ? `<small class="c-warn">${esc(r.warning)}</small>` : ''}<a class="btn su-pr-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${icon('open')}${r.created ? 'PR 열기' : '비교 화면에서 PR 만들기'}</a></div></div>` : ''}</div>`;

    // 5) CI
    if (g.github) {
      const ci = st.ci; const k = CI_KO[ci?.status] || null;
      h += `<div class="card su-card"><div class="card-h"><b>CI 검사</b><button type="button" class="icon-btn xs" data-su="ci-refresh" title="CI 상태 새로고침" aria-label="CI 상태 새로고침" ${st.ciLoading ? 'aria-busy="true"' : ''}>${icon('refresh')}</button></div>
        ${st.ciLoading && !ci ? `<div class="su-hint"><span class="spin-xs"></span><span>GitHub에서 검사 상태를 확인하는 중…</span></div>`
          : st.ciError && !ci ? `<div class="su-hint">${icon('alert')}<span>${esc(st.ciError)}</span></div>`
          : !ci ? `<div class="su-hint">${icon('info')}<span>push한 커밋의 검사 상태를 보여 줘요</span></div>`
          : `<div class="su-ci ${ci.status}"><span class="su-ci-st ${k[1]}">${k[2] === 'spin' ? '<span class="spin-xs"></span>' : icon(k[2])}<b>${k[0]}</b></span>${ci.sha ? `<span class="mono c-muted" title="${esc(ci.sha)}">${esc(ci.sha.slice(0, 7))}</span>` : ''}${ci.source ? `<span class="c-muted">${ci.source === 'gh' ? 'gh' : 'GitHub 공개 API'}</span>` : ''}</div>
            ${ci.status === 'unavailable' ? `<p class="fine">${esc(ci.message || '검사 상태를 읽지 못했어요')} · 비공개 저장소이거나 API 한도일 수 있어요</p>` : ''}
            ${ci.checks?.length ? `<ul class="su-checks">${ci.checks.slice(0, 10).map((c) => { const done = c.status === 'completed'; const bad = done && !['success', 'neutral', 'skipped'].includes(c.conclusion); return `<li><span class="${done ? (bad ? 'c-err' : 'c-ok') : 'c-run'}">${done ? icon(bad ? 'alert' : 'check') : '<span class="spin-xs"></span>'}</span><span class="su-ell">${esc(c.name || '검사')}</span>${c.url ? `<a class="icon-btn xs" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="GitHub에서 보기" aria-label="${esc(c.name || '검사')} GitHub에서 보기">${icon('open')}</a>` : ''}</li>`; }).join('')}${ci.checks.length > 10 ? `<li class="c-muted">…외 ${ci.checks.length - 10}개</li>` : ''}</ul>` : ''}
            ${ci.url ? `<a class="su-a" href="${esc(ci.url)}" target="_blank" rel="noopener noreferrer">${icon('open')}Actions 페이지</a>` : ''}`}</div>`;
    }

    // 6) 정리
    h += `<div class="card su-card"><div class="card-h"><b>worktree 정리</b></div><p class="fine">작업 폴더만 지우고 브랜치와 커밋은 남겨요. 커밋 안 된 변경이 있으면 정리하지 않아요. 정리한 뒤에는 이 세션에서 새 요청을 보낼 수 없어요.</p>
      <div class="su-acts"><button type="button" class="btn danger" data-su="cleanup" ${dis(false)} title="${esc(why || 'worktree를 지워요')}">${st.busy === 'cleanup' ? '<span class="spinner"></span>' : icon('folderx')}worktree 정리</button></div>
      ${e?.kind === 'cleanup' ? errBox(e) : r?.kind === 'cleanup' ? `<div class="su-ok">${icon('check')}<span>정리했어요 · 브랜치 <span class="mono">${esc(r.branch)}</span>는 남아 있어요</span></div>` : ''}</div>`;
    // 내용이 같으면 다시 그리지 않는다 (작업 로그 때문에 패널이 자주 다시 그려져도 초점·버튼이 흔들리지 않게)
    const root = body.firstElementChild;
    if (root?.classList.contains('su-git') && root.dataset.sid === s.id && st.html === h) return;
    st.html = h;
    // 커밋 메시지를 쓰는 중에 다시 그려져도 초점과 커서를 잃지 않게
    const ta = document.activeElement; const caret = ta?.id === 'suCommitMsg' ? [ta.selectionStart, ta.selectionEnd] : null;
    body.innerHTML = `<div class="su-git" data-sid="${esc(s.id)}">${h}</div>`;
    if (caret) { const n = document.getElementById('suCommitMsg'); if (n && !n.disabled) { n.focus({ preventScroll: true }); try { n.setSelectionRange(caret[0], caret[1]); } catch {} } }
  }
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'git', label: 'Git', icon: 'branch', render: renderGitTab });
  if (document.readyState !== 'loading' && typeof renderInspTabs === 'function') renderInspTabs();

  function openGitTab() {
    S.insp.tab = 'git'; S.prefs.inspTab = 'git'; savePrefs();
    if (typeof toggleRight === 'function' && typeof inspOpen === 'function' && !inspOpen()) toggleRight(true);
    if (typeof renderInspTabs === 'function') renderInspTabs();
    if (typeof renderInspector === 'function') renderInspector();
  }

  /* ---------- Git 확인 대화상자 ---------- */
  function confirmMerge(s, g) {
    const base = s.git.baseBranch;
    dialog({
      title: `${base}으로 병합`, confirm: '병합',
      body: `<p class="su-p"><span class="mono">${esc(s.git.branch)}</span>를 원본 저장소의 <span class="mono">${esc(base)}</span>에 병합할까요?</p>
        <ul class="su-tips"><li>${icon('folder')}<span>원본 저장소 <span class="mono">${esc(shortPath(s.git.repo, 2))}</span>가 지금 <span class="mono">${esc(base)}</span>를 보고 있어야 해요. 브랜치를 자동으로 바꾸지 않아요.</span></li><li>${icon('merge')}<span>가능하면 fast-forward, 아니면 병합 커밋을 만들어요.</span></li><li>${icon('alert')}<span>충돌이 나거나 원본에 커밋 안 된 변경이 있으면 아무것도 바꾸지 않고 취소해요. 병합한 뒤 되돌리려면 git에서 직접 되돌려야 해요.</span></li></ul>`,
      onConfirm: async () => { gitAction(s.id, 'merge', {}, { done: () => toast(`${base}에 병합했어요`) }); },
    });
  }
  function confirmPush(s, g) {
    dialog({
      title: 'origin에 push', confirm: 'push',
      body: `<p class="su-p"><span class="mono">${esc(s.git.branch)}</span>를 <span class="mono su-ell-inline" title="${esc(g.origin || '')}">${esc(g.github ? `${g.github.owner}/${g.github.repo}` : g.origin || 'origin')}</span>에 push할까요?</p>
        <ul class="su-tips"><li>${icon('upload')}<span>올라간 커밋은 원격을 보는 다른 사람도 볼 수 있어요. 강제 push는 하지 않아요.</span></li><li>${icon('info')}<span>이 PC의 git 인증을 그대로 써요. 인증 창은 띄우지 않으니 실패하면 터미널에서 한 번 로그인하세요.</span></li></ul>`,
      onConfirm: async () => { gitAction(s.id, 'push', {}, { done: () => toast('push했어요') }); },
    });
  }
  function confirmPr(s, g) {
    dialog({
      title: 'PR 만들기', confirm: 'push하고 PR 만들기', wide: true,
      body: `<p class="su-p"><span class="mono">${esc(s.git.branch)}</span>를 <b>${esc(g.github.owner)}/${esc(g.github.repo)}</b>에 push한 뒤 PR을 만들어요.</p>
        ${field('PR 제목', `<input class="su-in" name="title" maxlength="250" value="${esc(s.title)}" autocomplete="off">`)}
        ${field('설명 (선택)', `<textarea class="su-ta" name="body" rows="3" placeholder="${esc(`${s.title} 작업 반영`)}"></textarea>`)}
        <ul class="su-tips"><li>${icon('upload')}<span>올라간 커밋은 저장소를 보는 다른 사람도 볼 수 있어요.</span></li><li>${icon('open')}<span><b>gh</b>가 설치돼 있으면 PR을 바로 만들고, 없으면 GitHub 비교 화면이 새 창으로 열려요. 거기서 "Create pull request"를 누르면 돼요.</span></li></ul>`,
      onConfirm: async (d) => {
        const body = { title: d.querySelector('[name=title]').value.trim() || undefined, body: d.querySelector('[name=body]').value.trim() || undefined };
        gitAction(s.id, 'pr', body, { done: (r) => { toast(r.created ? 'PR을 만들었어요' : 'push했어요 · 비교 화면을 열어요'); openUrl(r.url); } });
      },
    });
  }
  function confirmCleanup(s) {
    dialog({
      title: 'worktree 정리', confirm: '정리', danger: true,
      body: `<p class="su-p">작업 폴더 <span class="mono">${esc(shortPath(s.git.worktree, 2))}</span>를 지울까요?</p>
        <ul class="su-tips"><li>${icon('branch')}<span>브랜치 <span class="mono">${esc(s.git.branch)}</span>와 커밋은 저장소에 남아요.</span></li><li>${icon('alert')}<span>커밋 안 된 변경이 있으면 정리하지 않아요.</span></li><li>${icon('info')}<span>정리한 뒤에는 이 세션에서 새 요청을 보낼 수 없어요. 기록 보기·내보내기는 그대로 돼요.</span></li></ul>`,
      onConfirm: async () => { gitAction(s.id, 'cleanup', {}, { done: () => toast('worktree를 정리했어요') }); },
    });
  }

  /* ======================= 클릭 처리 ======================= */
  function onAction(e) {
    const el = e.target.closest('[data-su]'); if (!el) return;
    const act = el.dataset.su; const s = cur();
    switch (act) {
      case 'isolate': SU.isolate = !SU.isolate; renderTop(); if (SU.isolate) toast('첫 요청을 보내면 git worktree를 만들어 격리된 폴더에서 작업해요'); return;
      case 'git-tab': return openGitTab();
      case 'origin': return goToOrigin(s);
      case 'unarchive': return s && unarchive(s.id);
      case 'fork-isolated': return s && openForkDialog(s.id, null, { isolate: true });
      case 'fork-job': { const j = S.jobs.get(el.dataset.job); return j && openForkDialog(j.sessionId, j.id); }
      case 'archive-toggle': SU.archiveOpen = !SU.archiveOpen; if (SU.archiveOpen) loadArchived(); renderTree(); return;
      case 'open-archived': if (e.target.closest('[data-su="archived-menu"]')) return; return openArchived(el.dataset.id);
      case 'archived-menu': e.stopPropagation(); return openArchivedMenu(el.dataset.id, el);
      case 'copy': return copyText(el.dataset.v, '경로를 복사했어요');
      case 'git-refresh': if (s) { gitState(s.id).stale = true; loadGit(s.id, { ci: true }); } return;
      case 'ci-refresh': return s && loadCi(s.id);
      case 'more-files': if (s) { const st = gitState(s.id); st.moreFiles = !st.moreFiles; repaintInsp(); } return;
      case 'commit': { if (!s) return; const st = gitState(s.id); const msg = (document.getElementById('suCommitMsg')?.value || st.msg || '').trim(); return gitAction(s.id, 'commit', msg ? { message: msg } : {}, { done: (r) => { if (r.committed) st.msg = ''; toast(r.committed ? `${r.files.length}개 파일을 커밋했어요` : r.message); } }); }
      case 'merge': { const g = gitState(s?.id)?.data; return s && g && confirmMerge(s, g); }
      case 'push': { const g = gitState(s?.id)?.data; return s && g && confirmPush(s, g); }
      case 'pr': { const g = gitState(s?.id)?.data; return s && g?.github && confirmPr(s, g); }
      case 'cleanup': return s && confirmCleanup(s);
    }
  }
  document.addEventListener('click', onAction);
  // 커밋 메시지 초안은 패널이 다시 그려져도 남긴다
  document.addEventListener('input', (e) => { if (e.target.id === 'suCommitMsg' && S.current) gitState(S.current).msg = e.target.value; });
  document.getElementById('tree')?.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('.su-arow'); if (!row) return;
    if (e.key === 'Enter') { e.preventDefault(); openArchived(row.dataset.id); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const rows = [...document.querySelectorAll('#tree .su-arow')]; const i = rows.indexOf(row); const n = rows[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (n) { e.preventDefault(); n.focus(); } }
  });
  document.getElementById('tree')?.addEventListener('contextmenu', (e) => { const row = e.target.closest?.('.su-arow'); if (!row) return; e.preventDefault(); e.stopPropagation(); openArchivedMenu(row.dataset.id, pointAnchor(e.clientX, e.clientY)); }, true);

  /* ======================= 실시간 이벤트 ======================= */
  window.hubTreeExtras = window.hubTreeExtras || [];
  window.hubTreeExtras.push(archiveBoxHtml);
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail; if (!ev) return;
    if (ev.type === 'hello') {
      // 보관한 세션은 hello 에 없다. 캐시해 둔 것을 합쳐 두면 보관 세션도 바로 열 수 있다 (app.js 가 이 배열로 S.sessions 를 만든다)
      if (Array.isArray(ev.sessions)) { const ids = new Set(ev.sessions.map((s) => s.id)); for (const s of SU.archived.values()) if (!ids.has(s.id)) ev.sessions.push(s); }
      SU.git.clear(); queueMicrotask(paintBar);
    } else if (ev.type === 'session' && ev.session) {
      const s = ev.session; const was = S.sessions.get(s.id);
      if (s.archived) SU.archived.set(s.id, s); else SU.archived.delete(s.id);
      if (was && JSON.stringify(was.git) !== JSON.stringify(s.git)) gitState(s.id).stale = true;
      if (s.id === S.current) queueMicrotask(() => { paintBar(); if (was?.archived !== s.archived || was?.git?.cleanedAt !== s.git?.cleanedAt || was?.git?.branch !== s.git?.branch) { renderTop(); repaintInsp(); } });
    } else if (ev.type === 'session_removed') {
      SU.archived.delete(ev.sessionId); SU.git.delete(ev.sessionId);
    } else if (ev.type === 'job' && ev.job) {
      const prev = S.jobs.get(ev.job.id);
      if (prev && LIVE.has(prev.status) && !LIVE.has(ev.job.status)) { gitState(ev.job.sessionId).stale = true; if (ev.job.sessionId === S.current) queueMicrotask(repaintInsp); }
      if (!prev && ev.job.sessionId === S.current) queueMicrotask(repaintInsp); // 작업이 시작되면 버튼을 잠근다
    }
  });

  /* ======================= 시작 ======================= */
  document.addEventListener('DOMContentLoaded', () => {
    ensureBar();
    // 기능 지원 여부(S.caps)는 app.js init 이 /api/status 를 받은 뒤 정해진다. 그 뒤 보관함 수를 미리 읽어 둔다
    const tick = setInterval(() => { if (!S.caps) return; clearInterval(tick); if (caps().sessionArchive) loadArchived(); renderTop(); }, 150);
    setTimeout(() => clearInterval(tick), 20_000);
  });

  // 다른 기능 파일·시험에서 쓸 수 있게 최소한만 공개
  window.hubSessionsUI = { openForkDialog, archive, unarchive, exportSession, openGitTab, state: SU };
})();
