// 세션 실행 PC 옮기기 (lib/session-move.mjs): 대화 기록을 읽기 전용으로 가져와 다음 요청 맥락으로 쓰고, CLI 대화는 이어 쓰지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-move-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { JobManager } = await import('../lib/jobs.mjs');
const { exportLocal, exportMirrored, importSession, sanitizeJob } = await import('../lib/session-move.mjs');
const mk = (...p) => { const d = path.join(temp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const manager = () => new JobManager({ defaultCwd: mk('ws'), hubDir: mk('shared'), tools: {}, defaults: {} });

function seed(m, cwd) {
  const s = m.createSession({ cwd, title: '영상 촬영본' });
  const add = (id, status, extra = {}) => { const j = { id, sessionId: s.id, title: id, goal: `${id} 요청`, mode: 'auto', status, createdAt: `2026-10-07T0${m.jobs.size}:00:00.000Z`, finishedAt: '2026-10-07T09:00:00.000Z', report: `${id} 결과 보고`, runDir: path.join(temp, 'runs', id), intercepts: [], notes: [], settings: {}, tasks: [{ id: 't1', title: '편집', assignee: 'codex', status: 'done', result: '결과', prompt: '지시', sessionId: 'codex-thread-1', resumeSessionId: 'x' }], ...extra }; m.jobs.set(id, j); m.sessions.get(s.id).jobIds.push(id); return j; };
  add('20261007-100000-AAAA', 'done', { sessionNotes: [{ text: '좌상단 자막은 쓰지 않는다' }] });
  add('20261007-110000-BBBB', 'partial');
  return s;
}

test('이 PC 세션 내보내기 → 다른 PC로 가져오기: 기록은 읽기 전용, CLI 대화 id·실행 기록 경로는 빼고, 결정 노트·보고는 다음 요청 맥락으로', () => {
  const a = manager(), s = seed(a, mk('a-proj'));
  const data = exportLocal(a, s.id);
  assert.equal(data.title, '영상 촬영본'); assert.equal(data.jobs.length, 2);
  assert.equal(data.jobs[0].tasks[0].sessionId, undefined, '작업자 CLI 대화는 다른 PC에서 이어 쓸 수 없으니 뺀다');
  assert.equal(data.jobs[0].runDir, undefined);
  const b = manager(), dest = mk('E-벌어보세');
  const made = importSession(b, { ...data, cwd: dest, from: { machine: '회사', sessionId: s.id, title: s.title } });
  assert.equal(made.imported, 2); assert.equal(made.cwd, dest);
  const ns = b.sessions.get(made.id);
  assert.equal(ns.importedFrom.machine, '회사'); assert.equal(ns.jobIds.length, 2);
  const j = b.jobs.get('20261007-100000-AAAA');
  assert.equal(j.sessionId, made.id); assert.equal(j.imported.machine, '회사'); assert.equal(j.runDir, null);
  assert.throws(() => b.retryTask(j.id, 't1'), (e) => e.status === 409 && /옮겨 온 기록/.test(e.message));
  // 다음 요청: 결정 노트와 이전 보고가 맥락으로 들어간다
  const next = { id: '20261007-235900-CCCC', sessionId: made.id, goal: '이어서 해줘', createdAt: '2026-10-07T23:59:00.000Z', tasks: [] };
  b.jobs.set(next.id, next); ns.jobIds.push(next.id);
  const ctx = b.historyContext(next);
  assert.match(ctx, /좌상단 자막은 쓰지 않는다/); assert.match(ctx, /20261007-110000-BBBB 요청/); assert.match(ctx, /BBBB 결과 보고/);
  // 같은 기록을 다시 가져와도 겹치지 않는다
  assert.equal(importSession(b, { ...data, cwd: dest, from: { machine: '회사' } }).imported, 0);
});

test('진행 중인 세션은 옮기지 않는다 · 다른 PC 사본에서 내보내면 그 PC 원래 id 로 되돌린다', () => {
  const a = manager(), s = seed(a, mk('a2'));
  a.jobs.get('20261007-110000-BBBB').status = 'running';
  assert.throws(() => exportLocal(a, s.id), (e) => e.status === 409);
  assert.throws(() => exportLocal(a, 's-없음'), (e) => e.status === 404);
  const pre = 'rm-cmp1-';
  const strip = (v) => JSON.parse(JSON.stringify(v).split(pre).join(''));
  const entry = { sessions: new Map([[`${pre}s-x`, { id: `${pre}s-x`, title: '원격 세션', cwd: 'D:\\YM_Inv' }]]), jobs: new Map([[`${pre}20261007-1`, { id: `${pre}20261007-1`, sessionId: `${pre}s-x`, goal: '요청', status: 'done', createdAt: '2026-10-07T01:00:00Z', tasks: [] }]]) };
  const d = exportMirrored(entry, `${pre}s-x`, strip);
  assert.equal(d.jobs[0].id, '20261007-1'); assert.equal(d.cwd, 'D:\\YM_Inv');
  entry.jobs.get(`${pre}20261007-1`).status = 'planning';
  assert.throws(() => exportMirrored(entry, `${pre}s-x`, strip), (e) => e.status === 409);
  assert.equal(sanitizeJob({ id: 'x', status: 'running', tasks: [{ id: 't', status: 'pending' }] }).tasks[0].status, 'interrupted');
});
