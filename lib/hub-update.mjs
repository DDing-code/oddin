// ODDIN 업데이트 (2026-10-05 집·회사 PC 두 대를 같은 버전으로): 허브 폴더에서 GitHub(origin) 최신 버전을 fast-forward 로 받고,
// 서버 코드가 바뀌었으면 진행 중인 작업이 끝난 뒤 이 허브만 재시작한다(scripts/restart-hub.mjs --detach). 화면 파일만 바뀌면 열린 화면이 알아서 새로 읽는다.
// 커밋 안 한 추적 파일 변경이 있으면 받지 않는다(그 PC에서 고치던 것을 덮지 않게).
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const error = (status, message) => Object.assign(new Error(message), { status });
const git = async (root, args, timeout = 30_000) => (await run('git', ['-C', root, ...args], { timeout, windowsHide: true, encoding: 'utf8' })).stdout.trim();

let cached = null, started = null;
/**
 * 지금 돌고 있는 서버의 버전(서버가 켜질 때 한 번 정함). 업데이트로 디스크 파일이 바뀌어도 재시작 전까지는 그대로다.
 * (2026-10-05: 디스크 기준으로 보여 줘 재시작 전인데도 "같은 버전"으로 보였다 → pending 으로 따로 알린다)
 */
export function runningCommit(root) {
  started ||= { ...hubCommit(root) };
  const disk = hubCommit(root);
  return { ...started, pending: disk.commit && disk.commit !== started.commit ? disk.commit : '' };
}
/** 디스크(허브 폴더)의 버전(짧은 커밋·날짜). 업데이트한 뒤 다시 읽는다 */
export function hubCommit(root, refresh = false) {
  if (cached && !refresh) return cached;
  try {
    const [commit, date] = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h|%cI'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim().split('|');
    cached = { commit, date };
  } catch { cached = { commit: '', date: '' }; }
  return cached;
}

/** origin 에서 업데이트 확인: 뒤처진 수·앞선 수·커밋 안 한 변경 */
export async function checkUpdate(root) {
  try { await git(root, ['fetch', '--quiet', 'origin'], 60_000); }
  catch (e) { throw error(502, `GitHub에서 업데이트를 확인하지 못했어요: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => 'origin/main');
  const [behind, ahead, dirty] = await Promise.all([
    git(root, ['rev-list', '--count', `HEAD..${upstream}`]),
    git(root, ['rev-list', '--count', `${upstream}..HEAD`]),
    git(root, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  return { ...hubCommit(root), upstream, behind: Number(behind) || 0, ahead: Number(ahead) || 0, dirty: dirty ? dirty.split('\n').length : 0 };
}

// 재시작이 필요 없는 파일: 화면(열린 화면이 새로 읽음)·문서·시험·데스크탑 프로그램(따로 빌드)
const NO_RESTART = (f) => /^(public|docs|tests|desktop)\//.test(f) || /\.md$/i.test(f);

export async function applyUpdate(root, { restart = true } = {}) {
  const st = await checkUpdate(root);
  if (st.dirty) throw error(409, `이 PC 허브 폴더에 커밋 안 한 변경이 ${st.dirty}개 있어 업데이트하지 않았어요`);
  if (!st.behind) return { updated: false, ...st, message: '이미 최신이에요' };
  if (st.ahead) throw error(409, `이 PC에만 있는 커밋이 ${st.ahead}개 있어 자동으로 업데이트하지 않았어요`);
  const from = st.commit;
  try { await git(root, ['pull', '--ff-only', '--quiet'], 120_000); }
  catch (e) { throw error(500, `업데이트하지 못했어요: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
  const to = hubCommit(root, true);
  const files = (await git(root, ['diff', '--name-only', `${from}..HEAD`]).catch(() => '')).split('\n').filter(Boolean);
  const needRestart = files.some((f) => !NO_RESTART(f));
  if (needRestart && restart) {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'restart-hub.mjs'), '--detach'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); child.unref();
  }
  return { updated: true, from, to: to.commit, date: to.date, files: files.length, restart: needRestart, message: needRestart ? '업데이트했어요. 진행 중인 작업이 끝나면 재시작해요' : '업데이트했어요. 화면만 바뀌어 재시작 없이 적용돼요' };
}
