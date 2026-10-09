#!/usr/bin/env node
// ODDIN 스튜디오 명령줄(작업자 AI·사람). 엔진(studio/engine/server.mjs, 기본 http://127.0.0.1:7710)이 꺼져 있으면 켠다.
//   node studio/cli.mjs status                                  스튜디오 켜짐·버전·ffmpeg·브라우저·ODDIN 연결
//   node studio/cli.mjs open <편집파일|영상>                       스튜디오 창에서 열기(창이 없으면 띄움)
//   node studio/cli.mjs new <영상> [--out <이름>.oddin-edit.json]  영상으로 새 편집(같은 이름 .srt → 자막 트랙)
//   node studio/cli.mjs blank <폴더> [--title 이름] [--size 1080x1920] [--fps 30]  빈 편집
//   node studio/cli.mjs add <편집파일> <원본…> [--at 초] [--track id] [--len 초]  영상·소리·그림·HTML 장면을 트랙에 넣기
//   node studio/cli.mjs check <편집파일>                          형식 정리·자막 빈칸/겹침/두 줄·없는 글꼴·없는 원본 점검
//   node studio/cli.mjs import-srt <편집파일> <SRT> [트랙이름]
//   node studio/cli.mjs srt <편집파일> [트랙id]                    자막 SRT 출력
//   node studio/cli.mjs from-premiere [--seq 이름|id] [--out 폴더]  열린 프리미어 시퀀스 → 편집 파일(ODDIN 어도비 플러그인 경유)
//   node studio/cli.mjs scene <장면.html> [--dur 초] [--size 1080x1920] [--fps 30] [--out x.mp4|x.mov]  HTML 장면 → 영상(.mov 는 투명)
//   node studio/cli.mjs render <편집파일> [--wait]                MP4 렌더(편집 파일 옆)
//   node studio/cli.mjs fonts [--missing] | fonts install <글꼴파일…|--all>
//   node studio/cli.mjs pipelines                                 파이프라인(합친 스킬의 제작 흐름) 목록
//   node studio/cli.mjs quit                                      엔진 끄기(렌더 중이면 거절)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEngine, engineUrl, engineStatus } from './engine/launch.mjs';

const argv = process.argv.slice(2);
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; } else pos.push(a); }
const [cmd, ...rest] = pos;
const abs = (p) => path.resolve(String(p || ''));
const BASE = engineUrl();
async function call(p, opt = {}) {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j?.error || `스튜디오가 ${r.status}로 답했어요`);
  return j;
}
const post = (p, body) => call(p, { method: 'POST', body: JSON.stringify(body) });
const fmt = (t) => { const s = Math.max(0, Number(t) || 0); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`; };
const size = (v) => { const m = String(v || '').match(/^(\d+)\s*[x×*]\s*(\d+)$/i); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
const help = () => { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); };

try {
  if (!cmd || cmd === 'help') { help(); process.exit(0); }
  if (cmd === 'quit') { const st = await engineStatus(); if (!st) { console.log('스튜디오가 꺼져 있어요'); process.exit(0); } const r = await post('/api/quit', { force: !!flags.force }); console.log(r.quit ? '스튜디오 엔진을 껐어요' : `끄지 않았어요: ${r.reason}`); process.exit(0); }
  const st = await ensureEngine();
  if (cmd === 'status') {
    console.log(`ODDIN 스튜디오 ${st.version} · ${BASE}${st.started ? ' (방금 켬)' : ''}`);
    console.log(`ffmpeg ${st.tools.ffmpeg ? '있음' : '없음'} · 브라우저 ${st.tools.browser ? '있음' : '없음'} · 프로그램 창 ${st.windows}개${st.installed ? '' : ' (프로그램 미설치 — 창은 Edge 앱 창으로)'} · ODDIN ${st.hub.online ? '연결됨' : `안 됨(${st.hub.error || '꺼짐'})`}`);
  } else if (cmd === 'open' && rest[0]) {
    let f = abs(rest[0]);
    if (!f.toLowerCase().endsWith('.oddin-edit.json')) { const r = await post('/api/new', { video: f }); f = r.path; console.log(r.existed ? `이미 있는 편집: ${f}` : `새 편집: ${f}`); }
    const r = await post('/api/open', { path: f });
    console.log(r.windows ? `스튜디오 창 ${r.windows}개에서 열었어요` : r.launch?.launched ? `스튜디오 창을 띄웠어요(${r.launch.how === 'app' ? '프로그램' : 'Edge 앱 창'})` : `창을 띄우지 못했어요: ${r.launch?.reason || ''}`);
  } else if (cmd === 'new' && rest[0]) { const r = await post('/api/new', { video: abs(rest[0]), out: flags.out || null }); console.log(r.existed ? `이미 있는 편집: ${r.path}` : `새 편집: ${r.path}${r.srt ? ` (자막: ${r.srt})` : ''}`); }
  else if (cmd === 'blank' && rest[0]) { const [w, h] = size(flags.size || '1080x1920'); const r = await post('/api/blank', { dir: abs(rest[0]), title: flags.title || '새 편집', width: w, height: h, fps: Number(flags.fps) || 30 }); console.log(`빈 편집: ${r.path}`); }
  else if (cmd === 'add' && rest.length >= 2) {
    const r = await post('/api/add', { path: abs(rest[0]), files: rest.slice(1).map(abs), at: flags.at != null ? Number(flags.at) : null, track: flags.track || null, length: flags.len != null ? Number(flags.len) : null });
    for (const x of r.placed) console.log(`넣음: ${path.basename(x.file)} → 트랙 ${x.track} ${fmt(x.start)}~${fmt(x.end)} (클립 ${x.clip})`);
    for (const p of r.problems || []) console.log(`고침: ${p}`);
  } else if (cmd === 'check' && rest[0]) {
    const r = await call(`/api/check?path=${encodeURIComponent(abs(rest[0]))}`);
    console.log(`${r.title} · ${r.size} ${r.fps}fps · 길이 ${fmt(r.duration)} · 트랙 ${r.tracks.map((t) => `${t.name}(${t.kind} ${t.count})`).join(', ')}`);
    for (const p of r.problems) console.log(`고침: ${p}`);
    for (const g of r.gaps) console.log(`빈칸 ${g.frames}f @${fmt(g.at)} [${g.track}] "${g.text.slice(0, 20)}"`);
    for (const g of r.overlaps) console.log(`겹침 ${g.frames}f @${fmt(g.at)} [${g.track}] "${g.text.slice(0, 20)}"`);
    for (const g of r.twoLines) console.log(`두 줄 @${fmt(g.at)} [${g.track}] "${g.text.replace(/\n/g, ' / ').slice(0, 30)}"`);
    for (const f of r.missingFonts) console.log(`없는 글꼴: ${f} (fonts --missing 로 설치할 수 있는지 보기)`);
    for (const m of r.missingMedia) console.log(`없는 원본: ${m.id} ${m.path}`);
    if (!r.gaps.length && !r.overlaps.length && !r.twoLines.length && !r.missingFonts.length && !r.missingMedia.length) console.log('문제 없음');
  } else if (cmd === 'import-srt' && rest[0] && rest[1]) { const r = await post('/api/import-srt', { path: abs(rest[0]), srt: abs(rest[1]), name: rest[2] || null }); console.log(`자막 ${r.count}개를 트랙 ${r.track}에 넣었어요 (${r.path})`); }
  else if (cmd === 'srt' && rest[0]) { const r = await fetch(`${BASE}/api/srt?path=${encodeURIComponent(abs(rest[0]))}${rest[1] ? `&track=${encodeURIComponent(rest[1])}` : ''}`); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); process.stdout.write(await r.text()); }
  else if (cmd === 'from-premiere') {
    const r = await post('/api/premiere/import', { sequence: flags.seq || null, outDir: flags.out ? abs(flags.out) : null });
    console.log(`프리미어 "${r.sequence}" → ${r.path} (클립·자막 ${r.clips}개)`);
    for (const p of r.problems) console.log(`참고: ${p}`);
  } else if (cmd === 'scene' && rest[0]) {
    const [w, h] = size(flags.size);
    const r = await post('/api/scene', { path: abs(rest[0]), out: flags.out ? abs(flags.out) : null, width: w, height: h, fps: Number(flags.fps) || 30, duration: Number(flags.dur) || 0, wait: true });
    if (r.status !== 'done') throw new Error(r.error || '장면을 만들지 못했어요');
    console.log(`장면 영상: ${r.out} (${r.result.width}x${r.result.height} ${r.result.fps}fps ${r.result.duration}초${r.result.alpha ? ', 투명 배경' : ''})`);
  } else if (cmd === 'render' && rest[0]) {
    const r = await post('/api/render', { path: abs(rest[0]) });
    console.log(`렌더 시작: ${r.out}`);
    if (flags.wait) {
      let last = '';
      for (;;) { await new Promise((x) => setTimeout(x, 1000)); const s = (await call('/api/renders')).find((x) => x.id === r.id); const line = `${s.status} ${Math.round(s.progress * 100)}% ${s.stage || ''}`; if (line !== last) { console.log(line); last = line; } if (s.status !== 'running') { if (s.warnings?.length) console.log(`주의: ${s.warnings.join(' / ')}`); if (s.status !== 'done') { console.error(s.error || '실패'); process.exit(1); } break; } }
    }
  } else if (cmd === 'fonts') {
    if (rest[0] === 'install') { const r = await post('/api/fonts/install', flags.all ? { all: true } : { files: rest.slice(1).map(abs) }); for (const x of r.installed) console.log(`설치: ${x.name} ← ${x.file}`); for (const x of r.skipped) console.log(`건너뜀: ${x.file} — ${x.reason}`); if (!r.installed.length && !r.skipped.length) console.log('설치할 글꼴이 없어요'); }
    else if (flags.missing) { const l = await call('/api/fonts/installable'); if (!l.length) console.log('등록이 풀린 글꼴이 없어요'); for (const x of l) console.log(`${x.name} · ${x.families.join(', ')}${x.ko ? ` (${x.ko})` : ''}`); }
    else { const l = await call('/api/fonts'); console.log(`이 PC 글꼴 ${l.length}개`); for (const f of l) console.log(`${f.family}${f.ko ? ` (${f.ko})` : ''}`); }
  } else if (cmd === 'pipelines') { for (const p of await call('/api/pipelines')) console.log(`${p.id} · ${p.name} — ${p.description}`); }
  else { help(); process.exit(1); }
} catch (e) { console.error(`실패: ${e.message}`); process.exit(1); }
