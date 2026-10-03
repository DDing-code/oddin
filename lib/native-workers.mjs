// 소유한 CLI 자식만 제어한다. 앱 daemon과 사용량 조회 프로세스는 연결하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnv, codexCommand } from './util.mjs';
import { noteClaudeRateLimit } from './usage.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; };
async function bounded(p, ms = 10000) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('CLI 수신 확인 시간 초과'), { uncertain: true })), ms); })]); }
  finally { clearTimeout(timer); }
}
export function killOwned(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}
function transport(opts, command, args, onMessage) {
  fs.mkdirSync(opts.runDir, { recursive: true });
  const shell = /\.(cmd|bat)$/i.test(command) || !!opts.toolCfg?.shell || (process.platform === 'win32' && command === 'claude');
  const passed = shell ? args.map((a) => /[\s&()^|<>]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a) : args;
  const child = spawn(command, passed, { cwd: opts.cwd, env: childEnv(), windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', closed = false;
  const done = deferred();
  const requests = new Map(); let serial = 0;
  const log = (x) => {
    // 인증 자료는 저장하지 않는다. 제어 알림과 응답을 기록한다.
    if (/account|auth|token/i.test(x.method || '')) return;
    fs.appendFileSync(path.join(opts.runDir, 'events.jsonl'), JSON.stringify(x, (k, v) => /token|apiKey|authorization/i.test(k) ? '[비공개]' : v) + '\n');
  };
  const send = (x) => {
    if (closed || child.stdin.destroyed) throw new Error('CLI 제어 연결이 닫혔습니다');
    child.stdin.write(JSON.stringify(x) + '\n');
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let x; try { x = JSON.parse(line); } catch { continue; }
      log(x);
      if (x.id !== undefined && requests.has(x.id) && ('result' in x || 'error' in x)) {
        const d = requests.get(x.id); requests.delete(x.id);
        if (x.error) d.reject(Object.assign(new Error(x.error.message), { rpcCode: x.error.code })); else d.resolve(x.result);
      } else onMessage(x, send);
    }
  });
  child.stderr.on('data', (s) => fs.appendFileSync(path.join(opts.runDir, 'stderr.log'), s));
  child.stdin.on('error', () => {});
  const end = (e) => { if (closed) return; closed = true; for (const d of requests.values()) d.reject(e || new Error('CLI 연결 종료')); requests.clear(); done.resolve(e); };
  child.on('error', end); child.on('close', (code) => end(new Error(`CLI 종료 코드 ${code}`)));
  return { child, done: done.promise, send, rpc: async (method, params) => {
    const id = ++serial, d = deferred(); requests.set(id, d);
    try { send({ id, method, params }); return await bounded(d.promise, opts.ackTimeoutMs); }
    finally { requests.delete(id); }
  }, close: () => { if (!closed) child.stdin.end(); } };
}

export function runNative(opts, recordInvocation) {
  const tool = opts.tool, settings = opts.settings || {}, cfg = opts.toolCfg || {};
  let sessionId = null, turnId = null, generation = 1, cancelled = false, timedOut = false, active = true, latest = deferred(), text = '', usage = null;
  const ready = deferred(), echoes = new Map(), seen = new Set(), controls = new Map();
  let background = new Set(), backgroundLevelSeen = false, claudeIdle = false, rawResult = deferred(), draining = false;
  let queue = Promise.resolve(), io, invocation;
  const state = () => ({ tool, transport: tool === 'codex' ? 'app-server' : 'stream-json', sessionId, turnId, generation, ready: !!sessionId, active });
  const emit = (ev) => opts.onEvent?.({ ...ev, ...state() });
  const receipt = (mode, error = null, status = 'delivered') => ({ status: cancelled || timedOut ? 'failed' : status, mode, sessionId, turnId, generation, error: cancelled ? '작업이 중지되었습니다' : timedOut ? '시간 초과' : error });
  const finish = (ok, error = null) => {
    active = false;
    const res = { ok: ok && !cancelled && !timedOut, tool, text, sessionId, turnId, generation, usage, costUsd: null, cancelled, timedOut, error, exitCode: ok ? 0 : 1 };
    fs.writeFileSync(path.join(opts.runDir, `turn-${generation}-result.md`), text || '');
    emit({ kind: 'result', text, isError: !res.ok, usage }); latest.resolve(res);
  };
  const echo = (id) => { if (!id) return; seen.add(id); echoes.get(id)?.resolve(true); };
  const waitEcho = async (id) => { if (seen.has(id)) return; const d = deferred(); echoes.set(id, d); try { await bounded(d.promise, opts.ackTimeoutMs); } finally { echoes.delete(id); } };
  let begin;
  if (tool === 'claude') {
    const command = cfg.command || 'claude';
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--verbose', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'];
    if (settings.model || cfg.model) args.push('--model', settings.model || cfg.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    for (const d of opts.addDirs || []) args.push('--add-dir', d);
    args.push(...(cfg.extraArgs || []));
    const user = (prompt, attachments, uuid) => ({ type: 'user', uuid, session_id: sessionId || '', parent_tool_use_id: null, message: { role: 'user', content: [...(attachments || []).map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: fs.readFileSync(a.path).toString('base64') } })), { type: 'text', text: prompt }] } });
    io = transport(opts, command, args, (ev) => {
      if (cancelled || timedOut) return;
      if (ev.type === 'control_response') { const r = ev.response || {}; const d = controls.get(r.request_id); if (d) { controls.delete(r.request_id); r.subtype === 'success' ? d.resolve(r.response || {}) : d.reject(new Error(r.error || 'CLI 중단에 실패했습니다')); } }
      else if (ev.type === 'system' && ev.subtype === 'init') { sessionId = ev.session_id; if (opts.resumeSessionId && sessionId !== opts.resumeSessionId) { ready.reject(new Error('재개된 CLI 세션 ID가 일치하지 않습니다')); finish(false, '재개된 CLI 세션 ID가 일치하지 않습니다'); } else { ready.resolve(); emit({ kind: 'init', model: ev.model }); } }
      else if (ev.type === 'rate_limit_event') noteClaudeRateLimit(ev);
      else if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) {
        // 이 이벤트는 전체 교체다. 시작/완료 이벤트의 순서와 결합하면 오래된 작업이 남을 수 있다.
        backgroundLevelSeen = true; background = new Set(ev.tasks.filter((t) => !t.ambient).map((t) => t.task_id));
        emit({ kind: 'background', count: background.size });
      }
      else if (ev.type === 'system' && !backgroundLevelSeen && ev.subtype === 'task_started' && !ev.ambient && ev.is_backgrounded !== false) background.add(ev.task_id);
      else if (ev.type === 'system' && !backgroundLevelSeen && ev.subtype === 'task_updated') {
        if (ev.patch?.ambient || ev.patch?.is_backgrounded === false) background.delete(ev.task_id);
        else if (ev.patch?.is_backgrounded) background.add(ev.task_id);
      }
      else if (ev.type === 'system' && !backgroundLevelSeen && ev.subtype === 'task_notification') background.delete(ev.task_id);
      else if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
        if (claudeIdle) { claudeIdle = false; rawResult = deferred(); }
        if (c.type === 'text') { text = c.text; emit({ kind: 'message', text: c.text }); }
        if (c.type === 'tool_use') emit({ kind: 'tool', name: c.name, detail: String(c.input?.command || c.input?.file_path || '').slice(0, 300) });
      }
      else if (ev.type === 'user') { echo(ev.uuid); for (const c of ev.message?.content || []) if (c.type === 'tool_result' && c.is_error) emit({ kind: 'tool_error', text: String(c.content || '').slice(0, 500) }); }
      else if (ev.type === 'result') {
        sessionId = ev.session_id || sessionId; text = ev.result || text; usage = ev.usage;
        claudeIdle = true; rawResult.resolve();
        if (draining || ev.is_error || !background.size) finish(!ev.is_error, ev.is_error ? ev.result || ev.terminal_reason : null);
        else emit({ kind: 'background', count: background.size, text: '백그라운드 작업 완료 뒤의 최종 결과를 기다립니다' });
      }
    });
    invocation = recordInvocation(opts.runDir, command, settings, args, { transport: 'stream-json', resumeSessionId: opts.resumeSessionId || null });
    begin = async (prompt, attachments, id) => {
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      generation++; latest = deferred(); active = true; text = ''; claudeIdle = false; rawResult = deferred();
      io.send(user(prompt, attachments, id));
      await waitEcho(id);
      return receipt('native-interrupt');
    };
    const initialId = randomUUID();
    io.send(user(opts.prompt, opts.attachments, initialId));
    // 최초 UUID도 대기 작업의 수신 확인에 사용한다.
    opts.initialReceipt = waitEcho(initialId);
    opts.initialReceipt.catch(() => {});
    opts._nativeIntercept = async (x) => {
      await bounded(ready.promise, opts.ackTimeoutMs);
      if (active) {
        const prior = claudeIdle ? Promise.resolve() : rawResult.promise, id = randomUUID(), d = deferred(); controls.set(id, d); draining = true;
        if (claudeIdle) finish(false, '수정 지시로 이어서 진행');
        try { io.send({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } }); const r = await bounded(d.promise, opts.ackTimeoutMs); await bounded(prior, opts.drainTimeoutMs); if (r.still_queued?.length) throw Object.assign(new Error('기존 메시지가 CLI 대기열에 남아 새 지시의 전달 순서를 확인할 수 없습니다'), { uncertain: true }); }
        finally { controls.delete(id); draining = false; }
      }
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      return begin(x.text, x.attachments, x.messageId);
    };
  } else {
    const command = codexCommand(cfg), args = ['app-server', '--listen', 'stdio://', ...(cfg.extraArgs || [])];
    io = transport(opts, command, args, (ev, send) => {
      if (cancelled || timedOut) return;
      if (ev.id !== undefined && ev.method) { send({ id: ev.id, error: { code: -32601, message: '이 실행은 대화형 승인 요청을 지원하지 않습니다' } }); return; }
      const p = ev.params || {}, it = p.item || {};
      if (p.threadId && sessionId && p.threadId !== sessionId) return;
      if (ev.method === 'turn/started') { turnId = p.turn.id; active = true; emit({ kind: 'turn' }); }
      else if (ev.method === 'item/started' || ev.method === 'item/completed') {
        if (it.type === 'userMessage') echo(it.clientId);
        if (ev.method === 'item/completed' && it.type === 'agentMessage') { text = it.text || ''; emit({ kind: 'message', text }); }
        if (ev.method === 'item/started' && it.type === 'commandExecution') emit({ kind: 'tool', name: 'Bash', detail: String(it.command || '').slice(0, 300) });
        if (ev.method === 'item/completed' && it.type === 'fileChange') emit({ kind: 'tool', name: 'Edit', detail: (it.changes || []).map((c) => c.path).join(', ').slice(0, 300) });
        if (it.type === 'mcpToolCall' && ev.method === 'item/started') emit({ kind: 'tool', name: `MCP ${it.server || ''}.${it.tool || ''}`, detail: '' });
      }
      else if (ev.method === 'thread/tokenUsage/updated') usage = p.tokenUsage;
      else if (ev.method === 'turn/completed' && (!turnId || p.turn.id === turnId)) { turnId = p.turn.id; finish(p.turn.status === 'completed', p.turn.error?.message || (p.turn.status === 'interrupted' ? '턴 중단' : null)); }
      else if (ev.method === 'error') emit({ kind: 'tool_error', text: p.error?.message || 'CLI 오류' });
    });
    invocation = recordInvocation(opts.runDir, command, settings, args, { transport: 'app-server', resumeSessionId: opts.resumeSessionId || null, addDirs: opts.addDirs || [] });
    const input = (prompt, attachments) => [{ type: 'text', text: prompt, text_elements: [] }, ...(attachments || []).map((a) => ({ type: 'localImage', path: a.path }))];
    begin = async (prompt, attachments, id, initial = false) => {
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      if (!initial) { generation++; latest = deferred(); }
      active = true; text = ''; turnId = null;
      const params = { threadId: sessionId, input: input(prompt, attachments), ...(id ? { clientUserMessageId: id } : {}), ...(settings.effort ? { effort: settings.effort } : {}) };
      if (opts.schemaFile) params.outputSchema = JSON.parse(fs.readFileSync(opts.schemaFile, 'utf8'));
      const r = await io.rpc('turn/start', params);
      turnId = r.turn.id; emit({ kind: 'turn' });
      return receipt(initial ? 'prompt' : 'native-steer');
    };
    (async () => {
      await io.rpc('initialize', { clientInfo: { name: 'ai-hub', title: 'AI Hub', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      io.send({ method: 'initialized' });
      const params = { cwd: opts.cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false, ...(settings.model || cfg.model ? { model: settings.model || cfg.model } : {}) };
      const r = await io.rpc(opts.resumeSessionId ? 'thread/resume' : 'thread/start', { ...params, ...(opts.resumeSessionId ? { threadId: opts.resumeSessionId } : {}) });
      sessionId = r.thread.id;
      if (opts.resumeSessionId && sessionId !== opts.resumeSessionId) throw new Error('재개된 CLI 세션 ID가 일치하지 않습니다');
      emit({ kind: 'init', model: r.model || settings.model });
      opts.initialReceipt = begin(opts.prompt, opts.attachments, null, true);
      await opts.initialReceipt; ready.resolve();
    })().catch((e) => { ready.reject(e); finish(false, e.message); });
    opts._nativeIntercept = async (x) => {
      await bounded(ready.promise, opts.ackTimeoutMs);
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      if (!active) return begin(x.text, x.attachments, x.messageId);
      const expected = turnId;
      try {
        const r = await io.rpc('turn/steer', { threadId: sessionId, expectedTurnId: expected, clientUserMessageId: x.messageId, input: input(x.text, x.attachments) });
        if (r.turnId !== expected) throw Object.assign(new Error('CLI가 다른 턴의 수신 확인을 반환했습니다'), { uncertain: true, receiptMismatch: true });
        return receipt('native-steer');
      } catch (e) {
        if (e.uncertain) { if (!e.receiptMismatch && seen.has(x.messageId)) return receipt('native-steer'); throw e; }
        if (cancelled || timedOut) throw e;
        if (!active) return begin(x.text, x.attachments, x.messageId);
        if (!/review|compact|steer.*support|steer.*allow/i.test(e.message)) throw e;
        const prior = latest.promise;
        await io.rpc('turn/interrupt', { threadId: sessionId, turnId: expected }); await bounded(prior, opts.drainTimeoutMs);
        return begin(x.text, x.attachments, x.messageId);
      }
    };
  }
  io.done.then((e) => { ready.reject(e); for (const d of echoes.values()) d.reject(Object.assign(e, { uncertain: true })); for (const d of controls.values()) d.reject(e); if (active) finish(false, e?.message || 'CLI 연결 종료'); });
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killOwned(io.child); finish(false, '시간 초과'); }, opts.timeoutMs) : null;
  const settle = async () => {
    for (;;) {
      const q = queue; await q; const d = latest; const result = await d.promise; await invocation;
      if (q === queue && d === latest) return result;
    }
  };
  return { promise: settle(), settle, initialReceipt: async () => { await bounded(ready.promise, opts.ackTimeoutMs); await (opts.initialReceipt || Promise.resolve()); return receipt('prompt'); },
    getState: state,
    intercept(x) { const work = queue.then(async () => { if (cancelled || timedOut) return receipt(null, '작업이 중지되었습니다', 'failed'); try { return await opts._nativeIntercept(x); } catch (e) { return receipt(tool === 'codex' ? 'native-steer' : 'native-interrupt', e.message, e.uncertain ? 'uncertain' : 'failed'); } }); queue = work.then(() => {}); return work; },
    cancel() { cancelled = true; killOwned(io.child); finish(false, '사용자 중지'); },
    shutdown: () => bounded(io.done, opts.drainTimeoutMs),
    close() { clearTimeout(timer); io.close(); setTimeout(() => killOwned(io.child), 1000).unref(); },
  };
}
