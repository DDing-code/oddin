// 계획 담당이 실패하면 다른 AI가 대신 계획한다(2026-10-14 회사 PC: Codex 플래너가 429 요청 많음으로 6초 만에 요청 전체 실패). 실제 모델 호출 없음
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-planfb-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data'); process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
test.after(() => { try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} });
const { JobManager } = await import('../lib/jobs.mjs');
const { invalidateToolStatus } = await import('../lib/tools.mjs');

let serial = 0;
function fixture(extra = {}) {
  const root = path.join(temp, 'case-' + ++serial), capture = path.join(root, 'capture.jsonl'); fs.mkdirSync(root, { recursive: true });
  const command = (tool) => `"${process.execPath}" "${path.resolve('tests/fixtures/intercept-cli.mjs')}" --tool ${tool} --capture "${capture}"`;
  const config = { hubDir: path.join(root, 'shared'), defaultCwd: root, maxParallel: 2, planner: 'codex', fastPath: { enabled: false }, memory: { curate: false },
    planFallback: { waitsMs: [20] }, // 시험: 같은 AI로 한 번 짧게 다시 시도한 뒤 넘긴다
    tools: { claude: { command: command('claude'), transport: 'native', shell: true }, codex: { command: command('codex'), transport: 'native', shell: true } },
    defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } }, ...extra };
  const manager = new JobManager(config);
  manager.memoryFor = () => '시험 메모리';
  const rows = () => fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, manager, rows };
}
async function until(fn, ms = 40_000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('시험 조건 대기 시간 초과'); await delay(20); } }
const finished = (j) => ['done', 'partial', 'failed', 'cancelled'].includes(j.status) && !j.activePhase;

test('계획 담당 기본 순서: Claude 먼저(기획은 Claude, 작업은 Codex), 못 쓰면 Codex · 직접 고르면 그대로', async () => {
  // 2026-10-14 사용자 "우선순위를 클로드가 기획하게 해줘 기획/디자인은 클로드가 잘하고, 워크는 코덱스가 잘하니까"
  const { pickPlanner } = await import('../lib/planner.mjs');
  assert.equal(pickPlanner({ planner: 'auto' }, ['claude', 'codex'], 'auto'), 'claude');
  assert.equal(pickPlanner({}, ['codex', 'claude']), 'claude', '목록 순서와 상관없이 Claude 먼저');
  assert.equal(pickPlanner({ planner: 'auto' }, ['codex'], 'auto'), 'codex', 'Claude 를 못 쓰거나 한도 95% 넘으면 Codex');
  assert.equal(pickPlanner({ planner: 'auto' }, ['claude', 'codex'], 'codex'), 'codex', '요청에서 직접 고르면 그대로');
  assert.equal(pickPlanner({ planner: 'codex' }, ['claude', 'codex'], 'auto'), 'codex', '설정에서 정해 두면 그대로');
  assert.equal(pickPlanner({}, []), null);
});

test('Codex 계획이 429로 실패하면 Claude가 대신 계획하고 요청은 이어서 끝난다', async () => {
  invalidateToolStatus();
  const f = fixture();
  const created = f.manager.create({ goal: 'PLAN_429 두 단계로 해 줘', cwd: f.root, mode: 'auto', planner: 'auto' });
  const j = f.manager.get(created.id);
  try {
    await until(() => finished(j));
    assert.equal(j.planner, 'claude', JSON.stringify({ status: j.status, error: j.error, notes: j.notes }));
    assert.ok(['done', 'partial'].includes(j.status), j.error || j.status);
    assert.match(j.notes.join('\n'), /Codex가 계획을 세우지 못해서\(exceeded retry limit, last status: 429 Too Many Requests\) Claude가 대신 계획했어요/);
    // Codex 로 계획을 두 번(처음 + 짧게 한 번 다시) 시도한 뒤 넘겼다
    const planTurns = f.rows().filter((r) => r.tool === 'codex' && r.kind === 'input' && r.message.method === 'turn/start' && /당신은 로컬/.test(JSON.stringify(r.message.params?.input || '')));
    assert.ok(planTurns.length >= 1);
    assert.ok(j.tasks.length >= 1, '계획한 작업이 실행됐다');
  } finally { clearTimeout(f.manager._saveTimer); }
});

test('계획 담당을 직접 고른 요청은 대신하지 않고 그 AI로 평소처럼(20초·60초·120초 뒤) 다시 시도한다', async () => {
  invalidateToolStatus();
  const f = fixture();
  const created = f.manager.create({ goal: 'PLAN_429 하나만', cwd: f.root, mode: 'auto', planner: 'codex' });
  const j = f.manager.get(created.id);
  try {
    // 첫 실패 뒤 다시 시도를 기다리는 중: 다른 AI로 넘기지 않았고 요청도 아직 실패가 아니다
    await until(() => fs.existsSync(path.join(j.runDir, 'plan.log.jsonl')) && /429 Too Many Requests/.test(fs.readFileSync(path.join(j.runDir, 'plan.log.jsonl'), 'utf8')));
    await delay(1500);
    assert.equal(j.status, 'planning'); assert.equal(j.planner ?? null, null);
    assert.doesNotMatch(j.notes.join('\n'), /대신 계획/);
    assert.match(fs.readFileSync(path.join(j.runDir, 'plan.log.jsonl'), 'utf8'), /20초 뒤 같은 대화에서 이어서/);
    assert.equal(f.rows().filter((r) => r.tool === 'claude' && r.kind === 'input').length, 0, 'Claude 는 부르지 않았다');
  } finally { f.manager.cancel(j.id); await until(() => finished(j)).catch(() => {}); clearTimeout(f.manager._saveTimer); }
});
