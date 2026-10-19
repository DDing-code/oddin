/* ODDIN 검사(lib/checks.mjs, 2026-10-19): 작업이 끝난 뒤 허브가 직접 돌린 확인 명령의 결과를 작업 카드 끝에 보여 준다
   — "ODDIN 검사 · 통과 2/2" / "실패 1/2" / "검사 중…". "출력 보기"를 누르면 그 줄 아래에 명령별 출력 끝부분을 펼친다.
   자료는 작업의 task.checkRuns(마지막 판이 지금 판정), task.verified, task.checking. 연결점: window.hubJobExtras */
(() => {
  const opened = new Set(); // `${작업}/${하위작업}` — 다시 그려도 펼친 채로
  const took = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.max(1, Math.round((ms || 0) / 1000))}초`);
  const one = (r) => (r.skipped ? `건너뜀 · ${r.skipped}` : r.ok ? `통과 · ${took(r.ms)}` : r.timedOut ? '시간 초과' : `실패 · 종료 코드 ${r.code}`);
  (window.hubJobExtras ||= []).push((j) => {
    const rows = [];
    for (const t of j.tasks || []) {
      const run = (t.checkRuns || []).at(-1);
      if (!run && !t.checking) continue;
      const key = `${j.id}/${t.id}`, open = opened.has(key);
      const ran = (run?.results || []).filter((r) => !r.skipped);
      const bad = ran.filter((r) => !r.ok).length;
      const state = t.checking ? 'running' : t.verified === 'verified' ? 'pass' : t.verified === 'refuted' ? 'fail' : 'skip';
      const head = t.checking ? '검사 중…' : !ran.length ? '돌린 검사 없음' : bad ? `실패 ${bad}/${ran.length}` : `통과 ${ran.length}/${ran.length}`;
      const again = (t.checkRuns || []).length > 1 ? ` · ${(t.checkRuns || []).length}번째 검사` : '';
      const cmds = (run?.results || []).map((r) => r.cmd).join(', ');
      rows.push(`<div class="handoff-row check-row ${state}">${icon(state === 'fail' ? 'alert' : 'check')}<span class="t" title="${esc(cmds)}"><b>ODDIN 검사</b>${(j.tasks || []).length > 1 ? ` · ${esc(t.title)}` : ''} · ${esc(cmds || '확인 명령')}</span><span class="st">${esc(head + again)}</span>${run ? `<button type="button" class="btn" data-check-out="${esc(key)}" aria-expanded="${open}">${open ? '접기' : '출력 보기'}</button>` : ''}</div>`);
      if (open && run) rows.push(`<div class="check-out">${run.results.map((r) => `<div class="check-cmd ${r.skipped ? 'skip' : r.ok ? 'pass' : 'fail'}"><b>${esc(r.cmd)}</b> <span>${esc(one(r))}</span></div>${r.tail ? `<pre>${esc(r.tail)}</pre>` : ''}`).join('')}</div>`);
    }
    return rows.join('');
  });
  const redraw = (jobId) => { try { queueRerender(jobId); } catch { try { renderThread(); } catch {} } };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-check-out]'); if (!b) return;
    e.preventDefault();
    const key = b.dataset.checkOut;
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    redraw(key.split('/')[0]);
  });
})();
