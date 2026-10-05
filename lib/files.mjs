// 허브가 아는 폴더의 파일을 읽는다. 탐색기 열기와 경로 해석 규칙을 공유한다.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeLocalPath, resolveRelative, isAllowed } from './opener.mjs';

const run = promisify(execFile);
export const TEXT_LIMIT = 1024 * 1024;
const LANGUAGES = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', json: 'json', md: 'markdown', css: 'css', html: 'html', htm: 'html', svg: 'xml', xml: 'xml', yaml: 'yaml', yml: 'yaml', py: 'python', ps1: 'powershell', sh: 'bash', bash: 'bash', bat: 'batch', cmd: 'batch', sql: 'sql', lua: 'lua', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', toml: 'toml', ini: 'ini', txt: 'plaintext', log: 'plaintext', csv: 'plaintext', srt: 'plaintext', vtt: 'plaintext', env: 'plaintext' };
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', pdf: 'application/pdf' };
const error = (status, message) => Object.assign(new Error(message), { status });
export const languageFor = (file) => LANGUAGES[path.extname(file).slice(1).toLowerCase()] || 'plaintext';

export function resolveFile(body, roots) {
  const target = normalizeLocalPath(resolveRelative(body, roots));
  if (!target) throw error(400, '읽을 수 없는 경로 형식이에요');
  if (!isAllowed(target, roots)) throw error(403, '허브가 아는 폴더 안의 파일만 볼 수 있어요');
  let real;
  try { real = fs.realpathSync.native(target); } catch { throw error(404, '경로를 찾지 못했어요'); }
  // opener의 동작은 유지하되, 읽기에서는 바깥으로 향하는 정션·심볼릭 링크도 차단한다.
  const realRoots = roots.filter(Boolean).flatMap((root) => { try { return [fs.realpathSync.native(root)]; } catch { return []; } });
  if (!isAllowed(real, realRoots)) throw error(403, '허브가 아는 폴더 안의 파일만 볼 수 있어요');
  return real;
}

function metadata(file, st) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return { path: file, name: path.basename(file), size: st.size, modifiedAt: st.mtime.toISOString(), language: languageFor(file), contentType: MEDIA[ext] || 'text/plain; charset=utf-8' };
}

export function inspectFile(file, fd, st) {
  const meta = metadata(file, st), ext = path.extname(file).slice(1).toLowerCase();
  if (MEDIA[ext]) return { ...meta, kind: ext === 'pdf' ? 'pdf' : MEDIA[ext].split('/')[0], streaming: true };
  const sample = Buffer.alloc(Math.min(st.size, TEXT_LIMIT));
  const n = fs.readSync(fd, sample, 0, sample.length, 0), bytes = sample.subarray(0, n);
  let content, encoding = 'utf-8', bom = false;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; bom = true; content = bytes.subarray(2).toString('utf16le'); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; bom = true; content = new TextDecoder('utf-16be').decode(bytes.subarray(2)); }
  else {
    bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: st.size > TEXT_LIMIT }); } catch { encoding = 'unknown'; }
  }
  const knownText = Boolean(LANGUAGES[ext]) || /^(dockerfile|makefile|\.gitignore|\.env)$/i.test(meta.name);
  const binary = encoding === 'unknown' || (!bom && bytes.includes(0)) || (content && /[\x01-\x08\x0b\x0e-\x1f]/.test(content));
  if (binary && !knownText) return { ...meta, contentType: 'application/octet-stream', kind: 'binary', streaming: false };
  if (st.size > TEXT_LIMIT) return { ...meta, kind: 'text', streaming: false, encoding, bom, tooLarge: true, content: null, message: '텍스트는 1MB까지 볼 수 있어요' };
  return { ...meta, kind: 'text', streaming: false, encoding, bom, tooLarge: false, content: content ?? null, ...(encoding === 'unknown' ? { message: 'UTF-8이 아닌 파일이에요. 인코딩을 확인해 주세요' } : {}) };
}

export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) throw error(416, '요청한 파일 범위를 읽을 수 없어요');
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw error(416, '요청한 파일 범위를 읽을 수 없어요'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) throw error(416, '요청한 파일 범위를 읽을 수 없어요');
  return { start, end: Math.min(end, size - 1) };
}

export function serveFile(req, res, body, roots, json) {
  const file = resolveFile(body, roots), fd = fs.openSync(file, 'r');
  let streaming = false;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw error(400, '파일을 골라 주세요');
    const meta = inspectFile(file, fd, st);
    if (!meta.streaming || body.meta === '1') { json(res, meta); return; }
    let range;
    try { range = parseRange(req.headers.range, st.size); }
    catch (e) { res.writeHead(e.status, { 'Content-Range': `bytes */${st.size}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(); return; }
    const headers = { 'Content-Type': meta.contentType, 'Content-Length': range ? range.end - range.start + 1 : st.size, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'X-File-Language': meta.language, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': "sandbox; default-src 'none'" };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file, { fd, autoClose: true, ...(range || {}) }); streaming = true;
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  } finally { if (!streaming) fs.closeSync(fd); }
}

/*
 * 결과 페이지 보기(2026-10-05 "시안을 원격으로 보여달라는 단순 작업에도 5분 넘게"): 작업 결과 HTML·그림·영상을
 * 허브 주소로 그대로 연다. 원격(Tailscale)에서도 같은 주소라 따로 게시(public/ 복사)할 필요가 없다.
 * 주소가 폴더 구조를 그대로 따르므로(/view/F:/…/index.html) 페이지 안 상대 경로(그림·CSS·JS)도 이어진다.
 * 허브 화면·API 와 섞이지 않게 CSP sandbox(고유 출처 없음)로 띄운다 — 쓰기 API 는 출처 검사로 막히고 읽기 응답도 못 읽는다.
 */
const VIEW_TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm' };
export const VIEW_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads allow-pointer-lock';
/** 화면에서 만드는 보기 주소: 경로 조각마다 인코딩하고 구분자는 / 로 */
export const viewUrl = (file) => '/view/' + String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
export function serveView(req, res, pathname, roots) {
  let raw;
  try { raw = decodeURIComponent(pathname.replace(/^\/view\//, '')); } catch { throw error(400, '읽을 수 없는 경로 형식이에요'); }
  let file = resolveFile({ path: raw }, roots), st = fs.statSync(file);
  if (st.isDirectory()) {
    // 폴더 주소는 끝에 / 를 붙여야 index.html 안의 상대 경로가 그 폴더 기준이 된다
    if (!/[\\/]$/.test(raw)) { res.writeHead(302, { Location: viewUrl(raw) + '/', 'Cache-Control': 'no-store' }); res.end(); return; }
    file = resolveFile({ path: path.join(file, 'index.html') }, roots); st = fs.statSync(file);
  }
  if (!st.isFile()) throw error(400, '파일을 골라 주세요');
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = VIEW_TYPES[ext] || MEDIA[ext] || 'application/octet-stream';
  let range;
  try { range = parseRange(req.headers.range, st.size); }
  catch (e) { res.writeHead(e.status, { 'Content-Range': `bytes */${st.size}`, 'Cache-Control': 'no-store' }); res.end(); return; }
  const headers = { 'Content-Type': type, 'Content-Length': range ? range.end - range.start + 1 : st.size, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': VIEW_CSP, 'Referrer-Policy': 'no-referrer' };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file, range || {});
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

export async function listFiles(body, roots) {
  const dir = resolveFile(body, roots);
  if (!fs.statSync(dir).isDirectory()) throw error(400, '폴더를 골라 주세요');
  const hidden = new Set();
  if (process.platform === 'win32') {
    const script = `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(dir).toString('base64')}')); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::Hidden } | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress`;
    const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }).catch(() => { throw error(500, '숨김 파일 정보를 읽지 못했어요'); });
    const names = stdout.trim() ? JSON.parse(stdout) : []; for (const name of Array.isArray(names) ? names : [names]) hidden.add(name);
  }
  const entries = []; let truncated = false;
  for await (const entry of await fs.promises.opendir(dir)) {
    const isHidden = entry.name.startsWith('.') || hidden.has(entry.name);
    if (isHidden && body.hidden !== '1' && body.hidden !== true) continue;
    if (entries.length >= 2000) { truncated = true; break; }
    const full = path.join(dir, entry.name);
    try {
      const st = fs.lstatSync(full);
      entries.push({ name: entry.name, path: full, kind: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'directory' : 'file', size: st.size, modifiedAt: st.mtime.toISOString(), hidden: isHidden, language: languageFor(full) });
    } catch { /* 목록을 읽는 중 사라진 파일은 생략한다. */ }
  }
  entries.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'ko'));
  return { path: dir, entries, truncated, limit: 2000 };
}
