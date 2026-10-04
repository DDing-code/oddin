/* 알림음 (2026-10-04 사용자 요청 "작업 끝나거나 질문 있을 때"): 작업이 끝나면(완료·일부 완료·실패) 또는 질문·승인 요청이 오면 짧은 소리.
   파일 없이 Web Audio 로 합성한다. 켜기·끄기는 왼쪽 아래 계정 메뉴의 "알림음"(이 창에만 저장: localStorage hub.sound).
   브라우저는 한 번이라도 누르거나 입력해야 소리를 낼 수 있어 첫 상호작용 때 준비한다(데스크탑 앱은 바로 — autoplayPolicy).
   데스크탑 앱의 Windows 알림은 이 소리가 대신하므로 조용히 뜬다(desktop/main.cjs). */
(() => {
  const KEY = 'hub.sound';
  let on = true;
  try { on = localStorage.getItem(KEY) !== 'off'; } catch {}
  let ctx = null;
  const ensure = () => {
    try {
      ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch {}
    return ctx;
  };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, ensure, { capture: true, passive: true });
  ensure();

  // 음표: [주파수(Hz), 시작(초), 길이(초), 세기]
  const TONES = {
    done: [[659.25, 0, 0.5, 0.22], [987.77, 0.11, 0.75, 0.2]], // 미→시: 밝게 끝남
    partial: [[659.25, 0, 0.45, 0.2], [783.99, 0.12, 0.65, 0.18]], // 미→솔: 일부 완료
    failed: [[523.25, 0, 0.45, 0.2], [392.0, 0.14, 0.75, 0.2]], // 도→아래 솔: 실패
    question: [[880, 0, 0.16, 0.17], [880, 0.19, 0.16, 0.17], [1174.66, 0.38, 0.6, 0.2]], // 띵·띵·딩: 답을 기다림
  };
  function play(kind) {
    if (!on) return false;
    const c = ensure();
    if (!c || c.state !== 'running') return false;
    const t0 = c.currentTime + 0.02;
    const out = c.createGain(); out.gain.value = 0.9; out.connect(c.destination);
    for (const [f, at, dur, vol] of TONES[kind] || TONES.done) {
      // 종소리처럼: 빠르게 올라가 천천히 사라짐 + 한 옥타브 위 배음을 살짝
      for (const [mul, v, len] of [[1, vol, dur], [2, vol * 0.18, dur * 0.6]]) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f * mul;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(v, t0 + at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        o.connect(g); g.connect(out); o.start(t0 + at); o.stop(t0 + at + len + 0.05);
      }
    }
    return true;
  }
  // 같은 일로 같은 브라우저의 여러 탭이 한꺼번에 울리지 않게
  function once(key, kind) {
    try {
      const last = JSON.parse(localStorage.getItem(KEY + '.last') || 'null');
      if (last && last.key === key && Date.now() - last.at < 4000) return;
      localStorage.setItem(KEY + '.last', JSON.stringify({ key, at: Date.now() }));
    } catch {}
    play(kind);
  }

  // 작업이 끝남: app.js finished() 를 감싼다 (직접 중지한 작업은 조용히)
  const base = window.finished;
  if (typeof base === 'function') {
    window.finished = function (job) {
      base.apply(this, arguments);
      try { if (job && job.status !== 'cancelled') once(`job:${job.id}`, job.status === 'failed' ? 'failed' : job.status === 'partial' ? 'partial' : 'done'); } catch {}
    };
  }
  // 질문·승인·계획 질문 요청 (새로 생긴 것만)
  const asked = new Set();
  window.addEventListener('hub:event', (e) => {
    const p = e.detail?.type === 'prompt' ? e.detail.prompt : null;
    if (p && p.status === 'pending' && !asked.has(p.id)) { asked.add(p.id); once(`prompt:${p.id}`, 'question'); }
  });

  window.hubSound = {
    get on() { return on; },
    set(v) { on = !!v; try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} if (on) setTimeout(() => play('done'), 60); return on; },
    toggle() { return this.set(!on); },
    play,
  };
})();
