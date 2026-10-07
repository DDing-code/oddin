// 승인·질문은 CLI 연결과 분리해 저장한다. 연결이 사라진 요청은 다시 실행하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic, nowIso } from './util.mjs';

export const AUTO_ANSWER = '사용자가 답하지 않았습니다. 가장 합리적인 선택으로 진행하고 보고서에 그 선택을 적으세요';
export const PERMISSIONS = ['auto', 'edits', 'ask', 'plan'];
const error = (status, message) => Object.assign(new Error(message), { status });
export function permissionSetting(config = {}, requested) {
  const value = requested ?? config.defaults?.permission ?? 'auto';
  if (!PERMISSIONS.includes(value)) throw error(400, '권한 방식은 auto, edits, ask, plan 중 하나여야 합니다');
  return value;
}
export class PromptManager {
  constructor({ file, config = {}, onChange = () => {} } = {}) {
    this.file = file; this.config = config; this.onChange = onChange;
    this.records = new Map(); this.live = new Map(); this.allowed = new Set();
    for (const p of file ? readJson(file, []) : []) {
      if (p.status === 'pending') { p.status = 'expired'; p.answeredAt = nowIso(); p.reason = '서버가 다시 시작되어 요청이 만료되었습니다'; }
      this.records.set(p.id, p);
    }
    this.save();
  }
  save() { if (this.file) writeJsonAtomic(this.file, [...this.records.values()]); }
  list({ status = 'pending', jobId } = {}) { return [...this.records.values()].filter((p) => (status === 'all' || p.status === status) && (!jobId || p.jobId === jobId)); }
  changed(p) { this.save(); this.onChange(structuredClone(p)); }
  key(p) { return `${p.jobId}/${p.tool}/${p.category}`; }
  request(spec, { permission = 'auto', owner } = {}) {
    if (spec.kind === 'approval' && this.allowed.has(this.key(spec))) return Promise.resolve({ action: 'allow' });
    const p = { ...spec, id: randomUUID(), status: 'pending', createdAt: nowIso(), answeredAt: null, answer: null };
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    this.records.set(p.id, p); this.live.set(p.id, { resolve, reject, owner, timer: null });
    if (p.kind === 'question' && permission === 'auto') {
      const minutes = Number(this.config.prompts?.autoAnswerMinutes ?? 20);
      p.expiresAt = new Date(Date.now() + Math.max(0, Number.isFinite(minutes) ? minutes : 20) * 60000).toISOString();
      this.live.get(p.id).timer = setTimeout(() => {
        try { this.settle(p, { answers: Object.fromEntries(p.detail.questions.map((q) => [q.id, [AUTO_ANSWER]])), automatic: true }, 'expired'); }
        catch (e) { this.live.delete(p.id); p.status = 'expired'; reject(error(500, `자동 응답을 저장하지 못했습니다: ${e.message}`)); }
      }, Math.max(0, Number.isFinite(minutes) ? minutes : 20) * 60000);
    }
    try { this.changed(p); }
    catch (e) { clearTimeout(this.live.get(p.id)?.timer); this.live.delete(p.id); this.records.delete(p.id); throw error(500, `요청을 저장하지 못했습니다: ${e.message}`); }
    return promise;
  }
  answer(id, answer, viewer = null) {
    const p = this.records.get(id);
    if (!p) throw error(404, '요청을 찾을 수 없습니다');
    if (p.status !== 'pending' || !this.live.has(id)) throw error(409, '이미 처리되었거나 만료된 요청입니다');
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw error(400, '응답 형식이 올바르지 않습니다');
    if (p.kind === 'question') {
      const answers = Object.create(null);
      for (const q of p.detail.questions) {
        const v = answer.answers?.[q.id];
        const values = typeof v === 'string' ? [v] : v;
        if (!Array.isArray(values) || !values.length || values.some((x) => typeof x !== 'string' || !x.trim() || x.length > 20000) || (!q.multiSelect && values.length > 1)) throw error(400, '모든 문항에 답해주세요');
        if (q.allowFreeText === false && values.some((v) => !q.options?.some((o) => o.label === v))) throw error(400, '제시된 선택지에서 골라주세요');
        answers[q.id] = values;
      }
      answer = { answers };
    } else {
      const actions = p.kind === 'plan' ? ['approve', 'revise', 'reject'] : ['allow', 'allow_session', 'deny'];
      if (!actions.includes(answer.action) || (answer.message != null && (typeof answer.message !== 'string' || answer.message.length > 20000))) throw error(400, '응답 형식이 올바르지 않습니다');
      if (answer.action === 'revise' && !answer.message?.trim()) throw error(400, '계획 수정 의견을 적어주세요');
      answer = { action: answer.action, message: answer.message || '' };
    }
    p.viewer = viewer ? { remote: !!viewer.remote, login: viewer.login || null } : null;
    this.settle(p, answer, 'answered'); return structuredClone(p);
  }
  settle(p, answer, status) {
    const live = this.live.get(p.id); if (!live) return;
    const previous = { ...p }, savedAnswer = structuredClone(answer);
    for (const q of p.detail.questions || []) if (q.isSecret && savedAnswer.answers?.[q.id]) savedAnswer.answers[q.id] = ['[비공개]'];
    Object.assign(p, { status, answer: savedAnswer, answeredAt: nowIso() });
    try { this.changed(p); }
    catch (e) { Object.assign(p, previous); throw error(500, `응답을 저장하지 못했습니다: ${e.message}`); }
    clearTimeout(live.timer); this.live.delete(p.id);
    if (answer.action === 'allow_session') this.allowed.add(this.key(p));
    live.resolve(answer);
  }
  cancel({ jobId, owner, cliRequestId, status = 'cancelled' } = {}) {
    for (const p of this.records.values()) if (p.status === 'pending' && (!jobId || p.jobId === jobId) && (!owner || this.live.get(p.id)?.owner === owner) && (cliRequestId === undefined || p.cliRequestId === cliRequestId)) {
      const answer = { action: 'deny', message: status === 'expired' ? 'CLI 연결이 종료되어 요청이 만료되었습니다' : '작업이 중지되었습니다' };
      try { this.settle(p, answer, status); }
      catch (e) {
        // 디스크 오류가 나도 중지와 연결 종료는 우선한다. 허용 응답은 보내지 않는다.
        const live = this.live.get(p.id); clearTimeout(live?.timer); this.live.delete(p.id);
        Object.assign(p, { status, answer, answeredAt: nowIso(), persistenceError: e.message });
        try { this.onChange(structuredClone(p)); } catch {}
        live?.resolve(answer);
      }
    }
  }
  clearSession(jobId) { for (const key of this.allowed) if (key.startsWith(`${jobId}/`)) this.allowed.delete(key); }
}

export function normalizeQuestions(questions = [], tool) {
  return questions.map((q, i) => ({ id: q.id || `q${i + 1}`, question: q.question, header: q.header || '', options: q.options || [], multiSelect: !!q.multiSelect, allowFreeText: tool === 'claude' || q.isOther === true || !q.options?.length, isSecret: !!q.isSecret }));
}
export function codexPolicy(permission) {
  if (permission === 'readonly') return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
  return permission === 'auto' ? { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    : permission === 'plan' ? { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
      : permission === 'ask' ? { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
        : { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } };
}

// 앞뒤를 보존하며 화면에 보낼 내용만 제한한다. 원본 CLI 이벤트는 별도 파일에 남는다.
export function clip(value, max = 4000) {
  const s = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  const mark = '\n… 중간 생략 …\n';
  return s.length <= max ? s : s.slice(0, Math.floor((max - mark.length) / 2)) + mark + s.slice(-Math.ceil((max - mark.length) / 2));
}
export class ToolRecords {
  constructor(tool, emit) { this.tool = tool; this.emit = emit; this.calls = new Map(); this.scope = randomUUID(); }
  nextTurn() { this.close('새 턴이 시작되어 이전 도구 결과를 확인할 수 없습니다'); this.calls.clear(); this.scope = randomUUID(); }
  start(id, name, input = {}, diff) {
    if (!id || this.calls.has(id)) return;
    const summary = Object.fromEntries(Object.entries(input || {}).filter(([k]) => !/token|secret|password|authorization|apiKey/i.test(k)).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 1000) : JSON.parse(clipJson(v))]));
    const call = { kind: 'tool', callId: `${this.scope}/${id}`, cliCallId: id, tool: this.tool, name, input: summary, status: 'running', output: '', diff, startedAt: nowIso(), endedAt: null, detail: clip(input.command || input.file_path || input.path || input.pattern || input.url || name, 300), text: name };
    this.calls.set(id, call); this.emit({ ...call });
  }
  end(id, output, failed = false, diff) {
    const call = this.calls.get(id); if (!call || call.endedAt) return;
    Object.assign(call, { status: failed ? 'error' : 'done', output: clip(output), endedAt: nowIso(), ...(diff ? { diff } : {}) }); this.emit({ ...call });
  }
  claude(content) {
    if (content.type === 'tool_use') {
      const i = content.input || {}, diff = ['Edit', 'Write'].includes(content.name) ? [{ path: i.file_path, before: i.old_string == null ? undefined : clip(i.old_string), after: clip(i.new_string ?? i.content) }] : undefined;
      this.start(content.id, content.name, i, diff);
    } else if (content.type === 'tool_result') this.end(content.tool_use_id, Array.isArray(content.content) ? content.content.map((c) => c.text || '').join('\n') : content.content, content.is_error);
  }
  codex(item, completed) {
    const type = item.type?.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (!['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall'].includes(type)) return;
    const changes = item.changes || [], diff = type === 'fileChange' ? changes.map((c) => ({ path: c.path, unified: clip(c.diff || c.unified_diff || '') })) : undefined;
    const name = type === 'commandExecution' ? 'Bash' : type === 'fileChange' ? 'Edit' : type === 'mcpToolCall' ? `MCP ${item.server}.${item.tool}` : type;
    this.start(item.id, name, type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : type === 'fileChange' ? { paths: changes.map((c) => c.path) } : { arguments: item.arguments, url: item.url, query: item.query }, diff);
    if (completed) this.end(item.id, item.aggregatedOutput ?? item.aggregated_output ?? item.result ?? item.error ?? '', item.status === 'failed' || item.status === 'declined' || !!item.error || (item.exitCode ?? item.exit_code ?? 0) !== 0, diff);
  }
  close(reason) { for (const [id, call] of this.calls) if (!call.endedAt) this.end(id, reason, true); }
}
function clipJson(v) { const s = JSON.stringify(v ?? null); return s.length <= 1000 ? s : JSON.stringify(clip(s, 1000)); }

export function planText(input, fallback, cwd) {
  if (input.plan) return String(input.plan);
  if (input.planFilePath) {
    const file = path.resolve(cwd, input.planFilePath);
    // .env와 임의 파일을 계획으로 읽지 않는다.
    if (path.extname(file).toLowerCase() === '.md' && fs.existsSync(file) && fs.statSync(file).size <= 200000) return fs.readFileSync(file, 'utf8');
  }
  return fallback || '계획 내용이 전달되지 않았습니다';
}

// 프로토콜별 응답 모양만 이곳에서 변환한다. 실제 전송은 소유한 워커가 한다.
export function promptBridge(opts, ask, currentPermission, itemOf = () => null) {
  const spec = (kind, category, title, detail, cliRequestId) => ({ jobId: opts.jobId || null, taskId: opts.taskId || null, phase: opts.phase || 'worker', tool: opts.tool, kind, category, title, detail, cliRequestId });
  const approval = async (category, title, detail, cliRequestId) => {
    const mode = currentPermission();
    if (mode === 'readonly') return category === 'read' ? { action: 'allow' } : { action: 'deny', message: '읽기 전용 요청에서는 변경이나 추가 권한을 허용하지 않습니다' };
    if (mode === 'auto' || (mode === 'edits' && category === 'file') || category === 'read') return { action: 'allow' };
    if (mode === 'plan') return { action: 'deny', message: '계획 승인 전에는 변경이나 명령을 실행할 수 없습니다' };
    return ask(spec('approval', category, title, detail, cliRequestId));
  };
  return {
    plan: (plan, cliRequestId) => ask(spec('plan', 'plan', '계획을 승인해주세요', { plan }, cliRequestId)),
    async claude(request) {
      const name = request.tool_name, input = request.input || {};
      if (name === 'AskUserQuestion') {
        const questions = normalizeQuestions(input.questions, 'claude');
        const answer = await ask(spec('question', 'question', '질문에 답해주세요', { questions }, request.cliRequestId));
        if (!answer.answers) return { behavior: 'deny', message: answer.message || '질문이 취소되었습니다' };
        return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map((q) => [q.question, answer.answers[q.id].join(', ')])) } };
      }
      if (name === 'ExitPlanMode') {
        if (currentPermission() === 'readonly') return { behavior: 'deny', message: '읽기 전용 요청입니다. 확인한 내용으로 답해 주세요' };
        if (currentPermission() === 'auto') return { behavior: 'allow', updatedInput: input };
        const answer = await this.plan(planText(input, opts.planFallback?.(), opts.cwd), request.cliRequestId);
        if (answer.action === 'approve') return { behavior: 'allow', updatedInput: input, planApproved: true };
        return { behavior: 'deny', message: answer.action === 'revise' ? `계획을 수정하고 다시 승인을 요청하세요. ${answer.message}` : answer.message || '계획이 거절되었습니다', planRejected: answer.action === 'reject' };
      }
      const category = ['Read', 'Glob', 'Grep', 'ToolSearch', 'WebFetch', 'WebSearch'].includes(name) ? 'read' : ['Write', 'Edit', 'NotebookEdit'].includes(name) ? 'file' : /Bash|PowerShell|exec/i.test(name) ? 'command' : /Web|Fetch|Search/i.test(name) ? 'network' : 'permission';
      const answer = await approval(category, `${name} 실행을 승인해주세요`, { command: input.command, cwd: input.cwd || opts.cwd, files: input.file_path ? [{ path: input.file_path, diff: clip(input.new_string ?? input.content ?? '') }] : undefined, reason: request.description, input }, request.cliRequestId);
      return answer.action === 'allow' || answer.action === 'allow_session' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: answer.message || '사용자가 실행을 거절했습니다' };
    },
    async codex(method, p) {
      if (method === 'item/tool/requestUserInput') {
        const questions = normalizeQuestions(p.questions, 'codex');
        const answer = await ask(spec('question', 'question', '질문에 답해주세요', { questions, isBlocking: p.isBlocking }, p.cliRequestId));
        return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: answer.answers?.[q.id] || [answer.message || '질문이 취소되었습니다'] }])) };
      }
      const category = method === 'item/fileChange/requestApproval' ? 'file' : method === 'item/commandExecution/requestApproval' ? 'command' : method === 'item/permissions/requestApproval' ? 'permission' : null;
      if (!category) throw error(-32601, '지원하지 않는 CLI 요청입니다');
      const item = itemOf(p.itemId);
      const detail = { command: p.command, cwd: p.cwd || opts.cwd, reason: p.reason, permissions: p.permissions, files: (item?.changes || []).map((c) => ({ path: c.path, diff: clip(c.diff || '') })), grantRoot: p.grantRoot };
      const answer = await approval(category, category === 'file' ? '파일 변경을 승인해주세요' : category === 'command' ? '명령 실행을 승인해주세요' : '추가 권한을 승인해주세요', detail, p.cliRequestId);
      const allow = ['allow', 'allow_session'].includes(answer.action);
      if (category === 'permission') return { permissions: allow ? p.permissions : {}, scope: 'turn', ...(!allow && answer.message ? { hubMessage: answer.message } : {}) };
      // 작업 동안의 허용 캐시는 허브가 관리한다. CLI의 더 넓은 세션 허용은 쓰지 않는다.
      return { decision: allow ? 'accept' : 'decline', ...(!allow && answer.message ? { hubMessage: answer.message } : {}) };
    },
  };
}
