// 기억 정리: 세션 결정 노트 · 장기 기억(공유 메모리) · 요청 안 공용 메모판
// - 세션 결정 노트: 요청이 끝날 때마다 그 시점의 노트 전체를 job.sessionNotes 에 남긴다(갈래 세션은 갈라진 시점의 노트를 이어받는다).
//   다음 요청은 이 노트를 잘리지 않게 통째로 받고, 오래된 보고서는 노트로 대신한다(session-tools.historyContext).
// - 장기 기억: 보고 뒤 한 번의 정리 호출이 제안한 생성·갱신·삭제를 허브가 공유 메모리 규칙대로 적용하고 되돌리기 기록을 남긴다.
//   고칠 수 있는 것은 정리 담당이 본문을 끝까지 본 메모리뿐이다(보지 않은 파일을 덮어쓰지 않게). 삭제는 휴지통 폴더로 옮긴다.
// - 공용 메모판: 작업자마다 runs/<작업>/notes/<작업ID>.md 에만 쓰고 서로의 파일을 읽는다(동시에 써도 덮어쓰지 않게).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractJson, truncate, nowIso } from './util.mjs';
import { placeIndexLine } from './memory-blocks.mjs';

export const NOTES_MAX = 60;
const NOTE_CHARS = 300, BOARD_CHARS = 4000, BODY_MAX = 6000, OPS_MAX = 8;
const NEW_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const NAME_RE = /^[\w.-]{1,80}$/;
const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
// 자격 증명으로 보이는 내용은 노트·메모리에 저장하지 않는다
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*\S{6,}|비밀번호\s*[:=]\s*\S{4,})/i;
export const looksSecret = (s) => SECRET_RE.test(String(s || ''));
// 노트·메모리는 한국어로 (형식을 놓친 답이 다른 언어로 나온 적이 있다 — 2026-10-04)
const hasHangul = (s) => /[가-힣]/.test(String(s || ''));

/** 정리 답 형식 — Codex 는 이 스키마로 출력을 강제한다 */
export const CURATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['notes', 'memory'],
  properties: {
    notes: { type: 'object', additionalProperties: false, required: ['add', 'update', 'remove'], properties: {
      add: { type: 'array', items: { type: 'string' } },
      update: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'text'], properties: { n: { type: 'integer' }, text: { type: 'string' } } } },
      remove: { type: 'array', items: { type: 'integer' } },
    } },
    memory: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['op', 'scope', 'name', 'title', 'description', 'type', 'body', 'reason', 'block'], properties: {
      op: { type: 'string', enum: ['create', 'update', 'delete'] }, scope: { type: 'string', enum: ['project', 'global'] }, name: { type: 'string' },
      title: { type: 'string' }, description: { type: 'string' }, type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] }, body: { type: 'string' }, reason: { type: 'string' }, block: { type: 'string' },
    } } },
  },
};

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/* ---------------- 공용 메모판 ---------------- */
export const boardDir = (runDir) => path.join(runDir, 'notes');
export const boardFile = (runDir, taskId) => path.join(boardDir(runDir), `${taskId}.md`);

/** 메모판 전체 줄: [{ taskId, text }] (작업 ID 순) */
export function readBoard(runDir) {
  let names = [];
  try { names = fs.readdirSync(boardDir(runDir)).filter((n) => /^[\w-]+\.md$/.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(boardDir(runDir), n), 'utf8'); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\s*[-*]\s*/, '').replace(/^\[[\w-]+\]\s*/, '').trim();
      if (!line || line.startsWith('#') || looksSecret(line)) continue;
      out.push({ taskId: n.replace(/\.md$/, ''), text: line.slice(0, 400) });
    }
  }
  return out.slice(0, 200);
}

export function boardText(board, limit = BOARD_CHARS) {
  if (!board?.length) return '';
  const text = board.map((b) => `- [${b.taskId}] ${b.text}`).join('\n');
  return text.length > limit ? '(앞부분 생략)\n' + text.slice(-limit) : text;
}

/* ---------------- 세션 결정 노트 ---------------- */
const noteId = () => 'n' + crypto.randomBytes(4).toString('hex');
const cleanNote = (s) => oneLine(s).slice(0, NOTE_CHARS);
export const notesText = (notes) => notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n');

/** 정리 담당이 낸 번호 기준 add·update·remove 를 적용한다. 번호는 정리 직전 노트의 1부터 */
export function applyNoteOps(prev = [], ops = {}, src = null) {
  const list = prev.map((n) => ({ ...n }));
  const stats = { added: 0, updated: 0, removed: 0, dropped: 0 };
  const at = nowIso();
  for (const u of Array.isArray(ops?.update) ? ops.update : []) {
    const i = Number(u?.n) - 1, text = cleanNote(u?.text);
    if (list[i] && text && hasHangul(text) && !looksSecret(text) && text !== list[i].text) { list[i] = { ...list[i], text, src, at }; stats.updated++; }
  }
  const drop = new Set((Array.isArray(ops?.remove) ? ops.remove : []).map((n) => Number(n) - 1).filter((i) => Number.isInteger(i) && list[i]));
  stats.removed = drop.size;
  const kept = list.filter((_, i) => !drop.has(i));
  for (const t of Array.isArray(ops?.add) ? ops.add : []) {
    const text = cleanNote(t);
    if (text && hasHangul(text) && !looksSecret(text) && !kept.some((n) => n.text === text)) { kept.push({ id: noteId(), text, src, at }); stats.added++; }
  }
  stats.dropped = Math.max(0, kept.length - NOTES_MAX);
  return { notes: kept.slice(stats.dropped), stats };
}

/** 사용자가 고친 노트 목록 검사: [{ id?, text }] → 정리된 목록 */
export function normalizeNotes(list) {
  if (!Array.isArray(list)) throw httpErr(400, 'notes 는 배열이어야 해요');
  const out = [], at = nowIso();
  for (const n of list.slice(0, NOTES_MAX)) {
    const text = cleanNote(typeof n === 'string' ? n : n?.text);
    if (!text) continue;
    if (looksSecret(text)) throw httpErr(400, '비밀 정보로 보이는 내용은 노트에 넣을 수 없어요');
    out.push({ id: typeof n?.id === 'string' && /^n[0-9a-f]{8}$/.test(n.id) ? n.id : noteId(), text, src: n?.src || 'user', at: n?.at || at });
  }
  return out;
}

/* ---------------- 정리 지시문 · 결과 해석 ---------------- */
export function buildCuratePrompt({ job, notes = [], board = [], memoryText = '', editable = [], instruction = '', blocks = [], save = 'shared' }) {
  const results = (job.tasks || []).map((t) => `### ${t.id} · ${t.title} (${t.assignee}, ${t.status})\n${truncate(t.resultText || t.error || '(결과 없음)', 3000)}`).join('\n\n');
  return `당신은 AI 작업 허브(ODDIN)의 기억 정리 담당입니다. 방금 끝난 요청을 보고 ① 세션 결정 노트와 ② 장기 기억을 정리해 JSON 하나로만 답하세요.
파일을 만들거나 고치지 마세요(허브가 적용합니다). 도구도 쓰지 말고 아래 자료만 보고 판단하세요.

# ① 세션 결정 노트
같은 세션(대화)의 다음 요청부터 작업자들이 이 노트를 빠짐없이 받습니다. 오래된 보고서는 잘려도 이 노트는 남습니다.
- 넣을 것: 사용자가 정한 방향·선호, 확정된 결정(이름·구조·경로·형식·도구), 알아낸 사실(원인·제약), 바뀐 약속.
- 넣지 말 것: 진행 로그, 일회성 수치, 다시 쓸 일 없는 세부, 코드에 그대로 있어 읽으면 아는 내용.
- 한 번의 요청을 "앞으로 모든 …"·"항상 …" 같은 규칙으로 부풀리지 마세요. 사용자가 그 말(앞으로·항상·매번·계속)로 직접 정했을 때만 규칙으로 적고, 아니면 "이번 요청에서 …했다"로 적거나 넣지 마세요. 부풀린 규칙은 다음 요청마다 작업자가 따라 하느라 일이 몇 배로 늘어납니다(2026-10-05: "원격에도 보이게 해줘" 한 번이 "모든 시안 보고에 원격 검토 페이지" 규칙이 되어 시안마다 검토 페이지·원격 확인 스크립트를 새로 만들었다).
- 한 항목 = 한 문장(200자 이내)에 왜 그렇게 정했는지 짧게 붙이세요.
- 기존 노트와 어긋나면 update 로 고치고, 더 맞지 않으면 remove. 전체 40개 이하(넘으면 비슷한 것을 update 로 합치고 나머지는 remove).
- 바뀐 것이 없으면 빈 배열.

# ② 장기 기억 (공유 메모리: 다른 세션·다른 날·Claude/Codex 모두가 봄)
- 다른 세션에서도 쓸모 있는 것만: 사용자 선호·작업 피드백, 프로젝트의 확정 결정·위치·운영 방법, 외부 자료 위치.
- 저장 금지: 코드·git 기록·지침 파일에 이미 있는 것, 이번 요청에서만 필요한 것, 자격 증명·토큰·비밀번호·개인 정보.
- 같은 주제의 메모리가 이미 있으면 새로 만들지 말고 update. update·delete 는 아래 '고칠 수 있는 메모리'에 있는 것만 가능하고, update 의 body 는 기존 본문을 바탕으로 고친 전체 본문입니다(frontmatter 제외).
- scope: 이 프로젝트에만 해당하면 "project", 모든 프로젝트 공통(사용자 선호 등)이면 "global".
- block: scope 가 global 이면 아래 '전역 블록' 중 주제가 맞는 하나를 그대로 쓰세요(맞는 게 없으면 "미분류"). project 면 빈 문자열.${save === 'local' ? '\n- 이 세션은 새 기억을 "이 PC만"에 저장하도록 정해져 있습니다(다른 PC와 맞추지 않음).' : ''}
- name: 영어 소문자·숫자·하이픈(kebab-case)이며 파일 이름이 됩니다. type: user | feedback | project | reference.
- feedback·project 는 body 끝에 "**Why:** …" 줄과 "**How to apply:** …" 줄을 쓰세요. 관련 메모리는 [[이름]]으로 링크하세요. 날짜는 절대 날짜로.
- 대부분의 요청은 장기 기억이 없습니다. 확실할 때만 넣고, 없으면 빈 배열.
- 모든 글은 한국어로.

# 이번 요청
- 세션 폴더: ${job.cwd}
- 요청:
${job.goal}
${instruction ? `\n${instruction}\n` : ''}
# 작업 결과
${results || '(없음)'}

# 최종 보고
${truncate(job.report || '(없음)', 6000)}

# 공용 메모판 (작업자들이 남긴 결정)
${boardText(board) || '(없음)'}

# 기존 세션 결정 노트 (번호)
${notes.length ? notesText(notes) : '(없음)'}

# 고칠 수 있는 메모리 (update·delete 대상 — scope/name)
${editable.length ? editable.map((e) => `- ${e.scope}/${e.name}`).join('\n') : '(없음 — create 만 가능)'}

# 전역 블록
${blocks.length ? blocks.map((b) => `- ${b}`).join('\n') : '- 미분류'}

# 기존 메모리 (인덱스·관련 본문)
${memoryText || '(없음)'}

# 답 형식 (이 JSON 하나만)
{"notes":{"add":["새 항목"],"update":[{"n":3,"text":"고친 항목"}],"remove":[5]},"memory":[{"op":"create","scope":"project","name":"kebab-name","title":"짧은 제목","description":"한 줄 요약(나중에 관련성 판단에 씀)","type":"project","body":"본문","block":"","reason":"저장하는 이유"}]}`;
}

export function parseCuration(text) {
  const j = extractJson(text);
  if (!j || typeof j !== 'object') throw new Error('정리 결과(JSON)를 읽지 못했어요');
  return { notes: j.notes && typeof j.notes === 'object' ? j.notes : {}, memory: Array.isArray(j.memory) ? j.memory.slice(0, OPS_MAX) : [] };
}

/* ---------------- 장기 기억 적용 · 되돌리기 ---------------- */
const memRoot = (hubDir) => path.join(hubDir, 'memory');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function memoryDir(hubDir, scope, slug, root = 'shared') {
  const base = root === 'local' ? path.join(hubDir, 'memory-local') : memRoot(hubDir);
  if (scope === 'global') return path.join(base, 'global');
  return slug && /^[A-Za-z0-9_.-]+$/.test(slug) && !['.', '..'].includes(slug) ? path.join(base, 'projects', slug) : null;
}

/** 정리 담당이 본문을 끝까지 본 메모리(전역·이 프로젝트)만 고칠 수 있다 */
export function editableFrom(hubDir, slug, manifest) {
  const g = memoryDir(hubDir, 'global'), p = memoryDir(hubDir, 'project', slug);
  const out = [];
  for (const s of manifest?.selected || []) {
    if (s.partial || !s.file) continue;
    const dir = path.dirname(s.file), name = path.basename(s.file).replace(/\.md$/i, '');
    if (name === 'MEMORY' || !NAME_RE.test(name)) continue;
    if (same(dir, g)) out.push({ scope: 'global', name, file: path.resolve(s.file) });
    else if (p && same(dir, p)) out.push({ scope: 'project', name, file: path.resolve(s.file) });
  }
  return out;
}

const frontmatter = ({ name, description, type }) => `---\nname: ${name}\ndescription: ${oneLine(description)}\nmetadata:\n  type: ${type}\n---\n\n`;

/** 인덱스에서 name 줄과 그 위치 */
function indexLineOf(index, name) {
  let text = '';
  try { text = fs.readFileSync(index, 'utf8'); } catch { return { line: null, at: -1 }; }
  const lines = text.split(/\r?\n/), at = lines.findIndex((l) => l.includes(`](${name}.md)`));
  return { line: at >= 0 ? lines[at] : null, at };
}

/** 인덱스(MEMORY.md)에서 name 줄을 바꾸거나(line) 지운다(null). 새 줄은 pos 자리(없으면 끝)에. 없던 인덱스는 새로 만든다 */
export function setIndexLine(index, name, line, title = '프로젝트 메모리', pos = -1) {
  let text;
  try { text = fs.readFileSync(index, 'utf8'); }
  catch {
    if (!line) return;
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, `# ${title}\n\n${line}\n`);
    return;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes(`](${name}.md)`));
  if (at >= 0) { if (line) lines[at] = line; else lines.splice(at, 1); }
  else if (line && pos >= 0 && pos <= lines.length) lines.splice(pos, 0, line);
  else if (line) { while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') lines.pop(); if (lines[lines.length - 1] === '') lines.pop(); lines.push(line, ''); }
  else return;
  fs.writeFileSync(index, lines.join(eol));
}

/**
 * 정리 결과의 memory 동작을 적용한다. 돌려주는 값: [{ op, scope, name, title, reason, status: 'applied'|'skipped', why?, file? }]
 * 적용한 것이 있으면 undoDir/memory-undo.json 에 되돌리기 기록(파일 원본·인덱스 줄)을 남긴다.
 */
export function applyMemoryOps({ hubDir, slug, ops = [], editable = [], jobId, undoDir, root = 'shared' }) {
  const results = [], files = new Map(), lines = [];
  for (const raw of ops) {
    const op = String(raw?.op || '').toLowerCase(), scope = raw?.scope === 'global' ? 'global' : 'project';
    const name = oneLine(raw?.name).replace(/\.md$/i, '');
    const r = { op, scope, name, title: oneLine(raw?.title || name).slice(0, 80), reason: oneLine(raw?.reason).slice(0, 200), status: 'skipped' };
    results.push(r);
    // 새 메모리는 세션이 정한 곳(공유·이 PC만)에, 고치기·지우기는 정리 담당이 본 공유 메모리에
    const dir = memoryDir(hubDir, scope, slug, op === 'create' ? root : 'shared');
    if (!dir) { r.why = '이 폴더의 프로젝트 메모리 위치를 몰라요'; continue; }
    if (op === 'create' && root === 'local') r.local = true;
    if (!['create', 'update', 'delete'].includes(op)) { r.why = '알 수 없는 동작'; continue; }
    if (!NAME_RE.test(name) || (op === 'create' && !NEW_NAME_RE.test(name))) { r.why = '이름은 영어 소문자·숫자·하이픈만 쓸 수 있어요'; continue; }
    const file = path.join(dir, `${name}.md`);
    const seen = editable.some((e) => e.scope === scope && e.name === name);
    if (op !== 'create' && !seen) { r.why = '본문을 끝까지 보지 못한 메모리라 고치지 않았어요'; continue; }
    if (op === 'create' && fs.existsSync(file) && !seen) { r.why = '같은 이름의 메모리가 이미 있어요(본문을 못 봐서 덮어쓰지 않음)'; continue; }
    if (op === 'delete' && !fs.existsSync(file)) { r.why = '이미 없는 메모리예요'; continue; }
    const body = String(raw?.body ?? '').trim(), description = oneLine(raw?.description);
    const type = TYPES.has(raw?.type) ? raw.type : 'project';
    if (op !== 'delete') {
      if (!body || !description) { r.why = '본문이나 요약이 비어 있어요'; continue; }
      if (body.length > BODY_MAX) { r.why = `본문이 너무 길어요(${BODY_MAX}자 넘음)`; continue; }
      if (looksSecret(body) || looksSecret(description)) { r.why = '비밀 정보로 보이는 내용이 있어 저장하지 않았어요'; continue; }
      if (!hasHangul(body) || !hasHangul(description)) { r.why = '한국어가 아니라 저장하지 않았어요'; continue; }
    }
    const index = path.join(dir, 'MEMORY.md');
    if (!files.has(file)) files.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
    const was = indexLineOf(index, name);
    lines.push({ index, name, before: was.line, at: was.at, title: scope === 'global' ? '공용 메모리 (전역)' : `프로젝트 메모리 (${slug})` });
    fs.mkdirSync(dir, { recursive: true });
    if (op === 'delete') {
      const trash = path.join(hubDir, 'backups', 'memory-trash', String(jobId || 'unknown'));
      fs.mkdirSync(trash, { recursive: true });
      fs.copyFileSync(file, path.join(trash, `${scope}__${name}.md`));
      fs.rmSync(file);
      setIndexLine(index, name, null);
    } else {
      fs.writeFileSync(file, frontmatter({ name, description, type }) + body + '\n');
      const line = `- [${r.title}](${name}.md) — ${description}`;
      // 새 전역 메모리는 정리 담당이 고른 블록에(없으면 미분류) — 블록은 목록의 "## 제목"
      if (op === 'create' && scope === 'global') { placeIndexLine(index, line, oneLine(raw?.block) || '미분류', r.local ? 'local' : 'shared'); r.block = oneLine(raw?.block) || '미분류'; }
      else setIndexLine(index, name, line, lines[lines.length - 1].title);
    }
    r.status = 'applied'; r.file = file;
  }
  if (undoDir && results.some((r) => r.status === 'applied')) {
    const record = { jobId, at: nowIso(),
      files: [...files].map(([file, before]) => ({ file, before, after: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null })),
      // 같은 이름이 여러 번 나오면 처음 상태가 원본이다
      lines: lines.filter((l, i) => lines.findIndex((x) => x.index === l.index && x.name === l.name) === i),
    };
    fs.mkdirSync(undoDir, { recursive: true });
    fs.writeFileSync(path.join(undoDir, 'memory-undo.json'), JSON.stringify(record, null, 2));
  }
  return results;
}

/** 되돌리기: 그 뒤에 다른 곳에서 바뀐 메모리 파일은 건드리지 않는다(conflict). 인덱스는 줄 단위로 되돌린다 */
export function undoMemory(undoDir) {
  const f = path.join(undoDir, 'memory-undo.json');
  let rec;
  try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw httpErr(404, '되돌릴 기억 기록이 없어요'); }
  if (rec.undoneAt) throw httpErr(409, '이미 되돌렸어요');
  const out = [];
  for (const x of rec.files || []) {
    const now = fs.existsSync(x.file) ? fs.readFileSync(x.file, 'utf8') : null;
    if (now !== x.after) { out.push({ file: x.file, status: 'conflict' }); continue; }
    if (x.before == null) fs.rmSync(x.file, { force: true });
    else { fs.mkdirSync(path.dirname(x.file), { recursive: true }); fs.writeFileSync(x.file, x.before); }
    out.push({ file: x.file, status: 'restored' });
  }
  for (const l of rec.lines || []) {
    const kept = out.find((o) => path.basename(o.file) === `${l.name}.md` && same(path.dirname(o.file), path.dirname(l.index)));
    if (kept?.status === 'conflict') continue;
    setIndexLine(l.index, l.name, l.before, l.title, l.at);
  }
  rec.undoneAt = nowIso(); rec.undo = out;
  fs.writeFileSync(f, JSON.stringify(rec, null, 2));
  return out;
}
