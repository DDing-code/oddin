/* 추론 과정 기록 계산: 화면 상태나 현재 시각을 직접 읽지 않는다 */
(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.ProcessModel = model;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const active = (status) => ['planning', 'running', 'reporting'].includes(status);
  const terminal = (status) => ['done', 'failed', 'cancelled', 'interrupted', 'skipped'].includes(status);
  const toolKind = (name = '') => /^(Bash|PowerShell)$|exec|commandExecution/i.test(name) ? 'cmd' : /^(Edit|Write|MultiEdit|NotebookEdit|fileChange)$/.test(name) ? 'edit' : name === 'Read' ? 'read' : /^(Grep|Glob|ToolSearch)$/.test(name) ? 'search' : /^Web|Fetch|Search/i.test(name) ? 'web' : /^MCP /.test(name) ? 'mcp' : name === 'AskUserQuestion' ? 'ask' : name === 'ExitPlanMode' ? 'plan' : /^(Agent|Task)$/.test(name) ? 'agent' : 'other';
  const time = (value) => { const n = Date.parse(value); return Number.isFinite(n) ? n : null; };
  const seconds = (from, to) => time(from) == null || time(to) == null ? null : Math.max(0, (time(to) - time(from)) / 1000);
  function elapsed(from, to, precise = false) {
    const value = seconds(from, to); if (value == null) return '';
    if (precise && value < 10) return `${value.toFixed(1)}초`;
    const s = Math.floor(value);
    return s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초` : `${Math.floor(s / 3600)}시간 ${Math.floor(s % 3600 / 60)}분`;
  }
  function offset(from, to) {
    const value = seconds(from, to); if (value == null) return '';
    const s = Math.floor(value), mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    return s < 3600 ? `+${mm}:${ss}` : `+${Math.floor(s / 3600)}:${String(mm % 60).padStart(2, '0')}:${ss}`;
  }
  /**
   * 화면에 보여 줄 명령: Codex 가 감싼 셸 껍데기(powershell -Command "…", bash -lc '…', cmd /c …)를 벗겨 실제 명령만 남긴다.
   * 벗길 수 없으면 원문 그대로.
   */
  function displayCommand(raw) {
    let s = String(raw || '').trim();
    const unquote = (x) => {
      x = x.trim();
      if (x.length >= 2 && ((x[0] === '"' && x.endsWith('"')) || (x[0] === "'" && x.endsWith("'")))) {
        const q = x[0]; x = x.slice(1, -1);
        if (q === '"') x = x.replace(/\\"/g, '"').replace(/`"/g, '"');
        else x = x.replace(/'\\''/g, "'");
      }
      return x;
    };
    for (let i = 0; i < 2; i++) {
      const ps = s.match(/^"?(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?:NoProfile|NoLogo|NonInteractive|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\s+([\s\S]+)$/i);
      if (ps) { s = unquote(ps[1]); continue; }
      const sh = s.match(/^"?(?:[^"\s]*[\\/])?(?:bash|sh|zsh)(?:\.exe)?"?\s+-l?c\s+([\s\S]+)$/i);
      if (sh) { s = unquote(sh[1]); continue; }
      const cmd = s.match(/^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[cs]\s+([\s\S]+)$/i);
      if (cmd) { s = unquote(cmd[1]); continue; }
      break;
    }
    return s;
  }
  function thinkingTitle(text) {
    return String(text || '').split('\n').map((s) => s.trim().replace(/^(?:#+\s*|\*\*)+/, '').replace(/(?:\*\*|\s|\.|#)+$/, '').trim()).filter(Boolean).join('\n');
  }
  function exitCode(e) {
    const explicit = e.exitCode ?? e.exit_code;
    if (explicit != null && /^-?\d+$/.test(String(explicit))) return Number(explicit);
    const error = String(e.errorText || '').match(/\bexit\s+(-?\d+)\s*:/i);
    const output = String(e.output || '').match(/\bexit\s+(-?\d+)\s*:?\s*$/i);
    return error ? Number(error[1]) : output ? Number(output[1]) : null;
  }
  function missingResult(e) {
    return e.status === 'error' && !e.errorText && (!e.output || /^(?:도구 결과를 받기 전에 실행이 종료되었습니다|작업이 중지되었습니다|새 턴이 시작되어 이전 도구 결과를 확인할 수 없습니다)$/.test(String(e.output).trim()));
  }
  function mergeCalls(records) {
    const list = [], calls = new Map();
    for (const raw of records || []) {
      const e = { ...raw, input: raw.input ? { ...raw.input } : undefined };
      if (e.kind === 'tool' && e.callId) {
        if (calls.has(e.callId)) {
          const index = calls.get(e.callId), old = list[index];
          list[index] = { ...old, ...e, at: old.at, startedAt: old.startedAt || e.startedAt || old.at, input: { ...old.input, ...e.input } };
          continue;
        }
        calls.set(e.callId, list.length);
      }
      list.push(e);
    }
    return list;
  }
  function itemsFor(records, prompts = [], key = '') {
    const list = mergeCalls(records).map((e, i) => ({ ...e, id: e.callId || `${key}#l${i}`, toolKind: e.kind === 'tool' ? toolKind(e.name) : undefined }));
    prompts.forEach((p) => list.push({ kind: 'prompt', id: `${key}#p${p.id}`, at: p.createdAt, prompt: p }));
    list.sort((a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0));
    const visible = [];
    for (const e of list) {
      if (['init', 'turn', 'memory', 'raw', 'result'].includes(e.kind)) continue;
      if (e.kind === 'waiting') {
        if (!e.waiting || prompts.some((p) => time(p.createdAt) != null && time(e.at) != null && Math.abs(time(p.createdAt) - time(e.at)) <= 5000)) continue;
        e.text = '사용자 응답 기다리는 중';
      }
      if (e.kind === 'thinking') { e.thought = e.text; e.text = thinkingTitle(e.text); }
      if (!['tool', 'message', 'thinking', 'tool_error', 'error', 'intercept', 'stderr', 'waiting', 'prompt'].includes(e.kind)) continue;
      const prev = visible[visible.length - 1];
      const delta = seconds(prev?.endedAt || prev?.at, e.at);
      if (['tool_error', 'error'].includes(e.kind) && prev?.toolKind === 'cmd' && prev.status === 'error' && delta != null && time(e.at) >= time(prev.endedAt || prev.at) && delta <= 2 && /\bexit\s+-?\d+\s*:/i.test(e.text || '')) {
        prev.errorText = String(e.text); prev.exitCode = exitCode(prev); continue;
      }
      if (e.kind === 'tool') { e.exitCode = exitCode(e); e.missingResult = missingResult(e); }
      visible.push(e);
    }
    return visible;
  }
  function counts(items) {
    const out = { steps: 0, commands: 0, edits: 0, errors: 0 };
    for (const e of items) {
      if (['message', 'thinking', 'tool', 'tool_error', 'error', 'intercept', 'prompt'].includes(e.kind)) out.steps++;
      if (e.kind === 'tool' && e.toolKind === 'cmd') out.commands++;
      if (e.kind === 'tool' && e.toolKind === 'edit') out.edits++;
      if ((e.kind === 'tool' && e.status === 'error') || ['tool_error', 'error'].includes(e.kind)) out.errors++;
    }
    return out;
  }
  function groupItems(items, key) {
    const out = [], warnings = items.filter((e) => e.kind === 'stderr'); let warningAdded = false;
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      if (e.kind === 'stderr') {
        if (!warningAdded) { out.push({ kind: 'warnings', id: `${key}#w${e.id}`, at: e.at, items: warnings.map((w) => ({ ...w, text: String(w.text || '').slice(0, 400) })), label: `경고 ${warnings.length}건` }); warningAdded = true; }
        continue;
      }
      if (e.kind === 'tool' && ['read', 'search'].includes(e.toolKind)) {
        let end = i + 1;
        while (end < items.length && items[end].kind === 'tool' && ['read', 'search'].includes(items[end].toolKind)) end++;
        if (end - i >= 3) {
          const run = items.slice(i, end), reads = run.filter((x) => x.toolKind === 'read').length, searches = run.length - reads;
          const running = run.some((x) => x.callId && (!x.status || x.status === 'running'));
          const last = run.reduce((a, b) => (time(b.endedAt || b.at) ?? 0) >= (time(a.endedAt || a.at) ?? 0) ? b : a);
          out.push({ kind: 'group', id: `${key}#g${e.id}`, items: run, at: e.at, startedAt: e.startedAt || e.at, endedAt: last.endedAt || last.at, status: running ? 'running' : run.some((x) => x.status === 'error') ? 'error' : 'done', label: [reads ? `파일 ${reads}개 읽음` : '', searches ? `검색 ${searches}회` : ''].filter(Boolean).join(' · ') });
          i = end - 1; continue;
        }
      }
      out.push(e);
    }
    return out;
  }
  function preview(items) {
    const list = items.filter((e) => !['stderr', 'waiting'].includes(e.kind));
    // 시작 위치가 아닌 마지막 갱신 시각으로 현재 단계를 고른다
    const e = list.reduce((last, item) => !last || (time(item.endedAt || item.at) ?? 0) >= (time(last.endedAt || last.at) ?? 0) ? item : last, null);
    if (!e) return null;
    const text = e.kind === 'tool' ? e.toolKind === 'cmd' ? displayCommand(e.input?.command || e.detail || e.name || '').split('\n')[0] : `${e.name || ''} ${e.detail || ''}` : e.kind === 'prompt' ? e.prompt.title || '사용자 응답 기다리는 중' : e.text;
    return { text: String(text || '').replace(/\s+/g, ' ').slice(0, 160), mono: e.toolKind === 'cmd', at: e.endedAt || e.at };
  }
  /**
   * 생각 글을 제목·본문 조각으로 나눈다.
   * Codex 생각 요약은 "**제목**\n\n본문" 또는 제목만 여러 줄, Claude 생각은 제목 없는 글이다.
   */
  function parseThought(text) {
    const parts = [];
    for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
      const line = raw.trim(), last = parts[parts.length - 1];
      if (!line) { if (last) last.lines.push(''); continue; }
      const titles = /^(?:\*\*[^*]+\*\*\s*)+$/.test(line) ? [...line.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]) : /^#{1,6}\s+\S/.test(line) ? [line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '')] : null;
      if (titles) { for (const title of titles) if (title.trim()) parts.push({ title: title.trim().replace(/[.。]+$/, ''), lines: [] }); continue; }
      if (last) last.lines.push(line); else parts.push({ title: '', lines: [line] });
    }
    return parts.map((p) => ({ title: p.title, body: p.lines.join('\n').trim().replace(/\n{3,}/g, '\n\n') })).filter((p) => p.title || p.body);
  }
  /** 중간 설명 글. 계획 결과처럼 JSON 으로 끝난 답은 summary 만 남긴다 */
  function narration(text) {
    const s = String(text || '').trim();
    if (!/^\{\s*"/.test(s)) return s;
    try { const o = JSON.parse(s); return typeof o?.summary === 'string' ? o.summary.trim() : ''; } catch { return ''; }
  }
  // 도구를 쓰는 동안 보여 줄 말 (명령·코드 원문 대신)
  const ACTIVITY = { cmd: '명령 실행 중', edit: '파일 고치는 중', read: '파일 읽는 중', search: '찾아보는 중', web: '웹에서 찾아보는 중', mcp: '도구 쓰는 중', agent: '보조 AI가 일하는 중', ask: '질문 준비 중', plan: '계획 정리 중', other: '도구 쓰는 중' };
  /**
   * 생각만 보기: 생각(thinking)과 중간 설명(message)만 남기고 명령·수정·읽기 기록은 뺀다.
   * 이어진 생각 조각은 한 덩어리로 합친다. 오류·사용자 수정 지시·승인 요청은 그대로 둔다.
   */
  function thoughts(items) {
    const out = [];
    for (const e of items) {
      if (e.kind === 'thinking') {
        const parts = parseThought(e.thought ?? e.text); if (!parts.length) continue;
        const last = out[out.length - 1];
        if (last?.kind === 'thought') { last.parts.push(...parts); last.endedAt = e.at; }
        else out.push({ kind: 'thought', id: `${e.id}#th`, at: e.at, endedAt: e.at, parts });
      } else if (e.kind === 'message') {
        const text = narration(e.text); if (text) out.push({ kind: 'say', id: e.id, at: e.at, text });
      } else if (['error', 'intercept', 'prompt'].includes(e.kind)) out.push(e);
    }
    return out;
  }
  /** 지금 무엇을 생각하는지: 마지막 생각·설명 글과, 도구를 쓰는 중이면 그 종류 */
  function thoughtPreview(items) {
    const latest = (list) => list.reduce((last, item) => !last || (time(item.endedAt || item.at) ?? 0) >= (time(last.endedAt || last.at) ?? 0) ? item : last, null);
    const said = latest(items.filter((e) => e.kind === 'thinking' || e.kind === 'message' && narration(e.text)));
    const now = latest(items.filter((e) => ['thinking', 'message', 'tool', 'prompt'].includes(e.kind)));
    if (!now) return null;
    let text = '';
    if (said?.kind === 'thinking') { const p = parseThought(said.thought ?? said.text).at(-1); text = p ? p.title || p.body : ''; }
    else if (said) text = narration(said.text);
    const activity = now.kind === 'tool' && (!now.status || now.status === 'running') ? ACTIVITY[now.toolKind] || ACTIVITY.other : now.kind === 'prompt' && now.prompt?.status === 'pending' ? '답을 기다리는 중' : '';
    return { text: String(text || '').replace(/\s+/g, ' ').slice(0, 160), activity, mono: false, at: now.endedAt || now.at };
  }
  function build(job, logs, prompts = []) {
    const get = (key) => typeof logs?.get === 'function' ? logs.get(key) || [] : logs?.[key] || [];
    const requests = prompts.filter((p) => p.jobId === job.id);
    const sections = [];
    const append = (task, taskId, own) => {
      const key = `${job.id}/${taskId}`;
      // 최종 결과와 같은 마지막 설명은 보고와 겹치므로 추론 과정에서 뺀다
      const result = String(task.resultText || '').trim();
      const items = itemsFor(get(key), own, key).filter((e) => !(result && e.kind === 'message' && String(e.text || '').trim() === result));
      const flow = thoughts(items);
      sections.push({ ...task, key, taskId, items, rows: groupItems(items, key), thoughts: flow, counts: { ...counts(items), thoughts: flow.filter((b) => b.kind === 'thought' || b.kind === 'say').length }, preview: preview(items), thinkPreview: thoughtPreview(items), waiting: !!task.waiting || own.some((p) => p.status === 'pending'), startedAt: task.startedAt || items[0]?.at || job.startedAt || job.createdAt });
    };
    if (job.mode === 'auto' && (get(`${job.id}/plan`).length || requests.some((p) => !p.taskId || p.taskId === 'plan'))) append({ title: '계획', assignee: job.planner, status: job.status === 'planning' ? 'running' : job.tasks?.length ? 'done' : job.status, startedAt: job.startedAt, finishedAt: job.tasks?.[0]?.startedAt || job.finishedAt }, 'plan', requests.filter((p) => !p.taskId || p.taskId === 'plan'));
    for (const t of job.tasks || []) append(t, t.id, requests.filter((p) => p.taskId === t.id));
    const total = sections.reduce((sum, s) => { for (const k of Object.keys(sum)) sum[k] += s.counts[k]; return sum; }, { ...counts([]), thoughts: 0 });
    const pending = requests.find((p) => p.status === 'pending');
    const latest = sections.filter((s) => s.preview).reduce((last, s) => !last || (time(s.preview.at) ?? 0) >= (time(last.at) ?? 0) ? { ...s.preview, assignee: s.assignee } : last, null);
    const thinkLatest = sections.filter((s) => s.thinkPreview).reduce((last, s) => !last || (time(s.thinkPreview.at) ?? 0) >= (time(last.at) ?? 0) ? { ...s.thinkPreview, assignee: s.assignee } : last, null);
    const waiting = !!pending || !!job.waiting || sections.some((s) => s.waiting);
    return { sections, counts: total, pending, waiting, preview: latest, thinkPreview: thinkLatest, multi: sections.length > 1, visible: sections.some((s) => s.items.length) || active(job.status), status: waiting ? 'waiting' : active(job.status) ? 'running' : ['cancelled', 'interrupted'].includes(job.status) ? 'stopped' : job.status };
  }
  return { active, terminal, toolKind, seconds, elapsed, offset, displayCommand, thinkingTitle, parseThought, narration, thoughts, thoughtPreview, exitCode, missingResult, mergeCalls, itemsFor, counts, groupItems, preview, build };
});
