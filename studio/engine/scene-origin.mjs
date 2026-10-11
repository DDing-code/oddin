// 장면 출처 (2026-10-12 보안 수정) — HTML 장면을 엔진과 **다른 출처**(127.0.0.1 의 다른 포트)에서 내주는 두 번째 HTTP 서버.
// 왜: 장면 HTML 은 받아 온 템플릿일 수 있다. 엔진 출처(/api/raw/…)로 띄우던 때는 장면 안의 스크립트가 엔진과 같은 출처로 돌아서
//     parent(편집기 화면)나 fetch('/api/…')로 엔진 API(아무 파일 읽기·ODDIN 작업 만들기·렌더·글꼴 설치)를 부를 수 있었다.
//     출처를 나누면 브라우저가 막는다 — 다른 출처의 화면은 못 만지고 응답도 못 읽는다. 엔진도 다른 출처에서 온 API 요청은 거절한다(server.mjs guard).
// 무엇: **파일 읽기만** 한다. API 가 하나도 없다. 주소는 /m/<mount>/<상대 경로> 뿐.
//  - mount = 엔진이 등록한 폴더(루트)의 토큰. 엔진을 켤 때 만든 비밀값으로 폴더 경로를 HMAC 한 것 — 같은 폴더는 같은 토큰, 밖에서는 못 맞힌다.
//  - 루트 밖(.. · 절대 경로 · 정션/심볼릭 링크 너머 — realpath 로 확인)은 404.
//  - Host 가 127.0.0.1:포트·localhost:포트 가 아니면 거절(DNS 리바인딩). GET·HEAD 만. nosniff.
//  - .html 은 </body> 앞에 시각 맞춤 스크립트(ui/scene-seek.js)와 postMessage 다리를 넣어 내준다 — 편집기 미리보기는 다른 출처의 iframe 안을
//    직접 만질 수 없으니 { oddinSeek: 초 } 를 보내고 { oddinSeeked } 답을 받는다. 렌더(scene.mjs)는 지금처럼 CDP 로 직접 부른다.
// 장면이 CDN(https) 라이브러리나 같은 루트의 그림·글꼴·json 을 쓰는 것은 그대로 된다(같은 출처의 상대 경로).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UI_DIR, error } from './env.mjs';
import { sendFile } from './http.mjs';

const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p); // 윈도는 대소문자를 가리지 않는다
const inside = (root, p) => { const r = fold(root), x = fold(p); return x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
const BAD_SEG = WIN ? /[\\/:\0]/ : /[/\0]/; // 한 칸 안의 구분자·드라이브(C:)·다른 스트림(파일:이름)

/** 부모 창(편집기 미리보기)과 말하는 다리: 시각을 받으면 맞추고 끝났다고 답한다. 다 읽히면 준비됐다고 알린다 */
const BRIDGE_JS = `(() => {
  if (window.__oddinBridge) return; window.__oddinBridge = true;
  window.addEventListener('message', (e) => {
    const d = e.data; if (!d || typeof d !== 'object' || d.oddinSeek == null || e.source !== window.parent) return;
    const t = Number(d.oddinSeek) || 0, done = () => { try { e.source.postMessage({ oddinSeeked: t, id: d.id }, '*'); } catch (x) {} };
    let p; try { p = window.__oddinSeekAny(t); } catch (x) {}
    Promise.resolve(p).then(done, done);
  });
  if (window.parent !== window) {
    const ready = () => { try { window.parent.postMessage({ oddinSceneReady: true }, '*'); } catch (x) {} };
    if (document.readyState === 'complete') ready(); else window.addEventListener('load', ready);
  }
})();`;
/** 장면 HTML 에 시각 맞춤 스크립트를 넣는다: 마지막 </body> 앞(없으면 끝). 바이트 그대로 다뤄 원래 내용은 건드리지 않는다 */
export function injectSeek(buf) {
  const seek = fs.readFileSync(path.join(UI_DIR, 'scene-seek.js'), 'utf8');
  const tag = Buffer.from(`<script data-oddin-seek>\n${`${seek}\n${BRIDGE_JS}`.replace(/<\/script/gi, '<\\/script')}\n</script>\n`);
  let at = -1; for (const m of buf.toString('latin1').matchAll(/<\/body\b/gi)) at = m.index;
  return at < 0 ? Buffer.concat([buf, Buffer.from('\n'), tag]) : Buffer.concat([buf.subarray(0, at), tag, buf.subarray(at)]);
}

export class SceneOrigin {
  /** port = 열고 싶은 포트(쓰는 중이면 빈 포트를 잡는다) */
  constructor({ port = 0 } = {}) {
    this.want = Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
    this.port = 0; this.server = null; this.starting = null;
    this.secret = crypto.randomBytes(32); // 엔진을 켤 때마다 새로 — 토큰은 이 엔진이 켜져 있는 동안만 맞는다
    this.mounts = new Map(); // 토큰 → 루트 폴더(실제 경로)
  }
  get origin() { return `http://127.0.0.1:${this.port}`; }
  /** 서버를 연다(이미 열렸으면 그대로). 열린 포트를 돌려준다 */
  start() {
    if (this.server) return Promise.resolve(this.port);
    return (this.starting ||= this.listen(this.want).catch((e) => (e.code === 'EADDRINUSE' && this.want ? this.listen(0) : Promise.reject(e))).finally(() => { this.starting = null; }));
  }
  listen(port) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this.handle(req, res));
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => { s.off('error', reject); s.on('error', (e) => console.error('[studio] 장면 출처 서버 오류:', e.message)); this.server = s; this.port = s.address().port; resolve(this.port); });
    });
  }
  stop() { const s = this.server; this.server = null; this.port = 0; try { s?.closeAllConnections?.(); s?.close(); } catch {} }

  /** 폴더를 루트로 등록하고 토큰을 준다(같은 폴더는 같은 토큰) */
  mount(dir) {
    const root = fs.realpathSync(path.resolve(String(dir || '')));
    if (!fs.statSync(root).isDirectory()) throw error(400, '폴더가 아니에요');
    const token = crypto.createHmac('sha256', this.secret).update(fold(root)).digest('hex').slice(0, 24);
    this.mounts.set(token, root);
    return token;
  }
  /**
   * 장면 파일을 띄울 주소(그 장면이 속한 폴더를 등록한다).
   * 루트 = 편집 파일(editFile) 폴더 안에 장면이 있으면 그 편집 파일 폴더(편집 폴더의 그림·글꼴을 같이 쓸 수 있게), 아니면 장면 파일의 폴더.
   */
  urlFor(file, editFile = null) {
    if (!this.server) throw error(503, '장면 출처가 아직 열리지 않았어요');
    let real; try { real = fs.realpathSync(path.resolve(String(file || ''))); } catch { throw error(404, `장면 파일을 찾지 못했어요: ${file}`); }
    let root = path.dirname(real);
    if (editFile) { try { const dir = fs.realpathSync(path.dirname(path.resolve(String(editFile)))); if (inside(dir, real)) root = dir; } catch {} }
    return `${this.origin}/m/${this.mount(root)}/${path.relative(root, real).split(path.sep).map(encodeURIComponent).join('/')}`;
  }
  /** 주소의 경로 → 루트 안의 실제 파일(아니면 null). 주소를 정리(normalize)하지 않고 칸마다 본다 — .. 한 칸이라도 있으면 거절 */
  resolve(pathname) {
    const segs = String(pathname || '').split('/'); // ['', 'm', 토큰, 상대 경로…]
    if (segs.length < 4 || segs[0] !== '' || segs[1] !== 'm') return null;
    const root = this.mounts.get(segs[2]); if (!root) return null;
    const rel = [];
    for (const s of segs.slice(3)) {
      let d; try { d = decodeURIComponent(s); } catch { return null; }
      if (!d || d === '.' || d === '..' || BAD_SEG.test(d)) return null;
      rel.push(d);
    }
    let real; try { real = fs.realpathSync(path.join(root, ...rel)); } catch { return null; }
    if (!inside(root, real)) return null; // 정션·심볼릭 링크로 루트 밖을 가리키는 것
    try { return fs.statSync(real).isFile() ? real : null; } catch { return null; }
  }
  handle(req, res) {
    const say = (status, text, extra = {}) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(req.method === 'HEAD' ? undefined : text); };
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return say(403, '이 주소로는 열 수 없어요');
      if (req.method !== 'GET' && req.method !== 'HEAD') return say(405, '읽기만 할 수 있어요', { Allow: 'GET, HEAD' });
      const file = this.resolve(String(req.url || '').split(/[?#]/)[0]);
      if (!file) return say(404, '없는 주소예요');
      if (!/\.html?$/i.test(file)) return sendFile(req, res, file, { cache: 'no-cache' });
      const body = injectSeek(fs.readFileSync(file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) { if (res.headersSent) res.destroy(); else say(e.code === 'ENOENT' ? 404 : 500, '파일을 읽지 못했어요'); }
  }
}
