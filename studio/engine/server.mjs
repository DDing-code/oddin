#!/usr/bin/env node
// ODDIN 스튜디오 엔진 (2026-10-10 사용자 "오딘과 연동(프리미어/애프터이펙트 플러그인처럼)되는 프로그램으로 만들고 싶은데").
//   node studio/engine/server.mjs [--port 7710]
// 127.0.0.1 에만 열린다. 화면(ui/)·API(/api/*)를 내주고, 켜지면 ODDIN 허브에 자기를 알린다(hub.mjs).
// 원격(폰 등)은 허브의 /studio/ 프록시로만 들어온다 — 허브가 x-oddin-remote 를 붙이면 열 수 있는 폴더를 허브 열기 범위로 줄인다.
// 다른 웹페이지가 이 주소로 몰래 요청하지 못하게: Host 는 127.0.0.1·localhost 만, 쓰기 요청은 출처가 자기이거나 허브 프록시(x-oddin-via)·명령줄(출처 없음)만.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveFile, parseRange } from '../../lib/files.mjs';
import { BrowserManager, findBrowser } from '../../lib/browser.mjs';
import { STUDIO_DIR, HUB_ROOT, UI_DIR, DATA_DIR, VERSION, loadConfig, error } from './env.mjs';
import { tools, probe, peaks, thumbs, mediaKind, VIDEO_RE } from './media.mjs';
import { listFonts, installableFonts, installFonts } from './fonts.mjs';
import { Editor, core, plain, relOrAbs, freshEditPath, checkEditName, rawPath, EDIT_EXT } from './edit.mjs';
import { renderScene } from './scene.mjs';
import { premiereToEdit } from './premiere.mjs';
import { HubLink } from './hub.mjs';

const args = process.argv.slice(2);
const config = loadConfig();
if (args.includes('--port')) config.port = Number(args[args.indexOf('--port') + 1]) || config.port;
const PORT = config.port, SELF = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(DATA_DIR, { recursive: true });

const browser = new BrowserManager({ exe: config.browser?.exe || null, profile: path.join(DATA_DIR, 'browser-profile'), headless: true, width: 1080, height: 1920 });
const editor = new Editor({ config, browser: findBrowser(config.browser?.exe) ? browser : null, engineUrl: () => SELF });
const appWindows = new Map(); // 창(SSE ?app=1) id → res
const hub = new HubLink({ hubUrl: config.hubUrl, port: PORT, app: () => ({ windows: appWindows.size }) });

/* ---------- 실시간 알림(SSE) ---------- */
const clients = new Set();
function broadcast(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) { try { c.write(s); } catch {} } }
editor.on('event', broadcast);
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch {} } }, 20_000).unref();

/* ---------- 최근 편집 ---------- */
const RECENT = path.join(DATA_DIR, 'recent.json');
const readRecent = () => { try { return JSON.parse(fs.readFileSync(RECENT, 'utf8')).filter((x) => x && x.path); } catch { return []; } };
function touchRecent(file, title = null) {
  const list = readRecent().filter((x) => x.path.toLowerCase() !== file.toLowerCase());
  list.unshift({ path: file, title: title || path.basename(file, EDIT_EXT), at: new Date().toISOString() });
  try { fs.writeFileSync(RECENT, JSON.stringify(list.slice(0, 40), null, 1)); } catch {}
}

/* ---------- HTTP 도우미 ---------- */
const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', srt: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8', lottie: 'application/json' };
const typeOf = (f) => TYPES[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
function json(res, data, status = 200) { const b = Buffer.from(JSON.stringify(data)); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); res.end(b); }
function fail(res, msg, status = 400, code) { if (!res.headersSent) json(res, { error: msg, ...(code ? { code } : {}) }, status); else res.end(); }
function readBody(req, limit = 20_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(error(413, '보낸 내용이 너무 커요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); if (!t) return resolve({}); try { resolve(JSON.parse(t)); } catch { reject(error(400, 'JSON 형식이 아니에요')); } });
    req.on('error', reject);
  });
}
/** 파일 보내기(구간 요청 지원 — 영상 앞뒤로 옮기기) */
function sendFile(req, res, file, { cache = 'no-store' } = {}) {
  const st = fs.statSync(file); if (!st.isFile()) throw error(400, '파일을 골라 주세요');
  let range = null;
  try { range = parseRange(req.headers.range, st.size); } catch (e) { res.writeHead(e.status || 416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
  const headers = { 'Content-Type': typeOf(file), 'Content-Length': range ? range.end - range.start + 1 : st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${st.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(file, range || {}); s.on('error', () => res.destroy()); res.on('close', () => s.destroy()); s.pipe(res);
}

/* ---------- 경로 허용 ---------- */
const isRemote = (req) => req.headers['x-oddin-remote'] === '1';
/** 이 요청이 열 수 있는 경로를 고른다: 이 PC 화면·명령줄은 어디든, 원격(허브 프록시)은 허브 열기 범위만 */
async function allowedFor(req) {
  if (!isRemote(req)) return (p) => { const abs = path.resolve(String(p || '')); if (!p || !fs.existsSync(abs)) throw error(404, `경로를 찾지 못했어요: ${p}`); return abs; };
  let roots; try { roots = await hub.roots(); } catch { throw error(503, '원격에서 열려면 ODDIN 이 켜져 있어야 해요'); }
  return (p) => resolveFile({ path: String(p || '') }, roots);
}
/** 아직 없는 파일(저장·새로 만들기): 폴더를 허용 검사하고 이름을 붙인다 */
const allowedNew = (allowed, file) => path.join(allowed(path.dirname(path.resolve(String(file || '')))), path.basename(String(file || '')));

/* ---------- 요청 지키기 ---------- */
function guard(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) throw error(403, '이 주소로는 열 수 없어요');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-oddin-via'] === 'hub') return; // 허브 프록시(허브가 원격 권한을 이미 봄)
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) throw error(403, '다른 페이지에서 온 요청은 받지 않아요');
}

/* ---------- 작업(렌더 말고 오래 걸리는 것: HTML 장면 → 영상) ---------- */
const scenes = new Map();
async function sceneJob({ file, out, width, height, fps, duration, wait }) {
  const id = crypto.randomBytes(5).toString('hex');
  const j = { id, path: file, out, status: 'running', progress: 0, error: null, startedAt: new Date().toISOString(), children: new Set() };
  scenes.set(id, j);
  const pub = () => ({ id, path: j.path, out: j.out, status: j.status, progress: j.progress, error: j.error, result: j.result || null });
  const tell = () => broadcast({ type: 'scene', scene: pub() });
  const p = renderScene({ browser, config, file, url: `${SELF}/api/raw/${rawPath(file)}`, out, width, height, fps, duration, children: j.children, onFrame: (f, n) => { j.progress = f / n; if (f % 10 === 0 || f === n) tell(); } })
    .then((r) => { j.status = 'done'; j.result = r; }).catch((e) => { j.status = 'failed'; j.error = e.message; try { fs.rmSync(out, { force: true }); } catch {} }).finally(tell);
  if (wait) await p;
  return pub();
}

/* ---------- 프리미어 ---------- */
async function premiereStatus() {
  const r = await hub.premiere('return ODDIN.pr.status();', 30);
  if (!r.ok) throw error(409, r.error || '프리미어에 연결하지 못했어요');
  return r.result;
}
async function premiereImport({ sequence = null, outDir = null }) {
  const sel = sequence ? (/^\d+$/.test(String(sequence)) ? { id: String(sequence) } : { name: String(sequence) }) : {};
  const r = await hub.premiere(`return ODDIN.pr.editExport(${JSON.stringify(sel)});`, 300);
  if (!r.ok) throw error(409, /editExport/.test(r.error || '') ? '프리미어 안 ODDIN 플러그인이 예전 판이에요. ODDIN 을 새 판으로 바꾼 뒤 프리미어를 다시 켜 주세요' : (r.error || '프리미어에서 시퀀스를 읽지 못했어요'));
  const seq = r.result || {};
  const projDir = seq.project ? path.dirname(seq.project) : null;
  const dir = outDir ? path.resolve(outDir) : projDir;
  if (!dir || !fs.existsSync(dir)) throw error(400, '편집 파일을 둘 폴더를 정해 주세요(프로젝트를 저장하지 않았으면 폴더를 골라야 해요)');
  const file = freshEditPath(dir, seq.name || '프리미어 시퀀스');
  const probes = new Map();
  for (const tr of [...(seq.video || []), ...(seq.audio || [])]) for (const c of tr.clips || []) {
    const f = c.media ? path.resolve(c.media) : ''; if (!f || probes.has(f) || !fs.existsSync(f)) continue;
    try { probes.set(f, await probe(f, config)); } catch {}
  }
  const { doc, problems } = premiereToEdit(seq, probes, file, { relOrAbs, styleDefault: plain(core().STYLE_DEFAULT) });
  const s = editor.save(file, doc);
  touchRecent(s.path, doc.title);
  return { path: s.path, problems: [...problems, ...s.problems], sequence: seq.name, clips: doc.tracks.reduce((n, t) => n + (t.clips || t.items).length, 0) };
}

/* ---------- 파이프라인(합친 스킬의 제작 흐름) ---------- */
function pipelines() {
  const dir = path.join(STUDIO_DIR, 'pipelines'); const out = [];
  try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.json')) { try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch {} } } catch {}
  return out.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}
function pipelineGoal(p, inputs = {}) {
  let text = String(p.prompt || '');
  for (const f of p.inputs || []) text = text.replaceAll(`{${f.key}}`, String(inputs[f.key] ?? '').trim() || (f.optional ? '(없음)' : ''));
  return `[ODDIN 스튜디오 · ${p.name}] ${text}\n\n공유 스킬 oddin-studio 의 파이프라인 "${p.id}"(pipelines/${p.id}/PIPELINE.md)를 따르세요. 도구: node "${path.join(STUDIO_DIR, 'cli.mjs')}" (스튜디오 엔진 ${SELF}).`;
}

/* ---------- 폴더 목록(원본 패널) ---------- */
function listDir(dir) {
  const out = { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries: [], truncated: false };
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || /^(\$recycle\.bin|system volume information|node_modules)$/i.test(e.name)) continue;
    if (out.entries.length >= 3000) { out.truncated = true; break; }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.entries.push({ name: e.name, path: full, kind: 'dir' }); continue; }
    const kind = full.toLowerCase().endsWith(EDIT_EXT) ? 'edit' : /\.srt$/i.test(e.name) ? 'srt' : /\.(ttf|otf|ttc)$/i.test(e.name) ? 'font' : mediaKind(full);
    if (!kind) continue;
    let st = null; try { st = fs.statSync(full); } catch {}
    out.entries.push({ name: e.name, path: full, kind: kind === 'video' ? (/\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff)$/i.test(e.name) ? 'audio' : 'video') : kind, size: st?.size || 0, mtime: st?.mtimeMs || 0 });
  }
  out.entries.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name, 'ko'));
  return out;
}
/** 올리기(원격·브라우저 끌어놓기): 받은 몸통을 그 폴더에 새 이름으로 */
function receiveUpload(req, dir, name) {
  const clean = path.basename(String(name || 'upload')).replace(/[\\/:*?"<>|]+/g, '_') || 'upload';
  if (!mediaKind(clean) && !/\.(srt|ttf|otf|ttc)$/i.test(clean)) throw error(400, '영상·소리·그림·HTML·SRT·글꼴 파일만 올릴 수 있어요');
  let file = path.join(dir, clean);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${path.basename(clean, path.extname(clean))} (${i})${path.extname(clean)}`);
  const tmp = `${file}.${process.pid}.part`;
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp); let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 20 * 1024 ** 3) { req.destroy(); ws.destroy(); fs.rmSync(tmp, { force: true }); reject(error(413, '20GB 보다 큰 파일은 올릴 수 없어요')); } });
    req.pipe(ws);
    ws.on('finish', () => { try { fs.renameSync(tmp, file); resolve({ path: file, size: n }); } catch (e) { reject(e); } });
    ws.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
    req.on('aborted', () => { ws.destroy(); fs.rmSync(tmp, { force: true }); reject(error(400, '올리다 끊겼어요')); });
  });
}

/* ---------- 창 열기(프로그램 창이 없으면 띄운다) ---------- */
function electronExe() {
  const exe = path.join(STUDIO_DIR, 'app', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  return fs.existsSync(exe) ? exe : null;
}
let launchedAt = 0;
function launchWindow(openPath = null) {
  if (Date.now() - launchedAt < 8000) return { launched: false, reason: '이미 창을 띄우는 중이에요' };
  launchedAt = Date.now();
  const exe = electronExe();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (exe) {
    const p = spawn(exe, [path.join(STUDIO_DIR, 'app'), ...(openPath ? ['--open', openPath] : [])], { detached: true, stdio: 'ignore', windowsHide: false, env });
    p.on('error', () => {}); p.unref(); return { launched: true, how: 'app' };
  }
  // 프로그램(Electron)을 아직 설치하지 않았으면 Edge 앱 창으로
  const b = findBrowser(config.browser?.exe); if (!b) return { launched: false, reason: '프로그램도 Edge·Chrome 도 찾지 못했어요' };
  const p = spawn(b, [`--app=${SELF}/${openPath ? `?${openPath.toLowerCase().endsWith(EDIT_EXT) ? 'path' : 'video'}=${encodeURIComponent(openPath)}` : ''}`, `--user-data-dir=${path.join(DATA_DIR, 'window-profile')}`, '--no-first-run', '--window-size=1500,950'], { detached: true, stdio: 'ignore', env });
  p.on('error', () => {}); p.unref(); return { launched: true, how: 'browser' };
}

/* ---------- 라우터 ---------- */
async function route(req, res, url) {
  const p = url.pathname, q = (k) => url.searchParams.get(k) || '', M = req.method;
  // 화면
  if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(UI_DIR, 'index.html'));
  if (p.startsWith('/ui/')) { const f = path.resolve(UI_DIR, decodeURIComponent(p.slice(4))); if (!f.startsWith(UI_DIR + path.sep)) throw error(403, '안 돼요'); return sendFile(req, res, f, { cache: 'no-cache' }); }
  if (p === '/shared/themes.css' || p === '/shared/themes.js') return sendFile(req, res, path.join(HUB_ROOT, 'public', path.basename(p)), { cache: 'no-cache' });
  if (p === '/favicon.ico' || p === '/favicon.svg') return sendFile(req, res, path.join(UI_DIR, 'icon.svg'));
  if (!p.startsWith('/api/')) throw error(404, '없는 주소예요');

  // 상태·알림
  if (p === '/api/status') { const t = tools(config); return json(res, { app: 'oddin-studio', version: VERSION, root: HUB_ROOT, port: PORT, pid: process.pid, tools: { ffmpeg: !!t.ffmpeg, ffprobe: !!t.ffprobe, browser: !!findBrowser(config.browser?.exe) }, hub: hub.status(), windows: appWindows.size, installed: !!electronExe(), remote: isRemote(req), renders: editor.list().filter((r) => r.status === 'running').length }); }
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ type: 'hello', version: VERSION })}\n\n`);
    clients.add(res); const wid = url.searchParams.get('app') === '1' && !isRemote(req) ? crypto.randomBytes(4).toString('hex') : null;
    if (wid) appWindows.set(wid, res);
    req.on('close', () => { clients.delete(res); if (wid) appWindows.delete(wid); });
    return;
  }
  if (p === '/api/open' && M === 'POST') {
    const b = await readBody(req); const target = b.path ? path.resolve(String(b.path)) : null;
    if (target) broadcast({ type: 'open', path: target });
    const n = appWindows.size;
    let launch = null; if (!n && b.launch !== false && !isRemote(req)) launch = launchWindow(target);
    return json(res, { windows: n, launch });
  }
  if (p === '/api/quit' && M === 'POST') {
    if (isRemote(req)) throw error(403, '원격에서는 끌 수 없어요');
    const busy = editor.list().some((r) => r.status === 'running') || [...scenes.values()].some((s) => s.status === 'running');
    const b = await readBody(req); if (busy && !b.force) return json(res, { quit: false, reason: '렌더 중이에요' });
    json(res, { quit: true }); setTimeout(() => shutdown(), 200); return;
  }
  if (p === '/api/recent' && M === 'GET') return json(res, readRecent().filter((x) => fs.existsSync(x.path)).slice(0, 20));
  if (p === '/api/recent' && M === 'POST') { const b = await readBody(req); const allowed = await allowedFor(req); touchRecent(allowed(b.path), b.title || null); return json(res, { ok: true }); }

  const allowed = await allowedFor(req);
  // 편집 파일
  if (p === '/api/edit' && M === 'GET') return json(res, editor.read(allowed(q('path'))));
  if (p === '/api/mtime') return json(res, { mtime: fs.statSync(allowed(q('path'))).mtimeMs });
  if (p === '/api/edit' && M === 'PUT') { const b = await readBody(req); checkEditName(b.path); return json(res, editor.save(allowedNew(allowed, b.path), b.doc, b.baseMtime ?? null, { force: b.force === true })); }
  if (p === '/api/new' && M === 'POST') { const b = await readBody(req); const r = await editor.create(allowed(b.video), { out: b.out || null }); touchRecent(r.path); return json(res, r, 201); }
  if (p === '/api/blank' && M === 'POST') { const b = await readBody(req); const r = editor.createBlank(allowed(b.dir), { title: b.title || '새 편집', width: Number(b.width) || 1080, height: Number(b.height) || 1920, fps: Number(b.fps) || 30 }); touchRecent(r.path); return json(res, r, 201); }
  if (p === '/api/add' && M === 'POST') { const b = await readBody(req); const files = [].concat(b.files || []).map((f) => allowed(f)); return json(res, await editor.add(allowed(b.path), files, { at: b.at ?? null, trackId: b.track || null, length: b.length ?? null })); }
  if (p === '/api/import-srt' && M === 'POST') { const b = await readBody(req); const text = b.text != null ? String(b.text) : fs.readFileSync(allowed(b.srt), 'utf8'); return json(res, editor.importSrt(allowed(b.path), text, b.name || null)); }
  if (p === '/api/check') return json(res, editor.check(allowed(q('path'))));
  if (p === '/api/srt') { const f = allowed(q('path')); const text = editor.srt(f, q('track') || null); res.writeHead(200, { 'Content-Type': 'application/x-subrip; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f).replace(EDIT_EXT, '') + '.srt')}` }); return res.end(text); }
  // 원본
  if (p === '/api/probe') return json(res, await probe(allowed(q('path')), config));
  if (p === '/api/peaks') { const buf = await peaks(allowed(q('path')), config); return json(res, { rate: 100, peaks: buf.toString('base64') }); }
  if (p === '/api/thumbs') { const meta = await thumbs(allowed(q('path')), config); if (url.searchParams.has('meta')) return json(res, { step: meta.step, count: meta.count, w: meta.w, h: meta.h }); return sendFile(req, res, meta.file, { cache: 'private, max-age=3600' }); }
  if (p === '/api/file') return sendFile(req, res, allowed(q('path')));
  if (p.startsWith('/api/raw/')) { let raw; try { raw = decodeURIComponent(p.slice('/api/raw/'.length)); } catch { throw error(400, '읽을 수 없는 경로예요'); } return sendFile(req, res, allowed(raw), { cache: 'no-cache' }); }
  if (p === '/api/list') { const d = q('path') ? allowed(q('path')) : null; if (!d) return json(res, { path: '', parent: null, entries: readRecent().slice(0, 12).map((x) => ({ name: path.basename(path.dirname(x.path)), path: path.dirname(x.path), kind: 'dir' })) }); return json(res, listDir(d)); }
  if (p === '/api/upload' && M === 'POST') return json(res, await receiveUpload(req, allowed(q('dir')), q('name')), 201);
  // 글꼴
  if (p === '/api/fonts' && M === 'GET') return json(res, listFonts());
  if (p === '/api/fonts/installable' && M === 'GET') return json(res, installableFonts());
  if (p === '/api/fonts/install' && M === 'POST') { const b = await readBody(req); const files = b.all ? installableFonts().map((x) => x.file) : [].concat(b.files || []).map((f) => allowed(f)); const r = installFonts(files); broadcast({ type: 'fonts' }); return json(res, r); }
  // 렌더·장면
  if (p === '/api/renders') return json(res, editor.list());
  if (p === '/api/render' && M === 'POST') { const b = await readBody(req); return json(res, await editor.render(allowed(b.path), { out: b.out || null, allowed }), 202); }
  const rc = p.match(/^\/api\/render\/([0-9a-f]{12})\/cancel$/); if (rc && M === 'POST') return json(res, editor.cancel(rc[1]));
  if (p === '/api/scene' && M === 'POST') {
    const b = await readBody(req); const file = allowed(b.path); if (mediaKind(file) !== 'html') throw error(400, 'HTML 장면 파일(.html)을 골라 주세요');
    const out = b.out ? allowedNew(allowed, b.out) : file.replace(/\.html?$/i, b.alpha === false ? '.mp4' : '.mov');
    return json(res, await sceneJob({ file, out, width: Number(b.width) || 0, height: Number(b.height) || 0, fps: Number(b.fps) || 30, duration: Number(b.duration) || 0, wait: b.wait === true }), 202);
  }
  if (p === '/api/scenes') return json(res, [...scenes.values()].map((j) => ({ id: j.id, path: j.path, out: j.out, status: j.status, progress: j.progress, error: j.error })));
  // 프리미어(이 PC에서만 — 허브의 어도비 명령과 같은 규칙)
  if (p.startsWith('/api/premiere/')) {
    if (isRemote(req)) throw error(403, '프리미어 가져오기는 그 PC 화면에서만 할 수 있어요');
    if (p === '/api/premiere/status') return json(res, await premiereStatus());
    if (p === '/api/premiere/import' && M === 'POST') { const b = await readBody(req); return json(res, await premiereImport({ sequence: b.sequence || null, outDir: b.outDir ? allowed(b.outDir) : null }), 201); }
  }
  // AI·파이프라인(ODDIN 에 작업으로)
  if (p === '/api/ai' && M === 'POST') {
    const b = await readBody(req);
    const body = { goal: String(b.goal || '').slice(0, 20000), reserve: true };
    if (!body.goal.trim()) throw error(400, '부탁할 내용을 적어 주세요');
    if (b.sessionId) body.sessionId = String(b.sessionId); else if (b.cwd) body.cwd = allowed(b.cwd);
    return json(res, await hub.call('/api/jobs', { method: 'POST', body }), 201);
  }
  const aj = p.match(/^\/api\/ai\/([\w-]+)$/); if (aj) { const j = await hub.call(`/api/jobs/${aj[1]}`); return json(res, { id: j.id, status: j.status, title: j.title, sessionId: j.sessionId, report: j.report || '', reserved: !!j.reserved }); }
  if (p === '/api/pipelines' && M === 'GET') return json(res, pipelines());
  if (p === '/api/pipelines/run' && M === 'POST') {
    const b = await readBody(req); const pl = pipelines().find((x) => x.id === b.id); if (!pl) throw error(404, '없는 파이프라인이에요');
    for (const f of pl.inputs || []) if (!f.optional && !String(b.inputs?.[f.key] ?? '').trim()) throw error(400, `"${f.label}"을(를) 적어 주세요`);
    const body = { goal: pipelineGoal(pl, b.inputs || {}), reserve: true, title: `${pl.name}` };
    // 작업 폴더: 파이프라인이 정한 입력(영상·편집 파일)의 폴더 → 작업 폴더 입력 → 화면이 준 폴더
    const from = pl.cwdFrom && String(b.inputs?.[pl.cwdFrom] || '').trim();
    let cwd = b.inputs?.folder || b.cwd || null;
    if (from) { try { const f = allowed(from); cwd = fs.statSync(f).isDirectory() ? f : path.dirname(f); } catch {} }
    if (b.sessionId) body.sessionId = String(b.sessionId); else if (cwd) body.cwd = allowed(cwd);
    return json(res, await hub.call('/api/jobs', { method: 'POST', body }), 201);
  }
  throw error(404, '없는 스튜디오 기능이에요');
}

const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, SELF); } catch { return fail(res, '주소가 이상해요', 400); }
  try { guard(req); await route(req, res, url); }
  catch (e) { const st = e.status || (e.code === 'ENOENT' ? 404 : 500); if (st >= 500) console.error(`[studio] ${req.method} ${url.pathname}:`, e.message); fail(res, e.code === 'ENOENT' ? '파일을 찾지 못했어요' : e.message, st, e.code && typeof e.code === 'string' && !/^E[A-Z]+$/.test(e.code) ? e.code : undefined); }
});
server.requestTimeout = 0; // 큰 파일 올리기·오래 걸리는 장면 렌더
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`[studio] 포트 ${PORT} 를 이미 쓰고 있어요(스튜디오가 이미 켜져 있을 수 있어요)`); process.exit(3); }
  console.error('[studio] 서버 오류:', e.message); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ODDIN 스튜디오 ${VERSION} — ${SELF} (허브 ${config.hubUrl})`);
  fs.writeFileSync(path.join(DATA_DIR, 'engine.json'), JSON.stringify({ port: PORT, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() }));
  hub.start();
});
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  hub.stop();
  for (const r of editor.renders.values()) if (r.status === 'running') editor.cancel(r.id);
  for (const c of clients) { try { c.end(); } catch {} }
  try { await browser.stop(); } catch {}
  try { fs.rmSync(path.join(DATA_DIR, 'engine.json'), { force: true }); } catch {}
  server.close(); setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => { console.error('[studio] 처리 못 한 오류:', e); });
process.on('unhandledRejection', (e) => { console.error('[studio] 처리 못 한 약속:', e); });
