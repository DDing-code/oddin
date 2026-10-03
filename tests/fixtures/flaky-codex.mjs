// 첫 실행은 Codex 상태 DB 잠금 오류로 실패, 두 번째부터 정상 응답하는 가짜 Codex (exec --json 형식)
import fs from 'node:fs';
if (!process.argv.includes('exec')) { process.stdout.write('codex-cli 0.0.0-test\n'); process.exit(0); } // 버전 확인 호출은 세지 않음
const counter = process.env.FLAKY_COUNTER;
const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
fs.writeFileSync(counter, String(n));
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  if (n === 1) { process.stderr.write('Error: failed to initialize sqlite state runtime under codex-home\n'); process.exit(1); }
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'thread.started', thread_id: 'flaky-thread' });
  out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: '두 번째 시도 성공' } });
  out({ type: 'turn.completed', usage: {} });
  process.exit(0);
});
