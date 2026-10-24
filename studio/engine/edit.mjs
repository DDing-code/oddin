// ODDIN 스튜디오 편집 엔진 (2026-10-10 사용자 "오딘에 딱 맞는 영상편집 툴" → 같은 날 "오딘과 연동되는 프로그램으로", replica/architecture.md)
// - 편집 파일(*.oddin-edit.json) 읽기·저장(바뀌었으면 409)·영상으로 새로 만들기(같은 이름 SRT → 자막)·원본 넣기·SRT 넣기·점검
// - 렌더: 시간 조각(같은 클립들이 보이는 구간)마다 ffmpeg 로 영상+소리 조각을 만들고(확대·위치·회전 키프레임은 ffmpeg 식),
//   조각을 이어 붙이며 글자·자막 레이어(엔진 브라우저가 ui/render.html 로 그린 투명 PNG)를 위에 합성한다.
//   ffmpeg 시험으로 확인한 순서: 크기가 프레임마다 바뀌는 scale(eval=frame)은 overlay 바로 앞에 둬야 한다(뒤에 다른 필터가 오면 첫 크기로 굳는다).
//   회전은 그 앞에서 고정 크기로 한다. 그림은 한 장을 되풀이(-loop 1), HTML 장면은 먼저 투명 영상으로 만들어(scene.mjs) 영상처럼 쓴다.
// 공용 계산(키프레임·이징·정리·원본 넣기)은 ui/video-core.js 를 vm 으로 읽어 화면과 같은 코드를 쓴다(core.mjs).
// 2026-10-24 프로 기능("전부 다 넣어주고, 오딘 친화적으로만"): 속도·램프·되감기·멈춤, 전환, 효과(색·LUT·흐림·빛 번짐·그림자 등, 키프레임),
//   섞기(블렌드)·마스크(따라가기)·3D 기울이기·카메라·모션 블러·조정 레이어·편집 안 편집, 출력 형식(H.265·ProRes·투명·10비트·GIF).
//   조각은 그림만 만들고 소리는 타임라인 전체를 한 번에 섞는다(audio-mix.mjs). 필터 짜기는 fx.mjs.
// 경로 허용(원격에서 온 요청은 ODDIN 이 아는 폴더만)은 server.mjs 가 정해 allowed 로 넘긴다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { guardChild, killChildTree, nowIso } from '../../lib/util.mjs';
import { DATA_DIR, error } from './env.mjs';
import { tools, probe, f6, even, rate, VIDEO_RE } from './media.mjs';
import { core, plain } from './core.mjs';
import { EASE_EXPR, keyExpr, opacityExpr, opacitySpans, transSpans, clipExprs, tiltFilter, isConst, Graph, sendcmdScript, buildMatte, applyMatte, applyFx, BLEND_FF, rampSetpts, ffPath } from './fx.mjs';
import { mixAudio } from './audio-mix.mjs';
import { trackRect, simplify } from './track.mjs';
import { listFonts } from './fonts.mjs';
import { sceneClip } from './scene.mjs';

export const EDIT_EXT = '.oddin-edit.json';

export { core, plain, EASE_EXPR, keyExpr, opacityExpr, opacitySpans };
/** 편집 내용의 지문(정리한 편집 문서의 sha256) — 렌더한 영상에 적어 두고, 나중에 "이 편집 파일의 최신 렌더인가"를 본다 */
export function editHash(doc) { return crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32); }
/** 렌더에 쓸 H.264 인코더: config.studio.video.encoder = auto(기본: NVIDIA 그래픽카드가 되면 h264_nvenc) | libx264 | h264_nvenc. STUDIO_ENCODER 로 덮어씀 */
let ENC = null;
export function videoEncoder(config, ffmpeg) {
  const want = process.env.STUDIO_ENCODER || config?.video?.encoder || 'auto';
  if (want !== 'auto') return want;
  if (ENC == null) {
    try {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeout: 15_000, windowsHide: true });
      ENC = r.status === 0 ? 'h264_nvenc' : 'libx264';
    } catch { ENC = 'libx264'; }
  }
  return ENC;
}
/** 인코더 인자: piece = 중간 조각(거의 무손실), 아니면 최종 */
export function encodeArgs(enc, { piece = false, crf = 18, preset = 'medium' } = {}) {
  if (enc === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', piece ? 'p4' : 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(piece ? 14 : crf + 1), '-b:v', '0', '-pix_fmt', 'yuv420p'];
  return piece ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p'] : ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p'];
}
/** 출력 형식별 인코더 인자(doc.output — video-core.js cleanOutput). 품질 → crf: draft·normal·high·master */
export function outputArgs(out, enc, config = {}) {
  const q = out.quality, base = Number(config.video?.crf ?? 18), preset = config.video?.preset || 'medium', ten = out.bitDepth === 10;
  const crf = { draft: 28, normal: base, high: Math.min(base, 15), master: 10 }[q] ?? base;
  let v;
  if (out.codec === 'h265') {
    const c = { draft: 32, normal: 23, high: 19, master: 14 }[q] ?? 23;
    v = enc === 'h264_nvenc' ? ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(c + 1), '-b:v', '0', '-pix_fmt', ten ? 'p010le' : 'yuv420p', '-tag:v', 'hvc1']
      : ['-c:v', 'libx265', '-preset', preset, '-crf', String(c), '-pix_fmt', ten ? 'yuv420p10le' : 'yuv420p', '-tag:v', 'hvc1'];
  } else if (out.codec === 'prores') v = ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0'];
  else if (out.codec === 'prores4444') v = ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0'];
  else if (out.codec === 'vp9') { const c = { draft: 40, normal: 31, high: 24, master: 15 }[q] ?? 31; v = ['-c:v', 'libvpx-vp9', '-crf', String(c), '-b:v', '0', '-row-mt', '1', '-pix_fmt', out.alpha ? 'yuva420p' : ten ? 'yuv420p10le' : 'yuv420p', ...(ten && !out.alpha ? ['-profile:v', '2'] : [])]; }
  else if (out.codec === 'gif') v = [];
  else v = ten ? ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p10le', '-profile:v', 'high10'] : encodeArgs(enc, { crf, preset });
  const a = out.audio === 'pcm' ? ['-c:a', q === 'master' ? 'pcm_s24le' : 'pcm_s16le'] : out.audio === 'opus' ? ['-c:a', 'libopus', '-b:a', '160k'] : out.audio === 'aac' ? ['-c:a', 'aac', '-b:a', q === 'master' || q === 'high' ? '320k' : '192k'] : [];
  return { video: v, audio: a };
}
/** 출력 형식의 마지막 픽셀 형식 */
export function outputPixFmt(out) {
  if (out.codec === 'prores') return 'yuv422p10le';
  if (out.codec === 'prores4444') return 'yuva444p10le';
  if (out.codec === 'vp9' && out.alpha) return 'yuva420p';
  return out.bitDepth === 10 ? 'yuv420p10le' : 'yuv420p';
}
export const isTransparent = (bg) => /^transparent$/i.test(String(bg || '')) || /^#[0-9a-f]{6}([0-9a-e][0-9a-f]|f[0-9a-e])$/i.test(String(bg || ''));
/** 렌더한 영상에 남긴 표시 읽기 → { studio, edit, hash, at, current, editability } */
export function readRenderMark(ffprobe, mp4) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', mp4], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) throw error(400, `영상을 읽지 못했어요: ${String(r.stderr || '').trim().split('\n').pop() || mp4}`);
  let tag = ''; try { const tags = JSON.parse(r.stdout).format?.tags || {}; tag = Object.entries(tags).find(([k]) => k.toLowerCase() === 'comment')?.[1] || ''; } catch {} // webm 은 COMMENT
  const m = String(tag).match(/^oddin-studio (\{.*\})$/s);
  if (!m) return { studio: false };
  try { return { studio: true, ...JSON.parse(m[1]) }; } catch { return { studio: false }; }
}

/* ---------- 편집 파일 ---------- */
export function mediaPath(editFile, p) { return path.isAbsolute(p) ? path.normalize(p) : path.resolve(path.dirname(editFile), p); }
/** 편집 파일에 적을 원본 경로: 편집 파일 폴더 안이면 상대 경로, 밖이면 절대 경로(/) */
export function relOrAbs(editFile, file) { const r = path.relative(path.dirname(editFile), file); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : file.split(path.sep).join('/'); }
export function checkEditName(file) { if (!String(file).toLowerCase().endsWith(EDIT_EXT)) throw error(400, `편집 파일은 이름이 ${EDIT_EXT} 로 끝나야 해요`); }
/** 겹치지 않는 새 파일 이름: 이름.oddin-edit.json → 이름 (2).oddin-edit.json … */
export function freshEditPath(dir, base) {
  const clean = String(base || '편집').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || '편집';
  let f = path.join(dir, `${clean}${EDIT_EXT}`);
  for (let i = 2; fs.existsSync(f); i++) f = path.join(dir, `${clean} (${i})${EDIT_EXT}`);
  return f;
}

export class Editor extends EventEmitter {
  /** browser: 엔진의 BrowserManager(글자 레이어·HTML 장면 그리기), engineUrl: 엔진 주소(브라우저가 렌더 페이지를 연다),
   *  sceneUrl(장면 파일, 편집 파일): HTML 장면을 띄울 주소 — 엔진과 다른 출처(scene-origin.mjs). 장면 스크립트가 엔진 API 에 닿지 못하게 */
  constructor({ config, browser = null, engineUrl = () => '', sceneUrl = async () => { throw error(500, 'HTML 장면을 띄울 주소(장면 출처)가 없어요'); } }) {
    super();
    this.config = config; this.browser = browser; this.engineUrl = engineUrl; this.sceneUrl = sceneUrl;
    this.renders = new Map();
  }
  read(file) {
    checkEditName(file);
    let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw error(e.code === 'ENOENT' ? 404 : 400, e.code === 'ENOENT' ? '편집 파일이 없어요' : `편집 파일을 읽지 못했어요: ${e.message}`); }
    const { doc, problems } = core().normalize(raw);
    return { path: file, mtime: fs.statSync(file).mtimeMs, doc: plain(doc), problems: plain(problems) };
  }
  save(file, doc, baseMtime = null, { force = false } = {}) {
    checkEditName(file);
    if (!fs.existsSync(path.dirname(file))) throw error(400, '편집 파일을 둘 폴더가 없어요');
    if (fs.existsSync(file) && baseMtime != null && !force) {
      const now = fs.statSync(file).mtimeMs;
      if (Math.abs(now - Number(baseMtime)) > 1) throw error(409, '다른 곳(AI 등)에서 이 파일을 바꿨어요. 다시 읽거나 내 것으로 덮어쓰세요', 'CHANGED');
    }
    const { doc: clean, problems } = core().normalize(doc);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plain(clean), null, 1)); fs.renameSync(tmp, file);
    this.emit('event', { type: 'edit_saved', path: file });
    return { path: file, mtime: fs.statSync(file).mtimeMs, problems: plain(problems) };
  }
  /** 영상으로 새 편집. 같은 폴더에 같은 이름 편집 파일이 있으면 그것을 연다. 같은 이름 SRT 가 있으면 자막으로 */
  async create(video, { out = null } = {}) {
    if (!VIDEO_RE.test(video)) throw error(400, '영상 파일(mp4·mov 등)을 골라 주세요');
    const base = video.replace(/\.[^.\\/]+$/, '');
    const file = out ? path.join(path.dirname(video), path.basename(out)) : `${base}${EDIT_EXT}`;
    checkEditName(file);
    if (fs.existsSync(file)) return { path: file, existed: true };
    const info = await probe(video, this.config);
    const fps = info.fps > 1 ? info.fps : 30;
    const short = Math.min(info.width || 1080, info.height || 1080);
    const doc = {
      oddinEdit: 1, title: path.basename(base), width: even(info.width || 1920), height: even(info.height || 1080), fps, background: '#000000',
      media: { m1: { path: path.basename(video), name: path.basename(video), kind: 'video', duration: info.duration, width: info.width, height: info.height, fps, audio: info.audio } },
      // 자막 크기: 화면 짧은 변의 6%(1080p → 65px), 테두리는 크기의 12%
      styles: { 자막: { ...plain(core().STYLE_DEFAULT), size: Math.round(short * 0.06), stroke: { color: '#000000', width: Math.max(2, Math.round(short * 0.06 * 0.12)) } } },
      tracks: [{ id: 'v1', kind: 'video', name: '영상', clips: [{ id: 'c1', media: 'm1', start: 0, in: 0, out: info.duration || 1 }] }, { id: 't1', kind: 'text', name: '자막', style: '자막', items: [] }],
      markers: [],
    };
    const srt = [`${base}.srt`, `${base}.ko.srt`].find((f) => fs.existsSync(f));
    if (srt) {
      const h = info.height || 1080;
      doc.tracks[1].items = plain(core().parseSrt(fs.readFileSync(srt, 'utf8'))).map((c, i) => ({ id: `x${i + 1}`, start: c.start, end: c.end, text: c.text, x: 0, y: Math.round(h * 0.36) }));
    }
    this.save(file, doc);
    return { path: file, existed: false, srt: srt || null };
  }
  /** 빈 편집(크기·fps 를 정해) — 원본 없이 시작해 그림·HTML 장면·소리를 넣을 때 */
  createBlank(dir, { title = '새 편집', width = 1080, height = 1920, fps = 30 } = {}) {
    const file = freshEditPath(dir, title);
    this.save(file, { oddinEdit: 1, title, width, height, fps, background: '#000000', media: {}, styles: { 자막: plain(core().STYLE_DEFAULT) }, tracks: [{ id: 'v1', kind: 'video', name: '영상', clips: [] }, { id: 't1', kind: 'text', name: '자막', style: '자막', items: [] }], markers: [] });
    return { path: file };
  }
  /** 원본 넣기(CLI·AI): 차례로 이어 붙인다(at 이 없으면 그 종류 트랙의 끝에서). files 는 허용 검사를 마친 절대 경로 */
  async add(file, files, { at = null, trackId = null, length = null } = {}) {
    const { doc, mtime } = this.read(file);
    const C = core(), placed = [];
    let t = at;
    for (const f of files) {
      const info = String(f).toLowerCase().endsWith(EDIT_EXT) ? this.nestInfo(f, file) : await probe(f, this.config);
      const kindTrack = info.kind === 'video' && !info.video ? 'audio' : 'video';
      if (t == null) { let end = 0; for (const tr of doc.tracks) if (tr.kind === kindTrack) for (const c of tr.clips) end = Math.max(end, C.clipEnd(c)); t = end; }
      const r = plain(C.placeMedia(doc, info, { path: relOrAbs(file, f), name: path.basename(f), at: t, trackId, length }));
      const tr = doc.tracks.find((x) => x.id === r.track), c = tr.clips.find((x) => x.id === r.clip);
      placed.push({ file: f, ...r, start: c.start, end: C.clipEnd(c) });
      t = C.clipEnd(c);
    }
    const s = this.save(file, doc, mtime);
    return { ...s, placed };
  }
  /** 편집 파일을 원본처럼(편집 안 편집): 길이·크기·소리 */
  nestInfo(f, parent) {
    if (path.resolve(f).toLowerCase() === path.resolve(parent).toLowerCase()) throw error(400, '편집 파일을 자기 안에 넣을 수 없어요');
    const { doc } = this.read(f), C = core();
    return { kind: 'edit', duration: C.duration(doc), width: doc.width, height: doc.height, fps: doc.fps, audio: doc.tracks.some((t) => t.kind !== 'text' && (t.clips || []).length), video: true };
  }
  importSrt(file, srtText, name = null) {
    const { doc, mtime } = this.read(file);
    const r = plain(core().srtTrack(doc, srtText, name));
    return { ...this.save(file, doc, mtime), ...r };
  }
  srt(file, trackId = null) {
    const { doc } = this.read(file);
    const tr = doc.tracks.find((t) => t.kind === 'text' && (!trackId || t.id === trackId));
    if (!tr) throw error(404, '자막 트랙이 없어요');
    return core().toSrt(tr.items);
  }
  /** 점검(CLI·AI): 고친 점·자막 빈칸/겹침/두 줄·이 PC에 없는 글꼴·없는 원본 */
  check(file) {
    const r = this.read(file), d = r.doc, C = core();
    const have = new Set(listFonts().map((f) => f.family.toLowerCase()));
    const missingFonts = plain(C.fontsOf(d)).filter((f) => !have.has(String(f).toLowerCase()));
    const missingMedia = Object.entries(d.media).filter(([, m]) => m.kind !== 'adjust' && !fs.existsSync(mediaPath(file, m.path))).map(([id, m]) => ({ id, path: m.path }));
    for (const tr of d.tracks) for (const c of tr.clips || []) for (const fx of c.effects || []) if (fx.type === 'lut' && fx.file && !fs.existsSync(mediaPath(file, fx.file))) missingMedia.push({ id: c.id, path: fx.file, lut: true });
    return { path: file, title: d.title, size: `${d.width}x${d.height}`, fps: d.fps, duration: C.duration(d), tracks: d.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, count: (t.items || t.clips).length })), problems: r.problems, ...plain(C.textChecks(d)), missingFonts, missingMedia, editability: plain(C.editability(d)) };
  }
  /** 이 영상이 이 편집 파일의 최신 렌더인가(cli.mjs verify). edit 를 안 주면 영상에 적힌 편집 파일로 */
  verify(mp4, { edit = null } = {}) {
    const { ffprobe } = tools(this.config); if (!ffprobe) throw error(500, 'ffprobe를 찾지 못했어요');
    if (!fs.existsSync(mp4)) throw error(404, `영상이 없어요: ${mp4}`);
    const mark = readRenderMark(ffprobe, mp4);
    const file = edit || mark.edit || null;
    const out = { video: mp4, studio: mark.studio, edit: file, renderedAt: mark.at || null, encoder: mark.encoder || null, current: false, sameEdit: !edit || !mark.edit || path.resolve(edit).toLowerCase() === path.resolve(mark.edit).toLowerCase(), editability: null };
    if (file && fs.existsSync(file)) { const { doc } = this.read(file); out.current = mark.studio && editHash(doc) === mark.hash && out.sameEdit; out.editability = plain(core().editability(doc)); }
    return out;
  }
  /** 편집 파일 고치기(AI·CLI): ops = [{op:'text'|'set'|'style'|'marker'|'track'|'remove'|'fx'|'shape'|'adjust', …}] — 한 번 읽고 한 번 저장(바뀌었으면 409) */
  patch(file, ops = []) {
    const { doc, mtime } = this.read(file), C = core(), results = [];
    const all = () => doc.tracks.flatMap((t) => [{ kind: 'track', o: t, tr: t }, ...(t.clips || t.items || []).map((o) => ({ kind: t.kind === 'text' ? 'item' : 'clip', o, tr: t }))]);
    const find = (id) => all().find((x) => x.o.id === id) || (doc.media[id] ? { kind: 'media', o: doc.media[id] } : null);
    const trackOf = (kind, want, style = null) => {
      let tr = want ? doc.tracks.find((t) => t.kind === kind && (t.id === want || t.name === want)) : doc.tracks.find((t) => t.kind === kind);
      if (!tr) { tr = { id: C.uid(kind[0]), kind, name: String(want || { text: '자막', audio: '소리', video: '영상' }[kind]), ...(kind === 'text' ? { style, items: [] } : { clips: [] }) }; doc.tracks.push(tr); }
      return tr;
    };
    // 점 표기("anim.in", "keys.scale")·JSON 값을 받아 깊게 합친다
    const assign = (o, props) => {
      for (const [k, v] of Object.entries(props || {})) {
        const ks = k.split('.'); let t = o;
        for (const p of ks.slice(0, -1)) t = (t[p] && typeof t[p] === 'object') ? t[p] : (t[p] = {});
        const last = ks[ks.length - 1];
        if (v && typeof v === 'object' && !Array.isArray(v) && t[last] && typeof t[last] === 'object' && !Array.isArray(t[last])) Object.assign(t[last], v); else if (v === null) delete t[last]; else t[last] = v;
      }
    };
    for (const op of Array.isArray(ops) ? ops : []) {
      if (op.op === 'text') {
        const tr = trackOf('text', op.track, op.style || null), start = Number(op.start) || 0;
        const end = op.end != null ? Number(op.end) : start + (Number(op.dur) > 0 ? Number(op.dur) : 2);
        const it = { id: C.uid('x'), start, end, text: String(op.text ?? ''), style: op.style || null, override: op.override || {}, x: Number(op.x) || 0, y: op.y != null ? Number(op.y) : Math.round(doc.height * 0.36), scale: op.scale != null ? Number(op.scale) : 1, rotation: 0, opacity: 1, anim: { in: op.in || 'none', out: op.out || 'none', inDur: op.inDur ?? 0.2, outDur: op.outDur ?? 0.15 }, keys: op.keys || {} };
        tr.items.push(it); results.push({ op: 'text', id: it.id, track: tr.id });
      } else if (op.op === 'set') {
        const f = find(op.id); if (!f) throw error(404, `id "${op.id}" 를 찾지 못했어요`);
        assign(f.o, op.props); results.push({ op: 'set', id: op.id, kind: f.kind });
      } else if (op.op === 'style') {
        const name = String(op.name || '').trim(); if (!name) throw error(400, '스타일 이름이 필요해요');
        doc.styles[name] = { ...(doc.styles[name] || plain(C.STYLE_DEFAULT)) }; assign(doc.styles[name], op.props); results.push({ op: 'style', name });
      } else if (op.op === 'marker') {
        const mk = { id: C.uid('k'), t: Math.max(0, Number(op.t) || 0), label: String(op.label || '') }; doc.markers.push(mk); results.push({ op: 'marker', id: mk.id });
      } else if (op.op === 'track') {
        const tr = trackOf(['video', 'audio', 'text'].includes(op.kind) ? op.kind : 'video', op.name || null, op.style || null); results.push({ op: 'track', id: tr.id });
      } else if (op.op === 'fx') { // 효과 더하기·바꾸기(index)·빼기(remove) — 클립·글자·도형
        const f = find(op.id); if (!f || (f.kind !== 'clip' && f.kind !== 'item')) throw error(404, `클립·글자 "${op.id}" 를 찾지 못했어요`);
        const list = (f.o.effects ||= []);
        if (op.remove != null) list.splice(Number(op.remove), 1);
        else { if (!core().FX[op.type]) throw error(400, `모르는 효과: ${op.type} (가능: ${Object.keys(core().FX).join(', ')})`); const fx = { type: op.type, ...(op.props || {}) }; if (op.index != null && list[Number(op.index)]) list[Number(op.index)] = fx; else list.push(fx); }
        results.push({ op: 'fx', id: op.id, count: list.length });
      } else if (op.op === 'shape') { // 도형 층(글자 트랙)
        if (!core().SHAPES.includes(op.type)) throw error(400, `모르는 도형: ${op.type} (가능: ${core().SHAPES.join(', ')})`);
        const tr = trackOf('text', op.track || '도형'), start = Number(op.start) || 0, end = op.end != null ? Number(op.end) : start + (Number(op.dur) > 0 ? Number(op.dur) : 2);
        const it = { id: C.uid('x'), start, end, text: String(op.text || ''), style: null, override: {}, shape: { type: op.type, ...(op.props || {}) }, x: Number(op.x) || 0, y: Number(op.y) || 0, scale: op.scale != null ? Number(op.scale) : 1, rotation: Number(op.rotation) || 0, opacity: op.opacity != null ? Number(op.opacity) : 1, anim: { in: op.in || 'none', out: op.out || 'none', inDur: op.inDur ?? 0.2, outDur: op.outDur ?? 0.15 }, keys: op.keys || {} };
        tr.items.push(it); results.push({ op: 'shape', id: it.id, track: tr.id });
      } else if (op.op === 'adjust') { // 조정 레이어: 아래 그림 전체에 효과(맨 위 "조정" 영상 트랙)
        let mid = Object.keys(doc.media).find((k) => doc.media[k].kind === 'adjust');
        if (!mid) { mid = 'adjust'; for (let i = 2; doc.media[mid]; i++) mid = `adjust${i}`; doc.media[mid] = { path: '', kind: 'adjust', name: '조정 레이어' }; }
        const name = op.track || '조정';
        let tr = doc.tracks.find((t) => t.kind === 'video' && t.name === name);
        if (!tr) { tr = { id: C.uid('v'), kind: 'video', name, clips: [] }; let last = -1; doc.tracks.forEach((t, i) => { if (t.kind === 'video') last = i; }); doc.tracks.splice(last + 1, 0, tr); }
        const start = Number(op.start) || 0, dur = op.end != null ? Number(op.end) - start : Number(op.dur) > 0 ? Number(op.dur) : 2;
        const c = { id: C.uid('c'), media: mid, start, in: 0, out: Math.max(1 / doc.fps, dur), effects: op.effects || [], ...(op.props || {}) };
        tr.clips.push(c); results.push({ op: 'adjust', id: c.id, track: tr.id });
      } else if (op.op === 'remove') {
        const f = find(op.id); if (!f) throw error(404, `id "${op.id}" 를 찾지 못했어요`);
        if (f.kind === 'track') doc.tracks = doc.tracks.filter((t) => t !== f.o);
        else if (f.kind === 'media') delete doc.media[op.id];
        else if (f.tr) { if (f.tr.items) f.tr.items = f.tr.items.filter((x) => x !== f.o); else f.tr.clips = f.tr.clips.filter((x) => x !== f.o); }
        results.push({ op: 'remove', id: op.id });
      } else throw error(400, `모르는 고치기: ${op.op}`);
    }
    return { ...this.save(file, doc, mtime), results };
  }

  /**
   * 따라가기(cli follow·/api/follow): 클립 원본에서 rect(원본 px, 왼쪽 위 x·y)를 프레임마다 찾아 키로.
   * apply: 'mask'(이 클립 마스크가 따라감) | 'item:<id>'(글자·도형이 따라감) | 'clip:<id>'(다른 클립이 따라감) | 'stabilize'(흔들림 잡기) | 없음(점만 돌려줌)
   */
  async follow(file, { clip: clipId, rect, from = null, to = null, apply = null, every = 2, allowed = (p) => p } = {}) {
    const { ffmpeg } = tools(this.config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요');
    const { doc, mtime } = this.read(file), C = core();
    const hit = doc.tracks.flatMap((t) => (t.clips || []).map((c) => ({ t, c }))).find((v) => v.c.id === clipId);
    if (!hit) throw error(404, `클립 "${clipId}" 를 찾지 못했어요`);
    const c = hit.c, m = doc.media[c.media];
    if (!m || m.kind !== 'video' || !(m.width > 0)) throw error(400, '따라가기는 영상 클립에서만 돼요');
    const R = Array.isArray(rect) ? { x: +rect[0], y: +rect[1], w: +rect[2], h: +rect[3] } : { x: +rect?.x, y: +rect?.y, w: +rect?.w, h: +rect?.h };
    if (![R.x, R.y, R.w, R.h].every(Number.isFinite)) throw error(400, 'rect 는 원본 픽셀 [x, y, w, h] 로 주세요');
    const t0 = from == null ? c.start : Math.max(c.start, Number(from)), t1 = to == null ? C.clipEnd(c) : Math.min(C.clipEnd(c), Number(to));
    if (!(t1 > t0)) throw error(400, '따라갈 구간이 비었어요');
    // 원본 시각 구간(되감기·속도 반영) — 첫 프레임(t0 의 원본 시각)에서 rect 를 본보기로
    const s0 = C.sourceTime(c, t0 - c.start), s1 = C.sourceTime(c, t1 - c.start), back = s1 < s0;
    const src = allowed(mediaPath(file, m.path)), fps = m.fps > 1 ? m.fps : doc.fps;
    let tr;
    if (!back) tr = await trackRect({ ffmpeg, file: src, from: s0, to: s1, rect: R, mediaW: m.width, mediaH: m.height, fps });
    else { // 되감은 클립: 원본을 거꾸로는 못 읽어 끝(s1)부터 앞으로 따라간 뒤 t0 에서 rect 가 되도록 옮긴다
      const fwd = await trackRect({ ffmpeg, file: src, from: s1, to: s0, rect: R, mediaW: m.width, mediaH: m.height, fps });
      const last = fwd.points[fwd.points.length - 1]; tr = { points: fwd.points.map((p) => ({ ...p, x: p.x - last.x + R.x, y: p.y - last.y + R.y })) };
    }
    const P = tr.points;
    const at = (s) => { if (s <= P[0].t) return P[0]; for (let i = 1; i < P.length; i++) if (s <= P[i].t) { const a = P[i - 1], b = P[i], k = (s - a.t) / ((b.t - a.t) || 1); return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, lost: a.lost || b.lost }; } return P[P.length - 1]; };
    const toScreen = (d, t, sx, sy, cl = c) => { const b = C.clipBox(d, cl, t), kx = b.w / m.width, ky = b.h / m.height, lx = (sx - m.width / 2) * kx, ly = (sy - m.height / 2) * ky, a = b.rotation * Math.PI / 180; return { x: b.cx + lx * Math.cos(a) - ly * Math.sin(a), y: b.cy + lx * Math.sin(a) + ly * Math.cos(a) }; };
    const samples = [];
    for (let t = t0; t <= t1 + 1e-9; t += Math.max(1, every) / doc.fps) { const p = at(C.sourceTime(c, Math.min(t, t1) - c.start)); samples.push({ t: Math.min(t, t1), x: p.x, y: p.y, ...(p.lost ? { lost: true } : {}) }); }
    const out = { clip: c.id, rect: R, from: t0, to: t1, frames: P.length, lost: P.filter((p) => p.lost).length, applied: null };
    const keysOf = (pts, base, valX, valY) => { const sp = simplify(pts.map((p) => ({ t: p.t, x: valX(p), y: valY(p) }))); return { x: sp.map((p) => ({ t: Math.round((p.t - base) * 10000) / 10000, v: Math.round(p.x * 100) / 100, ease: 'linear' })), y: sp.map((p) => ({ t: Math.round((p.t - base) * 10000) / 10000, v: Math.round(p.y * 100) / 100, ease: 'linear' })) }; };
    if (apply) {
      const ap = String(apply);
      if (ap === 'mask') {
        const k = keysOf(samples, c.start, (p) => p.x, (p) => p.y);
        c.mask = { shape: 'rect', feather: 0, ...(c.mask || {}), x: R.x, y: R.y, w: R.w, h: R.h, keys: { ...((c.mask && c.mask.keys) || {}), x: k.x, y: k.y } };
      } else if (ap === 'stabilize') {
        const base = { ...c, keys: { ...c.keys } }; delete base.keys.x; delete base.keys.y;
        const ref = toScreen(doc, t0, samples[0].x + R.w / 2, samples[0].y + R.h / 2, base);
        const pts = samples.map((p) => { const s = toScreen(doc, p.t, p.x + R.w / 2, p.y + R.h / 2, base); return { t: p.t, dx: s.x - ref.x, dy: s.y - ref.y }; });
        const k = keysOf(pts, c.start, (p) => c.x - p.dx, (p) => c.y - p.dy);
        c.keys = { ...c.keys, x: k.x, y: k.y };
      } else if (/^(item|clip):/.test(ap)) {
        const id = ap.slice(ap.indexOf(':') + 1), all = doc.tracks.flatMap((t) => (t.items || t.clips).map((o) => ({ t, o }))), tgt = all.find((v) => v.o.id === id);
        if (!tgt) throw error(404, `따라갈 대상 "${id}" 를 찾지 못했어요`);
        const o = tgt.o, st = o.start, en = tgt.t.kind === 'text' ? o.end : C.clipEnd(o);
        const pts = samples.filter((p) => p.t >= st - 1e-9 && p.t <= en + 1e-9).map((p) => { const s = toScreen(doc, p.t, p.x + R.w / 2, p.y + R.h / 2); return { t: p.t, sx: s.x - doc.width / 2, sy: s.y - doc.height / 2 }; });
        if (!pts.length) throw error(400, '따라갈 대상이 그 구간에 없어요');
        const offX = (Number(o.x) || 0) - pts[0].sx, offY = (Number(o.y) || 0) - pts[0].sy; // 지금 자리와의 차이는 그대로
        const k = keysOf(pts, st, (p) => p.sx + offX, (p) => p.sy + offY);
        o.keys = { ...(o.keys || {}), x: k.x, y: k.y };
      } else throw error(400, `apply 는 mask | stabilize | item:<id> | clip:<id> 중 하나예요`);
      Object.assign(out, this.save(file, doc, mtime)); out.applied = ap;
    }
    out.points = samples.map((p) => { const s = toScreen(doc, p.t, p.x + R.w / 2, p.y + R.h / 2); return { t: Math.round(p.t * 10000) / 10000, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, screenX: Math.round((s.x - doc.width / 2) * 100) / 100, screenY: Math.round((s.y - doc.height / 2) * 100) / 100, ...(p.lost ? { lost: true } : {}) }; });
    return out;
  }

  /* ---------- 렌더 ---------- */
  list() { return [...this.renders.values()].map((r) => this.pub(r)); }
  pub(r) { return { id: r.id, path: r.path, out: r.out, output: r.output || null, status: r.status, progress: r.progress, stage: r.stage, error: r.error, warnings: r.warnings, startedAt: r.startedAt, finishedAt: r.finishedAt }; }
  tell(r) { this.emit('event', { type: 'render', render: this.pub(r) }); }
  cancel(id) {
    const r = this.renders.get(id); if (!r) throw error(404, '렌더를 찾지 못했어요');
    if (r.status !== 'running') return this.pub(r);
    r.cancelled = true; for (const c of r.children) killChildTree(c);
    return this.pub(r);
  }
  /** allowed(p): 원본 경로 허용 검사(원격 요청이면 ODDIN 이 아는 폴더만) */
  async render(file, { out = null, allowed = (p) => p, output = null } = {}) {
    const { ffmpeg } = tools(this.config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요. ffmpeg를 설치하거나 config.json 의 studio.video.ffmpeg 에 경로를 적어 주세요');
    const { doc } = this.read(file);
    const hash = editHash(doc); // 원본 경로를 풀기 전(편집 파일 그대로의 내용)
    for (const r of this.renders.values()) if (r.path === file && r.status === 'running') throw error(409, '이 편집은 이미 렌더하고 있어요');
    const D = core().duration(doc); if (D <= 0) throw error(400, '렌더할 내용이 없어요(클립·자막이 없음)');
    for (const m of Object.values(doc.media)) { if (m.kind === 'adjust') continue; m.file = mediaPath(file, m.path); try { m.file = allowed(m.file); } catch (e) { throw error(e.status || 400, `원본을 열 수 없어요: ${m.path} — ${e.message}`); } }
    // 출력 형식: 편집 파일 output + 이번 렌더에서 고른 것(cli render --codec 등)
    const outFmt = plain(core().cleanOutput({ ...(doc.output || {}), ...(output || {}) })), ext = core().OUT_FORMATS[outFmt.codec].ext;
    const base = file.slice(0, -EDIT_EXT.length);
    let target = out ? path.join(path.dirname(file), path.basename(out)) : `${base}${ext}`;
    for (let i = 2; fs.existsSync(target) && !out; i++) target = `${base} (${i})${ext}`;
    const id = crypto.randomBytes(6).toString('hex');
    const r = { id, path: file, out: target, hash, output: outFmt, allowed, stack: new Set([path.resolve(file).toLowerCase()]), status: 'running', progress: 0, stage: '준비', error: null, warnings: [], startedAt: nowIso(), finishedAt: null, children: new Set(), cancelled: false };
    this.renders.set(id, r); this.tell(r);
    const tmp = path.join(DATA_DIR, 'render', id); fs.mkdirSync(tmp, { recursive: true });
    this.renderJob(r, doc, D, tmp).then(() => { r.status = 'done'; r.progress = 1; r.stage = '완료'; })
      .catch((e) => { r.status = r.cancelled ? 'cancelled' : 'failed'; r.error = r.cancelled ? '중지했어요' : e.message; try { fs.rmSync(target, { force: true }); } catch {} })
      .finally(() => { r.finishedAt = nowIso(); if (!process.env.STUDIO_KEEP_TMP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } this.tell(r); }); // STUDIO_KEEP_TMP=1: 조각·필터 그래프를 남김(고장 찾기)
    return this.pub(r);
  }
  /** HTML 장면 원본을 먼저 투명 영상으로(같은 장면이면 캐시) — 그다음은 영상 원본처럼 */
  async prepareScenes(r, doc, editPath = r.path) {
    const scenes = Object.values(doc.media).filter((m) => m.kind === 'html');
    let i = 0;
    for (const m of scenes) {
      if (r.cancelled) throw new Error('중지');
      r.stage = `HTML 장면 ${++i}/${scenes.length} 그리는 중`; this.tell(r);
      const width = m.width || doc.width, height = m.height || doc.height, duration = m.duration || 5;
      m.file = await sceneClip({ browser: this.browser, config: this.config, file: m.file, url: await this.sceneUrl(m.file, editPath), width, height, fps: doc.fps, duration, children: r.children, isCancelled: () => r.cancelled });
      Object.assign(m, { kind: 'video', width: even(width), height: even(height), duration, audio: false });
    }
  }
  /** 편집 안 편집(원본 종류 edit): 그 편집을 먼저 중간 파일(무손실, 배경이 투명이면 알파)로 렌더해 영상 원본처럼 쓴다. 4단계까지, 자기 자신을 품으면 멈춤 */
  async prepareNested(r, doc, tmp, depth) {
    const C = core();
    for (const [id, m] of Object.entries(doc.media)) {
      if (m.kind !== 'edit') continue;
      if (r.cancelled) throw new Error('중지');
      if (depth >= 4) throw error(400, '편집 안 편집이 너무 깊어요(4단계까지)');
      const child = m.file, key = path.resolve(child).toLowerCase();
      if (r.stack.has(key)) throw error(400, `편집이 자기 자신을 품고 있어요: ${m.path}`);
      const { doc: cd } = this.read(child), CD = C.duration(cd);
      if (CD <= 0) throw error(400, `안에 넣은 편집이 비었어요: ${m.path}`);
      for (const cm of Object.values(cd.media)) { if (cm.kind === 'adjust') continue; cm.file = mediaPath(child, cm.path); try { cm.file = r.allowed(cm.file); } catch (e) { throw error(e.status || 400, `원본을 열 수 없어요: ${cm.path} — ${e.message}`); } }
      const sub = path.join(tmp, `nest-${id}`); fs.mkdirSync(sub, { recursive: true });
      const outFile = path.join(tmp, `nest-${id}.mkv`), alpha = isTransparent(cd.background);
      r.stack.add(key); r.stage = `편집 안 편집 그리는 중: ${path.basename(child)}`; this.tell(r);
      await this.renderJob(r, cd, CD, sub, { intermediate: true, alpha, outFile, editPath: child, depth: depth + 1 });
      r.stack.delete(key);
      Object.assign(m, { file: outFile, kind: 'video', width: even(cd.width), height: even(cd.height), duration: CD, audio: true, fps: cd.fps });
    }
  }
  /** 멈춤 프레임(freeze): 원본의 in 프레임을 그림 한 장으로 */
  async prepareStills(r, doc, tmp) {
    const { ffmpeg } = tools(this.config); let i = 0;
    for (const tr of doc.tracks) if (tr.kind === 'video') for (const c of tr.clips) {
      const m = doc.media[c.media]; if (!(c.freeze > 0) || !m || m.kind !== 'video' || !m.file) continue;
      const png = path.join(tmp, `still${i++}.png`);
      await this.ff(r, ffmpeg, ['-v', 'error', '-y', '-ss', f6(c.in), '-i', m.file, '-frames:v', '1', png]);
      c._still = png;
    }
  }
  /**
   * 렌더 본체. opt = { intermediate, alpha, outFile, editPath, depth } — intermediate 는 편집 안 편집용 중간 파일(ffv1·pcm, mkv)
   * 1) 시간 조각(클립 경계·전환 구간·되감기 4초·속도 램프 2초)마다 그림만 ffmpeg 로 — 소리는 동시에 전체 한 번에(audio-mix.mjs)
   * 2) 이어 붙이고 글자·도형 레이어(브라우저)를 합성해 출력 형식으로
   */
  async renderJob(r, doc, D, tmp, opt = {}) {
    const { ffmpeg } = tools(this.config), C = core(), editPath = opt.editPath || r.path, depth = opt.depth || 0, top = !opt.intermediate;
    await this.prepareScenes(r, doc, editPath);
    await this.prepareNested(r, doc, tmp, depth);
    await this.prepareStills(r, doc, tmp);
    const out = top ? r.output : { codec: 'ffv1', alpha: !!opt.alpha, bitDepth: 8, quality: 'master', audio: 'pcm' };
    const fps = doc.fps, frames = Math.max(1, Math.round(D * fps)), W = doc.width, H = doc.height, fr = rate(fps);
    const alpha = !!out.alpha, ten = out.bitDepth === 10, hi = alpha || ten || out.quality === 'master' || !top;
    const pf = alpha ? (ten ? 'yuva444p10le' : 'yuva444p') : hi ? (ten ? 'yuv444p10le' : 'yuv444p') : 'yuv420p';
    const ovf = hi ? (ten ? 'yuv444p10' : 'yuv444') : 'auto', gbr = ten ? 'gbrp10le' : 'gbrp';
    const enc = videoEncoder(this.config, ffmpeg);
    const pieceArgs = hi ? ['-c:v', 'ffv1', '-level', '3', '-slices', '16', '-g', '1', '-pix_fmt', pf] : encodeArgs(enc, { piece: true });
    const bgColor = alpha ? 'black@0' : `0x${(String(doc.background).match(/^#?([0-9a-f]{6})/i) || [0, '000000'])[1]}`;
    const fr0 = (t) => Math.round(t * fps); // 프레임 번호
    // 소리는 그림 조각과 동시에
    const audioP = out.audio === 'none' ? Promise.resolve(null) : mixAudio({ doc, D, tmp, run: (a) => this.ff(r, ffmpeg, a), runOut: (a) => this.ffOut(r, ffmpeg, a), warn: (w) => r.warnings.push(w) });
    audioP.catch(() => {});
    // 1) 시간 조각
    const cuts = new Set([0, frames]), add = (t) => cuts.add(Math.min(frames, Math.max(0, fr0(t))));
    for (const tr of doc.tracks) if (tr.kind === 'video') for (const c of tr.clips) {
      const L = C.clipLen(c), e = C.clipEnd(c); add(c.start); add(e);
      for (const [s0, s1] of transSpans(c, L)) { add(c.start + s0); add(c.start + s1); }
      if (c.reverse) for (let t = c.start + 4; t < e; t += 4) add(t);
      const ks = c.keys?.speed; if (Array.isArray(ks) && ks.length) { const k0 = c.start + ks[0].t, k1 = Math.min(e, c.start + ks[ks.length - 1].t); add(k0); add(k1); for (let t = k0 + 2; t < k1; t += 2) add(t); }
    }
    const marks = [...cuts].sort((a, b) => a - b), slices = [];
    for (let i = 0; i < marks.length - 1; i++) if (marks[i + 1] > marks[i]) slices.push({ f0: marks[i], f1: marks[i + 1] });
    const tag = top ? '' : `/n${depth}`;
    r.stage = `${top ? '' : '안쪽 편집 '}조각 ${slices.length}개 만드는 중`; this.tell(r);
    const mbConf = doc.motionBlur || { samples: 8, shutter: 0.5, all: false };
    let done = 0;
    const one = async (s, idx) => {
      if (r.cancelled) throw new Error('중지');
      const a = s.f0 / fps, n = s.f1 - s.f0, len = n / fps, mid = (s.f0 + s.f1) / 2 / fps;
      const vis = [];
      for (const tr of doc.tracks) if (tr.kind === 'video' && !tr.hidden) for (const c of tr.clips) {
        if (!(mid >= c.start && mid < C.clipEnd(c))) continue;
        const m = doc.media[c.media]; if (m && (m.width > 0 || m.kind === 'adjust')) vis.push({ c, m });
      }
      // 모션 블러: 켠 클립이 이 조각에서 움직이면 조각 전체를 N배 빠르게 그려 섞는다
      const moving = (c) => { const pts = [0, 0.25, 0.5, 0.75, 1].map((k) => C.clipBox(doc, c, Math.min(C.clipEnd(c) - 1e-4, a + len * k))); return pts.some((b) => Math.abs(b.cx - pts[0].cx) > 0.5 || Math.abs(b.cy - pts[0].cy) > 0.5 || Math.abs(b.w - pts[0].w) > 0.5 || Math.abs(b.rotation - pts[0].rotation) > 0.2); };
      const mb = vis.some((v) => v.m.kind !== 'adjust' && (v.c.motionBlur || mbConf.all) && moving(v.c));
      const N = mb ? mbConf.samples : 1, K = Math.max(1, Math.round(N * mbConf.shutter)), frc = fps * N, frcS = mb ? f6(frc) : fr, dur = f6(len + 0.6 + (mb ? 1 / fps : 0));
      const g = new Graph('g'), args = ['-v', 'error', '-y'];
      let last = g.src(`color=c=${bgColor}:s=${W}x${H}:r=${frcS}:d=${dur},format=${alpha ? (ten ? 'yuva444p10le' : 'yuva444p') : hi ? (ten ? 'yuv444p10le' : 'yuv444p') : 'yuv420p'}`), inputs = 0;
      const cmdFrames = Math.ceil((len + 0.6) * frc);
      const opacityOf = (c, off, cmds, id) => {
        // 불투명도(키프레임·화면 들어오기/나가기·전환): 프레임마다 JS 로 계산해 바뀌면 sendcmd, 아니면 고정값
        const op = (lt) => C.clipOpacity(c, c.start + lt), o0 = op(off);
        let varies = false; for (let k = 1; k < cmdFrames && !varies; k++) if (Math.abs(op(off + k / frc) - o0) > 1e-4) varies = true;
        if (varies) { cmds.push({ target: `colorchannelmixer@${id}o`, param: 'aa', at: op }); return `colorchannelmixer@${id}o=aa=${f6(o0)}`; }
        return o0 < 0.9999 ? `colorchannelmixer=aa=${f6(o0)}` : '';
      };
      const headLine = (inLabel, head, cmds, label, k) => {
        if (cmds.length) { const file = path.join(tmp, `cmd_${idx}_${k}.txt`); fs.writeFileSync(file, sendcmdScript(cmds, { frc, frames: cmdFrames, off: cmds.off })); head.push(`sendcmd=f=${ffPath(file)}`); }
        g.add(`[${inLabel}]${head.join(',')}[${label}]`);
      };
      vis.forEach((v, k) => {
        const c = v.c, m = v.m, off = a - c.start, id = `c${k}`, cmds = [], L = C.clipLen(c);
        cmds.off = off;
        const ctx = { g, id, pre: 1, fr: frcS, len, off, w: W, h: H, cmds, resolve: (p) => mediaPath(editPath, p), warn: (w) => { if (!r.warnings.includes(w)) r.warnings.push(w); } };
        if (m.kind === 'adjust') {
          // 조정 레이어: 아래에 쌓인 그림 전체에 효과(+마스크·전환·불투명도)를 걸어 그 위에 덮는다
          const [aa, ab] = g.split(last), h0 = g.lab();
          let cur = h0;
          const matte = buildMatte(g, { pw: W, ph: H, fr: frcS, len, off, kx: 1, ky: 1, mask: c.mask, clip: c, clipLen: L, id, cmds });
          for (const [j, fx] of (c.effects || []).entries()) if (fx.on !== false && fx.type !== 'shadow' && fx.type !== 'wiggle') { ctx.id = `${id}f${j}`; cur = applyFx(cur, fx, ctx); }
          if (matte) cur = applyMatte(g, cur, matte);
          cur = g.pipe(cur, [opacityOf(c, off, cmds, id)]);
          headLine(ab, ['format=rgba'], cmds, h0, k);
          const o = g.lab(); g.add(`[${aa}][${cur}]overlay=0:0:format=${ovf}[${o}]`); last = o;
          return;
        }
        // 입력: 그림·멈춤 | 되감기 | 속도 램프 | 일정한 속도
        let head;
        const ks = c.keys?.speed, sp = Number(c.speed) || 1;
        if (m.kind === 'image' || c._still) { args.push('-loop', '1', '-framerate', frcS, '-t', f6(len + 1), '-i', c._still || m.file); head = ['setpts=PTS-STARTPTS']; }
        else if (c.reverse) {
          const Sb = C.sourceTime(c, off), Sa = C.sourceTime(c, Math.min(L, off + len + 1 / fps)), span = Math.max(1 / fps, Sb - Sa + 1 / fps);
          args.push('-ss', f6(Math.max(0, Sa)), '-t', f6(span), '-i', m.file); head = [`trim=duration=${f6(span)}`, 'reverse', `setpts=(PTS-STARTPTS)/${f6(sp)}`];
        } else if (Array.isArray(ks) && ks.length) { const rp = rampSetpts(c, off, len + 1 / fps, fps); args.push('-ss', f6(Math.max(0, rp.srcStart)), '-t', f6(rp.srcLen + 0.3), '-i', m.file); head = [rp.expr]; }
        else { args.push('-ss', f6(Math.max(0, C.sourceTime(c, off))), '-t', f6((len + 0.6) * sp), '-i', m.file); head = [sp === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${f6(sp)}`]; }
        const inp = inputs++;
        head.push(c.interp === 'flow' ? `minterpolate=fps=${frcS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : c.interp === 'blend' ? `framerate=fps=${frcS}` : `fps=${frcS}`);
        // 확대 전 크기: 이 조각 동안 가장 크게 보일 때(표본) — 크기가 그대로면 딱 그 크기
        const fit = C.fitSize(doc, m, c.fit);
        let maxS = 0, minS = Infinity;
        for (let i = 0; i <= 32; i++) { const b = C.clipBox(doc, c, Math.min(C.clipEnd(c) - 1e-4, a + len * i / 32)); const sc = b.w / fit.w; maxS = Math.max(maxS, sc); minS = Math.min(minS, sc); }
        maxS = Math.max(0.01, maxS);
        const cap = 4096 / Math.max(fit.w, fit.h), pre = Math.min(maxS * (maxS - minS > 1e-6 ? 1.05 : 1), Math.max(cap, 0.01));
        const pw = even(fit.w * pre), ph = even(fit.h * pre), h0 = g.lab();
        ctx.pre = pre; ctx.w = pw; ctx.h = ph;
        let cur = g.pipe(h0, [`scale=${pw}:${ph}:flags=bicubic`, 'format=rgba']);
        // 마스크·지우기·원형(원본 픽셀 → 레이어 픽셀)
        const matte = buildMatte(g, { pw, ph, fr: frcS, len, off, kx: pw / (m.width || pw), ky: ph / (m.height || ph), mask: c.mask, clip: c, clipLen: L, id, cmds });
        if (matte) cur = applyMatte(g, cur, matte);
        // 효과(배열 순서)
        for (const [j, fx] of (c.effects || []).entries()) if (fx.on !== false) { ctx.id = `${id}f${j}`; cur = applyFx(cur, fx, ctx); }
        // 전환 흐림(흐림·휙 넘기기): 값은 JS 로
        const tState = (lt) => C.transState(c, lt, L, W, H);
        const tb = [c.transIn, c.transOut].some((t) => t && t.type === 'blur'), tw = [c.transIn, c.transOut].some((t) => t && t.type === 'whip');
        if (tb) { cmds.push({ target: `gblur@${id}tb`, param: 'sigma', at: (lt) => tState(lt).blur * pre / 2 }); cur = g.pipe(cur, [`gblur@${id}tb=sigma=${f6(tState(off).blur * pre / 2)}`]); }
        if (tw) { const st0 = tState(off); cmds.push({ target: `dblur@${id}tw`, param: 'radius', at: (lt) => Math.max(0, tState(lt).dblur * pre) }); cur = g.pipe(cur, [`dblur@${id}tw=angle=${f6([c.transIn, c.transOut].find((t) => t && t.type === 'whip').dir === 'up' || [c.transIn, c.transOut].find((t) => t && t.type === 'whip').dir === 'down' ? 90 : 0)}:radius=${f6(Math.max(0, st0.dblur * pre))}`, 'format=rgba']); }
        // 회전 → 3D 기울이기 → 불투명도 → 크기(프레임마다 바뀌면 overlay 바로 앞)
        const ex = clipExprs(doc, c, off, a);
        if (!(isConst(ex.rot) && Number(ex.rot) === 0)) { const side = even(Math.hypot(ctx.w, ctx.h)); cur = g.pipe(cur, [`rotate=a='(${ex.rot})*PI/180':ow=${side}:oh=${side}:c=none`]); ctx.w = ctx.h = side; }
        if (!(isConst(ex.rx) && Number(ex.rx) === 0 && isConst(ex.ry) && Number(ex.ry) === 0)) {
          const exI = clipExprs(doc, c, off, a, `(in/(${frcS}))`), cw = ctx.w, ch = ctx.h;
          cur = g.pipe(cur, [`pad=w=${cw * 2}:h=${ch * 2}:x=${cw / 2}:y=${ch / 2}:color=black@0`, tiltFilter({ rx: exI.rx, ry: exI.ry, s: exI.s, P: C.perspOf(doc), pre, cw, ch })]);
          ctx.w = cw * 2; ctx.h = ch * 2;
        }
        cur = g.pipe(cur, [opacityOf(c, off, cmds, id)]);
        const bw = ctx.w, bh = ctx.h;
        if (!isConst(ex.s)) cur = g.pipe(cur, [`scale=w='max(2,trunc(${bw}*(${ex.s})/${f6(pre)}/2)*2)':h='max(2,trunc(${bh}*(${ex.s})/${f6(pre)}/2)*2)':eval=frame`]);
        else if (Math.abs(Number(ex.s) / pre - 1) > 1e-6) cur = g.pipe(cur, [`scale=${even(bw * Number(ex.s) / pre)}:${even(bh * Number(ex.s) / pre)}`]);
        headLine(`${inp}:v`, head, cmds, h0, k);
        // 합성: 보통은 overlay, 섞기(블렌드)는 화면 크기 판에 놓고 바탕과 blend → 레이어 알파로 덮기
        const X = `W/2+(${ex.x})-w/2`, Y = `H/2+(${ex.y})-h/2`;
        if (!c.blend || !BLEND_FF[c.blend]) { const o = g.lab(); g.add(`[${last}][${cur}]overlay=x='${X}':y='${Y}':eval=frame:eof_action=pass:format=${ovf}[${o}]`); last = o; }
        else {
          const [mode, layerTop] = BLEND_FF[c.blend], cv = g.src(`color=c=black@0:s=${W}x${H}:r=${frcS}:d=${dur},format=rgba`), lf = g.lab();
          g.add(`[${cv}][${cur}]overlay=x='${X}':y='${Y}':eval=frame:eof_action=pass:format=auto[${lf}]`);
          const [lc, la] = g.split(lf), am = g.pipe(la, ['alphaextract']), lg = g.pipe(lc, [`format=${gbr}`]);
          const [b1, b2] = g.split(last), bg2 = g.pipe(b2, [`format=${gbr}`]), bl = g.lab(), bm = g.lab(), o = g.lab();
          g.add(layerTop ? `[${lg}][${bg2}]blend=all_mode=${mode}[${bl}]` : `[${bg2}][${lg}]blend=all_mode=${mode}[${bl}]`);
          g.add(`[${bl}][${am}]alphamerge[${bm}]`);
          g.add(`[${b1}][${bm}]overlay=0:0:format=${ovf}[${o}]`); last = o;
        }
      });
      if (mb) { const sh = K - 1 - Math.floor(K / 2); g.add(`[${last}]tmix=frames=${K},select='gte(n,${sh})*not(mod(n-${sh},${N}))',setpts=N/(${fr})/TB,trim=end_frame=${n},format=${pf}[vout]`); }
      else g.add(`[${last}]trim=end_frame=${n},setpts=PTS-STARTPTS,format=${pf}[vout]`);
      const script = path.join(tmp, `g${idx}.txt`); fs.writeFileSync(script, g.lines.join(';\n'));
      const seg = path.join(tmp, `s${String(idx).padStart(5, '0')}.mkv`);
      args.push('-/filter_complex', script, '-map', '[vout]', '-frames:v', String(n), '-r', fr, ...pieceArgs, '-an', seg);
      await this.ff(r, ffmpeg, args);
      s.file = seg; done++;
      if (top) { r.progress = 0.7 * done / slices.length; r.stage = `조각 ${done}/${slices.length}`; this.tell(r); }
    };
    const par = Math.max(1, Math.min(6, Number(this.config.video?.parallel) || 3));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(par, slices.length) }, async () => { while (next < slices.length) { const i = next++; await one(slices[i], i); } }));
    if (r.cancelled) throw new Error('중지');
    // 2) 이어 붙이기 + 글자 레이어 합성 + 소리 + 출력 형식
    if (top) { r.stage = '소리 섞는 중'; this.tell(r); }
    const wav = await audioP;
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, slices.map((s) => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const hasText = doc.tracks.some((t) => t.kind === 'text' && !t.hidden && t.items.length);
    const target = top ? r.out : opt.outFile, gif = out.codec === 'gif';
    const args = ['-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-f', 'concat', '-safe', '0', '-i', list];
    let ti = null, ai = null, nIn = 1;
    if (hasText) { args.push('-f', 'image2pipe', '-c:v', 'png', '-framerate', fr, '-i', 'pipe:0'); ti = nIn++; }
    if (wav) { args.push('-i', wav); ai = nIn++; }
    let vf = hasText ? `[0:v][${ti}:v]overlay=0:0:eof_action=pass:format=${ovf}` : '[0:v]null';
    if (gif) vf += `,fps=${f6(out.fps || 15)},split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=sierra2_4a[v]`;
    else vf += `,format=${top ? outputPixFmt(out) : pf}[v]`;
    args.push('-filter_complex', vf, '-map', '[v]');
    if (ai != null) args.push('-map', `${ai}:a`);
    if (top) {
      const oa = outputArgs(out, enc, this.config);
      if (gif) args.push('-t', f6(frames / fps), '-f', 'gif');
      else args.push('-frames:v', String(frames), '-r', fr, ...oa.video);
      if (ai != null) args.push(...oa.audio);
      if (/\.(mp4|mov)$/i.test(target)) args.push('-movflags', '+faststart');
      // "ODDIN 스튜디오가 이 편집 파일의 이 내용으로 뽑았다" 표시 — cli.mjs verify 가 최신 렌더인지 본다
      if (!gif) args.push('-metadata', `comment=oddin-studio ${JSON.stringify({ edit: r.path, hash: r.hash, at: r.startedAt, encoder: enc, codec: out.codec })}`);
    } else args.push('-frames:v', String(frames), '-r', fr, '-c:v', 'ffv1', '-level', '3', '-slices', '16', '-pix_fmt', pf, ...(ai != null ? ['-c:a', 'pcm_s16le'] : []));
    args.push(target);
    if (top) { r.stage = hasText ? '자막 그리며 합치는 중' : '합치는 중'; this.tell(r); }
    const child = guardChild(spawn(ffmpeg, args, { windowsHide: true, stdio: [hasText ? 'pipe' : 'ignore', 'pipe', 'pipe'] }));
    r.children.add(child);
    let errTail = '';
    child.stderr.on('data', (b) => { errTail = (errTail + b).slice(-4000); });
    child.stdout.on('data', (b) => { if (!top) return; const m = String(b).match(/frame=(\d+)/g); if (m) { const f = Number(m.at(-1).slice(6)); r.progress = 0.7 + 0.3 * Math.min(1, f / frames); if (!r._t || Date.now() - r._t > 500) { r._t = Date.now(); this.tell(r); } } });
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => { r.children.delete(child); code === 0 ? resolve() : reject(new Error(r.cancelled ? '중지' : (errTail.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${code}`))); });
    });
    if (hasText) {
      // 글자 그리기가 먼저 실패하면 그 이유를 알린다(ffmpeg 를 끄면 "종료 코드 1"만 남아 원인이 가려졌다)
      let feedErr = null;
      const feeding = this.feedOverlay(r, doc, frames, child.stdin, editPath, tag).catch((e) => { feedErr = e; killChildTree(child); });
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
  /** ffmpeg 를 돌리고 stderr 전체(끝 64KB)를 돌려준다 — 음량 재기(loudnorm print_format=json) */
  ffOut(r, bin, args) {
    return new Promise((resolve, reject) => {
      const child = guardChild(spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }));
      r.children.add(child); let err = '';
      child.stderr.on('data', (b) => { err = (err + b).slice(-65536); });
      child.on('error', reject);
      child.on('close', (code) => { r.children.delete(child); code === 0 ? resolve(err) : reject(new Error(r.cancelled ? '중지' : (err.trim().split('\n').slice(-3).join(' ') || `ffmpeg 종료 코드 ${code}`))); });
    });
  }
  /** 엔진 브라우저로 글자 레이어를 프레임마다 그려 PNG 로 넘긴다(바뀐 프레임만 찍음). editPath = 그릴 편집 파일(편집 안 편집이면 그 파일) */
  async feedOverlay(r, doc, frames, stdin, editPath = r.path, tag = '') {
    const B = this.browser;
    if (!B) throw new Error('자막·글자를 그리려면 브라우저(Edge·Chrome)가 필요해요');
    const owner = `studio-render/${r.id}${tag}`;
    // 컴퓨터가 바쁘면 브라우저가 늦게 뜰 수 있다 — 한 번 더 시도
    let tab; try { tab = await B.tabOf(owner); } catch { await new Promise((x) => setTimeout(x, 1500)); tab = await B.tabOf(owner); }
    const write = (buf) => new Promise((resolve, reject) => { if (stdin.destroyed) return reject(new Error('ffmpeg 입력이 닫혔어요')); stdin.write(buf, (e) => (e ? reject(e) : resolve())); });
    try {
      await B.send('Emulation.setDeviceMetricsOverride', { width: doc.width, height: doc.height, deviceScaleFactor: 1, mobile: false }, tab.session);
      await B.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, tab.session);
      await B.send('Page.navigate', { url: `${this.engineUrl()}/ui/render.html?path=${encodeURIComponent(editPath)}` }, tab.session);
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
}

/** 엔진 출처의 원본 주소(/api/raw/…)의 경로 부분. HTML 은 여기서 스크립트 없이 보기만 된다 — 스크립트가 도는 장면은 장면 출처(sceneUrl)로 */
export const rawPath = (file) => String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
