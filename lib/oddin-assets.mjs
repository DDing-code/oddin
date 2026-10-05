// ODDIN 자산 (2026-10-05 사용자 "폴더를 구분할 필요 없이 두 기억을 합치는 느낌으로, 공유를 허용한 세션은 정제해서 오딘 폴더 안에 자동으로 메모리와 자산이 들어가는 거야").
// - 공유를 허용한 세션(기억 탭 "새 기억 저장: 공유")의 요청이 끝나면 기억 정리 담당이 다시 쓸 결과물을 고르고,
//   허브가 드라이브 ODDIN/자산/<분류>/<이름> 으로 복사한다. PC 구분 없이 한곳에 합친다.
// - 목록: ODDIN/자산/목록.md(전체, 사람이 봄)와 공유 기억 global/reference-oddin-assets.md(최근 것, AI가 봄 — 두 PC가 같은 기억으로 받음).
// - 안전: 정리 담당이 지어낸 경로가 아니라 이번 요청의 결과·보고에 실제로 나온 경로만, 비밀 파일·시스템 폴더·허브 내부는 빼고, 크기 한도 안에서.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { placeIndexLine } from './memory-blocks.mjs';

const fsp = fs.promises;
export const CATALOG = '목록.md';
export const MEMORY_NAME = 'reference-oddin-assets';
const MEMORY_BLOCK = 'ODDIN·공유 기억';
const MAX_FILE = 500 * 1024 * 1024, MAX_FILES = 3000, MAX_BYTES = 1024 * 1024 * 1024, MAX_ITEMS = 6, RECENT = 40;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.next', '.nuxt', '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'coverage', '.turbo']);
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|pfx|p12|kdbx)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const BLOCKED = [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i, /^[a-z]:\\programdata(\\|$)/i, /\\appdata\\(roaming|local(?!\\temp))(\\|$)/i];
const error = (status, message) => Object.assign(new Error(message), { status });
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** 파일·폴더 이름으로 쓸 수 있게: 경로 문자 빼고 60자 */
export const cleanName = (s, max = 60) => oneLine(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, max) || '자산';
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p, dir) => { const a = path.resolve(p).toLowerCase(), b = path.resolve(dir).toLowerCase(); return a === b || a.startsWith(b + path.sep); };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
async function fileSha(file) { try { return sha(await fsp.readFile(file)); } catch { return null; } }

/** 폴더 훑기(복사할 파일 목록): 뺄 폴더·비밀 파일 빼고, 한도를 넘으면 오류 */
async function walk(root) {
  const files = []; let bytes = 0;
  const go = async (dir, rel) => {
    let es; try { es = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await go(full, r); continue; }
      if (!e.isFile() || SECRET_FILE.test(e.name) || /^(desktop\.ini|Thumbs\.db|\.DS_Store)$/i.test(e.name)) continue;
      const st = await fsp.stat(full);
      if (st.size > MAX_FILE) throw error(413, `${r}: 파일이 너무 커요(500MB 넘음)`);
      files.push({ rel: r, full, size: st.size, mtime: st.mtimeMs }); bytes += st.size;
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw error(413, '폴더가 너무 커요(3,000개·1GB 넘음)');
    }
  };
  await go(root, '');
  return files;
}

/**
 * 정리 담당이 고른 자산 하나 검사. mentioned = 이번 요청의 결과·보고 글(경로가 실제로 나와야 함)
 * 돌려주는 값: { ok, src, isDir, name, category, description } 또는 { ok:false, why }
 */
export function checkAsset(raw, { mentioned = '', hub, hubDir = null, homeDir = os.homedir() }) {
  const rawPath = oneLine(raw?.path).replace(/^["'`<]+|["'`>]+$/g, '');
  const out = { ok: false, name: cleanName(raw?.name || path.basename(rawPath || '자산')), category: cleanName(raw?.category || '기타', 30), description: oneLine(raw?.description).slice(0, 200), path: rawPath };
  if (!rawPath || !path.isAbsolute(rawPath)) return { ...out, why: '절대 경로가 아니에요' };
  const src = path.resolve(rawPath);
  if (!norm(mentioned).includes(norm(src))) return { ...out, why: '이번 요청의 결과·보고에 나온 경로가 아니에요' };
  if (path.parse(src).root.toLowerCase() === (src + (src.endsWith(path.sep) ? '' : path.sep)).toLowerCase() || src.toLowerCase() === path.resolve(homeDir).toLowerCase()) return { ...out, why: '드라이브 전체나 사용자 폴더 전체는 올리지 않아요' };
  if (BLOCKED.some((re) => re.test(src))) return { ...out, why: '시스템 폴더예요' };
  if (hubDir && inside(src, hubDir)) return { ...out, why: '공유 기억 폴더 안이에요(이미 함께 씀)' };
  if (SECRET_FILE.test(src)) return { ...out, why: '비밀 정보가 들어 있을 수 있는 파일이에요' };
  let st; try { st = fs.statSync(src); } catch { return { ...out, why: '그 파일·폴더가 없어요' }; }
  if (hub && inside(src, hub.root) && !inside(src, hub.assets)) return { ...out, why: 'ODDIN 기억 폴더 안이에요' };
  if (!out.description) return { ...out, why: '설명이 비어 있어요' };
  return { ...out, ok: true, src, isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size };
}

/* ---------------- 목록 ---------------- */
const LINE_RE = /^- \[(.+?)\]\(<?(.+?)>?\) — (.*)$/;
export function readCatalog(assetsDir) {
  let text = ''; try { text = fs.readFileSync(path.join(assetsDir, CATALOG), 'utf8'); } catch {}
  const items = [];
  for (const l of text.split(/\r?\n/)) { const m = l.match(LINE_RE); if (m) items.push({ name: m[1], rel: m[2], rest: m[3] }); }
  return items;
}
export function writeCatalog(assetsDir, items) {
  const groups = new Map();
  for (const it of items) { const cat = it.rel.split('/')[0] || '기타'; if (!groups.has(cat)) groups.set(cat, []); groups.get(cat).push(it); }
  const cats = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const body = cats.map((c) => `## ${c}\n${groups.get(c).map((it) => `- [${it.name}](<${it.rel}>) — ${it.rest}`).join('\n')}`).join('\n\n');
  const text = `# ODDIN 자산 목록\n\nODDIN이 공유를 허용한 세션의 결과물을 정리해 자동으로 채우는 목록입니다. 경로는 이 자산 폴더 기준입니다. 같은 이름으로 다시 올리면 새 판으로 바뀌고, 이전 판은 구글 드라이브 버전 기록에 남습니다.\n\n${body}\n`;
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, CATALOG), text);
}
/** 목록 줄 넣기·바꾸기(같은 경로면 바꿈) / 빼기 */
export function upsertCatalog(assetsDir, entry) {
  const items = readCatalog(assetsDir).filter((x) => x.rel !== entry.rel);
  items.unshift(entry);
  writeCatalog(assetsDir, items);
}
export function removeCatalog(assetsDir, rel) { writeCatalog(assetsDir, readCatalog(assetsDir).filter((x) => x.rel !== rel)); }

/** 공유 기억의 자산 목록 메모리(AI가 봄)를 목록.md 에서 다시 만든다 */
export function writeAssetMemory(hubDir, assetsDir) {
  const items = readCatalog(assetsDir);
  const dir = path.join(hubDir, 'memory', 'global'), file = path.join(dir, `${MEMORY_NAME}.md`);
  const lines = items.slice(0, RECENT).map((it) => `- ${it.rel} — ${it.name}: ${it.rest}`);
  const text = `---\nname: ${MEMORY_NAME}\ndescription: 두 PC가 함께 쓰는 드라이브 ODDIN 자산(다시 쓸 결과물·공유 폴더) 목록 — ODDIN이 자동으로 고침, 최근 ${Math.min(items.length, RECENT)}개\nmetadata:\n  type: reference\n---\n\nODDIN이 공유를 허용한 세션의 결과물을 정리해 드라이브 ODDIN 폴더의 \`자산/\`에 넣고 이 목록을 자동으로 고친다. 직접 고치지 않는다. 경로는 \`ODDIN/자산/\` 기준이고, PC별 ODDIN 위치는 [[reference-oddin-drive]]에 있다. 전체 목록은 \`ODDIN/자산/${CATALOG}\`.\n\n${lines.join('\n') || '- (아직 없음)'}\n${items.length > RECENT ? `\n그 밖에 ${items.length - RECENT}개는 목록.md 에 있다.\n` : ''}`;
  let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur === text) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  try { placeIndexLine(path.join(dir, 'MEMORY.md'), `- [ODDIN 자산 목록(자동)](${MEMORY_NAME}.md) — 드라이브 ODDIN/자산 의 다시 쓸 결과물·공유 폴더, 최근 ${Math.min(items.length, RECENT)}개 (ODDIN이 고침)`, MEMORY_BLOCK, 'shared'); } catch {}
  return true;
}

/* ---------------- 올리기 · 되돌리기 ---------------- */
/** 파일·폴더를 자산/<분류>/<이름> 으로 복사(폴더는 원본과 같게). 돌려주는 값: { rel, dest, created, changed, files } */
export async function copyAsset(item, assetsDir) {
  const catDir = path.join(assetsDir, item.category);
  const ext = item.isDir ? '' : path.extname(item.src);
  const base = item.name.toLowerCase().endsWith(ext.toLowerCase()) ? item.name.slice(0, item.name.length - ext.length) || item.name : item.name;
  const dest = path.join(catDir, item.isDir ? base : `${base}${ext}`);
  const rel = `${item.category}/${path.basename(dest)}`;
  const created = !fs.existsSync(dest);
  if (!item.isDir) {
    if (item.size > MAX_FILE) throw error(413, '파일이 너무 커요(500MB 넘음)');
    if (!created && (await fsp.stat(dest)).size === item.size && await fileSha(dest) === await fileSha(item.src)) return { rel, dest, created: false, changed: false, files: 1 };
    await fsp.mkdir(catDir, { recursive: true });
    await fsp.copyFile(item.src, dest);
    return { rel, dest, created, changed: true, files: 1 };
  }
  const src = await walk(item.src);
  const have = new Map(fs.existsSync(dest) ? (await walk(dest)).map((f) => [f.rel, f]) : []);
  let changed = 0;
  for (const f of src) {
    const to = path.join(dest, ...f.rel.split('/')), h = have.get(f.rel);
    have.delete(f.rel);
    if (h && h.size === f.size && await fileSha(to) === await fileSha(f.full)) continue;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(f.full, to); changed++;
  }
  for (const [rel] of have) { await fsp.rm(path.join(dest, ...rel.split('/')), { force: true }); changed++; }
  return { rel, dest, created, changed: changed > 0, files: src.length };
}

/**
 * 기억 정리 결과의 자산을 ODDIN 에 올린다. 돌려주는 값: [{ name, category, rel?, status: 'saved'|'same'|'skipped', why?, created? }]
 * source = { machine, at, request } (목록에 붙는 출처)
 */
export async function saveAssets({ hub, hubDir, items = [], mentioned = '', source = {} }) {
  const results = [];
  if (!hub) return results;
  for (const raw of items.slice(0, MAX_ITEMS)) {
    const c = checkAsset(raw, { mentioned, hub, hubDir });
    const r = { name: c.name, category: c.category, description: c.description, path: c.path, status: 'skipped' };
    results.push(r);
    if (!c.ok) { r.why = c.why; continue; }
    try {
      // 이미 ODDIN 자산 폴더 안에 있는 결과물은 복사하지 않고 목록에만
      const done = inside(c.src, hub.assets) ? { rel: path.relative(hub.assets, c.src).split(path.sep).join('/'), dest: c.src, created: false, changed: true } : await copyAsset(c, hub.assets);
      const date = String(source.at || new Date().toISOString()).slice(0, 10);
      const rest = `${c.description} (${[source.machine, date].filter(Boolean).join(' · ')}${source.request ? ` · 요청: ${oneLine(source.request).slice(0, 60)}` : ''})`;
      upsertCatalog(hub.assets, { name: c.name, rel: done.rel, rest });
      Object.assign(r, { status: done.changed ? 'saved' : 'same', rel: done.rel, created: done.created, dest: done.dest });
    } catch (e) { r.why = e.message; }
  }
  if (results.some((r) => r.rel) && hubDir) { try { writeAssetMemory(hubDir, hub.assets); } catch {} }
  return results;
}

/** 되돌리기: 이 요청이 새로 만든 자산만 지우고 목록에서 뺀다(원래 있던 자산을 고친 것은 드라이브 버전 기록으로) */
export function undoAssets({ hub, hubDir, results = [] }) {
  const out = [];
  if (!hub) return out;
  for (const r of results) {
    if (r.status !== 'saved' || !r.created || !r.dest || !inside(r.dest, hub.assets)) continue;
    try { fs.rmSync(r.dest, { recursive: true, force: true }); removeCatalog(hub.assets, r.rel); out.push({ rel: r.rel, status: 'removed' }); }
    catch (e) { out.push({ rel: r.rel, status: 'failed', why: e.message }); }
  }
  if (out.length && hubDir) { try { writeAssetMemory(hubDir, hub.assets); } catch {} }
  return out;
}
