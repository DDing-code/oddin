// Codex 실시간 한도 조회와 초기화권(lib/usage.mjs · public/side.js · commands.js). 실제 계정·모델 호출 없음
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseCodexLimits, readCodexLimits, mergeCodexUsage, usageStatus, usageEvents } from '../lib/usage.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex-limits.mjs', import.meta.url));
const now = Date.UTC(2026, 9, 12), sec = (ms) => Math.floor(ms / 1000), day = 86_400_000;

test('응답 해석: 한도 창과 요금제, 지금 쓸 수 있는 초기화권만(쓴 것·만료된 것 제외, 번호·설명은 내보내지 않음)', () => {
  const r = parseCodexLimits({
    rateLimits: { primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: sec(now + 3 * day) }, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: sec(now + 3_600_000) }, planType: 'pro' },
    rateLimitResetCredits: { availableCount: 2, credits: [
      { id: 'secret-b', resetType: 'codexRateLimits', status: 'available', grantedAt: sec(now - day), expiresAt: sec(now + 25 * day), title: 'Full reset', description: '고마워요' },
      { id: 'secret-a', resetType: 'codexRateLimits', status: 'available', grantedAt: sec(now - 2 * day), expiresAt: sec(now + 2 * day), title: 'Full reset' },
      { id: 'used', status: 'redeemed', expiresAt: sec(now + 9 * day), title: 'Full reset' },
      { id: 'old', status: 'available', expiresAt: sec(now - day), title: 'Full reset' },
    ] },
  }, now);
  assert.deepEqual(r.windows.map((w) => [w.label, w.key, w.usedPercent]), [['5시간', 'w300', 40], ['주간', 'w10080', 15]]);
  assert.equal(r.plan, 'pro');
  assert.equal(r.resets.available, 2);
  assert.deepEqual(r.resets.items.map((i) => i.expiresAt), [new Date(now + 2 * day).toISOString(), new Date(now + 25 * day).toISOString()], '만료가 가까운 것부터');
  assert.deepEqual(Object.keys(r.resets.items[0]).sort(), ['expiresAt', 'grantedAt', 'title', 'type']);
  assert.doesNotMatch(JSON.stringify(r), /secret|고마워요/);
});

test('응답 해석: 초기화권 칸이 없으면 모름(null), 목록 없이 개수만 오면 그 개수, 빈 목록이면 0', () => {
  assert.equal(parseCodexLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1 } } }).resets, null);
  assert.deepEqual(parseCodexLimits({ rateLimitResetCredits: { availableCount: 3 } }).resets, { available: 3, items: [] });
  assert.deepEqual(parseCodexLimits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }).resets, { available: 0, items: [] });
  assert.deepEqual(parseCodexLimits(null), { windows: [], plan: null, resets: null });
  // 창 하나만 오는 요금제(주간만)
  assert.deepEqual(parseCodexLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1792296026 }, secondary: null } } }).windows.map((w) => w.label), ['주간']);
});

test('앱 서버에 묻기: 답을 받아 해석하고, 오류·무응답은 실패로 돌려준다', async () => {
  const ok = await readCodexLimits(process.execPath, { pre: [fixture] });
  assert.equal(ok.ok, true); assert.equal(ok.plan, 'pro'); assert.equal(ok.resets.available, 1); assert.equal(ok.resets.items[0].title, 'Full reset');
  assert.deepEqual(ok.windows.map((w) => w.label), ['5시간', '주간']);
  const none = await readCodexLimits(process.execPath, { pre: [fixture, '--mode', 'none'] });
  assert.equal(none.ok, true); assert.equal(none.resets, null);
  const err = await readCodexLimits(process.execPath, { pre: [fixture, '--mode', 'error'] });
  assert.equal(err.ok, false); assert.match(err.error, /로그인이 필요해요/);
  const slow = await readCodexLimits(process.execPath, { pre: [fixture, '--mode', 'silent'], timeoutMs: 600 });
  assert.deepEqual(slow, { ok: false, error: '시간 초과' });
  const gone = await readCodexLimits(process.execPath, { pre: [fixture + '.없음'] });
  assert.equal(gone.ok, false);
});

test('합치기: 한도는 더 새 쪽, 초기화권은 실시간 값(실시간 조회가 없으면 모름)', () => {
  const log = { status: 'ok', source: '최근 Codex 기록', plan: null, windows: [{ key: 'w10080', label: '주간', usedPercent: 30 }], observedAt: '2026-10-12T03:00:00.000Z' };
  const live = { windows: [{ key: 'w10080', label: '주간', usedPercent: 15 }], plan: 'pro', resets: { available: 1, items: [] }, observedAt: '2026-10-12T02:00:00.000Z' };
  assert.deepEqual(mergeCodexUsage(log, null), { ...log, resets: null });
  const older = mergeCodexUsage(log, live);
  assert.equal(older.source, '최근 Codex 기록'); assert.equal(older.windows[0].usedPercent, 30, '작업 기록이 더 새로우면 그 값');
  assert.equal(older.plan, 'pro'); assert.deepEqual(older.resets, { available: 1, items: [], observedAt: live.observedAt });
  const newer = mergeCodexUsage(log, { ...live, observedAt: '2026-10-12T03:05:00.000Z' });
  assert.equal(newer.source, '실시간 조회'); assert.equal(newer.windows[0].usedPercent, 15); assert.equal(newer.status, 'ok');
  // 기록이 없거나 지난 기록이면 실시간 값을 쓴다
  assert.equal(mergeCodexUsage({ status: 'unavailable', windows: [], observedAt: '2026-10-12T04:00:00.000Z' }, live).source, '실시간 조회');
  assert.equal(mergeCodexUsage({ ...log, status: 'stale' }, live).windows[0].usedPercent, 15);
  // 실시간 조회가 초기화권을 모르면(옛 버전) 모름으로 둔다
  assert.equal(mergeCodexUsage(log, { ...live, resets: null }).resets, null);
});

test('실시간 조회는 허브 서버의 주기 갱신·화면 요청에서만 한다(작업·시험 경로에서 Codex 앱 서버를 띄우지 않음)', async () => {
  // 2026-10-12: 작업 시작 때마다도 조회하게 했더니 시험 프로세스마다 진짜 Codex 를 띄워 전체 시험이 흔들렸다(7번 중 3번 실패 → 켜는 쪽에서만 하게 바꿈)
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const server = read('../server.mjs');
  assert.match(server, /CODEX_LIVE = config\.usage\?\.codexLive \?\? !process\.env\.HUB_SKIP_CLI_INSTALL/);
  assert.equal((server.match(/live: CODEX_LIVE/g) || []).length, 2, '주기 갱신과 /api/usage 두 곳');
  assert.doesNotMatch(read('../lib/jobs.mjs'), /usageStatus\([^)]*live/); assert.doesNotMatch(read('../lib/consult.mjs'), /usageStatus\([^)]*live/);
  // live 없이 부르면 조회를 시작하지 않는다 — 초기화권은 모름으로 남고 바뀜 알림도 없다
  let changed = 0; const on = () => changed++; usageEvents.on('change', on);
  try {
    const u = await usageStatus({ tools: { claude: { command: `"${process.execPath}" -e "process.exit(0)"` }, codex: { command: process.execPath } } });
    assert.equal(u.codex.resets, null);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(changed, 0);
  } finally { usageEvents.off('change', on); }
});

// ---- 화면 ----
const side = fs.readFileSync(new URL('../public/side.js', import.meta.url), 'utf8');
function creditsAt(nowMs) {
  const src = side.match(/function resetCredits\(x\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'side.js 에 resetCredits 가 있어야 해요');
  const ctx = vm.createContext({ Date: class extends Date { static now() { return nowMs; } }, Math, Number });
  vm.runInContext(src, ctx);
  return (x) => vm.runInContext('resetCredits', ctx)(x);
}

test('화면 글: 몇 장·언제까지·며칠 남았는지, 3일 이하면 강조, 없으면 "없음", 모르면 표시 안 함', () => {
  const rc = creditsAt(now);
  assert.equal(rc({}), null); assert.equal(rc({ resets: null }), null);
  assert.deepEqual({ ...rc({ resets: { available: 0, items: [] } }) }, { n: 0, soon: false, text: '초기화권 없음' });
  const far = rc({ resets: { available: 1, items: [{ expiresAt: new Date(now + 25 * day + 3_600_000).toISOString() }] } });
  assert.equal(far.n, 1); assert.equal(far.soon, false); assert.match(far.text, /^초기화권 1장 · 11월 \d+일까지 \(26일 남음\)$/);
  const near = rc({ resets: { available: 2, items: [{ expiresAt: new Date(now + 2 * day).toISOString() }, { expiresAt: new Date(now + 20 * day).toISOString() }] } });
  assert.equal(near.soon, true); assert.match(near.text, /^초기화권 2장 · 10월 \d+일까지 \(2일 남음\)$/, '만료가 가장 가까운 것 기준');
  assert.equal(rc({ resets: { available: 1, items: [] } }).text, '초기화권 1장', '만료일을 모르면 장수만');
  assert.match(side, /class="u-rc\$\{rc\.soon/); assert.match(side, /class="u-credit\$\{rc\.n/);
});

test('한도 경고: 그 AI에 초기화권이 있으면 옆에 알려 준다(모델 전용 한도에는 붙이지 않음)', () => {
  const source = fs.readFileSync(new URL('../public/commands.js', import.meta.url), 'utf8');
  const nodes = {}, get = (id) => (nodes[id] ||= { hidden: true, innerHTML: '', addEventListener() {} });
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const S = { usage: {
    claude: { windows: [{ key: 'model_fable', label: 'Fable 주간', model: 'fable', usedPercent: 96, resetsAt: soon }], resets: { available: 5 } },
    codex: { windows: [{ key: 'w10080', label: '주간', usedPercent: 97, resetsAt: soon }], resets: { available: 1, items: [] } },
  } };
  const ctx = vm.createContext({ S, $: get, input: { addEventListener() {}, focus() {} }, document: { addEventListener() {} }, window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} }, Date, renderUsage() {}, renderTop() {}, icon: () => '', esc: String, resetPhrase: String, toast() {} });
  vm.runInContext(source, ctx);
  ctx.renderWarnings();
  const html = get('#warnBar').innerHTML;
  assert.match(html, /<b>Codex 주간 3% 남음<\/b>[^<]*초기화권 1장 있음/);
  assert.doesNotMatch(html.match(/<b>Claude Fable 주간[^<]*<\/b>[^<]*/)?.[0] || '', /초기화권/);
  S.usage.codex.resets = { available: 0, items: [] };
  ctx.renderWarnings();
  assert.doesNotMatch(get('#warnBar').innerHTML, /초기화권/);
});
