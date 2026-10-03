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
      if (e.kind === 'thinking') e.text = thinkingTitle(e.text);
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
  function build(job, logs, prompts = []) {
    const get = (key) => typeof logs?.get === 'function' ? logs.get(key) || [] : logs?.[key] || [];
    const requests = prompts.filter((p) => p.jobId === job.id);
    const sections = [];
    const append = (task, taskId, own) => {
      const key = `${job.id}/${taskId}`;
      // 최종 결과와 같은 마지막 설명은 보고와 겹치므로 추론 과정에서 뺀다
      const result = String(task.resultText || '').trim();
      const items = itemsFor(get(key), own, key).filter((e) => !(result && e.kind === 'message' && String(e.text || '').trim() === result));
      sections.push({ ...task, key, taskId, items, rows: groupItems(items, key), counts: counts(items), preview: preview(items), waiting: !!task.waiting || own.some((p) => p.status === 'pending'), startedAt: task.startedAt || items[0]?.at || job.startedAt || job.createdAt });
    };
    if (job.mode === 'auto' && (get(`${job.id}/plan`).length || requests.some((p) => !p.taskId || p.taskId === 'plan'))) append({ title: '계획', assignee: job.planner, status: job.status === 'planning' ? 'running' : job.tasks?.length ? 'done' : job.status, startedAt: job.startedAt, finishedAt: job.tasks?.[0]?.startedAt || job.finishedAt }, 'plan', requests.filter((p) => !p.taskId || p.taskId === 'plan'));
    for (const t of job.tasks || []) append(t, t.id, requests.filter((p) => p.taskId === t.id));
    const total = sections.reduce((sum, s) => { for (const k of Object.keys(sum)) sum[k] += s.counts[k]; return sum; }, counts([]));
    const pending = requests.find((p) => p.status === 'pending');
    const latest = sections.filter((s) => s.preview).reduce((last, s) => !last || (time(s.preview.at) ?? 0) >= (time(last.at) ?? 0) ? { ...s.preview, assignee: s.assignee } : last, null);
    const waiting = !!pending || !!job.waiting || sections.some((s) => s.waiting);
    return { sections, counts: total, pending, waiting, preview: latest, multi: sections.length > 1, visible: sections.some((s) => s.items.length) || active(job.status), status: waiting ? 'waiting' : active(job.status) ? 'running' : ['cancelled', 'interrupted'].includes(job.status) ? 'stopped' : job.status };
  }
  return { active, terminal, toolKind, seconds, elapsed, offset, displayCommand, thinkingTitle, exitCode, missingResult, mergeCalls, itemsFor, counts, groupItems, preview, build };
});
