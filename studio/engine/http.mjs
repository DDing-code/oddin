// 엔진의 두 HTTP 서버(화면·API = server.mjs, 장면 출처 = scene-origin.mjs)가 같이 쓰는 파일 보내기
import fs from 'node:fs';
import path from 'node:path';
import { parseRange } from '../../lib/files.mjs';
import { error } from './env.mjs';

const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', srt: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8', lottie: 'application/json' };
export const typeOf = (f) => TYPES[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
/** 브라우저가 문서로 열면 그 안의 스크립트가 도는 종류(HTML·SVG) */
export const isActiveDoc = (f) => /^(text\/html|image\/svg\+xml)/.test(typeOf(f));

/**
 * 파일 보내기(구간 요청 지원 — 영상 앞뒤로 옮기기).
 * sandbox: 사용자 폴더의 HTML·SVG 를 엔진 출처에서 내줄 때 — 스크립트 없이 보기만 하게 한다(Content-Security-Policy: sandbox).
 *          받아 온 장면이 엔진과 같은 출처로 돌면 엔진 API 를 부를 수 있기 때문. 스크립트가 도는 장면은 장면 출처(scene-origin.mjs)에서만 띄운다.
 */
export function sendFile(req, res, file, { cache = 'no-store', sandbox = false } = {}) {
  const st = fs.statSync(file); if (!st.isFile()) throw error(400, '파일을 골라 주세요');
  let range = null;
  try { range = parseRange(req.headers.range, st.size); } catch (e) { res.writeHead(e.status || 416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
  const headers = { 'Content-Type': typeOf(file), 'Content-Length': range ? range.end - range.start + 1 : st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' };
  if (sandbox && isActiveDoc(file)) headers['Content-Security-Policy'] = 'sandbox';
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(file, range || {}); s.on('error', () => res.destroy()); res.on('close', () => s.destroy()); s.pipe(res);
}
