// 세션 실행 PC 옮기기 (2026-10-07 사용자 "'영상 촬영본' 세션 실행 PC를 집으로 바꿔줘 폴더는 내가 정해줄게").
// 세션은 만든 PC에서만 실행된다. 옮기기 = 원래 세션의 대화 기록(요청·결과 보고·결정 노트)을 다른 PC에 새 세션으로 가져오고,
// 그 PC에서 고른 폴더로 이어서 일하며, 원래 세션은 보관함으로 보낸다(지우지 않음, 되살릴 수 있음).
// - 가져온 기록(job.imported)은 읽기 전용이다: 실행 기록·변경 비교·첨부는 원래 PC에 남고, CLI 대화(작업자 sessionId)는 이어 쓰지 않는다
//   (다른 PC의 Codex·Claude 대화를 이 PC에서 이어 쓸 수 없으므로 다음 요청은 새 대화 + 기록 요약으로 시작한다).
// - 다른 PC 세션은 이 PC가 비춰 받은 사본(federation 캐시)에서 꺼낸다 — 그 PC가 예전 버전이어도 옮길 수 있다.
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled', 'interrupted']);
const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

/** 가져갈 작업 한 건(읽기 전용 기록): 화면·이전 대화 맥락에 필요한 것만 */
export function sanitizeJob(j) {
  return {
    id: j.id, title: j.title, goal: j.goal, input: j.input ?? null, command: j.command ?? null, agent: j.agent ?? null, mode: j.mode,
    status: TERMINAL.has(j.status) ? j.status : 'interrupted', createdAt: j.createdAt, startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? j.createdAt,
    report: j.report ?? null, error: j.error ?? null, notes: Array.isArray(j.notes) ? j.notes : [], settings: j.settings || {},
    sessionNotes: Array.isArray(j.sessionNotes) ? j.sessionNotes : undefined, curation: j.curation ? { status: j.curation.status, at: j.curation.at } : undefined,
    cwd: j.cwd, plannerPref: j.plannerPref, summary: j.summary,
    tasks: (j.tasks || []).map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, status: TERMINAL.has(t.status) || t.status === 'skipped' ? t.status : 'interrupted', result: cut(t.result, 20000) ?? null, prompt: cut(t.prompt, 4000) ?? '', model: t.model, effort: t.effort, startedAt: t.startedAt ?? null, finishedAt: t.finishedAt ?? null, reason: t.reason, dependsOn: t.dependsOn || [] })),
    intercepts: [], attachments: [],
  };
}

/** 이 PC 세션 내보내기 */
export function exportLocal(jobs, id) {
  const s = jobs.sessions.get(id);
  if (!s) throw Object.assign(new Error('세션을 찾지 못했어요'), { status: 404 });
  const list = s.jobIds.map((j) => jobs.jobs.get(j)).filter(Boolean);
  if (list.some((j) => LIVE.has(j.status))) throw Object.assign(new Error('진행 중인 작업이 끝난 뒤에 옮길 수 있어요'), { status: 409 });
  return { title: s.title, cwd: s.workdir || s.cwd, notesEdit: s.notesEdit || null, jobs: list.map(sanitizeJob) };
}

/** 다른 PC 세션(rm-) 내보내기: 이 PC가 비춰 받은 사본에서. strip = 그 PC의 원래 id 로 되돌리는 함수(federation.toRemote) */
export function exportMirrored(entry, id, strip) {
  const s = entry.sessions.get(id);
  if (!s) throw Object.assign(new Error('그 PC 세션을 찾지 못했어요(그 PC 연결을 확인해 주세요)'), { status: 404 });
  const list = [...entry.jobs.values()].filter((j) => j.sessionId === id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (list.some((j) => LIVE.has(j.status))) throw Object.assign(new Error('그 PC에서 진행 중인 작업이 끝난 뒤에 옮길 수 있어요'), { status: 409 });
  return { title: s.title, cwd: s.workdir || s.cwd, notesEdit: null, jobs: list.map((j) => sanitizeJob(strip(j))) };
}

/** 가져오기: 새 세션 + 읽기 전용 기록. from = { machine, sessionId, title } */
export function importSession(jobs, { title, cwd, from, notesEdit, jobs: list = [] }) {
  const s = jobs.createSession({ cwd, title: title || from?.title || '옮겨 온 세션' });
  const live = jobs.sessions.get(s.id);
  const at = new Date().toISOString();
  let n = 0;
  for (const raw of list) {
    if (!raw?.id || jobs.jobs.has(raw.id)) continue;
    const j = { ...sanitizeJob(raw), sessionId: live.id, runDir: null, imported: { machine: from?.machine || '', originalId: raw.id, at } };
    jobs.jobs.set(j.id, j); live.jobIds.push(j.id); n++;
  }
  live.importedFrom = { ...(from || {}), at, jobs: n };
  if (notesEdit?.notes) live.notesEdit = notesEdit;
  jobs.save(true);
  jobs.emitSession(live);
  return { ...jobs.publicSession(live), imported: n };
}
