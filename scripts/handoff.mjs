#!/usr/bin/env node
// 작업자(Claude·Codex)용: 다른 PC에만 있는 프로그램·파일이 필요할 때 그 부분을 그 PC로 넘긴다(2026-10-06 "다른 PC 작업은 그 PC로 정식으로 넘기기").
//   node scripts/handoff.mjs --pc 집 --job <작업 id> "그 PC에서 할 일(맥락·파일 경로·완료 기준)"
//   node scripts/handoff.mjs --list        (연결된 PC 이름 보기)
// 이 PC의 ODDIN(127.0.0.1)에 부탁하면 ODDIN 이 그 PC에 작업을 만든다. 같은 세션이 그 PC로 넘긴 적이 있으면 그 세션에 이어서.
// 넘긴 작업은 그 PC 세션(사이드바에 PC 이름이 붙음)에서 사용자에게 보이게 진행된다. 다른 PC의 원격 주소를 직접 부르지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = 7700;
try { port = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_FILE || path.join(root, 'config.json'), 'utf8')).port || port; } catch {}
const HUB = `http://127.0.0.1:${port}`; // 늘 이 PC의 ODDIN — 다른 PC로 직접 보내지 않는다

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flags = new Set(['--pc', '--job', '--cwd', '--task']);
const words = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1]));
const call = async (method, p, body) => {
  const r = await fetch(HUB + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

try {
  if (args.includes('--list')) {
    const v = await call('GET', '/api/peers');
    console.log(`이 PC: ${v.self?.name}\n연결된 PC: ${(v.peers || []).map((p) => `${p.name}${p.status?.online ? '' : ' (지금 연결 안 됨)'}`).join(', ') || '없음'}`);
    process.exit(0);
  }
  const goal = words.join(' ').trim();
  if (!goal) throw new Error('그 PC에서 할 일을 따옴표로 묶어 적어 주세요. 예: node scripts/handoff.mjs --pc 집 --job <작업 id> "컷백으로 자막 인식 후 …"');
  const r = await call('POST', '/api/handoff', { pc: opt('pc') || '', job: opt('job') || '', cwd: opt('cwd') || '', task: opt('task') || '', goal });
  console.log(`${r.machine} PC로 넘겼어요 — 그 PC 세션(${r.sessionId})의 작업 ${r.jobId}에서 이어서 진행돼요.${r.note ? `\n참고: ${r.note}` : ''}`);
} catch (e) {
  console.error(`넘기지 못했어요: ${e.message}`);
  process.exit(1);
}
