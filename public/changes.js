/* AI Hub — 변경 비교·되돌리기 (public/changes.js)
   app.js·side.js 다음에 읽힌다. 서버 규약: lib/checkpoints.mjs · docs/checkpoints.md
   - 오른쪽 패널 "변경" 탭 (window.hubTabs): 세션 전체 / 작업별 변경 파일 목록, 스냅샷에서 뺀 파일(skipped)·같은 시간에 돈 작업(overlaps) 안내
   - 비교 창 (#modal 재사용): 왼쪽 파일 목록, 오른쪽 diff (통합 / 나란히, 접힌 문맥 펼치기, 줄바꿈, 단어 단위 강조, 이진·큰 파일 안내)
   - 작업 카드 끝 요약 (window.hubJobExtras): "파일 N개 변경 +a −b" · 변경 보기 · 이 작업 되돌리기 (되돌린 뒤엔 되돌리기 취소)
   - 되돌리기: 확인 대화상자 → 충돌(작업 뒤 또 바뀐 파일)이면 '빼고 되돌리기'/'그래도 덮어쓰기' 선택 → "되돌렸어요 · 되돌리기 취소" 토스트
   - 실시간: hub:event 의 checkpoint / rewind / job / hello 로 카드·탭·창을 갱신
   기존 "파일" 탭(side.js 의 filesPane·touchedFiles)은 이 탭에 합쳤다: 스냅샷이 있으면 실제 diff 기준으로 보여 주고 누가 고쳤는지(C/X)는 도구 기록으로 덧붙인다.
   스냅샷이 없으면(체크포인트 꺼짐·저장 실패) 도구 기록만으로 목록을 보여 준다.
   시험용: window.hubChanges = { openCompare, rewind, undo, refresh } */
'use strict';
(() => {
  if (typeof IC === 'object' && IC) {
    if (!IC.diff) IC.diff = '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>';
    if (!IC.undo) IC.undo = '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>';
    if (!IC.wrap) IC.wrap = '<path d="M3 6h18M3 12h13a3 3 0 0 1 0 6h-4M3 18h5"/><path d="m14 16-2 2 2 2"/>';
    if (!IC.rows) IC.rows = '<path d="M4 7h16M4 12h16M4 17h16"/>';
    if (!IC.columns) IC.columns = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>';
  }

  /* ---------- 공용 도우미 (app.js 전역을 있으면 쓰고 없어도 깨지지 않게) ---------- */
  const ic = (n) => (typeof icon === 'function' ? icon(n) : '');
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const say = (m, err = false) => { if (typeof toast === 'function') toast(m, err); };
  const q = (s, el = document) => el.querySelector(s);
  const enc = encodeURIComponent;
  const live = (j) => (typeof LIVE !== 'undefined' ? LIVE.has(j.status) : ['queued', 'planning', 'running', 'reporting'].includes(j.status));
  const stKo = (s) => (typeof ST_KO !== 'undefined' && ST_KO[s]) || s;
  const time = (iso) => (typeof hm === 'function' ? hm(iso) : '');
  const jobOf = (id) => (typeof S !== 'undefined' ? S.jobs.get(id) : null);
  const sessOf = (id) => (typeof S !== 'undefined' ? S.sessions.get(id) : null);
  const jobsOf = (sid) => (typeof sessionJobs === 'function' ? sessionJobs(sid) : []);
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  const STATUS = { added: ['A', '추가', 'add'], modified: ['M', '수정', 'mod'], deleted: ['D', '삭제', 'del'], renamed: ['R', '이름 변경', 'ren'] };
  const SKIP_KO = { large_file: '큰 파일', symlink: '바로 가기(링크)', special_file: '특수 파일', changed_during_scan: '스캔 중 바뀜', missing_during_scan: '스캔 중 사라짐', too_many_files: '파일 수 초과로 폴더 전체 건너뜀' };
  const ACTION_KO = { added: '지워져요', modified: '작업 전 내용으로', deleted: '다시 생겨요', renamed: '원래 이름으로' };
  const STEP = 20, ROW_CAP = 2500;

  const CH = {
    scope: new Map(),    // sessionId -> 'session' | jobId
    session: new Map(),  // sessionId -> { key, data, error, pending, loading }
    diffs: new Map(),    // `${kind}:${id}|${path}` -> { loading } | { data, parsed } | { error, code }
    gaps: new Map(),     // `${diffKey}#${gapIdx}` -> { a, b }  (위에서 a줄, 아래에서 b줄 펼침)
    rewinds: new Map(),  // jobId -> { backup, paths, status: 'ready'|'undone', at }
    busy: new Set(),     // 되돌리기·취소가 진행 중인 jobId
    sig: new Map(),      // jobId -> 체크포인트 서명 (실시간 갱신 판단)
    view: store.get('hub.changes.view', 'unified') === 'split' ? 'split' : 'unified',
    wrap: store.get('hub.changes.wrap', '0') === '1',
    cmp: null,           // 비교 창 상태 { kind, id, path, full }
    store: null, storeOpen: false, // 저장 공간 조회 결과 (/api/checkpoints)
    toastTimer: null, panelTimer: null, backupsLoaded: false,
  };

  async function call(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.error || r.statusText || '요청에 실패했어요'); e.status = r.status; e.code = body.code || ''; throw e; }
    return body;
  }

  /* ---------- 서식 ---------- */
  const totals = (files) => { let a = 0, d = 0, bin = 0; for (const f of files || []) { a += f.additions || 0; d += f.deletions || 0; if (f.binary) bin++; } return { a, d, bin, n: (files || []).length }; };
  const counts = (files) => { const c = { added: 0, modified: 0, deleted: 0, renamed: 0 }; for (const f of files || []) c[f.status in c ? f.status : 'modified']++; return c; };
  const pm = (a, d) => `<span class="ch-pm" aria-label="추가 ${a || 0}줄, 삭제 ${d || 0}줄"><b class="${a ? 'p' : 'z'}">+${a || 0}</b><b class="${d ? 'm' : 'z'}">−${d || 0}</b></span>`;
  const st = (status) => { const [L, label, cls] = STATUS[status] || STATUS.modified; return `<span class="ch-st ${cls}" role="img" aria-label="${label}" title="${label}">${L}</span>`; };
  const splitPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i + 1) }; };
  const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
  const sorted = (files) => [...(files || [])].sort((x, y) => x.path.localeCompare(y.path, 'ko'));
  const firstLine = (t, n = 40) => { const s = String(t || '').split('\n')[0].trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const jobIndex = (j) => jobsOf(j.sessionId).findIndex((x) => x.id === j.id) + 1;
  const jobLabel = (j) => `${jobIndex(j) || '?'}번째 요청 · ${time(j.createdAt)}`;
  const absPath = (s, rel) => { const root = String(s?.cwd || '').replace(/[\\/]+$/, ''); const sep = root.includes('\\') ? '\\' : '/'; return root + sep + rel.split('/').join(sep); };

  /** 도구 기록으로 본 "누가 고쳤는지" (side.js 의 touchedFiles 재사용). 작업 폴더 기준 상대 경로(소문자) → Set('claude'|'codex') */
  function whoMap(s) {
    const map = new Map();
    if (!s || typeof touchedFiles !== 'function') return map;
    let list = []; try { list = touchedFiles(s); } catch { return map; }
    const root = String(s.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    for (const r of list) {
      let p = String(r.path || '').replace(/\\/g, '/').trim(); const lp = p.toLowerCase();
      if (root && lp.startsWith(root + '/')) p = p.slice(root.length + 1);
      p = p.replace(/^\.\//, '').toLowerCase();
      if (p) map.set(p, new Set([...(map.get(p) || []), ...r.who]));
    }
    return map;
  }

  /* ---------- 변경 자료: 작업은 job.checkpoint 그대로, 세션 전체는 서버에서 ---------- */
  function source(kind, id) {
    if (kind === 'job') {
      const j = jobOf(id); if (!j) return { status: 'missing', files: [], skipped: [], overlaps: [] };
      const cp = j.checkpoint;
      if (!cp) return { status: live(j) ? 'capturing' : 'unavailable', files: [], skipped: [], overlaps: [] };
      return { status: cp.status || 'pending', files: cp.files || [], skipped: cp.skipped || [], overlaps: cp.overlaps || [], warning: cp.warning || null };
    }
    const c = CH.session.get(id);
    if (c?.data) return { ...c.data, files: c.data.files || [], skipped: dedupeSkipped(c.data.skipped), overlaps: c.data.overlaps || [], stale: !!c.pending, loading: !!c.loading };
    if (c?.pending) return { status: 'pending', files: [], skipped: [], overlaps: [] };
    if (c?.error) return { status: 'error', error: c.error, files: [], skipped: [], overlaps: [] };
    return { status: jobsOf(id).some((j) => j.checkpoint) ? 'loading' : 'unavailable', files: [], skipped: [], overlaps: [] };
  }
  /** 세션 전체 응답은 작업마다의 skipped 를 그대로 이어 붙이므로 같은 경로·이유는 하나로 (가장 큰 크기만 남김) */
  function dedupeSkipped(list) {
    const m = new Map();
    for (const x of list || []) { const k = `${x.path || ''}|${x.reason || ''}`; const prev = m.get(k); if (!prev || (x.bytes || 0) > (prev.bytes || 0)) m.set(k, x); }
    return [...m.values()];
  }
  const samePath = (a, b) => String(a || '').replace(/[\\/]+$/, '').toLowerCase() === String(b || '').replace(/[\\/]+$/, '').toLowerCase();
  /** 같은 폴더에서 다른 작업이 돌고 있으면 서버가 409(CHECKPOINT_BUSY)를 내므로 미리 비활성으로 보여 준다 */
  const folderBusy = (j) => !!j && (typeof S !== 'undefined') && [...S.jobs.values()].some((x) => x.id !== j.id && live(x) && samePath(x.cwd, j.cwd));
  const BUSY_TITLE = '같은 폴더에서 다른 작업이 끝난 뒤 되돌릴 수 있어요';
  const sessionKey = (sid) => jobsOf(sid).map((j) => `${j.id}:${j.checkpoint?.status || '-'}:${j.checkpoint?.after || ''}`).join(',');
  async function loadSession(sid, force = false) {
    if (!jobsOf(sid).some((j) => j.checkpoint)) return;
    const key = sessionKey(sid); const c = CH.session.get(sid);
    if (c && c.key === key && (c.loading || (!force && (c.data || c.error || c.pending)))) return;
    const entry = { ...(c || {}), key, loading: true, error: null }; CH.session.set(sid, entry);
    try { entry.data = await call(`/api/sessions/${enc(sid)}/changes`); entry.pending = false; }
    catch (e) { if (e.code === 'CHECKPOINT_NOT_READY' || e.status === 409) entry.pending = true; else entry.error = e.message; }
    entry.loading = false;
    refreshPanel(sid); refreshCmp();
  }
  function invalidate(jobId, sid) {
    for (const k of [...CH.diffs.keys()]) if (k.startsWith(`job:${jobId}|`) || (sid && k.startsWith(`session:${sid}|`))) CH.diffs.delete(k);
    for (const k of [...CH.gaps.keys()]) if (k.startsWith(`job:${jobId}|`) || (sid && k.startsWith(`session:${sid}|`))) CH.gaps.delete(k);
    if (sid) { const c = CH.session.get(sid); if (c && !c.loading) c.key = ''; }
  }

  /* ================= 오른쪽 패널 "변경" 탭 ================= */
  function renderTab(body, s) {
    if (!s) { body.innerHTML = `<div class="insp-empty">${ic('diff')}<p>세션을 열면 바뀐 파일이 여기에 보여요</p><small>작업이 끝날 때마다 바뀐 파일을 줄 단위로 비교하고 되돌릴 수 있어요</small></div>`; return; }
    let scope = CH.scope.get(s.id) || 'session';
    if (scope !== 'session' && !jobOf(scope)) { CH.scope.delete(s.id); scope = 'session'; }
    const kind = scope === 'session' ? 'session' : 'job', id = kind === 'session' ? s.id : scope;
    if (kind === 'session') loadSession(s.id);
    const src = source(kind, id);
    body.innerHTML = `<div class="ch-pane" data-kind="${kind}" data-id="${E(id)}">${headHtml(s, kind, id)}${paneHtml(s, kind, id, src)}</div>`;
  }
  function headHtml(s, kind, id) {
    const label = kind === 'session' ? '세션 전체' : jobLabel(jobOf(id));
    return `<div class="ch-head"><button class="ch-scope" data-ch="scope" aria-haspopup="listbox" title="비교 범위 고르기">${ic('diff')}<span>${E(label)}</span>${ic('down')}</button><span class="grow"></span><button class="icon-btn sm" data-ch="refresh" title="새로고침" aria-label="새로고침">${ic('refresh')}</button></div>`;
  }
  function paneHtml(s, kind, id, src) {
    const who = whoMap(s);
    if (src.status === 'loading' && !src.files.length) return `<div class="ch-skel" aria-busy="true"><i></i><i></i><i></i></div>`;
    if (src.status === 'error') return `<div class="ch-note err">${ic('alert')}<div><b>변경 목록을 불러오지 못했어요</b><span>${E(src.error || '')}</span><button class="btn" data-ch="refresh">${ic('refresh')}다시 시도</button></div></div>`;
    if (src.status === 'missing') return `<div class="insp-empty">${ic('diff')}<p>이 작업을 찾을 수 없어요</p></div>`;
    if (src.status === 'capturing' || (src.status === 'pending' && !src.files.length)) {
      const msg = kind === 'job' ? '작업이 끝나면 바뀐 파일을 비교할 수 있어요' : '진행 중인 작업이 끝나면 세션 전체 변경을 볼 수 있어요';
      return `<div class="ch-note"><span class="spinner"></span><div><b>${msg}</b><span>${kind === 'job' ? '시작 전 상태를 저장해 두었어요' : '그동안은 범위를 작업별로 바꿔 끝난 작업만 볼 수 있어요'}</span></div></div>${fallbackHtml(s, who, false)}`;
    }
    if (src.status === 'unavailable' || src.status === 'warning') {
      const head = src.status === 'warning' ? `<div class="ch-note err">${ic('alert')}<div><b>이 작업은 변경 비교를 쓸 수 없어요</b><span>${E(src.warning || '체크포인트를 저장하지 못했어요')}</span></div></div>` : '';
      return head + noticesHtml(src, s) + fallbackHtml(s, who, true);
    }
    const files = sorted(src.files), t = totals(files), c = counts(files);
    if (!files.length) return `${noticesHtml(src, s)}<div class="insp-empty">${ic('check')}<p>${kind === 'job' ? '이 작업에서 바뀐 파일이 없어요' : '이 세션에서 바뀐 파일이 없어요'}</p><small>${t.bin ? '' : '스냅샷 전후가 같아요'}</small></div>`;
    const rw = kind === 'job' ? CH.rewinds.get(id) : null, fb = kind === 'job' && folderBusy(jobOf(id)), busy = kind === 'job' && (CH.busy.has(id) || fb);
    const acts = `<div class="ch-acts"><button class="btn" data-ch="compare">${ic('diff')}비교 보기</button>${kind === 'job' ? `${rw?.status === 'ready' ? `<span class="ch-flag ok" title="이 작업의 변경을 되돌렸어요. 아래 목록은 작업 당시의 변경 기록이에요">${ic('undo')}되돌림</span>` : ''}${rewindBtn(id, rw, busy, fb ? `title="${BUSY_TITLE}"` : '')}` : ''}</div>`;
    const kinds = ['added', 'modified', 'deleted', 'renamed'].filter((k) => c[k]).map((k) => `<span class="ch-k">${st(k)}${STATUS[k][1]} ${c[k]}</span>`).join('');
    return `<div class="ch-sumbar"><div class="ch-tot"><b>파일 ${t.n}개 변경</b>${pm(t.a, t.d)}${t.bin ? `<span class="ch-bin">이진 ${t.bin}</span>` : ''}</div><div class="ch-kinds">${kinds}</div>${acts}</div>
      ${noticesHtml(src, s)}
      <div class="ch-lbl">바뀐 파일<span class="grow"></span>${kind === 'session' ? '<span title="되돌리기는 작업별 범위에서 할 수 있어요">세션 전체</span>' : ''}</div>
      <div class="ch-list" role="list">${files.map((f) => rowHtml(f, who.get(f.path.toLowerCase()), s)).join('')}</div>
      <p class="ch-fine">파일을 누르면 줄 단위 비교가 열려요. 오른쪽 클릭으로 열기·경로 복사${kind === 'job' ? '·파일 하나만 되돌리기' : ''}</p>${storeHtml()}`;
  }
  /* ---------- 체크포인트 저장 공간 (접힌 절, 펼칠 때 조회) ---------- */
  function storeHtml() {
    const d = CH.store;
    const body = !d ? '<div class="ch-store-f"><span>펼치면 저장 공간을 조사해요</span></div>' : d.loading ? '<div class="ch-store-f"><span class="spinner"></span><span>조사하는 중…</span></div>' : d.error ? `<div class="ch-store-f"><span class="c-err">${E(d.error)}</span><button type="button" class="btn" data-ch="store-reload">${ic('refresh')}다시</button></div>`
      : `<ul>${(d.repositories || []).map((r) => `<li><span class="mono" title="${E(r.cwd)}">${E(shortCwd(r.cwd))}</span><small>${fmtBytes(r.bytes || 0)}</small><span class="sub">${r.unused ? '참조 없음 · 정리하면 지워져요' : `작업 ${(r.jobs || []).length}개 · 백업 ${(r.backups || []).length}개`}${r.updatedAt ? ` · ${typeof ago === 'function' ? ago(r.updatedAt) + ' 전' : ''}` : ''}</span></li>`).join('') || '<li><span class="sub">저장된 체크포인트가 없어요</span></li>'}</ul>
        <div class="ch-store-f"><span>모두 ${fmtBytes(d.bytes || 0)}</span><span class="grow"></span><button type="button" class="btn" data-ch="store-reload" title="다시 조사">${ic('refresh')}</button><button type="button" class="btn" data-ch="cleanup" ${d.busy ? 'disabled' : ''} title="참조 없는 저장소는 지우고 나머지는 압축해요">${ic('trash')}정리</button></div>`;
    return `<details class="ch-note ch-store" data-ch-store ${CH.storeOpen ? 'open' : ''}><summary>${ic('folder')}<div><b>체크포인트 저장 공간</b><span>작업 전후 스냅샷이 쌓인 그림자 저장소</span></div><span class="ico chev">${ic('down').replace(/^<span class="ico">|<\/span>$/g, '')}</span></summary>${body}</details>`;
  }
  const shortCwd = (p) => { const parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts.length > 2 ? '…' + parts.slice(-2).join('\\') : p; };
  async function loadStore(force = false) {
    if (CH.store && !force && !CH.store.error) return;
    CH.store = { ...(CH.store || {}), loading: true, error: null }; refreshPanel(S.current, true);
    try { CH.store = { ...(await call('/api/checkpoints')), loading: false }; } catch (e) { CH.store = { loading: false, error: e.message }; }
    refreshPanel(S.current, true);
  }
  async function cleanupStore() {
    if (CH.store?.busy) return;
    const r = await dialog({ title: '체크포인트 정리', icon: 'trash', body: '<p class="ch-dlg-p">참조가 없는 그림자 저장소는 지우고, 나머지는 압축해요. 작업·백업이 연결된 스냅샷은 지우지 않아요. 지금 작업이 도는 폴더는 건너뛰어요.</p>', buttons: [{ id: 'cancel', label: '취소' }, { id: 'ok', label: '정리', cls: 'primary', icon: 'trash', focus: true }] });
    if (r !== 'ok') return;
    CH.store = { ...(CH.store || {}), busy: true }; refreshPanel(S.current, true);
    try { const res = await call('/api/checkpoints/cleanup', { method: 'POST', body: '{}' }); CH.store = { ...res, loading: false }; say(`정리했어요 · 지운 저장소 ${res.removed?.length || 0}개, 압축 ${res.compacted?.length || 0}개`); }
    catch (e) { CH.store = { ...(CH.store || {}), busy: false }; say(e.message || '정리하지 못했어요', true); }
    refreshPanel(S.current, true);
  }
  /** 되돌리기 / 되돌리기 취소 버튼. 진행 중이면 스피너와 함께 비활성 */
  function rewindBtn(jobId, rw, disabled, titleAttr = '') {
    const working = CH.busy.has(jobId);
    const undoing = rw?.status === 'ready';
    const label = working ? (undoing ? '취소하는 중…' : '되돌리는 중…') : undoing ? '되돌리기 취소' : '이 작업 되돌리기';
    return `<button type="button" class="btn" data-ch="${undoing ? 'undo' : 'rewind'}" data-job="${E(jobId)}" ${disabled ? 'disabled' : ''} ${working ? 'aria-busy="true"' : ''} ${titleAttr}>${working ? '<span class="spinner"></span>' : ic(undoing ? 'retry' : 'undo')}${label}</button>`;
  }
  function rowHtml(f, who, s, active = false) {
    const { name, dir } = splitPath(f.path);
    const sub = f.status === 'renamed' && f.oldPath ? `${f.oldPath} →` : dir || '.';
    return `<button type="button" class="ch-row ${active ? 'on' : ''}" role="listitem" data-ch="file" data-path="${E(f.path)}" data-abs="${E(absPath(s, f.path))}" title="${E(f.path)}" ${active ? 'aria-current="true"' : ''}>${st(f.status)}<span class="ch-fn"><b>${E(name)}</b><small>${E(sub)}</small></span>${who ? [...who].map((w) => `<span class="prov ${w}" title="${w === 'claude' ? 'Claude' : 'Codex'}가 고침">${w === 'claude' ? 'C' : 'X'}</span>`).join('') : ''}${f.binary ? '<span class="ch-bin">이진</span>' : pm(f.additions, f.deletions)}</button>`;
  }
  function noticesHtml(src, s) {
    let h = '';
    if (src.stale) h += `<div class="ch-note">${ic('clock')}<div><b>진행 중인 작업이 끝나면 갱신돼요</b><span>지금 보이는 건 마지막으로 끝난 작업까지의 변경이에요</span></div></div>`;
    if (src.overlaps?.length) {
      const links = src.overlaps.map((id) => { const j = jobOf(id); const other = j && j.sessionId !== s?.id ? sessOf(j.sessionId) : null; const goal = j ? firstLine(j.goal, 48) : ''; const prefix = other && other.title && !goal.startsWith(other.title.slice(0, 12)) ? E(other.title) + ' · ' : ''; return `<button type="button" class="link" data-ch="gotojob" data-job="${E(id)}" title="작업 ${E(id)}${j ? '\n' + E(j.goal) : ''}">${j ? `${prefix}${E(goal)}` : `작업 ${E(id)} (지워짐)`}</button>`; }).join('');
      h += `<div class="ch-note warn">${ic('alert')}<div><b>같은 시간에 다른 작업 ${src.overlaps.length}개가 함께 돌았어요</b><span>같은 폴더에서 동시에 실행돼 서로의 변경이 섞여 보일 수 있어요</span><div class="ch-links">${links}</div></div></div>`;
    }
    if (src.skipped?.length) {
      const items = src.skipped.map((x) => `<li><span class="mono" title="${E(x.path || '')}">${E(x.path || '(폴더 전체)')}</span><small>${E(SKIP_KO[x.reason] || x.reason || '')}${x.bytes ? ` · ${fmtBytes(x.bytes)}` : ''}</small></li>`).join('');
      h += `<details class="ch-note"><summary>${ic('info')}<div><b>스냅샷에서 뺀 파일 ${src.skipped.length}개</b><span>큰 파일·링크는 비교와 되돌리기에서 빠져요</span></div><span class="ico chev">${ic('down').replace(/^<span class="ico">|<\/span>$/g, '')}</span></summary><ul>${items}</ul></details>`;
    }
    return h;
  }
  /** 스냅샷이 없을 때: 도구 기록(side.js touchedFiles)으로 본 목록 */
  function fallbackHtml(s, who, explain) {
    let list = []; try { list = typeof touchedFiles === 'function' ? touchedFiles(s) : []; } catch {}
    if (!list.length) return explain ? `<div class="insp-empty">${ic('file')}<p>이 세션에서 바뀐 파일이 아직 없어요</p><small>Claude·Codex가 파일을 고치면 작업이 끝날 때 여기에 모여요</small></div>` : '';
    const root = String(s.cwd || '').replace(/[\\/]+$/, '');
    const rel = (p) => (p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length).replace(/^[\\/]/, '') : p);
    const kindOf = (r) => (r.kinds.has('add') || r.kinds.has('write') ? 'added' : r.kinds.has('delete') ? 'deleted' : 'modified');
    return `<div class="ch-lbl">도구 기록으로 본 파일 ${list.length}</div><div class="ch-list" role="list">${list.map((r) => { const rp = rel(r.path).replace(/\\/g, '/'); const { name, dir } = splitPath(rp); return `<button type="button" class="ch-row" role="listitem" data-open="${E(r.path)}" title="${E(r.path)}\n눌러서 열기 · 오른쪽 클릭으로 경로 복사">${st(kindOf(r))}<span class="ch-fn"><b>${E(name)}</b><small>${E(dir || '.')}</small></span>${[...r.who].map((w) => `<span class="prov ${w}">${w === 'claude' ? 'C' : 'X'}</span>`).join('')}</button>`; }).join('')}</div>
      ${explain ? '<p class="ch-fine">스냅샷이 없어 줄 단위 비교와 되돌리기는 할 수 없어요. 도구 호출 기록에 남은 파일만 보여요.</p>' : ''}`;
  }

  function scopePop(anchor) {
    const s = sessOf(S.current); if (!s || typeof openPop !== 'function') return;
    const cur = CH.scope.get(s.id) || 'session'; const jobs = jobsOf(s.id);
    const pick = (v) => { CH.scope.set(s.id, v); closePop(); refreshPanel(s.id, true); };
    const items = [{ header: '비교 범위' }, { label: '세션 전체', desc: '첫 요청 시작 전부터 마지막 요청이 끝난 뒤까지', icon: 'diff', checked: cur === 'session', run: () => pick('session') }];
    if (jobs.length) items.push({ sep: true }, { header: `요청별 (${jobs.length})` });
    for (const j of [...jobs].reverse()) {
      const cp = j.checkpoint; let d;
      if (live(j)) d = '진행 중'; else if (!cp) d = '스냅샷 없음'; else if (cp.status === 'warning') d = '비교 불가'; else if (cp.status !== 'ready') d = '저장 중'; else { const t = totals(cp.files); d = t.n ? `파일 ${t.n}개 · +${t.a} −${t.d}` : '바뀐 파일 없음'; }
      items.push({ label: jobLabel(j), desc: `${firstLine(j.goal, 36)} · ${d}`, icon: j.status === 'done' ? 'check' : j.status === 'failed' ? 'alert' : live(j) ? 'clock' : 'minus', checked: cur === j.id, run: () => pick(j.id) });
    }
    const sel = Math.max(0, items.filter((i) => !i.header && !i.sep).findIndex((i) => i.checked));
    openPop(anchor, items, { sel, kind: 'ch-scope', below: true });
  }

  function refreshPanel(sid, now = false) {
    if (typeof S === 'undefined' || sid !== S.current || S.insp?.tab !== 'changes') return;
    if (typeof inspOpen === 'function' && !inspOpen()) return;
    clearTimeout(CH.panelTimer);
    const go = () => { if (typeof renderInspector === 'function') renderInspector(); };
    if (now) go(); else CH.panelTimer = setTimeout(go, 120);
  }
  function refreshJob(id) { if (typeof queueRerender === 'function' && jobOf(id)) queueRerender(id); }
  function showTab(sid, scope) {
    if (typeof S === 'undefined') return;
    if (scope) CH.scope.set(sid, scope);
    S.insp.tab = 'changes'; S.prefs.inspTab = 'changes'; if (typeof savePrefs === 'function') savePrefs();
    if (window.innerWidth <= 1100) S.inspFloat = true; else S.prefs.insp = true;
    if (typeof applyLayout === 'function') applyLayout();
    if (typeof renderInspTabs === 'function') renderInspTabs();
    if (typeof renderInspector === 'function') renderInspector();
  }

  /* ================= 비교 창 (#modal) ================= */
  function openCompare(kind, id, path = null) {
    if (typeof modal !== 'function') return;
    const title = kind === 'session' ? '변경 비교 — 세션 전체' : `변경 비교 — ${jobOf(id) ? jobLabel(jobOf(id)) : '작업'}`;
    const body = modal(title, false); body.classList.add('ch-cmp');
    CH.cmp = { kind, id, path, full: false };
    if (kind === 'session') loadSession(id);
    renderCmp();
    setTimeout(() => q('.ch-cmp-list')?.focus(), 0);
  }
  const cmpOpen = () => !!CH.cmp && !q('#modal').hidden && q('#modalBody').classList.contains('ch-cmp');
  function refreshCmp() { if (cmpOpen()) renderCmp(); }
  function renderCmp() {
    const c = CH.cmp; if (!cmpOpen()) return;
    const body = q('#modalBody'); const src = source(c.kind, c.id); const files = sorted(src.files);
    if (!c.path || !files.some((f) => f.path === c.path)) c.path = files[0]?.path || null;
    const s = sessOf(c.kind === 'session' ? c.id : jobOf(c.id)?.sessionId); const who = whoMap(s);
    const t = totals(files);
    const sum = src.status === 'ready' || files.length ? `<div class="ch-tot"><b>파일 ${t.n}개</b>${pm(t.a, t.d)}</div>${src.overlaps?.length ? `<span class="ch-flag warn">${ic('alert')}다른 작업 ${src.overlaps.length}개와 겹침</span>` : ''}${src.skipped?.length ? `<span class="ch-flag">뺀 파일 ${src.skipped.length}</span>` : ''}` : `<span>${src.status === 'loading' ? '불러오는 중…' : src.status === 'pending' || src.status === 'capturing' ? '작업이 끝나면 볼 수 있어요' : src.status === 'error' ? E(src.error || '불러오지 못했어요') : '비교할 변경이 없어요'}</span>`;
    const keep = q('.ch-cmp-list', body)?.scrollTop || 0;
    body.innerHTML = `<div class="ch-cmp-list" tabindex="0" aria-label="바뀐 파일 목록 (위아래 화살표로 이동)"><div class="ch-cmp-sum">${sum}</div>${files.map((f) => rowHtml(f, who.get(f.path.toLowerCase()), s, f.path === c.path)).join('')}</div><div class="ch-cmp-view" id="chView"></div>`;
    q('.ch-cmp-list', body).scrollTop = keep;
    renderView();
  }
  function selectFile(path) {
    const c = CH.cmp; if (!c || c.path === path) return;
    c.path = path; c.full = false;
    const list = q('.ch-cmp-list'); if (list) for (const r of list.querySelectorAll('.ch-row')) { const on = r.dataset.path === path; r.classList.toggle('on', on); if (on) { r.setAttribute('aria-current', 'true'); r.scrollIntoView({ block: 'nearest' }); } else r.removeAttribute('aria-current'); }
    renderView();
  }
  const diffKey = (c) => `${c.kind}:${c.id}|${c.path}`;
  async function ensureDiff(c) {
    const k = diffKey(c); if (CH.diffs.has(k)) return;
    CH.diffs.set(k, { loading: true });
    const url = c.kind === 'job' ? `/api/jobs/${enc(c.id)}/changes/diff?path=${enc(c.path)}` : `/api/sessions/${enc(c.id)}/changes/diff?path=${enc(c.path)}`;
    try { const data = await call(url); CH.diffs.set(k, { data, parsed: parseDiff(data) }); }
    catch (e) { CH.diffs.set(k, { error: e.message, code: e.code, status: e.status }); }
    if (CH.cmp && diffKey(CH.cmp) === k) renderView();
  }
  function renderView() {
    const c = CH.cmp, view = q('#chView'); if (!c || !view) return;
    const src = source(c.kind, c.id); const file = (src.files || []).find((f) => f.path === c.path);
    if (!file) { view.innerHTML = `<div class="ch-big">${ic('diff')}<b>${src.files?.length ? '파일을 고르면 변경 내용이 보여요' : '비교할 파일이 없어요'}</b></div>`; return; }
    const s = sessOf(c.kind === 'session' ? c.id : jobOf(c.id)?.sessionId);
    const entry = CH.diffs.get(diffKey(c)); if (!entry) ensureDiff(c);
    const { name, dir } = splitPath(file.path);
    const canRewind = c.kind === 'job' && !CH.busy.has(c.id);
    const tb = `<div class="ch-tb"><div class="ch-tb-path">${st(file.status)}<span class="ch-path" title="${E(file.path)}">${E(dir)}<b>${E(name)}</b></span>${file.status === 'renamed' && file.oldPath ? `<small title="${E(file.oldPath)}">← ${E(splitPath(file.oldPath).name)}</small>` : ''}</div>${file.binary ? '<span class="ch-bin">이진</span>' : pm(file.additions, file.deletions)}
      <div class="seg2" role="group" aria-label="보기 방식"><button type="button" data-ch="view" data-v="unified" class="${CH.view === 'unified' ? 'on' : ''}" aria-pressed="${CH.view === 'unified'}" title="통합 보기" ${file.binary ? 'disabled' : ''}>${ic('rows')}<span>통합</span></button><button type="button" data-ch="view" data-v="split" class="${CH.view === 'split' ? 'on' : ''}" aria-pressed="${CH.view === 'split'}" title="나란히 보기" ${file.binary ? 'disabled' : ''}>${ic('columns')}<span>나란히</span></button></div>
      <button type="button" class="icon-btn sm ${CH.wrap ? 'on' : ''}" data-ch="wrap" aria-pressed="${CH.wrap}" title="긴 줄 바꿈" aria-label="긴 줄 바꿈">${ic('wrap')}</button>
      <button type="button" class="icon-btn sm" data-ch="more" data-path="${E(file.path)}" data-abs="${E(absPath(s, file.path))}" title="더 보기" aria-label="파일 메뉴">${ic('more')}</button></div>`;
    let bodyHtml;
    if (!entry || entry.loading) bodyHtml = `<div class="ch-skel" aria-busy="true" style="padding:14px"><i></i><i></i><i></i><i></i></div>`;
    else if (entry.error) {
      if (entry.status === 413 || entry.code === 'DIFF_TOO_LARGE') bodyHtml = `<div class="ch-big">${ic('file')}<b>1MB가 넘는 파일이라 내용 비교를 보여 줄 수 없어요</b><span>${file.status === 'deleted' ? '지워진 파일이에요.' : '파일을 직접 열어 확인하세요.'} ${file.status !== 'deleted' ? `<button type="button" class="btn" data-open="${E(absPath(s, file.path))}">${ic('open')}열기</button>` : ''}</span></div>`;
      else bodyHtml = `<div class="ch-big">${ic('alert')}<b>비교를 불러오지 못했어요</b><span>${E(entry.error)}</span><button type="button" class="btn" data-ch="retry-diff">${ic('refresh')}다시 시도</button></div>`;
    } else if (entry.parsed.binary) bodyHtml = `<div class="ch-big">${ic('image')}<b>이진 파일이라 내용 비교가 없어요</b><span>${STATUS[file.status]?.[1] || '수정'}된 파일이에요. ${file.status !== 'deleted' ? `<button type="button" class="btn" data-open="${E(absPath(s, file.path))}">${ic('open')}열기</button>` : ''}</span></div>`;
    else if (!entry.parsed.hunks.length) bodyHtml = `<div class="ch-big">${ic('check')}<b>${file.status === 'renamed' ? '이름만 바뀌고 내용은 같아요' : '내용 변화가 없어요'}</b><span>${file.status === 'renamed' && file.oldPath ? `${E(file.oldPath)} → ${E(file.path)}` : '파일 속성만 바뀌었을 수 있어요'}</span></div>`;
    else bodyHtml = diffTable(c, entry.parsed);
    view.innerHTML = tb + `<div class="ch-body">${bodyHtml}</div>`;
  }
  function moveFile(delta) {
    const c = CH.cmp; if (!c) return; const files = sorted(source(c.kind, c.id).files); if (!files.length) return;
    const i = Math.max(0, files.findIndex((f) => f.path === c.path));
    const n = delta === 'first' ? 0 : delta === 'last' ? files.length - 1 : Math.min(files.length - 1, Math.max(0, i + delta));
    selectFile(files[n].path);
  }

  /* ---------- unified diff 파싱 ---------- */
  const toLines = (t) => { if (typeof t !== 'string' || !t) return []; const a = t.split('\n'); if (a.at(-1) === '') a.pop(); return a.map((l) => l.replace(/\r$/, '')); };
  function parseDiff(d) {
    if (!d || d.binary) return { binary: true, hunks: [] };
    const hunks = []; let h = null, o = 0, n = 0;
    for (const raw of String(d.unified || '').split('\n')) {
      if (raw.startsWith('@@')) { const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/); if (!m) continue; h = { oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4], ctx: m[5] || '', lines: [] }; o = h.oldStart; n = h.newStart; hunks.push(h); continue; }
      if (!h) continue;
      const c = raw[0], s = raw.slice(1).replace(/\r$/, '');
      if (c === ' ') h.lines.push({ t: 'ctx', o: o++, n: n++, s });
      else if (c === '+') h.lines.push({ t: 'add', n: n++, s });
      else if (c === '-') h.lines.push({ t: 'del', o: o++, s });
      else if (c === '\\') { const last = h.lines.at(-1); if (last) last.noeol = true; }
    }
    for (const hk of hunks) annotate(hk);
    return { hunks, before: typeof d.before === 'string' ? toLines(d.before) : null, after: typeof d.after === 'string' ? toLines(d.after) : null };
  }
  /** 삭제 줄 묶음 뒤에 추가 줄 묶음이 오면 짝지어 바뀐 부분만 <mark> 로 강조 */
  function annotate(h) {
    const L = h.lines; let i = 0;
    while (i < L.length) {
      if (L[i].t !== 'del') { i++; continue; }
      let j = i; while (j < L.length && L[j].t === 'del') j++;
      let k = j; while (k < L.length && L[k].t === 'add') k++;
      for (let x = 0; x < Math.min(j - i, k - j); x++) { const [a, b] = pairMarks(L[i + x].s, L[j + x].s); L[i + x].html = a; L[j + x].html = b; }
      i = k;
    }
    for (const l of L) if (l.html === undefined) l.html = E(l.s);
  }
  function pairMarks(a, b) {
    const max = Math.min(a.length, b.length); let p = 0; while (p < max && a[p] === b[p]) p++;
    let s = 0; while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const am = a.slice(p, a.length - s), bm = b.slice(p, b.length - s), lim = Math.max(a.length, b.length) * 0.7;
    if ((!am && !bm) || am.length > lim || bm.length > lim) return [E(a), E(b)];
    return [`${E(a.slice(0, p))}${am ? `<mark>${E(am)}</mark>` : ''}${E(a.slice(a.length - s))}`, `${E(b.slice(0, p))}${bm ? `<mark>${E(bm)}</mark>` : ''}${E(b.slice(b.length - s))}`];
  }
  /** 헝크와 그 사이의 접힌 문맥(gap). gap 은 after 전문이 있을 때만 (새 줄 번호 n0..n1, 옛 줄 번호는 o0 부터 같은 간격) */
  function segments(p) {
    const segs = []; let pn = 0, po = 0;
    p.hunks.forEach((h, i) => {
      const n0 = pn + 1, n1 = h.newLen === 0 ? h.newStart : h.newStart - 1;
      if (p.after && n1 >= n0) segs.push({ type: 'gap', idx: i, n0, n1, o0: po + 1, head: i === 0 });
      segs.push({ type: 'hunk', h });
      pn = h.newLen === 0 ? h.newStart : h.newStart + h.newLen - 1;
      po = h.oldLen === 0 ? h.oldStart : h.oldStart + h.oldLen - 1;
    });
    if (p.after && p.after.length > pn) segs.push({ type: 'gap', idx: p.hunks.length, n0: pn + 1, n1: p.after.length, o0: po + 1, tail: true });
    return segs;
  }
  function gapState(c, g) {
    const k = `${diffKey(c)}#${g.idx}`; const total = g.n1 - g.n0 + 1; const st0 = CH.gaps.get(k) || { a: 0, b: 0 };
    const a = Math.min(st0.a, total), b = Math.min(st0.b, total - a);
    return { k, total, a, b, hidden: total - a - b };
  }
  function gapBar(g, gs, idx, split) {
    const cols = split ? 4 : 3;
    const up = `<button type="button" data-ch="expand" data-gap="${idx}" data-dir="up" title="위로 ${STEP}줄 펼치기" aria-label="위로 ${STEP}줄 펼치기">${ic('up')}</button>`;
    const down = `<button type="button" data-ch="expand" data-gap="${idx}" data-dir="down" title="아래로 ${STEP}줄 펼치기" aria-label="아래로 ${STEP}줄 펼치기">${ic('down')}</button>`;
    return `<tr class="gap"><td colspan="${cols}"><div class="ch-gap">${g.head ? '' : down}<span class="lbl">${gs.hidden}줄 숨김</span><button type="button" data-ch="expand" data-gap="${idx}" data-dir="all">${ic('expand')}모두 펼치기</button>${g.tail ? '' : up}</div></td></tr>`;
  }
  const hunkHead = (h, split) => `<tr class="hh"><td class="n"></td>${split ? '<td class="c"></td><td class="n"></td>' : '<td class="n"></td>'}<td class="c">@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@ ${E(h.ctx)}</td></tr>`.replace(split ? '' : /$/, '');
  function diffTable(c, p) {
    const split = CH.view === 'split'; const rows = []; let count = 0, truncated = false;
    const cap = c.full ? Infinity : ROW_CAP;
    const push = (html) => { if (count >= cap) { truncated = true; return false; } rows.push(html); count++; return true; };
    const uni = (cls, o, n, mk, html, noeol) => push(`<tr class="${cls}${noeol ? ' noeol' : ''}"><td class="n">${o ?? ''}</td><td class="n">${n ?? ''}</td><td class="c"><span class="mk">${mk}</span>${html}</td></tr>`);
    const two = (l, r) => push(`<tr>${l ? `<td class="n ${l.cls}">${l.no}</td><td class="c ${l.cls}"><span class="mk">${l.mk}</span>${l.html}</td>` : '<td class="n empty"></td><td class="c empty"></td>'}${r ? `<td class="n ${r.cls}">${r.no}</td><td class="c ${r.cls}"><span class="mk">${r.mk}</span>${r.html}</td>` : '<td class="n empty"></td><td class="c empty"></td>'}</tr>`);
    const ctxRow = (o, n, text) => (split ? two({ cls: 'ctx', no: o, mk: ' ', html: E(text) }, { cls: 'ctx', no: n, mk: ' ', html: E(text) }) : uni('ctx', o, n, ' ', E(text)));
    outer: for (const seg of segments(p)) {
      if (seg.type === 'gap') {
        const gs = gapState(c, seg);
        for (let i = 0; i < gs.a; i++) { const n = seg.n0 + i; if (!ctxRow(seg.o0 + i, n, p.after[n - 1] ?? '')) break outer; }
        if (gs.hidden > 0 && !push(gapBar(seg, gs, seg.idx, split))) break outer;
        for (let i = gs.b - 1; i >= 0; i--) { const n = seg.n1 - i; if (!ctxRow(seg.o0 + (n - seg.n0), n, p.after[n - 1] ?? '')) break outer; }
        continue;
      }
      const h = seg.h;
      if (!push(split ? `<tr class="hh"><td class="n"></td><td class="c"></td><td class="n"></td><td class="c">@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@ ${E(h.ctx)}</td></tr>` : `<tr class="hh"><td class="n"></td><td class="n"></td><td class="c">@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@ ${E(h.ctx)}</td></tr>`)) break;
      if (!split) { for (const l of h.lines) if (!uni(l.t, l.o, l.n, l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ', l.html, l.noeol)) break outer; continue; }
      const L = h.lines; let i = 0;
      while (i < L.length) {
        const l = L[i];
        if (l.t === 'ctx') { if (!two({ cls: 'ctx', no: l.o, mk: ' ', html: l.html }, { cls: 'ctx', no: l.n, mk: ' ', html: l.html })) break outer; i++; continue; }
        let j = i; while (j < L.length && L[j].t === 'del') j++;
        let k = j; while (k < L.length && L[k].t === 'add') k++;
        if (j === i) { while (k < L.length && L[k].t === 'add') k++; }
        const dels = L.slice(i, j), adds = L.slice(j, k);
        for (let x = 0; x < Math.max(dels.length, adds.length); x++) {
          const d = dels[x], a = adds[x];
          if (!two(d ? { cls: 'del', no: d.o, mk: '−', html: d.html } : null, a ? { cls: 'add', no: a.n, mk: '+', html: a.html } : null)) break outer;
        }
        i = k;
      }
    }
    const more = truncated ? `<div class="ch-more"><button type="button" class="btn" data-ch="showall">${ic('down')}나머지 줄 모두 보기 (성능 때문에 ${ROW_CAP}줄까지만 먼저 그려요)</button></div>` : '';
    return `<table class="ch-diff ${split ? 'split' : 'unified'} ${CH.wrap ? 'wrap' : ''}" aria-label="${split ? '나란히' : '통합'} 비교"><tbody>${rows.join('')}</tbody></table>${more}`;
  }
  function expandGap(idx, dir) {
    const c = CH.cmp; if (!c) return; const entry = CH.diffs.get(diffKey(c)); if (!entry?.parsed) return;
    const g = segments(entry.parsed).find((x) => x.type === 'gap' && x.idx === idx); if (!g) return;
    const gs = gapState(c, g); const cur = { a: gs.a, b: gs.b };
    if (dir === 'all') cur.a = gs.total; else if (dir === 'down') cur.a = Math.min(gs.total - cur.b, cur.a + STEP); else cur.b = Math.min(gs.total - cur.a, cur.b + STEP);
    CH.gaps.set(gs.k, cur);
    const body = q('.ch-body'); const keep = body?.scrollTop || 0;
    renderView(); const nb = q('.ch-body'); if (nb) nb.scrollTop = keep;
  }

  /* ================= 작업 카드의 변경 요약 ================= */
  window.hubJobExtras = window.hubJobExtras || [];
  window.hubJobExtras.push((j) => {
    if (live(j)) return '';
    const cp = j.checkpoint; if (!cp) return '';
    if (cp.status === 'warning') return `<div class="ch-sum muted">${ic('alert')}<span>변경 비교를 쓸 수 없어요 · ${E(cp.warning || '체크포인트를 저장하지 못했어요')}</span></div>`;
    if (cp.status !== 'ready') return `<div class="ch-sum muted" aria-busy="true"><span class="spinner"></span><span>바뀐 파일을 저장하는 중…</span></div>`;
    const files = cp.files || [], t = totals(files), skipped = cp.skipped?.length || 0, overlaps = cp.overlaps?.length || 0;
    if (!files.length) return skipped || overlaps ? `<div class="ch-sum muted">${ic('diff')}<span>바뀐 파일 없음${skipped ? ` · 스냅샷에서 뺀 파일 ${skipped}개` : ''}${overlaps ? ` · 같은 시간에 다른 작업 ${overlaps}개` : ''}</span><button type="button" class="link" data-ch="tab" data-job="${E(j.id)}">자세히</button></div>` : '';
    const rw = CH.rewinds.get(j.id), fb = folderBusy(j), busy = CH.busy.has(j.id) || fb, bt = fb ? `title="${BUSY_TITLE}"` : '';
    return `<div class="ch-sum">${ic('diff')}<span class="ch-sum-t"><b>파일 ${t.n}개 변경</b>${pm(t.a, t.d)}${t.bin ? `<span class="ch-bin">이진 ${t.bin}</span>` : ''}${overlaps ? `<span class="ch-flag warn" title="같은 폴더에서 다른 작업 ${overlaps}개가 함께 돌아 변경이 섞여 보일 수 있어요">${ic('alert')}겹침 ${overlaps}</span>` : ''}${skipped ? `<span class="ch-flag" title="큰 파일 등 스냅샷에서 뺀 파일 ${skipped}개">뺀 파일 ${skipped}</span>` : ''}${rw?.status === 'ready' ? `<span class="ch-flag ok" title="이 작업의 변경을 되돌렸어요 (목록은 작업 당시 기록)">${ic('undo')}되돌림</span>` : ''}</span>
      <span class="ch-sum-b"><button type="button" class="btn" data-ch="compare" data-job="${E(j.id)}">${ic('diff')}변경 보기</button>${rewindBtn(j.id, rw, busy, bt)}</span></div>`;
  });

  /* ================= 되돌리기 ================= */
  function setBusy(jobId, on) { if (on) CH.busy.add(jobId); else CH.busy.delete(jobId); refreshJob(jobId); refreshPanel(jobOf(jobId)?.sessionId, true); if (CH.cmp?.kind === 'job' && CH.cmp.id === jobId) refreshCmp(); }
  function dialog({ title, icon: ico = 'undo', body, buttons }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog'); d.className = 'ch-dlg'; const tid = `chdlg${Date.now()}`;
      d.setAttribute('aria-labelledby', tid);
      d.innerHTML = `<div class="ch-dlg-h">${ic(ico)}<b id="${tid}">${E(title)}</b><span class="grow"></span><button type="button" class="icon-btn" data-r="" title="닫기" aria-label="닫기">${ic('x')}</button></div><div class="ch-dlg-b">${body}</div><div class="ch-dlg-f">${buttons.map((b, i) => (i === 1 ? '<span class="grow"></span>' : '') + `<button type="button" class="btn ${b.cls || ''}" data-r="${b.id}" ${b.focus ? 'autofocus' : ''}>${b.icon ? ic(b.icon) : ''}${E(b.label)}</button>`).join('')}</div>`;
      let result = null;
      d.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
      d.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { result = b.dataset.r || null; d.close(); } else if (e.target === d) d.close(); });
      d.addEventListener('close', () => { d.remove(); resolve(result); });
      document.body.appendChild(d);
      try { d.showModal(); } catch { d.setAttribute('open', ''); }
      (d.querySelector('[autofocus]') || d.querySelector('[data-r]'))?.focus();
    });
  }
  const fileLi = (f) => `<li>${st(f.status)}<span class="mono" title="${E(f.path)}">${E(f.path)}</span><small>${f.status === 'renamed' && f.oldPath ? `${E(splitPath(f.oldPath).name)}(으)로 되돌아가요 · 양쪽 경로 복원` : ACTION_KO[f.status] || ACTION_KO.modified}</small></li>`;
  async function rewind(jobId, paths = null) {
    const j = jobOf(jobId); const src = source('job', jobId);
    if (!j || src.status !== 'ready') return say('비교할 체크포인트가 아직 없어요', true);
    if (CH.busy.has(jobId)) return;
    const files = paths ? src.files.filter((f) => paths.includes(f.path)) : src.files;
    if (!files.length) return say('되돌릴 파일이 없어요', true);
    const one = files.length === 1 && !!paths;
    const body = `<p class="ch-dlg-p">${one ? `<b>${E(files[0].path)}</b>을(를)` : `이 요청이 바꾼 파일 <b>${files.length}개</b>를`} 작업 전 상태로 되돌려요. 되돌린 뒤에도 <b>되돌리기 취소</b>로 다시 복구할 수 있어요.</p>
      ${src.overlaps?.length ? `<div class="ch-note warn">${ic('alert')}<div><b>같은 시간에 다른 작업 ${src.overlaps.length}개가 함께 돌았어요</b><span>그 작업이 같은 파일을 고쳤다면 그 변경도 함께 되돌아가요</span></div></div>` : ''}
      <ul class="ch-dlg-files">${files.map(fileLi).join('')}</ul>
      ${src.skipped?.length ? `<p class="ch-fine">스냅샷에서 뺀 파일 ${src.skipped.length}개는 되돌리지 않아요.</p>` : ''}`;
    const r = await dialog({ title: one ? '파일 하나 되돌리기' : '이 요청 되돌리기', body, buttons: [{ id: 'cancel', label: '취소' }, { id: 'ok', label: one ? '이 파일 되돌리기' : `파일 ${files.length}개 되돌리기`, cls: 'primary', icon: 'undo', focus: true }] });
    if (r !== 'ok') return;
    await doRewind(jobId, paths, false);
  }
  async function doRewind(jobId, paths, force) {
    setBusy(jobId, true);
    try {
      const res = await call(`/api/jobs/${enc(jobId)}/rewind`, { method: 'POST', body: JSON.stringify({ ...(paths ? { paths } : {}), ...(force ? { force: true } : {}) }) });
      if (res.conflicts?.length && !res.restored?.length) {
        setBusy(jobId, false);
        const all = paths || source('job', jobId).files.flatMap((f) => [f.path, f.oldPath].filter(Boolean));
        const rest = (paths || source('job', jobId).files.map((f) => f.path)).filter((p) => { const f = source('job', jobId).files.find((x) => x.path === p); return !res.conflicts.some((c) => c.path === p || (f?.oldPath && c.path === f.oldPath)); });
        const choice = await conflictDialog(res.conflicts, rest.length < all.length ? rest.length : 0);
        if (choice === 'force') return doRewind(jobId, paths, true);
        if (choice === 'skip') return doRewind(jobId, rest, false);
        return;
      }
      CH.rewinds.set(jobId, { backup: res.backup, paths: res.restored || [], status: 'ready', at: Date.now() }); persistRewinds();
      undoToast(`파일 ${res.restored?.length || 0}개를 작업 전 상태로 되돌렸어요`, res.backup, jobId);
    } catch (e) { say(e.message || '되돌리지 못했어요', true); }
    finally { setBusy(jobId, false); }
  }
  function conflictDialog(conflicts, restCount, undo = false) {
    const body = `<p class="ch-dlg-p">${undo ? '되돌린 뒤에' : '작업이 끝난 뒤에'} 다시 바뀐 파일이 있어요. 덮어쓰면 그 뒤의 변경이 사라져요. ${undo ? '' : '(되돌리기 취소로 다시 복구할 수는 있어요)'}</p>
      <ul class="ch-dlg-files">${conflicts.map((c) => `<li>${ic('alert')}<span class="mono" title="${E(c.path)}">${E(c.path)}</span><small>${E(c.message || '작업 이후 다시 바뀜')}</small></li>`).join('')}</ul>`;
    const buttons = [{ id: 'cancel', label: '취소', focus: true }];
    if (restCount > 0) buttons.push({ id: 'skip', label: `이 파일 빼고 ${restCount}개만 되돌리기` });
    buttons.push({ id: 'force', label: '그래도 덮어쓰기', cls: 'primary danger', icon: 'alert' });
    return dialog({ title: '다시 바뀐 파일이 있어요', icon: 'alert', body, buttons });
  }
  async function undo(jobId, backup = CH.rewinds.get(jobId)?.backup, force = false) {
    if (!backup) return say('취소할 되돌리기가 없어요', true);
    if (CH.busy.has(jobId)) return;
    setBusy(jobId, true); const btn = q('#chToast .ch-tact'); if (btn) btn.disabled = true;
    try {
      const res = await call(`/api/rewinds/${enc(backup)}/undo`, { method: 'POST', body: JSON.stringify(force ? { force: true } : {}) });
      if (res.conflicts?.length && !res.restored?.length) {
        setBusy(jobId, false);
        const choice = await conflictDialog(res.conflicts, 0, true);
        if (choice === 'force') return undo(jobId, backup, true);
        if (btn) btn.disabled = false; return;
      }
      CH.rewinds.set(jobId, { ...(CH.rewinds.get(jobId) || {}), backup, status: 'undone', undoBackup: res.undoBackup || null, at: Date.now() }); persistRewinds();
      hideToast(); say(res.status === 'undone' && !res.restored?.length ? '이미 취소된 되돌리기예요' : `되돌리기를 취소했어요 · 파일 ${res.restored?.length || 0}개 복구`);
    } catch (e) { say(e.message || '되돌리기를 취소하지 못했어요', true); if (btn) btn.disabled = false; }
    finally { setBusy(jobId, false); }
  }

  /* ---------- 토스트: 되돌렸어요 · 되돌리기 취소 ---------- */
  function undoToast(msg, backup, jobId) {
    let t = q('#chToast');
    if (!t) { t = document.createElement('div'); t.id = 'chToast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
    const base = q('#toast'); if (base) base.hidden = true;
    t.innerHTML = `<span class="ch-tmsg">${ic('check')}<span>${E(msg)}</span></span><button type="button" class="ch-tact" data-ch="undo" data-job="${E(jobId)}" data-backup="${E(backup)}">${ic('undo')}되돌리기 취소</button><button type="button" class="icon-btn sm" data-ch="toast-close" aria-label="닫기">${ic('x')}</button>`;
    t.hidden = false;
    const arm = (ms) => { clearTimeout(CH.toastTimer); CH.toastTimer = setTimeout(hideToast, ms); };
    t.onmouseenter = () => clearTimeout(CH.toastTimer); t.onmouseleave = () => arm(5000); t.onfocusin = () => clearTimeout(CH.toastTimer); t.onfocusout = () => arm(5000);
    arm(12000);
  }
  function hideToast() { const t = q('#chToast'); if (t) t.hidden = true; clearTimeout(CH.toastTimer); }

  /* ---------- 되돌린 기록 복원 (새로고침 뒤에도 "되돌림" 표시) ---------- */
  /* 서버 목록(/api/checkpoints)의 backups 에는 "되돌리기 백업"과 "취소 때 만든 백업"이 같은 모양으로 섞여 있다.
     취소 백업은 취소된 백업의 undoneAt 직전(같은 처리 안)에 만들어지므로 그 시간 짝으로 가려낸다.
     같은 브라우저에서 직접 한 되돌리기·취소는 localStorage 에도 남겨 두고(백업 ID 기준) 서버 상태로 확인해 우선 쓴다. */
  const persistRewinds = () => store.set('hub.changes.rewinds', JSON.stringify(Object.fromEntries([...CH.rewinds].map(([k, v]) => [k, { backup: v.backup, status: v.status }]))));
  function deriveRewinds(backups) {
    const out = new Map(); const undone = backups.filter((b) => b.status === 'undone' && b.undoneAt).map((b) => ({ job: b.jobId, t: Date.parse(b.undoneAt) }));
    for (const b of backups) {
      if (!b.jobId || !/^r-/.test(b.id || '')) continue;
      const t = Date.parse(b.createdAt || '') || 0;
      const undoBackup = b.status === 'ready' && undone.some((u) => u.job === b.jobId && u.t >= t && u.t - t < 30_000);
      if (undoBackup) continue;
      const cur = out.get(b.jobId);
      if (!cur || t > cur.t) out.set(b.jobId, { t, backup: b.id, paths: b.paths || [], status: b.status === 'ready' ? 'ready' : 'undone', createdAt: b.createdAt || '' });
    }
    return out;
  }
  async function loadBackups() {
    if (CH.backupsLoaded) return; CH.backupsLoaded = true;
    try {
      const r = await call('/api/checkpoints');
      const all = (r.repositories || []).flatMap((repo) => repo.backups || []);
      const byId = new Map(all.map((b) => [b.id, b]));
      let local = {}; try { local = JSON.parse(store.get('hub.changes.rewinds', '{}')) || {}; } catch {}
      for (const [jobId, v] of deriveRewinds(all)) if (!CH.rewinds.has(jobId)) CH.rewinds.set(jobId, v);
      for (const [jobId, v] of Object.entries(local)) { const b = v && byId.get(v.backup); if (b) CH.rewinds.set(jobId, { backup: b.id, paths: b.paths || [], status: b.status === 'ready' ? 'ready' : 'undone', createdAt: b.createdAt || '' }); }
      if (typeof S !== 'undefined' && S.current) { for (const j of jobsOf(S.current)) if (CH.rewinds.has(j.id)) refreshJob(j.id); refreshPanel(S.current); }
    } catch { CH.backupsLoaded = false; }
  }

  /* ================= 이벤트 ================= */
  function filePop(anchor, { path, abs, kind, id }) {
    if (typeof openPop !== 'function') return;
    const items = [{ label: '줄 단위 비교 보기', icon: 'diff', run: () => { closePop(); if (cmpOpen()) selectFile(path); else openCompare(kind, id, path); } }];
    if (kind === 'job') items.push({ label: '이 파일만 되돌리기', desc: '작업 전 내용으로', icon: 'undo', run: () => { closePop(); rewind(id, [path]); } });
    items.push({ sep: true }, { label: '파일 열기', desc: typeof isRemoteView === 'function' && isRemoteView() ? '허브 PC에서만 열 수 있어요' : '기본 프로그램으로', icon: 'open', run: () => { closePop(); if (typeof openPath === 'function') openPath(abs); } }, { label: '경로 복사', icon: 'copy', run: () => { closePop(); if (typeof copyText === 'function') copyText(abs, '경로를 복사했어요'); } });
    openPop(anchor, items, { below: true, kind: 'ch-file' });
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-ch]'); if (!el) return;
    const act = el.dataset.ch; const pane = el.closest('.ch-pane'); const s = typeof S !== 'undefined' ? sessOf(S.current) : null;
    const ctx = () => (el.dataset.job ? { kind: 'job', id: el.dataset.job } : pane ? { kind: pane.dataset.kind, id: pane.dataset.id } : CH.cmp ? { kind: CH.cmp.kind, id: CH.cmp.id } : { kind: 'session', id: s?.id });
    if (act === 'scope') return scopePop(el);
    if (act === 'refresh') { const { kind, id } = ctx(); if (kind === 'session') { const c = CH.session.get(id); if (c) c.key = ''; loadSession(id, true); } else call(`/api/jobs/${enc(id)}`).then((j) => { if (typeof S !== 'undefined') { S.jobs.set(j.id, j); refreshJob(j.id); } refreshPanel(s?.id, true); }).catch((x) => say(x.message, true)); return refreshPanel(s?.id, true); }
    if (act === 'compare') { const { kind, id } = ctx(); if (el.dataset.job && s) CH.scope.set(s.id, id); return openCompare(kind, id); }
    if (act === 'file') { const { kind, id } = ctx(); if (cmpOpen() && el.closest('.ch-cmp-list')) return selectFile(el.dataset.path); return openCompare(kind, id, el.dataset.path); }
    if (act === 'rewind') return rewind(el.dataset.job, el.dataset.path ? [el.dataset.path] : null);
    if (act === 'undo') return undo(el.dataset.job, el.dataset.backup || undefined);
    if (act === 'toast-close') return hideToast();
    if (act === 'tab') return showTab(jobOf(el.dataset.job)?.sessionId || s?.id, el.dataset.job);
    if (act === 'gotojob') { const j = jobOf(el.dataset.job); if (!j) return say('그 작업은 이제 없어요', true); if (j.sessionId === S.current) return typeof gotoJob === 'function' && gotoJob(j.id); if (typeof openSession === 'function') return Promise.resolve(openSession(j.sessionId)).then(() => setTimeout(() => typeof gotoJob === 'function' && gotoJob(j.id), 250)); return; }
    if (act === 'view') { CH.view = el.dataset.v === 'split' ? 'split' : 'unified'; store.set('hub.changes.view', CH.view); return renderView(); }
    if (act === 'wrap') { CH.wrap = !CH.wrap; store.set('hub.changes.wrap', CH.wrap ? '1' : '0'); return renderView(); }
    if (act === 'more') { const { kind, id } = ctx(); return filePop(el, { path: el.dataset.path, abs: el.dataset.abs, kind, id }); }
    if (act === 'expand') return expandGap(Number(el.dataset.gap), el.dataset.dir);
    if (act === 'showall') { if (CH.cmp) { CH.cmp.full = true; renderView(); } return; }
    if (act === 'retry-diff') { if (CH.cmp) { CH.diffs.delete(diffKey(CH.cmp)); renderView(); } return; }
    if (act === 'store-reload') return loadStore(true);
    if (act === 'cleanup') return cleanupStore();
  });
  document.addEventListener('toggle', (e) => { const d = e.target; if (!(d instanceof HTMLElement) || !d.matches('details[data-ch-store]')) return; CH.storeOpen = d.open; if (d.open) loadStore(); }, true);
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ch-row[data-ch="file"]'); if (!row) return;
    e.preventDefault(); e.stopPropagation();
    const pane = row.closest('.ch-pane'); const ctx = pane ? { kind: pane.dataset.kind, id: pane.dataset.id } : CH.cmp ? { kind: CH.cmp.kind, id: CH.cmp.id } : null; if (!ctx) return;
    filePop(row, { path: row.dataset.path, abs: row.dataset.abs, ...ctx });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!cmpOpen() || !e.target.closest('.ch-cmp-list')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFile(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); moveFile(-1); } else if (e.key === 'Home') { e.preventDefault(); moveFile('first'); } else if (e.key === 'End') { e.preventDefault(); moveFile('last'); }
  });

  const cpSig = (j) => `${j.status}|${j.checkpoint?.status || ''}|${j.checkpoint?.after || ''}|${(j.checkpoint?.files || []).length}|${(j.checkpoint?.overlaps || []).length}`;
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'checkpoint') {
      const j = jobOf(ev.jobId); if (j) j.checkpoint = ev.checkpoint;
      invalidate(ev.jobId, j?.sessionId);
      setTimeout(() => { refreshJob(ev.jobId); if (j) { refreshPanel(j.sessionId); if (CH.cmp && (CH.cmp.id === ev.jobId || CH.cmp.id === j.sessionId)) refreshCmp(); } }, 0);
    } else if (ev.type === 'job') {
      const sig = cpSig(ev.job); const changed = CH.sig.get(ev.job.id) !== sig; CH.sig.set(ev.job.id, sig);
      if (changed) setTimeout(() => { invalidate(ev.job.id, ev.job.sessionId); refreshPanel(ev.job.sessionId); if (CH.cmp && (CH.cmp.id === ev.job.id || CH.cmp.id === ev.job.sessionId)) refreshCmp(); }, 0);
    } else if (ev.type === 'rewind') {
      const cur = CH.rewinds.get(ev.jobId) || {};
      if (ev.status === 'undone') CH.rewinds.set(ev.jobId, { ...cur, backup: ev.backup, status: 'undone', undoBackup: ev.undoBackup || null, at: Date.now() });
      else CH.rewinds.set(ev.jobId, { backup: ev.backup, paths: ev.restored || [], status: 'ready', at: Date.now() });
      persistRewinds(); refreshJob(ev.jobId); refreshPanel(jobOf(ev.jobId)?.sessionId);
    } else if (ev.type === 'hello') {
      CH.session.clear(); CH.diffs.clear(); CH.gaps.clear(); CH.sig.clear();
      for (const j of ev.jobs || []) CH.sig.set(j.id, cpSig(j));
      setTimeout(() => { if (typeof S !== 'undefined' && S.current) refreshPanel(S.current); refreshCmp(); loadBackups(); }, 0);
    } else if (ev.type === 'job_removed') { CH.rewinds.delete(ev.jobId); CH.sig.delete(ev.jobId); invalidate(ev.jobId, ev.sessionId); }
    else if (ev.type === 'session_removed') { CH.session.delete(ev.sessionId); CH.scope.delete(ev.sessionId); }
  });

  /* ================= 시작 ================= */
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'changes', label: '변경', icon: 'diff', render: renderTab });
  if (typeof S !== 'undefined' && S.insp && S.insp.tab === 'files') { S.insp.tab = 'changes'; S.prefs.inspTab = 'changes'; if (typeof savePrefs === 'function') savePrefs(); } // 예전 '파일' 탭 설정을 이어받는다
  window.hubChanges = { openCompare, rewind, undo, refresh: (sid) => refreshPanel(sid || S.current, true), state: CH };
})();
