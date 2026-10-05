#!/usr/bin/env node
// AI Hub — Claude Code + Codex 로컬 공동 작업 대시보드 서버 (의존성 없음, Node 22)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, readJson, readText } from './lib/util.mjs';
import { JobManager, publicJob } from './lib/jobs.mjs';
import { INTERCEPT_CAPABILITIES } from './lib/intercepts.mjs';
import { sessionToolsRoute, SESSION_CAPABILITIES } from './lib/session-tools.mjs';
import { PERMISSIONS, permissionSetting } from './lib/prompts.mjs';
import { toolStatus, invalidateToolStatus } from './lib/tools.mjs';
import { memoryOverview, memoryFiles, readMemoryFile, hubBoardDir } from './lib/memory.mjs';
import { modelOptions } from './lib/options.mjs';
import { usageStatus } from './lib/usage.mjs';
import { saveUpload, uploadPath, LIMITS, MIME_BY_EXT } from './lib/attachments.mjs';
import { catalog, installToClis, watchCatalog } from './lib/catalog.mjs';
import { openLocal, normalizeLocalPath, isAllowed, resolveRelative } from './lib/opener.mjs';
import { RemoteAccess, LOOPBACK, SECURITY_HEADERS, sendRemoteBlocked } from './lib/remote.mjs';
import { checkpointRoute } from './lib/checkpoints.mjs';
import { HubTools } from './lib/preview.mjs';
import { knownProjects } from './lib/projects.mjs';
import { Peers } from './lib/peers.mjs';
import { SharedSync, scanShared, readShared, writeShared } from './lib/shared-sync.mjs';
import { setupStatus, installSharedHooks, readLocalInstructions, writeLocalInstructions } from './lib/shared-setup.mjs';
import { listMemory, moveMemory, createBlock, renameBlock, setBlockRoot, deleteBlock, readBlockMemory } from './lib/memory-blocks.mjs';
import { hubCommit, runningCommit, checkUpdate, applyUpdate } from './lib/hub-update.mjs';
import { SharedFolders } from './lib/shared-folders.mjs';
import { DriveFolders } from './lib/drive-folders.mjs';
import { DriveHub } from './lib/drive-hub.mjs';
import { Federation } from './lib/federation.mjs';
import { FileAccess, fileRoots } from './lib/file-access.mjs';
import { AdobeBridge, appKey } from './lib/adobe-bridge.mjs';
import { Profile } from './lib/profile.mjs';
import { SessionGroups, listDirs } from './lib/session-groups.mjs';
import { adobeInstallStatus, installAdobePlugins, refreshAdobePlugins, installedHost } from './lib/adobe-install.mjs';

const configFile = process.env.HUB_CONFIG_FILE ? path.resolve(process.env.HUB_CONFIG_FILE) : path.join(ROOT, 'config.json');
const config = readJson(configFile, null);
if (!config) { console.error('config.json 을 읽지 못했습니다'); process.exit(1); }
if (process.env.HUB_PORT) config.port = Number(process.env.HUB_PORT);
// 경로 설정은 다른 PC에서도 그대로 쓰도록 `~`(사용자 폴더)와 허브 폴더 기준 상대 경로를 받는다.
const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());
config.hubDir = path.resolve(ROOT, expandHome(config.hubDir || '~/.ai-shared'));
config.defaultCwd = path.resolve(ROOT, expandHome(config.defaultCwd || '../oddin-workspace'));
fs.mkdirSync(config.defaultCwd, { recursive: true });

const jobs = new JobManager(config);
const remote = new RemoteAccess({ port: config.port });
const clients = new Map(); // SSE도 설정 변경·계정 취소 때 다시 검증한다.
jobs.on('event', (ev) => broadcast(ev));
// 파일 열기·보기 범위(lib/file-access.mjs): 허브가 아는 폴더 + 작업이 실제로 실행된 폴더 전부 + 드라이브 ODDIN 폴더.
// 입력창 아래 "권한" 메뉴에서 "모든 폴더"를 켜면 이 PC의 모든 드라이브. 열기·허브 안 보기·/view/·폴더 목록이 함께 쓴다
const fileAccess = new FileAccess({ file: path.join(DATA_DIR, 'file-access.json') });
// 프리미어·애프터이펙트 안 ODDIN 플러그인과의 연결(lib/adobe-bridge.mjs, 플러그인 소스 adobe/)
const adobe = new AdobeBridge({ emit: (ev) => broadcast(ev), installed: installedHost });
// 계정 칸 이름·사진(lib/profile.mjs)
const profile = new Profile({ dir: DATA_DIR });
// 세션 묶음(사이드바에서 이름 붙인 묶음, lib/session-groups.mjs)
const groups = new SessionGroups({ file: path.join(DATA_DIR, 'session-groups.json') });
jobs.groups = groups;
const groupsChanged = () => broadcast({ type: 'session-groups', groups: groups.list() });
const openRoots = () => fileRoots([config.defaultCwd, ROOT, config.hubDir, ...jobs.workFolders(), ...projectsList().map((p) => p.path), hubInfo()?.root], fileAccess.read());
const tools = new HubTools({ config, getSession: (id) => jobs.listSessions().find((s) => s.id === id), getRoots: openRoots, emit: broadcast });

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

// 연결된 PC(다른 ODDIN 허브)와 공유 기억(~/.ai-shared) 동기화 — 집·회사 PC 두 대를 한 대시보드로 (docs/peers.md)
const peers = new Peers({ version: readJson(path.join(ROOT, 'package.json'), {}).version || '', commit: () => runningCommit(ROOT) });
runningCommit(ROOT); // 켜질 때의 버전을 기억한다(업데이트 뒤 재시작 전과 구분)
// 구글 드라이브 ODDIN 폴더(공유 기억 사본·자산): 있으면 공유 기억을 드라이브로 맞추고 공유 폴더를 드라이브 자산으로 올린다 (lib/drive-hub.mjs)
const driveHub = new DriveHub({ driveRoot: process.env.HUB_DRIVE_ROOT || null });
// 시험 서버(HUB_SKIP_CLI_INSTALL=1)는 가짜 드라이브 위치(HUB_DRIVE_ROOT)를 주지 않으면 진짜 구글 드라이브를 건드리지 않는다
const driveHubOff = () => config.driveHub?.enabled === false || (process.env.HUB_SKIP_CLI_INSTALL === '1' && !process.env.HUB_DRIVE_ROOT);
let hubCache = { at: 0, info: null };
const hubInfo = (fresh = false) => {
  if (driveHubOff()) return null;
  if (fresh || Date.now() - hubCache.at > 10_000) hubCache = { at: Date.now(), info: driveHub.info() };
  return hubCache.info;
};
const sharedCfg = config.sharedSync || {};
const shared = sharedCfg.enabled === false ? null : new SharedSync({ root: config.hubDir, peers, intervalMs: (sharedCfg.intervalSeconds ?? 60) * 1000, watch: sharedCfg.watch !== false, hub: hubInfo, driveIntervalMs: (sharedCfg.driveIntervalSeconds ?? 20) * 1000 });
shared?.on('status', (status) => broadcast({ type: 'shared-sync', status }));
const peersView = () => ({ self: peers.self(), peers: peers.list(), sync: shared?.status() || null });
// 공유 폴더(읽기용 사본): 이 PC가 공유하는 폴더를 연결된 PC가 ~/.ai-shared/peer-files 로 받아 간다 (lib/shared-folders.mjs)
const folders = new SharedFolders({ hubDir: config.hubDir, peers, intervalMs: (config.sharedFolders?.intervalSeconds ?? 120) * 1000, hub: hubInfo });
folders.on('status', (s) => broadcast({ type: 'shared-folders', ...s }));
setTimeout(() => { if (peers.list().length || hubInfo()) folders.pullAll().catch(() => {}); }, 8000).unref();
// 드라이브 작업 폴더(구글 드라이브로 두 PC가 함께 쓰는 폴더): 다른 PC 경로 찾기·같은 메모리로 잇기·작업 순서 (lib/drive-folders.mjs)
const drive = new DriveFolders({ hubDir: config.hubDir, self: () => peers.self(), projects: () => projectsList().map((x) => x.path) });
const LIVE_JOB = new Set(['planning', 'running', 'reporting']);
const driveBusy = () => { const out = {}; for (const j of jobs.list()) if (LIVE_JOB.has(j.status)) { const f = drive.folderOf(j.cwd); if (f) out[f.id] = { jobId: j.id, title: j.title || '', since: j.createdAt, machine: peers.self().name }; } return out; };
const peerBusy = async () => {
  const out = {};
  await Promise.all(peers.list().map(async (x) => { try { Object.assign(out, await peers.call(x, '/api/drive-folders/busy', { timeoutMs: 5000 })); } catch {} }));
  return out;
};
jobs.driveInfo = (job) => drive.folderOf(job.cwd);
// 기억 정리가 공유를 허용한 세션의 결과물을 드라이브 ODDIN 자산으로 올릴 때 (lib/oddin-assets.mjs)
jobs.driveHub = () => hubInfo();
// 실행 PC 고르기·다른 PC 작업 함께 보기: 연결된 PC의 세션·작업을 이 화면에 비추고, 그 세션 요청은 그 PC로 (lib/federation.mjs)
const fed = config.federation?.enabled === false ? null : new Federation({ peers, broadcast, drive, hubInfo, isDefaultDir: (p) => jobs.isDefaultDir(p), uploadPath });
jobs.machineName = () => peers.self().name;
jobs.driveGuard = async (job, task) => {
  const f = drive.folderOf(job.cwd); if (!f) return;
  const wait = config.driveFolders?.waitMinutes ?? 30, until = Date.now() + wait * 60_000; let told = false;
  while (Date.now() < until && job.status !== 'cancelled') {
    const other = (await peerBusy())[f.id];
    // 먼저 시작한 쪽이 먼저 한다(같은 시각이면 PC 이름순) — 두 PC가 서로를 기다리며 멈추지 않게
    if (!other || other.since > job.createdAt || (other.since === job.createdAt && other.machine >= peers.self().name)) break;
    if (!told) { told = true; job.notes = job.notes || []; job.notes.push(`${other.machine}에서 드라이브 작업 폴더 "${f.name}"로 작업 중이라 끝날 때까지 기다려요(같은 파일 동시 수정 방지)`); jobs.emitJob(job); }
    await new Promise((r) => setTimeout(r, 20_000));
  }
  if (told) { if (Date.now() >= until) job.notes.push(`기다리는 시간(${wait}분)이 지나 그대로 시작해요`); jobs.emitJob(job); }
};
const driveResolve = () => { try { const r = drive.resolve(); if (r.found.length) broadcast({ type: 'drive-folders' }); return r; } catch (e) { return { error: e.message }; } };
setTimeout(driveResolve, 5000).unref();
setInterval(driveResolve, 120_000).unref();
const checkPeers = async () => {
  if (!peers.list().length) return;
  await Promise.all(peers.list().map((x) => peers.check(x)));
  broadcast({ type: 'peers', ...peersView() });
};
setTimeout(checkPeers, 2000).unref(); // 켜자마자 한 번 (안 그러면 1분 동안 상태 모름)
setInterval(checkPeers, 60_000).unref();

// 공통 커맨드·서브 에이전트를 Claude Code·Codex 에 설치하고, 원본이 바뀌면 다시 설치
if (process.env.HUB_SKIP_CLI_INSTALL !== '1') {
  try { const r = installToClis(config.hubDir); console.log(`공통 커맨드 ${r.commands}개 · 서브 에이전트 ${r.agents}개 · 스킬 ${r.skills}개 (새로 쓴 파일 ${r.write}개)`); } catch (e) { console.error('커맨드 설치 실패:', e.message); }
  watchCatalog(config.hubDir, (r) => broadcast({ type: 'catalog', install: r }));
}

// 화면 파일(html·js·css) 버전 표시. 열린 화면이 예전 파일을 쥐고 있는지 비교하는 데 쓴다(public/ui-refresh.js)
let uiVer = { at: 0, v: '' };
function uiVersion() {
  if (Date.now() - uiVer.at < 2000) return uiVer.v;
  const dir = path.join(ROOT, 'public');
  const sig = fs.readdirSync(dir).filter((n) => /[.](html|js|css)$/.test(n)).sort().map((n) => { const s = fs.statSync(path.join(dir, n)); return `${n}:${s.size}:${Math.round(s.mtimeMs)}`; }).join('|');
  uiVer = { at: Date.now(), v: createHash('sha1').update(sig).digest('hex').slice(0, 12) };
  return uiVer.v;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const json = (res, body, code = 200) => send(res, code, body);
const fail = (res, e, code) => json(res, { error: String(e?.message || e), ...(e?.code ? { code: e.code } : {}), ...(e?.files ? { files: e.files } : {}) }, code || e?.status || 400);

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
  const list = knownProjects(config, jobs.listSessions()), h = hubInfo();
  // 드라이브 ODDIN 자산(두 PC가 함께 쓰는 파일)을 기본 폴더들 바로 뒤에
  if (h && fs.existsSync(h.assets) && !list.some((x) => x.path.toLowerCase() === h.assets.toLowerCase())) list.splice(Math.min(2, list.length), 0, { path: h.assets, label: '드라이브 · ODDIN 자산', drive: true, memories: 0 });
  return list;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${config.port}`);
    const p = url.pathname;
    const m = (re) => p.match(re);
    const denial = remote.check(req);
    if (denial) return sendRemoteBlocked(res, denial, p, send);
    // 다른 PC 세션·작업(rm-<PC>- id)에 대한 요청은 그 PC로 넘긴다
    if (fed && p.startsWith('/api/') && fed.remoteOf(p + url.search)) { const raw = ['GET', 'HEAD'].includes(req.method) ? null : await readRaw(req, 8_000_000); return await fed.proxy(req, res, { pathname: p, search: url.search, raw }); }
    const checkpoint = await checkpointRoute({ pathname: p, method: req.method, query: url.searchParams, readBody: () => readBody(req), manager: jobs });
    if (checkpoint) return json(res, checkpoint.body);
    if (await tools.handle(req, res, url, { json, readBody })) return;
    // ---- 원격 접속: 변경은 게이트에서 로컬 요청에만 허용 ----
    if (p === '/api/remote' && req.method === 'GET') return json(res, await remote.status({ force: url.searchParams.get('force') === '1', viewer: req.hubViewer }));
    if (p === '/api/remote/enable' && req.method === 'POST') { await readBody(req); return json(res, await remote.enable()); }
    if (p === '/api/remote/disable' && req.method === 'POST') { await readBody(req); return json(res, await remote.disable()); }
    // ---- 연결된 PC · 공유 기억 동기화 ----
    if (p === '/api/peers/whoami' && req.method === 'GET') return json(res, peers.self());
    if (p === '/api/peers' && req.method === 'GET') return json(res, peersView());
    if (p === '/api/peers' && req.method === 'POST') {
      const peer = await peers.add(await readBody(req));
      shared?.syncAll('연결').catch(() => {}); folders.pullAll().catch(() => {}); broadcast({ type: 'peers', ...peersView() });
      return json(res, peer, 201);
    }
    if (p === '/api/peers/self' && req.method === 'POST') { const self = peers.setSelfName((await readBody(req)).name); broadcast({ type: 'peers', ...peersView() }); return json(res, self); }
    const peerRoute = p.match(/^\/api\/peers\/([\w-]+)$/);
    if (peerRoute && req.method === 'DELETE') { const r = peers.remove(peerRoute[1]); broadcast({ type: 'peers', ...peersView() }); return json(res, r); }
    if (peerRoute && req.method === 'POST') { const r = peers.rename(peerRoute[1], (await readBody(req)).name); broadcast({ type: 'peers', ...peersView() }); return json(res, r); }
    // 업데이트: 이 허브(/api/hub/…)와 연결된 PC(/api/peers/:id/update — 그 PC 허브에 대신 요청)
    if (p === '/api/hub/version' && req.method === 'GET') return json(res, url.searchParams.get('check') === '1' ? await checkUpdate(ROOT) : runningCommit(ROOT));
    if (p === '/api/hub/update' && req.method === 'POST') { await readBody(req); const r = await applyUpdate(ROOT); broadcast({ type: 'peers', ...peersView() }); return json(res, r); }
    // 지금 바꾸기: 진행 중인 작업을 멈춰 저장하고(새 버전에서 같은 대화로 이어 함) 이 허브만 바로 재시작한다
    if (p === '/api/hub/restart' && req.method === 'POST') {
      await readBody(req);
      if (process.env.HUB_SKIP_CLI_INSTALL === '1' || process.env.HUB_DATA_DIR || process.env.HUB_PORT) return fail(res, '시험 서버는 재시작하지 않아요', 409);
      const stopped = jobs.prepareRestart();
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'restart-hub.mjs'), '--detach', '--now', '--force'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {}); child.unref();
      broadcast({ type: 'hub-restarting', jobs: stopped.length });
      return json(res, { ok: true, stopped });
    }
    const peerUpdate = p.match(/^\/api\/peers\/([\w-]+)\/(update|version|restart)$/);
    if (peerUpdate) {
      const peer = peers.get(peerUpdate[1]); if (!peer) return fail(res, '연결된 PC를 찾지 못했어요', 404);
      if (peerUpdate[2] === 'version' && req.method === 'GET') return json(res, await peers.call(peer, '/api/hub/version?check=1', { timeoutMs: 90_000 }));
      if (peerUpdate[2] === 'restart' && req.method === 'POST') { await readBody(req); return json(res, await peers.call(peer, '/api/hub/restart', { method: 'POST', body: {}, timeoutMs: 30_000 })); }
      if (peerUpdate[2] === 'update' && req.method === 'POST') { await readBody(req); const r = await peers.call(peer, '/api/hub/update', { method: 'POST', body: {}, timeoutMs: 180_000 }); peers.check(peer).then(() => broadcast({ type: 'peers', ...peersView() })); return json(res, r); }
    }
    // 드라이브 작업 폴더
    if (p === '/api/drive-folders' && req.method === 'GET') { const [busyPeers] = await Promise.all([peerBusy()]); return json(res, { drive: drive.drive(), folders: drive.list({ ...busyPeers, ...driveBusy() }), here: peers.self().name }); }
    if (p === '/api/drive-folders/busy' && req.method === 'GET') return json(res, driveBusy());
    if (p === '/api/drive-folders/resolve' && req.method === 'POST') { await readBody(req); return json(res, driveResolve()); }
    if (p === '/api/drive-folders' && req.method === 'POST') {
      const f = drive.add(await readBody(req)); broadcast({ type: 'drive-folders' });
      // 목록이 연결된 PC에 넘어간 뒤 그쪽에서 자기 경로를 찾게 한다
      (async () => { try { await shared?.syncAll('드라이브 작업 폴더'); for (const x of peers.list()) await peers.call(x, '/api/drive-folders/resolve', { method: 'POST', body: {} }).catch(() => {}); broadcast({ type: 'drive-folders' }); } catch {} })();
      return json(res, f, 201);
    }
    {
      const df = p.match(/^\/api\/drive-folders\/([\w-]+)(\/path)?$/);
      if (df && df[2] && req.method === 'POST') { const r = drive.setPath(df[1], (await readBody(req)).path); broadcast({ type: 'drive-folders' }); return json(res, r); }
      if (df && !df[2] && req.method === 'DELETE') { const r = drive.remove(df[1]); broadcast({ type: 'drive-folders' }); return json(res, r); }
    }
    // 공유 폴더(읽기용 사본)
    if (p === '/api/shared-folders' && req.method === 'GET') return json(res, { own: folders.own(), mirrors: folders.mirrors(), root: folders.mirrorRoot });
    if (p === '/api/shared-folders/offer' && req.method === 'GET') return json(res, folders.offer());
    if (p === '/api/shared-folders/pull' && req.method === 'POST') { await readBody(req); return json(res, { results: await folders.pullAll() }); }
    if (p === '/api/shared-folders' && req.method === 'POST') { const f = folders.add(await readBody(req)); broadcast({ type: 'shared-folders', own: folders.own(), mirrors: folders.mirrors() }); return json(res, f, 201); }
    {
      const sf = p.match(/^\/api\/shared-folders\/([\w-]+)(?:\/(manifest|file))?$/);
      if (sf && !sf[2] && req.method === 'POST') { const r = folders.setMode(sf[1], (await readBody(req)).mode); broadcast({ type: 'shared-folders', own: folders.own(), mirrors: folders.mirrors() }); return json(res, r); }
      if (sf && !sf[2] && req.method === 'DELETE') { const r = folders.remove(sf[1]); broadcast({ type: 'shared-folders', own: folders.own(), mirrors: folders.mirrors() }); return json(res, r); }
      if (sf && sf[2] === 'manifest' && req.method === 'GET') return json(res, folders.manifest(sf[1]));
      if (sf && sf[2] === 'file' && req.method === 'GET') return json(res, folders.read(sf[1], url.searchParams.get('rel')));
    }
    if (p.startsWith('/api/shared/') && !shared) return fail(res, '공유 기억 동기화가 꺼져 있어요 (config.sharedSync.enabled)', 503);
    if (p === '/api/shared/manifest' && req.method === 'GET') return json(res, { machine: peers.self().name, driveHub: shared?.driveHubId() || null, files: scanShared(config.hubDir) });
    // 구글 드라이브 ODDIN 폴더
    if (p === '/api/drive-hub' && req.method === 'GET') return json(res, driveHubOff() ? { enabled: false, drive: null, hub: null, sync: null, assets: { categories: [], total: 0 } } : { drive: driveHub.drive(), hub: hubInfo(true), sync: shared?.status().drive || null, assets: driveHub.assets(), enabled: true });
    if (p === '/api/drive-hub' && req.method === 'POST') {
      await readBody(req);
      if (driveHubOff()) return json(res, { error: '설정에서 드라이브 ODDIN 폴더를 꺼 두었어요(config.driveHub.enabled)' }, 409);
      const h = driveHub.create(peers.self().id); hubInfo(true);
      broadcast({ type: 'drive-hub' });
      (async () => { try { await shared?.syncAll('드라이브 ODDIN 폴더'); await folders.pullAll(); } catch {} broadcast({ type: 'drive-hub' }); })();
      return json(res, h, h.created ? 201 : 200);
    }
    if (p === '/api/shared/file' && req.method === 'GET') return json(res, readShared(config.hubDir, url.searchParams.get('rel')));
    if (p === '/api/shared/file' && req.method === 'POST') {
      let from = 'peer'; try { from = decodeURIComponent(String(req.headers['x-oddin-machine'] || 'peer')).slice(0, 30); } catch {}
      return json(res, writeShared(config.hubDir, await readBody(req, 8_000_000), from));
    }
    if (p === '/api/shared/sync' && req.method === 'POST') { await readBody(req); return json(res, { results: await shared.syncAll('직접') }); }
    if (p === '/api/shared/status' && req.method === 'GET') return json(res, shared.status());
    if (p === '/api/shared/setup' && req.method === 'GET') return json(res, setupStatus(config.hubDir));
    if (p === '/api/shared/setup' && req.method === 'POST') { await readBody(req); return json(res, installSharedHooks(config.hubDir)); }
    // 이 PC 전용 지침(~/.ai-shared/AGENTS.local.md, 다른 PC와 맞추지 않음)
    if (p === '/api/shared/local' && req.method === 'GET') return json(res, readLocalInstructions(config.hubDir));
    if (p === '/api/shared/local' && req.method === 'POST') { const b = await readBody(req, 400_000); return json(res, writeLocalInstructions(config.hubDir, b.content)); }
    // ---- 실시간 이벤트 ----
    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', ...SECURITY_HEADERS });
      res.write(`data: ${JSON.stringify({ type: 'hello', sessions: [...jobs.listSessions(), ...(fed?.sessions() || [])], jobs: [...jobs.list().map(publicJob), ...(fed?.jobs() || [])], groups: groups.list() })}\n\n`);
      clients.set(res, req); res.on('close', () => clients.delete(res)); return;
    }
    // ---- 상태·선택지·사용량 ----
    if (p === '/api/prompts' && req.method === 'GET') return json(res, jobs.prompts.list({ status: url.searchParams.get('status') === 'all' ? 'all' : 'pending', jobId: url.searchParams.get('jobId') || undefined }));
    const promptAnswer = p.match(/^\/api\/prompts\/([^/]+)\/answer$/);
    if (promptAnswer && req.method === 'POST') return json(res, jobs.prompts.answer(promptAnswer[1], await readBody(req), req.hubViewer));
    if (p === '/api/ui-version') return json(res, { v: uiVersion() });
    if (p === '/api/status') return json(res, { capabilities: { ...INTERCEPT_CAPABILITIES, ...SESSION_CAPABILITIES, prompts: true, toolRecords: true, memoryCuration: true }, tools: await toolStatus(config, { force: url.searchParams.has('force') }), config: { port: config.port, hubDir: config.hubDir, defaultCwd: config.defaultCwd, maxParallel: config.maxParallel, planner: config.planner, boardDir: hubBoardDir(config.hubDir), limits: LIMITS, autoFloor: config.autoFloor || null, configFile, root: ROOT, user: os.userInfo().username, profile: profile.read() } });
    if (p === '/api/options') return json(res, { ...modelOptions(config), permission: { default: permissionSetting(config), values: PERMISSIONS, autoAnswerMinutes: config.prompts?.autoAnswerMinutes ?? 20 }, fileAccess: fileAccess.read() });
    // 세션 묶음: 목록·만들기·이름 바꾸기·순서·지우기(세션은 그대로, 묶음에서만 빠짐)
    if (p === '/api/session-groups' && req.method === 'GET') return json(res, groups.list());
    if (p === '/api/session-groups' && req.method === 'POST') { const g = groups.create((await readBody(req)).name); groupsChanged(); return json(res, g, 201); }
    if (p === '/api/session-groups/order' && req.method === 'POST') { const v = groups.reorder((await readBody(req)).ids); groupsChanged(); return json(res, v); }
    { const gm = p.match(/^\/api\/session-groups\/(g-[a-f0-9]+)$/);
      if (gm && req.method === 'PATCH') { const g = groups.rename(gm[1], (await readBody(req)).name); groupsChanged(); return json(res, g); }
      if (gm && req.method === 'DELETE') { groups.remove(gm[1]); for (const x of jobs.listSessions({ archived: false }).concat(jobs.listSessions({ archived: true }))) if (x.group === gm[1]) jobs.updateSession(x.id, { group: null }); groupsChanged(); return json(res, { removed: true }); } }
    // 작업 폴더 고르기 창: 하위 폴더 이름만 (빈 경로면 드라이브 목록)
    if (p === '/api/dirs' && req.method === 'GET') return json(res, listDirs(url.searchParams.get('path') || ''));
    // 프로필: 이름 { name } · 사진(본문이 그림 그대로, Content-Type 으로 종류)
    if (p === '/api/profile' && req.method === 'GET') return json(res, profile.read());
    if (p === '/api/profile' && req.method === 'POST') { const v = profile.setName((await readBody(req)).name); broadcast({ type: 'profile', profile: v }); return json(res, v); }
    if (p === '/api/profile/avatar' && req.method === 'GET') return profile.serveAvatar(res);
    if (p === '/api/profile/avatar' && req.method === 'POST') { const v = profile.setAvatar(await readRaw(req, 3 * 1024 * 1024), req.headers['content-type']); broadcast({ type: 'profile', profile: v }); return json(res, v); }
    if (p === '/api/profile/avatar' && req.method === 'DELETE') { const v = profile.clearAvatar(); broadcast({ type: 'profile', profile: v }); return json(res, v); }
    // 어도비 플러그인 연결: 플러그인이 붙어 명령을 기다리고(hello·next·result), 작업자는 run 으로 ExtendScript 실행
    if (p === '/api/adobe/status' && req.method === 'GET') return json(res, { ...adobe.status(), install: adobeInstallStatus(ROOT) });
    if (p === '/api/adobe/hello' && req.method === 'POST') return json(res, adobe.hello(await readBody(req)));
    if (p === '/api/adobe/next' && req.method === 'GET') return adobe.next(Object.fromEntries(url.searchParams), res, json);
    if (p === '/api/adobe/result' && req.method === 'POST') return json(res, adobe.result(await readBody(req)));
    // 앱 안 스크립트는 PC 명령까지 실행할 수 있어 이 PC에서 온 요청만 받는다(원격 접속 거절). 설치는 다른 PC에서 대신 눌러도 된다
    if (p === '/api/adobe/run' && req.hubViewer?.remote) return fail(res, '어도비 명령은 그 PC에서만 보낼 수 있어요', 403);
    // 연결 시험: 정해진 읽기 명령(열린 프로젝트 알아보기)만 실행하므로 다른 PC에서도 부를 수 있다
    if (p === '/api/adobe/check' && req.method === 'GET') { const app = appKey(url.searchParams.get('app') || 'premiere'); const script = url.searchParams.get('op') === 'status' ? (app === 'aftereffects' ? 'return ODDIN.ae.status();' : 'return ODDIN.pr.status();') : 'return ODDIN.info();'; return json(res, await adobe.run({ app: app || 'premiere', script, timeoutSeconds: 20 })); }
    if (p === '/api/adobe/run' && req.method === 'POST') return json(res, await adobe.run(await readBody(req)));
    if (p === '/api/adobe/install' && req.method === 'POST') { await readBody(req); const r = installAdobePlugins(ROOT, { port: config.port }); broadcast({ type: 'adobe', ...adobe.status(), install: adobeInstallStatus(ROOT) }); return json(res, r); }
    // 파일 열기·보기 범위: 허브가 아는 폴더만(기본) / 모든 폴더
    if (p === '/api/file-access' && req.method === 'GET') return json(res, fileAccess.read());
    if (p === '/api/file-access' && req.method === 'POST') { const v = fileAccess.save({ allowAll: (await readBody(req)).allowAll === true }); broadcast({ type: 'file-access', ...v }); return json(res, v); }
    if (p === '/api/usage') return json(res, await usageStatus(config, { force: url.searchParams.has('force') }));
    if (p === '/api/projects') return json(res, projectsList());
    if (p === '/api/catalog') { const c = catalog(config.hubDir); return json(res, { commands: c.commands.map(({ body, file, ...x }) => x), agents: c.agents.map(({ body, file, ...x }) => x), skills: c.skills.map(({ file, ...x }) => x) }); }
    if (p === '/api/open' && req.method === 'POST') {
      // 허브 PC 앞에서 볼 때만: 탐색기로 폴더 열기 / 안전한 파일은 기본 프로그램 / 나머지는 위치만 표시
      if (req.hubViewer?.remote) return fail(res, '원격 접속에서는 허브 PC의 폴더를 열 수 없어요', 403);
      const body = await readBody(req);
      const roots = openRoots();
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
    // 세션 목록: 기본은 이 PC 세션만(데스크탑 앱의 "원격 세션"이 다른 PC가 비춘 이 PC 세션까지 받아 가지 않게), ?all=1 이면 다른 PC 세션 사본도
    if (p === '/api/sessions' && req.method === 'GET') { const archived = url.searchParams.get('archived') === '1'; return json(res, [...jobs.listSessions({ archived }), ...(archived || url.searchParams.get('all') !== '1' ? [] : fed?.sessions() || [])]); }
    if (p === '/api/sessions' && req.method === 'POST') return json(res, jobs.createSession(await readBody(req)), 201);
    if (await sessionToolsRoute({ req, res, url, jobs, readBody, json, send })) return;
    let r;
    if ((r = m(/^\/api\/sessions\/([\w-]+)$/))) {
      if (req.method === 'PATCH') return json(res, jobs.updateSession(r[1], await readBody(req)));
      if (req.method === 'DELETE') return json(res, { removed: jobs.sessions.has(r[1]) ? await jobs.sessionTools.delete(r[1], url.searchParams.get('cleanup') === '1') : false });
    }
    if ((r = m(/^\/api\/sessions\/([\w-]+)\/jobs$/))) return json(res, jobs.sessionJobs(r[1]));
    // ---- 기억: 세션 결정 노트 읽기·고치기, 작업이 저장한 장기 기억 되돌리기 (lib/memory-curate.mjs) ----
    if ((r = m(/^\/api\/sessions\/([\w-]+)\/notes$/))) {
      if (req.method === 'GET') return json(res, jobs.sessionNotes(r[1]));
      if (req.method === 'PUT') return json(res, jobs.setSessionNotes(r[1], (await readBody(req)).notes));
    }
    if ((r = m(/^\/api\/jobs\/([\w-]+)\/memory\/undo$/)) && req.method === 'POST') return json(res, jobs.undoCuration(r[1]));
    if ((r = m(/^\/api\/jobs\/([\w-]+)\/memory\/retry$/)) && req.method === 'POST') return json(res, jobs.recurate(r[1]));
    if ((r = m(/^\/api\/sessions\/([\w-]+)\/goal\/(stop|resume)$/)) && req.method === 'POST') return json(res, r[2] === 'stop' ? jobs.stopGoal(r[1]) : await jobs.resumeGoal(r[1]));
    // ---- 작업 ----
    if (p === '/api/jobs' && req.method === 'GET') return json(res, jobs.list().map(publicJob));
    if (p === '/api/jobs' && req.method === 'POST') {
      const body = await readBody(req); invalidateToolStatus();
      // 실행 PC를 다른 PC로 골랐거나 다른 PC 세션에 이어서 하면 그 PC에 작업을 만든다
      if (fed && ((body.machine && body.machine !== peers.self().id) || /^rm-[A-Za-z0-9]+-/.test(String(body.sessionId || '')))) return json(res, await fed.createJob(body), 201);
      delete body.machine;
      return json(res, jobs.create(body), 201);
    }
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
    // ---- 기억 블록·공유/이 PC만·세션별 연결 (lib/memory-blocks.mjs, docs/memory.md) ----
    if (p === '/api/memory/blocks' && req.method === 'GET') return json(res, listMemory(config.hubDir));
    {
      const memChange = (r) => { broadcast({ type: 'memory-blocks' }); return json(res, r); };
      if (p === '/api/memory/move' && req.method === 'POST') return memChange(moveMemory(config.hubDir, await readBody(req)));
      if (p === '/api/memory/blocks' && req.method === 'POST') return memChange(createBlock(config.hubDir, await readBody(req)));
      if (p === '/api/memory/blocks/rename' && req.method === 'POST') { const b = await readBody(req); const r = renameBlock(config.hubDir, b); jobs.renameSessionBlock(r.from, r.to); return memChange(r); }
      if (p === '/api/memory/blocks/root' && req.method === 'POST') return memChange(setBlockRoot(config.hubDir, await readBody(req)));
      if (p === '/api/memory/blocks/delete' && req.method === 'POST') return memChange(deleteBlock(config.hubDir, await readBody(req)));
      if (p === '/api/memory/text' && req.method === 'GET') return json(res, readBlockMemory(config.hubDir, { root: url.searchParams.get('root'), rel: url.searchParams.get('rel') }));
    }
    if ((r = m(/^\/api\/sessions\/([^/]+)\/memory$/)) && req.method === 'POST') return json(res, jobs.setSessionMemory(decodeURIComponent(r[1]), await readBody(req)));
    if ((r = m(/^\/api\/memory\/([^/]+)$/))) return json(res, memoryFiles(config.hubDir, decodeURIComponent(r[1])));
    if ((r = m(/^\/api\/memory\/([^/]+)\/([^/]+)$/))) return json(res, readMemoryFile(config.hubDir, decodeURIComponent(r[1]), decodeURIComponent(r[2])));
    if (p === '/api/board') return json(res, { board: readText(path.join(hubBoardDir(config.hubDir), 'BOARD.md'), '') });
    if (p.startsWith('/api/')) return fail(res, '없는 API', 404);

    // ---- 데스크탑 프로그램 업데이트 (desktop/dist 의 업데이트 정보·설치 파일만) ----
    if (p.startsWith('/desktop-updates/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/desktop-updates/'.length));
      if (!/^(latest\.yml|(AI-Hub|ODDIN)-Setup-\d+\.\d+\.\d+\.exe(\.blockmap)?)$/.test(name)) return send(res, 404, 'not found', 'text/plain');
      const upd = path.join(ROOT, 'desktop', 'dist', name);
      if (!fs.existsSync(upd)) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': name.endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream', 'Content-Length': fs.statSync(upd).size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(upd).pipe(res);
    }

    // ---- 정적 파일 ----
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return fail(res, e, e?.status || (e instanceof SyntaxError ? 400 : 500));
  }
});

// 마지막 안전장치: 자식 프로세스 통로가 끊겨 생기는 오류는 기록만 하고 허브를 살려 둔다 (다른 오류는 원래대로 종료)
process.on('uncaughtException', (e) => {
  if (['EPIPE', 'ENOTCONN', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(e?.code)) { console.error(`[무시한 통로 오류] ${e.code}: ${e.message}`); return; }
  console.error(e); process.exit(1);
});

server.listen(config.port, config.host || '127.0.0.1', () => {
  console.log(`ODDIN  http://${config.host || '127.0.0.1'}:${config.port}  (허브: ${config.hubDir})`);
  const settings = remote.readConfig();
  console.log(settings.enabled ? `원격 접속: ${settings.url} (허용 계정 ${settings.logins.length}개)` : '원격 접속: 꺼짐');
  if (!LOOPBACK.has(config.host || '127.0.0.1')) console.warn('허브는 127.0.0.1에만 바인딩해야 합니다. 비루프백 요청은 원격 게이트에서 차단합니다');
  // "지금 바꾸기"로 멈췄던 작업을 새 버전에서 이어 한다 (다른 준비가 끝난 뒤)
  setTimeout(() => { try { const ids = jobs.resumeAfterRestart(); if (ids.length) console.log(`새 버전에서 이어 하는 작업: ${ids.join(', ')}`); } catch (e) { console.warn('작업 이어 하기 실패:', e.message); } }, 1500);
  // 어도비 플러그인을 이미 설치한 PC면 ODDIN 업데이트와 함께 플러그인도 새 판으로 (시험 서버는 건너뜀)
  if (process.env.HUB_SKIP_CLI_INSTALL !== '1') { try { const r = refreshAdobePlugins(ROOT, { port: config.port }); if (r) console.log(`어도비 플러그인 갱신: ${r.apps.map((a) => `${a.app} ${a.ok ? r.version : '실패 ' + a.error}`).join(', ')}`); } catch (e) { console.warn('어도비 플러그인 갱신 실패:', e.message); } }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `포트 ${config.port} 가 이미 사용 중입니다 (이미 실행 중인지 확인)` : e); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { try { await tools.terminals.closeAll(); } finally { process.exit(0); } });
process.on('exit', () => tools.terminals.closeAllSync());
