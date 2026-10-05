// 폰 알림(웹 푸시): 내용 암호화(RFC 8291 예시와 똑같이) · VAPID 서명 · 알릴 때 고르기 · 끊긴 구독 정리 (lib/push.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-push-'));
process.env.HUB_DATA_DIR = path.join(temp, 'data');
fs.mkdirSync(process.env.HUB_DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { encryptPayload, vapidAuth, Push } = await import('../lib/push.mjs');
const u = (s) => Buffer.from(s, 'base64url');

test('내용 암호화: RFC 8291 부록 A 예시와 바이트까지 같다', () => {
  const sub = { endpoint: 'https://push.example.net/x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const as = crypto.createECDH('prime256v1'); as.setPrivateKey(u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  const out = encryptPayload(sub, 'When I grow up, I want to be a watermelon', { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), serverKeys: as });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  assert.throws(() => encryptPayload({ keys: { p256dh: 'AAAA', auth: 'AAAA' } }, 'x'), (e) => e.status === 400);
});

test('VAPID: 허브 공개키로 서명이 확인되고, 받는 곳 주소만 담는다', () => {
  const p = new Push({ file: path.join(temp, 'v.json') });
  const keys = p.keys();
  assert.equal(u(keys.publicKey).length, 65);
  assert.equal(new Push({ file: path.join(temp, 'v.json') }).publicKey(), keys.publicKey, '키는 한 번 만들고 그대로');
  const h = vapidAuth('https://web.push.apple.com/abc/def', keys);
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, keys.publicKey);
  const [hd, cl, sig] = jwt.split('.');
  const claims = JSON.parse(u(cl).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.match(claims.sub, /^https:\/\//);
  assert.ok(claims.exp > Date.now() / 1000);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: u(keys.publicKey).subarray(1, 33).toString('base64url'), y: u(keys.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${cl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, u(sig)));
});

function fakeDevice() {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { sub: { endpoint: `https://push.example.net/${crypto.randomUUID()}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, ua, auth };
}
// 받는 기기 쪽 풀기(RFC 8291): 보낸 내용이 그대로 나오는지
function decrypt(dev, body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const shared = dev.ua.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, dev.auth, Buffer.concat([Buffer.from('WebPush: info\0'), dev.ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
}

test('알릴 때 고르기: 작업이 막 끝난 순간(직접 중지 빼고)과 새 질문·승인만, 끊긴 기기는 지운다', async () => {
  const sent = []; let status = 201;
  const p = new Push({ file: path.join(temp, 's.json'), fetchImpl: async (url, o) => { sent.push({ url, o }); return { ok: status < 300, status, text: async () => '' }; } });
  assert.equal(p.onEvent({ type: 'job', job: { id: 'j1', status: 'running' } }), null, '받을 기기가 없으면 아무것도 안 함');
  assert.throws(() => p.subscribe({ endpoint: 'http://x' }), (e) => e.status === 400);
  const dev = fakeDevice();
  p.subscribe(dev.sub, '아이폰');
  assert.deepEqual(p.list().map((d) => d.name), ['아이폰']);
  const titleOf = (j) => (j.sessionId === 's1' ? '차트던전 07편' : '');
  const ev = (status) => p.onEvent({ type: 'job', job: { id: 'j1', sessionId: 's1', status, title: '요청' } }, { titleOf });
  await ev('queued'); await ev('running'); await ev('running');
  assert.equal(sent.length, 0, '진행 중에는 조용히');
  await ev('done');
  assert.equal(sent.length, 1);
  const { o } = sent[0];
  assert.equal(o.headers['Content-Encoding'], 'aes128gcm'); assert.match(o.headers.Authorization, /^vapid t=/); assert.equal(o.headers.TTL, '86400');
  assert.deepEqual(decrypt(dev, o.body), { title: '작업 완료', body: '차트던전 07편', url: './#s=s1', tag: 'job-j1' });
  await ev('done'); assert.equal(sent.length, 1, '이미 끝난 작업은 다시 안 알림');
  await p.onEvent({ type: 'job', job: { id: 'j2', status: 'running' } }); await p.onEvent({ type: 'job', job: { id: 'j2', status: 'cancelled' } });
  assert.equal(sent.length, 1, '직접 중지는 조용히');
  await p.onEvent({ type: 'job', job: { id: 'j3', sessionId: 'rm-x-s9', status: 'running' }, machine: { name: '회사' } });
  await p.onEvent({ type: 'job', job: { id: 'j3', sessionId: 'rm-x-s9', status: 'failed', title: '렌더' }, machine: { name: '회사' } });
  assert.deepEqual(decrypt(dev, sent[1].o.body), { title: '작업 실패 · 회사', body: '렌더', url: './#s=rm-x-s9', tag: 'job-j3' });
  // 질문·승인: 새로 생긴 것만 한 번
  const prompt = { type: 'prompt', prompt: { id: 'p1', jobId: 'j1', kind: 'approval', title: '파일 지우기', status: 'pending' } };
  await p.onEvent(prompt, { titleOf, jobOf: () => ({ id: 'j1', sessionId: 's1' }) }); await p.onEvent(prompt, { titleOf });
  assert.equal(sent.length, 3);
  const m = decrypt(dev, sent[2].o.body);
  assert.equal(m.title, '승인을 기다려요'); assert.equal(m.body, '파일 지우기 · 차트던전 07편'); assert.equal(m.url, './#s=s1');
  assert.equal(sent[2].o.headers.Urgency, 'high');
  // 앱을 지웠거나 알림을 끈 기기(410)는 구독을 지운다
  status = 410;
  const r = await p.send({ title: 't' });
  assert.equal(r.length, 1); assert.equal(r[0].gone, true);
  assert.equal(p.list().length, 0);
  assert.equal(new Push({ file: path.join(temp, 's.json') }).list().length, 0, '파일에도 반영');
});
