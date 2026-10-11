// 작업 도중 다른 AI에게 묻기(2026-10-12 "가, 나 해줘" — Paseo 의 advisor·committee 를 참고한 방식만, 코드는 새로 씀).
// 작업자(Claude·Codex)가 도구 ask_other_ai(scripts/oddin-ask-mcp.mjs)로 부르면 허브가 "다른 쪽 AI"를 읽기 전용으로 한 번 돌려 답을 돌려준다.
//  - 필요할 때만(ask): 막히거나 위험한 결정 앞에서 두 번째 의견
//  - 꼭 받기(committee): 고치기 전 독립 분석 + 끝내기 전 바뀐 내용 검토
// 부른 쪽이 실행 자리를 쥔 채 기다리므로 의견 요청은 전체 CLI 한도(maxParallel) 밖의 따로 둔 자리에서 돈다(안 그러면 서로 기다리다 멈춘다).
// 규약 docs/consult.md, 시험 tests/consult.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { runWorker, canRestartResume } from './workers.mjs';
import { ExecutionQueue } from './execution-queue.mjs';
import { internalSettings } from './router.mjs';
import { toolStatus, healthyTools } from './tools.mjs';
import { usageStatus, headroom } from './usage.mjs';
import { instructionText } from './intercepts.mjs';
import { nowIso, shortId, truncate, readText } from './util.mjs';

export const CONSULT_MODES = ['off', 'ask', 'committee'];
export const NAMES = { claude: 'Claude', codex: 'Codex' };
export const otherTool = (tool) => (tool === 'claude' ? 'codex' : 'claude');
const DEFAULTS = { default: 'off', maxPerTask: 3, committeeMax: 4, timeoutMinutes: 8, blockAt: 90, parallel: 2, waitSeconds: 540 };
export const consultConfig = (config) => ({ ...DEFAULTS, ...(config?.consult || {}) });
/** 이 요청의 방식: 요청 설정(settings.consult) > 설정 파일 기본값. 모르는 값·꺼 둔 기능이면 off */
export function consultMode(config, settings) {
  const c = consultConfig(config);
  if (c.enabled === false) return 'off';
  const v = settings?.consult ?? c.default;
  return CONSULT_MODES.includes(v) ? v : 'off';
}
const httpError = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const took = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.max(1, Math.round(ms / 1000))}초`);

/** 의견을 주는 쪽에 넘기는 지시문. 이어 묻는 대화(resumed)에는 원문·맡은 일을 다시 넣지 않는다 */
export function buildConsultPrompt({ job, task, question, context = '', review = false, changes = null, changesFile = '', mode = 'ask', resumed = false }) {
  const caller = NAMES[task.assignee] || task.assignee;
  const kind = review ? '바뀐 내용 검토를' : mode === 'committee' ? '독립 분석을' : '두 번째 의견을';
  const out = [`[AI Hub 의견 요청] 같은 프로젝트 폴더에서 일하는 ${caller}가 ${kind} 구합니다. 작업 ${job.id}/${task.id} · 프로젝트 폴더: ${job.cwd}`];
  if (resumed) out.push('\n[이어서] 위 대화에서 의견을 준 같은 작업입니다. 그때 읽은 파일과 판단을 그대로 활용하세요.');
  out.push(`
# 당신의 역할
- 읽기 전용입니다. 파일을 만들거나 고치지 말고, 상태를 바꾸는 명령도 실행하지 마세요. 구현은 요청한 쪽이 합니다.
- 프로젝트 폴더의 파일을 직접 읽어 근거를 확인하세요. 요청한 쪽의 설명만 믿고 답하지 마세요.
- 요청한 쪽의 결론에 맞추지 말고 스스로 판단하세요. 같은 결론이면 왜 그런지, 다르면 무엇이 왜 다른지 적으세요.
- 확인하지 못한 것은 추측하지 말고 "확인 못 함"이라고 적으세요. 요청 범위를 넓히는 제안(새 기능·전체 재설계)은 하지 마세요.`);
  if (!resumed) {
    out.push(`\n# 사용자 요청 원문 (판단의 기준)\n${truncate(String(job.goal || ''), 3000)}\n${instructionText(job)}`);
    out.push(`# 요청한 쪽이 맡은 일: ${task.title || ''}\n${truncate(String(task.prompt || ''), 1500)}`);
  }
  out.push(`\n# 질문\n${question}`);
  if (context) out.push(`\n# 요청한 쪽이 붙인 참고 (그대로 믿지 말고 확인할 것)\n${truncate(String(context), 12_000)}`);
  if (review) {
    if (changes?.files?.length) {
      const list = changes.files.slice(0, 80).map((f) => `- ${f.path}${f.oldPath ? ` (이전 ${f.oldPath})` : ''} · ${f.status}${f.binary ? ' · 이진 파일' : ` +${f.additions ?? 0} −${f.deletions ?? 0}`}`).join('\n');
      out.push(`\n# 이 작업을 시작한 뒤 지금까지 바뀐 파일 (허브가 뽑음, ${changes.files.length}개)\n${list}${changes.files.length > 80 ? '\n…(나머지 생략)' : ''}`);
      if (changes.unified) out.push(`${changesFile ? `전체 비교: ${changesFile}\n` : ''}\`\`\`diff\n${truncate(changes.unified, 40_000)}\n\`\`\``);
      else if (changes.truncated) out.push('(바뀐 양이 많아 비교 내용은 싣지 못했어요. 위 파일을 직접 읽어 확인하세요.)');
    } else if (changes?.files) out.push('\n# 바뀐 파일\n허브가 보기에는 이 작업을 시작한 뒤 바뀐 파일이 없습니다. 질문과 참고에 적힌 파일을 직접 확인하세요.');
    else out.push('\n# 바뀐 파일\n허브가 바뀐 내용을 뽑지 못했습니다. 질문과 참고에 적힌 파일을 직접 읽어 검토하세요.');
  }
  out.push(`
# 답 형식 (한국어, 군더더기 없이)
① 결론 한두 문장 ② 근거(파일 경로:줄) ③ ${review ? '버그·빠뜨린 것·요청 범위를 벗어난 것' : '문제·위험'} — 심각한 순, 없으면 "없음" ④ 다르게 하길 권하는 것 ⑤ 확신(높음·중간·낮음)과 확인 못 한 것`);
  return out.join('\n');
}

export class Consults {
  /** @param manager JobManager. deps 는 시험에서 바꿔 끼운다({ runWorker, toolStatus, usageStatus, changes }) */
  constructor(manager, deps = {}) {
    this.m = manager; this.deps = deps; this.runs = new Map(); // `${작업}/${하위작업}/${번호}` → 진행·끝난 의견 요청
    this.queue = new ExecutionQueue(Math.max(1, Number(consultConfig(manager.config).parallel) || 2));
  }
  cfg() { return consultConfig(this.m.config); }
  /** 질문에 바로 답하는 요청·옮겨 온 기록에는 붙이지 않는다 */
  mode(job) { return !job || job.answer || job.imported ? 'off' : consultMode(this.m.config, job.settings); }
  limit(job) { const c = this.cfg(); return Math.max(1, Number(this.mode(job) === 'committee' ? Math.max(2, c.committeeMax) : c.maxPerTask) || 1); }
  /** 작업자 지시문에 넣을 안내(planner.consultRule) */
  info(job, task) { const mode = this.mode(job); return mode === 'off' ? null : { mode, other: NAMES[otherTool(task.assignee)], max: this.limit(job) }; }
  /** 작업자에 붙일 도구 서버(MCP). script = scripts/oddin-ask-mcp.mjs, hub = 이 허브 주소 */
  toolSpec(job, task, { script, hub }) {
    if (this.mode(job) === 'off') return null;
    const c = this.cfg(), wait = Math.max(30, Number(c.waitSeconds) || 540);
    const env = { ODDIN_TASK: `${job.id}/${task.id}`, ODDIN_HUB: hub, ODDIN_ASK_WAIT_MS: String(wait * 1000), ODDIN_ASK_OTHER: NAMES[otherTool(task.assignee)] };
    if (Number(c.holdMs) > 0) env.ODDIN_ASK_HOLD_MS = String(Number(c.holdMs)); // 시험용: 도구 호출을 최소 이만큼 붙잡는다(CLI 의 도구 대기 시간 확인)
    return { name: 'oddin-ask', command: process.execPath, args: [script], env, timeoutMs: (wait + 60) * 1000 };
  }
  find(owner) {
    const [jobId, taskId] = String(owner || '').split('/');
    const job = this.m.jobs.get(jobId), task = job?.tasks?.find((t) => t.id === taskId);
    if (!job || !task) throw httpError(404, '의견을 물을 작업을 찾지 못했어요');
    return { job, task };
  }
  key(job, task, id) { return `${job.id}/${task.id}/${id}`; }

  /**
   * 의견 요청을 시작한다(답은 wait 로 받는다). 받을 수 없는 사정(꺼짐·횟수·한도·상대 AI 없음)은 오류가 아니라
   * { ok:false, refused:true, message } — 도구가 그 글을 그대로 작업자에게 돌려줘 혼자 판단해 진행하게 한다.
   */
  async start({ owner, question, context = '', review = false } = {}) {
    const { job, task } = this.find(owner);
    const refuse = (message, extra = {}) => ({ ok: false, refused: true, message, ...extra });
    const mode = this.mode(job);
    if (mode === 'off') return refuse('이 요청은 다른 AI 의견 받기가 꺼져 있어요. 혼자 판단해 진행하세요.');
    if (this.m.frozen) return refuse('ODDIN이 새 버전으로 바뀌는 중이라 지금은 물을 수 없어요. 혼자 판단해 진행하세요.');
    if (task.status !== 'running' || job.status === 'cancelled') throw httpError(409, '진행 중인 작업만 의견을 물을 수 있어요');
    question = String(question || '').trim();
    if (!question) throw httpError(400, '무엇을 판단해 달라는지 질문을 적어 주세요');
    if (question.length > 8000) question = question.slice(0, 8000);
    const tool = otherTool(task.assignee), name = NAMES[tool];
    task.consults ||= [];
    // 같은 질문이 돌고 있으면 그 요청에 붙는다 — 도구 호출이 시간 초과로 다시 불려도 두 번 돌지 않게
    const live = task.consults.find((c) => c.status === 'running');
    if (live) {
      const same = this.runs.get(this.key(job, task, live.id))?.question === question;
      return same ? { ok: true, id: live.id, status: 'running', tool: live.tool, joined: true }
        : refuse(`앞서 물은 것(요청 번호 ${live.id})의 답을 아직 기다리는 중이에요. ask_result 로 그 답을 먼저 받으세요.`, { id: live.id });
    }
    const max = this.limit(job), used = task.consults.length;
    if (used >= max) return refuse(`이 작업에서 물을 수 있는 횟수(${max}번)를 다 썼어요. 지금까지 받은 의견으로 판단해 진행하세요.`);
    const alone = '혼자 판단해 진행하고, 의견을 받지 못했다는 것을 결과에 한 줄 적으세요.';
    let status = null; try { status = await (this.deps.toolStatus || toolStatus)(this.m.config); } catch {}
    if (status && !healthyTools(status).includes(tool)) return refuse(`${name}를 지금 쓸 수 없어요(설치·로그인 상태 확인 필요). ${alone}`);
    let usage = null; try { usage = await (this.deps.usageStatus || usageStatus)(this.m.config); } catch {}
    const left = headroom(usage, tool), c = this.cfg();
    if (left != null && 100 - left >= Number(c.blockAt)) return refuse(`${name} 한도를 ${Math.round(100 - left)}% 써서 의견 요청을 받지 않아요. ${alone}`);
    // 위에서 기다리는 동안 다른 요청이 먼저 들어왔을 수 있다
    if (task.consults.some((x) => x.status === 'running') || task.consults.length >= max) return refuse('방금 다른 의견 요청이 먼저 들어갔어요. ask_result 로 그 답을 받으세요.');

    const n = task.consults.length + 1, id = `c${n}-${shortId(4)}`;
    const entry = { id, n, tool, at: nowIso(), status: 'running', review: !!review, question: truncate(question, 240) };
    task.consults.push(entry);
    const run = { entry, job, task, question, cancelled: false, handle: null, result: null, startedAt: Date.now() };
    this.runs.set(this.key(job, task, id), run);
    this.m.log(job, task, { kind: 'consult', consult: id, tool, state: 'asked', review: !!review, text: `${name}에게 ${review ? '바뀐 내용 검토를 맡겼어요' : '의견을 물었어요'}: ${truncate(question, 300)}` });
    this.m.emitJob(job);
    run.promise = this.execute(run, { question, context, review: !!review, mode })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }))
      .then((res) => this.settle(run, res));
    return { ok: true, id, status: 'running', tool };
  }

  async execute(run, { question, context, review, mode }) {
    const { job, task, entry } = run, m = this.m, c = this.cfg(), tool = entry.tool;
    const stopped = () => run.cancelled || m.frozen || job.status === 'cancelled';
    const release = await this.queue.acquire({ owner: job.id });
    if (!release) return { ok: false, cancelled: true, error: '작업이 중지되었습니다' };
    try {
      if (stopped()) return { ok: false, cancelled: true, error: '작업이 중지되었습니다' };
      const dir = path.join(job.runDir, task.id, `consult-${entry.n}`);
      fs.mkdirSync(dir, { recursive: true }); run.dir = dir;
      let changes = null, changesFile = '';
      if (review) {
        try { changes = await (this.deps.changes ? this.deps.changes(job) : m.checkpoints?.live?.(job)); } catch (e) { m.log(job, task, { kind: 'stderr', text: `바뀐 내용을 뽑지 못해 파일 목록 없이 검토를 맡겨요: ${truncate(e.message, 160)}` }); }
        if (changes?.unified) { changesFile = path.join(dir, 'changes.diff'); fs.writeFileSync(changesFile, changes.unified); }
        if (stopped()) return { ok: false, cancelled: true, error: '작업이 중지되었습니다' };
      }
      // 같은 작업에서 앞서 의견을 준 대화가 있으면 이어 쓴다(읽은 파일·앞선 판단을 기억) — 안 되면 새 대화로 한 번 더
      const prev = [...task.consults].reverse().find((x) => x !== entry && x.status === 'done' && x.tool === tool && x.sessionId);
      const settings = internalSettings(m.config, tool, job.settings?.[tool] || {});
      entry.model = settings.model || null; entry.effort = settings.effort || null;
      const launch = (resumeSessionId) => {
        const prompt = buildConsultPrompt({ job, task, question, context, review, changes, changesFile, mode, resumed: !!resumeSessionId });
        fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
        return (this.deps.runWorker || runWorker)({
          readOnly: true, tool, prompt, cwd: job.cwd, runDir: dir, toolCfg: m.config.tools?.[tool], settings,
          modelPolicy: { config: m.config, fixed: job.settings?.[tool] || {} }, addDirs: [dir], resumeSessionId: resumeSessionId || null,
          timeoutMs: Math.max(1, Number(c.timeoutMinutes) || 8) * 60_000,
          onEvent: (ev) => { if (ev.sessionId) entry.sessionId = ev.sessionId; if (ev.kind === 'init' && ev.model) entry.model = ev.model; },
        });
      };
      run.handle = launch(prev?.sessionId);
      if (stopped()) { try { run.handle.cancel(); } catch {} }
      let res = await run.handle.promise;
      if (prev && !stopped() && canRestartResume(res, {})) {
        try { run.handle.close?.(); } catch {}
        entry.sessionId = null;
        run.handle = launch(null); res = await run.handle.promise;
      }
      return res;
    } finally { try { run.handle?.close?.(); } catch {} release(); }
  }

  settle(run, res) {
    const { job, task, entry } = run, name = NAMES[entry.tool], ms = Date.now() - run.startedAt;
    const cancelled = !res.ok && (res.cancelled || run.cancelled || job.status === 'cancelled' || this.m.frozen);
    entry.status = res.ok ? 'done' : cancelled ? 'cancelled' : 'failed';
    entry.ms = ms; entry.sessionId = res.sessionId || entry.sessionId || null;
    if (res.ok) entry.chars = String(res.text || '').length;
    else entry.error = truncate(cancelled ? '중지됨' : res.timedOut ? '시간 초과' : res.error || '응답 없음', 200);
    run.result = { status: entry.status, tool: entry.tool, ms, answer: res.ok ? String(res.text || '') : '', error: entry.error || null };
    if (!this.m.frozen) {
      this.m.log(job, task, { kind: 'consult', consult: entry.id, tool: entry.tool, state: entry.status, ms, text: res.ok ? `${name} 의견 도착 (${took(ms)}): ${truncate(String(res.text || '').replace(/\s+/g, ' '), 300)}` : `${name} 의견을 받지 못했어요: ${entry.error}` });
      this.m.emitJob(job);
    }
    const t = setTimeout(() => { if (this.runs.get(this.key(job, task, entry.id)) === run) this.runs.delete(this.key(job, task, entry.id)); }, 30 * 60_000); t.unref?.();
    return run.result;
  }

  /** 답 기다리기: 끝났으면 결과, 아니면 waitMs 까지 기다린 뒤 { status:'running' } */
  async wait({ owner, id, waitMs = 0 } = {}) {
    const { job, task } = this.find(owner);
    const entry = (task.consults || []).find((c) => c.id === String(id || ''));
    if (!entry) throw httpError(404, '그런 의견 요청이 없어요');
    const run = this.runs.get(this.key(job, task, entry.id));
    if (!run) {
      if (entry.status === 'done') return { id: entry.id, status: 'done', tool: entry.tool, ms: entry.ms || 0, answer: this.answer(job.id, task.id, entry.id).answer, error: null };
      return { id: entry.id, status: entry.status === 'running' ? 'failed' : entry.status, tool: entry.tool, ms: entry.ms || 0, answer: '', error: entry.error || '의견 요청이 중간에 끊겼어요' };
    }
    const ms = Math.max(0, Math.min(Number(waitMs) || 0, 240_000));
    if (!run.result && ms) await Promise.race([run.promise, sleep(ms)]);
    return run.result ? { id: entry.id, ...run.result } : { id: entry.id, status: 'running', tool: entry.tool };
  }

  /** 화면의 "답 보기": 실행 기록에 남은 답 전체 (GET /api/jobs/:id/consults/:task/:cid) */
  answer(jobId, taskId, id) {
    const { job, task } = this.find(`${jobId}/${taskId}`);
    const entry = (task.consults || []).find((c) => c.id === String(id || ''));
    if (!entry) throw httpError(404, '그런 의견 요청이 없어요');
    // 다른 PC에서 옮겨 온 기록에는 실행 기록 폴더가 없다
    const file = job.runDir ? path.join(job.runDir, task.id, `consult-${entry.n}`, 'result.md') : null;
    return { ...entry, answer: entry.status === 'done' && file ? readText(file, '') : '' };
  }

  /** 작업 중지·재시작 준비·하위 작업이 끝남: 그 작업(taskId 를 주면 그 하위 작업만, 둘 다 없으면 전부)의 의견 요청을 끈다 */
  cancel(jobId, taskId) {
    if (taskId === undefined) this.queue.cancel(jobId);
    for (const run of this.runs.values()) {
      if (run.result || (jobId !== undefined && run.job.id !== jobId) || (taskId !== undefined && run.task.id !== taskId)) continue;
      run.cancelled = true; try { run.handle?.cancel(); } catch {}
    }
  }
}
