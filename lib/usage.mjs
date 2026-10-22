// 구독 한도(5시간·주간) 조회
// - Claude: CLI 제어 프로토콜 get_usage (모델 호출 없음). 실패 시 워커 스트림의 rate_limit_event 값.
// - Codex : ~/.codex/sessions 의 최신 rollout 기록에 남은 rate_limits 스냅샷 (로컬 기록 기반)
//           + 앱 서버(app-server)의 account/rateLimits/read 실시간 조회(모델 호출 없음) — 초기화권은 여기서만 나온다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { childEnv, guardChild, killChildTree, codexCommand, lineSplitter } from './util.mjs';

const TTL = 120_000;
const state = {
  claude: { at: 0, value: null, inflight: null, fromStream: null },
  codex: { at: 0, value: null },
  codexLive: { at: 0, value: null, inflight: null, error: null },
};
/** 뒤에서 한 실시간 조회로 값이 바뀌면 'change' — 서버가 화면에 다시 보낸다 */
export const usageEvents = new EventEmitter();

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
      // 1.5초 뒤에도 살아 있을 때만 끈다. 이미 끝난 번호로 끄면 상관없는 프로세스가 죽는다 — util.killChildTree 참고
      const reap = setTimeout(() => killChildTree(child), 1500);
      child.once('exit', () => clearTimeout(reap));
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

// ---------------- Codex 실시간(앱 서버) ----------------
// account/rateLimits/read = 지금 한도 + 초기화권(rateLimitResetCredits: 한도를 한 번 통째로 되돌리는 쿠폰, 받은 날·만료일이 있다).
// 세션 기록에는 초기화권이 없어 이 조회로만 알 수 있다(2026-10-12 사용자 "초기화권 여부도 조회해서 사용량 모니터에").
// 쓰는 일(초기화권 사용)은 하지 않는다 — 읽기만.
const LIVE_TTL = 10 * 60_000, LIVE_KEEP = 6 * 3_600_000;
/** 앱 서버 응답 → { windows, plan, resets }. resets = null(정보 없음) | { available, items:[{ title, type, grantedAt, expiresAt }] } — 지금 쓸 수 있는 것만 */
export function parseCodexLimits(r, now = Date.now()) {
  const rl = r?.rateLimits || r?.rateLimitsByLimitId?.codex || null;
  const windows = [];
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || w.usedPercent == null) continue;
    const mins = Number(w.windowDurationMins) || 0;
    windows.push({ key: `w${mins}`, label: windowLabel(mins), usedPercent: Number(w.usedPercent), resetsAt: iso(w.resetsAt) });
  }
  windows.sort((a, b) => (a.label === '5시간' ? -1 : b.label === '5시간' ? 1 : 0));
  const rc = r?.rateLimitResetCredits;
  let resets = null;
  if (rc && typeof rc === 'object') {
    const listed = Array.isArray(rc.credits);
    const items = (listed ? rc.credits : [])
      .filter((c) => c && (c.status || 'available') === 'available' && !(c.expiresAt && Number(c.expiresAt) * 1000 < now))
      .map((c) => ({ title: String(c.title || '').slice(0, 80), type: c.resetType || null, grantedAt: iso(c.grantedAt), expiresAt: iso(c.expiresAt) }))
      .sort((a, b) => String(a.expiresAt || '9').localeCompare(String(b.expiresAt || '9')));
    const n = Number(rc.availableCount);
    resets = { available: listed ? items.length : Number.isFinite(n) ? Math.max(0, n) : 0, items };
  }
  return { windows, plan: rl?.planType || null, resets };
}
/** 실행 파일 하나로 된 명령인지(인자가 섞인 사용자 정의 명령·시험용 가짜 CLI 는 아님) */
const plainCommand = (command) => !/[\s"]/u.test(command) || fs.existsSync(command);
/** Codex 앱 서버를 잠깐 띄워 한도를 묻는다. pre 는 시험용(실행 파일 뒤에 먼저 붙일 인자) */
export function readCodexLimits(command, { pre = [], timeoutMs = 12_000 } = {}) {
  return new Promise((resolve) => {
    const shell = /\.(cmd|bat)$/i.test(command) || !plainCommand(command);
    let child;
    try { child = guardChild(spawn(command, [...pre, 'app-server', '--listen', 'stdio://'], { shell, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })); }
    catch (e) { return resolve({ ok: false, error: String(e) }); }
    let done = false;
    const finish = (r) => {
      if (done) return; done = true; clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      // 1.5초 뒤에도 살아 있을 때만 끈다 — util.killChildTree 참고
      const reap = setTimeout(() => killChildTree(child), 1500); reap.unref?.();
      child.once('exit', () => clearTimeout(reap));
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '시간 초과' }), timeoutMs); timer.unref?.();
    const send = (x) => { try { child.stdin.write(JSON.stringify(x) + '\n'); } catch {} };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', lineSplitter((line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1) {
        if (m.error) return finish({ ok: false, error: m.error.message || '초기화 실패' });
        send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' });
      } else if (m.id === 2) finish(m.error ? { ok: false, error: m.error.message || '조회 실패' } : { ok: true, ...parseCodexLimits(m.result) });
    }));
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({ ok: false, error: String(e) }));
    child.on('close', () => finish({ ok: false, error: 'CLI 종료' }));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-hub', title: 'AI Hub', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}
/** 실시간 조회를 뒤에서 한 번 돌린다(겹치면 같은 것을 기다림). 값이 바뀌면 usageEvents 'change'. 띄울 수 없으면 null */
function refreshCodexLive(config) {
  const s = state.codexLive;
  if (s.inflight) return s.inflight;
  const cfg = config?.tools?.codex || {};
  if (config?.usage?.codexLive === false || cfg.enabled === false) return null;
  const command = codexCommand(cfg);
  if (!plainCommand(command)) return null;
  const sig = () => JSON.stringify([s.value?.resets ?? null, s.value?.windows ?? null]);
  s.inflight = readCodexLimits(command).then((r) => {
    const before = sig();
    s.inflight = null; s.at = Date.now();
    if (r.ok) { s.value = { windows: r.windows, plan: r.plan, resets: r.resets, observedAt: new Date().toISOString() }; s.error = null; }
    else { s.error = r.error; if (s.value && Date.now() - new Date(s.value.observedAt).getTime() > LIVE_KEEP) s.value = null; }
    if (sig() !== before) usageEvents.emit('change');
    return s.value;
  }).catch(() => { s.inflight = null; s.at = Date.now(); return s.value; });
  return s.inflight;
}
/** 기록에서 읽은 값과 실시간 값을 합친다: 한도는 더 새 쪽, 초기화권은 실시간 값(없으면 null = 모름) */
export function mergeCodexUsage(log, live) {
  if (!live) return { ...log, resets: null };
  const logAt = log?.observedAt ? new Date(log.observedAt).getTime() : 0, liveAt = new Date(live.observedAt).getTime();
  const useLive = !!live.windows?.length && (log?.status !== 'ok' || !logAt || liveAt >= logAt);
  const base = useLive ? { status: 'ok', source: '실시간 조회', plan: live.plan || log?.plan || null, windows: live.windows, observedAt: live.observedAt } : { ...log, plan: log?.plan || live.plan || null };
  return { ...base, resets: live.resets ? { ...live.resets, observedAt: live.observedAt } : null };
}

/**
 * @param {{force?:boolean, live?:boolean, fresh?:boolean, liveTtlMs?:number}} [opts] force = 짧은 캐시를 건너뜀(주기 갱신),
 *   live = Codex 실시간 조회를 해도 되는 호출(허브 서버의 주기 갱신·화면 요청만 켠다 — 작업 시작 같은 다른 호출은 이미 받아 둔 값만 읽는다.
 *   앱 서버를 띄우는 일이라 시험·작업 경로에서 겹쳐 띄우지 않게), fresh = 사용자가 누른 새로고침(실시간 조회를 기다림),
 *   liveTtlMs = 실시간 조회를 다시 할 간격(쉴 때는 길게)
 */
export async function usageStatus(config, { force = false, live = false, fresh = false, liveTtlMs = LIVE_TTL } = {}) {
  const lv = state.codexLive;
  if (live && (fresh || !lv.at || Date.now() - lv.at > liveTtlMs)) { const p = refreshCodexLive(config); if (p && fresh) await p; }
  const [claude, codex] = await Promise.all([claudeUsage(config, force).catch((e) => ({ status: 'unavailable', windows: [], error: String(e) })), Promise.resolve(codexUsage(force))]);
  const out = { claude, codex: mergeCodexUsage(codex, lv.value) };
  // 화면에 "리셋 전에 남는 한도를 쥐어짜는 중"을 보이려고 단계를 붙인다(판단은 쓰는 곳에서 spare() 로 다시 계산)
  for (const t of ['claude', 'codex']) if (out[t]) out[t] = { ...out[t], spare: spare(out, t, { config }) };
  return out;
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

// ---------------- 리셋 시간 대비 한도 (쥐어짜기) ----------------
// 2026-10-22 사용자 "리셋 시간 대비 한도가 많이 남았으면 좀 쥐어짜서 쓰게 해줘": Claude 주간 80%·리셋 3시간 전인데도
// "75% 넘게 썼다"며 최상위 모델·강도를 아꼈다 — 남은 20%는 그대로 버려진다. 사용률만 보지 말고 리셋까지 남은 시간과 함께 본다.
const HOUR = 3_600_000, DAY = 24 * HOUR;
/** 한도 창 길이(ms): Codex 는 key 가 w<분>, Claude 는 5시간·주간(모델 전용 한도도 주간). 모르면 null */
export function windowLength(w) {
  const m = /^w(\d+)$/.exec(w?.key || ''); if (m) return Number(m[1]) * 60_000 || null;
  if (w?.key === 'five_hour' || w?.label === '5시간') return 5 * HOUR;
  if (w?.key === 'seven_day' || w?.scope === 'model' || /주간/.test(w?.label || '')) return 7 * DAY;
  return null;
}
/**
 * 창 하나의 속도: 남은 한도(%)와 남은 시간 비율. slack = 남은 % − 남은 시간 비율×100
 * — 고르게 써 왔으면 0 근처, 리셋 전에 버려질 몫이 클수록 크다(주간 80%·3시간 남음 → 20 − 2 = 18).
 */
export function windowPace(w, now = Date.now()) {
  const len = windowLength(w), reset = Date.parse(w?.resetsAt || ''), used = Number(w?.usedPercent);
  if (!len || !Number.isFinite(reset) || w?.usedPercent == null || !Number.isFinite(used)) return null;
  const leftMs = Math.min(len, Math.max(0, reset - now)), leftFrac = leftMs / len, remaining = Math.max(0, 100 - used);
  return { key: w.key, label: w.label, used, remaining, leftMs, leftFrac, slack: remaining - 100 * leftFrac, long: len > DAY };
}
export const leftText = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))}분 뒤` : ms < 2 * DAY ? `${Math.round(ms / HOUR)}시간 뒤` : `${Math.round(ms / DAY)}일 뒤`);
const SQUEEZE = { enabled: true, at: 10, strong: 25, shortMax: 80, minRemaining: 5 };
export const squeezeConfig = (config) => ({ ...SQUEEZE, ...(config?.squeeze || {}) });
/**
 * 쥐어짜기 단계 — 0 평소 · 1 넉넉(아끼는 장치를 풀고 강도 xhigh·최상위 모델 허용) · 2 많이 남음(그 AI에 일을 더 주고 최상위 모델로 올림)
 * 기준: 그 AI 의 긴(주간) 창 slack 이 squeeze.at(10) 이상이면 1, strong(25) 이상이면 2. 쓰는 만큼 slack 이 줄어 저절로 평소로 돌아온다. model 을 주면 그 모델 전용 창(Fable 주간)도 함께 보고 낮은 쪽.
 * 짧은 창(5시간)을 shortMax(80%) 넘게 썼거나 남은 한도가 minRemaining(5%) 미만이면 곧 막히니 0. 모르면 0(아끼는 쪽 그대로).
 * @returns {{ level: 0|1|2, slack: number|null, remaining?: number, leftMs?: number, label?: string, note: string|null }}
 */
export function spare(usage, tool, { model = null, config = null, now = Date.now() } = {}) {
  const c = squeezeConfig(config), none = { level: 0, slack: null, note: null };
  if (c.enabled === false) return none;
  const paces = (usage?.[tool]?.windows || []).map((w) => ({ w, p: windowPace(w, now) })).filter((x) => x.p);
  if (paces.some((x) => x.w.scope !== 'model' && !x.p.long && x.p.used >= c.shortMax)) return { ...none, note: '5시간 한도가 차서' };
  const long = paces.filter((x) => x.w.scope !== 'model' && x.p.long);
  const mine = model ? paces.find((x) => x.w.scope === 'model' && x.w.model === String(model).toLowerCase()) : null;
  const base = [...long, ...(mine ? [mine] : [])].sort((a, b) => a.p.slack - b.p.slack)[0]; // 가장 빠듯한 창이 기준
  if (!base) return none;
  const { p } = base;
  if (p.remaining < c.minRemaining) return { ...none, slack: p.slack };
  const level = p.slack >= c.strong ? 2 : p.slack >= c.at ? 1 : 0;
  return { level, slack: p.slack, remaining: p.remaining, leftMs: p.leftMs, label: p.label, note: level ? `${p.label} 한도가 리셋(${leftText(p.leftMs)})까지 ${Math.round(p.remaining)}% 남아 아끼지 않고 씀` : null };
}
/**
 * 리셋까지 남은 시간당 쓸 수 있는 한도(남은 % ÷ 남은 시간 비율) — 창 여럿이면 가장 빠듯한 값. 분배 비율에 쓴다.
 * 같은 20% 남음이어도 3시간 뒤 리셋이면 크고, 6일 뒤 리셋이면 작다. 모르면 null
 */
export function spendRate(usage, tool, now = Date.now()) {
  const rates = (usage?.[tool]?.windows || []).filter((w) => w.scope !== 'model').map((w) => windowPace(w, now)).filter(Boolean)
    .map((p) => Math.min(1000, p.remaining / Math.max(0.02, p.leftFrac)));
  return rates.length ? Math.min(...rates) : null;
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
export function balanceShare(usage, healthy = ['claude', 'codex'], { config = null, now = Date.now() } = {}) {
  const h = {};
  for (const t of ['claude', 'codex']) {
    const v = headroom(usage, t);
    h[t] = !healthy.includes(t) ? 0 : v == null ? 50 : v <= 100 - CRIT_AT ? 0 : v;
  }
  // 리셋 시간 대비(2026-10-22): 둘 다 리셋 시각을 알면 남은 한도 대신 "리셋까지 시간당 쓸 수 있는 몫"으로 나눈다 — 곧 리셋되는 쪽에 일을 더
  const rate = { claude: spendRate(usage, 'claude', now), codex: spendRate(usage, 'codex', now) };
  const byRate = squeezeConfig(config).enabled !== false && h.claude && h.codex && rate.claude != null && rate.codex != null && rate.claude + rate.codex > 0;
  if (byRate) { h.claude = rate.claude; h.codex = rate.codex; }
  const sum = h.claude + h.codex;
  if (!sum) return { claude: 0.5, codex: 0.5, note: '두 AI 모두 한도가 거의 찼어요' };
  let c = h.claude / sum;
  if (h.claude && h.codex) c = Math.min(0.85, Math.max(0.15, c));
  const pct = (x) => Math.round(x * 100);
  return { claude: c, codex: 1 - c, note: `${byRate ? '리셋까지 남은 시간 대비 남은 한도' : '남은 한도'} 기준 권장 분배: Claude ${pct(c)}% · Codex ${pct(1 - c)}%` };
}
