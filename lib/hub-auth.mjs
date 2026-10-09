// 다른 PC 제어 막기 (2026-10-06 사용자 "오딘 회사 컴퓨터에서 작업했는데 왜 집 프리미어에서 작업이 되지?" → 2번 "다른 PC 작업은 그 PC로 정식으로 넘기기").
// 원격 접속(Tailscale)은 사용자 계정이면 다 받아서, 회사 PC의 AI 가 집 ODDIN 원격 주소로 터미널을 열고 집 프리미어를 몰래 조작할 수 있었다.
// 이 PC를 조작하는 "제어" 기능(터미널·어도비·파일 열기 범위·업데이트·재시작)은 원격에서 아래 둘 중 하나일 때만 받는다.
//  1) ODDIN 화면(브라우저·데스크탑 앱·폰 앱): 화면을 열 때(문서 탐색) 이 PC가 주는 쿠키(oddin_ui)를 가진 요청.
//  2) 연결된 PC의 ODDIN 허브: 두 허브가 처음 연결될 때 주고받은 키로 서명한 요청(X-Oddin-From·X-Oddin-Sig, 5분 안).
// AI 작업자가 다른 PC가 필요하면 그 PC로 작업을 넘긴다(POST /api/handoff · scripts/handoff.mjs) — 그 PC 세션에 보이게 진행된다.
// 같은 PC 안의 AI 는 어차피 그 PC를 다룰 수 있으므로 로컬 요청은 막지 않는다. 단 로컬 요청이라도 다른 PC로 넘기는 제어 요청(rm- 대리)은 화면 쿠키가 있어야 한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.mjs';

const COOKIE = 'oddin_ui';
const SKEW_MS = 5 * 60_000;
const error = (status, message) => Object.assign(new Error(message), { status });
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** 서명에 쓰는 주소 모양(보내는 쪽 fetch 와 받는 쪽 URL 해석이 같은 글자가 되게) */
export const canonicalRoute = (route) => { try { const u = new URL(String(route), 'http://x'); return u.pathname + u.search; } catch { return String(route); } };

/** 이 PC를 조작하는 기능인가 (원격에서는 화면·연결된 허브만) */
export function isControl(pathname, method = 'GET') {
  const p = String(pathname || '');
  if (/^\/api\/terminals(\/|$)/.test(p)) return true;
  if (/^\/api\/adobe\//.test(p)) return !(p === '/api/adobe/status' && method === 'GET');
  if (p === '/api/open') return true;
  if (/^\/api\/browser(\/|$)/.test(p)) return true; // ODDIN 브라우저: 보기·조작 모두
  if (/^\/studio\//.test(p)) return method !== 'GET' && method !== 'HEAD'; // ODDIN 스튜디오(비춤): 저장·올리기·렌더·글꼴 설치(보기는 읽기)
  if (/^\/api\/studio\/(start|stop|install)$/.test(p)) return true;
  if (p === '/api/dirs' || p === '/api/dirs/rename') return method !== 'GET'; // 폴더 만들기·이름 바꾸기
  if (p === '/api/file-access') return method !== 'GET';
  if (/^\/api\/hub\/(update|restart)$/.test(p)) return method !== 'GET';
  if (/^\/api\/peers\/[^/]+\/(update|restart)$/.test(p)) return method !== 'GET';
  return false;
}

export class HubAuth {
  constructor({ file = path.join(DATA_DIR, 'hub-auth.json'), selfId = () => '' } = {}) {
    this.file = file; this.selfId = selfId;
    this.data = readJson(file, null) || {};
    if (!this.data.secret) { this.data.secret = crypto.randomBytes(32).toString('hex'); this.save(); }
    this.data.mine ||= {}; this.data.theirs ||= {}; this.data.registered ||= {};
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); writeJsonAtomic(this.file, this.data); }

  /* ---------- ODDIN 화면 쿠키 ---------- */
  uiToken() { return `v1.${hmac(this.data.secret, 'oddin-ui')}`; }
  /** 화면을 여는(문서 탐색) 요청이면 쿠키 머리를 돌려준다 */
  cookieFor(req, { secure = false } = {}) {
    const dest = String(req.headers['sec-fetch-dest'] || ''), mode = String(req.headers['sec-fetch-mode'] || '');
    if (dest !== 'document' && mode !== 'navigate') return null;
    return `${COOKIE}=${this.uiToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
  }
  hasUi(req) {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === COOKIE && same(v.join('='), this.uiToken())) return true; }
    return false;
  }

  /* ---------- 연결된 허브끼리 서명 ---------- */
  /** 그 PC로 보낼 요청에 붙일 서명 머리 (그 PC에 키를 아직 못 맡겼으면 빈 객체) */
  sign(peerId, method, route) {
    const key = this.data.mine[peerId];
    if (!key || !this.data.registered[peerId]) return {};
    const ts = String(Date.now());
    return { 'X-Oddin-From': this.selfId(), 'X-Oddin-Sig': `${ts}.${hmac(key, `${String(method || 'GET').toUpperCase()} ${route} ${ts}`)}` };
  }
  /** 받은 요청이 연결된 PC 허브가 서명한 것인가. knownIds = 연결된 PC들의 허브 id(remoteId) */
  verify(req, route, knownIds = []) {
    const from = String(req.headers['x-oddin-from'] || ''), sig = String(req.headers['x-oddin-sig'] || '');
    const key = this.data.theirs[from];
    if (!from || !key || !knownIds.includes(from)) return false;
    const [ts, mac] = sig.split('.');
    if (!ts || !mac || Math.abs(Date.now() - Number(ts)) > SKEW_MS) return false;
    return same(mac, hmac(key, `${String(req.method || 'GET').toUpperCase()} ${route} ${ts}`));
  }
  /** 그 PC에 맡길 내 서명 키(없으면 만든다) */
  keyFor(peerId) {
    if (!this.data.mine[peerId]) { this.data.mine[peerId] = crypto.randomBytes(32).toString('hex'); this.data.registered[peerId] = false; this.save(); }
    return this.data.mine[peerId];
  }
  markRegistered(peerId) { if (!this.data.registered[peerId]) { this.data.registered[peerId] = true; this.save(); } }
  needsRegister(peerId) { return !this.data.registered[peerId]; }
  /** 연결된 PC가 맡긴 키 받기. 처음 받은 키만 믿는다(바꾸려면 이 PC에서 그 PC 연결을 지웠다가 다시 추가) */
  accept(fromId, key) {
    if (!/^[0-9a-f]{64}$/.test(String(key || ''))) throw error(400, '키 형식이 올바르지 않아요');
    const cur = this.data.theirs[fromId];
    if (cur && cur !== key) throw error(409, '이 PC는 그 PC의 다른 연결 키를 이미 갖고 있어요. 이 PC의 PC 탭에서 그 PC 연결을 지우고 다시 추가해 주세요');
    if (!cur) { this.data.theirs[fromId] = key; this.save(); }
    return { ok: true };
  }
  forget(peerId, remoteId) {
    delete this.data.mine[peerId]; delete this.data.registered[peerId];
    if (remoteId) delete this.data.theirs[remoteId];
    this.save();
  }
}

/** 원격·대리 제어 요청 판정. 통과면 null, 막으면 {status, error} */
export function controlGate(req, { pathname, route, method, remote, proxied, auth, knownIds }) {
  if (!isControl(pathname, method)) return null;
  const ui = auth.hasUi(req);
  if (proxied && !ui) return { status: 403, error: '다른 PC의 터미널·어도비·설정은 ODDIN 화면에서만 열 수 있어요. AI 작업은 그 PC로 넘기세요(작업 넘기기)' };
  if (remote && !ui && !auth.verify(req, route, knownIds)) return { status: 403, error: '이 PC의 터미널·어도비·설정은 원격에서는 ODDIN 화면으로만 쓸 수 있어요(화면을 새로고침하면 다시 돼요). 다른 PC의 AI 는 작업 넘기기를 쓰세요' };
  return null;
}
