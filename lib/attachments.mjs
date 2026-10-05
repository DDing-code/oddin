// 이미지 첨부: 업로드 검증·저장·조회
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './util.mjs';

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// maxSide·maxBytes 는 AI(Claude)가 받는 이미지 한도. 긴 이미지는 화면(public/image-split.js)이 여러 장으로 나눠 올려서 장수를 넉넉히 둔다
export const LIMITS = { maxBytes: 5 * 1024 * 1024, maxCount: 24, maxSide: 8000 };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** 파일 서명으로 형식 판별 (확장자·Content-Type 신뢰 안 함) */
export function sniff(buf) {
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2; // SOF 마커에서 크기 읽기
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 6).match(/^GIF8[79]a$/)) return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', width: null, height: null };
  return null;
}

export function saveUpload(buf, originalName = '') {
  if (!buf.length) throw httpError(400, '빈 파일입니다');
  if (buf.length > LIMITS.maxBytes) throw httpError(413, `이미지는 ${LIMITS.maxBytes / 1024 / 1024}MB 이하만 가능합니다`);
  const info = sniff(buf);
  if (!info) throw httpError(415, 'PNG, JPEG, GIF, WebP 이미지만 첨부할 수 있습니다');
  if ((info.width && info.width > LIMITS.maxSide) || (info.height && info.height > LIMITS.maxSide)) throw httpError(422, `이미지 한 변은 ${LIMITS.maxSide}px 이하여야 합니다 (ODDIN 화면에서 첨부하면 긴 이미지는 자동으로 나눠 붙여요)`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}.${EXT[info.mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
  const name = path.basename(String(originalName || '').replace(/\\/g, '/')).slice(0, 120) || id;
  return { id, name, mime: info.mime, size: buf.length, width: info.width, height: info.height };
}

const ID_RE = /^[a-z0-9]+-[a-f0-9]{10}\.(png|jpg|gif|webp)$/;
export function uploadPath(id) {
  if (!ID_RE.test(id)) return null;
  const p = path.join(UPLOAD_DIR, id);
  return fs.existsSync(p) ? p : null;
}

/** 작업 생성 시 첨부 목록 검증 → 내부용 {id,name,mime,size,path} */
export function resolveAttachments(list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > LIMITS.maxCount) throw httpError(400, `이미지는 한 번에 ${LIMITS.maxCount}장까지 첨부할 수 있습니다`);
  return list.map((a) => {
    const id = typeof a === 'string' ? a : a?.id;
    const p = uploadPath(String(id || ''));
    if (!p) throw httpError(400, `첨부 이미지를 찾을 수 없습니다: ${id}`);
    const buf = fs.readFileSync(p);
    const info = sniff(buf);
    return { id, name: (typeof a === 'object' && a.name) ? String(a.name).slice(0, 120) : id, mime: info?.mime || 'image/png', size: buf.length, path: p };
  });
}

export const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
