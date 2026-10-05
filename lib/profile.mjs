// 사용자 프로필: 화면 왼쪽 아래 계정 칸의 이름·사진 (2026-10-05 사용자 "Heathcliff 로 유저 이름 바꾸고 프로필 사진 바꿔줘")
// PC마다 data/profile.json · data/profile-avatar.<확장자>. 비어 있으면 PC 사용자 이름과 첫 글자 동그라미를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, nowIso } from './util.mjs';

export const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const error = (status, message) => Object.assign(new Error(message), { status });

export class Profile {
  constructor({ dir }) { this.dir = dir; this.file = path.join(dir, 'profile.json'); }
  raw() { return readJson(this.file, {}) || {}; }
  avatarFile() {
    const r = this.raw(); if (!r.avatar) return null;
    const f = path.join(this.dir, r.avatar);
    return fs.existsSync(f) ? f : null;
  }
  read() {
    const r = this.raw(), f = this.avatarFile();
    return { name: r.name || '', avatar: f ? `/api/profile/avatar?v=${encodeURIComponent(r.avatarAt || '')}` : null, updatedAt: r.updatedAt || null };
  }
  setName(name) {
    const n = String(name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
    writeJsonAtomic(this.file, { ...this.raw(), name: n, updatedAt: nowIso() });
    return this.read();
  }
  setAvatar(buf, type) {
    const ext = AVATAR_TYPES[String(type || '').split(';')[0].trim().toLowerCase()];
    if (!ext) throw error(415, '사진은 PNG·JPG·WEBP·GIF·SVG 만 쓸 수 있어요');
    if (!buf?.length) throw error(400, '사진이 비어 있어요');
    if (buf.length > 3 * 1024 * 1024) throw error(413, '사진은 3MB 이하만 쓸 수 있어요');
    if (ext === 'svg' && !/<svg[\s>]/i.test(buf.toString('utf8', 0, 4096))) throw error(400, 'SVG 그림이 아니에요');
    const old = this.avatarFile();
    const name = `profile-avatar.${ext}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), buf);
    if (old && path.basename(old) !== name) fs.rmSync(old, { force: true });
    const at = nowIso();
    writeJsonAtomic(this.file, { ...this.raw(), avatar: name, avatarType: Object.keys(AVATAR_TYPES).find((k) => AVATAR_TYPES[k] === ext), avatarAt: at, updatedAt: at });
    return this.read();
  }
  clearAvatar() {
    const old = this.avatarFile(); if (old) fs.rmSync(old, { force: true });
    const { avatar, avatarType, avatarAt, ...rest } = this.raw();
    writeJsonAtomic(this.file, { ...rest, updatedAt: nowIso() });
    return this.read();
  }
  /** 사진 보내기. SVG 안의 스크립트가 허브 주소로 실행되지 않게 sandbox */
  serveAvatar(res) {
    const f = this.avatarFile(); if (!f) throw error(404, '프로필 사진이 없어요');
    const type = this.raw().avatarType || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    const stream = fs.createReadStream(f);
    stream.on('error', () => res.destroy?.()); // 보내는 중에 지워져도 서버는 멈추지 않게
    stream.pipe(res);
  }
}
