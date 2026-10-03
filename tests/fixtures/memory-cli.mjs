// 외부 AI/장기 메모리를 사용하지 않는 모의 CLI. 임시 fixture 파일만 바꾼다.
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const tool = value('--tool');
const fixture = JSON.parse(fs.readFileSync(value('--fixture'), 'utf8'));
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\n');
if (args.includes('--version')) { console.log('모의 CLI 0.160.0'); process.exit(0); }
if (args.includes('status')) {
  if (tool === 'claude') console.log(JSON.stringify({ loggedIn: true, authMethod: 'mock' }));
  else console.log('Logged in with mock');
  process.exit(0);
}
if (args.includes('--no-session-persistence')) {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const req = JSON.parse(line);
    emit({ type: 'control_response', response: { request_id: req.request_id, subtype: 'success', response: req.request.subtype === 'get_usage' ? { subscription_type: 'mock', rate_limits: { five_hour: { utilization: 0 } } } : {} } });
  }
  process.exit(0);
}
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const model = args.includes('-m') ? value('-m') : value('--model');
fs.appendFileSync(fixture.captures, JSON.stringify({ tool, args, model, prompt }) + '\n');
if ((fixture.reject || []).includes(model)) {
  if (tool === 'codex') emit({ type: 'error', message: `The '${model}' model is not supported when using Codex with a ChatGPT account.` });
  else emit({ type: 'result', is_error: true, result: `unsupported model ${model}` });
  process.exit(1);
}
let text;
if (prompt.startsWith('당신은 로컬 AI 작업 허브의 플래너')) {
  text = JSON.stringify({ summary: '모의 분배', tasks: [
    { id: 't1', title: '메모리 업데이트', assignee: 'claude', prompt: 'TEST_MUTATE 메모리를 업데이트', dependsOn: [], model: 'opus', effort: 'high', reason: '모의' },
    { id: 't2', title: '후속 작업', assignee: 'codex', prompt: '메모리 probe 최신 값을 확인', dependsOn: ['t1'], model: 'gpt-6.1-sol', effort: 'high', reason: '모의' },
  ] });
} else if (prompt.startsWith('당신은 작업마다')) {
  const ids = [...prompt.matchAll(/- id=([^,]+), 담당=([^,]+)/g)];
  text = JSON.stringify({ choices: ids.map(([, id, tool]) => ({ id, model: tool === 'claude' ? 'opus' : 'gpt-6.1-sol', effort: 'high', reason: '모의 배정' })) });
} else {
  if (prompt.includes('TEST_MUTATE')) fs.writeFileSync(fixture.probe, fs.readFileSync(fixture.probe, 'utf8').replace(/PROBE_OLD/g, 'PROBE_NEW'));
  text = prompt.includes('PROBE_NEW') ? 'PROBE_NEW 확인' : 'PROBE_OLD 확인';
}
if (tool === 'claude') {
  emit({ type: 'system', subtype: 'init', session_id: 'mock-claude', model });
  emit({ type: 'result', result: text, is_error: false, session_id: 'mock-claude' });
} else {
  emit({ type: 'thread.started', thread_id: 'mock-codex' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: {} });
  if (args.includes('-o')) fs.writeFileSync(value('-o'), text);
}
