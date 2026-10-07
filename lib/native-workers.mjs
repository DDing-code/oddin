// 소유한 CLI 자식만 제어한다. 앱 daemon과 사용량 조회 프로세스는 연결하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnv, codexCommand, guardChild, killChildTree } from './util.mjs';
import { noteClaudeRateLimit } from './usage.mjs';
import { permissionSetting, codexPolicy, promptBridge, ToolRecords } from './prompts.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; };
async function bounded(p, ms = 10000) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('CLI 수신 확인 시간 초과'), { uncertain: true })), ms); })]); }
  finally { clearTimeout(timer); }
}
export function killOwned(child) { killChildTree(child); }
function transport(opts, command, args, onMessage) {
  fs.mkdirSync(opts.runDir, { recursive: true });
  const shell = /\.(cmd|bat)$/i.test(command) || !!opts.toolCfg?.shell || (process.platform === 'win32' && command === 'claude') || (/[\s"]/u.test(command) && !fs.existsSync(command));
  const passed = shell ? args.map((a) => /[\s&()^|<>]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a) : args;
  if (!fs.existsSync(opts.cwd)) throw new Error(`작업 폴더가 없어요: ${opts.cwd}`);
  const child = guardChild(spawn(command, passed, { cwd: opts.cwd, env: childEnv({ ODDIN_WORKER: '1' }), windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] }));
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
  let permission = opts.readOnly ? 'readonly' : permissionSetting({}, opts.permission ?? settings.permission), planning = tool === 'codex' && permission === 'plan';
  const owner = randomUUID(), items = new Map(), records = new ToolRecords(tool, emit), abandoned = new Set();
  let requestEpoch = 0, planGate = false, connectionClosed = false, planRejected = false;
  let timer, remaining = opts.timeoutMs, clockAt = Date.now(), waits = 0;
  const armTimer = () => { if (timer && remaining) remaining = Math.max(1, remaining - (Date.now() - clockAt)); clearTimeout(timer); timer = null; clockAt = Date.now(); if (remaining) timer = setTimeout(() => { timedOut = true; opts.prompts?.cancel({ owner, status: 'expired' }); killOwned(io.child); finish(false, '시간 초과'); }, remaining); };
  const ask = async (spec) => {
    if (!opts.prompts) return { action: 'deny', message: '이 실행에는 사용자 응답 연결이 없습니다' };
    if (!waits++) { clearTimeout(timer); timer = null; if (remaining) remaining = Math.max(1, remaining - (Date.now() - clockAt)); emit({ kind: 'waiting', waiting: true }); }
    try { return await opts.prompts.request(spec, { permission, owner }); }
    finally { if (!--waits) { emit({ kind: 'waiting', waiting: false }); if (active && !cancelled && !timedOut) armTimer(); } }
  };
  const bridge = promptBridge({ ...opts, planFallback: () => text }, ask, () => permission, (id) => items.get(id));
  const receipt = (mode, error = null, status = 'delivered') => ({ status: cancelled || timedOut ? 'failed' : status, mode, sessionId, turnId, generation, error: cancelled ? '작업이 중지되었습니다' : timedOut ? '시간 초과' : error });
  const finish = (ok, error = null) => {
    opts.prompts?.cancel({ owner, status: cancelled ? 'cancelled' : 'expired' });
    records.close(error || '도구 결과를 받기 전에 실행이 종료되었습니다');
    clearTimeout(timer);
    timer = null;
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
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--replay-user-messages', '--verbose', '--permission-mode', { auto: 'bypassPermissions', edits: 'acceptEdits', ask: 'manual', plan: 'plan', readonly: 'manual' }[permission], '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio'];
    if (settings.model || cfg.model) args.push('--model', settings.model || cfg.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    if (opts.browser) args.push('--chrome'); // 사용자 Chrome 을 직접 조작하는 Claude in Chrome 도구 (작업 단계만)
    for (const d of opts.addDirs || []) args.push('--add-dir', d);
    args.push(...(cfg.extraArgs || []));
    if (opts.readOnly) args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch');
    const user = (prompt, attachments, uuid) => ({ type: 'user', uuid, session_id: sessionId || '', parent_tool_use_id: null, message: { role: 'user', content: [...(attachments || []).map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: fs.readFileSync(a.path).toString('base64') } })), { type: 'text', text: prompt }] } });
    io = transport(opts, command, args, (ev) => {
      if (cancelled || timedOut || planRejected) return;
      if (ev.type === 'control_request' && ev.request?.subtype === 'can_use_tool') {
        const epoch = requestEpoch;
        (async () => {
          let result = await bridge.claude({ ...ev.request, cliRequestId: ev.request_id });
          if (cancelled || timedOut || abandoned.has(ev.request_id)) return;
          if (epoch !== requestEpoch) result = { behavior: 'deny', message: '수정 지시로 이전 요청이 취소되었습니다' };
          const { planApproved, planRejected: rejected, ...response } = result;
          if (planApproved) { await control({ subtype: 'set_permission_mode', mode: 'acceptEdits' }); permission = 'edits'; }
          io.send({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response } });
          if (rejected) { planRejected = true; finish(false, response.message); killOwned(io.child); }
        })().catch((e) => { if (!cancelled && !timedOut) { finish(false, e.message); killOwned(io.child); } });
      }
      else if (ev.type === 'control_cancel_request') { abandoned.add(ev.request_id); opts.prompts?.cancel({ owner, cliRequestId: ev.request_id }); }
      else if (ev.type === 'control_response') { const r = ev.response || {}; const d = controls.get(r.request_id); if (d) { controls.delete(r.request_id); r.subtype === 'success' ? d.resolve(r.response || {}) : d.reject(new Error(r.error || 'CLI 중단에 실패했습니다')); } }
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
        // 생각 블록: 최신 모델은 내용을 비워 보내므로 내용이 있을 때만 남긴다 (추론 과정 보기용)
        if (c.type === 'thinking' && String(c.thinking || '').trim()) emit({ kind: 'thinking', text: String(c.thinking).trim().slice(0, 2000) });
        if (c.type === 'tool_use') records.claude(c);
      }
      else if (ev.type === 'user') { echo(ev.uuid); for (const c of ev.message?.content || []) { records.claude(c); if (c.type === 'tool_result' && c.is_error) emit({ kind: 'tool_error', text: String(c.content || '').slice(0, 500) }); } }
      else if (ev.type === 'result') {
        sessionId = ev.session_id || sessionId; text = ev.result || text; usage = ev.usage;
        claudeIdle = true; rawResult.resolve();
        if (permission === 'plan' && !draining && !ev.is_error && !background.size) {
          const epoch = requestEpoch;
          (async () => {
            const answer = await bridge.plan(text);
            if (cancelled || timedOut || epoch !== requestEpoch) return;
            if (answer.action === 'approve') { await control({ subtype: 'set_permission_mode', mode: 'acceptEdits' }); permission = 'edits'; await begin('승인된 계획을 실행하세요.', [], randomUUID(), true); }
            else if (answer.action === 'revise') await begin(`계획만 다시 작성하고 ExitPlanMode로 승인을 요청하세요. 사용자 수정 의견: ${answer.message}`, [], randomUUID(), true);
            else { planRejected = true; finish(false, answer.message || '계획이 거절되었습니다'); }
          })().catch((e) => { finish(false, e.message); killOwned(io.child); });
        }
        else if (draining || ev.is_error || !background.size) finish(!ev.is_error, ev.is_error ? ev.result || ev.terminal_reason : null);
        else emit({ kind: 'background', count: background.size, text: '백그라운드 작업 완료 뒤의 최종 결과를 기다립니다' });
      }
    });
    const control = async (request) => {
      const id = randomUUID(), d = deferred(); controls.set(id, d);
      try { io.send({ type: 'control_request', request_id: id, request }); return await bounded(d.promise, opts.ackTimeoutMs); }
      finally { controls.delete(id); }
    };
    invocation = recordInvocation(opts.runDir, command, settings, args, { transport: 'stream-json', resumeSessionId: opts.resumeSessionId || null });
    begin = async (prompt, attachments, id, continuingPlan = false) => {
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      generation++; if (!continuingPlan) latest = deferred(); active = true; text = ''; claudeIdle = false; rawResult = deferred();
      records.nextTurn(); armTimer();
      io.send(user(prompt, attachments, id));
      await waitEcho(id);
      return receipt('native-interrupt');
    };
    const initialId = randomUUID();
    control({ subtype: 'initialize' }).then(() => { if (!cancelled && !timedOut) io.send(user(opts.prompt, opts.attachments, initialId)); }).catch((e) => { ready.reject(e); finish(false, e.message); killOwned(io.child); });
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
      if (ev.id !== undefined && ev.method) {
        const p = ev.params || {};
        if (p.threadId && sessionId && p.threadId !== sessionId) { send({ id: ev.id, error: { code: -32602, message: 'CLI 스레드가 일치하지 않습니다' } }); return; }
        bridge.codex(ev.method, { ...p, cliRequestId: ev.id }).then((result) => {
          if (cancelled || timedOut || connectionClosed) return;
          const { hubMessage, ...response } = result;
          if (hubMessage && active && turnId) io.rpc('turn/steer', { threadId: sessionId, expectedTurnId: turnId, input: [{ type: 'text', text: `사용자의 승인 거절 사유: ${hubMessage}`, text_elements: [] }] }).catch((e) => emit({ kind: 'stderr', text: `거절 사유의 추가 전달을 확인하지 못했습니다: ${e.message}` }));
          send({ id: ev.id, result: response });
        }).catch((e) => { if (!cancelled && !timedOut && !connectionClosed) { try { send({ id: ev.id, error: { code: e.status === -32601 ? -32601 : -32603, message: e.message } }); } catch {} } }); return;
      }
      const p = ev.params || {}, it = p.item || {};
      if (p.threadId && sessionId && p.threadId !== sessionId) return;
      if (ev.method === 'turn/started') { turnId = p.turn.id; active = true; emit({ kind: 'turn' }); }
      else if (ev.method === 'item/started' || ev.method === 'item/completed') {
        items.set(it.id, it); records.codex(it, ev.method === 'item/completed');
        if (it.type === 'userMessage') echo(it.clientId);
        if (ev.method === 'item/completed' && it.type === 'agentMessage') { text = it.text || ''; emit({ kind: 'message', text }); }
        // Codex 생각 요약(짧은 제목들) → 추론 과정 보기용 기록
        if (ev.method === 'item/completed' && it.type === 'reasoning') {
          const sum = [...(it.summary || []), ...(it.content || [])].map((x) => String(typeof x === 'string' ? x : x?.text || '').trim()).filter(Boolean).join('\n');
          if (sum) emit({ kind: 'thinking', text: sum.slice(0, 2000) });
        }
      }
      else if (ev.method === 'thread/tokenUsage/updated') usage = p.tokenUsage;
      else if (ev.method === 'turn/completed' && (!turnId || p.turn.id === turnId)) {
        turnId = p.turn.id;
        if (planning && p.turn.status === 'completed') {
          planGate = true;
          const epoch = requestEpoch;
          (async () => {
            const answer = await bridge.plan(text);
            if (cancelled || timedOut || !planning || epoch !== requestEpoch) return;
            planGate = false;
            if (answer.action === 'approve') { planning = false; permission = 'edits'; await begin('승인된 계획을 실행하세요.', [], null, true); }
            else if (answer.action === 'revise') await begin(`파일을 바꾸지 말고 계획만 다시 작성하세요. 사용자 수정 의견: ${answer.message}`, [], null, true);
            else finish(false, answer.message || '계획이 거절되었습니다');
          })().catch((e) => finish(false, e.message));
        } else finish(p.turn.status === 'completed', p.turn.error?.message || (p.turn.status === 'interrupted' ? '턴 중단' : null));
      }
      else if (ev.method === 'error') emit({ kind: 'tool_error', text: p.error?.message || 'CLI 오류' });
    });
    invocation = recordInvocation(opts.runDir, command, settings, args, { transport: 'app-server', resumeSessionId: opts.resumeSessionId || null, addDirs: opts.addDirs || [] });
    const input = (prompt, attachments) => [{ type: 'text', text: prompt, text_elements: [] }, ...(attachments || []).map((a) => ({ type: 'localImage', path: a.path }))];
    begin = async (prompt, attachments, id, initial = false) => {
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      if (!initial) { generation++; latest = deferred(); }
      records.nextTurn();
      armTimer();
      active = true; text = ''; turnId = null;
      const params = { threadId: sessionId, input: input(prompt, attachments), ...(id ? { clientUserMessageId: id } : {}), ...(settings.effort ? { effort: settings.effort } : {}) };
      const policy = codexPolicy(permission); params.approvalPolicy = policy.approvalPolicy; params.sandboxPolicy = policy.sandboxPolicy;
      if (opts.schemaFile) params.outputSchema = JSON.parse(fs.readFileSync(opts.schemaFile, 'utf8'));
      const r = await io.rpc('turn/start', params);
      turnId = r.turn.id; emit({ kind: 'turn' });
      return receipt(initial ? 'prompt' : 'native-steer');
    };
    (async () => {
      await io.rpc('initialize', { clientInfo: { name: 'ai-hub', title: 'AI Hub', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      io.send({ method: 'initialized' });
      const policy = codexPolicy(permission);
      const params = { cwd: opts.cwd, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, ephemeral: false, ...(settings.model || cfg.model ? { model: settings.model || cfg.model } : {}) };
      const r = await io.rpc(opts.resumeSessionId ? 'thread/resume' : 'thread/start', { ...params, ...(opts.resumeSessionId ? { threadId: opts.resumeSessionId } : {}) });
      sessionId = r.thread.id;
      if (opts.resumeSessionId && sessionId !== opts.resumeSessionId) throw new Error('재개된 CLI 세션 ID가 일치하지 않습니다');
      emit({ kind: 'init', model: r.model || settings.model });
      opts.initialReceipt = begin(planning ? `먼저 계획만 작성하세요. 파일 변경이나 명령으로 변경하지 마세요. 계획 승인 뒤 같은 스레드에서 실행 지시를 받습니다.\n\n${opts.prompt}` : opts.prompt, opts.attachments, null, true);
      await opts.initialReceipt; ready.resolve();
    })().catch((e) => { ready.reject(e); finish(false, e.message); });
    opts._nativeIntercept = async (x) => {
      await bounded(ready.promise, opts.ackTimeoutMs);
      if (cancelled || timedOut) throw new Error('작업이 중지되었습니다');
      if (planGate) { planGate = false; finish(false, '수정 지시로 계획을 다시 작성합니다'); return begin(`계획만 작성하고 파일을 바꾸지 마세요. ${x.text}`, x.attachments, x.messageId); }
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
  io.done.then((e) => { connectionClosed = true; ready.reject(e); for (const d of echoes.values()) d.reject(Object.assign(e, { uncertain: true })); for (const d of controls.values()) d.reject(e); if (active) finish(false, e?.message || 'CLI 연결 종료'); });
  armTimer();
  const settle = async () => {
    for (;;) {
      const q = queue; await q; const d = latest; const result = await d.promise; await invocation;
      if (q === queue && d === latest) return result;
    }
  };
  return { promise: settle(), settle, initialReceipt: async () => { await bounded(ready.promise, opts.ackTimeoutMs); await (opts.initialReceipt || Promise.resolve()); return receipt('prompt'); },
    getState: state,
    intercept(x) { const work = queue.then(async () => { if (cancelled || timedOut) return receipt(null, '작업이 중지되었습니다', 'failed'); requestEpoch++; opts.prompts?.cancel({ owner }); try { return await opts._nativeIntercept(x); } catch (e) { return receipt(tool === 'codex' ? 'native-steer' : 'native-interrupt', e.message, e.uncertain ? 'uncertain' : 'failed'); } }); queue = work.then(() => {}); return work; },
    cancel() { cancelled = true; opts.prompts?.cancel({ owner }); killOwned(io.child); finish(false, '사용자 중지'); },
    shutdown: () => bounded(io.done, opts.drainTimeoutMs),
    close() { clearTimeout(timer); io.close(); setTimeout(() => killOwned(io.child), 1000).unref(); },
  };
}
