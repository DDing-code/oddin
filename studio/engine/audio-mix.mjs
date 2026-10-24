// ODDIN 스튜디오 소리 섞기 — 타임라인 전체를 한 번에(2026-10-24 프로 기능)
// 예전에는 시간 조각마다 소리를 섞어 이어 붙였다. 압축기·잡음 제거처럼 앞뒤 소리를 보는 처리는 조각 경계에서 끊기므로 전체를 한 번에 섞는다.
//  클립: 속도(atempo — 음높이 그대로)·되감기(areverse)·소리 크기 키(dB)·페이드 → 제 시각에 놓기(adelay)
//  트랙(tracks[].audio): EQ·게이트·잡음 제거·치찰음·압축·크기·좌우·자동 줄이기(duck: 다른 트랙 소리가 날 때 — 구간 봉투 또는 sidechain)
//  전체(doc.audio): 음량 맞추기(loudness, LUFS — 두 번: 재고 맞추기)·리미터(limit)
// 클립이 아주 많으면(명령줄 길이) 트랙을 32개씩 미리 섞은 소리 파일로 만든 뒤 섞는다.
import fs from 'node:fs';
import path from 'node:path';
import { f6 } from './media.mjs';
import { core } from './core.mjs';
import { keyExpr, atempoChain } from './fx.mjs';

const lin = (db) => Math.pow(10, db / 20);
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

/** 소리를 낼 클립 목록(트랙별) */
export function audioClips(doc, warn = () => {}) {
  const C = core(), byTrack = new Map();
  for (const tr of doc.tracks) {
    if (tr.kind === 'text' || tr.muted) continue;
    for (const c of tr.clips) {
      const m = doc.media[c.media];
      if (!m || m.kind !== 'video' || m.audio === false || !m.file) continue;
      if (c.freeze > 0) continue;
      if (c.keys && Array.isArray(c.keys.speed) && c.keys.speed.length) { warn(`클립 ${c.label || c.id}: 속도 램프는 소리를 뺐어요(프리미어 시간 다시 매기기와 같음)`); continue; }
      if (C.clipLen(c) <= 0) continue;
      if (!byTrack.has(tr)) byTrack.set(tr, []);
      byTrack.get(tr).push({ c, m });
    }
  }
  return byTrack;
}
/** 클립 하나의 입력 인자와 사슬(입력 번호 i) — 출력은 타임라인 0초 기준 자리에 놓인 소리 */
function clipPart(e, i) {
  const C = core(), c = e.c, len = C.clipLen(c), span = c.out - c.in, sp = Number(c.speed) || 1, vk = c.keys && c.keys.volume;
  const args = ['-ss', f6(c.in), '-t', f6(span + 0.05), '-i', e.m.file];
  const fs2 = [AFMT, 'asetpts=PTS-STARTPTS', `atrim=duration=${f6(span)}`, c.reverse ? 'areverse' : '', sp !== 1 ? atempoChain(sp) : '', 'asetpts=PTS-STARTPTS',
    vk && vk.length ? `volume=volume='pow(10,(${keyExpr(c.volume, vk, 0)})/20)':eval=frame` : c.volume ? `volume=${f6(c.volume)}dB` : '',
    c.fadeIn > 0 ? `afade=t=in:st=0:d=${f6(Math.min(c.fadeIn, len))}` : '',
    c.fadeOut > 0 ? `afade=t=out:st=${f6(Math.max(0, len - c.fadeOut))}:d=${f6(Math.min(c.fadeOut, len))}` : '',
    `atrim=duration=${f6(len)}`, `adelay=delays=${Math.max(0, Math.round(c.start * 48000))}S:all=1`, 'asetpts=N/SR/TB'];
  // ↑ atempo 를 거친 소리는 adelay 가 넣는 앞 무음에 시각이 없어 뒤의 atrim 이 무음을 버리고 소리를 0초로 당겼다(ffmpeg 8.0.1, 2026-10-24 시험) — 샘플 수로 시각을 다시 매긴다
  return { args, chain: `[${i}:a]${fs2.filter(Boolean).join(',')}` };
}
const mixLine = (labels, out, D) => (labels.length > 1 ? `${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0:duration=longest,apad=whole_dur=${f6(D)},atrim=duration=${f6(D)}[${out}]` : `[${labels[0]}]apad=whole_dur=${f6(D)},atrim=duration=${f6(D)}[${out}]`);
/** 트랙 처리 필터(EQ·게이트·잡음·치찰음·압축·크기·좌우) */
export function trackFilters(a) {
  if (!a) return [];
  const out = [];
  for (const b of a.eq || []) {
    if (b.type === 'peak') out.push(`equalizer=f=${f6(b.f)}:t=q:w=${f6(b.q)}:g=${f6(b.g)}`);
    else if (b.type === 'lowshelf') out.push(`lowshelf=f=${f6(b.f)}:g=${f6(b.g)}`);
    else if (b.type === 'highshelf') out.push(`highshelf=f=${f6(b.f)}:g=${f6(b.g)}`);
    else if (b.type === 'lowcut') out.push(`highpass=f=${f6(b.f)}:poles=2`);
    else if (b.type === 'highcut') out.push(`lowpass=f=${f6(b.f)}:poles=2`);
  }
  if (a.gate) out.push(`agate=threshold=${f6(lin(a.gate.threshold))}:ratio=4:attack=5:release=150`);
  if (a.denoise) out.push(`afftdn=nr=${f6(6 + a.denoise * 24)}:nf=-45:tn=1`);
  if (a.deess) out.push(`deesser=i=${f6(a.deess)}`);
  if (a.comp) out.push(`acompressor=threshold=${f6(Math.max(0.000977, lin(a.comp.threshold)))}:ratio=${f6(a.comp.ratio)}:attack=${f6(a.comp.attack)}:release=${f6(a.comp.release)}:makeup=${f6(Math.min(64, Math.max(1, lin(a.comp.makeup))))}`);
  if (a.volume) out.push(`volume=${f6(a.volume)}dB`);
  if (a.pan) out.push(`pan=stereo|c0=${f6(Math.min(1, 1 - a.pan))}*c0|c1=${f6(Math.min(1, 1 + a.pan))}*c1`);
  return out;
}
/** 자동 줄이기 봉투의 식(t = 타임라인 시각) — video-core.js duckEnv 와 같은 정의(합친 구간은 겹치지 않아 합 = 최댓값) */
export function duckExpr(ranges, att, rel) {
  if (!ranges.length) return '0';
  return ranges.map(([s, e]) => `min(clip((t-${f6(s - att)})/${f6(att)},0,1),clip((${f6(e + rel)}-t)/${f6(rel)},0,1))`).join('+');
}

/**
 * 전체 소리를 wav 하나로. o = { doc, D, tmp, run(args), runOut(args) → stderr, warn }
 * 반환: wav 경로
 */
export async function mixAudio({ doc, D, tmp, run, runOut, warn = () => {} }) {
  const C = core(), byTrack = audioClips(doc, warn), mixWav = path.join(tmp, 'mix.wav');
  if (!byTrack.size) { await run(['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', f6(D), '-c:a', 'pcm_f32le', mixWav]); return mixWav; }
  // 1) 클립이 많은 트랙은 32개씩 미리 섞기
  const total = [...byTrack.values()].reduce((a, l) => a + l.length, 0), stems = new Map();
  if (total > 48) {
    let si = 0;
    for (const [tr, list] of byTrack) {
      if (list.length <= 16 && total - list.length <= 48) continue;
      const files = [];
      for (let k = 0; k < list.length; k += 32) {
        const part = list.slice(k, k + 32), args = ['-v', 'error', '-y'], lines = [], labels = [];
        part.forEach((e, i) => { const p = clipPart(e, i); args.push(...p.args); lines.push(`${p.chain}[p${i}]`); labels.push(`p${i}`); });
        lines.push(mixLine(labels, 'out', D));
        const script = path.join(tmp, `stem${si}.txt`), wav = path.join(tmp, `stem${si++}.wav`);
        fs.writeFileSync(script, lines.join(';\n'));
        await run([...args, '-/filter_complex', script, '-map', '[out]', '-c:a', 'pcm_f32le', wav]);
        files.push(wav);
      }
      stems.set(tr, files);
    }
  }
  // 2) 트랙마다 섞고 처리 → 자동 줄이기 → 전체
  const args = ['-v', 'error', '-y'], lines = [], lab = new Map();
  let ii = 0;
  for (const [tr, list] of byTrack) {
    const labels = [];
    if (stems.has(tr)) for (const wav of stems.get(tr)) { args.push('-i', wav); lines.push(`[${ii}:a]${AFMT}[i${ii}]`); labels.push(`i${ii}`); ii++; }
    else for (const e of list) { const p = clipPart(e, ii); args.push(...p.args); lines.push(`${p.chain}[i${ii}]`); labels.push(`i${ii}`); ii++; }
    const id = `t${lab.size}`;
    lines.push(mixLine(labels, `${id}m`, D));
    const tf = trackFilters(tr.audio);
    lines.push(`[${id}m]${tf.length ? tf.join(',') : 'anull'}[${id}]`);
    lab.set(tr, id);
  }
  // 자동 줄이기: 봉투(기본) — sidechain 은 다른 트랙 소리 크기로 압축
  for (const [tr, id] of [...lab]) {
    const d = tr.audio && tr.audio.duck; if (!d) continue;
    const triggers = [...lab.keys()].filter((t) => t !== tr && d.by.some((b) => b === t.id || b === t.name) && !(t.audio && t.audio.duck && t.audio.duck.mode === 'sidechain'));
    if (d.mode === 'sidechain' && triggers.length) {
      const sc = [];
      for (const t of triggers) { const src = lab.get(t), a = `${src}a`, b = `${src}b`; lines.push(`[${src}]asplit[${a}][${b}]`); lab.set(t, a); sc.push(b); }
      const scl = `${id}sc`; lines.push(sc.length > 1 ? `${sc.map((x) => `[${x}]`).join('')}amix=inputs=${sc.length}:normalize=0[${scl}]` : `[${sc[0]}]anull[${scl}]`);
      lines.push(`[${id}][${scl}]sidechaincompress=threshold=${f6(lin(-32))}:ratio=${f6(Math.min(20, Math.max(1.5, 1 + Math.abs(d.amount) / 3)))}:attack=${f6(d.attack * 1000)}:release=${f6(d.release * 1000)}:makeup=1[${id}d]`);
      lab.set(tr, `${id}d`);
    } else {
      const ranges = C.duckRanges(doc, tr);
      if (!ranges.length) continue;
      lines.push(`[${id}]volume=volume='pow(10,(${f6(d.amount)})*(${duckExpr(ranges, d.attack, d.release)})/20)':eval=frame[${id}d]`);
      lab.set(tr, `${id}d`);
    }
  }
  const outs = [...lab.values()], A = doc.audio || null, loud = A && A.loudness != null, limit = A ? A.limit !== false : false;
  lines.push(`${outs.map((l) => `[${l}]`).join('')}${outs.length > 1 ? `amix=inputs=${outs.length}:normalize=0:dropout_transition=0:duration=longest,` : ''}atrim=duration=${f6(D)}${limit && !loud ? ',alimiter=limit=0.891:level=0' : ''}[mix]`);
  const script = path.join(tmp, 'audio.txt'); fs.writeFileSync(script, lines.join(';\n'));
  await run([...args, '-/filter_complex', script, '-map', '[mix]', '-c:a', 'pcm_f32le', mixWav]);
  if (!loud) return mixWav;
  // 3) 음량 맞추기: 재고(1번) → 직선으로 맞추기(2번) + 리미터
  const err = await runOut(['-hide_banner', '-nostats', '-i', mixWav, '-af', `loudnorm=I=${f6(A.loudness)}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
  const m = String(err).match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  let j = null; try { j = m && JSON.parse(m[0]); } catch {}
  if (!j || !Number.isFinite(Number(j.input_i)) || Number(j.input_i) < -70) { warn('음량을 재지 못해(소리가 거의 없음) 음량 맞추기를 건너뛰었어요'); return mixWav; }
  const finalWav = path.join(tmp, 'mix-loud.wav');
  await run(['-v', 'error', '-y', '-i', mixWav, '-af', `loudnorm=I=${f6(A.loudness)}:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000${limit ? ',alimiter=limit=0.891:level=0' : ''}`, '-c:a', 'pcm_f32le', finalWav]);
  return finalWav;
}
