// 누가 말했나(2026-10-12, studio/engine/speakers.mjs): 촬영본에서 화면 속 출연자와 화면 밖(PD) 목소리를 소리 크기 + 화면 움직임으로 가른다.
// 실제 사고 — 작업자가 받아쓴 글자만 보고 골라 PD 가 먼저 읽어 준 문장이 16편에 그대로 들어갔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tools } from '../studio/engine/media.mjs';
import { findIslands, levelSplit, checkKeep, sameLine, readKeep, readWords, analyzeSpeakers, speakersReport } from '../studio/engine/speakers.mjs';

const FF = tools({});

test('말 덩어리: 붙어 있어도 크기가 확 다르면 다른 덩어리(선창 바로 뒤 따라 하기)', () => {
  const db = new Float32Array(600).fill(-70);
  db.fill(-45, 50, 130);   // PD 가 읽어 줌
  db.fill(-28, 140, 240);  // 0.1초 뒤 출연자가 따라 함
  db.fill(-29, 400, 470);  // 출연자 다음 문장
  db.fill(-30, 480, 520);  // 0.1초 쉬고 이어 말함 — 같은 덩어리
  const { islands, threshold } = findIslands(db);
  assert.ok(threshold > -70 && threshold < -45);
  assert.equal(islands.length, 3);
  assert.ok(Math.abs(islands[0].level + 45) < 1 && Math.abs(islands[1].level + 28) < 1);
  assert.ok(islands[1].start > islands[0].end, '두 덩어리가 겹치지 않는다');
  assert.ok(islands[2].end - islands[2].start > 1.1, '짧게 쉰 말은 한 덩어리');
});

test('크기 무리: 출연자·코치·PD 셋이어도 가장 큰 목소리 바로 아래를 가른다', () => {
  const mk = (level, n, len) => Array.from({ length: n }, (_, k) => ({ start: k * 3, end: k * 3 + len, level: level + (k % 3) - 1 }));
  const three = [...mk(-29, 20, 1.5), ...mk(-38, 14, 1.4), ...mk(-47, 14, 1.4)];
  const s = levelSplit(three);
  assert.equal(s.ok, true);
  assert.ok(s.threshold > -37 && s.threshold < -31, `문턱 ${s.threshold}`);
  const one = levelSplit(mk(-30, 20, 1.5));
  assert.equal(one.ok, false, '한 무리면 가르지 않는다');
  assert.equal(levelSplit(mk(-30, 2, 1)).ok, false);
});

test('남긴 구간 점검·같은 문장·구간 읽기', () => {
  const islands = [{ start: 1, end: 2.5, who: 'off', level: -42, text: 'so i will eat eggs' }, { start: 3, end: 4.5, who: 'on', level: -29, text: 'So, I will eat eggs.' }, { start: 6, end: 6.3, who: 'unsure', level: -35 }];
  const leaks = checkKeep(islands, [{ start: 0.9, end: 2.6, text: '1번' }, { start: 2.9, end: 4.6 }, { start: 5.9, end: 6.2 }]);
  assert.deepEqual(leaks.map((l) => [l.keep, l.who]), [[0, 'off'], [2, 'unsure']]);
  assert.equal(checkKeep(islands, [{ start: 2.45, end: 4.6 }]).length, 0, '끝자락 0.05초 겹침은 넘어간다');
  assert.ok(sameLine('So, I will eat eggs.', 'so i will eat eggs') > 0.9);
  assert.ok(sameLine('My body wants electrolytes', 'So I will eat olives') < 0.4);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-spk-'));
  try {
    const edit = path.join(dir, 'a.oddin-edit.json');
    fs.writeFileSync(edit, JSON.stringify({ media: { m1: { path: 'raw/IMG_1.MOV' }, m2: { path: 'bgm.mp3' } }, tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c1', media: 'm1', start: 0, in: 12.3, out: 20 }, { id: 'c2', media: 'm1', start: 8, in: 30, out: 33, volume: -60 }] }, { id: 'a1', kind: 'audio', clips: [{ id: 'c9', media: 'm2', start: 0, in: 0, out: 30 }] }] }));
    assert.deepEqual(readKeep(edit, 'D:/x/IMG_1.MOV').map((r) => [r.start, r.end]), [[12.3, 20]]);
    const ranges = path.join(dir, 'r.json');
    fs.writeFileSync(ranges, JSON.stringify([{ source: 'a\\IMG_1.MOV', start: 1, end: 2, text: 'x' }, { source: 'other.mov', start: 5, end: 6 }]));
    assert.deepEqual(readKeep(ranges, 'IMG_1.MOV').map((r) => r.start), [1]);
    const words = path.join(dir, 'w.json');
    fs.writeFileSync(words, JSON.stringify({ segments: [{ start: 0, end: 1, text: 'a b', words: [{ word: ' a', start: 0, end: 0.4 }, { word: ' b', start: 0.5, end: 1 }] }, { start: 2, end: 3, text: 'c' }] }));
    assert.deepEqual(readWords(words).map((w) => w.text), ['a', 'b', 'c']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** 시험 영상: 4초마다 [작은/큰] 목소리가 번갈아 나오고, moveOn 목소리가 말할 때만 화면 속 '입'이 움직인다 */
function makeClip(dir, name, { leadAmp, talkAmp, cycles = 8 }) {
  const sr = 16000, fps = 15, W = 64, H = 64, total = cycles * 4;
  const pcm = Buffer.alloc(total * sr * 2);
  const burst = (t0, t1, amp) => { for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i++) { const t = i / sr; pcm.writeInt16LE(Math.round(32767 * amp * Math.sin(2 * Math.PI * 220 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 6 * t))), i * 2); } };
  for (let i = 0; i < total * sr; i++) pcm.writeInt16LE(Math.round(20 * Math.sin(i * 0.37)), i * 2); // 아주 작은 바닥 소리
  const lead = [], talk = [];
  for (let c = 0; c < cycles; c++) { lead.push([c * 4 + 0.3, c * 4 + 1.1]); talk.push([c * 4 + 1.5, c * 4 + 2.5]); burst(...lead[c], leadAmp); burst(...talk[c], talkAmp); }
  const wav = path.join(dir, `${name}.wav`), head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wav, Buffer.concat([head, pcm]));
  const frames = Buffer.alloc(total * fps * W * H);
  for (let f = 0; f < total * fps; f++) {
    const t = f / fps, o = f * W * H, talking = talk.some(([a, b]) => t >= a && t < b);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frames[o + y * W + x] = 60 + x; // 가만히 있는 배경
    const open = talking && f % 2 === 0;
    for (let y = 38; y < 44; y++) for (let x = 27; x < 37; x++) frames[o + y * W + x] = open ? 230 : 40; // 입
  }
  const raw = path.join(dir, `${name}.raw`), out = path.join(dir, `${name}.mkv`);
  fs.writeFileSync(raw, frames);
  const r = spawnSync(FF.ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', raw, '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return { out, wav, lead, talk };
}
const inside = (islands, [a, b]) => islands.filter((i) => i.end > a + 0.1 && i.start < b - 0.1);

test('촬영본: 큰 목소리가 화면 속(옷깃 마이크) — PD 선창은 화면 밖, 남긴 구간에 들어가면 알려 준다', { skip: !FF.ffmpeg && 'ffmpeg 없음', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-spk-'));
  try {
    const clip = makeClip(dir, 'lav', { leadAmp: 0.03, talkAmp: 0.25 });
    const keep = [{ start: clip.lead[2][0], end: clip.lead[2][1], text: 'PD 가 읽어 준 것' }, { start: clip.talk[2][0], end: clip.talk[2][1], text: '출연자' }];
    const r = await analyzeSpeakers(clip.out, { keep });
    assert.equal(r.basis, 'level+motion');
    assert.ok(r.levels.gap >= 10);
    for (const t of clip.talk) { const hit = inside(r.islands, t); assert.ok(hit.length >= 1 && hit.every((i) => i.who === 'on'), `출연자 ${t}: ${JSON.stringify(hit)}`); }
    for (const t of clip.lead) { const hit = inside(r.islands, t); assert.ok(hit.length >= 1 && hit.every((i) => i.who === 'off'), `PD ${t}: ${JSON.stringify(hit)}`); }
    assert.deepEqual(r.leaks.map((l) => [l.keep, l.who]), [[0, 'off']]);
    assert.match(speakersReport(r), /화면 밖 목소리가 1곳/);
    // 소리만 있는 파일: 크기만으로 가르고 근거가 약하다고 적는다
    const a = await analyzeSpeakers(clip.wav);
    assert.equal(a.basis, 'level');
    assert.equal(inside(a.islands, clip.talk[0])[0].who, 'on');
    assert.match(speakersReport(a), /소리 크기만/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('촬영본: 카메라 옆 PD 가 더 크게 녹음돼도 화면이 움직이는 쪽(작은 목소리)이 화면 속', { skip: !FF.ffmpeg && 'ffmpeg 없음', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-spk-'));
  try {
    const clip = makeClip(dir, 'phone', { leadAmp: 0.25, talkAmp: 0.03 });
    const r = await analyzeSpeakers(clip.out);
    assert.equal(r.basis, 'motion');
    for (const t of clip.talk) assert.ok(inside(r.islands, t).every((i) => i.who === 'on'), `출연자 ${t}`);
    for (const t of clip.lead) assert.ok(inside(r.islands, t).every((i) => i.who === 'off'), `PD ${t}`);
    assert.match(speakersReport(r), /화면 움직임 기준/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
