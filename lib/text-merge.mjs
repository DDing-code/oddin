// 글 파일 합치기 (2026-10-05 사용자 "메모리나 지침이 다를 텐데 덮어쓰지 않고 정상적으로 추합이 되는지?").
// 두 PC가 같은 파일을 고쳤을 때 최근 판으로 덮지 않고 줄 단위로 합친다.
// - merge3(기준, 내 판, 상대 판): 마지막으로 맞춘 내용(기준)과 비교해 겹치지 않게 고친 곳은 둘 다 반영한다.
//   같은 곳을 서로 다르게 고쳤으면 최근 판을 쓰고, 다른 판은 표시를 붙여 바로 아래에 남긴다(.md 만 — 그 밖의 파일은 합치지 못한 것으로 돌려줌).
// - merge2(최근 판, 다른 판): 기준이 없을 때(처음 맞춤) 두 판의 같은 줄은 한 번만, 한쪽에만 있는 줄은 모두 남긴다.
export const CONFLICT_OPEN = (who) => `<!-- ODDIN 합치기: 아래는 ${who}에서 같은 곳을 다르게 고친 판입니다. 확인 후 하나만 남기세요 -->`;
export const CONFLICT_CLOSE = '<!-- /ODDIN 합치기 -->';
const MAX_CELLS = 4_000_000; // 줄 수 곱이 이보다 크면 합치지 않는다(너무 큰 파일)

/** a→b 로 바꾸는 덩어리: [{ s, e, lines }] (a[s..e) 를 lines 로) — 줄 단위 최장 공통 부분열 */
export function diffHunks(a, b) {
  const n = a.length, m = b.length;
  if (n * m > MAX_CELLS) return null;
  // 앞뒤 같은 줄은 먼저 잘라 표를 줄인다
  let pre = 0; while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf), N = A.length, M = B.length;
  const L = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
  for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = []; let i = 0, j = 0, hs = -1, hj = -1;
  const close = () => { if (hs >= 0) { hunks.push({ s: hs + pre, e: i + pre, lines: B.slice(hj, j) }); hs = -1; } };
  while (i < N || j < M) {
    if (i < N && j < M && A[i] === B[j]) { close(); i++; j++; continue; }
    if (hs < 0) { hs = i; hj = j; }
    if (j < M && (i >= N || L[i][j + 1] >= L[i + 1][j])) j++; else i++;
  }
  close();
  return hunks;
}

const splitLines = (s) => String(s).replace(/\r\n/g, '\n').split('\n');
const eolOf = (s) => (String(s).includes('\r\n') ? '\r\n' : '\n');
const same = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
/** base[s..e) 구간에 그 판의 덩어리들을 적용한 결과 */
function applyIn(base, s, e, hunks) {
  const out = []; let p = s;
  for (const h of hunks) { out.push(...base.slice(p, h.s), ...h.lines); p = h.e; }
  out.push(...base.slice(p, e));
  return out;
}

/**
 * 3방향 합치기. mineNewer = 내 판이 더 최근(겹칠 때 위에 둘 판), other = 다른 판 이름(표시용), markers = 겹친 곳을 둘 다 남길지(.md)
 * 돌려주는 값: { text, conflicts } — 합치지 못하면 null
 */
export function merge3(baseText, mineText, theirsText, { mineNewer = true, other = '다른 PC', markers = true } = {}) {
  const base = splitLines(baseText), mine = splitLines(mineText), theirs = splitLines(theirsText);
  const hm = diffHunks(base, mine), ht = diffHunks(base, theirs);
  if (!hm || !ht) return null;
  const all = [...hm.map((h) => ({ ...h, who: 'm' })), ...ht.map((h) => ({ ...h, who: 't' }))].sort((x, y) => x.s - y.s || x.e - y.e);
  const out = []; let p = 0, conflicts = 0;
  for (let k = 0; k < all.length;) {
    // 겹치는 덩어리 묶기(같은 자리 끼워 넣기 포함)
    let s = all[k].s, e = all[k].e; const group = [all[k++]];
    while (k < all.length && (all[k].s < e || all[k].s === s || (all[k].s === e && all[k].s === all[k].e && group.some((g) => g.s === g.e && g.s === e)))) { e = Math.max(e, all[k].e); group.push(all[k++]); }
    out.push(...base.slice(p, s)); p = e;
    const gm = group.filter((g) => g.who === 'm'), gt = group.filter((g) => g.who === 't');
    if (!gt.length) { out.push(...applyIn(base, s, e, gm)); continue; }
    if (!gm.length) { out.push(...applyIn(base, s, e, gt)); continue; }
    const vm = applyIn(base, s, e, gm), vt = applyIn(base, s, e, gt);
    if (same(vm, vt)) { out.push(...vm); continue; }
    if (!markers) return null;
    conflicts++;
    const [first, second] = mineNewer ? [vm, vt] : [vt, vm];
    out.push(...first, CONFLICT_OPEN(other), ...second, CONFLICT_CLOSE);
  }
  out.push(...base.slice(p));
  return { text: out.join(eolOf(mineNewer ? mineText : theirsText)), conflicts };
}

/** 기준 없이 합치기: 최근 판을 바탕으로 다른 판에만 있는 줄을 더한다. 같은 자리를 바꾼 줄은 표시를 붙여 남긴다 */
export function merge2(newerText, olderText, { other = '다른 PC', markers = true } = {}) {
  const a = splitLines(newerText), b = splitLines(olderText);
  const hs = diffHunks(a, b);
  if (!hs) return null;
  const out = []; let p = 0, conflicts = 0;
  for (const h of hs) {
    out.push(...a.slice(p, h.e)); p = h.e; // 최근 판 줄은 그대로 둔다(다른 판에서 빠졌어도)
    if (!h.lines.length) continue;
    if (h.s === h.e) { out.push(...h.lines); continue; } // 다른 판에만 있는 줄 → 더함
    if (!markers) return null;
    conflicts++;
    out.push(CONFLICT_OPEN(other), ...h.lines, CONFLICT_CLOSE);
  }
  out.push(...a.slice(p));
  return { text: out.join(eolOf(newerText)), conflicts };
}
