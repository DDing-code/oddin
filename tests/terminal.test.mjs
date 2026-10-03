import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalManager, descendants } from '../lib/terminal.mjs';

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await delay(25); }
  assert.fail('터미널 응답 대기 시간이 초과됐어요');
}
async function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-terminal-'));
  const events = [], manager = new TerminalManager({ maxTerminals: 8, getSession: (id) => id === 'session' ? { cwd } : null, ...options });
  manager.on('event', (event) => events.push(event));
  t.after(async () => { await manager.closeAll(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const terminal = await manager.create({ sessionId: 'session', shell: options.shell });
  return { cwd, manager, terminal, events, output: () => events.filter((e) => e.type === 'term').map((e) => e.chunk).join('') };
}
async function command(f, text) { f.manager.input(f.terminal.id, text); await until(() => !f.manager.get(f.terminal.id).running); return f.manager.get(f.terminal.id).commandCode; }

test('PowerShell 파이프: 한글·실시간 출력·상태·변수·현재 폴더·종료 코드', { timeout: 40000 }, async (t) => {
  const f = await fixture(t);
  f.manager.input(f.terminal.id, "$saved='한글 유지'; Write-Output '먼저 출력'; Start-Sleep -Milliseconds 900; Write-Host '한글 호스트'; Write-Output '마지막'");
  await until(() => f.output().includes('먼저 출력'));
  assert.equal(f.manager.get(f.terminal.id).running, true, '완료 전에 출력이 도착해야 한다');
  await until(() => !f.manager.get(f.terminal.id).running);
  assert.match(f.output(), /한글 호스트/); assert.doesNotMatch(f.output(), /CLIXML|\ufffd/);
  assert.equal(await command(f, 'Write-Output $saved'), 0); assert.match(f.output(), /한글 유지/);
  fs.mkdirSync(path.join(f.cwd, '한글 폴더'));
  assert.equal(await command(f, "Set-Location -LiteralPath '한글 폴더'"), 0);
  assert.equal(f.manager.get(f.terminal.id).cwd, path.join(f.cwd, '한글 폴더'));
  assert.equal(await command(f, `& '${process.execPath.replace(/'/g, "''")}' -e 'process.exit(7)'`), 7);
  assert.equal(await command(f, "Write-Error '오류 출력'"), 1);
  assert.ok(f.events.some((e) => e.type === 'term' && e.stream === 'stderr' && e.chunk.includes('오류 출력')));
  await command(f, '[Console]::Write(([char]27)+"[31m빨강"+([char]27)+"[0m")');
  assert.match(f.output(), /\x1b\[31m빨강\x1b\[0m/);
});

test('중지: 자식·손자만 종료하고 같은 PowerShell 셸에서 계속 실행', { timeout: 45000 }, async (t) => {
  const f = await fixture(t), pidFile = path.join(f.cwd, 'pids.json');
  const childCode = `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));console.log('자식 시작');setInterval(()=>{},1000)`;
  const file = path.join(f.cwd, 'child.cjs'); fs.writeFileSync(file, childCode);
  f.manager.input(f.terminal.id, `& '${process.execPath}' '${file}'`);
  await until(() => fs.existsSync(pidFile) && f.output().includes('자식 시작'));
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const before = await descendants(f.terminal.pid); assert.ok(pids.every((pid) => before.includes(pid)));
  await f.manager.interrupt(f.terminal.id); await until(() => !f.manager.get(f.terminal.id).running);
  assert.equal(f.manager.get(f.terminal.id).commandCode, 130);
  process.kill(f.terminal.pid, 0);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  assert.equal(await command(f, "Write-Output '셸 생존'"), 0); assert.match(f.output(), /셸 생존/);
  f.manager.input(f.terminal.id, 'Start-Sleep -Seconds 60');
  await delay(150); await f.manager.interrupt(f.terminal.id); await until(() => !f.manager.get(f.terminal.id).running);
  assert.equal(f.manager.get(f.terminal.id).commandCode, 130);
  assert.equal(await command(f, "'내부 명령 중지 뒤 생존'"), 0);
});

test('출력 버퍼: 최근 2000줄과 줄 없는 출력의 용량 제한', { timeout: 40000 }, async (t) => {
  const f = await fixture(t); await command(f, "1..2100 | ForEach-Object { '줄'+$_ }");
  const buffer = f.manager.buffer(f.terminal.id), text = buffer.chunks.map((e) => e.chunk).join('');
  assert.equal((text.match(/\n/g) || []).length, 2000); assert.match(text, /^줄101\n/); assert.match(text, /줄2100\n$/);
  assert.equal(buffer.seq, f.manager.get(f.terminal.id).seq);
  f.manager.output(f.manager.get(f.terminal.id), 'x'.repeat(3 * 1024 * 1024), 'stdout');
  assert.equal(f.manager.get(f.terminal.id).bytes, 2 * 1024 * 1024);
  assert.equal(f.events.at(-1).chunk.length, 3 * 1024 * 1024, '실시간 이벤트는 버퍼를 자르기 전 전체 출력이어야 한다');
});

test('여러 터미널·상한·입력 검증·닫기·종료 이벤트·허브 정리', { timeout: 40000 }, async (t) => {
  const f = await fixture(t, { maxTerminals: 2 });
  const second = await f.manager.create({ sessionId: 'session' });
  assert.equal(f.manager.list('session').length, 2);
  await assert.rejects(f.manager.create({ sessionId: 'session' }), (e) => e.status === 429);
  assert.throws(() => f.manager.input(f.terminal.id, ''), (e) => e.status === 400);
  f.manager.input(f.terminal.id, 'Start-Sleep -Milliseconds 900');
  assert.throws(() => f.manager.input(f.terminal.id, 'echo 다음'), (e) => e.status === 409);
  await f.manager.close(f.terminal.id); assert.throws(() => process.kill(f.terminal.pid, 0));
  assert.ok(f.events.some((e) => e.type === 'term_exit' && e.id === f.terminal.id));
  await f.manager.closeAll(); assert.throws(() => process.kill(second.pid, 0));
});

test('cmd 파이프: 한글·작업 폴더·종료 코드·자식 중지', { timeout: 45000 }, async (t) => {
  const f = await fixture(t, { shell: 'cmd' });
  await command(f, 'echo 한글 cmd'); assert.match(f.output(), /한글 cmd/);
  fs.mkdirSync(path.join(f.cwd, 'sub')); await command(f, 'cd sub'); assert.equal(f.manager.get(f.terminal.id).cwd, path.join(f.cwd, 'sub'));
  assert.equal(await command(f, `"${process.execPath}" -e "process.exit(9)"`), 9);
  f.manager.input(f.terminal.id, 'ping -n 60 127.0.0.1'); await delay(250);
  await f.manager.interrupt(f.terminal.id); await until(() => !f.manager.get(f.terminal.id).running);
  assert.equal(await command(f, 'echo 생존'), 0); assert.match(f.output(), /생존/);
  assert.equal(await command(f, `"${process.execPath}" -e "console.log('native-alive')"`), 0); assert.match(f.output(), /native-alive/);
});

test('Git Bash가 있으면 파이프 명령·한글·종료 코드·중지', { timeout: 45000 }, async (t) => {
  const available = fs.existsSync(path.join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'bash.exe'));
  if (!available) { t.skip('Git Bash가 설치되지 않았어요'); return; }
  const f = await fixture(t, { shell: 'bash' });
  assert.equal(await command(f, "printf '한글 bash\\n'"), 0); assert.match(f.output(), /한글 bash/);
  assert.equal(await command(f, 'false'), 1);
  f.manager.input(f.terminal.id, 'sleep 60'); await delay(250); await f.manager.interrupt(f.terminal.id);
  await until(() => !f.manager.get(f.terminal.id).running);
  assert.equal(await command(f, "echo '셸 유지'"), 0); assert.match(f.output(), /셸 유지/);
});
