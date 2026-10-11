/* 화면을 쓰는 중인지 허브에 알린다 (2026-10-11 "작업을 안할 때도 자원을 많이 먹는데?").
   누르거나 칠 때 2분에 한 번만 /api/hub/touch 를 보낸다. 허브는 10분 동안 아무 알림도 작업도 없으면
   "쉬는 중"으로 보고 맞추기·상태 확인·사용량 조회 주기를 길게 한다. 창이 열려만 있는 것은 쓰는 중이 아니다.
   나눠 보기 칸(iframe)에서는 가운데 창이 대신 알린다. */
(() => {
  let last = 0;
  const tell = () => {
    const now = Date.now();
    if (now - last < 120_000) return;
    last = now;
    try { fetch('/api/hub/touch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {}); } catch {}
  };
  if (document.documentElement.classList.contains('embed-pane')) { try { if (parent !== window) return; } catch { return; } }
  for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, tell, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tell(); });
  window.addEventListener('focus', tell);
})();
