#!/usr/bin/env node
// ODDIN 스튜디오 명령줄(작업자 AI·사람). 엔진(studio/engine/server.mjs, 기본 http://127.0.0.1:7710)이 꺼져 있으면 켠다.
//   node studio/cli.mjs status                                  스튜디오 켜짐·버전·ffmpeg·브라우저·ODDIN 연결
//   node studio/cli.mjs open <편집파일|영상>                       스튜디오 창에서 열기(창이 없으면 띄움)
//   node studio/cli.mjs new <영상> [--out <이름>.oddin-edit.json]  영상으로 새 편집(같은 이름 .srt → 자막 트랙)
//   node studio/cli.mjs blank <폴더> [--title 이름] [--size 1080x1920] [--fps 30]  빈 편집
//   node studio/cli.mjs add <편집파일> <원본…> [--at 초] [--track id] [--len 초]  영상·소리·그림·HTML 장면을 트랙에 넣기
//   node studio/cli.mjs check <편집파일> [--strict]               형식 정리·자막 빈칸/겹침/두 줄·없는 글꼴·없는 원본 점검 + 고칠 수 있는 편집인가(--strict: 통째로 구운 편집이면 실패)
//   node studio/cli.mjs text <편집파일> --text 글 --at 초 [--dur 초|--end 초] [--track 이름|id] [--style 이름] [--x n] [--y n] [--in pop] [--out fade]  글자·자막 넣기
//   node studio/cli.mjs set <편집파일> <id> 키=값 …                클립·글자·트랙·원본 값 바꾸기(점 표기·JSON 값: anim.in=pop  keys.scale=[{"t":0,"v":1}]  vfadeIn=0.3)
//   node studio/cli.mjs style <편집파일> <이름> 키=값 …             글자 스타일 만들기·고치기(font= size= color= stroke={"color":"#000","width":6} bg={…})
//   node studio/cli.mjs marker <편집파일> <초> [이름]               마커
//   node studio/cli.mjs verify <영상> [--edit 편집파일] [--strict]   이 영상이 편집 파일의 최신 스튜디오 렌더인가(--strict: 아니거나 통째로 구운 편집이면 실패)
//   node studio/cli.mjs import-srt <편집파일> <SRT> [트랙이름]
//   node studio/cli.mjs srt <편집파일> [트랙id]                    자막 SRT 출력
//   node studio/cli.mjs from-premiere [--seq 이름|id] [--out 폴더]  열린 프리미어 시퀀스 → 편집 파일(ODDIN 어도비 플러그인 경유)
//   node studio/cli.mjs scene <장면.html> [--dur 초] [--size 1080x1920] [--fps 30] [--out x.mp4|x.mov]  HTML 장면 → 영상(.mov 는 투명)
//   node studio/cli.mjs render <편집파일> [--wait] [--out 이름.mp4] [--codec h264|h265|prores|prores4444|vp9|gif] [--quality draft|normal|high|master] [--bit-depth 10] [--alpha] [--gif-fps 15]
//                                                                 렌더(편집 파일 옆) — 영상 결과물은 이것으로 뽑는다. 출력 형식은 편집 파일 output 이 기본
//   node studio/cli.mjs fx <편집파일> <id> <효과> [키=값 …] [--index n] | fx <편집파일> <id> --remove n
//                                                                 효과: color lut curves blur glow shadow sharpen grain vignette pixelate chroma invert mirror tint rgbsplit lens wave wiggle (keys={"radius":[…]})
//   node studio/cli.mjs trans <편집파일> <id> in|out <전환> [--dur 0.5] [--dir left|right|up|down] [--ease ease]  전환: fade slide wipe iris zoom blur whip spin flip (none = 빼기)
//   node studio/cli.mjs shape <편집파일> <도형> --at 초 [--dur 초|--end 초] [--track 이름] [--x n] [--y n] [키=값 …]  도형: rect ellipse line arrow polygon star path (w= h= fill= stroke={…} radius= points=[[x,y]…] d="M…")
//   node studio/cli.mjs adjust <편집파일> --at 초 [--dur 초|--end 초] <효과 JSON 배열 | 효과이름…>   조정 레이어(아래 그림 전체에 효과)
//   node studio/cli.mjs follow <편집파일> --clip id --rect x,y,w,h [--from 초] [--to 초] [--apply mask|stabilize|item:<id>|clip:<id>] [--out 점.json]
//                                                                 따라가기(모션 트래킹): 원본 픽셀 사각형을 프레임마다 찾아 키로
//   node studio/cli.mjs fonts [--missing] | fonts install <글꼴파일…|--all>
//   node studio/cli.mjs speakers <촬영본> [--words 전사.json] [--keep 구간.json|편집파일] [--out 결과.json] [--all] [--no-video] [--on a|b]  누가 말했나: 화면 속 출연자 / 화면 밖(PD) 목소리 가르기, 남긴 구간에 화면 밖 목소리가 들어갔는지 점검
//   node studio/cli.mjs paper <촬영본> --script 대본.txt --words 전사.json [--on a|b] [--out 표.md]  종이 편집표: 대본 줄마다 출연자 테이크·PD 목소리(선창/지시/내용) 맞추기
//   node studio/cli.mjs pipelines                                 파이프라인(합친 스킬의 제작 흐름) 목록
//   node studio/cli.mjs quit                                      엔진 끄기(렌더 중이면 거절)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEngine, engineUrl, engineStatus } from './engine/launch.mjs';
import { loadConfig } from './engine/env.mjs';

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
const help = () => { const ls = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); console.log(ls.slice(0, ls.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); };
// 키=값 → { 키: 값 } (값이 JSON 이면 JSON 으로: 숫자·true·[…]·{…})
const kv = (list) => Object.fromEntries(list.map((a) => { const i = a.indexOf('='); if (i < 1) throw new Error(`"키=값" 꼴이어야 해요: ${a}`); const k = a.slice(0, i), v = a.slice(i + 1); let val = v; try { val = JSON.parse(v); } catch {} return [k, val]; }));
const patch = (file, ops) => post('/api/patch', { path: abs(file), ops });

try {
  if (!cmd || cmd === 'help') { help(); process.exit(0); }
  if (cmd === 'quit') { const st = await engineStatus(); if (!st) { console.log('스튜디오가 꺼져 있어요'); process.exit(0); } const r = await post('/api/quit', { force: !!flags.force }); console.log(r.quit ? '스튜디오 엔진을 껐어요' : `끄지 않았어요: ${r.reason}`); process.exit(0); }
  if (cmd === 'speakers' && rest[0]) { // 엔진 없이 이 자리에서 잰다(긴 4K 원본은 몇 분 걸림)
    const { analyzeSpeakers, speakersReport, readWords, readKeep } = await import('./engine/speakers.mjs');
    const file = abs(rest[0]);
    const r = await analyzeSpeakers(file, { words: flags.words ? readWords(abs(flags.words)) : null, keep: flags.keep ? readKeep(abs(flags.keep), file) : null, video: !flags['no-video'], on: flags.on === 'a' || flags.on === 'b' ? flags.on : null, config: loadConfig() });
    if (flags.out) { fs.writeFileSync(abs(flags.out), JSON.stringify(r, null, 1)); console.log(`결과 파일: ${abs(flags.out)}`); }
    console.log(speakersReport(r, { all: !!flags.all }));
    process.exit(r.leaks?.some((l) => l.who === 'off') ? 2 : 0);
  }
  if (cmd === 'paper' && rest[0]) { // 컷을 자르기 전에: 대본과 촬영본을 줄 단위로 맞춘 표
    if (!flags.script || !flags.words) throw new Error('--script <대본.txt> 와 --words <단어 시각이 있는 전사.json> 이 필요해요');
    const { analyzeSpeakers, readWords } = await import('./engine/speakers.mjs');
    const { paperEdit, paperReport, paperKeep, readScriptFile } = await import('./engine/paper.mjs');
    const file = abs(rest[0]);
    const sp = await analyzeSpeakers(file, { words: readWords(abs(flags.words)), video: !flags['no-video'], on: flags.on === 'a' || flags.on === 'b' ? flags.on : null, config: loadConfig() });
    const p = paperEdit(sp, readScriptFile(abs(flags.script))), md = paperReport(p);
    if (flags.out) { const o = abs(flags.out), base = o.replace(/\.md$/i, ''); fs.writeFileSync(o, md); fs.writeFileSync(`${base}.json`, JSON.stringify({ paper: p, speakers: sp }, null, 1)); fs.writeFileSync(`${base}.keep.json`, JSON.stringify(paperKeep(p, file), null, 1)); console.log(`표: ${o} · 자료: ${base}.json · 고른 구간: ${base}.keep.json`); }
    console.log(md);
    process.exit(0);
  }
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
    for (const n of r.editability?.notes || []) console.log(`고치기 어려움: ${n}`);
    if (!r.gaps.length && !r.overlaps.length && !r.twoLines.length && !r.missingFonts.length && !r.missingMedia.length && !r.editability?.notes?.length) console.log('문제 없음');
    if (flags.strict && r.editability?.flattened) { console.error('실패: 통째로 구운 편집이에요 — 그림은 장면별 재료로, 글자·자막·효과음은 편집 파일 안에 따로 두세요'); process.exit(2); }
  } else if (cmd === 'text' && rest[0]) {
    if (flags.text == null || flags.at == null) throw new Error('--text 글 과 --at 초 가 필요해요');
    const r = await patch(rest[0], [{ op: 'text', text: String(flags.text).replace(/\\n/g, '\n'), start: Number(flags.at), ...(flags.end != null ? { end: Number(flags.end) } : { dur: Number(flags.dur) || 2 }), track: flags.track || null, style: flags.style || null, ...(flags.x != null ? { x: Number(flags.x) } : {}), ...(flags.y != null ? { y: Number(flags.y) } : {}), in: flags.in || 'none', out: flags.out || 'none' }]);
    console.log(`글자 넣음: ${r.results[0].id} (트랙 ${r.results[0].track})`);
  } else if (cmd === 'set' && rest[0] && rest[1] && rest[2]) {
    const r = await patch(rest[0], [{ op: 'set', id: rest[1], props: kv(rest.slice(2)) }]); console.log(`바꿈: ${rest[1]} (${r.results[0].kind})`); for (const p of r.problems || []) console.log(`고침: ${p}`);
  } else if (cmd === 'style' && rest[0] && rest[1]) {
    await patch(rest[0], [{ op: 'style', name: rest[1], props: kv(rest.slice(2)) }]); console.log(`스타일 "${rest[1]}" 저장`);
  } else if (cmd === 'marker' && rest[0] && rest[1] != null) {
    const r = await patch(rest[0], [{ op: 'marker', t: Number(rest[1]), label: rest.slice(2).join(' ') }]); console.log(`마커 ${r.results[0].id} @${fmt(rest[1])}`);
  } else if (cmd === 'verify' && rest[0]) {
    const r = await call(`/api/verify?path=${encodeURIComponent(abs(rest[0]))}${flags.edit ? `&edit=${encodeURIComponent(abs(flags.edit))}` : ''}`);
    if (!r.studio) console.log('스튜디오에서 뽑은 영상이 아니에요(편집 파일에서 render 로 뽑으세요)');
    else if (!r.sameEdit) console.log(`다른 편집 파일에서 뽑은 영상이에요: ${r.edit}`);
    else console.log(r.current ? `편집 파일의 최신 렌더예요: ${r.edit} (${r.renderedAt}, ${r.encoder || ''})` : `편집 파일이 렌더 뒤에 바뀌었어요 — 다시 render 하세요: ${r.edit}`);
    for (const n of r.editability?.notes || []) console.log(`고치기 어려움: ${n}`);
    if (flags.strict && (!r.current || r.editability?.flattened)) process.exit(2);
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
  } else if (cmd === 'fx' && rest[0] && rest[1] && (rest[2] || flags.remove != null)) {
    const r = await patch(rest[0], [flags.remove != null ? { op: 'fx', id: rest[1], remove: Number(flags.remove) } : { op: 'fx', id: rest[1], type: rest[2], props: kv(rest.slice(3)), ...(flags.index != null ? { index: Number(flags.index) } : {}) }]);
    console.log(`효과 ${flags.remove != null ? '뺌' : rest[2]}: ${rest[1]} (효과 ${r.results[0].count}개)`); for (const p of r.problems || []) console.log(`고침: ${p}`);
  } else if (cmd === 'trans' && rest[0] && rest[1] && /^(in|out)$/.test(rest[2] || '') && rest[3]) {
    const key = rest[2] === 'in' ? 'transIn' : 'transOut';
    await patch(rest[0], [{ op: 'set', id: rest[1], props: { [key]: rest[3] === 'none' ? null : { type: rest[3], ...(flags.dur != null ? { dur: Number(flags.dur) } : {}), ...(flags.dir ? { dir: flags.dir } : {}), ...(flags.ease ? { ease: flags.ease } : {}), ...(flags.amount != null ? { amount: Number(flags.amount) } : {}) } } }]);
    console.log(`전환 ${rest[2] === 'in' ? '들어오기' : '나가기'}: ${rest[3]} (${rest[1]})`);
  } else if (cmd === 'shape' && rest[0] && rest[1]) {
    if (flags.at == null) throw new Error('--at 초 가 필요해요');
    const r = await patch(rest[0], [{ op: 'shape', type: rest[1], start: Number(flags.at), ...(flags.end != null ? { end: Number(flags.end) } : { dur: Number(flags.dur) || 2 }), track: flags.track || null, x: Number(flags.x) || 0, y: Number(flags.y) || 0, props: kv(rest.slice(2)) }]);
    console.log(`도형 넣음: ${r.results[0].id} (트랙 ${r.results[0].track})`);
  } else if (cmd === 'adjust' && rest[0]) {
    if (flags.at == null) throw new Error('--at 초 가 필요해요');
    let effects = [];
    if (rest[1] && rest[1].trim().startsWith('[')) effects = JSON.parse(rest[1]); else effects = rest.slice(1).map((t) => ({ type: t }));
    const r = await patch(rest[0], [{ op: 'adjust', start: Number(flags.at), ...(flags.end != null ? { end: Number(flags.end) } : { dur: Number(flags.dur) || 2 }), effects, track: flags.track || null }]);
    console.log(`조정 레이어: ${r.results[0].id} (트랙 ${r.results[0].track})`);
  } else if (cmd === 'follow' && rest[0]) {
    if (!flags.clip || !flags.rect) throw new Error('--clip id 와 --rect x,y,w,h(원본 픽셀) 가 필요해요');
    const r = await post('/api/follow', { path: abs(rest[0]), clip: flags.clip, rect: String(flags.rect).split(',').map(Number), from: flags.from != null ? Number(flags.from) : null, to: flags.to != null ? Number(flags.to) : null, apply: flags.apply || null, every: Number(flags.every) || 2 });
    if (flags.out) { fs.writeFileSync(abs(flags.out), JSON.stringify(r, null, 1)); console.log(`점: ${abs(flags.out)}`); }
    console.log(`따라감: ${r.frames}프레임 ${fmt(r.from)}~${fmt(r.to)}${r.lost ? ` · 놓친 프레임 ${r.lost}개(가려졌거나 모양이 바뀜 — 구간을 나눠 다시)` : ''}${r.applied ? ` · ${r.applied} 에 키로 넣음` : ' · 점만(--apply 로 넣기)'}`);
  } else if (cmd === 'render' && rest[0]) {
    const output = {}; if (flags.codec) output.codec = flags.codec; if (flags.quality) output.quality = flags.quality; if (flags['bit-depth']) output.bitDepth = Number(flags['bit-depth']); if (flags.alpha) output.alpha = true; if (flags['gif-fps']) output.fps = Number(flags['gif-fps']);
    const r = await post('/api/render', { path: abs(rest[0]), out: flags.out || null, ...(Object.keys(output).length ? { output } : {}) });
    console.log(`렌더 시작: ${r.out}${r.output ? ` (${r.output.codec}${r.output.bitDepth === 10 ? ' 10비트' : ''}${r.output.alpha ? ' 투명' : ''} · ${r.output.quality})` : ''}`);
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
