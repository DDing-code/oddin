// 작업 폴더 스냅샷·비교·복원. 사용자 저장소의 인덱스·설정·참조는 사용하지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, RUNS_DIR, guardChild } from './util.mjs';

const MB = 1024 * 1024;
const OMIT = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache']);
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const at = () => new Date().toISOString();
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const missing = (e) => e.code === 'ENOENT';
const validHash = (s) => /^[a-f0-9]{40}$/.test(s || '');

function glob(pattern) {
  pattern = String(pattern).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  let s = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { i++; if (pattern[i + 1] === '/') { i++; s += '(?:.*/)?'; } else s += '.*'; }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '');
}

function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1' };
}

function command(args, { cwd, input, limit = 64 * MB } = {}) {
  return new Promise((resolve, reject) => {
    const child = guardChild(spawn('git', args, { cwd, env: gitEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
    const chunks = []; let size = 0, stderr = '', failed;
    const timer = setTimeout(() => { failed = error(503, 'CHECKPOINT_TIMEOUT', '체크포인트 처리 시간이 초과되었습니다'); child.kill(); }, 120_000);
    child.on('error', (e) => { clearTimeout(timer); reject(error(503, 'CHECKPOINT_GIT_FAILED', `체크포인트 Git을 실행하지 못했습니다 (${e.code || '실행 오류'})`)); });
    child.stdout.on('data', (b) => { size += b.length; if (size <= limit) chunks.push(b); else { failed = error(413, 'DIFF_TOO_LARGE', '비교 내용은 1MB 이하만 볼 수 있습니다'); child.kill(); } });
    child.stderr.on('data', (b) => { if (stderr.length < 4096) stderr += b.toString(); });
    child.stdin.on('error', () => {});
    child.on('close', (code) => { clearTimeout(timer); if (failed) reject(failed); else if (code) reject(Object.assign(error(503, 'CHECKPOINT_GIT_FAILED', `체크포인트 Git 처리에 실패했습니다 (종료 코드 ${code})`), { gitError: stderr })); else resolve(Buffer.concat(chunks)); });
    child.stdin.end(input);
  });
}

export class Checkpoints {
  constructor(config = {}, { dataDir = DATA_DIR, runsDir = RUNS_DIR, emit = () => {}, jobs = () => [] } = {}) {
    this.config = { enabled: true, maxFileMB: 20, maxFiles: 20_000, exclude: [], ...config.checkpoints };
    this.root = path.join(path.resolve(dataDir), 'checkpoints');
    this.internal = [path.resolve(dataDir), path.resolve(runsDir)];
    this.emit = emit; this.jobs = jobs; this.locks = new Map(); this.active = new Map(); this.finishing = new Map(); this.deleted = new Set();
  }

  async location(cwd) {
    const real = await fs.realpath(cwd);
    const key = digest(process.platform === 'win32' ? real.toLowerCase() : real);
    return { key, cwd: real, dir: path.join(this.root, `${key}.git`) };
  }

  async locked(repo, fn) {
    const prev = this.locks.get(repo.key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn); this.locks.set(repo.key, next);
    try { return await next; } finally { if (this.locks.get(repo.key) === next) this.locks.delete(repo.key); }
  }

  git(repo, args, options = {}) {
    return command([`--git-dir=${repo.dir}`, `--work-tree=${repo.cwd}`, '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', '-c', 'gc.auto=0', ...args], { cwd: repo.dir, ...options });
  }
  async repository(job) {
    if (/^[a-f0-9]{64}$/.test(job.checkpoint?.repo || '')) {
      const repo = { key: job.checkpoint.repo, dir: path.join(this.root, `${job.checkpoint.repo}.git`) };
      const meta = await this.meta(repo); if (meta.cwd) return { ...repo, cwd: meta.cwd };
    }
    return this.location(job.cwd);
  }
  async meta(repo) { try { return JSON.parse(await fs.readFile(path.join(repo.dir, 'hub.json'), 'utf8')); } catch (e) { if (!missing(e)) throw e; return { cwd: repo.cwd, jobs: {}, backups: {}, updatedAt: at() }; } }
  async save(repo, meta) {
    meta.updatedAt = at(); const f = path.join(repo.dir, 'hub.json');
    await fs.writeFile(`${f}.tmp`, JSON.stringify(meta, null, 2)); await fs.rename(`${f}.tmp`, f);
  }
  async init(repo) {
    try { await fs.access(path.join(repo.dir, 'HEAD')); }
    catch { await fs.mkdir(this.root, { recursive: true }); await command(['init', '--bare', '--template=', repo.dir], { cwd: repo.cwd }); }
    await fs.mkdir(path.join(repo.dir, 'info'), { recursive: true });
    await fs.writeFile(path.join(repo.dir, 'info', 'attributes'), '* !diff\n');
    try { await fs.access(path.join(repo.dir, 'hub.json')); }
    catch (e) { if (!missing(e)) throw e; await this.save(repo, await this.meta(repo)); }
  }

  async scan(repo) {
    const files = [], skipped = [], patterns = this.config.exclude.map(glob); let count = 0;
    const maxFiles = Math.max(1, Number(this.config.maxFiles) || 20_000), maxBytes = Math.max(0, Number(this.config.maxFileMB) || 20) * MB;
    const walk = async (dir, prefix = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const rel = prefix + e.name, full = path.join(dir, e.name), name = e.name.toLowerCase();
        if (OMIT.has(name) || name === '.env' || name.startsWith('.env.') || patterns.some((re) => re.test(rel))) continue;
        if (this.internal.some((p) => full === p || full.startsWith(p + path.sep))) continue;
        if (e.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue; }
        if (e.isDirectory()) await walk(full, rel + '/');
        else if (e.isFile()) {
          if (++count > maxFiles) throw error(413, 'CHECKPOINT_TOO_MANY_FILES', `파일이 ${maxFiles}개를 넘어 스냅샷을 건너뛰었습니다`);
          try {
            const stat = await fs.lstat(full);
            if (!stat.isFile()) { skipped.push({ path: rel, reason: 'changed_during_scan' }); continue; }
            if (stat.size > maxBytes) skipped.push({ path: rel, reason: 'large_file', bytes: stat.size });
            else files.push({ path: rel, mode: process.platform !== 'win32' && (stat.mode & 0o111) ? '100755' : '100644' });
          } catch (e) { if (missing(e)) skipped.push({ path: rel, reason: 'missing_during_scan' }); else throw e; }
        } else skipped.push({ path: rel, reason: 'special_file' });
      }
    };
    await walk(repo.cwd); return { files, skipped, count };
  }

  async snapshot(repo, ref, label) {
    const start = performance.now(), scan = await this.scan(repo);
    await this.init(repo);
    await this.git(repo, ['read-tree', '--empty']);
    // 한 번의 스트리밍 해시와 인덱스 입력으로 처리한다. 필터·속성·중첩 저장소·줄바꿈 변환을 모두 우회한다.
    if (scan.files.length) {
      const names = scan.files.map((f) => JSON.stringify(path.join(repo.cwd, f.path).replaceAll('\\', '/'))).join('\n') + '\n';
      const hashes = (await this.git(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: names })).toString().trim().split('\n');
      if (hashes.length !== scan.files.length || hashes.some((h) => !validHash(h))) throw error(503, 'CHECKPOINT_GIT_FAILED', '스냅샷 파일 해시를 확인하지 못했습니다');
      const index = scan.files.map((f, i) => `${f.mode} ${hashes[i]}\t${f.path}\0`).join('');
      await this.git(repo, ['update-index', '-z', '--index-info'], { input: index });
    }
    const tree = (await this.git(repo, ['write-tree'])).toString().trim();
    const hash = (await this.git(repo, ['-c', 'user.name=AI Hub', '-c', 'user.email=hub@localhost', 'commit-tree', tree], { input: `${label}\n` })).toString().trim();
    await this.git(repo, ['update-ref', ref, hash]);
    return { hash, ref, skipped: scan.skipped, count: scan.files.length, durationMs: Math.round(performance.now() - start), at: at() };
  }

  notify(job) { this.emit({ type: 'checkpoint', jobId: job.id, checkpoint: job.checkpoint }); }
  warn(job, e) {
    job.checkpoint ||= { before: null, after: null, files: [], skipped: [], overlaps: [] };
    job.checkpoint.status = 'warning'; job.checkpoint.warning = e.status ? e.message : '체크포인트를 저장하지 못했습니다';
    job.checkpoint.code = e.code || 'CHECKPOINT_FAILED';
    if (e.code === 'CHECKPOINT_TOO_MANY_FILES') job.checkpoint.skipped.push({ path: '', reason: 'too_many_files' });
    job.notes ||= []; job.notes.push(job.checkpoint.warning); this.notify(job);
  }
  async begin(job) {
    if (!this.config.enabled) return;
    try {
      const repo = await this.location(job.cwd);
      const cp = job.checkpoint ||= { before: null, after: null, files: [], skipped: [], overlaps: [] };
      cp.status = 'capturing'; cp.repo = repo.key; cp.startedAt = at(); cp.finishedAt = null;
      for (const [id, other] of this.active) if (other.repo.key === repo.key && id !== job.id) {
        cp.overlaps = [...new Set([...cp.overlaps, id])]; other.job.checkpoint.overlaps = [...new Set([...other.job.checkpoint.overlaps, job.id])]; this.notify(other.job);
      }
      this.active.set(job.id, { job, repo }); this.notify(job);
      await this.locked(repo, async () => {
        if (this.deleted.has(job.id)) return;
        if (!cp.before) {
          const s = await this.snapshot(repo, `refs/checkpoints/jobs/${digest(job.id)}/before`, `작업 ${job.id} 시작`);
          cp.before = s.hash; cp.skipped = s.skipped; cp.beforeDurationMs = s.durationMs;
        }
        cp.after = null; cp.files = []; cp.status = 'pending'; delete cp.warning; delete cp.code;
        const meta = await this.meta(repo); meta.jobs[job.id] = { sessionId: job.sessionId, checkpoint: cp }; await this.save(repo, meta);
        this.notify(job);
      });
    } catch (e) { this.warn(job, e); }
  }
  async end(job) {
    if (!this.config.enabled || this.deleted.has(job.id)) { this.active.delete(job.id); return; }
    if (this.finishing.has(job.id)) return this.finishing.get(job.id);
    if (!this.active.has(job.id)) return;
    const p = (async () => {
      const { repo } = this.active.get(job.id);
      try {
        await this.locked(repo, async () => {
          const cp = job.checkpoint;
          if (!cp.before || this.deleted.has(job.id)) return;
          const s = await this.snapshot(repo, `refs/checkpoints/jobs/${digest(job.id)}/after`, `작업 ${job.id} 종료`);
          cp.after = s.hash; cp.skipped = [...cp.skipped, ...s.skipped].filter((s, i, all) => all.findIndex((x) => x.path === s.path && x.reason === s.reason) === i);
          cp.afterDurationMs = s.durationMs; cp.finishedAt = at();
          cp.files = await this.files(repo, cp);
          const meta = await this.meta(repo); meta.jobs[job.id] = { sessionId: job.sessionId, checkpoint: { ...cp, status: 'ready' } }; await this.save(repo, meta);
          cp.status = 'ready'; this.active.delete(job.id);
          this.notify(job);
        });
      } catch (e) { this.warn(job, e); }
      finally { this.active.delete(job.id); }
    })();
    this.finishing.set(job.id, p);
    try { await p; } finally { this.finishing.delete(job.id); }
  }

  requireReady(cp) {
    if (!validHash(cp?.before) || !validHash(cp?.after) || cp.status !== 'ready') throw error(409, 'CHECKPOINT_NOT_READY', '비교할 체크포인트가 아직 없습니다');
  }
  async files(repo, cp) {
    const raw = (await this.git(repo, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-ext-diff', '--no-textconv', cp.before, cp.after])).toString().split('\0');
    const stats = (await this.git(repo, ['diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', cp.before, cp.after])).toString().split('\0');
    const counts = new Map();
    for (let i = 0; i < stats.length && stats[i]; i++) {
      const match = stats[i].match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/); if (!match) continue;
      let p = match[3]; if (!p) { i++; p = stats[++i]; }
      counts.set(p, { additions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]), binary: match[1] === '-' });
    }
    const excluded = (cp.skipped || []).map((x) => x.path).filter(Boolean), files = [];
    for (let i = 0; i < raw.length && raw[i]; i++) {
      const fields = raw[i].split(' '), kind = fields[4][0]; let p = raw[++i], oldPath;
      if (kind === 'R') { oldPath = p; p = raw[++i]; }
      if (excluded.some((x) => [p, oldPath].some((p) => p && (p === x || p.startsWith(x + '/'))))) continue;
      files.push({ path: p, ...(oldPath ? { oldPath } : {}), status: ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified' })[kind] || 'modified', ...(counts.get(p) || { additions: 0, deletions: 0, binary: false }) });
    }
    return files;
  }
  async changes(job) {
    const cp = job.checkpoint;
    if (!cp) return { status: 'unavailable', files: [], skipped: [], overlaps: [] };
    return { status: cp.status, files: cp.files || [], skipped: cp.skipped || [], overlaps: cp.overlaps || [], warning: cp.warning || null, before: cp.before, after: cp.after };
  }
  async sessionChanges(session, jobs, filePath) {
    const completed = jobs.filter((j) => j.checkpoint?.before || j.checkpoint?.after);
    const first = completed[0], last = completed.at(-1);
    if (!first) return { status: 'unavailable', files: [], skipped: [], overlaps: [] };
    const cp = { repo: first.checkpoint.repo, before: first.checkpoint.before, after: last.checkpoint.after, status: last.checkpoint.status, skipped: completed.flatMap((j) => j.checkpoint.skipped || []), overlaps: [...new Set(completed.flatMap((j) => j.checkpoint.overlaps || []))] };
    this.requireReady(cp); const repo = await this.repository(first);
    cp.files = await this.files(repo, cp);
    if (filePath !== undefined) return this.diff({ cwd: session.cwd, checkpoint: cp }, filePath);
    return { ...cp, firstJobId: first.id, lastJobId: last.id };
  }

  validatePath(p) {
    if (typeof p !== 'string' || !p || p.includes('\\') || p.includes('\0') || p.split('/').some((c) => !c || c === '.' || c === '..' || c.toLowerCase() === '.git' || c.includes(':')) || path.isAbsolute(p)) throw error(400, 'CHECKPOINT_PATH_INVALID', '작업 폴더 밖의 경로는 사용할 수 없습니다');
    return p;
  }
  async tree(repo, hash) {
    const out = new Map();
    for (const row of (await this.git(repo, ['ls-tree', '-r', '-z', hash])).toString().split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'), [mode, type, object] = row.slice(0, tab).split(' ');
      if (type === 'blob') out.set(row.slice(tab + 1), { mode, hash: object });
    }
    return out;
  }
  async blob(repo, entry, limit = 64 * MB) { return entry ? this.git(repo, ['cat-file', 'blob', entry.hash], { limit }) : Buffer.alloc(0); }
  async diff(job, p) {
    this.validatePath(p); const cp = job.checkpoint; this.requireReady(cp);
    const file = cp.files.find((f) => f.path === p || f.oldPath === p);
    if (!file) throw error(404, 'CHECKPOINT_FILE_NOT_FOUND', '변경된 파일이 아닙니다');
    if (file.binary) return { path: file.path, unified: '이진 파일 변경', binary: true };
    const repo = await this.repository(job), beforeTree = await this.tree(repo, cp.before), afterTree = await this.tree(repo, cp.after);
    const before = await this.blob(repo, beforeTree.get(file.oldPath || file.path), MB), after = await this.blob(repo, afterTree.get(file.path), MB);
    if (before.length + after.length > MB) throw error(413, 'DIFF_TOO_LARGE', '비교 내용은 1MB 이하만 볼 수 있습니다');
    const unified = await this.git(repo, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', cp.before, cp.after, '--', ...[file.path, file.oldPath].filter(Boolean)], { limit: MB });
    if (before.length + after.length + unified.length > MB) throw error(413, 'DIFF_TOO_LARGE', '비교 내용은 1MB 이하만 볼 수 있습니다');
    return { path: file.path, unified: unified.toString(), binary: false, before: before.toString(), after: after.toString() };
  }

  async safeTarget(repo, p) {
    this.validatePath(p); const full = path.resolve(repo.cwd, p);
    const real = await fs.realpath(repo.cwd);
    if ((process.platform === 'win32' ? real.toLowerCase() : real) !== (process.platform === 'win32' ? repo.cwd.toLowerCase() : repo.cwd)) throw error(409, 'CHECKPOINT_UNSAFE_PATH', '작업 폴더의 실제 위치가 바뀌어 복원할 수 없습니다');
    if (!full.startsWith(repo.cwd + path.sep)) throw error(400, 'CHECKPOINT_PATH_INVALID', '작업 폴더 밖의 경로는 사용할 수 없습니다');
    let current = repo.cwd;
    for (const part of p.split('/')) {
      current = path.join(current, part);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw error(409, 'CHECKPOINT_UNSAFE_PATH', '연결된 경로는 복원할 수 없습니다'); }
      catch (e) { if (!missing(e)) throw e; }
    }
    return full;
  }
  isBusy(repo) {
    return [...this.active.values()].some((x) => x.repo.key === repo.key) || this.jobs().some((j) => j.checkpoint?.repo === repo.key && (LIVE.has(j.status) || ['goal-check', 'goal-transition'].includes(j.activePhase)));
  }
  async current(repo, p) {
    const full = await this.safeTarget(repo, p);
    try {
      const stat = await fs.lstat(full); if (!stat.isFile()) return { hash: 'directory', mode: 'directory' };
      const hash = (await this.git(repo, ['hash-object', '--no-filters', '--', full])).toString().trim();
      return { hash, mode: process.platform !== 'win32' && (stat.mode & 0o111) ? '100755' : '100644' };
    } catch (e) { if (missing(e)) return null; throw e; }
  }
  async conflicts(repo, paths, expected) {
    const out = [];
    for (const p of paths) {
      const cur = await this.current(repo, p), wanted = expected.get(p);
      if (cur?.mode === 'directory') throw error(409, 'CHECKPOINT_UNSAFE_PATH', '같은 경로에 폴더가 있어 복원할 수 없습니다');
      if ((cur?.hash || null) !== (wanted?.hash || null) || (cur?.mode || null) !== (wanted?.mode || null)) out.push({ path: p, reason: 'current_changed', message: '작업 이후 이 파일이 다시 바뀌었습니다' });
    }
    return out;
  }
  async restore(repo, paths, tree) {
    // 원본은 파일별로 임시 파일에 준비한다. 폴더 전체 내용을 메모리에 올리지 않는다.
    const prepared = [];
    try {
      for (const p of paths) {
        const item = { full: await this.safeTarget(repo, p), entry: tree.get(p) }; prepared.push(item);
        if (!item.entry) continue;
        await fs.mkdir(path.dirname(item.full), { recursive: true });
        item.tmp = path.join(path.dirname(item.full), `.hub-restore-${crypto.randomUUID()}.tmp`);
        await fs.writeFile(item.tmp, await this.blob(repo, item.entry, Infinity));
        if (process.platform !== 'win32') await fs.chmod(item.tmp, item.entry.mode === '100755' ? 0o755 : 0o644);
      }
      for (const item of prepared.filter((x) => !x.entry)) await fs.rm(item.full, { force: true });
      for (const item of prepared.filter((x) => x.entry)) await fs.rename(item.tmp, item.full);
      return paths;
    } finally {
      for (const item of prepared) if (item.tmp) await fs.rm(item.tmp, { force: true });
    }
  }
  async rewind(job, body = {}) {
    if (!body || typeof body !== 'object' || (body.force !== undefined && typeof body.force !== 'boolean') || (body.paths !== undefined && (!Array.isArray(body.paths) || !body.paths.length))) throw error(400, 'CHECKPOINT_REQUEST_INVALID', '되돌릴 파일 목록과 덮어쓰기 여부를 확인하세요');
    const cp = job.checkpoint; this.requireReady(cp); const repo = await this.repository(job);
    return this.locked(repo, async () => {
      if (this.isBusy(repo)) throw error(409, 'CHECKPOINT_BUSY', '같은 폴더의 작업이 끝난 뒤 되돌리세요');
      const chosen = body.paths || cp.files.map((f) => f.path); chosen.forEach((p) => this.validatePath(p));
      const selected = cp.files.filter((f) => chosen.includes(f.path) || chosen.includes(f.oldPath));
      if (chosen.some((p) => !selected.some((f) => f.path === p || f.oldPath === p))) throw error(400, 'CHECKPOINT_FILE_NOT_FOUND', '변경된 파일만 되돌릴 수 있습니다');
      const paths = [...new Set(selected.flatMap((f) => [f.path, f.oldPath].filter(Boolean)))];
      if (!paths.length) return { restored: [], conflicts: [], backup: null };
      const before = await this.tree(repo, cp.before), after = await this.tree(repo, cp.after);
      const conflicts = await this.conflicts(repo, paths, after);
      if (conflicts.length && !body.force) return { restored: [], conflicts, backup: null };
      const id = `r-${crypto.randomUUID()}`, ref = `refs/checkpoints/rewinds/${id}`;
      const backup = await this.snapshot(repo, ref, `rewind-backup ${job.id}`), backupTree = await this.tree(repo, backup.hash);
      // 큰 파일로 바뀐 충돌 파일도 백업 없이 덮어쓰지 않는다.
      if (backup.skipped.some((s) => paths.includes(s.path))) { await this.git(repo, ['update-ref', '-d', ref]); throw error(409, 'CHECKPOINT_BACKUP_INCOMPLETE', '제외된 파일이 있어 안전하게 백업할 수 없습니다'); }
      const record = { id, kind: 'rewind-backup', jobId: job.id, sessionId: job.sessionId, hash: backup.hash, ref, paths, expected: Object.fromEntries(paths.map((p) => [p, before.get(p) || null])), status: 'prepared', createdAt: at() };
      const meta = await this.meta(repo); meta.backups[id] = record; await this.save(repo, meta);
      // 스캔 도중 외부 변경이 있으면 새 백업과 비교한다. force도 백업 뒤 변경을 덮어쓰지 않는다.
      const raced = await this.conflicts(repo, paths, backupTree);
      if (raced.length) return { restored: [], conflicts: raced, backup: id };
      const restored = await this.restore(repo, paths, before);
      record.status = 'ready'; await this.save(repo, meta);
      this.emit({ type: 'rewind', jobId: job.id, backup: id, restored, status: 'ready' });
      return { restored, conflicts: [], backup: id };
    });
  }
  async undo(id, body = {}) {
    if (!/^r-[a-f0-9-]{36}$/.test(id)) throw error(404, 'REWIND_NOT_FOUND', '되돌리기 백업이 없습니다');
    if (body.force !== undefined && typeof body.force !== 'boolean') throw error(400, 'CHECKPOINT_REQUEST_INVALID', '덮어쓰기 여부를 확인하세요');
    for (const repo of await this.repositories()) {
      const meta = await this.meta(repo); if (!meta.backups[id]) continue;
      return this.locked(repo, async () => {
        const fresh = await this.meta(repo), b = fresh.backups[id];
        if (!b) throw error(404, 'REWIND_NOT_FOUND', '되돌리기 백업이 없습니다');
        if (b.status === 'undone') return { restored: [], conflicts: [], backup: id, status: 'undone' };
        if (this.isBusy(repo)) throw error(409, 'CHECKPOINT_BUSY', '같은 폴더의 작업이 끝난 뒤 되돌리세요');
        const expected = new Map(Object.entries(b.expected).filter(([, v]) => v));
        const conflicts = await this.conflicts(repo, b.paths, expected);
        if (conflicts.length && !body.force) return { restored: [], conflicts, backup: id };
        // 취소 역시 현재 상태를 별도 백업하므로 강제 취소 뒤에도 복구 가능하다.
        const redoId = `r-${crypto.randomUUID()}`, ref = `refs/checkpoints/rewinds/${redoId}`;
        const snapshot = await this.snapshot(repo, ref, `되돌리기 취소 전 백업 ${id}`);
        if (snapshot.skipped.some((s) => b.paths.includes(s.path))) { await this.git(repo, ['update-ref', '-d', ref]); throw error(409, 'CHECKPOINT_BACKUP_INCOMPLETE', '제외된 파일이 있어 안전하게 백업할 수 없습니다'); }
        const tree = await this.tree(repo, b.hash), currentTree = await this.tree(repo, snapshot.hash);
        fresh.backups[redoId] = { id: redoId, kind: 'rewind-backup', jobId: b.jobId, sessionId: b.sessionId, hash: snapshot.hash, ref, paths: b.paths, expected: Object.fromEntries(b.paths.map((p) => [p, tree.get(p) || null])), status: 'prepared', createdAt: at() };
        await this.save(repo, fresh);
        const raced = await this.conflicts(repo, b.paths, currentTree); if (raced.length) return { restored: [], conflicts: raced, backup: redoId };
        const restored = await this.restore(repo, b.paths, tree); b.status = 'undone'; b.undoneAt = at(); fresh.backups[redoId].status = 'ready'; await this.save(repo, fresh);
        this.emit({ type: 'rewind', jobId: b.jobId, backup: id, undoBackup: redoId, restored, status: 'undone' });
        return { restored, conflicts: [], backup: id, undoBackup: redoId, status: 'undone' };
      });
    }
    throw error(404, 'REWIND_NOT_FOUND', '되돌리기 백업이 없습니다');
  }

  async repositories() {
    let entries; try { entries = await fs.readdir(this.root); } catch (e) { if (missing(e)) return []; throw e; }
    const out = [];
    for (const name of entries.filter((n) => /^[a-f0-9]{64}\.git$/.test(n))) {
      const dir = path.join(this.root, name), repo = { key: name.slice(0, -4), dir };
      const meta = await this.meta(repo); if (meta.cwd) out.push({ ...repo, cwd: meta.cwd });
    }
    return out;
  }
  async forget(job) {
    this.deleted.add(job.id);
    if (!job.checkpoint?.repo) return;
    try {
      const repo = await this.repository(job);
      await this.locked(repo, async () => {
        const meta = await this.meta(repo); delete meta.jobs[job.id];
        for (const phase of ['before', 'after']) await this.git(repo, ['update-ref', '-d', `refs/checkpoints/jobs/${digest(job.id)}/${phase}`]);
        for (const [id, b] of Object.entries(meta.backups)) if (b.jobId === job.id) { await this.git(repo, ['update-ref', '-d', b.ref]); delete meta.backups[id]; }
        await this.save(repo, meta);
      });
    } catch (e) { if (!missing(e) && job.checkpoint) this.emit({ type: 'checkpoint_cleanup', jobId: job.id, warning: '체크포인트 참조를 정리하지 못했습니다' }); }
  }
  async storage() {
    const size = async (dir) => { let n = 0; for (const e of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, e.name); if (e.isDirectory()) n += await size(full); else if (e.isFile()) n += (await fs.stat(full)).size; } return n; };
    const repositories = [];
    for (const repo of await this.repositories()) await this.locked(repo, async () => {
      const meta = await this.meta(repo);
      repositories.push({ id: repo.key, cwd: repo.cwd, bytes: await size(repo.dir), updatedAt: meta.updatedAt, jobs: Object.entries(meta.jobs).map(([jobId, j]) => ({ jobId, sessionId: j.sessionId, ...j.checkpoint })), backups: Object.values(meta.backups).map(({ expected, ...b }) => b), unused: !Object.keys(meta.jobs).length && !Object.keys(meta.backups).length });
    });
    return { bytes: repositories.reduce((n, r) => n + r.bytes, 0), repositories };
  }
  async cleanup() {
    const removed = [], compacted = [];
    for (const repo of await this.repositories()) await this.locked(repo, async () => {
      if (this.isBusy(repo)) return;
      const meta = await this.meta(repo);
      if (!Object.keys(meta.jobs).length && !Object.keys(meta.backups).length) {
        // 목록에서 검증한 해시 이름의 직계 저장소만 삭제한다.
        if (path.dirname(repo.dir) !== this.root) throw error(400, 'CHECKPOINT_PATH_INVALID', '정리할 저장소 경로가 올바르지 않습니다');
        await fs.rm(repo.dir, { recursive: true, force: true }); removed.push(repo.key);
      } else { await this.git(repo, ['gc', '--prune=now']); compacted.push(repo.key); }
    });
    return { removed, compacted, ...(await this.storage()) };
  }
}

// 서버 공용 파일에서는 이 함수 한 번으로 경로를 연결한다.
export async function checkpointRoute({ pathname, method, query, readBody, manager }) {
  try {
    const c = manager.checkpoints; let m;
    const job = (id) => { const j = manager.get(id); if (!j) throw error(404, 'JOB_NOT_FOUND', '작업이 없습니다'); return j; };
    if ((m = pathname.match(/^\/api\/jobs\/([\w-]+)\/changes(\/diff)?$/)) && method === 'GET') return { body: m[2] ? await c.diff(job(m[1]), query.get('path')) : await c.changes(job(m[1])) };
    if ((m = pathname.match(/^\/api\/sessions\/([\w-]+)\/changes(\/diff)?$/)) && method === 'GET') {
      const s = manager.sessions.get(m[1]); if (!s) throw error(404, 'SESSION_NOT_FOUND', '세션이 없습니다');
      return { body: await c.sessionChanges(s, s.jobIds.map((id) => manager.get(id)).filter(Boolean), m[2] ? query.get('path') : undefined) };
    }
    if ((m = pathname.match(/^\/api\/jobs\/([\w-]+)\/rewind$/)) && method === 'POST') return { body: await c.rewind(job(m[1]), await readBody()) };
    if ((m = pathname.match(/^\/api\/rewinds\/(r-[a-f0-9-]+)\/undo$/)) && method === 'POST') return { body: await c.undo(m[1], await readBody()) };
    if (pathname === '/api/checkpoints' && method === 'GET') return { body: await c.storage() };
    if (pathname === '/api/checkpoints/cleanup' && method === 'POST') { await readBody(); return { body: await c.cleanup() }; }
    return null;
  } catch (e) {
    if (e.status || e instanceof SyntaxError) throw e;
    throw error(500, 'CHECKPOINT_FAILED', '체크포인트를 처리하지 못했습니다');
  }
}
