// ODDIN 크롬 연결 (2026-10-08 사용자 "크롬에서 로그인한 화면을 쓰거나 하고 싶은데 확장프로그램으로 만들어서 코덱스나 클로드가 조작할 수 있게").
// 사용자가 평소 쓰는 크롬(로그인된 상태)에 ODDIN 확장(chrome-extension/)을 깔면, 확장이 이 허브에 붙어 CDP 명령을 받아
// chrome.debugger 로 실행한다. 작업자 도구(browser_*)·화면 "브라우저" 탭은 ODDIN 브라우저(lib/browser.mjs)와 같다 —
// BrowserManager 를 그대로 쓰고 명령을 보내는 길(send)만 바꿨다. 작업자는 browser_open 에 chrome:true 를 주면 여기로 온다.
//
//  확장 → 허브 (이 PC 에서만, 머리 X-Oddin-Ext·출처 chrome-extension://<EXT_ID> — lib/remote.mjs·isExtRequest)
//   POST /api/chrome-ext/hello  { instance, version, agent } → { hub }   다른 확장이 이미 붙어 있으면 409
//   POST /api/chrome-ext/poll   { instance, wait }           → { cmds }  명령 기다리기(롱 폴링)
//   POST /api/chrome-ext/result { instance, results, events } → { ok }
// 확장은 ODDIN 이 연 탭만 다루고, 쓸 수 있는 CDP 명령도 정해져 있다(chrome-extension/core.js ALLOWED).
import crypto from 'node:crypto';
import { BrowserManager } from './browser.mjs';

/** chrome-extension/manifest.json 의 key 로 정해지는 확장 id(어느 PC 에 깔아도 같다) */
export const EXT_ID = 'bbphnjmjmoneaomdoefgepngcjlmimgk';
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const ONLINE_MS = 45_000; // 명령 기다리기가 이만큼 안 오면 꺼진 것으로 본다
const NOT_CONNECTED = '크롬 확장이 연결돼 있지 않아요. 크롬에 ODDIN 확장을 깔고 켜 두세요(ODDIN 폴더의 chrome-extension, 안내 docs/chrome-extension.md)';
const error = (status, message) => Object.assign(new Error(message), { status });

/** 확장이 보낸 요청인지: 출처가 있으면 확장 출처여야 하고, 머리에 확장 id 가 있어야 한다(웹 페이지는 이 머리를 못 붙인다 — 사전 확인에서 막힘) */
export function isExtRequest(req) {
  const origin = req.headers.origin;
  return req.headers['x-oddin-ext'] === EXT_ID && (!origin || origin === EXT_ORIGIN);
}

export class ChromeExtBrowser extends BrowserManager {
  constructor({ now = () => Date.now(), ...opts } = {}) {
    super({ ...opts, headless: false });
    this.now = now;
    this.hub = crypto.randomBytes(8).toString('hex'); // 허브가 다시 켜졌는지 확장이 알아보는 표
    this.ext = null; // { instance, version, agent, lastSeen }
    this.queue = []; this.waiter = null;
    this.watch = setInterval(() => this.checkAlive(), 5000); this.watch.unref?.();
  }
  get running() { return !!(this.ext && this.now() - this.ext.lastSeen < ONLINE_MS); }
  state() {
    return { ...super.state(), browser: this.ext ? browserName(this.ext.agent) : null, headless: false,
      chrome: { connected: this.running, version: this.ext?.version || null, browser: this.ext ? browserName(this.ext.agent) : null } };
  }
  checkAlive() { if (this.ext && !this.running) { this.ext = null; this.drop(); } }
  /** 연결이 끊겼다: 기다리던 명령은 실패로, 탭 목록은 비운다 */
  drop() {
    this.queue = [];
    if (this.waiter) { clearTimeout(this.waiter.t); this.waiter.resolve([]); this.waiter = null; }
    this.close();
  }

  /* ---------- 확장 쪽 ---------- */
  hello(b = {}) {
    const instance = String(b.instance || '').slice(0, 80);
    if (!instance) throw error(400, 'instance 가 없어요');
    // 지금 명령을 기다리는(살아 있는) 다른 확장이 있으면 거절. 기다리는 게 없으면 같은 확장이 다시 켜진 것 — 넘겨받는다
    if (this.running && this.ext.instance !== instance && this.waiter) throw error(409,`다른 브라우저(${browserName(this.ext.agent)})의 ODDIN 확장이 이미 연결돼 있어요. 그쪽을 끄면 이어서 연결돼요`);
    const fresh = this.ext?.instance !== instance;
    if (fresh && this.tabs.size) this.drop(); // 확장이 다시 켜졌다 — 예전 탭 번호는 믿지 않는다
    this.ext = { instance, version: String(b.version || '').slice(0, 20), agent: String(b.agent || '').slice(0, 300), lastSeen: this.now() };
    this.record('크롬', 'connect', browserName(this.ext.agent));
    return { hub: this.hub };
  }
  mine(instance) {
    if (!this.ext || this.ext.instance !== instance) throw error(409, '먼저 hello 로 연결해 주세요');
    this.ext.lastSeen = this.now();
  }
  /** req 를 주면 확장 쪽이 끊겼을 때(서비스 워커가 꺼짐) 기다리기를 바로 거둔다 */
  poll(b = {}, req = null) {
    this.mine(String(b.instance || ''));
    if (this.queue.length) return Promise.resolve({ cmds: this.queue.splice(0) });
    if (this.waiter) { clearTimeout(this.waiter.t); this.waiter.resolve([]); }
    const waitMs = Math.min(Math.max(Number(b.wait) || 20, 0), 25) * 1000;
    return new Promise((resolve) => {
      const w = { resolve: (cmds) => resolve({ cmds }), t: null };
      w.t = setTimeout(() => { if (this.waiter === w) this.waiter = null; if (this.ext) this.ext.lastSeen = this.now(); w.resolve([]); }, waitMs);
      this.waiter = w;
      req?.on?.('close', () => { if (this.waiter === w) { this.waiter = null; clearTimeout(w.t); } });
    });
  }
  result(b = {}) {
    this.mine(String(b.instance || ''));
    for (const r of Array.isArray(b.results) ? b.results : []) {
      const w = this.wait.get(r?.id); if (!w) continue;
      this.wait.delete(r.id); clearTimeout(w.t);
      if (r.ok) w.resolve(r.result || {}); else w.reject(error(500, `크롬: ${String(r.error || '명령 실패').slice(0, 300)}`));
    }
    for (const ev of Array.isArray(b.events) ? b.events : []) if (ev && typeof ev.method === 'string') this.onEvent(ev);
    return { ok: true };
  }

  /* ---------- BrowserManager 가 쓰는 길 ---------- */
  async start() { if (!this.running) throw error(503, NOT_CONNECTED); }
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (!this.running) return Promise.reject(error(503, NOT_CONNECTED));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.wait.delete(id); reject(error(504, `크롬이 응답하지 않아요(${method})`)); }, timeoutMs);
      this.wait.set(id, { resolve, reject, t });
      this.queue.push({ id, method, params, ...(sessionId ? { tab: sessionId } : {}) });
      if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.t); w.resolve(this.queue.splice(0)); }
    });
  }
  /** 사용자 크롬은 끄지 않는다 — AI 탭만 닫는다 */
  async stop() {
    for (const t of [...this.tabs.values()]) await this.send('Target.closeTarget', { targetId: t.id }, undefined, 5000).catch(() => {});
    this.tabs.clear(); this.emit('event', { type: 'browser', ...this.state() });
  }
  dispose() { clearInterval(this.watch); this.drop(); }
}

function browserName(agent = '') {
  const m = /Edg\/(\d+)/.exec(agent) || null;
  if (m) return `Edge ${m[1]}`;
  const c = /Chrome\/(\d+)/.exec(agent);
  return c ? `크롬 ${c[1]}` : '크롬';
}
