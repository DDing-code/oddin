// 폴더를 ZIP 으로 바로 내려받기 (2026-10-06 사용자 "원격에서도 … 파일 우클릭 누르면 다운로드").
// 의존성 없이 "저장(압축 안 함)" 방식 ZIP 을 응답으로 흘려보낸다. 결과물 폴더는 대개 그림·PDF·영상이라 압축 이득이 작고,
// 저장 방식이면 어떤 압축 풀기 도구(Windows 탐색기·macOS·아이폰 파일 앱·7-Zip)에서도 열린다.
// - 파일마다 CRC 를 먼저 읽어 계산한 뒤 머리·내용을 쓴다(데이터 설명자 없이 — 가장 호환이 잘 되는 형식).
// - 이름은 UTF-8 표시(한글 파일 이름). ZIP64 는 쓰지 않으므로 합계 3.9GB·65000개까지(넘으면 413).
// - .git·node_modules 와 링크·정션은 넣지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const error = (status, message) => Object.assign(new Error(message), { status });
export const ZIP_LIMITS = { maxBytes: 3.9 * 1024 ** 3, maxFiles: 65000 };
const SKIP_DIRS = new Set(['.git', 'node_modules']);

let TABLE = null;
function crcUpdate(buf, crc) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc);
  if (!TABLE) { TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; } }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 넣을 파일 목록과 합계. 한도를 넘으면 413 */
export function planZip(dir, limits = ZIP_LIMITS) {
  const entries = []; let total = 0;
  const walk = (d, rel) => {
    let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of list) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, r); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      total += st.size;
      if (entries.length >= limits.maxFiles || total > limits.maxBytes) throw error(413, `폴더가 너무 커서 한 번에 받을 수 없어요(ZIP 은 ${Math.floor(limits.maxBytes / 1024 ** 3 * 10) / 10}GB·${limits.maxFiles}개까지). 안쪽 폴더나 파일을 골라 받아 주세요`);
      entries.push({ rel: r, full, size: st.size, mtime: st.mtime });
    }
  };
  walk(dir, '');
  return { entries, total };
}

function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const CHUNK = 1024 * 1024;
async function crcOf(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: CHUNK })) crc = crcUpdate(chunk, crc);
  return crc >>> 0;
}
function write(out, buf) {
  return new Promise((resolve, reject) => {
    if (out.destroyed || out.writableEnded) return reject(error(499, '받는 쪽이 연결을 끊었어요'));
    if (out.write(buf)) return resolve();
    const done = () => { out.off('drain', done); out.off('close', gone); resolve(); };
    const gone = () => { out.off('drain', done); reject(error(499, '받는 쪽이 연결을 끊었어요')); };
    out.once('drain', done); out.once('close', gone);
  });
}
async function pipeFile(file, out) {
  for await (const chunk of fs.createReadStream(file, { highWaterMark: CHUNK })) await write(out, chunk);
}

/** 계획한 파일들을 ZIP 으로 out(쓰기 흐름)에 쓴다. 끝내지는(end) 않는다 */
export async function writeZip(entries, out) {
  const central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.rel, 'utf8'), { time, date } = dosTime(e.mtime);
    const crc = await crcOf(e.full);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(e.size, 18); h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    await write(out, Buffer.concat([h, name]));
    await pipeFile(e.full, out);
    central.push({ name, crc, size: e.size, time, date, offset });
    offset += 30 + name.length + e.size;
  }
  const cdStart = offset; const parts = [];
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36); h.writeUInt32LE(0, 38); h.writeUInt32LE(c.offset, 42);
    parts.push(h, c.name); offset += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16); end.writeUInt16LE(0, 20);
  parts.push(end);
  await write(out, Buffer.concat(parts));
}

/** 만들어질 ZIP 크기(응답 Content-Length — 받는 쪽에 진행률이 보이게) */
export function zipSize(entries) {
  let n = 22;
  for (const e of entries) { const len = Buffer.byteLength(e.rel, 'utf8'); n += 30 + len + e.size + 46 + len; }
  return n;
}

/** 내려받기 응답 머리의 파일 이름(한글은 filename*, 옛 프로그램용 ASCII 이름도 함께) */
export function attachment(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
