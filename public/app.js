/* AI Hub — 데스크탑 앱 스타일 대시보드 (프레임워크 없음) */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const ST_KO = { queued: '대기 중', planning: '계획 세우는 중', running: '작업 중', reporting: '보고서 쓰는 중', done: '완료', partial: '일부 완료', failed: '실패', cancelled: '중지됨', interrupted: '중단됨', pending: '대기', skipped: '건너뜀' };
const MODES = {
  auto: { label: '자동 분배', desc: '계획을 세워 Claude와 Codex에 나눠 맡기고 보고서로 정리' },
  claude: { label: 'Claude만', desc: 'Claude Code 혼자 처리' },
  codex: { label: 'Codex만', desc: 'Codex 혼자 처리' },
  both: { label: '둘 다 비교', desc: '같은 요청을 둘 다 수행해서 결과 비교' },
};
const EFFORT_KO = { low: '빠르게', medium: '균형', high: '꼼꼼히', xhigh: '아주 꼼꼼히', max: '최대', ultra: '최대+' };

/* ---------- 아이콘 (lucide 스타일) ---------- */
const IC = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  reuse: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  split: '<path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M12 22v-8"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  newchat: '<path d="M12 20h9"/><path d="M16.4 3.6a2 2 0 0 1 2.9 2.9L8 17.8l-4 1 1-4z"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8V6h6v4.8l2.5 3.2H6.5z"/><path d="M8 3h8"/>',
  pinoff: '<path d="M12 17v5M8 3h8M9 6v4.8L6.5 14H14M15 6v3"/><path d="m3 3 18 18"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  updown: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  panelR: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  gauge: '<path d="M12 14 16 10"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
  slash: '<path d="M15 4 9 20"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 17h5"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  steer: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
};
const icon = (n) => `<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[n] || ''}</svg></span>`;
function paintIcons(root = document) { root.querySelectorAll('[data-i]').forEach((el) => { if (!el.firstChild) el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[el.dataset.i] || ''}</svg>`; }); }

/* ---------- 상태 ---------- */
const S = {
  sessions: new Map(), jobs: new Map(), logs: new Map(), loadedLogs: new Set(), open: new Set(),
  current: null, draftCwd: null,
  options: null, usage: null, tools: null, projects: [],
  atts: [], notes: new Map(), collapsedFolders: new Set(), cfg: null,
  pop: null, history: [], histIdx: -1,
  prefs: loadPrefs(),
};
function loadPrefs() { let p = {}; try { p = JSON.parse(localStorage.getItem('hub.prefs') || '{}'); } catch {} return { mode: 'auto', planner: 'auto', claude: null, codex: null, cwd: null, collapsed: false, ...p }; }
function savePrefs() { try { localStorage.setItem('hub.prefs', JSON.stringify(S.prefs)); } catch {} }
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }

/* ---------- 포맷 ---------- */
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
function dur(a, b) { if (!a) return ''; const s = Math.max(0, ((b ? new Date(b) : new Date()) - new Date(a)) / 1000) | 0; return s < 60 ? `${s}초` : s < 3600 ? `${(s / 60) | 0}분 ${s % 60}초` : `${(s / 3600) | 0}시간 ${((s % 3600) / 60) | 0}분`; }
function ago(iso) { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return '방금'; if (s < 3600) return `${(s / 60) | 0}분`; if (s < 86400) return `${(s / 3600) | 0}시간`; return `${(s / 86400) | 0}일`; }
function shortPath(p, n = 2) { const parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts.length > n ? parts.slice(-n).join('\\') : p; }
function cmdLabel(c) { return c.kind === 'goal' ? '목표' : c.kind === 'agent' ? `@${c.name}` : c.kind === 'skill' ? `스킬 ${c.name}` : `/${c.name}`; }
// 초기화까지 남은 시간: 43분 · 2시간 59분 · 4일 15시간 (이미 지났으면 '곧')
function resetIn(iso) {
  if (!iso) return '';
  const m = Math.round((new Date(iso) - Date.now()) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m <= 0) return '곧';
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간${m % 60 ? ` ${m % 60}분` : ''}`;
  return `${Math.floor(h / 24)}일${h % 24 ? ` ${h % 24}시간` : ''}`;
}
// "2시간 59분 뒤 초기화 (오늘 04:10)"
function resetPhrase(iso) { const t = resetIn(iso); if (!t) return ''; return `${t === '곧' ? '곧' : `${t} 뒤`} 초기화 (${resetText(iso)})`; }
function resetText(iso) { if (!iso) return ''; const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? `오늘 ${hm(iso)}` : `${d.getMonth() + 1}/${d.getDate()} ${hm(iso)}`; }

/* ---------- 모델·강도 ---------- */
function toolPref(tool) { const d = S.options?.[tool]?.defaults || { model: '', effort: '' }; return { ...d, ...(S.prefs[tool] || {}) }; }
function modelName(tool, s) {
  const o = S.options?.[tool]; if (!o) return '…';
  if (s.model === 'auto') return '자동';
  const id = s.model || o.cliDefault.model || '기본';
  return o.models.find((m) => m.id === id)?.label || id;
}
function effortName(tool, s) { if (s.effort === 'auto') return '자동'; const o = S.options?.[tool]; const e = s.effort || o?.cliDefault.effort || ''; return e || '기본'; }
function prefLabel(tool, s) { return s.model === 'auto' && s.effort === 'auto' ? '자동' : `${modelName(tool, s)} · ${effortName(tool, s)}`; }
function codexEfforts(model) { const o = S.options?.codex; if (!o) return []; const m = o.models.find((x) => x.id === (model || o.cliDefault.model)); return m?.efforts?.length ? m.efforts : o.efforts; }

/* ================= 상단 ================= */
function currentCwd() { const s = S.sessions.get(S.current); return s ? s.cwd : (S.draftCwd || S.prefs.cwd || S.projects[0]?.path || ''); }
function sessionJobs(sid) { return [...S.jobs.values()].filter((j) => j.sessionId === sid).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
// 진행 중 = 실행 상태이거나, 목표 판정·라운드 전환처럼 서버가 수정 지시를 받는 구간(canIntercept)
const isActive = (j) => LIVE.has(j.status) || j.canIntercept === true;
function liveJob(sid = S.current) { return sid ? sessionJobs(sid).filter(isActive).at(-1) || null : null; }
function renderTop() {
  const s = S.sessions.get(S.current);
  $('#title').textContent = s ? s.title : '새 세션';
  $('#folderText').textContent = shortPath(currentCwd(), 3);
  $('#folderChip').title = `${currentCwd()}\n${s ? '눌러서 탐색기로 열기 · 오른쪽 클릭으로 경로 복사' : '눌러서 폴더 바꾸기'}`;
  // 확장: 기능 파일이 window.hubTopExtras.push((session|null) => html)로 상단 바에 칩을 더한다 (세션이 없으면 null)
  $('#topActions').innerHTML = (window.hubTopExtras || []).map((f) => { try { return f(s || null) || ''; } catch { return ''; } }).join('') + (s ? `${s.pinned ? `<span class="pin-flag" title="고정된 세션">${icon('pin')}</span>` : ''}<button class="icon-btn" id="btnSessMenu" title="세션 메뉴">${icon('more')}</button>` : '');
  renderSend();
}
$('#topActions').addEventListener('click', (e) => { const b = e.target.closest('#btnSessMenu'); if (b && S.current) openSessionMenu(S.current, b); });
$('#folderChip').addEventListener('click', (e) => { if (S.current) openPath(currentCwd()); else openFolderPicker(e.currentTarget); });
$('#folderChip').addEventListener('contextmenu', (e) => { e.preventDefault(); navigator.clipboard?.writeText(currentCwd()); toast('폴더 경로를 복사했어요'); });

/* ================= 대화 영역 ================= */
function renderThread() {
  renderTop();
  const sid = S.current; const box = $('#thread');
  const jobs = sid ? sessionJobs(sid) : [];
  $('#main').classList.toggle('empty', !jobs.length);
  let h = '';
  if (!jobs.length) h += heroHtml();
  for (const j of jobs) h += `<div class="turn" id="job-${j.id}">${jobHtml(j)}</div>`;
  h += `<div id="notes">${(S.notes.get(sid || 'draft') || []).join('')}</div>`;
  box.innerHTML = h;
  mountPreviews(box);
  for (const j of jobs) ensureLogs(j);
  const sc = $('#scroll'); sc.scrollTop = sc.scrollHeight;
  scheduleInspector();
}
function heroHtml() {
  const t = S.tools;
  const tag = (n, label) => !t ? '' : t[n]?.ok ? `<span class="ai-tag"><i style="background:var(--${n})"></i>${label} 준비됨</span>` : `<span class="ai-tag bad"><i style="background:var(--err)"></i>${label} 사용 불가 · ${esc(t[n]?.fix || '')}</span>`;
  const sug = [
    ['분석', '이 폴더의 구조를 파악하고 개선할 점 5가지를 정리해줘'],
    ['버그 수정', '테스트를 돌려서 실패하는 것을 찾아 고치고, 다시 통과하는지 확인해줘'],
    ['문서', 'README를 지금 코드에 맞게 한국어로 새로 써줘'],
    ['비교', '같은 기능을 Claude와 Codex가 각각 구현하게 해서 비교해줘'],
  ];
  return `<div class="hero"><span class="mark"><i></i><i></i></span><h2>무엇을 할까요?</h2><p>요청을 보내면 Claude와 Codex가 나눠서 처리하고 결과를 보고해요</p><div class="ais">${tag('claude', 'Claude Code')}${tag('codex', 'Codex')}</div></div>
    <div class="sugg">${sug.map(([b, s]) => `<button data-sugg="${esc(s)}"><b>${b}</b>${esc(s)}</button>`).join('')}</div>`;
}

function stIcon(status) {
  if (['running', 'planning', 'reporting', 'queued'].includes(status)) return '<span class="st"><span class="spinner"></span></span>';
  if (status === 'done') return `<span class="st c-ok">${icon('check')}</span>`;
  if (status === 'failed') return `<span class="st c-err">${icon('alert')}</span>`;
  if (status === 'partial') return `<span class="st c-warn">${icon('alert')}</span>`;
  if (['cancelled', 'interrupted', 'skipped'].includes(status)) return `<span class="st c-muted">${icon('minus')}</span>`;
  return '<span class="st wait"><i></i></span>';
}

function jobHtml(j) {
  const live = LIVE.has(j.status);
  const set = j.settings || {};
  const uses = j.mode === 'auto' ? ['claude', 'codex'] : j.mode === 'both' ? ['claude', 'codex'] : [j.mode];
  // 사용자 메시지
  let h = `<div class="user">${j.attachments?.length ? `<div class="thumbs">${j.attachments.map((a) => `<a href="/uploads/${esc(a.id)}" target="_blank" title="${esc(a.name)}"><img src="/uploads/${esc(a.id)}" alt="${esc(a.name)}"></a>`).join('')}</div>` : ''}${j.command ? `<span class="cmd-chip k-${j.command.kind}">${icon(j.command.kind === 'goal' ? 'target' : j.command.kind === 'agent' ? 'bot' : j.command.kind === 'skill' ? 'sparkle' : 'slash')}${esc(cmdLabel(j.command))}</span>` : ''}<div class="bubble">${esc(j.input || j.goal)}</div><div class="umeta">${j.goalRound ? `목표 ${j.goalRound}라운드 · ` : ''}${hm(j.createdAt)}</div></div>`;
  // AI 응답 카드
  h += `<div class="ai"><div class="avatar"><span class="mark"><i></i><i></i></span></div><div class="ai-body">`;
  h += `<div class="chips"><span class="tag">${icon('split')}${MODES[j.mode]?.label || j.mode}</span>${uses.map((n) => `<span class="tag ${n}">${n === 'claude' ? 'Claude' : 'Codex'} · ${esc(prefLabel(n, set[n] || {}))}</span>`).join('')}${j.agent ? `<span class="tag">${icon('bot')}@${esc(j.agent)} ${esc(agentLabel(j.agent))}</span>` : ''}</div>${(j.notes || []).length ? `<div class="auto-notes">${j.notes.map((n) => `<div>${icon('scale')}<span>${esc(n)}</span></div>`).join('')}</div>` : ''}`;

  if (j.mode === 'auto') {
    if (j.status === 'planning' || (j.status === 'queued')) {
      h += `<div class="working"><span class="spinner"></span><span>계획을 세우는 중${j.planner ? '' : ''} · <span class="live-dur" data-from="${j.startedAt || j.createdAt}"></span></span></div>`;
    } else if (j.summary) {
      h += `<div class="plan"><div class="lbl">${icon(j.fast ? 'bolt' : 'sparkle')}${j.fast ? '바로 처리' : '계획'}${j.planner ? ` · ${j.planner === 'claude' ? 'Claude' : 'Codex'}가 세움` : ''}</div>${esc(j.summary)}</div>`;
    }
  } else if (j.status === 'planning' && j.phase === 'routing') {
    h += `<div class="working"><span class="spinner"></span><span>요청에 맞는 모델과 강도를 고르는 중 · <span class="live-dur" data-from="${j.startedAt || j.createdAt}"></span></span></div>`;
  } else if (j.mode === 'both' && j.summary) {
    h += `<div class="plan">${esc(j.summary)}</div>`;
  }

  if (j.tasks.length) {
    h += `<div class="tasks">${j.tasks.map((t) => taskHtml(j, t)).join('')}</div>`;
  }
  h += window.hubJobProcess?.(j) || '';
  h += icHtml(j);

  if (j.status === 'reporting') h += `<div class="working"><span class="spinner"></span><span>결과를 모아 보고서를 쓰는 중</span></div>`;
  const showReport = j.mode === 'auto' || j.tasks.length === 1;
  if (j.report && !live && showReport) {
    h += `<div class="report">${j.tasks.length > 1 ? `<div class="report-h">${icon('board')}보고</div>` : ''}<div class="md">${md(j.report, j.cwd)}</div></div>`;
  }
  if (previewsFor(j).length) h += `<div class="pv-slot" data-pv-job="${esc(j.id)}"></div>`;
  // 확장: 기능 파일이 window.hubJobExtras.push((job) => html)로 작업 카드 끝에 내용을 더한다
  for (const f of window.hubJobExtras || []) { try { h += f(j) || ''; } catch {} }
  if (j.error) h += `<div class="jerr">${esc(j.error)}</div>`;

  // 꼬리
  const retry = j.tasks.filter((t) => ['failed', 'cancelled', 'interrupted', 'skipped'].includes(t.status) && !live);
  const cost = j.tasks.reduce((a, t) => a + (t.costUsd || 0), 0);
  const stateCls = j.status === 'done' ? 'c-ok' : j.status === 'failed' ? 'c-err' : live ? '' : 'c-warn';
  h += `<div class="afoot">${live ? `<span class="state"><span class="spinner"></span>${ST_KO[j.status]} · <span class="live-dur" data-from="${j.startedAt || j.createdAt}"></span></span><button class="btn danger" data-cancel="${j.id}">${icon('stop')}중지</button>`
    : `<span class="state ${stateCls}">${j.status === 'done' ? icon('check') : icon('alert')}${ST_KO[j.status] || j.status}</span><span class="sep">·</span><span>${dur(j.startedAt || j.createdAt, j.finishedAt)}</span>${cost ? `<span class="sep">·</span><span title="구독 로그인이라 실제 과금 아님 (API 환산)">≈ $${cost.toFixed(2)}</span>` : ''}`}
    ${retry.map((t) => `<button class="btn" data-retry="${j.id}/${t.id}">${icon('retry')}${esc(shortTitle(t))} 다시</button>`).join('')}
    ${!live ? `<button class="btn" data-reuse="${j.id}" title="이 요청을 입력창에 다시 넣기">${icon('reuse')}다시 보내기</button>` : ''}</div>`;
  h += `</div></div>`;
  return h;
}
const shortTitle = (t) => (t.title.length > 14 ? t.title.slice(0, 14) + '…' : t.title);

function taskHtml(j, t) {
  const key = `${j.id}/${t.id}`;
  const running = t.status === 'running';
  const open = S.open.has(key);
  const multi = j.tasks.length > 1 || j.mode === 'both';
  const model = t.model ? `${t.autoPicked ? '✦ ' : ''}${t.model.replace(/^claude-|-\d{8}$/g, '')}${t.effort ? ' · ' + t.effort : ''}` : '';
  const time = running ? `<span class="live-dur" data-from="${t.startedAt}"></span>` : t.finishedAt ? dur(t.startedAt, t.finishedAt) : (ST_KO[t.status] || '');
  let h = `<div class="task ${open ? 'open' : ''}"><div class="trow" data-toggle="${key}">${t.waiting ? `<span class="st wait-on" title="사용자 응답 대기">${icon('bell')}</span>` : stIcon(t.status)}<span class="prov ${t.assignee}">${t.assignee === 'claude' ? 'Claude' : 'Codex'}</span>${t.agent ? `<span class="agent-chip" title="서브 에이전트 @${esc(t.agent)}">${icon('bot')}${esc(agentLabel(t.agent))}</span>` : ''}<span class="tt" title="${esc(t.title)}">${esc(t.title)}</span><span class="tm" title="${esc(t.autoPicked ? `자동 선택${t.reason ? ': ' + t.reason : ''}` : '직접 고른 설정')}">${[model, t.toolCalls ? `도구 ${t.toolCalls}` : '', time].filter(Boolean).join(' · ')}</span><span class="chev">${icon('right')}</span></div>`;
  if (multi && running && !open) { const last = lastLog(key); if (last) h += `<div class="live"><b>지금:</b> ${esc(last)}</div>`; }
  if (t.error && !open) h += `<div class="terr">${esc(t.error)}</div>`;
  if (open) {
    h += `<div class="tdetail">${t.autoPicked && t.reason ? `<div class="why">${icon('sparkle')}<span>${esc(t.model || '')}${t.effort ? ' · ' + esc(t.effort) : ''} 자동 선택 — ${esc(t.reason)}</span></div>` : ''}`;
    if (t.error) h += `<div class="terr" style="margin:10px 0 0">${esc(t.error)}</div>`;
    if (t.resultText && multi) h += `<div class="tres md">${md(t.resultText, j.cwd)}</div>`;
    if (multi) h += `<button type="button" class="tc-more" data-proc-show="${esc(key)}">추론 과정에서 보기</button>`;
    h += `</div>`;
  }
  return h + `</div>`;
}

function lastLog(key) {
  const list = S.logs.get(key) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.kind === 'tool') return `${e.name}${e.detail ? '  ' + e.detail : ''}`.slice(0, 160);
    if (e.kind === 'message' || e.kind === 'thinking') return String(e.text || '').replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}
function logHtml(key, tool) {
  const list = (S.logs.get(key) || []).filter((e) => !['result', 'raw'].includes(e.kind));
  if (!list.length) return '<span class="c-muted">기록 없음</span>';
  return list.map((e) => {
    const k = e.kind; let cls = 'lg', mark = '', text = e.text ?? '';
    if (k === 'tool') { cls += ` tool ${tool}`; mark = e.name || 'tool'; text = e.detail || ''; }
    else if (k === 'message') { cls += ' msg'; mark = '답변'; }
    else if (k === 'thinking') { cls += ' think'; mark = '생각'; }
    else if (k === 'tool_error' || k === 'error') { cls += ' err'; mark = '오류'; }
    else if (k === 'stderr') { cls += ' warn'; mark = '경고'; }
    else if (k === 'intercept') { cls += ' ic'; mark = '수정 지시'; }
    else if (k === 'init') { mark = '시작'; text = `${e.model || ''}${e.effort ? ' · ' + e.effort : ''}`; }
    text = String(text); if (text.length > 800) text = text.slice(0, 800) + '…';
    return `<div class="${cls}"><span class="k">${esc(mark)}</span><span>${esc(text)}</span></div>`;
  }).join('');
}

async function ensureLogs(j) {
  const keys = [...(j.mode === 'auto' ? ['plan'] : []), ...j.tasks.map((t) => t.id)];
  let changed = false;
  await Promise.all(keys.map(async (k) => {
    const id = `${j.id}/${k}`; if (S.loadedLogs.has(id)) return; S.loadedLogs.add(id);
    const list = await api(`/api/jobs/${j.id}/log/${encodeURIComponent(k)}`).catch(() => []);
    const live = S.logs.get(id) || []; const seen = new Set(list.map((e) => e.at + e.kind));
    S.logs.set(id, [...list, ...live.filter((e) => !seen.has(e.at + e.kind))]); changed = true;
  }));
  if (changed && j.sessionId === S.current) { rerenderJob(j.id); scheduleInspector(); }
}
function rerenderJob(id) {
  const j = S.jobs.get(id); const el = document.getElementById(`job-${id}`); if (!j || !el) return;
  const sc = $('#scroll'); const stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  const logScroll = {}; el.querySelectorAll('.log, .proc-body').forEach((l) => (logScroll[l.id] = l.scrollHeight - l.scrollTop - l.clientHeight < 30 ? -1 : l.scrollTop));
  el.innerHTML = jobHtml(j);
  mountPreviews(el);
  el.querySelectorAll('.log, .proc-body').forEach((l) => { const v = logScroll[l.id]; l.scrollTop = v === undefined || v === -1 ? l.scrollHeight : v; });
  if (stick) sc.scrollTop = sc.scrollHeight;
}
const rq = new Set(); let rt = null;
function queueRerender(id) { rq.add(id); if (!rt) rt = setTimeout(() => { rt = null; for (const x of rq) rerenderJob(x); rq.clear(); }, 150); }

$('#thread').addEventListener('click', async (e) => {
  const sg = e.target.closest('[data-sugg]'); if (sg) { setInput(sg.dataset.sugg); return; }
  const tg = e.target.closest('[data-toggle]'); if (tg) { const k = tg.dataset.toggle; S.open.has(k) ? S.open.delete(k) : S.open.add(k); return rerenderJob(k.split('/')[0]); }
  const c = e.target.closest('[data-cancel]'); if (c) return stopJob(c.dataset.cancel);
  const it = e.target.closest('[data-ic-toggle]'); if (it) { const k = `ic:${it.dataset.icToggle}`; S.open.has(k) ? S.open.delete(k) : S.open.add(k); return rerenderJob(it.closest('.turn').id.slice(4)); }
  const r = e.target.closest('[data-retry]'); if (r) { const [jid, tid] = r.dataset.retry.split('/'); return api(`/api/jobs/${jid}/tasks/${tid}/retry`, { method: 'POST' }).catch((x) => toast(x.message, true)); }
  const u = e.target.closest('[data-reuse]'); if (u) { const j = S.jobs.get(u.dataset.reuse); if (j) setInput(j.goal); }
});
$('#scroll').addEventListener('scroll', () => $('#main').classList.toggle('scrolled', $('#scroll').scrollTop > 4));

function note(html, cls = '') {
  const k = S.current || 'draft'; const list = S.notes.get(k) || []; const item = `<div class="note ${cls}">${html}</div>`;
  list.push(item); S.notes.set(k, list.slice(-6));
  const box = $('#notes'); if (box) { box.insertAdjacentHTML('beforeend', item); $('#scroll').scrollTop = $('#scroll').scrollHeight; }
}

/* ================= 입력창 하단 버튼 ================= */
function renderBarPills() {
  const m = S.prefs.mode;
  const cl = toolPref('claude'), cx = toolPref('codex');
  $('#pMode').innerHTML = `${icon('split')}<span class="v">${MODES[m].label}${S.prefs.pace === 'speed' ? ' · 속도 우선' : ''}</span>${icon('down')}`;
  $('#pClaude').innerHTML = `<span class="dot" style="background:var(--claude)"></span><span class="v"><span class="nm">Claude · </span>${esc(prefLabel('claude', cl))}</span>${icon('down')}`;
  $('#pCodex').innerHTML = `<span class="dot" style="background:var(--codex)"></span><span class="v"><span class="nm">Codex · </span>${esc(prefLabel('codex', cx))}</span>${icon('down')}`;
  $('#pClaude').classList.toggle('off', m === 'codex');
  $('#pCodex').classList.toggle('off', m === 'claude');
  $('#pClaude').title = m === 'codex' ? 'Codex만 모드에서는 쓰이지 않음' : 'Claude 모델·추론 강도';
  $('#pCodex').title = m === 'claude' ? 'Claude만 모드에서는 쓰이지 않음' : 'Codex 모델·추론 강도';
}
/* 전송 버튼 세 가지: 유휴 = 보내기 · 진행 중 + 빈 입력 = 중지 · 진행 중 + 입력 있음 = 수정 지시 보내기(intercept.js) */
function renderSend() {
  const b = $('#btnSend'); const live = liveJob();
  const has = !!($('#in').value.trim() || S.atts.some((a) => a.state === 'ok'));
  const ic = live && has && icSupported(live);
  const sending = live && INT.inflight.has(live.id);
  b.classList.toggle('ic', !!ic); b.removeAttribute('aria-busy');
  if (ic && sending) { b.innerHTML = '<span class="spinner"></span>'; b.title = '수정 지시를 보내는 중'; b.disabled = true; b.setAttribute('aria-busy', 'true'); delete b.dataset.stop; }
  else if (ic) { b.innerHTML = icon('up'); b.title = '수정 지시 보내기 (Enter)'; b.disabled = false; delete b.dataset.stop; }
  else if (live) { b.innerHTML = icon('stop'); b.title = '실행 중인 작업 중지'; b.disabled = false; b.dataset.stop = live.id; }
  else { b.innerHTML = icon('up'); b.title = '보내기 (Enter)'; b.disabled = !has; delete b.dataset.stop; }
  b.setAttribute('aria-label', b.title);
  renderIcComposer(live, has);
}
/** 작업 중지. 목표 판정·라운드 전환 구간(작업은 이미 끝남)이면 목표를 중지한다 */
function stopJob(id) {
  const j = S.jobs.get(id);
  if (j && !LIVE.has(j.status) && S.sessions.get(j.sessionId)?.goal?.status === 'active') return api(`/api/sessions/${j.sessionId}/goal/stop`, { method: 'POST' }).catch((x) => toast(x.message, true));
  return api(`/api/jobs/${id}/cancel`, { method: 'POST' }).catch((x) => toast(x.message, true));
}
$('#btnSend').addEventListener('click', () => { const id = $('#btnSend').dataset.stop; if (id) stopJob(id); else submit(); });
$('#btnAttach').addEventListener('click', () => $('#file').click());
$('#pMode').addEventListener('click', (e) => openModePicker(e.currentTarget));
$('#pClaude').addEventListener('click', (e) => openModelPicker('claude', e.currentTarget));
$('#pCodex').addEventListener('click', (e) => openModelPicker('codex', e.currentTarget));

/* ================= 팝오버 ================= */
function openPop(anchor, items, { sel = 0, kind = '', below = false, onClose = null, kbd = kind === 'slash' } = {}) {
  if (S.pop?.onClose && S.pop.anchor !== anchor) { try { S.pop.onClose(); } catch {} }
  if (S.pop?.anchor?.classList) S.pop.anchor.classList.remove('on');
  const el = $('#pop');
  S.pop = { anchor, items, sel, kind, below, onClose, kbd };
  let idx = -1;
  const anyIcon = items.some((i) => i.icon);
  el.innerHTML = items.map((it) => {
    if (it.header) return `<div class="ph">${esc(it.header)}</div>`;
    if (it.sep) return '<div class="psep"></div>';
    idx++;
    return `<div class="pi ${idx === S.pop.sel ? 'sel' : ''} ${it.danger ? 'danger' : ''}" data-i="${idx}" role="option">${anyIcon ? `<span class="pic">${it.icon ? icon(it.icon) : ''}</span>` : ''}<div class="l"><b>${esc(it.label)}</b>${it.desc ? `<span>${esc(it.desc)}</span>` : ''}</div>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}${it.checked ? `<span class="ck">${icon('check')}</span>` : ''}</div>`;
  }).join('');
  el.classList.toggle('kbd', !!kbd); // 선택 줄은 방향키·명령 자동완성일 때만 보인다
  el.hidden = false;
  el.classList.toggle('compact', anyIcon && !items.some((i) => i.desc));
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top;
  if (below) { top = r.bottom + 6; if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6); }
  else { top = r.top - hgt - 8; if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - hgt - 8); }
  el.style.left = `${left}px`; el.style.top = `${Math.max(8, top)}px`;
  anchor.classList?.add('on');
  el.querySelector('.pi.sel')?.scrollIntoView({ block: 'nearest' });
}
function closePop() { if (S.pop?.anchor?.classList) S.pop.anchor.classList.remove('on'); const cb = S.pop?.onClose; S.pop = null; $('#pop').hidden = true; if (cb) { try { cb(); } catch {} } }
const popItems = () => (S.pop ? S.pop.items.filter((i) => !i.header && !i.sep) : []);
function popPick(i = S.pop?.sel) { const it = popItems()[i]; if (it) it.run(); }
// 방향키: 마우스로 연 메뉴는 첫 입력에 현재 줄만 드러내고, 그다음부터 움직인다
function popMove(d) { const n = popItems().length; if (!n) return; if (S.pop.kbd) S.pop.sel = (S.pop.sel + d + n) % n; S.pop.kbd = true; openPop(S.pop.anchor, S.pop.items, S.pop); }
$('#pop').addEventListener('mousemove', (e) => { const p = e.target.closest('.pi'); if (p && S.pop) S.pop.sel = Number(p.dataset.i); });
$('#pop').addEventListener('mousedown', (e) => { e.preventDefault(); const p = e.target.closest('.pi'); if (p) popPick(Number(p.dataset.i)); });
document.addEventListener('mousedown', (e) => { if (S.pop && !e.target.closest('#pop') && e.target !== S.pop.anchor && !S.pop.anchor.contains?.(e.target)) closePop(); });
document.addEventListener('keydown', (e) => {
  if (!S.pop || document.activeElement === input) return;
  const n = popItems().length; if (!n) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); popMove(1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); popMove(-1); }
  if (e.key === 'Enter' && S.pop.kbd) { e.preventDefault(); popPick(); }
});
window.addEventListener('resize', closePop);

function openModePicker(anchor) {
  const items = Object.entries(MODES).map(([k, v]) => ({ label: v.label, desc: v.desc, checked: S.prefs.mode === k, run: () => { S.prefs.mode = k; savePrefs(); renderBarPills(); closePop(); } }));
  items.push({ sep: true }, { header: '자동 분배일 때 계획 담당' });
  for (const [p, d] of [['auto', 'Codex 우선, 안 되면 Claude'], ['codex', 'Codex가 계획·보고'], ['claude', 'Claude가 계획·보고']]) items.push({ label: p === 'auto' ? '자동' : p === 'codex' ? 'Codex' : 'Claude', desc: d, checked: S.prefs.planner === p, run: () => { S.prefs.planner = p; savePrefs(); openModePicker(anchor); } });
  // 작업 방식: 품질 우선(기본) = 평소 단독으로 쓸 때의 추론 강도, 속도 우선 = 근거 없으면 high로 낮춤
  items.push({ sep: true }, { header: '작업 방식' });
  for (const [p, l, d] of [['quality', '품질 우선 (기본)', '평소 단독으로 쓸 때와 같은 추론 강도 · 느려도 꼼꼼하게'], ['speed', '속도 우선', '근거가 없으면 강도를 high로 낮춤 · 빠르지만 얕게']]) items.push({ label: l, desc: d, checked: (S.prefs.pace || 'quality') === p, run: () => { S.prefs.pace = p; savePrefs(); renderBarPills(); closePop(); } });
  openPop(anchor, items, { sel: Object.keys(MODES).indexOf(S.prefs.mode), kind: 'mode' });
}
function openModelPicker(tool, anchor) {
  const o = S.options?.[tool]; if (!o) return;
  const cur = toolPref(tool);
  const set = (patch) => {
    S.prefs[tool] = { ...cur, ...patch };
    if (tool === 'codex' && patch.model !== undefined && patch.model !== 'auto' && S.prefs.codex.effort !== 'auto') { const ef = codexEfforts(patch.model); if (S.prefs.codex.effort && !ef.includes(S.prefs.codex.effort)) S.prefs.codex.effort = ef.includes('medium') ? 'medium' : ''; }
    savePrefs(); renderBarPills(); openModelPicker(tool, anchor);
  };
  const items = [{ header: '알아서 고르기' }];
  const allAuto = cur.model === 'auto' && cur.effort === 'auto';
  items.push({ label: '자동 (알잘딱)', desc: '난이도·남은 한도를 보고 고름 (최소 Opus·high / GPT-6.1-Sol·high)', checked: allAuto, run: () => set({ model: 'auto', effort: 'auto' }) });
  items.push({ sep: true }, { header: `${tool === 'claude' ? 'CLAUDE' : 'CODEX'} 모델` });
  items.push({ label: '자동', desc: '모델만 알아서', checked: cur.model === 'auto' && !allAuto, run: () => set({ model: 'auto' }) });
  items.push({ label: `기본값 (${o.models.find((m) => m.id === o.cliDefault.model)?.label || o.cliDefault.model || 'CLI 설정'})`, desc: '각 CLI 평소 설정 그대로', checked: !cur.model, run: () => set({ model: '' }) });
  for (const m of o.models) items.push({ label: m.label, desc: m.id !== m.label ? m.id : '', checked: cur.model === m.id, run: () => set({ model: m.id }) });
  items.push({ sep: true }, { header: '추론 강도' });
  items.push({ label: '자동', desc: '강도만 알아서', checked: cur.effort === 'auto' && !allAuto, run: () => set({ effort: 'auto' }) });
  items.push({ label: `기본값 (${o.cliDefault.effort || 'CLI 설정'})`, desc: '', checked: !cur.effort, run: () => set({ effort: '' }) });
  for (const ef of tool === 'codex' ? codexEfforts(cur.model === 'auto' ? '' : cur.model) : o.efforts) items.push({ label: ef, desc: EFFORT_KO[ef] || '', checked: cur.effort === ef, run: () => set({ effort: ef }) });
  const sel = items.filter((i) => !i.header && !i.sep).findIndex((i) => i.checked);
  openPop(anchor, items, { sel: Math.max(0, sel), kind: tool });
}
function openFolderPicker(anchor) {
  const items = [{ header: '폴더를 고르면 그 폴더에서 새 세션을 시작해요' }];
  for (const p of S.projects) items.push({ label: shortPath(p.path, 3), desc: [p.label, p.memories ? `공유 메모리 ${p.memories}개` : '', p.path].filter(Boolean).join(' · '), checked: p.path.toLowerCase() === currentCwd().toLowerCase(), run: () => { closePop(); newSession(p.path); } });
  items.push({ sep: true }, { label: '다른 폴더 경로 입력…', desc: '', run: async () => { closePop(); const v = prompt('폴더 경로', currentCwd()); if (!v) return; const r = await api(`/api/dir?path=${encodeURIComponent(v)}`); if (!r.exists) return toast(`폴더가 없습니다: ${r.path}`, true); newSession(r.path); } });
  openPop(anchor, items, { kind: 'folder' });
}

/* ================= 입력 ================= */
const input = $('#in');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; }
function setInput(v) { input.value = v; autosize(); renderSend(); input.focus(); input.setSelectionRange(v.length, v.length); }
input.addEventListener('input', () => { autosize(); renderSend(); });
input.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (S.pop) {
    const n = popItems().length;
    if (n && e.key === 'ArrowDown') { e.preventDefault(); return popMove(1); }
    if (n && e.key === 'ArrowUp') { e.preventDefault(); return popMove(-1); }
    if (e.key === 'Escape') { e.preventDefault(); return closePop(); }
    if (e.key === 'Enter' && S.pop.kbd) { e.preventDefault(); return popPick(); }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return submit(); }
  if (e.key === 'ArrowUp' && !input.value && S.history.length) { e.preventDefault(); S.histIdx = Math.min(S.histIdx + 1, S.history.length - 1); return setInput(S.history[S.history.length - 1 - S.histIdx]); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (S.pop) closePop(); else if (!$('#modal').hidden) closeModal(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && e.shiftKey) { e.preventDefault(); newSession(currentCwd()); }
});

async function submit() {
  const text = input.value.trim();
  if (S.atts.some((a) => a.state === 'up')) return toast('이미지 업로드가 끝나면 보낼 수 있어요');
  const atts = S.atts.filter((a) => a.state === 'ok');
  if (!text && !atts.length) return;
  const live = liveJob();
  if (live) return icSubmit(live); // 진행 중이면 새 요청이 아니라 현재 작업에 수정 지시
  if (S.submitting) return; // 앞선 보내기가 아직 응답을 기다리는 중 (중복 Enter·클릭)
  const body = { goal: text, mode: S.prefs.mode, planner: S.prefs.planner, settings: { claude: toolPref('claude'), codex: toolPref('codex'), permission: S.prefs.permission, pace: S.prefs.pace === 'speed' ? 'speed' : 'quality' }, attachments: atts.map((a) => ({ id: a.id, name: a.name })) };
  if (S.current) body.sessionId = S.current; else body.cwd = currentCwd();
  S.submitting = true; $('#btnSend').disabled = true;
  try {
    // 확장: 새 세션 옵션(격리 등)이 있으면 기능 파일이 세션을 먼저 만들고 id를 돌려준다 (window.hubCreateSession(cwd) → sessionId|null)
    if (!S.current && window.hubCreateSession) { const sid = await window.hubCreateSession(body.cwd); if (sid) { body.sessionId = sid; delete body.cwd; } }
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    if (text) S.history.push(text); S.histIdx = -1;
    input.value = ''; autosize(); S.atts = []; renderAtts();
    S.jobs.set(job.id, job);
    if (!S.current) { S.notes.delete('draft'); await openSession(job.sessionId); } else renderThread();
  } catch (e) { toast(e.message, true); }
  finally { S.submitting = false; renderSend(); }
}

/* ================= 세션 ================= */
function newSession(cwd) {
  S.current = null; S.draftCwd = cwd; S.prefs.cwd = cwd; savePrefs();
  history.replaceState(null, '', location.pathname);
  renderTree(); renderThread(); input.focus();
}
async function openSession(id) {
  if (!S.sessions.has(id)) { try { for (const x of await api('/api/sessions')) S.sessions.set(x.id, x); } catch {} }
  if (!S.sessions.has(id)) return newSession(currentCwd());
  if (!sessionJobs(id).length) { try { for (const j of await api(`/api/sessions/${id}/jobs`)) S.jobs.set(j.id, j); } catch {} }
  S.current = id; S.draftCwd = null; S.prefs.cwd = S.sessions.get(id).cwd; savePrefs();
  history.replaceState(null, '', `#s=${id}`);
  renderTree(); renderThread(); input.focus();
  loadPreviews();
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  const s = S.sessions.get(S.current);
  switch (a.dataset.act) {
    case 'memory': return openMemory();
    case 'board': return openBoard();
    case 'rename': { if (s) renameInline(s.id, $('#title')); return; }
    case 'delete': { if (s) deleteSession(s.id); return; }
  }
});
$('#btnNew').addEventListener('click', () => newSession(currentCwd()));

/* ================= 사용량 ================= */
async function showUsage() {
  $('#usage').style.opacity = '.6';
  try { S.usage = await api('/api/usage?force=1'); renderUsage(); toast('사용량을 새로 불러왔어요'); }
  catch (e) { toast(e.message, true); }
  finally { $('#usage').style.opacity = ''; }
}

/* ================= 이미지 첨부 ================= */
function renderAtts() {
  $('#atts').innerHTML = S.atts.map((a) => `<div class="att ${a.state}" title="${esc(a.error || a.name)}"><img src="${esc(a.url)}" alt=""><button class="x" data-rm="${a.key}" title="빼기">${icon('x')}</button>${a.state === 'up' ? '<span class="st2">올리는 중…</span>' : a.state === 'bad' ? `<span class="st2">${esc(a.error)}</span>` : ''}</div>`).join('');
  renderSend();
}
$('#atts').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { S.atts = S.atts.filter((a) => a.key !== b.dataset.rm); renderAtts(); } });
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) { toast(`이미지만 첨부할 수 있어요: ${f.name}`, true); continue; }
    if (S.atts.filter((a) => a.state !== 'bad').length >= 4) { toast('이미지는 한 번에 4장까지', true); break; }
    const a = { key: Math.random().toString(36).slice(2), name: f.name || 'clipboard.png', url: URL.createObjectURL(f), state: 'up' };
    S.atts.push(a); renderAtts();
    try {
      const r = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(a.name) }, body: f });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText);
      Object.assign(a, { id: j.id, state: 'ok' });
    } catch (e) { Object.assign(a, { state: 'bad', error: e.message }); }
    renderAtts();
  }
}
$('#file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; input.focus(); });
input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); addFiles(files); } });
let dragN = 0; const mainEl = $('#main');
mainEl.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragN++; $('#drop').hidden = false; } });
mainEl.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop').hidden = true; } });
mainEl.addEventListener('dragover', (e) => e.preventDefault());
mainEl.addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#drop').hidden = true; addFiles([...e.dataTransfer.files]); });

/* ================= 모달: 메모리·보드 ================= */
function modal(title, single) { $('#modalTitle').textContent = title; $('#modalBody').className = single ? 'single' : ''; $('#modal').hidden = false; return $('#modalBody'); }
function closeModal() { $('#modal').hidden = true; input.focus(); }
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
async function openBoard() {
  const body = modal('작업 보드 — Claude와 Codex가 함께 보는 기록', true);
  body.innerHTML = '<span class="c-muted">불러오는 중…</span>';
  const { board } = await api('/api/board');
  body.innerHTML = `<div class="md">${board ? md(board) : '<span class="c-muted">아직 기록이 없어요</span>'}</div>`;
}
async function openMemory(scope = 'global', file = null) {
  const body = modal('공유 메모리 — Claude·Codex 공통 (읽기 전용)', false);
  const ov = await api('/api/memory');
  const scopes = [{ slug: 'global', label: '전역', count: Math.max(0, ov.global.length - 1) }, ...ov.projects.map((p) => ({ slug: p.slug, label: p.path ? shortPath(p.path) : p.slug, count: p.count }))];
  const files = await api(`/api/memory/${encodeURIComponent(scope)}`);
  let view = '<span class="c-muted">왼쪽에서 메모리를 고르세요</span>';
  if (file) view = esc((await api(`/api/memory/${encodeURIComponent(scope)}/${encodeURIComponent(file)}`)).text);
  body.innerHTML = `<div class="mlist">${scopes.map((s) => `<div class="mscope" data-scope="${esc(s.slug)}" title="${esc(s.slug)}">${icon(s.slug === scope ? 'down' : 'right')}${esc(s.label)}<span class="n">${s.count}</span></div>${s.slug === scope ? files.map((f) => `<div class="mfile ${f.name === file ? 'on' : ''}" data-file="${esc(f.name)}">${esc(f.title)}<small>${esc(f.description || f.name)}</small></div>`).join('') : ''}`).join('')}</div><div class="mview">${view}</div>`;
  body.querySelectorAll('[data-scope]').forEach((el) => (el.onclick = () => openMemory(el.dataset.scope)));
  body.querySelectorAll('[data-file]').forEach((el) => (el.onclick = () => openMemory(scope, el.dataset.file)));
}

/* ================= 결과 이미지 미리보기 =================
   목록: /image-previews.json (workspace/image-preview-contract.md). 세션 ID와 displayJobIds가 모두 맞는 작업 카드에만 붙인다.
   갤러리 DOM은 작업별로 보관해 다시 그릴 때 그대로 끼워 넣는다 (SSE 갱신마다 이미지가 다시 로딩되지 않게). */
const PV_URL = /^\/uploads\/[a-z0-9]+-[a-f0-9]{10}\.(png|jpg|gif|webp)$/;
const PV = { list: [], sig: '', loaded: false, timer: null, wait: 10_000, nodes: new Map(), focused: null, view: null };
function pvImage(x) {
  if (!x || typeof x.url !== 'string' || !PV_URL.test(x.url)) return null;
  const w = Number(x.width) > 0 ? Number(x.width) : 1, ht = Number(x.height) > 0 ? Number(x.height) : 1;
  return { key: String(x.key || x.uploadId || x.url), label: String(x.label || x.name || '이미지'), alt: String(x.alt || x.label || x.name || ''), name: String(x.name || ''), url: x.url, mime: String(x.mime || ''), width: w, height: ht, size: Number(x.size) || 0 };
}
function pvNormalize(data) {
  const out = [];
  for (const p of Array.isArray(data?.previews) ? data.previews : []) {
    if (!p || typeof p.sessionId !== 'string' || !Array.isArray(p.displayJobIds)) continue;
    const images = (Array.isArray(p.images) ? p.images : []).map(pvImage).filter(Boolean);
    if (!images.length) continue;
    out.push({ id: String(p.id || p.sourceJobId || ''), sessionId: p.sessionId, sourceJobId: String(p.sourceJobId || ''), displayJobIds: p.displayJobIds.map(String), title: String(p.title || '결과 이미지'), images, comparison: pvImage(p.comparison) });
  }
  return out;
}
async function loadPreviews(fromTimer = false) {
  clearTimeout(PV.timer);
  try {
    const r = await fetch('/image-previews.json', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = pvNormalize(await r.json());
    PV.loaded = true; PV.wait = 10_000;
    const sig = JSON.stringify(list);
    if (sig !== PV.sig) { PV.sig = sig; PV.list = list; PV.nodes.clear(); if (S.current) renderThread(); }
  } catch {
    // 아직 게시 전(404)이거나 일시 실패: 이미 받은 목록은 유지하고, 처음 받는 중이면 간격을 늘려 다시 시도
    if (!PV.loaded) { if (fromTimer) PV.wait = Math.min(PV.wait * 2, 60_000); PV.timer = setTimeout(() => loadPreviews(true), PV.wait); }
  }
}
const previewsFor = (j) => PV.list.filter((p) => p.sessionId === j.sessionId && p.displayJobIds.includes(j.id));
const pvKb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

function pvBuild(j) {
  const wrap = document.createElement('div');
  wrap.className = 'pv';
  wrap.innerHTML = previewsFor(j).map((p) => {
    const from = p.sourceJobId && p.sourceJobId !== j.id ? '이전 작업 결과' : '이 작업 결과';
    return `<section class="pv-g" aria-label="${esc(`${p.title} — ${from}`)}">
      <div class="pv-h">${icon('image')}<b>${esc(p.title)}</b><span class="pv-sub">${p.images.length}장 · ${from}</span><span class="grow"></span>${p.comparison ? `<button type="button" class="btn pv-cmp" data-pv-open="${esc(p.id)}" data-pv-key="${esc(p.comparison.key)}" aria-label="${esc(p.comparison.label)} 크게 보기">${icon('board')}${esc(p.comparison.label)}</button>` : ''}</div>
      <div class="pv-grid">${p.images.map((im) => `<figure class="pv-item is-loading">
        <div class="pv-box"><button type="button" class="pv-open" data-pv-open="${esc(p.id)}" data-pv-key="${esc(im.key)}" aria-label="${esc(im.label)} 크게 보기" title="${esc(im.label)} 크게 보기">
          <span class="pv-frame" style="aspect-ratio:${im.width}/${im.height}"><img src="${esc(im.url)}" alt="${esc(im.alt)}" width="${im.width}" height="${im.height}" decoding="async" draggable="false"></span>
          <span class="pv-zoom" aria-hidden="true">${icon('expand')}</span>
        </button>
        <div class="pv-fail" role="status"><span>${icon('alert')}불러오지 못했어요</span><button type="button" class="btn" data-pv-retry aria-label="${esc(im.label)} 다시 불러오기">${icon('retry')}다시 시도</button></div></div>
        <figcaption>${esc(im.label)}</figcaption>
      </figure>`).join('')}</div>
    </section>`;
  }).join('');
  wrap.querySelectorAll('.pv-item').forEach((fig) => {
    const img = fig.querySelector('img'); const btn = fig.querySelector('.pv-open'); const base = img.getAttribute('src');
    const set = (st) => { fig.classList.remove('is-loading', 'is-ok', 'is-err'); fig.classList.add(`is-${st}`); btn.disabled = st === 'err'; fig.setAttribute('aria-busy', String(st === 'loading')); };
    img.addEventListener('load', () => set(img.naturalWidth ? 'ok' : 'err'));
    img.addEventListener('error', () => set('err'));
    fig.querySelector('[data-pv-retry]').addEventListener('click', () => { set('loading'); img.src = `${base}?retry=${Date.now()}`; });
    if (img.complete) set(img.naturalWidth ? 'ok' : 'err'); else set('loading');
  });
  wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-pv-open]'); if (b && !b.disabled) openViewer(b.dataset.pvOpen, b.dataset.pvKey, b); });
  wrap.addEventListener('focusin', (e) => (PV.focused = e.target));
  return wrap;
}
function mountPreviews(root) {
  root.querySelectorAll('.pv-slot').forEach((slot) => {
    const j = S.jobs.get(slot.dataset.pvJob); if (!j) return slot.remove();
    let node = PV.nodes.get(j.id);
    if (!node) { node = pvBuild(j); PV.nodes.set(j.id, node); }
    slot.replaceWith(node);
    // 다시 그리면서 초점이 빠졌으면 보던 썸네일로 돌려놓는다
    if (PV.focused && node.contains(PV.focused) && (document.activeElement === document.body || !document.activeElement)) PV.focused.focus({ preventScroll: true });
  });
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest?.('.pv')) PV.focused = null; });

/* 확대창 */
function openViewer(previewId, key, trigger) {
  const p = PV.list.find((x) => x.id === previewId); if (!p) return;
  const items = [...p.images, ...(p.comparison ? [p.comparison] : [])];
  const idx = Math.max(0, items.findIndex((x) => x.key === key));
  PV.view = { p, items, idx, trigger, jobId: trigger?.closest('.turn')?.id || '' };
  const v = $('#viewer'); v.hidden = false; $('#app').inert = true;
  if (S.pop) closePop();
  renderViewer();
  $('#vwClose').focus();
}
function renderViewer() {
  const vw = PV.view; if (!vw) return;
  const it = vw.items[vw.idx]; const n = vw.items.length;
  $('#vwTitle').textContent = `${vw.p.title} — ${it.label}`;
  $('#vwCount').textContent = n > 1 ? `${vw.idx + 1} / ${n}` : '';
  $('#vwPrev').hidden = $('#vwNext').hidden = n < 2;
  $('#vwRaw').href = it.url;
  const fig = $('#vwFig'); const img = $('#vwImg');
  fig.className = 'is-loading';
  img.onload = () => { fig.className = img.naturalWidth ? 'is-ok' : 'is-err'; };
  img.onerror = () => { fig.className = 'is-err'; };
  img.alt = it.alt; img.width = it.width; img.height = it.height; img.src = it.url;
  if (img.complete && img.naturalWidth && img.src.endsWith(it.url)) fig.className = 'is-ok';
  $('#vwMeta').textContent = [it.alt, `${it.width}×${it.height}`, it.mime ? it.mime.replace('image/', '').toUpperCase() : '', it.size ? pvKb(it.size) : ''].filter(Boolean).join(' · ');
  $('#vwThumbs').innerHTML = n > 1 ? vw.items.map((x, i) => `<button type="button" class="vw-th ${i === vw.idx ? 'on' : ''}" data-vw-i="${i}" aria-label="${esc(x.label)}" aria-current="${i === vw.idx ? 'true' : 'false'}" title="${esc(x.label)}"><img src="${esc(x.url)}" alt="" width="${x.width}" height="${x.height}"><span>${esc(x.label)}</span></button>`).join('') : '';
}
function stepViewer(d) { const vw = PV.view; if (!vw || vw.items.length < 2) return; vw.idx = (vw.idx + d + vw.items.length) % vw.items.length; renderViewer(); }
function closeViewer() {
  const vw = PV.view; if (!vw) return;
  PV.view = null; $('#viewer').hidden = true; $('#app').inert = false;
  $('#vwImg').removeAttribute('src');
  let t = vw.trigger;
  if (!t?.isConnected) t = document.querySelector(`#${CSS.escape(vw.jobId || 'x')} [data-pv-open="${CSS.escape(vw.p.id)}"][data-pv-key="${CSS.escape(vw.items[0].key)}"]`);
  (t?.isConnected ? t : input).focus({ preventScroll: true });
}
$('#viewer').addEventListener('click', (e) => {
  const th = e.target.closest('[data-vw-i]'); if (th) { PV.view.idx = Number(th.dataset.vwI); renderViewer(); return $(`#vwThumbs [data-vw-i="${th.dataset.vwI}"]`)?.focus(); }
  if (e.target.closest('#vwClose')) return closeViewer();
  if (e.target.closest('#vwPrev')) return stepViewer(-1);
  if (e.target.closest('#vwNext')) return stepViewer(1);
  if (e.target.closest('#vwRetry')) { const img = $('#vwImg'); $('#vwFig').className = 'is-loading'; img.src = `${PV.view.items[PV.view.idx].url}?retry=${Date.now()}`; return; }
  // 창 바깥 어두운 배경이나 이미지 둘레 빈 곳을 누르면 닫기
  if (e.target.id === 'viewer' || e.target.classList.contains('vw-stage')) closeViewer();
});
$('#viewer').addEventListener('keydown', (e) => {
  e.stopPropagation(); // 확대창이 열린 동안 뒤 화면 단축키는 막는다
  if (e.key === 'Escape') { e.preventDefault(); return closeViewer(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); return stepViewer(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); return stepViewer(1); }
  if (e.key === 'Tab') {
    const f = [...$('#viewer').querySelectorAll('button:not([hidden]):not(:disabled), a[href]')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
});

/* ================= 마크다운(간단) ================= */
/* ---------- 로컬 경로 열기 ---------- */
// 마크다운 안의 경로를 누르면 허브 PC 탐색기로 연다 (원격 접속이면 서버가 거절 → 경로 복사)
function pathLink(text, p) {
  const full = String(p).replace(/^\/(?=[A-Za-z]:)/, '');
  return `<button type="button" class="path" data-open="${full}" title="${full}&#10;눌러서 열기 · 오른쪽 클릭으로 경로 복사">${text}</button>`;
}
const ABS_RE = /^[A-Za-z]:[\\/]/;
const REL_RE = /^(?:\.{1,2}[\\/])?[\w.\-()\[\]\uAC00-\uD7A3]+(?:[\\/][\w.\-()\[\]\uAC00-\uD7A3]+)*(?:\.[A-Za-z0-9]{1,8}|[\\/])$/;
function codeWithPath(c, base) {
  const raw = c.trim();
  let full = '';
  if (ABS_RE.test(raw)) full = raw;
  else if (base && /[\\/.]/.test(raw) && REL_RE.test(raw) && !/^\d+(\.\d+)*$/.test(raw) && !/^https?:/.test(raw)) full = `${base.replace(/[\\/]+$/, '')}\\${raw.replace(/^\.[\\/]/, '').replace(/\//g, '\\')}`;
  const isRel = full && !ABS_RE.test(raw);
  const rel = isRel ? ` data-rel="${raw}" data-base="${base}"` : '';
  const tip = isRel ? `${raw}&#10;작업 폴더에 없으면 상위·허브 폴더에서 찾아 열기 · 오른쪽 클릭으로 전체 경로 복사` : `${full}&#10;눌러서 열기 · 오른쪽 클릭으로 경로 복사`;
  return full ? `<code class="path" data-open="${full}"${rel} title="${tip}">${c}</code>` : `<code>${c}</code>`;
}
async function openPath(p, mode = 'auto', rel = '', base = '') {
  const raw = String(p || '').replace(/&amp;/g, '&');
  try {
    const r = await api('/api/open', { method: 'POST', body: JSON.stringify({ path: raw, mode, rel, base }) });
    toast(r.action === 'folder' ? '탐색기로 폴더를 열었어요' : r.action === 'file' ? '파일을 열었어요' : '탐색기에서 파일 위치를 열었어요');
  } catch (e) {
    navigator.clipboard?.writeText(raw).catch(() => {});
    toast(`${e.message} · 경로를 복사했어요`, true);
  }
}
document.addEventListener('click', (e) => { const el = e.target.closest('[data-open]'); if (!el) return; e.preventDefault(); e.stopPropagation(); openPath(el.dataset.open, el.dataset.openMode || 'auto', el.dataset.rel || '', el.dataset.base || ''); }, true);
document.addEventListener('contextmenu', async (e) => {
  const el = e.target.closest('[data-open]'); if (!el) return; e.preventDefault();
  let p = el.dataset.open.replace(/&amp;/g, '&');
  // 상대 경로는 서버가 찾은 실제 위치를 복사 (못 찾으면 작업 폴더 기준 경로)
  if (el.dataset.rel) { try { p = (await api('/api/open', { method: 'POST', body: JSON.stringify({ path: p, rel: el.dataset.rel, base: el.dataset.base || '', mode: 'resolve' }) })).path || p; } catch {} }
  navigator.clipboard?.writeText(p).then(() => toast('경로를 복사했어요'), () => toast(p));
});

function md(src, base = '') {
  const lines = esc(src).split('\n'); let out = '', inUl = false, inPre = false, inTbl = false;
  const inline = (s) => s
    .replace(/\[([^\]]+)\]\(\/?([A-Za-z]:[\\/][^)]*)\)/g, (m, t, p) => pathLink(t, p))
    .replace(/`([^`]+)`/g, (m, c) => codeWithPath(c, base)).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(((?:https?:|\/)[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  const close = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inTbl) { out += '</table>'; inTbl = false; } };
  for (const l of lines) {
    if (l.trim().startsWith('```')) { close(); out += inPre ? '</code></pre>' : '<pre><code>'; inPre = !inPre; continue; }
    if (inPre) { out += l + '\n'; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue;
      if (inUl) { out += '</ul>'; inUl = false; }
      if (!inTbl) { out += '<table>'; inTbl = true; }
      out += '<tr>' + l.trim().slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('') + '</tr>'; continue;
    }
    if (inTbl) { out += '</table>'; inTbl = false; }
    const li = l.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)/);
    if (li) { if (!inUl) { out += '<ul>'; inUl = true; } out += `<li>${inline(li[1])}</li>`; continue; }
    if (inUl) { out += '</ul>'; inUl = false; }
    const hh = l.match(/^(#{1,4})\s+(.*)/);
    if (hh) out += `<h${Math.min(4, hh[1].length + 1)}>${inline(hh[2])}</h${Math.min(4, hh[1].length + 1)}>`;
    else if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  close(); if (inPre) out += '</code></pre>';
  return out;
}

/* ================= 실시간 이벤트 ================= */
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    // 확장: 기능 파일은 window.addEventListener('hub:event', (e) => e.detail)로 모든 실시간 이벤트를 받는다
    try { window.dispatchEvent(new CustomEvent('hub:event', { detail: ev })); } catch {}
    if (ev.type === 'hello') {
      for (const j of ev.jobs) icMergeJob(S.jobs.get(j.id), j);
      S.sessions = new Map(ev.sessions.map((s) => [s.id, s])); S.jobs = new Map(ev.jobs.map((j) => [j.id, j]));
      if (S.current && !S.sessions.has(S.current)) S.current = null;
      initSeen(); renderTree(); renderThread(); loadPreviews();
    } else if (ev.type === 'session') {
      const was = S.sessions.get(ev.session.id); S.sessions.set(ev.session.id, ev.session); renderTree();
      if (ev.session.id === S.current && (was?.title !== ev.session.title || was?.pinned !== ev.session.pinned || JSON.stringify(was?.goal) !== JSON.stringify(ev.session.goal))) { renderTop(); scheduleInspector(); }
    } else if (ev.type === 'session_removed') {
      S.sessions.delete(ev.sessionId); for (const [id, j] of S.jobs) if (j.sessionId === ev.sessionId) S.jobs.delete(id);
      if (S.current === ev.sessionId) newSession(currentCwd()); else renderTree();
    } else if (ev.type === 'job') {
      const prev = S.jobs.get(ev.job.id); icMergeJob(prev, ev.job); S.jobs.set(ev.job.id, ev.job);
      if (ev.job.sessionId === S.current) {
        if (!document.getElementById(`job-${ev.job.id}`)) renderThread(); else queueRerender(ev.job.id);
        renderSend();
        if (ev.job.tasks.length !== (prev?.tasks.length || 0)) ensureLogs(ev.job);
      }
      if (prev && LIVE.has(prev.status) && !LIVE.has(ev.job.status)) finished(ev.job);
      if (ev.job.sessionId === S.current) scheduleInspector();
    } else if (ev.type === 'job_removed') {
      S.jobs.delete(ev.jobId); if (ev.sessionId === S.current) renderThread();
    } else if (ev.type === 'log') {
      const key = `${ev.jobId}/${ev.taskId || ev.entry.phase || 'job'}`;
      if (!S.logs.has(key)) S.logs.set(key, []); S.logs.get(key).push(ev.entry);
      const j = S.jobs.get(ev.jobId); if (j && j.sessionId === S.current) { queueRerender(ev.jobId); if (ev.entry.kind === 'tool' || ev.entry.kind === 'init') scheduleInspector(); }
    } else if (ev.type === 'intercept') { onInterceptEvent(ev);
    } else if (ev.type === 'usage') { S.usage = ev.usage; renderUsage(); }
    else if (ev.type === 'catalog') { if (typeof loadCatalog === 'function') loadCatalog(); }
  };
  // 연결 상태를 remote.js 의 안내 줄에 알린다 (원격이 꺼지거나 허브가 멈춘 경우)
  es.onopen = () => { if (typeof onHubConn === 'function') onHubConn(true); };
  es.onerror = () => { es.close(); if (typeof onHubConn === 'function') onHubConn(false); setTimeout(connect, 2000); };
}
function finished(job) {
  const s = S.sessions.get(job.sessionId);
  if (job.sessionId !== S.current) toast(`${s?.title || '작업'} — ${ST_KO[job.status]}`, job.status === 'failed');
  document.title = `${job.status === 'done' ? '✓' : '!'} ${s?.title || 'ODDIN'}`; setTimeout(() => (document.title = 'ODDIN'), 8000);
  setTimeout(() => api('/api/usage').then((u) => { S.usage = u; renderUsage(); }).catch(() => {}), 3000);
}

/* 경과 시간 갱신 */
setInterval(() => document.querySelectorAll('.live-dur').forEach((el) => (el.textContent = dur(el.dataset.from, null))), 1000);
setInterval(() => renderTree(), 60_000);

/* 고정 버튼 아이콘 */
$('#btnCollapse').innerHTML = icon('panel'); $('#btnSide').innerHTML = icon('panel'); $('#btnInsp').innerHTML = icon('panelR'); $('#btnInspClose').innerHTML = icon('x');
$('#btnAttach').innerHTML = icon('clip'); $('#modalClose').innerHTML = icon('x');
$('#vwClose').innerHTML = icon('x'); $('#vwRaw').innerHTML = icon('open'); $('#vwPrev').innerHTML = icon('left'); $('#vwNext').innerHTML = icon('right');

/* ================= 시작 ================= */
async function init() {
  paintIcons(); applyLayout(); renderUsage(); renderAccount();
  const [opts, status, projects] = await Promise.all([api('/api/options'), api('/api/status'), api('/api/projects')]).catch((e) => { toast(`서버 연결 실패: ${e.message}`, true); return [null, null, []]; });
  S.options = opts; S.tools = status?.tools || null; S.cfg = status?.config || null; S.caps = status?.capabilities || {}; S.projects = projects || [];
  const m = location.hash.match(/s=([\w-]+)/); if (m) S.current = m[1];
  if (!S.prefs.cwd) S.prefs.cwd = S.projects[0]?.path || null;
  renderBarPills(); renderTree(); renderThread();
  loadPreviews();
  connect();
  api('/api/usage').then((u) => { S.usage = u; renderUsage(); }).catch(() => {});
  setInterval(() => api('/api/status').then((s) => { S.tools = s.tools; S.cfg = s.config; const had = S.caps?.intercept; S.caps = s.capabilities || {}; renderAccount(); if (had !== S.caps.intercept) renderSend(); }).catch(() => {}), 120_000);
  icRecover();
  input.focus();
}
document.addEventListener('DOMContentLoaded', init);
