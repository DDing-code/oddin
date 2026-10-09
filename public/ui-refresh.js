/* 화면 새 판 감지: 허브가 재시작되거나 화면 파일이 바뀌어도 열린 창(특히 ODDIN 앱)은
   실시간 연결만 다시 잇고 예전 화면 파일을 계속 쓴다. 판 표시(/api/ui-version)를 비교해
   - 창이 안 보이고 입력·메뉴·대화상자가 비어 있으면 조용히 새로고침
   - 보고 있거나 작성 중이면 위쪽에 "새로고침" 띠만 띄운다(입력을 날리지 않게).
   판 표시가 없는 예전 서버면 아무것도 하지 않는다. */
(() => {
  let base = null, bar = null;
  const busy = () => !!(document.getElementById('in')?.value || '').trim() || !document.getElementById('pop')?.hidden || !document.getElementById('modal')?.hidden;
  function showBar() {
    if (bar) return;
    bar = document.createElement('div'); bar.className = 'ui-stale'; bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>화면이 새 버전으로 바뀌었어요</span><button type="button">새로고침</button>';
    bar.querySelector('button').addEventListener('click', () => location.reload());
    document.body.appendChild(bar);
  }
  async function check() {
    try {
      const r = await fetch('/api/ui-version', { cache: 'no-store' }); if (!r.ok) return;
      const v = (await r.json())?.v; if (!v) return;
      if (base === null) { base = v; return; }
      if (v === base) return;
      if (document.hidden && !busy()) return location.reload();
      showBar();
    } catch {}
  }
  check();
  setInterval(check, 30000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
})();
