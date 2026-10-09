// ODDIN 허브와 잇기 — 프리미어·AE 플러그인처럼 스튜디오가 켜지면 이 PC의 허브에 자기를 알리고(hello), 허브는
// 그 주소로 스튜디오 화면을 비춰(/studio/ 프록시) 폰·원격에서도 열리게 한다. 스튜디오는 허브에게
//  - 원격 요청일 때 열 수 있는 폴더(허브의 열기 범위)  GET /api/studio/roots
//  - AI 에게 부탁(작업 만들기)                      POST /api/jobs
//  - 프리미어 명령(어도비 플러그인)                   POST /api/adobe/run
// 을 묻는다. 허브가 꺼져 있어도 스튜디오는 혼자 돈다(AI·프리미어·원격만 안 됨).
import { VERSION, error } from './env.mjs';

export class HubLink {
  constructor({ hubUrl, port, app = () => null, interval = 15_000 }) {
    this.hubUrl = hubUrl; this.port = port; this.app = app; this.interval = interval;
    this.online = false; this.lastError = null; this.timer = null; this.rootsCache = null;
  }
  async call(p, { method = 'GET', body = null, timeoutMs = 15_000 } = {}) {
    let r;
    try { r = await fetch(this.hubUrl + p, { method, headers: { 'Content-Type': 'application/json', 'X-Oddin-Studio': '1' }, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { this.online = false; throw error(503, 'ODDIN 이 꺼져 있거나 연결되지 않았어요'); }
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    if (!r.ok) throw error(r.status, j?.error || `ODDIN 이 ${r.status}로 답했어요`);
    return j;
  }
  async hello() {
    try { await this.call('/api/studio/hello', { method: 'POST', body: { port: this.port, version: VERSION, pid: process.pid, app: this.app() }, timeoutMs: 5000 }); this.online = true; this.lastError = null; }
    catch (e) { this.online = false; this.lastError = e.message; }
    return this.online;
  }
  start() { this.hello(); clearInterval(this.timer); this.timer = setInterval(() => this.hello(), this.interval); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; this.call('/api/studio/bye', { method: 'POST', body: { port: this.port, pid: process.pid }, timeoutMs: 2000 }).catch(() => {}); }
  /** 원격 요청이 열 수 있는 폴더(허브 열기 범위). 30초 기억 */
  async roots() {
    if (this.rootsCache && Date.now() - this.rootsCache.at < 30_000) return this.rootsCache.list;
    const r = await this.call('/api/studio/roots', { timeoutMs: 5000 });
    this.rootsCache = { at: Date.now(), list: Array.isArray(r.roots) ? r.roots : [] };
    return this.rootsCache.list;
  }
  premiere(script, timeoutSeconds = 120) { return this.call('/api/adobe/run', { method: 'POST', body: { app: 'premiere', script, timeoutSeconds }, timeoutMs: (timeoutSeconds + 10) * 1000 }); }
  status() { return { url: this.hubUrl, online: this.online, error: this.lastError }; }
}
