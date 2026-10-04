// 첫 실행은 도중에 "모델 용량 초과"로 턴이 실패하고, 두 번째(같은 대화 이어 쓰기)부터 정상 응답하는 가짜 Codex (exec --json 형식)
import fs from 'node:fs';
if (!process.argv.includes('exec')) { process.stdout.write('codex-cli 0.0.0-test\n'); process.exit(0); } // 버전 확인 호출은 세지 않음
const counter = process.env.CAPACITY_COUNTER;
const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
fs.writeFileSync(counter, String(n));
fs.appendFileSync(process.env.CAPACITY_ARGS, JSON.stringify(process.argv.slice(2)) + '\n');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.CAPACITY_ARGS, JSON.stringify({ prompt: stdin.slice(0, 200) }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'thread.started', thread_id: 'cap-thread' });
  if (n === 1) {
    out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: '다시 만드는 중' } });
    out({ type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } });
    process.exit(1);
  }
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '이어서 완료' } });
  out({ type: 'turn.completed', usage: {} });
  process.exit(0);
});
