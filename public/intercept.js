/* AI Hub — 실행 중 수정 지시(인터셉트)
   계약: workspace/intercept-contract.md — POST·GET /api/jobs/:id/intercepts, SSE "intercept", job.intercepts·canIntercept·activePhase,
   /api/status 의 capabilities.intercept. app.js · side.js · commands.js 다음에 읽힌다.
   접수(202/200)나 CLI 수신 확인만으로 "반영 완료"라고 쓰지 않는다. 실제 반영은 작업 결과에서 확인한다. */
'use strict';

const INT = {
  inflight: new Map(), // jobId → 보내는 중인 로컬 기록 (중복 클릭·Enter 방지)
  retry: new Map(),    // jobId → { sig, rid } 응답을 못 받은 같은 내용은 같은 clientRequestId 로 다시 보낸다
  drafts: new Map(),   // 세션 키 → { value, atts } 진행 중인 대화를 오가며 보관한 입력
  err: null,           // { sid, jobId, msg } 입력창 위에 보일 마지막 전송 실패
  seen: new Map(),     // intercept.id → 마지막으로 알린 상태 (aria-live 중복 방지)
  barHtml: '',
};
const IC_ST = {
  sending: { label: '접수 중…', icon: 'spin' },
  accepted: { label: '수정 지시 접수됨', icon: 'clock' },
  applying: { label: '현재 작업에 전달 중', icon: 'spin' },
  delivered: { label: '현재 작업에 전달됨', icon: 'check', cls: 'ok' },
  partial: { label: '일부 작업에 전달하지 못함', icon: 'alert', cls: 'warn' },
  failed: { label: '수정 지시 전달 실패', icon: 'alert', cls: 'err' },
  cancelled: { label: '중지로 전달 취소됨', icon: 'minus', cls: 'muted' },
};
const IC_RANK = { sending: 0, accepted: 1, applying: 2, delivered: 3, partial: 3, failed: 3, cancelled: 4 };
const DLV_KO = { recorded: '시작할 때 반영 예정', waiting: '전달 대기', sending: '전달 중', delivered: '전달됨', failed: '전달 실패', uncertain: '전달 여부 확인 불가', cancelled: '취소됨' };
const DLV_IC = { recorded: 'clock', waiting: 'clock', sending: 'clock', delivered: 'check', failed: 'alert', uncertain: 'alert', cancelled: 'minus' };
const DLV_MODE_KO = { prompt: '시작 프롬프트에 포함', 'native-steer': '실행 중인 턴에 지시 추가', 'native-interrupt': '현재 턴을 멈추고 이어서 지시', resume: '같은 CLI 세션을 재개해 지시' };
const PHASE_KO = { queued: '시작 전', plan: '계획 세우는 중', 'plan-question': '질문에 답을 기다리는 중', route: '모델 고르는 중', worker: '작업 실행 중', report: '보고서 쓰는 중', 'goal-check': '목표 달성 판정 중', 'goal-transition': '다음 목표 라운드 준비 중' };
const PHASE_WHO = { queued: '최초 계획', plan: '계획 담당', 'plan-question': '계획 담당', route: '모델 배정', report: '보고서 담당', 'goal-check': '목표 판정 담당', 'goal-transition': '다음 목표 라운드' };
const IC_ERR = {
  NETWORK: '허브에 연결하지 못해 보내지 못했어요. 입력은 그대로 있어요 — 다시 보내면 같은 지시로 처리돼 중복되지 않아요',
  INVALID_INTERCEPT: '수정 지시 형식이 올바르지 않아 접수되지 않았어요',
  JOB_NOT_FOUND: '작업을 찾지 못해 접수되지 않았어요. 입력은 그대로 있어요',
  SESSION_MISMATCH: '이 대화의 작업이 아니어서 보내지 않았어요. 입력은 그대로 있어요',
  JOB_NOT_ACTIVE: '작업이 이미 끝나서 수정 지시를 받지 않았어요. 입력은 그대로 있어요 — 다시 보내면 새 요청이 돼요',
  REQUEST_ID_CONFLICT: '같은 요청 번호로 다른 내용이 이미 접수돼 있어요. 다시 보내면 새 지시로 보내요',
  INTERCEPT_BACKLOG_FULL: '아직 전달되지 않은 수정 지시가 너무 많아요(20개). 앞의 지시가 전달된 뒤 다시 보내세요',
  INTERCEPT_PERSIST_FAILED: '허브가 수정 지시를 저장하지 못해 접수되지 않았어요. 다시 보내 주세요',
  HTTP_404: '이 허브는 아직 실행 중 수정 지시를 지원하지 않아요(서버 업데이트 필요). 입력은 그대로 있어요',
  HTTP_403: '원격 접속 권한이 없어 보내지 못했어요. 입력은 그대로 있어요',
  HTTP_413: '내용이 너무 커서 보내지 못했어요. 줄이거나 이미지를 빼고 다시 보내세요',
  BAD_RESPONSE: '허브 응답을 확인하지 못했어요. 접수 여부가 불확실해요 — 다시 보내도 같은 지시로 처리돼 중복되지 않아요',
};

/* ---------- 판단 ---------- */
/** 서버가 수정 지시를 지원하고, 이 작업이 지금 지시를 받는 구간인가 */
function icSupported(j) { return !!(j && Number(S.caps?.intercept) >= 1 && isActive(j) && j.canIntercept !== false); }
/** 지금 입력창이 수정 지시 모드인가 (commands.js 자동완성 끄기에 사용) */
function icMode() { const l = liveJob(); return !!(l && icSupported(l)); }
function icPhase(j) {
  if (j.activePhase) return j.activePhase;
  if (j.status === 'queued') return 'queued';
  if (j.status === 'planning') return j.phase === 'routing' ? 'route' : 'plan';
  if (j.status === 'reporting') return 'report';
  return j.status === 'running' ? 'worker' : null;
}
const titleOf = (sid) => (sid ? S.sessions.get(sid)?.title || '이전 대화' : '새 세션');
const icErrText = (e) => (!e ? '' : typeof e === 'string' ? e : e.message || e.code || JSON.stringify(e));
function icNewRid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- 목록 병합 (HTTP 응답·SSE·hello 어느 쪽이 먼저 와도 id 기준으로 새 정보만 반영) ---------- */
function icNewer(a, b) {
  const ta = Date.parse(a.updatedAt || a.acceptedAt || 0) || 0, tb = Date.parse(b.updatedAt || b.acceptedAt || 0) || 0;
  if (ta !== tb) return tb > ta;
  return (IC_RANK[b.status] ?? 0) >= (IC_RANK[a.status] ?? 0);
}
function icMergeList(oldL, newL) {
  const m = new Map();
  for (const x of oldL || []) if (x?.id) m.set(x.id, x);
  for (const x of newL || []) { if (!x?.id) continue; const o = m.get(x.id); if (!o || icNewer(o, x)) m.set(x.id, o ? { ...o, ...x } : x); }
  return [...m.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0) || String(a.acceptedAt || '').localeCompare(String(b.acceptedAt || '')));
}
function icMergeJob(prev, next) {
  if (!next) return;
  next.intercepts = icMergeList(prev?.intercepts, next.intercepts);
  if (prev) icNotice(next);
}
function onInterceptEvent(ev) {
  const j = S.jobs.get(ev.jobId); if (!j || !ev.intercept) return;
  j.intercepts = icMergeList(j.intercepts, [ev.intercept]);
  if (typeof ev.revision === 'number') j.instructionRevision = Math.max(j.instructionRevision || 0, ev.revision);
  icNotice(j);
  if (j.sessionId === S.current) { queueRerender(j.id); renderSend(); }
}

/* ---------- 상태 문구 ---------- */
function icCounts(it) {
  const c = { delivered: 0, recorded: 0, pending: 0, failed: 0, uncertain: 0, cancelled: 0 };
  for (const d of it.deliveries || []) { if (d.status === 'waiting' || d.status === 'sending') c.pending++; else if (d.status in c) c[d.status]++; }
  return c;
}
function icLabel(it) {
  const c = icCounts(it);
  if (it.status === 'accepted') return c.pending ? '전달 대기' : c.recorded ? '시작할 작업에 반영 예정' : '수정 지시 접수됨';
  if (c.delivered && c.cancelled && !c.failed && !c.uncertain && !c.pending && !c.recorded) return '일부 전달 후 중지됨';
  return IC_ST[it.status]?.label || it.status;
}
function icSummary(it) {
  const c = icCounts(it); const p = [];
  if (c.delivered) p.push(`${c.delivered}곳에 전달됨`);
  if (c.pending) p.push(`${c.pending}곳 전달 중`);
  if (c.recorded) p.push(`대기 작업 ${c.recorded}개에 반영 예정`);
  if (c.failed) p.push(`${c.failed}곳 전달 실패`);
  if (c.uncertain) p.push(`${c.uncertain}곳 확인 불가`);
  if (c.cancelled) p.push(`${c.cancelled}곳 취소`);
  return p.join(' · ');
}
function icAnnounce(msg) { const el = $('#icLive'); el.textContent = ''; setTimeout(() => (el.textContent = msg), 40); }
function icNotice(j) {
  if (j.sessionId !== S.current) return;
  for (const it of j.intercepts || []) {
    const k = `${it.status}|${icSummary(it)}`; const was = INT.seen.get(it.id); INT.seen.set(it.id, k);
    if (was !== undefined && was !== k) icAnnounce(`수정 지시 ${it.seq ? `#${it.seq} ` : ''}${icLabel(it)}${icSummary(it) ? ` — ${icSummary(it)}` : ''}`);
  }
}

/* ---------- 작업 카드 안 기록 ---------- */
function icList(j) {
  const list = [...(j.intercepts || [])];
  const local = INT.inflight.get(j.id);
  if (local && !list.some((x) => x.clientRequestId === local.clientRequestId)) list.push(local);
  return list;
}
function icHtml(j) {
  const list = icList(j); if (!list.length) return '';
  return `<div class="ics" role="list" aria-label="수정 지시 ${list.length}개">${list.map((it) => icItemHtml(j, it)).join('')}</div>`;
}
function icWho(j, d) {
  const t = d.taskId ? j.tasks.find((x) => x.id === d.taskId) : null;
  if (t) return `<span class="prov ${t.assignee}">${t.assignee === 'claude' ? 'Claude' : 'Codex'}</span><span class="who" title="${esc(t.title)}">${esc(t.title)}</span>`;
  return `<span class="who">${esc(PHASE_WHO[d.phase] || d.taskId || d.phase || '대상')}</span>`;
}
function icItemHtml(j, it) {
  const meta = IC_ST[it.status] || { label: it.status, icon: 'info' };
  const stIco = meta.icon === 'spin' ? '<span class="spinner"></span>' : icon(meta.icon);
  const key = `ic:${it.id}`; const open = S.open.has(key);
  const dl = it.deliveries || []; const sum = icSummary(it);
  const tip = it.status === 'delivered' ? 'AI가 지시를 받았어요. 실제로 반영됐는지는 작업 기록과 결과에서 확인하세요' : it.status === 'accepted' ? '허브가 저장했어요. 아직 AI에게 전달된 것은 아니에요' : '';
  let h = `<div class="ic s-${esc(it.status)}" role="listitem" data-ic-id="${esc(it.id)}">`;
  h += `<div class="ic-h"><span class="ic-ic">${icon('steer')}</span><b>수정 지시${it.seq ? ` #${it.seq}` : ''}</b><span class="ic-st ${meta.cls || ''}"${tip ? ` title="${esc(tip)}"` : ''}>${stIco}<span>${esc(icLabel(it))}</span></span><span class="grow"></span>${it.acceptedAt ? `<time datetime="${esc(it.acceptedAt)}">${hm(it.acceptedAt)}</time>` : ''}</div>`;
  if (it.attachments?.length) h += `<div class="ic-thumbs">${it.attachments.map((a) => `<a href="/uploads/${esc(a.id)}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="/uploads/${esc(a.id)}" alt="${esc(a.name || '첨부 이미지')}"></a>`).join('')}</div>`;
  if (it.text) h += `<div class="ic-text">${esc(it.text)}</div>`;
  if (sum || dl.length) h += `<div class="ic-foot"><span>${esc(sum || '전달 대상 확인 중')}</span>${dl.length ? `<button type="button" class="ic-more" data-ic-toggle="${esc(it.id)}" aria-expanded="${open}">${open ? '대상 접기' : `대상 ${dl.length}곳 보기`}${icon(open ? 'down' : 'right')}</button>` : ''}</div>`;
  if (it.error) h += `<div class="ic-err">${icon('alert')}<span>${esc(icErrText(it.error))}</span></div>`;
  if (open && dl.length) h += `<ul class="ic-dl">${dl.map((d) => `<li class="d-${esc(d.status)}"><span class="d-ic">${icon(DLV_IC[d.status] || 'info')}</span>${icWho(j, d)}<span class="dst">${esc(DLV_KO[d.status] || d.status)}${d.mode ? ` · ${esc(DLV_MODE_KO[d.mode] || d.mode)}` : ''}</span>${d.error ? `<span class="derr">${esc(icErrText(d.error))}</span>` : ''}</li>`).join('')}</ul>`;
  return h + '</div>';
}

/* ---------- 입력창 (renderSend 가 부른다) ---------- */
const IC_PH = input.placeholder, IC_HINT = $('#hint').textContent;
function renderIcComposer(live, has) {
  const sup = !!(live && icSupported(live));
  const err = INT.err && INT.err.sid === S.current ? INT.err : null;
  if (INT.mode !== sup) { INT.mode = sup; if (sup && S.pop?.kind === 'slash') closePop(); renderCmdHint(); } // 커맨드 설명 줄도 모드에 맞춰 다시
  $('#composer').classList.toggle('ic-mode', sup);
  input.placeholder = sup ? '진행 중인 작업에 수정 지시를 보내세요' : IC_PH;
  $('#hint').textContent = sup ? 'Enter 수정 지시 · Shift+Enter 줄바꿈' : IC_HINT;
  for (const p of ['#pMode', '#pClaude', '#pCodex']) $(p).classList.toggle('ic-off', sup);
  // 입력이 있으면 전송 버튼이 "수정 지시 보내기"가 되므로 중지는 옆 버튼으로 계속 쓸 수 있게
  const stop = $('#btnStop'); stop.hidden = !(sup && has); if (live) stop.dataset.job = live.id;

  let h = '', cls = '';
  if (sup) {
    const ph = icPhase(live); const run = live.tasks.filter((t) => t.status === 'running').length; const wait = live.tasks.filter((t) => t.status === 'pending').length;
    const parts = [PHASE_KO[ph] || '진행 중', run ? `실행 중 ${run}개` : '', wait ? `대기 ${wait}개` : ''].filter(Boolean).join(' · ');
    h = `<div class="icb-main">${icon('steer')}<b>수정 지시 모드</b><span class="icb-target">적용 대상: <em>${esc(titleOf(live.sessionId))}</em>의 진행 중 작업 · ${esc(parts)}</span></div>
      <div class="icb-sub">보내면 새 요청이 아니라 현재 작업과 대기 중인 작업에 이어서 전달해요<span class="icb-more"> · 모델·분배 설정은 그대로예요</span></div>`;
    cls = 'on';
  } else if (live && has) {
    const why = Number(S.caps?.intercept) >= 1 ? '작업을 마무리하는 중이라 지금은 수정 지시를 받을 수 없어요' : '이 허브는 아직 실행 중 수정 지시를 지원하지 않아요(서버 업데이트 필요)';
    h = `<div class="icb-main">${icon('alert')}<span class="icb-target">${why}. 입력은 그대로 두고, 작업이 끝나면 새 요청으로 보낼 수 있어요</span></div>`;
    cls = 'warn';
  }
  if (err) { h += `<div class="icb-err">${icon('alert')}<span>${esc(err.msg)}</span><button type="button" class="icon-btn" data-ic-dismiss title="알림 닫기" aria-label="알림 닫기">${icon('x')}</button></div>`; cls ||= 'err-only'; }
  const bar = $('#icBar'); const sig = `${cls}|${h}`;
  if (sig !== INT.barHtml) { INT.barHtml = sig; bar.innerHTML = h; bar.className = cls; bar.hidden = !h; }
  if (h) input.setAttribute('aria-describedby', 'icBar'); else input.removeAttribute('aria-describedby');
}
$('#icBar').addEventListener('click', (e) => { if (e.target.closest('[data-ic-dismiss]')) { INT.err = null; renderSend(); input.focus(); } });
$('#btnStop').innerHTML = icon('stop');
$('#btnStop').addEventListener('click', () => { const id = $('#btnStop').dataset.job; if (id) stopJob(id); });

/* ---------- 보내기 ---------- */
function icRerender(sid, jobId) { if (S.current !== sid) return; if (document.getElementById(`job-${jobId}`)) rerenderJob(jobId); else renderThread(); }
// 오류는 입력창 위 안내 줄에 남긴다. 그 사이 다른 대화로 옮겼으면 토스트로도 알린다
function icFail(sid, jobId, msg) { INT.err = { sid, jobId, msg }; if (S.current !== sid) toast(`‘${titleOf(sid)}’ — ${msg}`, true); icAnnounce(msg); renderSend(); }
async function icSubmit(job) {
  const sid = job.sessionId, jobId = job.id; // 보내기 직전에 대상 대화·작업을 고정한다
  if (!icSupported(job)) { const m = Number(S.caps?.intercept) >= 1 ? '작업을 마무리하는 중이라 지금은 수정 지시를 받을 수 없어요. 입력은 그대로 있어요' : IC_ERR.HTTP_404; toast(m, true); return; }
  if (INT.inflight.has(jobId)) return;
  if (S.atts.some((a) => a.state === 'up')) return toast('이미지 업로드가 끝나면 보낼 수 있어요');
  if (S.atts.some((a) => a.state === 'bad')) return icFail(sid, jobId, '올리지 못한 이미지가 있어요. 그 이미지를 빼고 다시 보내세요');
  const raw = input.value, text = raw.trim(); const atts = S.atts.filter((a) => a.state === 'ok');
  if (!text && !atts.length) return;
  if (text.length > 20000) return icFail(sid, jobId, `수정 지시는 20,000자까지 보낼 수 있어요 (지금 ${text.length.toLocaleString()}자)`);
  if (atts.length > 4) return icFail(sid, jobId, '수정 지시에는 이미지를 4장까지 붙일 수 있어요');
  const attachments = atts.map((a) => ({ id: a.id, name: a.name }));
  const sig = JSON.stringify([text, attachments.map((a) => a.id)]);
  const prev = INT.retry.get(jobId); const rid = prev?.sig === sig ? prev.rid : icNewRid();
  INT.retry.set(jobId, { sig, rid });
  INT.err = null;
  INT.inflight.set(jobId, { id: `local-${rid}`, clientRequestId: rid, text, attachments, status: 'sending', acceptedAt: new Date().toISOString(), deliveries: [], local: true });
  pendingSave({ sid, jobId, rid, text, attachments });
  icRerender(sid, jobId); renderSend();
  icAnnounce('수정 지시를 보내는 중이에요');
  try {
    let r;
    try { r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/intercepts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, clientRequestId: rid, text, attachments }) }); }
    catch { throw Object.assign(new Error('network'), { code: 'NETWORK' }); }
    const body = await r.json().catch(() => ({}));
    if ((r.status !== 200 && r.status !== 202) || !body.intercept) throw Object.assign(new Error(body.error || r.statusText), { code: body.code || (r.ok ? 'BAD_RESPONSE' : `HTTP_${r.status}`), status: r.status });
    // 접수됨: 수정 지시 목록만 병합한다. 응답보다 새 SSE job 이 먼저 왔을 수 있어 작업 전체는 덮어쓰지 않는다
    const cur = S.jobs.get(jobId);
    if (cur) { cur.intercepts = icMergeList(cur.intercepts, [...(body.job?.id === jobId ? body.job.intercepts || [] : []), body.intercept]); cur.instructionRevision = Math.max(cur.instructionRevision || 0, body.job?.instructionRevision || 0, body.intercept.revision || 0); }
    else if (body.job?.id === jobId) { body.job.intercepts = icMergeList(body.job.intercepts, [body.intercept]); S.jobs.set(jobId, body.job); }
    INT.seen.set(body.intercept.id, `${body.intercept.status}|${icSummary(body.intercept)}`);
    INT.retry.delete(jobId); pendingDrop(rid);
    icClearSent(sid, raw, attachments.map((a) => a.id));
    if (text) { S.history.push(text); S.histIdx = -1; }
    const what = `수정 지시${body.intercept.seq ? ` #${body.intercept.seq}` : ''}`;
    icAnnounce(`${what} ${body.duplicate ? '이미 접수돼 있어요' : '접수됨'} — ${icLabel(body.intercept)}`);
    if (S.current !== sid) toast(`‘${titleOf(sid)}’ 대화에 ${what}를 접수했어요`);
  } catch (e) {
    const code = e.code || 'UNKNOWN';
    const msg = IC_ERR[code] || `보내지 못했어요${e.status ? ` (${e.status})` : ''}${e.message ? ` — ${e.message}` : ''}. 입력은 그대로 있어요`;
    if (code === 'REQUEST_ID_CONFLICT') INT.retry.delete(jobId);
    if (['JOB_NOT_ACTIVE', 'JOB_NOT_FOUND', 'SESSION_MISMATCH', 'INVALID_INTERCEPT', 'REQUEST_ID_CONFLICT', 'HTTP_413'].includes(code)) pendingDrop(rid);
    if (code === 'JOB_NOT_ACTIVE') api(`/api/sessions/${sid}/jobs`).then((list) => { for (const x of list) { icMergeJob(S.jobs.get(x.id), x); S.jobs.set(x.id, x); } if (S.current === sid) renderThread(); }).catch(() => {});
    icFail(sid, jobId, msg);
  } finally {
    INT.inflight.delete(jobId);
    icRerender(sid, jobId); renderSend();
  }
}
/** 접수된 내용만 그 대화의 입력에서 뺀다. 보내는 동안 덧붙인 글·새 첨부는 남긴다 */
function icClearSent(sid, raw, ids) {
  const here = S.current === sid;
  const d = here ? { value: input.value, atts: S.atts } : INT.drafts.get(sid);
  if (!d) return;
  let v = d.value, kept = false;
  if (v.trim() === raw.trim()) v = '';
  else if (v.startsWith(raw)) v = v.slice(raw.length).replace(/^\s+/, '');
  else if (v.trim()) kept = true;
  const atts = d.atts.filter((a) => !ids.includes(a.id));
  if (here) { input.value = v; autosize(); S.atts = atts; renderAtts(); }
  else if (!v.trim() && !atts.length) INT.drafts.delete(sid);
  else INT.drafts.set(sid, { value: v, atts });
  if (kept) toast('보내는 동안 입력이 바뀌어서 입력창은 그대로 두었어요');
}

/* ---------- 대화 전환: 진행 중인 대화의 입력이 다른 대화로 넘어가 실수로 보내지지 않게 ---------- */
function icStash(from, to) {
  if (!input.value.trim() && !S.atts.length) return;
  if (!(from && liveJob(from)) && !(to && liveJob(to))) return; // 둘 다 유휴면 예전처럼 입력을 그대로 들고 간다
  INT.drafts.set(from || 'draft', { value: input.value, atts: S.atts });
  input.value = ''; S.atts = []; autosize(); renderAtts();
  toast(`입력 중이던 내용은 ‘${titleOf(from)}’ 대화에 보관했어요. 돌아가면 다시 보여요`);
}
function icRestore() {
  const k = S.current || 'draft'; const d = INT.drafts.get(k);
  if (!d || input.value.trim() || S.atts.length) return;
  INT.drafts.delete(k); input.value = d.value; S.atts = d.atts; autosize(); renderAtts();
}
const _icOpenSession = openSession, _icNewSession = newSession;
openSession = async function (id) { if (id !== S.current) icStash(S.current, id); await _icOpenSession(id); icRestore(); renderSend(); };
newSession = function (cwd) { icStash(S.current, null); _icNewSession(cwd); icRestore(); renderSend(); };

/* ---------- 새로고침 복구: 응답을 못 받은 채 새로고침하면 접수 여부를 확인하고 아니면 원문을 되돌린다 ---------- */
const IC_PKEY = 'hub.icPending';
function pendingAll() { try { return JSON.parse(sessionStorage.getItem(IC_PKEY) || '[]'); } catch { return []; } }
function pendingPut(list) { try { list.length ? sessionStorage.setItem(IC_PKEY, JSON.stringify(list.slice(-10))) : sessionStorage.removeItem(IC_PKEY); } catch {} }
function pendingSave(p) { pendingPut([...pendingAll().filter((x) => x.rid !== p.rid && x.jobId !== p.jobId), p]); }
function pendingDrop(rid) { pendingPut(pendingAll().filter((x) => x.rid !== rid)); }
async function icRecover() {
  for (const p of pendingAll()) {
    let accepted = null;
    try { const r = await fetch(`/api/jobs/${encodeURIComponent(p.jobId)}/intercepts`, { cache: 'no-store' }); if (r.ok) accepted = ((await r.json()).intercepts || []).some((x) => x.clientRequestId === p.rid); } catch {}
    pendingDrop(p.rid);
    if (accepted) continue;
    const atts = (p.attachments || []).map((a) => ({ key: Math.random().toString(36).slice(2), id: a.id, name: a.name, url: `/uploads/${a.id}`, state: 'ok' }));
    INT.retry.set(p.jobId, { sig: JSON.stringify([p.text, atts.map((a) => a.id)]), rid: p.rid });
    INT.err = { sid: p.sid, jobId: p.jobId, msg: accepted === false ? '새로고침 전에 보내던 수정 지시가 접수되지 않아 입력창에 되돌렸어요' : '새로고침 전에 보내던 수정 지시의 접수 여부를 확인하지 못해 입력창에 되돌렸어요. 다시 보내도 같은 지시로 처리돼 중복되지 않아요' };
    // 초기 SSE hello보다 복구 GET 응답이 먼저 올 수 있으므로 대상 상태를 직접 확인한다.
    const target = S.jobs.get(p.jobId) || await api(`/api/jobs/${encodeURIComponent(p.jobId)}`).catch(() => null);
    if (target && !icSupported(target)) INT.err.msg += '. 이 작업은 종료·중단되어 수정 지시를 받을 수 없어요. 그대로 보내면 새 요청이 돼요. 이어서 하려면 작업 카드의 다시를 쓰세요';
    if (S.current === p.sid && !input.value.trim() && !S.atts.length) { input.value = p.text; S.atts = atts; autosize(); renderAtts(); }
    else INT.drafts.set(p.sid, { value: p.text, atts });
  }
  renderSend();
}
