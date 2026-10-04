import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitOps, githubOrigin } from '../lib/gitops.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
let serial = 0;
function fixture(t, deps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gitops-'));
  const repo = path.join(root, '저장소 공백'), remote = path.join(root, 'remote.git'); fs.mkdirSync(repo);
  git(root, 'init', '--bare', remote); git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', '시험'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false'); // PC마다 다른 git 기본 줄바꿈 변환(Windows 기본 true)에 결과가 흔들리지 않게
  write(repo, '내용.txt', '기준\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', '기준'); git(repo, 'remote', 'add', 'origin', remote);
  const ops = new GitOps({}, { hasGh: () => false, ...deps });
  const s = { id: 's-test-' + ++serial, cwd: repo, title: '새 기능 시험' }; ops.initialize(s, true);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, remote, ops, s };
}
const error = (code) => (e) => e.code === code;

test('격리: 한글·공백 경로, 현재 커밋 기준, 원본 폴더 밖, 중복 제목', (t) => {
  const { repo, ops, s } = fixture(t);
  assert.equal(s.git.repo, repo); assert.equal(s.git.baseBranch, 'main'); assert.equal(git(s.cwd, 'rev-parse', 'HEAD'), s.git.baseCommit);
  assert(!s.cwd.startsWith(repo + path.sep)); assert.match(s.git.branch, /^ai-hub\/\d{4}-\d{2}-\d{2}-새-기능-시험-/);
  const s2 = { id: 's-other-unique', title: s.title, cwd: repo }; ops.initialize(s2, true); assert.notEqual(s.cwd, s2.cwd);
  write(repo, '원본만.txt', '보존'); assert(!fs.existsSync(path.join(s.cwd, '원본만.txt')));
  const state = ops.status(s); assert.equal(state.available, true); assert.equal(state.changedFiles, 0); assert.equal(state.ahead, 0);
});
test('일반 폴더 격리는 경고, 일반 Git 세션도 상태 조회, 빈 저장소·분리 HEAD 거절', (t) => {
  const { root, repo, ops } = fixture(t);
  const normal = { id: 's-normal', cwd: root, title: '일반' }; ops.initialize(normal, true);
  assert.equal(normal.git, null); assert.deepEqual(normal.warnings, ['git 저장소가 아니라 격리 없이 시작해요']); assert.equal(ops.status(normal).available, false);
  const plain = { id: 's-plain', cwd: repo }; ops.initialize(plain); write(repo, '한글 공백.txt', '변경');
  assert.equal(ops.status(plain).changedFiles, 1); assert.equal(plain.git.isolated, false);
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty); git(empty, 'init', '-b', 'main');
  assert.throws(() => ops.initialize({ id: 's-empty', cwd: empty }, true), error('GIT_BASE_REQUIRED'));
  git(repo, 'checkout', '--detach'); assert.throws(() => ops.initialize({ id: 's-detach', cwd: repo }, true), error('GIT_BASE_REQUIRED'));
});
test('커밋: 추가·수정·삭제·이름 변경, 인자 주입 방지, 기준 대비 앞뒤 수', async (t) => {
  const { ops, s, repo } = fixture(t);
  git(s.cwd, 'mv', '내용.txt', '이름 변경.txt'); write(s.cwd, '추가.txt', '추가');
  assert.equal(ops.status(s).changedFiles, 2);
  const result = await ops.action(s, 'commit', { message: '반영 $(잘못된명령) `그대로`' });
  assert.equal(result.committed, true); assert.equal(git(s.cwd, 'log', '-1', '--format=%s'), '반영 $(잘못된명령) `그대로`');
  assert.equal(ops.status(s).ahead, 1); assert.equal(ops.status(s).behind, 0); assert.equal(git(repo, 'rev-parse', 'HEAD'), s.git.baseCommit);
  assert.equal((await ops.action(s, 'commit')).committed, false);
  git(repo, 'commit', '--allow-empty', '-m', '원본 전진'); assert.equal(ops.status(s).baseBranchBehind, 1);
});
test('병합: fast-forward와 분기된 기준 브랜치의 병합 커밋', async (t) => {
  for (const diverged of [false, true]) {
    const { ops, s, repo } = fixture(t);
    write(s.cwd, '작업.txt', '작업'); await ops.action(s, 'commit');
    if (diverged) { write(repo, '원본.txt', '원본'); git(repo, 'add', '.'); git(repo, 'commit', '-m', '원본'); }
    const r = await ops.action(s, 'merge'); assert.equal(r.fastForward, !diverged); assert.equal(git(repo, 'status', '--porcelain'), '');
    assert(fs.existsSync(path.join(repo, '작업.txt'))); assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, diverged ? 3 : 2);
  }
});
test('병합: 원본 변경·기준 브랜치 변경은 손대지 않고 거절', async (t) => {
  const { ops, s, repo } = fixture(t);
  write(s.cwd, '작업.txt', '작업'); await ops.action(s, 'commit');
  write(repo, '내용.txt', '보존'); git(repo, 'add', '내용.txt'); const before = git(repo, 'diff', '--cached');
  await assert.rejects(ops.action(s, 'merge'), error('GIT_DIRTY')); assert.equal(git(repo, 'diff', '--cached'), before); assert.equal(fs.readFileSync(path.join(repo, '내용.txt'), 'utf8'), '보존');
  git(repo, 'restore', '--staged', '내용.txt'); git(repo, 'restore', '내용.txt'); git(repo, 'checkout', '-b', 'other');
  await assert.rejects(ops.action(s, 'merge'), error('GIT_BASE_CHANGED')); assert.equal(git(repo, 'branch', '--show-current'), 'other');
});
test('병합 충돌은 파일 목록을 반환하고 HEAD·작업 폴더·인덱스를 복구', async (t) => {
  const { ops, s, repo } = fixture(t);
  write(s.cwd, '내용.txt', '세션 수정\n'); await ops.action(s, 'commit');
  write(repo, '내용.txt', '원본 수정\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', '원본'); const before = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(ops.action(s, 'merge'), (e) => e.code === 'GIT_MERGE_CONFLICT' && e.files.includes('내용.txt'));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before); assert.equal(git(repo, 'status', '--porcelain'), ''); assert.equal(fs.readFileSync(path.join(repo, '내용.txt'), 'utf8'), '원본 수정\n');
  assert.equal(ops.status({ cwd: repo }).inProgress, false);
});
test('병합 커밋 실패도 취소하고 원본 상태 복구', async (t) => {
  const { ops, s, repo } = fixture(t);
  write(s.cwd, '작업.txt', '작업'); await ops.action(s, 'commit'); write(repo, '원본.txt', '원본'); git(repo, 'add', '.'); git(repo, 'commit', '-m', '원본');
  const before = git(repo, 'rev-parse', 'HEAD'); git(repo, 'config', 'user.email', ''); git(repo, 'config', 'user.name', '');
  await assert.rejects(ops.action(s, 'merge'), error('GIT_MERGE_FAILED')); assert.equal(git(repo, 'rev-parse', 'HEAD'), before); assert.equal(git(repo, 'status', '--porcelain'), '');
});
test('정리: 미커밋 변경 거절·브랜치 보존·정리 후 실행 거절', async (t) => {
  const { ops, s, repo } = fixture(t);
  write(s.cwd, '변경.txt', '변경'); await assert.rejects(ops.action(s, 'cleanup'), error('GIT_DIRTY')); assert(fs.existsSync(s.cwd));
  await ops.action(s, 'commit'); const branch = s.git.branch; await ops.action(s, 'cleanup');
  assert(!fs.existsSync(s.cwd)); assert(git(repo, 'show-ref', '--verify', `refs/heads/${branch}`)); assert.equal(ops.status(s).reason, 'cleaned');
  await assert.rejects(ops.action(s, 'commit'), error('GIT_WORKTREE_REMOVED'));
});
test('push는 로컬 bare 원격에서만 시험, 미커밋 변경·없는 origin 거절', async (t) => {
  const { ops, s, remote } = fixture(t);
  write(s.cwd, '작업.txt', '작업'); await assert.rejects(ops.action(s, 'push'), error('GIT_DIRTY')); await ops.action(s, 'commit');
  const r = await ops.action(s, 'push'); assert.equal(r.pushed, true); assert.equal(git(remote, 'rev-parse', `refs/heads/${s.git.branch}`), r.commit);
  git(s.cwd, 'remote', 'remove', 'origin'); await assert.rejects(ops.action(s, 'push'), error('GIT_NO_ORIGIN'));
});
test('PR: gh 없음은 push 호출 뒤 비교 주소, gh 있음은 명시적 생성, 실패는 비교 주소', async (t) => {
  const calls = [], exec = async (file, args) => { calls.push({ file, args }); return { ok: true, text: file === 'gh' ? 'https://github.com/owner/repo/pull/12\n' : '' }; };
  const { ops, s } = fixture(t, { exec }); git(s.cwd, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
  const r = await ops.action(s, 'pr'); assert.equal(r.created, false); assert.equal(r.mode, 'compare'); assert.equal(calls[0].file, 'git'); assert(r.url.includes(encodeURIComponent(s.git.branch)));
  ops.hasGh = () => true; assert.equal((await ops.action(s, 'pr')).created, true); assert.equal(calls.at(-1).args[0], 'pr');
  ops.exec = async () => ({ ok: false, text: '' }); await assert.rejects(ops.action(s, 'pr'), error('GIT_PUSH_FAILED'));
  ops.exec = async (file) => ({ ok: file === 'git', text: '' }); assert.equal((await ops.action(s, 'pr')).mode, 'compare');
});
test('GitHub 원격 판별은 정확한 호스트만, 원격 사용자 정보는 응답에서 제거', (t) => {
  for (const url of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) assert.equal(githubOrigin(url).repo, 'repo');
  for (const url of ['https://github.com.evil.invalid/o/r', 'https://user:secret@github.com/o/r', 'file:///o/r']) assert.equal(githubOrigin(url), null);
  const { ops, s } = fixture(t); git(s.cwd, 'remote', 'set-url', 'origin', 'https://user:secret@example.invalid/o/r?token=hidden'); assert.equal(ops.status(s).origin, 'https://example.invalid/o/r');
});
test('CI: 인증 없는 공개 API·페이지 처리·상태·실패시 Actions 주소', async (t) => {
  const calls = [], fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ total_count: 1, check_runs: [{ name: '검사', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/1' }] }) }; };
  const { ops, s } = fixture(t, { fetch }); git(s.cwd, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
  assert.equal((await ops.ci(s)).status, 'success'); assert.equal(calls[0].opts.headers.Authorization, undefined); assert.match(calls[0].url, /commits\/[a-f0-9]{40}\/check-runs/);
  for (const [status, conclusion, expected] of [['in_progress', null, 'pending'], ['completed', 'failure', 'failure'], ['completed', 'neutral', 'success']]) {
    ops.fetch = async () => ({ ok: true, json: async () => ({ total_count: 1, check_runs: [{ status, conclusion }] }) }); assert.equal((await ops.ci(s)).status, expected);
  }
  let page = 0; ops.fetch = async () => ({ ok: true, json: async () => ({ total_count: 101, check_runs: Array.from({ length: ++page === 1 ? 100 : 1 }, () => ({ status: 'completed', conclusion: 'success' })) }) }); assert.equal((await ops.ci(s)).checks.length, 101);
  ops.fetch = async () => ({ ok: true, json: async () => ({ total_count: 0, check_runs: [] }) }); assert.equal((await ops.ci(s)).status, 'none');
  ops.fetch = async () => ({ ok: false }); const r = await ops.ci(s); assert.equal(r.status, 'unavailable'); assert.equal(r.url, 'https://github.com/o/r/actions');
});
test('CI: gh 검사 실패 종료값과 PR 없는 경우 run list 처리', async (t) => {
  const { ops, s } = fixture(t, { hasGh: () => true });
  ops.exec = async (_, args) => args[1] === 'view' ? { ok: true, text: JSON.stringify({ headRefOid: git(s.cwd, 'rev-parse', 'HEAD') }) } : { ok: false, exitCode: 1, text: '[{"name":"검사","bucket":"fail","link":"https://github.com/o/r"}]' };
  git(s.cwd, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git'); assert.equal((await ops.ci(s)).status, 'failure');
  ops.exec = async (_, args) => args[0] === 'pr' ? { ok: false, text: '' } : { ok: true, text: '[{"name":"검사","status":"queued","conclusion":null}]' }; assert.equal((await ops.ci(s)).status, 'pending');
  const calls = []; ops.exec = async (_, args) => { calls.push(args); return args[0] === 'pr' ? { ok: true, text: '{"headRefOid":"다른 커밋"}' } : { ok: true, text: '[]' }; };
  assert.equal((await ops.ci(s)).status, 'none'); assert(!calls.some((a) => a[1] === 'checks'));
});
test('안전장치: Git 작업 중 중복 거절·브랜치 변경 거절·민감 파일 커밋 거절', async (t) => {
  let finish; const { ops, s } = fixture(t, { exec: () => new Promise((resolve) => { finish = resolve; }) });
  const pushing = ops.action(s, 'push'); await assert.rejects(ops.action(s, 'commit'), error('GIT_BUSY')); finish({ ok: true }); await pushing;
  git(s.cwd, 'checkout', '-b', 'changed'); await assert.rejects(ops.action(s, 'cleanup'), error('GIT_BRANCH_CHANGED')); git(s.cwd, 'checkout', s.git.branch);
  // 내용이 없는 시험 파일로 민감 경로 판별만 확인한다.
  write(s.cwd, 'credentials.fixture', ''); await assert.rejects(ops.action(s, 'commit'), error('GIT_SENSITIVE_FILE')); assert.equal(git(s.cwd, 'diff', '--cached', '--name-only'), '');
});
