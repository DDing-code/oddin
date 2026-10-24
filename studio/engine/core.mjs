// 공용 코어(ui/video-core.js)를 엔진에서 읽기 — 편집기 화면·렌더 페이지와 같은 코드(vm). edit.mjs·fx.mjs·audio-mix.mjs 가 함께 쓴다
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { UI_DIR } from './env.mjs';

let CORE = null;
export function core() {
  if (!CORE) {
    const ctx = { console, Math, JSON, Date };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(UI_DIR, 'video-core.js'), 'utf8'), ctx, { filename: 'video-core.js' });
    CORE = ctx.OddinVideo;
  }
  return CORE;
}
export const plain = (v) => JSON.parse(JSON.stringify(v)); // vm 안에서 만든 객체를 이쪽 객체로
