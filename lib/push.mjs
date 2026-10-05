// 폰 알림(웹 푸시) (2026-10-06 사용자 "오딘 앱으로도 쓰고 싶어 아이폰").
// 홈 화면에 추가한 ODDIN(아이폰 iOS 16.4+, 안드로이드 크롬)이 알림을 허용하면 그 기기의 구독을 data/push.json 에 저장하고,
// 작업이 끝나거나(완료·일부 완료·실패) 질문·승인 요청이 오면 이 허브가 직접 푸시를 보낸다. 의존성 없이 node:crypto 로:
//  - VAPID(RFC 8292): 이 허브의 P-256 키로 서명한 ES256 토큰을 Authorization 에 붙인다. 키는 처음 쓸 때 만들어 data/push.json 에 둔다(커밋 안 함).
//  - 내용 암호화(RFC 8291, aes128gcm): 기기 공개키(p256dh)·인증값(auth)과 한 번 쓰는 키로 ECDH → HKDF → AES-128-GCM.
// 푸시 서비스가 404·410 을 돌려주면(앱 지움·알림 끔) 그 구독은 지운다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.mjs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const ST_KO = { done: '완료', partial: '일부 완료', failed: '실패' };
const LIVE = new Set(['queued', 'planning', 'running', 'reporting']);
const SUBJECT = 'https://github.com/DDing-code/oddin'; // VAPID 연락처(사이트 주소). 개인 이메일은 넣지 않는다

/** 기기 구독 + 보낼 내용 → 암호화한 본문(aes128gcm) */
export function encryptPayload(sub, payload, { salt = crypto.randomBytes(16), serverKeys = null } = {}) {
  const uaPublic = fromB64u(sub?.keys?.p256dh), authSecret = fromB64u(sub?.keys?.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw Object.assign(new Error('구독 키가 올바르지 않아요'), { status: 400 });
  const ecdh = serverKeys || crypto.createECDH('prime256v1');
  if (!serverKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const plain = Buffer.concat([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)), Buffer.from([2])]); // 2 = 마지막 묶음
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/** VAPID 서명 토큰 */
export function vapidAuth(endpoint, keys, { now = Date.now() } = {}) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT })}`;
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

export class Push {
  constructor({ file = path.join(DATA_DIR, 'push.json'), fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    this.file = file; this.fetch = fetchImpl; this.log = log;
    this.data = readJson(file, null) || {};
    this.data.subs ||= [];
    this.jobState = new Map(); // 작업 id → 마지막 상태 (끝난 순간만 알림)
    this.asked = new Set();
  }
  save() { writeJsonAtomic(this.file, this.data); }
  keys() {
    if (!this.data.vapid?.privateJwk) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65); // 압축 안 한 점 65바이트
      this.data.vapid = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }), createdAt: new Date().toISOString() };
      this.save();
    }
    return this.data.vapid;
  }
  publicKey() { return this.keys().publicKey; }
  list() { return this.data.subs.map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt, lastOk: s.lastOk || null, lastError: s.lastError || null })); }
  subscribe(sub, name = '') {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw Object.assign(new Error('구독 정보가 올바르지 않아요'), { status: 400 });
    encryptPayload(sub, 'x'); // 키 검사
    const id = crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 16);
    this.data.subs = this.data.subs.filter((s) => s.id !== id);
    this.data.subs.push({ id, name: String(name || '기기').slice(0, 60), endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: new Date().toISOString() });
    this.save();
    return { id };
  }
  unsubscribe({ id, endpoint } = {}) {
    const n = this.data.subs.length;
    this.data.subs = this.data.subs.filter((s) => s.id !== id && s.endpoint !== endpoint);
    if (this.data.subs.length !== n) this.save();
    return { removed: n - this.data.subs.length };
  }
  /** 모든 기기(또는 id 하나)에 보내기 */
  async send(msg, { only = null } = {}) {
    const keys = this.keys(), out = [];
    for (const s of this.data.subs.filter((x) => !only || x.id === only)) {
      try {
        const res = await this.fetch(s.endpoint, {
          method: 'POST',
          headers: { Authorization: vapidAuth(s.endpoint, keys), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: msg.urgent ? 'high' : 'normal', ...(msg.topic ? { Topic: msg.topic } : {}) },
          body: encryptPayload(s, msg),
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 404 || res.status === 410) { this.unsubscribe({ id: s.id }); out.push({ id: s.id, gone: true }); continue; }
        if (!res.ok) { const t = await res.text().catch(() => ''); s.lastError = `${res.status} ${t.slice(0, 160)}`; out.push({ id: s.id, status: res.status, error: s.lastError }); continue; }
        s.lastOk = new Date().toISOString(); s.lastError = null; out.push({ id: s.id, ok: true });
      } catch (e) { s.lastError = String(e.message || e).slice(0, 160); out.push({ id: s.id, error: s.lastError }); }
    }
    if (out.length) this.save();
    return out;
  }
  /** 허브 실시간 이벤트를 보고 알릴 일만 골라 보낸다. titleOf(job) = 세션 제목, jobOf(id) = 작업(질문·승인 요청이 어느 세션 것인지) */
  onEvent(ev, { titleOf = () => '', jobOf = () => null } = {}) {
    if (!this.data.subs.length || !ev) return null;
    if (ev.type === 'job' && ev.job?.id) {
      const j = ev.job, prev = this.jobState.get(j.id);
      this.jobState.set(j.id, j.status);
      if (this.jobState.size > 2000) this.jobState.delete(this.jobState.keys().next().value);
      if (!prev || !LIVE.has(prev) || LIVE.has(j.status) || !ST_KO[j.status]) return null; // 막 끝난 순간만, 직접 중지는 조용히
      const where = ev.machine?.name ? ` · ${ev.machine.name}` : '';
      const msg = { title: `${j.status === 'failed' ? '작업 실패' : j.status === 'partial' ? '일부 완료' : '작업 완료'}${where}`, body: titleOf(j) || j.title || '작업', url: `./#s=${encodeURIComponent(j.sessionId || '')}`, tag: `job-${j.id}` };
      return this.send(msg).catch((e) => this.log(`폰 알림 실패: ${e.message}`));
    }
    if (ev.type === 'prompt' && ev.prompt?.status === 'pending' && !this.asked.has(ev.prompt.id)) {
      const p = ev.prompt; this.asked.add(p.id);
      const job = p.jobId ? jobOf(p.jobId) : null;
      const where = ev.machine?.name ? ` · ${ev.machine.name}` : '';
      const msg = { title: `${p.kind === 'question' ? '질문이 왔어요' : p.kind === 'plan' ? '계획 확인을 기다려요' : '승인을 기다려요'}${where}`, body: [p.title, job ? titleOf(job) || job.title : ''].filter(Boolean).join(' · ').slice(0, 160) || '확인이 필요해요', url: `./#s=${encodeURIComponent(job?.sessionId || '')}`, tag: `prompt-${p.id}`, urgent: true };
      return this.send(msg).catch((e) => this.log(`폰 알림 실패: ${e.message}`));
    }
    return null;
  }
}
