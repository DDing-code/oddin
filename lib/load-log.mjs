// 허브가 쉬는 동안 무엇이 바쁜지 숫자로 본다 (2026-10-11 사용자 "작업을 안할 때도 자원을 많이 먹는데?").
// - timed(이름, 일): 주기 작업 하나가 쓴 CPU·걸린 시간을 이름별로 더한다. 여러 일이 겹쳐 돌면 서로의 CPU가 섞이므로 어림값이다.
// - 1분마다 허브 프로세스의 누적 CPU 를 적어 최근 1분·10분·1시간 평균(코어 하나 = 100%)을 낸다. 딸린 프로세스(CLI·브라우저)는 들어가지 않는다.
// - GET /api/hub/load 로 본다.
const tasks = new Map(); // 이름 → { n, cpuMs, wallMs, maxCpuMs, lastAt }
const samples = []; // { at, cpu } 1분마다, 최근 61개
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
let timer = null;

function add(name, cpu, wall) {
  const r = tasks.get(name) || { n: 0, cpuMs: 0, wallMs: 0, maxCpuMs: 0, lastAt: null };
  r.n++; r.cpuMs += cpu; r.wallMs += wall; r.maxCpuMs = Math.max(r.maxCpuMs, cpu); r.lastAt = new Date().toISOString();
  tasks.set(name, r);
}
export async function timed(name, fn) {
  const c0 = process.cpuUsage(), t0 = performance.now();
  try { return await fn(); }
  finally { const u = process.cpuUsage(c0); add(name, (u.user + u.system) / 1000, performance.now() - t0); }
}
/** 요청 하나가 쓴 시간: 시작할 때 부르고, 돌려받은 함수를 응답이 끝날 때 부른다. 이름은 "http GET /api/…"(주소의 id 부분은 뭉뚱그린다) */
export function requestTimer(method, pathname) {
  const c0 = process.cpuUsage(), t0 = performance.now();
  const name = `http ${method} ${String(pathname).split('/').slice(0, 4).map((s) => (/^(rm-|\d{8}-|[0-9a-f]{8,})/.test(s) || s.length > 24 ? ':id' : s)).join('/')}`;
  return () => { const u = process.cpuUsage(c0); add(name, (u.user + u.system) / 1000, performance.now() - t0); };
}
export function startLoadLog() {
  if (timer) return;
  samples.push({ at: Date.now(), cpu: cpuNow() });
  timer = setInterval(() => { samples.push({ at: Date.now(), cpu: cpuNow() }); if (samples.length > 61) samples.shift(); }, 60_000);
  timer.unref?.();
}
export function loadReport() {
  const now = Date.now(), cpu = cpuNow(), up = process.uptime() * 1000;
  const avg = (minutes) => {
    const s = samples.length ? samples[Math.max(0, samples.length - minutes)] : null;
    if (!s || now - s.at < 5000) return null;
    return Math.round((cpu - s.cpu) / (now - s.at) * 1000) / 10;
  };
  const mem = process.memoryUsage();
  return {
    uptimeMinutes: Math.round(up / 60_000),
    cpuPercent: { last1m: avg(1), last10m: avg(10), last60m: avg(60), sinceStart: Math.round(cpu / up * 1000) / 10 },
    memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    tasks: [...tasks.entries()].map(([name, r]) => ({ name, runs: r.n, cpuMs: Math.round(r.cpuMs), wallMs: Math.round(r.wallMs), maxCpuMs: Math.round(r.maxCpuMs), perMinuteCpuMs: Math.round(r.cpuMs / Math.max(1, up / 60_000)), lastAt: r.lastAt }))
      .sort((a, b) => b.cpuMs - a.cpuMs),
  };
}
