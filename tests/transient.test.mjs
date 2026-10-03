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
