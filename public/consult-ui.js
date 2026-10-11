/* 다른 AI 의견(lib/consult.mjs, 2026-10-12): 작업 도중 맡은 AI가 다른 쪽 AI에게 물은 것을 작업 카드 끝에 보여 준다
   — 누가 누구에게 · 무엇을 · 얼마나 걸렸는지. "답 보기"를 누르면 그 줄 아래에 답 전체를 펼친다(GET /api/jobs/:id/consults/:task/:cid).
   켜는 곳은 입력창 아래 분배 버튼 메뉴 "다른 AI 의견"(app.js openModePicker). 연결점: window.hubJobExtras */
(() => {
  const NAME = { claude: 'Claude', codex: 'Codex' };
  const opened = new Set(), answers = new Map(); // `${작업}/${하위작업}/${번호}` — 다시 그려도 펼친 채로
  const took = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.max(1, Math.round((ms || 0) / 1000))}초`);
  const stateOf = (c) => (c.status === 'running' ? '답 쓰는 중…' : c.status === 'done' ? took(c.ms) : c.status === 'cancelled' ? '중지됨' : `받지 못함${c.error ? ' · ' + c.error : ''}`);
  (window.hubJobExtras ||= []).push((j) => {
    const rows = [];
    for (const t of j.tasks || []) for (const c of t.consults || []) {
      const key = `${j.id}/${t.id}/${c.id}`, open = opened.has(key);
      rows.push(`<div class="handoff-row consult-row ${esc(c.status)}">${icon('scale')}<span class="t" title="${esc(c.question || '')}"><b>${esc(NAME[t.assignee] || t.assignee)} → ${esc(NAME[c.tool] || c.tool)} ${c.review ? '검토' : '의견'}</b> · ${esc(c.question || '')}</span><span class="st">${esc(stateOf(c))}</span>${c.status === 'done' ? `<button type="button" class="btn" data-consult="${esc(key)}" aria-expanded="${open}">${open ? '접기' : '답 보기'}</button>` : ''}</div>`);
      if (open && c.status === 'done') rows.push(`<div class="consult-answer md">${answers.has(key) ? md(answers.get(key), j.cwd) : '<span class="c-muted">불러오는 중…</span>'}</div>`);
    }
    return rows.join('');
  });
  const redraw = (jobId) => { try { queueRerender(jobId); } catch { try { renderThread(); } catch {} } };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-consult]'); if (!b) return;
    e.preventDefault();
    const key = b.dataset.consult, [jobId, taskId, cid] = key.split('/');
    if (opened.has(key)) { opened.delete(key); return redraw(jobId); }
    opened.add(key); redraw(jobId);
    if (answers.has(key)) return;
    try { const r = await api(`/api/jobs/${encodeURIComponent(jobId)}/consults/${encodeURIComponent(taskId)}/${encodeURIComponent(cid)}`); answers.set(key, r.answer || '(답이 비어 있어요)'); }
    catch (err) { opened.delete(key); toast(`답을 불러오지 못했어요: ${err.message}`, true); }
    redraw(jobId);
  });
})();
