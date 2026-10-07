import fs from 'node:fs';

// 바이트 위치로 뒤에서 읽는다. 큰 실행 기록도 화면 요청 한 번에 최대 2MiB만 읽는다.
export function readLogPage(file, { before, limit = 200 } = {}) {
  limit = Math.floor(Math.min(500, Math.max(1, Number(limit) || 200)));
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (e) { if (e.code === 'ENOENT') return { entries: [], nextBefore: null }; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = before == null ? size : Math.floor(Math.min(size, Math.max(0, Number(before) || 0)));
    const chunks = []; let bytes = 0, lines = 0;
    while (pos > 0 && lines <= limit && bytes < 2 * 1024 * 1024) {
      const count = Math.min(pos, 65536); pos -= count;
      const b = Buffer.alloc(count); fs.readSync(fd, b, 0, count, pos);
      chunks.unshift(b); bytes += count;
      for (const x of b) if (x === 10) lines++;
    }
    const data = Buffer.concat(chunks), rows = [];
    let start = pos ? data.indexOf(10) + 1 : 0;
    for (let i = start; i <= data.length; i++) if (i === data.length || data[i] === 10) {
      if (i > start) { try { rows.push({ at: pos + start, entry: JSON.parse(data.toString('utf8', start, i)) }); } catch {} }
      start = i + 1;
    }
    const page = rows.slice(-limit), next = page[0]?.at ?? pos;
    return { entries: page.map((x) => x.entry), nextBefore: next > 0 ? next : null };
  } finally { fs.closeSync(fd); }
}
