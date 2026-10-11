// 공유 기억 동기화 (2026-10-05 사용자 "공유 메모리로 어디서나 같은 기억을 유지", 집·회사 PC 두 대).
// 연결된 PC의 ODDIN 허브끼리 ~/.ai-shared(지침·메모리·공통 커맨드·서브 에이전트·동기화 스크립트)를 주고받는다.
// - 각 허브가 주기적으로·파일이 바뀔 때 상대 허브와 맞춘다. 상대마다 "마지막으로 맞춘 내용(기준)"을 기억해
//   한쪽만 바뀐 파일은 그쪽 것을 쓰고, 둘 다 바뀐 파일은 목록 파일(MEMORY.md)이면 줄을 합치고
//   아니면 최근에 고친 쪽을 쓰되 다른 쪽은 backups/sync/ 에 남긴다. 지운 파일도 backups 에 남기고 지운다.
// - 상대 허브 쓰기는 기대한 이전 내용(ifSha)과 지금 내용이 같을 때만 적용한다. 그사이 바뀌었으면 다음 차례에 다시 맞춘다.
// - 구글 드라이브 ODDIN 폴더(lib/drive-hub.mjs)가 있으면 그 "공유 기억/" 폴더도 상대 하나로 맞춘다(같은 방식, 파일을 직접 읽고 씀).
//   두 PC가 같은 ODDIN 폴더를 쓰고 있으면(manifest 의 driveHub 가 같으면) PC끼리 직접 맞추기는 쉬고 드라이브로만 맞춘다
//   — 같은 파일을 두 길로 올리면 드라이브에 같은 이름 파일이 둘 생길 수 있어서. 드라이브 쪽 "이름 (1)" 충돌 사본은 맞추지 않는다.
//
// 가볍게 맞추기 (2026-10-11 사용자 "작업을 안할 때도 자원을 많이 먹는데?" — 20초마다 드라이브 폴더 3천여 파일을 훑던 것을 고침):
// - 평소에는 드라이브를 훑지 않는다. 드라이브에 올릴 때마다 "공유 기억/.oddin-sync/<PC id>.json"(표시 파일)에
//   바뀐 파일과 내용 해시를 적고, 다른 PC는 그 작은 파일만 확인해 새로 적힌 파일만 골라 받는다(올라올 때까지 몇 번 다시 봄).
// - 이 PC 파일이 바뀌면(감시) 이 PC 목록만 훑어 기준과 다른 파일만 드라이브에 올린다.
// - 올린 직후 연결된 PC 허브에 바로 알린다(/api/shared/changed). 알림만 직접 가고 파일은 드라이브로만 간다(위 이유).
// - 전체 훑기는 안전망: 기억·지침은 5분, 스킬은 10분마다. 작업도 없고 화면도 안 쓰면 모든 주기를 idleFactor 배 길게.
// - node_modules·__pycache__ 는 맞추지 않는다(PC마다 따로 설치하는 것, 3천여 파일 중 2천4백 개가 이것이었다).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.mjs';
import { merge3, merge2 } from './text-merge.mjs';

// 줄 단위로 합칠 수 있는 글 파일과, 겹친 곳을 둘 다 남기는 표시를 넣을 수 있는 파일(.md)
const TEXT_RE = /\.(md|txt|json|jsonc|mjs|cjs|js|ts|ya?ml|toml|ini|cfg|csv|ps1|cmd|bat|sh)$/i;
const OBJ_MAX = 256 * 1024;

/** 맞추는 범위: ~/.ai-shared 의 이 항목들만. backups·hub(허브별 작업 보드)는 PC마다 따로 */
export const SHARED_TOP = ['AGENTS.md', 'README.md', 'memory', 'commands', 'agents', 'skills', 'sync']; // skills: 두 PC 공유 스킬(2026-10-05, lib/catalog.mjs linkSharedSkills)
/** 훑는 주기를 나누는 묶음: 스킬(파일이 많고 드물게 바뀜)은 가끔, 나머지(기억·지침·커맨드)는 자주 */
export const SLOW_TOPS = ['skills'];
export const CORE_TOPS = SHARED_TOP.filter((t) => !SLOW_TOPS.includes(t));
// PC마다 따로인 파일: 동기화 상태·기록·잠금, PC 경로로 다시 만드는 프로젝트 대응표, 각 PC에서 설치하는 라이브러리 폴더
const SKIP = [/^sync\/(state\.json|sync\.log|\.lock|memory-check-state(\/|$))/, /^memory\/projects\/INDEX\.md$/, /(^|\/)\.(git|DS_Store)(\/|$)/, /\.(tmp|bak|swp|lock)$/i, /~$/, /(^|\/)(node_modules|__pycache__)(\/|$)/];
/** 드라이브 "공유 기억/" 안의 표시 파일 폴더(SHARED_TOP 밖이라 맞추지 않는다) */
export const MARK_DIR = '.oddin-sync';
const MARK_MAX = 300; // 표시 파일에 남기는 최근 변경 수. 넘치면 받는 쪽이 한 번 훑는다
const CATCH_STEPS = [1500, 4000, 8000, 15_000, 30_000, 60_000, 120_000, 240_000]; // 알림 받은 파일이 드라이브에 올라올 때까지 다시 보는 간격
const ID_RE = /^[\w-]{1,64}$/, SHA_RE = /^[0-9a-f]{64}$/;
const UNION = /(^|\/)MEMORY\.md$/;
export const MAX_FILE = 4 * 1024 * 1024;
const STATE_FILE = () => path.join(DATA_DIR, 'shared-sync.json');
const error = (status, message) => Object.assign(new Error(message), { status });
export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const skipped = (rel) => SKIP.some((re) => re.test(rel));
// 드라이브가 만드는 파일: 같은 이름 충돌 사본 "이름 (1).md", 폴더 설정, 올리기·내려받기 임시 파일
const DRIVE_SKIP = [/ \(\d+\)(\.[^/.]+)?$/, /(^|\/)(desktop\.ini|Thumbs\.db)$/i, /(^|\/)\.tmp\.drive/i, /(^|\/)~\$/];
export const driveSkipped = (rel) => DRIVE_SKIP.some((re) => re.test(rel));

/** 상대가 보낸 경로 검사: 맞추는 범위 안의 상대 경로만 */
export function safeRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-z]:/i.test(r) || r.split('/').some((s) => !s || s === '.' || s === '..') || /[\0:*?"<>|]/.test(r)) throw error(400, '잘못된 경로예요');
  if (!SHARED_TOP.includes(r.split('/')[0]) || skipped(r)) throw error(403, '동기화 대상이 아닌 경로예요');
  return r;
}
const fileOf = (root, rel) => path.join(root, ...rel.split('/'));

const cache = new Map(); // 전체 경로 → { mtime, size, sha } — 바뀌지 않은 파일은 다시 해시하지 않는다
/** tops = 훑을 맨 위 항목(없으면 전부) */
export function scanShared(root, { drive = false, tops = null } = {}) {
  const out = {};
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
      if (!rel && (!SHARED_TOP.includes(e.name) || (tops && !tops.includes(e.name)))) continue;
      if (skipped(r) || (drive && driveSkipped(r)) || e.isSymbolicLink()) continue; // 정션·링크는 따라가지 않는다
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!e.isFile()) continue;
      const st = fs.statSync(full);
      if (st.size > MAX_FILE) { out[r] = { sha: 'excluded', excluded: true, size: st.size }; continue; }
      const hit = cache.get(full);
      const hash = hit && hit.mtime === st.mtimeMs && hit.size === st.size ? hit.sha : sha(fs.readFileSync(full));
      cache.set(full, { mtime: st.mtimeMs, size: st.size, sha: hash });
      out[r] = { sha: hash, mtime: st.mtimeMs, size: st.size };
    }
  };
  walk(root, '');
  return out;
}
/** 고른 파일만 확인한다(폴더를 훑지 않음). 없는 파일은 목록에 넣지 않고, 훑기와 같게 정션·링크 아래 파일도 넣지 않는다 */
export function statShared(root, rels) {
  const out = {}, linked = new Map();
  const underLink = (rel) => {
    const parts = rel.split('/'); let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = path.join(dir, parts[i]);
      let v = linked.get(dir);
      if (v === undefined) { try { v = fs.lstatSync(dir).isSymbolicLink(); } catch { v = false; } linked.set(dir, v); }
      if (v) return true;
    }
    return false;
  };
  for (const rel of rels) {
    if (underLink(rel)) continue;
    const full = fileOf(root, rel);
    let st; try { st = fs.lstatSync(full); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) { out[rel] = { sha: 'excluded', excluded: true, size: st.size }; continue; }
    const hit = cache.get(full);
    const hash = hit && hit.mtime === st.mtimeMs && hit.size === st.size ? hit.sha : sha(fs.readFileSync(full));
    cache.set(full, { mtime: st.mtimeMs, size: st.size, sha: hash });
    out[rel] = { sha: hash, mtime: st.mtimeMs, size: st.size };
  }
  return out;
}
const currentSha = (file) => { try { return sha(fs.readFileSync(file)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

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
  try { st = fs.statSync(file); } catch { throw error(404, '파일이 없어요'); }
  if (st.size > MAX_FILE) throw error(413, '파일이 너무 커요');
  buf = fs.readFileSync(file);
  return { rel, sha: sha(buf), mtime: st.mtimeMs, content: buf.toString('base64') };
}
/** 상대 허브가 보낸 쓰기·지우기. ifSha(기대한 지금 내용)가 다르면 409 */
export function writeShared(root, body, from = 'peer', backupRoot = root) {
  const rel = safeRel(body.rel), file = fileOf(root, rel);
  const cur = currentSha(file), want = body.ifSha ?? null;
  if (cur !== want) throw error(409, '그사이 바뀌었어요. 다음 차례에 다시 맞춰요');
  if (body.delete) { if (cur) { backup(backupRoot, rel, file, `지움-${from}`); fs.rmSync(file, { force: true }); } return { rel, sha: null }; }
  const buf = Buffer.from(String(body.content || ''), 'base64');
  if (buf.length > MAX_FILE) throw error(413, '파일이 너무 커요');
  if (cur && body.backup) backup(backupRoot, rel, file, `덮어씀-${from}`);
  writeAtomic(file, buf, body.mtime);
  return { rel, sha: sha(buf) };
}

/* ---- 드라이브 폴더용(비동기): 다른 PC가 올린 드라이브 파일은 처음 읽을 때 클라우드에서 내려받아 느리다.
   동기 읽기로 허브 서버 전체가 멈추지 않게 드라이브 쪽은 모두 fs.promises 로 읽고 쓴다(실측 2026-10-05: 처음 훑기 60초 넘음) ---- */
const fsp = fs.promises;
async function shaOfFile(file) {
  try {
    const st = await fsp.stat(file), hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.sha;
    const h = sha(await fsp.readFile(file)); cache.set(file, { mtime: st.mtimeMs, size: st.size, sha: h }); return h;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function scanFolderShared(root, { tops = null } = {}) {
  const out = {};
  const walk = async (dir, rel) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
      if (!rel && (!SHARED_TOP.includes(e.name) || (tops && !tops.includes(e.name)))) continue;
      if (skipped(r) || driveSkipped(r) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(full, r); continue; }
      if (!e.isFile()) continue;
      const st = await fsp.stat(full);
      if (st.size > MAX_FILE) { out[r] = { sha: 'excluded', excluded: true, size: st.size }; continue; }
      const hash = await shaOfFile(full); if (!hash) throw error(409, '파일을 끝까지 읽지 못해 동기화를 멈췄어요');
      out[r] = { sha: hash, mtime: st.mtimeMs, size: st.size };
    }
  };
  await walk(root, '');
  return out;
}
/** 드라이브 폴더에서 고른 파일만 확인한다(훑지 않음). 없는 파일은 목록에 넣지 않는다 */
export async function statFolderShared(root, rels) {
  const out = {};
  for (const rel of rels) {
    if (driveSkipped(rel)) continue;
    const full = fileOf(root, rel);
    let st; try { st = await fsp.lstat(full); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE) { out[rel] = { sha: 'excluded', excluded: true, size: st.size }; continue; }
    const hash = await shaOfFile(full); if (!hash) continue; // 그사이 사라짐
    out[rel] = { sha: hash, mtime: st.mtimeMs, size: st.size };
  }
  return out;
}
export async function readFolderShared(root, rel) {
  rel = safeRel(rel);
  const file = fileOf(root, rel);
  let buf, st;
  try { st = await fsp.stat(file); } catch { throw error(404, '파일이 없어요'); }
  if (st.size > MAX_FILE) throw error(413, '파일이 너무 커요');
  buf = await fsp.readFile(file);
  return { rel, sha: sha(buf), mtime: st.mtimeMs, content: buf.toString('base64') };
}
/** 드라이브 폴더 쓰기·지우기(writeShared 와 같은 규칙). 밀린 판은 backupRoot(이 PC)에 */
export async function writeFolderShared(root, body, from, backupRoot) {
  const rel = safeRel(body.rel), file = fileOf(root, rel);
  const cur = await shaOfFile(file), want = body.ifSha ?? null;
  if (cur !== want) throw error(409, '그사이 바뀌었어요. 다음 차례에 다시 맞춰요');
  const keep = async (tag) => {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dest = path.join(backupRoot, 'backups', 'sync', stamp, ...rel.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(file, `${dest}.${String(tag).replace(/[^\w가-힣-]/g, '_')}`);
  };
  if (body.delete) { if (cur) { await keep(`지움-${from}`); await fsp.rm(file, { force: true }); cache.delete(file); } return { rel, sha: null }; }
  const buf = Buffer.from(String(body.content || ''), 'base64');
  if (buf.length > MAX_FILE) throw error(413, '파일이 너무 커요');
  if (cur && body.backup) await keep(`덮어씀-${from}`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buf); await fsp.rename(tmp, file);
  if (body.mtime) { const t = new Date(body.mtime); try { await fsp.utimes(file, t, t); } catch {} }
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

const iso = () => new Date().toISOString();
const anyCount = (c) => !!c && (c.pulled + c.pushed + c.merged + c.conflicts + c.deleted) > 0;
/** 바깥에 돌려주는 결과(안에서만 쓰는 목록은 뺀다) */
const pub = (r) => { if (!r) return r; const { sent, touched, ...rest } = r; return rest; };

export class SharedSync extends EventEmitter {
  /** root = ~/.ai-shared, peers = Peers, intervalMs = 이 PC 변경·연결된 PC를 확인하는 주기(0이면 끔), watch = 파일 변경 감시,
   *  hub() = 쓰는 중인 드라이브 ODDIN 폴더(DriveHub.info) 또는 null, driveIntervalMs = 드라이브 표시 파일을 확인하는 주기(0이면 끔),
   *  joinMs = 다른 PC가 만든 드라이브 폴더를 처음 본 뒤 맞는 파일만 기준으로 삼는 시간(만든 PC가 다 올릴 때까지 같은 파일을 또 올리지 않게),
   *  coreScanMs·skillScanMs = 안전망으로 드라이브를 훑는 주기(기억·지침 / 스킬), legacyScanMs = 표시 파일을 쓰는 다른 PC가 없을 때(예전 버전) 훑는 주기,
   *  active() = 지금 쓰는 중인지(작업 중·방금 화면을 씀) — 아니면 모든 주기를 idleFactor 배로, catchSteps = 알림 받은 파일을 다시 보는 간격들,
   *  notify = 드라이브에 올린 뒤 연결된 PC 허브에 바로 알릴지, meter(이름, 일) = 쓴 시간 기록(lib/load-log.mjs timed) */
  constructor({ root, peers, intervalMs = 60_000, watch = true, hub = () => null, driveIntervalMs = 20_000, joinMs = 5 * 60_000, stateFile = STATE_FILE(),
    coreScanMs = 5 * 60_000, skillScanMs = 10 * 60_000, legacyScanMs = 60_000, idleFactor = 6, active = () => true, catchSteps = CATCH_STEPS, notify = true, meter = null }) {
    super();
    Object.assign(this, { root, peers, hub, joinMs, stateFile, intervalMs, driveIntervalMs, coreScanMs, skillScanMs, legacyScanMs, idleFactor, active, catchSteps, notifyOn: notify, meter });
    this.state = readJson(stateFile, null) || { peers: {} };
    this.state.peers ||= {};
    this.dirty = false;
    // 이제 맞추지 않는 경로(node_modules 등)는 기준에서 뺀다 — 이 PC에서 지운 것으로 읽혀 상대 쪽을 지우면 안 된다
    for (const s of Object.values(this.state.peers || {})) for (const rel of Object.keys(s.base || {})) if (skipped(rel)) { delete s.base[rel]; this.dirty = true; }
    this.queue = Promise.resolve(); this.busy = 0; this.allQueued = null; this.closed = false;
    this.ran = {}; this.runs = []; this.timers = new Set(); this.objSeen = new Set(); this.emittedAt = 0;
    this.pending = new Map(); this.catchStep = 0; this.markStat = new Map(); this.markerPeers = null;
    const tickMs = Math.min(...[intervalMs, driveIntervalMs].filter((n) => n > 0));
    if (Number.isFinite(tickMs)) {
      this.timer = setInterval(() => this.tick().catch(() => {}), tickMs).unref();
      this.later(() => this.tick().catch(() => {}), Math.min(8000, tickMs)); // 켠 직후 한 번(전체 맞추기)
    }
    if (watch) this.watch();
  }
  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms); t.unref?.(); this.timers.add(t); return t; }
  isActive() { try { return this.active() !== false; } catch { return true; } }
  selfId() { try { const id = String(this.peers.self?.().id || ''); return ID_RE.test(id) ? id : ''; } catch { return ''; } }
  /** 바뀐 것이 있을 때만 상태 파일을 쓴다(예전에는 맞출 때마다 1MB 넘는 파일을 다시 썼다) */
  saveState(force = false) {
    if (!force && !this.dirty) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); writeJsonAtomic(this.stateFile, this.state);
  }
  peerState(id) { return (this.state.peers[id] ||= { base: {}, lastAt: null, ok: null, error: null, counts: null }); }
  /** 맞추기 일은 한 번에 하나씩 차례로(겹쳐 돌면 같은 파일을 두 번 다룬다) */
  enqueue(fn, { announce = false, name = '' } = {}) {
    const run = async () => {
      this.busy++;
      try { return await (this.meter && name ? this.meter(`shared:${name}`, fn) : fn()); }
      finally { this.busy--; try { this.saveState(); } catch {} if (announce) this.wantEmit = true; if (!this.busy) this.emitStatus(); }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  /** 화면에 알리기: 바뀐 것이 있거나 직접 시킨 맞추기면 바로, 아니면 5분에 한 번만(확인만 한 차례마다 화면을 다시 그리지 않게) */
  emitStatus() {
    if (!this.wantEmit && Date.now() - this.emittedAt < 5 * 60_000) return;
    this.wantEmit = false; this.emittedAt = Date.now();
    this.emit('status', this.status());
  }
  note(reason, kind, r, ms) {
    this.runs.push({ at: iso(), reason, kind, ms: Math.round(ms), ok: r?.ok !== false, ...(anyCount(r?.counts) ? { counts: r.counts } : {}), ...(r?.error ? { error: String(r.error).slice(0, 120) } : {}) });
    if (this.runs.length > 40) this.runs.shift();
    if (anyCount(r?.counts) || r?.ok === false || r?.joining) this.wantEmit = true;
  }
  /* ---- 합치기 기준: 마지막으로 맞춘 글 파일 내용을 sha 이름으로 보관(상대마다 기준 sha 만 기억하므로) ---- */
  objDir() { return path.join(path.dirname(this.stateFile), 'shared-sync-objects'); }
  loadObject(id) { if (!id || !/^[0-9a-f]{64}$/.test(id)) return null; try { return fs.readFileSync(path.join(this.objDir(), id)); } catch { return null; } }
  /** 이번에 맞춘 글 파일 내용을 기준으로 남긴다(이 PC 파일이 그 내용일 때만). 가끔 아무 기준도 가리키지 않는 것은 지운다.
   *  rels = 이번에 본 파일만(고른 파일만 맞춘 차례) */
  keepObjects(next, rels = null) {
    const dir = this.objDir();
    for (const rel of rels || Object.keys(next)) {
      const id = next[rel];
      if (!id || !TEXT_RE.test(rel) || this.objSeen.has(id)) continue;
      if (fs.existsSync(path.join(dir, id))) { this.objSeen.add(id); continue; }
      let buf; try { buf = fs.readFileSync(fileOf(this.root, rel)); } catch { continue; }
      if (buf.length > OBJ_MAX || sha(buf) !== id) continue;
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id), buf); this.objSeen.add(id); } catch {}
    }
    if (rels || Date.now() - (this.prunedAt || 0) < 30 * 60_000) return;
    this.prunedAt = Date.now(); this.objSeen.clear();
    const used = new Set(Object.values(this.state.peers).flatMap((p) => Object.values(p.base || {})));
    for (const id of Object.values(next)) used.add(id);
    try { for (const n of fs.readdirSync(dir)) if (!used.has(n)) fs.rmSync(path.join(dir, n), { force: true }); } catch {}
  }
  /** 두 PC가 같은 글 파일을 고쳤을 때 줄 단위로 합친다. 돌려주는 값: { buf, conflicts } 또는 null(합칠 수 없음) */
  mergeText(rel, baseId, mine, theirs, mineNewer, from) {
    if (!TEXT_RE.test(rel) || mine.length > OBJ_MAX || theirs.length > OBJ_MAX || mine.includes(0) || theirs.includes(0)) return null;
    let me = '이 PC'; try { me = this.peers.self?.().name || me; } catch {}
    const md = /\.md$/i.test(rel), other = mineNewer ? from : me; // 표시 문구는 두 PC에 그대로 가므로 PC 이름으로
    const base = this.loadObject(baseId);
    const r = base ? merge3(base.toString('utf8'), mine.toString('utf8'), theirs.toString('utf8'), { mineNewer, other, markers: md })
      : merge2((mineNewer ? mine : theirs).toString('utf8'), (mineNewer ? theirs : mine).toString('utf8'), { other, markers: md });
    if (!r) return null;
    if (/\.json$/i.test(rel)) { try { JSON.parse(r.text); } catch { return null; } }
    return { buf: Buffer.from(r.text), conflicts: r.conflicts };
  }
  /** 드라이브 ODDIN 폴더의 "공유 기억/"을 상대 하나로: { id, name, folder, hubId, creator } 또는 null */
  driveTarget() {
    let h; try { h = this.hub?.(); } catch { h = null; }
    if (!h?.memory || !h.id) return null;
    let me = null; try { me = this.peers.self?.().id || null; } catch {}
    return { id: `drive:${h.id}`, name: '구글 드라이브', folder: h.memory, hubId: h.id, creator: !!me && h.createdBy === me };
  }
  /** 이 PC가 드라이브로 맞추는 중이면 그 ODDIN 폴더 id(처음 기준 잡기가 끝났고 마지막 맞추기가 성공). 상대에게 알린다 */
  driveHubId() {
    const t = this.driveTarget(); if (!t) return null;
    const s = this.state.peers[t.id];
    return s?.joined && s.ok !== false ? t.hubId : null;
  }
  targets() { const t = this.driveTarget(); return [...this.peers.list(), ...(t ? [t] : [])]; }
  /** 상대 호출: 연결된 PC 는 HTTP, 드라이브 폴더는 파일을 직접 읽고 쓴다(밀린 판 보관은 이 PC backups) */
  async call(peer, route, opts = {}) {
    if (!peer.folder) return this.peers.call(peer, route, opts);
    if (route === '/api/shared/manifest') return this.manifestOf(peer);
    if (route.startsWith('/api/shared/file?')) return readFolderShared(peer.folder, new URLSearchParams(route.slice(route.indexOf('?') + 1)).get('rel'));
    if (route === '/api/shared/file' && opts.method === 'POST') return writeFolderShared(peer.folder, opts.body, peer.name, this.root);
    throw error(404, '없는 경로예요');
  }
  /** 상대 파일 목록. 드라이브 폴더는 고른 파일(rels)만 또는 맨 위 항목 몇 개(tops)만 볼 수 있다 */
  async manifestOf(peer, { tops = null, rels = null } = {}) {
    if (!peer.folder) return this.peers.call(peer, '/api/shared/manifest');
    // 폴더가 안 보이면(드라이브 앱이 아직 준비 전·이름이 바뀜) 빈 목록으로 보지 않는다 — 다 지워진 것으로 읽혀 이 PC 기억을 지우면 안 된다
    try { await fsp.access(peer.folder); } catch { throw error(404, '드라이브의 공유 기억 폴더가 안 보여요'); }
    return { machine: peer.name, files: rels ? await statFolderShared(peer.folder, rels) : await scanFolderShared(peer.folder, { tops }) };
  }
  /** 연결된 PC에 알려 주는 이 PC 상태(목록 전체를 보내지 않는 가벼운 확인) */
  hello() { let machine = ''; try { machine = this.peers.self?.().name || ''; } catch {} return { machine, driveHub: this.driveHubId(), markers: true }; }
  status() {
    const row = (p) => { const s = this.state.peers[p.id] || {}; return { id: p.id, name: p.name, lastAt: s.lastAt || null, ok: s.ok ?? null, error: s.error || null, counts: s.counts || null, files: Object.keys(s.base || {}).length, via: s.via || null }; };
    const t = this.driveTarget(), ds = t ? this.state.peers[t.id] || {} : null;
    return { root: this.root, running: this.busy > 0, idle: !this.isActive(), peers: this.peers.list().map(row),
      drive: t ? { ...row(t), folder: t.folder, hubId: t.hubId, creator: t.creator, joined: !!ds.joined, joinUntil: ds.joinUntil ? new Date(ds.joinUntil).toISOString() : null, waiting: this.pending.size, markers: this.markerPeers } : null,
      recent: this.runs.slice(-12) };
  }
  watch() {
    let t;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => {
        const rel = String(name || '').replace(/\\/g, '/');
        if (!rel || !SHARED_TOP.includes(rel.split('/')[0]) || skipped(rel) || this.applying) return;
        clearTimeout(t); t = setTimeout(() => { if (!this.closed) this.enqueue(() => this.localCheck('파일 변경', true), { name: 'local' }).catch(() => {}); }, 3000);
        t.unref?.();
      });
      this.watcher.on('error', () => {});
    } catch {}
  }
  close() {
    this.closed = true;
    clearInterval(this.timer); clearTimeout(this.catchTimer);
    for (const t of this.timers) clearTimeout(t); this.timers.clear();
    try { this.watcher?.close(); } catch {}
  }

  /* ---- 언제 무엇을 하나 ---- */
  /** 주기마다: 할 때가 된 일만 한다. 쉬는 중이면 모든 주기가 idleFactor 배 */
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now(), slow = this.isActive() ? 1 : this.idleFactor;
      const due = (k, ms) => ms > 0 && now - (this.ran[k] || 0) >= ms * slow && ((this.ran[k] = now), true);
      const t = this.driveTarget();
      if (t && this.driveIntervalMs > 0) {
        if (!this.state.peers[t.id]?.joined) { if (due('join', this.driveIntervalMs)) await this.enqueue(() => this.syncDrive({}, '드라이브 처음 맞추기'), { name: 'join' }); }
        else {
          if (due('markers', this.driveIntervalMs)) await this.enqueue(() => this.checkMarkers(), { name: 'markers' });
          // 표시 파일을 쓰는 다른 PC가 아직 없으면(예전 버전) 훑어서 찾는 수밖에 없다
          const legacy = !this.markerPeers;
          if (due('core', legacy ? this.legacyScanMs : this.coreScanMs)) await this.enqueue(() => this.syncDrive({ tops: CORE_TOPS }, '확인(기억)'), { name: 'scan-core' });
          if (due('skills', legacy ? this.legacyScanMs * 5 : this.skillScanMs)) await this.enqueue(() => this.syncDrive({ tops: SLOW_TOPS }, '확인(스킬)'), { name: 'scan-skills' });
        }
      }
      if (this.intervalMs > 0) {
        if (due('local', this.intervalMs)) await this.enqueue(() => this.localCheck('주기'), { name: 'local' }); // 감시가 놓친 이 PC 변경
        if (this.peers.list().length && due('peers', this.intervalMs)) await this.enqueue(() => this.syncPeers('주기'), { name: 'peers' });
      }
    } finally { this.ticking = false; }
  }
  /** 모든 상대와 전체로 맞춘다(직접 시킴·연결 직후). 줄 서 있는 전체 맞추기가 있으면 그것을 같이 기다린다 */
  syncAll(reason = '') {
    if (this.allQueued) return this.allQueued;
    const p = this.enqueue(async () => {
      this.allQueued = null;
      const results = await this.syncPeers(reason);
      if (this.driveTarget()) { results.push(pub(await this.syncDrive({}, reason))); this.ran.core = this.ran.skills = this.ran.join = Date.now(); }
      return results;
    }, { announce: true, name: 'all' });
    this.allQueued = p;
    return p;
  }
  /** 상대 하나와 맞춘다(바깥에서 부르는 문) */
  syncPeer(peer, plan = {}) { return this.enqueue(async () => pub(await this._syncPeer(peer, plan)), { announce: true }); }
  /** 연결된 PC들: 같은 드라이브 폴더로 맞추는 사이면 가볍게 확인만 하고 쉰다. 아니면 PC끼리 직접 맞춘다 */
  async syncPeers(reason = '') {
    const results = [];
    for (const peer of this.peers.list()) {
      const t0 = Date.now();
      const r = await this.syncHttpPeer(peer).catch((e) => ({ peer: peer.id, ok: false, error: String(e.message || e) }));
      this.note(reason, r.via === 'drive' ? `${peer.name || peer.id} 확인` : `${peer.name || peer.id} 직접`, r, Date.now() - t0);
      results.push(pub(r));
    }
    this.ran.peers = Date.now();
    return results;
  }
  rest(peer) {
    const st = this.peerState(peer.id);
    if (st.via !== 'drive' || st.ok !== true || st.error) this.dirty = true;
    st.via = 'drive'; st.ok = true; st.error = null; st.lastAt = iso();
    return { peer: peer.id, ok: true, via: 'drive' };
  }
  async syncHttpPeer(peer) {
    const mine = this.driveHubId();
    const old = (this.oldPeers ||= new Map());
    if (mine && !(Date.now() - (old.get(peer.id) || 0) < 30 * 60_000)) {
      let h = null;
      try { h = await this.peers.call(peer, '/api/shared/hello', { timeoutMs: 8000 }); old.delete(peer.id); }
      catch (e) {
        if (e.status === 501 || e.status === 404) old.set(peer.id, Date.now()); // 예전 버전: 목록 전체로 확인하고, 30분 뒤 다시 물어본다(그사이 업데이트됐을 수 있다)
        else { const st = this.peerState(peer.id); if (st.ok !== false) this.dirty = true; st.ok = false; st.error = `연결 안 됨: ${e.message}`; st.lastTry = iso(); return { peer: peer.id, ok: false, error: st.error }; }
      }
      if (h && h.driveHub === mine) return this.rest(peer);
    }
    return this._syncPeer(peer);
  }
  /** 드라이브 폴더와 맞춘다. 올린 것이 있으면 표시 파일에 적고 연결된 PC에 알린다 */
  async syncDrive(plan = {}, reason = '') {
    const t = this.driveTarget(); if (!t) return null;
    const st = this.peerState(t.id);
    if (!st.joined) plan = {}; // 처음 기준을 잡기 전에는 전체로
    const t0 = Date.now();
    const r = await this._syncPeer(t, plan).catch((e) => ({ peer: t.id, ok: false, error: String(e.message || e) }));
    this.note(reason, plan.rels ? `파일 ${plan.rels.length}개` : plan.tops ? (plan.tops === SLOW_TOPS ? '스킬 훑기' : '기억 훑기') : '전체 훑기', r, Date.now() - t0);
    if (r.sent?.size && st.joined) {
      const mark = await this.writeMarker(t, r.sent).catch(() => null);
      if (mark) this.notify(t, mark);
    }
    return r;
  }
  /** 이 PC에서 바뀐 파일만 찾아 드라이브에 올린다(드라이브는 훑지 않는다). fromWatch = 파일이 바뀌어서 불림 */
  async localCheck(reason, fromWatch = false) {
    const t = this.driveTarget();
    if (t && !this.state.peers[t.id]?.joined) await this.syncDrive({}, reason);
    else if (t) {
      let local = null; try { local = scanShared(this.root); } catch {}
      if (local) {
        const base = this.peerState(t.id).base || {}, rels = [];
        // 다른 PC가 방금 고쳤다고 알린 파일은 그 내용이 드라이브에 올라온 뒤에 맞춘다(먼저 올리면 서로 덮는다)
        for (const [rel, f] of Object.entries(local)) if (!f.excluded && f.sha !== base[rel] && !driveSkipped(rel) && !this.pending.has(rel)) rels.push(rel);
        for (const rel of Object.keys(base)) if (!local[rel] && !skipped(rel) && !this.pending.has(rel)) rels.push(rel);
        if (rels.length) await this.syncDrive({ rels }, reason);
      }
    }
    // 드라이브로 맞추지 않는 PC(직접 맞추는 사이)는 이 PC 파일이 바뀌면 바로 그 PC와 맞춘다
    if (fromWatch && this.peers.list().some((p) => this.state.peers[p.id]?.via !== 'drive')) await this.syncPeers(reason);
    this.ran.local = Date.now();
  }

  /* ---- 표시 파일: 드라이브에 올린 변경을 적어 두면 다른 PC가 그 파일만 받는다 ---- */
  /** 이 PC 표시 파일에 이번에 올린 변경(sent: 경로 → 내용 해시|null)을 더한다 */
  async writeMarker(t, sent = new Map()) {
    const me = this.selfId(); if (!me) return null;
    const st = this.peerState(t.id), m = (st.marker ||= { seq: 0, floor: 0, changes: [] });
    if (sent.size) {
      m.seq++;
      const names = new Set(sent.keys());
      m.changes = m.changes.filter((c) => !names.has(c.rel));
      for (const [rel, id] of sent) m.changes.push({ rel, sha: id ?? null, seq: m.seq });
      // 넘치는 옛 변경은 버리고, 어디까지 버렸는지 적어 둔다(그보다 뒤처진 PC는 한 번 훑는다)
      if (m.changes.length > MARK_MAX) { const cut = m.changes.splice(0, m.changes.length - MARK_MAX); m.floor = Math.max(m.floor || 0, ...cut.map((c) => c.seq)); }
      this.dirty = true;
    }
    let name = ''; try { name = this.peers.self?.().name || ''; } catch {}
    const dir = path.join(t.folder, MARK_DIR);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${me}.json`), JSON.stringify({ v: 1, pc: me, name, seq: m.seq, floor: m.floor || 0, at: iso(), changes: m.changes }));
    return { seq: m.seq, floor: m.floor || 0, changes: m.changes.filter((c) => c.seq === m.seq) };
  }
  /** 다른 PC의 표시 파일을 확인한다(작은 파일 몇 개). 새로 적힌 변경만 받을 목록에 올린다 */
  async checkMarkers() {
    const t = this.driveTarget(); if (!t) return;
    const st = this.peerState(t.id); if (!st.joined) return;
    const me = this.selfId(); if (!me) return;
    const dir = path.join(t.folder, MARK_DIR), seen = (st.seen ||= {});
    let names;
    try { names = await fsp.readdir(dir); }
    catch (e) { if (e.code !== 'ENOENT') return; names = []; }
    if (!names.includes(`${me}.json`)) await this.writeMarker(t).catch(() => {}); // 이 PC도 표시 파일을 쓴다는 것을 알린다
    let others = 0, full = false; const fresh = [];
    for (const n of names) {
      const hit = /^([\w-]{1,64})\.json$/.exec(n); if (!hit || hit[1] === me) continue; // "이름 (1).json" 같은 드라이브 충돌 사본은 보지 않는다
      others++;
      const file = path.join(dir, n), pc = hit[1];
      let s; try { s = await fsp.stat(file); } catch { continue; }
      const sig = `${s.mtimeMs}:${s.size}`; if (this.markStat.get(n) === sig) continue; // 안 바뀐 표시 파일은 다시 읽지 않는다
      let j; try { j = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { continue; } // 쓰는 중이면 다음 차례에
      this.markStat.set(n, sig);
      if (j?.v !== 1 || !Number.isInteger(j.seq) || !Array.isArray(j.changes)) continue;
      const was = seen[pc];
      if (was === j.seq) continue;
      seen[pc] = j.seq; this.dirty = true;
      if (was == null) continue; // 처음 본 표시 파일: 켠 직후의 전체 맞추기가 이미 맞췄다
      if (j.seq < was || (j.floor || 0) > was) { full = true; continue; } // 표시가 처음부터 다시 시작됐거나 놓친 변경이 목록에서 밀려남
      for (const c of j.changes) if (c && c.seq > was) fresh.push(c);
    }
    this.markerPeers = others;
    st.lastAt = iso();
    if (full) this.scanSoon('표시 파일(놓친 변경)');
    if (fresh.length) this.expect(fresh);
  }
  /** 다른 PC가 올렸다고 알린 변경을 받을 목록에 올리고, 드라이브에 올라올 때까지 그 파일만 다시 본다 */
  expect(entries) {
    const t = this.driveTarget(); if (!t) return 0;
    const base = this.peerState(t.id).base || {};
    let added = 0;
    for (const c of entries.slice(-MARK_MAX * 2)) {
      let rel; try { rel = safeRel(c?.rel); } catch { continue; }
      if (driveSkipped(rel)) continue;
      const want = c.sha == null ? null : SHA_RE.test(String(c.sha)) ? String(c.sha) : undefined;
      if (want === undefined || (base[rel] ?? null) === want) continue; // 이미 받은 내용
      if (this.pending.get(rel) !== want) added++;
      this.pending.set(rel, want);
    }
    if (added) { this.catchStep = 0; this.armCatch(); }
    return added;
  }
  armCatch() {
    clearTimeout(this.catchTimer); this.catchTimer = null;
    if (this.closed || !this.pending.size) return;
    if (this.catchStep >= this.catchSteps.length) { this.pending.clear(); return; } // 끝내 안 오면 안전망 훑기에 맡긴다
    this.catchTimer = setTimeout(() => this.catchUp().catch(() => {}), this.catchSteps[this.catchStep++]);
    this.catchTimer.unref?.();
  }
  /** 받을 목록의 파일만 드라이브에서 확인해, 알린 내용이 와 있는 것만 받는다 */
  catchUp() {
    return this.enqueue(async () => {
      const t = this.driveTarget(); if (!t || !this.pending.size) return null;
      const expect = new Map(this.pending);
      const r = await this.syncDrive({ rels: [...expect.keys()], expect }, '알림 받은 파일');
      const base = this.peerState(t.id).base || {};
      for (const [rel, want] of expect) if (((base[rel] ?? null) === want || r?.touched?.has(rel)) && this.pending.get(rel) === want) this.pending.delete(rel);
      return pub(r);
    }, { name: 'catch-up' }).finally(() => this.armCatch());
  }
  /** 놓친 변경이 있을 수 있을 때: 곧 한 번, 조금 뒤 한 번 더 훑는다(드라이브에 올라오는 데 시간이 걸린다) */
  scanSoon(reason) {
    for (const ms of [3000, 60_000, 240_000]) this.later(() => this.enqueue(() => this.syncDrive({}, reason), { name: 'scan-all' }).catch(() => {}), ms);
  }
  /** 연결된 PC 허브에 "드라이브에 올렸다"고 바로 알린다. 파일은 보내지 않는다(드라이브로만 간다) */
  notify(t, mark) {
    if (!this.notifyOn) return;
    const from = this.selfId(); if (!from) return;
    const bulk = mark.changes.length >= MARK_MAX || (mark.floor || 0) >= mark.seq;
    for (const p of this.peers.list()) {
      this.peers.call(p, '/api/shared/changed', { method: 'POST', body: { hub: t.hubId, from, seq: mark.seq, bulk, changes: mark.changes.slice(-MARK_MAX) }, timeoutMs: 5000 }).catch(() => {});
    }
  }
  /** 다른 PC의 알림을 받았다: 같은 드라이브 폴더로 맞추는 사이면 그 파일들을 받을 목록에 올린다 */
  onChanged(b = {}) {
    const t = this.driveTarget();
    if (!t || !b || b.hub !== t.hubId) return { ok: true, ignored: true };
    const st = this.peerState(t.id);
    if (!st.joined) return { ok: true, waiting: true };
    const pc = String(b.from || ''), seq = Number(b.seq);
    if (b.bulk) this.scanSoon('다른 PC 알림(많이 바뀜)');
    const added = this.expect(Array.isArray(b.changes) ? b.changes.slice(0, MARK_MAX) : []);
    // 바로 앞 번호까지 본 PC면 이 번호도 본 것으로 적는다(건너뛴 번호가 있으면 표시 파일에서 다시 읽는다)
    if (ID_RE.test(pc) && Number.isInteger(seq)) { const seen = (st.seen ||= {}); if (seen[pc] === seq - 1) { seen[pc] = seq; this.dirty = true; } }
    return { ok: true, waiting: this.pending.size, added };
  }

  /** 상대 하나와 맞춘다. plan: {} 전체 · { tops } 맨 위 항목 몇 개만 · { rels } 고른 파일만(훑지 않음)
   *  · { rels, expect: Map(경로 → 다른 PC가 알린 내용 해시|null) } 알린 내용이 상대 쪽에 와 있는 파일만.
   *  돌려주는 값의 sent = 상대 쪽에 쓴 것(경로 → 해시|null), touched = 이번에 손댄 경로 */
  async _syncPeer(peer, plan = {}) {
    const st = this.peerState(peer.id), base = st.base || {};
    if (peer.folder && !st.joined && (plan.rels || plan.tops)) plan = {};
    const counts = { pulled: 0, pushed: 0, merged: 0, conflicts: 0, deleted: 0 }, errors = [], sent = new Map(), touched = new Set();
    const valid = (r) => { try { safeRel(r); return !(peer.folder && driveSkipped(r)); } catch { return false; } };
    const only = plan.rels ? [...new Set(plan.rels)].filter(valid) : null;
    const tops = !only && plan.tops ? plan.tops : null;
    const partial = !!(only || tops);
    const stop = (msg) => { if (st.ok !== false || st.error !== msg) this.dirty = true; st.ok = false; st.error = msg; st.lastTry = iso(); return { peer: peer.id, ok: false, error: msg }; };
    let remote;
    try { remote = await this.manifestOf(peer, { tops, rels: only }); }
    catch (e) { return stop(peer.folder ? `드라이브 폴더를 읽지 못함: ${e.message}` : `연결 안 됨: ${e.message}`); }
    // 두 PC가 같은 드라이브 ODDIN 폴더로 맞추는 중이면 PC끼리는 쉰다(기준은 그대로 두었다가 드라이브가 멈추면 다시 맞춘다)
    if (!peer.folder) {
      const mine = this.driveHubId();
      if (mine && remote?.driveHub === mine) return this.rest(peer);
      if (st.via) { st.via = null; this.dirty = true; }
    }
    let local;
    try { local = only ? statShared(this.root, only) : scanShared(this.root, { tops }); }
    catch (e) { return stop(`이 PC 목록을 끝까지 읽지 못해 맞추지 않았어요: ${e.message}`); }
    if (!remote?.files || typeof remote.files !== 'object' || Array.isArray(remote.files)) throw error(502, '상대 파일 목록이 올바르지 않아요');
    const rfiles = remote.files, from = remote.machine || peer.name;
    const onlySet = only ? new Set(only) : null;
    const covered = onlySet ? (rel) => onlySet.has(rel) : tops ? (rel) => tops.includes(rel.split('/')[0]) : () => true;
    const keys = (only || [...new Set([...Object.keys(local), ...Object.keys(rfiles)])].filter((r) => valid(r) && covered(r)))
      .sort((a, b) => (UNION.test(a) - UNION.test(b)) || a.localeCompare(b)); // 목록 파일은 다른 파일을 다 맞춘 뒤에
    // 다른 PC가 만든 드라이브 폴더를 처음 보면 한동안은 같은 파일만 기준으로 삼는다(만든 PC가 올리는 중인 파일을 또 올리지 않게)
    if (peer.folder && !st.joined) {
      this.dirty = true;
      if (peer.creator) st.joined = true;
      else {
        st.joinUntil ||= Date.now() + this.joinMs;
        if (Date.now() < st.joinUntil) {
          let same = 0;
          for (const rel of keys) if (local[rel] && local[rel].sha === rfiles[rel]?.sha) { base[rel] = local[rel].sha; same++; }
          st.base = base; st.lastAt = iso(); st.ok = true; st.error = null; st.counts = { pulled: 0, pushed: 0, merged: 0, conflicts: 0, deleted: 0, same, waiting: keys.length - same };
          return { peer: peer.id, ok: true, joining: true, same, waiting: keys.length - same };
        }
        st.joined = true;
      }
    }
    // 상대 쪽에서 맞춰 둔 파일이 한꺼번에 많이 사라졌으면(폴더가 비어 보임·덜 내려받음) 이 PC 기억을 지우지 않고 멈춘다.
    // 다른 PC가 지웠다고 알린 파일은 세지 않는다
    const announced = (rel) => !!plan.expect && plan.expect.get(rel) === null;
    const gone = keys.filter((rel) => base[rel] && !announced(rel) && ((!rfiles[rel] && local[rel]?.sha === base[rel]) || (!local[rel] && rfiles[rel]?.sha === base[rel]))).length;
    if (gone > Math.max(10, Object.keys(base).length * 0.3)) return stop(`${peer.folder ? '드라이브' : from} 쪽에서 파일 ${gone}개가 한꺼번에 사라져 보여서 지우지 않고 멈췄어요`);
    // 이번에 보지 않은 파일의 기준은 그대로 둔다
    const next = {};
    if (partial) for (const [rel, id] of Object.entries(base)) if (!covered(rel)) next[rel] = id;
    const push = async (rel, body) => { const r = await this.call(peer, '/api/shared/file', { method: 'POST', body: { rel, ...body } }); sent.set(rel, body.delete ? null : r?.sha ?? null); touched.add(rel); return r; };
    const pull = async (rel) => this.call(peer, `/api/shared/file?rel=${encodeURIComponent(rel)}`);
    const localBuf = (rel) => fs.readFileSync(fileOf(this.root, rel));
    const writeLocal = (rel, buf, mtime, expect, tag) => {
      const file = fileOf(this.root, rel);
      if (currentSha(file) !== expect) throw error(409, '이 PC에서 그사이 바뀜');
      if (tag && expect) backup(this.root, rel, file, tag);
      writeAtomic(file, buf, mtime); touched.add(rel);
    };
    this.applying = true;
    try {
      for (const rel of keys) {
        if (local[rel]?.excluded || rfiles[rel]?.excluded) { if (base[rel]) next[rel] = base[rel]; continue; }
        const L = local[rel]?.sha ?? null, R = rfiles[rel]?.sha ?? null, B = base[rel] ?? null;
        // 알림 받은 파일: 알린 내용이 아직 안 올라왔으면 이번에는 건드리지 않는다(옛 내용을 받거나 지우지 않게)
        if (plan.expect?.has(rel) && R !== plan.expect.get(rel)) { if (B) next[rel] = B; continue; }
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
            else { const file = fileOf(this.root, rel); if (currentSha(file) === L) { backup(this.root, rel, file, `지움-${from}`); fs.rmSync(file, { force: true }); } touched.add(rel); counts.deleted++; }
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
          // 글 파일(지침·메모리 등): 마지막으로 맞춘 내용을 기준으로 줄 단위로 합친다. 합치기 전 두 판은 backups/sync 에
          const mineNewer = local[rel].mtime >= (rfiles[rel].mtime || 0);
          const merged = this.mergeText(rel, B, mine, theirs, mineNewer, peer.folder ? '다른 PC' : from);
          if (merged) {
            writeLocal(rel, merged.buf, null, L, `합치기전-이PC`);
            const r = await push(rel, { content: merged.buf.toString('base64'), ifSha: R, backup: true });
            next[rel] = r.sha; counts.merged++; if (merged.conflicts) counts.conflicts++;
            continue;
          }
          // 합칠 수 없는 파일(그림·스크립트의 같은 곳을 서로 고침 등): 최근 판을 쓰고 다른 판은 backups/sync 에
          if (mineNewer) { const r = await push(rel, { content: mine.toString('base64'), mtime: local[rel].mtime, ifSha: R, backup: true }); next[rel] = r.sha; }
          else { writeLocal(rel, theirs, f.mtime, L, `밀림-${from}`); next[rel] = f.sha; }
          counts.conflicts++;
        } catch (e) {
          if (B) next[rel] = B; // 실패한 파일은 기준을 그대로 두고 다음 차례에 다시
          errors.push(`${rel}: ${e.message}`);
        }
      }
    } finally { this.applying = false; }
    this.keepObjects(next, only);
    const ok = !errors.length, nk = Object.keys(next);
    if (st.ok !== ok || (st.error || null) !== (errors[0] || null) || nk.length !== Object.keys(base).length || nk.some((k) => next[k] !== base[k])) this.dirty = true;
    st.base = next; st.lastAt = iso(); st.ok = ok; st.error = errors[0] || null; st.errors = errors.length;
    if (!partial || anyCount(counts) || !st.counts) st.counts = counts; // 고른 파일만 본 차례가 아무것도 안 바꿨으면 지난 결과를 그대로 보여 준다
    return { peer: peer.id, ok, counts, errors: errors.slice(0, 5), sent, touched };
  }
}
