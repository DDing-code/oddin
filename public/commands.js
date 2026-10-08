/* AI Hub — 공통 커맨드(/), 서브 에이전트(@), 스킬, 목표(/goal), 한도 경고
   app.js · side.js 다음에 읽힌다. */
'use strict';

S.catalog = { commands: [], agents: [], skills: [] };
S.warnLevel = {};

/* ================= 목록 불러오기 ================= */
async function loadCatalog() {
  try { S.catalog = await api('/api/catalog'); } catch { /* 서버가 옛 버전이면 비어 있음 */ }
}
const agentOf = (name) => S.catalog.agents.find((a) => a.name === name);
const agentLabel = (name) => agentOf(name)?.label || name;

/* ================= 입력창 자동완성 (/ 와 @) ================= */
function slashItems(q) {
  const items = [];
  const hit = (s) => !q || s.toLowerCase().includes(q);
  if (hit('goal') || hit('목표')) items.push({ header: '목표' }, { label: '/goal', desc: '목표를 달성할 때까지 계획 → 실행 → 확인을 반복', icon: 'target', run: () => insertCmd('/goal ') });
  const cmds = S.catalog.commands.filter((c) => c.name !== 'goal' && (hit(c.name) || hit(c.description)));
  if (cmds.length) items.push({ header: '공통 커맨드' }, ...cmds.map((c) => ({ label: `/${c.name}`, desc: `${c.description}${c.argumentHint ? ` · ${c.argumentHint}` : ''}`, icon: 'slash', run: () => insertCmd(`/${c.name} `) })));
  const skills = S.catalog.skills.filter((s) => hit(s.name) || hit(s.description)).slice(0, q ? 20 : 8);
  if (skills.length) items.push({ header: q ? '스킬' : '스킬 (일부 — 이름을 더 입력하세요)' }, ...skills.map((s) => ({ label: `/${s.name}`, desc: s.description, icon: 'sparkle', run: () => insertCmd(`/${s.name} `) })));
  return items;
}
function atItems(q) {
  const list = S.catalog.agents.filter((a) => !q || a.name.includes(q) || a.label.includes(q) || a.description.includes(q));
  return list.length ? [{ header: '서브 에이전트' }, ...list.map((a) => ({ label: `@${a.name}  ${a.label}`, desc: `${a.tool === 'auto' ? '자동' : a.tool === 'claude' ? 'Claude' : 'Codex'} · ${a.description}`, icon: 'bot', run: () => insertCmd(`@${a.name} `) }))] : [];
}
function insertCmd(text) { closePop(); setInput(text); renderCmdHint(); }
input.addEventListener('input', () => {
  const v = input.value;
  const m = v.match(/^([/@])([^\s]*)$/);
  // 진행 중인 작업에 보내는 수정 지시에서는 /goal·/커맨드·@역할도 그냥 글이다 (intercept.js)
  if (m && !icMode()) {
    const items = m[1] === '/' ? slashItems(m[2].toLowerCase()) : atItems(m[2].toLowerCase());
    if (items.some((i) => !i.header)) return openPop($('#composer'), items, { kind: 'slash', sel: 0 });
  }
  if (S.pop?.kind === 'slash') closePop();
  renderCmdHint();
});
/** 입력 중인 커맨드 설명을 입력창 위에 보여 준다 */
function renderCmdHint() {
  const v = input.value; let html = '';
  const m = v.match(/^([/@])([\w.-]+)\s/);
  if (m && !icMode()) {
    const n = m[2].toLowerCase();
    if (m[1] === '@') { const a = agentOf(n); if (a) html = `${icon('bot')}<b>@${esc(a.name)} ${esc(a.label)}</b><span>${esc(a.description)}</span>`; }
    else if (n === 'goal') html = `${icon('target')}<b>/goal</b><span>달성될 때까지 반복합니다. 완료 기준을 같이 적으면 더 정확해요</span>`;
    else { const c = S.catalog.commands.find((x) => x.name === n); const s = S.catalog.skills.find((x) => x.name.toLowerCase() === n); if (c) html = `${icon('slash')}<b>/${esc(c.name)}</b><span>${esc(c.description)}${c.agent ? ` · @${esc(c.agent)}에게 맡김` : ''}${c.mode ? ` · ${esc(MODES[c.mode]?.label || c.mode)}` : ''}</span>`; else if (s) html = `${icon('sparkle')}<b>스킬 ${esc(s.name)}</b><span>${esc(s.description)}</span>`; }
  }
  let el = $('#cmdHint');
  if (!el) { el = document.createElement('div'); el.id = 'cmdHint'; $('#composer').prepend(el); }
  el.innerHTML = html; el.hidden = !html;
}

/* ================= 커맨드 · 에이전트 · 스킬 모아 보기 ================= */
async function openLibrary(tab = 'commands') {
  await loadCatalog();
  const body = modal('커맨드 · 서브 에이전트 · 스킬', true);
  const tabs = [['commands', `공통 커맨드 ${S.catalog.commands.length}`], ['agents', `서브 에이전트 ${S.catalog.agents.length}`], ['skills', `스킬 ${S.catalog.skills.length}`]];
  const use = (cli) => `<div class="lib-where">${cli}</div>`;
  let list = '';
  if (tab === 'commands') list = use('허브: <code>/이름 내용</code> · Claude Code: <code>/hub:이름</code> · Codex: <code>/prompts:hub-이름</code> · 원본 <code>~/.ai-shared/commands/</code>')
    + `<div class="lib-item"><div class="lib-h"><b>/goal</b><span class="tag">허브 내장</span></div><p>목표를 달성할 때까지 계획 → 실행 → 확인을 반복해요. 한도가 위험해지면 잠시 멈춰요.</p><button class="btn" data-ins="/goal ">${icon('plus')}입력창에 넣기</button></div>`
    + S.catalog.commands.filter((c) => c.name !== 'goal').map((c) => `<div class="lib-item"><div class="lib-h"><b>/${esc(c.name)}</b>${c.mode ? `<span class="tag">${esc(MODES[c.mode]?.label || c.mode)}</span>` : ''}${c.agent ? `<span class="tag">@${esc(c.agent)}</span>` : ''}</div><p>${esc(c.description)}${c.argumentHint ? ` <span class="c-muted">${esc(c.argumentHint)}</span>` : ''}</p><button class="btn" data-ins="/${esc(c.name)} ">${icon('plus')}입력창에 넣기</button></div>`).join('');
  else if (tab === 'agents') list = use('허브: <code>@이름 할 일</code>, 자동 분배 때 플래너가 알아서 붙여요 · Claude Code: <code>hub-이름</code> 서브 에이전트 · Codex: <code>/prompts:hub-agent-이름</code> · 원본 <code>~/.ai-shared/agents/</code>')
    + S.catalog.agents.map((a) => `<div class="lib-item"><div class="lib-h"><b>@${esc(a.name)}</b><span>${esc(a.label)}</span><span class="tag ${a.tool}">${a.tool === 'auto' ? '자동' : a.tool === 'claude' ? 'Claude' : 'Codex'}</span>${a.effort !== 'auto' ? `<span class="tag">${esc(a.effort)}</span>` : ''}${a.readonly ? '<span class="tag">읽기 전용</span>' : ''}</div><p>${esc(a.description)}</p>${a.skills.length ? `<p class="c-muted">먼저 읽는 스킬: ${esc(a.skills.join(', '))}</p>` : ''}<button class="btn" data-ins="@${esc(a.name)} ">${icon('plus')}입력창에 넣기</button></div>`).join('');
  else list = use('허브: <code>/스킬이름 할 일</code> 또는 <code>/skill 이름 할 일</code> · 두 CLI는 원래대로 스킬을 씀')
    + [...S.catalog.skills].sort((a, b) => (b.shared ? 1 : 0) - (a.shared ? 1 : 0)).map((s) => `<div class="lib-item"><div class="lib-h"><b>${esc(s.name)}</b>${s.shared ? '<span class="tag" title="~/.ai-shared/skills — 두 PC·드라이브 ODDIN 폴더에 함께 맞춰지는 스킬">두 PC 공유</span>' : ''}${s.tools.map((t) => `<span class="tag ${t}">${t === 'claude' ? 'Claude' : 'Codex'}</span>`).join('')}</div><p>${esc(s.description)}</p><button class="btn" data-ins="/${esc(s.name)} ">${icon('plus')}입력창에 넣기</button></div>`).join('');
  body.innerHTML = `<div class="lib"><div class="lib-tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-libtab="${k}">${l}</button>`).join('')}</div><div class="lib-list">${list}</div></div>`;
  body.onclick = (e) => {
    const t = e.target.closest('[data-libtab]'); if (t) return openLibrary(t.dataset.libtab);
    const b = e.target.closest('[data-ins]'); if (b) { closeModal(); setInput(b.dataset.ins); renderCmdHint(); }
  };
}

/* ================= 목표(/goal) 막대 ================= */
const GOAL_KO = { active: '진행 중', done: '달성', stopped: '중지됨', paused: '멈춤', failed: '실패' };
function renderGoalBar() {
  const s = S.sessions.get(S.current); const el = $('#goalBar'); const g = s?.goal;
  if (!g) { el.hidden = true; el.innerHTML = ''; return; }
  const pct = Math.max(0, Math.min(100, Number(g.progress) || 0));
  const live = g.status === 'active';
  el.hidden = false; el.className = `goal-${g.status}`;
  el.innerHTML = `<div class="goal-in"><span class="goal-ic">${live ? '<span class="spin-xs"></span>' : icon('target')}</span>
    <div class="goal-main"><div class="goal-t"><b>목표</b><span title="${esc(g.text)}">${esc(g.text)}</span></div>
      <div class="goal-sub"><span class="gbadge">${GOAL_KO[g.status] || g.status}</span><span>${g.round || 0}/${g.maxRounds}라운드</span>${g.remaining && g.status !== 'done' ? `<span title="${esc(g.remaining)}">남은 일: ${esc(g.remaining)}</span>` : ''}${g.reason && g.status !== 'active' ? `<span title="${esc(g.reason)}">${esc(g.reason)}</span>` : ''}</div>
      <div class="prog"><i style="width:${pct}%"></i></div></div>
    <div class="goal-acts">${live ? `<button class="btn danger" data-goal="stop">${icon('stop')}중지</button>` : ['stopped', 'paused', 'failed'].includes(g.status) ? `<button class="btn" data-goal="resume">${icon('retry')}이어서</button>` : ''}</div></div>`;
}
$('#goalBar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-goal]'); if (!b || !S.current) return;
  try { await api(`/api/sessions/${S.current}/goal/${b.dataset.goal}`, { method: 'POST' }); } catch (x) { toast(x.message, true); }
});

/* ================= 한도 경고 ================= */
// 기준은 사용률(서버 lib/usage.mjs 와 같음): 80% 이상 = 남은 20% 이하 주의, 95% 이상 = 남은 5% 이하 위험. 표시는 남은 비율
const WARN = 80, CRIT = 95;
const WARN_HIDDEN_KEY = 'oddin.usage-warnings-hidden';
function readHiddenWarnings() {
  try {
    const saved = JSON.parse(localStorage.getItem(WARN_HIDDEN_KEY));
    return Object.fromEntries(Object.entries(saved || {}).filter(([, until]) => typeof until === 'number' && Number.isFinite(until) && until > Date.now()));
  } catch { return {}; }
}
let hiddenWarnings = readHiddenWarnings();
function usageWarnings(u) {
  const out = [];
  for (const tool of ['claude', 'codex']) for (const w of u?.[tool]?.windows || []) {
    const p = Number(w.usedPercent); if (w.usedPercent == null || !(p >= WARN)) continue;
    out.push({ tool, key: `${tool}:${w.key}`, label: w.label, model: w.model, percent: p, left: Math.max(0, Math.round(100 - p)), level: p >= CRIT ? 'crit' : 'warn', resetsAt: w.resetsAt });
  }
  return out.sort((a, b) => b.percent - a.percent);
}
function renderWarnings() {
  const ws = usageWarnings(S.usage).filter(w => !(hiddenWarnings[w.key] === Date.parse(w.resetsAt) && hiddenWarnings[w.key] > Date.now()));
  const el = $('#warnBar');
  // 단계가 올라가면 한 번 알림
  for (const w of ws) { const prev = S.warnLevel[w.key]; if (prev !== w.level && (prev !== 'crit')) toast(`${w.tool === 'claude' ? 'Claude' : 'Codex'} ${w.label} 한도 ${w.left}% 남음 — ${w.level === 'crit' ? '이쪽 작업은 다른 AI로 넘겨요' : '분배를 줄여요'}`, w.level === 'crit'); S.warnLevel[w.key] = w.level; }
  for (const k of Object.keys(S.warnLevel)) if (!ws.some((w) => w.key === k)) delete S.warnLevel[k];
  if (!ws.length) { el.hidden = true; el.innerHTML = ''; return; }
  const crit = ws.some((w) => w.level === 'crit');
  const what = (w) => w.model ? `${w.label} 한도 — 자동 선택이 ${w.model === 'fable' ? 'Opus로 바꿔요' : '다른 모델로 바꿔요'}` : w.level === 'crit' ? '한도 거의 소진 — 새 작업은 다른 AI로 보내요' : '자동 분배가 이쪽 비중을 줄여요';
  el.hidden = false; el.className = crit ? 'crit' : 'warn';
  const canHideUntilReset = ws.every(w => Date.parse(w.resetsAt) > Date.now());
  el.innerHTML = `${icon('alert')}<div class="wb-list">${ws.slice(0, 3).map((w) => `<span><b>${w.tool === 'claude' ? 'Claude' : 'Codex'} ${esc(w.label)} ${w.left}% 남음</b> ${esc(what(w))}${w.resetsAt ? ` · ${esc(resetPhrase(w.resetsAt))}` : ''}</span>`).join('')}${canHideUntilReset ? '<button type="button" class="wb-hide" data-wb-hide title="현재 경고를 각 한도의 초기화 시각까지 숨깁니다">다음 초기화까지 숨기기</button>' : ''}</div><button type="button" class="icon-btn" data-wb-close title="잠시 숨기기" aria-label="한도 경고 잠시 숨기기">${icon('x')}</button>`;
}
$('#warnBar').addEventListener('click', (e) => {
  if (e.target.closest('[data-wb-hide]')) {
    hiddenWarnings = { ...readHiddenWarnings(), ...hiddenWarnings };
    for (const w of usageWarnings(S.usage)) {
      const until = Date.parse(w.resetsAt);
      if (until > Date.now()) hiddenWarnings[w.key] = until;
    }
    try { localStorage.setItem(WARN_HIDDEN_KEY, JSON.stringify(hiddenWarnings)); }
    catch { toast('이 창에서는 숨겼지만 저장하지 못했어요. 새로고침하면 다시 표시될 수 있어요'); }
    renderWarnings(); input.focus();
  } else if (e.target.closest('[data-wb-close]')) $('#warnBar').hidden = true;
});
window.addEventListener('storage', e => {
  if (e.key === WARN_HIDDEN_KEY || e.key === null) { hiddenWarnings = readHiddenWarnings(); renderWarnings(); }
});

/* ================= 연결 ================= */
// 사용량이 바뀔 때마다 경고 갱신 (side.js 의 renderUsage 뒤에 붙인다)
const _renderUsage = renderUsage;
renderUsage = function () { _renderUsage(); renderWarnings(); };
// 세션이 바뀌거나 갱신될 때 목표 막대
const _renderTop = renderTop;
renderTop = function () { _renderTop(); renderGoalBar(); };
document.addEventListener('click', (e) => { const a = e.target.closest('[data-act="library"]'); if (a) openLibrary(); });
document.addEventListener('DOMContentLoaded', () => { loadCatalog(); });
