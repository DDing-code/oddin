/* 작업 폴더 고르기·바꾸기 (2026-10-06 사용자 "세션을 폴더로 묶거나 작업 폴더를 고를 수 있게 해줘")
   - 위쪽 폴더 칩: 새 세션이면 폴더 고르기, 세션이면 메뉴(탐색기에서 열기·작업 폴더 바꾸기·자주 쓰는 폴더로 바로 바꾸기·경로 복사)
   - 폴더 찾아보기 창(window.hubPickFolder): 드라이브부터 하위 폴더를 둘러보며 고른다 (서버 /api/dirs — 폴더 이름만)
   - 작업 폴더 바꾸기: PATCH /api/sessions/:id { cwd } — 다음 요청부터 그 폴더에서 실행, 지난 대화·결과는 그대로 */
(() => {
  if (!IC.layers) IC.layers = '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>';
  const remote = () => (typeof isRemoteView === 'function' ? isRemoteView() : false);

  /** 폴더 찾아보기 창 → 고른 경로(취소하면 null) */
  window.hubPickFolder = ({ title = '작업 폴더 고르기', start = '', confirm = '이 폴더로' } = {}) => new Promise((resolve) => {
    const body = modal(title, true);
    let cur = '', done = false;
    const finish = (v) => { if (done) return; done = true; obs.disconnect(); closeModal(); resolve(v); };
    // 창을 X·바깥 클릭으로 닫으면 취소
    const obs = new MutationObserver(() => { if ($('#modal').hidden && !done) { done = true; obs.disconnect(); resolve(null); } });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    async function go(p) {
      body.innerHTML = '<div class="fp"><div class="fp-skel">불러오는 중…</div></div>';
      let r;
      try { r = await api(`/api/dirs?path=${encodeURIComponent(p || '')}`); }
      catch (e) { toast(e.message, true); if (p) return go(''); return; }
      cur = r.path;
      const quick = (S.projects || []).slice(0, 8);
      const isRoot = !cur || path2parent(cur) === null;
      body.innerHTML = `<div class="fp">
        <form class="fp-bar" data-fp-go><button type="button" class="icon-btn" data-fp-up title="위 폴더" ${r.parent === null ? 'disabled' : ''}>${icon('up')}</button><input name="p" value="${esc(r.path)}" placeholder="드라이브 목록" aria-label="폴더 경로" autocomplete="off" spellcheck="false"><button type="submit" class="btn">이동</button></form>
        <div class="fp-tools"><button type="button" class="btn" data-fp-new ${cur ? '' : 'disabled'} title="${cur ? '지금 폴더 안에 새 폴더 만들기' : '드라이브를 먼저 고르세요'}">${icon('plus')}새 폴더</button><button type="button" class="btn" data-fp-ren="${esc(cur)}" ${isRoot ? 'disabled' : ''} title="${isRoot ? '드라이브 이름은 바꿀 수 없어요' : '지금 폴더 이름 바꾸기'}">${icon('pencil')}이름 바꾸기</button>${quick.length ? `<span class="fp-sep"></span>${quick.map((q) => `<button type="button" class="chip" data-fp-path="${esc(q.path)}" title="${esc(q.path)}">${icon('folder')}${esc(q.label || shortPath(q.path, 2))}</button>`).join('')}` : ''}</div>
        <form class="fp-edit" data-fp-edit hidden><span class="fp-edit-l"></span><input name="n" autocomplete="off" spellcheck="false" aria-label="폴더 이름"><button type="submit" class="btn primary"></button><button type="button" class="btn" data-fp-edit-cancel>취소</button></form>
        <div class="fp-list" role="listbox" aria-label="하위 폴더">${r.dirs.length ? r.dirs.map((d) => `<div class="fp-row"><button type="button" class="fp-item" data-fp-path="${esc(d.path)}" title="${esc(d.path)} · 두 번 누르면 바로 고름">${icon('folder')}<span>${esc(d.name)}</span></button>${cur ? `<button type="button" class="icon-btn fp-row-ren" data-fp-ren="${esc(d.path)}" title="이름 바꾸기" aria-label="${esc(d.name)} 이름 바꾸기">${icon('pencil')}</button>` : ''}</div>`).join('') : '<div class="empty-row">하위 폴더가 없어요</div>'}${r.truncated ? '<div class="empty-row">폴더가 많아 앞쪽 800개만 보여요. 위 칸에 경로를 적어 이동하세요</div>' : ''}</div>
        <div class="fp-foot"><span class="fp-cur" title="${esc(cur)}">${cur ? esc(cur) : '드라이브를 고르세요'}</span><span class="grow"></span><button type="button" class="btn" data-fp-cancel>취소</button><button type="button" class="btn primary" data-fp-ok ${cur ? '' : 'disabled'}>${icon('check')}${esc(confirm)}</button></div></div>`;
      body.querySelector('[data-fp-up]').onclick = () => go(r.parent || '');
      body.querySelector('[data-fp-go]').onsubmit = (e) => { e.preventDefault(); go(e.target.p.value.trim()); };
      body.querySelector('[data-fp-cancel]').onclick = () => finish(null);
      body.querySelector('[data-fp-ok]').onclick = () => cur && finish(cur);
      body.querySelectorAll('[data-fp-path]').forEach((b) => {
        b.onclick = () => go(b.dataset.fpPath);
        if (b.classList.contains('fp-item')) b.ondblclick = () => finish(b.dataset.fpPath);
      });
      // 새 폴더·이름 바꾸기: 창 안의 이름 칸으로 받는다(데스크탑 앱은 prompt 창이 없다)
      const form = body.querySelector('[data-fp-edit]'), field = form.n;
      const edit = (label, value, ok, run) => {
        form.hidden = false; form.querySelector('.fp-edit-l').textContent = label; form.querySelector('[type=submit]').textContent = ok;
        field.value = value; field.focus(); field.select();
        form.onsubmit = async (e) => {
          e.preventDefault(); const name = field.value.trim(); if (!name) return field.focus();
          const btn = form.querySelector('[type=submit]'); btn.disabled = true;
          try { await run(name); } catch (err) { toast(err.message, true); btn.disabled = false; field.focus(); }
        };
      };
      const closeEdit = () => { form.hidden = true; form.onsubmit = null; };
      form.querySelector('[data-fp-edit-cancel]').onclick = closeEdit;
      field.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEdit(); } });
      body.querySelector('[data-fp-new]').onclick = () => edit('새 폴더 이름', '새 폴더', '만들기', async (name) => {
        const made = await api('/api/dirs', { method: 'POST', body: JSON.stringify({ parent: cur, name }) });
        toast(`"${name}" 폴더를 만들었어요`); go(made.path);
      });
      body.querySelectorAll('[data-fp-ren]').forEach((b) => { b.onclick = (e) => {
        e.stopPropagation(); const target = b.dataset.fpRen, old = target.split(/[\\/]/).filter(Boolean).pop();
        edit(`"${old}" 새 이름`, old, '바꾸기', async (name) => {
          const res = await api('/api/dirs/rename', { method: 'POST', body: JSON.stringify({ path: target, name }) });
          toast(`이름을 "${name}"(으)로 바꿨어요${res.sessions ? ` · 이 폴더를 쓰던 세션 ${res.sessions}개의 작업 폴더도 같이 바꿨어요` : ''}`);
          go(target === cur ? res.path : cur); // 지금 폴더를 바꿨으면 새 이름으로, 목록의 폴더를 바꿨으면 그대로 다시 읽기
        });
      }; });
    }
    const path2parent = (p) => { const t = String(p).replace(/[\\/]+$/, ''); return /^[A-Za-z]:$/.test(t) || t === '' ? null : t; };
    go(start);
  });

  async function changeCwd(id, dir) {
    try {
      const s = await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ cwd: dir }) });
      if (s?.id) S.sessions.set(s.id, { ...S.sessions.get(s.id), ...s });
      renderTop(); renderTree();
      toast('작업 폴더를 바꿨어요 — 다음 요청부터 이 폴더에서 해요');
    } catch (e) { toast(`바꾸지 못했어요: ${e.message}`, true); }
  }
  window.hubChangeCwd = changeCwd;

  window.hubFolderChip = (anchor) => {
    if (!S.current) return openFolderPicker(anchor);
    const s = S.sessions.get(S.current); if (!s) return;
    const cur = currentCwd(), live = sessionJobs(S.current).some((j) => LIVE.has(j.status));
    const items = [{ header: `작업 폴더 · ${shortPath(cur, 3)}` }];
    if (!remote()) items.push({ label: '탐색기에서 열기', icon: 'open', run: () => { closePop(); openPath(cur); } });
    items.push({ label: '작업 폴더 바꾸기…', desc: live ? '진행 중인 작업이 끝난 뒤에 바꿀 수 있어요' : '다음 요청부터 고른 폴더에서 해요 · 지난 대화는 그대로', icon: 'folder', run: async () => {
      closePop(); if (live) return toast('진행 중인 작업이 끝난 뒤에 바꿀 수 있어요', true);
      const p = await window.hubPickFolder({ title: '이 세션의 작업 폴더 바꾸기', start: cur, confirm: '이 폴더로 바꾸기' }); if (p) changeCwd(S.current, p);
    } });
    const quick = (S.projects || []).filter((p) => p.path.toLowerCase() !== cur.toLowerCase()).slice(0, 6);
    if (quick.length && !live) { items.push({ sep: true }, { header: '이 폴더로 바로 바꾸기' }); for (const q of quick) items.push({ label: shortPath(q.path, 3), desc: q.label || q.path, run: () => { closePop(); changeCwd(S.current, q.path); } }); }
    items.push({ sep: true }, { label: '경로 복사', icon: 'copy', run: () => { closePop(); copyText(cur, '폴더 경로를 복사했어요'); } });
    openPop(anchor, items, { below: true, kind: 'folder' });
  };

  // 입력창 아래 "폴더 · <이름>" 버튼: 위쪽 칩과 같은 메뉴 (위쪽 칩을 못 찾는 경우가 있어 늘 보이는 곳에도 둔다)
  const pill = document.createElement('button');
  pill.type = 'button'; pill.className = 'pill'; pill.id = 'pFolder';
  $('#btnAttach').after(pill);
  pill.addEventListener('click', (e) => { e.stopPropagation(); window.hubFolderChip(pill); });
  function renderPill(s) {
    const cur = currentCwd(), name = cur.split(/[\\/]/).filter(Boolean).pop() || cur;
    pill.innerHTML = `${icon('folder')}<span class="v"><span class="nm">폴더 · </span>${esc(name)}</span>${icon('down')}`;
    pill.title = `작업 폴더: ${cur}\n${s ? '눌러서 열기·바꾸기' : '눌러서 이 새 세션의 폴더 고르기'}`;
    pill.setAttribute('aria-label', `작업 폴더: ${cur}`);
  }
  (window.hubTopExtras ||= []).push((s) => { renderPill(s); return ''; });
  renderPill(S.sessions.get(S.current) || null);
})();
