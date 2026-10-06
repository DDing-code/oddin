// 작업자 브라우저: Claude 작업자에 Claude in Chrome(--chrome)을 켜고(작업 단계만), 플래너에 두 AI 의 브라우저 능력을 알린다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorker } from '../lib/workers.mjs';
import { browserOn } from '../lib/jobs.mjs';
import { catalogText } from '../lib/router.mjs';

const fixture = fileURLToPath(new URL('./fixtures/intercept-cli.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-browser-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function argsOf(browser) {
  const runDir = path.join(dir, `run-${browser}`), cap = path.join(dir, `cap-${browser}.jsonl`);
  const h = runWorker({ tool: 'claude', prompt: '시험', cwd: dir, runDir, browser, toolCfg: { command: `"${process.execPath}" "${fixture}" --tool claude --capture "${cap}"`, transport: 'native', shell: true }, settings: {}, timeoutMs: 15_000, ackTimeoutMs: 2000, onEvent() {} });
  const file = path.join(runDir, 'attempt-1', 'invocation.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  const inv = JSON.parse(fs.readFileSync(file, 'utf8'));
  h.cancel(); await h.promise.catch(() => {}); h.close?.();
  await new Promise((r) => setTimeout(r, 300)); // 가짜 CLI 가 끝나고 폴더를 놓을 때까지
  return inv.args;
}

test('Claude 작업자: browser 를 켜면 --chrome, 끄면 없음', async () => {
  assert.ok((await argsOf(true)).includes('--chrome'));
  assert.ok(!(await argsOf(false)).includes('--chrome'));
});

test('설정: 기본은 켜짐, config.browser.claudeChrome:false 로 끔 · 플래너 안내도 같이', () => {
  assert.equal(browserOn({}), true);
  assert.equal(browserOn({ browser: { claudeChrome: false } }), false);
  const base = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.match(catalogText(base), /브라우저: 두 작업자 모두/);
  assert.doesNotMatch(catalogText({ ...base, browser: { claudeChrome: false } }), /브라우저: 두 작업자 모두/);
});
