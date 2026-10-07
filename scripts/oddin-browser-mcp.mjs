#!/usr/bin/env node
// ODDIN 브라우저 도구(MCP, 표준 입출력). ODDIN 이 Claude·Codex 작업자를 띄울 때 붙여 준다(lib/workers.mjs·native-workers.mjs).
// 실제 브라우저는 ODDIN 허브가 관리한다(lib/browser.mjs) — 이 스크립트는 허브의 /api/browser/act 로 부탁만 한다.
// 작업마다 자기 탭을 쓴다(ODDIN_TASK = "작업/하위작업"). 사용자는 ODDIN 화면 "브라우저" 탭에서 실시간으로 보고 거들 수 있다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = 7700;
try { port = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_FILE || path.join(root, 'config.json'), 'utf8')).port || port; } catch {}
const HUB = (process.env.ODDIN_HUB || `http://127.0.0.1:${port}`).replace(/\/$/, '');
const OWNER = process.env.ODDIN_TASK || `cli-${process.pid}`;

const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const TOOLS = [
  ['browser_open', '주소를 연다(이 작업 전용 탭). 사용자가 ODDIN 화면에서 함께 본다. Open a URL in this task\'s tab.', S({ url: { type: 'string', description: '열 주소(https:// 생략 가능, 로컬 파일은 file:///)' } }, ['url'])],
  ['browser_read', '지금 페이지를 읽는다: 제목·주소·보이는 글(앞부분)·누를 수 있는 것 목록(번호 ref). 누르거나 입력하기 전에 먼저 부른다. Read page text and numbered interactive elements.', S()],
  ['browser_click', 'ref 번호(또는 x·y 좌표)를 누른다. Click element by ref (from browser_read) or coordinates.', S({ ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' } })],
  ['browser_type', '입력 칸(ref)에 글자를 넣는다. submit 이면 Enter. clear 면 기존 글을 지우고. Type text into an input.', S({ ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, clear: { type: 'boolean' } }, ['text'])],
  ['browser_press', '키 하나를 누른다: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, Space 등. Press a key.', S({ key: { type: 'string' } }, ['key'])],
  ['browser_scroll', '페이지를 굴린다(dy 픽셀, 위로는 음수). Scroll the page.', S({ dy: { type: 'number' } })],
  ['browser_screenshot', '지금 화면을 그림으로 본다(full 이면 페이지 전체). 디자인·배치 확인용. Take a screenshot.', S({ full: { type: 'boolean' } })],
  ['browser_eval', '페이지 안에서 자바스크립트 식을 실행해 값을 받는다. Evaluate a JS expression in the page.', S({ expression: { type: 'string' } }, ['expression'])],
  ['browser_back', '뒤로 간다. Go back.', S()],
  ['browser_reload', '새로 읽는다. Reload.', S()],
  ['browser_wait', '기다린다: text 가 보일 때까지(최대 ms) 또는 ms 만큼. Wait for text or time.', S({ text: { type: 'string' }, ms: { type: 'number' } })],
  ['browser_console', '이 탭의 콘솔 기록·오류·대화 상자를 본다. Console messages.', S()],
  ['browser_close', '이 작업의 탭을 닫는다(끝났을 때). Close this task\'s tab.', S()],
];

async function act(action, args) {
  const r = await fetch(`${HUB}/api/browser/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER, action, ...args }), signal: AbortSignal.timeout(120_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `ODDIN 허브가 ${r.status}로 답했어요`);
  return j;
}
function readText(s) {
  const lines = [`제목: ${s.title || '(없음)'}`, `주소: ${s.url}`, `스크롤: ${s.scroll?.y ?? 0} / ${s.scroll?.height ?? 0} (화면 높이 ${s.scroll?.view ?? 0})`, '', '# 보이는 글', s.text || '(글 없음)', s.textTruncated ? '…(뒤는 생략 — 스크롤하거나 browser_eval 로 더 보기)' : '', '', '# 누를 수 있는 것 (ref 번호로 browser_click·browser_type)'];
  for (const i of s.items || []) lines.push(`[${i.ref}] ${i.tag}${i.type ? `(${i.type})` : ''}${i.role ? ` role=${i.role}` : ''} "${i.name}"${i.href ? ` → ${i.href}` : ''}${i.inView ? '' : ' (화면 밖)'}`);
  return lines.join('\n');
}
async function call(name, args = {}) {
  const action = name.replace(/^browser_/, '');
  const r = await act(action === 'read' ? 'read' : action, args);
  if (action === 'read') return [{ type: 'text', text: readText(r) }];
  if (action === 'screenshot') return [{ type: 'image', data: r.image, mimeType: r.mimeType || 'image/png' }, { type: 'text', text: `${r.title || ''} — ${r.url || ''}` }];
  return [{ type: 'text', text: JSON.stringify(r) }];
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // 알림
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => out({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  try {
    if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oddin-browser', version: '1.0.0' }, instructions: 'ODDIN 이 관리하는 브라우저. 사용자가 ODDIN 화면에서 실시간으로 본다. browser_open → browser_read(번호 확인) → browser_click/browser_type 순서로 쓴다.' });
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: TOOLS.map(([name, description, inputSchema]) => ({ name, description, inputSchema })) });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (!TOOLS.some(([n]) => n === name)) return fail(-32602, `모르는 도구: ${name}`);
      try { return reply({ content: await call(name, msg.params?.arguments || {}) }); }
      catch (e) { return reply({ content: [{ type: 'text', text: `실패: ${e.message}` }], isError: true }); }
    }
    return fail(-32601, `지원하지 않는 요청: ${msg.method}`);
  } catch (e) { return fail(-32603, e.message); }
});
