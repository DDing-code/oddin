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
