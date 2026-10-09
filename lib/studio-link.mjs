// ODDIN 스튜디오와 잇기 (2026-10-10 사용자 "오딘과 연동(프리미어/애프터이펙트 플러그인처럼)되는 프로그램으로").
// 스튜디오(studio/ — 따로 켜는 영상 편집 프로그램)는 켜지면 이 허브에 자기를 알린다(hello, 15초마다). 허브는
//  - 상태(켜짐·판·창 수·프로그램 설치 여부)를 화면에 보여 주고
//  - /studio/ 주소로 스튜디오 화면·API 를 그대로 비춘다(폰·원격에서도 열리게). 원격 요청이면 x-oddin-remote 를 붙여
//    스튜디오가 열 수 있는 폴더를 허브 열기 범위로 줄인다. 클라이언트가 보낸 x-oddin-* 머리는 지운다.
//  - 켜기(엔진 숨김 실행 + 창 띄우기)·설치(Electron 내려받기·바로가기)·끄기를 맡는다.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { guardChild } from './util.mjs';

const ONLINE_MS = 45_000;
const error = (status, message) => Object.assign(new Error(message), { status });

export class StudioLink {
  constructor({ root, emit = () => {}, port = null, now = () => Date.now() }) {
    this.root = root; this.emit = emit; this.now = now;
    this.studioDir = path.join(root, 'studio');
    this.port = port || this.configPort();
    this.last = null; // 마지막 hello
    this.installing = null;
  }
  configPort() { try { return Number(JSON.parse(fs.readFileSync(path.join(this.root, 'config.json'), 'utf8')).studio?.port) || 7710; } catch { return 7710; } }
  version() { try { return JSON.parse(fs.readFileSync(path.join(this.studioDir, 'version.json'), 'utf8')).version; } catch { return null; } }
  electronExe() { const f = path.join(this.studioDir, 'app', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'); return fs.existsSync(f) ? f : null; }
  online() { return !!this.last && this.now() - this.last.at < ONLINE_MS; }
  hello(b = {}) {
    const was = this.online();
    const port = Number(b.port) || this.port;
    this.last = { at: this.now(), port, version: String(b.version || '').slice(0, 40), pid: Number(b.pid) || null, windows: Number(b.app?.windows) || 0 };
    this.port = port;
    if (!was) this.emit({ type: 'studio', ...this.status() });
    return { ok: true };
  }
  bye(b = {}) { if (this.last && (!b.pid || Number(b.pid) === this.last.pid)) { this.last = null; this.emit({ type: 'studio', ...this.status() }); } return { ok: true }; }
  status() {
    return { online: this.online(), port: this.port, version: this.last?.version || null, available: this.version(), windows: this.last?.windows || 0, installed: !!this.electronExe(), installing: !!this.installing, installLog: this.installing?.log?.slice(-6) || null, lastSeen: this.last ? new Date(this.last.at).toISOString() : null };
  }
  /** 엔진을 켜고(꺼져 있으면) 창을 띄운다. open = 열 편집 파일·영상 경로 */
  async start({ open = null, window = true } = {}) {
    const { ensureEngine } = await import(pathToFileURL(path.join(this.studioDir, 'engine', 'launch.mjs')).href);
    const st = await ensureEngine({ port: this.port });
    let r = null;
    if (window || open) r = await this.call('/api/open', { method: 'POST', body: { path: open || null, launch: window } }).catch((e) => ({ error: e.message }));
    return { started: !!st.started, version: st.version, ...(r || {}) };
  }
  async stop({ force = false } = {}) { return this.call('/api/quit', { method: 'POST', body: { force } }); }
  async call(p, { method = 'GET', body = null } = {}) {
    const r = await fetch(`http://127.0.0.1:${this.port}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw error(r.status, j.error || `스튜디오가 ${r.status}로 답했어요`);
    return j;
  }
  /** 프로그램 창 설치: studio/app 에 Electron 을 받고(npm install + 내려받기) 시작 메뉴·바탕화면 바로가기를 만든다 */
  install() {
    if (this.installing) return this.status();
    const appDir = path.join(this.studioDir, 'app');
    const job = { log: [], started: this.now() };
    this.installing = job;
    const say = (s) => { job.log.push(String(s).trim()); if (job.log.length > 200) job.log.shift(); this.emit({ type: 'studio', ...this.status() }); };
    const step = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
      const c = guardChild(spawn(cmd, args, { cwd: appDir, windowsHide: true, shell: process.platform === 'win32' && /npm/.test(cmd), ...opts }));
      c.stdout?.on('data', (b) => say(b)); c.stderr?.on('data', (b) => say(b));
      c.on('error', reject); c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 종료 코드 ${code}`))));
    });
    (async () => {
      say('Electron 받는 중(처음이면 몇 분 걸려요)…');
      await step(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund']);
      if (!this.electronExe()) { say('Electron 실행 파일 내려받는 중…'); await step(process.execPath, [path.join(appDir, 'node_modules', 'electron', 'install.js')]); }
      if (!this.electronExe()) throw new Error('Electron 실행 파일이 없어요');
      say('바로가기 만드는 중…');
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      await step(this.electronExe(), ['.', '--install-shortcuts'], { env });
      say('설치 끝 — 시작 메뉴·바탕화면의 "ODDIN 스튜디오"');
    })().catch((e) => say(`설치 실패: ${e.message}`)).finally(() => { this.installing = null; this.emit({ type: 'studio', ...this.status(), installLog: job.log.slice(-6) }); });
    return this.status();
  }

  /**
   * /studio/… → 스튜디오 엔진. remote = 원격(Tailscale) 화면에서 온 요청, cookie = 화면 쿠키(문서를 열 때 — 원격에서 스튜디오 화면이 바꾸기 요청을 할 수 있게)
   */
  proxy(req, res, { pathname, search, remote = false, cookie = null }) {
    let sub = pathname.replace(/^\/studio/, '') || '/';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!/^(host|x-oddin-|connection|cookie|origin|referer)/i.test(k)) headers[k] = v;
    headers.host = `127.0.0.1:${this.port}`;
    headers['x-oddin-via'] = 'hub';
    headers['x-oddin-remote'] = remote ? '1' : '0';
    const up = http.request({ host: '127.0.0.1', port: this.port, method: req.method, path: sub + (search || ''), headers }, (r) => {
      const h = { ...r.headers }; delete h.connection;
      if (cookie && /text\/html/.test(String(h['content-type'] || ''))) h['set-cookie'] = [cookie];
      res.writeHead(r.statusCode || 502, h);
      r.pipe(res);
      res.on('close', () => r.destroy());
    });
    up.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      const page = /^\/(index\.html)?$/.test(sub) && req.method === 'GET';
      if (page) { res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(offlinePage(remote)); }
      else { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'ODDIN 스튜디오가 꺼져 있어요' })); }
    });
    req.pipe(up);
    req.on('aborted', () => up.destroy());
  }
}

function offlinePage(remote) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ODDIN 스튜디오</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101010;color:#e4e4e4;font:15px/1.6 "Malgun Gothic",sans-serif}main{max-width:420px;padding:24px;text-align:center}button{margin-top:14px;padding:8px 18px;border:0;background:#e4e4e4;color:#101010;font:inherit;font-weight:600;cursor:pointer}p{color:#999}</style></head>
<body><main><h2>ODDIN 스튜디오가 꺼져 있어요</h2><p>${remote ? '이 PC에서 스튜디오를 켜면 여기서 열려요. 아래 단추로 켜 볼 수 있어요.' : '아래 단추를 누르면 켜요.'}</p>
<button id="b">스튜디오 켜기</button><p id="m"></p></main>
<script>document.getElementById('b').onclick=async()=>{const m=document.getElementById('m');m.textContent='켜는 중…';try{const r=await fetch('/api/studio/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({window:${remote ? 'false' : 'true'}})});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);location.reload();}catch(e){m.textContent='켜지 못했어요: '+e.message;}};</script></body></html>`;
}
