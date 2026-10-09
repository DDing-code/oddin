// 세션·작업(Job) 상태 머신 + 스케줄러: 계획 → 병렬 실행(의존 순서) → 보고
// 세션 = 한 폴더에서 이어지는 대화. 같은 세션의 다음 명령은 이전 명령·보고를 맥락으로 받는다.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ExecutionQueue, workspaceKey } from './execution-queue.mjs';
import { readLogPage } from './logs.mjs';
import { ROOT, DATA_DIR, RUNS_DIR, jobId, shortId, nowIso, readJson, writeJsonAtomic, appendLine, projectMemoryFolder, truncate } from './util.mjs';
import { toolStatus, healthyTools } from './tools.mjs';
import { runWorker, canRestartResume } from './workers.mjs';
import { makePlan, makeReport, buildWorkerPrompt, pickPlanner } from './planner.mjs';
import { readBoard, boardText, boardDir, applyNoteOps, buildCuratePrompt, parseCuration, editableFrom, applyMemoryOps, undoMemory, normalizeNotes, CURATE_SCHEMA } from './memory-curate.mjs';
import { saveAssets, undoAssets } from './oddin-assets.mjs';
import { memoryBundle, writeBoard } from './memory.mjs';
import { blockNames } from './memory-blocks.mjs';
import { resolveSettings } from './options.mjs';
import { resolveAttachments } from './attachments.mjs';
import { usageStatus, balanceShare, headroom, CRIT_AT, WARN_AT } from './usage.mjs';
import { catalog, parseInput, agentBrief } from './catalog.mjs';
import { roundPrompt, checkGoal } from './goals.mjs';
import { isAuto, finalizeChoice, routeTasks, internalSettings, autoCatalog, autoFloor, heuristicTier, deepEffortJustified, isDesignText, designRule, designTarget, applyDesignModel, capPremium, premiumAllowed, raiseToStandalone, isVisualText, badModels } from './router.mjs';
import { knownProjects, validWorkdir } from './projects.mjs';
import { normalizeIntercept, fingerprint, newDelivery, aggregateIntercept, instructionText, interceptError } from './intercepts.mjs';
import { SessionTools } from './session-tools.mjs';
import { Checkpoints } from './checkpoints.mjs';
import { PromptManager, permissionSetting, normalizeQuestions } from './prompts.mjs';

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const MODES = new Set(['auto', 'claude', 'codex', 'both']);

// 지시문 맥락 한도(글자). config.context 로 바꿀 수 있다 — planHistory·workerHistory·memory.{plan,route,worker,report}
const CONTEXT = { planHistory: 12_000, workerHistory: 8_000 };
const MEMORY_LIMITS = { plan: { limit: 10_000, files: 5 }, route: { limit: 5_000, files: 3 }, worker: { limit: 8_000, files: 4 }, report: { limit: 5_000, files: 3 }, goal: { limit: 6_000, files: 4 } };

// '커밋 어디까지 했어' 같은 상태 질문의 명사와 실제 실행 요청을 구분한다.
const QUESTION_WORK_RE = /(해\s*(줘|봐|줄|주|라|요)|하[자라]|(?:할|바꿀|넣을|지울|고칠|만들)\s*(수|래)|해도\s*(돼|되)|만들어|고쳐|고치|바꿔|바꾸|뽑아|그려|지워|돌려|올려|넣어|빼\s*줘|옮겨|합쳐|알아봐|계속\s*시도|(?:수정|추가|구현|작성|진행|제작|빌드|배포|삭제|커밋|푸시|설치|실행)\s*(좀|부탁|요청|ㄱㄱ|고고|해|하자|할래|가능|(?=[?？.!~]*$)))/;

export class JobManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.execution = new ExecutionQueue(Math.max(1, config.maxParallel || 2));
    this.workspaces = new ExecutionQueue();
    this.jobs = new Map();
    this.sessions = new Map();
    this.running = new Map(); // `${jobId}/${taskId|phase:phase}` -> 소유한 제어 핸들
    this._curations = new Map(); // sessionId -> 진행 중인 기억 정리 (다음 요청이 잠깐 기다린다)
    this.sessionTools = new SessionTools(this);
    this.checkpoints = new Checkpoints(config, { jobs: () => this.list(), emit: (ev) => { this.emit('event', ev); this.save(); } });
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
      if (j.curation?.status === 'running') Object.assign(j.curation, { status: 'failed', error: '허브가 다시 시작돼서 기억 정리가 중단됐어요' });
      if (LIVE.has(j.status) && !j.reserved) { // 예약(시작 전)은 그대로 두고 부팅 뒤 startReserved 가 이어 간다
        j.status = 'interrupted'; j.finishedAt = j.finishedAt || nowIso();
        for (const t of j.tasks || []) if (t.status === 'running' || t.status === 'pending') t.status = 'interrupted';
      }
      this.jobs.set(j.id, j);
    }
    for (const s of readJson(SESSIONS_FILE, [])) {
      if (s.goal?.status === 'active') { s.goal.status = 'paused'; s.goal.reason = s.goal.resumeOnStart ? '새 버전으로 바꾸는 중이에요. 곧 이어서 해요' : '서버가 다시 시작돼서 멈췄어요. "이어서"를 누르면 계속해요'; }
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
    if (this.frozen) return; // 새 버전으로 재시작하는 중: 멈춘 그대로를 남긴다
    if (immediate) { writeJsonAtomic(JOBS_FILE, [...this.jobs.values()]); this.save(); return; }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        writeJsonAtomic(JOBS_FILE, [...this.jobs.values()]);
        writeJsonAtomic(SESSIONS_FILE, [...this.sessions.values()]);
        this.persistenceError = null;
      } catch (e) { this.persistenceError = e.message; this.emit('event', { type: 'persistence-error', error: e.message }); }
    }, 150);
  }

  // ---------------- 세션 ----------------
  newSessionObject(cwd, title, at = nowIso()) {
    return { id: `s-${Date.now().toString(36)}${shortId(4)}`, title: title || '새 세션', cwd: path.resolve(cwd), createdAt: at, updatedAt: at, jobIds: [], titled: !!title };
  }
  createSession({ cwd, title, isolate = this.config.gitOps?.defaultIsolate || false, forkOf, group } = {}) {
    if (!cwd && forkOf?.sessionId) { const source = this.sessionTools.get(forkOf.sessionId); cwd = source.git?.cleanedAt ? source.git.repo : source.cwd; }
    cwd = path.resolve(String(cwd || this.config.defaultCwd));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw httpError(400, `폴더가 없습니다: ${cwd}`);
    const s = this.newSessionObject(cwd, title ? String(title).slice(0, 80) : null);
    this.sessionTools.initialize(s, { isolate, forkOf });
    if (group && this.groups?.has(group)) s.group = group;
    this.sessions.set(s.id, s);
    this.emitSession(s);
    return this.publicSession(s);
  }
  /** 이름 바꾸기·고정 (고정은 정렬 순서를 흔들지 않게 updatedAt 을 건드리지 않는다) */
  updateSession(id, { title, pinned, group, cwd } = {}) {
    const s = this.sessions.get(id); if (!s) throw httpError(404, '세션 없음');
    if (typeof title === 'string' && title.trim()) { s.title = title.trim().slice(0, 80); s.titled = true; }
    if (typeof pinned === 'boolean') s.pinned = pinned ? nowIso() : null;
    // 묶음(lib/session-groups.mjs): 묶음 id 또는 null(묶음에서 빼기)
    if (group !== undefined) {
      if (group === null || group === '') s.group = null;
      else { if (this.groups && !this.groups.has(String(group))) throw httpError(404, '묶음이 없어요'); s.group = String(group); }
    }
    if (cwd !== undefined) this.changeCwd(s, cwd);
    this.emit('event', { type: 'session', session: this.publicSession(s) }); this.save();
    return this.publicSession(s);
  }
  /** 작업 폴더 바꾸기: 다음 요청부터 그 폴더에서 실행(지난 대화·결과는 그대로). 실행 중이거나 격리(worktree) 세션은 안 됨 */
  changeCwd(s, raw) {
    if (s.jobIds.some((jid) => this.canIntercept(this.jobs.get(jid)))) throw httpError(409, '진행 중인 작업이 끝난 뒤에 작업 폴더를 바꿀 수 있어요');
    if (s.git?.isolated || s.git?.worktree) throw httpError(409, '격리(worktree) 세션은 작업 폴더를 바꿀 수 없어요. 그 폴더에서 새 세션을 만들어 주세요');
    const v = validWorkdir(raw, this.config);
    if (v.error && !this.isDefaultDir(raw)) throw httpError(400, `이 폴더는 작업 폴더로 쓸 수 없어요: ${v.error}`);
    const dir = v.dir || path.resolve(String(raw));
    if (dir.toLowerCase() === String(s.cwd).toLowerCase() && !s.workdir) return;
    s.cwd = dir; s.workdir = null;
    this.sessionTools.git.initialize(s, false);
  }
  /** 이 폴더(안쪽 포함)에서 진행 중인 작업이 있는가 — 폴더 이름 바꾸기 전에 */
  folderBusy(dir) {
    const inside = (p) => { if (!p) return false; const a = path.resolve(String(p)).toLowerCase(), b = path.resolve(String(dir)).toLowerCase(); return a === b || a.startsWith(b + path.sep); };
    return [...this.jobs.values()].some((j) => LIVE.has(j.status) && (inside(j.cwd) || inside(this.sessions.get(j.sessionId)?.cwd)));
  }
  /** 폴더 이름을 바꾼 뒤: 그 안을 쓰던 세션의 작업 폴더 경로를 새 이름으로(보관 세션 포함) → 바꾼 세션 수 */
  renameFolderRefs(from, to) {
    const a = path.resolve(String(from)), lower = a.toLowerCase();
    const move = (p) => { if (typeof p !== 'string' || !p) return p; const r = path.resolve(p); const l = r.toLowerCase(); return l === lower || l.startsWith(lower + path.sep) ? path.join(to, r.slice(a.length)) : p; };
    let n = 0;
    for (const s of this.sessions.values()) {
      const before = JSON.stringify([s.cwd, s.workdir, s.git?.repo, s.git?.worktree]);
      s.cwd = move(s.cwd); if (s.workdir) s.workdir = move(s.workdir);
      if (s.git?.repo) s.git.repo = move(s.git.repo); if (s.git?.worktree) s.git.worktree = move(s.git.worktree);
      if (JSON.stringify([s.cwd, s.workdir, s.git?.repo, s.git?.worktree]) !== before) { n++; this.emit('event', { type: 'session', session: this.publicSession(s) }); }
    }
    if (n) this.save();
    return n;
  }
  deleteSession(id) {
    const s = this.sessions.get(id); if (!s) return false;
    this.sessionTools.idle(s); this.sessionTools.assertUnreferenced(id);
    for (const jid of s.jobIds) { const j = this.jobs.get(jid); if (j && LIVE.has(j.status)) this.cancel(jid); if (j) this.checkpoints.forget(j); this.jobs.delete(jid); }
    this.sessions.delete(id); this.save();
    this.emit('event', { type: 'session_removed', sessionId: id });
    return true;
  }
  publicSession(s) {
    const jobs = s.jobIds.map((id) => this.jobs.get(id)).filter(Boolean);
    const live = jobs.some((j) => this.canIntercept(j));
    const last = jobs.at(-1);
    return { ...s, archived: !!s.archived, git: s.git || null, forkOf: s.forkOf || null, jobCount: jobs.length, status: live ? 'running' : last?.status || 'empty' };
  }
  listSessions({ archived = false } = {}) { return [...this.sessions.values()].filter((s) => !!s.archived === archived).map((s) => this.publicSession(s)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  sessionJobs(id) { const s = this.sessions.get(id); return s ? s.jobIds.map((j) => this.jobs.get(j)).filter(Boolean).map(publicJob) : []; }
  /** 작업 넘기기 기록(server.mjs handoff): 작업 카드에 보이고, 같은 세션의 다음 넘기기는 그 PC 세션에 이어서 */
  recordHandoff(jobId, h) {
    const job = this.jobs.get(jobId); if (!job) return;
    (job.handoffs ||= []).push({ ...h, at: nowIso() });
    job.notes = [...(job.notes || []), `${h.peer} PC로 넘김: ${String(h.goal).slice(0, 160)}`];
    const s = this.sessions.get(job.sessionId);
    if (s) s.handoffs = { ...(s.handoffs || {}), [h.peerId]: h.sessionId };
    this.emit('event', { type: 'job', job: publicJob(job) });
    if (s) this.emitSession(s); else this.save();
  }
  emitSession(s) { this.emit('event', { type: 'session', session: this.publicSession(s) }); this.save(); }

  historyContext(job, limit = 24_000, opts = {}) {
    return this.sessionTools.historyContext(job, limit, opts);
  }
  // 지시문 다이어트(2026-10-04 "단독보다 멍청함" 조사: 작업자 지시문의 94%가 이전 대화·전역 메모리 목록이었다)
  // 플래너·배정: 결정 노트 + 최근 4건, 작업자: 결정 노트 + 최근 2건(건당 3천 자). 한도는 config.context 로 바꿀 수 있다
  ctxLimit(key) { return Number(this.config.context?.[key]) || CONTEXT[key]; }
  planHistory(job) { return this.historyContext(job, this.ctxLimit('planHistory'), { maxItems: 4, itemChars: 3000 }); }
  workerHistory(job) { return job.answer ? this.historyContext(job, 6000, { maxItems: 4, itemChars: 1000 }) : this.historyContext(job, this.ctxLimit('workerHistory'), { maxItems: 2, itemChars: 3000 }); }
  /** 허브 기본 작업 폴더(지금 기본값 또는 예전 ai-hub/workspace)인가 — 이런 세션만 플래너가 프로젝트 폴더로 옮길 수 있다 */
  isDefaultDir(dir) {
    const d = path.resolve(String(dir || '')).toLowerCase();
    return [this.config.defaultCwd, path.join(ROOT, 'workspace')].some((x) => x && path.resolve(x).toLowerCase() === d);
  }
  /** 세션의 다음 요청을 시작할 폴더: 기본 작업 폴더 세션이면 직전에 옮겨 간 프로젝트 폴더(session.workdir), 아니면 세션 폴더 */
  startDir(session) {
    if (session.workdir && this.isDefaultDir(session.cwd) && !session.git?.worktree) {
      const v = validWorkdir(session.workdir, this.config);
      if (v.dir) return v.dir;
    }
    return session.cwd;
  }
  /** 플래너가 고른 프로젝트 폴더로 옮긴다(작업자가 그 폴더의 지침·스킬·메모리를 받게). 옮겼으면 true */
  applyWorkdir(job, raw) {
    const s = this.sessions.get(job.sessionId);
    if (!raw || this.config.workdir?.auto === false || !s) return false;
    if (!this.isDefaultDir(s.cwd) || s.git?.worktree) { job.notes.push(`플래너가 작업 폴더로 ${raw}를 제안했지만 이 세션은 직접 고른 폴더(${s.cwd})라 그대로 뒀어요.`); return false; }
    const v = validWorkdir(raw, this.config);
    if (v.error) { job.notes.push(`플래너가 고른 작업 폴더(${raw})는 쓰지 않았어요: ${v.error}`); return false; }
    const keep = path.resolve(job.cwd).toLowerCase() === v.dir.toLowerCase();
    s.workdir = this.isDefaultDir(v.dir) ? null : v.dir;
    if (keep) return false;
    const from = job.cwd;
    job.cwd = v.dir; job.memorySlug = projectMemoryFolder(this.config.hubDir, v.dir);
    job.notes.push(`요청을 보고 작업 폴더를 ${v.dir}(으)로 옮겼어요. 그 프로젝트의 지침·스킬·메모리를 작업자가 그대로 받아요. (원래 ${from})`);
    this.log(job, null, { kind: 'info', text: `작업 폴더: ${from} → ${v.dir}` });
    return true;
  }
  /**
   * 같은 세션의 후속 요청: 직전 요청에서 같은 AI가 같은 폴더에서 끝낸 CLI 대화를 이어 쓴다(읽은 파일·시행착오를 가진 채).
   * 같은 AI·역할은 한 작업만 이어 쓴다. 기획·구현·검수는 각자의 대화를 잇고, 같은 CLI 대화를 두 작업에 주지 않는다.
   * 갈래 세션·24시간 지난 대화·다른 폴더는 새로 시작한다.
   */
  continuation(job, task) {
    if (job.answer || this.config.continuity?.resume === false) return null;
    job._continued ||= {};
    // 역할: 작업 / 디자인 기획 / 눈으로 확인 / @에이전트(리뷰어 등은 그 역할 대화끼리) — 모델·강도는 바뀌어도 같은 대화를 잇는다
    const roleOf = (t) => (t.visualCheck ? 'check' : t.designPlan ? 'plan' : t.agent ? `agent:${t.agent}` : 'work');
    const role = roleOf(task);
    const key = `${task.assignee}/${role}`;
    if (job._continued[key]) return null;
    const s = this.sessions.get(job.sessionId); if (!s) return null;
    // 같은 세션의 최근 요청 5개까지 거슬러 같은 AI·같은 역할의 마지막 대화를 찾는다(직전 요청에 그 역할이 없었어도, 2026-10-05)
    const maxAge = (this.config.continuity?.maxAgeHours || 24) * 3_600_000, depth = this.config.continuity?.lookback ?? 5;
    const earlier = s.jobIds.map((id) => this.jobs.get(id)).filter((j) => j && !j.answer && j.id !== job.id && j.createdAt < job.createdAt && ['done', 'partial'].includes(j.status)).slice(-depth).reverse();
    for (const prev of earlier) {
      if (path.resolve(prev.cwd).toLowerCase() !== path.resolve(job.cwd).toLowerCase()) continue;
      if (Date.now() - new Date(prev.finishedAt || prev.createdAt).getTime() > maxAge) break;
      // 검수·기획 대화에는 구현자가 읽은 파일과 시행착오가 없다. 같은 역할의 대화만 잇는다.
      const cand = (prev.tasks || []).filter((t) => t.assignee === task.assignee && t.status === 'done' && t.sessionId && roleOf(t) === role
        && !Object.values(job._continued).includes(t.sessionId))
        .sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || ''))).at(-1);
      if (!cand) continue;
      job._continued[key] = cand.sessionId;
      return { jobId: prev.id, taskId: cand.id, sessionId: cand.sessionId };
    }
    return null;
  }

  // ---------------- 작업 ----------------
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  /**
   * 파일 열기·보기를 허용할 작업 폴더(보관한 세션 포함): 세션 폴더·옮겨 간 프로젝트 폴더·작업이 실제로 실행된 폴더.
   * 플래너가 작업을 프로젝트 폴더로 옮기거나(applyWorkdir) 세션이 다른 폴더로 옮겨 가도 예전 결과물을 계속 열 수 있게 한다.
   */
  workFolders() {
    const out = new Set();
    for (const s of this.sessions.values()) for (const d of [s.cwd, s.workdir]) if (d) out.add(d);
    for (const j of this.jobs.values()) if (j.cwd) out.add(j.cwd);
    return [...out];
  }
  get(id) { return this.jobs.get(id) || null; }

  canIntercept(job) {
    if (!job || job.status === 'cancelled' || job.status === 'interrupted') return false;
    if (job.reserved) return false; // 예약한 요청은 아직 시작 전 — 끼어들기 대상도, "진행 중"도 아니다
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
    for (const t of job.tasks || []) if (t.status === 'pending' || (t.status === 'running' && !active.some(([, e]) => e.task?.id === t.id))) deliveries.push(newDelivery(`task:${t.id}`, 'worker', t.id, true));
    if (!deliveries.length) deliveries.push(newDelivery(`phase:${job.activePhase || 'plan'}`, job.activePhase || 'plan', null, true));
    const i = { id: `i-${x.clientRequestId}`, clientRequestId: x.clientRequestId, seq: revision, revision, text: x.text, attachments: x.attachments, status: 'accepted', acceptedAt: nowIso(), updatedAt: nowIso(), deliveries, error: null };
    job.intercepts ||= []; job.intercepts.push(i); job.instructionRevision = revision;
    try { this.save({ immediate: true }); }
    catch (e) { job.intercepts.pop(); job.instructionRevision = revision - 1; throw interceptError(500, 'INTERCEPT_PERSIST_FAILED', `수정 지시를 저장하지 못했습니다: ${e.message}`); }
    const g = this.sessions.get(job.sessionId)?.goal;
    if (g && g.id === job.goalId && g.status === 'active') { g.intercepts ||= []; g.intercepts.push({ ...i, sourceJobId: job.id }); }
    if (job.answer || job.activePhase === 'report' || (job.activePhase === 'worker' && job.tasks.length && !active.length && job.tasks.every((t) => !['pending', 'running'].includes(t.status)))) job.reconcileRevision = revision;
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
  async trackWorker(job, launch, phase, task = null) {
    const waitingAt = Date.now();
    const revision = job.instructionRevision || 0;
    const release = await this.execution.acquire({ owner: job.id, priority: phase === 'memory' ? 1 : 0 });
    if (!release || this.frozen || job.status === 'cancelled') { release?.(); return { ok: false, cancelled: true, text: '', error: '작업이 중지되었습니다' }; }
    let handle;
    try { handle = typeof launch === 'function' ? launch() : launch; }
    catch (e) { release(); throw e; }
    const beganAt = Date.now();
    const key = `${job.id}/${task?.id || 'phase:' + phase}`;
    const e = { handle, phase, task, deliveryKey: task ? `task:${task.id}` : `phase:${phase}`, adoptedRevision: revision, pending: new Map() };
    try {
      this.log(job, task, { kind: 'timing', phase, queueMs: beganAt - waitingAt });
      this.running.set(key, e);
      job.phaseRuns ||= {};
      const record = task || (job.phaseRuns[phase] = { tool: handle.getState().tool, revision });
      record.instructionRevision = revision;
      // 출발 프롬프트에 들어 있는 접수는 실제 CLI 수신 확인을 받아야 delivered가 된다.
      const initial = phase === 'memory' ? [] : (job.intercepts || []).filter((i) => i.status !== 'cancelled' && i.revision <= revision);
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
      if (phase !== 'memory') for (const i of job.intercepts || []) if (i.status !== 'cancelled' && i.revision > revision) this.sendIntercept(job, e, i);
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
    } finally { if (this.running.get(key) === e) this.running.delete(key); try { handle.close(); } finally { release(); } this.log(job, task, { kind: 'timing', phase, durationMs: Date.now() - beganAt }); }
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
  /** 세션의 블록 연결/해제 → 선택기 옵션 { on, off } (없으면 null = 예전처럼 관련성으로만) */
  sessionBlocks(sessionId) {
    const b = this.sessions.get(sessionId)?.memory?.blocks || {};
    const on = Object.keys(b).filter((k) => b[k] === 'on'), off = Object.keys(b).filter((k) => b[k] === 'off');
    return on.length || off.length ? { on, off } : null;
  }
  /** 세션 기억 설정: 블록마다 on(연결)·off(해제)·auto(관련 있을 때만), 새 기억 저장 위치 shared·local·none */
  setSessionMemory(id, { blocks, save } = {}) {
    const s = this.sessions.get(id); if (!s) throw httpError(404, '세션 없음');
    const cur = { blocks: { ...(s.memory?.blocks || {}) }, save: s.memory?.save || 'shared' };
    if (blocks && typeof blocks === 'object') {
      for (const [k, v] of Object.entries(blocks)) {
        if (typeof k !== 'string' || !k.trim() || k.length > 120) continue;
        if (v === 'on' || v === 'off') cur.blocks[k] = v; else delete cur.blocks[k];
      }
    }
    if (save !== undefined) { if (!['shared', 'local', 'none'].includes(save)) throw httpError(400, '저장 위치는 shared·local·none 중 하나'); cur.save = save; }
    s.memory = cur;
    this.emit('event', { type: 'session', session: this.publicSession(s) }); this.save();
    return this.publicSession(s);
  }
  /** 블록 이름이 바뀌면 세션 설정도 따라 바꾼다 */
  renameSessionBlock(from, to) {
    for (const s of this.sessions.values()) if (s.memory?.blocks && from in s.memory.blocks) { s.memory.blocks[to] = s.memory.blocks[from]; delete s.memory.blocks[from]; this.emit('event', { type: 'session', session: this.publicSession(s) }); }
    this.save();
  }
  /** delivered = { 파일: 해시 } — 이어 쓰는 대화에 이미 넣은 메모리(그대로면 빼고 새로 관련된·바뀐 것만) */
  memoryFor(job, phase, task = null, delivered = null) {
    // 전역 메모리 목록은 두 CLI 지침에 이미 있어 빼고, 단계별 한도 안에서 관련 본문만 (지시문 다이어트)
    const lim = MEMORY_LIMITS[phase] || MEMORY_LIMITS.worker;
    const result = memoryBundle(this.config.hubDir, { cwd: job.cwd, query: `${job.goal}\n${task?.title || ''}\n${task?.prompt || ''}\n${instructionText(job)}`, limit: Number(this.config.context?.memory?.[phase]) || lim.limit, maxFiles: lim.files, skipGlobalIndex: this.config.context?.globalIndex !== true, blocks: this.sessionBlocks(job.sessionId), delivered });
    this.lastMemory = result.manifest;
    if (delivered && !result.manifest.selected?.length && !result.manifest.indexes?.length) return '(이 대화에 이미 넣은 공유 메모리에서 바뀐 것·새로 관련된 것 없음)';
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
    if (parsed.kind === 'goal') { if (body.reserve) throw httpError(400, '목표(/goal)는 예약할 수 없어요. 지금 작업이 끝난 뒤 보내 주세요'); return this.startGoal({ ...body, text: parsed.text }); }
    if (parsed.kind === 'command') return this._create({ ...body, goal: parsed.prompt, input: raw, mode: parsed.mode || body.mode, command: { kind: 'command', name: parsed.name }, agentHint: parsed.agent });
    if (parsed.kind === 'skill') return this._create({ ...body, goal: parsed.prompt, input: raw, command: { kind: 'skill', name: parsed.name } });
    return this._create({ ...body, goal: parsed.text, input: raw, command: { kind: 'agent', name: parsed.name }, agent: parsed.name });
  }

  _create({ goal, cwd, mode = 'auto', title, sessionId, settings, attachments, planner, input = null, command = null, agent = null, agentHint = null, goalRef = null, group = null, reserve = false } = {}) {
    if (this.frozen) throw httpError(503, 'ODDIN이 새 버전으로 바뀌는 중이에요. 잠시 뒤 다시 보내 주세요');
    goal = String(goal || '').trim();
    const atts = resolveAttachments(attachments);
    if (!goal && atts.length) goal = '첨부한 이미지를 보고 요청을 처리해 주세요.';
    if (!goal) throw httpError(400, '명령이 비어 있습니다');
    if (!MODES.has(mode)) throw httpError(400, `알 수 없는 분배 방식: ${mode}`);

    let session = sessionId ? this.sessions.get(sessionId) : null;
    if (sessionId && !session) throw httpError(404, '세션이 없습니다');
    if (session) this.sessionTools.assertWritable(session);
    // 진행 중(또는 예약된) 작업이 있는 세션: 평소엔 거절(화면은 끼어들기로 보냄), reserve 면 예약 — 앞 작업이 모두 끝난 뒤 순서대로 시작(startReserved)
    const busy = session ? session.jobIds.map((jid) => this.jobs.get(jid)).filter((j) => j && (j.reserved || this.canIntercept(j))) : [];
    if (busy.length && !goalRef && !reserve) throw httpError(409, '이 세션에서 아직 실행 중인 작업이 있습니다. 끝나거나 중지한 뒤 보내세요');
    const reserved = !!(reserve && busy.length && !goalRef);
    if (!session) {
      const dir = path.resolve(String(cwd || this.config.defaultCwd));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `폴더가 없습니다: ${dir}`);
      session = this.newSessionObject(dir, null);
      if (group && this.groups?.has(String(group))) session.group = String(group);
      this.sessionTools.initialize(session);
      this.sessions.set(session.id, session);
    }
    if (!session.titled && !session.jobIds.length) session.title = (session.goal?.text || input || goal).split('\n')[0].slice(0, 60);

    const id = jobId();
    const job = {
      id, sessionId: session.id, title: (title || (input || goal).split('\n')[0]).slice(0, 80), goal, cwd: this.startDir(session), mode,
      input, command, agent, agentHint, goalId: goalRef?.id || null, goalRound: goalRef?.round || null, notes: [],
      settings: { ...resolveSettings(this.config, settings), permission: permissionSetting(this.config, settings?.permission), pace: settings?.pace === 'speed' ? 'speed' : 'quality' }, plannerPref: ['claude', 'codex'].includes(planner) ? planner : 'auto',
      attachments: atts.map(({ id: aid, name, mime, size }) => ({ id: aid, name, mime, size })),
      status: 'queued', createdAt: nowIso(), startedAt: null, finishedAt: null,
      planner: null, summary: null, tasks: [], report: null, error: null,
      intercepts: goalRef ? structuredClone(session.goal?.intercepts || []).map((i) => ({ ...i, deliveries: [], status: 'accepted' })) : [],
      instructionRevision: goalRef ? (session.goal?.intercepts?.length || 0) : 0, phaseRuns: {}, activePhase: 'queued', canIntercept: true,
      ...(reserved ? { reserved: true, after: busy.at(-1).id, canIntercept: false, activePhase: null } : {}), // 예약: 수정 지시도 받지 않고 기다린다
      runDir: path.join(RUNS_DIR, id), memorySlug: projectMemoryFolder(this.config.hubDir, this.startDir(session)),
    };
    fs.mkdirSync(job.runDir, { recursive: true });
    fs.writeFileSync(path.join(job.runDir, 'GOAL.md'), `# ${job.title}\n\n- 세션: ${session.title} (${session.id})\n- 폴더: ${job.cwd}\n- 분배: ${mode}\n- 설정: ${JSON.stringify(job.settings)}\n- 첨부: ${job.attachments.map((a) => a.name).join(', ') || '없음'}\n- 생성: ${job.createdAt}\n\n${goal}\n`);
    this.jobs.set(id, job);
    session.jobIds.push(id);
    this.emitJob(job);
    if (reserved) { this.log(job, null, { kind: 'info', text: `예약됨 — '${busy.at(-1).title}'이(가) 끝나면 시작해요` }); return publicJob(job); }
    this.run(job, atts).catch((e) => {
      if (job.status === 'cancelled') return this.finish(job);
      job.status = 'failed'; job.error = String(e?.message || e); job.errorCode = e?.code || null; job.finishedAt = nowIso();
      this.log(job, null, { kind: 'error', text: job.error });
      this.finish(job);
    });
    return publicJob(job);
  }

  async run(job, atts) {
    job.startedAt = nowIso();
    const direct = job.mode !== 'both' && !job.agent && !job.agentHint;
    job.answer = direct && this.isQuestion(job);
    job.fast = direct && !job.answer && this.isSmallRequest(job);
    // 질문은 스냅샷을 생략한다. 쓰기 작업은 실제 폴더가 정해진 뒤 잠금 안에서 시작·종료를 기록한다.
    const preparingAt = Date.now();
    // 독립적인 상태 조회는 함께 시작한다. 질문은 저장된 원문·결과로 답하므로 기억 정리를 기다리지 않는다.
    const [status, usage] = await Promise.all([toolStatus(this.config), usageStatus(this.config).catch(() => null), job.answer ? null : this.waitCuration(job.sessionId)]);
    this.log(job, null, { kind: 'timing', phase: 'prepare', durationMs: Date.now() - preparingAt });
    if (job.status === 'cancelled') return this.finish(job);
    const healthy = healthyTools(status);
    if (!healthy.length) throw new Error('사용 가능한 AI가 없습니다. 상태 표시줄의 안내대로 로그인하세요.');
    if ((job.mode === 'claude' || job.mode === 'codex') && !healthy.includes(job.mode)) throw new Error(`${job.mode} 를 지금 쓸 수 없습니다 (로그인 확인). 다른 분배 방식을 고르세요.`);
    const historyCtx = this.planHistory(job), workerCtx = this.workerHistory(job);
    this._atts = this._atts || new Map();
    this._atts.set(job.id, atts);
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
    } else if (job.answer) {
      const tool = job.mode === 'auto' ? this.answerTool(job, usable, share, cat) : job.mode;
      job.summary = `질문이라 계획 없이 ${nameOf(tool)}가 바로 답해요.`;
      job.tasks = [freshTask({ id: 't1', title: job.title, assignee: tool, prompt: job.goal, dependsOn: [], agent: null })];
      job.tasks[0].visualOutput = false;
      this.applyChoice(job, job.tasks[0], { reason: '질문이라 바로 답함' }, usage);
      planned = true;
    } else if (job.fast) {
      // 작은 요청: 계획·모델 선택·보고 없이 한 AI에게 바로
      const tool = job.mode === 'auto' ? this.answerTool(job, usable, share, cat) : job.mode;
      const tier = heuristicTier(job.input || job.goal);
      const c = autoCatalog(this.config)[tool]?.[tier] || {};
      job.summary = `작은 요청이라 나누지 않고 ${nameOf(tool)} 혼자 바로 처리해요.`;
      job.tasks = [freshTask({ id: 't1', title: job.title, assignee: tool, prompt: job.goal, dependsOn: [], agent: job.agentHint && cat.agents.some((a) => a.name === job.agentHint) ? job.agentHint : null })];
      this.applyChoice(job, job.tasks[0], { model: c.model, effort: c.effort, reason: '작은 수정은 한 담당자가 직접 확인까지 처리' }, usage);
      planned = true;
    } else if (job.mode === 'auto') {
      job.status = 'planning'; job.activePhase = 'plan'; this.emitJob(job);
      const memoryCtx = this.memoryFor(job, 'plan');
      const planOnce = () => makePlan({
        goal: job.goal, cwd: job.cwd, config: this.config, status, healthy: usable, memoryCtx, historyCtx,
        settings: job.settings, attachments: atts, plannerPref: job.plannerPref, usage, agents: cat.agents, share, agentHint: job.agentHint, runDir: job.runDir,
        projects: knownProjects(this.config, this.listSessions()), workdirAuto: this.isDefaultDir(this.sessions.get(job.sessionId)?.cwd) && !this.sessions.get(job.sessionId)?.git?.worktree,
        cwdLabel: this.isDefaultDir(job.cwd) ? '허브 기본 작업 폴더(특정 프로젝트 폴더가 아님)' : '이 세션이 직전에 작업한 프로젝트 폴더',
        onEvent: (ev) => this.log(job, null, ev),
        onWorker: this.phaseWorker(job), job,
      });
      let { planner, plan } = await planOnce();
      if (job.status === 'cancelled') return this.finish(job);
      // 요청이 모호하면 계획 전에 사용자에게 먼저 묻고, 답을 목표에 붙여 한 번 더 계획한다
      if (plan.questions?.length && !job.clarified) {
        await this.askPlanQuestions(job, planner, plan);
        if (job.status === 'cancelled') return this.finish(job);
        ({ planner, plan } = await planOnce());
        if (job.status === 'cancelled') return this.finish(job);
      }
      if (!plan.tasks.length) throw new Error('질문에 답을 받은 뒤에도 계획에 작업이 없어요. 요청을 조금 더 구체적으로 적어 주세요');
      job.planner = planner; job.summary = plan.summary; planned = true;
      // 프로젝트 폴더로 옮기면 체크포인트를 새 폴더 기준으로 다시 찍는다
      if (this.applyWorkdir(job, plan.workdir)) job.checkpoint = null;
      if (plan.dropped?.length) job.notes.push(`검증만 하는 작업 ${plan.dropped.length}개(${plan.dropped.map((d) => d.title).join(', ')})는 빼고 앞 작업이 직접 검증하게 했어요.`);
      job.tasks = plan.tasks.map((t) => freshTask(t));
      this.rebalance(job, usage, usable, share, limitNote, nameOf);
      const designAdded = this.enforceDesignRule(job, usable, nameOf, usage);
      plan.tasks.forEach((t, i) => this.applyChoice(job, job.tasks[i], t.choice, usage));
      for (const t of designAdded) this.applyChoice(job, t, { reason: t.visualCheck ? '눈으로 확인' : '디자인 기획' }, usage);
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

    await this.runScheduled(job, workerCtx);
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
        fresh.resumeSessionId = job.answer ? null : source?.sessionId || null; fresh.sourceTaskId = source?.id || null;
        fresh.settings = source?.settings || null;
        if (!fresh.settings) this.applyChoice(job, fresh, t.choice, usage);
        return fresh;
      });
      for (const t of supplements) t.dependsOn = t.dependsOn.map((d) => `r${job.instructionRevision}_${d}`).filter((d) => supplements.some((s) => s.id === d));
      const plannedRevision = job.instructionRevision;
      if (supplements.length) job.answer = false;
      job.tasks.push(...supplements); job.report = null;
      job.status = 'running'; job.activePhase = 'worker'; this.emitJob(job);
      await this.runScheduled(job, workerCtx);
      if (job.status === 'cancelled') return this.finish(job);
      job.reconciledRevision = plannedRevision;
    }
    const failed = job.tasks.filter((t) => t.status === 'failed');
    if (job.status === 'cancelled') return this.finish(job);
    if (!job.report) job.report = job.tasks.length === 1 ? (job.tasks[0].resultText || job.tasks[0].error || '') : job.tasks.map((t) => `## ${t.title} (${t.assignee}, ${t.status})\n${t.resultText || t.error || ''}`).join('\n\n');
    fs.writeFileSync(path.join(job.runDir, 'REPORT.md'), job.report);
    job.status = failed.length === job.tasks.length ? 'failed' : failed.length || job.error || job.intercepts.some((i) => ['failed', 'partial'].includes(i.status)) ? 'partial' : 'done';
    this.finish(job);
    // 질문·답은 jobs/REPORT에 남는다. 변경 지시 없는 질문마다 별도 기억 정리 AI를 호출하지 않는다.
    if (!job.answer || job.intercepts.length) this.curate(job);
  }

  // ---------------- 기억 정리 (세션 결정 노트 · 장기 기억) ----------------
  // 요청이 끝난 뒤 한 번: 결정 노트 스냅샷을 이 요청에 남기고, 장기 기억 후보를 공유 메모리에 적용한다
  curate(job) {
    if (this.config.memory?.curate === false || !['done', 'partial'].includes(job.status)) return null;
    const p = this.runCuration(job).catch((e) => {
      job.curation = { ...(job.curation || {}), status: 'failed', error: e.message, at: nowIso() };
      this.log(job, null, { kind: 'error', phase: 'memory', text: `기억 정리 실패: ${e.message}` });
      this.emitJob(job);
    }).finally(() => { if (this._curations.get(job.sessionId) === p) this._curations.delete(job.sessionId); });
    this._curations.set(job.sessionId, p);
    return p;
  }
  async waitCuration(sessionId, ms = (this.config.memory?.waitSeconds ?? 20) * 1000) {
    const p = this._curations.get(sessionId);
    if (p) { let timer; await Promise.race([p, new Promise((r) => { timer = setTimeout(r, ms); })]); clearTimeout(timer); }
  }
  async runCuration(job) {
    job.curation = { status: 'running', startedAt: nowIso() }; this.emitJob(job);
    const s = this.sessions.get(job.sessionId);
    const prev = this.sessionTools.notesFor(s, job);
    const board = readBoard(job.runDir);
    const slug = job.memorySlug || projectMemoryFolder(this.config.hubDir, job.cwd);
    const bundle = memoryBundle(this.config.hubDir, { cwd: job.cwd, query: `${job.goal}\n${job.report || ''}`.slice(0, 8000), limit: 18_000, maxFileChars: 9_000, maxFiles: 5, skipGlobalIndex: true, blocks: this.sessionBlocks(job.sessionId) });
    const editable = editableFrom(this.config.hubDir, slug, bundle.manifest);
    const tool = pickPlanner(this.config, healthyTools(await toolStatus(this.config)), job.plannerPref);
    if (!tool) throw new Error('정리할 AI를 지금 쓸 수 없어요');
    const dir = path.join(job.runDir, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const save = s?.memory?.save || 'shared';
    let blocks = []; try { blocks = blockNames(this.config.hubDir); } catch {}
    // 공유를 허용한 세션이고 드라이브 ODDIN 폴더가 있으면 다시 쓸 결과물도 골라 ODDIN 자산으로(lib/oddin-assets.mjs)
    let hub = null; try { hub = this.driveHub?.() || null; } catch {}
    const assetsOn = !!hub && save === 'shared' && this.config.driveHub?.assets !== false && this.config.memory?.longTerm !== false;
    const prompt = buildCuratePrompt({ job, notes: prev, board, memoryText: bundle.text, editable, instruction: instructionText(job), blocks, save, assets: assetsOn });
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
    fs.writeFileSync(path.join(dir, 'memory-context.json'), JSON.stringify(bundle.manifest, null, 2));
    // Codex 는 출력 형식을 스키마로 강제한다(2026-10-04 형식을 놓친 답 — 다른 언어·코드 조각 — 으로 실패한 뒤)
    let schemaFile = null;
    if (tool === 'codex') { schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(CURATE_SCHEMA)); }
    // 파일을 고치지 않는 정리라 실행 기록 폴더에서 돌린다(사용자 프로젝트를 건드리지 않게)
    const ask = async (text) => {
      const res = await this.trackWorker(job, () => runWorker({
        readOnly: true,
        tool, prompt: text, cwd: dir, runDir: dir, toolCfg: this.config.tools[tool], timeoutMs: 6 * 60_000, schemaFile,
        settings: internalSettings(this.config, tool, job.settings?.[tool] || {}),
        modelPolicy: { config: this.config, fixed: job.settings?.[tool] || {} },
        onEvent: (ev) => this.log(job, null, { ...ev, phase: 'memory', tool }),
      }), 'memory');
      if (!res.ok) throw new Error(`정리 CLI 실행 실패 [${res.errorKind || 'CLI_ERROR'}]: ${res.error || '응답 없음'}`);
      return res.text;
    };
    let out;
    try { out = parseCuration(await ask(prompt)); }
    catch (e) {
      if (!/JSON/.test(e.message)) throw e;
      // 한 번 더: 형식만 다시 강조
      this.log(job, null, { kind: 'error', phase: 'memory', text: '정리 결과를 읽지 못해 한 번 더 시켜요' });
      out = parseCuration(await ask(`${prompt}\n\n# 다시\n앞 답은 JSON 으로 읽을 수 없었습니다. 위 "답 형식"의 JSON 하나만 한국어로 답하세요. 설명·코드·다른 언어를 섞지 마세요.`));
    }
    const n = applyNoteOps(prev, out.notes, job.id);
    // 세션이 "저장 안 함"이면 장기 기억은 건너뛰고(결정 노트는 남김), "이 PC만"이면 새 기억을 memory-local 에
    const memory = this.config.memory?.longTerm === false || save === 'none' ? []
      : applyMemoryOps({ hubDir: this.config.hubDir, slug, ops: out.memory, editable, jobId: job.id, undoDir: dir, root: save === 'local' ? 'local' : 'shared' });
    let assets = [];
    if (assetsOn && out.assets?.length) {
      const mentioned = [job.report || '', ...(job.tasks || []).map((t) => t.resultText || '')].join('\n');
      try { assets = await saveAssets({ hub, hubDir: this.config.hubDir, items: out.assets, mentioned, source: { machine: this.machineName?.() || '', at: nowIso(), request: job.goal } }); }
      catch (e) { assets = [{ name: '자산', status: 'skipped', why: e.message }]; }
    }
    job.sessionNotes = n.notes;
    job.curation = { status: 'done', startedAt: job.curation.startedAt, at: nowIso(), tool, notes: n.stats, total: n.notes.length, memory, assets };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ notes: n, memory, assets }, null, 2));
    const applied = memory.filter((m) => m.status === 'applied'), saved = assets.filter((a) => a.status === 'saved' || a.status === 'same');
    this.log(job, null, { kind: 'memory', phase: 'memory', text: `기억 정리: 결정 노트 +${n.stats.added} · 고침 ${n.stats.updated} · 뺌 ${n.stats.removed}, 장기 기억 ${applied.length}건${applied.length ? ` (${applied.map((m) => m.name).join(', ')})` : ''}${saved.length ? `, ODDIN 자산 ${saved.length}건 (${saved.map((a) => a.rel).join(', ')})` : ''}` });
    this.emitJob(job);
  }
  undoCuration(jobId) {
    const job = this.get(jobId);
    if (!job) throw httpError(404, '작업을 찾을 수 없어요');
    const hasMem = job.curation?.memory?.some((m) => m.status === 'applied'), hasAssets = job.curation?.assets?.some((a) => a.status === 'saved' && a.created);
    if (!hasMem && !hasAssets) throw httpError(409, '되돌릴 장기 기억·자산이 없어요');
    const out = hasMem ? undoMemory(path.join(job.runDir, 'memory')) : [];
    let hub = null; try { hub = this.driveHub?.() || null; } catch {}
    const assetsUndo = hasAssets ? undoAssets({ hub, hubDir: this.config.hubDir, results: job.curation.assets }) : [];
    job.curation = { ...job.curation, undoneAt: nowIso(), undo: out, assetsUndo };
    this.emitJob(job);
    return { undo: out };
  }
  // 실패한(또는 다시 하고 싶은) 기억 정리를 한 번 더
  recurate(jobId) {
    const job = this.get(jobId);
    if (!job) throw httpError(404, '작업을 찾을 수 없어요');
    if (!['done', 'partial'].includes(job.status)) throw httpError(409, '끝난 작업만 다시 정리할 수 있어요');
    if (job.curation?.status === 'running') throw httpError(409, '이미 정리 중이에요');
    this.curate(job);
    return { curation: job.curation || null };
  }
  sessionNotes(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw httpError(404, '세션을 찾을 수 없어요');
    return { notes: this.sessionTools.notesFor(s), editedAt: s.notesEdit?.at || null };
  }
  setSessionNotes(sessionId, list) {
    const s = this.sessions.get(sessionId);
    if (!s) throw httpError(404, '세션을 찾을 수 없어요');
    s.notesEdit = { at: nowIso(), notes: normalizeNotes(list) };
    s.updatedAt = nowIso();
    this.emit('event', { type: 'session', session: this.publicSession(s) }); this.save();
    return this.sessionNotes(sessionId);
  }

  /** 예약한 요청 시작(2026-10-10 "인터셉트할지 예약으로 할지"): 그 세션에 진행 중인 작업이 하나도 없을 때 가장 먼저 예약한 것부터 하나씩. 끝나면 finish 가 다시 부른다 */
  startReserved(sessionId, pickId = null) {
    const s = this.sessions.get(sessionId); if (!s || this.frozen) return null;
    const jobs = s.jobIds.map((id) => this.jobs.get(id)).filter(Boolean);
    if (jobs.some((j) => !j.reserved && this.canIntercept(j))) return null;
    const next = (pickId && jobs.find((j) => j.id === pickId && j.reserved && j.status === 'queued')) || jobs.find((j) => j.reserved && j.status === 'queued'); if (!next) return null;
    delete next.reserved; next.after = null; next.canIntercept = true; next.activePhase = 'queued'; next.cwd = this.startDir(s);
    this.log(next, null, { kind: 'info', text: pickId === next.id ? '지금 보내기로 예약한 요청을 바로 시작해요' : '앞 작업이 끝나서 예약한 요청을 시작해요' });
    this.emitJob(next);
    this.run(next, resolveAttachments(next.attachments || [])).catch((e) => {
      if (next.status === 'cancelled') return this.finish(next);
      next.status = 'failed'; next.error = String(e?.message || e); next.errorCode = e?.code || null; next.finishedAt = nowIso();
      this.log(next, null, { kind: 'error', text: next.error });
      this.finish(next);
    });
    return next;
  }

  /**
   * 예약한 요청 지금 보내기(2026-10-10 "예약 메세지 지금 전송 기능"): 기다리지 않고 그 세션의 지금 작업에 끼어들기(수정 지시)로 넘기고 예약은 지운다.
   * 지금 작업이 없으면(막 끝남) 그 예약을 바로 시작한다. 지금 작업에 끼어들 수 없으면 거절하고 예약은 그대로 둔다.
   * /스킬·@에이전트로 예약한 것도 입력한 글 그대로 수정 지시가 된다(새 요청이 아니므로 분배·모델 설정은 지금 작업 것을 따른다).
   */
  sendReservedNow(id) {
    const job = this.get(id); if (!job) throw httpError(404, '작업 없음');
    if (!job.reserved || job.status !== 'queued') throw httpError(409, '예약 중인 요청이 아니에요(이미 시작했거나 취소했어요)');
    const s = this.sessions.get(job.sessionId); if (!s) throw httpError(404, '세션이 없습니다');
    const live = s.jobIds.map((jid) => this.jobs.get(jid)).filter((j) => j && !j.reserved && this.canIntercept(j)).at(-1);
    if (!live) {
      const started = this.startReserved(job.sessionId, job.id);
      if (!started) throw httpError(409, '지금은 보낼 수 없어요. 잠시 뒤 다시 눌러 주세요');
      return { mode: 'started', job: publicJob(started) };
    }
    const text = String(job.input || job.goal || '').trim();
    const r = this.acceptIntercept(live.id, { sessionId: job.sessionId, clientRequestId: `rsnow-${job.id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80), text, attachments: (job.attachments || []).map(({ id: aid, name }) => ({ id: aid, name })) });
    this.remove(job.id); // 예약 카드는 지우고, 그 글은 지금 작업의 수정 지시로 보인다
    return { mode: 'intercept', target: live.id, job: r.job, intercept: r.intercept };
  }

  finish(job) {
    if (this.frozen) return; // 새 버전으로 바꾸는 중: 끝난 것으로 처리하지 않는다(기억 정리·목표 다음 라운드도 시작하지 않음)
    this.prompts.cancel({ jobId: job.id, status: 'expired' }); this.prompts.clearSession(job.id);
    job.finishedAt = job.finishedAt || nowIso();
    this._atts?.delete(job.id);
    if (job.goalId && job.status !== 'cancelled') job.activePhase = 'goal-check';
    this.emitJob(job); // 완료는 바로 알리고, 끝 스냅샷은 뒤에서 찍는다 (체크포인트 이벤트로 따로 알림)
    if (!LIVE.has(job.status)) this.startReserved(job.sessionId); // 끝난 뒤(중지·실패 포함) 예약한 요청이 있으면 이어서
    try { writeBoard(this.config.hubDir, job); } catch (e) { this.log(job, null, { kind: 'error', text: `보드 기록 실패: ${e.message}` }); }
    // 같은 폴더의 스냅샷은 잠금 순서대로 처리되므로, 다음 목표 라운드의 시작 스냅샷은 이 끝 스냅샷 뒤에 찍힌다
    const ended = this.checkpoints.end(job).catch(() => {});
    if (job.goalId && !LIVE.has(job.status)) this.afterGoalRound(job).catch((e) => this.log(job, null, { kind: 'error', text: `목표 진행 오류: ${e.message}` }));
    return ended;
  }

  async runScheduled(job, historyCtx = '') {
    if (job.answer) return this.schedule(job, historyCtx);
    const release = await this.workspaces.acquire({ owner: job.id, folder: workspaceKey(job.cwd) });
    if (!release || this.frozen || job.status === 'cancelled') { release?.(); return; }
    try {
      if (this.driveGuard) await this.driveGuard(job);
      await this.checkpoints.begin(job);
      if (!this.frozen && job.status !== 'cancelled') await this.schedule(job, historyCtx);
    } finally {
      try { await this.checkpoints.end(job); } finally { release(); }
    }
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

  /**
   * 짧은 상태·설명 질문은 구두점 없이도 바로 답한다. 작업 지시·복잡한 분석·특수 요청은 기존 경로.
   */
  isQuestion(job) {
    const cfg = this.config.answerPath || {};
    if (cfg.enabled === false || job.goalId || job.command || job.agent || job.agentHint || (job.attachments?.length || 0) > 2 || job.intercepts?.some((i) => i.status !== 'cancelled')) return false;
    const text = String(job.input || job.goal || '').trim();
    if (!text || text.length > (cfg.maxChars || 300) || QUESTION_WORK_RE.test(text) || heuristicTier(text) === 'strong' || deepEffortJustified(text)) return false;
    return /[?？]\s*$/.test(text) || /(했어|됐어|했니|됐니|했나요|됐나요|맞아|맞지|끝났어|끝났니|남았어|있어|없어|뭐야|인가요|한가요|어떻게\s*돼)[.!;~\s]*$/.test(text) || /(?:왜|어디|언제|얼마나|무엇|뭐가)[^\n]*(?:니|까|지|나요|돼|야|함|음|끝나|느려|걸려|어디|언제)[.!;~\s]*$/.test(text);
  }
  /** 질문·작은 수정을 맡을 AI: 직전 담당을 유지하고, 못 쓰면 빠른 선택. 대화 재개는 continuation에서 따로 결정. */
  answerTool(job, usable, share, cat) {
    const s = this.sessions.get(job.sessionId);
    const earlier = s?.jobIds.map((id) => this.jobs.get(id)).filter((j) => j && j.id !== job.id && ['done', 'partial'].includes(j.status)) || [];
    const last = earlier.filter((j) => !j.answer).at(-1) || earlier.at(-1);
    const t = last?.tasks?.filter((x) => x.status === 'done' && !x.visualCheck).sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || ''))).at(-1);
    return t && usable.includes(t.assignee) ? t.assignee : this.pickFastTool(job, usable, share, cat);
  }
  isSmallRequest(job) {
    const cfg = this.config.fastPath || {};
    // ponytail: 명시된 작은 수정만 규칙으로 판정한다. 범위가 모호하거나 새 작업이면 기존 플래너에 맡긴다.
    if (cfg.enabled !== true || job.goalId || job.command || job.agent || job.agentHint || job.attachments?.length || job.intercepts?.some((i) => i.status !== 'cancelled') || (job.cwd && this.isDefaultDir(job.cwd))) return false;
    const text = String(job.command?.kind === 'command' ? job.input : (job.input || job.goal) || '').trim();
    if (!text || text.length > (cfg.maxChars || 160)) return false;
    if (text.split('\n').filter((l) => l.trim()).length > 3) return false;
    if ((text.match(/(^|\n|\s)(\d+[.)]|[①-⑩]|[-*•]\s)/g) || []).length >= 2) return false; // 여러 항목 나열
    if (/(둘\s*다|각각|비교|병렬|나눠|분담|협업|여러\s*개|동시에)/.test(text)) return false; // 나눠 달라는 요청
    if (heuristicTier(text) === 'strong' || deepEffortJustified(text)) return false;
    if (/(전체|전부|모든|일괄|처음부터|새로|그리고|하고|한\s*뒤|한\s*다음|복구|되돌|롤백|배포|푸시|릴리스|출시|결제|인증|데이터베이스)/.test(text)) return false;
    return /(오타|문구|텍스트|글자|제목|이름|라벨|링크|URL|주석|들여쓰기|줄바꿈|여백|간격|정렬|크기|색상|배경색|버튼색|명령어)/i.test(text) && /(고쳐|고치|바꿔|바꾸|수정|늘려|줄여|키워|작게|크게|다듬|지워|제거|삭제|추가|넣어|빼)/.test(text);
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
    // 한도 전환으로 넘겨받은 디자인 기획: 옮기기 전 담당 기준으로 고른 모델 대신 전환 모델에서 시작한다
    const dsw = task.designPlan && task.designTarget?.switched && task.designTarget.tool === task.assignee ? task.designTarget : null;
    if (dsw && fixed.model === 'auto') choice = { ...(choice || {}), model: dsw.model };
    const vr = designRule(this.config);
    if (task.visualCheck && vr?.check && task.assignee === vr.check.tool) { task.design = true; if (fixed.model === 'auto') choice = { ...(choice || {}), model: vr.check.model }; }
    if (vr?.mode === 'whole' && task.assignee === vr.tool && (task.visual || isDesignText(this.config, `${task.title}\n${task.prompt}\n${job.tasks.length === 1 ? (job.input || job.goal || '') : ''}`))) {
      task.visual = true; task.design = true;
      if (fixed.model === 'auto') choice = { ...(choice || {}), model: vr.model };
    }
    if (isAuto(fixed)) {
      const f = finalizeChoice(this.config, task.assignee, fixed, choice || {}, usage);
      // high 보다 높은 강도는 근거가 있을 때만 (역할이 정한 강도, 원인 불명 버그·큰 설계, 목표 모드 재시도)
      const EFF = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      const floorEff = autoFloor(this.config, task.assignee).effort;
      const pace = job.settings?.pace === 'speed' ? 'speed' : 'quality';
      if (pace === 'speed' && fixed.effort === 'auto' && EFF.indexOf(f.effort) > EFF.indexOf(floorEff) && !(ag && ag.effort !== 'auto')
        && !(job.goalRound >= 2) && !deepEffortJustified(`${task.title}\n${task.prompt}\n${choice?.reason || ''}`)) {
        f.reason = `${f.reason ? f.reason + ' · ' : ''}${f.effort} 근거가 약해서 ${floorEff}로 낮춤 (속도 우선)`; f.effort = floorEff;
      }
      if (task.visualCheck && vr?.check && task.assignee === vr.check.tool && fixed.model === 'auto' && !badModels.has(vr.check.model)) {
        f.model = vr.check.model; f.reason = [`눈으로 확인 규칙: ${vr.check.model}`, f.reason].filter(Boolean).join(' · ');
      }
      if (task.visual && vr?.mode === 'whole') { // 눈으로 보는 결과물은 한도 안전장치가 최상위 모델을 내려도 규칙 모델(Astra) 유지
        const d = applyDesignModel(this.config, task.assignee, fixed, { model: f.model, effort: f.effort }, usage);
        if (d.note) f.reason = [d.note, f.reason].filter(Boolean).join(' · ');
        f.model = d.model;
      }
      if (task.designPlan || task.designMake) { // Fable(한도 전환 중이면 Astra)은 디자인 기획·시안 제작에만 (구현·검증 작업은 일반 자동 선택)
        const d = applyDesignModel(this.config, task.assignee, fixed, { model: f.model, effort: f.effort }, usage, task.designTarget);
        if (d.note) f.reason = [d.note, f.reason].filter(Boolean).join(' · ');
        f.model = d.model; f.effort = d.effort || f.effort; task.design = true;
      }
      // 최상위 모델(Fable·Astra)은 기획·디자인 기획·중요한 글쓰기에만
      const cap = capPremium(this.config, task.assignee, f.model, premiumAllowed(this.config, task, job.tasks.length === 1 ? (job.input || job.goal || '') : ''));
      if (cap.note) { f.model = cap.model; f.reason = [f.reason, cap.note].filter(Boolean).join(' · '); }
      // 품질 우선(기본): 자동 강도를 평소 단독 설정(Codex config.toml)까지 올린다 — 단독으로 쓸 때보다 얕게 생각하지 않게
      // 단순 질문·작은 수정은 사용자 하한(기본 high)으로 바로 처리. 그 외 품질 우선만 평소 강도까지 올린다.
      if (pace === 'quality' && fixed.effort === 'auto' && !job.answer && !job.fast) {
        const up = raiseToStandalone(this.config, task.assignee, f.model, f.effort, usage, { cap: this.config.quality?.maxEffort || 'xhigh' });
        if (up.note) { f.effort = up.effort; f.reason = [f.reason, up.note].filter(Boolean).join(' · '); }
      }
      task.settings = { model: f.model, effort: f.effort }; task.reason = f.reason || null; task.autoPicked = true;
    } else {
      task.settings = { model: fixed.model || '', effort: fixed.effort || '' }; task.reason = null; task.autoPicked = false;
    }
    task.model = task.settings.model || null; task.effort = task.settings.effort || null;
  }

  async runTask(job, task, deps, historyCtx) {
    if (this.frozen) return; // 새 버전으로 바꾸는 중: 새 작업자를 띄우지 않는다(다음 시작이 이어 함)
    if (job.status === 'cancelled') return;
    task.status = 'running'; task.startedAt = nowIso();
    const fixed = job.settings?.[task.assignee] || {};
    const s = task.settings || (isAuto(fixed) ? internalSettings(this.config, task.assignee, fixed) : fixed);
    task.model = s.model || null; task.effort = s.effort || null;
    this.emitJob(job);
    const cat = this._cat || catalog(this.config.hubDir);
    const agentText = task.agent ? agentBrief(cat.agents.find((a) => a.name === task.agent), cat.skills) : '';
    const bdir = boardDir(job.runDir);
    fs.mkdirSync(bdir, { recursive: true });
    // 같은 세션의 후속 요청이면 직전 CLI 대화를 이어 쓰고, 그 뒤 다른 담당자가 받은 요청·수정도 붙인다.
    if (!task.resumeSessionId && !task.continuedFrom && !task.continueFailed) {
      const c = this.continuation(job, task);
      if (c) { task.resumeSessionId = c.sessionId; task.continuedFrom = c; task.reason = [task.reason, `직전 요청(${c.jobId})의 대화를 이어서 씀`].filter(Boolean).join(' · '); this.emitJob(job); }
    }
    // 메모리: 이어 쓰는 대화에는 그 대화에 이미 넣은 것(내용 그대로)은 빼고 보낸다. 새 대화로 다시 시작하면 전부(2026-10-05 토큰 줄이기)
    const memoryCtx = this.memoryFor(job, 'worker', task);
    const sentOf = (m) => Object.fromEntries([...(m?.selected || []), ...(m?.indexes || [])].map((x) => [x.file, x.hash]));
    const fullSent = sentOf(this.lastMemory);
    const prevTask = task.continuedFrom ? (this.get(task.continuedFrom.jobId)?.tasks || []).find((t) => t.id === task.continuedFrom.taskId) : null;
    const memoryDelta = prevTask?.memorySent ? this.memoryFor(job, 'worker', task, prevTask.memorySent) : null;
    task.memorySent = { ...(prevTask?.memorySent || {}), ...fullSent };
    const promptFor = (continued) => buildWorkerPrompt({
      job, task, siblings: job.tasks, hubDir: this.config.hubDir, memoryCtx: continued && memoryDelta != null ? memoryDelta : memoryCtx, agentText, continued, driveFolder: this.driveInfo?.(job) || null, resumed: !!(task.resumedAfterRestart && task.resumeSessionId), machines: this.machines?.() || null, browserTools: !job.answer && !!this.browserTool,
      historyCtx: continued ? this.historyContext(job, this.ctxLimit('workerHistory'), { afterJobId: continued.jobId }) : historyCtx,
      board: boardText(readBoard(job.runDir)), boardDir: bdir, curate: this.config.memory?.curate !== false,
      depResults: deps.map((d) => ({ id: d.id, title: d.title, assignee: d.assignee, status: d.status, text: d.resultText, error: d.error })),
    });
    const prompt = promptFor(task.continuedFrom || null);
    const runDir = path.join(job.runDir, task.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);
    const launch = (prompt) => runWorker({
      tool: task.assignee, prompt, cwd: job.cwd, runDir, toolCfg: this.config.tools[task.assignee],
      settings: s, attachments: [...(this._atts?.get(job.id) || []), ...job.intercepts.flatMap((i) => resolveAttachments(i.attachments))],
      permission: job.settings?.permission || permissionSetting(this.config), prompts: this.prompts, jobId: job.id, taskId: task.id, phase: 'worker',
      readOnly: !!job.answer,
      browser: !job.answer && browserOn(this.config), // Claude in Chrome(사용자 Chrome) — ODDIN 브라우저가 켜져 있으면 기본으로 끔
      browserTool: !job.answer ? this.browserTool?.(job, task) || null : null, // ODDIN 브라우저 도구(MCP) — 두 작업자 공통, 계획·보고·기억 정리에는 안 붙임
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
      let res = await this.trackWorker(job, () => launch(prompt), 'worker', task);
      // 이어 쓰기가 실패하면(대화가 없어졌거나 열 수 없음) 새 대화로 한 번 다시
      if (canRestartResume(res, task) && (task.continuedFrom || (task.resumedAfterRestart && task.resumeSessionId)) && job.status !== 'cancelled') {
        this.log(job, task, { kind: 'error', text: `직전 대화 이어 쓰기 실패(${truncate(res.error || `종료 코드 ${res.exitCode}`, 200)}) → 새 대화로 다시 시작` });
        task.resumeSessionId = null; task.continuedFrom = null; task.continueFailed = true; task.resumedAfterRestart = false;
        task.reason = [task.reason, '이어 쓰기 실패로 새 대화'].filter(Boolean).join(' · ');
        const fresh = promptFor(null);
        fs.writeFileSync(path.join(runDir, 'prompt.md'), fresh);
        res = await this.trackWorker(job, () => launch(fresh), 'worker', task);
      }
      if (res.fellBackFrom) { task.reason = `${task.reason ? task.reason + ' · ' : ''}${res.fellBackFrom}는 이 계정에서 못 써서 ${res.fellBackTo}로 실행`; task.model = res.fellBackTo; task.settings = { ...(task.settings || {}), model: res.fellBackTo }; }
      task.resultText = res.text || ''; task.usage = res.usage || null; task.costUsd = res.costUsd ?? null; task.sessionId = res.sessionId || task.sessionId;
      if (res.cancelled || job.status === 'cancelled') task.status = 'cancelled';
      else if (res.timedOut) { task.status = 'failed'; task.error = '시간 초과'; }
      else if (res.ok) task.status = 'done';
      else { task.status = 'failed'; task.error = res.error || `종료 코드 ${res.exitCode}`; }
    } catch (e) { task.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; task.error = String(e?.message || e); }
    finally { task.finishedAt = nowIso(); job.board = readBoard(job.runDir); this.emitJob(job); }
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
  /** 계획 전 질문: 승인·질문 카드로 묻고 답(또는 시간 초과 자동 답)을 목표에 붙인다 */
  async askPlanQuestions(job, planner, plan) {
    const questions = normalizeQuestions(plan.questions.map((q, i) => ({ ...q, id: `q${i + 1}`, isOther: true })), 'claude');
    job.activePhase = 'plan-question'; job.notes.push('계획 전에 확인할 것이 있어 질문했어요.'); this.emitJob(job);
    this.log(job, null, { kind: 'message', phase: 'plan', text: `계획 전에 질문했어요: ${questions.map((q) => q.question).join(' / ')}` });
    let answer = null;
    try {
      answer = await this.prompts.request(
        { jobId: job.id, taskId: null, phase: 'plan', tool: planner, kind: 'question', category: 'question', title: '시작하기 전에 확인할게요', detail: { questions, reason: plan.summary || '' } },
        { permission: permissionSetting(this.config, job.settings?.permission), owner: `${job.id}/plan-question` });
    } catch {}
    if (job.status === 'cancelled') return false;
    const picked = (q) => [].concat(answer?.answers?.[q.id] ?? []).map(String).filter(Boolean);
    const lines = questions.map((q) => `- ${q.question} → ${picked(q).join(', ') || '(답 없음)'}`);
    const auto = !answer || answer.automatic || answer.action === 'deny';
    job.goal = `${job.goal}\n\n# 사용자 답변 (계획 전 질문)\n${lines.join('\n')}${auto ? '\n(시간 안에 답이 없어 가장 합리적인 해석으로 진행)' : ''}`;
    job.clarified = true; job.activePhase = 'plan'; this.emitJob(job);
    return !auto;
  }

  /**
   * 디자인 규칙 (사용자 요구 2026-10-03 갱신: "페이블 비싸니까 디자인 기획만 페이블 맡기자")
   * 디자인이 섞인 작업은 '디자인 기획'(규칙 담당·Fable, 명세만)과 구현·검증(다른 AI, 기획에 의존)으로 나눈다.
   * 기획만 하는 작업은 나누지 않고 그대로 기획 담당에게 준다. 다른 AI 전용 역할이 붙은 작업은 담당을 바꾸지 않는다.
   * 새 기획 작업은 작업 목록 끝에 붙이고 돌려준다(계획 순서대로 모델을 고르는 호출부의 짝이 어긋나지 않게).
   * 한도 전환(사용자 요구 2026-10-04): Fable 전용 주간 한도가 기준 이상이면 기획 담당이 Codex·gpt-6-astra 로 바뀐다(router.designTarget).
   * 결정은 작업의 designTarget 에 적어 두고 applyChoice 가 그대로 따른다. 구현·검증 담당(Sol 우선, Opus)은 바뀌지 않는다.
   */
  /**
   * 눈으로 보는 결과물(사용자 규칙 2026-10-04 "눈으로 보는건 무조건 아스트라가 하자"): 규칙 담당(Codex·gpt-6-astra) 한 작업자가
   * 기획부터 구현·눈 확인까지 끝까지 맡는다. 나누지 않는다. 다른 AI 전용 역할이 붙은 작업은 그대로 둔다. 새로 만든 작업은 없다.
   */
  enforceVisualRule(job, usable, nameOf, r) {
    const agents = (this._cat || catalog(this.config.hubDir)).agents;
    const pinnedTool = (t) => { const a = t.agent && agents.find((x) => x.name === t.agent); return a && a.tool !== 'auto' ? a.tool : null; };
    let moved = 0;
    for (const t of job.tasks) {
      if (!isDesignText(this.config, `${t.title}\n${t.prompt}\n${job.tasks.length === 1 ? (job.input || job.goal || '') : ''}`)) continue;
      const pin = pinnedTool(t);
      if (pin && pin !== r.tool) continue;
      if (!usable.includes(r.tool)) { job.notes.push(`눈으로 보는 결과물은 ${nameOf(r.tool)}·${r.model} 담당이지만 지금 쓸 수 없어 ${nameOf(t.assignee)}가 맡아요.`); continue; }
      t.assignee = r.tool; t.visual = true; t.design = true;
      if (!t.prompt.includes('[눈으로 확인]')) t.prompt += '\n\n[눈으로 확인] 눈으로 보는 결과물입니다. 기획부터 구현까지 직접 하고, 끝내기 전에 결과를 실제로 렌더·스크린샷·재생해서 직접 눈으로 확인하세요. 이상하면 고친 뒤 끝내세요.';
      moved++;
    }
    if (moved) job.notes.push(`눈으로 보는 결과물 규칙: 작업 ${moved}개를 ${nameOf(r.tool)}·${r.model}가 기획부터 구현·확인까지 맡아요.`);
    return [];
  }

  enforceDesignRule(job, usable, nameOf = (t) => t, usage = null) {
    const r = designRule(this.config);
    if (!r || job.mode !== 'auto') return [];
    if (r.mode === 'whole') return this.enforceVisualRule(job, usable, nameOf, r);
    const target = designTarget(this.config, { usage, usable, settings: job.settings }) || { tool: r.tool, model: r.model, switched: false, note: null };
    const asPlan = (t, tg = target) => { t.designPlan = true; t.design = true; t.assignee = tg.tool; t.designTarget = { tool: tg.tool, model: tg.model, switched: !!tg.switched, note: tg.note || null }; };
    let targetUsed = false;
    const agents = (this._cat || catalog(this.config.hubDir)).agents;
    const pinnedTool = (t) => { const a = t.agent && agents.find((x) => x.name === t.agent); return a && a.tool !== 'auto' ? a.tool : null; };
    // 고쳐 가는 시안·디자인 결과물(draft): 디자인 담당(Fable, 한도 넘으면 Astra)이 한 작업으로 직접 만든다(사용자 요구 2026-10-05).
    // 만든 쪽이 눈으로 확인 담당(Astra)이면 스스로 눈으로 확인하고, 아니면 뒤에 확인 작업이 붙는다(addVisualChecks).
    let makers = 0;
    const asMaker = (t) => {
      const pin = pinnedTool(t); if (pin && pin !== target.tool) return false;
      if (!usable.includes(target.tool)) { job.notes.push(`디자인 담당 ${nameOf(target.tool)}·${target.model}를 지금 쓸 수 없어 ${nameOf(t.assignee)}가 맡아요.`); return false; }
      t.designMake = true; t.design = true; t.assignee = target.tool; t.visualOutput = true;
      t.designTarget = { tool: target.tool, model: target.model, switched: !!target.switched, note: target.note || null };
      const self = !!(r.check && r.check.tool === target.tool && r.check.model === target.model);
      if (self) t.selfChecked = true;
      if (!t.prompt.includes('[디자인 제작]')) t.prompt += `\n\n[디자인 제작] 디자인 판단이 핵심인 결과물입니다. 명세를 따로 쓰지 말고 직접 만들고, 직전 대화의 레퍼런스·결정을 이어서 활용하세요. 시간은 결과물(그림·화면)을 만들고 직접 보며 고치는 데 쓰세요: 검토용 HTML 페이지·빌드/검증 스크립트·README·기록 JSON·원격 게시 확인은 사용자가 이번 요청에서 직접 요구했을 때만 만드세요. 결과는 파일 절대 경로를 적으면 허브 화면(원격 포함)에서 바로 열립니다.${self ? '\n[눈으로 확인] 끝내기 전에 결과를 실제로 렌더·스크린샷·재생해서 직접 눈으로 확인하고, 이상하면 고친 뒤 끝내세요.' : ''}`;
      targetUsed = true; return true;
    };
    const isPlanTitle = (t) => /^ *디자인 *기획/.test(t?.title || '');
    const IMPL = /(구현|코드|적용|수정|고쳐|고치|만들|제작|렌더|빌드|생성|그려|그리|넣어|붙여|CSS|HTML|SVG|PNG|GIF|파일)/i;
    const implTool = ['codex', 'claude'].find((x) => x !== r.tool && usable.includes(x)) || null;
    const planTool = usable.includes(target.tool) ? target.tool : null;
    const added = []; let plans = 0, splits = 0;
    for (const t of [...job.tasks]) {
      if (t.designPlan || t.designImpl || t.designMake) continue;
      if (r.adaptive) {
        // 플래너 판정(designKind) 우선. 플래너 없이 만든 작업(빠른 경로 등)은 제목·원문으로 판정해 시안으로 본다
        const kind = t.designKind === 'build' ? 'build' : t.designKind === 'draft' || (typeof t.designKind !== 'string' && (isPlanTitle(t) || this.isDesignTask(job, t))) ? 'draft' : '';
        if (!kind) continue;
        if (kind === 'draft') { if (asMaker(t)) makers++; continue; }
        // build: 아래 예전 방식(기획 → 구현 → 눈으로 확인)
      } else if (!isPlanTitle(t) && !this.isDesignTask(job, t)) continue;
      t.design = true;
      const text = job.tasks.length === 1 ? `${t.title} ${job.input || job.goal || ''}` : `${t.title} ${t.prompt || ''}`;
      // 기획만 하는 작업: 나누지 않고 기획 담당에게
      if (isPlanTitle(t) || !IMPL.test(text)) {
        if (!planTool) { job.notes.push(`디자인 기획은 ${nameOf(r.tool)} 담당이지만 지금 쓸 수 없어 ${nameOf(t.assignee)}가 맡아요.`); continue; }
        const pin = pinnedTool(t);
        if (pin && pin !== planTool) {
          if (pin !== r.tool || !usable.includes(pin)) continue; // 다른 AI 전용 역할은 그대로
          // 기획 담당(Claude) 전용 역할: 역할 지정이 우선이라 한도 전환을 하지 않는다
          asPlan(t, { tool: r.tool, model: r.model, switched: false, note: `디자인 규칙: @${t.agent} 역할이 ${nameOf(pin)} 전용이라 ${target.model}에 넘기지 않음` });
          plans++; continue;
        }
        asPlan(t); targetUsed = true; plans++;
        continue;
      }
      // 플래너가 이미 기획 작업을 앞에 두었으면 구현만 맡긴다
      const planDep = t.dependsOn.map((id) => job.tasks.find((x) => x.id === id)).find((x) => x && (x.designPlan || isPlanTitle(x)));
      t.designImpl = true;
      if (implTool && !pinnedTool(t)) t.assignee = implTool;
      t.prompt = `${t.prompt}\n\n[디자인 명세 준수] 먼저 끝난 "디자인 기획" 작업의 명세를 따라 구현하고, 결과 화면·결과물을 직접 확인해 검증하세요. 명세와 다르게 해야 하면 이유를 보고에 적으세요.`;
      if (planDep) { if (planTool && !planDep.designTarget) { asPlan(planDep); targetUsed = true; } else { planDep.designPlan = true; planDep.design = true; } continue; }
      if (!planTool) { job.notes.push(`디자인 기획 담당 ${nameOf(r.tool)}를 지금 쓸 수 없어 ${nameOf(t.assignee)}가 기획부터 함께 해요.`); continue; }
      let id = `${t.id}d`; while (job.tasks.some((x) => x.id === id)) id += 'd';
      const plan = freshTask({ id, title: `디자인 기획: ${t.title}`.slice(0, 120), assignee: planTool, dependsOn: [...t.dependsOn], prompt: designPlanPrompt(t) });
      asPlan(plan); targetUsed = true;
      t.dependsOn = [...t.dependsOn, id];
      job.tasks.push(plan); added.push(plan); splits++;
    }
    const planName = target.switched ? `${nameOf(target.tool)}·${target.model}` : nameOf(target.tool);
    if (makers) job.notes.push(`디자인 규칙: 시안·디자인 결과물 작업 ${makers}개는 ${nameOf(target.tool)}·${target.model}가 한 작업으로 직접 만들어요(직전 대화를 이어서).`);
    if (splits) job.notes.push(`디자인 규칙: 디자인이 섞인 작업 ${splits}개를 "기획(${planName}) → 구현·검증(${nameOf(implTool || r.tool)})"으로 나눴어요.`);
    if (plans) job.notes.push(`디자인 규칙: 디자인 기획 작업 ${plans}개는 ${planName}가 맡아요.`);
    if (targetUsed && target.note) job.notes.push(`${target.note}${target.switched ? ' (구현·검증은 기본 모델 그대로)' : ''}`);
    return [...added, ...this.addVisualChecks(job, usable, nameOf, r)];
  }

  /**
   * 눈으로 확인(사용자 규칙 2026-10-04 "디자인은 페이블 / 눈으로 확인은 아스트라"): 눈으로 보는 결과물을 만드는 작업 뒤에
   * 확인 담당(designRule.check, 기본 Codex·gpt-6-astra)이 렌더·스크린샷으로 확인하고 어긋난 곳을 고치는 작업을 붙인다.
   * 디자인 기획 작업이 있으면 그 명세도 받는다. 기획만 하는 작업에는 붙이지 않는다. 그 결과를 쓰던 뒤 작업은 확인 뒤로 미룬다.
   */
  addVisualChecks(job, usable, nameOf, r) {
    const c = r?.check; if (!c) return [];
    const added = [];
    for (const t of [...job.tasks]) {
      if (t.designPlan || t.visualCheck || t.checkedBy || t.selfChecked) continue;
      // 플래너의 결과물 판정을 먼저 따른다. 예전 계획은 제목·사용자 원문으로 판정한다.
      // 길게 재작성된 과제의 과거 영상·스크린샷 언급은 새 시각 결과물의 근거가 아니다.
      if (t.visualOutput === false) continue;
      if (t.visualOutput !== true && !t.designImpl && !isVisualText(this.config, `${t.title}\n${job.tasks.length === 1 ? (job.input || job.goal || '') : ''}`)) continue;
      if (!usable.includes(c.tool)) { job.notes.push(`눈으로 확인은 ${nameOf(c.tool)}·${c.model} 담당이지만 지금 쓸 수 없어 구현 작업이 직접 확인해요.`); break; }
      let id = `${t.id}v`; while (job.tasks.some((x) => x.id === id)) id += 'v';
      const plans = t.dependsOn.filter((d) => job.tasks.find((x) => x.id === d)?.designPlan);
      const chk = freshTask({ id, title: `눈으로 확인: ${t.title}`.slice(0, 120), assignee: c.tool, dependsOn: [t.id, ...plans], prompt: visualCheckPrompt(t, plans.length > 0) });
      Object.assign(chk, { visualCheck: true, design: true });
      t.checkedBy = id;
      for (const x of job.tasks) if (x !== t && x.dependsOn.includes(t.id) && !x.visualCheck) x.dependsOn.push(id);
      job.tasks.push(chk); added.push(chk);
    }
    if (added.length) job.notes.push(`눈으로 확인 규칙: 눈으로 보는 결과물 ${added.length}개는 구현 뒤 ${nameOf(c.tool)}·${c.model}가 렌더·스크린샷으로 확인하고 어긋난 곳을 고쳐요.`);
    return added;
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
    if (session) this.sessionTools.assertWritable(session);
    if (session?.goal?.status === 'active') throw httpError(409, '이 세션에 진행 중인 목표가 있어요. 중지한 뒤 새 목표를 주세요');
    if (session && session.jobIds.some((id) => LIVE.has(this.jobs.get(id)?.status))) throw httpError(409, '이 세션에서 아직 실행 중인 작업이 있습니다. 끝나거나 중지한 뒤 보내세요');
    if (!session) {
      const dir = path.resolve(String(cwd || this.config.defaultCwd));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `폴더가 없습니다: ${dir}`);
      session = this.newSessionObject(dir, null);
      this.sessionTools.initialize(session);
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
    const resumed = !!g.resumed; delete g.resumed;
    const job = this._create({
      goal: roundPrompt({ ...g, intercepts: [], resumed }), input: firstInput || `${g.round}라운드: ${g.next || g.remaining || g.text}`, title: `목표 ${g.round}라운드 · ${g.text}`.slice(0, 80),
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
    // 라운드 계획에 할 일이 없었다(예: "재개 지시 전까지 일시중지 유지") → 판정·다음 라운드 없이 멈춘다. 같은 빈 라운드를 되풀이하지 않게(2026-10-08)
    if (job.status === 'failed' && job.errorCode === 'EMPTY_PLAN') {
      Object.assign(g, { status: 'paused', reason: `이번 라운드에 할 일이 없다고 봐서 멈췄어요. 계속하려면 "이어서"를 누르세요 · ${truncate(job.error.replace(/^플래너\([a-z]+\)가 할 일이 없다고 판단했어요: /, ''), 200)}`, updatedAt: nowIso() });
      return this.emitSession(s);
    }
    // 두 라운드 연속 실패면 더 돌리지 않는다(한도만 쓴다)
    const prev = s.jobIds.map((id) => this.jobs.get(id)).filter((j) => j && j.goalId === g.id && j.id !== job.id).at(-1);
    if (job.status === 'failed' && prev?.status === 'failed') {
      Object.assign(g, { status: 'paused', reason: `두 라운드 연속 실패해서 멈췄어요. 원인을 확인한 뒤 "이어서"를 누르세요 · ${truncate(job.error || '', 200)}`, updatedAt: nowIso() });
      return this.emitSession(s);
    }
    // 일시정지를 눌러 둔 채 라운드가 중지·빈 계획·연속 실패로 끝났으면 위에서 멈췄다. 여기부터는 판정까지 한 뒤 멈춘다(이어서 할 때 다음 지시가 준비되게)
    g.checking = true; job.activePhase = 'goal-check'; this.emitJob(job); this.emitSession(s);
    const D = this.goalDeps || {}; // 시험에서 바꿔 끼우는 자리(CLI 상태·한도·달성 판정)
    const status = await (D.toolStatus || toolStatus)(this.config); const healthy = healthyTools(status);
    const usage = await (D.usageStatus || usageStatus)(this.config).catch(() => null);
    if (g.status !== 'active' || s.goal !== g || job.status === 'cancelled') { g.checking = false; this.emitJob(job); return; }
    const usable = healthy.filter((t) => { const h = headroom(usage, t); return h == null || h > 100 - CRIT_AT; });
    let v;
    try {
      const rounds = s.jobIds.map((id) => this.jobs.get(id)).filter((j) => j && j.goalId === g.id);
      v = await (D.checkGoal || checkGoal)({ config: this.config, goal: g, jobs: rounds, healthy: usable.length ? usable : healthy, plannerPref: job.plannerPref, settings: job.settings, cwd: s.cwd, runDir: job.runDir, onEvent: (ev) => this.log(job, null, ev), onWorker: this.phaseWorker(job), memoryCtx: this.memoryFor(job, 'goal-check') });
    } catch (e) { if (g.status === 'active') Object.assign(g, { status: 'paused', checking: false, reason: `달성 판정 실패: ${e.message}`.slice(0, 300), updatedAt: nowIso() }); this.emitJob(job); return this.emitSession(s); }
    if (g.status !== 'active' || s.goal !== g || job.status === 'cancelled') { g.checking = false; this.emitJob(job); return; }
    Object.assign(g, { checking: false, progress: v.progress, remaining: v.remaining, next: v.next, reason: v.reason, updatedAt: nowIso() });
    if (v.done) { g.status = 'done'; g.progress = 100; }
    else if (v.blocked) g.status = 'paused';
    else if (g.round >= g.maxRounds) { g.status = 'stopped'; g.reason = `최대 ${g.maxRounds}라운드에 도달했어요. 계속하려면 "이어서"를 누르세요 · ${v.reason}`; }
    else if (!usable.length) { g.status = 'paused'; g.reason = '두 AI 모두 한도가 거의 차서 멈췄어요. 한도가 초기화된 뒤 "이어서"를 누르세요'; }
    else if (g.pauseRequested) { g.status = 'paused'; g.reason = `일시정지했어요. "이어서"를 누르면 ${g.round + 1}라운드부터 계속해요`; }
    if (g.status !== 'active') delete g.pauseRequested;
    job.activePhase = g.status === 'active' ? 'goal-transition' : null; this.emitJob(job); this.emitSession(s);
    if (g.status === 'active') { try { this.nextGoalRound(s); } catch (e) { Object.assign(g, { status: 'paused', reason: e.message }); this.emitSession(s); } }
    this.refreshInterceptState(job); this.emitJob(job);
  }

  /**
   * 목표 일시정지(2026-10-10 "목표 정지 말고 일시정지도"): 지금 라운드는 끝까지 하고 달성 판정까지 한 뒤, 다음 라운드를 시작하지 않고 멈춘다.
   * 진행 중인 라운드가 없으면 바로 멈춤. 다시 누르면(또는 "이어서") 일시정지 예약을 거둔다. 정지와 달리 하던 작업을 끊지 않는다.
   */
  pauseGoal(id) {
    const s = this.sessions.get(id); const g = s?.goal; if (!g) throw httpError(404, '목표가 없습니다');
    if (g.status !== 'active') return this.publicSession(s);
    const running = s.jobIds.some((jid) => { const j = this.jobs.get(jid); return j && j.goalId === g.id && (LIVE.has(j.status) || ['goal-check', 'goal-transition'].includes(j.activePhase)); });
    if (running || g.checking) Object.assign(g, { pauseRequested: true, updatedAt: nowIso() });
    else Object.assign(g, { status: 'paused', reason: `일시정지했어요. "이어서"를 누르면 ${g.round + 1}라운드부터 계속해요`, updatedAt: nowIso() });
    this.emitSession(s);
    return this.publicSession(s);
  }

  stopGoal(id) {
    const s = this.sessions.get(id); if (!s?.goal) throw httpError(404, '목표가 없습니다');
    delete s.goal.pauseRequested;
    Object.assign(s.goal, { status: 'stopped', checking: false, reason: '사용자가 중지했어요', updatedAt: nowIso() });
    for (const jid of s.jobIds) { const j = this.jobs.get(jid); if (j && (LIVE.has(j.status) || ['goal-check', 'goal-transition'].includes(j.activePhase))) this.cancel(jid); }
    this.emitSession(s);
    return this.publicSession(s);
  }

  async resumeGoal(id) {
    const s = this.sessions.get(id); if (!s?.goal) throw httpError(404, '목표가 없습니다');
    this.sessionTools.assertWritable(s);
    if (s.goal.status === 'active') { if (s.goal.pauseRequested) { delete s.goal.pauseRequested; s.goal.updatedAt = nowIso(); this.emitSession(s); } return this.publicSession(s); } // 일시정지 예약 거두기
    if (s.goal.status === 'done') throw httpError(409, '이미 달성한 목표예요');
    if (s.jobIds.some((jid) => LIVE.has(this.jobs.get(jid)?.status))) throw httpError(409, '실행 중인 작업이 끝난 뒤 이어서 할 수 있어요');
    if (s.goal.round >= s.goal.maxRounds) s.goal.maxRounds = s.goal.round + 3;
    delete s.goal.pauseRequested; // 일시정지를 눌러 둔 채 다른 이유(중지·빈 계획)로 멈췄던 것도 지운다
    Object.assign(s.goal, { status: 'active', reason: '', resumed: true, updatedAt: nowIso() });
    this.emitSession(s);
    this.nextGoalRound(s);
    return this.publicSession(s);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, '작업 없음');
    if (!LIVE.has(job.status) && !['goal-check', 'goal-transition'].includes(job.activePhase)) return publicJob(job);
    job.status = 'cancelled';
    this.execution.cancel(id); this.workspaces.cancel(id);
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
    if (job.reserved) { delete job.reserved; this.startReserved(job.sessionId); } // 시작 전 예약을 취소: 그 뒤 예약은 건너뛰고 이어진다
    return publicJob(job);
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.sessionTools.assertUnreferenced(job.sessionId, id);
    if (this.canIntercept(job)) this.cancel(id);
    this.checkpoints.forget(job);
    this.jobs.delete(id);
    const s = this.sessions.get(job.sessionId);
    if (s) s.jobIds = s.jobIds.filter((x) => x !== id);
    this.save();
    this.emit('event', { type: 'job_removed', jobId: id, sessionId: job.sessionId });
    return true;
  }

  /**
   * "지금 바꾸기"(새 버전으로 바로 재시작): 진행 중인 작업에 이어 하기 표시를 남겨 저장하고 작업자 CLI만 끈다.
   * 이후 상태 변화는 저장하지 않는다(멈춘 그대로를 다음 시작이 받아 resumeAfterRestart 로 이어 한다). 허브 종료는 재시작 도구가 한다.
   */
  prepareRestart() {
    const live = [...this.jobs.values()].filter((j) => !j.reserved && (LIVE.has(j.status) || this.canIntercept(j)));
    for (const j of live) { j.resumeOnStart = true; const g = this.sessions.get(j.sessionId)?.goal; if (g && g.status === 'active') g.resumeOnStart = true; }
    clearTimeout(this._saveTimer);
    writeJsonAtomic(JOBS_FILE, [...this.jobs.values()]);
    writeJsonAtomic(SESSIONS_FILE, [...this.sessions.values()]);
    this.frozen = true;
    this.execution.cancel(); this.workspaces.cancel();
    for (const [, e] of this.running) { try { e.handle.cancel(); } catch {} }
    return live.map((j) => ({ id: j.id, title: j.title, status: j.status }));
  }

  /** 새 버전으로 시작한 뒤: "지금 바꾸기"로 멈췄던 작업을 이어 한다. 작업자가 돌던 작업은 같은 CLI 대화를, 계획 전이면 처음부터 */
  resumeAfterRestart() {
    const list = [...this.jobs.values()].filter((j) => j.resumeOnStart);
    for (const job of list) {
      delete job.resumeOnStart;
      const s = this.sessions.get(job.sessionId);
      if (s?.goal?.resumeOnStart) { delete s.goal.resumeOnStart; if (s.goal.status === 'paused') { s.goal.status = 'active'; s.goal.reason = null; } }
      try {
        if (!job.tasks.length) this.restartJob(job); else this.resumeTasks(job);
        this.log(job, null, { kind: 'info', text: '새 버전으로 재시작한 뒤 이어서 진행해요' });
      } catch (e) { job.notes.push(`새 버전에서 이어 하지 못했어요: ${e.message}`); this.emitJob(job); }
    }
    // 예약해 둔 요청: 앞 작업이 재시작으로 중단됐거나 이미 끝났으면 지금 시작(이어 하는 작업이 있으면 그 뒤에)
    for (const s of this.sessions.values()) if (s.jobIds.some((id) => this.jobs.get(id)?.reserved)) this.startReserved(s.id);
    if (list.length) this.save();
    return list.map((j) => j.id);
  }

  /** 계획 전에 멈춘 작업: 처음부터 다시(같은 작업 id·세션 그대로) */
  restartJob(job) {
    Object.assign(job, { status: 'queued', startedAt: null, finishedAt: null, error: null, phase: null, activePhase: 'queued', canIntercept: true, summary: null, tasks: [], report: null });
    this.emitJob(job);
    this.run(job, resolveAttachments(job.attachments || [])).catch((e) => {
      if (job.status === 'cancelled') return this.finish(job);
      job.status = 'failed'; job.error = String(e?.message || e); job.finishedAt = nowIso();
      this.log(job, null, { kind: 'error', text: job.error });
      this.finish(job);
    });
  }

  /** 작업자 단계에서 멈춘 작업: 멈춘 작업만 같은 CLI 대화로 이어 하고(대화가 없으면 새로), 보고까지 마친다 */
  resumeTasks(job) {
    const stopped = job.tasks.filter((t) => t.status === 'interrupted' || t.status === 'running' || t.status === 'pending');
    for (const t of stopped) {
      Object.assign(t, { status: 'pending', error: null, startedAt: null, finishedAt: null });
      if (t.sessionId) { t.resumeSessionId = t.sessionId; t.resumedAfterRestart = true; }
    }
    job.status = 'running'; job.activePhase = 'worker'; job.finishedAt = null; job.error = null; this.emitJob(job);
    this._atts = this._atts || new Map();
    this._atts.set(job.id, resolveAttachments(job.attachments || []));
    (async () => {
      await this.checkpoints.end(job).catch(() => {});
      await this.runScheduled(job, this.workerHistory(job));
      if (job.status === 'cancelled') return this.finish(job);
      if (job.mode === 'auto' && job.tasks.length > 1) {
        job.status = 'reporting'; job.activePhase = 'report'; this.emitJob(job);
        try { job.report = await makeReport({ job, config: this.config, healthy: healthyTools(await toolStatus(this.config)), memoryCtx: this.memoryFor(job, 'report'), runDir: job.runDir, onEvent: (ev) => this.log(job, null, ev), onWorker: this.phaseWorker(job), resumeSessionId: job.phaseRuns.report?.cliSessionId }); }
        catch (e) { job.report = null; job.error = `보고 생성 실패: ${e.message}`; }
      }
      const failed = job.tasks.filter((t) => t.status === 'failed');
      job.status = failed.length === job.tasks.length ? 'failed' : failed.length ? 'partial' : 'done';
      if (!job.report) job.report = job.tasks.length === 1 ? (job.tasks[0].resultText || job.tasks[0].error || '') : job.tasks.map((t) => `## ${t.title} (${t.assignee}, ${t.status})\n${t.resultText || t.error || ''}`).join('\n\n');
      this.finish(job);
    })().catch((e) => { job.status = 'failed'; job.error = String(e.message || e); this.finish(job); });
  }

  retryTask(jobId, taskId) {
    const job = this.jobs.get(jobId); if (!job) throw httpError(404, '작업 없음');
    if (job.imported) throw httpError(409, `${job.imported.machine || '다른'} PC에서 옮겨 온 기록이라 다시 실행할 수 없어요. 새 요청으로 보내 주세요`);
    this.sessionTools.assertWritable(this.sessionTools.get(job.sessionId));
    const task = job.tasks.find((t) => t.id === taskId); if (!task) throw httpError(404, '하위 작업 없음');
    if (task.status === 'running') throw httpError(409, '실행 중');
    if (this.canIntercept(job)) throw httpError(409, '실행 중인 작업이 끝난 뒤 재시도하세요');
    Object.assign(task, { status: 'pending', error: null, resultText: null, startedAt: null, finishedAt: null, toolCalls: 0 });
    const revived = reviveDependents(job.tasks, taskId); // 이 작업 실패로 건너뛴 후속 작업도 함께 다시
    if (revived.length) this.log(job, null, { kind: 'stderr', text: `건너뛰었던 후속 작업 ${revived.join(', ')}도 함께 다시 실행합니다` });
    job.status = 'running'; job.finishedAt = null; job.error = null; this.emitJob(job);
    (async () => {
      await this.checkpoints.end(job).catch(() => {}); // 이전 실행의 끝 스냅샷이 아직 진행 중이면 끝난 뒤 시작
      await this.runScheduled(job, this.workerHistory(job));
      if (job.status === 'cancelled') return this.finish(job);
      const failed = job.tasks.filter((t) => t.status === 'failed');
      job.status = failed.length === job.tasks.length ? 'failed' : failed.length ? 'partial' : 'done';
      job.report = job.tasks.length === 1 ? (job.tasks[0].resultText || job.tasks[0].error || '') : job.tasks.map((t) => `## ${t.title} (${t.assignee}, ${t.status})\n${t.resultText || t.error || ''}`).join('\n\n');
      this.finish(job);
    })().catch((e) => { job.status = 'failed'; job.error = String(e.message || e); this.finish(job); });
    return publicJob(job);
  }

  taskLog(jobId, key, page = null) {
    const job = this.jobs.get(jobId); if (!job || !/^[\w-]+$/.test(key)) return [];
    if (page) return readLogPage(path.join(job.runDir, `${key}.log.jsonl`), page);
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

/** 디자인 기획 작업 지시문: 명세만 쓰고 구현·생성·시험은 하지 않는다 (구현은 다음 작업자) */
function visualCheckPrompt(t, hasSpec) {
  return `[눈으로 확인 단계] 앞 작업 「${t.title}」이 만든 결과물을 직접 눈으로 확인하세요.
- 실제로 렌더·실행·스크린샷·재생해서 확인합니다. 코드만 읽고 판단하지 마세요.
- 기준: ${hasSpec ? '선행 "디자인 기획" 작업의 명세와 ' : ''}사용자 요청. 깨진 배치·잘림·겹침·색·글자·여백·상태별 모습·움직임을 봅니다.
- 어긋난 곳은 직접 고치고 다시 확인하세요. 새 기능을 더하거나 디자인 방향을 바꾸지는 마세요.
- 마지막에 확인한 화면(스크린샷 경로)·고친 점·남은 문제를 보고하세요.

원래 작업: ${t.title}
${t.prompt || ''}`;
}

function designPlanPrompt(t) {
  return `[디자인 기획 단계] 아래 작업에 필요한 디자인을 **기획만** 하세요. 코드·파일 수정, 이미지·영상 생성, 브라우저 시험은 하지 마세요. 구현과 검증은 다음 작업자가 이 명세를 보고 합니다.
필요하면 관련 파일을 읽기만 해서 기존 스타일(색·글꼴·간격·컴포넌트)을 파악하세요.
답변에 마크다운으로 디자인 명세를 쓰세요: 목표와 방향, 구성과 배치, 상태별 모습(빈 상태·로딩·오류 등), 문구, 색·간격·글꼴(기존 디자인 우선), 상호작용·움직임, 접근성, 구현자가 확인할 체크리스트.

원래 작업: ${t.title}
${t.prompt || ''}`;
}

function freshTask(t) {
  return { id: t.id, title: t.title, assignee: t.assignee, agent: t.agent || null, prompt: t.prompt, visualOutput: typeof t.visualOutput === 'boolean' ? t.visualOutput : null, ...(typeof t.designKind === 'string' ? { designKind: t.designKind } : {}), dependsOn: t.dependsOn || [], status: 'pending', startedAt: null, finishedAt: null, resultText: null, error: null, sessionId: null, usage: null, costUsd: null, toolCalls: 0, model: null, effort: null, settings: null, reason: null, autoPicked: false };
}

export function publicJob(job) {
  return { ...job, tasks: job.tasks.map((t) => ({ ...t, prompt: t.prompt?.length > 4000 ? t.prompt.slice(0, 4000) + '…' : t.prompt })) };
}

export function jobSummary(job) {
  const { id, sessionId, title, status, createdAt, startedAt, finishedAt, cwd, mode, waiting, canIntercept, machine, goalId, goalRound, reserved } = job;
  return { id, sessionId, title, goal: job.goal || job.input || '', status, createdAt, startedAt, finishedAt, cwd, mode, waiting, canIntercept, machine, goalId, goalRound, reserved: !!reserved, summaryOnly: true,
    tasks: (job.tasks || []).map(({ id, title, assignee, status, model, effort, waiting }) => ({ id, title, assignee, status, model, effort, waiting })) };
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/** 작업자 브라우저(2026-10-06 "오딘이 다른 두 AI에 비해 브라우저 컨트롤이 좀 약한 거 같아"): Claude 작업자에 Claude in Chrome(--chrome). 끄기 config.browser.claudeChrome:false */
export function browserOn(config) { const b = config?.browser || {}; return b.claudeChrome === true || (b.claudeChrome !== false && b.oddin === false); }
/** ODDIN 브라우저(lib/browser.mjs)를 작업자에게 붙일까 — 기본 켜짐, 끄기 config.browser.oddin:false */
export function oddinBrowserOn(config) { return config?.browser?.oddin !== false; }
