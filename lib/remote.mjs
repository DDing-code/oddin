// Tailscale Serve 전용 원격 게이트. 공개 바인딩·토큰·셸 문자열을 사용하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT, nowIso, writeJsonAtomic } from './util.mjs';

// SAMEORIGIN: 화면 나눠 보기(public/split.js)가 ODDIN 화면을 칸 안에 띄운다. 다른 사이트가 끼워 넣는 것은 계속 막는다
export const SECURITY_HEADERS = { 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' };
export const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOGIN_URL = 'https://login.tailscale.com/';
const HTTPS_URL = 'https://login.tailscale.com/admin/dns';
const READ = new Set(['GET', 'HEAD']);
const MESSAGES = {
  remote_socket: '원격 요청은 Tailscale을 거쳐야만 받을 수 있어요',
  remote_off: '원격 접속이 꺼져 있어요. 허브 PC의 설정 › 원격 접속에서 켜 주세요',
  remote_host: '이 주소로는 허브를 열 수 없어요',
  remote_user: '허용되지 않은 Tailscale 계정이에요',
  bad_origin: '허용되지 않은 출처',
  remote_local_only: '원격 접속 설정은 허브 PC에서만 바꿀 수 있어요',
};

export function normalizeHost(value) {
  if (typeof value !== 'string' || value.length > 260) return '';
  const s = value.trim().toLowerCase();
  // 쉼표로 합쳐진 중복 헤더·userinfo·경로·제어문자는 허용하지 않는다.
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(s)) return '';
  return s.replace(/:\d+$/, '').replace(/\.+$/, '');
}
export function normalizeLogin(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().toLowerCase();
  return s.length <= 254 && /^[^\s,<>\x00-\x1f\x7f]+$/.test(s) ? s : '';
}
function unique(values, normalize) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalize).filter(Boolean))];
}
function dashboardUrl(value, hosts) {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !hosts.includes(normalizeHost(u.host))) return null;
    return `${u.origin}/`;
  } catch { return null; }
}
export function normalizeRemoteConfig(raw = {}, port = 7700) {
  const hosts = unique(raw?.hosts, normalizeHost);
  const logins = unique(raw?.logins, normalizeLogin);
  const url = dashboardUrl(raw?.url, hosts);
  const target = `http://127.0.0.1:${port}`;
  return {
    version: 1, provider: 'tailscale',
    enabled: raw?.version === 1 && raw?.provider === 'tailscale' && raw?.enabled === true && hosts.length > 0 && logins.length > 0 && !!url && raw?.target === target,
    url, hosts, logins, target, updatedAt: raw?.updatedAt || null,
  };
}
export function decodeUserName(value) {
  if (typeof value !== 'string') return null;
  try {
    return value.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, kind, encoded) => {
      if (kind.toLowerCase() === 'b') return Buffer.from(encoded, 'base64').toString('utf8');
      const bytes = encoded.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, 'latin1').toString('utf8');
    }).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || null;
  } catch { return null; }
}

/** 성공은 null, 거절은 {status, code, error}. req.hubViewer는 매번 새로 정한다. */
export function checkRemoteRequest(req, { port = 7700, remote = {} } = {}) {
  const deny = (code) => ({ status: code === 'remote_host' ? 421 : 403, code, error: MESSAGES[code] });
  req.hubViewer = { remote: false, login: null, name: null };
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return deny('remote_socket');
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const forwarded = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic'].some((h) => Object.hasOwn(req.headers, h));
  const local = localHosts.includes(host) && !forwarded;
  const write = !READ.has(req.method);
  const origin = req.headers.origin;
  if (local) {
    if (write && origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin)) return deny('bad_origin');
    return null;
  }
  if (!remote.enabled) return deny('remote_off');
  const remoteHost = normalizeHost(localHosts.includes(host) ? req.headers['x-forwarded-host'] : host);
  if (!remoteHost || !remote.hosts?.includes(remoteHost)) return deny('remote_host');
  const login = normalizeLogin(req.headers['tailscale-user-login']);
  if (!login || !remote.logins?.includes(login)) return deny('remote_user');
  let origins = remote.hosts.map((h) => `https://${h}`);
  try { origins.push(new URL(remote.url).origin); } catch {}
  if (write && origin && !origins.includes(origin)) return deny('bad_origin');
  let pathname = '';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch {}
  if (write && pathname.startsWith('/api/remote/')) return deny('remote_local_only');
  req.hubViewer = { remote: true, login, name: decodeUserName(req.headers['tailscale-user-name']) };
  return null;
}

export function findTailscale() {
  const fixed = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  if (fs.existsSync(fixed)) return fixed;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'tailscale.exe' : 'tailscale');
    try { if (fs.statSync(exe).isFile()) return exe; } catch {}
  }
  return null;
}

/** 출력은 메모리에서만 처리한다. 인증 링크·CLI 원문을 로그나 오류에 넣지 않는다. */
export function runCommand(exe, args, { timeoutMs = 5000, stopOnHttpsLink = false } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, httpsRequired = false, done = false;
    const child = spawn(exe, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code, errorCode = null) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, httpsRequired, errorCode });
    };
    const stop = () => { child.kill(); setTimeout(() => finish(null), 1000).unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (channel, chunk) => {
      if (channel === 'out') stdout = (stdout + chunk).slice(0, 1_000_000);
      else stderr = (stderr + chunk).slice(0, 1_000_000);
      if (stopOnHttpsLink && /https:\/\/login\.tailscale\.com\//i.test(stdout + stderr)) { httpsRequired = true; stop(); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => collect('out', c));
    child.stderr.on('data', (c) => collect('err', c));
    child.on('error', (e) => finish(null, e.code));
    child.on('close', (code) => finish(code));
  });
}
function parseJson(result) {
  if (result.code !== 0 || result.timedOut) return null;
  try { const x = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); return x && typeof x === 'object' && !Array.isArray(x) ? x : null; } catch { return null; }
}

export function parseTailscaleStatus(status, serve = {}, { exe = null, version = null, target = 'http://127.0.0.1:7700', error = null } = {}) {
  const states = new Set(['Stopped', 'Starting', 'NeedsLogin', 'NeedsMachineAuth', 'Running']);
  const state = !exe ? 'NotInstalled' : !status ? 'NotRunning' : states.has(status.BackendState) ? status.BackendState : 'Unknown';
  const dnsName = normalizeHost(status?.Self?.DNSName) || null;
  const user = status?.User?.[String(status?.Self?.UserID)];
  const login = normalizeLogin(user?.LoginName) || null;
  const hp = `${dnsName}:443`;
  const configs = [serve, ...Object.values(serve?.Foreground || {})].filter((x) => x && typeof x === 'object');
  let rootHandler = null, serving = false, conflict = false;
  for (const c of configs) {
    const handler = c.Web?.[hp]?.Handlers?.['/'];
    if (handler) {
      rootHandler = handler;
      if (dashboardTarget(handler.Proxy) !== target || c.TCP?.['443']?.HTTPS !== true) conflict = true;
      else serving = true;
    } else if (c.TCP?.['443'] && c.TCP['443'].HTTPS !== true) conflict = true;
  }
  const funnel = configs.some((c) => Object.values(c.AllowFunnel || {}).some((v) => v === true));
  return {
    installed: !!exe, exe, version, state, dnsName, login,
    // AuthURL에는 일회성 자격값이 들어갈 수 있다. 공개 로그인 화면으로만 안내한다.
    authUrl: status?.AuthURL ? LOGIN_URL : null,
    httpsEnabled: !!dnsName && Array.isArray(status?.CertDomains) && status.CertDomains.some((h) => normalizeHost(h) === dnsName),
    serving: serving && !conflict, serveTarget: typeof rootHandler?.Proxy === 'string' ? dashboardTarget(rootHandler.Proxy) : null,
    funnel, error, checkedAt: nowIso(), conflict,
  };
}
function dashboardTarget(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash) return null;
    return u.pathname === '/' ? u.origin : `${u.origin}${u.pathname}`;
  } catch { return null; }
}
export function remoteSnapshot(remote, ts, { port = 7700, viewer = { remote: false, login: null, name: null }, httpsRequired = false } = {}) {
  const target = `http://127.0.0.1:${port}`;
  const ready = remote.enabled && ts.state === 'Running' && ts.serving && !ts.funnel && remote.hosts.includes(ts.dnsName) && remote.target === target && ts.serveTarget === target;
  let next;
  if (ts.state === 'NotInstalled') next = { step: 'install', message: '허브 PC에 Tailscale을 설치해 주세요', command: 'winget install --id Tailscale.Tailscale -e', url: 'https://tailscale.com/download/windows' };
  else if (['NotRunning', 'Stopped', 'Starting'].includes(ts.state)) next = { step: 'start', message: '작업 표시줄의 Tailscale 아이콘에서 Connect를 눌러 주세요', command: 'tailscale up', url: null };
  else if (['NeedsLogin', 'NeedsMachineAuth'].includes(ts.state)) next = { step: 'login', message: 'Tailscale 앱에서 로그인하고 기기를 승인해 주세요', command: null, url: ts.authUrl || LOGIN_URL };
  else if (ts.state !== 'Running' || ts.error) next = { step: 'start', message: 'Tailscale 상태를 확인하지 못했어요. 앱 연결 후 다시 확인해 주세요', command: null, url: null };
  else if (ts.conflict) next = { step: 'conflict', message: '443 포트를 이미 다른 서비스가 쓰고 있어요', command: null, url: null };
  else if (!ts.httpsEnabled || httpsRequired) next = { step: 'enable-https', message: 'Tailscale 관리 화면에서 HTTPS 인증서를 허용해 주세요', command: null, url: HTTPS_URL };
  else if (ready) next = { step: 'ready', message: '다른 컴퓨터에서 주소를 열면 돼요', command: null, url: remote.url };
  else next = { step: 'enable', message: '허브 PC에서 원격 접속을 켜 주세요', command: null, url: null };
  const warnings = [];
  if (ts.funnel) warnings.push('Funnel이 켜져 있어요. 공개 접속을 끄고 비공개 Serve만 사용해 주세요');
  if (remote.enabled && !ts.serving) warnings.push('원격 설정은 켜져 있지만 Tailscale Serve 연결이 없어요');
  if (!remote.enabled && ts.serving) warnings.push('Serve는 설정되어 있지만 허브의 원격 접속은 꺼져 있어요');
  if (remote.enabled && ts.dnsName && !remote.hosts.includes(ts.dnsName)) warnings.push('PC 주소가 바뀌었어요. 허브 PC에서 원격 접속을 다시 켜 주세요');
  if (ts.serveTarget && ts.serveTarget !== target) warnings.push('Serve 대상이 이 허브의 주소와 달라요');
  const { conflict, ...tailscale } = ts;
  if (viewer.remote) tailscale.authUrl = null;
  return { enabled: remote.enabled, ready, url: remote.url, hosts: remote.hosts, allowedCount: remote.logins.length, viewer, canManage: !viewer.remote, local: { url: target }, tailscale, next, warnings, checkedAt: nowIso() };
}

export class RemoteAccess {
  constructor({ port = 7700, dataDir = DATA_DIR, findExe = findTailscale, run = runCommand, log = console.warn } = {}) {
    this.port = port; this.file = path.join(dataDir, 'remote.json'); this.findExe = findExe; this.run = run; this.log = log;
    this.marker = undefined; this.config = normalizeRemoteConfig({}, port); this.cache = null; this.pending = null; this.blocked = new Map(); this.queue = Promise.resolve(); this.httpsRequired = false;
  }
  readConfig() {
    let marker;
    try { const s = fs.statSync(this.file); marker = `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`; } catch { marker = null; }
    if (marker === this.marker) return this.config;
    this.marker = marker;
    let raw = {};
    if (marker) {
      try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')); }
      catch { this.log('[원격 설정] 설정을 읽지 못해 원격 접속을 차단합니다'); }
    }
    this.config = normalizeRemoteConfig(raw, this.port);
    return this.config;
  }
  saveConfig(raw) {
    const normalized = normalizeRemoteConfig({ ...raw, version: 1, provider: 'tailscale', target: `http://127.0.0.1:${this.port}` }, this.port);
    writeJsonAtomic(this.file, { ...normalized, updatedAt: nowIso() }, { repair: true }); // 사용자가 다시 설정할 때만 손상본을 따로 보존하고 교체
    this.marker = undefined; return this.readConfig();
  }
  check(req, { log = true } = {}) {
    const denial = checkRemoteRequest(req, { port: this.port, remote: this.readConfig() });
    if (denial && log) {
      const host = normalizeHost(req.headers.host) || '-';
      // 거절된 임의 헤더값·경로·쿼리는 기록하지 않는다.
      const login = normalizeLogin(req.headers['tailscale-user-login']);
      const knownLogin = this.config.logins.includes(login) ? login : '-';
      const key = `${denial.code}:${host}:${knownLogin}`, at = Date.now();
      if (at - (this.blocked.get(key) || 0) >= 60_000) {
        for (const [k, time] of this.blocked) if (at - time >= 60_000) this.blocked.delete(k);
        if (this.blocked.size >= 1000) this.blocked.clear();
        this.blocked.set(key, at);
        this.log(`[원격 차단] ${denial.code} host=${host} login=${knownLogin} ${req.method} ${req.url?.startsWith('/api/') ? '/api/…' : req.url?.startsWith('/uploads/') ? '/uploads/…' : '/'}`);
      }
    }
    return denial;
  }
  async probe({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.at < 30_000) return this.cache.ts;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const exe = this.findExe();
      let ts;
      if (!exe) ts = parseTailscaleStatus(null);
      else {
        const results = await Promise.allSettled([
          this.run(exe, ['version']), this.run(exe, ['status', '--json']), this.run(exe, ['serve', 'status', '--json']),
        ]);
        const [version, status, serve] = results.map((r) => r.status === 'fulfilled' ? r.value : { code: null, stdout: '' });
        const s = parseJson(status), sc = parseJson(serve);
        ts = parseTailscaleStatus(s, sc || {}, { exe, target: `http://127.0.0.1:${this.port}`, version: version.code === 0 ? (version.stdout.match(/^\s*(\d+\.\d+\.\d+[^\r\n]*)/)?.[1] || null) : null, error: !s ? 'Tailscale 데몬에 연결하지 못했어요' : !sc ? 'Serve 설정을 확인하지 못했어요' : null });
      }
      this.cache = { at: Date.now(), ts }; return ts;
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async status({ force = false, viewer } = {}) {
    const ts = await this.probe({ force });
    return remoteSnapshot(this.readConfig(), ts, { port: this.port, viewer, httpsRequired: this.httpsRequired });
  }
  serialize(fn) {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  enable({ force = false } = {}) {
    return this.serialize(async () => {
      const ts = await this.probe({ force: true });
      const before = remoteSnapshot(this.readConfig(), ts, { port: this.port });
      const result = async (ok, step, message) => ({ ...await this.status(), result: { ok, step, message } });
      if (ts.state !== 'Running' || ts.error) return result(false, before.next.step, before.next.message);
      if (ts.conflict && !force) return result(false, 'conflict', before.next.message);
      if (!ts.dnsName || !ts.login) return result(false, 'login', '현재 Tailscale 계정을 확인하지 못했어요. 개인 계정으로 로그인해 주세요');
      if (!ts.httpsEnabled) { this.httpsRequired = true; return { ...await result(false, 'enable-https', 'HTTPS 인증서를 먼저 허용해 주세요'), result: { ok: false, step: 'enable-https', message: 'HTTPS 인증서를 먼저 허용해 주세요', url: HTTPS_URL } }; }
      const run = await this.run(ts.exe, ['serve', '--bg', ...(force && ts.conflict ? ['--yes'] : []), '--https=443', `http://127.0.0.1:${this.port}`], { timeoutMs: 25_000, stopOnHttpsLink: true });
      this.cache = null; this.httpsRequired = !!run.httpsRequired;
      if (run.httpsRequired) return { ...await result(false, 'enable-https', 'HTTPS 인증서를 허용한 뒤 다시 켜 주세요'), result: { ok: false, step: 'enable-https', message: 'HTTPS 인증서를 허용한 뒤 다시 켜 주세요', url: HTTPS_URL } };
      if (run.code !== 0 || run.timedOut) return result(false, 'enable', 'Serve 연결을 설정하지 못했어요. Tailscale 앱의 상태를 확인해 주세요');
      const after = await this.probe({ force: true });
      if (after.error || after.state !== 'Running' || !after.serving || after.funnel || after.dnsName !== ts.dnsName || after.login !== ts.login) return result(false, 'enable', 'Serve 연결을 검증하지 못해 원격 접속을 켜지 않았어요');
      this.saveConfig({ ...this.readConfig(), enabled: true, url: `https://${after.dnsName}/`, hosts: [after.dnsName], logins: [...this.readConfig().logins, after.login] });
      this.httpsRequired = false;
      return result(true, 'ready', '비공개 원격 접속을 켰어요');
    });
  }
  disable() {
    return this.serialize(async () => {
      const prior = this.readConfig();
      this.saveConfig({ ...prior, enabled: false }); // CLI가 실패해도 앱 게이트부터 닫는다.
      const ts = await this.probe({ force: true });
      let ok = true, message = '원격 접속을 껐어요';
      if (ts.state === 'Running' && ts.serving && ts.serveTarget === prior.target) {
        const run = await this.run(ts.exe, ['serve', '--https=443', 'off'], { timeoutMs: 25_000 });
        ok = run.code === 0 && !run.timedOut;
        if (!ok) message = '허브의 원격 접속은 차단했지만 Serve 해제에 실패했어요';
      } else if (ts.conflict) message = '허브의 원격 접속을 차단했어요. 다른 서비스의 Serve 설정은 유지했어요';
      this.cache = null; this.httpsRequired = false;
      return { ...await this.status({ force: true }), result: { ok, step: 'enable', message } };
    });
  }
  changeLogin(value, allow) {
    const login = normalizeLogin(value);
    if (!login) throw new Error('올바른 Tailscale 로그인 이름이 필요합니다');
    const config = this.readConfig();
    const logins = allow ? [...config.logins, login] : config.logins.filter((x) => x !== login);
    return this.saveConfig({ ...config, logins });
  }
}

export function sendRemoteBlocked(res, denial, pathname, send, publicDir = path.join(ROOT, 'public')) {
  if (pathname.startsWith('/api/') || pathname.startsWith('/uploads/')) return send(res, denial.status, { error: denial.error, code: denial.code });
  try {
    const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const html = fs.readFileSync(path.join(publicDir, 'remote-blocked.html'), 'utf8').replaceAll('%%CODE%%', escape(denial.code)).replaceAll('%%MESSAGE%%', escape(denial.error));
    return send(res, denial.status, html, 'text/html; charset=utf-8');
  } catch { return send(res, denial.status, denial.error, 'text/plain; charset=utf-8'); }
}
