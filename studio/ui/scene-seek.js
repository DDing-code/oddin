/* HTML 장면 시각 맞추기 — 편집기 미리보기(iframe 에 넣음)와 엔진 렌더(scene.mjs 가 페이지에서 실행)가 같은 이 파일을 쓴다.
   window.__oddinSeekAny(t초) 순서: 페이지의 window.oddinSeek(t) → HyperFrames 식 window.__timelines(GSAP) → gsap 전역 타임라인 → CSS·Web Animations → <video>·<audio> */
(() => {
  if (window.__oddinSeekAny) return true;
  const frame = () => new Promise((r) => { let done = false; const end = () => { if (!done) { done = true; r(); } }; try { requestAnimationFrame(() => requestAnimationFrame(end)); } catch {} setTimeout(end, 40); });
  window.__oddinSeekAny = async (t) => {
    try { if (document.fonts && document.fonts.status !== 'loaded') await document.fonts.ready; } catch {}
    if (typeof window.oddinSeek === 'function') { await window.oddinSeek(t); }
    else {
      let used = false;
      const tls = window.__timelines;
      if (tls && typeof tls === 'object') for (const tl of Object.values(tls)) { if (tl && typeof tl.seek === 'function') { try { tl.pause(); tl.seek(t, false); used = true; } catch {} } }
      const g = window.gsap;
      if (!used && g && g.globalTimeline && g.globalTimeline.getChildren) {
        const kids = g.globalTimeline.getChildren(false, true, true);
        if (window.__oddinGsapBase == null) window.__oddinGsapBase = kids.length ? Math.min(...kids.map((k) => k.startTime())) : 0;
        for (const k of kids) { try { k.pause(); k.totalTime(Math.max(0, t - (k.startTime() - window.__oddinGsapBase)), false); } catch {} }
      }
      if (document.getAnimations) for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = t * 1000; } catch {} }
      const media = [...document.querySelectorAll('video,audio')];
      await Promise.all(media.map((v) => new Promise((res) => {
        try {
          v.pause(); v.muted = true;
          const want = Math.min(t, isFinite(v.duration) ? v.duration : t);
          if (Math.abs(v.currentTime - want) < 0.001) return res();
          v.addEventListener('seeked', res, { once: true }); v.currentTime = want; setTimeout(res, 3000);
        } catch { res(); }
      })));
    }
    if (document.body) void document.body.offsetHeight;
    await frame();
    return true;
  };
  return true;
})();
