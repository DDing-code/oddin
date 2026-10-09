// ODDIN 영상 편집기 서버 (2026-10-10 사용자 "오딘에 딱 맞는 영상편집 툴 … 간단한 싱크 수정/디자인/모션 수정", replica/architecture.md)
// - 편집 파일(*.oddin-edit.json) 읽기·저장(바뀌었으면 409)·영상으로 새로 만들기(같은 이름 SRT → 자막)
// - 원본 정보(ffprobe)·파형(초당 100개)·썸네일 띠 — data/video-cache 에 보관
// - 렌더: 시간 조각(같은 클립들이 보이는 구간)마다 ffmpeg 로 영상+소리 조각을 만들고(확대·위치·회전 키프레임은 ffmpeg 식),
//   조각을 이어 붙이며 글자·자막 레이어(ODDIN 브라우저가 video-render.html 로 그린 투명 PNG)를 위에 합성한다.
//   ffmpeg 시험으로 확인한 순서: 크기가 프레임마다 바뀌는 scale(eval=frame)은 overlay 바로 앞에 둬야 한다(뒤에 다른 필터가 오면 첫 크기로 굳는다).
//   회전은 그 앞에서 고정 크기로 한다.
// 공용 계산(키프레임·이징·정리)은 public/video-core.js 를 vm 으로 읽어 화면과 같은 코드를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ROOT, DATA_DIR, guardChild, killChildTree, nowIso } from './util.mjs';
import { resolveFile } from './files.mjs';

const error = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
export const EDIT_EXT = '.oddin-edit.json';
export const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mts|m2ts|wmv)$/i;
export const AUDIO_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
const CACHE = path.join(DATA_DIR, 'video-cache');

/* ---------- 공용 코어(public/video-core.js) ---------- */
let CORE = null;
export function core() {
  if (!CORE) {
    const ctx = { console, Math, JSON, Date };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'video-core.js'), 'utf8'), ctx, { filename: 'video-core.js' });
    CORE = ctx.OddinVideo;
  }
  return CORE;
}
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm 안에서 만든 객체를 이쪽 객체로

/* ---------- 이징: ffmpeg 식 (video-core.js EASE 와 같은 공식, 변수 P) ---------- */
export const EASE_EXPR = {
  linear: '(P)',
  ease: 'if(lt(P,0.5),4*pow(P,3),1-pow(-2*P+2,3)/2)',
  in: 'pow(P,3)',
  out: '1-pow(1-P,3)',
  hold: '0',
  snap: '1+2.70158*pow(P-1,3)+1.70158*pow(P-1,2)',
  expo: 'if(gte(P,1),1,1-pow(2,-10*P))',
};
const f6 = (v) => { const s = (Math.round(v * 1e6) / 1e6).toString(); return s.includes('e') ? v.toFixed(6) : s; };
/** 키프레임 값을 ffmpeg 식으로. off = (조각 시작) - (클립 시작) — 식의 t 는 조각 안 시각 */
export function keyExpr(base, keys, off = 0) {
  if (!Array.isArray(keys) || !keys.length) return f6(base);
  const T = `(t+${f6(off)})`;
  let e = f6(keys[keys.length - 1].v);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1], span = b.t - a.t;
    const seg = a.ease === 'hold' || span <= 0 ? f6(a.v) : `${f6(a.v)}+(${f6(b.v - a.v)})*(${(EASE_EXPR[a.ease] || EASE_EXPR.linear).replaceAll('P', `((${T}-${f6(a.t)})/${f6(span)})`)})`;
    e = `if(lt(${T},${f6(b.t)}),${seg},${e})`;
  }
  return `if(lt(${T},${f6(keys[0].t)}),${f6(keys[0].v)},${e})`;
}
/** 값의 범위(최댓값 — 확대 전 크기를 정할 때). 쫀득 이징이 넘치는 몫까지 */
function maxOf(base, keys) {
  if (!Array.isArray(keys) || !keys.length) return base;
  let m = -Infinity;
  for (let i = 0; i < keys.length; i++) { m = Math.max(m, keys[i].v); if (i < keys.length - 1 && keys[i].ease === 'snap') m = Math.max(m, keys[i].v + (keys[i + 1].v - keys[i].v) * 1.1); }
  return m;
}
const rate = (fps) => (Math.abs(fps - 29.97) < 0.01 ? '30000/1001' : Math.abs(fps - 59.94) < 0.01 ? '60000/1001' : Math.abs(fps - 23.976) < 0.01 ? '24000/1001' : f6(fps));
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

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
function run(bin, args, { input = null, onStdout = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = guardChild(spawn(bin, args, { windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    let err = '', timer = null;
    child.stdout.on('data', (b) => onStdout ? onStdout(b) : null);
    child.stderr.on('data', (b) => { err = (err + b).slice(-6000); });
    if (timeoutMs) timer = setTimeout(() => { killChildTree(child); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve({ code, err }) : reject(Object.assign(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${code}`), { code })); });
    if (input) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    run.last = child;
  });
}

/* ---------- 원본 정보·파형·썸네일 ---------- */
const cacheKey = (file, extra = '') => { const st = fs.statSync(file); return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${extra}`).digest('hex').slice(0, 24); };
export async function probe(file, config) {
  const { ffprobe } = tools(config); if (!ffprobe) throw error(500, 'ffprobe를 찾지 못했어요(ffmpeg 설치 필요)');
  const key = cacheKey(file, 'probe'), cf = path.join(CACHE, `${key}.probe.json`);
  try { return JSON.parse(fs.readFileSync(cf, 'utf8')); } catch {}
  let out = '';
  await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { onStdout: (b) => { out += b; }, timeoutMs: 30_000 });
  const j = JSON.parse(out || '{}'), v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)), a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fr = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : 0; };
  let rot = 0;
  if (v) { const sd = (v.side_data_list || []).find((x) => x.rotation != null); rot = Number(sd?.rotation ?? v.tags?.rotate ?? 0) || 0; }
  const swap = Math.abs(rot) % 180 === 90;
  const info = { duration: Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0, width: v ? (swap ? v.height : v.width) : 0, height: v ? (swap ? v.width : v.height) : 0,
    fps: v ? Math.round((fr(v.avg_frame_rate) || fr(v.r_frame_rate)) * 1000) / 1000 : 0, video: !!v, audio: !!a, rotation: rot, codec: v?.codec_name || a?.codec_name || '' };
  fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(info));
  return info;
}
/** 파형: 초당 100개, 0~127 (절댓값 최대). 캐시 */
export async function peaks(file, config) {
  const { ffmpeg } = tools(config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요');
  const key = cacheKey(file, 'peaks'), cf = path.join(CACHE, `${key}.peaks`);
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
  fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cf, buf);
  return buf;
}
/** 썸네일 띠: 높이 64px 칸을 가로로 이은 JPEG 한 장 + 간격 */
export async function thumbs(file, config) {
  const { ffmpeg } = tools(config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요');
  const info = await probe(file, config); if (!info.video) throw error(400, '영상이 없는 파일이에요');
  const H = 64, W = even(H * (info.width || 16) / (info.height || 9));
  const n = Math.max(1, Math.min(300, Math.floor(65000 / W), Math.ceil(info.duration / 1)));
  const step = Math.max(0.5, info.duration / n), count = Math.max(1, Math.ceil(info.duration / step));
  const key = cacheKey(file, `thumbs${H}`), img = path.join(CACHE, `${key}.thumbs.jpg`), meta = { step, count, w: W, h: H, file: img };
  if (fs.existsSync(img)) return meta;
  fs.mkdirSync(CACHE, { recursive: true });
  await run(ffmpeg, ['-v', 'error', '-y', '-i', file, '-vf', `fps=1/${f6(step)},scale=${W}:${H},tile=${count}x1`, '-frames:v', '1', '-q:v', '6', img], { timeoutMs: 10 * 60_000 });
  return meta;
}

/* ---------- 이 PC 글꼴 목록(글꼴 파일의 name 표에서 가족 이름) ---------- */
function fontFamilies(file) {
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); };
  const be16 = (b) => { const s = Buffer.from(b); s.swap16(); return s.toString('utf16le'); };
  try {
    const head = read(0, 12); if (head.length < 12) return [];
    let offsets = [0];
    if (head.toString('ascii', 0, 4) === 'ttcf') { const n = Math.min(head.readUInt32BE(8), 8); const b = read(12, 4 * n); offsets = Array.from({ length: n }, (_, i) => b.readUInt32BE(4 * i)); }
    const out = [];
    for (const off of offsets) {
      const h = read(off, 12); if (h.length < 12) continue;
      const numTables = h.readUInt16BE(4), dir = read(off + 12, 16 * numTables);
      let nameOff = -1, nameLen = 0;
      for (let i = 0; i < numTables && 16 * i + 16 <= dir.length; i++) if (dir.toString('ascii', 16 * i, 16 * i + 4) === 'name') { nameOff = dir.readUInt32BE(16 * i + 8); nameLen = dir.readUInt32BE(16 * i + 12); }
      if (nameOff < 0) continue;
      const nb = read(nameOff, Math.min(nameLen, 400_000)); if (nb.length < 6) continue;
      const count = nb.readUInt16BE(2), so = nb.readUInt16BE(4);
      const got = {}; // `${nameID}-${lang}` → 글
      for (let i = 0; i < count && 6 + 12 * i + 12 <= nb.length; i++) {
        const r = 6 + 12 * i, pid = nb.readUInt16BE(r), lid = nb.readUInt16BE(r + 4), nid = nb.readUInt16BE(r + 6), len = nb.readUInt16BE(r + 8), o = nb.readUInt16BE(r + 10);
        if (pid !== 3 || (nid !== 1 && nid !== 16)) continue;
        const s = be16(nb.subarray(so + o, so + o + len)).trim(); if (!s) continue;
        const lang = lid === 0x0412 ? 'ko' : lid === 0x0409 ? 'en' : 'x';
        if (!got[`${nid}-${lang}`]) got[`${nid}-${lang}`] = s;
      }
      const family = got['16-en'] || got['1-en'] || got['16-x'] || got['1-x'] || got['16-ko'] || got['1-ko'];
      if (family) out.push({ family, ko: got['16-ko'] || got['1-ko'] || null });
    }
    return out;
  } catch { return []; } finally { fs.closeSync(fd); }
}
let FONTS = null;
/** 윈도에 등록된 글꼴 파일(HKLM·HKCU 레지스트리). 폴더에 파일만 있고 등록 안 된 글꼴은 어떤 프로그램도 못 쓴다(2026-10-10 배민 도현·부크크가 그랬음) */
function registeredFontFiles() {
  const winFonts = process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:/Windows/Fonts';
  const files = new Set();
  for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
    try {
      const r = spawnSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/); if (!m) continue;
        const v = m[1].replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
        if (/\.(ttf|otf|ttc)$/i.test(v)) files.add(path.isAbsolute(v) ? v : path.join(winFonts, v));
      }
    } catch {}
  }
  return files;
}
export function listFonts() {
  if (FONTS && Date.now() - FONTS.at < 10 * 60_000) return FONTS.list;
  let files = process.platform === 'win32' ? [...registeredFontFiles()] : [];
  if (!files.length) { // 레지스트리를 못 읽으면 폴더를 그대로
    const dirs = [process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:/Windows/Fonts', process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts') : null, '/usr/share/fonts', path.join(process.env.HOME || '', '.fonts')].filter(Boolean);
    for (const d of dirs) { try { for (const n of fs.readdirSync(d)) if (/\.(ttf|otf|ttc)$/i.test(n)) files.push(path.join(d, n)); } catch {} }
  }
  const map = new Map();
  for (const file of files) { if (!fs.existsSync(file)) continue; for (const f of fontFamilies(file)) if (!map.has(f.family)) map.set(f.family, f); else if (f.ko && !map.get(f.family).ko) map.set(f.family, f); }
  const list = [...map.values()].filter((f) => !/^(\.|@)/.test(f.family)).sort((a, b) => (!!b.ko - !!a.ko) || a.family.localeCompare(b.family));
  FONTS = { at: Date.now(), list };
  return list;
}

/* ---------- 편집 파일 ---------- */
export function mediaPath(editFile, p) { return path.isAbsolute(p) ? path.normalize(p) : path.resolve(path.dirname(editFile), p); }
function relOrAbs(editFile, file) { const r = path.relative(path.dirname(editFile), file); return !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : file.split(path.sep).join('/'); }
function checkEditName(file) { if (!file.toLowerCase().endsWith(EDIT_EXT)) throw error(400, `편집 파일은 이름이 ${EDIT_EXT} 로 끝나야 해요`); }

export class VideoEditor extends EventEmitter {
  constructor({ config, getRoots, browser = null, hubUrl = () => '' }) {
    super();
    this.config = config; this.getRoots = getRoots; this.browser = browser; this.hubUrl = hubUrl;
    this.renders = new Map();
  }
  allowed(p) { return resolveFile({ path: p }, this.getRoots()); }
  read(p) {
    const file = this.allowed(p); checkEditName(file);
    let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw error(400, `편집 파일을 읽지 못했어요: ${e.message}`); }
    const { doc, problems } = core().normalize(raw);
    return { path: file, mtime: fs.statSync(file).mtimeMs, doc: plain(doc), problems: plain(problems) };
  }
  save(p, doc, baseMtime = null, { force = false } = {}) {
    let file = String(p || ''); checkEditName(file);
    const dir = this.allowed(path.dirname(file)); file = path.join(dir, path.basename(file));
    if (fs.existsSync(file) && baseMtime != null && !force) {
      const now = fs.statSync(file).mtimeMs;
      if (Math.abs(now - Number(baseMtime)) > 1) throw error(409, '다른 곳(AI 등)에서 이 파일을 바꿨어요. 다시 읽거나 내 것으로 덮어쓰세요', 'CHANGED');
    }
    const { doc: clean, problems } = core().normalize(doc);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plain(clean), null, 1)); fs.renameSync(tmp, file);
    return { path: file, mtime: fs.statSync(file).mtimeMs, problems: plain(problems) };
  }
  /** 영상으로 새 편집. 같은 폴더에 같은 이름 편집 파일이 있으면 그것을 연다. 같은 이름 SRT 가 있으면 자막으로 */
  async create(videoPath, { out = null } = {}) {
    const video = this.allowed(videoPath);
    if (!VIDEO_RE.test(video)) throw error(400, '영상 파일(mp4·mov 등)을 골라 주세요');
    const base = video.replace(/\.[^.\\/]+$/, '');
    const file = out ? path.join(path.dirname(video), path.basename(out)) : `${base}${EDIT_EXT}`;
    checkEditName(file);
    if (fs.existsSync(file)) return { path: file, existed: true };
    const info = await probe(video, this.config);
    const fps = info.fps > 1 ? info.fps : 30;
    const doc = {
      oddinEdit: 1, title: path.basename(base), width: even(info.width || 1920), height: even(info.height || 1080), fps, background: '#000000',
      media: { m1: { path: path.basename(video), name: path.basename(video), duration: info.duration, width: info.width, height: info.height, fps, audio: info.audio } },
      // 자막 크기: 화면 짧은 변의 6%(1080p → 65px), 테두리는 크기의 12%
      styles: { 자막: { ...plain(core().STYLE_DEFAULT), size: Math.round(Math.min(info.width || 1080, info.height || 1080) * 0.06), stroke: { color: '#000000', width: Math.max(2, Math.round(Math.min(info.width || 1080, info.height || 1080) * 0.06 * 0.12)) } } },
      tracks: [{ id: 'v1', kind: 'video', name: '영상', clips: [{ id: 'c1', media: 'm1', start: 0, in: 0, out: info.duration || 1 }] }, { id: 't1', kind: 'text', name: '자막', style: '자막', items: [] }],
      markers: [],
    };
    const srt = [`${base}.srt`, `${base}.ko.srt`].find((f) => fs.existsSync(f));
    if (srt) {
      const h = info.height || 1080;
      doc.tracks[1].items = plain(core().parseSrt(fs.readFileSync(srt, 'utf8'))).map((c, i) => ({ id: `x${i + 1}`, start: c.start, end: c.end, text: c.text, x: 0, y: Math.round(h * 0.36) }));
    } else doc.tracks[1].items = [];
    this.save(file, doc);
    return { path: file, existed: false, srt: srt || null };
  }
  srt(p, trackId = null) {
    const { doc } = this.read(p);
    const tr = doc.tracks.find((t) => t.kind === 'text' && (!trackId || t.id === trackId));
    if (!tr) throw error(404, '자막 트랙이 없어요');
    return core().toSrt(tr.items);
  }

  /* ---------- 렌더 ---------- */
  list() { return [...this.renders.values()].map((r) => this.pub(r)); }
  pub(r) { return { id: r.id, path: r.path, out: r.out, status: r.status, progress: r.progress, stage: r.stage, error: r.error, warnings: r.warnings, startedAt: r.startedAt, finishedAt: r.finishedAt }; }
  tell(r) { this.emit('event', { type: 'video_render', render: this.pub(r) }); }
  cancel(id) {
    const r = this.renders.get(id); if (!r) throw error(404, '렌더를 찾지 못했어요');
    if (r.status !== 'running') return this.pub(r);
    r.cancelled = true; for (const c of r.children) killChildTree(c);
    return this.pub(r);
  }
  async render(p, { out = null } = {}) {
    const { ffmpeg } = tools(this.config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요. ffmpeg를 설치하거나 config.video.ffmpeg 에 경로를 적어 주세요');
    const { path: file, doc } = this.read(p);
    for (const r of this.renders.values()) if (r.path === file && r.status === 'running') throw error(409, '이 편집은 이미 렌더하고 있어요');
    const D = core().duration(doc); if (D <= 0) throw error(400, '렌더할 내용이 없어요(클립·자막이 없음)');
    for (const m of Object.values(doc.media)) { m.file = mediaPath(file, m.path); try { m.file = this.allowed(m.file); } catch (e) { throw error(e.status || 400, `원본을 열 수 없어요: ${m.path} — ${e.message}`); } }
    const base = file.slice(0, -EDIT_EXT.length);
    let target = out ? path.join(path.dirname(file), path.basename(out)) : `${base}.mp4`;
    for (let i = 2; fs.existsSync(target) && !out; i++) target = `${base} (${i}).mp4`;
    const id = crypto.randomBytes(6).toString('hex');
    const r = { id, path: file, out: target, status: 'running', progress: 0, stage: '준비', error: null, warnings: [], startedAt: nowIso(), finishedAt: null, children: new Set(), cancelled: false };
    this.renders.set(id, r); this.tell(r);
    const tmp = path.join(DATA_DIR, 'video-render', id); fs.mkdirSync(tmp, { recursive: true });
    this.renderJob(r, doc, D, tmp).then(() => { r.status = 'done'; r.progress = 1; r.stage = '완료'; })
      .catch((e) => { r.status = r.cancelled ? 'cancelled' : 'failed'; r.error = r.cancelled ? '중지했어요' : e.message; try { fs.rmSync(target, { force: true }); } catch {} })
      .finally(() => { r.finishedAt = nowIso(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} this.tell(r); });
    return this.pub(r);
  }
  async renderJob(r, doc, D, tmp) {
    const { ffmpeg } = tools(this.config), C = core();
    const fps = doc.fps, frames = Math.max(1, Math.round(D * fps)), W = doc.width, H = doc.height;
    const fr = (t) => Math.round(t * fps); // 프레임 번호
    // 1) 시간 조각: 모든 클립 경계(프레임에 붙임)
    const cuts = new Set([0, frames]);
    for (const tr of doc.tracks) if (tr.kind !== 'text') for (const c of tr.clips) { cuts.add(Math.min(frames, fr(c.start))); cuts.add(Math.min(frames, fr(C.clipEnd(c)))); }
    const marks = [...cuts].filter((f) => f >= 0 && f <= frames).sort((a, b) => a - b);
    const slices = [];
    for (let i = 0; i < marks.length - 1; i++) if (marks[i + 1] > marks[i]) slices.push({ f0: marks[i], f1: marks[i + 1] });
    r.stage = `조각 ${slices.length}개 만드는 중`; this.tell(r);
    let done = 0;
    const one = async (s, idx) => {
      if (r.cancelled) throw new Error('중지');
      const a = s.f0 / fps, n = s.f1 - s.f0, len = n / fps;
      const args = ['-v', 'error', '-y'], vin = [], ain = [];
      const inputs = new Map(); // clip.id → 입력 번호
      const mid = (s.f0 + s.f1) / 2 / fps;
      for (const tr of doc.tracks) {
        if (tr.kind === 'text') continue;
        for (const c of tr.clips) {
          if (!(mid >= c.start && mid < C.clipEnd(c))) continue;
          const m = doc.media[c.media];
          const useV = tr.kind === 'video' && !tr.hidden && (m.width > 0), useA = !tr.muted && m.audio !== false;
          if (!useV && !useA) continue;
          const at = c.in + (a - c.start);
          inputs.set(c.id, inputs.size);
          args.push('-ss', f6(Math.max(0, at)), '-t', f6(len + 0.5), '-i', m.file);
          if (useV) vin.push({ c, m, i: inputs.size - 1, off: a - c.start });
          if (useA) ain.push({ c, i: inputs.size - 1, off: a - c.start, a0: a, len });
        }
      }
      const g = [`color=c=${doc.background.replace('#', '0x')}:s=${W}x${H}:r=${rate(fps)}:d=${f6(len + 0.5)},format=yuv420p[bg0]`];
      let last = 'bg0';
      vin.forEach((v, k) => {
        const fit = C.fitSize(doc, v.m, v.c.fit), keys = v.c.keys || {};
        const maxS = Math.max(0.01, maxOf(v.c.scale, keys.scale));
        const cap = 4096 / Math.max(fit.w, fit.h); const pre = Math.min(maxS * (keys.scale ? 1.05 : 1), Math.max(cap, 0.01));
        const pw = even(fit.w * pre), ph = even(fit.h * pre);
        const rot = keys.rotation || v.c.rotation ? keyExpr(v.c.rotation, keys.rotation, v.off) : null;
        const sExpr = keyExpr(v.c.scale, keys.scale, v.off);
        const chain = [`[${v.i}:v]setpts=PTS-STARTPTS`, `fps=${rate(fps)}`, `scale=${pw}:${ph}:flags=bicubic`, 'format=rgba'];
        if (rot) { const side = even(Math.hypot(pw, ph)); chain.push(`rotate=a='(${rot})*PI/180':ow=${side}:oh=${side}:c=none`); }
        if (v.c.opacity < 1) chain.push(`colorchannelmixer=aa=${f6(v.c.opacity)}`);
        const base0 = rot ? even(Math.hypot(pw, ph)) : null;
        const bw = base0 || pw, bh = base0 || ph;
        // 크기가 바뀌는 scale 은 맨 끝(overlay 바로 앞)
        if (keys.scale) chain.push(`scale=w='max(2,trunc(${bw}*(${sExpr})/${f6(pre)}/2)*2)':h='max(2,trunc(${bh}*(${sExpr})/${f6(pre)}/2)*2)':eval=frame`);
        else if (Math.abs(v.c.scale / pre - 1) > 1e-6) chain.push(`scale=${even(bw * v.c.scale / pre)}:${even(bh * v.c.scale / pre)}`);
        g.push(`${chain.join(',')}[v${k}]`);
        const xE = keyExpr(v.c.x, keys.x, v.off), yE = keyExpr(v.c.y, keys.y, v.off);
        g.push(`[${last}][v${k}]overlay=x='W/2+(${xE})-w/2':y='H/2+(${yE})-h/2':eval=frame:eof_action=pass:format=auto[o${k}]`);
        last = `o${k}`;
      });
      g.push(`[${last}]trim=end_frame=${n},setpts=PTS-STARTPTS,format=yuv420p[vout]`);
      if (ain.length) {
        ain.forEach((x, k) => {
          const c = x.c, chain = [`[${x.i}:a]aresample=48000`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS', `volume=${f6(c.volume)}dB`];
          const clipLen = c.out - c.in, local0 = x.off; // 이 조각 시작이 클립 안 몇 초인지
          // 소리 페이드(말 연결이 뚝 끊기지 않게): 조각이 클립 처음에서 시작하면 들어오기, 페이드 구간을 지나 끝나면 나가기
          if (c.fadeIn > 0 && local0 < 1e-3) chain.push(`afade=t=in:st=0:d=${f6(Math.min(c.fadeIn, x.len))}`);
          const outAt = clipLen - c.fadeOut - local0;
          if (c.fadeOut > 0 && outAt >= 0 && outAt < x.len) chain.push(`afade=t=out:st=${f6(outAt)}:d=${f6(c.fadeOut)}`);
          chain.push(`apad=whole_dur=${f6(len)}`, `atrim=duration=${f6(len)}`);
          g.push(`${chain.join(',')}[a${k}]`);
        });
        g.push(ain.length > 1 ? `${ain.map((_, k) => `[a${k}]`).join('')}amix=inputs=${ain.length}:normalize=0:dropout_transition=0,atrim=duration=${f6(len)}[aout]` : '[a0]anull[aout]');
      } else g.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f6(len)}[aout]`);
      const script = path.join(tmp, `g${idx}.txt`); fs.writeFileSync(script, g.join(';\n'));
      const seg = path.join(tmp, `s${String(idx).padStart(5, '0')}.mkv`);
      args.push('-/filter_complex', script, '-map', '[vout]', '-map', '[aout]', '-frames:v', String(n), '-r', rate(fps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', seg);
      await this.ff(r, ffmpeg, args);
      s.file = seg; done++; r.progress = 0.7 * done / slices.length; r.stage = `조각 ${done}/${slices.length}`; this.tell(r);
    };
    const par = Math.max(1, Math.min(6, Number(this.config.video?.parallel) || 3));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(par, slices.length) }, async () => { while (next < slices.length) { const i = next++; await one(slices[i], i); } }));
    if (r.cancelled) throw new Error('중지');
    // 2) 이어 붙이기 + 글자 레이어 합성 + 최종 인코딩
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, slices.map((s) => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const hasText = doc.tracks.some((t) => t.kind === 'text' && !t.hidden && t.items.length);
    const args = ['-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-f', 'concat', '-safe', '0', '-i', list];
    if (hasText) args.push('-f', 'image2pipe', '-c:v', 'png', '-framerate', rate(fps), '-i', 'pipe:0');
    args.push('-filter_complex', hasText ? `[0:v][1:v]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v]` : `[0:v]format=yuv420p[v]`, '-map', '[v]', '-map', '0:a',
      '-frames:v', String(frames), '-r', rate(fps), '-c:v', 'libx264', '-preset', this.config.video?.preset || 'medium', '-crf', String(this.config.video?.crf ?? 18), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', r.out);
    r.stage = hasText ? '자막 그리며 합치는 중' : '합치는 중'; this.tell(r);
    const child = guardChild(spawn(ffmpeg, args, { windowsHide: true, stdio: [hasText ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    r.children.add(child);
    let errTail = '';
    child.stderr.on('data', (b) => { errTail = (errTail + b).slice(-4000); });
    child.stdout.on('data', (b) => { const m = String(b).match(/frame=(\d+)/g); if (m) { const f = Number(m.at(-1).slice(6)); r.progress = 0.7 + 0.3 * Math.min(1, f / frames); if (!r._t || Date.now() - r._t > 500) { r._t = Date.now(); this.tell(r); } } });
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => { r.children.delete(child); code === 0 ? resolve() : reject(new Error(r.cancelled ? '중지' : (errTail.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${code}`))); });
    });
    if (hasText) {
      // 글자 그리기가 먼저 실패하면 그 이유를 알린다(ffmpeg 를 끄면 "종료 코드 1"만 남아 원인이 가려졌다)
      let feedErr = null;
      const feeding = this.feedOverlay(r, doc, frames, child.stdin).catch((e) => { feedErr = e; killChildTree(child); });
      try { await exited; } catch (e) { await feeding; throw feedErr ? new Error(`자막·글자 그리기 실패: ${feedErr.message}`) : e; }
      await feeding; if (feedErr) throw new Error(`자막·글자 그리기 실패: ${feedErr.message}`);
    } else await exited;
  }
  ff(r, bin, args) {
    return new Promise((resolve, reject) => {
      const child = guardChild(spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
      r.children.add(child); let err = '';
      child.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
      child.on('error', reject);
      child.on('close', (code) => { r.children.delete(child); code === 0 ? resolve() : reject(new Error(r.cancelled ? '중지' : (err.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${code}`))); });
    });
  }
  /** ODDIN 브라우저로 글자 레이어를 프레임마다 그려 PNG 로 넘긴다(바뀐 프레임만 찍음) */
  async feedOverlay(r, doc, frames, stdin) {
    const B = this.browser;
    if (!B) throw new Error('자막·글자를 그리려면 ODDIN 브라우저가 필요해요(config.browser.oddin)');
    const owner = `video-render/${r.id}`;
    // 컴퓨터가 바쁘면 브라우저가 늦게 뜰 수 있다 — 한 번 더 시도
    let tab; try { tab = await B.tabOf(owner); } catch { await new Promise((x) => setTimeout(x, 1500)); tab = await B.tabOf(owner); }
    const write = (buf) => new Promise((resolve, reject) => { if (stdin.destroyed) return reject(new Error('ffmpeg 입력이 닫혔어요')); stdin.write(buf, (e) => (e ? reject(e) : resolve())); });
    try {
      await B.send('Emulation.setDeviceMetricsOverride', { width: doc.width, height: doc.height, deviceScaleFactor: 1, mobile: false }, tab.session);
      await B.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, tab.session);
      await B.send('Page.navigate', { url: `${this.hubUrl()}/video-render.html?path=${encodeURIComponent(r.path)}` }, tab.session);
      let ready = null;
      for (let i = 0; i < 200 && !ready; i++) { await new Promise((x) => setTimeout(x, 150)); try { ready = await B.evaluate(tab, 'window.__oddinReady || null', 30_000); } catch {} }
      if (!ready) throw new Error('렌더 페이지가 열리지 않았어요');
      if (ready.error) throw new Error(ready.error);
      if (ready.missingFonts?.length) r.warnings.push(`이 PC에 없는 글꼴: ${ready.missingFonts.join(', ')} — 다른 글꼴로 그려졌어요`);
      let prevSig = null, prevBuf = null;
      for (let f = 0; f < frames; f++) {
        if (r.cancelled) throw new Error('중지');
        const sig = await B.evaluate(tab, `__oddinFrame(${f / doc.fps})`, 30_000);
        if (sig !== prevSig || !prevBuf) {
          const shot = await B.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: doc.width, height: doc.height, scale: 1 }, captureBeyondViewport: false }, tab.session, 60_000);
          prevBuf = Buffer.from(shot.data, 'base64'); prevSig = sig;
        }
        await write(prevBuf);
      }
      stdin.end();
    } finally {
      try { await B.act(owner, { action: 'close' }); } catch {}
    }
  }

  /* ---------- HTTP ---------- */
  async handle(req, res, p, url, { json, fail, readBody, send }) {
    const q = (k) => url.searchParams.get(k) || '';
    if (p === '/api/video/edit' && req.method === 'GET') return json(res, this.read(q('path')));
    if (p === '/api/video/mtime' && req.method === 'GET') { const f = this.allowed(q('path')); return json(res, { mtime: fs.statSync(f).mtimeMs }); }
    if (p === '/api/video/edit' && req.method === 'PUT') { const b = await readBody(req, 20_000_000); return json(res, this.save(b.path, b.doc, b.baseMtime ?? null, { force: b.force === true })); }
    if (p === '/api/video/new' && req.method === 'POST') { const b = await readBody(req); return json(res, await this.create(b.video, { out: b.out || null }), 201); }
    if (p === '/api/video/probe' && req.method === 'GET') return json(res, await probe(this.allowed(q('path')), this.config));
    if (p === '/api/video/peaks' && req.method === 'GET') { const buf = await peaks(this.allowed(q('path')), this.config); return json(res, { rate: 100, peaks: buf.toString('base64') }); }
    if (p === '/api/video/thumbs' && req.method === 'GET') {
      const meta = await thumbs(this.allowed(q('path')), this.config);
      if (url.searchParams.has('meta')) return json(res, { step: meta.step, count: meta.count, w: meta.w, h: meta.h });
      return send(res, 200, fs.readFileSync(meta.file), 'image/jpeg');
    }
    if (p === '/api/video/srt' && req.method === 'GET') { const text = this.srt(q('path'), q('track') || null); res.writeHead(200, { 'Content-Type': 'application/x-subrip; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(q('path')).replace(EDIT_EXT, '') + '.srt')}` }); return res.end(text); }
    if (p === '/api/video/renders' && req.method === 'GET') return json(res, this.list());
    if (p === '/api/video/render' && req.method === 'POST') { const b = await readBody(req); return json(res, await this.render(b.path, { out: b.out || null }), 202); }
    const m = p.match(/^\/api\/video\/render\/([0-9a-f]{12})\/cancel$/);
    if (m && req.method === 'POST') { await readBody(req); return json(res, this.cancel(m[1])); }
    if (p === '/api/video/fonts' && req.method === 'GET') return json(res, listFonts());
    if (p === '/api/video/tools' && req.method === 'GET') { const t = tools(this.config); return json(res, { ffmpeg: !!t.ffmpeg, ffprobe: !!t.ffprobe, browser: !!this.browser }); }
    return fail(res, '없는 영상 편집 기능이에요', 404);
  }
}
