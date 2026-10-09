/* ODDIN 스튜디오 시작 화면 — 최근 편집 · 새로 만들기(영상으로·빈 편집·프리미어에서·HTML 장면 영상으로) · AI 제작 흐름(합친 스킬 파이프라인) · 글꼴 · 연결 상태.
   주소 ?path=<편집 파일> 이면 바로 편집기, ?video=<영상> 이면 그 영상으로 새 편집. */
(() => {
  const H = { pipes: [], jobs: new Map(), fonts: null, installable: null };
  const el = () => document.getElementById('home');
  const ago = (iso) => { const s = (Date.now() - new Date(iso).getTime()) / 1000; return s < 60 ? '방금' : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`; };
  const JOB_KO = { queued: '기다리는 중', planning: '계획 중', running: '하는 중', done: '끝남', partial: '일부 끝남', failed: '실패', cancelled: '중지됨' };

  async function show() {
    const root = el(); root.hidden = false;
    const [st, recent, pipes] = await Promise.all([refreshStatus(), api('api/recent').catch(() => []), api('api/pipelines').catch(() => [])]);
    H.pipes = pipes;
    const remote = !!st?.remote, hubOn = !!st?.hub?.online;
    const chip = (ok, label, tip) => `<span class="chip ${ok ? 'ok' : 'warn'}" title="${esc(tip || '')}">${icon(ok ? 'check' : 'alert')}${esc(label)}</span>`;
    root.innerHTML = `<header class="hm-top"><img src="ui/icon.svg" alt="" width="28" height="28"><b>ODDIN 스튜디오</b><small class="c-muted">${esc(st?.version || '')}</small><span class="grow"></span>
        ${st ? `${chip(st.tools.ffmpeg, st.tools.ffmpeg ? 'ffmpeg' : 'ffmpeg 없음', st.tools.ffmpeg ? '렌더·파형·썸네일에 써요' : 'ffmpeg 를 설치해야 렌더할 수 있어요')}${chip(hubOn, hubOn ? 'ODDIN 연결됨' : 'ODDIN 꺼짐', hubOn ? 'AI 부탁·프리미어 가져오기·폰에서 열기가 돼요' : 'ODDIN 을 켜면 AI 부탁·프리미어 가져오기가 돼요')}${remote ? chip(true, '원격으로 보는 중', 'ODDIN 을 거쳐 이 PC 스튜디오를 보고 있어요') : ''}` : chip(false, '엔진 연결 안 됨')}
        ${window.hubTheme ? `<button type="button" class="icon-btn" data-h="theme" title="테마(색·모양)">${icon('palette')}</button>` : ''}</header>
      <div class="hm-body">
        <section class="hm-card hm-new"><h3>새로 만들기</h3>
          <div class="hm-acts">
            <button type="button" class="hm-big" data-h="video">${icon('film')}<b>영상으로 시작</b><span>촬영본을 고르면 컷·자막·모션을 손볼 편집을 만들어요(같은 이름 SRT 는 자막으로)</span></button>
            <button type="button" class="hm-big" data-h="blank">${icon('plus')}<b>빈 편집</b><span>크기만 정하고 시작해 그림·HTML 장면·소리를 넣어요</span></button>
            <button type="button" class="hm-big" data-h="premiere" ${remote ? 'disabled title="프리미어 가져오기는 그 PC 화면에서만 돼요"' : ''}>${icon('pr')}<b>프리미어에서 가져오기</b><span>열린 프리미어 시퀀스의 컷·소리·모션·마커를 편집 파일로</span></button>
            <button type="button" class="hm-big" data-h="scene">${icon('code')}<b>HTML 장면 → 영상</b><span>HTML·CSS·GSAP 로 만든 장면을 영상(.mov 투명·.mp4)으로</span></button>
          </div></section>
        <section class="hm-card hm-recent"><h3>최근 편집<span class="grow"></span><button type="button" class="btn sm" data-h="openfile">${icon('folder')}편집 파일 열기…</button></h3>
          ${recent.length ? `<div class="hm-list">${recent.map((r) => `<button type="button" class="hm-row" data-open="${esc(r.path)}" title="${esc(r.path)}">${icon('film')}<span class="n">${esc(r.title || r.path.split(/[\\/]/).pop())}</span><small>${esc(r.path.split(/[\\/]/).slice(-2, -1)[0] || '')} · ${ago(r.at)}</small></button>`).join('')}</div>` : '<p class="empty-row">아직 연 편집이 없어요. 위에서 새로 만들거나 편집 파일을 여세요.</p>'}</section>
        <section class="hm-card hm-pipes"><h3>AI 제작 흐름 <small class="c-muted">ODDIN 에 맡겨요 — 합친 스킬(oddin-studio)의 파이프라인</small></h3>
          ${pipes.length ? `<div class="hm-pgrid">${pipes.map((p) => `<button type="button" class="hm-pipe" data-pipe="${esc(p.id)}" ${hubOn ? '' : 'disabled title="ODDIN 이 켜져 있어야 해요"'}><b>${esc(p.name)}</b><span>${esc(p.description || '')}</span></button>`).join('')}</div>` : '<p class="empty-row">파이프라인이 없어요</p>'}
          <div class="hm-jobs"></div></section>
        <section class="hm-card hm-fonts"><h3>글꼴</h3><div class="hm-fbody"><span class="c-muted">읽는 중…</span></div></section>
      </div>`;
    renderJobs(); loadFonts();
  }
  async function loadFonts() {
    const box = el().querySelector('.hm-fbody'); if (!box) return;
    try {
      const [fonts, inst] = await Promise.all([api('api/fonts'), api('api/fonts/installable')]);
      H.fonts = fonts; H.installable = inst;
      box.innerHTML = `<p>이 PC에서 쓸 수 있는 글꼴 <b>${fonts.length}</b>개${fonts.filter((f) => f.ko).length ? ` (한글 이름 ${fonts.filter((f) => f.ko).length}개)` : ''}.</p>
        ${inst.length ? `<p class="ve-warn">${icon('alert')}글꼴 폴더에 파일은 있는데 윈도에 등록이 풀려 못 쓰는 글꼴이 ${inst.length}개 있어요: ${inst.slice(0, 6).map((x) => esc(x.ko || x.families[0])).join(', ')}${inst.length > 6 ? ' …' : ''}</p><button type="button" class="btn sm" data-h="fontsall">${icon('check')}모두 설치(등록)</button>` : `<p class="c-muted">등록이 풀린 글꼴은 없어요.</p>`}
        <button type="button" class="btn sm" data-h="fontfile" ${STUDIO.remote ? 'disabled' : ''}>${icon('font')}글꼴 파일로 설치…</button>`;
    } catch (e) { box.innerHTML = `<span class="c-muted">글꼴 목록을 읽지 못했어요: ${esc(e.message)}</span>`; }
  }
  async function installFonts(body) {
    try { const r = await api('api/fonts/install', { method: 'POST', body: JSON.stringify(body) }); toast(r.installed.length ? `글꼴 ${r.installed.length}개를 설치했어요 — 이미 켜져 있던 프로그램(프리미어 등)은 다시 켜야 보여요` : r.skipped[0]?.reason || '설치할 글꼴이 없어요', !r.installed.length); loadFonts(); }
    catch (e) { toast(`설치하지 못했어요: ${e.message}`, true); }
  }

  /* ---------- 새로 만들기 ---------- */
  async function fromVideo() { const p = await pickPath({ title: '편집할 영상 고르기', kinds: ['video'], confirm: '이 영상으로' }); if (p) studioEditor.create(p); }
  async function blank() {
    const body = modal('빈 편집 만들기');
    body.innerHTML = `<form class="hm-form">
      <label>폴더<span class="hm-pick"><input name="dir" required placeholder="편집 파일을 둘 폴더" spellcheck="false"><button type="button" class="btn sm" data-pick>${icon('folder')}고르기</button></span></label>
      <label>제목<input name="title" value="새 편집"></label>
      <label>크기<select name="size"><option value="1080x1920">세로 1080×1920 (쇼츠·릴스)</option><option value="1920x1080">가로 1920×1080</option><option value="1080x1080">정사각 1080×1080</option><option value="3840x2160">가로 4K 3840×2160</option></select></label>
      <label>초당 프레임<select name="fps"><option>30</option><option>60</option><option>24</option><option value="29.97">29.97</option></select></label>
      <div class="hm-fbtn"><button type="button" class="btn" data-x>취소</button><button class="btn primary">만들기</button></div></form>`;
    const f = body.querySelector('form');
    try { const last = localStorage.getItem('oddin.studio.last'); if (last) f.dir.value = last.replace(/[\\/][^\\/]*$/, ''); } catch {}
    f.querySelector('[data-pick]').onclick = async () => { const d = await pickPath({ title: '폴더 고르기', mode: 'dir', start: f.dir.value, confirm: '이 폴더' }); if (d) { blankAgain(d, f); } };
    f.querySelector('[data-x]').onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault(); const [w, h] = f.size.value.split('x').map(Number);
      try { const r = await api('api/blank', { method: 'POST', body: JSON.stringify({ dir: f.dir.value.trim().replace(/^"|"$/g, ''), title: f.title.value.trim() || '새 편집', width: w, height: h, fps: Number(f.fps.value) }) }); closeModal(); studioEditor.open(r.path); }
      catch (x) { toast(x.message, true); }
    };
  }
  // 폴더 고르기 창이 같은 모달을 써서, 고른 뒤 빈 편집 창을 다시 연다
  function blankAgain(dir, prev) { const vals = { title: prev.title.value, size: prev.size.value, fps: prev.fps.value }; blank().then(() => {}); setTimeout(() => { const f = $('#modalBody form'); if (!f) return; f.dir.value = dir; f.title.value = vals.title; f.size.value = vals.size; f.fps.value = vals.fps; }, 0); }
  async function premiere() {
    const body = modal('프리미어에서 가져오기', true);
    body.innerHTML = '<p class="c-muted">프리미어에 물어보는 중…</p>';
    let st;
    try { st = await api('api/premiere/status'); }
    catch (e) { body.innerHTML = `<p class="ve-warn">${icon('alert')}${esc(e.message)}</p><p class="c-muted">프리미어를 켜고 프로젝트를 열면 ODDIN 플러그인이 자동으로 붙어요. ODDIN 도 켜져 있어야 해요.</p>`; return; }
    const seqs = st.sequences || [];
    if (!seqs.length) { body.innerHTML = '<p class="c-muted">열린 프로젝트에 시퀀스가 없어요.</p>'; return; }
    const proj = st.project || '';
    body.innerHTML = `<form class="hm-form"><p class="c-muted" title="${esc(proj)}">프로젝트: ${esc(proj.split(/[\\/]/).pop() || '저장 안 됨')}</p>
      <div class="hm-seqs">${seqs.map((s) => `<label class="hm-seq"><input type="radio" name="seq" value="${esc(s.id)}" ${String(s.id) === String(st.active) ? 'checked' : ''}><b>${esc(s.name)}</b><small>${Math.round(s.seconds)}초 · 영상 ${s.video} · 소리 ${s.audio}${String(s.id) === String(st.active) ? ' · 지금 열린 것' : ''}</small></label>`).join('')}</div>
      <label>편집 파일을 둘 폴더<span class="hm-pick"><input name="dir" value="${esc(proj ? proj.replace(/[\\/][^\\/]*$/, '') : '')}" placeholder="프로젝트 폴더" spellcheck="false"><button type="button" class="btn sm" data-pick>${icon('folder')}고르기</button></span></label>
      <p class="c-muted hm-note">컷 위치·원본 구간·모션(위치·크기·회전)·불투명도·소리 크기·글자 클립의 글·마커를 가져와요. 효과·전환·속도·캡션 트랙은 가져오지 않아요(캡션은 SRT 로 내보내 "원본" 패널에서 넣기).</p>
      <div class="hm-fbtn"><button type="button" class="btn" data-x>닫기</button><button class="btn primary">가져오기</button></div></form>`;
    const f = body.querySelector('form');
    if (!f.querySelector('input[name=seq]:checked')) f.querySelector('input[name=seq]').checked = true;
    f.querySelector('[data-x]').onclick = closeModal;
    f.querySelector('[data-pick]').onclick = async () => { const keep = { seq: f.seq.value }; const d = await pickPath({ title: '폴더 고르기', mode: 'dir', start: f.dir.value, confirm: '이 폴더' }); await premiere(); const g = $('#modalBody form'); if (g) { if (d) g.dir.value = d; const r = g.querySelector(`input[name=seq][value="${CSS.escape(keep.seq)}"]`); if (r) r.checked = true; } };
    f.onsubmit = async (e) => {
      e.preventDefault(); const btn = f.querySelector('.primary'); btn.disabled = true; btn.textContent = '가져오는 중…';
      try {
        const r = await api('api/premiere/import', { method: 'POST', body: JSON.stringify({ sequence: f.seq.value, outDir: f.dir.value.trim() || null }) });
        closeModal(); await studioEditor.open(r.path);
        const notes = (r.problems || []).filter((x) => !/캡션 트랙/.test(x));
        toast(`프리미어 "${r.sequence}"를 가져왔어요 (${r.clips}개)${notes.length ? ` · ${notes.slice(0, 2).join(' · ')}` : ''}`);
      } catch (x) { btn.disabled = false; btn.textContent = '가져오기'; toast(x.message, true); }
    };
  }
  async function scene() {
    const p = await pickPath({ title: 'HTML 장면 고르기', kinds: ['html'], confirm: '이 장면' }); if (!p) return;
    const body = modal('HTML 장면 → 영상');
    body.innerHTML = `<form class="hm-form"><p class="c-muted" title="${esc(p)}">${esc(p.split(/[\\/]/).pop())}</p>
      <label>길이(초, 비우면 장면에 적힌 길이)<input name="dur" type="number" step="0.1" min="0.1" placeholder="data-duration"></label>
      <label>크기(비우면 장면에 적힌 크기)<input name="size" placeholder="1080x1920"></label>
      <label>초당 프레임<select name="fps"><option>30</option><option>60</option><option>24</option></select></label>
      <label>만들 파일<select name="fmt"><option value="mov">.mov — 투명 배경(영상 위에 겹쳐 쓰기·프리미어)</option><option value="mp4">.mp4 — 검은 배경</option></select></label>
      <div class="hm-fbtn"><button type="button" class="btn" data-x>취소</button><button class="btn primary">만들기</button></div></form>`;
    const f = body.querySelector('form'); f.querySelector('[data-x]').onclick = closeModal;
    f.onsubmit = async (e) => {
      e.preventDefault(); const [w, h] = (f.size.value.match(/(\d+)\s*[x×*]\s*(\d+)/) || []).slice(1).map(Number);
      try {
        const r = await api('api/scene', { method: 'POST', body: JSON.stringify({ path: p, duration: Number(f.dur.value) || 0, width: w || 0, height: h || 0, fps: Number(f.fps.value), alpha: f.fmt.value === 'mov' }) });
        closeModal(); toast(`장면을 영상으로 만들고 있어요: ${r.out.split(/[\\/]/).pop()}`);
      } catch (x) { toast(x.message, true); }
    };
  }

  /* ---------- AI 제작 흐름 ---------- */
  function runPipe(id) {
    const pl = H.pipes.find((x) => x.id === id); if (!pl) return;
    const body = modal(pl.name, true);
    const field = (fd) => {
      const pick = fd.type === 'path' || fd.type === 'dir';
      const input = fd.type === 'textarea' ? `<textarea name="${esc(fd.key)}" rows="4" placeholder="${esc(fd.placeholder || '')}"></textarea>` : `<input name="${esc(fd.key)}" placeholder="${esc(fd.placeholder || '')}" spellcheck="false">`;
      return `<label>${esc(fd.label)}${fd.optional ? ' <small class="c-muted">(선택)</small>' : ''}${pick ? `<span class="hm-pick">${input}<button type="button" class="btn sm" data-pickf="${esc(fd.key)}" data-mode="${fd.type === 'dir' ? 'dir' : 'file'}" data-kinds="${esc((fd.kinds || []).join(','))}">${icon('folder')}고르기</button></span>` : input}${fd.help ? `<small class="c-muted">${esc(fd.help)}</small>` : ''}</label>`;
    };
    body.innerHTML = `<form class="hm-form"><p class="c-muted">${esc(pl.description || '')}</p>${(pl.inputs || []).map(field).join('')}
      ${pl.gates ? `<p class="c-muted hm-note">${icon('info')}${esc(pl.gates)}</p>` : ''}
      <div class="hm-fbtn"><button type="button" class="btn" data-x>취소</button><button class="btn primary">${icon('sparkle')}ODDIN 에 맡기기</button></div></form>`;
    const f = body.querySelector('form'); f.querySelector('[data-x]').onclick = closeModal;
    const kept = {};
    f.querySelectorAll('[data-pickf]').forEach((b) => b.onclick = async () => {
      for (const fd of pl.inputs || []) kept[fd.key] = f[fd.key]?.value || '';
      const v = await pickPath({ title: '고르기', mode: b.dataset.mode, kinds: b.dataset.kinds ? b.dataset.kinds.split(',') : null, start: kept[b.dataset.pickf] || '', confirm: '이것으로' });
      runPipe(id); const g = $('#modalBody form'); if (!g) return;
      for (const [k, val] of Object.entries(kept)) if (g[k]) g[k].value = val;
      if (v && g[b.dataset.pickf]) g[b.dataset.pickf].value = v;
    });
    f.onsubmit = async (e) => {
      e.preventDefault(); const inputs = {}; for (const fd of pl.inputs || []) inputs[fd.key] = f[fd.key]?.value?.trim() || '';
      try {
        const job = await api('api/pipelines/run', { method: 'POST', body: JSON.stringify({ id, inputs }) });
        closeModal(); H.jobs.set(job.id, { id: job.id, name: pl.name, status: job.status, sessionId: job.sessionId, at: new Date().toISOString() }); saveJobs(); renderJobs(); pollJobs();
        toast(`ODDIN 에 맡겼어요: ${pl.name} — ODDIN 화면에서 진행을 볼 수 있어요`);
      } catch (x) { toast(x.message, true); }
    };
  }
  function saveJobs() { try { localStorage.setItem('oddin.studio.jobs', JSON.stringify([...H.jobs.values()].slice(-12))); } catch {} }
  try { for (const j of JSON.parse(localStorage.getItem('oddin.studio.jobs') || '[]')) H.jobs.set(j.id, j); } catch {}
  function renderJobs() {
    const box = el()?.querySelector('.hm-jobs'); if (!box) return;
    const list = [...H.jobs.values()].reverse();
    box.innerHTML = list.length ? `<h4>맡긴 일</h4>${list.map((j) => `<div class="hm-job s-${esc(j.status)}"><b>${esc(j.name)}</b><span class="chip">${esc(JOB_KO[j.status] || j.status)}</span><small class="c-muted">${ago(j.at)}</small>${j.report ? `<p>${esc(j.report.slice(0, 220))}</p>` : ''}</div>`).join('')}` : '';
  }
  let pollT = null;
  function pollJobs() {
    clearTimeout(pollT);
    const live = [...H.jobs.values()].filter((j) => !['done', 'partial', 'failed', 'cancelled'].includes(j.status));
    if (!live.length) return;
    pollT = setTimeout(async () => {
      for (const j of live) { try { const r = await api(`api/ai/${enc(j.id)}`); Object.assign(j, { status: r.status, report: r.report || j.report }); } catch {} }
      saveJobs(); renderJobs(); pollJobs();
    }, 5000);
  }

  /* ---------- 이벤트 ---------- */
  document.addEventListener('click', async (e) => {
    const root = el(); if (!root || root.hidden || !root.contains(e.target)) return;
    const b = e.target.closest('[data-h],[data-open],[data-pipe]'); if (!b || b.disabled) return;
    if (b.dataset.open) return studioEditor.open(b.dataset.open);
    if (b.dataset.pipe) return runPipe(b.dataset.pipe);
    const a = b.dataset.h;
    if (a === 'video') return fromVideo();
    if (a === 'blank') return blank();
    if (a === 'premiere') return premiere();
    if (a === 'scene') return scene();
    if (a === 'theme') return window.hubTheme?.open();
    if (a === 'openfile') { const p = await pickPath({ title: '편집 파일 열기', kinds: ['edit'], confirm: '열기' }); if (p) studioEditor.open(p); return; }
    if (a === 'fontsall') return installFonts({ all: true });
    if (a === 'fontfile') { const f = await pickPath({ title: '설치할 글꼴 파일', kinds: ['font'], multi: true, confirm: '설치' }); if (f?.length) installFonts({ files: f }); }
  });
  STUDIO.on((ev) => {
    if (ev.type === 'scene' && ev.scene) {
      const s = ev.scene;
      if (s.status === 'done') toast(`장면 영상을 만들었어요: ${s.out}`);
      if (s.status === 'failed') toast(`장면 영상을 만들지 못했어요: ${s.error}`, true);
    }
    if (ev.type === 'fonts' && !el().hidden) loadFonts();
  });

  window.studioHome = { show, refresh: show };
  document.addEventListener('DOMContentLoaded', () => {
    const q = new URLSearchParams(location.search);
    if (q.get('path')) { show(); studioEditor.open(q.get('path')); }
    else if (q.get('video')) { show(); studioEditor.create(q.get('video')); }
    else show();
    pollJobs();
  });
})();
