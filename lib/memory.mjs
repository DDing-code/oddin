// 공유 메모리(~/.ai-shared/memory) 읽기 전용 접근 + 허브 보드 기록
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readText, appendLine } from './util.mjs';
const require = createRequire(import.meta.url);

export function memoryBundle(hubDir, { cwd, query = '', limit = 24000, projectSlugs, maxFileChars, maxFiles, skipGlobalIndex, blocks, delivered } = {}) {
  try { return require(path.join(hubDir, 'sync', 'memory-context.cjs')).buildMemoryContext({ hubDir, cwd, query, limit, projectSlugs, ...(blocks ? { blocks } : {}), ...(maxFileChars ? { maxFileChars } : {}), ...(maxFiles ? { maxFiles } : {}), ...(skipGlobalIndex ? { skipGlobalIndex: true } : {}), ...(delivered ? { delivered } : {}) }); }
  catch (e) {
    return { text: `공유 메모리 확인 실패 [${e.code || 'ERROR'}]: ${e.message}\n직접 조회: ${path.join(hubDir, 'memory')}`,
      manifest: { checkedAt: new Date().toISOString(), diagnostics: [{ code: e.code || 'ERROR', message: e.message }], selected: [], indexes: [], omitted: [] } };
  }
}

export function memoryRoots(hubDir) {
  return { global: path.join(hubDir, 'memory', 'global'), projects: path.join(hubDir, 'memory', 'projects') };
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^\s*(name|description|type):\s*(.+)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  return meta;
}

function listMd(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch (e) { if (e.code === 'ENOENT') return []; throw new Error(`메모리 목록 읽기 실패 [${e.code || 'ERROR'}]: ${dir}`); }
  return names.map((name) => {
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const fm = parseFrontmatter(text);
    return { name, size: st.size, mtime: st.mtime.toISOString(), title: fm.name || name.replace(/\.md$/, ''), description: fm.description || '', type: fm.type || (name === 'MEMORY.md' ? 'index' : '') };
  }).sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : b.mtime.localeCompare(a.mtime)));
}

export function memoryOverview(hubDir) {
  const { global, projects } = memoryRoots(hubDir);
  const index = readText(path.join(projects, 'INDEX.md'), '') || '';
  const pathOf = {};
  for (const line of index.split(/\r?\n/)) {
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length >= 4 && /^[A-Za-z]:[\\/]/.test(cells[1])) pathOf[cells[2]] = cells[1];
  }
  const projectDirs = (() => { try { return fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } })();
  const projectList = projectDirs.map((slug) => {
    const files = listMd(path.join(projects, slug));
    return { slug, path: pathOf[slug] || null, count: files.filter((f) => f.name !== 'MEMORY.md').length, latest: files[0]?.mtime || null };
  }).filter((p) => p.count > 0).sort((a, b) => (b.latest || '').localeCompare(a.latest || ''));
  return { global: listMd(global), projects: projectList };
}

export function memoryFiles(hubDir, scope) {
  const { global, projects } = memoryRoots(hubDir);
  return listMd(scope === 'global' ? global : path.join(projects, scope));
}

export function readMemoryFile(hubDir, scope, name) {
  if (!/^[\w.-]+\.md$/.test(name)) throw new Error('잘못된 파일명');
  if (!/^[\w.-]+$/.test(scope)) throw new Error('잘못된 범위');
  const { global, projects } = memoryRoots(hubDir);
  const file = scope === 'global' ? path.join(global, name) : path.join(projects, scope, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (e) { throw new Error(`메모리 읽기 실패 [${e.code || 'ERROR'}]: ${file}`); }
  return { file, text };
}

/** 플래너·워커에게 줄 메모리 요약 컨텍스트 */
export function memoryContext(hubDir, projectSlug, limit = 24000) {
  return memoryBundle(hubDir, { projectSlugs: projectSlug ? [].concat(projectSlug) : [], limit }).text;
}

// ---------- 허브 보드: 두 도구가 서로 한 일을 보는 공용 게시판 ----------
export function hubBoardDir(hubDir) { return path.join(hubDir, 'hub'); }

export function writeBoard(hubDir, job) {
  const dir = hubBoardDir(hubDir);
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  const jobFile = path.join(dir, 'jobs', `${job.id}.md`);
  const lines = [
    `# ${job.title}`,
    '',
    `- 상태: ${job.status}  · 모드: ${job.mode}  · 프로젝트: ${job.cwd}`,
    `- 시작: ${job.createdAt}  · 종료: ${job.finishedAt || '-'}`,
    `- 실행 기록: ${job.runDir}`,
    '',
    '## 목표',
    job.goal,
    '',
    '## 작업 분배',
    ...job.tasks.map((t) => `- [${t.status}] (${t.assignee}) **${t.title}**${t.dependsOn?.length ? ` ← ${t.dependsOn.join(', ')}` : ''}`),
    '',
  ];
  if (job.report) lines.push('## 결과 보고', job.report, '');
  for (const t of job.tasks) {
    if (t.resultText) lines.push(`## ${t.title} (${t.assignee}) 결과`, t.resultText, '');
  }
  fs.writeFileSync(jobFile, lines.join('\n'));

  // BOARD.md 는 최근 30건 인덱스
  const boardFile = path.join(dir, 'BOARD.md');
  const header = '# AI Hub 작업 보드\n\nClaude Code와 Codex가 대시보드(http://127.0.0.1:7700)에서 나눠 실행한 작업 기록. 상세는 `jobs/<id>.md`.\n\n| 시각 | 상태 | 제목 | 분배 | 프로젝트 |\n|---|---|---|---|---|\n';
  const existing = (readText(boardFile, '') || '').split('\n').filter((l) => l.startsWith('| 20') && !l.includes(`jobs/${job.id}.md`));
  const split = { claude: 0, codex: 0 };
  for (const t of job.tasks) if (split[t.assignee] !== undefined) split[t.assignee]++;
  const row = `| ${localStamp(job.createdAt)} | ${job.status} | [${job.title.replace(/\|/g, '/')}](jobs/${job.id}.md) | C${split.claude}/X${split.codex} | ${job.cwd} |`;
  const rows = [row, ...existing].slice(0, 30);
  fs.writeFileSync(boardFile, header + rows.join('\n') + '\n');
  appendLine(path.join(dir, 'board.log'), `${new Date().toISOString()} ${job.id} ${job.status} ${job.title}`);
}

function localStamp(iso) {
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
