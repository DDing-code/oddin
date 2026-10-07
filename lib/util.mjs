import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.HUB_DATA_DIR ? path.resolve(process.env.HUB_DATA_DIR) : path.join(ROOT, 'data');
export const RUNS_DIR = process.env.HUB_RUNS_DIR ? path.resolve(process.env.HUB_RUNS_DIR) : path.join(ROOT, 'runs');

export const nowIso = () => new Date().toISOString();
export const shortId = (n = 6) => crypto.randomBytes(n).toString('base64url').slice(0, n);
export const jobId = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${shortId(4)}`;
};

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw Object.assign(new Error(`저장 자료를 읽지 못해 원본을 보존합니다: ${file} (${e.message})`), { code: 'STATE_READ_FAILED', cause: e });
  }
}
export function readText(file, fallback = null) {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return fallback; }
}
export function writeJsonAtomic(file, data, { repair = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 마지막 정상본은 분당 한 번 보관. 손상된 원본은 자동 저장으로 덮지 않는다.
  if (fs.existsSync(file)) {
    let valid = true;
    try { readJson(file); } catch (e) {
      if (!repair || !(e.cause instanceof SyntaxError)) throw e;
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`); valid = false;
    }
    const backup = `${file}.bak`;
    if (valid && (!fs.existsSync(backup) || Date.now() - fs.statSync(backup).mtimeMs > 60_000)) fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
export function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}
export const truncate = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n…[${s.length - n}자 생략]` : s);

/** 텍스트에서 첫 번째 완전한 JSON 객체를 추출한다 (```json 펜스, 앞뒤 잡음 허용). */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

/** 자식 프로세스용 환경: 데스크탑 Claude 세션의 중첩 변수 제거 */
/** 자식 프로세스의 입출력 통로 오류(EPIPE·ENOTCONN 등)가 허브 서버 전체를 죽이지 않게 막는다. 실패는 'error'·'close' 이벤트로 처리된다 */
export function guardChild(child) {
  for (const s of [child?.stdin, child?.stdout, child?.stderr]) s?.on?.('error', () => {});
  return child;
}

/**
 * 내가 띄운 자식과 그 자손을 끈다. 이미 끝난 자식이면 아무것도 하지 않는다 — 끝난 프로세스 번호는 Windows가 곧 다른
 * 프로세스에 다시 주므로, 번호로 `taskkill /T` 하면 상관없는 프로세스와 그 자식들까지 죽는다(2026-10-05 병렬 시험이
 * 가끔 깨지던 원인). 끄기로 했으면 true.
 */
export function killChildTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else { try { child.kill('SIGTERM'); } catch {} }
  return true;
}

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR') delete env[k];
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return { ...env, ...extra };
}

/** 작업 경로 → 공유 메모리 프로젝트 폴더(slug). sync.mjs/memory-check.mjs와 같은 규칙 */
export function projectMemoryFolder(hubDir, cwd) {
  if (!cwd) return null;
  try { return require(path.join(hubDir, 'sync', 'memory-context.cjs')).resolveMemoryProjects(hubDir, cwd).primary; }
  catch { return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'); }
}

export function projectMemoryFolders(hubDir, cwd) {
  if (!cwd) return [];
  try { return require(path.join(hubDir, 'sync', 'memory-context.cjs')).resolveMemoryProjects(hubDir, cwd).slugs; }
  catch { return [projectMemoryFolder(hubDir, cwd)]; }
}

/**
 * Codex 실행 파일 고르기: config 에 직접 경로를 적었으면 그것, 아니면
 * Codex 앱이 받아 둔 최신 CLI(~/.codex/packages/app-server-daemon/releases/<ver>/bin/codex.exe).
 * PATH 의 codex 가 오래돼서 새 모델(예: gpt-6.1-sol)을 거부하는 문제를 피한다. 10분 캐시.
 */
let codexCache = { at: 0, cmd: null, version: null };
export function codexCommand(cfg = {}) {
  if (cfg.command && cfg.command !== 'codex') return cfg.command;
  if (Date.now() - codexCache.at < 600_000 && codexCache.cmd) return codexCache.cmd;
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
  const rel = path.join(home, 'packages', 'app-server-daemon', 'releases');
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const ver = (n) => (n.match(/^(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  let best = null;
  try {
    for (const n of fs.readdirSync(rel)) {
      const v = ver(n); if (v.length !== 3) continue;
      const f = path.join(rel, n, 'bin', exe);
      if (!fs.existsSync(f)) continue;
      if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) best = { v, f, n };
    }
  } catch {}
  codexCache = { at: Date.now(), cmd: best ? best.f : 'codex', version: best ? best.v.join('.') : null };
  return codexCache.cmd;
}
