// 두 CLI 상태를 터미널에서 확인: npm run check
import path from 'node:path';
import { ROOT, readJson } from '../lib/util.mjs';
import { toolStatus } from '../lib/tools.mjs';

const config = readJson(path.join(ROOT, 'config.json'), {});
const s = await toolStatus(config, { force: true });
for (const n of ['claude', 'codex']) {
  const t = s[n];
  console.log(`${t.ok ? '✅' : '❌'} ${t.label.padEnd(12)} ${t.version || '미설치'}  ${t.loggedIn ? '로그인됨' : '로그인 필요'}${t.fix ? `  → ${t.fix}` : ''}`);
}
process.exit(s.claude.ok || s.codex.ok ? 0 : 1);
