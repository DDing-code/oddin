// 로컬 개발 서버 발견·포트 조회·HTTP 프록시와 도구 API 연결.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TerminalManager } from './terminal.mjs';
import { serveFile, listFiles } from './files.mjs';

const run = promisify(execFile);
const error = (status, message) => Object.assign(new Error(message), { status });
const SENSITIVE = new Set([135, 139, 445, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 5432, 5900, 5985, 5986, 6379, 7700, 9200, 9222, 9229, 11211, 27017]);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function safeHeaders(headers) {
  const excluded = new Set([...HOP, ...String(headers.connection || '').split(',').map((s) => s.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key) && !/^(tailscale-|x-forwarded-|cookie$|set-cookie$|authorization$)/i.test(key)));
}

export async function listeningPorts() {
  if (process.platform !== 'win32') throw error(501, '로컬 포트 조회는 Windows에서 지원해요');
  const { stdout } = await run('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).catch(() => { throw error(500, '로컬 포트 목록을 읽지 못했어요'); });
  const ports = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (!match) continue;
    const port = Number(match[2]), row = ports.get(port) || { port, addresses: [], pids: [] };
    if (!row.addresses.includes(match[1])) row.addresses.push(match[1]);
    if (!row.pids.includes(Number(match[3]))) row.pids.push(Number(match[3])); ports.set(port, row);
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
}

export class PreviewManager {
  constructor({ hubPort, getSession, queryPorts = listeningPorts } = {}) { this.hubPort = hubPort; this.getSession = getSession; this.queryPorts = queryPorts; this.sessions = new Map(); this.tails = new Map(); }
  checkPort(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === this.hubPort || SENSITIVE.has(port)) throw error(403, '이 포트는 미리보기로 열 수 없어요');
    return port;
  }
  session(sessionId) { if (!this.getSession?.(sessionId)) throw error(404, '세션을 찾지 못했어요'); return sessionId; }
  record(sessionId, port, source) {
    this.checkPort(port); let entries = this.sessions.get(sessionId); if (!entries) this.sessions.set(sessionId, entries = new Map());
    const old = entries.get(port); entries.set(port, { port, source: old?.source === 'selected' ? 'selected' : source, url: `http://127.0.0.1:${port}/`, proxyUrl: `/preview/${port}/`, detectedAt: new Date().toISOString() });
    if (entries.size > 64) entries.delete(entries.keys().next().value);
    return entries.get(port);
  }
  detect(sessionId, chunk) {
    const text = (this.tails.get(sessionId) || '') + chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); this.tails.set(sessionId, text.slice(-512));
    for (const match of text.matchAll(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})(?=[/\s\x1b]|$)/gi)) {
      try { this.record(sessionId, Number(match[1]), 'detected'); } catch { /* 민감한 포트는 발견 목록에도 넣지 않는다. */ }
    }
  }
  async targets(sessionId) {
    this.session(sessionId); const listening = await this.queryPorts();
    const targets = [...(this.sessions.get(sessionId)?.values() || [])].map((entry) => ({ ...entry, listening: listening.some((row) => row.port === entry.port) }));
    return { sessionId, targets, ports: listening.map((row) => { let selectable = true; try { this.checkPort(row.port); } catch { selectable = false; } return { ...row, selectable }; }), websocket: false };
  }
  select(sessionId, port) { this.session(sessionId); if (typeof port !== 'number') throw error(400, '포트 번호를 숫자로 보내 주세요'); return this.record(sessionId, port, 'selected'); }
  allowed(port) { this.checkPort(port); return [...this.sessions].some(([id, entries]) => this.getSession?.(id) && entries.has(port)); }
  proxy(req, res, url) {
    const match = /^\/preview\/(\d+)(\/.*)?$/.exec(url.pathname); if (!match) throw error(404, '미리보기 주소를 찾지 못했어요');
    const port = Number(match[1]); if (!this.allowed(port)) throw error(403, '개발 서버를 발견하거나 포트를 먼저 골라 주세요');
    if (req.headers.upgrade) throw error(501, '웹소켓 미리보기는 지원하지 않아요');
    if (!match[2]) { res.writeHead(308, { Location: `/preview/${port}/${url.search}`, 'X-Content-Type-Options': 'nosniff' }); res.end(); return; }
    const headers = safeHeaders(req.headers); headers.host = `127.0.0.1:${port}`; delete headers.origin; delete headers.referer;
    const upstream = http.request({ hostname: '127.0.0.1', port, path: match[2] + url.search, method: req.method, headers }, (response) => {
      const outgoing = safeHeaders(response.headers);
      // 개발 서버 HTML을 허브 API에 접근할 수 없는 샌드박스 출처로 격리한다.
      outgoing['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-modals allow-downloads';
      outgoing['x-content-type-options'] = 'nosniff'; outgoing['cache-control'] = 'no-store';
      const location = response.headers.location;
      if (location) {
        try {
          const redirect = new URL(location, `http://127.0.0.1:${port}${match[2]}`);
          if (redirect.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) && Number(redirect.port || 80) === port) outgoing.location = `/preview/${port}${redirect.pathname}${redirect.search}${redirect.hash}`;
          else delete outgoing.location;
        } catch { delete outgoing.location; }
      }
      res.writeHead(response.statusCode, outgoing); response.on('error', () => res.destroy()); response.pipe(res);
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('미리보기 응답 시간이 초과됐어요')));
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify({ error: '개발 서버에 연결하지 못했어요' })); } else res.destroy(); });
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy()); req.pipe(upstream);
  }
}

export class HubTools {
  constructor({ config, getSession, getRoots, emit }) {
    this.getRoots = getRoots;
    this.preview = new PreviewManager({ hubPort: config.port, getSession });
    this.terminals = new TerminalManager({ maxTerminals: config.terminal?.maxTerminals, getSession, onOutput: (id, chunk) => this.preview.detect(id, chunk) });
    this.terminals.on('event', emit);
  }
  async handle(req, res, url, { json, readBody }) {
    const p = url.pathname, params = Object.fromEntries(url.searchParams); let r;
    if (p === '/api/terminals') {
      if (req.method === 'GET') json(res, this.terminals.list(params.sessionId));
      else if (req.method === 'POST') json(res, await this.terminals.create(await readBody(req)), 201);
      else throw error(405, '지원하지 않는 요청 방식이에요');
    } else if ((r = /^\/api\/terminals\/([\w-]+)(?:\/(input|interrupt|buffer))?$/.exec(p))) {
      if (!r[2] && req.method === 'DELETE') json(res, await this.terminals.close(r[1]));
      else if (r[2] === 'input' && req.method === 'POST') json(res, this.terminals.input(r[1], (await readBody(req)).text));
      else if (r[2] === 'interrupt' && req.method === 'POST') json(res, await this.terminals.interrupt(r[1]));
      else if (r[2] === 'buffer' && req.method === 'GET') json(res, this.terminals.buffer(r[1]));
      else throw error(405, '지원하지 않는 요청 방식이에요');
    } else if (p === '/api/file' && ['GET', 'HEAD'].includes(req.method)) serveFile(req, res, params, this.getRoots(), json);
    else if (p === '/api/files/list' && req.method === 'GET') json(res, await listFiles(params, this.getRoots()));
    else if (p === '/api/preview/targets') {
      if (req.method === 'GET') json(res, await this.preview.targets(params.sessionId));
      else if (req.method === 'POST') { const body = await readBody(req); json(res, this.preview.select(body.sessionId, body.port), 201); }
      else throw error(405, '지원하지 않는 요청 방식이에요');
    } else if (p.startsWith('/preview/')) this.preview.proxy(req, res, url);
    else return false;
    return true;
  }
}
