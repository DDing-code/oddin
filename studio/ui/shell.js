/* ODDIN 스튜디오 화면 공용 도우미 — ODDIN 화면(public/app.js)의 같은 이름 함수($·esc·icon·api·toast·modal)를 스튜디오 크기로.
   주소는 모두 상대 경로(api/…, ui/…) — 이 PC 창(http://127.0.0.1:7710/)과 ODDIN 을 거친 원격(…/studio/)에서 같은 코드가 돈다.
   프로그램 창(Electron)이면 window.studioDesktop(preload.cjs)이 있다: 끌어 놓은 파일의 실제 경로·탐색기에서 보기. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const IC = {
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>', sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 20h16"/>', refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  bin: '<path d="M3 7h18M5 7l1 13h12l1-13M9 7V4h6v3"/>', font: '<path d="M4 20 10 4h4l6 16M7 14h10"/>', left: '<path d="m15 18-6-6 6-6"/>',
  pr: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 16V8h3a2.5 2.5 0 0 1 0 5H8M14 16v-5m0 1.5a2.5 2.5 0 0 1 3-1.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2" fill="currentColor"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor"/><circle cx="16" cy="10" r="1.2" fill="currentColor"/><path d="M12 21a2 2 0 0 1 0-4h2a3 3 0 0 0 3-3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
};
const icon = (n) => `<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[n] || ''}</svg></span>`;
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText || `요청 실패(${r.status})`), { status: r.status, code: j.code });
  return j;
}
function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5200 : 3200); }
function modal(title, wide = false) { $('#modalTitle').textContent = title; $('#modal .modal-win').classList.toggle('wide', !!wide); $('#modal').hidden = false; const b = $('#modalBody'); b.innerHTML = ''; b.scrollTop = 0; return b; }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
document.addEventListener('DOMContentLoaded', () => {
  $('#modalClose').onclick = closeModal;
  $('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) { e.stopPropagation(); closeModal(); } }, true);
});
const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : n >= 1e3 ? `${Math.round(n / 1e3)}KB` : `${n || 0}B`);
const KIND_ICON = { dir: 'folder', video: 'film', audio: 'sound', image: 'image', html: 'code', edit: 'film', srt: 'file', font: 'font' };
const KIND_KO = { video: '영상', audio: '소리', image: '그림', html: 'HTML 장면', edit: '편집 파일', srt: '자막', font: '글꼴' };

/* ---------- 스튜디오 공용 상태: 프로그램 창·원격·실시간 알림 ---------- */
const STUDIO = {
  desktop: window.studioDesktop || null,
  remote: false, status: null, listeners: new Set(),
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};
(function connect() {
  const es = new EventSource(`api/events${STUDIO.desktop ? '?app=1' : ''}`);
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } for (const fn of STUDIO.listeners) { try { fn(ev); } catch (e) { console.error(e); } } };
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
})();
async function refreshStatus() { try { STUDIO.status = await api('api/status'); STUDIO.remote = !!STUDIO.status.remote; } catch { STUDIO.status = null; } return STUDIO.status; }

/** 경로 고르기 창: mode 'file' | 'dir', kinds 고를 수 있는 파일 종류. 고른 경로(들) 또는 null */
function pickPath({ title = '고르기', mode = 'file', kinds = null, start = '', multi = false, confirm = '고르기' } = {}) {
  return new Promise((resolve) => {
    const body = modal(title, true); let cur = '', done = false, chosen = new Set();
    const finish = (v) => { if (done) return; done = true; obs.disconnect(); closeModal(); resolve(v); };
    const obs = new MutationObserver(() => { if ($('#modal').hidden && !done) { done = true; obs.disconnect(); resolve(null); } });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    const ok = (e) => e.kind !== 'dir' && (!kinds || kinds.includes(e.kind));
    async function go(p) {
      let r; try { r = await api(`api/list?path=${enc(p || '')}`); } catch (e) { toast(e.message, true); if (p) return go(''); return; }
      cur = r.path; chosen = new Set();
      const rows = r.entries.filter((e) => e.kind === 'dir' || mode === 'file');
      body.innerHTML = `<div class="pk"><form class="pk-bar"><button type="button" class="icon-btn" data-up ${r.parent ? '' : 'disabled'} title="위 폴더">${icon('up')}</button><input name="p" value="${esc(cur)}" placeholder="폴더 경로를 적거나 붙여 넣기 (예: D:\\영상)" spellcheck="false"><button class="btn">이동</button></form>
        <div class="pk-list" role="listbox">${rows.length ? rows.map((e) => `<button type="button" class="pk-row k-${e.kind}" data-path="${esc(e.path)}" data-kind="${e.kind}" ${e.kind !== 'dir' && !ok(e) ? 'disabled' : ''}>${icon(KIND_ICON[e.kind] || 'file')}<span>${esc(e.name)}</span>${e.kind !== 'dir' ? `<small>${KIND_KO[e.kind] || ''} · ${fmtSize(e.size)}</small>` : ''}</button>`).join('') : `<div class="empty-row">${cur ? '여기에는 고를 것이 없어요' : '최근 편집 폴더가 없어요 — 위 칸에 폴더 경로를 적어 주세요'}</div>`}${r.truncated ? '<div class="empty-row">항목이 많아 앞쪽만 보여요</div>' : ''}</div>
        <div class="pk-foot"><span class="cur grow">${mode === 'dir' ? esc(cur || '폴더를 고르세요') : multi ? 'Ctrl 을 누르고 여러 개 고를 수 있어요' : '두 번 누르면 바로 골라요'}</span><button type="button" class="btn" data-cancel>취소</button><button type="button" class="btn primary" data-ok ${mode === 'dir' && !cur ? 'disabled' : mode === 'file' ? 'disabled' : ''}>${esc(confirm)}</button></div></div>`;
      body.querySelector('form').onsubmit = (e) => { e.preventDefault(); go(e.target.p.value.trim().replace(/^"|"$/g, '')); };
      body.querySelector('[data-up]').onclick = () => go(r.parent || '');
      body.querySelector('[data-cancel]').onclick = () => finish(null);
      const okBtn = body.querySelector('[data-ok]');
      okBtn.onclick = () => finish(mode === 'dir' ? cur : multi ? [...chosen] : [...chosen][0] || null);
      body.querySelectorAll('.pk-row').forEach((b) => {
        b.onclick = (e) => {
          if (b.dataset.kind === 'dir') return go(b.dataset.path);
          if (!(multi && (e.ctrlKey || e.metaKey))) { chosen.clear(); body.querySelectorAll('.pk-row.on').forEach((x) => x.classList.remove('on')); }
          chosen.has(b.dataset.path) ? chosen.delete(b.dataset.path) : chosen.add(b.dataset.path); b.classList.toggle('on', chosen.has(b.dataset.path));
          okBtn.disabled = !chosen.size;
        };
        if (b.dataset.kind !== 'dir') b.ondblclick = () => finish(multi ? [b.dataset.path] : b.dataset.path);
      });
    }
    go(start);
  });
}
/** 짧은 글 입력 창(프로그램 창에는 prompt 가 없다) */
function askText(title, value = '', { label = '', ok = '확인' } = {}) {
  return new Promise((resolve) => {
    const body = modal(title); let done = false;
    const obs = new MutationObserver(() => { if ($('#modal').hidden && !done) { done = true; obs.disconnect(); resolve(null); } });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    body.innerHTML = `<form class="ask">${label ? `<p class="c-muted">${esc(label)}</p>` : ''}<input name="v" value="${esc(value)}" spellcheck="false" style="width:100%"><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button type="button" class="btn" data-x>취소</button><button class="btn primary">${esc(ok)}</button></div></form>`;
    const f = body.querySelector('form'); f.v.focus(); f.v.select();
    f.querySelector('[data-x]').onclick = () => { done = true; obs.disconnect(); closeModal(); resolve(null); };
    f.onsubmit = (e) => { e.preventDefault(); done = true; obs.disconnect(); closeModal(); resolve(f.v.value.trim()); };
  });
}
window.modal = modal; // themes.js 의 테마 고르기 창이 쓴다
