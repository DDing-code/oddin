// ODDIN 어도비 연결 (2026-10-05 사용자 "따로 만든 애프터이펙트/프리미어 플러그인을 합쳐서 새로 만들어줘. 가운데 오딘 로고랑 연결 상황 여부만")
// 프리미어·애프터이펙트 안의 ODDIN 플러그인(adobe/ 폴더)이 이 허브에 붙어 명령을 기다리고, 작업자(Claude·Codex)는
// 허브 API(또는 scripts/adobe.mjs)로 ExtendScript 를 보내 결과를 받는다. 집 PC의 연결 패널(API로 프로젝트 조작)과
// 회사 PC DDstudio(화면 없이 명령으로 제어하는 워커)의 공통 부분 — "앱 안에서 스크립트를 실행하고 결과를 돌려준다" — 만 남겼다.
//
//  플러그인 → 허브
//   POST /api/adobe/hello  { app, instance, version, appVersion, project, role }  자기 소개(앱이 켜질 때·프로젝트가 바뀔 때)
//   GET  /api/adobe/next?app=&instance=&wait=25                                  명령 기다리기(롱 폴링). { cmd } 또는 { cmd: null }
//   POST /api/adobe/result { id, ok, result, error }                              명령 결과
//  작업자 → 허브
//   GET  /api/adobe/status                                                        연결된 앱 목록
//   POST /api/adobe/run    { app, script | file, timeoutSeconds }                 실행하고 결과까지 기다림
import crypto from 'node:crypto';

export const APPS = { premiere: '프리미어', aftereffects: '애프터이펙트' };
const ALIAS = { premiere: 'premiere', ppro: 'premiere', pr: 'premiere', 'premiere pro': 'premiere', aftereffects: 'aftereffects', 'after effects': 'aftereffects', aeft: 'aftereffects', ae: 'aftereffects' };
export const appKey = (v) => ALIAS[String(v || '').trim().toLowerCase()] || null;
const error = (status, message) => Object.assign(new Error(message), { status });
const ONLINE_MS = 45_000; // 명령을 기다리는 요청이 이만큼 안 오면 꺼진 것으로 본다

export class AdobeBridge {
  constructor({ emit = () => {}, now = () => Date.now() } = {}) {
    this.emit = emit; this.now = now;
    this.clients = new Map(); // instance -> { app, instance, version, appVersion, project, role, lastSeen, waiter, queue, done }
    this.commands = new Map(); // id -> { id, app, instance, resolve, timer, sentAt }
  }

  client(app, instance) {
    const a = appKey(app); if (!a) throw error(400, '앱은 premiere 또는 aftereffects 예요');
    const id = String(instance || '').slice(0, 80) || `${a}-default`;
    let c = this.clients.get(id);
    if (!c) { c = { app: a, instance: id, version: '', appVersion: '', project: '', role: 'worker', headless: false, lastSeen: 0, waiter: null, queue: [], done: 0 }; this.clients.set(id, c); }
    return c;
  }
  // 명령을 실행하는 동안(렌더 등)은 기다림 요청이 안 와도 붙어 있는 것으로 본다
  online(c) { return !!c.waiter || this.now() - c.lastSeen < ONLINE_MS || [...this.commands.values()].some((x) => x.instance === c.instance); }

  hello(b = {}) {
    const c = this.client(b.app, b.instance), was = this.online(c);
    Object.assign(c, { version: String(b.version || '').slice(0, 40), appVersion: String(b.appVersion || '').slice(0, 40), project: String(b.project || '').slice(0, 500), role: b.role === 'panel' ? 'panel' : 'worker', headless: b.headless === true, lastSeen: this.now() });
    if (!was) this.emit({ type: 'adobe', ...this.status() });
    return { ok: true, instance: c.instance };
  }

  /** 플러그인의 명령 기다리기: 쌓인 명령이 있으면 바로, 없으면 wait 초 동안 붙잡고 있다가 빈 답 */
  next(q, res, json) {
    const c = this.client(q.app, q.instance), was = this.online(c);
    c.lastSeen = this.now();
    if (!was) this.emit({ type: 'adobe', ...this.status() });
    if (c.waiter) { const w = c.waiter; c.waiter = null; clearTimeout(w.timer); w.send(null); } // 같은 플러그인의 예전 기다림은 비운다
    const cmd = c.queue.shift();
    if (cmd) return json(res, { cmd });
    const wait = Math.max(0, Math.min(Number(q.wait) || 25, 55)) * 1000;
    const send = (x) => { if (!res.writableEnded) json(res, { cmd: x }); };
    const w = { send, timer: setTimeout(() => { if (c.waiter === w) c.waiter = null; c.lastSeen = this.now(); send(null); }, wait) };
    c.waiter = w;
    res.on?.('close', () => { if (c.waiter === w) { clearTimeout(w.timer); c.waiter = null; c.lastSeen = this.now(); } });
  }

  result(b = {}) {
    const cmd = this.commands.get(String(b.id || ''));
    if (!cmd) return { ok: false, unknown: true };
    this.commands.delete(cmd.id); clearTimeout(cmd.timer);
    const c = this.clients.get(cmd.instance); if (c) { c.done++; c.lastSeen = this.now(); }
    cmd.resolve({ ok: b.ok === true, result: b.result ?? null, error: b.ok === true ? null : String(b.error || '실패했어요'), ms: this.now() - cmd.sentAt, app: cmd.app, instance: cmd.instance });
    return { ok: true };
  }

  /** 앱별로 가장 최근에 붙은 플러그인(같은 앱이 여러 개 켜져 있으면 마지막으로 소식이 온 것) */
  pick(app, instance) {
    const a = appKey(app); if (!a) throw error(400, '앱은 premiere 또는 aftereffects 예요');
    // 화면 없이 뜬 AE(백그라운드 렌더·Dynamic Link용)는 사용자가 보는 앱이 아니라 고르지 않는다(이름으로 직접 고르면 허용)
    const list = [...this.clients.values()].filter((c) => c.app === a && this.online(c) && (instance ? c.instance === instance : !c.headless));
    if (!list.length) throw error(409, `${APPS[a]}가 꺼져 있거나 ODDIN 플러그인이 아직 연결되지 않았어요. ${APPS[a]}를 열어 두면 플러그인이 자동으로 붙어요`);
    return list.sort((x, y) => (y.waiter ? 1 : 0) - (x.waiter ? 1 : 0) || y.lastSeen - x.lastSeen)[0];
  }

  async run(b = {}) {
    const script = typeof b.script === 'string' ? b.script : '', file = typeof b.file === 'string' ? b.file : '';
    if (!script.trim() && !file.trim()) throw error(400, '실행할 script 나 file 을 주세요');
    if (script.length > 2_000_000) throw error(413, '스크립트가 너무 커요 (2MB 이하)');
    const c = this.pick(b.app, b.instance);
    const id = crypto.randomBytes(9).toString('base64url');
    const timeout = Math.max(1, Math.min(Number(b.timeoutSeconds) || 600, 3 * 3600)) * 1000;
    const cmd = { id, script, file, timeoutMs: timeout };
    return new Promise((resolve) => {
      const entry = { id, app: c.app, instance: c.instance, sentAt: this.now(), resolve,
        timer: setTimeout(() => { this.commands.delete(id); c.queue = c.queue.filter((x) => x.id !== id); resolve({ ok: false, result: null, error: `${Math.round(timeout / 1000)}초 안에 답이 없어요 (앱이 바쁘거나 대화 상자가 떠 있을 수 있어요)`, timedOut: true, app: c.app, instance: c.instance }); }, timeout) };
      this.commands.set(id, entry);
      if (c.waiter) { const w = c.waiter; c.waiter = null; clearTimeout(w.timer); w.send(cmd); } else c.queue.push(cmd);
    });
  }

  status() {
    const apps = [...this.clients.values()].map((c) => ({ app: c.app, name: APPS[c.app], instance: c.instance, online: this.online(c), headless: c.headless, version: c.version, appVersion: c.appVersion, project: c.project, role: c.role, lastSeen: c.lastSeen ? new Date(c.lastSeen).toISOString() : null, done: c.done, waiting: c.queue.length }));
    return { apps, pending: this.commands.size };
  }

  close() { for (const c of this.clients.values()) if (c.waiter) { clearTimeout(c.waiter.timer); c.waiter.send(null); c.waiter = null; } for (const x of this.commands.values()) clearTimeout(x.timer); }
}
