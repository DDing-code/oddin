// 디스크 정리 (2026-10-12 점검: 열흘 만에 허브 폴더 아래 약 17GB — 변경 스냅샷 8.5GB, 실행 기록 4GB(대부분 CLI 원본 기록), 숨은 브라우저 캐시 1GB.
// 세션·작업을 지워도 실행 기록 폴더가 남았고, 스냅샷 저장소는 한 번도 묶어 줄이지 않았다).
// 하루에 한 번, 쉬는 때에(server.mjs 가 부른다):
//   ① 주인 없는 실행 기록 폴더(지운 작업의 runs/<id>)를 지운다.
//   ② 끝난 지 rawLogDays(기본 7일) 지난 작업의 CLI 원본 기록(events.jsonl·stderr.log)을 지운다. 화면이 읽는 기록(*.log.jsonl)·결과·보고는 둔다.
//   ③ 끝난 지 checkpointDays(기본 30일) 지난 작업의 변경 스냅샷을 지운다(그 작업은 "변경 비교·되돌리기"를 못 쓰게 되고 카드에 그렇게 보인다).
//   ④ 스냅샷 저장소를 묶어 줄인다(git gc), 비어 있는 저장소는 지운다.
//   ⑤ 숨은 브라우저가 꺼져 있으면 캐시 폴더를 비운다(로그인은 그대로).
// 사용자의 결과물(작업 폴더·public 의 결과 페이지·첨부)은 건드리지 않는다. 설정 config.retention { enabled, rawLogDays, checkpointDays }.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, RUNS_DIR, readJson, writeJsonAtomic } from './util.mjs';

const DAY = 86_400_000;
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const STATE = () => path.join(DATA_DIR, 'maintenance.json');
const RAW_LOGS = new Set(['events.jsonl', 'stderr.log']);
const BROWSER_CACHES = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache', 'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache'];
const within = (p, dir) => { const a = path.resolve(p).toLowerCase(), b = path.resolve(dir).toLowerCase(); return a.startsWith(b + path.sep); };

async function sizeOf(target) {
  let n = 0;
  const walk = async (d) => { let es; try { es = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) await walk(f); else { try { n += (await fs.promises.stat(f)).size; } catch {} } } };
  try { const st = await fs.promises.stat(target); if (st.isFile()) return st.size; } catch { return 0; }
  await walk(target); return n;
}
async function removeCounting(target) { const bytes = await sizeOf(target); try { await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); return bytes; } catch { return 0; } }

/** 작업 하나의 실행 기록 폴더를 지운다(작업·세션을 지울 때). 실행 기록 폴더 바로 아래 것만 */
export function removeRunDir(job, runsDir = RUNS_DIR) {
  const dir = job?.runDir; if (!dir || !within(dir, runsDir) || path.dirname(path.resolve(dir)).toLowerCase() !== path.resolve(runsDir).toLowerCase()) return false;
  fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
  return true;
}

export function lastMaintenance() { try { return readJson(STATE(), null); } catch { return null; } }

/**
 * 정리 한 번. jobs = JobManager, browserRunning() = 숨은 브라우저가 켜져 있는지, browserProfile = 그 프로필 폴더.
 * 돌려주는 값: { at, freedBytes, orphanRuns, rawLogs, snapshots, repos, browserCache, ms }
 */
export async function maintain({ jobs, config = {}, runsDir = RUNS_DIR, browserProfile = null, browserRunning = () => false, now = Date.now(), save = true } = {}) {
  const cfg = config.retention || {}, t0 = Date.now();
  const rawDays = Number(cfg.rawLogDays ?? 7), cpDays = Number(cfg.checkpointDays ?? 30);
  const out = { at: new Date(now).toISOString(), freedBytes: 0, orphanRuns: 0, rawLogs: 0, snapshots: 0, repos: { compacted: 0, removed: 0 }, browserCache: 0, ms: 0 };
  const all = [...jobs.jobs.values()];
  const busy = () => all.some((j) => LIVE.has(j.status));
  // ① 주인 없는 실행 기록 폴더(하루 넘은 것만 — 막 만들어지는 중인 폴더는 두려고)
  const known = new Set(all.map((j) => j.runDir && path.basename(j.runDir)).filter(Boolean));
  let names = []; try { names = await fs.promises.readdir(runsDir, { withFileTypes: true }); } catch {}
  for (const e of names) {
    if (!e.isDirectory() || known.has(e.name) || !/^\d{8}-\d{6}-[\w-]+$/.test(e.name)) continue;
    const dir = path.join(runsDir, e.name);
    try { if (now - (await fs.promises.stat(dir)).mtimeMs < DAY) continue; } catch { continue; }
    out.freedBytes += await removeCounting(dir); out.orphanRuns++;
  }
  // ② 오래된 CLI 원본 기록
  if (rawDays > 0) for (const j of all) {
    if (LIVE.has(j.status) || !j.runDir || !within(j.runDir, runsDir)) continue;
    const done = Date.parse(j.finishedAt || j.createdAt || '') || 0; if (!done || now - done < rawDays * DAY) continue;
    const walk = async (d, depth) => { let es; try { es = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) { if (depth < 4) await walk(f, depth + 1); } else if (RAW_LOGS.has(e.name)) { const b = await removeCounting(f); if (b) { out.freedBytes += b; out.rawLogs++; } } } };
    await walk(j.runDir, 0);
  }
  // ③ 오래된 변경 스냅샷 — 작업 카드에는 "정리했다"고 남긴다
  if (cpDays > 0 && jobs.checkpoints) for (const j of all) {
    if (LIVE.has(j.status) || !j.checkpoint?.repo || j.checkpoint.expired) continue;
    const done = Date.parse(j.finishedAt || j.createdAt || '') || 0; if (!done || now - done < cpDays * DAY) continue;
    try {
      await jobs.checkpoints.forget(j);
      j.checkpoint = { status: 'warning', warning: `${cpDays}일이 지나 변경 스냅샷을 정리했어요`, expired: true, before: null, after: null, files: [], skipped: [], overlaps: [] };
      out.snapshots++;
    } catch {}
  }
  if (out.snapshots) { try { jobs.save(); } catch {} }
  // ④ 스냅샷 저장소 묶기(작업이 도는 중이면 다음에)
  if (jobs.checkpoints?.cleanup && !busy()) {
    try { const before = (await jobs.checkpoints.storage()).bytes; const r = await jobs.checkpoints.cleanup(); out.repos = { compacted: r.compacted.length, removed: r.removed.length }; out.freedBytes += Math.max(0, before - (r.bytes || 0)); } catch (e) { out.repos.error = String(e.message || e).slice(0, 200); }
  }
  // ⑤ 숨은 브라우저 캐시(꺼져 있을 때만 — 켜져 있으면 파일이 잠겨 있다)
  if (browserProfile && !browserRunning()) for (const rel of BROWSER_CACHES) {
    const dir = path.join(browserProfile, ...rel.split('/'));
    if (!within(dir, browserProfile)) continue;
    const b = await removeCounting(dir); out.freedBytes += b; out.browserCache += b;
  }
  out.ms = Date.now() - t0;
  if (save) { try { writeJsonAtomic(STATE(), out); } catch {} }
  return out;
}

/** 지금 디스크를 얼마나 쓰는지(느림 — 화면에서 볼 때만 부른다) */
export async function storageReport({ runsDir = RUNS_DIR, dataDir = DATA_DIR } = {}) {
  const part = async (name, dir) => ({ name, path: dir, bytes: await sizeOf(dir) });
  const parts = await Promise.all([part('변경 스냅샷', path.join(dataDir, 'checkpoints')), part('실행 기록', runsDir), part('숨은 브라우저', path.join(dataDir, 'browser-profile')), part('첨부', path.join(dataDir, 'uploads'))]);
  return { parts, bytes: parts.reduce((a, p) => a + p.bytes, 0), last: lastMaintenance() };
}
