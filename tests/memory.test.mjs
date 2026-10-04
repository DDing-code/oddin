import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const shared = process.env.AI_SHARED_SYNC_DIR || path.join(os.homedir(), '.ai-shared', 'sync');
// 공유 메모리 스크립트(~/.ai-shared/sync)가 없는 PC(새로 설치한 PC 등)에서는 이 파일의 시험을 건너뛴다.
const skipped = (name, fn) => nodeTest(name, { skip: `${shared} 가 없어 공유 메모리 시험을 건너뜀` }, fn);
skipped.after = nodeTest.after;
const test = fs.existsSync(path.join(shared, 'memory-context.cjs')) ? nodeTest : skipped;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-memory-test-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
process.env.HUB_RUNS_DIR = path.join(temp, 'runs');
process.env.CODEX_HOME = path.join(temp, 'codex');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: ['gpt-6.1-sol', 'gpt-6-astra'].map((slug) => ({ slug, supported_reasoning_levels: ['high', 'xhigh'] })) }));
const { JobManager } = await import('../lib/jobs.mjs');
const { makePlan } = await import('../lib/planner.mjs');
const { runWorker } = await import('../lib/workers.mjs');
const { invalidateToolStatus } = await import('../lib/tools.mjs');
const { autoCatalog, finalizeChoice, internalSettings, badModels } = await import('../lib/router.mjs');
const { resolveSettings } = await import('../lib/options.mjs');
const fact = (name, description, body, type = 'reference') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n${body}\n`;
let serial = 0;
function fixture() {
  const root = path.join(temp, 'case-' + ++serial), hubDir = path.join(root, 'shared'), cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  for (const name of ['memory-context.cjs', 'memory-check.mjs', 'memory-query.mjs']) write(path.join(hubDir, 'sync', name), fs.readFileSync(path.join(shared, name)));
  const mem = require(path.join(hubDir, 'sync/memory-context.cjs'));
  write(path.join(hubDir, 'sync/config.json'), JSON.stringify({ memoryAliases: { [cwd]: 'project' } }));
  write(path.join(hubDir, 'memory/projects/INDEX.md'), `| 작업 경로 | 폴더 | 파일 |\n|---|---|---|\n| ${cwd} | project | 2 |\n`);
  write(path.join(hubDir, 'memory/global/MEMORY.md'), '- [한국어](feedback-korean-only.md) — 언어\n- [무관](unrelated.md) — 여행\n');
  write(path.join(hubDir, 'memory/global/feedback-korean-only.md'), fact('feedback-korean-only', '한국어', '항상 한국어 응답', 'feedback'));
  write(path.join(hubDir, 'memory/global/unrelated.md'), fact('unrelated', '독립된 여행 정보', 'UNRELATED_BODY'));
  write(path.join(hubDir, 'memory/projects/project/MEMORY.md'), '- [probe](probe.md) — probe 메모리 공유\n');
  const probe = path.join(hubDir, 'memory/projects/project/probe.md');
  write(probe, fact('probe', 'probe 메모리 공유', 'PROBE_OLD'));
  const captures = path.join(root, 'captures.jsonl'), configFile = path.join(root, 'fixture.json');
  write(configFile, JSON.stringify({ probe, captures }));
  const cli = path.resolve('tests/fixtures/memory-cli.mjs');
  const command = (tool) => `"${process.execPath}" "${cli}" --tool ${tool} --fixture "${configFile}"`;
  const config = { hubDir, defaultCwd: cwd, maxParallel: 2, planner: 'codex', fastPath: { enabled: false }, // 계획 단계를 시험하므로 작은 요청 바로 처리는 끔
    tools: { claude: { command: command('claude'), transport: 'legacy' }, codex: { command: command('codex'), transport: 'legacy' } }, defaults: { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } } };
  return { root, hubDir, cwd, mem, probe, configFile, captures, config };
}
function hook(f, mode, session = 'same') {
  const run = spawnSync(process.execPath, [path.join(f.hubDir, 'sync/memory-check.mjs'), ...(mode === 'codex' ? ['--codex'] : [])], { input: JSON.stringify({ cwd: f.cwd, session_id: session, prompt: 'probe 메모리 공유' }), encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  return mode === 'codex' ? JSON.parse(run.stdout).hookSpecificOutput.additionalContext : run.stdout;
}
async function completed(manager, publicJob) {
  const job = manager.get(publicJob.id);
  if (!['queued', 'planning', 'running', 'reporting'].includes(job.status)) return job;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { manager.off('event', listen); reject(new Error('모의 작업 시간 초과')); }, 15000);
    const listen = (e) => { if (e.type === 'job' && e.job.id === job.id && !['queued', 'planning', 'running', 'reporting'].includes(e.job.status)) { clearTimeout(timeout); manager.off('event', listen); resolve(); } };
    manager.on('event', listen);
  });
  assert.equal(job.status, 'done', job.error || JSON.stringify(job.tasks)); return job;
}

test('관련 본문·프로젝트 보호·전역 목록 초과·추가 조회·크기 제한', () => {
  const f = fixture();
  write(path.join(f.hubDir, 'memory/global/MEMORY.md'), ('긴 전역 목록\n'.repeat(3000)) + '- [한국어](feedback-korean-only.md) — 한국어\n- [무관](unrelated.md) — 여행\n');
  const result = f.mem.buildMemoryContext({ hubDir: f.hubDir, cwd: f.cwd, query: 'probe', limit: 9000 });
  assert.ok(result.text.length <= 9000);
  assert.match(result.text, /PROBE_OLD/); assert.match(result.text, /항상 한국어/);
  assert.doesNotMatch(result.text, /UNRELATED_BODY/); assert.match(result.text, /memory-query/);
  assert.ok(result.manifest.indexes.some((x) => x.partial));
  assert.ok(result.manifest.omitted.some((x) => /unrelated/.test(x.file)));
  const cli = spawnSync(process.execPath, [path.join(f.hubDir, 'sync/memory-query.mjs'), '--read', 'projects/project/probe.md'], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0); assert.match(cli.stdout, /PROBE_OLD/);
});

test('별칭·대소문자·정션 실경로·독립 하위 메모리·미등록 폴더', () => {
  const f = fixture();
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.cwd, alias, 'junction');
  const child = path.join(f.cwd, 'child'); fs.mkdirSync(child);
  const childSlug = f.mem.slugOf(child);
  write(path.join(f.hubDir, 'memory/projects', childSlug, 'MEMORY.md'), '- [child](child.md) — child\n');
  write(path.join(f.hubDir, 'memory/projects', childSlug, 'child.md'), fact('child', 'child', 'CHILD_MEMORY'));
  assert.ok(f.mem.resolveMemoryProjects(f.hubDir, alias).slugs.includes('project'));
  assert.ok(f.mem.resolveMemoryProjects(f.hubDir, f.cwd.toUpperCase()).slugs.includes('project'));
  const slugs = f.mem.resolveMemoryProjects(f.hubDir, child).slugs;
  assert.ok(slugs.includes('project')); assert.ok(slugs.includes(childSlug));
  const unknown = path.join(f.root, 'unknown'), unknownSlug = f.mem.slugOf(unknown);
  write(path.join(f.hubDir, 'memory/projects', unknownSlug, 'MEMORY.md'), '未知');
  assert.equal(f.mem.resolveMemoryProjects(f.hubDir, unknown).primary, unknownSlug);
});

test('누락·권한·구성 파싱·인덱스 누락·저장소 밖 링크 진단', () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.hubDir, 'memory/projects/project/MEMORY.md'), '- [missing](missing.md) — missing\n- [escape](../../../outside.md) — escape\n');
  write(path.join(f.hubDir, 'memory/projects/project/orphan.md'), fact('orphan', 'probe', 'ORPHAN'));
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (String(file) === f.probe) throw Object.assign(new Error('권한 거부 모의'), { code: 'EACCES' }); return originalRead(file, ...args); };
  let result;
  try { result = f.mem.buildMemoryContext({ hubDir: f.hubDir, cwd: f.cwd, query: 'probe' }); } finally { fs.readFileSync = originalRead; }
  for (const code of ['ENOENT', 'EACCES', 'UNINDEXED', 'OUTSIDE_MEMORY']) assert.ok(result.manifest.diagnostics.some((x) => x.code === code), code);
  write(path.join(f.hubDir, 'sync/config.json'), '{broken');
  assert.ok(f.mem.resolveMemoryProjects(f.hubDir, f.cwd).diagnostics.some((x) => x.code === 'PARSE_ERROR'));
  write(path.join(f.hubDir, 'memory/projects/INDEX.md'), '깨진 대응표');
  assert.ok(f.mem.resolveMemoryProjects(f.hubDir, f.cwd).diagnostics.some((x) => x.code === 'INDEX_PARSE_ERROR'));
});

test('두 CLI 훅: 새 요청·같은 세션·재개·본문 변경·삭제 갱신', () => {
  const f = fixture();
  for (const mode of ['claude', 'codex']) {
    assert.match(hook(f, mode), /PROBE_OLD/);
    assert.match(hook(f, mode), /최신 확인/);
    write(f.probe, fact('probe', 'probe', 'PROBE_NEW'));
    assert.match(hook(f, mode), /PROBE_NEW/);
    assert.match(hook(f, mode, 'resumed'), /PROBE_NEW/);
    fs.unlinkSync(f.probe); assert.match(hook(f, mode), /삭제된 메모리/);
    write(f.probe, fact('probe', 'probe 메모리 공유', 'PROBE_OLD'));
  }
});

test('두 CLI 훅: 큰 메모리도 CLI 훅 한도(10,000바이트) 안에서 핵심 본문 전달', () => {
  const f = fixture();
  const filler = Array.from({ length: 300 }, (_, i) => `- [긴 전역 항목 ${i}](item-${i}.md) — 영상 편집 방송 폰트 작업 기록 ${i}`).join('\n');
  write(path.join(f.hubDir, 'memory/global/MEMORY.md'), `- [한국어](feedback-korean-only.md) — 언어\n${filler}\n`);
  write(f.probe, fact('probe', 'probe 메모리 공유', 'PROBE_OLD\n' + '공유 메모리 본문 내용입니다. '.repeat(400)));
  for (const mode of ['claude', 'codex']) {
    const text = hook(f, mode, 'big-' + mode);
    assert.ok(Buffer.byteLength(text) <= 9000, `${mode} 훅 출력 ${Buffer.byteLength(text)}바이트`);
    assert.match(text, /PROBE_OLD/);
    assert.match(text, /항상 한국어 응답/);
    assert.match(text, /memory-query\.mjs/);
  }
});

test('새 자동 작업·의존 작업 분배·본문 갱신·보고·세션 후속·재시도', async () => {
  const f = fixture(); invalidateToolStatus();
  const manager = new JobManager(f.config);
  const first = await completed(manager, manager.create({ goal: 'probe 메모리 공유', mode: 'auto' }));
  const text = (phase) => fs.readFileSync(path.join(first.runDir, phase, 'prompt.md'), 'utf8');
  assert.match(text('plan'), /PROBE_OLD/); assert.match(text('t1'), /PROBE_OLD/);
  assert.match(text('t2'), /PROBE_NEW/); assert.match(text('report'), /PROBE_NEW/);
  for (const phase of ['plan', 't1', 't2', 'report']) assert.ok(fs.existsSync(path.join(first.runDir, phase, 'memory-context.json')));
  const oldHash = JSON.parse(fs.readFileSync(path.join(first.runDir, 't1/memory-context.json'))).selected.find((x) => x.file === f.probe).hash;
  const newHash = JSON.parse(fs.readFileSync(path.join(first.runDir, 't2/memory-context.json'))).selected.find((x) => x.file === f.probe).hash;
  assert.notEqual(oldHash, newHash);
  const next = await completed(manager, manager.create({ goal: 'probe 메모리 이어서', mode: 'codex', sessionId: first.sessionId }));
  assert.match(fs.readFileSync(path.join(next.runDir, 't1/prompt.md'), 'utf8'), /PROBE_NEW/);
  // 같은 세션 후속 요청: 직전 Codex 대화를 이어 쓰므로 이전 명령 대신 [이어서] 안내 (이전 명령은 그 대화에 이미 있음)
  const nextTask = next.tasks[0];
  assert.match(fs.readFileSync(path.join(next.runDir, 't1/prompt.md'), 'utf8'), /\[이어서\]/);
  assert.equal(nextTask.continuedFrom?.jobId, first.id);
  assert.equal(nextTask.continuedFrom.sessionId, first.tasks.find((t) => t.assignee === 'codex').sessionId);
  // 이어 쓰기를 끄면 예전처럼 이전 명령을 지시문에 붙인다
  manager.config.continuity = { resume: false };
  const third = await completed(manager, manager.create({ goal: 'probe 메모리 새로', mode: 'codex', sessionId: first.sessionId }));
  assert.match(fs.readFileSync(path.join(third.runDir, 't1/prompt.md'), 'utf8'), /이전 명령/);
  assert.equal(third.tasks[0].continuedFrom, undefined);
  delete manager.config.continuity;
  write(f.probe, fact('probe', 'probe', 'PROBE_RETRY'));
  await completed(manager, manager.retryTask(next.id, 't1'));
  assert.match(fs.readFileSync(path.join(next.runDir, 't1/prompt.md'), 'utf8'), /PROBE_RETRY/);
  // 오래된 job의 재시도도 작업 중 바뀐 별칭을 재해석한다.
  write(path.join(f.hubDir, 'sync/config.json'), JSON.stringify({ memoryAliases: { [f.cwd]: 'new-project' } }));
  write(path.join(f.hubDir, 'memory/projects/new-project/MEMORY.md'), '- [probe](probe.md) — probe\n');
  write(path.join(f.hubDir, 'memory/projects/new-project/probe.md'), fact('probe', 'probe', 'ALIAS_RETRY'));
  await completed(manager, manager.retryTask(next.id, 't1'));
  assert.match(fs.readFileSync(path.join(next.runDir, 't1/prompt.md'), 'utf8'), /ALIAS_RETRY/);
  assert.equal(next.memorySlug, 'new-project');
  clearTimeout(manager._saveTimer);
});

test('단독/비교 자동 배정에도 최신 메모리와 이력을 전달', async () => {
  const f = fixture(); invalidateToolStatus();
  f.config.defaults = { claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } };
  const manager = new JobManager(f.config);
  for (const mode of ['codex', 'both']) {
    const job = await completed(manager, manager.create({ goal: 'probe 메모리 배정', mode }));
    assert.match(fs.readFileSync(path.join(job.runDir, 'route/prompt.md'), 'utf8'), /PROBE_OLD/);
    for (const t of job.tasks) assert.match(fs.readFileSync(path.join(job.runDir, t.id, 'prompt.md'), 'utf8'), /PROBE_OLD/);
  }
  clearTimeout(manager._saveTimer);
});

test('미지원 오류 분리·고정 모델/강도 보존·상위 하한·후보 없음 차단', async () => {
  const f = fixture(); badModels.clear();
  write(f.configFile, JSON.stringify({ probe: f.probe, captures: f.captures, reject: ['gpt-6-astra', 'gpt-6.1-sol'] }));
  await assert.rejects(makePlan({ goal: 'probe', cwd: f.cwd, config: f.config, status: { codex: { ok: true } }, healthy: ['codex'], settings: f.config.defaults, runDir: path.join(f.root, 'failed-plan'), onEvent() {} }), /CLI 실행 실패 \[MODEL_UNSUPPORTED\]/);
  const res = await runWorker({ tool: 'codex', prompt: 'probe', cwd: f.cwd, runDir: path.join(f.root, 'fixed'), toolCfg: f.config.tools.codex, settings: { model: 'gpt-6-astra', effort: 'xhigh' }, modelPolicy: { config: f.config, fixed: { model: 'gpt-6-astra', effort: 'xhigh' } }, onEvent() {} }).promise;
  assert.equal(res.errorKind, 'MODEL_UNSUPPORTED'); assert.equal(res.fellBackTo, undefined);
  assert.throws(() => internalSettings(f.config, 'codex', { model: 'auto', effort: 'auto' }), /지원 후보/);
  assert.throws(() => finalizeChoice(f.config, 'codex', { model: 'auto', effort: 'auto' }), /지원 후보/);
  badModels.clear();
  assert.deepEqual(autoCatalog({ autoFloor: { codex: { model: 'gpt-6-astra', effort: 'xhigh' } } }).codex.models, ['gpt-6-astra']);
  assert.throws(() => resolveSettings(f.config, { codex: { model: 'gpt-6-astra', effort: 'ultra' } }), /자동으로 내리지/);
  const invocation = JSON.parse(fs.readFileSync(path.join(f.root, 'fixed/invocation.json')));
  assert.equal(invocation.settings.effort, 'xhigh'); assert.match(invocation.version, /0.160.0/);
  badModels.clear();
});

test('자동 모델 재실행은 동급 이상 모델과 원래 강도만 사용', async () => {
  const f = fixture(); badModels.clear();
  write(f.configFile, JSON.stringify({ probe: f.probe, captures: f.captures, reject: ['gpt-6.1-sol'] }));
  const res = await runWorker({ tool: 'codex', prompt: 'probe', cwd: f.cwd, runDir: path.join(f.root, 'fallback'), toolCfg: f.config.tools.codex,
    settings: { model: 'gpt-6.1-sol', effort: 'xhigh' }, modelPolicy: { config: f.config, fixed: { model: 'auto', effort: 'auto' } }, onEvent() {} }).promise;
  assert.equal(res.ok, true); assert.equal(res.fellBackTo, 'gpt-6-astra');
  const attempts = fs.readFileSync(path.join(f.root, 'fallback/invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((x) => x.stage === 'resolved');
  assert.deepEqual(attempts.map((x) => [x.settings.model, x.settings.effort]), [['gpt-6.1-sol', 'xhigh'], ['gpt-6-astra', 'xhigh']]);
  const cache = path.join(process.env.CODEX_HOME, 'models_cache.json'), original = fs.readFileSync(cache);
  try {
    write(cache, JSON.stringify({ models: [{ slug: 'gpt-6-astra', supported_reasoning_levels: ['low', 'medium'] }] }));
    assert.throws(() => internalSettings(f.config, 'codex', { model: 'auto', effort: 'auto' }), /지원 후보/);
  } finally { fs.writeFileSync(cache, original); badModels.clear(); }
});

test.after(() => {
  const resolved = path.resolve(temp);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('ai-hub-memory-test-')) throw new Error('임시 폴더 삭제 범위 오류');
  fs.rmSync(resolved, { recursive: true, force: true });
});
