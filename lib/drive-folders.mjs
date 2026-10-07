// 드라이브 작업 폴더 (2026-10-05 사용자 "PC 탭에서 구글 드라이브로 등록한 폴더를 등록하면 그 안에서 작업").
// 구글 드라이브 데스크탑이 두 PC에 맞춰 주는 폴더(내 드라이브·다른 컴퓨터 백업)를 ODDIN 작업 폴더로 등록한다.
// - 같은 폴더가 PC마다 다른 경로로 보인다(예: 회사 C:\…\Documents\작업폴더 = 집 D:\다른 컴퓨터\내 컴퓨터\작업폴더 (1)).
//   등록한 PC의 경로와 폴더 안 이름 목록(지문)을 남기면, 다른 PC의 ODDIN이 자기 드라이브·아는 폴더에서 지문이 맞는 폴더를 찾아 자기 경로를 채운다.
// - 목록은 ~/.ai-shared/sync/drive-folders.json(공유 기억 동기화로 두 PC가 함께 씀). 모든 경로를 같은 프로젝트 메모리로 잇는다(memoryAliases).
// - 실측(2026-10-05): 집에서 만든·지운 파일이 10~20초 안에 회사 원본에 반영됐다(다른 컴퓨터 백업도 양방향).
//   그래서 한 PC가 그 폴더로 작업 중이면 다른 PC의 작업은 끝날 때까지 기다린다(같은 파일 동시 수정 → 드라이브 충돌 사본).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic } from './util.mjs';

const error = (status, message) => Object.assign(new Error(message), { status });
const REG = (hubDir) => path.join(hubDir, 'sync', 'drive-folders.json');
const slugOf = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
const fwd = (p) => p.replace(/\\/g, '/');
const MY = ['내 드라이브', 'My Drive'], OTHERS = ['다른 컴퓨터', 'Other computers'];
const IGNORE = new Set(['desktop.ini', '.tmp.driveupload', '.tmp.drivedownload', 'Thumbs.db', '.DS_Store']);

/** 이 PC의 구글 드라이브: { root, myDrive, computers } 또는 null. 시험·다른 위치는 root 를 직접 준다 */
export function detectDrive(root = process.env.HUB_DRIVE_ROOT || null) {
  const roots = root ? [root] : (process.platform === 'win32' ? 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`) : []);
  for (const r of roots) {
    const my = MY.map((n) => path.join(r, n)).find((p) => fs.existsSync(p));
    if (!my) continue;
    return { root: r, myDrive: my, computers: OTHERS.map((n) => path.join(r, n)).find((p) => fs.existsSync(p)) || null };
  }
  return null;
}
/** 폴더 지문: 맨 위 항목 이름들 (드라이브가 붙이는 임시 폴더 빼고) */
export function fingerprint(dir) {
  try { return fs.readdirSync(dir).filter((n) => !IGNORE.has(n) && !n.startsWith('~$')).sort().slice(0, 120); } catch { return []; }
}
export function similarity(a, b) {
  const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0;
  let both = 0; for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}
const inside = (p, dir) => { const a = path.resolve(p).toLowerCase(), b = path.resolve(dir).toLowerCase(); return a === b || a.startsWith(b + path.sep); };

export async function guardDriveWrite(folder, peers) {
  if (!folder) return;
  if (!folder.confirmed) throw error(409, '이 PC의 공유 폴더 경로를 PC 탭에서 먼저 확인해 주세요');
  if (folder.ownerId !== peers.self().id) throw error(409, `이 공유 폴더는 ${folder.ownerName}에서 수정해요. 실행 PC를 ${folder.ownerName}로 골라 주세요`);
  for (const peer of peers.list()) {
    let busy;
    try { busy = await peers.call(peer, '/api/drive-folders/busy', { timeoutMs: 5000 }); }
    catch { throw error(503, `${peer.name} 상태를 확인하지 못해 공유 폴더 수정을 시작하지 않았어요`); }
    if (busy?._writerPolicy !== 'registered-owner-v1') throw error(409, `${peer.name}의 ODDIN을 업데이트해야 공유 폴더를 안전하게 수정할 수 있어요`);
    if (busy[folder.id]) throw error(409, `${peer.name}에서 이 공유 폴더를 사용 중이라 수정을 시작하지 않았어요`);
  }
}

export class DriveFolders {
  /** selfId·selfName: 이 PC(Peers.self), projects(): 이 PC가 아는 프로젝트 경로들, driveRoot: 시험용 */
  constructor({ hubDir, self, projects = () => [], driveRoot = null }) {
    this.hubDir = hubDir; this.self = self; this.projects = projects; this.driveRoot = driveRoot;
  }
  drive() { return detectDrive(this.driveRoot || undefined); }
  read() { const d = readJson(REG(this.hubDir), { folders: [] }); d.folders ||= []; return d; }
  write(d) { writeJsonAtomic(REG(this.hubDir), d); }
  confirmed(f, id) { return !!f.confirmed?.[id] || id === Object.keys(f.paths || {})[0]; }
  here(f) { const id = this.self().id, p = f.paths?.[id]; return this.confirmed(f, id) && p && fs.existsSync(p) ? p : null; }
  list(busy = {}) {
    const me = this.self().id;
    return this.read().folders.map((f) => {
      const here = this.here(f);
      return { id: f.id, name: f.name, addedAt: f.addedAt, here, hasGit: !!here && fs.existsSync(path.join(here, '.git')),
        others: Object.entries(f.paths || {}).filter(([id]) => id !== me).map(([id, p]) => ({ id, name: f.names?.[id] || '다른 PC', path: p })),
        ownerId: Object.keys(f.paths || {})[0], ownerName: f.names?.[Object.keys(f.paths || {})[0]] || '등록한 PC', busy: busy[f.id] || null };
    });
  }
  add({ path: p, name }) {
    const abs = path.resolve(String(p || '').trim().replace(/^"|"$/g, ''));
    let st; try { st = fs.statSync(abs); } catch { throw error(404, '그 폴더를 찾지 못했어요'); }
    if (!st.isDirectory()) throw error(400, '폴더를 골라 주세요');
    const d = this.read(), me = this.self();
    if (d.folders.some((f) => Object.values(f.paths || {}).some((x) => x.toLowerCase() === abs.toLowerCase()))) throw error(409, '이미 등록한 폴더예요');
    const fp = fingerprint(abs);
    if (!fp.length) throw error(400, '빈 폴더는 다른 PC에서 찾을 수 없어요. 파일이 있는 폴더를 등록해 주세요');
    const f = { id: randomUUID().slice(0, 8), name: String(name || path.basename(abs)).trim().slice(0, 60) || path.basename(abs), fingerprint: fp, paths: { [me.id]: abs }, names: { [me.id]: me.name }, addedAt: new Date().toISOString() };
    d.folders.push(f); this.write(d); this.updateAliases();
    return this.list().find((x) => x.id === f.id);
  }
  setPath(id, p) {
    const d = this.read(), f = d.folders.find((x) => x.id === id); if (!f) throw error(404, '드라이브 작업 폴더를 찾지 못했어요');
    const abs = path.resolve(String(p || '').trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(abs)) throw error(404, '그 폴더를 찾지 못했어요');
    const me = this.self(); f.paths[me.id] = abs; (f.names ||= {})[me.id] = me.name;
    if (!fs.statSync(abs).isDirectory()) throw error(400, '폴더를 골라 주세요');
    (f.confirmed ||= {})[me.id] = true;
    this.write(d); this.updateAliases(); return this.list().find((x) => x.id === id);
  }
  remove(id) {
    const d = this.read(), before = d.folders.length;
    d.folders = d.folders.filter((f) => f.id !== id);
    if (d.folders.length === before) throw error(404, '드라이브 작업 폴더를 찾지 못했어요');
    this.write(d); return { ok: true };
  }
  /** 다른 PC가 등록한 폴더의 이 PC 경로 찾기: 드라이브(내 드라이브 2단계·다른 컴퓨터 PC별 폴더)와 아는 프로젝트에서 지문이 가장 비슷한 곳 */
  /** 찾을 후보 [{path, rank}] — rank 0 이 PC의 원본(알려진 프로젝트), 1 내 드라이브, 2 다른 컴퓨터 백업.
   *  원본 PC의 드라이브에는 자기 백업도 "다른 컴퓨터"에 보이므로, 점수가 거의 같으면 원본을 고른다(드라이브 경유로 고치지 않게). */
  candidates() {
    const out = new Map(), dr = this.drive();
    const add = (p, rank) => { const k = path.resolve(p).toLowerCase(); if (!out.has(k) || out.get(k).rank > rank) out.set(k, { path: path.resolve(p), rank }); };
    const kids = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORE.has(e.name)).map((e) => path.join(dir, e.name)); } catch { return []; } };
    if (dr) {
      for (const a of kids(dr.myDrive)) { add(a, 1); for (const b of kids(a)) add(b, 1); }
      if (dr.computers) for (const pc of kids(dr.computers)) for (const a of kids(pc)) add(a, 2);
    }
    for (const p of this.projects()) if (p && fs.existsSync(p)) add(p, 0);
    return [...out.values()];
  }
  resolve() {
    const d = this.read(); const candidates = [];
    const need = d.folders.filter((f) => !this.here(f));
    if (need.length) {
      const cands = this.candidates().map((c) => ({ ...c, fp: fingerprint(c.path) }));
      for (const f of need) {
        let best = null;
        for (const c of cands) { const s = similarity(f.fingerprint || [], c.fp); if (s >= 0.6 && (!best || s > best.s + 0.05 || (s > best.s - 0.05 && c.rank < best.rank))) best = { ...c, s }; }
        if (best) candidates.push({ id: f.id, name: f.name, path: best.path, score: Math.round(best.s * 100) });
      }
    }
    this.updateAliases();
    return { found: [], candidates, missing: d.folders.filter((f) => !this.here(f)).map((f) => f.name) };
  }
  /** 등록한 폴더의 모든 경로를 같은 프로젝트 메모리로 (sync/config.json memoryAliases — 공유) */
  updateAliases() {
    const file = path.join(this.hubDir, 'sync', 'config.json');
    let cfg; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    const aliases = cfg.memoryAliases ||= {}; let changed = false;
    for (const f of this.read().folders) {
      const paths = Object.entries(f.paths || {}).filter(([id]) => this.confirmed(f, id)).map(([, p]) => p); if (!paths.length) continue;
      const known = paths.map((p) => aliases[fwd(p)]).find(Boolean);
      const slug = known || f.slug || slugOf(paths[0]);
      for (const [id, p] of Object.entries(f.paths || {})) if (!this.confirmed(f, id) && aliases[fwd(p)] === slug) { delete aliases[fwd(p)]; changed = true; }
      for (const p of paths) if (aliases[fwd(p)] !== slug) { aliases[fwd(p)] = slug; changed = true; }
    }
    if (changed) writeJsonAtomic(file, cfg);
    return changed;
  }
  /** cwd 가 들어 있는 드라이브 작업 폴더(이 PC 경로 기준) */
  folderOf(cwd) {
    if (!cwd) return null;
    for (const f of this.read().folders.sort((a, b) => (b.paths?.[this.self().id]?.length || 0) - (a.paths?.[this.self().id]?.length || 0))) { const h = f.paths?.[this.self().id]; if (h && inside(cwd, h)) return { id: f.id, name: f.name, here: h, confirmed: this.confirmed(f, this.self().id), ownerId: Object.keys(f.paths || {})[0], ownerName: f.names?.[Object.keys(f.paths || {})[0]] || '등록한 PC', others: Object.entries(f.paths || {}).filter(([id]) => id !== this.self().id).map(([id, p]) => ({ id, name: f.names?.[id] || '다른 PC', path: p })) }; }
    return null;
  }
}
