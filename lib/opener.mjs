// 허브 PC에서 폴더·파일 열기 (탐색기). 원격 접속에서는 서버가 막는다.
//  - 폴더: 탐색기로 연다
//  - 파일: 이미지·영상·소리·문서·편집 프로젝트처럼 안전한 종류만 기본 프로그램으로 열고,
//          나머지(실행 파일·스크립트 등)는 탐색기에서 위치만 보여 준다 (실행하지 않음)
//  - 허브가 아는 폴더(세션 폴더·작업 공간·허브·공유 허브) 안의 경로만 연다
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './util.mjs';

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
  // 드라이브 글자 뒤의 ':'(파일 뒤 숨은 자료 줄기 a.txt::$DATA), 끝의 점·공백, 장치 이름(nul·con …)은 같은 파일의 다른 이름이거나 파일이 아니다
  if (s.slice(2).includes(':') || /[. ]$/.test(s) || s.split(/[\\/]/).some((part) => DEVICE_RE.test(part))) return null;
  return path.resolve(s.replace(/\//g, '\\'));
}
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

const under = (p, root) => { const a = p.toLowerCase().replace(/[\\/]+$/, ''); const b = root.toLowerCase().replace(/[\\/]+$/, ''); return a === b || a.startsWith(b + '\\'); };
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

/**
 * 허브가 내주지 않는 곳: 허브 자료 폴더(화면 쿠키·허브 서명을 만드는 비밀, 푸시 키, 원격 설정, 브라우저 프로필의 로그인)와 .env.
 * 허브 폴더가 열기 범위에 들어 있어서(허브를 고치는 작업 폴더) 예전에는 이 파일들도 읽기·내려받기가 됐다 — 원격으로 들어온 계정이
 * 비밀을 받아 가면 터미널까지 열 수 있었다(2026-10-12 점검). 첨부(data/uploads)는 /uploads/ 경로로 따로 내준다.
 */
const inData = (target) => under(real(target), real(DATA_DIR)) || under(target, DATA_DIR);
export function isPrivate(target) { return /^\.env(\..+)?$/i.test(path.basename(target)) || inData(target); }
/** 열기 범위 안인가. 정션·심볼릭 링크는 실제 위치로 본다 — 범위 안에 놓인 링크가 범위 밖을 가리키면 밖이다. 허브 자료 폴더는 늘 밖 */
export function isAllowed(target, roots) {
  if (inData(target)) return false;
  const t = real(target);
  const rs = roots.filter(Boolean).flatMap((r) => [path.resolve(r), real(path.resolve(r))]);
  return rs.some((r) => under(t, r));
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
  // 보고에 하위 폴더 없이 이름만 적은 경우(스토리보드.md → 완성본\bull-potion\스토리보드.md): 작업 폴더 아래에서 찾는다
  if (base && /\.[A-Za-z0-9]{1,8}$/.test(rel)) { const hit = findBelow(base, rel); if (hit) return hit; }
  return body.path;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', '__pycache__', '.venv', 'venv']);
/**
 * dir 아래에서 끝이 rel 과 같은 파일을 찾는다(대소문자 무시). 여러 개면 가장 최근에 고친 것(보고가 가리킨 결과물일 가능성이 큼).
 * 숨김·node_modules 등은 건너뛰고, 깊이 6·폴더 4000개·1.5초까지만 본다(넓은 폴더에서 느려지지 않게).
 */
export function findBelow(dir, rel, { maxDepth = 6, maxDirs = 4000, timeMs = 1500 } = {}) {
  const want = '\\' + String(rel).replace(/\//g, '\\').replace(/^[\\]+/, '').toLowerCase();
  const until = Date.now() + timeMs, hits = [];
  let queue = [dir], seen = 0;
  for (let depth = 0; depth <= maxDepth && queue.length && hits.length < 20; depth++) {
    const next = [];
    for (const d of queue) {
      if (++seen > maxDirs || Date.now() > until) { queue = []; break; }
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isFile() && full.toLowerCase().endsWith(want)) hits.push(full);
        else if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) next.push(full);
      }
    }
    if (queue.length) queue = next;
  }
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return hits.sort((a, b) => mtime(b) - mtime(a))[0] || null;
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
  if (!isAllowed(target, roots)) throw Object.assign(new Error('허브가 아는 폴더 밖이에요 · 입력창 아래 권한 메뉴에서 "모든 폴더"를 켜면 열 수 있어요'), { status: 403 });
  const st = fs.statSync(target);
  if (st.isDirectory()) { launch([target]); return { action: 'folder', path: target }; }
  if (mode !== 'reveal' && SAFE_OPEN_EXT.has(path.extname(target).toLowerCase())) { launch([target]); return { action: 'file', path: target }; }
  launch([`/select,"${target}"`], true); // 경로에는 " 가 들어갈 수 없다 (위에서 거름)
  return { action: 'reveal', path: target };
}
