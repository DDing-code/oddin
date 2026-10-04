import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../lib/workers.mjs';

test('시작 직후 일시적 잠금 오류는 한 번 다시 시작해서 성공', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-flaky-'));
  process.env.FLAKY_COUNTER = path.join(dir, 'count.txt');
  const script = fileURLToPath(new URL('./fixtures/flaky-codex.mjs', import.meta.url));
  const events = [];
  const { promise } = runWorker({
    tool: 'codex', prompt: '시험', cwd: dir, runDir: path.join(dir, 'run'),
    toolCfg: { command: `node "${script}"`, transport: 'legacy' }, settings: {}, timeoutMs: 60_000,
    onEvent: (ev) => events.push(ev),
  });
  const res = await promise;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.text, /두 번째 시도 성공/);
  assert.equal(fs.readFileSync(process.env.FLAKY_COUNTER, 'utf8'), '2');
  assert.ok(events.some((e) => /일시적인 잠금 오류/.test(e.text || '')));
});

test('실행 도중 모델 용량 초과로 끊기면 같은 대화를 이어서 다시 시도해 성공', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-capacity-'));
  process.env.CAPACITY_COUNTER = path.join(dir, 'count.txt');
  process.env.CAPACITY_ARGS = path.join(dir, 'args.jsonl');
  const script = fileURLToPath(new URL('./fixtures/capacity-codex.mjs', import.meta.url));
  const events = [];
  const { promise } = runWorker({
    tool: 'codex', prompt: '영상을 다시 만들어 주세요', cwd: dir, runDir: path.join(dir, 'run'),
    toolCfg: { command: `node "${script}"`, transport: 'legacy' }, settings: {}, timeoutMs: 60_000, capacityWaitsMs: [30],
    onEvent: (ev) => events.push(ev),
  });
  const res = await promise;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.text, /이어서 완료/);
  assert.equal(fs.readFileSync(process.env.CAPACITY_COUNTER, 'utf8'), '2');
  assert.ok(events.some((e) => /붐벼/.test(e.text || '')), '재시도 안내 이벤트가 있어야 한다');
  const lines = fs.readFileSync(process.env.CAPACITY_ARGS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // 두 번째 실행은 새 대화가 아니라 같은 대화(cap-thread) 이어 쓰기여야 하고, 이어서 진행하라는 안내를 받는다.
  assert.ok(Array.isArray(lines[2]) && lines[2].includes('resume') && lines[2].includes('cap-thread'), JSON.stringify(lines[2]));
  assert.match(lines[3].prompt, /붐벼 직전 턴이 중간에 끊겼습니다/);
});

test('네이티브 연결에서 용량 초과로 끊기면 같은 스레드에 새 턴을 시작해 성공', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-capacity-native-'));
  const fixture = fileURLToPath(new URL('./fixtures/intercept-cli.mjs', import.meta.url));
  const cap = path.join(dir, 'cap.jsonl');
  const events = [];
  const h = runWorker({
    tool: 'codex', prompt: 'CAPACITY_ONCE 영상을 다시 만들어 주세요', cwd: dir, runDir: path.join(dir, 'run'),
    toolCfg: { command: `"${process.execPath}" "${fixture}" --tool codex --capture "${cap}"`, transport: 'native', shell: true },
    settings: {}, timeoutMs: 30_000, ackTimeoutMs: 3000, capacityWaitsMs: [30],
    onEvent: (ev) => events.push(ev),
  });
  const res = await h.promise; h.close?.();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.text, /최신 지시: \[AI Hub 안내\] 모델 서버가 붐벼/);
  assert.ok(events.some((e) => /붐벼 턴이 끊겼습니다/.test(e.text || '')), '재시도 안내 이벤트가 있어야 한다');
  const inputs = fs.readFileSync(cap, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'input');
  const turns = inputs.filter((x) => x.message.method === 'turn/start');
  assert.equal(turns.length, 2, '같은 연결에서 턴이 두 번 시작돼야 한다');
  assert.equal(new Set(inputs.map((x) => x.pid)).size, 1, 'CLI를 다시 띄우지 않고 같은 프로세스를 써야 한다');
  assert.equal(turns[0].message.params.threadId, turns[1].message.params.threadId);
});

test('구독 한도 소진 문구는 용량 초과로 보지 않고 다시 시도하지 않는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-limit-'));
  const script = path.join(dir, 'limit-codex.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
if (!process.argv.includes('exec')) { process.stdout.write('codex-cli 0.0.0-test\\n'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(dir, 'runs.txt'))}, 'x');
process.stdin.resume(); process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 'limit-thread' });
  out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Service unavailable until reset." } });
  process.exit(1);
});
`);
  const { promise } = runWorker({
    tool: 'codex', prompt: '시험', cwd: dir, runDir: path.join(dir, 'run'),
    toolCfg: { command: `node "${script}"`, transport: 'legacy' }, settings: {}, timeoutMs: 60_000, capacityWaitsMs: [30],
    onEvent() {},
  });
  const res = await promise;
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'x', '한 번만 실행돼야 한다');
});

test('없는 작업 폴더로 실행해도 서버가 죽지 않고 작업만 알기 쉬운 오류로 실패', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-nocwd-'));
  const fixture = fileURLToPath(new URL('./fixtures/intercept-cli.mjs', import.meta.url));
  const missing = path.join(dir, '없는 폴더', 'x'.repeat(40));
  let crashed = null; const onCrash = (e) => { crashed = e; };
  process.on('uncaughtException', onCrash);
  try {
    for (const transport of ['native', 'legacy']) {
      let res;
      try {
        const h = runWorker({ tool: 'codex', prompt: '시험', cwd: missing, runDir: path.join(dir, 'run-' + transport), toolCfg: { command: `"${process.execPath}" "${fixture}" --tool codex --capture "${path.join(dir, 'cap.jsonl')}"`, transport, shell: true }, settings: {}, timeoutMs: 15_000, ackTimeoutMs: 2000, onEvent() {} });
        res = await h.promise; h.close?.();
      } catch (e) { res = { ok: false, error: e.message }; }
      if (transport === 'native') { assert.equal(res.ok, false); assert.match(res.error || res.text || '', /작업 폴더가 없어요|CLI/); } // 예전 방식은 원래 폴더를 만들고 실행한다
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(crashed, null, `${transport}: 잡히지 않은 오류 ${crashed?.message}`);
    }
  } finally { process.off('uncaughtException', onCrash); }
});
