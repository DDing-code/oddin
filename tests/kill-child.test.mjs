// 자식 프로세스 강제 종료(util.killChildTree): 이미 끝난 자식의 번호로는 끄지 않는다.
// 끝난 번호는 Windows가 곧 다른 프로세스에 다시 주므로, 그대로 taskkill /T 하면 상관없는 프로세스가 죽는다
// (2026-10-05: 사용량 조회·예전 방식 실행기가 끝난 번호를 끄는 바람에 병렬 시험의 다른 CLI·셸이 가끔 죽었다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { killChildTree } from '../lib/util.mjs';

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function within(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

test('이미 끝난 자식은 끄지 않는다 (끝난 번호가 다른 프로세스에 다시 쓰였을 수 있음)', async () => {
  const done = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await within(new Promise((r) => done.once('exit', r)), 15000, '자식이 끝나지 않음');
  assert.ok(exited(done));
  assert.equal(killChildTree(done), false);
  assert.equal(killChildTree(null), false);
  assert.equal(killChildTree({ pid: undefined, exitCode: null, signalCode: null }), false);
});

test('살아 있는 자식은 손자까지 끈다', { skip: process.platform !== 'win32' && 'Windows 전용(taskkill /T)' }, async () => {
  // 손자는 자식의 출력 통로를 물려받는다. 손자까지 끝나야 통로가 닫혀 'close'가 온다 — 번호로 생존을 확인하지 않는다.
  const grand = "console.log('grand-ready'); setInterval(() => {}, 1000)";
  const code = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
  const live = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = ''; live.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((r) => live.once('close', r));
  const end = Date.now() + 15000;
  while (!out.includes('grand-ready')) { if (Date.now() > end) { live.kill(); throw new Error('손자가 시작하지 않음'); } await delay(20); }
  assert.equal(killChildTree(live), true);
  await within(closed, 15000, '자식·손자가 끝나지 않음');
  assert.equal(killChildTree(live), false, '끝난 뒤에는 다시 끄지 않는다');
});
