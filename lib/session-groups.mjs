// 세션 묶음 (2026-10-06 사용자 "세션을 폴더로 묶거나 작업 폴더를 고를 수 있게 해줘")
// 사이드바에서 사용자가 이름 붙인 묶음. 세션은 group 필드(묶음 id)로 들어간다. PC마다 data/session-groups.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, nowIso } from './util.mjs';

const error = (status, message) => Object.assign(new Error(message), { status });
const clean = (name) => String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);

export class SessionGroups {
  constructor({ file }) { this.file = file; this.data = readJson(file, null) || { groups: [] }; if (!Array.isArray(this.data.groups)) this.data.groups = []; }
  save() { writeJsonAtomic(this.file, this.data); }
  list() { return this.data.groups.map((g) => ({ ...g })); }
  has(id) { return this.data.groups.some((g) => g.id === id); }
  create(name) {
    const n = clean(name); if (!n) throw error(400, '묶음 이름을 적어 주세요');
    if (this.data.groups.length >= 50) throw error(400, '묶음은 50개까지 만들 수 있어요');
    const g = { id: `g-${crypto.randomBytes(5).toString('hex')}`, name: n, createdAt: nowIso() };
    this.data.groups.push(g); this.save(); return { ...g };
  }
  rename(id, name) {
    const g = this.data.groups.find((x) => x.id === id); if (!g) throw error(404, '묶음이 없어요');
    const n = clean(name); if (!n) throw error(400, '묶음 이름을 적어 주세요');
    g.name = n; this.save(); return { ...g };
  }
  /** 묶음을 지운다(세션은 그대로, 묶음에서만 빠진다 — 세션 정리는 부르는 쪽이 한다) */
  remove(id) {
    const before = this.data.groups.length;
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    if (this.data.groups.length === before) throw error(404, '묶음이 없어요');
    this.save(); return true;
  }
  /** 순서 바꾸기: ids 순서대로(빠진 것은 뒤에 그대로) */
  reorder(ids = []) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.data.groups.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
    this.save(); return this.list();
  }
}

/** 폴더 둘러보기(작업 폴더 고르기 창): 하위 폴더 이름만. 숨김·시스템 폴더는 뺀다. 빈 경로면 드라이브 목록 */
export function listDirs(raw) {
  const p = String(raw || '').trim();
  if (!p) {
    const drives = process.platform === 'win32'
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => { try { return fs.existsSync(d); } catch { return false; } })
      : ['/'];
    return { path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })) };
  }
  const dir = path.resolve(p);
  let entries;
  try { if (!fs.statSync(dir).isDirectory()) throw error(400, '폴더가 아니에요'); entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (e.status) throw e; throw error(404, '폴더를 열 수 없어요'); }
  const SKIP = /^(\$|\.|node_modules$|System Volume Information$|Recovery$|Config\.Msi$|pagefile|hiberfil|swapfile)/i;
  const dirs = entries.filter((e) => { try { return (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory())) && !SKIP.test(e.name); } catch { return false; } })
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
    .slice(0, 800);
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, dirs, truncated: entries.length > 800 };
}

/* ---------- 폴더 찾아보기 창의 새 폴더·이름 바꾸기 (2026-10-08 사용자 "작업폴더 바꾸기 팝업창에 새 폴더/이름바꾸기 기능도 넣어줘") ---------- */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** 폴더 이름 검사: Windows 에서 못 쓰는 글자·예약 이름·끝 점/빈칸 */
export function checkFolderName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw error(400, '폴더 이름을 적어 주세요');
  if (name.length > 120) throw error(400, '폴더 이름이 너무 길어요(120자까지)');
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) throw error(400, '폴더 이름에 \\ / : * ? " < > | 는 쓸 수 없어요');
  if (name === '.' || name === '..' || /[. ]$/.test(name)) throw error(400, '폴더 이름은 점이나 빈칸으로 끝날 수 없어요');
  if (RESERVED.test(name)) throw error(400, `"${name}"은 Windows가 쓰는 이름이라 폴더 이름으로 쓸 수 없어요`);
  return name;
}
const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const within = (p, dir) => { const a = norm(p), b = norm(dir); return a === b || a.startsWith(b + path.sep); };
/** 안에 새 폴더 만들기 → { path } */
export function makeDir(parentRaw, nameRaw) {
  const parent = path.resolve(String(parentRaw || ''));
  if (!parentRaw || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw error(404, '새 폴더를 만들 곳을 찾지 못했어요');
  const name = checkFolderName(nameRaw), target = path.join(parent, name);
  if (fs.existsSync(target)) throw error(409, `"${name}" 폴더가 이미 있어요`);
  fs.mkdirSync(target);
  return { path: target };
}
/**
 * 폴더 이름 바꾸기 → { path, from }. protect = 바꾸면 안 되는 폴더들(ODDIN·기본 작업 폴더·공유 기억 등 — 그 폴더나 그것을 품은 폴더 모두),
 * busy(p) = 진행 중인 작업이 그 안에서 돌고 있으면 true
 */
export function renameDir(raw, nameRaw, { protect = [], busy = () => false } = {}) {
  const from = path.resolve(String(raw || ''));
  if (!raw || !fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw error(404, '이름을 바꿀 폴더를 찾지 못했어요');
  if (path.dirname(from) === from) throw error(400, '드라이브 이름은 여기서 바꿀 수 없어요');
  // 시스템 폴더(그 안 전부)와 사용자 폴더 윗부분(C:\Users\이름\문서 처럼 두 단계까지)은 막는다
  const depth = (p) => norm(p).split(path.sep).filter(Boolean).length;
  const SYSTEM = process.platform === 'win32' ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'] : ['/bin', '/etc', '/usr', '/var'];
  const USERS = process.platform === 'win32' ? 'C:\\Users' : '/home';
  if (SYSTEM.some((d) => within(from, d)) || (within(from, USERS) && depth(from) <= depth(USERS) + 2)) throw error(403, '시스템 폴더나 사용자 기본 폴더(문서·바탕화면 등)는 이름을 바꿀 수 없어요');
  const hit = protect.filter(Boolean).find((p) => within(p, from));
  if (hit) throw error(403, `ODDIN이 쓰는 폴더(${hit})가 들어 있어서 이름을 바꿀 수 없어요`);
  if (busy(from)) throw error(409, '이 폴더에서 진행 중인 작업이 끝난 뒤에 바꿀 수 있어요');
  const name = checkFolderName(nameRaw), to = path.join(path.dirname(from), name);
  if (norm(to) === norm(from) && to !== from) { fs.renameSync(from, to); return { path: to, from }; } // 대소문자만 바꿈
  if (norm(to) === norm(from)) return { path: from, from };
  if (fs.existsSync(to)) throw error(409, `"${name}" 폴더가 이미 있어요`);
  try { fs.renameSync(from, to); }
  catch (e) { throw error(e.code === 'EBUSY' || e.code === 'EPERM' ? 409 : 500, e.code === 'EBUSY' || e.code === 'EPERM' ? '다른 프로그램(탐색기·프리미어 등)이 이 폴더를 쓰고 있어서 바꾸지 못했어요. 닫고 다시 해 주세요' : `바꾸지 못했어요: ${e.message}`); }
  return { path: to, from };
}
