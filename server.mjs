#!/usr/bin/env node
// AI Hub — Claude Code + Codex 로컬 공동 작업 대시보드 서버 (의존성 없음, Node 22)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { URL } from 'node:url';
import { ROOT, readJson, readText } from './lib/util.mjs';
import { JobManager, publicJob } from './lib/jobs.mjs';
import { INTERCEPT_CAPABILITIES } from './lib/intercepts.mjs';
import { PERMISSIONS, permissionSetting } from './lib/prompts.mjs';
import { toolStatus, invalidateToolStatus } from './lib/tools.mjs';
import { memoryOverview, memoryFiles, readMemoryFile, hubBoardDir } from './lib/memory.mjs';
import { modelOptions } from './lib/options.mjs';
import { usageStatus } from './lib/usage.mjs';
import { saveUpload, uploadPath, LIMITS, MIME_BY_EXT } from './lib/attachments.mjs';
import { catalog, installToClis, watchCatalog } from './lib/catalog.mjs';
import { openLocal, normalizeLocalPath, isAllowed, resolveRelative } from './lib/opener.mjs';
import { RemoteAccess, LOOPBACK, SECURITY_HEADERS, sendRemoteBlocked } from './lib/remote.mjs';

const configFile = process.env.HUB_CONFIG_FILE ? path.resolve(process.env.HUB_CONFIG_FILE) : path.join(ROOT, 'config.json');
const config = readJson(configFile, null);
if (!config) { console.error('config.json 을 읽지 못했습니다'); process.exit(1); }
if (process.env.HUB_PORT) config.port = Number(process.env.HUB_PORT);
config.hubDir = path.resolve(config.hubDir);
config.defaultCwd = path.resolve(config.defaultCwd);
fs.mkdirSync(config.defaultCwd, { recursive: true });

const jobs = new JobManager(config);
const remote = new RemoteAccess({ port: config.port });
const clients = new Map(); // SSE도 설정 변경·계정 취소 때 다시 검증한다.
jobs.on('event', (ev) => broadcast(ev));

function checkClient(res, req) {
  if (res.destroyed || remote.check(req, { log: false })) {
    clients.delete(res); res.end(); return false;
  }
  return true;
}
function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const [res, req] of clients) { if (checkClient(res, req)) { try { res.write(data); } catch {} } }
}
setInterval(() => { for (const [res, req] of clients) { if (checkClient(res, req)) { try { res.write(': ping\n\n'); } catch {} } } }, 25_000).unref();
setInterval(() => { for (const [res, req] of clients) checkClient(res, req); }, 2000).unref();
// 사용량: 작업이 도는 동안엔 1분 30초, 아니면 3분마다 갱신해서 화면·자동 분배에 반영
let lastUsageAt = 0;
setInterval(async () => {
  const busy = jobs.list().some((j) => ['planning', 'running', 'reporting'].includes(j.status));
  if (!clients.size && !busy) return;
  if (Date.now() - lastUsageAt < (busy ? 90_000 : 180_000)) return;
  lastUsageAt = Date.now();
  try { broadcast({ type: 'usage', usage: await usageStatus(config, { force: busy }) }); } catch {}
}, 15_000).unref();

// 공통 커맨드·서브 에이전트를 Claude Code·Codex 에 설치하고, 원본이 바뀌면 다시 설치
if (process.env.HUB_SKIP_CLI_INSTALL !== '1') {
  try { const r = installToClis(config.hubDir); console.log(`공통 커맨드 ${r.commands}개 · 서브 에이전트 ${r.agents}개 · 스킬 ${r.skills}개 (새로 쓴 파일 ${r.write}개)`); } catch (e) { console.error('커맨드 설치 실패:', e.message); }
  watchCatalog(config.hubDir, (r) => broadcast({ type: 'catalog', install: r }));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const json = (res, body, code = 200) => send(res, code, body);
const fail = (res, e, code) => json(res, { error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}) }, code || e?.status || 400);

async function readBody(req, limit = 2_000_000) {
  let s = ''; for await (const c of req) { s += c; if (s.length > limit) { const e = new Error('본문이 너무 큽니다'); e.status = 413; throw e; } }
  return s ? JSON.parse(s) : {};
}
async function readRaw(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) { const e = new Error(`이미지는 ${limit / 1024 / 1024}MB 이하만 가능합니다`); e.status = 413; throw e; } chunks.push(c); }
  return Buffer.concat(chunks);
}
function projectsList() {
  const index = readText(path.join(config.hubDir, 'memory', 'projects', 'INDEX.md'), '') || '';
  const out = [];
  for (const line of index.split(/\r?\n/)) {
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length >= 4 && /^[A-Za-z]:[\\/]/.test(cells[1])) out.push({ path: path.resolve(cells[1]), slug: cells[2], memories: Number(cells[3]) || 0 });
  }
  const sync = readJson(path.join(config.hubDir, 'sync', 'config.json'), {});
  for (const [p, slug] of Object.entries(sync.memoryAliases || {})) out.push({ path: path.resolve(p), slug, memories: 0 });
  for (const p of sync.extraPaths || []) out.push({ path: path.resolve(p), slug: null, memories: 0 });
  for (const s of jobs.listSessions()) out.push({ path: s.cwd, slug: null, memories: 0 });
  const fixed = [{ path: config.defaultCwd, label: '허브 작업 공간 (기본)' }, { path: ROOT, label: 'AI Hub 자체' }];
  const seen = new Set(); const res = [];
  for (const p of [...fixed, ...out.sort((a, b) => b.memories - a.memories)]) {
    const k = p.path.toLowerCase(); if (seen.has(k) || k === 'c:\\users\\d2jk') continue; seen.add(k);
    if (fs.existsSync(p.path)) res.push({ memories: 0, ...p });
  }
  return res;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    const p = url.pathname;
    const m = (re) => p.match(re);
    const denial = remote.check(req);
    if (denial) return sendRemoteBlocked(res, denial, p, send);
    // ---- 원격 접속: 변경은 게이트에서 로컬 요청에만 허용 ----
    if (p === '/api/remote' && req.method === 'GET') return json(res, await remote.status({ force: url.searchParams.get('force') === '1', viewer: req.hubViewer }));
    if (p === '/api/remote/enable' && req.method === 'POST') { await readBody(req); return json(res, await remote.enable()); }
    if (p === '/api/remote/disable' && req.method === 'POST') { await readBody(req); return json(res, await remote.disable()); }
    // ---- 실시간 이벤트 ----
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', ...SECURITY_HEADERS });
      res.write(`data: ${JSON.stringify({ type: 'hello', sessions: jobs.listSessions(), jobs: jobs.list().map(publicJob) })}\n\n`);
      clients.set(res, req); res.on('close', () => clients.delete(res)); return;
    }
    // ---- 상태·선택지·사용량 ----
    if (p === '/api/prompts' && req.method === 'GET') return json(res, jobs.prompts.list({ status: url.searchParams.get('status') === 'all' ? 'all' : 'pending', jobId: url.searchParams.get('jobId') || undefined }));
    const promptAnswer = p.match(/^\/api\/prompts\/([^/]+)\/answer$/);
    if (promptAnswer && req.method === 'POST') return json(res, jobs.prompts.answer(promptAnswer[1], await readBody(req), req.hubViewer));
    if (p === '/api/status') return json(res, { capabilities: { ...INTERCEPT_CAPABILITIES, prompts: true, toolRecords: true }, tools: await toolStatus(config, { force: url.searchParams.has('force') }), config: { port: config.port, hubDir: config.hubDir, defaultCwd: config.defaultCwd, maxParallel: config.maxParallel, planner: config.planner, boardDir: hubBoardDir(config.hubDir), limits: LIMITS, autoFloor: config.autoFloor || null, configFile, root: ROOT, user: os.userInfo().username } });
    if (p === '/api/options') return json(res, { ...modelOptions(config), permission: { default: permissionSetting(config), values: PERMISSIONS, autoAnswerMinutes: config.prompts?.autoAnswerMinutes ?? 20 } });
    if (p === '/api/usage') return json(res, await usageStatus(config, { force: url.searchParams.has('force') }));
    if (p === '/api/projects') return json(res, projectsList());
    if (p === '/api/catalog') { const c = catalog(config.hubDir); return json(res, { commands: c.commands.map(({ body, file, ...x }) => x), agents: c.agents.map(({ body, file, ...x }) => x), skills: c.skills.map(({ file, ...x }) => x) }); }
    if (p === '/api/open' && req.method === 'POST') {
      // 허브 PC 앞에서 볼 때만: 탐색기로 폴더 열기 / 안전한 파일은 기본 프로그램 / 나머지는 위치만 표시
      if (req.hubViewer?.remote) return fail(res, '원격 접속에서는 허브 PC의 폴더를 열 수 없어요', 403);
      const body = await readBody(req);
      const roots = [config.defaultCwd, ROOT, config.hubDir, ...jobs.listSessions().map((x) => x.cwd), ...projectsList().map((x) => x.path)];
      const target = resolveRelative(body, roots);
      if (body.mode === 'resolve') { // 열지 않고 실제 위치만 알려 준다 (상대 경로 복사용)
        const t = normalizeLocalPath(target);
        if (!t || !fs.existsSync(t) || !isAllowed(t, roots)) return fail(res, '경로를 찾지 못했어요', 404);
        return json(res, { path: t });
      }
      return json(res, openLocal(target, { mode: body.mode === 'reveal' ? 'reveal' : 'auto', roots }));
    }
    if (p === '/api/dir') { const d = path.resolve(url.searchParams.get('path') || ''); return json(res, { path: d, exists: fs.existsSync(d) && fs.statSync(d).isDirectory() }); }
    // ---- 세션 ----
    if (p === '/api/sessions' && req.method === 'GET') return json(res, jobs.listSessions());
    if (p === '/api/sessions' && req.method === 'POST') return json(res, jobs.createSession(await readBody(req)), 201);
    let r;
    if ((r = m(/^\/api\/sessions\/([\w-]+)$/))) {
      if (req.method === 'PATCH') return json(res, jobs.updateSession(r[1], await readBody(req)));
      if (req.method === 'DELETE') return json(res, { removed: jobs.deleteSession(r[1]) });
    }
    if ((r = m(/^\/api\/sessions\/([\w-]+)\/jobs$/))) return json(res, jobs.sessionJobs(r[1]));
    if ((r = m(/^\/api\/sessions\/([\w-]+)\/goal\/(stop|resume)$/)) && req.method === 'POST') return json(res, r[2] === 'stop' ? jobs.stopGoal(r[1]) : await jobs.resumeGoal(r[1]));
    // ---- 작업 ----
    if (p === '/api/jobs' && req.method === 'GET') return json(res, jobs.list().map(publicJob));
    if (p === '/api/jobs' && req.method === 'POST') { const body = await readBody(req); invalidateToolStatus(); return json(res, jobs.create(body), 201); }
    if ((r = m(/^\/api\/jobs\/([\w-]+)$/))) {
      if (req.method === 'DELETE') return json(res, { removed: jobs.remove(r[1]) });
      const j = jobs.get(r[1]); return j ? json(res, publicJob(j)) : fail(res, '작업 없음', 404);
    }
    if ((r = m(/^\/api\/jobs\/([\w-]+)\/intercepts$/))) {
      if (req.method === 'GET') return json(res, jobs.getIntercepts(r[1]));
      if (req.method === 'POST') { const result = jobs.acceptIntercept(r[1], await readBody(req)); return json(res, result, result.duplicate ? 200 : 202); }
    }
    if ((r = m(/^\/api\/jobs\/([\w-]+)\/cancel$/)) && req.method === 'POST') return json(res, jobs.cancel(r[1]));
    if ((r = m(/^\/api\/jobs\/([\w-]+)\/tasks\/([\w-]+)\/retry$/)) && req.method === 'POST') return json(res, jobs.retryTask(r[1], r[2]));
    if ((r = m(/^\/api\/jobs\/([\w-]+)\/log\/([\w-]+)$/))) return json(res, jobs.taskLog(r[1], r[2]));
    // ---- 이미지 첨부 ----
    if (p === '/api/uploads' && req.method === 'POST') {
      const buf = await readRaw(req, LIMITS.maxBytes);
      return json(res, saveUpload(buf, decodeURIComponent(req.headers['x-filename'] || '')), 201);
    }
    if ((r = m(/^\/uploads\/([\w.-]+)$/))) {
      const f = uploadPath(r[1]); if (!f) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(f), MIME_BY_EXT[path.extname(f).slice(1)] || 'application/octet-stream', { 'Cache-Control': 'private, max-age=86400' });
    }
    // ---- 메모리·보드 ----
    if (p === '/api/memory') return json(res, memoryOverview(config.hubDir));
    if ((r = m(/^\/api\/memory\/([^/]+)$/))) return json(res, memoryFiles(config.hubDir, decodeURIComponent(r[1])));
    if ((r = m(/^\/api\/memory\/([^/]+)\/([^/]+)$/))) return json(res, readMemoryFile(config.hubDir, decodeURIComponent(r[1]), decodeURIComponent(r[2])));
    if (p === '/api/board') return json(res, { board: readText(path.join(hubBoardDir(config.hubDir), 'BOARD.md'), '') });
    if (p.startsWith('/api/')) return fail(res, '없는 API', 404);

    // ---- 정적 파일 ----
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return fail(res, e, e?.status || (e instanceof SyntaxError ? 400 : 500));
  }
});

server.listen(config.port, config.host || '127.0.0.1', () => {
  console.log(`AI Hub  http://${config.host || '127.0.0.1'}:${config.port}  (허브: ${config.hubDir})`);
  const settings = remote.readConfig();
  console.log(settings.enabled ? `원격 접속: ${settings.url} (허용 계정 ${settings.logins.length}개)` : '원격 접속: 꺼짐');
  if (!LOOPBACK.has(config.host || '127.0.0.1')) console.warn('허브는 127.0.0.1에만 바인딩해야 합니다. 비루프백 요청은 원격 게이트에서 차단합니다');
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `포트 ${config.port} 가 이미 사용 중입니다 (이미 실행 중인지 확인)` : e); process.exit(1); });
process.on('SIGINT', () => process.exit(0));
