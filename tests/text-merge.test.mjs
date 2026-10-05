// 글 파일 합치기: 두 PC가 같은 파일을 고쳐도 덮어쓰지 않고 줄 단위로 합친다
import test from 'node:test';
import assert from 'node:assert/strict';
import { merge3, merge2, diffHunks, CONFLICT_CLOSE } from '../lib/text-merge.mjs';

const T = (...lines) => lines.join('\n');

test('줄 차이 덩어리', () => {
  assert.deepEqual(diffHunks(['a', 'b', 'c'], ['a', 'x', 'c']), [{ s: 1, e: 2, lines: ['x'] }]);
  assert.deepEqual(diffHunks(['a', 'c'], ['a', 'b', 'c']), [{ s: 1, e: 1, lines: ['b'] }]);
  assert.deepEqual(diffHunks(['a', 'b'], ['a']), [{ s: 1, e: 2, lines: [] }]);
  assert.deepEqual(diffHunks(['a'], ['a']), []);
});

test('3방향: 서로 다른 곳을 고치면 둘 다 반영', () => {
  const base = T('# 지침', '- 하나', '- 둘', '- 셋', '- 넷');
  const home = T('# 지침', '- 하나 (집에서 고침)', '- 둘', '- 셋', '- 넷');
  const office = T('# 지침', '- 하나', '- 둘', '- 셋', '- 넷 (회사에서 고침)', '- 다섯 (회사에서 더함)');
  const r = merge3(base, home, office, { other: '회사' });
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, T('# 지침', '- 하나 (집에서 고침)', '- 둘', '- 셋', '- 넷 (회사에서 고침)', '- 다섯 (회사에서 더함)'));
  // 한쪽이 지운 줄은 지운다
  assert.equal(merge3(T('a', 'b', 'c'), T('a', 'c'), T('a', 'b', 'c', 'd')).text, T('a', 'c', 'd'));
  // 같은 수정은 한 번만
  assert.equal(merge3(T('a', 'b'), T('a', 'B'), T('a', 'B')).text, T('a', 'B'));
});

test('3방향: 같은 곳을 다르게 고치면 최근 판 + 다른 판을 표시해 남김', () => {
  const base = T('제목', '규칙: 원래', '끝');
  const r = merge3(base, T('제목', '규칙: 집 판', '끝'), T('제목', '규칙: 회사 판', '끝'), { mineNewer: false, other: '집' });
  assert.equal(r.conflicts, 1);
  const lines = r.text.split('\n');
  assert.deepEqual([lines[0], lines[1], lines[3], lines[4], lines[5]], ['제목', '규칙: 회사 판', '규칙: 집 판', CONFLICT_CLOSE, '끝']);
  assert.match(lines[2], /집에서 같은 곳을 다르게 고친 판/);
  assert.equal(merge3(base, T('제목', 'x', '끝'), T('제목', 'y', '끝'), { markers: false }), null, '표시를 못 넣는 파일은 합치지 못함');
  // 같은 자리에 서로 다른 줄을 끼워 넣음
  const ins = merge3(T('a', 'c'), T('a', '집', 'c'), T('a', '회사', 'c'), { other: '회사' });
  assert.equal(ins.conflicts, 1); assert.ok(ins.text.includes('집') && ins.text.includes('회사'));
});

test('기준 없이(처음 맞춤): 같은 줄은 한 번, 한쪽에만 있는 줄은 모두', () => {
  const r = merge2(T('# 메모', '- 가', '- 나 (집)', '- 다'), T('# 메모', '- 가', '- 다', '- 라 (회사)'), { other: '회사' });
  assert.equal(r.conflicts, 0);
  assert.equal(r.text, T('# 메모', '- 가', '- 나 (집)', '- 다', '- 라 (회사)'));
  const c = merge2(T('a', '집 판', 'z'), T('a', '회사 판', 'z'), { other: '회사' });
  assert.equal(c.conflicts, 1); assert.ok(c.text.startsWith(T('a', '집 판')) && c.text.includes('회사 판') && c.text.endsWith('z'));
  assert.equal(merge2('a\r\nb', 'a\r\nb\r\nc').text, 'a\r\nb\r\nc', '줄바꿈 방식 유지');
});
