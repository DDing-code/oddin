/* AI Hub — 승인·질문·계획 승인 카드, 권한 방식 선택, 도구 호출 카드 (prompts.js)
   서버 규약(lib/prompts.mjs · docs/approvals.md):
   - GET /api/prompts (대기 중) · GET /api/prompts?status=all[&jobId=] · POST /api/prompts/:id/answer
   - SSE { type:'prompt', prompt } 생김·바뀜 / job.waiting · task.waiting
   - 요청 { id, jobId, taskId, tool, kind:'approval'|'question'|'plan', category, title, detail:{ command, cwd, files:[{path,diff}], reason, input, permissions, questions:[...], plan }, status, createdAt, answeredAt, answer, expiresAt?, viewer? }
   - 응답 approval { action:'allow'|'allow_session'|'deny', message? } · question { answers:{ [qid]: string[] } } · plan { action:'approve'|'revise'|'reject', message? }
   - 로그 { kind:'tool', callId, name, input, status:'running'|'done'|'error', output, diff:[{path,before,after,unified}], startedAt, endedAt } 같은 callId 로 시작·끝이 두 번 온다.
   app.js · side.js 다음에 읽힌다. 연결점: window.hubJobExtras(작업 카드 끝) · hub:event(실시간) · logHtml·renderThread 덮어쓰기 ·
   S.prefs.permission(app.js submit 이 settings.permission 으로 보냄) · hubSessionWaiting(side.js 사이드바 줄) · 입력창 아래 #pPerm 버튼과 입력창 위 #promptDock 은 여기서 만든다. */
'use strict';
(() => {
  /* ---------- 아이콘 ---------- */
  Object.assign(IC, {
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/>',
    shieldq: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="M9.8 9.8a2.3 2.3 0 0 1 4.4.8c0 1.5-2.2 1.6-2.2 3M12 16.3h.01"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.5a2.8 2.8 0 0 1 5.4.9c0 1.9-2.7 2.1-2.7 3.9M12 17.2h.01"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>',
    eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="3"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    hourglass: '<path d="M6 3h12M6 21h12M8 3v4l4 5 4-5V3M8 21v-4l4-5 4 5v4"/>',
  });
  if (!IC.globe) IC.globe = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>';

  const PERMS = {
    auto: { label: '자동', desc: '전부 자동으로 진행 · 질문만 전달하고 답이 없으면 알아서 진행' },
    edits: { label: '편집만 자동', desc: '파일 편집은 자동, 명령 실행·네트워크는 확인' },
    ask: { label: '매번 확인', desc: '편집·명령 모두 확인 (읽기·검색은 자동)' },
    plan: { label: '계획 먼저', desc: '계획을 승인받은 뒤 편집만 자동으로 실행' },
  };
  const CAT_KO = { command: '명령 실행', file: '파일 변경', permission: '추가 권한', network: '네트워크 접근', read: '읽기', question: '질문', plan: '계획 승인' };
  const HEAD = { command: '명령을 실행할까요?', file: '파일을 바꿀까요?', permission: '추가 권한을 허용할까요?', network: '네트워크 접근을 허용할까요?', read: '읽기를 허용할까요?' };
  const ACT_KO = { allow: '허용함', allow_session: '이 작업 동안 허용함', deny: '거절함', approve: '승인함', revise: '수정 요청함', reject: '거절함' };
  const TOOL_KO = { claude: 'Claude', codex: 'Codex' };
  const P = { map: new Map(), loaded: false, busy: new Set(), toolOpen: new Set(), toolFull: new Set(), planOpen: new Set(), dockSig: '', seen: new Set() };

  /* ---------- 공용 ---------- */
  const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  const pendingList = () => [...P.map.values()].filter((p) => p.status === 'pending').sort(byCreated);
  const sessionOf = (p) => S.jobs.get(p.jobId)?.sessionId || null;
  const taskOf = (p) => S.jobs.get(p.jobId)?.tasks?.find((t) => t.id === p.taskId) || null;
  const baseName = (f) => String(f || '').split(/[\\/]/).pop();
  const dirName = (f) => { const s = String(f || ''); return s.slice(0, s.length - baseName(s).length); };
  const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
  const kindOfPrompt = (p) => (p.kind === 'approval' ? CAT_KO[p.category] || '승인' : p.kind === 'question' ? '질문' : '계획 승인');
  const headline = (p) => (p.kind === 'question' ? (p.detail?.questions?.length > 1 ? `질문 ${p.detail.questions.length}개에 답해 주세요` : '질문에 답해 주세요') : p.kind === 'plan' ? '계획을 승인할까요?' : HEAD[p.category] || p.title || '승인이 필요해요');
  function live(msg) { let el = document.getElementById('prLive'); if (!el) { el = document.createElement('div'); el.id = 'prLive'; el.className = 'sr-only'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); } el.textContent = ''; setTimeout(() => (el.textContent = msg), 40); }
  const remain = (iso) => Math.max(0, Math.round((new Date(iso) - Date.now()) / 1000));
  const remainText = (iso) => { const s = remain(iso); if (!s) return '곧 자동으로 진행돼요'; return `답이 없으면 ${s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`} 뒤 AI가 알아서 진행해요`; };

  /* ================= 1. 권한 방식 버튼 (#pPerm) =================
     고른 값은 S.prefs.permission 에 남고(app.js submit 이 settings.permission 으로 보냄), 고른 적이 없으면 서버 기본값(/api/options 의 permission.default)을 보여 주고 필드를 보내지 않는다. */
  if (!PERMS[S.prefs.permission]) delete S.prefs.permission;
  const serverPerm = () => S.options?.permission || null;
  const curPerm = () => (PERMS[S.prefs.permission] ? S.prefs.permission : PERMS[serverPerm()?.default] ? serverPerm().default : 'auto');
  const pill = document.createElement('button');
  pill.type = 'button'; pill.className = 'pill'; pill.id = 'pPerm'; pill.title = '이번 요청의 권한 방식';
  $('#pCodex').after(pill);
  function renderPermPill() {
    const k = curPerm();
    pill.innerHTML = `${icon('shield')}<span class="v"><span class="nm">권한 · </span>${esc(PERMS[k].label)}</span>${icon('down')}`;
    pill.classList.toggle('perm-on', k !== 'auto');
    pill.setAttribute('aria-label', `권한 방식: ${PERMS[k].label}`);
    pill.hidden = !!(S.caps && Object.keys(S.caps).length && !S.caps.prompts); // 승인 기능이 없는 옛 서버에서는 숨긴다
  }
  pill.addEventListener('click', () => {
    const sp = serverPerm(); const values = Object.keys(PERMS).filter((k) => !sp?.values || sp.values.includes(k));
    const items = [{ header: '이번 요청의 권한 방식 · 다음 요청에도 유지돼요' }];
    for (const k of values) {
      const minutes = Number(sp?.autoAnswerMinutes); const desc = k === 'auto' && Number.isFinite(minutes) && minutes > 0 ? `전부 자동으로 진행 · 질문만 전달하고 ${minutes}분 안에 답이 없으면 알아서 진행` : PERMS[k].desc;
      items.push({ label: PERMS[k].label + (sp?.default === k ? ' (기본)' : ''), desc, checked: curPerm() === k, run: () => { S.prefs.permission = k; savePrefs(); renderPermPill(); closePop(); } });
    }
    openPop(pill, items, { sel: Math.max(0, values.indexOf(curPerm())), kind: 'perm' });
  });
  renderPermPill();
  // app.js 가 선택지(/api/options)·상태를 받은 뒤 버튼 줄을 다시 그릴 때 함께 갱신한다
  const baseRenderBarPills = window.renderBarPills;
  window.renderBarPills = function () { baseRenderBarPills.apply(this, arguments); renderPermPill(); };

  /* ================= 2~4. 입력창 위 대기 요청 카드 (#promptDock) ================= */
  const dock = document.createElement('div');
  dock.id = 'promptDock'; dock.hidden = true; dock.setAttribute('role', 'region'); dock.setAttribute('aria-label', '승인·질문 대기');
  $('#composerWrap').prepend(dock);

  function renderDock() {
    const cur = pendingList().filter((p) => S.current && sessionOf(p) === S.current);
    const others = pendingList().filter((p) => sessionOf(p) !== S.current);
    const first = others[0]; const osid = first ? sessionOf(first) : null; const otitle = osid ? S.sessions.get(osid)?.title || '' : '';
    const sig = `${S.current}|${cur.map((p) => p.id).join(',')}|${others.map((p) => p.id).join(',')}|${osid}|${otitle}`;
    if (sig === P.dockSig) return;
    P.dockSig = sig;
    const want = new Set(cur.map((p) => p.id));
    for (const el of [...dock.querySelectorAll('.pr-card')]) if (!want.has(el.dataset.pid)) el.remove();
    for (const p of cur) if (!dock.querySelector(`.pr-card[data-pid="${CSS.escape(p.id)}"]`)) dock.appendChild(buildCard(p));
    dock.querySelector('.pr-others')?.remove();
    if (others.length) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pr-others'; b.dataset.sid = osid || '';
      b.innerHTML = `${icon('bell')}<span>${others.length > 1 ? `다른 세션에서 요청 ${others.length}건이 답을 기다려요 · ` : '다른 세션에서 답을 기다려요 · '}<b>${esc(otitle || '다른 세션')}</b> — ${esc(headline(first))}</span>${icon('right')}`;
      dock.appendChild(b);
    }
    dock.hidden = !cur.length && !others.length;
  }
  function buildCard(p) {
    const el = document.createElement('section');
    el.className = `pr-card k-${p.kind} t-${p.tool}`; el.dataset.pid = p.id; el.tabIndex = -1;
    el.setAttribute('aria-label', headline(p));
    const t = taskOf(p); const d = p.detail || {};
    const sub = `<span class="pr-sub"><span>${TOOL_KO[p.tool] || p.tool}${t ? ` · ${esc(t.title)}` : ''}</span><span>${hm(p.createdAt)}</span></span>`;
    const head = (ic, title) => `<header class="pr-h"><span class="pr-ic">${icon(ic)}</span><div class="pr-ht"><b>${esc(title)}</b>${sub}</div><span class="prov ${esc(p.tool)}">${TOOL_KO[p.tool] || p.tool}</span></header>`;
    let h = '';
    if (p.kind === 'approval') {
      h += head('shieldq', headline(p));
      let b = '';
      if (d.reason) b += `<p class="pr-why">${esc(d.reason)}</p>`;
      if (d.command) b += `<pre class="pr-cmd"><code>${esc(d.command)}</code></pre>`;
      if (d.cwd && (d.command || !d.files?.length)) b += `<div class="pr-cwd" title="${esc(d.cwd)}">${icon('folder')}<span>${esc(d.cwd)}</span></div>`;
      if (d.files?.length) b += `<div class="pr-files">${d.files.map((f) => fileHtml(f, d.input)).join('')}</div>`;
      if (d.permissions && typeof d.permissions === 'object') b += `<div class="pr-perms">${Object.entries(d.permissions).map(([k, v]) => `<span class="tag">${esc(k)}${v && typeof v === 'object' ? ': ' + esc(JSON.stringify(v)) : ''}</span>`).join('')}${d.grantRoot ? `<span class="tag">${icon('folder')}${esc(d.grantRoot)}</span>` : ''}</div>`;
      if (!d.command && !d.files?.length && !d.permissions && d.input) b += `<pre class="pr-cmd" style="color:var(--fg2)"><code>${esc(JSON.stringify(d.input, null, 1).slice(0, 1500))}</code></pre>`;
      h += `<div class="pr-b">${b}</div>`;
      h += `<footer class="pr-f"><button type="button" class="pbtn primary" data-act="allow">${icon('check')}허용</button><button type="button" class="pbtn" data-act="allow_session" title="같은 종류의 요청은 이 작업이 끝날 때까지 다시 묻지 않아요">이 작업 동안 허용</button><button type="button" class="pbtn ghost danger" data-act="deny">거절…</button><span class="pr-hint">Tab으로 이동 · Enter로 선택</span></footer>`;
      h += `<div class="pr-more" hidden><label>거절 사유 (선택) — AI에게 그대로 전달돼요<textarea rows="2" placeholder="예: 이 명령 대신 npm run check 를 쓰세요"></textarea></label><div class="pr-f"><button type="button" class="pbtn danger fill" data-act="deny-send">${icon('x')}거절 보내기</button><button type="button" class="pbtn ghost" data-act="back">돌아가기</button></div></div>`;
    } else if (p.kind === 'question') {
      const qs = d.questions || [];
      h += head('help', headline(p));
      h += `<div class="pr-b">${qs.map((q, i) => questionHtml(p, q, i)).join('')}</div>`;
      h += `<footer class="pr-f"><button type="button" class="pbtn primary" data-act="answer">${icon('up')}답변 보내기</button>${p.expiresAt ? `<span class="pr-timer" data-exp="${esc(p.expiresAt)}">${icon('hourglass')}<span>${esc(remainText(p.expiresAt))}</span></span>` : '<span class="pr-hint">모든 문항에 답해 주세요</span>'}</footer>`;
    } else {
      const plan = String(d.plan || '');
      const long = plan.length > 1200 || plan.split('\n').length > 18;
      h += head('clipboard', headline(p));
      h += `<div class="pr-b"><div class="pr-plan ${long ? 'long' : ''} ${P.planOpen.has(p.id) ? 'open' : ''}"><div class="md">${md(plan, S.jobs.get(p.jobId)?.cwd || '')}</div></div>${long ? `<button type="button" class="pr-expand" data-act="expand">${icon('down')}${P.planOpen.has(p.id) ? '접기' : '전체 보기'}</button>` : ''}</div>`;
      h += `<footer class="pr-f"><button type="button" class="pbtn primary" data-act="approve">${icon('check')}승인하고 진행</button><button type="button" class="pbtn" data-act="revise">${icon('pencil')}수정 요청…</button><button type="button" class="pbtn ghost danger" data-act="reject">거절…</button><span class="pr-hint">승인하면 파일 편집은 자동, 명령은 확인해요</span></footer>`;
      h += `<div class="pr-more" hidden></div>`;
    }
    h += `<div class="pr-err" role="alert" hidden></div>`;
    el.innerHTML = h;
    return el;
  }
  function fileHtml(f, input) {
    const path = f.path || input?.file_path || '';
    let d = null;
    if (input && input.old_string != null && (input.file_path === path || !f.path)) d = { before: input.old_string, after: input.new_string ?? '' };
    else if (input && input.content != null && input.file_path === path) d = { after: input.content };
    else if (typeof f.diff === 'string' && f.diff) d = /^(?:\+|-|@@)/m.test(f.diff) ? { unified: f.diff } : { after: f.diff };
    const kind = d?.before != null ? '수정' : d?.unified ? '변경' : '새 내용';
    return `<div class="pr-file"><div class="pr-fh">${icon('file')}<b>${esc(baseName(path))}</b><small title="${esc(path)}">${esc(dirName(path))}</small><span class="fk">${kind}</span></div>${d ? diffHtml(d) : ''}</div>`;
  }
  function questionHtml(p, q, i) {
    const name = `q-${p.id}-${q.id}`; const type = q.multiSelect ? 'checkbox' : 'radio';
    const opts = (q.options || []).map((o, k) => `<label class="pr-opt"><input type="${type}" name="${esc(name)}" value="${esc(o.label)}" data-qid="${esc(q.id)}" ${i === 0 && k === 0 ? 'data-first' : ''}><span class="pr-ol"><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></label>`).join('');
    const inputType = q.isSecret ? 'password' : 'text';
    let free = '';
    if (q.allowFreeText !== false && opts) free = `<label class="pr-opt free"><input type="${type}" name="${esc(name)}" value="__free__" data-qid="${esc(q.id)}"><span class="pr-ol"><b>직접 입력</b><input type="${inputType}" class="pr-free" data-free="${esc(q.id)}" placeholder="답을 적어 주세요" autocomplete="off" spellcheck="false"></span></label>`;
    else if (!opts) free = q.isSecret ? `<input type="password" class="pr-free" data-free="${esc(q.id)}" data-only placeholder="답을 적어 주세요" autocomplete="off">` : `<textarea class="pr-free" data-free="${esc(q.id)}" data-only rows="2" placeholder="답을 적어 주세요" spellcheck="false"></textarea>`;
    return `<fieldset class="pr-q" data-qid="${esc(q.id)}"><legend>${q.header ? `<span class="qh">${esc(q.header)}</span>` : ''}<span>${esc(q.question)}</span>${q.multiSelect ? '<small>여러 개 선택 가능</small>' : ''}</legend><div class="pr-opts">${opts}${free}</div></fieldset>`;
  }
  function collectAnswers(card, p) {
    const answers = {};
    for (const q of p.detail?.questions || []) {
      const fs = card.querySelector(`.pr-q[data-qid="${CSS.escape(q.id)}"]`); if (!fs) continue;
      const picked = [...fs.querySelectorAll('input[type=radio]:checked, input[type=checkbox]:checked')].map((x) => x.value);
      const freeEl = fs.querySelector('[data-free]'); const freeV = freeEl ? freeEl.value.trim() : '';
      const vals = picked.filter((v) => v !== '__free__');
      if (picked.includes('__free__') || freeEl?.dataset.only !== undefined) { if (!freeV && (picked.includes('__free__') || !vals.length)) return { error: `"${q.header || q.question}" 문항의 답을 적어 주세요`, focus: freeEl }; if (freeV) vals.push(freeV); }
      if (!vals.length) return { error: `"${q.header || q.question}" 문항을 골라 주세요`, focus: fs.querySelector('input') };
      answers[q.id] = vals;
    }
    return { answers };
  }
  function showErr(card, msg) { const e = card.querySelector('.pr-err'); e.textContent = msg; e.hidden = !msg; }
  function showMore(card, mode) {
    const more = card.querySelector('.pr-more'); const p = P.map.get(card.dataset.pid);
    if (p?.kind === 'plan') {
      more.innerHTML = mode === 'revise'
        ? `<label>어떻게 바꿀지 적어 주세요 — 이 의견을 반영해 계획을 다시 세워요<textarea rows="3" placeholder="예: 테스트를 먼저 추가하고, 문서 수정은 빼 주세요" required></textarea></label><div class="pr-f"><button type="button" class="pbtn primary" data-act="revise-send">${icon('pencil')}수정 요청 보내기</button><button type="button" class="pbtn ghost" data-act="back">돌아가기</button></div>`
        : `<label>거절 사유 (선택) — 작업이 여기서 멈춰요<textarea rows="2" placeholder="예: 지금은 진행하지 않을게요"></textarea></label><div class="pr-f"><button type="button" class="pbtn danger fill" data-act="reject-send">${icon('x')}거절 보내기</button><button type="button" class="pbtn ghost" data-act="back">돌아가기</button></div>`;
    }
    more.hidden = false; more.dataset.mode = mode; card.querySelector('footer.pr-f').hidden = true;
    more.querySelector('textarea')?.focus();
  }
  function hideMore(card) { const more = card.querySelector('.pr-more'); if (!more) return; more.hidden = true; card.querySelector('footer.pr-f').hidden = false; card.querySelector('footer.pr-f button')?.focus(); }
  async function send(card, p, body, btn) {
    if (P.busy.has(p.id)) return;
    P.busy.add(p.id); card.classList.add('busy'); showErr(card, '');
    const ctrls = [...card.querySelectorAll('button,input,textarea')]; ctrls.forEach((x) => (x.disabled = true));
    const old = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>보내는 중'; btn.setAttribute('aria-busy', 'true');
    try {
      const r = await api(`/api/prompts/${encodeURIComponent(p.id)}/answer`, { method: 'POST', body: JSON.stringify(body) });
      P.map.set(r.id, r);
      live(`${kindOfPrompt(r)} 응답을 보냈어요: ${answerText(r)}`);
      afterChange(r);
      // 카드가 사라지면 초점을 다음 카드나 입력창으로 옮긴다 (키보드 사용자)
      if (!card.isConnected) (dock.querySelector('.pr-card footer.pr-f button, .pr-card .pr-opts input') || input).focus({ preventScroll: true });
    } catch (e) {
      showErr(card, e.message || '보내지 못했어요');
      ctrls.forEach((x) => (x.disabled = false)); btn.innerHTML = old; btn.removeAttribute('aria-busy'); card.classList.remove('busy');
      if (/이미 처리|만료|찾을 수 없/.test(e.message || '')) loadAll();
    } finally { P.busy.delete(p.id); }
  }
  dock.addEventListener('click', (e) => {
    const o = e.target.closest('.pr-others'); if (o) { if (o.dataset.sid) openSession(o.dataset.sid); return; }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const card = b.closest('.pr-card'); const p = P.map.get(card?.dataset.pid); if (!p) return;
    const act = b.dataset.act; const more = card.querySelector('.pr-more');
    const msg = () => (more?.querySelector('textarea')?.value || '').trim();
    if (act === 'allow' || act === 'allow_session' || act === 'approve') return send(card, p, { action: act }, b);
    if (act === 'deny' || act === 'revise' || act === 'reject') return showMore(card, act);
    if (act === 'back') return hideMore(card);
    if (act === 'deny-send') return send(card, p, { action: 'deny', message: msg() }, b);
    if (act === 'reject-send') return send(card, p, { action: 'reject', message: msg() }, b);
    if (act === 'revise-send') { if (!msg()) { showErr(card, '수정 의견을 적어 주세요'); more.querySelector('textarea')?.focus(); return; } return send(card, p, { action: 'revise', message: msg() }, b); }
    if (act === 'expand') { P.planOpen.has(p.id) ? P.planOpen.delete(p.id) : P.planOpen.add(p.id); const open = P.planOpen.has(p.id); card.querySelector('.pr-plan').classList.toggle('open', open); b.innerHTML = `${icon(open ? 'up' : 'down')}${open ? '접기' : '전체 보기'}`; return; }
    if (act === 'answer') {
      const r = collectAnswers(card, p);
      if (r.error) { showErr(card, r.error); r.focus?.focus(); return; }
      return send(card, p, { answers: r.answers }, b);
    }
  });
  // 직접 입력에 글을 쓰면 그 선택지가 자동으로 골라진다
  dock.addEventListener('input', (e) => {
    const f = e.target.closest('.pr-free'); if (!f || f.dataset.only !== undefined) return;
    const opt = f.closest('.pr-opt')?.querySelector('input[value="__free__"]'); if (opt && f.value && !opt.checked) { opt.checked = true; }
    const card = f.closest('.pr-card'); if (card) showErr(card, '');
  });
  dock.addEventListener('focusin', (e) => { const f = e.target.closest('.pr-free'); const opt = f?.closest('.pr-opt')?.querySelector('input[value="__free__"]'); if (opt && !opt.checked && opt.type === 'radio') opt.checked = true; });
  dock.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const card = e.target.closest('.pr-card'); if (!card) return;
    if (e.key === 'Escape' && e.target.closest('.pr-more')) { e.preventDefault(); e.stopPropagation(); return hideMore(card); }
    if (e.key === 'Enter' && e.target.matches('input.pr-free')) { e.preventDefault(); return card.querySelector('[data-act="answer"]')?.click(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea')) { e.preventDefault(); const more = e.target.closest('.pr-more'); return (more ? more.querySelector('[data-act$="-send"]') : card.querySelector('[data-act="answer"]'))?.click(); }
  });

  /* ================= 작업 카드 안: 요청 기록 행 ================= */
  function answerText(p) {
    const a = p.answer || {};
    if (p.status === 'cancelled') return '취소됨';
    if (p.status === 'expired') return a.automatic ? '답변 시간이 지나 AI가 판단해서 진행했어요' : /다시 시작/.test(p.reason || '') ? '서버가 다시 시작되어 요청이 만료되었어요' : (p.reason || a.message || '만료됨');
    if (p.kind === 'question') {
      const secret = new Set((p.detail?.questions || []).filter((q) => q.isSecret).map((q) => q.id));
      return Object.entries(a.answers || {}).map(([k, v]) => secret.has(k) ? '•••' : [].concat(v).join(', ')).join(' · ') || '답변함';
    }
    return `${ACT_KO[a.action] || a.action || ''}${a.message ? ` · ${a.message}` : ''}`;
  }
  function rowSummary(p) {
    const d = p.detail || {};
    if (p.kind === 'approval') {
      if (d.command) return `<code>${esc(firstLine(d.command))}</code>`;
      if (d.files?.length) return `<span>${esc(d.files.map((f) => baseName(f.path)).join(', '))}</span>`;
      if (d.permissions) return `<span>${esc(Object.keys(d.permissions).join(', '))}</span>`;
      return `<span>${esc(p.title || '')}</span>`;
    }
    if (p.kind === 'question') { const qs = d.questions || []; return `<span>${esc(qs[0]?.question || '')}${qs.length > 1 ? ` 외 ${qs.length - 1}개` : ''}</span>`; }
    return `<span>${esc(firstLine(String(d.plan || '')).replace(/^#+\s*/, '') || '계획')}</span>`;
  }
  function rowHtml(p) {
    const a = p.answer || {}; const pend = p.status === 'pending';
    const ok = ['allow', 'allow_session', 'approve'].includes(a.action) || (p.kind === 'question' && p.status === 'answered');
    const cls = pend ? '' : ['deny', 'reject'].includes(a.action) || p.status === 'cancelled' ? 'err' : a.action === 'revise' ? 'run' : ok ? 'ok' : '';
    const st = pend ? `<span class="spin-xs"></span>${p.kind === 'question' ? '답변 대기' : '승인 대기'}`
      : `${icon(cls === 'ok' ? 'check' : cls === 'err' ? 'x' : cls === 'run' ? 'pencil' : 'minus')}<span title="${esc(answerText(p))}">${esc(answerText(p))}</span>${p.answeredAt ? `<small class="c-muted"> · ${hm(p.answeredAt)}${p.viewer?.remote ? ' · 원격' : ''}</small>` : ''}`;
    return `<div class="pr-row s-${esc(p.status)} k-${esc(p.kind)} ${a.action ? `a-${esc(a.action)}` : ''}">${icon(p.kind === 'question' ? 'help' : p.kind === 'plan' ? 'clipboard' : 'shieldq')}<span class="prov ${esc(p.tool)}">${TOOL_KO[p.tool] || p.tool}</span><span class="pr-rt"><b>${esc(kindOfPrompt(p))}</b>${rowSummary(p)}</span><span class="pr-rs ${cls}">${st}</span>${pend ? `<button type="button" class="btn" data-pr-focus="${esc(p.id)}">${icon('bell')}답하기</button>` : ''}</div>`;
  }
  (window.hubJobExtras = window.hubJobExtras || []).push((j) => {
    const list = [...P.map.values()].filter((p) => p.jobId === j.id).sort(byCreated);
    return list.length ? `<div class="prs" aria-label="승인·질문 기록">${list.map(rowHtml).join('')}</div>` : '';
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pr-focus]'); if (!b) return;
    const card = dock.querySelector(`.pr-card[data-pid="${CSS.escape(b.dataset.prFocus)}"]`);
    if (!card) { renderDock(); return; }
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    (card.querySelector('footer.pr-f button, .pr-opts input, .pr-free') || card).focus({ preventScroll: true });
  });

  /* ================= 5. 대기 표시: 사이드바 · 탭 제목 · 알림 ================= */
  window.hubSessionWaiting = (sid) => pendingList().some((p) => sessionOf(p) === sid);
  const TITLE_RE = /^\(\d+\) 승인 필요 · /;
  function updateTitle() {
    const n = pendingList().length; const base = document.title.replace(TITLE_RE, '');
    const want = n ? `(${n}) 승인 필요 · ${base}` : base;
    if (document.title !== want) document.title = want;
  }
  function notifyNew(p) {
    const sid = sessionOf(p); const s = S.sessions.get(sid); const where = s?.title || '작업';
    live(`승인이 필요해요: ${where} — ${headline(p)}`);
    if (sid !== S.current) toast(`${where} — ${headline(p)} · 사이드바에서 열어 답해 주세요`);
    const D = window.hubDesktop; if (D?.isDesktop && typeof D.notify === 'function') { try { D.notify({ title: '승인이 필요해요', body: `${where} — ${headline(p)}`, sessionId: sid }); } catch {} }
  }
  function afterChange(p) {
    renderDock(); renderTree(); updateTitle();
    const j = S.jobs.get(p.jobId); if (j && j.sessionId === S.current) queueRerender(j.id);
  }
  function onPrompt(p) {
    const prev = P.map.get(p.id); P.map.set(p.id, p);
    if (p.status === 'pending' && !prev && !P.seen.has(p.id)) { P.seen.add(p.id); if (P.loaded) notifyNew(p); }
    if (prev?.status === 'pending' && p.status !== 'pending' && p.status !== 'answered') live(`${kindOfPrompt(p)} 요청이 ${p.status === 'cancelled' ? '취소' : '만료'}됐어요`);
    afterChange(p);
  }
  async function loadAll() {
    try {
      const list = await api('/api/prompts?status=all');
      P.map = new Map(list.map((p) => [p.id, p])); P.loaded = true;
      for (const p of list) P.seen.add(p.id);
      // 처음·재연결 때는 세션·작업 정보가 바뀌었을 수 있으니 카드를 새로 만든다
      P.dockSig = ''; for (const el of [...dock.querySelectorAll('.pr-card')]) if (!P.busy.has(el.dataset.pid)) el.remove();
      renderDock(); renderTree(); updateTitle();
      if (S.current) for (const j of sessionJobs(S.current)) queueRerender(j.id);
    } catch (e) { if (!P.loaded) setTimeout(loadAll, 5000); }
  }
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail;
    if (ev.type === 'prompt' && ev.prompt) onPrompt(ev.prompt);
    else if (ev.type === 'hello') setTimeout(loadAll, 0); // app.js 가 S.jobs 를 채운 뒤에
  });
  // 세션을 바꾸면 그 세션의 대기 요청으로 카드 묶음을 다시 그린다
  const baseRenderThread = window.renderThread;
  window.renderThread = function () { baseRenderThread.apply(this, arguments); renderDock(); };
  setInterval(() => {
    for (const el of dock.querySelectorAll('[data-exp]')) { const span = el.lastElementChild; const txt = remainText(el.dataset.exp); if (span && span.textContent !== txt) span.textContent = txt; }
    updateTitle();
  }, 1000);
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(loadAll, 0); else document.addEventListener('DOMContentLoaded', () => setTimeout(loadAll, 0));

  /* ================= 6. 도구 호출 카드 (작업 진행 기록) ================= */
  const TOOL_KIND = (name) => /^(Bash|PowerShell)$|exec/i.test(name) ? 'cmd' : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? 'edit' : name === 'Read' ? 'read' : /^(Grep|Glob|ToolSearch)$/.test(name) ? 'search' : /^Web|Fetch|Search/i.test(name) ? 'web' : /^MCP /.test(name) ? 'mcp' : name === 'AskUserQuestion' ? 'ask' : name === 'ExitPlanMode' ? 'plan' : /^(Agent|Task)$/.test(name) ? 'agent' : 'other';
  const TOOL_ICON = { cmd: 'terminal', edit: 'pencil', read: 'eye', search: 'search', web: 'globe', mcp: 'cpu', ask: 'help', plan: 'clipboard', agent: 'bot', other: 'bolt' };
  const CUT_LINES = 14, CUT_CHARS = 1400;
  function cutText(s, full) {
    s = String(s ?? '');
    if (full) return { text: s, cut: false };
    const lines = s.split('\n');
    if (lines.length <= CUT_LINES && s.length <= CUT_CHARS) return { text: s, cut: false };
    let t = lines.slice(0, CUT_LINES).join('\n'); if (t.length > CUT_CHARS) t = t.slice(0, CUT_CHARS);
    return { text: t, cut: true, lines: lines.length };
  }
  function diffHtml(d) {
    const line = (cls, l) => `<span class="dl ${cls}">${esc(l)}</span>`;
    if (d.unified) return `<pre class="tc-diff">${String(d.unified).split('\n').map((l) => line(/^… 중간 생략/.test(l.trim()) ? 'cut' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '', l)).join('')}</pre>`;
    const rows = [];
    if (d.before != null) for (const l of String(d.before).split('\n')) rows.push(line('del', `- ${l}`));
    if (d.after != null) for (const l of String(d.after).split('\n')) rows.push(line('add', `+ ${l}`));
    return rows.length ? `<pre class="tc-diff">${rows.join('')}</pre>` : '';
  }
  const diffCounts = (list) => { let add = 0, del = 0; for (const d of list || []) { if (d.unified) for (const l of String(d.unified).split('\n')) { if (l[0] === '+' && !l.startsWith('+++')) add++; else if (l[0] === '-' && !l.startsWith('---')) del++; } else { if (d.after != null) add += String(d.after).split('\n').length; if (d.before != null) del += String(d.before).split('\n').length; } } return { add, del }; };
  function toolSummary(e, kind) {
    const i = e.input || {};
    if (kind === 'cmd') return `<span class="tc-s mono">${esc(firstLine(i.command || e.detail))}</span>`;
    if (kind === 'edit') { const paths = e.diff?.map((d) => d.path) || i.paths || [i.file_path].filter(Boolean); const p = paths[0] || e.detail || ''; const c = diffCounts(e.diff); return `<span class="tc-s"><b>${esc(baseName(p))}</b>${paths.length > 1 ? ` <small>외 ${paths.length - 1}개</small>` : ''} <small>${esc(dirName(p))}</small></span>${c.add || c.del ? `<span class="tc-cnt">${c.add ? `<span class="add">+${c.add}</span>` : ''}${c.del ? `<span class="del">−${c.del}</span>` : ''}</span>` : ''}`; }
    if (kind === 'read') { const p = i.file_path || i.path || e.detail || ''; return `<span class="tc-s"><b>${esc(baseName(p))}</b> <small>${esc(dirName(p))}</small></span>`; }
    if (kind === 'search') return `<span class="tc-s"><code class="mono">${esc(i.pattern || i.query || e.detail || '')}</code>${i.path ? ` <small>${esc(i.path)}</small>` : ''}</span>`;
    if (kind === 'web') return `<span class="tc-s">${esc(i.url || i.query || e.detail || '')}</span>`;
    if (kind === 'ask') return `<span class="tc-s">질문 ${(i.questions || []).length || 1}개</span>`;
    if (kind === 'plan') return `<span class="tc-s">계획 제출</span>`;
    if (kind === 'agent') return `<span class="tc-s">${esc(i.description || i.prompt || e.detail || '')}</span>`;
    const d = e.detail && e.detail !== e.name ? e.detail : Object.entries(i).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
    return `<span class="tc-s">${esc(d || '')}</span>`;
  }
  function toolCard(e, tool, key) {
    const kind = TOOL_KIND(e.name || ''); const id = e.callId; const open = P.toolOpen.has(id); const full = P.toolFull.has(id);
    const running = e.status === 'running' || !e.status; const err = e.status === 'error';
    const hasBody = !!(e.output || e.diff?.length || (kind === 'cmd' && (e.input?.command || '').includes('\n')) || (kind !== 'cmd' && kind !== 'edit' && e.input && Object.keys(e.input).length && kind !== 'read'));
    const meta = running ? `<span class="tc-m"><span class="spinner"></span><span class="live-dur" data-from="${esc(e.startedAt || e.at || '')}"></span></span>`
      : `<span class="tc-m ${err ? 'err' : 'ok'}">${icon(err ? 'alert' : 'check')}${e.startedAt && e.endedAt ? esc(dur(e.startedAt, e.endedAt)) : ''}</span>`;
    let body = '';
    if (open) {
      if (kind === 'cmd') {
        if (e.input?.command) body += `<pre class="tc-cmd">${esc(e.input.command)}</pre>`;
        if (running) body += `<div class="tc-run"><span class="spinner"></span>실행 중…</div>`;
        else if (e.output) { const c = cutText(e.output, full); body += `<pre class="tc-out ${err ? 'err' : ''}">${esc(c.text)}${c.cut ? '\n…' : ''}</pre>${c.cut ? `<button type="button" class="tc-more" data-tc-full="${esc(id)}">${icon('down')}전체 보기 (${c.lines}줄)</button>` : full ? `<button type="button" class="tc-more" data-tc-full="${esc(id)}">${icon('up')}접기</button>` : ''}`; }
      } else if (kind === 'edit') {
        for (const d of e.diff || []) body += `<div class="tc-path">${icon('file')}<b>${esc(baseName(d.path))}</b><small title="${esc(d.path || '')}">${esc(dirName(d.path))}</small></div>${diffHtml(d)}`;
        if (!e.diff?.length && e.output) body += `<pre class="tc-out ${err ? 'err' : ''}">${esc(cutText(e.output, true).text)}</pre>`;
        else if (err && e.output) body += `<pre class="tc-out err">${esc(cutText(e.output, false).text)}</pre>`;
        if (running) body += `<div class="tc-run"><span class="spinner"></span>적용 중…</div>`;
      } else {
        if (e.input && Object.keys(e.input).length && kind !== 'read') body += `<div class="tc-lbl">입력</div><pre class="tc-out">${esc(JSON.stringify(e.input, null, 1).slice(0, 2000))}</pre>`;
        if (running) body += `<div class="tc-run"><span class="spinner"></span>${kind === 'ask' ? '답을 기다리는 중…' : '실행 중…'}</div>`;
        else if (e.output) { const c = cutText(e.output, full); body += `<div class="tc-lbl">결과</div><pre class="tc-out ${err ? 'err' : ''}">${esc(c.text)}${c.cut ? '\n…' : ''}</pre>${c.cut ? `<button type="button" class="tc-more" data-tc-full="${esc(id)}">${icon('down')}전체 보기 (${c.lines}줄)</button>` : full ? `<button type="button" class="tc-more" data-tc-full="${esc(id)}">${icon('up')}접기</button>` : ''}`; }
      }
    }
    return `<div class="tc ${esc(tool)} k-${kind} s-${esc(e.status || 'running')} ${open ? 'open' : ''}" data-tc-job="${esc(key.split('/')[0])}"><button type="button" class="tc-h" data-tc="${esc(id)}" aria-expanded="${open}" ${hasBody ? '' : 'disabled'}>${icon(TOOL_ICON[kind])}<span class="tc-n">${esc(e.name || 'tool')}</span>${toolSummary(e, kind)}${meta}${hasBody ? `<span class="chev">${icon('right')}</span>` : ''}</button>${body ? `<div class="tc-b">${body}</div>` : ''}</div>`;
  }
  function lineHtml(e, tool) {
    const k = e.kind; let cls = 'lg', mark = '', text = e.text ?? '';
    if (k === 'tool') { cls += ` tool ${tool}`; mark = e.name || 'tool'; text = e.detail || ''; }
    else if (k === 'message') { cls += ' msg'; mark = '답변'; }
    else if (k === 'thinking') { cls += ' think'; mark = '생각'; }
    else if (k === 'tool_error' || k === 'error') { cls += ' err'; mark = '오류'; }
    else if (k === 'stderr') { cls += ' warn'; mark = '경고'; }
    else if (k === 'intercept') { cls += ' ic'; mark = '수정 지시'; }
    else if (k === 'init') { mark = '시작'; text = `${e.model || ''}${e.effort ? ' · ' + e.effort : ''}`; }
    else if (k === 'waiting') { if (!e.waiting) return ''; cls += ' waiting'; mark = '대기'; text = '사용자 응답을 기다려요'; }
    text = String(text); if (text.length > 800) text = text.slice(0, 800) + '…';
    return `<div class="${cls}"><span class="k">${esc(mark)}</span><span>${esc(text)}</span></div>`;
  }
  const baseLogHtml = window.logHtml;
  window.logHtml = function (key, tool) {
    const raw = (S.logs.get(key) || []).filter((e) => !['result', 'raw'].includes(e.kind));
    if (!raw.some((e) => e.kind === 'tool' && e.callId)) return baseLogHtml(key, tool); // 구조화 기록이 없는 예전 로그는 그대로
    const list = []; const at = new Map();
    for (const e of raw) {
      if (e.kind === 'tool' && e.callId) { if (at.has(e.callId)) { list[at.get(e.callId)] = e; continue; } at.set(e.callId, list.length); }
      list.push(e);
    }
    return list.map((e) => (e.kind === 'tool' && e.callId ? toolCard(e, tool, key) : lineHtml(e, tool))).join('');
  };
  $('#thread').addEventListener('click', (e) => {
    const f = e.target.closest('[data-tc-full]'); if (f) { const id = f.dataset.tcFull; P.toolFull.has(id) ? P.toolFull.delete(id) : P.toolFull.add(id); return rerenderJob(f.closest('[data-tc-job]').dataset.tcJob); }
    const h = e.target.closest('[data-tc]'); if (h && !h.disabled) { const id = h.dataset.tc; P.toolOpen.has(id) ? P.toolOpen.delete(id) : P.toolOpen.add(id); return rerenderJob(h.closest('[data-tc-job]').dataset.tcJob); }
  });
})();
