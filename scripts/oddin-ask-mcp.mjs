#!/usr/bin/env node
// ODDIN 다른 AI에게 묻기 도구(MCP, 표준 입출력). 요청에서 "다른 AI 의견"을 켰을 때 ODDIN 이 Claude·Codex 작업자에 붙여 준다(lib/consult.mjs).
// 실제로 다른 AI를 돌리는 것은 ODDIN 허브다 — 이 스크립트는 허브의 /api/consult 로 부탁하고 답을 기다려 돌려준다.
// 답은 몇 분 걸릴 수 있어 허브에 짧게 여러 번 물으며 기다린다(ODDIN_ASK_WAIT_MS 까지). 그보다 늦으면 요청 번호를 돌려주고 ask_result 로 이어 받게 한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = 7700;
try { port = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_FILE || path.join(root, 'config.json'), 'utf8')).port || port; } catch {}
const HUB = (process.env.ODDIN_HUB || `http://127.0.0.1:${port}`).replace(/\/$/, '');
const OWNER = process.env.ODDIN_TASK || '';
const OTHER = process.env.ODDIN_ASK_OTHER || '다른 AI';
const WAIT = Math.max(1000, Number(process.env.ODDIN_ASK_WAIT_MS) || 540_000);
const POLL = Math.max(200, Math.min(Number(process.env.ODDIN_ASK_POLL_MS) || 50_000, 240_000));
const HOLD = Math.max(0, Number(process.env.ODDIN_ASK_HOLD_MS) || 0); // 시험용: 도구 호출을 최소 이만큼 붙잡는다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const TOOLS = [
  ['ask_other_ai', `${OTHER}에게 의견을 묻는다(두 번째 의견·독립 분석·바뀐 내용 검토). ${OTHER}는 이 프로젝트 폴더를 읽기만 하고 파일을 고치지 않는다. 답이 올 때까지 기다리며 몇 분 걸릴 수 있다. 너무 늦으면 요청 번호를 돌려주니 ask_result 로 이어 받는다. Ask the other AI (${OTHER}) for a read-only second opinion or a review; blocks until it answers.`, S({
    question: { type: 'string', description: '무엇을 판단해 달라는지. 볼 파일 경로와 판단 기준을 함께 적는다. 독립 분석을 원하면 내 결론은 적지 않는다.' },
    context: { type: 'string', description: '판단에 필요한 참고(지금까지 알아낸 것, 고민 중인 선택지, 오류 메시지 등). 없어도 된다.' },
    review: { type: 'boolean', description: 'true = 끝내기 전 검토. 허브가 이 작업을 시작한 뒤 바뀐 파일과 비교 내용을 뽑아 함께 넘긴다.' },
  }, ['question'])],
  ['ask_result', '앞서 ask_other_ai 가 "아직 쓰는 중"이라며 돌려준 요청 번호의 답을 이어서 기다려 받는다. Fetch a pending answer by its request id.', S({ id: { type: 'string', description: '요청 번호(예: c1-ab12)' } }, ['id'])],
];

async function post(route, body, timeoutMs) {
  const r = await fetch(`${HUB}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, ...body }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `ODDIN 허브가 ${r.status}로 답했어요`);
  return j;
}
const took = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.max(1, Math.round(ms / 1000))}초`);
const ALONE = '혼자 판단해 진행하고, 의견을 받지 못했다는 것을 결과에 한 줄 적으세요.';

/** 요청 번호의 답을 deadline 까지 기다린다 */
async function waitFor(id, deadline) {
  for (;;) {
    const left = deadline - Date.now();
    const r = await post('/api/consult/wait', { id, waitMs: Math.max(0, Math.min(POLL, left)) }, POLL + 20_000);
    if (r.status !== 'running') return r;
    if (deadline - Date.now() <= 0) return r;
  }
}
function render(r, id) {
  const name = { claude: 'Claude', codex: 'Codex' }[r.tool] || OTHER;
  if (r.status === 'done') return `[${name} 의견 · ${took(r.ms || 0)}]\n${r.answer || '(빈 답)'}\n\n(참고 의견입니다. 근거를 직접 확인해 판단하고, 따르지 않는 부분은 결과에 이유를 한 줄 적으세요.)`;
  if (r.status === 'running') return `아직 ${name}가 답을 쓰는 중이에요(요청 번호 ${id}). 기다리는 동안 할 수 있는 일을 하다가 ask_result 에 이 번호를 주어 답을 받으세요. 같은 질문을 다시 보내지 마세요.`;
  return `${name} 의견을 받지 못했어요(${r.error || r.status}). ${ALONE}`;
}
async function call(name, args = {}) {
  const began = Date.now(), deadline = began + WAIT;
  let id = String(args.id || ''), text;
  if (name === 'ask_other_ai') {
    const s = await post('/api/consult', { question: args.question, context: args.context || '', review: args.review === true }, 60_000);
    if (s.refused) text = s.message; // 꺼짐·횟수·한도·상대 AI 없음: 그 사정을 그대로 알려 혼자 진행하게 한다
    id = s.id || id;
    if (!s.refused && !id) throw new Error('요청 번호를 받지 못했어요');
  }
  if (text === undefined) text = render(await waitFor(id, deadline), id);
  if (HOLD) { const left = HOLD - (Date.now() - began); if (left > 0) await sleep(left); }
  return [{ type: 'text', text }];
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // 알림
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => out({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  try {
    if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oddin-ask', version: '1.0.0' }, instructions: `ODDIN 이 붙여 준 "다른 AI에게 묻기" 도구. ask_other_ai 로 ${OTHER}에게 의견·검토를 받는다(읽기 전용, 몇 분 걸릴 수 있음). 언제 쓰는지는 작업 지시문의 규칙을 따른다.` });
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: TOOLS.map(([name, description, inputSchema]) => ({ name, description, inputSchema })) });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (!TOOLS.some(([n]) => n === name)) return fail(-32602, `모르는 도구: ${name}`);
      try { return reply({ content: await call(name, msg.params?.arguments || {}) }); }
      catch (e) { return reply({ content: [{ type: 'text', text: `의견 요청 실패: ${e.message}. ${ALONE}` }], isError: true }); }
    }
    return fail(-32601, `지원하지 않는 요청: ${msg.method}`);
  } catch (e) { return fail(-32603, e.message); }
});
