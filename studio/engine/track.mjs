// ODDIN 스튜디오 따라가기(모션 트래킹) — 2026-10-24 프로 기능("마스크·트래킹")
// 원본 영상의 사각형 안 모양을 프레임마다 찾아 위치를 낸다. ffmpeg 로 줄인 회색 프레임을 받아 JS 로 정규화 상관(NCC)을 잰다:
//  - 이전 위치(+움직이던 속도) 둘레만 찾는다, 소수점 위치는 포물선 맞춤
//  - 본보기는 잘 맞을 때 조금씩 새로 고친다(모양이 천천히 바뀌어도 따라가게), 점수가 낮으면 lost 로 표시
// 결과(원본 픽셀 위치)를 편집 파일 키로 바꾸는 일은 apply*(server.mjs /api/follow, cli.mjs follow)
import { spawn } from 'node:child_process';
import { guardChild } from '../../lib/util.mjs';
import { f6 } from './media.mjs';

/**
 * o = { ffmpeg, file, from, to(원본 초), rect: {x,y,w,h}(원본 px), mediaW, mediaH, fps(따라갈 프레임 수/초), children, isCancelled }
 * 반환: { points: [{ t(원본 초), x, y(사각형 왼쪽 위, 원본 px), score }], scale }
 */
export function trackRect(o) {
  const mw = o.mediaW, mh = o.mediaH, r0 = o.rect;
  if (!(r0.w >= 4 && r0.h >= 4)) throw new Error('따라갈 사각형이 너무 작아요(4px 이상)');
  // 둘레를 조금 넓혀 함께 본다(AE 특징 영역처럼) — 속이 한 가지 색인 물체도 가장자리로 잡히게. 결과는 원래 사각형 자리로 돌려준다
  const pad = Math.max(4, Math.round(0.25 * Math.max(r0.w, r0.h))), fx0 = Math.max(0, r0.x - pad), fy0 = Math.max(0, r0.y - pad);
  const rect = { x: fx0, y: fy0, w: Math.min(mw, r0.x + r0.w + pad) - fx0, h: Math.min(mh, r0.y + r0.h + pad) - fy0 }, offX = r0.x - fx0, offY = r0.y - fy0;
  const s = Math.min(1, 48 / Math.max(rect.w, rect.h), 640 / mw), W = Math.max(8, Math.round(mw * s / 2) * 2), H = Math.max(8, Math.round(mh * s / 2) * 2);
  const sx = W / mw, sy = H / mh, tw = Math.max(4, Math.round(rect.w * sx)), th = Math.max(4, Math.round(rect.h * sy));
  const fps = o.fps || 30, dur = Math.max(1 / fps, o.to - o.from);
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-ss', f6(Math.max(0, o.from)), '-t', f6(dur + 0.5 / fps), '-i', o.file, '-vf', `fps=${f6(fps)},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'];
    const child = guardChild(spawn(o.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    o.children?.add(child);
    const frameSize = W * H; let buf = Buffer.alloc(0), n = 0, err = '';
    let T = null, px = rect.x * sx, py = rect.y * sy, vx = 0, vy = 0;
    const points = [];
    const tpl = (img, x0, y0) => { const t = new Float64Array(tw * th); for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) t[j * tw + i] = img[Math.min(H - 1, Math.max(0, Math.round(y0) + j)) * W + Math.min(W - 1, Math.max(0, Math.round(x0) + i))]; return t; };
    const stats = (t) => { let m = 0; for (const v of t) m += v; m /= t.length; let q = 0; for (const v of t) q += (v - m) ** 2; return { m, sd: Math.sqrt(q / t.length) || 1 }; };
    const onFrame = (img) => {
      const t = o.from + n / fps;
      if (!T) { T = tpl(img, px, py); points.push({ t, x: px / sx + offX, y: py / sy + offY, score: 1 }); n++; return; }
      const ts = stats(T), R = Math.max(6, Math.round(Math.max(tw, th) * 0.9)), cx = px + vx, cy = py + vy;
      let best = -2, bx = cx, by = cy; const grid = new Map();
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x0 = Math.round(cx) + dx, y0 = Math.round(cy) + dy;
        if (x0 < 0 || y0 < 0 || x0 + tw > W || y0 + th > H) continue;
        let sp = 0, spp = 0, spt = 0;
        for (let j = 0; j < th; j++) { const row = (y0 + j) * W + x0, tr = j * tw; for (let i = 0; i < tw; i++) { const p = img[row + i]; sp += p; spp += p * p; spt += p * T[tr + i]; } }
        const N = tw * th, mp = sp / N, sdp = Math.sqrt(Math.max(1e-9, spp / N - mp * mp));
        const ncc = (spt / N - mp * ts.m) / (sdp * ts.sd);
        grid.set(`${x0},${y0}`, ncc);
        if (ncc > best) { best = ncc; bx = x0; by = y0; }
      }
      // 소수점 위치: 이웃 셋으로 포물선
      const g = (x, y) => grid.get(`${x},${y}`);
      const sub = (a, b, c) => (a == null || c == null || a - 2 * b + c >= 0 ? 0 : clampH(0.5 * (a - c) / (a - 2 * b + c)));
      const fx = bx + sub(g(bx - 1, by), best, g(bx + 1, by)), fy = by + sub(g(bx, by - 1), best, g(bx, by + 1));
      vx = 0.6 * vx + 0.4 * (fx - px); vy = 0.6 * vy + 0.4 * (fy - py); px = fx; py = fy;
      points.push({ t, x: px / sx + offX, y: py / sy + offY, score: Math.round(best * 1000) / 1000, ...(best < 0.5 ? { lost: true } : {}) });
      if (best > 0.8) { const nt = tpl(img, px, py); for (let i = 0; i < T.length; i++) T[i] = 0.88 * T[i] + 0.12 * nt[i]; }
      n++;
    };
    const clampH = (v) => Math.max(-0.5, Math.min(0.5, v));
    child.stdout.on('data', (b) => {
      if (o.isCancelled?.()) { child.kill(); return; }
      buf = buf.length ? Buffer.concat([buf, b]) : b;
      while (buf.length >= frameSize) { onFrame(buf.subarray(0, frameSize)); buf = buf.subarray(frameSize); }
    });
    child.stderr.on('data', (b) => { err = (err + b).slice(-3000); });
    child.on('error', reject);
    child.on('close', (code) => { o.children?.delete(child); if (o.isCancelled?.()) return reject(new Error('중지')); if (code !== 0 && !points.length) return reject(new Error(err.trim().split('\n').pop() || `ffmpeg 종료 코드 ${code}`)); resolve({ points, scale: s }); });
  });
}

/** 꺾은선 줄이기(Ramer–Douglas–Peucker, 허용 px) — 키가 너무 많아지지 않게. pts = [{t, x, y}] */
export function simplify(pts, tol = 0.35) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const k = (pts[i].t - pts[a].t) / ((pts[b].t - pts[a].t) || 1);
      const d = Math.max(Math.abs(pts[a].x + (pts[b].x - pts[a].x) * k - pts[i].x), Math.abs(pts[a].y + (pts[b].y - pts[a].y) * k - pts[i].y));
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
