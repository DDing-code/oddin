// 보관·갈래·내보내기와 Git API 연결. 원본 작업은 복사하지 않고 참조한다.
import fs from 'node:fs';
import path from 'node:path';
import { GitOps, sessionError } from './gitops.mjs';
import { RUNS_DIR, truncate, nowIso } from './util.mjs';
import { instructionText } from './intercepts.mjs';

export const SESSION_CAPABILITIES = { gitSessions: true, sessionArchive: true, sessionFork: true, sessionExport: true };
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export class SessionTools {
  constructor(manager, git = new GitOps(manager.config)) { this.manager = manager; this.git = git; }
  get(id) {
    const s = this.manager.sessions.get(id);
    if (!s) throw sessionError(404, 'SESSION_NOT_FOUND', '세션이 없어요');
    return s;
  }
  live(s) {
    return s.goal?.status === 'active' || s.jobIds.some((id) => this.manager.canIntercept(this.manager.jobs.get(id))) || [...this.manager.running.keys()].some((key) => s.jobIds.some((id) => key.startsWith(`${id}/`)));
  }
  idle(s, includeRepo = false) {
    this.git.assertAvailable(s);
    const related = includeRepo ? [...this.manager.sessions.values()].filter((x) => this.git.key(x) === this.git.key(s)) : [s];
    if (related.some((x) => this.live(x))) throw sessionError(409, 'SESSION_RUNNING', '실행 중인 작업을 마친 뒤 시도해 주세요');
  }
  assertWritable(s) {
    if (s.archived) throw sessionError(409, 'SESSION_ARCHIVED', '보관함에서 복원한 뒤 요청해 주세요');
    if (s.git?.cleanedAt) throw sessionError(409, 'GIT_WORKTREE_REMOVED', '정리된 worktree예요. 새 갈래 세션을 만들어 주세요');
    this.git.assertAvailable(s);
  }
  initialize(s, body = {}) {
    if (body.forkOf) {
      if (typeof body.forkOf !== 'object' || !body.forkOf.sessionId) throw sessionError(400, 'FORK_SOURCE_REQUIRED', '갈래를 만들 원본 세션을 골라 주세요');
      const source = this.get(body.forkOf.sessionId);
      const jobId = body.forkOf.jobId || source.jobIds.at(-1) || null;
      if (jobId && (!source.jobIds.includes(jobId) || !this.manager.jobs.has(jobId))) throw sessionError(400, 'FORK_JOB_INVALID', '원본 세션의 작업을 골라 주세요');
      s.forkOf = { sessionId: source.id, jobId }; s.forkTitle = source.title;
    }
    this.git.initialize(s, body.isolate === true);
  }
  fork(id, body = {}) {
    const source = this.get(id);
    return this.manager.createSession({ cwd: body.cwd || (source.git?.cleanedAt ? source.git.repo : source.cwd), title: body.title || `${source.title} 갈래`, isolate: body.isolate === true, forkOf: { sessionId: id, jobId: body.jobId } });
  }
  assertUnreferenced(id, jobId = null) {
    const source = this.manager.sessions.get(id);
    for (const s of this.manager.sessions.values()) {
      if (s.forkOf?.sessionId !== id) continue;
      const cutoff = source?.jobIds.indexOf(s.forkOf.jobId) ?? -1;
      if (!jobId || (cutoff >= 0 && source.jobIds.indexOf(jobId) <= cutoff)) throw sessionError(409, 'SESSION_FORK_REFERENCED', '갈래 세션이 참조하는 기록은 삭제할 수 없어요');
    }
  }
  async archive(id, body = {}, archived = true) {
    const s = this.get(id); this.idle(s);
    if (archived && body.cleanup === true) await this.gitAction(id, 'cleanup');
    // 비동기 Git 작업이 끝난 뒤에도 작업 시작을 다시 검사한다.
    this.idle(s); s.archived = archived; s.updatedAt = nowIso();
    this.manager.emitSession(s); return this.manager.publicSession(s);
  }
  async delete(id, cleanup = false) {
    const s = this.get(id); this.idle(s); this.assertUnreferenced(id);
    if (cleanup) await this.gitAction(id, 'cleanup');
    return this.manager.deleteSession(id);
  }
  async gitAction(id, kind, body = {}) {
    const s = this.get(id); this.idle(s, true);
    if (kind !== 'cleanup') this.assertWritable(s);
    if (kind === 'cleanup' && s.git?.cleanedAt) return { removed: false, branchKept: true, branch: s.git.branch };
    // 같은 폴더를 공유하는 다른 세션의 작업 경로를 지우지 않는다.
    if (kind === 'cleanup' && s.git?.worktree) {
      const root = path.resolve(s.git.worktree).toLowerCase();
      if ([...this.manager.sessions.values()].some((x) => x.id !== id && !x.git?.cleanedAt && [x.cwd, x.git?.repo].filter(Boolean).some((p) => path.resolve(p).toLowerCase() === root || path.resolve(p).toLowerCase().startsWith(root + path.sep)))) throw sessionError(409, 'GIT_WORKTREE_SHARED', '다른 세션이 이 worktree를 사용하고 있어요');
    }
    try { return await this.git.action(s, kind, body); }
    finally { this.manager.emitSession(s); }
  }
  previous(s, seen = new Set()) {
    if (!s?.forkOf) return [];
    if (seen.has(s.id)) throw sessionError(409, 'FORK_CYCLE', '갈래 세션 참조가 순환하고 있어요');
    seen.add(s.id);
    const source = this.get(s.forkOf.sessionId), index = source.jobIds.indexOf(s.forkOf.jobId);
    if (s.forkOf.jobId && index < 0) throw sessionError(409, 'FORK_SOURCE_MISSING', '갈래의 원본 작업을 찾을 수 없어요');
    return [...this.previous(source, seen), ...source.jobIds.slice(0, index + 1).map((id) => this.manager.jobs.get(id)).filter(Boolean)];
  }
  /**
   * 세션 결정 노트: job 전까지(갈래면 원본의 갈라진 시점까지 포함) 가장 최근 정리 스냅샷.
   * 그 뒤에 사용자가 기억 탭에서 고친 것(s.notesEdit)이 있으면 그것. job 이 없으면 지금 노트.
   */
  notesFor(s, job = null) {
    if (!s) return [];
    const own = s.jobIds.map((id) => this.manager.jobs.get(id)).filter((j) => j && (!job || (j.id !== job.id && j.createdAt < job.createdAt)));
    const snap = [...this.previous(s), ...own].reverse().find((j) => Array.isArray(j.sessionNotes));
    const edit = s.notesEdit;
    if (edit && Array.isArray(edit.notes) && (!snap || (edit.at || '') >= (snap.curation?.at || ''))) return edit.notes.map((n) => ({ ...n }));
    return (snap?.sessionNotes || []).map((n) => ({ ...n }));
  }
  // 다음 요청에 줄 세션 맥락: 결정 노트는 잘리지 않게 앞에 통째로, 이전 명령·결과는 최근 것부터 남은 예산만큼
  // maxItems: 최근 몇 건까지, itemChars: 결과를 건당 몇 자까지, notesOnly: 노트만(이어 쓰는 CLI 대화는 이전 명령을 이미 가짐)
  historyContext(job, limit = 24_000, { maxItems = Infinity, itemChars = 6000, notesOnly = false, afterJobId = null } = {}) {
    const s = this.manager.sessions.get(job.sessionId); if (!s) return '';
    const own = s.jobIds.filter((id) => id !== job.id).map((id) => this.manager.jobs.get(id)).filter((j) => j && j.createdAt < job.createdAt);
    const prev = [...this.previous(s), ...own];
    const notes = this.notesFor(s, job);
    const head = notes.length ? `## 세션 결정 노트 (이 세션에서 정해진 것 — 잘리지 않음. 이번 요청이 노트와 다르면 이번 요청을 따르세요)\n${notes.map((n) => `- ${n.text}`).join('\n')}\n\n` : '';
    if (notesOnly) return head.trim();
    const refsFor = (j) => j.runDir ? ['GOAL.md', 'intercepts.jsonl', 'REPORT.md'].map((name) => path.join(j.runDir, name)).filter((file) => fs.existsSync(file)).join('\n') : '';
    if (afterJobId) {
      // 같은 CLI가 마지막으로 맡은 요청의 최종 결과와 그 뒤 다른 담당자에게 한 수정도 전달한다.
      // ponytail: 재개 탐색 범위(기본 최근 5건)의 사용자 원문은 보존. 더 긴 대화 재개가 필요하면 원문 파일 참조로 전환한다.
      const at = prev.findIndex((j) => j.id === afterJobId);
      const updates = prev.slice(at < 0 ? 0 : at).map((j) => {
        const refs = refsFor(j);
        return `### ${j.id} (${j.status})\n${j.goal}${instructionText(j)}\n결과 요약: ${truncate(j.report || j.error || '(결과 없음)', 500)}${refs ? '\n원문 기록:\n' + refs : ''}`;
      });
      return head + (updates.length ? `## 이 대화가 마지막으로 맡은 요청 이후의 변경 (다른 담당자의 작업 포함)\n요청과 수정 지시는 원문입니다. 결과는 요약이므로 필요한 근거는 원문 기록에서 확인하세요.\n${updates.join('\n\n')}` : '');
    }
    const items = prev.map((j, i) => {
      const refs = refsFor(j);
      return `### 이전 명령 ${i + 1} (${j.createdAt.slice(0, 16).replace('T', ' ')}, ${j.status})\n${j.goal}${instructionText(j)}\n\n#### 결과\n${truncate(j.report || j.error || '(결과 없음)', itemChars)}${refs ? '\n원문 기록:\n' + refs : ''}`;
    });
    const budget = Math.max(limit - head.length, Math.min(limit, 4000));
    let body = '', kept = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const next = body ? `${items[i]}\n\n${body}` : items[i];
      if ((next.length > budget || kept >= maxItems) && kept) break;
      body = next.length > budget ? '…' + next.slice(-budget) : next; kept++;
    }
    const skipped = items.length - kept;
    const lead = skipped ? `(오래된 이전 명령 ${skipped}건은 생략${notes.length ? ' — 그때 정한 것은 위 결정 노트에 있어요' : ''})\n\n` : '';
    if (!head) return lead + body;
    return head + (body ? `## 최근 명령과 결과\n${lead}${body}` : '');
  }
  changedFiles(j) {
    const files = new Set((j.changedFiles || []).map((f) => typeof f === 'string' ? f : f.path).filter(Boolean));
    // 실행 로그의 파일 경로만 사용한다. 소스·환경 파일·CLI 인증 자료는 열지 않는다.
    const dir = path.resolve(j.runDir || RUNS_DIR), allowed = path.relative(RUNS_DIR, dir);
    if (!allowed || allowed.startsWith('..') || path.isAbsolute(allowed)) return [...files];
    for (const t of j.tasks || []) {
      if (!/^[\w-]+$/.test(t.id)) continue;
      let text; try { text = fs.readFileSync(path.join(dir, `${t.id}.log.jsonl`), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.kind !== 'tool' || !e.detail || !EDIT_TOOLS.has(e.name)) continue;
        const parts = t.assignee === 'codex' ? String(e.detail).split(/,\s*/).map((f) => f.replace(/^(add|update|delete|modify)\s+/i, '')) : [String(e.detail)];
        for (const f of parts) files.add(f);
      }
    }
    return [...files];
  }
  export(id, format = 'md') {
    const s = this.get(id), jobs = s.jobIds.map((id) => this.manager.jobs.get(id)).filter(Boolean).map((j) => ({ id: j.id, title: j.title, createdAt: j.createdAt, status: j.status, request: j.input || j.goal, summary: j.summary || '', tasks: (j.tasks || []).map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, status: t.status, result: t.resultText || t.error || '', files: t.changedFiles || [] })), report: j.report || j.error || '', changedFiles: this.changedFiles(j) }));
    const result = { version: 1, exportedAt: nowIso(), session: this.manager.publicSession(s), inheritedContext: this.historyContext({ sessionId: id, id: '', createdAt: '' }), jobs };
    if (format === 'json') return result;
    const lines = [`# ${s.title}`, '', `- 세션: ${s.id}`, `- 작업 폴더: ${s.cwd}`, `- 보관: ${s.archived ? '예' : '아니요'}`, ...(s.forkOf ? [`- 갈래 원본: ${s.forkTitle || s.forkOf.sessionId} (${s.forkOf.sessionId}, ${s.forkOf.jobId || '작업 없음'})`] : []), '', ...(result.inheritedContext ? ['## 이어받은 대화 맥락', '', result.inheritedContext, ''] : [])];
    for (const j of jobs) {
      lines.push(`## ${j.title} (${j.id})`, '', `- 상태: ${j.status}`, `- 요청 시각: ${j.createdAt}`, '', '### 요청', '', j.request, '', '### 계획 요약', '', j.summary || '(없음)', '');
      for (const t of j.tasks) lines.push(`### ${t.title} (${t.assignee}, ${t.status})`, '', t.result || '(결과 없음)', '');
      lines.push('### 보고서', '', j.report || '(없음)', '', '### 바뀐 파일', '', ...(j.changedFiles.length ? j.changedFiles.map((f) => `- ${f}`) : ['(기록된 파일 없음)']), '');
    }
    return lines.join('\n');
  }
}

// 기존 서버 라우터에는 이 함수 호출만 연결한다. 보안 게이트를 통과한 요청만 받는다.
export async function sessionToolsRoute({ req, res, url, jobs, readBody, json, send }) {
  const match = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/(git(?:\/(commit|merge|push|pr|ci|cleanup))?|archive|unarchive|fork|export\.(md|json))$/);
  if (!match) return false;
  const [, id, action, gitAction, format] = match, tools = jobs.sessionTools;
  try {
    if (req.method === 'GET' && action === 'git') json(res, tools.git.status(tools.get(id)));
    else if (req.method === 'GET' && gitAction === 'ci') json(res, await tools.git.ci(tools.get(id)));
    else if (req.method === 'GET' && format) send(res, 200, format === 'json' ? JSON.stringify(tools.export(id, format), null, 2) : tools.export(id), format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="${id}.${format}"` });
    else if (req.method === 'POST' && ['commit', 'merge', 'push', 'pr', 'cleanup'].includes(gitAction)) json(res, await tools.gitAction(id, gitAction, await readBody(req)));
    else if (req.method === 'POST' && ['archive', 'unarchive'].includes(action)) json(res, await tools.archive(id, await readBody(req), action === 'archive'));
    else if (req.method === 'POST' && action === 'fork') json(res, tools.fork(id, await readBody(req)), 201);
    else json(res, { error: '이 API에서 지원하지 않는 요청 방식이에요', code: 'METHOD_NOT_ALLOWED' }, 405);
  } catch (e) { json(res, { error: e instanceof SyntaxError ? 'JSON 본문을 확인해 주세요' : e.message, code: e.code || (e instanceof SyntaxError ? 'INVALID_JSON' : 'SESSION_OPERATION_FAILED'), ...(e.files ? { files: e.files } : {}) }, e.status || (e instanceof SyntaxError ? 400 : 500)); }
  return true;
}
