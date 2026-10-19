import fs from 'node:fs';
import path from 'node:path';

export function workspaceKey(dir) {
  let key; try { key = fs.realpathSync.native(dir); } catch { key = path.resolve(dir); }
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
const contains = (a, b) => a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
export const overlaps = (a, b) => a && b && (contains(a, b) || contains(b, a));

// 하나는 전체 CLI 슬롯, 하나는 폴더별 쓰기 순서에 사용한다. 별도 프로세스·서비스 없음.
// 폴더 순서(2026-10-19 회사 PC: D:\YM_Inv 에서 다른 세션의 1시간짜리 영상 작업 뒤에 압축 요청이 47분 기다리다 취소됨):
// - group(세션) + shared: 둘 다 shared 이고 group 이 다르면 같은 폴더여도 함께 돈다(변경 기록을 못 남기는 큰 폴더 — jobs.runScheduled)
// - force(owner): 사용자가 "기다리지 않고 시작"을 누르면 그 요청은 겹쳐도 바로 시작
// - onWait(blockers): 기다려야 하면(앞을 막는 것이 바뀔 때마다) 막고 있는 owner 목록을 알린다
export class ExecutionQueue {
  constructor(limit = Infinity) { this.limit = limit; this.active = new Set(); this.pending = []; }
  acquire({ owner, folder = null, priority = 0, group = null, shared = false, onWait = null } = {}) {
    return new Promise((resolve) => {
      this.pending.push({ owner, folder, priority, group, shared, onWait, resolve, blockedBy: '' });
      this.pending.sort((a, b) => a.priority - b.priority); this.drain();
    });
  }
  cancel(owner) {
    const cancelled = this.pending.filter((x) => owner === undefined || x.owner === owner);
    this.pending = this.pending.filter((x) => !cancelled.includes(x));
    for (const x of cancelled) x.resolve(null);
  }
  /** 기다리는 요청을 겹쳐도 바로 시작시킨다. 기다리던 것이 있었으면 true */
  force(owner) {
    const x = this.pending.find((p) => p.owner === owner); if (!x) return false;
    x.forced = true; this.drain(); return true;
  }
  /** x 를 막고 있는 실행 중인 것들 */
  blockers(x) {
    if (x.forced) return [];
    return [...this.active].filter((a) => overlaps(a.folder, x.folder) && !(a.shared && x.shared && a.group !== x.group));
  }
  drain() {
    for (const x of [...this.pending]) {
      if (this.active.size >= this.limit) break;
      const by = this.blockers(x);
      if (by.length) {
        const key = by.map((a) => a.owner).join(',');
        if (key !== x.blockedBy) { x.blockedBy = key; try { x.onWait?.(by.map((a) => a.owner)); } catch {} }
        continue;
      }
      this.pending.splice(this.pending.indexOf(x), 1); this.active.add(x);
      x.resolve(() => { if (this.active.delete(x)) this.drain(); });
    }
  }
}
