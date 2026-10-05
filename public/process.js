/* 작업 카드의 추론 과정과 키보드·스크롤 동작 */
'use strict';
(() => {
  const M = window.ProcessModel, H = window.hubPrompts, P = H.P;
  const closed = new Set(), limits = new Map(), unread = new Map(), totals = new Map(), scrolls = new Map(), focus = new Map(), mounted = new WeakSet();
  const modelFor = (j) => M.build(j, S.logs, [...P.map.values()]);
  const domId = (key) => `pi-${encodeURIComponent(key)}`;
  const tag = (tool) => tool ? `<span class="prov ${esc(tool)}">${tool === 'claude' ? 'Claude' : 'Codex'}</span>` : '';
  const openFor = (key, fallback = false) => S.open.has(key) || (!closed.has(key) && fallback);
  function setOpen(key, open) { if (open) { S.open.add(key); closed.delete(key); } else { S.open.delete(key); closed.add(key); } }
  function redraw(jobId, focusId) { rerenderJob(jobId); mount(); if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true }); }
  const chev = (open) => `<span class="chev ${open ? 'turned' : ''}">${icon('right')}</span>`;
  const stamp = (e, s) => `<span class="pi-m" title="${esc(hm(e.at))}">${esc(M.offset(s.startedAt, e.at))}</span>`;
  // 기본은 생각만 보기. "작업 기록"을 누른 작업만 명령·수정까지 전부 보여 준다
  const detailOn = (jobId) => S.open.has(`procdetail:${jobId}`);
  const inline = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  function nowThink(p, multi) {
    if (!p || !p.text && !p.activity) return '';
    return `<span class="proc-now">${multi ? tag(p.assignee) : ''}${p.activity ? `<em>${esc(p.activity)}</em>${p.text ? ' · ' : ''}` : ''}${esc(p.text)}</span>`;
  }
  function summary(c, tasks = 0) {
    const base = [tasks > 1 ? `작업 ${tasks}개` : '', c.steps ? `${c.steps}단계` : ''].filter(Boolean).join(' · ');
    return base + [c.commands ? `명령 ${c.commands}` : '', c.edits ? `수정 ${c.edits}` : '', c.errors ? `오류 ${c.errors}` : ''].map((text, i) => text ? `<span class="opt ${i === 2 ? 'c-err' : ''}">${base || i > 0 && c.commands ? ' · ' : ''}${text}</span>` : '').join('');
  }
  function duration(from, to, live = false, precise = false) {
    return live ? `<span class="live-dur" data-from="${esc(from || '')}" ${precise ? 'data-proc-precise' : ''} title="${esc(hm(from))}">${esc(M.elapsed(from, new Date().toISOString(), precise))}</span>` : `<span title="${esc(hm(to || from))}">${esc(M.elapsed(from, to, precise))}</span>`;
  }
  function now(p, multi) { return p ? `<span class="proc-now"><em>지금:</em> ${multi ? tag(p.assignee) : ''} ${p.mono ? `<code>${esc(p.text)}</code>` : esc(p.text)}</span>` : ''; }
  function promptKind(p) {
    const kind = H.kindOfPrompt(p);
    return p.kind === 'approval' && ['command', 'file'].includes(p.category) ? `${kind} 승인` : kind;
  }
  function promptAnswer(p) {
    if (p.status === 'expired') return p.answer?.automatic ? '답이 없어 AI가 판단해 진행' : /다시 시작|재시작/.test(p.reason || '') ? '서버 재시작으로 만료됨' : '만료됨';
    return H.answerText(p);
  }
  function toolMeta(e) {
    const running = !e.status || e.status === 'running', error = e.status === 'error';
    const label = error ? e.toolKind === 'cmd' && e.exitCode != null ? `종료 코드 ${e.exitCode}` : '오류' : '';
    return `<span class="tc-m ${error ? 'err' : running ? '' : 'ok'}" title="${esc(hm(e.endedAt || e.at))}">${running ? '<span class="spinner"></span>' : icon(error ? 'alert' : 'check')}${label}${label ? ' · ' : ''}${duration(e.startedAt || e.at, e.endedAt || e.at, running, true)}</span>`;
  }
  function outputHtml(e, id) {
    const full = P.toolFull.has(id), cut = H.cutText(e.output, full);
    return `<pre class="tc-out ${e.status === 'error' ? 'err' : ''} ${e.output ? '' : 'empty'}" id="${domId(id)}-out" tabindex="0" aria-label="명령 출력">${esc(cut.text || '출력 없음')}${cut.cut ? '\n…' : ''}</pre>${cut.cut || full ? `<button type="button" class="tc-more" data-proc-full="${esc(id)}" id="${domId(id)}-full">${cut.cut ? `전체 보기 (${cut.lines}줄)` : '접기'}</button>` : ''}`;
  }
  function diffHtml(d, id, index) {
    const fullKey = `${id}#d${index}`, full = P.toolFull.has(fullKey);
    const rows = d.unified ? String(d.unified).split('\n') : [...(d.before != null ? String(d.before).split('\n').map((l) => `- ${l}`) : []), ...(d.after != null ? String(d.after).split('\n').map((l) => `+ ${l}`) : [])];
    const cut = !full && rows.length > 40;
    const value = cut ? { unified: rows.slice(0, 30).join('\n') } : d;
    return H.diffHtml(value).replace('<pre class="tc-diff">', `<pre class="tc-diff" id="${domId(fullKey)}-out" tabindex="0" aria-label="파일 변경 내용">`) + (cut || full ? `<button type="button" class="tc-more" id="${domId(fullKey)}-full" data-proc-full="${esc(fullKey)}">${cut ? `전체 보기 (${rows.length}줄)` : '접기'}</button>` : '');
  }
  function toolHtml(e, s) {
    if (!e.callId) return `<li class="proc-i k-legacy"><span class="pi-ic">${icon('bolt')}</span><div class="pi-c">${H.lineHtml(e, s.assignee)}</div>${stamp(e, s)}</li>`;
    const id = e.callId, kind = e.toolKind, open = P.toolOpen.has(id), command = M.displayCommand(e.input?.command || e.detail || '');
    const hasBody = !!(e.output || e.diff?.length || e.status === 'error' || kind === 'cmd' && command.includes('\n') || kind !== 'cmd' && kind !== 'edit' && kind !== 'read' && e.input && Object.keys(e.input).length);
    const extra = kind === 'cmd' && command.split('\n').length > 1 ? `<small class="proc-lines">+${command.split('\n').length - 1}줄</small>` : '';
    let body = '';
    if (open && hasBody) {
      if (kind === 'cmd') {
        if (e.input?.cwd) body += `<div class="tc-path">${icon('folder')}<small title="${esc(e.input.cwd)}">${esc(e.input.cwd)}</small></div>`;
        body += `<pre class="tc-cmd">${esc(command)}</pre>`;
        body += !e.status || e.status === 'running' ? '<div class="tc-run"><span class="spinner"></span>실행 중…</div>' : outputHtml(e, id);
        if (e.status === 'error') body += `<div class="c-err">${e.exitCode != null ? `종료 코드 ${e.exitCode}` : e.missingResult ? '결과를 받지 못함 · 작업이 끝나거나 중지됨' : '오류'}</div>`;
      } else if (kind === 'edit') {
        for (const [i, d] of (e.diff || []).entries()) {
          const path = String(d.path || '').replace(/\\/g, '/'), split = path.lastIndexOf('/');
          body += `<div class="tc-path">${icon('file')}<b>${esc(path.slice(split + 1))}</b><small title="${esc(d.path)}">${esc(path.slice(0, split + 1))}</small></div>${diffHtml(d, id, i)}`;
        }
        if (e.output) body += outputHtml(e, id);
        if (!e.status || e.status === 'running') body += '<div class="tc-run"><span class="spinner"></span>적용 중…</div>';
      } else {
        // 그 외 도구는 기존 카드 본문을 재사용한다
        const template = document.createElement('template'); template.innerHTML = H.toolCard(e, s.assignee, s.key);
        const b = template.content.querySelector('.tc-b'); if (b) { b.querySelectorAll('pre').forEach((el) => el.tabIndex = 0); b.querySelectorAll('[data-tc-full]').forEach((el) => { el.dataset.procFull = el.dataset.tcFull; delete el.dataset.tcFull; }); body = b.innerHTML; }
      }
    }
    const icons = { cmd: 'terminal', read: 'eye', search: 'search', edit: 'pencil', web: 'globe', mcp: 'cpu', agent: 'bot', ask: 'help', plan: 'clipboard', other: 'bolt' };
    return `<li class="proc-tool"><div class="tc ${esc(s.assignee || '')} k-${kind} s-${esc(e.status || 'running')} ${open ? 'open' : ''}"><button type="button" class="tc-h" id="${domId(id)}-h" data-proc-tool="${esc(id)}" aria-expanded="${open && hasBody}" aria-controls="${domId(id)}-b" ${hasBody ? '' : 'disabled'}>${icon(icons[kind])}${H.toolSummary(e, kind)}${extra}${toolMeta(e)}${hasBody ? chev(open) : ''}</button><div class="tc-b" id="${domId(id)}-b" ${open && hasBody ? '' : 'hidden'}>${body}</div></div></li>`;
  }
  function textHtml(e, s) {
    const error = ['error', 'tool_error'].includes(e.kind), msg = e.kind === 'message', open = S.open.has(e.id);
    const long = msg ? String(e.text || '').split('\n').length > 8 : error && String(e.text || '').split('\n').length > 3;
    const content = msg ? md(e.text || '', S.jobs.get(s.key.split('/')[0])?.cwd) : esc(e.kind === 'intercept' ? `수정 지시: ${String(e.text || '').split('\n')[0]}` : e.text);
    const cls = error ? 'err' : msg ? 'msg' : e.kind === 'thinking' ? 'think' : e.kind;
    const ic = error ? 'alert' : msg ? 'chat' : e.kind === 'thinking' ? 'sparkle' : e.kind === 'intercept' ? 'steer' : 'bell';
    return `<li class="proc-i k-${cls}"><span class="pi-ic">${icon(ic)}</span><div class="pi-c"><div id="${domId(e.id)}-b" class="${msg ? 'md' : ''} ${long && !open ? 'pi-clamp' : ''}" ${msg || error ? `data-pi-line-limit="${error ? 3 : 8}" data-pi-open="${open}"` : ''} style="${error ? '--pi-lines:3' : ''}">${content}</div>${long || msg || error ? `<button type="button" class="tc-more" id="${domId(e.id)}-h" data-proc-text="${esc(e.id)}" aria-expanded="${open}" aria-controls="${domId(e.id)}-b" ${long ? '' : 'hidden'}>${open ? '접기' : '더 보기'}</button>` : ''}</div>${stamp(e, s)}</li>`;
  }
  function promptHtml(e, s) {
    const p = e.prompt, pend = p.status === 'pending', a = p.answer || {}, denied = ['deny', 'reject'].includes(a.action);
    const cls = pend ? 'warn' : denied ? 'err' : a.action === 'revise' ? 'run' : p.status === 'answered' ? 'ok' : 'muted';
    const key = `proc:${e.id}`, open = S.open.has(key), command = denied && p.detail?.command;
    const label = pend ? `${promptKind(p)} 대기` : `${denied || a.action === 'revise' || ['expired', 'cancelled'].includes(p.status) ? '' : promptKind(p) + ' · '}${promptAnswer(p)}`;
    return `<li class="proc-i k-prompt s-${esc(p.status)} c-${cls}"><span class="pi-ic">${icon(p.kind === 'question' ? 'help' : p.kind === 'plan' ? 'clipboard' : 'shieldq')}</span><div class="pi-c">${command ? `<button type="button" class="pi-prompt-h" id="${domId(e.id)}-h" data-proc-text="${esc(key)}" aria-expanded="${open}" aria-controls="${domId(e.id)}-b">${esc(label)} ${H.rowSummary(p)}${chev(open)}</button><div id="${domId(e.id)}-b" ${open ? '' : 'hidden'}><pre class="tc-cmd">${esc(command)}</pre></div>` : `${esc(label)} ${pend ? H.rowSummary(p) : ''}`}</div><span class="pi-pmeta">${pend ? `<span class="spin-xs"></span><button type="button" class="btn sm" data-pr-focus="${esc(p.id)}">답하기</button>` : `<span title="${esc(hm(p.answeredAt))}">${hm(p.answeredAt)}${p.viewer?.remote ? ' · 원격' : ''}</span>`}</span></li>`;
  }
  function rowsHtml(rows, s) {
    return rows.map((e) => {
      if (e.kind === 'tool') return toolHtml(e, s);
      if (e.kind === 'prompt') return promptHtml(e, s);
      if (!['group', 'warnings'].includes(e.kind)) return textHtml(e, s);
      const key = `proc:${e.id}`, open = openFor(key, e.status === 'running');
      return `<li class="proc-group ${open ? 'open' : ''} ${e.kind === 'warnings' ? 'c-warn' : ''}"><button type="button" class="pi-h" id="${domId(e.id)}-h" data-proc-toggle="${esc(key)}" aria-expanded="${open}" aria-controls="${domId(e.id)}-b"><span class="pi-ic">${icon(e.kind === 'warnings' ? 'alert' : 'eye')}</span><span class="pi-c">${esc(e.label)}</span><span class="tc-m ${e.status === 'error' ? 'err' : ''}">${e.status === 'running' ? '<span class="spinner"></span>' : e.kind === 'group' ? icon(e.status === 'error' ? 'alert' : 'check') : ''}${e.kind === 'group' ? duration(e.startedAt, e.endedAt, e.status === 'running', true) : ''}${chev(open)}</span></button><div id="${domId(e.id)}-b" ${open ? '' : 'hidden'}>${e.kind === 'group' ? `<ol class="proc-tl">${rowsHtml(e.items, s)}</ol>` : `<div class="proc-warnings">${e.items.map((w) => `<pre>${esc(w.text)}</pre>`).join('')}</div>`}</div></li>`;
    }).join('');
  }
  // 생각 한 덩어리(Claude·Codex 생각) 또는 중간 설명 한 단락. 길면 접어 두고 "더 보기"
  function thoughtHtml(b, s) {
    if (b.kind === 'prompt') return promptHtml(b, s);
    if (b.kind !== 'thought' && b.kind !== 'say') return textHtml(b, s);
    const open = S.open.has(b.id), say = b.kind === 'say', lines = say ? 8 : 6;
    const body = say ? md(b.text, S.jobs.get(s.key.split('/')[0])?.cwd) : b.parts.map((p) => `<p>${p.title ? `<b class="th-t">${inline(p.title)}</b>` : ''}${p.body ? `<span class="th-b">${inline(p.body)}</span>` : ''}</p>`).join('');
    return `<li class="pt ${say ? 'pt-say' : 'pt-think'}" title="${esc(hm(b.at))}"><div id="${domId(b.id)}-b" class="pt-c ${say ? 'md' : ''}" data-pi-line-limit="${lines}" data-pi-open="${open}" style="--pi-lines:${lines}">${body}</div><button type="button" class="tc-more" id="${domId(b.id)}-h" data-proc-text="${esc(b.id)}" aria-expanded="${open}" aria-controls="${domId(b.id)}-b" hidden>${open ? '접기' : '더 보기'}</button></li>`;
  }
  function thinkListHtml(s, hidden, shown) {
    const loading = !S.loadedLogs.has(s.key) && !S.logs.has(s.key), live = M.active(s.status);
    const did = [s.hiddenThoughts ? `영어 생각 ${s.hiddenThoughts}개` : '', s.counts.commands ? `명령 ${s.counts.commands}개` : '', s.counts.edits ? `수정 ${s.counts.edits}개` : ''].filter(Boolean).join(' · ');
    const empty = shown.length || live ? '' : `<li class="proc-empty">${loading ? '기록을 불러오는 중' : s.items.length ? `${s.hiddenThoughts ? '한국어로 ' : ''}남긴 생각이 없어요${did ? ` · ${did}는 작업 기록에서 볼 수 있어요` : ''}` : '기록이 없어요'}</li>`;
    const tail = live ? `<li class="pt pt-live"><span class="spinner"></span>${esc(s.thinkPreview?.activity || (s.waiting ? '답을 기다리는 중' : '생각하는 중'))}</li>` : '';
    return `${hidden ? `<button type="button" class="tc-more proc-previous" id="${domId(s.key)}-previous" data-proc-previous="${esc(s.key)}#th">이전 생각 ${hidden}개 보기</button>` : ''}<ol class="proc-th">${shown.map((b) => thoughtHtml(b, s)).join('')}${empty}${tail}${endHtml(s)}</ol>`;
  }
  function endHtml(s) {
    if (!M.terminal(s.status)) return '';
    const text = s.status === 'done' ? `완료 · ${M.elapsed(s.startedAt, s.finishedAt)}` : s.status === 'failed' ? `실패${s.error ? ' · ' + String(s.error).split('\n')[0] : ''}` : { cancelled: '여기서 중지됨', interrupted: '여기서 중단됨', skipped: '건너뜀' }[s.status];
    return `<li class="proc-i k-end s-${esc(s.status)}"><span class="pi-dot"></span><span class="pi-c">${esc(text)}</span></li>`;
  }
  const sectionOpen = (s, m, job) => !m.multi || openFor(`proc:${s.key}`, M.active(s.status) || s.waiting || s.status === 'failed' || s.counts.errors > 0 && M.active(job.status));
  const shownRows = (s) => M.groupItems(s.items.slice(-(limits.get(s.key) || 200)), s.key);
  function sectionHtml(s, model, job) {
    const key = `proc:${s.key}`, open = sectionOpen(s, model, job), detail = detailOn(job.id);
    const head = !model.multi ? '' : `<button type="button" class="proc-sec-h" id="${domId(s.key)}-h" data-proc-toggle="${esc(key)}" aria-expanded="${open}" aria-controls="${domId(s.key)}-b" aria-label="생각 과정 · ${esc(s.title)}">${stIcon(s.status)}${tag(s.assignee)}<span class="proc-title">${esc(s.title)}</span>${M.active(s.status) ? detail ? now(s.preview) : nowThink(s.thinkPreview) : `<span class="proc-sum">${detail ? summary(s.counts) : s.counts.thoughts ? `생각 ${s.counts.thoughts}` : ''}${detail || s.counts.thoughts ? ' · ' : ''}${duration(s.startedAt, s.finishedAt)}</span>`}${chev(open)}</button>`;
    let body;
    if (!detail) {
      const limit = limits.get(`${s.key}#th`) || 200, hidden = Math.max(0, s.thoughts.length - limit);
      body = thinkListHtml(s, hidden, s.thoughts.slice(hidden));
    } else {
      const limit = limits.get(s.key) || 200, hidden = Math.max(0, s.items.length - limit), shown = hidden ? M.groupItems(s.items.slice(hidden), s.key) : s.rows;
      const loading = !S.loadedLogs.has(s.key) && !S.logs.has(s.key);
      body = `${hidden ? `<button type="button" class="tc-more proc-previous" id="${domId(s.key)}-previous" data-proc-previous="${esc(s.key)}">이전 ${hidden}단계 보기</button>` : ''}<ol class="proc-tl">${s.items.length ? rowsHtml(shown, s) : `<li class="proc-empty">${loading ? '기록을 불러오는 중' : M.active(s.status) ? '시작하는 중' : '기록이 없어요'}</li>`}${endHtml(s)}</ol>`;
    }
    return `<section class="proc-sec ${open ? 'open' : ''}" data-proc-sec="${esc(s.key)}">${head}<div id="${domId(s.key)}-b" ${open ? '' : 'hidden'}>${body}</div></section>`;
  }
  window.hubJobProcess = (job) => {
    const m = modelFor(job); if (!m.visible) return '';
    const detail = detailOn(job.id), steps = detail ? m.counts.steps : m.counts.thoughts;
    const open = S.open.has(`proc:${job.id}`), previous = totals.get(job.id) ?? steps;
    const body = document.getElementById(`procb-${job.id}`), atBottom = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    if (body) scrolls.set(job.id, { top: body.scrollTop, bottom: atBottom });
    if (open && !atBottom && steps > previous) unread.set(job.id, (unread.get(job.id) || 0) + steps - previous);
    if (atBottom) unread.delete(job.id); totals.set(job.id, steps);
    const activeElement = document.activeElement;
    if (activeElement?.id && activeElement.closest('.proc')?.dataset.proc === job.id) focus.set(job.id, activeElement.id);
    const count = unread.get(job.id) || 0, all = allOpen(m, job), title = all ? '모두 접기' : '모두 펼치기';
    const meta = detail ? summary(m.counts, job.tasks.length) : job.tasks.length > 1 ? `작업 ${job.tasks.length}개` : '', elapsed = duration(job.startedAt || job.createdAt, job.finishedAt, M.active(job.status));
    const preview = m.waiting ? `<span class="proc-now c-warn">답을 기다리는 중${m.pending ? ' · ' + esc(promptKind(m.pending)) : ''}</span>` : !M.active(job.status) ? '' : detail ? now(m.preview, m.multi) : nowThink(m.thinkPreview, m.multi);
    const mode = `<button type="button" class="btn sm proc-mode" id="procmode-${esc(job.id)}" data-proc-mode="${esc(job.id)}" aria-pressed="${detail}" title="${detail ? '생각만 보기' : '명령·파일 수정까지 모두 보기'}">${detail ? '생각만' : '작업 기록'}</button>`;
    // 답하기와 전체 토글은 머리 버튼의 형제로 두어 중첩 버튼을 피한다
    return `<section class="proc s-${esc(m.status)} ${open ? 'open' : ''} ${detail ? 'detail' : 'think'}" id="proc-${esc(job.id)}" data-proc="${esc(job.id)}"><div class="proc-head"><button type="button" class="proc-h" id="proch-${esc(job.id)}" data-proc-toggle="proc:${esc(job.id)}" aria-expanded="${open}" aria-controls="procb-${esc(job.id)}" aria-label="생각 과정">${m.waiting ? `<span class="st c-warn">${icon('bell')}</span>` : stIcon(job.status)}<b>생각 과정</b><span class="proc-sum">${!m.sections.some((s) => s.items.length) && M.active(job.status) ? '시작하는 중' : `${meta}${meta ? ' · ' : ''}${['cancelled', 'interrupted'].includes(job.status) ? ST_KO[job.status] + ' · ' : ''}${elapsed}`}</span>${preview}${chev(open)}</button>${m.pending ? `<button type="button" class="btn sm" data-pr-focus="${esc(m.pending.id)}">답하기</button>` : ''}${open ? `${mode}<button type="button" class="icon-btn sm" id="procall-${esc(job.id)}" data-proc-all="${esc(job.id)}" title="${title}" aria-label="${title}">${icon('updown')}</button>` : ''}</div>${open ? `<div class="proc-body" id="procb-${esc(job.id)}" role="region" aria-label="생각 과정">${m.sections.map((s) => sectionHtml(s, m, job)).join('')}<button type="button" class="proc-new btn sm" data-proc-new="${esc(job.id)}" ${count ? '' : 'hidden'}>${detail ? '새 단계' : '새 생각'} ${count}개 ↓</button></div>` : ''}</section>`;
  };
  const longBlock = (b) => b.kind === 'thought' || b.kind === 'say';
  function allOpen(m, job) {
    if (!detailOn(job.id)) return m.sections.every((s) => sectionOpen(s, m, job) && s.thoughts.every((b) => !longBlock(b) || S.open.has(b.id)));
    return m.sections.every((s) => sectionOpen(s, m, job) && shownRows(s).every((r) => !['group', 'warnings'].includes(r.kind) || openFor(`proc:${r.id}`, r.status === 'running')) && s.items.every((e) => e.kind !== 'tool' || !e.callId || P.toolOpen.has(e.callId)));
  }
  function showTask(key) {
    const jobId = key.split('/')[0]; setOpen(`proc:${jobId}`, true); setOpen(`proc:${key}`, true); redraw(jobId);
    document.querySelector(`[data-proc-sec="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto][data-task]'); if (goto) return showTask(`${goto.dataset.goto}/${goto.dataset.task}`);
    const show = event.target.closest('[data-proc-show]'); if (show) return showTask(show.dataset.procShow);
    const proc = event.target.closest('.proc'); if (!proc) return;
    const jobId = proc.dataset.proc, b = event.target.closest('button'); if (!b || b.disabled) return;
    if (b.hasAttribute('data-proc-new')) { const body = proc.querySelector('.proc-body'); body.scrollTop = body.scrollHeight; unread.delete(jobId); b.hidden = true; return; }
    if (b.hasAttribute('data-proc-toggle')) {
      const open = b.getAttribute('aria-expanded') !== 'true';
      if (open && b.dataset.procToggle === `proc:${jobId}` && M.active(S.jobs.get(jobId)?.status)) scrolls.delete(jobId);
      setOpen(b.dataset.procToggle, open);
    }
    else if (b.hasAttribute('data-proc-tool')) P.toolOpen.has(b.dataset.procTool) ? P.toolOpen.delete(b.dataset.procTool) : P.toolOpen.add(b.dataset.procTool);
    else if (b.hasAttribute('data-proc-full')) P.toolFull.has(b.dataset.procFull) ? P.toolFull.delete(b.dataset.procFull) : P.toolFull.add(b.dataset.procFull);
    else if (b.hasAttribute('data-proc-text')) setOpen(b.dataset.procText, !S.open.has(b.dataset.procText));
    else if (b.hasAttribute('data-proc-previous')) { const key = b.dataset.procPrevious; limits.set(key, (limits.get(key) || 200) + 200); }
    else if (b.hasAttribute('data-proc-mode')) {
      // 생각만 ↔ 작업 기록. 단계 수 세는 기준이 바뀌므로 새 단계 알림은 새로 센다
      setOpen(`procdetail:${jobId}`, !detailOn(jobId)); totals.delete(jobId); unread.delete(jobId); scrolls.delete(jobId);
    } else if (b.hasAttribute('data-proc-all')) {
      const job = S.jobs.get(jobId), m = modelFor(job), open = !allOpen(m, job);
      if (!detailOn(jobId)) { for (const s of m.sections) { setOpen(`proc:${s.key}`, open); for (const t of s.thoughts) if (longBlock(t)) setOpen(t.id, open); } redraw(jobId, b.id); return; }
      for (const s of m.sections) { setOpen(`proc:${s.key}`, open); for (const r of [...s.rows, ...shownRows(s)]) if (['group', 'warnings'].includes(r.kind)) setOpen(`proc:${r.id}`, open); for (const e of s.items) if (e.callId) open ? P.toolOpen.add(e.callId) : P.toolOpen.delete(e.callId); }
    } else return;
    redraw(jobId, b.id);
  });
  $('#thread').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const proc = e.target.closest('.proc'); if (!proc) return;
    const card = e.target.closest('.tc-b')?.closest('.tc'), jobId = proc.dataset.proc;
    e.preventDefault(); e.stopPropagation();
    if (card) { const b = card.querySelector('[data-proc-tool]'); P.toolOpen.delete(b.dataset.procTool); redraw(jobId, b.id); }
    else { setOpen(`proc:${jobId}`, false); redraw(jobId, `proch-${jobId}`); }
  });
  // 긴 설명·오류만 "더 보기"를 보인다. 다시 그려진 항목도 매번 잰다 (처음 붙을 때 한 번만 재면 새 항목이 빠진다)
  function measureClamps() {
    document.querySelectorAll('.proc-body [data-pi-line-limit]:not([data-pi-measured])').forEach((content) => {
      if (!content.offsetParent) return; // 접혀 있어 높이를 잴 수 없으면 다음 기회에
      content.dataset.piMeasured = '1';
      const cs = getComputedStyle(content);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
      const open = content.dataset.piOpen === 'true', long = content.scrollHeight > lh * Number(content.dataset.piLineLimit) + 2;
      content.classList.toggle('pi-clamp', long && !open);
      if (content.nextElementSibling) content.nextElementSibling.hidden = !long && !open;
    });
  }
  function mount() {
    measureClamps();
    document.querySelectorAll('.proc-body').forEach((body) => {
      if (mounted.has(body)) return; mounted.add(body);
      const jobId = body.closest('.proc').dataset.proc, saved = scrolls.get(jobId);
      body.scrollTop = saved?.bottom === false ? saved.top : body.scrollHeight;
      if (focus.has(jobId)) { document.getElementById(focus.get(jobId))?.focus({ preventScroll: true }); focus.delete(jobId); }
      body.addEventListener('scroll', () => {
        const bottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
        scrolls.set(jobId, { top: body.scrollTop, bottom });
        if (bottom) { unread.delete(jobId); body.querySelector('.proc-new').hidden = true; }
      }, { passive: true });
    });
  }
  new MutationObserver(mount).observe($('#thread'), { childList: true, subtree: true });
  setInterval(() => document.querySelectorAll('.proc .live-dur').forEach((el) => { el.textContent = M.elapsed(el.dataset.from, new Date().toISOString(), el.hasAttribute('data-proc-precise')); }), 1000);
  mount();
})();
