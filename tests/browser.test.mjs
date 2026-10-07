// 작업자 브라우저(2026-10-06 Claude in Chrome → 2026-10-08 ODDIN 브라우저):
// - ODDIN 이 띄우는 브라우저 도구(MCP)를 두 작업자에 붙인다(Claude --mcp-config, Codex -c mcp_servers.oddin_browser.*)
// - Claude in Chrome(--chrome)은 ODDIN 브라우저가 꺼졌거나 claudeChrome:true 일 때만
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../lib/workers.mjs';
import { browserOn, oddinBrowserOn } from '../lib/jobs.mjs';
import { catalogText } from '../lib/router.mjs';
import { codexBrowserArgs } from '../lib/native-workers.mjs';
import { buildWorkerPrompt, BROWSER_RULE } from '../lib/planner.mjs';
import { BrowserManager, findBrowser, normalizeUrl } from '../lib/browser.mjs';
import { freePort } from './_port.mjs';

const fixture = fileURLToPath(new URL('./fixtures/intercept-cli.mjs', import.meta.url));
const mcpScript = fileURLToPath(new URL('../scripts/oddin-browser-mcp.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-browser-'));
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {} }); // 브라우저 프로필은 꺼진 뒤에도 잠깐 잠겨 있을 수 있다

let n = 0;
async function argsOf(extra) {
  const key = `run-${++n}`, runDir = path.join(dir, key), cap = path.join(dir, `cap-${key}.jsonl`);
  const h = runWorker({ tool: 'claude', prompt: '시험', cwd: dir, runDir, ...extra, toolCfg: { command: `"${process.execPath}" "${fixture}" --tool claude --capture "${cap}"`, transport: 'native', shell: true }, settings: {}, timeoutMs: 15_000, ackTimeoutMs: 2000, onEvent() {} });
  const file = path.join(runDir, 'attempt-1', 'invocation.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  const inv = JSON.parse(fs.readFileSync(file, 'utf8'));
  h.cancel(); await h.promise.catch(() => {}); h.close?.();
  await new Promise((r) => setTimeout(r, 300)); // 가짜 CLI 가 끝나고 폴더를 놓을 때까지
  return { args: inv.args, runDir };
}

test('Claude 작업자: browser 를 켜면 --chrome, 끄면 없음', async () => {
  assert.ok((await argsOf({ browser: true })).args.includes('--chrome'));
  assert.ok(!(await argsOf({ browser: false })).args.includes('--chrome'));
});

test('Claude 작업자: ODDIN 브라우저 도구를 --mcp-config 파일로 붙인다', async () => {
  const tool = { command: process.execPath, args: [mcpScript], env: { ODDIN_TASK: 'j1/t1', ODDIN_HUB: 'http://127.0.0.1:7700' } };
  const { args } = await argsOf({ browserTool: tool });
  const i = args.indexOf('--mcp-config'); assert.ok(i > 0, '--mcp-config 가 있어야 해요');
  const file = args[i + 1].replace(/^"|"$/g, '');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(cfg.mcpServers['oddin-browser'], { type: 'stdio', ...tool });
  assert.ok(!(await argsOf({})).args.includes('--mcp-config'));
});

test('Codex 작업자: -c mcp_servers.oddin_browser.* 덮어쓰기(TOML 작은따옴표, 역슬래시 그대로)', () => {
  assert.deepEqual(codexBrowserArgs(null), []);
  const out = codexBrowserArgs({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['F:\\허브\\scripts\\oddin-browser-mcp.mjs'], env: { ODDIN_TASK: "j1/t'1" } });
  assert.deepEqual(out, ['-c', "mcp_servers.oddin_browser.command='C:\\Program Files\\nodejs\\node.exe'", '-c', "mcp_servers.oddin_browser.args=['F:\\허브\\scripts\\oddin-browser-mcp.mjs']", '-c', "mcp_servers.oddin_browser.env.ODDIN_TASK='j1/t1'"]);
});

test('설정: ODDIN 브라우저가 기본, Claude in Chrome 은 따로 켤 때만 · 플래너 안내도 같이', () => {
  assert.equal(oddinBrowserOn({}), true);
  assert.equal(oddinBrowserOn({ browser: { oddin: false } }), false);
  assert.equal(browserOn({}), false);
  assert.equal(browserOn({ browser: { claudeChrome: true } }), true);
  assert.equal(browserOn({ browser: { oddin: false } }), true); // ODDIN 브라우저를 끄면 예전처럼 Claude in Chrome
  assert.equal(browserOn({ browser: { oddin: false, claudeChrome: false } }), false);
  const base = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.match(catalogText(base), /ODDIN 브라우저 도구/);
  assert.doesNotMatch(catalogText({ ...base, browser: { oddin: false, claudeChrome: false } }), /브라우저: 두 작업자 모두/);
});

test('작업 지시문: 브라우저 도구를 붙였을 때만 사용 규칙을 넣는다', () => {
  const job = { id: 'j1', cwd: 'D:/x', goal: '사이트 확인', input: '사이트 확인', tasks: [], mode: 'auto', settings: {} };
  const task = { id: 't1', assignee: 'codex', title: '확인', prompt: '확인해', dependsOn: [] };
  const base = { job, task, depResults: [], siblings: [task], hubDir: 'H', memoryCtx: '' };
  assert.ok(buildWorkerPrompt({ ...base, browserTools: true }).includes(BROWSER_RULE));
  assert.ok(!buildWorkerPrompt(base).includes('browser_open'));
});

test('주소 다듬기: 스킴 없으면 https, localhost 는 http, 브라우저 내부 주소는 막음', () => {
  assert.equal(normalizeUrl('wowhead.com'), 'https://wowhead.com');
  assert.equal(normalizeUrl('localhost:3002/a'), 'http://localhost:3002/a');
  assert.equal(normalizeUrl('127.0.0.1:7700'), 'http://127.0.0.1:7700');
  assert.equal(normalizeUrl('file:///C:/x.html'), 'file:///C:/x.html');
  for (const bad of ['chrome://settings', 'edge://flags', 'devtools://x', 'javascript:alert(1)', '']) assert.throws(() => normalizeUrl(bad));
});

test('MCP 도구 서버: 시작 인사·도구 목록·호출이 허브 /api/browser/act 로 간다', async () => {
  const seen = [];
  const hub = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const b = JSON.parse(body || '{}'); seen.push({ path: req.url, ...b });
      const reply = (code, x) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(x)); };
      if (b.action === 'read') return reply(200, { url: 'https://a.test/', title: '시험 페이지', text: '안녕', scroll: { y: 0, height: 900, view: 860 }, items: [{ ref: '1', tag: 'button', name: '확인', inView: true }] });
      if (b.action === 'screenshot') return reply(200, { image: 'aGk=', mimeType: 'image/png', url: 'https://a.test/', title: '시험 페이지' });
      if (b.action === 'eval') return reply(400, { error: '페이지 스크립트 오류: 없음' });
      reply(200, { ok: true });
    });
  });
  const port = await freePort(); await new Promise((r) => hub.listen(port, '127.0.0.1', r));
  const child = spawn(process.execPath, [mcpScript], { env: { ...process.env, ODDIN_HUB: `http://127.0.0.1:${port}`, ODDIN_TASK: 'j9/t2' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(); let buf = '';
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => { const k = ++id; waiting.set(k, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'oddin-browser');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_close']) assert.ok(names.includes(n), n);
    const read = await rpc('tools/call', { name: 'browser_read', arguments: {} });
    assert.match(read.result.content[0].text, /\[1\] button "확인"/);
    const shot = await rpc('tools/call', { name: 'browser_screenshot', arguments: {} });
    assert.deepEqual(shot.result.content[0], { type: 'image', data: 'aGk=', mimeType: 'image/png' });
    await rpc('tools/call', { name: 'browser_click', arguments: { ref: '1' } });
    const bad = await rpc('tools/call', { name: 'browser_eval', arguments: { expression: 'x' } });
    assert.equal(bad.result.isError, true); assert.match(bad.result.content[0].text, /페이지 스크립트 오류/);
    const unknown = await rpc('tools/call', { name: 'rm_rf', arguments: {} });
    assert.ok(unknown.error);
    assert.ok(seen.every((s) => s.path === '/api/browser/act' && s.owner === 'j9/t2'));
    assert.deepEqual(seen.map((s) => s.action), ['read', 'screenshot', 'click', 'eval']);
    assert.equal(seen[2].ref, '1');
  } finally { child.kill(); hub.close(); }
});

test('브라우저 관리자: 실제 Edge/Chrome 으로 열기·읽기·입력·누르기·화면·사용자 탭', { skip: !findBrowser() && '이 PC에 Edge·Chrome 이 없어요', timeout: 90_000 }, async () => {
  const profile = path.join(dir, 'profile');
  const m = new BrowserManager({ profile, headless: true, width: 800, height: 600 });
  const events = []; m.on('event', (e) => events.push(e));
  try {
    const html = '<title>시험</title><input id=q placeholder="이름"><button onclick="document.title=\'눌림:\'+q.value">확인</button>';
    const opened = await m.act('j1/t1', { action: 'open', url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    assert.equal(opened.title, '시험');
    const page = await m.act('j1/t1', { action: 'read' });
    const input = page.items.find((i) => i.tag === 'input'), button = page.items.find((i) => i.tag === 'button');
    assert.ok(input && button, '입력 칸과 단추가 목록에 있어야 해요');
    await m.act('j1/t1', { action: 'type', ref: input.ref, text: '오딘' });
    await m.act('j1/t1', { action: 'click', ref: button.ref });
    assert.equal((await m.act('j1/t1', { action: 'eval', expression: 'document.title' })).value, '눌림:오딘');
    await m.act('j1/t1', { action: 'type', ref: input.ref, text: '새 글', clear: true });
    assert.equal((await m.act('j1/t1', { action: 'eval', expression: 'q.value' })).value, '새 글');
    const shot = await m.act('j1/t1', { action: 'screenshot' });
    assert.equal(Buffer.from(shot.image, 'base64').subarray(1, 4).toString(), 'PNG');
    const tab = m.state().tabs.find((t) => t.owner === 'j1/t1');
    const frame = await m.frame(tab.id);
    assert.equal(frame[0], 0xff); assert.equal(frame[1], 0xd8); // JPEG
    // 사용자: 그 탭을 누르고 새 탭을 연다
    await m.input(tab.id, { type: 'key', key: 'Tab' });
    const mine = await m.input('new', { type: 'open', url: 'about:blank' });
    const st = m.state();
    assert.equal(st.tabs.length, 2);
    assert.equal(st.tabs.find((t) => t.id === mine.id).user, true);
    await assert.rejects(m.input(tab.id, { type: 'open', url: 'chrome://settings' }));
    assert.ok(st.log.some((e) => e.owner === '사용자'));
    assert.ok(events.some((e) => e.type === 'browser' && e.last?.action === 'click'));
    await m.act('j1/t1', { action: 'close' });
    assert.equal(m.state().tabs.length, 1);
  } finally { await m.stop(); }
});
