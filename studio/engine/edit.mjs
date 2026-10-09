// ODDIN 스튜디오 편집 엔진 (2026-10-10 사용자 "오딘에 딱 맞는 영상편집 툴" → 같은 날 "오딘과 연동되는 프로그램으로", replica/architecture.md)
// - 편집 파일(*.oddin-edit.json) 읽기·저장(바뀌었으면 409)·영상으로 새로 만들기(같은 이름 SRT → 자막)·원본 넣기·SRT 넣기·점검
// - 렌더: 시간 조각(같은 클립들이 보이는 구간)마다 ffmpeg 로 영상+소리 조각을 만들고(확대·위치·회전 키프레임은 ffmpeg 식),
//   조각을 이어 붙이며 글자·자막 레이어(엔진 브라우저가 ui/render.html 로 그린 투명 PNG)를 위에 합성한다.
//   ffmpeg 시험으로 확인한 순서: 크기가 프레임마다 바뀌는 scale(eval=frame)은 overlay 바로 앞에 둬야 한다(뒤에 다른 필터가 오면 첫 크기로 굳는다).
//   회전은 그 앞에서 고정 크기로 한다. 그림은 한 장을 되풀이(-loop 1), HTML 장면은 먼저 투명 영상으로 만들어(scene.mjs) 영상처럼 쓴다.
// 공용 계산(키프레임·이징·정리·원본 넣기)은 ui/video-core.js 를 vm 으로 읽어 화면과 같은 코드를 쓴다.
// 경로 허용(원격에서 온 요청은 ODDIN 이 아는 폴더만)은 server.mjs 가 정해 allowed 로 넘긴다.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { guardChild, killChildTree, nowIso } from '../../lib/util.mjs';
import { UI_DIR, DATA_DIR, error } from './env.mjs';
import { tools, probe, f6, even, rate, VIDEO_RE } from './media.mjs';
import { listFonts } from './fonts.mjs';
import { sceneClip } from './scene.mjs';

export const EDIT_EXT = '.oddin-edit.json';

/* ---------- 공용 코어(ui/video-core.js) ---------- */
let CORE = null;
export function core() {
  if (!CORE) {
    const ctx = { console, Math, JSON, Date };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(UI_DIR, 'video-core.js'), 'utf8'), ctx, { filename: 'video-core.js' });
    CORE = ctx.OddinVideo;
  }
  return CORE;
}
export const plain = (v) => JSON.parse(JSON.stringify(v)); // vm 안에서 만든 객체를 이쪽 객체로

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
  /** browser: 엔진의 BrowserManager(글자 레이어·HTML 장면 그리기), engineUrl: 엔진 주소(브라우저가 장면·렌더 페이지를 연다) */
  constructor({ config, browser = null, engineUrl = () => '' }) {
    super();
    this.config = config; this.browser = browser; this.engineUrl = engineUrl;
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
      const info = await probe(f, this.config);
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
    const missingMedia = Object.entries(d.media).filter(([, m]) => !fs.existsSync(mediaPath(file, m.path))).map(([id, m]) => ({ id, path: m.path }));
    return { path: file, title: d.title, size: `${d.width}x${d.height}`, fps: d.fps, duration: C.duration(d), tracks: d.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, count: (t.items || t.clips).length })), problems: r.problems, ...plain(C.textChecks(d)), missingFonts, missingMedia };
  }

  /* ---------- 렌더 ---------- */
  list() { return [...this.renders.values()].map((r) => this.pub(r)); }
  pub(r) { return { id: r.id, path: r.path, out: r.out, status: r.status, progress: r.progress, stage: r.stage, error: r.error, warnings: r.warnings, startedAt: r.startedAt, finishedAt: r.finishedAt }; }
  tell(r) { this.emit('event', { type: 'render', render: this.pub(r) }); }
  cancel(id) {
    const r = this.renders.get(id); if (!r) throw error(404, '렌더를 찾지 못했어요');
    if (r.status !== 'running') return this.pub(r);
    r.cancelled = true; for (const c of r.children) killChildTree(c);
    return this.pub(r);
  }
  /** allowed(p): 원본 경로 허용 검사(원격 요청이면 ODDIN 이 아는 폴더만) */
  async render(file, { out = null, allowed = (p) => p } = {}) {
    const { ffmpeg } = tools(this.config); if (!ffmpeg) throw error(500, 'ffmpeg를 찾지 못했어요. ffmpeg를 설치하거나 config.json 의 studio.video.ffmpeg 에 경로를 적어 주세요');
    const { doc } = this.read(file);
    for (const r of this.renders.values()) if (r.path === file && r.status === 'running') throw error(409, '이 편집은 이미 렌더하고 있어요');
    const D = core().duration(doc); if (D <= 0) throw error(400, '렌더할 내용이 없어요(클립·자막이 없음)');
    for (const m of Object.values(doc.media)) { m.file = mediaPath(file, m.path); try { m.file = allowed(m.file); } catch (e) { throw error(e.status || 400, `원본을 열 수 없어요: ${m.path} — ${e.message}`); } }
    const base = file.slice(0, -EDIT_EXT.length);
    let target = out ? path.join(path.dirname(file), path.basename(out)) : `${base}.mp4`;
    for (let i = 2; fs.existsSync(target) && !out; i++) target = `${base} (${i}).mp4`;
    const id = crypto.randomBytes(6).toString('hex');
    const r = { id, path: file, out: target, status: 'running', progress: 0, stage: '준비', error: null, warnings: [], startedAt: nowIso(), finishedAt: null, children: new Set(), cancelled: false };
    this.renders.set(id, r); this.tell(r);
    const tmp = path.join(DATA_DIR, 'render', id); fs.mkdirSync(tmp, { recursive: true });
    this.renderJob(r, doc, D, tmp).then(() => { r.status = 'done'; r.progress = 1; r.stage = '완료'; })
      .catch((e) => { r.status = r.cancelled ? 'cancelled' : 'failed'; r.error = r.cancelled ? '중지했어요' : e.message; try { fs.rmSync(target, { force: true }); } catch {} })
      .finally(() => { r.finishedAt = nowIso(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} this.tell(r); });
    return this.pub(r);
  }
  /** HTML 장면 원본을 먼저 투명 영상으로(같은 장면이면 캐시) — 그다음은 영상 원본처럼 */
  async prepareScenes(r, doc) {
    const scenes = Object.values(doc.media).filter((m) => m.kind === 'html');
    let i = 0;
    for (const m of scenes) {
      if (r.cancelled) throw new Error('중지');
      r.stage = `HTML 장면 ${++i}/${scenes.length} 그리는 중`; this.tell(r);
      const width = m.width || doc.width, height = m.height || doc.height, duration = m.duration || 5;
      m.file = await sceneClip({ browser: this.browser, config: this.config, file: m.file, url: `${this.engineUrl()}/api/raw/${rawPath(m.file)}`, width, height, fps: doc.fps, duration, children: r.children, isCancelled: () => r.cancelled });
      Object.assign(m, { kind: 'video', width: even(width), height: even(height), duration, audio: false });
    }
  }
  async renderJob(r, doc, D, tmp) {
    const { ffmpeg } = tools(this.config), C = core();
    await this.prepareScenes(r, doc);
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
          const useV = tr.kind === 'video' && !tr.hidden && (m.width > 0), useA = !tr.muted && m.audio !== false && m.kind === 'video';
          if (!useV && !useA) continue;
          inputs.set(c.id, inputs.size);
          if (m.kind === 'image') args.push('-loop', '1', '-framerate', rate(fps), '-t', f6(len + 0.5), '-i', m.file);
          else args.push('-ss', f6(Math.max(0, c.in + (a - c.start))), '-t', f6(len + 0.5), '-i', m.file);
          if (useV) vin.push({ c, m, i: inputs.size - 1, off: a - c.start });
          if (useA) ain.push({ c, i: inputs.size - 1, off: a - c.start, a0: a, len });
        }
      }
      const g = [`color=c=${doc.background.replace('#', '0x').slice(0, 8)}:s=${W}x${H}:r=${rate(fps)}:d=${f6(len + 0.5)},format=yuv420p[bg0]`];
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
  /** 엔진 브라우저로 글자 레이어를 프레임마다 그려 PNG 로 넘긴다(바뀐 프레임만 찍음) */
  async feedOverlay(r, doc, frames, stdin) {
    const B = this.browser;
    if (!B) throw new Error('자막·글자를 그리려면 브라우저(Edge·Chrome)가 필요해요');
    const owner = `studio-render/${r.id}`;
    // 컴퓨터가 바쁘면 브라우저가 늦게 뜰 수 있다 — 한 번 더 시도
    let tab; try { tab = await B.tabOf(owner); } catch { await new Promise((x) => setTimeout(x, 1500)); tab = await B.tabOf(owner); }
    const write = (buf) => new Promise((resolve, reject) => { if (stdin.destroyed) return reject(new Error('ffmpeg 입력이 닫혔어요')); stdin.write(buf, (e) => (e ? reject(e) : resolve())); });
    try {
      await B.send('Emulation.setDeviceMetricsOverride', { width: doc.width, height: doc.height, deviceScaleFactor: 1, mobile: false }, tab.session);
      await B.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, tab.session);
      await B.send('Page.navigate', { url: `${this.engineUrl()}/ui/render.html?path=${encodeURIComponent(r.path)}` }, tab.session);
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

/** 장면·원본 주소의 경로 부분: 폴더 구조를 그대로 따라야 장면 안 상대 경로(그림·글꼴)가 이어진다 */
export const rawPath = (file) => String(file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
