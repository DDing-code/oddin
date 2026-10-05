// 연결된 PC(다른 ODDIN 허브) 목록 (2026-10-05 집·회사 PC 두 대를 한 대시보드로).
// 목록은 이 PC 전용이라 data/peers.json 에 둔다(저장소에 올라가지 않음). 상대 허브와는 Tailscale 주소로 서버끼리 이야기한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.mjs';

const FILE = path.join(DATA_DIR, 'peers.json');
const error = (status, message) => Object.assign(new Error(message), { status });

/** 상대 허브 주소: Tailscale(https://<기기>.<tailnet>.ts.net) 또는 같은 PC 시험용(http://127.0.0.1:<포트>) */
export function peerUrl(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { throw error(400, '주소 형식이 아니에요. 예: https://회사pc.tailnet.ts.net'); }
  const ts = u.protocol === 'https:' && /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname);
  const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) && u.port;
  if (!ts && !local) throw error(400, 'Tailscale 주소(https://<기기>.<tailnet>.ts.net)만 넣을 수 있어요');
  return `${u.protocol}//${u.host}`;
}

export class Peers {
  constructor({ version = '' } = {}) {
    this.version = version;
    this.data = readJson(FILE, null) || {};
    if (!this.data.self?.id) { this.data.self = { id: randomUUID(), ...(this.data.self || {}) }; this.save(); }
    if (!Array.isArray(this.data.peers)) this.data.peers = [];
    this.status = new Map(); // id → { online, at, error, name, hostname }
  }
  save() { fs.mkdirSync(DATA_DIR, { recursive: true }); writeJsonAtomic(FILE, this.data); }
  self() { return { id: this.data.self.id, name: this.data.self.name || os.hostname(), hostname: os.hostname(), version: this.version }; }
  setSelfName(name) {
    const n = String(name || '').trim().slice(0, 30);
    if (!n) throw error(400, '이 PC 이름을 넣어 주세요');
    this.data.self.name = n; this.save(); return this.self();
  }
  list() { return this.data.peers.map((p) => ({ ...p, status: this.status.get(p.id) || null })); }
  get(id) { return this.data.peers.find((p) => p.id === id) || null; }
  /** 상대 허브 API 호출. Tailscale Serve 가 이 PC 계정 정보를 붙여 상대 허브의 원격 게이트를 통과한다 */
  async call(peer, route, { method = 'GET', body, timeoutMs = 15000 } = {}) {
    const headers = { 'X-Oddin-Machine': encodeURIComponent(this.self().name), ...(body ? { 'Content-Type': 'application/json' } : {}) };
    const res = await fetch(peer.url + route, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw error(res.status, data?.error || `상대 허브가 ${res.status}로 답했어요`);
    return data;
  }
  async check(peer) {
    try {
      const who = await this.call(peer, '/api/peers/whoami', { timeoutMs: 8000 });
      const s = { online: true, at: new Date().toISOString(), error: null, name: who.name, hostname: who.hostname, version: who.version };
      this.status.set(peer.id, s); return s;
    } catch (e) {
      const s = { online: false, at: new Date().toISOString(), error: e.name === 'TimeoutError' ? '응답이 없어요(상대 허브가 꺼졌거나 원격 접속이 꺼짐)' : String(e.message || e) };
      this.status.set(peer.id, s); return s;
    }
  }
  async add({ name, url }) {
    const base = peerUrl(url);
    if (this.data.peers.some((p) => p.url === base)) throw error(409, '이미 연결된 PC예요');
    const probe = { id: 'probe', url: base };
    let who;
    try { who = await this.call(probe, '/api/peers/whoami', { timeoutMs: 8000 }); }
    catch (e) { throw error(502, `그 주소의 허브에 닿지 않아요: ${e.name === 'TimeoutError' ? '응답 없음 — 그 PC 허브에서 원격 접속을 켜 주세요' : e.message}`); }
    if (who?.id === this.data.self.id) throw error(400, '이 PC 자신의 주소예요');
    const peer = { id: randomUUID().slice(0, 8), name: String(name || who?.name || who?.hostname || '다른 PC').trim().slice(0, 30), url: base, remoteId: who?.id || null, addedAt: new Date().toISOString() };
    this.data.peers.push(peer); this.save();
    this.status.set(peer.id, { online: true, at: new Date().toISOString(), error: null, name: who?.name, hostname: who?.hostname, version: who?.version });
    return peer;
  }
  rename(id, name) {
    const p = this.get(id); if (!p) throw error(404, '연결된 PC를 찾지 못했어요');
    const n = String(name || '').trim().slice(0, 30); if (!n) throw error(400, '이름을 넣어 주세요');
    p.name = n; this.save(); return p;
  }
  remove(id) {
    const before = this.data.peers.length;
    this.data.peers = this.data.peers.filter((p) => p.id !== id);
    if (this.data.peers.length === before) throw error(404, '연결된 PC를 찾지 못했어요');
    this.status.delete(id); this.save(); return { ok: true };
  }
}
