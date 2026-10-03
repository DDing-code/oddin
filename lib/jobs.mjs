// 세션·작업(Job) 상태 머신 + 스케줄러: 계획 → 병렬 실행(의존 순서) → 보고
// 세션 = 한 폴더에서 이어지는 대화. 같은 세션의 다음 명령은 이전 명령·보고를 맥락으로 받는다.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, RUNS_DIR, jobId, shortId, nowIso, readJson, writeJsonAtomic, appendLine, projectMemoryFolder, truncate } from './util.mjs';
import { toolStatus, healthyTools } from './tools.mjs';
import { runWorker } from './workers.mjs';
import { makePlan, makeReport, buildWorkerPrompt } from './planner.mjs';
import { memoryBundle, writeBoard } from './memory.mjs';
import { resolveSettings } from './options.mjs';
import { resolveAttachments } from './attachments.mjs';
import { usageStatus, balanceShare, headroom, CRIT_AT, WARN_AT } from './usage.mjs';
import { catalog, parseInput, agentBrief } from './catalog.mjs';
import { roundPrompt, checkGoal } from './goals.mjs';
import { isAuto, finalizeChoice, routeTasks, internalSettings, autoCatalog, autoFloor, heuristicTier, deepEffortJustified, isDesignText, designRule, applyDesignModel } from './router.mjs';
import { normalizeIntercept, fingerprint, newDelivery, aggregateIntercept, instructionText, interceptError } from './intercepts.mjs';
import { PromptManager, permissionSetting } from './prompts.mjs';

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const MODES = new Set(['auto', 'claude', 'codex', 'both']);

export class JobManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.jobs = new Map();
    this.sessions = new Map();
    this.running = new Map(); // `${jobId}/${taskId|phase:phase}` -> 소유한 제어 핸들
    this.load();
    this.prompts = new PromptManager({ file: path.join(DATA_DIR, 'prompts.json'), config, onChange: (prompt) => {
      const job = this.jobs.get(prompt.jobId);
      if (job) {
        const pending = this.prompts.list({ jobId: job.id });
        job.waiting = pending.length > 0;
        for (const task of job.tasks) task.waiting = pending.some((p) => p.taskId === task.id);
        this.emitJob(job);
      }
      this.emit('event', { type: 'prompt', prompt });
    } });
  }

  // ---------------- 저장 ----------------
  load() {
    for (const j of readJson(JOBS_FILE, [])) {
      j.waiting = false; for (const task of j.tasks || []) task.waiting = false;
      j.intercepts ||= []; j.instructionRevision ||= 0; j.phaseRuns ||= {}; j.activePhase = null; j.canIntercept = false;
      for (const i of j.intercepts) {
        for (const d of i.deliveries || []) if (['waiting', 'sending', 'recorded'].includes(d.status)) {
          d.status = d.status === 'sending' ? 'uncertain' : 'failed'; d.error = '서버가 다시 시작되어 전달을 확인할 수 없습니다';
        }
        i.status = aggregateIntercept(i); i.updatedAt = nowIso();
      }
      if (LIVE.has(j.status)) {
        j.status = 'interrupted'; j.finishedAt = j.finishedAt || nowIso();
        for (const t of j.tasks || []) if (t.status === 'running' || t.status === 'pending') t.status = 'interrupted';
      }
      this.jobs.set(j.id, j);
    }
    for (const s of readJson(SESSIONS_FILE, [])) {
      if (s.goal?.status === 'active') { s.goal.status = 'paused'; s.goal.reason = '서버가 다시 시작돼서 멈췄어요. "이어서"를 누르면 계속해요'; }
      this.sessions.set(s.id, s);
    }
    // 접수의 기준 저장소는 jobs.json이다. 202 직후 재시작되어 세션의 지연 저장이
    // 끝나지 않았더라도 목표의 후속 라운드가 최신 지시를 잃지 않게 복원한다.
    for (const s of this.sessions.values()) if (s.goal) {
      const collected = new Map();
      for (const j of this.jobs.values()) if (j.sessionId === s.id && j.goalId === s.goal.id) for (const i of j.intercepts || []) {
        const sourceJobId = i.sourceJobId || j.id, key = `${sourceJobId}/${i.clientRequestId}`;
        if (!collected.has(key) || sourceJobId === j.id) collected.set(key, { ...i, sourceJobId });
      }
      if (collected.size) s.goal.intercepts = [...collected.values()].sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    }
    // 이전 버전 작업(세션 없음)은 작업 하나당 세션 하나로 옮긴다
    for (const j of [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (j.sessionId && this.sessions.has(j.sessionId)) continue;
      const s = this.newSessionObject(j.cwd, j.title, j.createdAt);
      s.jobIds.push(j.id); s.updatedAt = j.finishedAt || j.createdAt;
      j.sessionId = s.id;
      this.sessions.set(s.id, s);
    }
    this.save();
  }
  save({ immediate = false } = {}) {
    clearTimeout(this._saveTimer);
    if (immediate) { writeJsonAtomic(JOBS_FILE, [...this.jobs.values()]); return; }
    this._saveTimer = setTimeout(() => {
      writeJsonAtomic(JOBS_FILE, [...this.jobs.values()]);
      writeJsonAtomic(SESSIONS_FILE, [...this.sessions.values()]);
    }, 150);
  }

  // ---------------- 세션 ----------------
  newSessionObject(cwd, title, at = nowIso()) {
    return { id: `s-${Date.now().toString(36)}${shortId(4)}`, title: title || '새 세션', cwd: path.resolve(cwd), createdAt: at, updatedAt: at, jobIds: [], titled: !!title };
  }
  createSession({ cwd, title } = {}) {
    cwd = path.resolve(String(cwd || this.config.defaultCwd));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpError(400, `폴더가 없습니다: ${cwd}`);
    const s = this.newSessionObject(cwd, title ? String(title).slice(0, 80) : null);
    this.sessions.set(s.id, s);
    this.emitSession(s);
    return this.publicSession(s);
  }
  /** 이름 바꾸기·고정 (고정은 정렬 순서를 흔들지 않게 updatedAt 을 건드리지 않는다) */
  updateSession(id, { title, pinned } = {}) {
    const s = this.sessions.get(id); if (!s) throw httpError(404, '세션 없음');
    if (typeof title === 'string' && title.trim()) { s.title = title.trim().slice(0, 80); s.titled = true; }
    if (typeof pinned === 'boolean') s.pinned = pinned ? nowIso() : null;
    this.emit('event', { type: 'session', session: this.publicSession(s) }); this.save();
    return this.publicSession(s);
  }
  deleteSession(id) {
    const s = this.sessions.get(id); if (!s) return false;
    for (const jid of s.jobIds) { const j = this.jobs.get(jid); if (j && LIVE.has(j.status)) this.cancel(jid); this.jobs.delete(jid); }
    this.sessions.delete(id); this.save();
    this.emit('event', { type: 'session_removed', sessionId: id });
    return true;
  }
  publicSession(s) {
    const jobs = s.jobIds.map((id) => this.jobs.get(id)).filter(Boolean);
    const live = jobs.some((j) => this.canIntercept(j));
    const last = jobs.at(-1);
    return { ...s, jobCount: jobs.length, status: live ? 'running' : last?.status || 'empty' };
  }
  listSessions() { return [...this.sessions.values()].map((s) => this.publicSession(s)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  sessionJobs(id) { const s = this.sessions.get(id); return s ? s.jobIds.map((j) => this.jobs.get(j)).filter(Boolean).map(publicJob) : []; }
  emitSession(s) { this.emit('event', { type: 'session', session: this.publicSession(s) }); this.save(); }

  historyContext(job, limit = 24_000) {
    const s = this.sessions.get(job.sessionId); if (!s) return '';
    const prev = s.jobIds.filter((id) => id !== job.id).map((id) => this.jobs.get(id)).filter((j) => j && j.createdAt < job.createdAt);
    if (!prev.length) return '';
    const parts = prev.map((j, i) => `### 이전 명령 ${i + 1} (${j.createdAt.slice(0, 16).replace('T', ' ')}, ${j.status})\n${j.goal}\n\n#### 결과\n${truncate(j.report || j.error || '(결과 없음)', 6000)}`);
    let text = parts.join('\n\n');
    if (text.length > limit) text = '(앞부분 생략)\n…' + text.slice(-limit);
    return text;
  }

  // ---------------- 작업 ----------------
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { return this.jobs.get(id) || null; }

  canIntercept(job) {
    if (!job || job.status === 'cancelled' || job.status === 'interrupted') return false;
    if (LIVE.has(job.status)) return true;
    const s = this.sessions.get(job.sessionId), g = s?.goal;
    return !!(g && g.id === job.goalId && g.status === 'active' && s.jobIds.at(-1) === job.id && ['goal-check', 'goal-transition'].includes(job.activePhase));
  }
  refreshInterceptState(job) { job.canIntercept = this.canIntercept(job); if (!job.canIntercept) job.activePhase = null; }
  getIntercepts(id) {
    const j = this.get(id); if (!j) throw interceptError(404, 'JOB_NOT_FOUND', '작업이 없습니다');
    return { jobId: id, sessionId: j.sessionId, revision: j.instructionRevision || 0, intercepts: j.intercepts || [] };
  }
  acceptIntercept(id, body) {
    const job = this.get(id); if (!job) throw interceptError(404, 'JOB_NOT_FOUND', '작업이 없습니다');
    let x = normalizeIntercept(body, false);
    if (x.sessionId !== job.sessionId) throw interceptError(409, 'SESSION_MISMATCH', '현재 대화와 작업이 일치하지 않습니다');
    const existing = (job.intercepts || []).find((i) => i.clientRequestId === x.clientRequestId);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(x)) throw interceptError(409, 'REQUEST_ID_CONFLICT', '같은 요청 ID에 다른 지시가 있습니다');
      return { job: publicJob(job), intercept: existing, duplicate: true };
    }
    // 이 함수의 저장·대상 예약·전송 시작 사이에는 await가 없다. 완료 확정도 같은 이벤트 루프 장벽을 쓴다.
    if (!this.canIntercept(job)) throw interceptError(409, 'JOB_NOT_ACTIVE', '작업이 이미 종료되었습니다');
    x = normalizeIntercept(body);
    if ((job.intercepts || []).filter((i) => ['accepted', 'applying'].includes(i.status)).length >= 20) throw interceptError(429, 'INTERCEPT_BACKLOG_FULL', '전달 대기 중인 수정 지시가 너무 많습니다');
    const revision = (job.instructionRevision || 0) + 1;
    const active = [...this.running.entries()].filter(([key]) => key.startsWith(`${job.id}/`));
    const deliveries = active.map(([, e]) => newDelivery(e.deliveryKey, e.phase, e.task?.id || null));
    for (const t of job.tasks || []) if (t.status === 'pending') deliveries.push(newDelivery(`task:${t.id}`, 'worker', t.id, true));
    if (!deliveries.length) deliveries.push(newDelivery(`phase:${job.activePhase || 'plan'}`, job.activePhase || 'plan', null, true));
    const i = { id: `i-${x.clientRequestId}`, clientRequestId: x.clientRequestId, seq: revision, revision, text: x.text, attachments: x.attachments, status: 'accepted', acceptedAt: nowIso(), updatedAt: nowIso(), deliveries, error: null };
    job.intercepts ||= []; job.intercepts.push(i); job.instructionRevision = revision;
    try { this.save({ immediate: true }); }
    catch (e) { job.intercepts.pop(); job.instructionRevision = revision - 1; throw interceptError(500, 'INTERCEPT_PERSIST_FAILED', `수정 지시를 저장하지 못했습니다: ${e.message}`); }
    const g = this.sessions.get(job.sessionId)?.goal;
    if (g && g.id === job.goalId && g.status === 'active') { g.intercepts ||= []; g.intercepts.push({ ...i, sourceJobId: job.id }); }
    if (job.activePhase === 'report' || (job.activePhase === 'worker' && job.tasks.length && !active.length && job.tasks.every((t) => !['pending', 'running'].includes(t.status)))) job.reconcileRevision = revision;
    this.changedIntercept(job, i);
    for (const [, e] of active) this.sendIntercept(job, e, i);
    return { job: publicJob(job), intercept: i, duplicate: false };
  }
  changedIntercept(job, i) {
    i.status = aggregateIntercept(i); i.updatedAt = nowIso();
    this.save({ immediate: true });
    appendLine(path.join(job.runDir, 'intercepts.jsonl'), JSON.stringify(i));
    this.emit('event', { type: 'intercept', jobId: job.id, sessionId: job.sessionId, revision: job.instructionRevision, intercept: i });
    this.emitJob(job);
  }
  sendIntercept(job, e, i) {
    let d = i.deliveries.find((x) => x.key === e.deliveryKey);
    if (!d) { d = newDelivery(e.deliveryKey, e.phase, e.task?.id || null); i.deliveries.push(d); }
    if (e.pending.has(i.id) || ['delivered', 'failed', 'uncertain', 'cancelled'].includes(d.status)) return;
    d.status = 'sending'; this.changedIntercept(job, i);
    const memory = this.memoryFor(job, e.phase, e.task);
    const text = `[AI Hub 수정 지시 #${i.seq}]\n원래 목표: ${job.goal}\n현재 담당: ${e.task?.title || e.phase}\n${i.text}\n기존 맥락·완료 결과·파일 소유권을 유지하고 남은 작업을 이어서 진행하세요. 앞선 지시와 충돌하는 부분은 이 지시를 우선하세요.\n${memory}`;
    let sent;
    try { sent = e.handle.intercept({ ...i, text, messageId: d.messageId, attachments: resolveAttachments(i.attachments) }); }
    catch (error) { sent = Promise.resolve({ status: 'failed', error: error.message }); }
    const p = Promise.resolve(sent).catch((error) => ({ status: 'failed', error: error.message })).then((receipt) => {
      if (job.status === 'cancelled' || i.status === 'cancelled') d.status = 'cancelled';
      else Object.assign(d, { status: receipt.status, mode: receipt.mode || null, cliSessionId: receipt.sessionId || null, turnId: receipt.turnId || null, generation: receipt.generation || null, error: receipt.error || null, deliveredAt: receipt.status === 'delivered' ? nowIso() : null });
      if (d.status === 'delivered') e.adoptedRevision = Math.max(e.adoptedRevision, i.revision);
      this.log(job, e.task, { kind: 'intercept', interceptId: i.id, revision: i.revision, phase: e.phase, mode: d.mode, text: `수정 지시 #${i.seq}: ${d.status}${d.error ? ' · ' + d.error : ''}` });
      this.changedIntercept(job, i);
      return receipt;
    });
    e.pending.set(i.id, p);
  }
  async trackWorker(job, handle, phase, task = null) {
    const key = `${job.id}/${task?.id || 'phase:' + phase}`;
    const revision = job.instructionRevision || 0;
    const e = { handle, phase, task, deliveryKey: task ? `task:${task.id}` : `phase:${phase}`, adoptedRevision: revision, pending: new Map() };
    this.running.set(key, e);
    job.phaseRuns ||= {};
    const record = task || (job.phaseRuns[phase] = { tool: handle.getState().tool, revision });
    record.instructionRevision = revision;
    // 출발 프롬프트에 들어 있는 접수는 실제 CLI 수신 확인을 받아야 delivered가 된다.
    const initial = (job.intercepts || []).filter((i) => i.status !== 'cancelled');
    if (initial.length) {
      for (const i of initial) {
        let d = i.deliveries.find((d) => d.key === e.deliveryKey);
        if (!d) { d = newDelivery(e.deliveryKey, phase, task?.id || null, true); i.deliveries.push(d); }
        d.status = 'sending'; this.changedIntercept(job, i);
      }
      const ack = handle.initialReceipt().catch((err) => ({ status: 'failed', error: err.message })).then((receipt) => {
        for (const i of initial) { const d = i.deliveries.find((d) => d.key === e.deliveryKey); Object.assign(d, { status: job.status === 'cancelled' ? 'cancelled' : receipt.status, mode: 'prompt', cliSessionId: receipt.sessionId || null, turnId: receipt.turnId || null, deliveredAt: receipt.status === 'delivered' ? nowIso() : null, error: receipt.error || null }); this.changedIntercept(job, i); }
      });
      e.pending.set('initial', ack);
    }
    try {
      let res = await handle.promise;
      for (;;) {
        const seenRevision = job.instructionRevision || 0, pending = [...e.pending.values()];
        await Promise.all(pending);
        res = await handle.settle();
        if (seenRevision !== job.instructionRevision || pending.length !== e.pending.size) continue;
        Object.assign(record, { cliSessionId: res.sessionId, turnId: res.turnId || null, generation: res.generation || handle.getState().generation, revision: e.adoptedRevision, instructionRevision: e.adoptedRevision });
        const failed = (job.intercepts || []).flatMap((i) => i.deliveries.filter((d) => d.key === e.deliveryKey && ['failed', 'uncertain'].includes(d.status)));
        if (failed.length) res = { ...res, ok: false, error: `수정 지시 전달을 확인하지 못했습니다: ${failed.map((d) => d.error).join(' · ')}` };
        const dir = path.join(job.runDir, task?.id || phase); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'result.md'), res.text || '');
        return res;
      }
    } finally { if (this.running.get(key) === e) this.running.delete(key); handle.close(); }
  }
  phaseWorker(job) { return (handle, phase) => this.trackWorker(job, handle, phase); }

  emitJob(job) {
    this.refreshInterceptState(job);
    this.emit('event', { type: 'job', job: publicJob(job) });
    const s = this.sessions.get(job.sessionId);
    if (s) { s.updatedAt = nowIso(); this.emit('event', { type: 'session', session: this.publicSession(s) }); }
    this.save();
  }
  log(job, task, ev) {
    if (!task && ev.phase && ['init', 'turn'].includes(ev.kind)) {
      job.phaseRuns ||= {}; job.phaseRuns[ev.phase] ||= {};
      Object.assign(job.phaseRuns[ev.phase], { tool: ev.tool, cliSessionId: ev.sessionId, turnId: ev.turnId || null, generation: ev.generation || 1 });
      this.emitJob(job);
    }
    const entry = { at: nowIso(), ...ev };
    const key = task ? task.id : (ev.phase || 'job');
    appendLine(path.join(job.runDir, `${key}.log.jsonl`), JSON.stringify(entry));
    this.emit('event', { type: 'log', jobId: job.id, taskId: task?.id || null, entry });
  }

  /** 매 CLI 호출 직전 다시 해석/조회. 작업 간 메모리 문자열은 공유하지 않는다. */
  memoryFor(job, phase, task = null) {
    const result = memoryBundle(this.config.hubDir, { cwd: job.cwd, query: `${job.goal}\n${task?.title || ''}\n${task?.prompt || ''}\n${instructionText(job)}` });
    job.memorySlug = result.manifest.projectSlugs?.[0] || null;
    job.memorySlugs = result.manifest.projectSlugs || [];
    const dir = path.join(job.runDir, task?.id || phase);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory-context.json'), JSON.stringify(result.manifest, null, 2));
    this.log(job, task, { kind: 'memory', phase, text: `메모리 최신 확인: 본문 ${result.manifest.selected.length}개, 생략 ${result.manifest.omitted.length}개, 진단 ${result.manifest.diagnostics.length}개`,
      manifest: path.join(dir, 'memory-context.json'), diagnostics: result.manifest.diagnostics });
    return result.text;
  }

  /** 새 명령 → /goal · /커맨드 · /스킬 · @에이전트 해석 후 작업 생성 */
  create(body = {}) {
    const raw = String(body.goal || '').trim();
    const parsed = raw ? parseInput(raw, catalog(this.config.hubDir)) : null;
    if (!parsed) return this._create(body);
    if (parsed.kind === 'goal') return this.startGoal({ ...body, text: parsed.text });
    if (parsed.kind === 'command') return this._create({ ...body, goal: parsed.prompt, input: raw, mode: parsed.mode || body.mode, command: { kind: 'command', name: parsed.name }, agentHint: parsed.agent });
    if (parsed.kind === 'skill') return this._create({ ...body, goal: parsed.prompt, input: raw, command: { kind: 'skill', name: parsed.name } });
    return this._create({ ...body, goal: parsed.text, input: raw, command: { kind: 'agent', name: parsed.name }, agent: parsed.name });
  }

  _create({ goal, cwd, mode = 'auto', title, sessionId, settings, attachments, planner, input = null, command = null, agent = null, agentHint = null, goalRef = null } = {}) {
    goal = String(goal || '').trim();
    const atts = resolveAttachments(attachments);
    if (!goal && atts.length) goal = '첨부한 이미지를 보고 요청을 처리해 주세요.';
    if (!goal) throw httpError(400, '명령이 비어 있습니다');
    if (!MODES.has(mode)) throw httpError(400, `알 수 없는 분배 방식: ${mode}`);

    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !session) throw httpError(404, '세션이 없습니다');
    if (session && session.jobIds.some((id) => this.canIntercept(this.jobs.get(id))) && !goalRef) throw httpError(409, '이 세션에서 아직 실행 중인 작업이 있습니다. 끝나거나 중지한 뒤 보내세요');
    if (!session) {
      const dir = path.resolve(String(cwd || this.config.defaultCwd));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `폴더가 없습니다: ${dir}`);
      session = this.newSessionObject(dir, null);
      this.sessions.set(session.id, session);
    }
    if (!session.titled && !session.jobIds.length) session.title = (session.goal?.text || input || goal).split('\n')[0].slice(0, 60);

    const id = jobId();
    const job = {
      id, sessionId: session.id, title: (title || (input || goal).split('\n')[0]).slice(0, 80), goal, cwd: session.cwd, mode,
      input, command, agent, agentHint, goalId: goalRef?.id || null, goalRound: goalRef?.round || null, notes: [],
      settings: { ...resolveSettings(this.config, settings), permission: permissionSetting(this.config, settings?.permission) }, plannerPref: ['claude', 'codex'].includes(planner) ? planner : 'auto',
      attachments: atts.map(({ id: aid, name, mime, size }) => ({ id: aid, name, mime, size })),
      status: 'queued', createdAt: nowIso(), startedAt: null, finishedAt: null,
      planner: null, summary: null, tasks: [], report: null, error: null,
      intercepts: goalRef ? structuredClone(session.goal?.intercepts || []).map((i) => ({ ...i, deliveries: [], status: 'accepted' })) : [],
      instructionRevision: goalRef ? (session.goal?.intercepts?.length || 0) : 0, phaseRuns: {}, activePhase: 'queued', canIntercept: true,
      runDir: path.join(RUNS_DIR, id), memorySlug: projectMemoryFolder(this.config.hubDir, session.cwd),
    };
    fs.mkdirSync(job.runDir, { recursive: true });
    fs.writeFileSync(path.join(job.runDir, 'GOAL.md'), `# ${job.title}\n\n- 세션: ${session.title} (${session.id})\n- 폴더: ${job.cwd}\n- 분배: ${mode}\n- 설정: ${JSON.stringify(job.settings)}\n- 첨부: ${job.attachments.map((a) => a.name).join(', ') || '없음'}\n- 생성: ${job.createdAt}\n\n${goal}\n`);
    this.jobs.set(id, job);
    session.jobIds.push(id);
    this.emitJob(job);
    this.run(job, atts).catch((e) => {
      if (job.status === 'cancelled') return this.finish(job);
      job.status = 'failed'; job.error = String(e?.message || e); job.finishedAt = nowIso();
      this.log(job, null, { kind: 'error', text: job.error });
      this.finish(job);
    });
    return publicJob(job);
  }

  async run(job, atts) {
    job.startedAt = nowIso();
    const status = await toolStatus(this.config);
    if (job.status === 'cancelled') return this.finish(job);
    const healthy = healthyTools(status);
    if (!healthy.length) throw new Error('사용 가능한 AI가 없습니다. 상태 표시줄의 안내대로 로그인하세요.');
    if ((job.mode === 'claude' || job.mode === 'codex') && !healthy.includes(job.mode)) throw new Error(`${job.mode} 를 지금 쓸 수 없습니다 (로그인 확인). 다른 분배 방식을 고르세요.`);
    const historyCtx = this.historyContext(job);
    this._atts = this._atts || new Map();
    this._atts.set(job.id, atts);
    const usage = await usageStatus(this.config).catch(() => null);
    if (job.status === 'cancelled') return this.finish(job);
    job.notes = job.notes || [];
    const cat = catalog(this.config.hubDir); this._cat = cat;
    const nameOf = (t) => (t === 'claude' ? 'Claude' : 'Codex');
    const limitNote = (t) => { const w = (usage?.[t]?.windows || []).filter((x) => x.scope !== 'model').sort((a, b) => b.usedPercent - a.usedPercent)[0]; return w ? `${nameOf(t)} ${w.label} 한도가 ${Math.round(w.usedPercent)}%` : `${nameOf(t)} 한도가 거의 차서`; };
    // 한도 95% 이상인 AI는 이번 작업에서 뺀다 (둘 다면 그대로 진행)
    let usable = healthy.filter((t) => { const h = headroom(usage, t); return h == null || h > 100 - CRIT_AT; });
    if (!usable.length) { usable = healthy.slice(); job.notes.push('두 AI 모두 한도가 거의 찼어요. 그대로 진행하지만 중간에 멈출 수 있어요.'); }
    const share = balanceShare(usage, usable);
    if ((job.mode === 'claude' || job.mode === 'codex') && !usable.includes(job.mode) && this.config.usageGuard?.autoSwitch !== false) {
      job.notes.push(`${limitNote(job.mode)}라 ${nameOf(usable[0])}로 대신 실행했어요.`); job.mode = usable[0];
    }
    const agentObj = job.agent ? cat.agents.find((a) => a.name === job.agent) : null;

    let planned = false; // 플래너가 작업마다 모델을 이미 골랐는지
    if (agentObj && job.mode !== 'both') {
      let tool = agentObj.tool !== 'auto' ? agentObj.tool : (job.mode === 'claude' || job.mode === 'codex') ? job.mode : (share.claude >= share.codex ? 'claude' : 'codex');
      if (!usable.includes(tool)) { job.notes.push(`${limitNote(tool)}라 @${agentObj.name}을 ${nameOf(usable[0])}로 실행했어요.`); tool = usable[0]; }
      job.summary = `@${agentObj.name} (${agentObj.label})에게 맡김`;
      job.tasks = [freshTask({ id: 't1', title: job.title, assignee: tool, prompt: job.goal, dependsOn: [], agent: agentObj.name })];
    } else if (job.mode === 'auto' && this.isSmallRequest(job)) {
      // 작은 요청: 계획·모델 선택·보고 없이 한 AI에게 바로
      const tool = this.pickFastTool(job, usable, share, cat);
      const tier = heuristicTier(job.input || job.goal);
      const c = autoCatalog(this.config)[tool]?.[tier] || {};
      job.fast = true;
      job.summary = `작은 요청이라 나누지 않고 ${nameOf(tool)} 혼자 바로 처리해요.`;
      job.tasks = [freshTask({ id: 't1', title: job.title, assignee: tool, prompt: job.goal, dependsOn: [], agent: job.agentHint && cat.agents.some((a) => a.name === job.agentHint) ? job.agentHint : null })];
      this.enforceDesignRule(job, usable, nameOf);
      const c2 = job.tasks[0].assignee === tool ? c : (autoCatalog(this.config)[job.tasks[0].assignee]?.[tier] || {});
      this.applyChoice(job, job.tasks[0], { model: c2.model, effort: c2.effort, reason: '작은 요청이라 바로 처리' }, usage);
      planned = true;
    } else if (job.mode === 'auto') {
      job.status = 'planning'; job.activePhase = 'plan'; this.emitJob(job);
      const memoryCtx = this.memoryFor(job, 'plan');
      const { planner, plan } = await makePlan({
        goal: job.goal, cwd: job.cwd, config: this.config, status, healthy: usable, memoryCtx, historyCtx,
        settings: job.settings, attachments: atts, plannerPref: job.plannerPref, usage, agents: cat.agents, share, agentHint: job.agentHint, runDir: job.runDir,
        onEvent: (ev) => this.log(job, null, ev),
        onWorker: this.phaseWorker(job), job,
      });
      if (job.status === 'cancelled') return this.finish(job);
      job.planner = planner; job.summary = plan.summary; planned = true;
      if (plan.dropped?.length) job.notes.push(`검증만 하는 작업 ${plan.dropped.length}개(${plan.dropped.map((d) => d.title).join(', ')})는 빼고 앞 작업이 직접 검증하게 했어요.`);
      job.tasks = plan.tasks.map((t) => freshTask(t));
      this.rebalance(job, usage, usable, share, limitNote, nameOf);
      this.enforceDesignRule(job, usable, nameOf);
      plan.tasks.forEach((t, i) => this.applyChoice(job, job.tasks[i], t.choice, usage));
    } else if (job.mode === 'both') {
      job.summary = '같은 명령을 Claude와 Codex가 각자 수행합니다 (비교 모드).';
      job.tasks = usable.map((tool) => freshTask({ id: tool, title: `${nameOf(tool)} 단독 수행`, assignee: tool, prompt: job.goal, dependsOn: [] }));
      for (const t of healthy) if (!usable.includes(t)) job.notes.push(`${limitNote(t)}라 비교에서 뺐어요.`);
      if (job.tasks.length < 2) job.summary += ` (지금은 ${nameOf(usable[0])}만 실행)`;
    } else {
      job.summary = `${job.mode} 단독 실행`;
      job.tasks = [freshTask({ id: 't1', title: job.title, assignee: job.mode, prompt: job.goal, dependsOn: [], agent: job.agentHint && cat.agents.some((a) => a.name === job.agentHint) ? job.agentHint : null })];
    }
    // 단독·비교 모드에서 자동 선택이 필요하면 가벼운 라우터로 고른다
    if (!planned && job.tasks.some((t) => isAuto(job.settings?.[t.assignee]))) {
      job.status = 'planning'; job.phase = 'routing'; job.activePhase = 'route'; this.emitJob(job);
      const picks = await routeTasks({ config: this.config, job, tasks: job.tasks, healthy: usable, usage, memoryCtx: this.memoryFor(job, 'route'), historyCtx, runDir: job.runDir, onEvent: (ev) => this.log(job, null, ev), onWorker: this.phaseWorker(job) });
      if (job.status === 'cancelled') return this.finish(job);
      for (const t of job.tasks) this.applyChoice(job, t, picks.get(t.id), usage);
      job.phase = null;
    } else if (!planned) {
      for (const t of job.tasks) this.applyChoice(job, t, null, usage);
    }
    if (job.status === 'cancelled') return this.finish(job);
    job.status = 'running'; job.activePhase = 'worker'; this.emitJob(job);
    writeBoard(this.config.hubDir, job);

    await this.schedule(job, historyCtx);
    if (job.status === 'cancelled') return this.finish(job);

    for (;;) {
      const workRevision = job.reconcileRevision > (job.reconciledRevision || 0) ? Math.min(job.instructionRevision, job.reconcileRevision - 1) : job.instructionRevision;
      if ((job.mode === 'auto' && job.tasks.length > 1) || job.intercepts.length) {
        job.status = 'reporting'; job.activePhase = 'report'; this.emitJob(job);
        try { job.report = await makeReport({ job, config: this.config, healthy: usable, memoryCtx: this.memoryFor(job, 'report'), runDir: job.runDir, onEvent: (ev) => this.log(job, null, ev), onWorker: this.phaseWorker(job), resumeSessionId: job.phaseRuns.report?.cliSessionId }); }
        catch (e) { job.report = null; job.error = `보고 생성 실패: ${e.message}`; this.log(job, null, { kind: 'error', text: job.error }); }
      }
      if (job.status === 'cancelled') return this.finish(job);
      if (workRevision === job.instructionRevision) break;
      // 보고 단계의 구현 지시도 실제 보완 작업으로 조정한다. 완료 결과는 보존한다.
      job.status = 'planning'; job.activePhase = 'plan'; this.emitJob(job);
      const done = job.tasks.map((t) => `## ${t.id} (${t.assignee}) ${t.title}\n담당 범위: ${t.prompt}\n완료 결과: ${truncate(t.resultText || t.error || '', 5000)}`).join('\n\n');
      const reconciled = await makePlan({ goal: `원래 목표: ${job.goal}\n\n이미 완료된 작업을 처음부터 반복하지 마세요. 새 수정 지시를 충족하는 데 필요한 보완 작업만 만드세요. 보완할 일이 없으면 tasks:[]를 반환하세요. 기존 담당 범위를 보완하면 그 작업 id와 assignee를 그대로 사용하세요.\n${done}`, cwd: job.cwd, config: this.config, status, healthy: usable, settings: job.settings, attachments: this._atts?.get(job.id) || [], memoryCtx: this.memoryFor(job, 'plan'), historyCtx, plannerPref: job.plannerPref, usage, agents: cat.agents, runDir: job.runDir, onEvent: (ev) => this.log(job, null, ev), onWorker: this.phaseWorker(job), job, allowEmpty: true, resumeSessionId: job.phaseRuns.plan?.cliSessionId || job.phaseRuns.report?.cliSessionId });
      if (job.status === 'cancelled') return this.finish(job);
      const supplements = reconciled.plan.tasks.map((t) => {
        const source = job.tasks.find((old) => old.id === t.id && old.assignee === t.assignee);
        const fresh = freshTask({ ...t, id: `r${job.instructionRevision}_${t.id}` });
        fresh.resumeSessionId = source?.sessionId || null; fresh.sourceTaskId = source?.id || null;
        fresh.settings = source?.settings || null;
        if (!fresh.settings) this.applyChoice(job, fresh, t.choice, usage);
        return fresh;
      });
      for (const t of supplements) t.dependsOn = t.dependsOn.map((d) => `r${job.instructionRevision}_${d}`).filter((d) => supplements.some((s) => s.id === d));
      const plannedRevision = job.instructionRevision;
      job.tasks.push(...supplements); job.report = null;
      job.status = 'running'; job.activePhase = 'worker'; this.emitJob(job);
      await this.schedule(job, historyCtx);
      if (job.status === 'cancelled') return this.finish(job);
      job.reconciledRevision = plannedRevision;
    }
    const failed = job.tasks.filter((t) => t.status === 'failed');
    if (job.status === 'cancelled') return this.finish(job);
    if (!job.report) job.report = job.tasks.length === 1 ? (job.tasks[0].resultText || job.tasks[0].error || '') : job.tasks.map((t) => `## ${t.title} (${t.assignee}, ${t.status})\n${t.resultText || t.error || ''}`).join('\n\n');
    fs.writeFileSync(path.join(job.runDir, 'REPORT.md'), job.report);
    job.status = failed.length === job.tasks.length ? 'failed' : failed.length || job.error || job.intercepts.some((i) => ['failed', 'partial'].includes(i.status)) ? 'partial' : 'done';
    this.finish(job);
  }

  finish(job) {
    this.prompts.cancel({ jobId: job.id, status: 'expired' }); this.prompts.clearSession(job.id);
    job.finishedAt = job.finishedAt || nowIso();
    this._atts?.delete(job.id);
    if (job.goalId && job.status !== 'cancelled') job.activePhase = 'goal-check';
    this.emitJob(job);
    try { writeBoard(this.config.hubDir, job); } catch (e) { this.log(job, null, { kind: 'error', text: `보드 기록 실패: ${e.message}` }); }
    if (job.goalId && !LIVE.has(job.status)) this.afterGoalRound(job).catch((e) => this.log(job, null, { kind: 'error', text: `목표 진행 오류: ${e.message}` }));
  }

  async schedule(job, historyCtx = '') {
    const max = Math.max(1, this.config.maxParallel || 2);
    const byId = new Map(job.tasks.map((t) => [t.id, t]));
    const active = new Set();
    return new Promise((resolve) => {
      const tick = () => {
        if (job.status === 'cancelled') { if (!active.size) resolve(); return; }
        for (const t of job.tasks) {
          if (active.size >= max) break;
          if (t.status !== 'pending') continue;
          const deps = t.dependsOn.map((d) => byId.get(d)).filter(Boolean);
          if (deps.some((d) => ['failed', 'skipped', 'cancelled', 'interrupted'].includes(d.status))) { t.status = 'skipped'; t.error = '선행 작업 실패'; this.cancelReservation(job, t); this.emitJob(job); continue; }
          if (deps.some((d) => d.status !== 'done')) continue;
          active.add(t.id);
          this.runTask(job, t, deps, historyCtx).catch((e) => { t.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; t.error = e.message; this.cancelReservation(job, t); this.emitJob(job); }).finally(() => { active.delete(t.id); tick(); });
        }
        const pending = job.tasks.some((t) => t.status === 'pending');
        if (!active.size && !pending) resolve();
        else if (!active.size && pending) {
          for (const t of job.tasks) if (t.status === 'pending') { t.status = 'skipped'; t.error = '의존 관계 해소 불가'; this.cancelReservation(job, t); }
          this.emitJob(job); resolve();
        }
      };
      tick();
    });
  }

  /** 계획 없이 바로 처리해도 되는 작은 요청인지 (config.fastPath 로 끄거나 길이 조절) */
  isSmallRequest(job) {
    const cfg = this.config.fastPath || {};
    if (cfg.enabled === false || job.goalId || job.command?.name === 'compare') return false;
    const text = String(job.command?.kind === 'command' ? job.input : (job.input || job.goal) || '').trim();
    if (!text || text.length > (cfg.maxChars || 160)) return false;
    if (text.split('\n').filter((l) => l.trim()).length > 3) return false;
    if ((text.match(/(^|\n|\s)(\d+[.)]|[①-⑩]|[-*•]\s)/g) || []).length >= 2) return false; // 여러 항목 나열
    if (/(둘\s*다|각각|비교|병렬|나눠|분담|협업|여러\s*개|동시에)/.test(text)) return false; // 나눠 달라는 요청
    if (heuristicTier(text) === 'strong' || deepEffortJustified(text)) return false;
    return true;
  }

  /** 작은 요청을 맡을 AI: 역할 지정 > 내용(화면·글은 Claude, 코드·실행은 Codex) > 남은 한도 */
  pickFastTool(job, usable, share, cat) {
    const ag = job.agentHint && cat.agents.find((a) => a.name === job.agentHint);
    const text = String(job.input || job.goal || '');
    const cl = /(UI|화면|디자인|CSS|스타일|레이아웃|문서|README|가이드|설명|번역|문구|카피|요약|이미지|일러스트|기획|아이디어|대본|글)/i.test(text);
    const cx = /(스크립트|테스트|빌드|버그|에러|오류|CLI|함수|코드|리팩터|성능|데이터|변환|자동화|설치|명령|서버|API|로그|파일)/i.test(text);
    let tool = ag && ag.tool !== 'auto' ? ag.tool : cl && !cx ? 'claude' : cx && !cl ? 'codex' : (share.claude >= share.codex ? 'claude' : 'codex');
    if (!usable.includes(tool)) tool = usable[0];
    return tool;
  }

  /** 작업의 최종 모델·강도 결정 (고정값 우선, 자동이면 선택값 + 한도 안전장치) */
  applyChoice(job, task, choice, usage) {
    const fixed = job.settings?.[task.assignee] || {};
    const ag = task.agent ? (this._cat || catalog(this.config.hubDir)).agents.find((a) => a.name === task.agent) : null;
    if (ag && isAuto(fixed)) choice = { ...(choice || {}), ...(ag.model !== 'auto' ? { model: ag.model } : {}), ...(ag.effort !== 'auto' ? { effort: ag.effort } : {}), reason: [choice?.reason, `@${ag.name} 기본 설정`].filter(Boolean).join(' · ') };
    if (isAuto(fixed)) {
      const f = finalizeChoice(this.config, task.assignee, fixed, choice || {}, usage);
      // high 보다 높은 강도는 근거가 있을 때만 (역할이 정한 강도, 원인 불명 버그·큰 설계, 목표 모드 재시도)
      const EFF = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      const floorEff = autoFloor(this.config, task.assignee).effort;
      if (fixed.effort === 'auto' && EFF.indexOf(f.effort) > EFF.indexOf(floorEff) && !(ag && ag.effort !== 'auto')
        && !(job.goalRound >= 2) && !deepEffortJustified(`${task.title}\n${task.prompt}\n${choice?.reason || ''}`)) {
        f.reason = `${f.reason ? f.reason + ' · ' : ''}${f.effort} 근거가 약해서 ${floorEff}로 낮춤 (속도 우선)`; f.effort = floorEff;
      }
      if (task.design || this.isDesignTask(job, task)) {
        const d = applyDesignModel(this.config, task.assignee, fixed, { model: f.model, effort: f.effort }, usage);
        if (d.note) f.reason = [d.note, f.reason].filter(Boolean).join(' · ');
        f.model = d.model; task.design = true;
      }
      task.settings = { model: f.model, effort: f.effort }; task.reason = f.reason || null; task.autoPicked = true;
    } else {
      task.settings = { model: fixed.model || '', effort: fixed.effort || '' }; task.reason = null; task.autoPicked = false;
    }
    task.model = task.settings.model || null; task.effort = task.settings.effort || null;
  }

  async runTask(job, task, deps, historyCtx) {
    if (job.status === 'cancelled') return;
    task.status = 'running'; task.startedAt = nowIso();
    const fixed = job.settings?.[task.assignee] || {};
    const s = task.settings || (isAuto(fixed) ? internalSettings(this.config, task.assignee, fixed) : fixed);
    task.model = s.model || null; task.effort = s.effort || null;
    this.emitJob(job);
    const memoryCtx = this.memoryFor(job, 'worker', task);
    const cat = this._cat || catalog(this.config.hubDir);
    const agentText = task.agent ? agentBrief(cat.agents.find((a) => a.name === task.agent), cat.skills) : '';
    const prompt = buildWorkerPrompt({
      job, task, siblings: job.tasks, hubDir: this.config.hubDir, memoryCtx, historyCtx, agentText,
      depResults: deps.map((d) => ({ id: d.id, title: d.title, assignee: d.assignee, text: d.resultText })),
    });
    const runDir = path.join(job.runDir, task.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);
    const worker = runWorker({
      tool: task.assignee, prompt, cwd: job.cwd, runDir, toolCfg: this.config.tools[task.assignee],
      settings: s, attachments: [...(this._atts?.get(job.id) || []), ...job.intercepts.flatMap((i) => resolveAttachments(i.attachments))],
      permission: job.settings?.permission || permissionSetting(this.config), prompts: this.prompts, jobId: job.id, taskId: task.id, phase: 'worker',
      managed: true, resumeSessionId: task.resumeSessionId || null,
      modelPolicy: { config: this.config, fixed: job.settings?.[task.assignee] || {} },
      addDirs: [this.config.hubDir, job.runDir],
      timeoutMs: (this.config.taskTimeoutMinutes || 90) * 60_000,
      onEvent: (ev) => {
        if (ev.kind === 'init' || ev.kind === 'turn') { task.sessionId = ev.sessionId || task.sessionId; task.turnId = ev.turnId || null; task.generation = ev.generation; if (ev.model) task.model = ev.model; this.emitJob(job); }
        if (ev.kind === 'tool' && (!ev.status || ev.status === 'running')) { task.toolCalls = (task.toolCalls || 0) + 1; this.emitJob(job); }
        this.log(job, task, ev);
      },
    });
    try {
      const res = await this.trackWorker(job, worker, 'worker', task);
      if (res.fellBackFrom) { task.reason = `${task.reason ? task.reason + ' · ' : ''}${res.fellBackFrom}는 이 계정에서 못 써서 ${res.fellBackTo}로 실행`; task.model = res.fellBackTo; task.settings = { ...(task.settings || {}), model: res.fellBackTo }; }
      task.resultText = res.text || ''; task.usage = res.usage || null; task.costUsd = res.costUsd ?? null; task.sessionId = res.sessionId || task.sessionId;
      if (res.cancelled || job.status === 'cancelled') task.status = 'cancelled';
      else if (res.timedOut) { task.status = 'failed'; task.error = '시간 초과'; }
      else if (res.ok) task.status = 'done';
      else { task.status = 'failed'; task.error = res.error || `종료 코드 ${res.exitCode}`; }
    } catch (e) { task.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; task.error = String(e?.message || e); }
    finally { task.finishedAt = nowIso(); this.emitJob(job); }
  }

  cancelReservation(job, task) {
    for (const i of job.intercepts || []) for (const d of i.deliveries) if (d.taskId === task.id && d.status === 'recorded') { d.status = 'cancelled'; d.error = task.error || '작업이 시작되지 않았습니다'; this.changedIntercept(job, i); }
  }

  /**
   * 한도에 맞춰 배정 조정
   *  1) 역할에 담당 AI가 정해진 서브 에이전트는 그 AI로
   *  2) 80% 이상 쓴 AI는 권장 비율만큼만 맡기고 나머지는 여유 있는 쪽으로
   */
  /** 이 작업이 디자인 작업인지 (작업 하나면 사용자 요청 원문까지 본다) */
  isDesignTask(job, task) {
    const text = job.tasks.length === 1 ? `${task.title}
${job.input || job.goal || ''}` : task.title;
    return isDesignText(this.config, text);
  }

  /** 디자인 고정 규칙: 자동 분배에서 디자인 작업은 규칙 담당(기본 Claude)에게. 다른 AI 전용 역할이 붙은 작업은 그대로 */
  enforceDesignRule(job, usable, nameOf = (t) => t) {
    const r = designRule(this.config);
    if (!r || job.mode !== 'auto') return;
    const agents = (this._cat || catalog(this.config.hubDir)).agents;
    let moved = 0;
    for (const t of job.tasks) {
      if (!this.isDesignTask(job, t)) continue;
      t.design = true;
      if (t.assignee === r.tool) continue;
      const a = t.agent && agents.find((x) => x.name === t.agent);
      if (a && a.tool !== 'auto' && a.tool !== r.tool) continue;
      if (!usable.includes(r.tool)) { job.notes.push(`디자인 작업은 ${nameOf(r.tool)} 고정이지만 지금 쓸 수 없어 ${nameOf(t.assignee)}가 맡아요.`); continue; }
      t.assignee = r.tool; moved++;
    }
    if (moved) job.notes.push(`디자인 규칙에 따라 작업 ${moved}개를 ${nameOf(r.tool)}로 옮겼어요.`);
  }

  rebalance(job, usage, usable, share, limitNote, nameOf) {
    const agents = (this._cat || catalog(this.config.hubDir)).agents;
    for (const t of job.tasks) {
      const a = t.agent && agents.find((x) => x.name === t.agent);
      if (a && a.tool !== 'auto' && a.tool !== t.assignee && usable.includes(a.tool)) t.assignee = a.tool;
    }
    if (usable.length < 2 || job.tasks.length < 2) return;
    for (const tool of usable) {
      const other = usable.find((x) => x !== tool);
      const used = 100 - (headroom(usage, tool) ?? 100);
      const otherUsed = 100 - (headroom(usage, other) ?? 100);
      if (used < WARN_AT || otherUsed >= WARN_AT) continue;
      const mine = job.tasks.filter((t) => t.assignee === tool);
      const allowed = Math.max(1, Math.round(job.tasks.length * share[tool]));
      let moved = 0;
      for (const t of [...mine].reverse()) {
        if (mine.length - moved <= allowed) break;
        const a = t.agent && agents.find((x) => x.name === t.agent);
        if (a && a.tool === tool) continue; // 그 AI 전용 역할은 유지
        t.assignee = other; moved++;
      }
      if (moved) job.notes.push(`${limitNote(tool)}라 작업 ${moved}개를 ${nameOf(other)}로 옮겼어요.`);
    }
  }

  // ---------------- 목표 모드 (/goal) ----------------
  startGoal({ text, cwd, sessionId, mode = 'auto', settings, attachments, planner, maxRounds } = {}) {
    text = String(text || '').trim();
    if (!text) throw httpError(400, '목표가 비어 있습니다');
    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !session) throw httpError(404, '세션이 없습니다');
    if (session?.goal?.status === 'active') throw httpError(409, '이 세션에 진행 중인 목표가 있어요. 중지한 뒤 새 목표를 주세요');
    if (session && session.jobIds.some((id) => LIVE.has(this.jobs.get(id)?.status))) throw httpError(409, '이 세션에서 아직 실행 중인 작업이 있습니다. 끝나거나 중지한 뒤 보내세요');
    if (!session) {
      const dir = path.resolve(String(cwd || this.config.defaultCwd));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `폴더가 없습니다: ${dir}`);
      session = this.newSessionObject(dir, null);
      this.sessions.set(session.id, session);
    }
    const max = Math.max(1, Math.min(20, Number(maxRounds) || this.config.goalMaxRounds || 6));
    session.goal = { id: `g-${shortId(6)}`, text, status: 'active', round: 0, maxRounds: max, progress: 0, remaining: '', next: '', reason: '', startedAt: nowIso(), updatedAt: nowIso(), attachments: resolveAttachments(attachments).map(({ id, name, mime, size }) => ({ id, name, mime, size })), opts: { mode, settings, planner } };
    this.emitSession(session);
    return this.nextGoalRound(session, { attachments, firstInput: `/goal ${text}` });
  }

  nextGoalRound(session, { attachments, firstInput } = {}) {
    const g = session.goal;
    if (!g || g.status !== 'active') throw httpError(409, '목표가 중지되었습니다');
    g.round += 1; g.updatedAt = nowIso();
    const job = this._create({
      goal: roundPrompt({ ...g, intercepts: [] }), input: firstInput || `${g.round}라운드: ${g.next || g.remaining || g.text}`, title: `목표 ${g.round}라운드 · ${g.text}`.slice(0, 80),
      sessionId: session.id, mode: g.opts?.mode || 'auto', settings: g.opts?.settings, planner: g.opts?.planner, attachments: attachments || g.attachments,
      command: { kind: 'goal', name: 'goal' }, goalRef: { id: g.id, round: g.round },
    });
    this.emitSession(session);
    return job;
  }

  async afterGoalRound(job) {
    const s = this.sessions.get(job.sessionId); const g = s?.goal;
    if (!g || g.id !== job.goalId || g.status !== 'active') return;
    if (job.status === 'cancelled') { Object.assign(g, { status: 'stopped', reason: '라운드를 중지해서 목표도 멈췄어요', updatedAt: nowIso() }); return this.emitSession(s); }
    if (g.checking) return;
    g.checking = true; job.activePhase = 'goal-check'; this.emitJob(job); this.emitSession(s);
    const status = await toolStatus(this.config); const healthy = healthyTools(status);
    const usage = await usageStatus(this.config).catch(() => null);
    if (g.status !== 'active' || s.goal !== g || job.status === 'cancelled') { g.checking = false; this.emitJob(job); return; }
    const usable = healthy.filter((t) => { const h = headroom(usage, t); return h == null || h > 100 - CRIT_AT; });
    let v;
    try {
      const rounds = s.jobIds.map((id) => this.jobs.get(id)).filter((j) => j && j.goalId === g.id);
      v = await checkGoal({ config: this.config, goal: g, jobs: rounds, healthy: usable.length ? usable : healthy, plannerPref: job.plannerPref, settings: job.settings, cwd: s.cwd, runDir: job.runDir, onEvent: (ev) => this.log(job, null, ev), onWorker: this.phaseWorker(job), memoryCtx: this.memoryFor(job, 'goal-check') });
    } catch (e) { if (g.status === 'active') Object.assign(g, { status: 'paused', checking: false, reason: `달성 판정 실패: ${e.message}`.slice(0, 300), updatedAt: nowIso() }); this.emitJob(job); return this.emitSession(s); }
    if (g.status !== 'active' || s.goal !== g || job.status === 'cancelled') { g.checking = false; this.emitJob(job); return; }
    Object.assign(g, { checking: false, progress: v.progress, remaining: v.remaining, next: v.next, reason: v.reason, updatedAt: nowIso() });
    if (v.done) { g.status = 'done'; g.progress = 100; }
    else if (v.blocked) g.status = 'paused';
    else if (g.round >= g.maxRounds) { g.status = 'stopped'; g.reason = `최대 ${g.maxRounds}라운드에 도달했어요. 계속하려면 "이어서"를 누르세요 · ${v.reason}`; }
    else if (!usable.length) { g.status = 'paused'; g.reason = '두 AI 모두 한도가 거의 차서 멈췄어요. 한도가 초기화된 뒤 "이어서"를 누르세요'; }
    job.activePhase = g.status === 'active' ? 'goal-transition' : null; this.emitJob(job); this.emitSession(s);
    if (g.status === 'active') { try { this.nextGoalRound(s); } catch (e) { Object.assign(g, { status: 'paused', reason: e.message }); this.emitSession(s); } }
    this.refreshInterceptState(job); this.emitJob(job);
  }

  stopGoal(id) {
    const s = this.sessions.get(id); if (!s?.goal) throw httpError(404, '목표가 없습니다');
    Object.assign(s.goal, { status: 'stopped', checking: false, reason: '사용자가 중지했어요', updatedAt: nowIso() });
    for (const jid of s.jobIds) { const j = this.jobs.get(jid); if (j && (LIVE.has(j.status) || ['goal-check', 'goal-transition'].includes(j.activePhase))) this.cancel(jid); }
    this.emitSession(s);
    return this.publicSession(s);
  }

  async resumeGoal(id) {
    const s = this.sessions.get(id); if (!s?.goal) throw httpError(404, '목표가 없습니다');
    if (s.goal.status === 'active') return this.publicSession(s);
    if (s.goal.status === 'done') throw httpError(409, '이미 달성한 목표예요');
    if (s.jobIds.some((jid) => LIVE.has(this.jobs.get(jid)?.status))) throw httpError(409, '실행 중인 작업이 끝난 뒤 이어서 할 수 있어요');
    if (s.goal.round >= s.goal.maxRounds) s.goal.maxRounds = s.goal.round + 3;
    Object.assign(s.goal, { status: 'active', reason: '', updatedAt: nowIso() });
    this.emitSession(s);
    this.nextGoalRound(s);
    return this.publicSession(s);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, '작업 없음');
    if (!LIVE.has(job.status) && !['goal-check', 'goal-transition'].includes(job.activePhase)) return publicJob(job);
    job.status = 'cancelled';
    this.prompts.cancel({ jobId: id }); this.prompts.clearSession(id);
    const g = this.sessions.get(job.sessionId)?.goal;
    if (g && g.id === job.goalId) { g.status = 'stopped'; g.checking = false; g.reason = '사용자가 중지했어요'; }
    for (const [key, e] of this.running) if (key.startsWith(`${id}/`)) { try { e.handle.cancel(); } catch {} }
    for (const i of job.intercepts || []) {
      if (i.deliveries.some((d) => ['recorded', 'waiting', 'sending'].includes(d.status))) {
        for (const d of i.deliveries) if (['recorded', 'waiting', 'sending'].includes(d.status)) { d.status = 'cancelled'; d.error = '사용자가 작업을 중지했습니다'; }
        i.status = i.deliveries.some((d) => d.status === 'delivered') ? 'partial' : 'cancelled';
        this.changedIntercept(job, i);
      }
    }
    for (const t of job.tasks) if (t.status === 'pending') t.status = 'cancelled';
    job.finishedAt = nowIso();
    this.emitJob(job);
    return publicJob(job);
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (this.canIntercept(job)) this.cancel(id);
    this.jobs.delete(id);
    const s = this.sessions.get(job.sessionId);
    if (s) s.jobIds = s.jobIds.filter((x) => x !== id);
    this.save();
    this.emit('event', { type: 'job_removed', jobId: id, sessionId: job.sessionId });
    return true;
  }

  retryTask(jobId, taskId) {
    const job = this.jobs.get(jobId); if (!job) throw httpError(404, '작업 없음');
    const task = job.tasks.find((t) => t.id === taskId); if (!task) throw httpError(404, '하위 작업 없음');
    if (task.status === 'running') throw httpError(409, '실행 중');
    if (this.canIntercept(job)) throw httpError(409, '실행 중인 작업이 끝난 뒤 재시도하세요');
    Object.assign(task, { status: 'pending', error: null, resultText: null, startedAt: null, finishedAt: null, toolCalls: 0 });
    const revived = reviveDependents(job.tasks, taskId); // 이 작업 실패로 건너뛴 후속 작업도 함께 다시
    if (revived.length) this.log(job, null, { kind: 'stderr', text: `건너뛰었던 후속 작업 ${revived.join(', ')}도 함께 다시 실행합니다` });
    job.status = 'running'; job.finishedAt = null; job.error = null; this.emitJob(job);
    (async () => {
      await this.schedule(job, this.historyContext(job));
      if (job.status === 'cancelled') return this.finish(job);
      const failed = job.tasks.filter((t) => t.status === 'failed');
      job.status = failed.length === job.tasks.length ? 'failed' : failed.length ? 'partial' : 'done';
      job.report = job.tasks.length === 1 ? (job.tasks[0].resultText || job.tasks[0].error || '') : job.tasks.map((t) => `## ${t.title} (${t.assignee}, ${t.status})\n${t.resultText || t.error || ''}`).join('\n\n');
      this.finish(job);
    })().catch((e) => { job.status = 'failed'; job.error = String(e.message || e); this.finish(job); });
    return publicJob(job);
  }

  taskLog(jobId, key) {
    const job = this.jobs.get(jobId); if (!job || !/^[\w-]+$/.test(key)) return [];
    try { return fs.readFileSync(path.join(job.runDir, `${key}.log.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
  }
}

/** taskId 실패 때문에 건너뛴(skipped) 후속 작업들을 다시 대기로 되돌린다. 되살린 id 목록을 돌려준다 */
export function reviveDependents(tasks, taskId) {
  const revived = new Set([taskId]); const out = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) {
      if (t.status !== 'skipped' || revived.has(t.id) || !t.dependsOn.some((d) => revived.has(d))) continue;
      Object.assign(t, { status: 'pending', error: null, resultText: null, startedAt: null, finishedAt: null, toolCalls: 0 });
      revived.add(t.id); out.push(t.id); grew = true;
    }
  }
  return out;
}

function freshTask(t) {
  return { id: t.id, title: t.title, assignee: t.assignee, agent: t.agent || null, prompt: t.prompt, dependsOn: t.dependsOn || [], status: 'pending', startedAt: null, finishedAt: null, resultText: null, error: null, sessionId: null, usage: null, costUsd: null, toolCalls: 0, model: null, effort: null, settings: null, reason: null, autoPicked: false };
}

export function publicJob(job) {
  return { ...job, tasks: job.tasks.map((t) => ({ ...t, prompt: t.prompt?.length > 4000 ? t.prompt.slice(0, 4000) + '…' : t.prompt })) };
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
