// 원본 정보·파형·썸네일 (ffprobe·ffmpeg) — data/cache 에 보관
// 원본 종류: 영상·소리(video), 그림(image — png·jpg·webp·gif 한 장, 길이 없음), HTML 장면(html — scene.mjs 가 렌더)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { guardChild, killChildTree } from '../../lib/util.mjs';
import { CACHE_DIR, error } from './env.mjs';

export const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mts|m2ts|wmv|mxf)$/i;
export const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff)$/i;
export const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;
export const HTML_RE = /\.html?$/i;
export const mediaKind = (file) => (HTML_RE.test(file) ? 'html' : IMAGE_RE.test(file) ? 'image' : VIDEO_RE.test(file) || AUDIO_RE.test(file) ? 'video' : null);

export const f6 = (v) => { const s = (Math.round(v * 1e6) / 1e6).toString(); return s.includes('e') ? v.toFixed(6) : s; };
export const even = (v) => Math.max(2, Math.round(v / 2) * 2);
export const rate = (fps) => (Math.abs(fps - 29.97) < 0.01 ? '30000/1001' : Math.abs(fps - 59.94) < 0.01 ? '60000/1001' : Math.abs(fps - 23.976) < 0.01 ? '24000/1001' : f6(fps));

/* ---------- ffmpeg 찾기 ---------- */
let BIN = null;
export function tools(config = {}) {
  if (BIN) return BIN;
  const found = (name) => {
    const custom = config.video?.[name]; if (custom && fs.existsSync(custom)) return custom;
    try { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true }); const line = (r.stdout || '').split(/\r?\n/).find((l) => l.trim()); if (line) return line.trim(); } catch {}
    for (const p of ['C:/ffmpeg/bin', 'C:/Program Files/ffmpeg/bin']) { const f = path.join(p, `${name}${process.platform === 'win32' ? '.exe' : ''}`); if (fs.existsSync(f)) return f; }
    return null;
  };
  BIN = { ffmpeg: found('ffmpeg'), ffprobe: found('ffprobe') };
  return BIN;
}
export function run(bin, args, { input = null, onStdout = null, timeoutMs = 0, children = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = guardChild(spawn(bin, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    children?.add(child);
    let err = '', timer = null;
    child.stdout.on('data', (b) => (onStdout ? onStdout(b) : null));
    child.stderr.on('data', (b) => { err = (err + b).slice(-6000); });
    if (timeoutMs) timer = setTimeout(() => { killChildTree(child); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); children?.delete(child); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); children?.delete(child); code === 0 ? resolve({ code, err }) : reject(Object.assign(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${code}`), { code })); });
    if (input) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

const cacheKey = (file, extra = '') => { const st = fs.statSync(file); return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 24); };

/** HTML 장면의 길이·크기: <html data-duration data-width data-height> 또는 <meta name="oddin-scene" content="duration=5;width=1080;height=1920"> */
export function sceneMeta(file) {
  const head = fs.readFileSync(file, 'utf8').slice(0, 20000);
  const html = head.match(/<html\b[^>]*>/i)?.[0] || '';
  const attr = (k) => { const m = html.match(new RegExp(`data-${k}\\s*=\\s*["']?([\\d.]+)`, 'i')); return m ? Number(m[1]) : null; };
  const meta = head.match(/<meta[^>]+name=["']oddin-scene["'][^>]*>/i)?.[0] || '';
  const mv = (k) => { const m = meta.match(new RegExp(`${k}\\s*=\\s*([\\d.]+)`, 'i')); return m ? Number(m[1]) : null; };
  // HyperFrames 식 루트(data-composition-id)의 data-duration 도 읽는다
  const root = (k) => { const m = head.match(new RegExp(`data-composition-id[^>]*data-${k}\\s*=\\s*["']?([\\d.]+)`, 'i')) || head.match(new RegExp(`data-${k}\\s*=\\s*["']?([\\d.]+)[^>]*data-composition-id`, 'i')); return m ? Number(m[1]) : null; };
  return { duration: attr('duration') ?? mv('duration') ?? root('duration') ?? 0, width: attr('width') ?? mv('width') ?? root('width') ?? 0, height: attr('height') ?? mv('height') ?? root('height') ?? 0 };
}

/** 원본 정보: { kind, duration, width, height, fps, video, audio, rotation, codec } */
export async function probe(file, config) {
  const kind = mediaKind(file);
  if (kind === 'html') { const m = sceneMeta(file); return { kind, duration: m.duration || 5, width: m.width || 0, height: m.height || 0, fps: 0, video: true, audio: false, rotation: 0, codec: 'html' }; }
  const { ffprobe } = tools(config); if (!ffprobe) throw error(500, 'ffprobe를 찾지 못했어요(ffmpeg 설치 필요)');
  const key = cacheKey(file, 'probe2'), cf = path.join(CACHE_DIR, `${key}.probe.json`);
  try { return JSON.parse(fs.readFileSync(cf, 'utf8')); } catch {}
  let out = '';
  await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { onStdout: (b) => { out += b; }, timeoutMs: 30_000 });
  const j = JSON.parse(out || '{}'), v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)), a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fr = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : 0; };
  let rot = 0;
  if (v) { const sd = (v.side_data_list || []).find((x) => x.rotation != null); rot = Number(sd?.rotation ?? v.tags?.rotate ?? 0) || 0; }
  const swap = Math.abs(rot) % 180 === 90;
  const still = kind === 'image' || /image2|_pipe$/.test(j.format?.format_name || '') && !a && !(Number(v?.nb_frames) > 1);
  const info = { kind: still ? 'image' : 'video', duration: still ? 0 : Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0, width: v ? (swap ? v.height : v.width) : 0, height: v ? (swap ? v.width : v.height) : 0,
    fps: v && !still ? Math.round((fr(v.avg_frame_rate) || fr(v.r_frame_rate)) * 1000) / 1000 : 0, video: !!v, audio: !!a, rotation: rot, codec: v?.codec_name || a?.codec_name || '' };
  fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(info));
  return info;
}
/** 파형: 초당 100개, 0~127 (절댓값 최대). 캐시 */
export async function peaks(file, config) {
  const { ffmpeg } = tools(config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요');
  const key = cacheKey(file, 'peaks'), cf = path.join(CACHE_DIR, `${key}.peaks`);
  try { return fs.readFileSync(cf); } catch {}
  const per = 40, out = []; let cur = 0, n = 0, carry = null;
  await run(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'], {
    timeoutMs: 10 * 60_000,
    onStdout: (b) => {
      if (carry) { b = Buffer.concat([carry, b]); carry = null; }
      const len = b.length - (b.length % 2); if (b.length % 2) carry = b.subarray(len);
      for (let i = 0; i < len; i += 2) { const v = Math.abs(b.readInt16LE(i)); if (v > cur) cur = v; if (++n === per) { out.push(Math.min(127, Math.round(cur / 32768 * 127))); cur = 0; n = 0; } }
    },
  });
  if (n) out.push(Math.min(127, Math.round(cur / 32768 * 127)));
  const buf = Buffer.from(out);
  fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cf, buf);
  return buf;
}
/** 썸네일 띠: 높이 64px 칸을 가로로 이은 JPEG 한 장 + 간격 */
export async function thumbs(file, config) {
  const { ffmpeg } = tools(config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요');
  const info = await probe(file, config); if (!info.video || info.kind === 'html') throw error(400, '영상이 없는 파일이에요');
  const H = 64, W = even(H * (info.width || 16) / (info.height || 9));
  if (info.kind === 'image') { // 그림은 한 칸
    const key = cacheKey(file, `thumbs${H}`), img = path.join(CACHE_DIR, `${key}.thumbs.jpg`), meta = { step: 1e9, count: 1, w: W, h: H, file: img };
    if (!fs.existsSync(img)) { fs.mkdirSync(CACHE_DIR, { recursive: true }); await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', `scale=${W}:${H}`, '-frames:v', '1', '-q:v', '6', img], { timeoutMs: 60_000 }); }
    return meta;
  }
  const n = Math.max(1, Math.min(300, Math.floor(65000 / W), Math.ceil(info.duration / 1)));
  const step = Math.max(0.5, info.duration / n), count = Math.max(1, Math.ceil(info.duration / step));
  const key = cacheKey(file, `thumbs${H}`), img = path.join(CACHE_DIR, `${key}.thumbs.jpg`), meta = { step, count, w: W, h: H, file: img };
  if (fs.existsSync(img)) return meta;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', `fps=1/${f6(step)},scale=${W}:${H},tile=${count}x1`, '-frames:v', '1', '-q:v', '6', img], { timeoutMs: 10 * 60_000 });
  return meta;
}
