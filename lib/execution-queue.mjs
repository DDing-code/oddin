import fs from 'node:fs';
import path from 'node:path';

export function workspaceKey(dir) {
  let key; try { key = fs.realpathSync.native(dir); } catch { key = path.resolve(dir); }
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
const contains = (a, b) => a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
const overlaps = (a, b) => a && b && (contains(a, b) || contains(b, a));

// 하나는 전체 CLI 슬롯, 하나는 폴더별 쓰기 순서에 사용한다. 별도 프로세스·서비스 없음.
export class ExecutionQueue {
  constructor(limit = Infinity) { this.limit = limit; this.active = new Set(); this.pending = []; }
  acquire({ owner, folder = null, priority = 0 } = {}) {
    return new Promise((resolve) => { this.pending.push({ owner, folder, priority, resolve }); this.pending.sort((a, b) => a.priority - b.priority); this.drain(); });
  }
  cancel(owner) {
    const cancelled = this.pending.filter((x) => owner === undefined || x.owner === owner);
    this.pending = this.pending.filter((x) => !cancelled.includes(x));
    for (const x of cancelled) x.resolve(null);
  }
  drain() {
    for (const x of [...this.pending]) {
      if (this.active.size >= this.limit) break;
      if ([...this.active].some((a) => overlaps(a.folder, x.folder))) continue;
      this.pending.splice(this.pending.indexOf(x), 1); this.active.add(x);
      x.resolve(() => { if (this.active.delete(x)) this.drain(); });
    }
  }
}
