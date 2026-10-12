// 종이 편집표(2026-10-12, studio/engine/paper.mjs): 대본과 촬영본을 줄 단위로 맞추고 화면 밖 목소리를 선창·지시·내용으로 나눈다.
// 사용자 "숏폼이어도 PD 목소리가 들어갈 때가 있고, 리드만 할 때가 있는데 실제 편집 PD처럼 하는 과정이 필요"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readScript, utterances, matchLine, paperEdit, paperReport, paperKeep } from '../studio/engine/paper.mjs';
import { checkKeep, readKeep } from '../studio/engine/speakers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('대본 읽기: 줄 앞의 화자 표시(PD·Q = 화면 밖, 출연자·A = 화면 속, 자막·내레이션 = 촬영 대사 아님)', () => {
  const s = readScript('# 3번 기획안\n1. When I am craving sugar\n- PD: My acne is really bad.\nA: Use salicylic acid.\n자막: 저장해 두세요\n\n출연자) 마지막 줄입니다');
  assert.deepEqual(s.map((l) => [l.n, l.who, l.text]), [[1, null, 'When I am craving sugar'], [2, 'off', 'My acne is really bad.'], [3, 'on', 'Use salicylic acid.'], [4, 'none', '저장해 두세요'], [5, 'on', '마지막 줄입니다']]);
});

test('발화 묶기·대본 줄 찾기', () => {
  const u = utterances([{ start: 1, end: 1.6, who: 'on', group: 'a', level: -30, text: 'So I will' }, { start: 1.8, end: 2.6, who: 'on', group: 'a', level: -28, text: 'eat eggs' }, { start: 2.7, end: 3.4, who: 'off', group: 'b', level: -40, text: 'good next' }, { start: 6, end: 6.1, who: 'on', group: 'a', level: -30, text: 'uh' }]);
  assert.deepEqual(u.map((x) => [x.start, x.end, x.who, x.text]), [[1, 2.6, 'on', 'So I will eat eggs'], [2.7, 3.4, 'off', 'good next']]);
  const script = readScript('When I am craving sugar\nSo I will eat eggs\n자막: So I will eat eggs');
  assert.deepEqual(matchLine('so, I will eat eggs', script), { line: 2, score: 1.5, cover: 1 });
  assert.equal(matchLine('I will eat', script).line, 2); assert.ok(matchLine('I will eat', script).cover < 0.8);
  assert.equal(matchLine('좋습니다 다음', script), null);
});

const isl = (start, end, who, text, group = who === 'on' ? 'a' : 'b') => ({ start, end, who, group, level: who === 'on' ? -29 : -41, text });
test('선창은 빼고 출연자 테이크를 고른다 · 지시는 뺀다 · 온전한 마지막 테이크', () => {
  const script = readScript('When I am craving sugar\nMy body is asking for protein\nSo I will eat eggs');
  const sp = { file: 'IMG.MOV', basis: 'level+motion', islands: [
    isl(1, 3, 'off', 'When I am craving sugar'),              // PD 선창
    isl(4, 6, 'on', 'When I am craving'),                     // 출연자 — 끝까지 못 함
    isl(7, 8, 'off', '다시 하겠습니다'),                         // 지시
    isl(9, 11, 'on', 'When I am craving sugar'),              // 출연자 온전한 테이크
    isl(12, 14, 'off', 'My body is asking for protein'),      // 선창
    isl(15, 17, 'on', 'My body is asking for protein'),
    isl(18, 20, 'on', 'My body is asking for protein'),       // 한 번 더 — 마지막 것을 고른다
    isl(21, 22, 'on', '아 죄송합니다'),                          // 대본에 없는 출연자 말
    isl(23, 25, 'off', 'So I will eat eggs'),                 // 선창
    isl(26, 28, 'on', 'So I will eat eggs'),
  ] };
  const p = paperEdit(sp, script);
  assert.deepEqual(p.counts, { lines: 3, take: 3, partial: 0, pdVoice: 0, pdVoiceMaybe: 0, check: 0, missing: 0, notSpoken: 0 });
  assert.equal(p.leads, 3);
  assert.deepEqual(p.lines.map((l) => [l.pick.start, l.off.map((o) => o.kind)]), [[9, ['lead']], [18, ['lead']], [26, ['lead']]]);
  assert.deepEqual(p.directions.map((d) => d.text), ['다시 하겠습니다']);
  assert.deepEqual(p.adlibs.map((d) => d.text), ['아 죄송합니다']);
  assert.deepEqual(paperKeep(p, 'IMG.MOV').map((k) => [k.start, k.speaker]), [[9, 'on'], [18, 'on'], [26, 'on']]);
  const md = paperReport(p);
  assert.match(md, /선창 3곳 · 지시·잡담 1곳/); assert.match(md, /\*\*00:09\.00~00:11\.00 100%\*\*/); assert.match(md, /선창 → 뺌/);
});

test('내용인 PD 목소리는 쓴다: 대본에 PD 대사로 적혀 있으면 확정, 표시가 없어도 출연자가 따라 하지 않고 대답하면 "질문으로 보임"', () => {
  const marked = readScript('PD: My acne is really bad.\nUse salicylic acid.\nPD: Pigmentation stresses me every day.\nUse tranexamic acid.');
  const islands = [
    isl(1, 3, 'off', 'My acne is really bad'), isl(4, 6, 'on', 'Use salicylic acid'),
    isl(7, 8, 'off', '좋아요 다음'),
    isl(9, 11, 'off', 'Pigmentation stresses me every day'), isl(12, 14, 'on', 'Use tranexamic acid'),
  ];
  const p = paperEdit({ file: 'Q.MOV', basis: 'channels+motion', islands: islands.map((i) => ({ ...i })) }, marked);
  assert.deepEqual(p.lines.map((l) => l.verdict), ['pd-voice', 'take', 'pd-voice', 'take']);
  assert.equal(p.leads, 0); assert.equal(p.directions.length, 1);
  const keep = paperKeep(p, 'Q.MOV');
  assert.deepEqual(keep.map((k) => [k.start, k.speaker]), [[1, 'pd'], [4, 'on'], [9, 'pd'], [12, 'on']]);
  // 일부러 남긴 PD 목소리는 '화면 밖 목소리가 들어감' 점검에 걸리지 않는다. 표시 없이 남기면 걸린다
  assert.equal(checkKeep(islands, keep).length, 0);
  assert.equal(checkKeep(islands, keep.map(({ speaker, ...k }) => k)).filter((l) => l.who === 'off').length, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-paper-'));
  try { const f = path.join(dir, 'keep.json'); fs.writeFileSync(f, JSON.stringify(keep)); assert.deepEqual(readKeep(f, 'Q.MOV').map((k) => k.speaker || 'on'), ['pd', 'on', 'pd', 'on']); } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // 대본에 화자 표시가 없을 때: 질문으로 보이지만 확정하지 않는다(첫 편에서 한 번 묻는다)
  const plain = readScript('My acne is really bad.\nUse salicylic acid.');
  const q = paperEdit({ file: 'Q.MOV', basis: 'channels+motion', islands: islands.slice(0, 2).map((i) => ({ ...i })) }, plain);
  assert.deepEqual(q.lines.map((l) => l.verdict), ['pd-voice?', 'take']);
  assert.equal(paperKeep(q, 'Q.MOV').length, 1, '확인 필요인 줄은 고른 구간에 넣지 않는다');
  assert.match(paperReport(q), /PD 목소리로 보임 — 확인 필요/);
  // 출연자 대사인데 PD 만 말했고 뒤에 이어지는 대답도 없다 → 확인 필요 / 아무도 안 했다 → 못 찾음
  const lost = paperEdit({ file: 'Q.MOV', basis: 'level', islands: [isl(1, 3, 'off', 'Use salicylic acid')] }, readScript('Use salicylic acid.\nNever said line here.'));
  assert.deepEqual(lost.lines.map((l) => l.verdict), ['check', 'missing']);
  assert.match(paperReport(lost), /근거가 약해요/);
});
