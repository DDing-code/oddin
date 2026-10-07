// 공유 폴더(읽기용 사본) (2026-10-05 사용자 "따로 개발한 플러그인 같은 건 파일까지 공유해야 어떻게 구현됐는지 알 수 있다").
// 각 PC가 공유할 폴더(예: 어도비 플러그인 소스)를 정하면, 연결된 PC의 ODDIN 이 그 폴더를 받아
// ~/.ai-shared/peer-files/<원본 PC 이름>/<폴더 이름>/ 에 읽기용 사본으로 계속 맞춰 둔다.
// - 한 방향(원본 → 사본)만. 사본을 고쳐도 원본은 그대로이고 다음 차례에 원본 내용으로 돌아간다. 고치려면 원본 PC에서.
// - 코드 위주: node_modules·.git·빌드 결과·캐시 폴더, 2MB 넘는 파일, 미디어·압축 파일은 뺀다. 폴더당 5,000개·100MB까지.
// - ~/.ai-shared/peer-files 는 공유 기억 동기화 범위(SHARED_TOP) 밖이라 다시 돌려보내지 않는다. 목록은 peer-files/INDEX.md.
// - 구글 드라이브 ODDIN 폴더(lib/drive-hub.mjs)가 있으면 원본 PC가 드라이브 ODDIN/자산/소스/<폴더>/ 로 올린다(publish).
//   상대 PC도 같은 ODDIN 폴더를 쓰면(offer 의 driveHub 가 같으면) peer-files 로 받지 않고 드라이브 사본을 쓴다(목록에 드라이브 위치).
//   PC 구분 없이 자산/소스/<이름>(이름이 겹치면 "<이름> (<PC>)")에 두고 자산 목록(목록.md·공유 기억 reference-oddin-assets)에 적는다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.mjs';
import { readCatalog, upsertCatalog, removeCatalog, writeAssetMemory } from './oddin-assets.mjs';

const SRC_CAT = '소스'; // 드라이브 ODDIN 자산에서 공유 폴더 사본이 들어가는 분류

const FILE = () => path.join(DATA_DIR, 'shared-folders.json');
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'coverage', '.turbo', 'target', 'bin', 'obj']);
const SKIP_EXT = /\.(mp4|mov|m4v|mkv|avi|webm|wav|mp3|m4a|flac|aac|ogg|zip|7z|rar|tar|gz|iso|exe|dll|msi|psd|aep|prproj|aepx|mogrt|pdb|lib|node|ttf|otf|woff2?)$/i;
const MAX_FILE = 2 * 1024 * 1024, MAX_FILES = 5000, MAX_BYTES = 100 * 1024 * 1024;
// 기본은 코드·문서만(2026-10-05: 회사 YM_Inv 가 그림·PDF 로 100MB 한도를 채워 코드가 밀려났다). 그림까지는 mode 'all'
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|jsxinc|py|pyi|ps1|psm1|cmd|bat|sh|json|jsonc|md|txt|html?|css|scss|less|ya?ml|toml|ini|cfg|conf|xml|svg|csv|sql|lua|rs|go|java|kt|c|h|cpp|hpp|cs|vue|svelte|astro|lock|gitignore|env\.example)$/i;
export const MODES = { code: '코드·문서만', all: '그림 포함' };
const error = (status, message) => Object.assign(new Error(message), { status });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const cleanName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60) || '폴더';

const cache = new Map(); // 전체 경로 → { mtime, size, sha }
/** 폴더 훑기: 상대 경로 → { sha, size, mtime } (뺄 것 빼고, 한도까지) */
export function scanFolder(root, mode = 'code') {
  const files = {}; let count = 0, bytes = 0, truncated = false, excluded = false;
  const walk = (dir, rel) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { excluded = true; continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.git')) walk(full, r); continue; }
      if (!e.isFile() || SKIP_EXT.test(e.name) || (mode !== 'all' && !CODE_EXT.test(e.name))) continue;
      const st = fs.statSync(full);
      if (st.size > MAX_FILE) { excluded = true; continue; }
      if (count + 1 > MAX_FILES || bytes + st.size > MAX_BYTES) { truncated = true; return; }
      const hit = cache.get(full);
      const hash = hit && hit.mtime === st.mtimeMs && hit.size === st.size ? hit.sha : sha(fs.readFileSync(full));
      cache.set(full, { mtime: st.mtimeMs, size: st.size, sha: hash });
      files[r] = { sha: hash, size: st.size, mtime: st.mtimeMs }; count++; bytes += st.size;
    }
  };
  walk(root, '');
  return { files, count, bytes, truncated: truncated || excluded };
}
const safeRel = (rel) => {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!r || r.startsWith('/') || /^[a-z]:/i.test(r) || r.split('/').some((s) => !s || s === '.' || s === '..') || /[\0:*?"<>|]/.test(r)) throw error(400, '잘못된 경로예요');
  return r;
};

const within = (p, dir) => path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);

export class SharedFolders extends EventEmitter {
  /** hub() = 쓰는 중인 드라이브 ODDIN 폴더(DriveHub.info) 또는 null */
  constructor({ hubDir, peers, intervalMs = 120_000, hub = () => null, file = FILE() }) {
    super();
    this.hubDir = hubDir; this.peers = peers; this.hub = () => { try { return hub() || null; } catch { return null; } }; this.mirrorRoot = path.join(hubDir, 'peer-files');
    this.file = file; this.data = readJson(file, null) || {}; this.data.folders ||= []; this.data.mirrors ||= {}; this.data.published ||= {};
    this.running = null;
    if (intervalMs > 0) this.timer = setInterval(() => this.pullAll().catch(() => {}), intervalMs).unref();
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeJsonAtomic(this.file, this.data); }
  close() { clearInterval(this.timer); }
  /* ---- 이 PC가 공유하는 폴더 ---- */
  own() {
    return this.data.folders.map((f) => {
      const exists = fs.existsSync(f.path); const s = exists ? scanFolder(f.path, f.mode) : { count: 0, bytes: 0, truncated: false };
      return { id: f.id, name: f.name, path: f.path, mode: f.mode || 'code', addedAt: f.addedAt, exists, files: s.count, bytes: s.bytes, truncated: s.truncated, published: this.hub() ? this.data.published[f.id] || null : null };
    });
  }
  offer() { return { machine: this.peers.self().name, driveHub: this.hub()?.id || null, folders: this.own().map(({ id, name, files, bytes, truncated }) => ({ id, name, files, bytes, truncated, driveRel: this.data.published[id]?.rel || null })) }; }
  /** 이 PC 공유 폴더를 드라이브 ODDIN/자산/<이 PC>/<폴더>/ 로 올린다(한 방향, 원본과 같게). 공유를 그만둔 폴더는 드라이브에서도 지운다 */
  publish() {
    const h = this.hub(); if (!h) return null;
    const pub = this.data.published, me = this.peers.self().name, done = [], srcDir = path.join(h.assets, SRC_CAT);
    const catalog = readCatalog(h.assets); let catalogChanged = false;
    const relOf = (dir) => path.relative(h.assets, dir).split(path.sep).join('/');
    for (const f of this.data.folders) {
      if (!fs.existsSync(f.path)) continue;
      // PC 구분 없이 자산/소스/<이름>. 같은 이름을 다른 PC가 먼저 쓰고 있으면 "<이름> (<PC>)"
      let dir = pub[f.id]?.name === f.name && pub[f.id]?.dir && within(pub[f.id].dir, srcDir) ? pub[f.id].dir : null;
      if (!dir) {
        const base = path.join(srcDir, cleanName(f.name));
        dir = fs.existsSync(base) && !Object.values(pub).some((p) => p.dir === base) ? path.join(srcDir, cleanName(`${f.name} (${me})`)) : base;
      }
      const at = new Date().toISOString(), counts = { put: 0, removed: 0 };
      try {
        const src = scanFolder(f.path, f.mode || 'code'), dst = fs.existsSync(dir) ? scanFolder(dir, 'all').files : {};
        if (src.truncated && pub[f.id]?.dir && pub[f.id].dir !== dir) throw error(409, '전체 목록을 읽지 못해 기존 사본을 옮기지 않았어요');
        for (const [rel, info] of Object.entries(src.files)) {
          if (dst[rel]?.sha === info.sha) continue;
          const to = path.join(dir, ...rel.split('/'));
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(f.path, ...rel.split('/')), to);
          const t = new Date(info.mtime); try { fs.utimesSync(to, t, t); } catch {}
          counts.put++;
        }
        if (!src.truncated) for (const rel of Object.keys(dst)) if (!src.files[rel]) { fs.rmSync(path.join(dir, ...rel.split('/')), { force: true }); counts.removed++; }
        if (pub[f.id]?.dir && pub[f.id].dir !== dir && within(pub[f.id].dir, h.assets)) { // 이름이 바뀜·예전 자리(자산/<PC>/…)
          fs.rmSync(pub[f.id].dir, { recursive: true, force: true });
          if (pub[f.id].rel) { removeCatalog(h.assets, pub[f.id].rel); catalogChanged = true; }
        }
        const rel = relOf(dir), rest = `${me} PC가 공유하는 폴더의 사본(${f.mode === 'all' ? '그림 포함' : '코드·문서만'}) — 원본 ${f.path}, 원본 PC의 ODDIN이 계속 맞춤`;
        const was = catalog.find((x) => x.rel === rel);
        if (!was || was.name !== f.name || was.rest !== rest) { upsertCatalog(h.assets, { name: f.name, rel, rest }); catalogChanged = true; }
        pub[f.id] = { name: f.name, dir, rel, files: src.count, truncated: src.truncated, at, ok: true, error: null };
        done.push({ name: f.name, ...counts });
      } catch (e) { pub[f.id] = { name: f.name, dir, ...(pub[f.id] || {}), at, ok: false, error: e.message }; }
    }
    for (const [id, p] of Object.entries(pub)) {
      if (this.data.folders.some((f) => f.id === id)) continue;
      if (p.dir && within(p.dir, h.assets)) fs.rmSync(p.dir, { recursive: true, force: true });
      if (p.rel) { removeCatalog(h.assets, p.rel); catalogChanged = true; }
      delete pub[id];
    }
    // 예전 자리(자산/<이 PC>/)가 비었으면 지운다
    try { const old = path.join(h.assets, cleanName(me)); if (fs.existsSync(old) && !fs.readdirSync(old).length) fs.rmdirSync(old); } catch {}
    if (catalogChanged) { try { writeAssetMemory(this.hubDir, h.assets); } catch {} }
    this.save();
    return { ok: true, folders: done };
  }
  add({ path: p, name, mode = 'code' }) {
    if (!MODES[mode]) throw error(400, '공유 방식은 code(코드·문서만) 또는 all(그림 포함)');
    const abs = path.resolve(String(p || '').trim().replace(/^"|"$/g, ''));
    let st; try { st = fs.statSync(abs); } catch { throw error(404, '그 폴더를 찾지 못했어요'); }
    if (!st.isDirectory()) throw error(400, '폴더를 골라 주세요');
    if (abs.toLowerCase().startsWith(this.mirrorRoot.toLowerCase())) throw error(400, '다른 PC에서 받은 사본은 다시 공유할 수 없어요');
    if (this.data.folders.some((f) => f.path.toLowerCase() === abs.toLowerCase())) throw error(409, '이미 공유 중인 폴더예요');
    const n = cleanName(name || path.basename(abs));
    if (this.data.folders.some((f) => f.name === n)) throw error(409, '같은 이름의 공유 폴더가 이미 있어요');
    const f = { id: randomUUID().slice(0, 8), name: n, path: abs, mode, addedAt: new Date().toISOString() };
    this.data.folders.push(f); this.save();
    return { ...f, ...(() => { const s = scanFolder(abs, mode); return { files: s.count, bytes: s.bytes, truncated: s.truncated }; })() };
  }
  setMode(id, mode) {
    if (!MODES[mode]) throw error(400, '공유 방식은 code(코드·문서만) 또는 all(그림 포함)');
    const f = this.data.folders.find((x) => x.id === id); if (!f) throw error(404, '공유 폴더를 찾지 못했어요');
    f.mode = mode; this.save(); return this.own().find((x) => x.id === id);
  }
  remove(id) {
    const before = this.data.folders.length;
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    if (before === this.data.folders.length) throw error(404, '공유 폴더를 찾지 못했어요');
    this.save(); return { ok: true };
  }
  folder(id) { const f = this.data.folders.find((x) => x.id === id); if (!f || !fs.existsSync(f.path)) throw error(404, '공유 폴더를 찾지 못했어요'); return f; }
  manifest(id) { const f = this.folder(id); const s = scanFolder(f.path, f.mode); return { id, name: f.name, machine: this.peers.self().name, files: s.files, truncated: s.truncated }; }
  read(id, rel) {
    const f = this.folder(id), r = safeRel(rel), file = path.join(f.path, ...r.split('/'));
    if (!path.resolve(file).toLowerCase().startsWith(path.resolve(f.path).toLowerCase() + path.sep)) throw error(400, '잘못된 경로예요');
    if (!scanFolder(f.path, f.mode).files[r]) throw error(404, '공유 범위 밖 파일이에요');
    const buf = fs.readFileSync(file); const st = fs.statSync(file);
    return { rel: r, sha: sha(buf), mtime: st.mtimeMs, content: buf.toString('base64') };
  }
  /* ---- 다른 PC에서 받은 사본 ---- */
  mirrors() {
    const out = [];
    for (const [key, m] of Object.entries(this.data.mirrors)) out.push({ key, ...m, dir: m.drive ? m.driveDir : path.join(this.mirrorRoot, m.peerDir, m.dirName) });
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async pullAll() {
    if (this.running) return this.running;
    this.running = (async () => {
      const results = [];
      try { const r = this.publish(); if (r) results.push({ drive: true, ...r }); } catch (e) { results.push({ drive: true, ok: false, error: e.message }); }
      for (const peer of this.peers.list()) results.push(await this.pullPeer(peer).catch((e) => ({ peer: peer.name, ok: false, error: e.message })));
      this.writeIndex();
      return results;
    })();
    try { return await this.running; } finally { this.running = null; this.emit('status', { own: this.own(), mirrors: this.mirrors() }); }
  }
  async pullPeer(peer) {
    let offer;
    try { offer = await this.peers.call(peer, '/api/shared-folders/offer'); }
    catch (e) { return { peer: peer.name, ok: false, error: `연결 안 됨: ${e.message}` }; }
    if (!Array.isArray(offer?.folders)) return { peer: peer.name, ok: false, error: '상대 공유 폴더 목록이 올바르지 않아요' };
    const peerDir = cleanName(offer.machine || peer.name), seen = new Set(), done = [];
    const h = this.hub(), viaDrive = !!h && !!offer.driveHub && offer.driveHub === h.id;
    for (const f of viaDrive ? offer.folders || [] : []) {
      // 같은 드라이브 ODDIN 폴더: 원본 PC가 드라이브 자산/<PC>/<폴더>로 올리므로 그대로 쓴다. 예전에 받은 peer-files 사본은 지운다
      const key = `${peer.id}:${f.id}`, dirName = cleanName(f.name), driveDir = path.join(h.assets, ...(f.driveRel ? f.driveRel.split('/') : [SRC_CAT, dirName])), old = path.join(this.mirrorRoot, peerDir, dirName);
      seen.add(key);
      const there = fs.existsSync(driveDir);
      if (there && !f.truncated && within(old, this.mirrorRoot)) fs.rmSync(old, { recursive: true, force: true });
      this.data.mirrors[key] = { peer: peer.name, peerId: peer.id, folderId: f.id, name: f.name, peerDir, dirName, drive: true, driveDir, files: f.files ?? null, truncated: !!f.truncated, at: new Date().toISOString(), ok: there, error: there ? null : '드라이브에 아직 안 보여요(원본 PC가 올리는 중)' };
      done.push({ name: f.name, drive: true });
    }
    for (const f of viaDrive ? [] : offer.folders || []) {
      const key = `${peer.id}:${f.id}`; seen.add(key);
      const dirName = cleanName(f.name), dir = path.join(this.mirrorRoot, peerDir, dirName);
      const counts = { got: 0, removed: 0 };
      try {
        const man = await this.peers.call(peer, `/api/shared-folders/${encodeURIComponent(f.id)}/manifest`, { timeoutMs: 60_000 });
        if (!man.files || typeof man.files !== 'object' || Array.isArray(man.files)) throw error(502, '상대 파일 목록이 올바르지 않아요');
        const local = fs.existsSync(dir) ? scanFolder(dir, 'all').files : {};
        for (const [rel, info] of Object.entries(man.files || {})) {
          let r; try { r = safeRel(rel); } catch { continue; }
          if (local[r]?.sha === info.sha) continue;
          const got = await this.peers.call(peer, `/api/shared-folders/${encodeURIComponent(f.id)}/file?rel=${encodeURIComponent(r)}`, { timeoutMs: 60_000 });
          const file = path.join(dir, ...r.split('/'));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(got.content, 'base64'));
          if (got.mtime) { const t = new Date(got.mtime); try { fs.utimesSync(file, t, t); } catch {} }
          counts.got++;
        }
        if (!man.truncated) for (const rel of Object.keys(local)) if (!man.files[rel]) { fs.rmSync(path.join(dir, ...rel.split('/')), { force: true }); counts.removed++; }
        this.data.mirrors[key] = { peer: peer.name, peerId: peer.id, folderId: f.id, name: f.name, peerDir, dirName, files: Object.keys(man.files || {}).length, truncated: !!man.truncated, at: new Date().toISOString(), ok: true, error: null };
        done.push({ name: f.name, ...counts });
      } catch (e) {
        this.data.mirrors[key] = { ...(this.data.mirrors[key] || { peer: peer.name, peerId: peer.id, folderId: f.id, name: f.name, peerDir, dirName }), ok: false, error: e.message, at: new Date().toISOString() };
      }
    }
    // 상대가 공유를 그만둔 폴더는 사본도 지운다
    for (const [key, m] of Object.entries(this.data.mirrors)) {
      if (m.peerId !== peer.id || seen.has(key)) continue;
      const dir = path.join(this.mirrorRoot, m.peerDir, m.dirName);
      if (dir.toLowerCase().startsWith(this.mirrorRoot.toLowerCase() + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
      delete this.data.mirrors[key];
    }
    this.save();
    return { peer: peer.name, ok: true, folders: done };
  }
  writeIndex() {
    const rows = this.mirrors();
    const text = ['# 다른 PC에서 공유한 폴더 (읽기용 사본)', '', 'ODDIN 이 만들고 고치는 목록이다. 사본을 고쳐도 원본은 그대로이며 다음 차례에 원본 내용으로 돌아간다. 고치려면 원본 PC에서 작업한다. 두 PC가 구글 드라이브 ODDIN 폴더를 함께 쓰면 사본은 드라이브 ODDIN/자산/<원본 PC>/<폴더>/ 에 있다(원본 PC가 올림).', '',
      '| 원본 PC | 폴더 | 사본 위치 | 파일 | 마지막으로 받음 |', '|---|---|---|---|---|',
      ...rows.map((m) => `| ${m.peer} | ${m.name} | ${m.dir} | ${m.files ?? '-'}${m.truncated ? ' (한도까지)' : ''} | ${m.at || '-'}${m.ok === false ? ` · 오류: ${m.error}` : ''} |`), ''].join('\n');
    fs.mkdirSync(this.mirrorRoot, { recursive: true });
    fs.writeFileSync(path.join(this.mirrorRoot, 'INDEX.md'), text);
  }
}
