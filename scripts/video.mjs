#!/usr/bin/env node
// ODDIN 영상 편집기 도우미(작업자 AI·사람이 명령줄에서). 실제 일은 이 PC의 ODDIN 허브(lib/video-edit.mjs)가 한다.
//   node scripts/video.mjs new <영상>                       영상으로 새 편집(같은 이름 SRT → 자막), 편집 파일 경로 출력
//   node scripts/video.mjs check <편집파일>                  형식 정리 결과·자막 빈칸/겹침/길이 점검
//   node scripts/video.mjs srt <편집파일> [트랙id]           자막을 SRT 로 출력
//   node scripts/video.mjs import-srt <편집파일> <SRT> [트랙이름]  SRT 를 자막 트랙으로(있으면 바꿈)
//   node scripts/video.mjs render <편집파일> [--wait]        MP4 렌더(편집 파일 옆). --wait 면 끝날 때까지 진행률 출력
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = 7700;
try { port = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_FILE || path.join(root, 'config.json'), 'utf8')).port || port; } catch {}
const HUB = (process.env.ODDIN_HUB || `http://127.0.0.1:${port}`).replace(/\/$/, '');
const [cmd, a, b, c] = process.argv.slice(2);
const wait = process.argv.includes('--wait');
async function call(p, opt = {}) {
  const r = await fetch(HUB + p, { ...opt, headers: { 'Content-Type': 'application/json' } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j?.error || `ODDIN 허브가 ${r.status}로 답했어요`);
  return j;
}
const abs = (p) => path.resolve(String(p || ''));
const fmt = (t) => { const s = Math.max(0, t); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`; };
try {
  if (cmd === 'new' && a) { const r = await call('/api/video/new', { method: 'POST', body: JSON.stringify({ video: abs(a) }) }); console.log(r.existed ? `이미 있는 편집: ${r.path}` : `새 편집: ${r.path}${r.srt ? ` (자막: ${r.srt})` : ''}`); }
  else if (cmd === 'check' && a) {
    const r = await call(`/api/video/edit?path=${encodeURIComponent(abs(a))}`), d = r.doc;
    console.log(`${d.title} · ${d.width}x${d.height} ${d.fps}fps · 트랙 ${d.tracks.length}개 · 원본 ${Object.keys(d.media).length}개`);
    for (const p of r.problems) console.log(`고침: ${p}`);
    const half = 0.5 / d.fps;
    for (const tr of d.tracks) {
      const list = tr.items || tr.clips; console.log(`- ${tr.kind} "${tr.name}" ${list.length}개`);
      if (tr.kind !== 'text') continue;
      for (let i = 1; i < list.length; i++) { const g = list[i].start - list[i - 1].end; if (g > half && g < 1) console.log(`  빈칸 ${Math.round(g * d.fps)}f @${fmt(list[i - 1].end)} "${list[i].text.slice(0, 20)}"`); else if (g < -half) console.log(`  겹침 ${Math.round(-g * d.fps)}f @${fmt(list[i].start)} "${list[i].text.slice(0, 20)}"`); }
      for (const it of list) if (it.text.includes('\n')) console.log(`  두 줄 @${fmt(it.start)} "${it.text.replace(/\n/g, ' / ').slice(0, 30)}"`);
    }
  } else if (cmd === 'srt' && a) { const r = await fetch(`${HUB}/api/video/srt?path=${encodeURIComponent(abs(a))}${b ? `&track=${encodeURIComponent(b)}` : ''}`); process.stdout.write(await r.text()); }
  else if (cmd === 'import-srt' && a && b) {
    const f = abs(a), r = await call(`/api/video/edit?path=${encodeURIComponent(f)}`), d = r.doc;
    const text = fs.readFileSync(abs(b), 'utf8').replace(/\r/g, '');
    const tc = (s) => { const m = String(s).trim().match(/(\d+):(\d+):(\d+)[,.](\d{1,3})/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + Number(m[4].padEnd(3, '0')) / 1000 : null; };
    const items = [];
    for (const block of text.split(/\n\s*\n/)) { const ls = block.split('\n').filter((l) => l.trim()); const i = ls.findIndex((l) => l.includes('-->')); if (i < 0) continue; const [s, e] = ls[i].split('-->').map(tc); if (s == null || e == null || e <= s) continue; items.push({ id: `x${items.length + 1}`, start: s, end: e, text: ls.slice(i + 1).join('\n'), x: 0, y: Math.round(d.height * 0.36) }); }
    let tr = d.tracks.find((t) => t.kind === 'text' && (!c || t.name === c));
    if (!tr) { tr = { id: `t${d.tracks.length + 1}`, kind: 'text', name: c || '자막', style: Object.keys(d.styles)[0] || null, items: [] }; d.tracks.push(tr); }
    tr.items = items;
    const s = await call('/api/video/edit', { method: 'PUT', body: JSON.stringify({ path: f, doc: d, baseMtime: r.mtime }) });
    console.log(`자막 ${items.length}개를 "${tr.name}" 트랙에 넣었어요 (${s.path})`);
  } else if (cmd === 'render' && a) {
    const r = await call('/api/video/render', { method: 'POST', body: JSON.stringify({ path: abs(a) }) });
    console.log(`렌더 시작: ${r.out}`);
    if (wait) {
      let last = '';
      for (;;) { await new Promise((x) => setTimeout(x, 1000)); const st = (await call('/api/video/renders')).find((x) => x.id === r.id); const line = `${st.status} ${Math.round(st.progress * 100)}% ${st.stage || ''}`; if (line !== last) { console.log(line); last = line; } if (st.status !== 'running') { if (st.warnings?.length) console.log(`주의: ${st.warnings.join(' / ')}`); if (st.status !== 'done') { console.error(st.error || '실패'); process.exit(1); } break; } }
    }
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error(`실패: ${e.message}`); process.exit(1); }
