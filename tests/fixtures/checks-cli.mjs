// ODDIN 검사 시험용 모의 CLI(실제 모델 호출 없음): 계획은 확인 명령(node check.js)을 적고,
// 작업자는 처음엔 그냥 끝내고 "ODDIN 검사 실패" 지시를 받으면 fixed.txt 를 만든다(--never-fix 면 끝내 못 고침).
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const tool = value('--tool'), capture = value('--capture');
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\n');
if (args.includes('--version')) { console.log('모의 CLI 0.160.0'); process.exit(0); }
if (args.includes('status')) { console.log(tool === 'claude' ? JSON.stringify({ loggedIn: true }) : 'Logged in with mock'); process.exit(0); }
if (args.includes('--no-session-persistence')) process.exit(0);
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
fs.appendFileSync(capture, JSON.stringify({ tool, args, prompt }) + '\n');
let text;
if (prompt.startsWith('당신은 로컬 AI 작업 허브의 플래너')) {
  text = JSON.stringify({ summary: '시험 계획', tasks: [{ id: 't1', title: '파서 수정', assignee: 'claude', prompt: 'WORK', dependsOn: [], model: 'opus', effort: 'high', reason: '시험', agent: '', visualOutput: false, design: '', check: '', checks: ['node check.js'] }] });
} else if (prompt.startsWith('당신은 작업마다')) {
  text = JSON.stringify({ choices: [{ id: 't1', model: 'opus', effort: 'high', reason: '시험' }] });
} else if (prompt.startsWith('당신은 AI 작업 허브의 보고 담당')) {
  text = '시험 보고';
} else if (prompt.includes('ODDIN 검사 실패')) {
  if (!args.includes('--never-fix')) fs.writeFileSync(path.join(process.cwd(), 'fixed.txt'), 'ok');
  text = '② fixed.txt 만듦';
} else {
  text = '① 했어요';
}
if (tool === 'claude') {
  emit({ type: 'system', subtype: 'init', session_id: 'mock-claude', model: 'opus' });
  emit({ type: 'result', result: text, is_error: false, session_id: 'mock-claude' });
} else {
  emit({ type: 'thread.started', thread_id: 'mock-codex' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: {} });
  if (args.includes('-o')) fs.writeFileSync(value('-o'), text);
}
