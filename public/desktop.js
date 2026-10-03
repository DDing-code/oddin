// 데스크탑 프로그램 연결: 작업 완료 알림·작업 표시줄 진행 표시·실제 경로 끌어놓기·트레이 명령.
// window.hubDesktop 은 프로그램 안에서만 있다 (docs/desktop.md). 일반 브라우저에서는 아무것도 하지 않는다.
(() => {
  const D = window.hubDesktop;
  if (!D || !D.isDesktop) return;
  document.documentElement.classList.add('is-desktop');

  // 1) 작업이 끝나면 Windows 알림 (창이 앞에 있으면 프로그램이 알아서 생략)
  const baseFinished = window.finished;
  if (typeof baseFinished === 'function') {
    window.finished = function (job) {
      baseFinished(job);
      try {
        const s = S.sessions.get(job.sessionId);
        const state = (typeof ST_KO !== 'undefined' && ST_KO[job.status]) || job.status;
        const body = String(job.summary || job.title || job.goal || '').replace(/\s+/g, ' ').slice(0, 160);
        D.notify({ title: `${s?.title || '작업'} — ${state}`, body, sessionId: job.sessionId });
      } catch {}
    };
  }

  // 2) 실행 중인 작업 수 → 작업 표시줄 진행 표시
  let lastBusy = -1;
  setInterval(() => {
    try {
      const n = [...S.sessions.values()].filter((s) => s.status === 'running').length;
      if (n !== lastBusy) { lastBusy = n; D.setBusy(n); }
    } catch {}
  }, 1500);

  // 3) 탐색기에서 끌어놓기: 이미지는 지금처럼 첨부, 다른 파일·폴더는 실제 경로를 입력창에
  const dropHint = document.querySelector('#drop > div');
  if (dropHint && D.isLocalHub) dropHint.lastChild.textContent = '이미지는 첨부되고, 다른 파일·폴더는 경로가 입력됩니다';
  document.addEventListener('drop', (e) => {
    if (!e.target.closest || !e.target.closest('#main')) return;
    const files = [...(e.dataTransfer?.files || [])];
    const others = files.filter((f) => !f.type.startsWith('image/'));
    if (!others.length) return; // 이미지뿐이면 기존 처리(app.js)에 맡긴다
    e.preventDefault(); e.stopPropagation();
    try { dragN = 0; } catch {}
    document.getElementById('drop').hidden = true;
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) addFiles(imgs);
    if (!D.isLocalHub) { toast('원격 허브에는 이 PC의 파일 경로를 넘길 수 없어요. 이미지만 첨부돼요', true); return; }
    const paths = others.map((f) => D.pathForFile(f)).filter(Boolean).map((p) => (/\s/.test(p) ? `"${p}"` : p));
    if (!paths.length) { toast('파일 경로를 읽지 못했어요', true); return; }
    const v = input.value;
    setInput(`${v}${v && !/\s$/.test(v) ? ' ' : ''}${paths.join(' ')} `);
  }, true);

  // 4) 트레이·알림에서 온 명령 (허브 추가·원격 설정은 hubs.js 가 처리)
  D.onCommand((c) => {
    if (c?.type === 'open-session' && c.sessionId) openSession(c.sessionId);
  });
})();
