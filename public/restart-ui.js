/* 새 버전 알림 · 지금 바꾸기 (2026-10-05 사용자 개선 요청 1번)
   업데이트를 받았는데 진행 중인 작업 때문에 재시작을 기다리는 동안(/api/hub/version 의 pending), 위쪽에 띠를 띄운다.
   "지금 바꾸기"는 진행 중인 작업을 멈춰 저장하고 ODDIN만 재시작한다. 새 버전이 켜지면 멈춘 작업을 같은 AI 대화로 이어서 끝낸다
   (서버 /api/hub/restart · jobs.prepareRestart · jobs.resumeAfterRestart). */
(() => {
  const V = { pending: '', restarting: false, el: null };
  const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
  const liveCount = () => (typeof S !== 'undefined' ? [...S.jobs.values()].filter((j) => !String(j.id).startsWith('rm-') && LIVE.has(j.status)).length : 0);

  function bar() {
    if (V.el) return V.el;
    const el = document.createElement('div');
    el.id = 'verBar'; el.hidden = true; el.setAttribute('role', 'status');
    const conn = document.getElementById('connBar');
    if (conn) conn.after(el); else document.getElementById('main')?.prepend(el);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-ver-now]')) restartNow(); });
    return (V.el = el);
  }
  function render() {
    const el = bar();
    if (!V.pending && !V.restarting) { el.hidden = true; return; }
    const n = liveCount();
    el.hidden = false;
    el.innerHTML = V.restarting
      ? `<div class="vb-in">${icon('refresh')}<div class="vb-main"><b>새 버전으로 바꾸는 중이에요</b><small>잠시 뒤 다시 연결되고, 멈춘 작업은 이어서 진행돼요</small></div><span class="spinner"></span></div>`
      : `<div class="vb-in">${icon('sparkle')}<div class="vb-main"><b>새 버전이 준비됐어요</b><small>${n ? `진행 중인 작업 ${n}개가 끝나면 저절로 바뀌어요` : '곧 저절로 바뀌어요'}</small></div><button type="button" class="btn" data-ver-now>${icon('refresh')}지금 바꾸기</button></div>`;
  }
  async function check() {
    try {
      const v = await api('/api/hub/version');
      V.pending = v?.pending || '';
      if (!V.pending) V.restarting = false;
      render();
    } catch { /* 재시작 중이면 응답이 없다 — 띠는 그대로 */ }
  }
  async function restartNow() {
    const n = liveCount();
    if (n && !confirm(`진행 중인 작업 ${n}개를 잠깐 멈췄다가 새 버전에서 같은 대화로 이어서 해요.\n지금 바꿀까요?`)) return;
    try {
      await api('/api/hub/restart', { method: 'POST', body: '{}' });
      V.restarting = true; render();
      toast('새 버전으로 바꾸는 중이에요');
    } catch (e) { toast(/없는 API/.test(e.message) ? '이 PC의 ODDIN이 아직 예전 버전이라 이번 한 번은 작업이 끝난 뒤 저절로 바뀌어요. 다음부터는 바로 바꿀 수 있어요' : `바꾸지 못했어요: ${e.message}`, true); }
  }
  window.addEventListener('hub:event', (e) => {
    const t = e.detail?.type;
    if (t === 'hub-restarting') { V.restarting = true; render(); }
    else if (t === 'hello') { V.restarting = false; check(); }
    else if (t === 'peers' || t === 'job') render();
  });
  check();
  setInterval(check, 60_000);
  window.addEventListener('focus', check);
})();
