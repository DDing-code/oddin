#!/usr/bin/env node
// 사용자가 직접 실행하는 활성화 도구. 진행 중인 작업을 기다리고 해당 허브 PID만 종료한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, readJson, nowIso } from '../lib/util.mjs';
import { runCommand } from '../lib/remote.mjs';

const logFile = path.join(ROOT, 'logs', 'restart.log');
const live = new Set(['queued', 'planning', 'running', 'reporting']);
export function isIdle(jobs, sessions) {
  if (!Array.isArray(jobs) || !Array.isArray(sessions)) return false;
  return !jobs.some((j) => live.has(j.status) || j.tasks?.some((t) => t.status === 'running')) && !sessions.some((s) => s.goal?.status === 'active' || s.goal?.checking === true);
}
function log(message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${nowIso()} ${message}\n`); console.log(message);
}
async function getJson(target, route) {
  const res = await fetch(`${target}${route}`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!res.ok) throw new Error('허브 상태 확인에 실패했습니다');
  return res.json();
}
async function idleSnapshot(target) {
  const [jobs, sessions, status] = await Promise.all([getJson(target, '/api/jobs'), getJson(target, '/api/sessions'), getJson(target, '/api/status')]);
  if (typeof status.config?.root !== 'string' || path.resolve(status.config.root).toLowerCase() !== ROOT.toLowerCase()) throw new Error('이 프로젝트의 허브가 아니므로 재시작하지 않습니다');
  return isIdle(jobs, sessions);
}
async function listener(port) {
  // 숫자 검증이 끝난 포트만 코드에 넣는다. 종료는 별도 taskkill PID 인자로만 한다.
  const script = `$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique); if ($ids.Count -ne 1) { throw 'listener count' }; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[0]); [pscustomobject]@{pid=$p.ProcessId; exe=$p.ExecutablePath; command=$p.CommandLine; created=$p.CreationDate.ToString('o')} | ConvertTo-Json -Compress`;
  const r = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error('허브의 대기 PID를 확인하지 못했습니다');
  const p = JSON.parse(r.stdout.replace(/^\uFEFF/, ''));
  if (!Number.isInteger(p.pid) || p.pid <= 0 || path.basename(p.exe || '').toLowerCase() !== 'node.exe' || !/(?:^|[\s"\\/])server\.mjs(?:["\s]|$)/i.test(p.command || '')) throw new Error('대기 PID가 node.exe server.mjs가 아니므로 중단합니다');
  return p;
}
async function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('이 재시작 도구는 Windows용입니다');
  // VBS 시작 도구는 기본 data/를 사용한다. 시험 서버를 운영 서버 설정으로 재시작하지 않는다.
  if (process.env.HUB_DATA_DIR || process.env.HUB_RUNS_DIR || process.env.HUB_PORT) throw new Error('시험 서버 환경에서는 재시작 도구를 실행할 수 없습니다');
  const config = readJson(path.join(ROOT, 'config.json'), {}), port = Number(config.port || 7700);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('허브 포트가 올바르지 않습니다');
  const target = `http://127.0.0.1:${port}`;
  if (args.includes('--detach')) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'restart-hub.mjs'), ...args.filter((a) => a !== '--detach')], { cwd: ROOT, detached: true, windowsHide: true, shell: false, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd); child.unref();
    log(`숨김 재시작 대기 프로세스 PID ${child.pid}. 기록: logs/restart.log`); return;
  }
  const initial = await listener(port);
  log(`재시작 대상 허브 PID ${initial.pid}. 유휴 상태를 확인합니다`);
  if (args.includes('--now')) {
    if (!await idleSnapshot(target) && !args.includes('--force')) throw new Error('진행 중인 작업이 있어 즉시 재시작을 거부합니다');
  } else {
    let consecutive = 0, done = false;
    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await idleSnapshot(target)) consecutive++; else consecutive = 0;
      if (consecutive >= 2) { done = true; break; }
      await delay(15_000);
    }
    if (!done) throw new Error('6시간 동안 작업이 끝나지 않아 재시작하지 않았습니다');
  }
  const current = await listener(port);
  if (current.pid !== initial.pid || current.created !== initial.created || current.command !== initial.command) throw new Error('허브 PID가 바뀌어 재시작하지 않습니다');
  if (!args.includes('--force') && !await idleSnapshot(target)) throw new Error('새 작업이 시작되어 재시작하지 않습니다');
  await runCommand('taskkill.exe', ['/PID', String(initial.pid)], { timeoutMs: 10_000 });
  await delay(5000);
  if (await alive(initial.pid)) {
    // /F 직전에도 PID 재사용을 검사한다.
    const still = await listener(port);
    if (still.pid !== initial.pid || still.created !== initial.created) throw new Error('종료 대상이 바뀌어 강제 종료하지 않습니다');
    const killed = await runCommand('taskkill.exe', ['/PID', String(initial.pid), '/F'], { timeoutMs: 10_000 });
    if (killed.code !== 0) throw new Error('허브 PID 종료에 실패했습니다');
    await delay(1000);
  }
  if (await alive(initial.pid)) throw new Error('허브 PID가 아직 살아 있어 새 서버를 시작하지 않습니다');
  const start = await runCommand('wscript.exe', [path.join(ROOT, 'start-hub-hidden.vbs')], { timeoutMs: 10_000 });
  if (start.code !== 0) throw new Error('숨김 허브 시작에 실패했습니다');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const status = await getJson(target, '/api/remote');
      if (status.canManage === true && status.viewer?.remote === false && status.local?.url === target) {
        const next = await listener(port); log(`재시작 완료. 새 허브 PID ${next.pid}, 원격 게이트 적용 확인`); return;
      }
    } catch {}
    await delay(1000);
  }
  throw new Error('30초 안에 새 원격 게이트를 확인하지 못했습니다. logs/server.log를 확인해 주세요');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { log(e.message); process.exitCode = 1; });
}
