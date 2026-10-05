// 기억 블록·공유/이 PC만·세션별 연결/해제 (lib/memory-blocks.mjs, 공용 선택기 ~/.ai-shared/sync/memory-context.cjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseIndex, renderIndex, listMemory, moveMemory, createBlock, renameBlock, deleteBlock, setBlockRoot, placeIndexLine, readBlockMemory } from '../lib/memory-blocks.mjs';
import { applyMemoryOps } from '../lib/memory-curate.mjs';
import { scanShared } from '../lib/shared-sync.mjs';

const require = createRequire(import.meta.url);
const SELECTOR = path.join(os.homedir(), '.ai-shared', 'sync', 'memory-context.cjs');
const fm = (name, description, type = 'feedback') => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n${description} 본문\n`;

function makeHub() {
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mem-blocks-'));
  const g = path.join(hub, 'memory', 'global');
  fs.mkdirSync(g, { recursive: true });
  const files = { 'user-profile.md': ['사용자 개요', '한국어 사용자', 'user'], 'feedback-korean-only.md': ['한국어로만', '한국어로만 말하기'], 'video-a.md': ['영상 편집 규칙', '자막 템포 규칙'], 'font-a.md': ['폰트 제작', '한글 폰트 글자별 설계'], 'stray.md': ['목록에 없는 것', '인덱스 밖 메모리'] };
  for (const [f, [, d, t]] of Object.entries(files)) fs.writeFileSync(path.join(g, f), fm(f.replace('.md', ''), d, t));
  fs.writeFileSync(path.join(g, 'MEMORY.md'), [
    '# 공용 메모리 (전역)', '머리말', '', '## 사용자', '- [사용자 개요](user-profile.md) — 한국어 사용자', '- [한국어로만](feedback-korean-only.md) — 한국어로만 말하기',
    '', '## 영상', '- [영상 편집 규칙](video-a.md) — 자막 템포 규칙', '', '## 폰트', '- [폰트 제작](font-a.md) — 한글 폰트 글자별 설계', '', '## 미분류', '',
  ].join('\n'));
  fs.mkdirSync(path.join(hub, 'memory', 'projects', 'C--proj'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'memory', 'projects', 'C--proj', 'p1.md'), fm('p1', '프로젝트 결정', 'project'));
  fs.writeFileSync(path.join(hub, 'memory', 'projects', 'C--proj', 'MEMORY.md'), '# 프로젝트 메모리\n- [p1](p1.md) — 프로젝트 결정\n');
  return hub;
}

test('목록 파일: 제목 하나가 블록 하나, 다시 그려도 줄이 그대로', () => {
  const text = '# 제목\n머리\n- [가](a.md) — 가\n\n## 하나\n- [나](b.md) — 나\n### 둘\n- [다](c.md) — 다\n';
  const p = parseIndex(text);
  assert.deepEqual(p.blocks.map((b) => b.name), ['하나', '둘']);
  const out = renderIndex(p);
  for (const l of ['- [가](a.md) — 가', '## 하나', '- [나](b.md) — 나', '## 둘', '- [다](c.md) — 다']) assert.ok(out.includes(l), l);
});

test('블록 목록·옮기기·이 PC만·블록 만들기·이름 바꾸기·지우기', () => {
  const hub = makeHub();
  try {
    let v = listMemory(hub);
    const ids = v.blocks.map((b) => b.id);
    assert.deepEqual(ids.slice(0, 4), ['사용자', '영상', '폰트', '미분류']);
    assert.ok(v.blocks.find((b) => b.id === '미분류').memories.some((m) => m.rel === 'global/stray.md'), '목록에 없는 파일은 미분류');
    assert.equal(v.blocks.find((b) => b.id === 'project:C--proj').memories.length, 1);

    moveMemory(hub, { root: 'shared', rel: 'global/stray.md', block: '영상' });
    v = listMemory(hub);
    assert.deepEqual(v.blocks.find((b) => b.id === '영상').memories.map((m) => m.rel), ['global/video-a.md', 'global/stray.md']);

    moveMemory(hub, { root: 'shared', rel: 'global/font-a.md', toRoot: 'local' });
    assert.ok(fs.existsSync(path.join(hub, 'memory-local', 'global', 'font-a.md')));
    assert.ok(!fs.existsSync(path.join(hub, 'memory', 'global', 'font-a.md')));
    assert.ok(!fs.readFileSync(path.join(hub, 'memory', 'global', 'MEMORY.md'), 'utf8').includes('font-a.md'));
    assert.match(fs.readFileSync(path.join(hub, 'memory-local', 'global', 'MEMORY.md'), 'utf8'), /## 폰트\n- \[폰트 제작\]\(font-a\.md\)/);
    v = listMemory(hub);
    const font = v.blocks.find((b) => b.id === '폰트');
    assert.equal(font.local, 1); assert.equal(font.shared, 0);
    assert.equal(readBlockMemory(hub, { root: 'local', rel: 'global/font-a.md' }).description, '한글 폰트 글자별 설계');

    // 프로젝트 메모리도 이 PC만으로 (목록 줄 함께)
    moveMemory(hub, { root: 'shared', rel: 'projects/C--proj/p1.md', toRoot: 'local' });
    assert.match(fs.readFileSync(path.join(hub, 'memory-local', 'projects', 'C--proj', 'MEMORY.md'), 'utf8'), /\(p1\.md\)/);
    assert.throws(() => moveMemory(hub, { root: 'local', rel: 'projects/C--proj/p1.md', block: '영상' }), /프로젝트 메모리는 블록을/);
    assert.throws(() => moveMemory(hub, { root: 'shared', rel: '../x.md' }), /메모리 경로가 아니/);

    createBlock(hub, { name: '방송' });
    assert.throws(() => createBlock(hub, { name: '방송' }), /이미 있어요/);
    renameBlock(hub, { from: '방송', to: '방송·버튜버' });
    assert.ok(listMemory(hub).blocks.some((b) => b.id === '방송·버튜버'));
    assert.throws(() => deleteBlock(hub, { name: '영상' }), /남아 있는 블록/);
    deleteBlock(hub, { name: '방송·버튜버' });
    assert.ok(!listMemory(hub).blocks.some((b) => b.id === '방송·버튜버'));

    // 블록 통째로 공유로 되돌리기
    assert.equal(setBlockRoot(hub, { id: '폰트', root: 'shared' }).moved, 1);
    assert.ok(fs.existsSync(path.join(hub, 'memory', 'global', 'font-a.md')));
    assert.match(fs.readFileSync(path.join(hub, 'memory', 'global', 'MEMORY.md'), 'utf8'), /## 폰트\n- \[폰트 제작\]/);
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('정리 담당의 새 기억: 고른 블록에, 세션이 "이 PC만"이면 memory-local 에', () => {
  const hub = makeHub();
  try {
    const op = { op: 'create', scope: 'global', name: 'new-video-rule', title: '새 영상 규칙', description: '컷은 3초 안팎', type: 'feedback', body: '컷은 3초 안팎으로 자른다.\n\n**Why:** 템포\n**How to apply:** 편집할 때', reason: '사용자 지시', block: '영상' };
    const [r] = applyMemoryOps({ hubDir: hub, slug: 'C--proj', ops: [op], editable: [], jobId: 'j1', undoDir: path.join(hub, 'undo') });
    assert.equal(r.status, 'applied'); assert.equal(r.block, '영상');
    assert.match(fs.readFileSync(path.join(hub, 'memory', 'global', 'MEMORY.md'), 'utf8'), /## 영상\n- \[영상 편집 규칙\][^\n]*\n- \[새 영상 규칙\]\(new-video-rule\.md\)/);
    const [l] = applyMemoryOps({ hubDir: hub, slug: 'C--proj', ops: [{ ...op, name: 'local-rule', title: '이 PC 규칙', block: '없는 블록' }], editable: [], jobId: 'j2', undoDir: path.join(hub, 'undo2'), root: 'local' });
    assert.equal(l.status, 'applied'); assert.equal(l.local, true);
    assert.ok(fs.existsSync(path.join(hub, 'memory-local', 'global', 'local-rule.md')));
    assert.match(fs.readFileSync(path.join(hub, 'memory-local', 'global', 'MEMORY.md'), 'utf8'), /## 없는 블록\n- \[이 PC 규칙\]/);
    // 이 PC만 메모리는 연결된 PC와 맞추는 범위 밖
    assert.ok(!Object.keys(scanShared(hub)).some((k) => k.startsWith('memory-local')));
    placeIndexLine(path.join(hub, 'memory', 'global', 'MEMORY.md'), '- [옮김](video-a.md) — 자막 템포 규칙', '폰트');
    assert.match(fs.readFileSync(path.join(hub, 'memory', 'global', 'MEMORY.md'), 'utf8'), /## 폰트\n- \[폰트 제작\][^\n]*\n- \[옮김\]\(video-a\.md\)/);
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});

test('선택기: 연결한 블록은 관련 없어도 넣고, 해제한 블록은 목록·본문에서 빼며, 이 PC만 메모리도 읽는다', { skip: !fs.existsSync(SELECTOR) && '이 PC에 공용 선택기가 없음' }, () => {
  const hub = makeHub();
  try {
    fs.mkdirSync(path.join(hub, 'sync'), { recursive: true });
    fs.copyFileSync(SELECTOR, path.join(hub, 'sync', 'memory-context.cjs'));
    moveMemory(hub, { root: 'shared', rel: 'global/stray.md', toRoot: 'local', block: '폰트' });
    const { buildMemoryContext } = require(path.join(hub, 'sync', 'memory-context.cjs'));
    const pick = (blocks) => buildMemoryContext({ hubDir: hub, cwd: os.tmpdir(), query: '영상 자막 템포', projectSlugs: ['C--proj'], blocks });
    const base = (x) => x.manifest.selected.map((s) => path.basename(s.file));
    let r = pick(null);
    assert.ok(base(r).includes('video-a.md')); assert.ok(!base(r).includes('font-a.md'), '관련 없는 블록은 자동이면 안 넣음');
    r = pick({ on: ['폰트'], off: ['영상'] });
    assert.ok(base(r).includes('font-a.md') && base(r).includes('stray.md'), '연결 블록은 공유·이 PC만 모두');
    assert.ok(!base(r).includes('video-a.md'), '해제 블록은 본문에서 빠짐');
    assert.ok(!r.text.includes('영상 편집 규칙'), '해제 블록은 목록에서도 빠짐');
    assert.ok(base(r).includes('feedback-korean-only.md'), '한국어 규칙은 늘 넣음');
    assert.match(r.text, /이 PC만 · 전역 인덱스/);
    r = pick({ off: ['project:C--proj'] });
    assert.ok(!base(r).includes('p1.md'));
  } finally { fs.rmSync(hub, { recursive: true, force: true }); }
});
