// 알려진 프로젝트 폴더와 작업 폴더 검사
// - knownProjects: 공유 메모리 대응표·별칭·세션 폴더 (폴더 고르기 화면과 플래너의 작업 폴더 후보)
// - validWorkdir: 플래너가 고른 작업 폴더를 그대로 믿지 않는다(있는 폴더·드라이브 루트·시스템 폴더 아님)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readText, readJson, ROOT } from './util.mjs';

export function knownProjects(config, sessions = []) {
  const index = readText(path.join(config.hubDir, 'memory', 'projects', 'INDEX.md'), '') || '';
  const out = [];
  for (const line of index.split(/\r?\n/)) {
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length >= 4 && /^[A-Za-z]:[\\/]/.test(cells[1])) out.push({ path: path.resolve(cells[1]), slug: cells[2], memories: Number(cells[3]) || 0 });
  }
  const sync = readJson(path.join(config.hubDir, 'sync', 'config.json'), {});
  for (const [p, slug] of Object.entries(sync.memoryAliases || {})) out.push({ path: path.resolve(p), slug, memories: 0 });
  for (const p of sync.extraPaths || []) out.push({ path: path.resolve(p), slug: null, memories: 0 });
  for (const s of sessions) out.push({ path: s.cwd, slug: null, memories: 0 });
  for (const s of sessions) if (s.workdir) out.push({ path: s.workdir, slug: null, memories: 0 });
  const fixed = [{ path: path.resolve(config.defaultCwd), label: '허브 작업 공간 (기본)' }, { path: ROOT, label: 'ODDIN 자체 (허브 코드)' }];
  // 드라이브 작업 폴더(lib/drive-folders.mjs): 두 PC가 함께 쓰는 구글 드라이브 폴더는 이름을 붙여 위로
  const driveNames = new Map();
  for (const f of readJson(path.join(config.hubDir, 'sync', 'drive-folders.json'), {}).folders || []) for (const p of Object.values(f.paths || {})) driveNames.set(path.resolve(p).toLowerCase(), f.name);
  const drives = [...driveNames.keys()].map((k) => ({ path: out.find((x) => x.path.toLowerCase() === k)?.path || k, slug: null, memories: 0 }));
  const seen = new Set(), res = [], home = os.homedir().toLowerCase();
  for (const p of [...fixed, ...drives, ...out.sort((a, b) => b.memories - a.memories)]) {
    const k = p.path.toLowerCase();
    if (seen.has(k) || k === home) continue;
    seen.add(k);
    if (fs.existsSync(p.path)) res.push({ memories: 0, ...p, ...(driveNames.has(k) ? { label: `드라이브 · ${driveNames.get(k)}`, drive: true } : {}) });
  }
  return res;
}

const BLOCKED = [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i, /^[a-z]:\\programdata(\\|$)/i, /\\appdata\\(roaming|local(?!\\temp))(\\|$)/i];

/** 플래너가 고른 작업 폴더 검사. 괜찮으면 정규화한 절대 경로, 아니면 { error } */
export function validWorkdir(p, config) {
  const raw = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return { error: '비어 있음' };
  if (!path.isAbsolute(raw)) return { error: '절대 경로가 아님' };
  const dir = path.resolve(raw);
  if (path.parse(dir).root.toLowerCase() === (dir + (dir.endsWith(path.sep) ? '' : path.sep)).toLowerCase()) return { error: '드라이브 루트' };
  if (dir.toLowerCase() === os.homedir().toLowerCase()) return { error: '사용자 홈 폴더 전체' };
  if (BLOCKED.some((re) => re.test(dir))) return { error: '시스템 폴더' };
  for (const d of [config.hubDir, path.join(ROOT, 'data'), path.join(ROOT, 'runs')].filter(Boolean)) {
    const rel = path.relative(path.resolve(d), dir);
    if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { error: '허브 내부 기록 폴더' };
  }
  try { if (!fs.statSync(dir).isDirectory()) return { error: '폴더가 아님' }; } catch { return { error: '없는 폴더' }; }
  return { dir };
}
