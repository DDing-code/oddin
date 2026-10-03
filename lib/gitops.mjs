// 세션의 Git 작업. 셸 문자열 없이 인자를 넘기고 외부 작업은 명시적 API에서만 실행한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';

export function sessionError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}
const options = (cwd, timeout = 15_000) => ({ cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1', GIT_OPTIONAL_LOCKS: '0' } });
function command(cwd, args, allowFailure = false) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], options(cwd));
  if (!allowFailure && (r.error || r.status !== 0)) throw sessionError(409, 'GIT_FAILED', 'Git 작업을 완료하지 못했어요. 저장소 상태와 Git 설정을 확인해 주세요');
  return { ok: !r.error && r.status === 0, text: r.stdout || '' };
}
function external(file, args, cwd, timeout = 120_000) {
  return new Promise((resolve) => execFile(file, args, options(cwd, timeout), (error, stdout) => resolve({ ok: !error, exitCode: error?.code, text: stdout || '' })));
}
const value = (cwd, args) => command(cwd, args, true).text.trim();
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const slug = (s) => String(s).normalize('NFKC').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 35) || 'session';
function changes(cwd) {
  const tokens = command(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).text.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) continue;
    const status = tokens[i].slice(0, 2), file = tokens[i].slice(3);
    files.push({ path: file, status });
    if (/[RC]/.test(status)) i++;
  }
  return files;
}
export function githubOrigin(origin) {
  const m = String(origin || '').match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null;
}
function safeOrigin(origin) {
  // 원격 주소에 사용자 정보가 들어 있어도 응답·저장에는 남기지 않는다.
  try { const u = new URL(origin); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return origin.replace(/^[^@]+@(?=[^:]+:)/, 'git@').split(/[?#]/)[0]; }
}
function inProgress(cwd) {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_START', 'sequencer'].some((name) => {
    const p = value(cwd, ['rev-parse', '--git-path', name]); return p && fs.existsSync(path.resolve(cwd, p));
  });
}
function requireClean(cwd) {
  const files = changes(cwd).map((f) => f.path);
  if (files.length) throw sessionError(409, 'GIT_DIRTY', '커밋 안 된 변경이 있어요. 먼저 커밋하거나 정리해 주세요', { files });
  if (inProgress(cwd)) throw sessionError(409, 'GIT_IN_PROGRESS', '저장소에서 진행 중인 Git 작업을 먼저 마쳐 주세요');
}
function aggregate(checks) {
  if (!checks.length) return 'none';
  if (checks.some((c) => ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'fail', 'cancel'].includes(c.conclusion))) return 'failure';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  if (checks.some((c) => !c.conclusion)) return 'pending';
  return checks.every((c) => ['success', 'neutral', 'skipped', 'pass', 'skipping'].includes(c.conclusion)) ? 'success' : 'unavailable';
}

export class GitOps {
  constructor(config = {}, { exec = external, fetch = globalThis.fetch, hasGh = () => spawnSync('gh', ['--version'], options(undefined, 3000)).status === 0 } = {}) {
    this.config = config; this.exec = exec; this.fetch = fetch; this.hasGh = hasGh; this.busy = new Set();
  }
  inspect(cwd) {
    const r = command(cwd, ['rev-parse', '--show-toplevel'], true);
    if (!r.ok) {
      // 일반 폴더와 손상된/신뢰되지 않은 저장소를 구분한다.
      for (let p = path.resolve(cwd); ; p = path.dirname(p)) {
        if (fs.existsSync(path.join(p, '.git'))) throw sessionError(409, 'GIT_UNAVAILABLE', 'Git 저장소를 읽을 수 없어요. Git 설치와 저장소 설정을 확인해 주세요');
        if (p === path.dirname(p)) break;
      }
      return null;
    }
    const repo = path.resolve(r.text.trim());
    return { repo, worktree: null, branch: value(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null, baseBranch: value(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null, baseCommit: value(cwd, ['rev-parse', '--verify', 'HEAD']) || null, isolated: false };
  }
  key(s) {
    const cwd = s.git?.repo || s.cwd;
    const p = value(cwd, ['rev-parse', '--git-common-dir']);
    return path.resolve(cwd, p || '.').toLowerCase();
  }
  assertAvailable(s) {
    if (this.busy.has(this.key(s))) throw sessionError(409, 'GIT_BUSY', '이 저장소의 Git 작업이 끝난 뒤 다시 시도해 주세요');
  }
  initialize(s, isolate = false) {
    s.git = this.inspect(s.cwd); s.archived = false; s.forkOf ||= null; s.warnings ||= [];
    if (s.git) this.assertAvailable(s);
    if (!isolate) return;
    if (!s.git) { s.warnings.push('git 저장소가 아니라 격리 없이 시작해요'); return; }
    if (!s.git.baseCommit || !s.git.baseBranch) throw sessionError(409, 'GIT_BASE_REQUIRED', '격리하려면 먼저 커밋이 있는 브랜치를 선택해 주세요');
    const repo = s.git.repo, short = `${slug(s.title)}-${s.id.slice(-8)}`;
    const worktree = path.join(path.dirname(repo), '.ai-hub-worktrees', path.basename(repo), short);
    const branch = `ai-hub/${new Date().toISOString().slice(0, 10)}-${short}`;
    const relative = path.relative(repo, s.cwd);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    command(repo, ['worktree', 'add', '-b', branch, '--', worktree, s.git.baseCommit]);
    s.git = { ...s.git, branch, worktree, isolated: true }; s.cwd = path.join(worktree, relative);
    if (!fs.existsSync(s.cwd)) {
      command(repo, ['worktree', 'remove', '--', worktree]); command(repo, ['branch', '-D', '--', branch]);
      throw sessionError(409, 'GIT_FOLDER_UNTRACKED', '선택한 폴더가 기준 커밋에 없어요. 저장소 루트에서 시작해 주세요');
    }
  }
  status(s) {
    const cwd = s.git?.worktree || s.cwd;
    if (s.git?.cleanedAt) return { available: false, reason: 'cleaned', ...s.git };
    const git = this.inspect(cwd);
    if (!git) return { available: false, reason: 'not-repository', isolated: false };
    const origin = value(cwd, ['remote', 'get-url', 'origin']);
    const base = s.git?.baseCommit || git.baseCommit;
    const counts = base ? value(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`]).split(/\s+/).map(Number) : [];
    const branchCounts = s.git?.baseBranch ? value(cwd, ['rev-list', '--left-right', '--count', `refs/heads/${s.git.baseBranch}...HEAD`]).split(/\s+/).map(Number) : [];
    const files = changes(cwd);
    return { available: true, ...git, ...s.git, branch: git.branch, head: value(cwd, ['rev-parse', '--verify', 'HEAD']) || null, origin: origin ? safeOrigin(origin) : null, github: githubOrigin(origin), files, changedFiles: files.length, ahead: counts.length === 2 ? counts[1] : null, behind: counts.length === 2 ? counts[0] : null, baseBranchAhead: branchCounts.length === 2 ? branchCounts[1] : null, baseBranchBehind: branchCounts.length === 2 ? branchCounts[0] : null, inProgress: inProgress(cwd), busy: this.busy.has(this.key(s)) };
  }
  isolated(s) {
    if (!s.git?.isolated) throw sessionError(409, 'GIT_NOT_ISOLATED', '격리 세션에서만 사용할 수 있어요');
    if (s.git.cleanedAt || !fs.existsSync(s.git.worktree)) throw sessionError(409, 'GIT_WORKTREE_REMOVED', '정리된 worktree예요. 새 갈래 세션을 만들어 주세요');
    const cwd = s.git.worktree, current = this.inspect(cwd);
    if (!current || !same(current.repo, cwd) || current.branch !== s.git.branch) throw sessionError(409, 'GIT_BRANCH_CHANGED', '세션 브랜치가 바뀌었어요. 원래 브랜치로 돌아온 뒤 시도해 주세요');
    const registered = value(s.git.repo, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`worktree ${cwd.replaceAll('\\', '/')}`);
    if (!registered) throw sessionError(409, 'GIT_WORKTREE_MISMATCH', '등록된 worktree 경로와 일치하지 않아요');
    return cwd;
  }
  async action(s, kind, body = {}) {
    this.assertAvailable(s); const key = this.key(s); this.busy.add(key);
    try {
      const cwd = this.isolated(s);
      if (kind === 'commit') return this.commit(s, cwd, body);
      if (kind === 'merge') return this.merge(s, cwd);
      if (kind === 'cleanup') return this.cleanup(s, cwd);
      if (kind === 'push') return await this.push(s, cwd);
      if (kind === 'pr') return await this.pr(s, cwd, body);
      throw sessionError(404, 'GIT_ACTION_UNKNOWN', '없는 Git 작업이에요');
    } finally { this.busy.delete(key); }
  }
  commit(s, cwd, body) {
    if (inProgress(cwd)) throw sessionError(409, 'GIT_IN_PROGRESS', '저장소에서 진행 중인 Git 작업을 먼저 마쳐 주세요');
    const files = changes(cwd);
    if (!files.length) return { committed: false, message: '커밋할 변경이 없어요' };
    if (files.some((f) => /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?)$/i.test(f.path))) throw sessionError(409, 'GIT_SENSITIVE_FILE', '환경 설정·인증 파일은 여기서 커밋할 수 없어요');
    const message = String(body.message || `${s.title} 작업 반영`).trim();
    if (!message || message.length > 4000 || message.includes('\0')) throw sessionError(400, 'GIT_COMMIT_MESSAGE', '커밋 메시지를 4000자 이내로 입력해 주세요');
    command(cwd, ['add', '-A', '--', '.']); command(cwd, ['commit', '-m', message]);
    return { committed: true, commit: value(cwd, ['rev-parse', 'HEAD']), files: files.map((f) => f.path) };
  }
  merge(s, cwd) {
    const repo = s.git.repo; requireClean(repo); requireClean(cwd);
    if (value(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== s.git.baseBranch) throw sessionError(409, 'GIT_BASE_CHANGED', '원본 저장소를 기준 브랜치로 돌린 뒤 병합해 주세요');
    const before = value(repo, ['rev-parse', 'HEAD']), head = value(cwd, ['rev-parse', 'HEAD']);
    const ff = command(repo, ['merge-base', '--is-ancestor', before, head], true).ok;
    // 자동 커밋 전에 충돌을 확인한다. fast-forward가 아니면 명시적으로 병합 커밋을 만든다.
    const merged = command(repo, ['merge', ff ? '--ff-only' : '--no-ff', '--no-edit', ...(ff ? [] : ['--no-commit']), head], true);
    if (!merged.ok) {
      const files = value(repo, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
      command(repo, ['merge', '--abort'], true);
      if (value(repo, ['rev-parse', 'HEAD']) !== before || inProgress(repo) || changes(repo).length) throw sessionError(500, 'GIT_ROLLBACK_FAILED', '병합 취소를 확인하지 못했어요. 저장소 상태를 확인해 주세요', { files });
      throw sessionError(409, files.length ? 'GIT_MERGE_CONFLICT' : 'GIT_MERGE_FAILED', files.length ? '충돌이 있어 병합을 취소했어요' : '병합하지 못해 원래 상태로 돌아왔어요', { files });
    }
    if (!ff && inProgress(repo)) {
      const committed = command(repo, ['commit', '-m', `${s.title} 병합`], true);
      if (!committed.ok) {
        const aborted = command(repo, ['merge', '--abort'], true);
        if (!aborted.ok || inProgress(repo) || value(repo, ['rev-parse', 'HEAD']) !== before || changes(repo).length) throw sessionError(500, 'GIT_ROLLBACK_FAILED', '병합 취소를 확인하지 못했어요. 저장소 상태를 확인해 주세요');
        throw sessionError(409, 'GIT_MERGE_FAILED', '병합 커밋을 만들지 못해 원래 상태로 돌아왔어요');
      }
    }
    return { merged: true, fastForward: ff, commit: value(repo, ['rev-parse', 'HEAD']), baseBranch: s.git.baseBranch };
  }
  cleanup(s, cwd) {
    requireClean(cwd); command(s.git.repo, ['worktree', 'remove', '--', cwd]);
    s.git.cleanedAt = new Date().toISOString();
    return { removed: true, branchKept: true, branch: s.git.branch };
  }
  async push(s, cwd) {
    requireClean(cwd);
    if (!value(cwd, ['remote', 'get-url', 'origin'])) throw sessionError(409, 'GIT_NO_ORIGIN', 'origin 원격이 없어요');
    const r = await this.exec('git', ['push', '--set-upstream', 'origin', `refs/heads/${s.git.branch}:refs/heads/${s.git.branch}`], cwd);
    if (!r.ok) throw sessionError(409, 'GIT_PUSH_FAILED', 'push하지 못했어요. Git 인증과 원격 상태를 확인해 주세요');
    return { pushed: true, branch: s.git.branch, commit: value(cwd, ['rev-parse', 'HEAD']) };
  }
  async pr(s, cwd, body) {
    const ghRepo = githubOrigin(value(cwd, ['remote', 'get-url', 'origin']));
    if (!ghRepo) throw sessionError(409, 'GIT_NOT_GITHUB', 'GitHub origin이 있어야 PR을 만들 수 있어요');
    const pushed = await this.push(s, cwd);
    const url = `${ghRepo.url}/compare/${encodeURIComponent(s.git.baseBranch)}...${encodeURIComponent(s.git.branch)}?expand=1`;
    if (!this.hasGh()) return { ...pushed, created: false, mode: 'compare', url };
    const r = await this.exec('gh', ['pr', 'create', '--repo', `${ghRepo.owner}/${ghRepo.repo}`, '--base', s.git.baseBranch, '--head', s.git.branch, '--title', String(body.title || s.title).slice(0, 250), '--body', String(body.body || `${s.title} 작업 반영`).slice(0, 50_000)], cwd);
    const createdUrl = r.text.trim();
    if (r.ok && new RegExp(`^${ghRepo.url.replaceAll('.', '\\.')}/pull/\\d+$`).test(createdUrl)) { s.git.prUrl = createdUrl; return { ...pushed, created: true, mode: 'gh', url: createdUrl }; }
    return { ...pushed, created: false, mode: 'compare', url, warning: 'PR을 만들지 못했어요. 비교 화면에서 이어서 만들어 주세요' };
  }
  async ci(s) {
    const status = this.status(s), ghRepo = status.github;
    if (!status.available || !ghRepo || !status.head) return { status: 'unavailable', message: 'CI 상태를 확인할 수 없어요', url: ghRepo ? `${ghRepo.url}/actions` : null, checks: [] };
    const url = `${ghRepo.url}/actions`, repo = `${ghRepo.owner}/${ghRepo.repo}`, cwd = s.git?.worktree || s.cwd;
    if (this.hasGh()) {
      try {
        const pr = await this.exec('gh', ['pr', 'view', status.branch || status.head, '--repo', repo, '--json', 'headRefOid'], cwd, 15_000);
        if (pr.ok && JSON.parse(pr.text).headRefOid === status.head) {
          const r = await this.exec('gh', ['pr', 'checks', status.branch || status.head, '--repo', repo, '--json', 'name,state,bucket,link'], cwd, 15_000);
          if (r.ok || [1, 8].includes(r.exitCode)) {
            const checks = JSON.parse(r.text).map((c) => ({ name: c.name, status: c.bucket === 'pending' ? 'in_progress' : 'completed', conclusion: c.bucket === 'pending' ? null : c.bucket, url: c.link }));
            if (checks.length) return { status: aggregate(checks), source: 'gh', sha: status.head, url, checks };
          }
        }
        const runs = await this.exec('gh', ['run', 'list', '--repo', repo, '--commit', status.head, '--limit', '50', '--json', 'name,status,conclusion,url'], cwd, 15_000);
        if (runs.ok) { const checks = JSON.parse(runs.text); return { status: aggregate(checks), source: 'gh', sha: status.head, url, checks }; }
      } catch { /* 공개 API로 다시 확인한다. */ }
    }
    try {
      const checks = [];
      for (let page = 1; page <= 10; page++) {
        const response = await this.fetch(`https://api.github.com/repos/${repo}/commits/${status.head}/check-runs?per_page=100&page=${page}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AI-Hub' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!response.ok) throw new Error('조회 실패');
        const data = await response.json();
        if (!Array.isArray(data.check_runs)) throw new Error('응답 오류');
        checks.push(...data.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })));
        if (checks.length >= data.total_count || data.check_runs.length < 100) return { status: aggregate(checks), source: 'github-public', sha: status.head, url, checks };
      }
    } catch { /* 비공개 저장소·한도·네트워크 실패는 확인 불가로 표시한다. */ }
    return { status: 'unavailable', message: 'CI 상태를 확인할 수 없어요', sha: status.head, url, checks: [] };
  }
}
