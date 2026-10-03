// 구독 한도(5시간·주간) 조회
// - Claude: CLI 제어 프로토콜 get_usage (모델 호출 없음). 실패 시 워커 스트림의 rate_limit_event 값.
// - Codex : ~/.codex/sessions 의 최신 rollout 기록에 남은 rate_limits 스냅샷 (로컬 기록 기반).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv, guardChild } from './util.mjs';

const TTL = 120_000;
const state = {
  claude: { at: 0, value: null, inflight: null, fromStream: null },
  codex: { at: 0, value: null },
};

const windowLabel = (mins) => (mins <= 360 ? '5시간' : mins >= 10000 ? '주간' : `${Math.round(mins / 60)}시간`);
const iso = (v) => (v == null ? null : typeof v === 'number' ? new Date(v * 1000).toISOString() : new Date(v).toISOString());

// ---------------- Claude ----------------
function claudeGetUsage(command = 'claude') {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    let child;
    try { child = guardChild(spawn(command, args, { shell: true, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })); }
    catch (e) { return resolve({ ok: false, error: String(e) }); }
    let buf = '', done = false;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      setTimeout(() => { if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill(); }, 1500);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '시간 초과' }), 25_000);
    const send = (id, request) => { try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n'); } catch {} };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type !== 'control_response') continue;
        const r = ev.response;
        if (r?.request_id === 'hub-init') {
          if (r.subtype !== 'success') finish({ ok: false, error: '초기화 실패' });
          else send('hub-usage', { subtype: 'get_usage', skip_behaviors: true });
        } else if (r?.request_id === 'hub-usage') {
          if (r.subtype !== 'success') return finish({ ok: false, error: r.error || '조회 실패' });
          const x = r.response || {};
          const windows = [];
          for (const [key, label] of [['five_hour', '5시간'], ['seven_day', '주간']]) {
            const w = x.rate_limits?.[key];
            if (w && w.utilization != null) windows.push({ key, label, usedPercent: Number(w.utilization), resetsAt: iso(w.resets_at) });
          }
          // 모델별 주간 한도 (예: Fable). model_scoped 가 없으면 limits[].weekly_scoped 에서 찾는다
          const scoped = Array.isArray(x.rate_limits?.model_scoped) ? x.rate_limits.model_scoped
            : (x.rate_limits?.limits || []).filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name).map((l) => ({ display_name: l.scope.model.display_name, utilization: l.percent, resets_at: l.resets_at }));
          for (const m of scoped) {
            if (!m?.display_name || m.utilization == null) continue;
            const name = String(m.display_name);
            windows.push({ key: `model_${name.toLowerCase()}`, label: `${name} 주간`, usedPercent: Number(m.utilization), resetsAt: iso(m.resets_at), scope: 'model', model: name.toLowerCase() });
          }
          finish({ ok: true, plan: x.subscription_type || null, windows });
        }
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({ ok: false, error: String(e) }));
    child.on('close', () => finish({ ok: false, error: 'CLI 종료' }));
    send('hub-init', { subtype: 'initialize' });
  });
}

/** 워커 스트림의 rate_limit_event 를 받아 둔다 (utilization 0~1, resetsAt 유닉스 초) */
export function noteClaudeRateLimit(ev) {
  const uw = ev?.rate_limit_info?.unifiedWindows;
  if (!uw) return;
  const windows = [];
  for (const [key, label] of [['five_hour', '5시간'], ['seven_day', '주간']]) {
    const w = uw[key];
    if (w && w.utilization != null) windows.push({ key, label, usedPercent: Math.round(Number(w.utilization) * 1000) / 10, resetsAt: iso(w.resetsAt) });
  }
  if (windows.length) state.claude.fromStream = { windows, observedAt: new Date().toISOString() };
}

async function claudeUsage(config, force) {
  const s = state.claude;
  if (!force && s.value && Date.now() - s.at < TTL) return s.value;
  if (!s.inflight) {
    s.inflight = claudeGetUsage(config.tools?.claude?.command || 'claude').then((r) => {
      const now = new Date().toISOString();
      s.value = r.ok
        ? { status: 'ok', source: '실시간 조회', plan: r.plan, windows: r.windows, observedAt: now }
        : s.fromStream
          ? { status: 'stale', source: '최근 작업 기록', windows: s.fromStream.windows, observedAt: s.fromStream.observedAt, error: r.error }
          : { status: 'unavailable', source: null, windows: [], observedAt: now, error: r.error };
      s.at = Date.now(); s.inflight = null;
      return s.value;
    });
  }
  return s.inflight;
}

// ---------------- Codex ----------------
function newestRollouts(limit = 8) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const out = [];
  const dirsDesc = (d) => { try { return fs.readdirSync(d).filter((n) => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  for (const y of dirsDesc(root)) for (const m of dirsDesc(path.join(root, y))) for (const d of dirsDesc(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => { const f = path.join(dir, n); return { f, t: fs.statSync(f).mtimeMs }; }); } catch {}
    out.push(...files);
    if (out.length >= limit * 3) return out.sort((a, b) => b.t - a.t).slice(0, limit);
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit);
}

function tailText(file, bytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function findRateLimits(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.rate_limits && typeof obj.rate_limits === 'object') return obj.rate_limits;
  for (const v of Object.values(obj)) { const r = findRateLimits(v); if (r) return r; }
  return null;
}

function codexUsage(force) {
  const s = state.codex;
  if (!force && s.value && Date.now() - s.at < 30_000) return s.value;
  let best = null;
  for (const { f } of newestRollouts()) {
    let text; try { text = tailText(f); } catch { continue; }
    const lines = text.split('\n').filter((l) => l.includes('"rate_limits"'));
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
      const rl = findRateLimits(ev);
      if (!rl || (!rl.primary && !rl.secondary)) continue;
      const ts = ev.timestamp || null;
      if (!best || (ts && ts > best.ts)) best = { ts, rl };
      break;
    }
  }
  if (!best) s.value = { status: 'unavailable', source: null, windows: [], observedAt: new Date().toISOString(), error: '기록 없음' };
  else {
    const windows = [];
    for (const w of [best.rl.primary, best.rl.secondary]) {
      if (!w || w.used_percent == null) continue;
      windows.push({ key: `w${w.window_minutes}`, label: windowLabel(w.window_minutes || 0), usedPercent: Number(w.used_percent), resetsAt: iso(w.resets_at) });
    }
    windows.sort((a, b) => (a.label === '5시간' ? -1 : b.label === '5시간' ? 1 : 0));
    const reset = windows.every((w) => !w.resetsAt || new Date(w.resetsAt) < new Date()) && windows.length > 0;
    s.value = { status: reset ? 'stale' : 'ok', source: '최근 Codex 기록', plan: best.rl.plan_type || null, windows, observedAt: best.ts };
  }
  s.at = Date.now();
  return s.value;
}

export async function usageStatus(config, { force = false } = {}) {
  const [claude, codex] = await Promise.all([claudeUsage(config, force).catch((e) => ({ status: 'unavailable', windows: [], error: String(e) })), Promise.resolve(codexUsage(force))]);
  return { claude, codex };
}

/** 경고 단계: 80% 이상 주의, 95% 이상 위험 */
export const WARN_AT = 80, CRIT_AT = 95;
export function usageWarnings(usage) {
  const out = [];
  for (const tool of ['claude', 'codex']) {
    for (const w of usage?.[tool]?.windows || []) {
      const p = Number(w.usedPercent);
      if (Number.isNaN(p) || p < WARN_AT) continue;
      out.push({ tool, key: w.key, label: w.label, model: w.model || null, percent: p, level: p >= CRIT_AT ? 'crit' : 'warn', resetsAt: w.resetsAt });
    }
  }
  return out.sort((a, b) => b.percent - a.percent);
}

/** 도구별 남은 여유(%) — 모델 전용 한도는 빼고 5시간·주간 중 더 빡빡한 쪽 */
export function headroom(usage, tool) {
  const ws = (usage?.[tool]?.windows || []).filter((w) => w.scope !== 'model').map((w) => Number(w.usedPercent)).filter((x) => !Number.isNaN(x));
  return ws.length ? Math.max(0, 100 - Math.max(...ws)) : null;
}

/** 모델 전용 한도 사용률 (없으면 null) */
export function modelUsed(usage, tool, model) {
  const w = (usage?.[tool]?.windows || []).find((x) => x.scope === 'model' && x.model === String(model || '').toLowerCase());
  return w ? Number(w.usedPercent) : null;
}

/**
 * 남은 한도 기준 권장 분배 비율. 한쪽이 위험(95%+)이면 그쪽은 0.
 * @returns {{claude:number, codex:number, note:string}}
 */
export function balanceShare(usage, healthy = ['claude', 'codex']) {
  const h = {};
  for (const t of ['claude', 'codex']) {
    const v = headroom(usage, t);
    h[t] = !healthy.includes(t) ? 0 : v == null ? 50 : v <= 100 - CRIT_AT ? 0 : v;
  }
  const sum = h.claude + h.codex;
  if (!sum) return { claude: 0.5, codex: 0.5, note: '두 AI 모두 한도가 거의 찼어요' };
  let c = h.claude / sum;
  if (h.claude && h.codex) c = Math.min(0.85, Math.max(0.15, c));
  const pct = (x) => Math.round(x * 100);
  return { claude: c, codex: 1 - c, note: `남은 한도 기준 권장 분배: Claude ${pct(c)}% · Codex ${pct(1 - c)}%` };
}
