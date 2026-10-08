// 크롬 연결 실제 확인: 시험 허브(임시 폴더·빈 포트) + 진짜 Edge/Chrome(임시 프로필, 확장 로드) → 작업자 동작이 확장을 거쳐 실행되는지.
// node scripts/check-chrome-ext.mjs [edge|chrome] [headful]  (정식 크롬 137+ 은 명령줄 확장 로드를 막아서 edge 로 확인)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXT_ID } from '../lib/chrome-ext.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const which = process.argv[2] || 'edge', headful = process.argv.includes('headful');
const exe = which === 'chrome' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oddin-chrome-e2e-'));
const port = await freePort();
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ ...cfg, port, browser: { ...(cfg.browser || {}), oddin: false } }));
const env = { ...process.env, HUB_PORT: String(port), HUB_DATA_DIR: path.join(tmp, 'data'), HUB_RUNS_DIR: path.join(tmp, 'runs'), HUB_CONFIG_FILE: path.join(tmp, 'config.json'), HUB_SKIP_CLI_INSTALL: '1' };
const server = spawn(process.execPath, [path.join(root, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let serverLog = ''; server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
const hub = `http://127.0.0.1:${port}`;
const api = async (p, body) => { const r = await fetch(hub + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} ${r.status} ${j.error}`); return j; };
let browser = null;
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? '통과' : '실패'}  ${name}${extra ? ` — ${extra}` : ''}`); };
try {
  let up = false; for (let i = 0; i < 150 && !up; i++) { try { await api('/api/ui-version'); up = true; } catch { await sleep(200); } }
  check('시험 허브 켜짐', up, hub);
  const prof = path.join(tmp, 'profile');
  browser = spawn(exe, [`--user-data-dir=${prof}`, `--load-extension=${path.join(root, 'chrome-extension')}`, `--disable-extensions-except=${path.join(root, 'chrome-extension')}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...(headful ? ['--window-position=40,40'] : ['--headless=new']), 'about:blank'], { stdio: 'ignore' });
  let dt = null;
  for (let i = 0; i < 100 && !dt; i++) { await sleep(150); try { const [p, w] = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split(/\r?\n/); if (p && w) dt = p; } catch {} }
  if (!dt) throw new Error('브라우저 디버깅 포트를 못 찾음');
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) { await sleep(250); const list = await fetch(`http://127.0.0.1:${dt}/json/list`).then((r) => r.json()); sw = list.find((t) => t.url.startsWith(`chrome-extension://${EXT_ID}/`)); }
  check('확장이 로드됨(고정 id)', !!sw, sw?.url || '확장 대상 없음 — 이 브라우저는 --load-extension 을 안 받을 수 있음');
  if (!sw) throw new Error('확장 없음');
  // 팝업 페이지를 열어 포트를 시험 허브로 바꾼다(실제 팝업 경로)
  const page = await fetch(`http://127.0.0.1:${dt}/json/new?chrome-extension://${EXT_ID}/popup.html`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const wait = new Map(); ws.onmessage = (m) => { const x = JSON.parse(m.data); wait.get(x.id)?.(x); };
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await sleep(500);
  const setPort = await cdp('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({ type: 'port', port: ${port} }).then((r) => JSON.stringify(r))`, awaitPromise: true, returnByValue: true });
  check('팝업에서 포트 저장', /"ok":true/.test(setPort.result?.result?.value || ''), setPort.result?.result?.value?.slice(0, 120));
  let st = null;
  for (let i = 0; i < 80; i++) { st = await api('/api/browser'); if (st.chrome?.connected) break; await sleep(250); }
  check('허브에 크롬 연결됨', !!st.chrome?.connected, JSON.stringify(st.chrome));
  const t0 = Date.now();
  const open = await api('/api/browser/act', { owner: 'e2e/t1', action: 'open', url: 'https://example.com', chrome: true });
  check('chrome:true 로 열기', /Example Domain/.test(open.title), `${open.title} ${Date.now() - t0}ms`);
  const read = await api('/api/browser/act', { owner: 'e2e/t1', action: 'read' });
  check('읽기', /This domain is for use/.test(read.text) && read.items.length > 0, `누를 것 ${read.items.length}개`);
  const shot = await api('/api/browser/act', { owner: 'e2e/t1', action: 'screenshot' });
  const png = Buffer.from(shot.image, 'base64');
  check('화면 찍기', png.subarray(1, 4).toString() === 'PNG' && png.length > 2000, `${png.length} bytes`);
  fs.writeFileSync(path.join(tmp, 'shot.png'), png);
  const st2 = await api('/api/browser');
  check('화면 상태에 크롬 탭(where)', st2.tabs.some((t) => t.where === 'chrome' && t.owner === 'e2e/t1' && /example/.test(t.url)), JSON.stringify(st2.tabs.map((t) => [t.where, t.title])));
  const frame = await fetch(`${hub}/api/browser/frame?tab=${encodeURIComponent(st2.tabs[0].id)}`);
  check('실시간 보기 그림', frame.ok && (await frame.arrayBuffer()).byteLength > 1000);
  const ref = read.items.find((x) => x.tag === 'a')?.ref;
  const click = await api('/api/browser/act', { owner: 'e2e/t1', action: 'click', ref });
  check('누르기(링크 이동)', /iana/i.test(click.url), click.url);
  const ev = await api('/api/browser/act', { owner: 'e2e/t1', action: 'eval', expression: 'navigator.webdriver' });
  console.log('   참고: navigator.webdriver =', ev.value);
  // 허용하지 않는 명령은 확장이 막는다 — 허브를 거치지 않고 확장 본체에 직접 물어볼 수는 없으니 탭 개수만 확인
  await api('/api/browser/act', { owner: 'e2e/t2', action: 'open', url: 'about:blank', chrome: true });
  check('다른 작업은 새 탭', (await api('/api/browser')).tabs.filter((t) => t.where === 'chrome').length === 2);
  await api('/api/browser/act', { owner: 'e2e/t1', action: 'close' });
  await api('/api/browser/act', { owner: 'e2e/t2', action: 'close' });
  check('닫기', (await api('/api/browser')).tabs.length === 0);
  // 웹 페이지 출처로는 확장 길을 못 쓴다
  const evil = await fetch(`${hub}/api/chrome-ext/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Oddin-Ext': EXT_ID }, body: '{}' });
  check('다른 출처 거절', evil.status === 403, String(evil.status));
  ws.close();
} catch (e) {
  check('예외 없이 끝남', false, e.message);
} finally {
  try { browser?.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(800);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n실패 ${failed}개 · 서버 기록 끝:\n${serverLog.slice(-1500)}` : `\n모두 통과 (${results.length}개) · 화면 그림 ${path.join(tmp, 'shot.png')}`);
  fs.writeFileSync(path.join(tmp, 'server.log'), serverLog); process.exitCode = failed ? 1 : 0; setTimeout(() => process.exit(), 300);
}
