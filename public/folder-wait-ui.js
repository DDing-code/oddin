/* 폴더 차례 기다림(2026-10-19 회사 PC: 같은 작업실 폴더의 다른 세션 영상 작업 뒤에서 압축 요청이 47분 동안 말없이 기다리다 취소됨):
   같은 폴더를 쓰는 앞 작업이 끝나길 기다리는 동안 작업 카드 끝에 누구를 기다리는지 보여 주고, "기다리지 않고 시작"으로 바로 시작한다
   (POST /api/jobs/:id/skip-folder-wait — 다른 PC 세션도 같은 주소로 그 PC에 전달된다). 자료는 job.folderWait. 연결점: window.hubJobExtras */
(() => {
  const ago = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000)); return m < 1 ? '방금' : `${m}분째`; };
  (window.hubJobExtras ||= []).push((j) => {
    const w = j.folderWait; if (!w || !['queued', 'planning', 'running'].includes(j.status)) return '';
    const who = (w.behind || []).map((b) => `「${esc(b.title)}」${b.sameSession ? '' : '(다른 세션)'}`).join(', ') || '다른 작업';
    return `<div class="handoff-row folder-wait-row">${icon('clock')}<span class="t" title="${esc(w.folder || '')}"><b>폴더 차례 기다리는 중</b> · 같은 폴더에서 ${who}이 끝나면 시작해요</span><span class="st">${esc(ago(w.since))}</span><button type="button" class="btn" data-skip-folder-wait="${esc(j.id)}" title="앞 작업과 같은 파일을 함께 고칠 수 있어요">기다리지 않고 시작</button></div>`;
  });
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-skip-folder-wait]'); if (!b) return;
    e.preventDefault();
    if (!confirm('앞 작업이 끝나기 전에 바로 시작할까요?\n같은 폴더에서 두 작업이 함께 돌아요. 같은 파일을 고치는 일이면 기다리는 편이 안전해요.')) return;
    b.disabled = true;
    try { await api(`/api/jobs/${encodeURIComponent(b.dataset.skipFolderWait)}/skip-folder-wait`, { method: 'POST', body: '{}' }); toast('바로 시작했어요'); }
    catch (err) { b.disabled = false; toast(`시작하지 못했어요: ${err.message}`, true); }
  });
})();
