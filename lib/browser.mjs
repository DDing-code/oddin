// ODDIN 브라우저 (2026-10-08 사용자 "브라우저 조작이 안되는 느낌" → 개선안 7번 "AI가 쓰는 브라우저를 오딘 화면에서 보기").
// ODDIN 이 직접 띄우고 관리하는 브라우저(Edge, 없으면 Chrome) 하나를 두 AI 작업자가 같이 쓴다.
// - 작업마다 자기 탭을 가진다(owner = "작업/하위작업"). 도구: 열기·읽기(누를 수 있는 것에 번호)·누르기·입력·키·스크롤·화면 찍기·스크립트·뒤로·새로고침·기다리기·콘솔.
// - 사용자는 ODDIN 화면의 "브라우저" 탭에서 실시간으로 보고(화면 찍기 반복), 눌러서·입력해서 직접 거들 수 있다(원격·폰 포함).
// - 프로필은 ODDIN 전용(data/browser-profile) — 사용자 Chrome 과 섞이지 않고, 한 번 로그인하면 유지된다.
// - 의존성 없이 Chrome DevTools 프로토콜(CDP)을 Node 22 기본 WebSocket 으로 쓴다. 디버깅 포트는 127.0.0.1 에만 열린다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './util.mjs';

const error = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANDIDATES = process.platform === 'win32'
  ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
export function findBrowser(custom) { return [custom, ...CANDIDATES].filter(Boolean).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null; }

// 페이지 안에서 돌리는 읽기 스크립트: 보이는 글(앞부분)과 누를 수 있는 것 목록(번호를 data-oddin-ref 로 붙임)
const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return null; const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return null; return r; };
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=option],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  let n = 0; const items = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = vis(el); if (!r) continue;
    if (r.bottom < -200 || r.top > innerHeight * 3) continue;
    const ref = String(++n); el.setAttribute('data-oddin-ref', ref);
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    items.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, role: el.getAttribute('role') || undefined, name, href: el.tagName === 'A' ? el.getAttribute('href')?.slice(0, 120) : undefined, inView: r.top >= 0 && r.bottom <= innerHeight });
    if (items.length >= 200) break;
  }
  const text = (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, 8000), textTruncated: text.length > 8000, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight }, items };
})()`;
const POINT_JS = (ref) => `(() => { const el = document.querySelector('[data-oddin-ref="${String(ref).replace(/[^0-9]/g, '')}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 60) }; })()`;
const FOCUS_JS = (ref) => `(() => { const el = document.querySelector('[data-oddin-ref="${String(ref).replace(/[^0-9]/g, '')}"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); if ('select' in el && /^(input|textarea)$/i.test(el.tagName)) el.select(); return true; })()`;
const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' '] };

/** 열 주소 다듬기: 스킴이 없으면 https://, 브라우저 내부 주소(chrome:·edge:·devtools: 등)는 막는다 */
export function normalizeUrl(raw) {
  let url = String(raw || '').trim(); if (!url) throw error(400, '열 주소를 적어 주세요');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^localhost:\d/i.test(url)) url = `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url) ? 'http' : 'https'}://${url}`;
  if (!/^(https?|file|about|data):/i.test(url)) throw error(400, '이 주소는 열 수 없어요');
  return url;
}

export class BrowserManager extends EventEmitter {
  constructor({ exe = null, profile = path.join(DATA_DIR, 'browser-profile'), headless = true, width = 1280, height = 860 } = {}) {
    super();
    this.exe = exe; this.profile = profile; this.headless = headless; this.width = width; this.height = height;
    this.proc = null; this.ws = null; this.seq = 0; this.wait = new Map(); this.tabs = new Map(); this.log = []; this.starting = null; this.frames = new Map();
  }
  get running() { return !!(this.ws && this.ws.readyState === 1); }
  state() {
    return { running: this.running, browser: this.exe ? path.basename(this.exe) : null, headless: this.headless,
      tabs: [...this.tabs.values()].map((t) => ({ id: t.id, owner: t.owner, title: t.title, url: t.url, at: t.at, user: !!t.user })), log: this.log.slice(-60) };
  }
  record(owner, action, detail = '') {
    const e = { at: new Date().toISOString(), owner, action, detail: String(detail).slice(0, 200) };
    this.log.push(e); if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.emit('event', { type: 'browser', ...this.state(), last: e });
  }

  /* ---------- 띄우기·연결 ---------- */
  async start() {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const exe = findBrowser(this.exe);
      if (!exe) throw error(500, 'Edge나 Chrome을 찾지 못했어요. 둘 중 하나를 설치해 주세요');
      this.exe = exe;
      fs.mkdirSync(this.profile, { recursive: true });
      const portFile = path.join(this.profile, 'DevToolsActivePort');
      // ODDIN 이 다시 켜졌는데 전에 띄운 브라우저가 아직 살아 있으면(같은 프로필은 한 번에 하나만 뜬다) 그걸 다시 쓴다 — 예전 탭은 닫는다
      try {
        const [oldPort] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        const v = await fetch(`http://127.0.0.1:${oldPort}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
        if (v?.webSocketDebuggerUrl) {
          await this.connect(v.webSocketDebuggerUrl);
          await this.send('Target.setDiscoverTargets', { discover: true });
          const { targetInfos = [] } = await this.send('Target.getTargets');
          const pages = targetInfos.filter((x) => x.type === 'page');
          for (const pg of pages.slice(1)) await this.send('Target.closeTarget', { targetId: pg.targetId }).catch(() => {});
          return;
        }
      } catch {}
      try { fs.rmSync(portFile, { force: true }); } catch {}
      const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=Translate,msEdgeSidebarV2,msUndersideButton', `--window-size=${this.width},${this.height}`, ...(this.headless ? ['--headless=new', '--hide-scrollbars'] : []), 'about:blank'];
      this.proc = spawn(exe, args, { stdio: 'ignore', windowsHide: this.headless });
      this.proc.on('exit', () => { this.proc = null; this.close(); });
      let info = null;
      for (let i = 0; i < 100 && !info; i++) { await sleep(100); try { const [port, p] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/); if (port && p) info = { port, p }; } catch {} }
      if (!info) { try { this.proc?.kill(); } catch {} throw error(500, '브라우저가 켜지지 않았어요'); }
      await this.connect(`ws://127.0.0.1:${info.port}${info.p}`);
      await this.send('Target.setDiscoverTargets', { discover: true });
      // 처음 뜬 빈 탭은 닫지 않고 남겨 둔다(사용자 탭으로 쓰지 않음)
    })().finally(() => { this.starting = null; });
    return this.starting;
  }
  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(error(500, '브라우저에 연결하지 못했어요'));
      ws.onclose = () => { if (this.ws === ws) this.close(); };
      ws.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.id && this.wait.has(msg.id)) { const w = this.wait.get(msg.id); this.wait.delete(msg.id); clearTimeout(w.t); return msg.error ? w.reject(error(500, msg.error.message || '브라우저 명령 실패')) : w.resolve(msg.result || {}); }
        this.onEvent(msg);
      };
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (!this.running) return Promise.reject(error(503, '브라우저가 꺼져 있어요'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.wait.delete(id); reject(error(504, `브라우저가 응답하지 않아요(${method})`)); }, timeoutMs);
      this.wait.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  onEvent(msg) {
    const p = msg.params || {};
    if (msg.method === 'Target.targetInfoChanged' || msg.method === 'Target.targetCreated') {
      // 페이지가 바뀌면(누르기로 넘어감 등) 제목·주소를 고치고 화면에 알린다(잦으면 0.2초에 한 번)
      const t = this.tabs.get(p.targetInfo?.targetId);
      if (t && (t.title !== p.targetInfo.title || t.url !== p.targetInfo.url)) { t.title = p.targetInfo.title; t.url = p.targetInfo.url; this.bump(); }
    } else if (msg.method === 'Target.targetDestroyed') {
      if (this.tabs.delete(p.targetId)) this.emit('event', { type: 'browser', ...this.state() });
    } else if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
      const t = [...this.tabs.values()].find((x) => x.session === msg.sessionId); if (!t) return;
      const text = msg.method === 'Runtime.exceptionThrown' ? `오류: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''}` : `${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`;
      t.console.push(text.slice(0, 400)); if (t.console.length > 100) t.console.shift();
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // 대화 상자(alert·confirm)는 페이지를 멈추게 한다 — 받아들이고 기록
      this.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId).catch(() => {});
      const t = [...this.tabs.values()].find((x) => x.session === msg.sessionId); if (t) t.console.push(`대화 상자(${p.type}): ${p.message}`.slice(0, 400));
    }
  }
  bump() { if (this.bumpT) return; this.bumpT = setTimeout(() => { this.bumpT = null; this.emit('event', { type: 'browser', ...this.state() }); }, 200); }
  close() {
    for (const w of this.wait.values()) { clearTimeout(w.t); w.reject(error(503, '브라우저가 닫혔어요')); }
    this.wait.clear(); this.tabs.clear(); this.frames.clear();
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.emit('event', { type: 'browser', ...this.state() });
  }
  /** 브라우저를 끈다 — 프로세스가 정말 끝날 때까지(최대 5초) 기다린다(프로필 폴더를 바로 지울 수 있게) */
  async stop() {
    const proc = this.proc;
    const exited = proc ? new Promise((r) => { if (proc.exitCode != null) r(); else proc.once('exit', r); }) : null;
    try { await this.send('Browser.close', {}, undefined, 5000); } catch {}
    if (exited) await Promise.race([exited, sleep(5000)]);
    try { if (proc && proc.exitCode == null) proc.kill(); } catch {}
    this.close();
  }

  /* ---------- 탭 ---------- */
  async tabOf(owner, { create = true } = {}) {
    await this.start();
    let t = [...this.tabs.values()].find((x) => x.owner === owner);
    if (t || !create) return t || null;
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', newWindow: false });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    t = { id: targetId, session: sessionId, owner, title: '', url: 'about:blank', at: new Date().toISOString(), console: [], user: String(owner).startsWith('user') };
    this.tabs.set(targetId, t);
    await Promise.all(['Page.enable', 'Runtime.enable'].map((m) => this.send(m, {}, sessionId)));
    await this.send('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false }, sessionId).catch(() => {});
    this.emit('event', { type: 'browser', ...this.state() });
    return t;
  }
  byId(id) { const t = this.tabs.get(id); if (!t) throw error(404, '그 탭을 찾지 못했어요'); return t; }
  async evaluate(t, expression, timeoutMs = 20_000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t.session, timeoutMs);
    if (r.exceptionDetails) throw error(400, `페이지 스크립트 오류: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async settle(t, ms = 8000) {
    // 페이지가 다 읽힐 때까지(최대 ms) — document.readyState 가 complete 이고 잠깐 조용하면
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { if ((await this.evaluate(t, 'document.readyState', 3000)) === 'complete') break; } catch {}
      await sleep(150);
    }
    await sleep(250);
    try { const info = await this.evaluate(t, '({ url: location.href, title: document.title })', 3000); t.url = info.url; t.title = info.title; } catch {}
  }
  async mouse(t, x, y, { button = 'left', clickCount = 1 } = {}) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount }, t.session);
  }
  /** 키 하나(또는 "Control+a" 같은 조합)를 누른다 */
  async key(t, combo) {
    const parts = String(combo).split('+'); let name = parts.pop();
    if (name === '' && parts.length) { parts.pop(); name = '+'; } // "Control++" 처럼 + 자체
    const MOD = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };
    let modifiers = 0; for (const m of parts) { const v = MOD[m.toLowerCase()]; if (!v) throw error(400, `모르는 키예요: ${combo}`); modifiers |= v; }
    if (name === ' ') name = 'Space';
    const k = KEYS[name] || (name.length === 1 ? [name.toUpperCase().charCodeAt(0), name] : null);
    if (!k) throw error(400, `모르는 키예요: ${combo}`);
    const [vk, text] = k, key = name === 'Space' ? ' ' : name;
    const code = KEYS[name] ? name : /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : /^[0-9]$/.test(name) ? `Digit${name}` : undefined;
    const typed = text && !(modifiers & 7); // Ctrl·Alt·Meta 를 같이 누르면 글자를 넣지 않는다(단축키)
    await this.send('Input.dispatchKeyEvent', { type: typed ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(typed ? { text: modifiers & 8 ? text.toUpperCase() : text } : {}) }, t.session);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers }, t.session);
  }
  async shot(t, { full = false, quality = 70, format = 'jpeg' } = {}) {
    const params = { format, ...(format === 'jpeg' ? { quality } : {}) };
    if (full) { const m = await this.send('Page.getLayoutMetrics', {}, t.session); const h = Math.min(Math.ceil(m.cssContentSize?.height || m.contentSize?.height || this.height), 6000); params.clip = { x: 0, y: 0, width: this.width, height: h, scale: 1 }; params.captureBeyondViewport = true; }
    const r = await this.send('Page.captureScreenshot', params, t.session, 30_000);
    return Buffer.from(r.data, 'base64');
  }
  /** 화면 탭의 실시간 보기용 그림(너무 자주 찍지 않게 잠깐 저장) */
  async frame(id) {
    const t = this.byId(id), hit = this.frames.get(id);
    if (hit && Date.now() - hit.at < 250) return hit.buf;
    const buf = await this.shot(t, { quality: 55 });
    this.frames.set(id, { at: Date.now(), buf });
    return buf;
  }

  /* ---------- 작업자 도구 ---------- */
  async act(owner, b = {}) {
    const action = String(b.action || '');
    const t = action === 'tabs' ? null : await this.tabOf(owner);
    const say = (detail) => this.record(owner, action, detail);
    switch (action) {
      case 'open': {
        const url = normalizeUrl(b.url);
        const r = await this.send('Page.navigate', { url }, t.session, 30_000);
        if (r.errorText) throw error(400, `열지 못했어요: ${r.errorText}`);
        await this.settle(t); say(url);
        return { url: t.url, title: t.title };
      }
      case 'read': case 'snapshot': { const s = await this.evaluate(t, SNAPSHOT_JS); t.url = s.url; t.title = s.title; say(s.url); return s; }
      case 'click': {
        let x = Number(b.x), y = Number(b.y), what = `(${x}, ${y})`;
        if (b.ref != null) { const p = await this.evaluate(t, POINT_JS(b.ref)); if (!p) throw error(404, `번호 ${b.ref}를 찾지 못했어요. 먼저 read 로 다시 읽어 주세요`); x = p.x; y = p.y; what = `${b.ref}번 ${p.tag} "${p.name}"`; await sleep(120); }
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw error(400, 'ref 또는 x·y 를 주세요');
        await this.mouse(t, x, y, { clickCount: b.double ? 2 : 1 }); await this.settle(t, 4000); say(what);
        return { url: t.url, title: t.title, clicked: what };
      }
      case 'type': {
        if (b.ref != null && !(await this.evaluate(t, FOCUS_JS(b.ref)))) throw error(404, `번호 ${b.ref}를 찾지 못했어요. 먼저 read 로 다시 읽어 주세요`);
        if (b.clear) { await this.key(t, 'Control+a'); await this.key(t, 'Backspace'); }
        await this.send('Input.insertText', { text: String(b.text ?? '') }, t.session);
        if (b.submit) { await this.key(t, 'Enter'); await this.settle(t, 6000); }
        say(`${b.ref != null ? b.ref + '번에 ' : ''}"${String(b.text ?? '').slice(0, 40)}"${b.submit ? ' + Enter' : ''}`);
        return { url: t.url, title: t.title };
      }
      case 'press': { await this.key(t, String(b.key || '')); await this.settle(t, 2500); say(b.key); return { url: t.url, title: t.title }; }
      case 'scroll': { const dy = Number(b.dy ?? 600); await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.width / 2, y: this.height / 2, deltaX: 0, deltaY: dy }, t.session); await sleep(250); say(`${dy}`); return { ok: true }; }
      case 'screenshot': { const buf = await this.shot(t, { full: !!b.full, format: 'png' }); say(b.full ? '전체' : '보이는 부분'); return { image: buf.toString('base64'), mimeType: 'image/png', url: t.url, title: t.title }; }
      case 'eval': { const value = await this.evaluate(t, String(b.expression || 'undefined')); say(String(b.expression).slice(0, 60)); return { value }; }
      case 'back': case 'forward': { await this.evaluate(t, `history.${action}()`); await this.settle(t, 5000); say(''); return { url: t.url, title: t.title }; }
      case 'reload': { await this.send('Page.reload', {}, t.session); await this.settle(t); say(''); return { url: t.url, title: t.title }; }
      case 'wait': {
        const until = Date.now() + Math.min(Number(b.ms || 3000), 60_000);
        if (b.text) { while (Date.now() < until) { if ((await this.evaluate(t, `document.body?.innerText?.includes(${JSON.stringify(String(b.text))})`).catch(() => false))) { say(`"${b.text}" 보임`); return { found: true }; } await sleep(300); } say(`"${b.text}" 못 찾음`); return { found: false }; }
        await sleep(until - Date.now()); say(`${b.ms}ms`); return { ok: true };
      }
      case 'console': return { console: t.console.slice(-50) };
      case 'tabs': return this.state();
      case 'close': { await this.send('Target.closeTarget', { targetId: t.id }); this.tabs.delete(t.id); say(''); this.emit('event', { type: 'browser', ...this.state() }); return { ok: true }; }
      default: throw error(400, `모르는 동작이에요: ${action}`);
    }
  }

  /* ---------- 사용자가 화면에서 직접 ---------- */
  async input(id, b = {}) {
    if (b.type === 'open') normalizeUrl(b.url); // 잘못된 주소면 빈 탭을 만들기 전에 거절
    const t = id === 'new' ? await this.tabOf(`user-${Date.now()}`) : this.byId(id);
    if (b.type === 'click') await this.mouse(t, Number(b.x), Number(b.y));
    else if (b.type === 'text') await this.send('Input.insertText', { text: String(b.text || '') }, t.session);
    else if (b.type === 'key') await this.key(t, String(b.key || ''));
    else if (b.type === 'scroll') await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(b.x ?? this.width / 2), y: Number(b.y ?? this.height / 2), deltaX: 0, deltaY: Number(b.dy || 400) }, t.session);
    else if (b.type === 'open') { const url = normalizeUrl(b.url); await this.send('Page.navigate', { url }, t.session); await this.settle(t, 6000); }
    else if (b.type === 'back' || b.type === 'forward') { await this.evaluate(t, `history.${b.type}()`).catch(() => {}); await this.settle(t, 4000); }
    else if (b.type === 'reload') { await this.send('Page.reload', {}, t.session); await this.settle(t, 6000); }
    else if (b.type === 'close') { await this.send('Target.closeTarget', { targetId: t.id }); this.tabs.delete(t.id); }
    else throw error(400, '모르는 입력이에요');
    this.frames.delete(t.id);
    this.record('사용자', b.type, b.type === 'text' ? '' : b.type === 'open' ? b.url : b.type === 'key' ? b.key : '');
    return { id: t.id, url: t.url, title: t.title };
  }
}
