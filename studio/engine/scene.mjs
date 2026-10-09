// HTML 장면 (2026-10-10 사용자 "몽타주 뭐시기나 하이퍼프레임처럼") — HTML 파일 하나가 영상의 한 장면이 된다.
// HyperFrames(HeyGen, Apache-2.0)처럼 페이지를 시각마다 멈춰 세우고(seek) 한 장씩 찍어 영상으로 만든다. 코드는 ODDIN 이 새로 짰다.
// 시각 맞추기 순서: 페이지의 window.oddinSeek(t) → HyperFrames 식 window.__timelines(GSAP) → gsap 전역 타임라인 → CSS·Web Animations → <video>·<audio>.
// 배경은 투명(영상 위에 겹쳐 쓰기). Math.random 은 고정 씨앗으로 바꿔 같은 입력이면 같은 결과가 나오게 한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { guardChild, killChildTree } from '../../lib/util.mjs';
import { CACHE_DIR, UI_DIR, error } from './env.mjs';
import { tools, rate, f6, even, sceneMeta } from './media.mjs';

/** 페이지가 읽히기 전에 넣는 스크립트: 고정 씨앗 무작위 */
export const PRE_JS = `(() => { let s = 0x2f6b9c1d; Math.random = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();`;
/** 시각 맞추기 도우미(ui/scene-seek.js — 편집기 미리보기와 같은 파일)를 페이지에 심는다 */
export const SEEK_JS = () => fs.readFileSync(path.join(UI_DIR, 'scene-seek.js'), 'utf8');

/** 장면 폴더의 파일들(그림·글꼴·스크립트)이 바뀌면 다시 렌더하도록 서명을 만든다 */
function sceneSig(file, extra) {
  const h = crypto.createHash('sha1').update(fs.readFileSync(file)).update(extra);
  const dir = path.dirname(file);
  try { for (const n of fs.readdirSync(dir).sort().slice(0, 300)) { const st = fs.statSync(path.join(dir, n)); if (st.isFile()) h.update(`${n}|${st.size}|${st.mtimeMs}`); } } catch {}
  return h.digest('hex').slice(0, 24);
}

/**
 * HTML 장면 → 영상. out 이 .mov 면 투명(PNG 코덱), .mp4·.webm 이면 배경색 위에.
 * browser: lib/browser.mjs BrowserManager, url: 엔진이 내주는 장면 주소(상대 경로 그림이 이어지게).
 */
export async function renderScene({ browser, config, file, url, out, width, height, fps = 30, duration, background = '#000000', onFrame = null, isCancelled = () => false, children = null, owner = null }) {
  const { ffmpeg } = tools(config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요');
  if (!browser) throw error(500, 'HTML 장면을 그리려면 브라우저(Edge·Chrome)가 필요해요');
  const meta = sceneMeta(file);
  const W = even(width || meta.width || 1080), H = even(height || meta.height || 1920), D = Number(duration || meta.duration || 5);
  const frames = Math.max(1, Math.round(D * fps));
  const alpha = /\.mov$/i.test(out);
  const args = ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'png', '-framerate', rate(fps), '-i', 'pipe:0'];
  if (alpha) args.push('-frames:v', String(frames), '-c:v', 'png', '-pix_fmt', 'rgba', out);
  else args.push('-f', 'lavfi', '-i', `color=c=${String(background).replace('#', '0x').slice(0, 8)}:s=${W}x${H}:r=${rate(fps)}`, '-filter_complex', '[1:v][0:v]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]', '-map', '[v]', '-frames:v', String(frames), '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  const child = guardChild(spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }));
  children?.add(child);
  let errTail = '';
  child.stderr.on('data', (b) => { errTail = (errTail + b).slice(-3000); });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => { children?.delete(child); code === 0 ? resolve() : reject(new Error(errTail.trim().split('\n').slice(-2).join(' ') || `ffmpeg 종료 코드 ${code}`)); }); });
  const write = (buf) => new Promise((resolve, reject) => { if (child.stdin.destroyed) return reject(new Error('ffmpeg 입력이 닫혔어요')); child.stdin.write(buf, (e) => (e ? reject(e) : resolve())); });
  const who = owner || `studio-scene/${crypto.randomBytes(4).toString('hex')}`;
  let feedErr = null;
  const feed = (async () => {
    const tab = await browser.tabOf(who);
    try {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, tab.session);
      await browser.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, tab.session);
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PRE_JS }, tab.session);
      const nav = await browser.send('Page.navigate', { url }, tab.session, 30_000);
      if (nav.errorText) throw new Error(`장면을 열지 못했어요: ${nav.errorText}`);
      let ready = false;
      for (let i = 0; i < 200 && !ready; i++) { await new Promise((r) => setTimeout(r, 100)); try { ready = await browser.evaluate(tab, 'document.readyState === "complete"', 10_000); } catch {} }
      if (!ready) throw new Error('장면 페이지가 다 읽히지 않았어요');
      await browser.evaluate(tab, SEEK_JS(), 10_000);
      for (let f = 0; f < frames; f++) {
        if (isCancelled()) throw new Error('중지');
        await browser.evaluate(tab, `__oddinSeekAny(${f6(f / fps)})`, 30_000);
        const shot = await browser.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, captureBeyondViewport: false }, tab.session, 60_000);
        await write(Buffer.from(shot.data, 'base64'));
        onFrame?.(f + 1, frames);
      }
      child.stdin.end();
    } finally { try { await browser.act(who, { action: 'close' }); } catch {} }
  })().catch((e) => { feedErr = e; killChildTree(child); });
  try { await exited; } catch (e) { await feed; throw feedErr || e; }
  await feed; if (feedErr) throw feedErr;
  return { out, width: W, height: H, fps, duration: D, frames, alpha };
}

/** 편집 렌더용: 장면을 투명 영상(.mov)으로 한 번 만들어 두고 같은 장면이면 다시 쓴다 */
export async function sceneClip(opts) {
  const { file, width, height, fps, duration } = opts;
  const sig = sceneSig(file, `${width}x${height}@${fps}:${duration}`);
  const out = path.join(CACHE_DIR, 'scenes', `${sig}.mov`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out.replace(/\.mov$/, `.${process.pid}.tmp.mov`);
  try { await renderScene({ ...opts, out: tmp }); fs.renameSync(tmp, out); } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  return out;
}
