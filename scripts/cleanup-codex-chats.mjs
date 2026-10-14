#!/usr/bin/env node
// ODDIN이 만든 Codex 채팅만 정리한다. 모델 호출·서버 재시작 없이 공식 RPC를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexCommand, childEnv, guardChild, killChildTree, lineSplitter } from '../lib/util.mjs';

export function isOddinChat(thread) {
  const first = thread.preview || thread.first_user_message || thread.title || '';
  return thread.originator === 'ai-hub' || /^(?:\[AI Hub (?:작업|계획|보고|안내)\]|당신은 (?:로컬 AI 작업 허브의 플래너|AI 작업 허브(?:\(ODDIN\))?의 (?:기억 정리|보고) 담당|목표 달성 판정 담당|작업마다.*담당))/.test(first);
}

export async function cleanup({ apply = false } = {}) {
  const command = codexCommand({});
  const child = guardChild(spawn(command, ['app-server', '--listen', 'stdio://'], { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  let serial = 0, stderr = '', closed = false;
  const pending = new Map();
  child.stderr.on('data', (s) => { stderr = (stderr + s).slice(-2000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', lineSplitter((line) => {
    let x; try { x = JSON.parse(line); } catch { return; }
    const p = pending.get(x.id); if (!p) return;
    pending.delete(x.id); clearTimeout(p.timer);
    if (x.error) p.reject(new Error(x.error.message)); else p.resolve(x.result);
  }));
  const fail = (e) => { closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  child.on('error', fail);
  child.on('close', (code) => fail(new Error(`Codex 연결 종료 ${code}: ${stderr}`)));
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Codex 연결이 닫혔습니다')); return; }
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 응답 시간 초과`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const found = [], deleted = [], errors = [];
  try {
    await rpc('initialize', { clientInfo: { name: 'oddin-chat-cleanup', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    for (const archived of [false, true]) {
      let cursor = null;
      do {
        const r = await rpc('thread/list', { archived, limit: 100, cursor, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], modelProviders: [] });
        for (const t of r.data || []) if (isOddinChat(t)) found.push({ id: t.id, archived, title: (t.name || t.preview || '').slice(0, 120), status: t.status?.type });
        cursor = r.nextCursor;
      } while (cursor);
    }
    if (apply) {
      // 삭제 전에 대상 ID만 기록한다. 다른 대화에는 손대지 않는다.
      const dir = path.join(process.env.HUB_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data'), 'codex-chat-cleanup');
      const jobsFile = path.join(dir, '../jobs.json'), jobsKnown = fs.existsSync(jobsFile);
      let jobs = [];
      try { jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const busy = new Set();
      for (const j of jobs) if (['planning', 'running', 'reporting'].includes(j.status) || j.curation?.status === 'running') {
        for (const t of j.tasks || []) if (t.status === 'running' && t.sessionId) busy.add(t.sessionId);
        for (const phase of Object.values(j.phaseRuns || {})) if (phase.cliSessionId) busy.add(phase.cliSessionId);
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
      fs.writeFileSync(file, JSON.stringify({ found, deleted, errors }, null, 2));
      for (const t of found) {
        // CLI 종료 뒤에도 Codex에 active 표시가 남을 수 있어 허브의 실제 실행 기록을 우선한다.
        if (busy.has(t.id) || (!jobsKnown && t.status === 'active')) { errors.push({ id: t.id, error: '실행 중이므로 이번 정리에서 제외' }); continue; }
        try { await rpc('thread/delete', { threadId: t.id }); deleted.push(t.id); }
        catch (e) { errors.push({ id: t.id, error: e.message }); }
        if ((deleted.length + errors.length) % 100 === 0) {
          fs.writeFileSync(file, JSON.stringify({ found, deleted, errors }, null, 2));
          console.log(`오딘 자동 채팅 ${deleted.length}/${found.length}개 삭제`);
        }
      }
      fs.writeFileSync(file, JSON.stringify({ found, deleted, errors }, null, 2));
    }
    return { found: found.length, archived: found.filter((t) => t.archived).length, deleted: deleted.length, errors, sample: found.slice(0, 5) };
  } finally { child.stdin.end(); const timer = setTimeout(() => killChildTree(child), 1000); timer.unref(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await cleanup({ apply: process.argv.includes('--apply') }), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
