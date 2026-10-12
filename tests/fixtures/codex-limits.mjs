// Codex 앱 서버 흉내: account/rateLimits/read 에만 답한다(실제 계정·모델 호출 없음). 시험 tests/usage-resets.test.mjs
// --mode none = 초기화권 칸 없이, --mode error = 조회 오류, --mode silent = 답하지 않음(시간 초과 시험)
import readline from 'node:readline';
const args = process.argv.slice(2), mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'ok';
if (!args.includes('app-server')) { console.error('app-server 로만 불러요'); process.exit(2); }
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\n');
const now = Math.floor(Date.now() / 1000), day = 86_400;
const limits = { limitId: 'codex', primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: now + 3 * day }, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now + 3600 }, planType: 'pro' };
for await (const line of readline.createInterface({ input: process.stdin })) {
  let x; try { x = JSON.parse(line); } catch { continue; }
  if (x.method === 'initialize') emit({ id: x.id, result: { serverInfo: {} } });
  else if (x.method === 'account/rateLimits/read') {
    if (mode === 'silent') continue;
    if (mode === 'error') { emit({ id: x.id, error: { code: -32000, message: '로그인이 필요해요' } }); continue; }
    emit({ id: x.id, result: { rateLimits: limits, rateLimitsByLimitId: { codex: limits }, accountId: 'acct-secret',
      ...(mode === 'none' ? {} : { rateLimitResetCredits: { availableCount: 1, credits: [
        { id: 'RateLimitReset-secret', resetType: 'codexRateLimits', status: 'available', grantedAt: now - 5 * day, expiresAt: now + 25 * day, title: 'Full reset', description: 'Thanks' },
        { id: 'used', resetType: 'codexRateLimits', status: 'redeemed', grantedAt: now - 40 * day, expiresAt: now + 2 * day, title: 'Full reset' },
        { id: 'old', resetType: 'codexRateLimits', status: 'available', grantedAt: now - 60 * day, expiresAt: now - day, title: 'Full reset' },
      ] } }) } });
  }
}
