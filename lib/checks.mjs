// ODDIN 이 직접 돌리는 검사(2026-10-19 사용자 "1~3 해줘"): "다 됐다"를 AI 말로만 믿지 않고 실행해서 판정한다
// (claw-orchestrator 의 acceptance contract·ralphex 의 작업별 검사 명령을 참고, 코드는 새로 씀).
// 계획(tasks[].checks)이나 작업자가 결과 끝에 적은 "확인 명령: …" 을 작업이 끝난 뒤 작업 폴더에서 직접 돌리고,
// 실패하면 같은 작업자에게 한 번 돌려보낸다(jobs.verifyTask). 규약 docs/checks.md, 시험 tests/checks.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { childEnv, guardChild, killChildTree } from './util.mjs';

const DEFAULTS = { enabled: true, timeoutMinutes: 10, fixRounds: 1, max: 3 };
export const checksConfig = (config) => ({ ...DEFAULTS, ...(config?.checks || {}) });

/** 명령 목록 다듬기: 한 줄짜리만, 앞뒤 따옴표·코드 표시 빼고, 겹치는 것 빼고 최대 max 개 */
export function cleanChecks(list, max = DEFAULTS.max) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let c = String(raw || '').trim();
    if (/[\r\n]/.test(c)) continue;
    // 명령 전체를 감싼 따옴표·코드 표시만 벗긴다("C:\node.exe" -e "…" 처럼 안에도 따옴표가 있으면 그대로)
    const m = c.match(/^(`+|'|")(.*)\1$/);
    if (m && !m[2].includes(m[1][0])) c = m[2];
    c = c.replace(/\s+/g, ' ').trim();
    if (c && c.length <= 300 && !out.includes(c)) out.push(c);
  }
  return out.slice(0, max);
}

/** 작업자가 결과 끝에 적은 "확인 명령: …" 줄 */
export function declaredChecks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/^[ \t]*(?:[-*•][ \t]*)?\**확인 명령\**[ \t]*[:：]\**[ \t]*(.+)$/gm)) out.push(m[1].trim());
  return cleanChecks(out);
}

// 돌리지 않는 명령: 지우기·되돌리기·배포·push·설치·네트워크·프로세스 끄기·파일로 출력 돌려쓰기
const UNSAFE = /(\brm\s+-\w*[rf]|\brmdir\b|\brd\s+\/s|\bdel\s+\/[sqf]|\bformat\s+[a-z]:|\bshutdown\b|\btaskkill\b|\bkill\s+-?\d|\bgit\s+(push|reset|clean|checkout|switch|commit|rebase|merge|pull|stash|restore)\b|\bnpm\s+(publish|install|i|ci|uninstall|update|link)\b|\b(yarn|pnpm|bun)\s+(add|install|remove|publish)\b|\bpip\s+install\b|\bvercel\b|\bdeploy\b|\bcurl\b|\bwget\b|Invoke-WebRequest|Remove-Item|Set-Content|Out-File|\breg\s+(add|delete)\b|\bmklink\b|(^|[^<>\d=])>(?!=)|>>|\|\s*(sh|bash|iex|cmd)\b)/i;
export function unsafeReason(cmd) { return UNSAFE.test(cmd) ? '파일을 바꾸거나 지우기·배포·설치할 수 있는 명령이라 돌리지 않았어요' : null; }

/** npm run X / npm test 인데 package.json 에 그 스크립트가 없으면 미리 거른다(없는 명령으로 "실패" 판정하지 않게) */
export function missingScript(cmd, cwd) {
  const m = cmd.match(/^npm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|start)\b)/i);
  if (!m) return null;
  const name = m[1] || m[2];
  let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch { return '작업 폴더에 package.json 이 없어요'; }
  return pkg.scripts?.[name] ? null : `package.json 에 "${name}" 스크립트가 없어요`;
}

/** 명령 하나 돌리기 → { cmd, ok, code, ms, timedOut, tail }. 전체 출력은 logFile(최대 4MB) */
export function runCheck(cmd, { cwd, timeoutMs = 10 * 60_000, logFile = null } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = '', size = 0, timedOut = false, done = false, child, log = null;
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer);
      try { log?.end(); } catch {}
      resolve({ cmd, ok: code === 0 && !timedOut, code: code ?? null, ms: Date.now() - started, timedOut, tail: tail.slice(-1500) });
    };
    const take = (d) => { const s = d.toString(); size += s.length; tail = (tail + s).slice(-8000); if (log && size < 4 << 20) log.write(s); };
    try {
      if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); log = fs.createWriteStream(logFile); log.on('error', () => { log = null; }); }
      child = guardChild(spawn(cmd, { cwd, shell: true, windowsHide: true, env: childEnv({ CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }), stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) { take(String(e?.message || e)); return finish(null); }
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; killChildTree(child); }, timeoutMs); timer.unref?.();
    child.on('error', (e) => { take(String(e?.message || e)); finish(null); });
    child.on('close', (code) => finish(code));
  });
}

/** 작업 하나의 검사 묶음 → { results, verified }. verified = 'verified'(모두 통과) | 'refuted'(하나라도 실패) | 'unverified'(돌린 것 없음) */
export async function runTaskChecks({ cmds, cwd, dir, timeoutMs, onEvent }) {
  const results = [];
  for (const [i, cmd] of cmds.entries()) {
    const why = unsafeReason(cmd) || missingScript(cmd, cwd);
    if (why) { results.push({ cmd, skipped: why }); onEvent?.({ kind: 'check', state: 'skipped', cmd, text: `검사 건너뜀: ${cmd} — ${why}` }); continue; }
    onEvent?.({ kind: 'check', state: 'running', cmd, text: `검사 시작: ${cmd}` });
    const r = await runCheck(cmd, { cwd, timeoutMs, logFile: dir ? path.join(dir, `${i + 1}.log`) : null });
    results.push(r);
    onEvent?.({ kind: 'check', state: r.ok ? 'pass' : 'fail', cmd, ms: r.ms, code: r.code, text: r.ok ? `검사 통과: ${cmd} (${took(r.ms)})` : `검사 실패: ${cmd} (${r.timedOut ? '시간 초과' : `종료 코드 ${r.code}`})\n${r.tail.slice(-600)}` });
  }
  const ran = results.filter((r) => !r.skipped);
  return { results, verified: !ran.length ? 'unverified' : ran.every((r) => r.ok) ? 'verified' : 'refuted' };
}

const took = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초` : `${Math.max(1, Math.round(ms / 1000))}초`);
/** 보고·다음 작업에 넘길 한 줄: "ODDIN 검사: 통과 2/2 (npm test 12초, …)" */
export function checksSummary(task) {
  const run = task?.checkRuns?.at(-1); if (!run) return '';
  const ran = run.results.filter((r) => !r.skipped), skipped = run.results.filter((r) => r.skipped);
  const fixed = (task.checkRuns.length > 1) ? ` — 첫 검사 실패 뒤 고쳐서 ${task.checkRuns.length}번째 검사` : '';
  const part = (r) => r.skipped ? `${r.cmd}(건너뜀: ${r.skipped})` : `${r.cmd} ${r.ok ? '통과' : r.timedOut ? '시간 초과' : `실패(종료 코드 ${r.code})`} ${took(r.ms)}`;
  const head = !ran.length ? '돌린 검사 없음' : task.verified === 'verified' ? `통과 ${ran.length}/${ran.length}` : `실패 ${ran.filter((r) => !r.ok).length}/${ran.length}`;
  return `ODDIN 검사(허브가 직접 실행): ${head}${fixed} — ${[...ran, ...skipped].map(part).join(', ')}`;
}
