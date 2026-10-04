/* AI Hub — 왼쪽 사이드바 · 오른쪽 패널 · 검색(Ctrl+K) · 우클릭 메뉴 · 크기 조절 · 설정
   app.js 다음에 읽힌다. 시작(init)은 DOMContentLoaded 에서 app.js 가 한다. */
'use strict';

/* ================= 읽음 표시 ================= */
S.seenInit = (() => { try { return localStorage.getItem('hub.seen') !== null; } catch { return true; } })();
S.seen = (() => { try { return JSON.parse(localStorage.getItem('hub.seen') || '{}'); } catch { return {}; } })();
function saveSeen() { try { localStorage.setItem('hub.seen', JSON.stringify(S.seen)); } catch {} }
function markSeen(id) { const s = S.sessions.get(id); if (!s) return; if (S.seen[id] !== s.updatedAt) { S.seen[id] = s.updatedAt; saveSeen(); } }
function initSeen() { if (S.seenInit) return; for (const s of S.sessions.values()) S.seen[s.id] = s.updatedAt; S.seenInit = true; saveSeen(); }
const isUnread = (s) => s.id !== S.current && s.status !== 'running' && s.jobCount > 0 && (!S.seen[s.id] || S.seen[s.id] < s.updatedAt);

/* ================= 왼쪽: 세션 목록 ================= */
let treeQ = false;
function renderTree() {
  if (treeQ) return; treeQ = true;
  requestAnimationFrame(() => {
    treeQ = false;
    if (S.current) markSeen(S.current);
    const all = [...S.sessions.values()].filter((s) => !s.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); // 보관한 세션은 보관함(sessions-ui.js)에서만
    const pinned = all.filter((s) => s.pinned).sort((a, b) => a.pinned.localeCompare(b.pinned));
    const rest = all.filter((s) => !s.pinned);
    const view = S.prefs.sideView || 'folder';
    let h = '';
    if (!S.current) h += `<div class="sess on draft" title="${esc(currentCwd())}"><span class="s-ic">${icon('newchat')}</span><span class="t">새 세션</span><span class="meta">${esc(shortPath(currentCwd(), 1))}</span></div>`;
    if (pinned.length) h += section('pinned', '고정됨', pinned.map((s) => rowHtml(s, true)).join(''));
    const viewBtn = `<button class="sec-btn" data-view title="보기 방식 바꾸기">${view === 'folder' ? '폴더별' : '날짜별'}${icon('down')}</button>`;
    let body = '';
    if (view === 'folder') {
      const groups = new Map();
      for (const s of rest) { const home = s.git?.isolated && s.git.repo ? s.git.repo : s.cwd; const k = home.toLowerCase(); if (!groups.has(k)) groups.set(k, { cwd: home, list: [] }); groups.get(k).list.push(s); } // 격리(worktree) 세션은 원본 저장소 폴더 아래에 묶는다
      const cur = currentCwd().toLowerCase();
      if (!S.current && cur && !groups.has(cur)) groups.set(cur, { cwd: currentCwd(), list: [] });
      for (const [k, g] of groups) {
        const closed = S.collapsedFolders.has(k);
        const live = g.list.some((s) => s.status === 'running');
        body += `<div class="group"><div class="ghead ${closed ? 'closed' : ''}" data-folder="${esc(g.cwd)}" title="${esc(g.cwd)}" role="treeitem" aria-expanded="${!closed}">
          <span class="chev">${icon('right')}</span><span class="g-ic">${icon('folder')}</span><span class="gname">${esc(shortPath(g.cwd))}</span>${live ? '<span class="spin-xs"></span>' : `<span class="gcount">${g.list.length || ''}</span>`}
          <span class="gacts"><button class="mini" data-newin="${esc(g.cwd)}" title="이 폴더에서 새 세션">${icon('plus')}</button><button class="mini" data-fmenu="${esc(g.cwd)}" title="폴더 메뉴">${icon('more')}</button></span></div>`;
        if (!closed) body += `<div class="gbody">${g.list.map((s) => rowHtml(s)).join('') || '<div class="empty-row">아직 세션 없음</div>'}</div>`;
        body += '</div>';
      }
    } else {
      const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const bucket = (iso) => { const t = new Date(iso).getTime(); return t >= start ? '오늘' : t >= start - 86400000 ? '어제' : t >= start - 6 * 86400000 ? '지난 7일' : t >= start - 29 * 86400000 ? '지난 30일' : '이전'; };
      const groups = new Map();
      for (const s of rest) { const b = bucket(s.updatedAt); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(s); }
      for (const [b, list] of groups) body += `<div class="group"><div class="dhead">${b}</div>${list.map((s) => rowHtml(s, false, true)).join('')}</div>`;
    }
    h += section('recent', '세션', body || '<div class="empty-row">아직 세션이 없어요. 위의 새 세션으로 시작하세요.</div>', viewBtn);
    for (const f of window.hubTreeExtras || []) { try { h += f() || ''; } catch {} } // 확장: 기능 파일이 세션 목록 아래에 구역(보관함 등)을 더한다
    $('#tree').innerHTML = h;
    renderAccount();
  });
}
function section(id, label, inner, extra = '') {
  const closed = S.collapsedFolders.has(`sec:${id}`);
  return `<div class="sec ${closed ? 'closed' : ''}"><div class="sec-h"><button class="sec-t" data-sec="${id}">${esc(label)}<span class="chev">${icon('down')}</span></button>${extra}</div>${closed ? '' : `<div class="sec-b">${inner}</div>`}</div>`;
}
function rowHtml(s, pinnedRow = false, showFolder = false) {
  const unread = isUnread(s);
  const waiting = typeof hubSessionWaiting === 'function' && hubSessionWaiting(s.id); // 승인·질문 대기 (prompts.js)
  const ic = waiting ? `<span class="s-wait" title="승인 대기 중">${icon('bell')}</span>` : s.status === 'running' ? '<span class="spin-xs"></span>'
    : unread ? '<span class="dot-unread" title="새 결과"></span>'
    : s.status === 'failed' ? `<span class="c-err">${icon('alert')}</span>`
    : s.status === 'partial' ? `<span class="c-warn">${icon('alert')}</span>`
    : pinnedRow ? `<span class="c-muted">${icon('pin')}</span>` : '';
  const tip = `${s.title}\n${s.cwd}\n${ST_KO[s.status] || ''} · ${new Date(s.updatedAt).toLocaleString('ko-KR')}`;
  return `<div class="sess ${s.id === S.current ? 'on' : ''} ${unread ? 'unread' : ''} ${waiting ? 'waiting' : ''}" data-sid="${s.id}" tabindex="0" role="treeitem" title="${esc(tip)}">
    <span class="s-ic">${ic}</span><span class="t">${esc(s.title)}</span>${showFolder ? `<span class="meta f">${esc(shortPath(s.cwd, 1))}</span>` : `<span class="meta">${waiting ? '승인 대기' : s.status === 'running' ? '작업 중' : ago(s.updatedAt)}</span>`}
    <button class="row-more" data-more="${s.id}" title="더보기" tabindex="-1">${icon('more')}</button></div>`;
}

$('#tree').addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]'); if (v) return openViewMenu(v);
  const sec = e.target.closest('[data-sec]'); if (sec) { toggleKey(`sec:${sec.dataset.sec}`); return renderTree(); }
  const add = e.target.closest('[data-newin]'); if (add) { e.stopPropagation(); return newSession(add.dataset.newin); }
  const fm = e.target.closest('[data-fmenu]'); if (fm) { e.stopPropagation(); return openFolderMenu(fm.dataset.fmenu, fm); }
  const more = e.target.closest('[data-more]'); if (more) { e.stopPropagation(); return openSessionMenu(more.dataset.more, more); }
  const f = e.target.closest('[data-folder]'); if (f) { toggleKey(f.dataset.folder.toLowerCase()); return renderTree(); }
  const s = e.target.closest('[data-sid]'); if (s && !s.querySelector('input')) { openSession(s.dataset.sid); closeOverlays(); }
});
$('#tree').addEventListener('dblclick', (e) => { const s = e.target.closest('[data-sid]'); if (s) renameInline(s.dataset.sid, s.querySelector('.t')); });
$('#tree').addEventListener('contextmenu', (e) => {
  const s = e.target.closest('[data-sid]'); const f = e.target.closest('[data-folder]');
  if (!s && !f) return;
  e.preventDefault();
  const at = pointAnchor(e.clientX, e.clientY);
  if (s) openSessionMenu(s.dataset.sid, at); else openFolderMenu(f.dataset.folder, at);
});
$('#tree').addEventListener('keydown', (e) => {
  const rows = [...$('#tree').querySelectorAll('[data-sid]')]; const i = rows.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' && i >= 0) { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)].focus(); }
  if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); rows[Math.max(0, i - 1)].focus(); }
  if (e.key === 'Enter' && i >= 0) rows[i].click();
  if (e.key === 'F2' && i >= 0) renameInline(rows[i].dataset.sid, rows[i].querySelector('.t'));
  if (e.key === 'Delete' && i >= 0) deleteSession(rows[i].dataset.sid);
});
function toggleKey(k) { S.collapsedFolders.has(k) ? S.collapsedFolders.delete(k) : S.collapsedFolders.add(k); try { localStorage.setItem('hub.collapsed', JSON.stringify([...S.collapsedFolders])); } catch {} }
try { for (const k of JSON.parse(localStorage.getItem('hub.collapsed') || '[]')) S.collapsedFolders.add(k); } catch {}

const pointAnchor = (x, y) => ({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), contains: () => false });

function openViewMenu(anchor) {
  const v = S.prefs.sideView || 'folder';
  const set = (x) => { S.prefs.sideView = x; savePrefs(); closePop(); renderTree(); };
  openPop(anchor, [
    { header: '세션 묶기' },
    { label: '폴더별', desc: '작업 폴더마다 묶어서', icon: 'folder', checked: v === 'folder', run: () => set('folder') },
    { label: '날짜별', desc: '오늘 · 어제 · 지난 7일', icon: 'clock', checked: v === 'date', run: () => set('date') },
    { sep: true },
    { label: '폴더 모두 펼치기', icon: 'down', run: () => { for (const k of [...S.collapsedFolders]) if (!k.startsWith('sec:')) S.collapsedFolders.delete(k); toggleKey('__'); toggleKey('__'); closePop(); renderTree(); } },
  ], { below: true });
}
function openSessionMenu(id, anchor) {
  const s = S.sessions.get(id); if (!s) return;
  const live = sessionJobs(id).some((j) => LIVE.has(j.status));
  const row = $(`#tree [data-sid="${id}"]`);
  row?.classList.add('menu-open');
  openPop(anchor, [
    { label: '열기', icon: 'open', run: () => { closePop(); openSession(id); } },
    { label: s.pinned ? '고정 해제' : '고정', icon: s.pinned ? 'pinoff' : 'pin', run: () => { closePop(); setPinned(id, !s.pinned); } },
    { label: '이름 바꾸기', icon: 'pencil', kbd: 'F2', run: () => { closePop(); renameInline(id, row?.querySelector('.t')); } },
    { label: '폴더 열기', icon: 'folder', run: () => { closePop(); openPath(s.cwd); } },
    { label: '폴더 경로 복사', icon: 'copy', run: () => { closePop(); copyText(s.cwd, '폴더 경로를 복사했어요'); } },
    { label: '이 폴더에서 새 세션', icon: 'plus', run: () => { closePop(); newSession(s.cwd); } },
    ...(live ? [{ label: '실행 중인 작업 중지', icon: 'stop', run: () => { closePop(); for (const j of sessionJobs(id)) if (LIVE.has(j.status)) api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }); } }] : []),
    ...(window.hubSessionMenuItems || []).flatMap((f) => { try { return f(s, { live, anchor }) || []; } catch { return []; } }), // 확장: 기능 파일이 세션 메뉴 항목(보관·갈래·내보내기 등)을 더한다
    { sep: true },
    { label: '삭제', icon: 'trash', danger: true, kbd: 'Del', run: () => { closePop(); deleteSession(id); } },
  ], { below: true, onClose: () => row?.classList.remove('menu-open') });
}
function openFolderMenu(cwd, anchor) {
  const k = cwd.toLowerCase();
  openPop(anchor, [
    { label: '폴더 열기', icon: 'folder', run: () => { closePop(); openPath(cwd); } },
    { label: '이 폴더에서 새 세션', icon: 'plus', run: () => { closePop(); newSession(cwd); } },
    { label: '폴더 경로 복사', icon: 'copy', run: () => { closePop(); copyText(cwd, '폴더 경로를 복사했어요'); } },
    { label: S.collapsedFolders.has(k) ? '펼치기' : '접기', icon: S.collapsedFolders.has(k) ? 'down' : 'right', run: () => { closePop(); toggleKey(k); renderTree(); } },
  ], { below: true });
}
async function setPinned(id, pinned) { try { await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ pinned }) }); toast(pinned ? '고정했어요' : '고정을 해제했어요'); } catch (e) { toast(e.message, true); } }
async function deleteSession(id) {
  const s = S.sessions.get(id); if (!s) return;
  if (window.hubDeleteSession && window.hubDeleteSession(s)) return; // 확장: 기능 파일이 삭제를 대신 처리하면(격리 세션의 worktree 정리 선택 등) true
  if (!confirm(`"${s.title}" 세션을 목록에서 지울까요?\n작업 결과 파일과 실행 기록 폴더는 그대로 남습니다.`)) return;
  try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); toast('세션을 지웠어요'); } catch (e) { toast(e.message, true); }
}
function copyText(t, msg) { navigator.clipboard?.writeText(t).then(() => toast(msg), () => toast(t)); }

/** 제목 자리에서 바로 이름 바꾸기 (Enter 저장, Esc 취소) */
function renameInline(id, el) {
  const s = S.sessions.get(id); if (!s) return;
  if (!el) { el = id === S.current ? $('#title') : null; if (!el) return; }
  const inp = document.createElement('input');
  inp.className = 'rename'; inp.value = s.title; inp.maxLength = 80;
  const orig = el.innerHTML; el.innerHTML = ''; el.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    el.innerHTML = orig;
    if (save && v && v !== s.title) { el.textContent = v; try { await api(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: v }) }); } catch (e) { toast(e.message, true); renderTree(); } }
  };
  inp.addEventListener('keydown', (e) => { if (e.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } e.stopPropagation(); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}
$('#title').addEventListener('dblclick', () => { if (S.current) renameInline(S.current, $('#title')); });

/* ================= 왼쪽 아래: 사용량 · 계정 ================= */
// 한도는 남은 비율로 보여 준다(API 값은 사용률). 값이 없거나 숫자가 아니면 null = 미확인 — 100% 남음으로 치지 않는다
function quotaLeft(w) {
  const u = w?.usedPercent;
  if (u == null || u === '' || !Number.isFinite(Number(u))) return null;
  return Math.max(0, Math.min(100, 100 - Number(u)));
}
// 한도 창 길이(분): Codex 는 key 가 w<분>, Claude 는 5시간·주간(모델 전용 한도도 주간)
function windowMinutes(w) {
  const m = /^w([0-9]+)$/.exec(w?.key || ''); if (m) return Number(m[1]) || null;
  if (w?.key === 'five_hour' || w?.label === '5시간') return 300;
  if (w?.key === 'seven_day' || w?.scope === 'model' || /주간/.test(w?.label || '')) return 10080;
  return null;
}
// 초기화까지 남은 시간을 창 길이에 대한 비율(0~100)로. 창 길이·초기화 시각을 모르면 null
function timeLeftPct(w) {
  const len = windowMinutes(w), t = w?.resetsAt ? new Date(w.resetsAt).getTime() : NaN;
  if (!len || !Number.isFinite(t)) return null;
  return Math.max(0, Math.min(100, ((t - Date.now()) / 60000 / len) * 100));
}
// 막대 위 눈금 = 남은 시간 비율. 막대(남은 한도)가 눈금보다 길면 지금 속도로 초기화까지 버틴다
const tickHtml = (tp) => (tp == null ? '' : `<b class="u-tick" style="left:${tp.toFixed(1)}%"></b>`);
const tickText = (tp) => (tp == null ? '' : ` · 남은 시간 ${Math.round(tp)}%`);
// 막대 색: 기존 기준(사용 60%·80% 이상) = 남은 40%·20% 이하. 경고 줄 기준은 commands.js
const leftTone = (r) => (r <= 20 ? 'hi' : r <= 40 ? 'mid' : '');
const leftText = (r, w) => `${Math.round(r)}% 남음${w?.resetsAt ? ` · ${resetPhrase(w.resetsAt)}` : ''}`;
// 막대 하나의 접근성 속성 (미확인이면 숫자 없이 이름만)
const meterAria = (tool, label, r, w) => r == null
  ? `role="img" aria-label="${esc(`${tool === 'claude' ? 'Claude' : 'Codex'} ${label} 한도 미확인`)}"`
  : `role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(r)}" aria-valuetext="${esc(leftText(r, w))}" aria-label="${esc(`${tool === 'claude' ? 'Claude' : 'Codex'} ${label} 남은 한도`)}"`;
// 한도 한 줄: 창 · 막대 · 남은 % · 초기화까지. AI 이름은 머리줄로 올려 막대 폭을 넓힌다 (2026-10-04 "가시성 올리고 리셋까지 남은 기간도")
function uRow(tool, { tag, label, w }) {
  const r = quotaLeft(w);
  const tp = r == null ? null : timeLeftPct(w);
  const tip = `title="${esc(`${tool === 'claude' ? 'Claude' : 'Codex'} ${label} 한도 ${r == null ? '기록 없음' : leftText(r, w) + tickText(tp)}`)}"`;
  if (r == null) return `<span class="u-l" ${tip}>${esc(tag)}</span><div class="meter" ${meterAria(tool, label, r, w)} ${tip}><i style="width:0"></i></div><span class="p na" aria-hidden="true" ${tip}>–</span><span class="u-rs na" aria-hidden="true" ${tip}>기록 없음</span>`;
  return `<span class="u-l" ${tip}>${esc(tag)}</span><div class="meter ${tool} ${leftTone(r)}${tp == null ? '' : ' has-tick'}" ${meterAria(tool, label, r, w)} ${tip}><i style="width:${r}%"></i>${tickHtml(tp)}</div><span class="p ${leftTone(r)}" aria-hidden="true" ${tip}>${Math.round(r)}%</span><span class="u-rs" aria-hidden="true" ${tip}>${esc(resetIn(w?.resetsAt) || '–')}</span>`;
}
function renderUsage() {
  const u = S.usage; const el = $('#usage');
  if (!u) { el.innerHTML = '<div class="c-muted u-load">사용량 불러오는 중…</div>'; return; }
  const rows = [];
  const add = (tool, name, x) => {
    const all = ['5시간', '주간'].map((l) => ({ tag: l, label: l, w: x?.windows?.find((y) => y.label === l && y.scope !== 'model') }));
    for (const w of (x?.windows || []).filter((y) => y.scope === 'model')) all.push({ tag: w.label.replace(' 주간', ''), label: w.label, w });
    // 기록 없는 창(대개 Codex 5시간)은 줄을 차지하지 않는다. 전부 없으면 주간 한 줄만 '기록 없음' — 자세한 건 오른쪽 사용량 탭
    let shown = all.filter((c) => quotaLeft(c.w) != null);
    if (!shown.length) shown = [all[1]];
    rows.push(`<span class="u-name"><i style="background:var(--${tool})"></i>${name}${x?.plan ? `<small>${esc(String(x.plan).toUpperCase())}</small>` : ''}</span>`, ...shown.map((c) => uRow(tool, c)));
  };
  add('claude', 'Claude', u.claude); add('codex', 'Codex', u.codex);
  el.innerHTML = `<div class="u-grid"><span class="u-cap">남은 한도</span><span class="u-cap r" title="막대 위 눈금 = 초기화까지 남은 시간 비율. 막대가 눈금보다 길면 지금 속도로 초기화까지 넉넉해요"><i class="u-tick-key"></i>초기화까지</span>${rows.join('')}</div>`;
  if (S.insp?.tab === 'usage') renderInspector();
}
// 초기화까지 남은 시간이 흐르도록 1분마다 다시 그린다
setInterval(() => { if (S.usage) renderUsage(); }, 60_000);
$('#usage').addEventListener('click', () => showUsage());

function renderAccount() {
  const t = S.tools; const user = S.cfg?.user || '로컬';
  const ok = t ? ['claude', 'codex'].filter((n) => t[n]?.ok).length : 0;
  const live = [...S.sessions.values()].filter((s) => s.status === 'running').length;
  const crit = S.usage && ['claude', 'codex'].some((n) => (S.usage[n]?.windows || []).some((w) => w.usedPercent >= 95));
  $('#btnAccount').classList.toggle('crit', !!crit);
  $('#btnAccount').innerHTML = `<span class="avatar-u">${esc(user.slice(0, 1).toUpperCase())}</span><span class="acc-t"><b>${esc(user)}</b><small>${t ? `AI ${ok}/2 연결${live ? ` · ${live}개 작업 중` : ''}` : '연결 확인 중…'}</small></span><span class="acc-dots">${t ? ['claude', 'codex'].map((n) => `<i class="${t[n]?.ok ? 'on' : 'off'}" style="--c:var(--${n})" title="${n} ${t[n]?.ok ? '연결됨' : '사용 불가'}"></i>`).join('') : ''}</span>${icon('updown')}`;
}
$('#btnAccount').addEventListener('click', (e) => {
  openPop(e.currentTarget, [
    { header: `${S.cfg?.user ? `${S.cfg.user} · ` : ''}${typeof isRemoteView === 'function' && isRemoteView() ? `원격 · ${location.host}` : `로컬 허브 :${S.cfg?.port || location.port}`}` },
    { label: '설정 및 상태', icon: 'gear', run: () => { closePop(); openSettings(); } },
    { label: '원격 접속', icon: 'globe', run: () => { closePop(); openSettings('remoteSec'); } },
    { label: '키보드 단축키', icon: 'keyboard', run: () => { closePop(); openSettings('keys'); } },
    { label: '사용량 새로고침', icon: 'refresh', run: () => { closePop(); showUsage(); } },
    { sep: true },
    { label: '작업 보드', icon: 'board', run: () => { closePop(); openBoard(); } },
    { label: '공유 메모리', icon: 'book', run: () => { closePop(); openMemory(); } },
  ]);
});

/* ================= 오른쪽 패널 ================= */
const TABS = [['tasks', '작업', 'list'], ['usage', '사용량', 'gauge'], ['info', '정보', 'info']]; // '파일' 탭은 changes.js 의 '변경' 탭에 합쳤다 (filesPane 은 그 탭의 대체 목록으로 쓴다)
// 확장 탭: 기능 파일이 window.hubTabs.push({ key, label, icon, render(body, session) })로 오른쪽 패널에 탭을 더한다 ('작업' 다음에 끼운다)
window.hubTabs = window.hubTabs || [];
const allTabs = () => [TABS[0], ...window.hubTabs.map((t) => [t.key, t.label, t.icon]), ...TABS.slice(1)];
S.insp = { tab: S.prefs.inspTab || 'tasks' };
function renderInspTabs() {
  $('#inspTabs').innerHTML = allTabs().map(([k, l, i]) => `<button class="tab ${S.insp.tab === k ? 'on' : ''}" data-tab="${k}" role="tab" aria-selected="${S.insp.tab === k}">${icon(i)}<span>${l}</span></button>`).join('');
}
$('#inspTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; S.insp.tab = b.dataset.tab; S.prefs.inspTab = b.dataset.tab; savePrefs(); renderInspTabs(); renderInspector(); });
let inspT = null;
function scheduleInspector() { if (!inspOpen()) return; clearTimeout(inspT); inspT = setTimeout(renderInspector, 200); }
const inspOpen = () => !$('#app').classList.contains('insp-off');

function renderInspector() {
  if (!inspOpen()) return;
  const body = $('#inspBody'); const s = S.sessions.get(S.current);
  const keep = body.scrollTop;
  const tab = S.insp.tab;
  const ext = window.hubTabs.find((t) => t.key === tab);
  if (ext) { try { ext.render(body, s || null); } catch (e) { body.innerHTML = `<div class="insp-empty"><p>${esc(e.message)}</p></div>`; } body.scrollTop = keep; return; }
  if (tab === 'usage') body.innerHTML = usagePane();
  else if (!s) body.innerHTML = `<div class="insp-empty">${icon((allTabs().find((t) => t[0] === tab) || TABS[0])[2])}<p>세션을 열면 ${tab === 'tasks' ? '진행 상황이' : tab === 'files' ? '바뀐 파일이' : '세션 정보가'} 여기에 보여요</p></div>`;
  else if (tab === 'tasks') body.innerHTML = tasksPane(s);
  else if (tab === 'files') body.innerHTML = filesPane(s);
  else body.innerHTML = infoPane(s);
  body.scrollTop = keep;
}

function tasksPane(s) {
  const jobs = sessionJobs(s.id);
  if (!jobs.length) return `<div class="insp-empty">${icon('list')}<p>아직 보낸 요청이 없어요</p></div>`;
  const cur = jobs.find((j) => LIVE.has(j.status)) || jobs.at(-1);
  const done = cur.tasks.filter((t) => t.status === 'done').length;
  const pct = cur.tasks.length ? Math.round((done / cur.tasks.length) * 100) : (LIVE.has(cur.status) ? 8 : 100);
  let h = `<div class="card"><div class="card-h"><span class="badge s-${cur.status}">${LIVE.has(cur.status) ? '<span class="spin-xs"></span>' : ''}${ST_KO[cur.status] || cur.status}</span><span class="c-muted">${LIVE.has(cur.status) ? `<span class="live-dur" data-from="${cur.startedAt || cur.createdAt}"></span>` : dur(cur.startedAt || cur.createdAt, cur.finishedAt)}</span></div>
    <div class="card-t" data-goto="${cur.id}">${esc(cur.goal.split('\n')[0])}</div>
    <div class="prog"><i style="width:${pct}%"></i></div><div class="prog-l">${cur.tasks.length ? `${done}/${cur.tasks.length}개 완료` : cur.status === 'planning' ? (cur.phase === 'routing' ? '모델 고르는 중' : '계획 세우는 중') : ''}</div>`;
  if (cur.summary && cur.mode === 'auto') h += `<div class="card-sum">${esc(cur.summary)}</div>`;
  h += `<div class="tlist">${cur.tasks.map((t) => `<button class="trow2" data-goto="${cur.id}" data-task="${t.id}" title="${esc(t.title)}${t.reason ? '\n선택 이유: ' + esc(t.reason) : ''}">${stIcon(t.status)}<span class="prov ${t.assignee}">${t.assignee === 'claude' ? 'C' : 'X'}</span>${t.agent ? `<span class="agent-chip">${esc(agentLabel(t.agent))}</span>` : ''}<span class="tt">${esc(t.title)}</span><span class="tm">${t.status === 'running' ? `<span class="live-dur" data-from="${t.startedAt}"></span>` : t.finishedAt ? dur(t.startedAt, t.finishedAt) : ''}</span></button><div class="tsub">${esc([t.model ? `${t.autoPicked ? '✦ ' : ''}${t.model.replace(/^claude-|-\d{8}$/g, '')}` : '', t.effort, t.toolCalls ? `도구 ${t.toolCalls}` : ''].filter(Boolean).join(' · '))}</div>`).join('')}</div></div>`;
  if (s.goal) h = `<div class="card goal-card"><div class="card-h"><span class="badge s-${s.goal.status === 'active' ? 'running' : s.goal.status === 'done' ? 'done' : 'partial'}">목표 · ${esc(GOAL_KO[s.goal.status] || s.goal.status)}</span><span class="c-muted">${s.goal.round}/${s.goal.maxRounds}라운드 · ${Math.round(s.goal.progress || 0)}%</span></div><div class="card-t">${esc(s.goal.text)}</div><div class="prog"><i style="width:${Math.round(s.goal.progress || 0)}%"></i></div>${s.goal.remaining ? `<div class="card-sum">남은 일: ${esc(s.goal.remaining)}</div>` : ''}</div>` + h;
  const prev = jobs.filter((j) => j !== cur).reverse();
  if (prev.length) h += `<div class="ilabel">이전 요청 ${prev.length}</div><div class="hist">${prev.map((j) => `<button class="hrow" data-goto="${j.id}">${stIcon(j.status)}<span class="tt">${esc(j.goal.split('\n')[0])}</span><span class="tm">${hm(j.createdAt)}</span></button>`).join('')}</div>`;
  return h;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
function touchedFiles(s) {
  const map = new Map();
  for (const j of sessionJobs(s.id)) for (const t of j.tasks) for (const e of S.logs.get(`${j.id}/${t.id}`) || []) {
    if (e.kind !== 'tool' || !EDIT_TOOLS.has(e.name) || !e.detail) continue;
    const parts = t.assignee === 'codex' ? String(e.detail).split(/,\s*/).map((x) => { const m = x.match(/^(add|update|delete|modify)?\s*(.+)$/i); return { kind: (m?.[1] || 'update').toLowerCase(), p: m?.[2] || x }; }) : [{ kind: e.name === 'Write' ? 'write' : 'update', p: e.detail }];
    for (const { kind, p } of parts) {
      const k = p.trim().toLowerCase(); if (!k) continue;
      const r = map.get(k) || { path: p.trim(), n: 0, who: new Set(), kinds: new Set(), at: e.at };
      r.n++; r.who.add(t.assignee); r.kinds.add(kind); if (e.at > r.at) r.at = e.at; map.set(k, r);
    }
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}
function filesPane(s) {
  const files = touchedFiles(s);
  if (!files.length) return `<div class="insp-empty">${icon('file')}<p>이 세션에서 고친 파일이 아직 없어요</p><small>Claude·Codex가 파일을 만들거나 고치면 여기에 모여요</small></div>`;
  const rel = (p) => { const c = s.cwd.replace(/[\\/]+$/, ''); return p.toLowerCase().startsWith(c.toLowerCase()) ? p.slice(c.length).replace(/^[\\/]/, '') : p; };
  const kindKo = (r) => (r.kinds.has('add') || r.kinds.has('write') ? '추가' : r.kinds.has('delete') ? '삭제' : '수정');
  return `<div class="ilabel">바뀐 파일 ${files.length}</div><div class="flist">${files.map((r) => { const rp = rel(r.path); const name = rp.split(/[\\/]/).pop(); const dir = rp.slice(0, rp.length - name.length); return `<button class="frow" data-open="${esc(r.path)}" title="${esc(r.path)}\n눌러서 열기 · 오른쪽 클릭으로 경로 복사"><span class="f-ic">${icon('file')}</span><span class="fn"><b>${esc(name)}</b><small>${esc(dir || '.')}</small></span><span class="fk k-${kindKo(r)}">${kindKo(r)}</span>${[...r.who].map((w) => `<span class="prov ${w}">${w === 'claude' ? 'C' : 'X'}</span>`).join('')}</button>`; }).join('')}</div>`;
}
function usagePane() {
  const u = S.usage;
  const block = (name, label, x) => {
    let h = `<div class="card"><div class="card-h"><b class="c-${name}">${label}</b><span class="c-muted">${esc([x?.plan?.toUpperCase(), x?.source].filter(Boolean).join(' · '))}</span></div>`;
    // 5시간·주간은 늘 보이고, 그 밖에 받은 한도(모델 전용, Codex 다른 길이 창)도 모두 보인다
    const labels = [...new Set(['5시간', '주간', ...(x?.windows || []).map((y) => y.label)])];
    for (const w of labels) {
      const v = x?.windows?.find((y) => y.label === w); const r = quotaLeft(v);
      if (r == null) { h += `<div class="ubig na"><div class="ubig-h"><span>${esc(w)} 한도</span><span>기록 없음</span></div><div class="meter" ${meterAria(name, w, r, v)}><i style="width:0"></i></div></div>`; continue; }
      h += `<div class="ubig"><div class="ubig-h"><span>${esc(w)} 한도</span><b class="${leftTone(r)}">${Math.round(r)}%<span class="u-unit">남음</span></b></div><div class="meter lg ${name} ${leftTone(r)}${timeLeftPct(v) == null ? '' : ' has-tick'}" ${meterAria(name, w, r, v)}><i style="width:${r}%"></i>${tickHtml(timeLeftPct(v))}</div>${v.resetsAt ? `<small class="u-reset">${icon('clock')}${esc(resetPhrase(v.resetsAt) + tickText(timeLeftPct(v)))}</small>` : ''}</div>`;
    }
    if (x?.observedAt) h += `<small class="c-muted">${hm(x.observedAt)} 기준${x.status === 'stale' ? ' · 지난 기록' : ''}</small>`;
    return h + '</div>';
  };
  return (!u ? '<div class="insp-empty"><p>불러오는 중…</p></div>' : block('claude', 'Claude', u.claude) + block('codex', 'Codex', u.codex))
    + `<button class="btn wide" data-usage-refresh>${icon('refresh')}새로고침</button><p class="fine">Claude는 CLI에서 실시간으로 조회해요. Codex는 최근 실행 기록에 남은 값이라 5시간 한도가 비어 있을 수 있어요. 숫자와 막대는 남은 한도이고, 막대 위 흰 눈금은 초기화까지 남은 시간의 비율이에요. 막대가 눈금보다 길면 지금 속도로 초기화까지 넉넉하고, 짧으면 그 전에 바닥날 수 있어요. 자동 분배는 남은 한도에 맞춰 Claude·Codex 비중을 나누고, 남은 한도가 5% 이하인 쪽 작업은 다른 AI로 넘겨요. Fable 주간 한도가 25% 이하로 남으면 자동 선택이 Opus로 바꾸고, 디자인 기획은 Codex의 GPT-6-Astra에 넘겨요.</p>`;
}
function infoPane(s) {
  const jobs = sessionJobs(s.id);
  const total = jobs.reduce((a, j) => a + (j.finishedAt && j.startedAt ? new Date(j.finishedAt) - new Date(j.startedAt) : 0), 0) / 1000 | 0;
  const cost = jobs.reduce((a, j) => a + j.tasks.reduce((b, t) => b + (t.costUsd || 0), 0), 0);
  const models = [...new Set(jobs.flatMap((j) => j.tasks.map((t) => t.model && `${t.model.replace(/^claude-|-\d{8}$/g, '')}${t.effort ? '·' + t.effort : ''}`)).filter(Boolean))];
  const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  return `<div class="card">${kv('이름', `<button class="link" data-rename-cur>${esc(s.title)}</button>`)}${kv('폴더', `<button class="link mono" data-open="${esc(s.cwd)}" title="눌러서 탐색기로 열기 · 오른쪽 클릭으로 경로 복사">${esc(s.cwd)}</button>`)}${kv('만든 시각', new Date(s.createdAt).toLocaleString('ko-KR'))}${kv('마지막 활동', new Date(s.updatedAt).toLocaleString('ko-KR'))}${kv('요청', `${jobs.length}개`)}${kv('총 실행 시간', total ? dur(new Date(0).toISOString(), new Date(total * 1000).toISOString()) : '–')}${kv('API 환산', cost ? `≈ $${cost.toFixed(2)} <small class="c-muted">(구독이라 실제 과금 아님)</small>` : '–')}${kv('쓴 모델', models.length ? models.map((m) => `<span class="tag">${esc(m)}</span>`).join(' ') : '–')}${kv('세션 ID', `<span class="mono c-muted">${esc(s.id)}</span>`)}</div>
    <div class="ibtns"><button class="btn" data-pin-cur>${icon(s.pinned ? 'pinoff' : 'pin')}${s.pinned ? '고정 해제' : '고정'}</button><button class="btn" data-newin-cur>${icon('plus')}같은 폴더 새 세션</button><button class="btn danger" data-del-cur>${icon('trash')}삭제</button></div>`;
}

$('#inspBody').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]'); if (g) return gotoJob(g.dataset.goto, g.dataset.task);
  const c = e.target.closest('[data-copy]'); if (c) return copyText(c.dataset.copy, '경로를 복사했어요');
  if (e.target.closest('[data-usage-refresh]')) return showUsage();
  if (e.target.closest('[data-rename-cur]')) return renameInline(S.current, $('#title'));
  if (e.target.closest('[data-pin-cur]')) { const s = S.sessions.get(S.current); return s && setPinned(s.id, !s.pinned); }
  if (e.target.closest('[data-newin-cur]')) return newSession(currentCwd());
  if (e.target.closest('[data-del-cur]')) return S.current && deleteSession(S.current);
});
function gotoJob(jobId, taskId) {
  if (taskId) { S.open.add(`${jobId}/${taskId}`); rerenderJob(jobId); }
  const el = taskId ? document.querySelector(`#job-${CSS.escape(jobId)} [data-toggle="${jobId}/${taskId}"]`) : document.getElementById(`job-${jobId}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1200);
  if (window.innerWidth <= 1100) closeOverlays();
}

/* ================= 레이아웃: 접기 · 패널 · 크기 조절 ================= */
const W = { left: [220, 420, 272], right: [280, 560, 340] };
function applyLayout() {
  const app = $('#app'); const narrow = window.innerWidth <= 860; const mid = window.innerWidth <= 1100;
  app.style.setProperty('--lw', `${S.prefs.lw || W.left[2]}px`);
  app.style.setProperty('--rw', `${S.prefs.rw || W.right[2]}px`);
  app.classList.toggle('collapsed', !narrow && !!S.prefs.collapsed);
  // 넓은 화면은 저장된 설정, 좁은 화면(겹쳐 뜨는 패널)은 이번에 직접 연 경우에만
  const inspWanted = !mid ? (S.prefs.insp ?? window.innerWidth >= 1280) : !!S.inspFloat;
  app.classList.toggle('insp-off', !inspWanted);
  app.classList.toggle('insp-float', inspWanted && mid);
  $('#btnInsp').classList.toggle('on', inspWanted);
  $('#scrim').hidden = !(app.classList.contains('side-open') || (inspWanted && mid));
  if (inspWanted) { renderInspTabs(); renderInspector(); }
}
function toggleLeft() { if (window.innerWidth <= 860) { $('#app').classList.toggle('side-open'); applyLayout(); } else { S.prefs.collapsed = !S.prefs.collapsed; savePrefs(); applyLayout(); } }
function toggleRight(force) {
  if (window.innerWidth <= 1100) { S.inspFloat = force ?? !S.inspFloat; return applyLayout(); }
  const cur = S.prefs.insp ?? window.innerWidth >= 1280; S.prefs.insp = force ?? !cur; savePrefs(); applyLayout();
}
function closeOverlays() { $('#app').classList.remove('side-open'); S.inspFloat = false; applyLayout(); }
$('#btnCollapse').addEventListener('click', toggleLeft);
$('#btnSide').addEventListener('click', toggleLeft);
$('#btnInsp').addEventListener('click', () => toggleRight());
$('#btnInspClose').addEventListener('click', () => toggleRight(false));
$('#scrim').addEventListener('click', closeOverlays);
window.addEventListener('resize', () => { clearTimeout(applyLayout.t); applyLayout.t = setTimeout(applyLayout, 80); });

document.querySelectorAll('.resizer').forEach((r) => {
  const edge = r.dataset.edge; const [min, max, def] = W[edge];
  r.addEventListener('pointerdown', (e) => {
    e.preventDefault(); r.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
    const startX = e.clientX; const start = S.prefs[edge === 'left' ? 'lw' : 'rw'] || def;
    const move = (ev) => {
      const d = edge === 'left' ? ev.clientX - startX : startX - ev.clientX;
      const v = Math.round(Math.max(min, Math.min(max, start + d)));
      S.prefs[edge === 'left' ? 'lw' : 'rw'] = v; $('#app').style.setProperty(edge === 'left' ? '--lw' : '--rw', `${v}px`);
    };
    const up = () => { r.removeEventListener('pointermove', move); r.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); savePrefs(); };
    r.addEventListener('pointermove', move); r.addEventListener('pointerup', up);
  });
  r.addEventListener('dblclick', () => { S.prefs[edge === 'left' ? 'lw' : 'rw'] = def; savePrefs(); applyLayout(); });
});

/* ================= 검색 팔레트 (Ctrl+K) ================= */
const PAL = { items: [], sel: 0 };
function openPalette() { $('#palette').hidden = false; $('#palQ').value = ''; renderPalette(); $('#palQ').focus(); }
function closePalette() { $('#palette').hidden = true; }
function renderPalette() {
  const q = $('#palQ').value.trim().toLowerCase();
  const cmds = [
    { label: '새 세션', desc: shortPath(currentCwd(), 2), icon: 'newchat', kbd: 'Ctrl ⇧ N', run: () => newSession(currentCwd()) },
    { label: '다른 폴더에서 새 세션…', icon: 'folder', run: () => openFolderPicker($('#folderChip')) },
    { label: '작업 보드 열기', icon: 'board', run: openBoard },
    { label: '공유 메모리 열기', icon: 'book', run: () => openMemory() },
    { label: '사이드바 열기·닫기', icon: 'panel', kbd: 'Ctrl B', run: toggleLeft },
    { label: '오른쪽 패널 열기·닫기', icon: 'panelR', kbd: 'Ctrl J', run: () => toggleRight() },
    { label: '사용량 새로고침', icon: 'refresh', run: showUsage },
    { label: '설정 및 상태', icon: 'gear', run: () => openSettings() },
    { label: '원격 접속 (다른 컴퓨터에서 열기)', icon: 'globe', run: () => openSettings('remoteSec') },
    ...(window.hubCommands || []).flatMap((f) => { try { return f() || []; } catch { return []; } }), // 확장: 기능 파일이 window.hubCommands.push(() => [{ label, desc, icon, kbd, run }]) 로 명령을 더한다
  ].filter((c) => !q || c.label.toLowerCase().includes(q));
  const hit = (s) => {
    if (!q) return { score: 1, snip: '' };
    if (s.title.toLowerCase().includes(q)) return { score: 3, snip: '' };
    if (s.cwd.toLowerCase().includes(q)) return { score: 2, snip: s.cwd };
    for (const j of sessionJobs(s.id)) { const g = j.goal.toLowerCase(); const i = g.indexOf(q); if (i >= 0) return { score: 1, snip: '…' + j.goal.slice(Math.max(0, i - 12), i + 40).replace(/\s+/g, ' ') + '…' }; }
    return null;
  };
  const sess = [...S.sessions.values()].map((s) => ({ s, h: hit(s) })).filter((x) => x.h).sort((a, b) => b.h.score - a.h.score || b.s.updatedAt.localeCompare(a.s.updatedAt)).slice(0, 30)
    .map(({ s, h }) => ({ label: s.title, desc: h.snip || `${shortPath(s.cwd, 2)} · ${ago(s.updatedAt)}`, icon: s.status === 'running' ? 'spin' : s.pinned ? 'pin' : 'chat', run: () => openSession(s.id) }));
  PAL.items = [...(q ? sess : []), ...cmds, ...(q ? [] : sess.slice(0, 8))];
  PAL.sel = Math.min(PAL.sel, Math.max(0, PAL.items.length - 1));
  let idx = -1; const head = (t) => `<div class="pal-h">${t}</div>`;
  const rowsOf = (list) => list.map((it) => { idx++; return `<div class="pal-i ${idx === PAL.sel ? 'sel' : ''}" data-pi="${idx}">${it.icon === 'spin' ? '<span class="spin-xs"></span>' : icon(it.icon)}<span class="l"><b>${hl(it.label, q)}</b>${it.desc ? `<small>${esc(it.desc)}</small>` : ''}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</div>`; }).join('');
  let h = '';
  if (q) { if (sess.length) h += head('세션') + rowsOf(sess); if (cmds.length) h += head('명령') + rowsOf(cmds); }
  else { h += head('명령') + rowsOf(cmds); if (sess.length) h += head('최근 세션') + rowsOf(sess.slice(0, 8)); }
  $('#palList').innerHTML = h || `<div class="pal-empty">"${esc(q)}"에 맞는 결과가 없어요</div>`;
  $('#palList').querySelector('.pal-i.sel')?.scrollIntoView({ block: 'nearest' });
}
function hl(t, q) { const s = esc(t); if (!q) return s; const i = t.toLowerCase().indexOf(q); return i < 0 ? s : esc(t.slice(0, i)) + `<mark>${esc(t.slice(i, i + q.length))}</mark>` + esc(t.slice(i + q.length)); }
function palRun(i) { const it = PAL.items[i]; if (!it) return; closePalette(); it.run(); }
$('#palQ').addEventListener('input', () => { PAL.sel = 0; renderPalette(); });
$('#palQ').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); PAL.sel = (PAL.sel + 1) % Math.max(1, PAL.items.length); renderPalette(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); PAL.sel = (PAL.sel - 1 + PAL.items.length) % Math.max(1, PAL.items.length); renderPalette(); }
  if (e.key === 'Enter') { e.preventDefault(); palRun(PAL.sel); }
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); input.focus(); }
});
$('#palList').addEventListener('mousedown', (e) => { const p = e.target.closest('[data-pi]'); if (p) { e.preventDefault(); palRun(Number(p.dataset.pi)); } });
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });
$('#btnSearch').addEventListener('click', openPalette);

/* ================= 설정 및 상태 ================= */
async function openSettings(focus) {
  const body = modal('설정 및 상태', true);
  try { const st = await api('/api/status?force=1'); S.tools = st.tools; S.cfg = st.config; S.caps = st.capabilities || {}; renderAccount(); renderSend(); } catch {}
  const t = S.tools || {}; const c = S.cfg || {};
  const ai = (n, label) => { const x = t[n] || {}; return `<div class="set-row"><span class="set-k"><i class="sd ${x.ok ? 'on' : 'off'}"></i>${label}</span><span>${esc(x.version || '미설치')}${x.ok ? ' · 로그인됨' : `<br><span class="c-err">${esc(x.fix || '사용 불가')}</span>`}</span></div>`; };
  const fl = c.autoFloor || {};
  const view = S.prefs.sideView || 'folder';
  const localUrl = `http://127.0.0.1:${c.port || location.port}`;
  body.innerHTML = `<div class="settings">
    <section><h3>AI 연결</h3>${ai('claude', 'Claude Code')}${ai('codex', 'Codex')}<p class="fine">Codex는 Codex 앱이 받아 둔 가장 새 CLI를 자동으로 써요.</p></section>
    <section id="remoteSec" class="rm"></section>
    <section><h3>자동(알잘딱) 기준</h3><div class="set-row"><span class="set-k">Claude 최소</span><span>${esc(fl.claude?.model || 'opus')} · ${esc(fl.claude?.effort || 'high')} 이상</span></div><div class="set-row"><span class="set-k">Codex 최소</span><span>${esc(fl.codex?.model || 'gpt-6.1-sol')} · ${esc(fl.codex?.effort || 'high')} 이상</span></div><p class="fine">바꾸려면 <span class="mono">${esc(c.configFile || 'config.json')}</span>의 autoFloor 를 고친 뒤 서버를 다시 시작하세요.</p></section>
    <section><h3>화면</h3><div class="set-row"><span class="set-k">세션 묶기</span><span class="seg2"><button data-setview="folder" class="${view === 'folder' ? 'on' : ''}">폴더별</button><button data-setview="date" class="${view === 'date' ? 'on' : ''}">날짜별</button></span></div><div class="set-row"><span class="set-k">오른쪽 패널</span><span class="seg2"><button data-setinsp="1" class="${S.prefs.insp !== false ? 'on' : ''}">열기</button><button data-setinsp="0" class="${S.prefs.insp === false ? 'on' : ''}">닫기</button></span></div><div class="set-row"><span class="set-k">패널 너비</span><span><button class="link" data-resetw>기본 너비로 되돌리기</button></span></div></section>
    <section id="keys"><h3>키보드 단축키</h3>${[['Ctrl K', '검색'], ['Ctrl Shift N', '새 세션'], ['Ctrl B', '왼쪽 사이드바'], ['Ctrl J', '오른쪽 패널'], ['Enter / Shift+Enter', '보내기 / 줄바꿈'], ['↑ (빈 입력창)', '이전 요청 불러오기'], ['F2 · Del (세션 목록)', '이름 바꾸기 · 삭제'], ['오른쪽 클릭 (세션)', '세션 메뉴'], ['Esc', '메뉴·창 닫기']].map(([k, d]) => `<div class="set-row"><span class="set-k"><kbd>${k}</kbd></span><span>${d}</span></div>`).join('')}</section>
    <section><h3>허브</h3><div class="set-row"><span class="set-k">주소</span><span class="mono">${esc(location.origin)}</span></div>${typeof isRemoteView === 'function' && isRemoteView() ? `<div class="set-row"><span class="set-k">허브 PC에서</span><span class="mono">${esc(localUrl)}</span></div>` : ''}<div class="set-row"><span class="set-k">동시 실행</span><span>${esc(c.maxParallel || '')}개</span></div><div class="set-row"><span class="set-k">공유 메모리</span><span class="mono">${esc(c.hubDir || '')}</span></div><div class="set-row"><span class="set-k">허브 폴더</span><span class="mono">${esc(c.root || '')}</span></div></section>
  </div>`;
  body.onclick = (e) => {
    const v = e.target.closest('[data-setview]'); if (v) { S.prefs.sideView = v.dataset.setview; savePrefs(); renderTree(); return openSettings(); }
    const i = e.target.closest('[data-setinsp]'); if (i) { S.prefs.insp = i.dataset.setinsp === '1'; savePrefs(); applyLayout(); return openSettings(); }
    if (e.target.closest('[data-resetw]')) { delete S.prefs.lw; delete S.prefs.rw; savePrefs(); applyLayout(); toast('기본 너비로 되돌렸어요'); }
  };
  if (typeof renderRemoteSection === 'function') renderRemoteSection(document.getElementById('remoteSec'));
  if (focus) document.getElementById(focus)?.scrollIntoView({ block: 'start' });
}

/* ================= 단축키 ================= */
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
  if (mod && k === 'k') { e.preventDefault(); $('#palette').hidden ? openPalette() : closePalette(); }
  else if (mod && k === 'b' && !e.shiftKey) { e.preventDefault(); toggleLeft(); }
  else if (mod && k === 'j') { e.preventDefault(); toggleRight(); }
  else if (e.key === 'Escape' && !$('#palette').hidden) closePalette();
});
