// 메모리 블록·공유/이 PC만 관리 (2026-10-05 사용자 "메모리를 블록별로 정리하고 공유/로컬 메모리를 나누고 세션별로 실시간 연결/해제").
// - 블록: 전역 메모리 목록(MEMORY.md)의 "## 제목" 하나가 블록 하나. 새로 생긴 줄이 끝에 붙으면 '미분류' 블록에 들어간다.
//   프로젝트 메모리 폴더(projects/<폴더>)는 폴더 하나가 블록 하나('project:<폴더>').
// - 공유: ~/.ai-shared/memory (연결된 PC와 맞춤) / 이 PC만: ~/.ai-shared/memory-local (맞추지 않음). 같은 구조.
// - 읽기(세션별 연결·해제)는 공용 선택기(~/.ai-shared/sync/memory-context.cjs)의 blocks 옵션이 한다.
import fs from 'node:fs';
import path from 'node:path';

export const UNSORTED = '미분류';
export const BASIC = '기본';
export const ROOTS = { shared: 'memory', local: 'memory-local' };
const TITLES = { shared: '공용 메모리 (전역)', local: '이 PC만 쓰는 메모리 (전역)' };
const HEADS = {
  shared: ['# 공용 메모리 (전역)', '폴더: `~\\.ai-shared\\memory\\global\\` — Claude Code·Codex 공통, 연결된 PC와 함께 씀. 한 줄 = 메모리 파일 1개. `## 제목` 하나가 블록 하나(ODDIN 기억 관리에서 옮기기·연결/해제).'],
  local: ['# 이 PC만 쓰는 메모리 (전역)', '폴더: `~\\.ai-shared\\memory-local\\global\\` — 이 PC에서만 쓰고 다른 PC와 맞추지 않는다. 한 줄 = 메모리 파일 1개.'],
};
const error = (status, message) => Object.assign(new Error(message), { status });
const NAME_OK = (s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 40 && !/[\r\n#\[\]()]/.test(s);
const rootDir = (hubDir, root) => path.join(hubDir, ROOTS[root] || ROOTS.shared);
const globalIndex = (hubDir, root) => path.join(rootDir(hubDir, root), 'global', 'MEMORY.md');

/* ---------- 목록 파일 다루기 ---------- */
export function parseIndex(text) {
  const head = [], blocks = []; let cur = null;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (h) { cur = { name: h[1], lines: [] }; blocks.push(cur); continue; }
    (cur ? cur.lines : head).push(line);
  }
  return { head, blocks };
}
const trimBlank = (lines) => { const a = [...lines]; while (a.length && !a[0].trim()) a.shift(); while (a.length && !a.at(-1).trim()) a.pop(); return a; };
export function renderIndex({ head, blocks }) {
  const out = [...trimBlank(head)];
  for (const b of blocks) out.push('', `## ${b.name}`, ...trimBlank(b.lines));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
const entryOf = (line) => { const m = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)\s*(?:—|-)?\s*(.*)$/); return m ? { title: m[1], href: m[2], desc: m[3] } : null; };
function readIndex(file, root) {
  let text = null; try { text = fs.readFileSync(file, 'utf8'); } catch {}
  return text === null ? { head: [...HEADS[root], ''], blocks: [] } : parseIndex(text);
}
function writeIndex(file, parsed) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, renderIndex(parsed)); }
function blockFor(parsed, name, create = true) {
  let b = parsed.blocks.find((x) => x.name === name);
  if (!b && create) {
    b = { name, lines: [] };
    const at = parsed.blocks.findIndex((x) => x.name === UNSORTED); // 새 블록은 미분류 앞에
    if (at >= 0 && name !== UNSORTED) parsed.blocks.splice(at, 0, b); else parsed.blocks.push(b);
  }
  return b;
}
function takeEntry(parsed, href) {
  for (const where of [{ lines: parsed.head, block: BASIC }, ...parsed.blocks.map((b) => ({ lines: b.lines, block: b.name }))]) {
    const at = where.lines.findIndex((l) => entryOf(l)?.href === href);
    if (at >= 0) return { line: where.lines.splice(at, 1)[0], block: where.block };
  }
  return null;
}
function putEntry(parsed, line, block) {
  if (block === BASIC && !parsed.blocks.some((b) => b.name === BASIC)) { // 제목 없는 '기본' 줄은 머리말 끝에
    const lastItem = parsed.head.map((l, i) => (entryOf(l) ? i : -1)).filter((i) => i >= 0).at(-1);
    parsed.head.splice(lastItem >= 0 ? lastItem + 1 : parsed.head.length, 0, line); return;
  }
  const b = blockFor(parsed, block);
  const lastItem = b.lines.map((l, i) => (entryOf(l) ? i : -1)).filter((i) => i >= 0).at(-1);
  b.lines.splice(lastItem >= 0 ? lastItem + 1 : b.lines.length, 0, line);
}

/* ---------- 프론트매터 ---------- */
function frontmatter(text) {
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  return Object.fromEntries([...fm.matchAll(/^\s*(name|description|type):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()]));
}
function memoryInfo(file) {
  let text = ''; let st = null;
  try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch { return null; }
  const fm = frontmatter(text);
  return { name: fm.name || path.basename(file, '.md'), description: fm.description || '', type: fm.type || '', mtime: st.mtime.toISOString(), size: st.size };
}
const mdFiles = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md'); } catch { return []; } };

/** 프로젝트 폴더 → 보기 좋은 이름 (프로젝트 대응표·별칭의 작업 경로 끝 이름) */
function projectLabels(hubDir) {
  const out = {};
  // workspace·site 처럼 흔한 끝 이름은 상위 폴더까지 (ai-hub\workspace)
  const label = (p) => { const b = path.win32.basename(p); return /^(workspace|site|src|app|kb|docs|work)$/i.test(b) ? `${path.win32.basename(path.win32.dirname(p))}\\${b}` : b; };
  try {
    for (const line of fs.readFileSync(path.join(hubDir, 'memory', 'projects', 'INDEX.md'), 'utf8').split(/\r?\n/)) {
      const c = line.split('|').map((s) => s.trim());
      if (c.length >= 4 && /^[A-Za-z]:/.test(c[1]) && c[2]) out[c[2]] ||= label(c[1]);
    }
  } catch {}
  try { for (const [p, folder] of Object.entries(JSON.parse(fs.readFileSync(path.join(hubDir, 'sync', 'config.json'), 'utf8')).memoryAliases || {})) out[folder] ||= label(p); } catch {}
  return out;
}

/** 블록 목록: 전역 블록(공유·이 PC만 함께)과 비어 있지 않은 프로젝트 블록 */
export function listMemory(hubDir) {
  const blocks = new Map(), order = [];
  const block = (id, extra) => { if (!blocks.has(id)) { blocks.set(id, { id, name: id, kind: 'global', memories: [], ...extra }); order.push(id); } return blocks.get(id); };
  for (const root of ['shared', 'local']) {
    const dir = path.join(rootDir(hubDir, root), 'global'), parsed = readIndex(path.join(dir, 'MEMORY.md'), root), seen = new Set();
    const add = (line, name) => {
      const e = entryOf(line); if (!e || e.href.includes('/') || e.href.includes('\\')) return;
      const info = memoryInfo(path.join(dir, e.href)); if (!info) return;
      seen.add(e.href);
      block(name).memories.push({ root, rel: `global/${e.href}`, title: e.title, ...info, description: e.desc || info.description });
    };
    for (const l of parsed.head) add(l, BASIC);
    for (const b of parsed.blocks) { block(b.name); for (const l of b.lines) add(l, b.name); }
    for (const n of mdFiles(dir)) if (!seen.has(n)) { const info = memoryInfo(path.join(dir, n)); if (info) block(UNSORTED).memories.push({ root, rel: `global/${n}`, title: info.name, ...info }); }
  }
  // 빈 '기본'은 빼고, 미분류는 끝으로
  const globals = order.filter((id) => !(id === BASIC && !blocks.get(id).memories.length)).sort((a, b) => (a === UNSORTED) - (b === UNSORTED));
  const labels = projectLabels(hubDir), projects = [];
  for (const root of ['shared', 'local']) {
    let names = []; try { names = fs.readdirSync(path.join(rootDir(hubDir, root), 'projects')); } catch {}
    for (const slug of names) {
      const dir = path.join(rootDir(hubDir, root), 'projects', slug), files = mdFiles(dir);
      if (!files.length) continue;
      const id = `project:${slug}`;
      if (!blocks.has(id)) { blocks.set(id, { id, name: labels[slug] || slug, kind: 'project', slug, memories: [] }); projects.push(id); }
      for (const n of files) { const info = memoryInfo(path.join(dir, n)); if (info) blocks.get(id).memories.push({ root, rel: `projects/${slug}/${n}`, title: info.name, ...info }); }
    }
  }
  projects.sort((a, b) => blocks.get(b).memories.length - blocks.get(a).memories.length);
  const view = (id) => { const b = blocks.get(id); return { ...b, shared: b.memories.filter((m) => m.root === 'shared').length, local: b.memories.filter((m) => m.root === 'local').length }; };
  return { blocks: [...globals, ...projects].map(view), roots: { shared: rootDir(hubDir, 'shared'), local: rootDir(hubDir, 'local') } };
}

const safeRel = (rel) => {
  const r = String(rel || '').replace(/\\/g, '/');
  if (!/^(global\/[^/]+\.md|projects\/[A-Za-z0-9_.-]+\/[^/]+\.md)$/.test(r) || r.split('/').some((s) => s === '..' || s === '.') || /MEMORY\.md$/.test(r)) throw error(400, '메모리 경로가 아니에요');
  return r;
};

/** 메모리 옮기기: 블록 바꾸기(전역만)·공유↔이 PC만 바꾸기 */
export function moveMemory(hubDir, { root = 'shared', rel, block, toRoot }) {
  rel = safeRel(rel);
  if (!ROOTS[root] || (toRoot && !ROOTS[toRoot])) throw error(400, '공유 또는 이 PC만 중 하나여야 해요');
  toRoot = toRoot || root;
  const src = path.join(rootDir(hubDir, root), ...rel.split('/')), dst = path.join(rootDir(hubDir, toRoot), ...rel.split('/'));
  if (!fs.existsSync(src)) throw error(404, '메모리를 찾지 못했어요');
  const global = rel.startsWith('global/'), file = path.basename(rel);
  if (!global && block && block !== `project:${rel.split('/')[1]}`) throw error(400, '프로젝트 메모리는 블록을 옮길 수 없어요(공유/이 PC만만 바꿀 수 있어요)');
  if (block && global && (!NAME_OK(block) || block.startsWith('project:'))) throw error(400, '블록 이름이 올바르지 않아요');
  if (toRoot !== root && fs.existsSync(dst)) throw error(409, `${toRoot === 'local' ? '이 PC만' : '공유'} 쪽에 같은 이름의 메모리가 이미 있어요`);
  const srcIdx = path.join(path.dirname(src), 'MEMORY.md'), dstIdx = path.join(path.dirname(dst), 'MEMORY.md');
  const sp = global ? readIndex(srcIdx, root) : null;
  const taken = global ? takeEntry(sp, file) : null;
  const info = memoryInfo(src);
  const line = taken?.line || `- [${info?.name || file}](${file}) — ${info?.description || ''}`;
  const target = global ? (block || taken?.block || UNSORTED) : null;
  if (toRoot !== root) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst); }
  if (global) {
    if (toRoot === root) { putEntry(sp, line, target); writeIndex(srcIdx, sp); }
    else {
      if (taken) writeIndex(srcIdx, sp);
      const dp = readIndex(dstIdx, toRoot); putEntry(dp, line, target); writeIndex(dstIdx, dp);
    }
  } else if (toRoot !== root) { // 프로젝트 목록 줄도 따라 옮긴다
    const strip = (idx) => { try { const t = fs.readFileSync(idx, 'utf8'); const lines = t.split(/\r?\n/); const at = lines.findIndex((l) => entryOf(l)?.href === file); if (at < 0) return null; const [l] = lines.splice(at, 1); fs.writeFileSync(idx, lines.join('\n')); return l; } catch { return null; } };
    const l = strip(srcIdx) || line;
    let t = ''; try { t = fs.readFileSync(dstIdx, 'utf8'); } catch { t = `# ${toRoot === 'local' ? '이 PC만 쓰는 ' : ''}프로젝트 메모리 (${rel.split('/')[1]})\n`; }
    fs.mkdirSync(path.dirname(dstIdx), { recursive: true }); fs.writeFileSync(dstIdx, `${t.replace(/\s*$/, '')}\n${l}\n`);
  }
  return { root: toRoot, rel, block: global ? target : `project:${rel.split('/')[1]}` };
}

export function createBlock(hubDir, { name, root = 'shared' }) {
  if (!NAME_OK(name) || name.trim().startsWith('project:')) throw error(400, '블록 이름은 1~40자, #·[]·() 없이 써 주세요');
  const n = name.trim(), file = globalIndex(hubDir, root), parsed = readIndex(file, root);
  if (parsed.blocks.some((b) => b.name === n)) throw error(409, '같은 이름의 블록이 이미 있어요');
  blockFor(parsed, n); writeIndex(file, parsed); return { name: n };
}
export function renameBlock(hubDir, { from, to }) {
  if (!NAME_OK(to) || to.trim().startsWith('project:')) throw error(400, '블록 이름은 1~40자, #·[]·() 없이 써 주세요');
  if (from === UNSORTED) throw error(400, '미분류 블록은 이름을 바꿀 수 없어요');
  let changed = 0;
  for (const root of ['shared', 'local']) {
    const file = globalIndex(hubDir, root); if (!fs.existsSync(file)) continue;
    const parsed = readIndex(file, root);
    if (parsed.blocks.some((b) => b.name === to.trim())) throw error(409, '같은 이름의 블록이 이미 있어요');
    for (const b of parsed.blocks) if (b.name === from) { b.name = to.trim(); changed++; }
    writeIndex(file, parsed);
  }
  if (!changed) throw error(404, '블록을 찾지 못했어요');
  return { from, to: to.trim() };
}
export function deleteBlock(hubDir, { name }) {
  const list = listMemory(hubDir).blocks.find((b) => b.id === name);
  if (list?.memories.length) throw error(409, '메모리가 남아 있는 블록은 지울 수 없어요. 먼저 다른 블록으로 옮겨 주세요');
  for (const root of ['shared', 'local']) {
    const file = globalIndex(hubDir, root); if (!fs.existsSync(file)) continue;
    const parsed = readIndex(file, root);
    const b = parsed.blocks.find((x) => x.name === name);
    if (b) { parsed.head.push(...b.lines.filter((l) => l.trim() && !entryOf(l))); parsed.blocks = parsed.blocks.filter((x) => x !== b); writeIndex(file, parsed); }
  }
  return { ok: true };
}
/** 블록 통째로 공유 ↔ 이 PC만 */
export function setBlockRoot(hubDir, { id, root }) {
  if (!ROOTS[root]) throw error(400, '공유 또는 이 PC만 중 하나여야 해요');
  const b = listMemory(hubDir).blocks.find((x) => x.id === id);
  if (!b) throw error(404, '블록을 찾지 못했어요');
  const moved = [];
  for (const m of b.memories) if (m.root !== root) { moveMemory(hubDir, { root: m.root, rel: m.rel, toRoot: root, block: b.kind === 'global' ? b.id : undefined }); moved.push(m.rel); }
  if (b.kind === 'global' && root === 'local' && !b.memories.length) createBlock(hubDir, { name: b.id, root: 'local' });
  return { id, root, moved: moved.length };
}

/** 메모리 한 개 본문 (기억 관리 화면에서 보기) */
export function readBlockMemory(hubDir, { root = 'shared', rel }) {
  rel = safeRel(rel);
  if (!ROOTS[root]) throw error(400, '공유 또는 이 PC만 중 하나여야 해요');
  const file = path.join(rootDir(hubDir, root), ...rel.split('/'));
  try { return { root, rel, file, text: fs.readFileSync(file, 'utf8'), ...memoryInfo(file) }; }
  catch { throw error(404, '메모리를 찾지 못했어요'); }
}

/** 정리 담당이 새 메모리를 블록에 넣을 때: 목록 줄을 그 블록 끝에 (없으면 블록을 만든다) */
export function placeIndexLine(indexFile, line, block, root = 'shared') {
  const parsed = readIndex(indexFile, root);
  const href = entryOf(line)?.href;
  if (href) takeEntry(parsed, href);
  putEntry(parsed, line, block && NAME_OK(block) ? block.trim() : UNSORTED);
  writeIndex(indexFile, parsed);
}
export const blockNames = (hubDir) => listMemory(hubDir).blocks.filter((b) => b.kind === 'global').map((b) => b.id);
