// 파일 열기·보기 범위 (2026-10-05 사용자 요구 "모든 폴더 스캔 권한을 설정할 수 있게 권한에 추가")
//  - 기본: 허브가 아는 폴더(작업 공간·허브·세션 폴더·작업이 실제로 실행된 폴더·프로젝트·드라이브 폴더)만
//  - 모든 폴더(allowAll): 이 PC의 모든 드라이브. 입력창 아래 "권한" 메뉴에서 켜고 끈다(PC마다 따로, data/file-access.json)
// 열기(탐색기·기본 프로그램)·허브 안 보기·결과 페이지 보기(/view/)·폴더 목록이 같은 범위를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, nowIso } from './util.mjs';

export class FileAccess {
  constructor({ file }) { this.file = file; this.cache = null; }
  read() {
    if (!this.cache) this.cache = readJson(this.file, {}) || {};
    return { allowAll: this.cache.allowAll === true, updatedAt: this.cache.updatedAt || null };
  }
  save({ allowAll } = {}) {
    this.cache = { allowAll: allowAll === true, updatedAt: nowIso() };
    writeJsonAtomic(this.file, this.cache);
    return this.read();
  }
}

let drives = { at: 0, list: [] };
/** 이 PC에 있는 드라이브 루트(C:\ D:\ …). 1분 동안 기억한다 */
export function driveRoots() {
  if (Date.now() - drives.at < 60_000) return drives.list;
  const list = process.platform === 'win32'
    ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((r) => { try { return fs.existsSync(r); } catch { return false; } })
    : [path.parse(process.cwd()).root];
  drives = { at: Date.now(), list };
  return list;
}

/** 허용 폴더 목록: 아는 폴더(중복 제거) + 모든 폴더를 허용했으면 드라이브 루트 */
export function fileRoots(known, { allowAll = false } = {}) {
  const seen = new Set(), out = [];
  for (const r of [...known, ...(allowAll ? driveRoots() : [])]) {
    if (!r || typeof r !== 'string') continue;
    const k = path.resolve(r).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out;
}
