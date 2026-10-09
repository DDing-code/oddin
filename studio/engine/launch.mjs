// 스튜디오 엔진 켜기(명령줄·ODDIN 허브·프로그램 창 공통): 이미 켜져 있으면 그대로, 꺼져 있으면 Node 로 숨겨서 띄우고 답할 때까지 기다린다.
// 엔진은 따로 도는 프로세스라 창을 닫아도 AI 가 계속 쓸 수 있다(창 트레이 "끝내기"가 끈다).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STUDIO_DIR, DATA_DIR, loadConfig } from './env.mjs';

export const engineUrl = (port = loadConfig().port) => `http://127.0.0.1:${port}`;
export async function engineStatus(port) {
  try { const r = await fetch(`${engineUrl(port)}/api/status`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) return null; const j = await r.json(); return j?.app === 'oddin-studio' ? j : null; } catch { return null; }
}
/** 켜져 있으면 상태, 아니면 띄우고 상태. node = 엔진을 돌릴 Node(기본 지금 Node). Electron 에서 부를 때는 electronAsNode 로 */
export async function ensureEngine({ port = loadConfig().port, node = process.execPath, electronAsNode = false, waitMs = 15_000 } = {}) {
  let st = await engineStatus(port); if (st) return { ...st, started: false };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'engine.log'), 'a');
  const env = { ...process.env, STUDIO_PORT: String(port) };
  if (electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(node, [path.join(STUDIO_DIR, 'engine', 'server.mjs'), '--port', String(port)], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env, cwd: STUDIO_DIR });
  child.on('error', () => {}); child.unref(); fs.closeSync(log);
  const until = Date.now() + waitMs;
  while (Date.now() < until) { await new Promise((r) => setTimeout(r, 300)); st = await engineStatus(port); if (st) return { ...st, started: true }; if (child.exitCode != null && child.exitCode !== 3) break; }
  throw new Error(`스튜디오 엔진이 켜지지 않았어요 — ${path.join(DATA_DIR, 'engine.log')} 를 보세요`);
}
