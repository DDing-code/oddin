// PTY 없이 파이프로 실행하는 셸. 출력과 명령 완료 상태는 별도로 전달한다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { guardChild } from './util.mjs';

const run = promisify(execFile);
const error = (status, message) => Object.assign(new Error(message), { status });
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

// 읽기 스레드와 비동기 runspace를 분리해 Start-Sleep 같은 내부 명령도 중지한다.
// 파이프용 PowerShell -Command - 의 프롬프트·버퍼링에 의존하지 않는다.
function powershellBootstrap(prefix, cwd) {
  const source = `
using System;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
public static class HubPipeShell {
  static string prefix = "${prefix}";
  static object gate = new object();
  static string B64(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value)); }
  static void Send(string kind, string value) { lock(gate) { Console.WriteLine(prefix + kind + ":" + value); Console.Out.Flush(); } }
  public static void Run() {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    var messages = new ConcurrentQueue<string>();
    var reader = new Thread(() => { string line; while ((line = Console.ReadLine()) != null) messages.Enqueue(line); messages.Enqueue("X"); });
    reader.IsBackground = true; reader.Start();
    using (var rs = RunspaceFactory.CreateRunspace()) {
      rs.Open();
      using (var init = PowerShell.Create()) {
        init.Runspace = rs;
        init.AddScript("$global:OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=$global:OutputEncoding; chcp.com 65001 > $null; Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cwd).toString('base64')}'))) ", false).Invoke();
      }
      Send("R", B64(rs.SessionStateProxy.Path.CurrentLocation.Path));
      PowerShell ps = null; IAsyncResult pending = null; bool interrupted = false; bool hadErrors = false;
      while (true) {
        string message;
        while (messages.TryDequeue(out message)) {
          if (message == "X") { if (ps != null) { ps.Stop(); ps.Dispose(); } return; }
          if (message == "I") { if (ps != null && !pending.IsCompleted) { interrupted = true; ps.Stop(); } continue; }
          if (!message.StartsWith("C:") || ps != null) continue;
          interrupted = false; hadErrors = false; ps = PowerShell.Create(); ps.Runspace = rs;
          var output = new PSDataCollection<PSObject>();
          output.DataAdded += (s, e) => { foreach (var item in output.ReadAll()) Send("O", B64(item.ToString() + "\\n")); };
          ps.Streams.Error.DataAdded += (s, e) => { foreach (var item in ((PSDataCollection<ErrorRecord>)s).ReadAll()) { if (item.FullyQualifiedErrorId != "NativeCommandError" && item.FullyQualifiedErrorId != "NativeCommandErrorMessage") hadErrors = true; Send("E", B64(item.ToString() + "\\n")); } };
          ps.Streams.Information.DataAdded += (s, e) => { foreach (var item in ((PSDataCollection<InformationRecord>)s).ReadAll()) Send("O", B64(item.MessageData.ToString() + "\\n")); };
          ps.Streams.Warning.DataAdded += (s, e) => { foreach (var item in ((PSDataCollection<WarningRecord>)s).ReadAll()) Send("E", B64(item.Message + "\\n")); };
          ps.AddScript("$global:LASTEXITCODE=0; $global:__hubResult=0; . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + message.Substring(2) + "')))); $global:__hubResult=if ($?) { $LASTEXITCODE } elseif ($LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }", false);
          ps.AddCommand("Out-String").AddParameter("Stream");
          var input = new PSDataCollection<PSObject>(); input.Complete();
          pending = ps.BeginInvoke<PSObject, PSObject>(input, output);
        }
        if (ps != null && pending.IsCompleted) {
          int code = interrupted ? 130 : 0;
          try { ps.EndInvoke(pending); if (!interrupted) code = Convert.ToInt32(rs.SessionStateProxy.GetVariable("__hubResult")); }
          catch (Exception ex) { if (!interrupted) { code = 1; Send("E", B64(ex.Message + "\\n")); } }
          if (code == 0 && hadErrors) code = 1;
          string location = rs.SessionStateProxy.Path.CurrentLocation.Path;
          ps.Dispose(); ps = null; pending = null;
          Send("S", code.ToString() + ":" + B64(location));
        }
        Thread.Sleep(15);
      }
    }
  }
}`;
  return `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition @'\n${source}\n'@; [HubPipeShell]::Run()`;
}

export async function descendants(pid) {
  if (process.platform !== 'win32') throw error(501, '터미널 프로세스 관리는 Windows에서만 지원해요');
  const script = `@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`;
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).catch(() => { throw error(500, '터미널 자식 프로세스를 찾지 못했어요'); });
  const rows = JSON.parse(stdout || '[]'), ids = new Set([pid]), found = [];
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (ids.has(row.ParentProcessId) && !ids.has(row.ProcessId)) { ids.add(row.ProcessId); if (!/^(conhost|OpenConsole)\.exe$/i.test(row.Name)) found.push(row.ProcessId); changed = true; } }
  return found;
}

async function killTree(pid) {
  try { await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); }
  catch (e) { if (e.code !== 128 && e.code !== 255) throw error(500, '프로세스를 종료하지 못했어요'); }
}

function parseBashChildren(t, stdout) {
  const rows = stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((row) => /^\d+$/.test(row[0])).map((row) => ({ pid: Number(row[0]), parent: Number(row[1]), winpid: Number(row[3]) }));
  const root = rows.find((row) => row.winpid === t.child.pid); if (!root) return [];
  const ids = new Set([root.pid]), found = [];
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); found.push(row); changed = true; } }
  return found;
}

async function bashChildren(t) {
  const { stdout } = await run(path.join(path.dirname(t.exe), 'ps.exe'), ['-W'], { windowsHide: true, timeout: 10000 }).catch(() => { throw error(500, 'Git Bash 자식 프로세스를 찾지 못했어요'); });
  return parseBashChildren(t, stdout);
}

export class TerminalManager extends EventEmitter {
  constructor({ maxTerminals = 8, getSession, onOutput = () => {} } = {}) {
    super(); this.maxTerminals = Math.max(1, Math.min(64, Math.trunc(Number(maxTerminals) || 8))); this.getSession = getSession; this.onOutput = onOutput; this.terminals = new Map(); this.disposing = false;
  }
  snapshot(t) { return { id: t.id, sessionId: t.sessionId, shell: t.shell, cwd: t.cwd, pid: t.child.pid, running: t.running, ready: t.ready, closed: t.closed, code: t.code, commandCode: t.commandCode, seq: t.seq }; }
  get(id) { const t = this.terminals.get(id); if (!t) throw error(404, '터미널을 찾지 못했어요'); return t; }
  list(sessionId) { return [...this.terminals.values()].filter((t) => !sessionId || t.sessionId === sessionId).map((t) => this.snapshot(t)); }
  state(t) { this.emit('event', { type: 'term_state', ...this.snapshot(t) }); }
  output(t, chunk, stream) {
    if (!chunk) return;
    // 줄 없는 출력도 메모리를 무한히 쓰지 않도록 2MB를 함께 제한한다.
    const ev = { type: 'term', id: t.id, sessionId: t.sessionId, chunk, stream, seq: ++t.seq };
    const last = t.buffer.at(-1);
    if (last?.stream === stream && Buffer.byteLength(last.chunk) + Buffer.byteLength(chunk) <= 8192) { last.chunk += chunk; last.seq = ev.seq; }
    else t.buffer.push({ ...ev });
    t.bytes += Buffer.byteLength(chunk); t.lines += (chunk.match(/\n/g) || []).length;
    while (t.buffer.length && (t.lines > 2000 || t.bytes > 2 * 1024 * 1024)) {
      const first = t.buffer[0];
      if (t.lines > 2000 && first.chunk.includes('\n')) {
        let cut = 0, count = 0;
        const removeLines = Math.min(t.lines - 2000, (first.chunk.match(/\n/g) || []).length);
        while (count < removeLines) { cut = first.chunk.indexOf('\n', cut) + 1; count++; }
        const removed = first.chunk.slice(0, cut); first.chunk = first.chunk.slice(cut); t.lines -= count; t.bytes -= Buffer.byteLength(removed);
        if (first.chunk) continue;
      } else if (t.bytes > 2 * 1024 * 1024) {
        const bytes = Buffer.from(first.chunk); let cut = Math.min(bytes.length, t.bytes - 2 * 1024 * 1024);
        while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut++;
        const removed = bytes.subarray(0, cut).toString('utf8'); first.chunk = bytes.subarray(cut).toString('utf8');
        t.lines -= (removed.match(/\n/g) || []).length; t.bytes -= cut;
        if (first.chunk) continue;
      } else { t.lines -= (first.chunk.match(/\n/g) || []).length; t.bytes -= Buffer.byteLength(first.chunk); }
      t.buffer.shift();
    }
    this.onOutput(t.sessionId, chunk); this.emit('event', ev);
  }
  buffer(id) { const t = this.get(id); return { terminal: this.snapshot(t), chunks: t.buffer.map((x) => ({ ...x })), seq: t.seq, limit: 2000 }; }
  async create({ sessionId, shell = 'powershell' } = {}) {
    if (this.disposing) throw error(503, '허브가 종료 중이에요');
    if ([...this.terminals.values()].filter((t) => !t.closed).length >= this.maxTerminals) throw error(429, `터미널은 동시에 ${this.maxTerminals}개까지 열 수 있어요`);
    const session = this.getSession?.(sessionId); if (!session) throw error(404, '세션을 찾지 못했어요');
    const cwd = session.cwd; if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw error(400, '세션 폴더를 찾지 못했어요');
    if (process.platform !== 'win32') throw error(501, '터미널은 Windows 허브에서 지원해요');
    if (!['powershell', 'cmd', 'bash'].includes(shell)) throw error(400, '지원하지 않는 셸이에요');
    const prefix = `__HUB_${crypto.randomBytes(16).toString('hex')}__`, id = crypto.randomUUID();
    const scriptDir = shell === 'cmd' ? fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cmd-')) : null;
    let exe, args;
    if (shell === 'powershell') { exe = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded(powershellBootstrap(prefix, cwd))]; }
    else if (shell === 'cmd') { exe = 'cmd.exe'; args = ['/D', '/Q', '/K', 'chcp 65001>nul & prompt $S']; }
    else {
      exe = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], path.join(process.env.LOCALAPPDATA || '', 'Programs')].filter(Boolean).map((base) => path.join(base, 'Git', 'usr', 'bin', 'bash.exe')).find((file) => fs.existsSync(file));
      if (!exe) throw error(400, 'Git Bash를 찾지 못했어요');
      args = ['--noprofile', '--norc'];
    }
    const child = guardChild(spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LANG: 'ko_KR.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color', ...(scriptDir ? { HUB_TERMINAL_SCRIPT: path.join(scriptDir, 'command.cmd') } : {}) } }));
    const t = { id, sessionId, shell, cwd, child, exe, scriptDir, prefix, running: false, ready: false, closed: false, code: null, commandCode: null, buffer: [], lines: 0, bytes: 0, seq: 0, pending: '', interrupting: null, interrupted: false };
    this.terminals.set(id, t);
    child.stdin.on('error', () => {});
    const exited = new Promise((resolve) => child.once('close', (code) => { t.closed = true; t.ready = false; t.running = false; t.code = code; this.state(t); this.emit('event', { type: 'term_exit', id, sessionId, code }); resolve(); })); t.exited = exited;
    const ready = new Promise((resolve, reject) => {
      t.resolveReady = resolve;
      child.once('error', () => reject(error(500, '셸을 시작하지 못했어요')));
      child.once('close', () => { if (!t.ready) reject(error(500, '셸이 시작 중 종료됐어요')); });
    });
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (bytes) => this.receive(t, decoders[stream].write(bytes), stream));
      child[stream].on('end', () => { this.receive(t, decoders[stream].end(), stream); if (stream === 'stdout' && t.pending) { this.output(t, t.pending, stream); t.pending = ''; } });
    }
    if (shell === 'cmd') child.stdin.write(`echo ${prefix}R:%cd%\r\n`);
    if (shell === 'bash') child.stdin.write(`export LANG=C.UTF-8 LC_ALL=C.UTF-8\n__hub_run(){ eval "$1"; }\ntrap 'return 130' INT\nprintf '${prefix}R:%s\\n' "$PWD"\n`);
    let timer;
    try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(error(504, '셸 시작 시간이 초과됐어요')), 20000); })]); this.state(t); return this.snapshot(t); }
    catch (e) { await this.close(id); throw e; } finally { clearTimeout(timer); }
  }
  receive(t, chunk, stream) {
    if (stream === 'stderr') { this.output(t, chunk, stream); return; }
    t.pending += chunk;
    while (t.pending) {
      const index = t.pending.indexOf(t.prefix);
      if (index < 0) {
        let keep = 0; for (let n = 1; n < t.prefix.length && n <= t.pending.length; n++) if (t.pending.endsWith(t.prefix.slice(0, n))) keep = n;
        this.output(t, t.pending.slice(0, t.pending.length - keep), stream); t.pending = t.pending.slice(t.pending.length - keep); return;
      }
      if (index > 0) { this.output(t, t.pending.slice(0, index), stream); t.pending = t.pending.slice(index); }
      const end = t.pending.indexOf('\n'); if (end < 0) return;
      const message = t.pending.slice(t.prefix.length, end).replace(/\r$/, ''); t.pending = t.pending.slice(end + 1);
      const kind = message.slice(0, 1), value = message.slice(2);
      if (kind === 'O' || kind === 'E') this.output(t, Buffer.from(value, 'base64').toString('utf8'), kind === 'E' ? 'stderr' : 'stdout');
      else if (kind === 'R') { if (t.shell === 'powershell') t.cwd = Buffer.from(value, 'base64').toString('utf8'); t.ready = true; t.resolveReady(); }
      else if (kind === 'S') {
        const colon = value.indexOf(':'); t.commandCode = t.interrupted ? 130 : Number(value.slice(0, colon));
        t.cwd = t.shell === 'powershell' ? Buffer.from(value.slice(colon + 1), 'base64').toString('utf8') : value.slice(colon + 1);
        t.running = false; this.state(t);
      }
    }
  }
  input(id, text) {
    const t = this.get(id);
    if (t.closed || !t.ready) throw error(409, '터미널이 닫혔거나 준비 중이에요');
    if (t.running || t.interrupting) throw error(409, '명령이 실행 중이에요. 먼저 중지해 주세요');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024 || text.includes('\0')) throw error(400, '명령은 비어 있지 않은 64KB 이하의 글로 보내 주세요');
    t.running = true; t.interrupted = false; t.commandCode = null; this.state(t);
    if (t.shell === 'powershell') t.child.stdin.write(`C:${Buffer.from(text).toString('base64')}\n`);
    else if (t.shell === 'cmd') {
      // cmd의 UTF-8 파이프 입력은 한글을 잃는다. UTF-8 배치 파일을 ASCII 입력으로 호출한다.
      fs.writeFileSync(path.join(t.scriptDir, 'command.cmd'), `@echo off\r\n@ver >nul\r\n${text.replace(/\r?\n/g, '\r\n')}\r\n`, 'utf8');
      t.child.stdin.write(`call "%HUB_TERMINAL_SCRIPT%"\r\necho ${t.prefix}S:%errorlevel%:%cd%\r\n`);
    } else t.child.stdin.write(`__hub_run '${text.replace(/'/g, "'\\''")}'\nprintf '${t.prefix}S:%s:%s\\n' "$?" "$PWD"\n`);
    return this.snapshot(t);
  }
  async interrupt(id) {
    const t = this.get(id); if (t.closed || !t.running) return this.snapshot(t);
    if (t.interrupting) { await t.interrupting; return this.snapshot(t); }
    t.interrupted = true;
    t.interrupting = (async () => {
      // 부모 PID로 찾은 자식만 종료한다. 셸 PID는 포함하지 않는다.
      const children = await descendants(t.child.pid);
      if (t.shell === 'bash') {
        // MSYS 자식은 taskkill만으로 대기가 풀리지 않아 POSIX 신호를 먼저 보낸다.
        const rows = await bashChildren(t), posix = rows.map((row) => row.pid);
        if (posix.length) await run(t.exe, ['-c', `kill -TERM ${posix.join(' ')} 2>/dev/null || true`], { windowsHide: true, timeout: 10000 });
        for (const row of rows) if (!children.includes(row.winpid) && row.winpid !== t.child.pid) children.push(row.winpid);
      }
      await Promise.all(children.reverse().map(killTree));
      if (t.shell === 'powershell' && !t.closed && t.running) t.child.stdin.write('I\n');
    })();
    try { await t.interrupting; return this.snapshot(t); } finally { t.interrupting = null; }
  }
  async close(id) {
    const t = this.get(id);
    if (!t.closing) t.closing = (async () => {
      if (!t.closed) {
        if (t.shell === 'bash') await Promise.all((await bashChildren(t)).map((row) => killTree(row.winpid)));
        await killTree(t.child.pid); await t.exited;
      }
      if (t.scriptDir) fs.rmSync(t.scriptDir, { recursive: true, force: true });
      this.terminals.delete(id); return { removed: true };
    })();
    return t.closing;
  }
  async closeAll() { this.disposing = true; await Promise.all([...this.terminals.keys()].map((id) => this.close(id))); }
  closeAllSync() {
    for (const t of this.terminals.values()) {
      if (!t.closed && t.shell === 'bash') {
        const { stdout } = spawnSync(path.join(path.dirname(t.exe), 'ps.exe'), ['-W'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        for (const row of parseBashChildren(t, stdout || '')) spawnSync('taskkill.exe', ['/PID', String(row.winpid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      }
      if (!t.closed && t.child.pid) spawnSync('taskkill.exe', ['/PID', String(t.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
      if (t.scriptDir) fs.rmSync(t.scriptDir, { recursive: true, force: true });
    }
  }
}
