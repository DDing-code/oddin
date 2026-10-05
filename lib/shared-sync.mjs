// 공유 기억 동기화 (2026-10-05 사용자 "공유 메모리로 어디서나 같은 기억을 유지", 집·회사 PC 두 대).
// 연결된 PC의 ODDIN 허브끼리 ~/.ai-shared(지침·메모리·공통 커맨드·서브 에이전트·동기화 스크립트)를 주고받는다.
// - 각 허브가 주기적으로·파일이 바뀔 때 상대 허브와 맞춘다. 상대마다 "마지막으로 맞춘 내용(기준)"을 기억해
//   한쪽만 바뀐 파일은 그쪽 것을 쓰고, 둘 다 바뀐 파일은 목록 파일(MEMORY.md)이면 줄을 합치고
//   아니면 최근에 고친 쪽을 쓰되 다른 쪽은 backups/sync/ 에 남긴다. 지운 파일도 backups 에 남기고 지운다.
// - 상대 허브 쓰기는 기대한 이전 내용(ifSha)과 지금 내용이 같을 때만 적용한다. 그사이 바뀌었으면 다음 차례에 다시 맞춘다.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.mjs';

/** 맞추는 범위: ~/.ai-shared 의 이 항목들만. backups·hub(허브별 작업 보드)는 PC마다 따로 */
export const SHARED_TOP = ['AGENTS.md', 'README.md', 'memory', 'commands', 'agents', 'sync'];
// PC마다 따로인 파일: 동기화 상태·기록·잠금, PC 경로로 다시 만드는 프로젝트 대응표
const SKIP = [/^sync\/(state\.json|sync\.log|\.lock|memory-check-state(\/|$))/, /^memory\/projects\/INDEX\.md$/, /(^|\/)\.(git|DS_Store)(\/|$)/, /\.(tmp|bak|swp|lock)$/i, /~$/];
const UNION = /(^|\/)MEMORY\.md$/;
export const MAX_FILE = 4 * 1024 * 1024;
const STATE_FILE = () => path.join(DATA_DIR, 'shared-sync.json');
const error = (status, message) => Object.assign(new Error(message), { status });
export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const skipped = (rel) => SKIP.some((re) => re.test(rel));

/** 상대가 보낸 경로 검사: 맞추는 범위 안의 상대 경로만 */
export function safeRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-z]:/i.test(r) || r.split('/').some((s) => !s || s === '.' || s === '..') || /[\0:*?"<>|]/.test(r)) throw error(400, '잘못된 경로예요');
  if (!SHARED_TOP.includes(r.split('/')[0]) || skipped(r)) throw error(403, '동기화 대상이 아닌 경로예요');
  return r;
}
const fileOf = (root, rel) => path.join(root, ...rel.split('/'));

const cache = new Map(); // 전체 경로 → { mtime, size, sha } — 바뀌지 않은 파일은 다시 해시하지 않는다
export function scanShared(root) {
  const out = {};
  const walk = (dir, rel) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
      if (!rel && !SHARED_TOP.includes(e.name)) continue;
      if (skipped(r) || e.isSymbolicLink()) continue; // 정션·링크는 따라가지 않는다
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      const hit = cache.get(full);
      const hash = hit && hit.mtime === st.mtimeMs && hit.size === st.size ? hit.sha : sha(fs.readFileSync(full));
      cache.set(full, { mtime: st.mtimeMs, size: st.size, sha: hash });
      out[r] = { sha: hash, mtime: st.mtimeMs, size: st.size };
    }
  };
  walk(root, '');
  return out;
}
const currentSha = (file) => { try { return sha(fs.readFileSync(file)); } catch { return null; } };

function backup(root, rel, file, tag) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = path.join(root, 'backups', 'sync', stamp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, `${dest}.${String(tag || 'local').replace(/[^\w가-힣-]/g, '_')}`);
}
function writeAtomic(file, buf, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
  if (mtime) { const t = new Date(mtime); try { fs.utimesSync(file, t, t); } catch {} }
}

export function readShared(root, rel) {
  rel = safeRel(rel);
  const file = fileOf(root, rel);
  let buf, st;
  try { st = fs.statSync(file); buf = fs.readFileSync(file); } catch { throw error(404, '파일이 없어요'); }
  return { rel, sha: sha(buf), mtime: st.mtimeMs, content: buf.toString('base64') };
}
/** 상대 허브가 보낸 쓰기·지우기. ifSha(기대한 지금 내용)가 다르면 409 */
export function writeShared(root, body, from = 'peer') {
  const rel = safeRel(body.rel), file = fileOf(root, rel);
  const cur = currentSha(file), want = body.ifSha ?? null;
  if (cur !== want) throw error(409, '그사이 바뀌었어요. 다음 차례에 다시 맞춰요');
  if (body.delete) { if (cur) { backup(root, rel, file, `지움-${from}`); fs.rmSync(file, { force: true }); } return { rel, sha: null }; }
  const buf = Buffer.from(String(body.content || ''), 'base64');
  if (buf.length > MAX_FILE) throw error(413, '파일이 너무 커요');
  if (cur && body.backup) backup(root, rel, file, `덮어씀-${from}`);
  writeAtomic(file, buf, body.mtime);
  return { rel, sha: sha(buf) };
}

/**
 * 목록 파일(MEMORY.md) 합치기: 최근 판(newer)을 기준으로 다른 판에만 있는 줄을 덧붙인다.
 * 같은 메모리 파일을 가리키는 줄(](파일.md))은 최근 판 줄 하나만 남기고, 가리키는 파일이 없어진 줄은 뺀다.
 */
export function unionLines(newer, older, exists = () => true) {
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n');
  const key = (line) => { const m = line.match(/\]\(([^)\s]+\.md)\)/); return m ? `link:${m[1]}` : `line:${line.trim()}`; };
  const keep = (line) => { const m = line.match(/\]\(([^)\s/\\]+\.md)\)/); return !m || exists(m[1]); };
  const base = norm(newer).split('\n').filter((l) => !l.trim() || keep(l));
  const seen = new Set(base.filter((l) => l.trim()).map(key));
  const extra = norm(older).split('\n').filter((l) => l.trim() && keep(l) && !seen.has(key(l)) && (seen.add(key(l)), true));
  let text = base.join('\n');
  if (extra.length) text = text.replace(/\n*$/, '\n') + extra.join('\n') + '\n';
  return text;
}

export class SharedSync extends EventEmitter {
  /** root = ~/.ai-shared, peers = Peers, intervalMs = 주기(0이면 끔), watch = 파일 변경 감시 */
  constructor({ root, peers, intervalMs = 60_000, watch = true }) {
    super();
    this.root = root; this.peers = peers;
    this.state = readJson(STATE_FILE(), null) || { peers: {} };
    this.running = null; this.again = false;
    if (intervalMs > 0) this.timer = setInterval(() => this.syncAll('주기').catch(() => {}), intervalMs).unref();
    if (watch) this.watch();
  }
  saveState() { fs.mkdirSync(DATA_DIR, { recursive: true }); writeJsonAtomic(STATE_FILE(), this.state); }
  peerState(id) { return (this.state.peers[id] ||= { base: {}, lastAt: null, ok: null, error: null, counts: null }); }
  status() {
    return { root: this.root, running: !!this.running, peers: this.peers.list().map((p) => { const s = this.state.peers[p.id] || {}; return { id: p.id, name: p.name, lastAt: s.lastAt || null, ok: s.ok ?? null, error: s.error || null, counts: s.counts || null, files: Object.keys(s.base || {}).length }; }) };
  }
  watch() {
    let t;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => {
        const rel = String(name || '').replace(/\\/g, '/');
        if (!rel || !SHARED_TOP.includes(rel.split('/')[0]) || skipped(rel) || this.applying) return;
        clearTimeout(t); t = setTimeout(() => this.syncAll('파일 변경').catch(() => {}), 3000);
      });
      this.watcher.on('error', () => {});
    } catch {}
  }
  close() { clearInterval(this.timer); try { this.watcher?.close(); } catch {} }
  /** 모든 연결된 PC와 맞춘다. 이미 도는 중이면 끝난 뒤 한 번 더 */
  async syncAll(reason = '') {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      const results = [];
      do {
        this.again = false;
        for (const peer of this.peers.list()) results.push(await this.syncPeer(peer).catch((e) => ({ peer: peer.id, ok: false, error: String(e.message || e) })));
      } while (this.again);
      return results;
    })();
    try { return await this.running; } finally { this.running = null; this.emit('status', this.status()); }
  }
  async syncPeer(peer) {
    const st = this.peerState(peer.id), base = st.base || {}, next = {};
    const counts = { pulled: 0, pushed: 0, merged: 0, conflicts: 0, deleted: 0 }, errors = [];
    let remote;
    try { remote = await this.peers.call(peer, '/api/shared/manifest'); }
    catch (e) { st.ok = false; st.error = `연결 안 됨: ${e.message}`; st.lastTry = new Date().toISOString(); this.saveState(); return { peer: peer.id, ok: false, error: st.error }; }
    const local = scanShared(this.root), rfiles = remote?.files || {}, from = remote?.machine || peer.name;
    const keys = [...new Set([...Object.keys(local), ...Object.keys(rfiles)])].filter((r) => { try { safeRel(r); return true; } catch { return false; } })
      .sort((a, b) => (UNION.test(a) - UNION.test(b)) || a.localeCompare(b)); // 목록 파일은 다른 파일을 다 맞춘 뒤에
    const push = (rel, body) => this.peers.call(peer, '/api/shared/file', { method: 'POST', body: { rel, ...body } });
    const pull = async (rel) => this.peers.call(peer, `/api/shared/file?rel=${encodeURIComponent(rel)}`);
    const localBuf = (rel) => fs.readFileSync(fileOf(this.root, rel));
    const writeLocal = (rel, buf, mtime, expect, tag) => {
      const file = fileOf(this.root, rel);
      if (currentSha(file) !== expect) throw error(409, '이 PC에서 그사이 바뀜');
      if (tag && expect) backup(this.root, rel, file, tag);
      writeAtomic(file, buf, mtime);
    };
    this.applying = true;
    try {
      for (const rel of keys) {
        const L = local[rel]?.sha ?? null, R = rfiles[rel]?.sha ?? null, B = base[rel] ?? null;
        try {
          if (L === R) { if (L) next[rel] = L; continue; }
          const localChanged = L !== B, remoteChanged = R !== B;
          if (!remoteChanged) { // 이 PC만 바뀜 → 보낸다
            if (L) { const r = await push(rel, { content: localBuf(rel).toString('base64'), mtime: local[rel].mtime, ifSha: R }); next[rel] = r.sha; counts.pushed++; }
            else { await push(rel, { delete: true, ifSha: R }); counts.deleted++; }
            continue;
          }
          if (!localChanged) { // 상대만 바뀜 → 받는다
            if (R) { const f = await pull(rel); writeLocal(rel, Buffer.from(f.content, 'base64'), f.mtime, L); next[rel] = f.sha; counts.pulled++; }
            else { const file = fileOf(this.root, rel); if (currentSha(file) === L) { backup(this.root, rel, file, `지움-${from}`); fs.rmSync(file, { force: true }); } counts.deleted++; }
            continue;
          }
          // 둘 다 바뀜
          if (!L || !R) { // 한쪽은 지우고 한쪽은 고침 → 고친 쪽을 살린다
            if (L) { const r = await push(rel, { content: localBuf(rel).toString('base64'), mtime: local[rel].mtime, ifSha: null }); next[rel] = r.sha; }
            else { const f = await pull(rel); writeLocal(rel, Buffer.from(f.content, 'base64'), f.mtime, null); next[rel] = f.sha; }
            counts.conflicts++; continue;
          }
          const f = await pull(rel), theirs = Buffer.from(f.content, 'base64'), mine = localBuf(rel);
          if (UNION.test(rel)) { // 목록 파일: 줄 합치기
            const dir = path.dirname(fileOf(this.root, rel));
            const localNewer = local[rel].mtime >= (rfiles[rel].mtime || 0);
            const merged = Buffer.from(unionLines(localNewer ? mine.toString('utf8') : theirs.toString('utf8'), localNewer ? theirs.toString('utf8') : mine.toString('utf8'), (name) => fs.existsSync(path.join(dir, name))));
            writeLocal(rel, merged, null, L);
            const r = await push(rel, { content: merged.toString('base64'), ifSha: R });
            next[rel] = r.sha; counts.merged++; continue;
          }
          if (local[rel].mtime >= (rfiles[rel].mtime || 0)) { const r = await push(rel, { content: mine.toString('base64'), mtime: local[rel].mtime, ifSha: R, backup: true }); next[rel] = r.sha; }
          else { writeLocal(rel, theirs, f.mtime, L, `밀림-${from}`); next[rel] = f.sha; }
          counts.conflicts++;
        } catch (e) {
          if (B) next[rel] = B; // 실패한 파일은 기준을 그대로 두고 다음 차례에 다시
          errors.push(`${rel}: ${e.message}`);
        }
      }
    } finally { this.applying = false; }
    st.base = next; st.lastAt = new Date().toISOString(); st.ok = !errors.length; st.error = errors[0] || null; st.counts = counts; st.errors = errors.length;
    this.saveState();
    return { peer: peer.id, ok: !errors.length, counts, errors: errors.slice(0, 5) };
  }
}
