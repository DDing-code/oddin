import { jobSummary } from './jobs.mjs';

export function clientEvent(ev, sessionId, sessionOf = () => null) {
  if (ev.type === 'log' && sessionOf(ev.jobId) !== sessionId) return null;
  const visible = (j) => j.sessionId === sessionId ? j : jobSummary(j);
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
