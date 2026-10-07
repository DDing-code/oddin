// Claude Code / Codex CLI 상태 점검 (버전, 로그인) — 60초 캐시
import { spawn } from 'node:child_process';
import { childEnv, codexCommand, guardChild } from './util.mjs';

const cache = new Map();
const TTL = 60_000;
let inflight = null;

function run(cmd, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = guardChild(spawn(cmd, args, { shell: true, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function checkClaude(cfg) {
  const cmd = cfg.command || 'claude';
  const [ver, auth] = await Promise.all([run(cmd, ['--version']), run(cmd, ['auth', 'status'])]);
  let loggedIn = false, method = '';
  try { const j = JSON.parse(auth.out); loggedIn = !!j.loggedIn; method = j.authMethod || ''; } catch {}
  const version = (ver.out || '').trim().split('\n')[0] || null;
  return {
    name: 'claude', label: 'Claude Code', enabled: cfg.enabled !== false,
    installed: ver.code === 0 && !!version, version, loggedIn, authMethod: method,
    ok: cfg.enabled !== false && ver.code === 0 && loggedIn,
    fix: loggedIn ? null : '터미널에서 `claude auth login` 실행 후 브라우저에서 로그인',
  };
}

async function checkCodex(cfg) {
  const cmd = codexCommand(cfg);
  const [ver, auth] = await Promise.all([run(cmd, ['--version']), run(cmd, ['login', 'status'])]);
  const text = (auth.out + auth.err).trim();
  const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
  const version = (ver.out || '').trim().split('\n')[0] || null;
  return {
    name: 'codex', label: 'Codex', enabled: cfg.enabled !== false,
    installed: ver.code === 0 && !!version, version, loggedIn, authMethod: loggedIn ? text.replace(/^logged in\s*/i, '') : '',
    ok: cfg.enabled !== false && ver.code === 0 && loggedIn,
    fix: loggedIn ? null : '터미널에서 `codex login` 실행',
  };
}

export async function toolStatus(config, { force = false } = {}) {
  const key = 'status';
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const [claude, codex] = await Promise.all([checkClaude(config.tools.claude || {}), checkCodex(config.tools.codex || {})]);
    const value = { checkedAt: new Date().toISOString(), claude, codex };
    cache.set(key, { at: Date.now(), value });
    return value;
  })();
  try { return await inflight; } finally { inflight = null; }
}

export function invalidateToolStatus() { cache.clear(); }

export function healthyTools(status) {
  return ['claude', 'codex'].filter((n) => status[n]?.ok);
}
