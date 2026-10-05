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
