import { jobSummary } from './jobs.mjs';

/** 화면 실시간 연결의 세션 거르기 값: "a" · "a,b" · 배열 → 세션 id 목록(정렬, 중복 없음, 최대 8개). 나란히 보기는 가운데+칸 세션을 연결 하나로 받는다 */
export function sessionList(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(raw.map((x) => String(x).trim()).filter((x) => /^[\w-]{1,120}$/.test(x)))].sort().slice(0, 8);
}

export function clientEvent(ev, sessionId, sessionOf = () => null) {
  const want = new Set(sessionList(sessionId));
  if (ev.type === 'log' && !want.has(sessionOf(ev.jobId))) return null;
  const visible = (j) => want.has(j.sessionId) ? j : jobSummary(j);
  if (ev.job) return { ...ev, job: visible(ev.job) };
  if (ev.jobs) return { ...ev, jobs: ev.jobs.map(visible) };
  return ev;
}

export function writeSse(res, data) {
  if (res.destroyed || res.writableEnded) return;
  if (res.writableLength + Buffer.byteLength(data) > 16 * 1024 * 1024) { res.destroy(); return; }
  if (!res.write(data) && !res.hubDrainTimer) {
    const clear = () => { clearTimeout(res.hubDrainTimer); res.hubDrainTimer = null; res.off('drain', clear); res.off('close', clear); };
    res.hubDrainTimer = setTimeout(() => res.destroy(), 30_000).unref();
    res.once('drain', clear); res.once('close', clear);
  }
}
