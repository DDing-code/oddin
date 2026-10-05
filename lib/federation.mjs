// 실행 PC 고르기 · 다른 PC 작업 함께 보기 (2026-10-05 사용자 "작업을 할 컴퓨터를 정할 수 있게 해줘 하단 메뉴에서 — 작업 지시는 어느 기기에서나 할 수 있지만 작업은 정할 수 있도록").
// - 연결된 PC의 실시간 이벤트(/api/events)를 받아 그 PC의 세션·작업을 이 PC 화면에도 보여 준다.
//   섞이지 않게 세션·작업·요청 id 앞에 rm-<PC키>- 를 붙이고 machine({id,name}) 을 단다.
// - 그 세션·작업에 대한 요청(경로·질의·본문에 rm- id)은 그 PC로 넘기고, 답의 id 를 다시 바꿔 돌려준다(proxy).
// - 새 요청에 실행 PC(machine)를 고르면 그 PC에 작업을 만든다. 폴더는 드라이브 작업 폴더·ODDIN 자산이면 그 PC 경로로 바꾸고,
//   그 밖의 폴더는 그 PC의 기본 작업 폴더를 쓴다. 첨부 이미지는 그 PC로 올린다.
// - 다른 PC가 비춰 준 것(machine 이 붙은 것)은 다시 비추지 않는다 — 두 PC가 서로 비춰 끝없이 늘지 않게.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const FORWARD = new Set(['job', 'job_removed', 'session', 'session_removed', 'log', 'intercept', 'prompt', 'checkpoint']);
const error = (status, message) => Object.assign(new Error(message), { status });
export const peerKey = (peer) => String(peer?.id || '').replace(/[^A-Za-z0-9]/g, '');
const NS_RE = /rm-([A-Za-z0-9]+)-/g;
const inside = (p, dir) => { const a = path.resolve(p).toLowerCase(), b = path.resolve(dir).toLowerCase(); return a === b || a.startsWith(b + path.sep); };

/** 세션·작업·요청 객체의 id·sessionId·jobId·jobIds 를 fn 으로 바꾼다(작업 안의 task id 는 그대로) */
export function mapIds(v, fn) {
  if (Array.isArray(v)) return v.map((x) => mapIds(x, fn));
  if (!v || typeof v !== 'object') return v;
  const idish = 'sessionId' in v || 'jobId' in v || 'jobIds' in v || 'tasks' in v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'sessionId' || k === 'jobId') && typeof x === 'string') out[k] = fn(x);
    else if (k === 'jobIds' && Array.isArray(x)) out[k] = x.map((y) => (typeof y === 'string' ? fn(y) : y));
    else if (k === 'id' && idish && typeof x === 'string') out[k] = fn(x);
    else out[k] = mapIds(x, fn);
  }
  return out;
}
/** 다른 PC에서 받은 것: id 에 표시를 붙이고 machine 을 단다 */
export function toLocal(peer, v) {
  const pre = `rm-${peerKey(peer)}-`, machine = { id: peer.id, name: peer.name };
  const out = mapIds(v, (id) => (id.startsWith('rm-') ? id : pre + id));
  const tag = (x) => (x && typeof x === 'object' && !Array.isArray(x) && ('jobIds' in x || 'tasks' in x) ? { ...x, machine } : x);
  if (Array.isArray(out)) return out.map(tag);
  return tag(out);
}
/** 다른 PC로 보낼 것: 그 PC 표시를 뗀다(글자 값 전체) */
export function toRemote(peer, v) {
  const pre = `rm-${peerKey(peer)}-`;
  const strip = (x) => {
    if (typeof x === 'string') return x.split(pre).join('');
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === 'object') { const o = {}; for (const [k, y] of Object.entries(x)) o[k] = strip(y); return o; }
    return x;
  };
  return strip(v);
}

export class Federation {
  /**
   * peers: Peers, broadcast(ev), drive: DriveFolders(경로 바꾸기), hubInfo(): 드라이브 ODDIN 폴더, defaultCwd, isDefaultDir(p),
   * uploadPath(id): 이 PC 첨부 파일 경로
   */
  constructor({ peers, broadcast, drive = null, hubInfo = () => null, isDefaultDir = () => false, uploadPath = () => null, connect = true }) {
    Object.assign(this, { peers, broadcast, drive, hubInfo, isDefaultDir, uploadPath });
    this.cache = new Map(); // peer.id → { sessions: Map, jobs: Map, online, hub }
    this.streams = new Map(); // peer.id → AbortController
    if (connect) { this.sync(); this.timer = setInterval(() => this.sync(), 30_000).unref(); }
  }
  close() { clearInterval(this.timer); for (const c of this.streams.values()) c.abort(); this.streams.clear(); }
  peerByKey(key) { return this.peers.list().find((p) => peerKey(p) === key) || null; }
  /** 이 요청이 다른 PC 것(rm- id)이면 그 PC */
  // 글 속 첫 번째 '아는 PC' 표시만 본다 — 파일 이름(transform-3d-…)에 우연히 rm-xx- 가 들어 있어도 다른 PC 요청으로 보지 않게
  remoteOf(text) { for (const m of String(text || '').matchAll(NS_RE)) { const p = this.peerByKey(m[1]); if (p) return p; } return null; }
  entry(peer) { let e = this.cache.get(peer.id); if (!e) { e = { sessions: new Map(), jobs: new Map(), online: false }; this.cache.set(peer.id, e); } return e; }
  /** 화면에 함께 보일 다른 PC 세션·작업 */
  sessions() { return [...this.cache.entries()].flatMap(([id, e]) => [...e.sessions.values()].map((s) => ({ ...s, machine: { ...s.machine, online: e.online } }))); }
  jobs() { return [...this.cache.values()].flatMap((e) => [...e.jobs.values()]); }
  status() { return this.peers.list().map((p) => ({ id: p.id, name: p.name, online: !!this.cache.get(p.id)?.online, sessions: this.cache.get(p.id)?.sessions.size || 0 })); }

  /* ---------------- 실시간 이벤트 받기 ---------------- */
  sync() {
    const ids = new Set(this.peers.list().map((p) => p.id));
    for (const [id, c] of this.streams) if (!ids.has(id)) { c.abort(); this.streams.delete(id); this.cache.delete(id); this.broadcast({ type: 'remote_sync', machine: { id }, sessions: [], jobs: [], online: false }); }
    for (const p of this.peers.list()) if (!this.streams.has(p.id)) this.listen(p);
  }
  async listen(peer, wait = 3000) {
    const ctl = new AbortController(); this.streams.set(peer.id, ctl);
    const again = (ms) => { if (ctl.signal.aborted) return; this.streams.delete(peer.id); this.setOnline(peer, false); setTimeout(() => { if (this.peers.list().some((p) => p.id === peer.id) && !this.streams.has(peer.id)) this.listen(peer, Math.min(ms * 2, 60_000)); }, ms).unref?.(); };
    try {
      const res = await fetch(`${peer.url}/api/events`, { headers: { 'X-Oddin-Machine': encodeURIComponent(this.peers.self().name), Accept: 'text/event-stream' }, signal: ctl.signal });
      if (!res.ok || !res.body) return again(wait);
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { this.onEvent(peer, JSON.parse(data)); } catch {}
        }
      }
      again(3000);
    } catch { again(wait); }
  }
  setOnline(peer, on) {
    const e = this.entry(peer); if (e.online === on) return;
    e.online = on; this.broadcast({ type: 'remote_sync', machine: { id: peer.id, name: peer.name, online: on }, sessions: this.sessionsOf(peer), jobs: [...e.jobs.values()], online: on });
  }
  sessionsOf(peer) { const e = this.entry(peer); return [...e.sessions.values()].map((s) => ({ ...s, machine: { ...s.machine, online: e.online } })); }
  onEvent(peer, ev) {
    const e = this.entry(peer);
    if (ev.type === 'hello') {
      // 그 PC가 비춰 준 다른 PC 것(machine 붙음)은 빼고 그 PC 자신의 것만
      e.sessions = new Map((ev.sessions || []).filter((s) => !s.machine).map((s) => toLocal(peer, s)).map((s) => [s.id, s]));
      e.jobs = new Map((ev.jobs || []).filter((j) => !j.machine && !String(j.id).startsWith('rm-')).map((j) => toLocal(peer, j)).map((j) => [j.id, j]));
      e.online = true;
      this.broadcast({ type: 'remote_sync', machine: { id: peer.id, name: peer.name, online: true }, sessions: this.sessionsOf(peer), jobs: [...e.jobs.values()], online: true });
      return;
    }
    if (!FORWARD.has(ev.type) || ev.machine || ev.session?.machine || ev.job?.machine) return;
    if (ev.job && String(ev.job.id).startsWith('rm-')) return;
    const local = toLocal(peer, ev);
    if (local.type === 'job') { local.job = { ...local.job, machine: { id: peer.id, name: peer.name } }; e.jobs.set(local.job.id, local.job); }
    else if (local.type === 'session') { local.session = { ...local.session, machine: { id: peer.id, name: peer.name, online: true } }; e.sessions.set(local.session.id, local.session); }
    else if (local.type === 'session_removed') { e.sessions.delete(local.sessionId); for (const [id, j] of e.jobs) if (j.sessionId === local.sessionId) e.jobs.delete(id); }
    else if (local.type === 'job_removed') e.jobs.delete(local.jobId);
    this.broadcast({ ...local, machine: { id: peer.id, name: peer.name } });
  }

  /* ---------------- 그 PC로 넘기기 ---------------- */
  /** rm- id 가 들어 있는 /api 요청을 그 PC로 넘긴다. 답이 JSON 이면 id 를 바꿔 돌려준다 */
  async proxy(req, res, { pathname, search, raw }) {
    const peer = this.remoteOf(pathname + search) || this.remoteOf(raw?.toString('utf8'));
    if (!peer) throw error(404, '그 PC를 찾지 못했어요');
    const pre = `rm-${peerKey(peer)}-`;
    let body;
    if (raw?.length) { const t = raw.toString('utf8'); try { body = JSON.stringify(toRemote(peer, JSON.parse(t))); } catch { body = t.split(pre).join(''); } }
    // 응답 머리가 60초 안에 와야 한다. 그 뒤 본문(영상 등)은 시간 제한 없이 흘려보낸다
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(new Error('응답이 없어요')), 60_000);
    res.on?.('close', () => ac.abort());
    const r = await fetch(peer.url + (pathname + search).split(pre).join(''), {
      method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json', 'X-Oddin-Machine': encodeURIComponent(this.peers.self().name), ...(req.headers.range ? { Range: req.headers.range } : {}) },
      signal: ac.signal,
    }).catch((e) => { throw error(502, `${peer.name} PC에 연결하지 못했어요: ${e.message}`); }).finally(() => clearTimeout(timer));
    const type = r.headers.get('content-type') || '';
    if (type.includes('json')) {
      const j = await r.json().catch(() => ({}));
      const out = j && typeof j === 'object' && !j.error ? toLocal(peer, j) : j;
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    // 파일(그림·영상)은 받는 대로 흘려보낸다. 영상 넘겨 보기(Range)·크기·보안 머리는 그대로 전한다
    const headers = { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' };
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'content-disposition', 'content-security-policy', 'x-content-type-options', 'x-file-language', 'location']) { const v = r.headers.get(k); if (v) headers[k] = k === 'location' ? v.split(pre).join('') : v; }
    res.writeHead(r.status, headers);
    if (!r.body || req.method === 'HEAD') return res.end();
    const stream = Readable.fromWeb(r.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /** 이 PC 폴더를 그 PC 폴더로: 드라이브 작업 폴더·ODDIN 자산이면 그 PC 경로, 아니면 null(그 PC 기본 작업 폴더) */
  async mapCwd(peer, cwd) {
    if (!cwd || this.isDefaultDir(cwd)) return { cwd: null };
    const f = this.drive?.folderOf?.(cwd);
    if (f) {
      const reg = this.drive.read().folders.find((x) => x.id === f.id);
      const there = reg?.paths?.[peer.remoteId];
      if (there) return { cwd: path.win32.join(there, path.relative(f.here, cwd)) };
      return { cwd: null, note: `"${f.name}"의 ${peer.name} PC 경로를 아직 몰라 그 PC의 기본 작업 폴더에서 해요` };
    }
    const h = this.hubInfo?.();
    if (h && inside(cwd, h.root)) {
      const e = this.entry(peer);
      if (!e.hub) { try { e.hub = (await this.peers.call(peer, '/api/drive-hub', { timeoutMs: 8000 })).hub; } catch {} }
      if (e.hub?.root) return { cwd: path.win32.join(e.hub.root, path.relative(h.root, cwd)) };
    }
    return { cwd: null, note: `${peer.name} PC에는 이 폴더가 없어서 그 PC의 기본 작업 폴더에서 해요` };
  }
  /** 첨부 이미지를 그 PC로 올리고 그 PC의 첨부 id 로 바꾼다 */
  async sendAttachments(peer, atts = []) {
    const out = [];
    for (const a of atts) {
      const file = this.uploadPath(a.id); if (!file) continue;
      const r = await fetch(`${peer.url}/api/uploads`, { method: 'POST', body: fs.readFileSync(file), headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(a.name || path.basename(file)), 'X-Oddin-Machine': encodeURIComponent(this.peers.self().name) }, signal: AbortSignal.timeout(60_000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw error(r.status, j.error || '첨부 이미지를 그 PC로 올리지 못했어요');
      out.push({ id: j.id, name: a.name });
    }
    return out;
  }
  /** 다른 PC에 작업 만들기: machine(실행 PC id) 또는 rm- 세션 id */
  async createJob(body) {
    const fromSession = this.remoteOf(body.sessionId);
    const peer = fromSession || this.peers.get?.(body.machine) || this.peers.list().find((p) => p.id === body.machine);
    if (!peer) throw error(404, '고른 PC를 찾지 못했어요. 연결된 PC 탭을 확인해 주세요');
    const b = toRemote(peer, { ...body }); delete b.machine;
    let note = null;
    if (!fromSession) { const m = await this.mapCwd(peer, body.cwd); note = m.note || null; if (m.cwd) b.cwd = m.cwd; else delete b.cwd; }
    if (b.attachments?.length) b.attachments = await this.sendAttachments(peer, body.attachments);
    let job;
    try { job = await this.peers.call(peer, '/api/jobs', { method: 'POST', body: b, timeoutMs: 60_000 }); }
    catch (e) { throw error(e.status || 502, `${peer.name} PC에 작업을 넘기지 못했어요: ${e.message}`); }
    const local = { ...toLocal(peer, job), machine: { id: peer.id, name: peer.name } };
    const e = this.entry(peer);
    e.jobs.set(local.id, local);
    // 화면이 바로 그 세션을 열 수 있게 세션도 받아 둔다(실시간 이벤트보다 먼저 올 수 있어서)
    if (!e.sessions.has(local.sessionId)) {
      try {
        const list = await this.peers.call(peer, '/api/sessions', { timeoutMs: 15_000 });
        const raw = (list || []).find((s) => `rm-${peerKey(peer)}-${s.id}` === local.sessionId);
        if (raw) { const s = { ...toLocal(peer, raw), machine: { id: peer.id, name: peer.name, online: true } }; e.sessions.set(s.id, s); this.broadcast({ type: 'session', session: s, machine: { id: peer.id, name: peer.name } }); }
      } catch {}
    }
    this.broadcast({ type: 'job', job: local, machine: { id: peer.id, name: peer.name } });
    return { ...local, note };
  }
}
