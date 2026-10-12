// 누가 말했나 — 두 채널이 서로 다른 마이크인 촬영본(출연자 옷깃 마이크 / PD 마이크).
// 2026-10-12 실제 사고: 에너지가 큰 채널 하나만 골랐더니 PD 마이크 쪽을 골라 판정이 뒤집혔다(입 닫은 장면이 '화면 속').
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tools } from '../studio/engine/media.mjs';
import { dualMics, diffSplit, analyzeSpeakers, speakersReport } from '../studio/engine/speakers.mjs';

const FF = tools({});

test('두 마이크 감지: 말하는 동안 좌우 차이가 사람마다 크게 다르면 서로 다른 마이크, 같은 소리를 양쪽에 넣은 것은 아님', () => {
  const n = 4000, L = new Float32Array(n).fill(-70), R = new Float32Array(n).fill(-70);
  for (let k = 0; k < 10; k++) { L.fill(-28, k * 400, k * 400 + 100); R.fill(-40, k * 400, k * 400 + 100); L.fill(-45, k * 400 + 150, k * 400 + 250); R.fill(-25, k * 400 + 150, k * 400 + 250); }
  const d = dualMics(L, R);
  assert.equal(d.dual, true); assert.ok(d.spread > 20);
  assert.equal(dualMics(L, L.map((v) => v - 3)).dual, false, '한 소리를 양쪽에(크기만 다름)');
  const isl = (diff, k) => ({ start: k * 2, end: k * 2 + 1.2, level: -30, diff });
  const s = diffSplit([...Array(8)].map((_, k) => isl(11 + (k % 2), k)).concat([...Array(8)].map((_, k) => isl(-19 - (k % 3), k + 8))));
  assert.equal(s.ok, true); assert.ok(s.threshold > -15 && s.threshold < 8); assert.ok(s.gap > 25);
  assert.equal(diffSplit([...Array(10)].map((_, k) => isl(2 + (k % 3), k))).ok, false, '좌우 차이가 한 무리');
});

function stereoClip(dir, name, cycles = 8) {
  const sr = 16000, fps = 15, W = 64, H = 64, total = cycles * 4, n = total * sr;
  const pcm = Buffer.alloc(n * 4);
  const add = (t0, t1, aL, aR, hz) => { for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i++) { const t = i / sr, v = Math.sin(2 * Math.PI * hz * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 6 * t)); pcm.writeInt16LE(Math.round(32767 * aL * v), i * 4); pcm.writeInt16LE(Math.round(32767 * aR * v), i * 4 + 2); } };
  for (let i = 0; i < n; i++) { pcm.writeInt16LE(Math.round(18 * Math.sin(i * 0.37)), i * 4); pcm.writeInt16LE(Math.round(18 * Math.sin(i * 0.41)), i * 4 + 2); }
  const lead = [], talk = [], far = [];
  for (let c = 0; c < cycles; c++) {
    lead.push([c * 4 + 0.2, c * 4 + 1.3]); talk.push([c * 4 + 1.7, c * 4 + 2.5]); far.push([c * 4 + 3.0, c * 4 + 3.5]);
    add(...lead[c], 0.02, 0.32, 180);   // PD: 오른쪽 마이크에 크게(더 길고 더 큼 — 전체 에너지는 오른쪽이 큼), 왼쪽에 새어 듦
    add(...talk[c], 0.2, 0.02, 240);    // 출연자: 왼쪽 옷깃 마이크
    add(...far[c], 0.012, 0.012, 300);  // 멀리서 난 소리: 양쪽에 비슷하게
  }
  const wav = path.join(dir, `${name}.wav`), head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wav, Buffer.concat([head, pcm]));
  const frames = Buffer.alloc(total * fps * W * H);
  for (let f = 0; f < total * fps; f++) {
    const t = f / fps, o = f * W * H, talking = talk.some(([a, b]) => t >= a && t < b);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frames[o + y * W + x] = 60 + x;
    const open = talking && f % 2 === 0;
    for (let y = 38; y < 44; y++) for (let x = 27; x < 37; x++) frames[o + y * W + x] = open ? 230 : 40;
  }
  const raw = path.join(dir, `${name}.raw`), out = path.join(dir, `${name}.mkv`);
  fs.writeFileSync(raw, frames);
  const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', raw, '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return { out, wav, lead, talk, far };
}
const inside = (islands, [a, b]) => islands.filter((i) => i.end > a + 0.1 && i.start < b - 0.1);

test('두 마이크 촬영본: PD 마이크 쪽 에너지가 더 커도 출연자(화면이 움직이는 쪽)가 화면 속, 먼 소리는 화면 밖', { skip: !FF.ffmpeg && 'ffmpeg 없음', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-spk2-'));
  try {
    const clip = stereoClip(dir, 'two');
    const r = await analyzeSpeakers(clip.out, { keep: [{ start: clip.lead[1][0], end: clip.lead[1][1], text: 'PD' }, { start: clip.talk[1][0], end: clip.talk[1][1], text: '출연자' }] });
    assert.equal(r.mics.dual, true);
    assert.equal(r.basis, 'channels+motion'); assert.equal(r.onGroup, 'a');
    for (const t of clip.talk) { const hit = inside(r.islands, t); assert.ok(hit.length && hit.every((i) => i.who === 'on' && i.group === 'a'), `출연자 ${t}: ${JSON.stringify(hit)}`); }
    for (const t of clip.lead) { const hit = inside(r.islands, t); assert.ok(hit.length && hit.every((i) => i.who === 'off' && i.group === 'b'), `PD ${t}: ${JSON.stringify(hit)}`); }
    for (const t of clip.far) assert.ok(inside(r.islands, t).every((i) => i.who !== 'on' && i.group === 'c'), `먼 소리 ${t}`);
    assert.deepEqual(r.leaks.map((l) => [l.keep, l.who]), [[0, 'off']]);
    assert.match(speakersReport(r), /두 채널이 서로 다른 마이크예요/);
    // 소리만: 두 사람은 갈랐지만 누가 화면 속인지 모른다 — 전부 '확인 필요', 직접 정하면(--on) 갈린다
    const a = await analyzeSpeakers(clip.wav);
    assert.equal(a.basis, 'channels'); assert.equal(a.onGroup, null);
    assert.ok(a.islands.every((i) => i.who === 'unsure'));
    assert.match(speakersReport(a), /--on a 또는 --on b/);
    const f = await analyzeSpeakers(clip.wav, { on: 'a' });
    assert.equal(f.forced, true); assert.equal(inside(f.islands, clip.talk[0])[0].who, 'on'); assert.equal(inside(f.islands, clip.lead[0])[0].who, 'off');
    const g = await analyzeSpeakers(clip.wav, { on: 'b' });
    assert.equal(inside(g.islands, clip.lead[0])[0].who, 'on', '반대로 정하면 반대로');
    // 받아쓴 글이 있으면: 먼저 읽은 쪽(PD) → 따라 한 쪽(출연자) 순서로 정한다
    const words = [];
    const line = (k) => `가${k} 나${k} 다${k}`; // 문장마다 낱말이 다르다(같은 문장은 PD 와 출연자 한 쌍뿐)
    clip.lead.forEach(([s, e], k) => words.push({ text: line(k), start: s + 0.1, end: e - 0.1 }));
    clip.talk.forEach(([s, e], k) => words.push({ text: line(k), start: s + 0.1, end: e - 0.1 }));
    const w = await analyzeSpeakers(clip.wav, { words });
    assert.equal(w.basis, 'channels+lead'); assert.equal(w.onGroup, 'a');
    assert.equal(inside(w.islands, clip.talk[2])[0].who, 'on');
    assert.ok(w.pairs.length >= 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
