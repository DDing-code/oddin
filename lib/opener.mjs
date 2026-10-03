// 허브 PC에서 폴더·파일 열기 (탐색기). 원격 접속에서는 서버가 막는다.
//  - 폴더: 탐색기로 연다
//  - 파일: 이미지·영상·소리·문서·편집 프로젝트처럼 안전한 종류만 기본 프로그램으로 열고,
//          나머지(실행 파일·스크립트 등)는 탐색기에서 위치만 보여 준다 (실행하지 않음)
//  - 허브가 아는 폴더(세션 폴더·작업 공간·허브·공유 허브) 안의 경로만 연다
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const SAFE_OPEN_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac',
  '.pdf', '.txt', '.md', '.json', '.csv', '.srt', '.log', '.html', '.htm', '.xml', '.yaml', '.yml',
  '.psd', '.ai', '.prproj', '.aep', '.blend', '.ttf', '.otf', '.woff2',
]);

/** 화면에서 넘어온 경로 정리: file:///F:/..., /F:/..., F:/... → F:\... */
export function normalizeLocalPath(p) {
  let s = String(p || '').trim();
  if (!s || s.length > 1000) return null;
  s = s.replace(/^file:\/\/\/?/i, '');
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/^[/\\]+(?=[A-Za-z]:)/, '');
  if (!/^[A-Za-z]:[\\/]/.test(s)) return null;
  if (/[\0<>"|?*\r\n]/.test(s.slice(2))) return null; // 윈도우 경로에 올 수 없는 문자
  return path.resolve(s.replace(/\//g, '\\'));
}

const under = (p, root) => { const a = p.toLowerCase().replace(/[\\/]+$/, ''); const b = root.toLowerCase().replace(/[\\/]+$/, ''); return a === b || a.startsWith(b + '\\'); };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

export function isAllowed(target, roots) {
  const cands = [target, real(target)];
  const rs = roots.filter(Boolean).flatMap((r) => [path.resolve(r), real(path.resolve(r))]);
  return cands.some((c) => rs.some((r) => under(c, r)));
}

/**
 * 보고 속 상대 경로(server.mjs 등)의 실제 위치 찾기.
 * 화면은 작업 폴더 기준 경로(path)와 원래 글자(rel)·기준 폴더(base)를 함께 보낸다.
 * path 가 있으면 그대로, 없으면 기준 폴더 → 상위 폴더(3단계) → 허브가 아는 폴더 순으로 찾는다.
 * 못 찾으면 path 를 그대로 돌려줘서 openLocal 이 404 를 낸다. 범위 검사는 openLocal/isAllowed 가 한다.
 */
export function resolveRelative(body, roots = []) {
  const rel = typeof body?.rel === 'string' ? body.rel.trim().replace(/&amp;/g, '&').replace(/^\.[\\/]/, '').replace(/\//g, '\\') : '';
  const first = normalizeLocalPath(body?.path);
  if (!rel || (first && fs.existsSync(first))) return body?.path;
  const base = normalizeLocalPath(body.base || '') || '';
  const bases = [];
  for (let b = base, i = 0; b && i < 4; b = path.dirname(b), i++) { bases.push(b); if (path.dirname(b) === b) break; }
  for (const b of [...bases, ...roots]) {
    if (!b) continue;
    const cand = path.join(b, rel);
    if (fs.existsSync(cand)) return cand;
  }
  return body.path;
}

function launch(args, verbatim = false) {
  if (process.platform !== 'win32') throw Object.assign(new Error('폴더 열기는 Windows 허브에서만 됩니다'), { status: 501 });
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: verbatim });
  child.on('error', () => {});
  child.unref();
}

/**
 * @param {string} p   열 경로
 * @param {{mode?: 'auto'|'reveal', roots: string[]}} opts
 * @returns {{action:'folder'|'file'|'reveal', path:string}}
 */
export function openLocal(p, { mode = 'auto', roots = [] } = {}) {
  const target = normalizeLocalPath(p);
  if (!target) throw Object.assign(new Error('열 수 없는 경로 형식이에요'), { status: 400 });
  if (!fs.existsSync(target)) throw Object.assign(new Error(`없는 경로예요: ${target}`), { status: 404 });
  if (!isAllowed(target, roots)) throw Object.assign(new Error('허브 세션 폴더 밖의 경로는 열지 않아요'), { status: 403 });
  const st = fs.statSync(target);
  if (st.isDirectory()) { launch([target]); return { action: 'folder', path: target }; }
  if (mode !== 'reveal' && SAFE_OPEN_EXT.has(path.extname(target).toLowerCase())) { launch([target]); return { action: 'file', path: target }; }
  launch([`/select,"${target}"`], true); // 경로에는 " 가 들어갈 수 없다 (위에서 거름)
  return { action: 'reveal', path: target };
}
