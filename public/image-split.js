/* 긴 이미지 자동 나누기 (2026-10-06 사용자 "이미지 긴 거 보내려는데 픽셀 제한 때문에 막혔어 제한 풀어줘")
   Claude 는 이미지 한 변 8000픽셀까지만 받고, 큰 이미지는 긴 변 약 1568픽셀로 줄여서 본다 → 긴 스크린샷은 막히거나 글씨를 못 읽는다.
   그래서 첨부할 때 이 화면에서 긴 쪽을 따라 조금씩 겹치게 잘라 여러 장으로 붙인다(위→아래 또는 왼쪽→오른쪽, 이름에 "(n/총)").
   한 장이 5MB를 넘는 큰 이미지는 같은 모양으로 다시 저장해 크기를 줄인다. 서버는 그대로 한 변 8000픽셀·5MB 를 검사한다. */
(() => {
  const MAX_SIDE = 8000, MAX_BYTES = 4.8 * 1024 * 1024, OVERLAP = 80, MAX_PARTS = 20;

  /** 나눠야 하나: 한 변이 8000을 넘거나, 2.5배 넘게 길쭉하고 긴 변이 3000을 넘으면(줄여 보면 글씨가 안 읽힘) */
  const needsSplit = (w, h) => { const long = Math.max(w, h), short = Math.min(w, h); return long > MAX_SIDE || (long / short > 2.5 && long > 3000); };

  const encode = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  async function blobUnder(canvas) {
    let b = await encode(canvas, 'image/png');
    if (b && b.size <= MAX_BYTES) return b;
    for (const q of [0.92, 0.85, 0.75, 0.65]) { b = await encode(canvas, 'image/jpeg', q); if (b && b.size <= MAX_BYTES) return b; }
    return b;
  }
  const fileOf = (blob, name) => new File([blob], `${name}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type });

  /** 긴 쪽 길이 L 을 tile 크기로 겹쳐 자를 시작 위치들 (마지막 조각은 끝에 맞춤) */
  function cuts(L, tile) {
    if (L <= tile) return [0];
    const step = tile - OVERLAP, n = Math.ceil((L - OVERLAP) / step), out = [];
    for (let i = 0; i < n; i++) out.push(Math.min(i * step, L - tile));
    return out;
  }

  /** 계획만 (시험·안내용): 원본 크기 → 조각 수·조각 크기 */
  function plan(W, H) {
    const vertical = H >= W;
    let short = vertical ? W : H, long = vertical ? H : W, scale = 1;
    if (short > MAX_SIDE) scale = MAX_SIDE / short; // 짧은 변도 8000을 넘으면 줄인다
    let s = short * scale, L = long * scale;
    let tile = Math.min(MAX_SIDE, Math.max(1200, Math.round(s * 1.6))); // 조각은 짧은 변의 1.6배 정도라야 줄여 봐도 글씨가 읽힌다
    let starts = cuts(L, tile);
    if (starts.length > MAX_PARTS) { tile = Math.min(MAX_SIDE, Math.ceil((L - OVERLAP) / MAX_PARTS) + OVERLAP); starts = cuts(L, tile); }
    if (starts.length > MAX_PARTS) { // 8000픽셀 조각 20장으로도 모자라면 전체를 줄인다
      const k = (MAX_PARTS * (MAX_SIDE - OVERLAP) + OVERLAP) / L; scale *= k; s *= k; L *= k; tile = MAX_SIDE; starts = cuts(L, tile);
    }
    return { vertical, scale, s: Math.round(s), L: Math.round(L), tile, starts };
  }

  /** 첨부 한 개 → 올릴 파일 목록 (나눌 필요 없고 작으면 그대로) */
  async function split(file) {
    let bmp; try { bmp = await createImageBitmap(file); } catch { return [file]; }
    const W = bmp.width, H = bmp.height, base = (file.name || '이미지').replace(/\.[^.]+$/, '');
    try {
      if (!needsSplit(W, H)) {
        if (file.size <= MAX_BYTES) return [file];
        // 크기만 큰 이미지: 같은 모양으로 다시 저장(그래도 크면 긴 변 4000으로 줄임)
        const k = Math.max(W, H) > 4000 ? 4000 / Math.max(W, H) : 1, c = document.createElement('canvas');
        c.width = Math.round(W * k); c.height = Math.round(H * k);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        return [fileOf(await blobUnder(c), base)];
      }
      const p = plan(W, H), out = [];
      for (let i = 0; i < p.starts.length; i++) {
        const start = p.starts[i], len = Math.min(p.tile, p.L - start), c = document.createElement('canvas');
        c.width = p.vertical ? p.s : len; c.height = p.vertical ? len : p.s;
        const sx = p.vertical ? 0 : start / p.scale, sy = p.vertical ? start / p.scale : 0, sw = p.vertical ? W : len / p.scale, sh = p.vertical ? len / p.scale : H;
        c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
        out.push(fileOf(await blobUnder(c), `${base} (${i + 1}/${p.starts.length})`));
      }
      return out;
    } finally { bmp.close?.(); }
  }

  window.hubSplitImage = Object.assign(split, { needsSplit, plan, MAX_SIDE, OVERLAP });
})();
