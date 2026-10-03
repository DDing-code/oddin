// 네트워크/실제 모델을 호출하지 않는 CLI 제어 프로토콜 시험기.
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), value = (k) => args[args.indexOf(k) + 1];
const tool = value('--tool'), capture = value('--capture');
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\n');
const note = (x) => fs.appendFileSync(capture, JSON.stringify({ pid: process.pid, tool, ...x }) + '\n');
if (args.includes('--version')) { console.log('fixture-cli 0.160.0'); process.exit(0); }
if (args.includes('status')) { console.log(tool === 'claude' ? JSON.stringify({ loggedIn: true }) : 'Logged in with fixture'); process.exit(0); }
// --flaky-once <파일>: 첫 실행만 Codex 상태 DB 잠금 오류처럼 바로 끝난다 (일시적 시작 오류 재시도 시험)
if (args.includes('--flaky-once') && !fs.existsSync(value('--flaky-once'))) {
  fs.writeFileSync(value('--flaky-once'), '1');
  process.stderr.write('Error: failed to initialize sqlite state runtime under fixture-home\n');
  process.exit(1);
}
let sid = `fixture-${tool}-${randomUUID()}`, tid, serial = 0, timer, original = '', current = '', stage, ended = false;
let backgroundTimer;
function answer(prompt) {
  if (stage === 'plan') {
    const reconcile = original.includes('보완 작업만');
    return JSON.stringify({ summary: '시험 계획', tasks: reconcile ? [{ id: 't1', title: '보완', assignee: 'codex', prompt: 'SUPPLEMENT_WORK', dependsOn: [], model: 'gpt-6.1-sol', effort: 'high', reason: '시험', agent: '' }] : [
      { id: 't1', title: '첫 작업', assignee: 'codex', prompt: 'WORK_ONE', dependsOn: [], model: 'gpt-6.1-sol', effort: 'high', reason: '시험', agent: '' },
      { id: 't2', title: '다음 작업', assignee: 'claude', prompt: 'WORK_TWO', dependsOn: ['t1'], model: 'opus', effort: 'high', reason: '시험', agent: '' },
    ] });
  }
  if (stage === 'route') return JSON.stringify({ choices: [{ id: 't1', model: 'gpt-6.1-sol', effort: 'high', reason: '시험' }] });
  if (stage === 'goal-check') return JSON.stringify({ done: !prompt.includes('NEXT_ROUND'), progress: 70, remaining: '남은 시험', next: '이어서 시험', blocked: false, reason: '시험' });
  return `원래 맥락: ${original.slice(0, 40)}\n최신 지시: ${prompt}`;
}
function complete() {
  if (ended) return; ended = true;
  const text = answer(current);
  if (tool === 'claude' && current.includes('AMBIENT_BACKGROUND')) {
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', ambient: true }] });
    emit({ type: 'result', result: text, session_id: sid, is_error: false });
  }
  else if (tool === 'claude' && current.includes('BACKGROUND')) {
    const id = 'background-1';
    emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: id }] });
    emit({ type: 'system', subtype: 'task_started', task_id: id, is_backgrounded: true });
    emit({ type: 'result', result: '끝나면 만들겠습니다', session_id: sid, is_error: false });
    if (current.includes('BACKGROUND_EXIT')) { process.exit(0); }
    if (!current.includes('BACKGROUND_STUCK')) backgroundTimer = setTimeout(() => {
      emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
      emit({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' });
      // level 신호가 edge보다 먼저 와도 task_started를 결합해 다시 대기하지 않아야 한다.
      emit({ type: 'system', subtype: 'task_started', task_id: id, is_backgrounded: true });
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'BACKGROUND_FINAL ' + current }] } });
      emit({ type: 'result', result: 'BACKGROUND_FINAL ' + current, session_id: sid, is_error: false });
    }, 350);
  }
  else if (tool === 'claude') emit({ type: 'result', result: text, session_id: sid, is_error: false });
  else { emit({ method: 'item/completed', params: { threadId: sid, turnId: tid, item: { type: 'agentMessage', text } } }); emit({ method: 'turn/completed', params: { threadId: sid, turn: { id: tid, status: 'completed' } } }); }
}
function begin(prompt) {
  if (!original) { original = prompt; stage = prompt.startsWith('당신은 로컬') ? 'plan' : prompt.startsWith('당신은 작업마다') ? 'route' : prompt.startsWith('당신은 AI 작업') ? 'report' : prompt.startsWith('당신은 목표 달성') ? 'goal-check' : 'worker'; }
  current = prompt; ended = false; clearTimeout(timer); timer = setTimeout(complete, original.includes('SLOW') ? 1500 : 240);
}
if (args.includes('exec')) {
  // 재개 경로는 stdin EOF 뒤 같은 thread ID를 내보낸다.
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  sid = args.includes('resume') ? args.at(-2) : sid;
  note({ kind: 'legacy', args, prompt, sid });
  if (!prompt.includes('NO_INIT')) emit({ type: 'thread.started', thread_id: prompt.includes('BAD_RESUME') ? 'wrong-id' : sid });
  if (!args.includes('resume')) await new Promise((r) => setTimeout(r, 1500));
  const text = `재개 결과 ${prompt}`;
  emit({ type: 'item.completed', item: { type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: {} });
  if (args.includes('-o')) fs.writeFileSync(value('-o'), text);
  process.exit(0);
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const x = JSON.parse(line); note({ kind: 'input', message: x });
  if (tool === 'claude') {
    if (x.type === 'control_request') {
      const subtype = x.request.subtype;
      if (subtype === 'interrupt') {
        clearTimeout(timer); clearTimeout(backgroundTimer); emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        const ack = () => { emit({ type: 'control_response', response: { request_id: x.request_id, subtype: 'success', response: { still_queued: original.includes('STILL_QUEUED') ? ['queued-id'] : [] } } }); if (!ended) setTimeout(() => emit({ type: 'result', session_id: sid, is_error: true, result: 'STALE_INTERRUPTED_RESULT' }), 10); };
        if (original.includes('DELAY_ACK')) timer = setTimeout(ack, 500); else ack();
      }
      else emit({ type: 'control_response', response: { request_id: x.request_id, subtype: 'success', response: subtype === 'get_usage' ? { rate_limits: { five_hour: { utilization: 0 } } } : {} } });
    } else if (x.type === 'user') {
      const prompt = x.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (!original && !prompt.includes('NO_INIT')) emit({ type: 'system', subtype: 'init', session_id: args.includes('--resume') ? value('--resume') : sid, model: 'opus' });
      if (!prompt.includes('ACK_LOSS')) emit({ ...x, session_id: sid });
      begin(prompt);
    }
  } else {
    const p = x.params || {}, reply = (result) => emit({ id: x.id, result });
    if (x.method === 'initialize') reply({ serverInfo: {} });
    else if (x.method === 'thread/start' || x.method === 'thread/resume') { if (p.model && p.model === value('--reject-model') && args.includes('--reject-model')) { emit({ id: x.id, error: { code: -32600, message: `The '${p.model}' model is not supported when using Codex with a ChatGPT account.` } }); continue; } if (p.threadId) sid = p.threadId; reply({ thread: { id: sid }, model: p.model }); }
    else if (x.method === 'turn/start') {
      tid = 'turn-' + ++serial; begin(p.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n'));
      reply({ turn: { id: tid } }); emit({ method: 'turn/started', params: { threadId: sid, turn: { id: tid } } });
      emit({ method: 'item/started', params: { threadId: sid, item: { type: 'userMessage', clientId: p.clientUserMessageId } } });
    } else if (x.method === 'turn/steer') {
      if (p.expectedTurnId !== tid || original.includes('REJECT_STEER')) { emit({ id: x.id, error: { code: -32600, message: 'expected turn conflict' } }); continue; }
      if (original.includes('ACK_LOSS')) { current += p.input[0].text; continue; }
      current += '\n' + p.input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
      if (!ended) { clearTimeout(timer); timer = setTimeout(complete, 200); }
      const ack = () => { reply({ turnId: original.includes('WRONG_TURN') ? 'wrong-turn' : tid }); emit({ method: 'item/started', params: { threadId: sid, item: { type: 'userMessage', clientId: p.clientUserMessageId } } }); };
      if (original.includes('DELAY_ACK')) { clearTimeout(timer); timer = setTimeout(ack, 500); } else ack();
    } else if (x.method === 'turn/interrupt') { clearTimeout(timer); reply({}); ended = true; emit({ method: 'turn/completed', params: { threadId: sid, turn: { id: tid, status: 'interrupted' } } }); }
  }
}
clearTimeout(timer);
clearTimeout(backgroundTimer);
