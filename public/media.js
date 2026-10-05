/* 결과 그림·영상 바로 보기 (2026-10-05 사용자 "시안 볼 때 … 앱 내에 이미지/영상으로도 출력 가능하면 기능 구현")
   - 작업 보고(보고가 없으면 작업별 결과)에 적힌 그림·영상 경로를 작업 카드 끝에 썸네일·재생기로 보여 준다.
     [라벨](E:/…/a.png) 링크 · `E:\…\b.mp4` · `상대/경로.png`(작업 폴더 기준) · 글 속 맨 경로를 찾는다.
   - 파일은 /api/file 로 받는다. 범위는 서버가 정한다(허브가 아는 폴더, 또는 권한 메뉴 › 모든 폴더 — lib/file-access.mjs).
     다른 PC 작업(rm- id)이면 &job= 을 붙여 서버가 그 PC에서 받아 온다(lib/federation.mjs proxy).
   - 그림을 누르면 허브 확대창(app.js hubOpenViewer), 영상은 그 자리에서 재생하고 ⤢ 로 크게 본다.
   - 다시 그릴 때마다 영상이 처음으로 돌아가지 않게 작업별 DOM 을 보관해 끼운다(app.js hubMounts).
   - 없는 파일(404)은 조용히 빼고, 범위 밖(403)은 안내를 띄운다. */
(() => {
  const IMG = /\.(png|jpe?g|gif|webp|bmp|avif)$/i, VID = /\.(mp4|m4v|webm|mov)$/i;
  const ABS = /^[A-Za-z]:[\\/]/;
  const SHOW = 9; // 처음에 보이는 그림 수(나머지는 "더 보기")
  const MX = { nodes: new Map(), open: new Set() }; // jobId -> { sig, node } · 펼친 작업
  const enc = encodeURIComponent;
  const remote = () => (typeof isRemoteView === 'function' ? isRemoteView() : false);
  const baseName = (p) => String(p).split(/[\\/]/).pop();

  /** 보고 글에서 그림·영상 경로 모으기 */
  function extract(j) {
    const texts = j.report ? [j.report] : (j.tasks || []).map((t) => t.resultText).filter(Boolean);
    const out = [], seen = new Set();
    const add = (raw, label) => {
      let p = String(raw || '').trim().replace(/^<|>$/g, '').replace(/&amp;/g, '&').replace(/[.,;:]+$/, '');
      p = p.replace(/^\/(?=[A-Za-z]:)/, '').replace(/[#?].*$/, '');
      try { if (/%[0-9A-Fa-f]{2}/.test(p)) p = decodeURIComponent(p); } catch {}
      const kind = VID.test(p) ? 'video' : IMG.test(p) ? 'image' : '';
      if (!kind || /^https?:/i.test(p) || p.length > 400) return;
      let item;
      if (ABS.test(p)) item = { path: p };
      else if (j.cwd && /^[^\s:*?"<>|]+$/.test(p) && !p.startsWith('/')) item = { path: `${j.cwd.replace(/[\\/]+$/, '')}\\${p.replace(/^\.[\\/]/, '').replace(/\//g, '\\')}`, rel: p, base: j.cwd };
      else return;
      const key = item.path.replace(/\//g, '\\').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ...item, kind, label: (label && label.trim() && !ABS.test(label.trim()) ? label.trim() : baseName(p)).slice(0, 80) });
    };
    for (const text of texts) {
      for (const m of text.matchAll(/\[([^\]\n]{1,120})\]\(<?(\/?[A-Za-z]:[\\/][^)>\n]+?)>?\)/g)) add(m[2], m[1]);
      for (const m of text.matchAll(/`([^`\n]{3,400})`/g)) add(m[1], '');
      for (const m of text.matchAll(/(?:^|[\s(（:])([A-Za-z]:[\\/][^\s`'"<>|*?()[\]]+\.(?:png|jpe?g|gif|webp|bmp|avif|mp4|m4v|webm|mov))(?=$|[\s),.;:'"])/gim)) add(m[1], '');
    }
    return out;
  }

  const fileUrl = (j, it, meta = false) => `/api/file?path=${enc(it.path)}${it.rel ? `&rel=${enc(it.rel)}&base=${enc(it.base)}` : ''}${String(j.id).startsWith('rm-') ? `&job=${enc(j.id)}` : ''}${meta ? '&meta=1' : ''}`;
  const pathAttrs = (it) => `data-open="${esc(it.path)}"${it.rel ? ` data-rel="${esc(it.rel)}" data-base="${esc(it.base)}"` : ''}`;

  function build(j, items) {
    const imgs = items.filter((x) => x.kind === 'image'), vids = items.filter((x) => x.kind === 'video');
    const el = document.createElement('section');
    el.className = 'mx'; el.setAttribute('aria-label', '결과 그림·영상');
    const sub = [imgs.length ? `그림 ${imgs.length}` : '', vids.length ? `영상 ${vids.length}` : ''].filter(Boolean).join(' · ');
    const fromPc = j.machine?.name ? ` · ${esc(j.machine.name)} PC 파일` : '';
    const more = imgs.length > SHOW && !MX.open.has(j.id);
    el.innerHTML = `<div class="mx-h">${icon('image')}<b>결과 보기</b><span class="mx-sub">${sub}${fromPc}</span></div>
      <div class="mx-note" hidden></div>
      ${vids.length ? `<div class="mx-vids">${vids.map((v, i) => `<figure class="mx-vid" data-k="v${i}">
        <video controls playsinline preload="metadata" src="${esc(fileUrl(j, v))}"></video>
        <figcaption><span class="mx-cap" title="${esc(v.path)}">${icon('film')}${esc(v.label)}</span><span class="grow"></span>
          <button type="button" class="icon-btn mx-big" data-mx-big="v${i}" title="크게 보기" aria-label="${esc(v.label)} 크게 보기">${icon('expand')}</button>
          <button type="button" class="icon-btn" ${pathAttrs(v)} title="${remote() ? '허브 안에서 보기' : '이 PC에서 열기 · 오른쪽 클릭 메뉴'}" aria-label="${esc(v.label)} 열기">${icon('open')}</button></figcaption>
      </figure>`).join('')}</div>` : ''}
      ${imgs.length ? `<div class="mx-grid">${imgs.map((m, i) => `<figure class="mx-item is-loading" data-k="i${i}"${i >= SHOW && more ? ' hidden' : ''}>
        <button type="button" class="mx-open" data-mx-big="i${i}" title="${esc(m.label)} 크게 보기" aria-label="${esc(m.label)} 크게 보기"><img src="${esc(fileUrl(j, m))}" alt="${esc(m.label)}" loading="lazy" decoding="async" draggable="false"></button>
        <figcaption title="${esc(m.path)}">${esc(m.label)}</figcaption>
      </figure>`).join('')}</div>${more ? `<button type="button" class="btn sm mx-more">${icon('down')}${imgs.length - SHOW}개 더 보기</button>` : ''}` : ''}`;
    const list = [...vids.map((v, i) => ({ ...v, k: `v${i}` })), ...imgs.map((m, i) => ({ ...m, k: `i${i}` }))];
    // 못 불러온 것: 없는 파일이면 빼고, 범위 밖·다른 문제면 이유를 한 줄로
    const failed = async (fig, it) => {
      let msg = '', status = 0;
      try { const r = await fetch(fileUrl(j, it, true), { cache: 'no-store' }); status = r.status; if (!r.ok) msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`; } catch (e) { msg = e.message; }
      if (status === 404) { fig.remove(); } else { fig.classList.add('is-err'); fig.title = msg || '불러오지 못했어요'; if (status === 403) { const n = el.querySelector('.mx-note'); n.hidden = false; n.innerHTML = `${icon('alert')}<span>${esc(msg)}</span>`; } }
      if (!el.querySelector('.mx-item, .mx-vid')) el.hidden = true;
    };
    for (const it of list) {
      const fig = el.querySelector(`[data-k="${it.k}"]`);
      if (it.kind === 'image') {
        const img = fig.querySelector('img');
        const done = () => { fig.classList.remove('is-loading'); if (!img.naturalWidth) failed(fig, it); };
        img.addEventListener('load', done); img.addEventListener('error', () => { fig.classList.remove('is-loading'); failed(fig, it); });
        if (img.complete) done();
      } else fig.querySelector('video').addEventListener('error', () => failed(fig, it));
    }
    el.addEventListener('click', (e) => {
      if (e.target.closest('.mx-more')) { MX.open.add(j.id); el.querySelectorAll('.mx-item[hidden]').forEach((x) => (x.hidden = false)); e.target.closest('.mx-more').remove(); return; }
      const b = e.target.closest('[data-mx-big]'); if (!b) return;
      const live = list.filter((x) => el.querySelector(`[data-k="${x.k}"]`));
      const idx = Math.max(0, live.findIndex((x) => x.k === b.dataset.mxBig));
      el.querySelectorAll('video').forEach((v) => v.pause());
      window.hubOpenViewer?.({ title: '결과 보기', trigger: b, idx, items: live.map((x) => ({ key: x.k, label: x.label, alt: x.label, url: fileUrl(j, x), video: x.kind === 'video', path: x.path, rel: x.rel || '', base: x.base || '' })) });
    });
    return el;
  }

  // 작업 카드 끝 자리(app.js 가 작업 카드를 그릴 때)
  window.hubJobExtras = window.hubJobExtras || [];
  window.hubJobExtras.push((j) => {
    if (!j.report && !(j.tasks || []).some((t) => t.resultText)) return '';
    return extract(j).length ? `<div class="mx-slot" data-mx-job="${esc(j.id)}"></div>` : '';
  });
  // 그린 뒤 보관한 DOM 을 끼운다(보고가 바뀐 경우에만 새로 만든다)
  window.hubMounts = window.hubMounts || [];
  window.hubMounts.push((root) => {
    root.querySelectorAll('.mx-slot').forEach((slot) => {
      const j = S.jobs.get(slot.dataset.mxJob); if (!j) return slot.remove();
      const items = extract(j), sig = JSON.stringify(items);
      let rec = MX.nodes.get(j.id);
      if (!rec || rec.sig !== sig) { rec = { sig, node: build(j, items) }; MX.nodes.set(j.id, rec); }
      slot.replaceWith(rec.node);
    });
  });
  // 범위를 바꾸면(권한 메뉴) 못 불러온 것을 다시 시도하게 새로 만든다
  window.addEventListener('hub:event', (e) => {
    if (e.detail?.type !== 'file-access') return;
    MX.nodes.clear();
    if (S.current && typeof renderThread === 'function') renderThread();
  });
})();
