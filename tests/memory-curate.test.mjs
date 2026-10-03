import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyNoteOps, normalizeNotes, readBoard, boardText, boardFile, parseCuration, editableFrom, applyMemoryOps, undoMemory, buildCuratePrompt, looksSecret } from '../lib/memory-curate.mjs';
import { SessionTools } from '../lib/session-tools.mjs';
import { buildWorkerPrompt } from '../lib/planner.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memcur-'));
let serial = 0;
const fresh = () => { const d = path.join(temp, 'c' + ++serial); fs.mkdirSync(d, { recursive: true }); return d; };

test('결정 노트: 번호 기준 추가·고침·빼기, 중복·비밀 거름, 최대 개수', () => {
  const prev = [{ id: 'n00000001', text: '색은 다크 테마만' }, { id: 'n00000002', text: '폴더는 workspace' }, { id: 'n00000003', text: '옛 결정' }];
  const r = applyNoteOps(prev, { add: ['아이콘은 엮인 O', '아이콘은 엮인 O', 'password=hunter2hunter2'], update: [{ n: 2, text: '폴더는 ai-hub/workspace 고정' }, { n: 9, text: '없는 번호' }], remove: [3, 7] }, 'job1');
  assert.deepEqual(r.notes.map((n) => n.text), ['색은 다크 테마만', '폴더는 ai-hub/workspace 고정', '아이콘은 엮인 O']);
  assert.deepEqual(r.stats, { added: 1, updated: 1, removed: 1, dropped: 0 });
  assert.equal(r.notes[0].id, 'n00000001'); assert.equal(r.notes[1].src, 'job1');
  const many = applyNoteOps([], { add: Array.from({ length: 70 }, (_, i) => `결정 ${i}`) });
  assert.equal(many.notes.length, 60); assert.equal(many.stats.dropped, 10); assert.equal(many.notes[0].text, '결정 10');
  assert.equal(applyNoteOps(prev, null).notes.length, 3);
});

test('결정 노트 직접 고치기: 빈 줄 빼고 id 유지, 비밀은 거절', () => {
  const out = normalizeNotes([{ id: 'n0000000a', text: ' 하나 ' }, '둘', { text: '' }]);
  assert.deepEqual(out.map((n) => n.text), ['하나', '둘']); assert.equal(out[0].id, 'n0000000a'); assert.match(out[1].id, /^n[0-9a-f]{8}$/);
  assert.throws(() => normalizeNotes([{ text: 'api_key = sk-abcdefghijklmnopqrstuv' }]), /비밀/);
  assert.throws(() => normalizeNotes('x'), /배열/);
});

test('공용 메모판: 작업별 파일을 모아 읽고 머리말·비밀 줄은 뺀다', () => {
  const run = fresh();
  fs.mkdirSync(path.join(run, 'notes'));
  fs.writeFileSync(boardFile(run, 't2'), '# 메모\n- 함수 이름은 camelCase\n\n- [t2] 출력 폴더 out/\n');
  fs.writeFileSync(boardFile(run, 't1'), '- API 응답은 { ok, data }\n- token: ghp_abcdefghijklmnopqrstuvwx\n');
  const b = readBoard(run);
  assert.deepEqual(b, [{ taskId: 't1', text: 'API 응답은 { ok, data }' }, { taskId: 't2', text: '함수 이름은 camelCase' }, { taskId: 't2', text: '출력 폴더 out/' }]);
  assert.match(boardText(b), /^- \[t1\] API 응답은/);
  assert.deepEqual(readBoard(path.join(run, '없음')), []);
});

test('정리 결과 해석: 코드 블록 JSON, 동작 수 제한, 깨진 응답은 오류', () => {
  const r = parseCuration('정리했어요\n```json\n{"notes":{"add":["a"]},"memory":[' + Array.from({ length: 12 }, () => '{"op":"create"}').join(',') + ']}\n```');
  assert.deepEqual(r.notes, { add: ['a'] }); assert.equal(r.memory.length, 8);
  assert.throws(() => parseCuration('JSON 없음'), /읽지 못했어요/);
});

function hub() {
  const hubDir = fresh();
  const g = path.join(hubDir, 'memory', 'global'), p = path.join(hubDir, 'memory', 'projects', 'P--proj');
  fs.mkdirSync(g, { recursive: true }); fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(g, 'MEMORY.md'), '# 공용 메모리 (전역)\r\n\r\n- [사용자](user-profile.md) — 한국어\r\n');
  fs.writeFileSync(path.join(g, 'user-profile.md'), '---\nname: user-profile\n---\n한국어');
  fs.writeFileSync(path.join(p, 'MEMORY.md'), '# 프로젝트\n\n- [옛 결정](old-decision.md) — 예전\n- [긴 문서](long-doc.md) — 김\n');
  fs.writeFileSync(path.join(p, 'old-decision.md'), '---\nname: old-decision\n---\n예전 결정');
  fs.writeFileSync(path.join(p, 'long-doc.md'), '---\nname: long-doc\n---\n아주 긺');
  const manifest = { selected: [
    { file: path.join(g, 'user-profile.md') }, { file: path.join(p, 'old-decision.md') },
    { file: path.join(p, 'long-doc.md'), partial: true }, { file: path.join(hubDir, 'memory', 'projects', 'OTHER', 'x.md') },
  ] };
  return { hubDir, g, p, editable: editableFrom(hubDir, 'P--proj', manifest) };
}

test('고칠 수 있는 메모리: 끝까지 본 전역·이 프로젝트 파일만', () => {
  const { editable } = hub();
  assert.deepEqual(editable.map((e) => `${e.scope}/${e.name}`), ['global/user-profile', 'project/old-decision']);
});

test('장기 기억 적용: 생성·갱신·삭제와 인덱스, 보지 못한 파일·비밀·잘못된 이름은 건너뜀, 되돌리기', () => {
  const { hubDir, g, p, editable } = hub();
  const undoDir = path.join(fresh(), 'memory');
  const res = applyMemoryOps({ hubDir, slug: 'P--proj', editable, jobId: 'job-1', undoDir, ops: [
    { op: 'create', scope: 'project', name: 'icon-choice', title: '아이콘 선택', description: '엮인 O로 확정', type: 'project', body: '시안 B\n\n**Why:** 사용자 선택\n**How to apply:** 아이콘 원본은 build/icon.svg', reason: '확정 결정' },
    { op: 'update', scope: 'global', name: 'user-profile', title: '사용자', description: '한국어·다크 테마 선호', type: 'user', body: '한국어, 다크 테마' },
    { op: 'delete', scope: 'project', name: 'old-decision' },
    { op: 'update', scope: 'project', name: 'long-doc', description: 'x', body: 'y' },
    { op: 'create', scope: 'project', name: 'long-doc', description: 'x', body: 'y' },
    { op: 'create', scope: 'project', name: 'Bad Name', description: 'x', body: 'y' },
    { op: 'create', scope: 'project', name: 'secret-note', description: '키', body: 'API_KEY=abcdef123456' },
  ] });
  assert.deepEqual(res.map((r) => r.status), ['applied', 'applied', 'applied', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.match(res[3].why, /끝까지 보지 못한/); assert.match(res[4].why, /이미 있어요/); assert.match(res[5].why, /영어 소문자/); assert.match(res[6].why, /비밀/);
  const created = fs.readFileSync(path.join(p, 'icon-choice.md'), 'utf8');
  assert.match(created, /^---\nname: icon-choice\ndescription: 엮인 O로 확정\nmetadata:\n  type: project\n---\n\n시안 B/);
  const pIndex = fs.readFileSync(path.join(p, 'MEMORY.md'), 'utf8');
  assert.match(pIndex, /- \[아이콘 선택\]\(icon-choice\.md\) — 엮인 O로 확정/); assert.doesNotMatch(pIndex, /old-decision/);
  assert.equal(fs.existsSync(path.join(p, 'old-decision.md')), false);
  assert.equal(fs.readFileSync(path.join(hubDir, 'backups', 'memory-trash', 'job-1', 'project__old-decision.md'), 'utf8'), '---\nname: old-decision\n---\n예전 결정');
  const gIndex = fs.readFileSync(path.join(g, 'MEMORY.md'), 'utf8');
  assert.match(gIndex, /\r\n- \[사용자\]\(user-profile\.md\) — 한국어·다크 테마 선호\r\n/);
  // 그 뒤에 다른 곳에서 바뀐 파일은 되돌리지 않는다
  fs.writeFileSync(path.join(g, 'user-profile.md'), '사용자가 직접 고침');
  const undo = undoMemory(undoDir);
  assert.deepEqual(undo.map((u) => [path.basename(u.file), u.status]).sort(), [['icon-choice.md', 'restored'], ['old-decision.md', 'restored'], ['user-profile.md', 'conflict']]);
  assert.equal(fs.existsSync(path.join(p, 'icon-choice.md')), false);
  assert.equal(fs.readFileSync(path.join(p, 'old-decision.md'), 'utf8'), '---\nname: old-decision\n---\n예전 결정');
  assert.equal(fs.readFileSync(path.join(p, 'MEMORY.md'), 'utf8'), '# 프로젝트\n\n- [옛 결정](old-decision.md) — 예전\n- [긴 문서](long-doc.md) — 김\n');
  assert.equal(fs.readFileSync(path.join(g, 'user-profile.md'), 'utf8'), '사용자가 직접 고침');
  assert.match(fs.readFileSync(path.join(g, 'MEMORY.md'), 'utf8'), /한국어·다크 테마 선호/); // 충돌한 파일의 인덱스 줄도 그대로
  assert.throws(() => undoMemory(undoDir), /이미 되돌렸어요/);
  assert.throws(() => undoMemory(fresh()), /되돌릴 기억 기록이 없어요/);
});

test('장기 기억: 프로젝트 메모리 폴더가 없으면 인덱스까지 새로 만든다, 위치를 모르면 건너뜀', () => {
  const hubDir = fresh();
  const r = applyMemoryOps({ hubDir, slug: 'NEW--proj', jobId: 'j', ops: [{ op: 'create', scope: 'project', name: 'first-fact', title: '첫 사실', description: '처음', type: 'reference', body: '본문' }] });
  assert.equal(r[0].status, 'applied');
  assert.equal(fs.readFileSync(path.join(hubDir, 'memory', 'projects', 'NEW--proj', 'MEMORY.md'), 'utf8'), '# 프로젝트 메모리 (NEW--proj)\n\n- [첫 사실](first-fact.md) — 처음\n');
  const none = applyMemoryOps({ hubDir, slug: null, jobId: 'j', ops: [{ op: 'create', scope: 'project', name: 'x-y', description: 'd', body: 'b' }] });
  assert.match(none[0].why, /위치를 몰라요/);
  assert.equal(looksSecret('-----BEGIN RSA PRIVATE KEY-----'), true); assert.equal(looksSecret('토큰 수 2만 개'), false);
});

test('세션 맥락: 결정 노트는 잘리지 않고 앞에, 오래된 명령은 생략 안내, 사용자 수정이 더 새것이면 우선', () => {
  const sessions = new Map(), jobs = new Map();
  const tools = new SessionTools({ sessions, jobs, config: {} });
  const s = { id: 's1', jobIds: [] }; sessions.set('s1', s);
  for (let i = 1; i <= 6; i++) {
    const j = { id: `j${i}`, sessionId: 's1', goal: `요청 ${i}`, status: 'done', createdAt: `2026-10-0${i}T00:00:00.000Z`, report: `보고 ${i} ` + 'ㄱ'.repeat(3000) };
    if (i === 2) Object.assign(j, { sessionNotes: [{ id: 'n00000001', text: '첫 결정: 다크 테마' }], curation: { at: '2026-10-02T01:00:00.000Z' } });
    if (i === 5) Object.assign(j, { sessionNotes: [{ id: 'n00000001', text: '첫 결정: 다크 테마' }, { id: 'n00000002', text: '아이콘은 엮인 O' }], curation: { at: '2026-10-05T01:00:00.000Z' } });
    jobs.set(j.id, j); s.jobIds.push(j.id);
  }
  const next = { id: 'j7', sessionId: 's1', createdAt: '2026-10-07T00:00:00.000Z' };
  const ctx = tools.historyContext(next, 8000);
  assert.match(ctx, /^## 세션 결정 노트[^\n]*\n- 첫 결정: 다크 테마\n- 아이콘은 엮인 O\n\n## 최근 명령과 결과\n\(오래된 이전 명령 \d건은 생략 — 그때 정한 것은 위 결정 노트에 있어요\)/);
  assert.match(ctx, /### 이전 명령 6/); assert.doesNotMatch(ctx, /### 이전 명령 1 /);
  // j3 시점에는 j2 스냅샷까지만
  assert.deepEqual(tools.notesFor(s, jobs.get('j3')).map((n) => n.text), ['첫 결정: 다크 테마']);
  s.notesEdit = { at: '2026-10-06T00:00:00.000Z', notes: [{ id: 'n00000009', text: '사용자가 고친 노트' }] };
  assert.deepEqual(tools.notesFor(s).map((n) => n.text), ['사용자가 고친 노트']);
  s.notesEdit.at = '2026-10-04T00:00:00.000Z'; // j5 정리보다 오래된 수정은 j5 스냅샷이 이긴다
  assert.equal(tools.notesFor(s).length, 2);
  // 노트가 없는 세션은 예전처럼 이전 명령만
  const s2 = { id: 's2', jobIds: ['k1'] }; sessions.set('s2', s2); jobs.set('k1', { id: 'k1', sessionId: 's2', goal: '하나', status: 'done', createdAt: '2026-10-01T00:00:00.000Z', report: '끝' });
  assert.match(tools.historyContext({ id: 'k2', sessionId: 's2', createdAt: '2026-10-02T00:00:00.000Z' }), /^### 이전 명령 1/);
});

test('작업자 지시문: 공용 메모판 경로·내용, 메모리는 직접 쓰지 않고 "기억할 것"으로', () => {
  const job = { id: 'J', cwd: 'C:/p', goal: '목표', summary: '요약', intercepts: [] };
  const task = { id: 't2', title: '두 번째', assignee: 'codex', prompt: '할 일' };
  const p = buildWorkerPrompt({ job, task, depResults: [], siblings: [task], hubDir: 'C:/hub', memoryCtx: '', board: '- [t1] 이름은 camelCase', boardDir: 'C:/runs/J/notes' });
  assert.match(p, /# 공용 메모판[^\n]*\n- 내 메모: C:\/runs\/J\/notes\\t2\.md/);
  assert.match(p, /- \[t1\] 이름은 camelCase/);
  assert.match(p, /직접 고치지 마세요[^\n]*기억할 것/);
  const old = buildWorkerPrompt({ job, task, depResults: [], siblings: [task], hubDir: 'C:/hub', memoryCtx: '', curate: false });
  assert.doesNotMatch(old, /공용 메모판/); assert.match(old, /공유 메모리 규칙/);
});

test('정리 지시문: 노트 번호·고칠 수 있는 메모리·메모판·보고가 들어간다', () => {
  const p = buildCuratePrompt({ job: { cwd: 'C:/p', goal: '아이콘 바꿔', report: '엮인 O 적용', tasks: [{ id: 't1', title: '적용', assignee: 'claude', status: 'done', resultText: '기억할 것: 원본은 icon.svg' }] },
    notes: [{ text: '다크 테마' }], board: [{ taskId: 't1', text: '원본 svg 위치 build/' }], memoryText: '# 인덱스', editable: [{ scope: 'global', name: 'user-profile' }] });
  for (const re of [/1\. 다크 테마/, /- global\/user-profile/, /- \[t1\] 원본 svg 위치 build\//, /엮인 O 적용/, /기억할 것: 원본은 icon\.svg/, /"notes":\{"add"/]) assert.match(p, re);
});
