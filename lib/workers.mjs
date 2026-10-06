// Claude Code(-p stream-json) / Codex(exec --json) 워커 실행기
// 두 도구 모두 프롬프트를 stdin으로 넘긴다 (Windows 인용 문제 회피).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv, readText, codexCommand, guardChild, killChildTree } from './util.mjs';
import { noteClaudeRateLimit } from './usage.mjs';
import { markUnsupported, supportedFallback } from './router.mjs';
import { modelOptions } from './options.mjs';
import { runNative } from './native-workers.mjs';
import { ToolRecords, permissionSetting } from './prompts.mjs';

/**
 * @param {object} opts
 * @param {'claude'|'codex'} opts.tool
 * @param {string} opts.prompt
 * @param {string} opts.cwd
 * @param {string} opts.runDir   로그/결과 파일 저장 폴더
 * @param {object} opts.toolCfg  config.tools[tool]
 * @param {string[]} [opts.addDirs]
 * @param {{model?:string, effort?:string}} [opts.settings]  작업별 모델·추론 강도 ('' = CLI 기본)
 * @param {{path:string, mime:string}[]} [opts.attachments]   이미지 첨부
 * @param {string} [opts.schemaFile]  (codex) 최종 응답 JSON 스키마 파일
 * @param {boolean} [opts.jsonAnswer] (claude) JSON 답변 요구 시 --output-format json 대신 stream 유지
 * @param {(ev:object)=>void} opts.onEvent
 * @param {number} [opts.timeoutMs]
 * @returns {{ promise: Promise<Result>, cancel: () => void }}
 */
const TRANSIENT_START = /failed to initialize (sqlite )?state runtime|database is locked|SQLITE_BUSY/i;
// 실행 도중 모델 서버가 붐벼 턴이 끊기는 오류(구독 한도 소진과는 다르다 — 한도 문구는 제외)
const TRANSIENT_CAPACITY = /\bat capacity\b|overloaded|temporarily unavailable|service unavailable|server (is )?busy|\b(502|503|529)\b/i;
const NOT_CAPACITY = /usage limit|rate limit|quota|한도/i;
const CAPACITY_WAITS = [20_000, 60_000, 120_000];
const RESUME_FAILED = /not found|세션 ID가 일치하지|no rollout|thread\/resume/i;
const CAPACITY_RESUME_PROMPT = '[AI Hub 안내] 모델 서버가 붐벼 직전 턴이 중간에 끊겼습니다. 끊길 때 실행 중이던 명령은 중단됐을 수 있습니다. 먼저 쓰다 만 출력 파일이 없는지(특히 다시 만들던 최종 결과물) 확인하고, 하던 작업을 이어서 끝까지 진행한 뒤 원래 요청의 결과 보고를 해 주세요.';
const CAPACITY_RESTART_NOTE = '[AI Hub 안내] 앞선 시도가 모델 서버 혼잡으로 중간에 끊겨 새 대화로 다시 시작했습니다. 작업 폴더에 앞선 시도의 결과물이 남아 있을 수 있으니 현재 상태(쓰다 만 파일 포함)를 먼저 확인하고 이어서 진행하세요.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function runWorker(opts) {
  const { tool } = opts;
  const customShell = /[\s"]/u.test(opts.toolCfg?.command || '') && !fs.existsSync(opts.toolCfg.command);
  let legacy = opts.toolCfg?.transport === 'legacy' || (opts.toolCfg?.transport !== 'native' && ((opts.toolCfg?.extraArgs || []).length || customShell));
  const interactive = (!!opts.prompts && opts.toolCfg?.transport !== 'legacy') || permissionSetting({}, opts.permission ?? opts.settings?.permission) !== 'auto';
  if (interactive) legacy = false;
  fs.mkdirSync(opts.runDir, { recursive: true });
  let attempt = Math.max(0, ...fs.readdirSync(opts.runDir).map((n) => Number(n.match(/^attempt-(\d+)$/)?.[1]) || 0));
  let sessionId = opts.resumeSessionId || null, cancelled = false, latestResult = null, queue = Promise.resolve(), effectiveSettings = opts.settings;
  let deadline = Date.now() + (opts.timeoutMs || 90 * 60000), waitingAt = null, inPlaceRetry = false;
  const start = (o) => {
    const runDir = path.join(opts.runDir, `attempt-${++attempt}`);
    const next = { ...o, runDir, timeoutMs: Math.max(1, deadline - Date.now()), onEvent: (ev) => {
      if (ev.kind === 'waiting') { if (ev.waiting && waitingAt === null) waitingAt = Date.now(); else if (!ev.waiting && waitingAt !== null) { deadline += Date.now() - waitingAt; waitingAt = null; } }
      if (ev.sessionId) sessionId = ev.sessionId;
      opts.onEvent?.({ ...ev, generation: attempt });
    } };
    if (!legacy) return runNative(next, recordInvocation);
    if (tool === 'claude') return runClaude(next);
    if (tool === 'codex') return runCodex(next);
    throw new Error(`알 수 없는 도구: ${tool}`);
  };
  let current = start(opts);
  // 계정에서 지원하지 않는 모델이면 그 모델을 자동 선택에서 빼고, 실제로 쓸 수 있는 주력 모델로 한 번 다시 실행
  const fallback = current.promise.then(async (res) => {
    // 시작 직후 Codex 상태 DB 잠김 같은 일시적 실패(앞 프로세스가 막 끝난 직후)는 2초 뒤 한 번만 다시 시작
    // resume 요청의 ID는 초기화 성공의 증거가 아니다. 시작 전 실패는 재개에서도 한 번 재시도한다.
    if (!res.ok && !cancelled && !res.timedOut && !res.cancelled && !res.sessionId) {
      const errText = `${res.error || ''} ${readText(path.join(opts.runDir, `attempt-${attempt}`, 'stderr.log'), '') || ''}`;
      if (TRANSIENT_START.test(errText)) {
        opts.onEvent?.({ kind: 'stderr', text: '실행 준비 중 일시적인 잠금 오류라 2초 뒤 한 번 다시 시작합니다' });
        current.close?.();
        await new Promise((r) => setTimeout(r, 2000));
        if (!cancelled) { current = start(opts); res = await current.promise; }
      }
    }
    // 실행 도중 모델 서버 혼잡(용량 초과·과부하)으로 턴이 끊기면 잠시 기다렸다가 같은 대화에서 이어서 다시 시도한다.
    // (2026-10-05 사고: gpt-6.1-sol이 "Selected model is at capacity"로 끊겨 다시 만들던 영상이 쓰다 만 채 실패 처리됨)
    const waits = opts.capacityWaitsMs || CAPACITY_WAITS;
    const isCapacity = (r) => !r.ok && !cancelled && !r.timedOut && !r.cancelled && TRANSIENT_CAPACITY.test(r.error || '') && !NOT_CAPACITY.test(r.error || '');
    for (let n = 0; n < waits.length && isCapacity(res); n++) {
      opts.onEvent?.({ kind: 'stderr', text: `모델 서버가 붐벼 턴이 끊겼습니다(${String(res.error).slice(0, 80)}). ${Math.round(waits[n] / 1000)}초 뒤 같은 대화에서 이어서 진행합니다 (${n + 1}/${waits.length})` });
      const until = Date.now() + waits[n];
      while (Date.now() < until && !cancelled && Date.now() < deadline) await sleep(Math.min(250, Math.max(1, until - Date.now())));
      if (cancelled || Date.now() >= deadline) break;
      const resumeId = res.sessionId || sessionId;
      // ① 네이티브 연결이 살아 있으면 같은 스레드에 새 턴을 시작한다.
      if (!legacy && current.intercept && current.settle) {
        const receipt = await current.intercept({ text: CAPACITY_RESUME_PROMPT, attachments: [] });
        if (receipt.status !== 'failed') { res = await current.settle(); inPlaceRetry = true; continue; }
      }
      // ② 아니면 CLI를 다시 띄워 같은 대화를 이어 쓴다. 이어 쓰기가 안 되면 새 대화로 한 번 다시 시작한다.
      current.close?.();
      if (resumeId) sessionId = null;
      current = start({ ...opts, settings: effectiveSettings, prompt: resumeId ? CAPACITY_RESUME_PROMPT : `${opts.prompt}\n\n${CAPACITY_RESTART_NOTE}`, attachments: resumeId ? [] : opts.attachments, resumeSessionId: resumeId || null });
      res = await current.promise;
      if (resumeId && !res.ok && !cancelled && !res.timedOut && !res.cancelled && RESUME_FAILED.test(res.error || '')) {
        opts.onEvent?.({ kind: 'stderr', text: '같은 대화를 이어 쓰지 못해 새 대화로 다시 시작합니다' });
        current.close?.(); sessionId = null;
        current = start({ ...opts, settings: effectiveSettings, prompt: `${opts.prompt}\n\n${CAPACITY_RESTART_NOTE}`, resumeSessionId: null });
        res = await current.promise;
      }
    }
    const msg = `${res.error || ''} ${res.ok ? '' : res.text || ''}`;
    if (res.ok || cancelled || res.timedOut || res.cancelled || !UNSUPPORTED.test(msg)) return res;
    const failed = opts.settings?.model || msg.match(/'([\w.:-]+)' model/)?.[1] || modelOptions({})[tool]?.cliDefault?.model || '';
    markUnsupported(failed);
    const fallback = supportedFallback(opts.modelPolicy?.config || {}, tool, opts.modelPolicy?.fixed, failed, opts.settings || {});
    if (!fallback) return { ...res, errorKind: 'MODEL_UNSUPPORTED', error: `${res.error || msg}\n사용자 최소 모델·강도와 고정값을 유지하는 재실행 후보가 없습니다.` };
    opts.onEvent?.({ kind: 'stderr', text: `${failed} 모델 미지원: 기존 등급·강도를 유지하는 ${fallback.model}로 한 번 재실행합니다` });
    current.close?.();
    effectiveSettings = { ...fallback, permission: effectiveSettings?.permission };
    current = start({ ...opts, settings: effectiveSettings });
    const again = await current.promise;
    if (!again.ok && UNSUPPORTED.test(`${again.error} ${again.text}`)) { markUnsupported(fallback.model); again.errorKind = 'MODEL_UNSUPPORTED'; }
    return { ...again, fellBackFrom: failed, fellBackTo: fallback.model };
  });
  let restartSettled = false; // 첫 시도 뒤 다시 시작할지 결정이 끝났는지 (수신 확인 대기용)
  fallback.then(() => { restartSettled = true; }, () => { restartSettled = true; });
  let resultPromise = fallback;
  const getState = () => ({ tool, transport: legacy ? 'legacy' : current.getState()?.transport, sessionId, generation: attempt, ...(current.getState?.() || {}) });
  const settle = async () => {
    for (;;) {
      const q = queue, p = resultPromise; await q;
      const activeHandle = current;
      const res = current.settle ? await current.settle() : await p;
      // 초기 모델 대체 결과까지 기다린다.
      const base = p === fallback ? await fallback : res;
      if (q !== queue || p !== resultPromise || activeHandle !== current) continue;
      // 혼잡 오류 뒤 같은 연결에서 다시 시도했다면 위에서 읽은 res는 끊긴 턴의 것이다 → 한 번 다시 읽는다.
      if (inPlaceRetry) { inPlaceRetry = false; continue; }
      latestResult = current.settle ? { ...res, ...(base.errorKind && !base.ok ? { errorKind: base.errorKind, error: base.error } : {}) } : base;
      if (base.fellBackFrom) latestResult = { ...latestResult, fellBackFrom: base.fellBackFrom, fellBackTo: base.fellBackTo };
      sessionId = latestResult.sessionId || sessionId;
      return latestResult;
    }
  };
  const controller = {
    getState, settle,
    initialReceipt: async () => {
      // 시작 직후 일시적 오류로 다시 시작하면 첫 시도의 실패가 아니라 새 시도의 수신 확인을 돌려준다.
      for (;;) {
        const h = current;
        let r;
        try {
          if (h.initialReceipt) r = await h.initialReceipt();
          else {
            const end = Math.min(deadline, Date.now() + (opts.ackTimeoutMs || 10000));
            while (!sessionId && Date.now() < end && !cancelled) await sleep(20);
            r = { status: sessionId ? 'delivered' : 'failed', mode: 'prompt', sessionId, generation: attempt, error: sessionId ? null : 'CLI 세션 초기화를 확인하지 못했습니다' };
          }
        } catch (error) { r = { status: 'failed', mode: 'prompt', sessionId, generation: attempt, error: error.message }; }
        if (r.status === 'delivered' || cancelled) return r;
        // 아직 실행 중인 시도의 확인 실패(시간 초과 등)는 그대로 돌려준다.
        let ended = false;
        await Promise.race([Promise.resolve(h.promise).then(() => { ended = true; }, () => { ended = true; }), sleep(1000)]);
        if (!ended) return r;
        // 끝난 시도면 다시 시작할지 정해질 때까지 기다린다 (일시적 오류 재시작·미지원 모델 대체).
        while (current === h && !restartSettled && !cancelled) await sleep(50);
        if (current === h || cancelled) return r;
      }
    },
    intercept(x) {
      const work = queue.then(async () => {
        if (cancelled) return { status: 'failed', error: '작업이 중지되었습니다' };
        if (!legacy) {
          const receipt = await current.intercept(x);
          if (interactive || receipt.status !== 'failed' || !/not supported|method not found|제어 연결이 닫|CLI 연결 종료/i.test(receipt.error || '') || !sessionId || cancelled) return receipt;
          opts.onEvent?.({ kind: 'intercept', mode: 'resume', text: `네이티브 제어 실패로 같은 CLI 세션을 재개합니다: ${receipt.error}` });
          current.cancel(); await current.shutdown(); legacy = true;
        }
        const end = Math.min(deadline, Date.now() + (opts.ackTimeoutMs || 10000));
        while (!sessionId && Date.now() < end && !cancelled) await new Promise((r) => setTimeout(r, 20));
        if (!sessionId) return { status: 'failed', mode: 'resume', error: 'CLI 세션 ID가 없어 맥락을 유지하며 재개할 수 없습니다' };
        const expected = sessionId, old = current;
        // 이 워커가 소유한 자식의 close 완료 뒤에만 재개한다.
        old.cancel();
        let drainTimer;
        try { await Promise.race([old.promise, new Promise((_, reject) => { drainTimer = setTimeout(() => reject(new Error('이전 CLI 자식의 종료를 확인하지 못해 재개하지 않습니다')), opts.drainTimeoutMs || 10000); })]); }
        finally { clearTimeout(drainTimer); }
        if (cancelled || Date.now() >= deadline) return { status: 'failed', mode: 'resume', error: '중지 또는 원래 실행 제한 시간 만료' };
        sessionId = null;
        current = start({ ...opts, settings: effectiveSettings, prompt: x.text, attachments: x.attachments || [], resumeSessionId: expected });
        resultPromise = current.promise;
        const ack = await controller.initialReceipt();
        if (ack.sessionId !== expected) { current.cancel(); return { ...ack, status: 'failed', mode: 'resume', error: '재개된 CLI 세션 ID가 일치하지 않습니다' }; }
        return { ...ack, mode: 'resume' };
      }).catch((error) => ({ status: 'failed', mode: legacy ? 'resume' : null, ...getState(), error: error.message }));
      queue = work.then(() => {}, () => {}); return work;
    },
    cancel() { cancelled = true; current.cancel(); },
    close() { current.close?.(); },
  };
  controller.promise = settle().then(async (res) => {
    // 이전 테스트/도구의 표준 경로에는 채택된 결과와 실행 메타데이터만 게시한다.
    fs.writeFileSync(path.join(opts.runDir, 'result.md'), res.text || '');
    const lastDir = path.join(opts.runDir, `attempt-${attempt}`);
    for (const f of ['invocation.json', 'invocations.jsonl']) if (fs.existsSync(path.join(lastDir, f))) {
      if (f === 'invocations.jsonl') {
        const lines = Array.from({ length: attempt }, (_, i) => readText(path.join(opts.runDir, `attempt-${i + 1}`, f), '')).join(''); fs.writeFileSync(path.join(opts.runDir, f), lines);
      } else fs.copyFileSync(path.join(lastDir, f), path.join(opts.runDir, f));
    }
    if (!opts.managed) controller.close();
    return res;
  });
  return controller;
}
const UNSUPPORTED = /model is not supported|not supported when using|unsupported model|model[^.]{0,40}(does not exist|not found|not available)|invalid model/i;

const versions = new Map();
function recordInvocation(runDir, command, settings, args, metadata = {}) {
  if (!versions.has(command)) versions.set(command, new Promise((resolve) => {
    const child = guardChild(spawn(command, ['--version'], { shell: true, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim().slice(0, 200) || null); });
  }));
  const entry = { at: new Date().toISOString(), command, settings, args, version: null, transport: 'legacy', ...metadata };
  fs.appendFileSync(path.join(runDir, 'invocations.jsonl'), JSON.stringify({ ...entry, stage: 'requested' }) + '\n');
  fs.writeFileSync(path.join(runDir, 'invocation.json'), JSON.stringify(entry, null, 2));
  return versions.get(command).then((version) => {
    entry.version = version;
    fs.appendFileSync(path.join(runDir, 'invocations.jsonl'), JSON.stringify({ ...entry, stage: 'resolved' }) + '\n');
    fs.writeFileSync(path.join(runDir, 'invocation.json'), JSON.stringify(entry, null, 2));
    return entry;
  });
}

function spawnTool(command, args, { cwd, prompt, onLine, onStderr, timeoutMs }) {
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(command, args, {
    cwd, shell: true, env: childEnv({ ODDIN_WORKER: '1' }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  guardChild(child);
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => onStderr(String(d)));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  let killed = false;
  const kill = () => {
    // 끝난 뒤 불린 중지(작업 정리 등)는 아무것도 하지 않는다 — util.killChildTree 참고
    if (!killed && killChildTree(child)) killed = true;
  };
  const timer = timeoutMs ? setTimeout(() => { kill(); child.emit('hub-timeout'); }, timeoutMs) : null;
  const done = new Promise((resolve) => {
    let timedOut = false;
    child.on('hub-timeout', () => { timedOut = true; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, error: String(e), killed, timedOut, tail: buf }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); if (buf.trim()) onLine(buf); resolve({ code, killed, timedOut }); });
  });
  return { child, done, kill };
}

// ---------------- Claude Code ----------------
function runClaude(opts) {
  const { prompt, cwd, runDir, toolCfg = {}, addDirs = [], onEvent, timeoutMs, settings = {}, attachments = [] } = opts;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.browser) args.push('--chrome'); // 사용자 Chrome 을 직접 조작하는 Claude in Chrome 도구
  const model = settings.model || toolCfg.model;
  if (model) args.push('--model', model);
  if (settings.effort) args.push('--effort', settings.effort);
  // 이미지가 있으면 stream-json 입력으로 image 블록을 함께 보낸다
  let stdinText = prompt;
  if (attachments.length) {
    args.push('--input-format', 'stream-json');
    const content = attachments.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: fs.readFileSync(a.path).toString('base64') } }));
    content.push({ type: 'text', text: prompt });
    stdinText = JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } }) + '\n';
  }
  for (const d of addDirs) args.push('--add-dir', quoteArg(d));
  if (Array.isArray(toolCfg.extraArgs)) args.push(...toolCfg.extraArgs);

  const logFile = path.join(runDir, 'events.jsonl');
  fs.mkdirSync(runDir, { recursive: true });
  let finalText = '';
  let sessionId = null;
  let usage = null;
  let costUsd = null;
  let isError = false;
  let errorText = '';
  const texts = [];
  let stderr = '';
  const records = new ToolRecords('claude', onEvent);

  const onLine = (line) => {
    fs.appendFileSync(logFile, line + '\n');
    let ev; try { ev = JSON.parse(line); } catch { onEvent({ kind: 'raw', text: line }); return; }
    if (ev.type === 'system' && ev.subtype === 'init') { sessionId = ev.session_id; onEvent({ kind: 'init', sessionId, model: ev.model, effort: settings.effort || null }); }
    else if (ev.type === 'rate_limit_event') { noteClaudeRateLimit(ev); }
    else if (ev.type === 'assistant') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text) { texts.push(c.text); onEvent({ kind: 'message', text: c.text }); }
        else if (c.type === 'tool_use') records.claude(c);
      }
    } else if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_result') {
          records.claude(c);
          const t = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : '');
          if (c.is_error) onEvent({ kind: 'tool_error', text: String(t).slice(0, 500) });
        }
      }
    } else if (ev.type === 'result') {
      finalText = ev.result || texts.at(-1) || '';
      usage = ev.usage || null; costUsd = ev.total_cost_usd ?? null; isError = !!ev.is_error;
      if (isError) errorText = ev.result || ev.terminal_reason || 'error';
      onEvent({ kind: 'result', text: finalText, isError, usage, costUsd, sessionId: ev.session_id || sessionId });
    }
  };
  const invocation = recordInvocation(runDir, toolCfg.command || 'claude', { model: model || null, effort: settings.effort || null }, args);
  const { done, kill } = spawnTool(toolCfg.command || 'claude', args, {
    cwd, prompt: stdinText, onLine, timeoutMs,
    onStderr: (d) => { stderr += d; if (stderr.length < 20000) onEvent({ kind: 'stderr', text: d }); },
  });
  const promise = done.then(async (r) => {
    await invocation;
    records.close(r.killed ? '작업이 중지되었습니다' : '도구 결과를 받기 전에 실행이 종료되었습니다');
    if (!finalText && texts.length) finalText = texts.join('\n\n');
    fs.writeFileSync(path.join(runDir, 'result.md'), finalText || '');
    const ok = !isError && !r.timedOut && !r.killed && (r.code === 0 || !!finalText);
    return { ok, tool: 'claude', text: finalText, sessionId, usage, costUsd, exitCode: r.code, timedOut: r.timedOut, cancelled: r.killed && !r.timedOut, error: isError ? errorText : (r.error || (ok ? null : lastLines(stderr))) };
  });
  return { promise, cancel: kill };
}

// ---------------- Codex ----------------
function runCodex(opts) {
  const { prompt, cwd, runDir, toolCfg = {}, addDirs = [], schemaFile, onEvent, timeoutMs, settings = {}, attachments = [] } = opts;
  fs.mkdirSync(runDir, { recursive: true });
  const lastFile = path.join(runDir, 'last-message.txt');
  const args = ['exec', ...(opts.resumeSessionId ? ['resume'] : []), '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(!opts.resumeSessionId ? ['-C', quoteArg(cwd)] : []), '-o', quoteArg(lastFile)];
  const model = settings.model || toolCfg.model;
  if (model) args.push('-m', model);
  if (settings.effort) args.push('-c', `model_reasoning_effort=${settings.effort}`);
  for (const a of attachments) args.push('-i', quoteArg(a.path));
  if (!opts.resumeSessionId) for (const d of addDirs) args.push('--add-dir', quoteArg(d));
  if (schemaFile && !opts.resumeSessionId) args.push('--output-schema', quoteArg(schemaFile));
  if (Array.isArray(toolCfg.extraArgs)) args.push(...toolCfg.extraArgs);
  if (opts.resumeSessionId) args.push(opts.resumeSessionId);
  args.push('-'); // 프롬프트는 stdin

  const logFile = path.join(runDir, 'events.jsonl');
  let threadId = null, usage = null, finalText = '', errorText = '', stderr = '';
  const texts = [];
  const records = new ToolRecords('codex', onEvent);
  // 재실행에서 전회 최종 응답을 성공으로 오인하지 않는다.
  try { fs.unlinkSync(lastFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const onLine = (line) => {
    fs.appendFileSync(logFile, line + '\n');
    let ev; try { ev = JSON.parse(line); } catch { onEvent({ kind: 'raw', text: line }); return; }
    if (ev.type === 'thread.started') { threadId = ev.thread_id; onEvent({ kind: 'init', sessionId: threadId, model: model || null, effort: settings.effort || null }); }
    else if (ev.type === 'item.completed' || ev.type === 'item.started') {
      const it = ev.item || {};
      records.codex(it, ev.type === 'item.completed');
      if (ev.type === 'item.completed' && it.type === 'agent_message' && it.text) { texts.push(it.text); onEvent({ kind: 'message', text: it.text }); }
      else if (ev.type === 'item.completed' && it.type === 'command_execution' && it.exit_code && it.exit_code !== 0) onEvent({ kind: 'tool_error', text: `exit ${it.exit_code}: ${(it.aggregated_output || '').slice(-400)}` });
      else if (ev.type === 'item.completed' && it.type === 'reasoning' && it.text) onEvent({ kind: 'thinking', text: it.text.slice(0, 400) });
    } else if (ev.type === 'turn.completed') { usage = ev.usage || null; }
    else if (ev.type === 'turn.failed' || ev.type === 'error') { errorText = ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 500); onEvent({ kind: 'tool_error', text: errorText }); }
  };
  const command = codexCommand(toolCfg);
  const invocation = recordInvocation(runDir, command, { model: model || null, effort: settings.effort || null }, args);
  const { done, kill } = spawnTool(command, args, {
    cwd, prompt, onLine, timeoutMs,
    onStderr: (d) => {
      // Codex는 MCP OAuth 갱신 실패 같은 로그를 stderr로 쏟는다 — 저장만 하고 화면엔 ERROR 줄만
      stderr += d; fs.appendFileSync(path.join(runDir, 'stderr.log'), d);
      if (/\bERROR\b/.test(d) && !/oauth|refresh token/i.test(d)) onEvent({ kind: 'stderr', text: d.slice(0, 400) });
    },
  });
  const promise = done.then(async (r) => {
    await invocation;
    records.close(r.killed ? '작업이 중지되었습니다' : '도구 결과를 받기 전에 실행이 종료되었습니다');
    finalText = (readText(lastFile, '') || '').trim() || texts.at(-1) || '';
    fs.writeFileSync(path.join(runDir, 'result.md'), finalText);
    const ok = !errorText && !r.timedOut && !r.killed && (r.code === 0 || !!finalText);
    onEvent({ kind: 'result', text: finalText, isError: !ok, usage, sessionId: threadId });
    return { ok, tool: 'codex', text: finalText, sessionId: threadId, usage, costUsd: null, exitCode: r.code, timedOut: r.timedOut, cancelled: r.killed && !r.timedOut, error: errorText || r.error || (ok ? null : lastLines(stderr)) };
  });
  return { promise, cancel: kill };
}

function quoteArg(s) {
  // shell:true 로 cmd.exe 를 거치므로 공백/한글 경로는 큰따옴표로 감싼다
  if (process.platform === 'win32') return /[\s&()^|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function lastLines(s, n = 5) { return (s || '').trim().split('\n').slice(-n).join('\n').slice(0, 800) || null; }
