// ODDIN 스튜디오 엔진 공용 설정 (2026-10-10 사용자 "오딘 내에 만드는 게 아니라 오딘과 연동(프리미어/애프터이펙트 플러그인처럼)되는 프로그램으로")
// 스튜디오 = ODDIN 저장소 안 studio/ 폴더의 따로 켜는 프로그램. 엔진(이 폴더, Node 22·의존성 없음)이 편집·렌더·글꼴·프리미어 가져오기를 맡고,
// 화면(studio/ui)은 엔진이 내주는 웹 페이지, 창(studio/app)은 Electron 껍데기다. ODDIN 허브와는 HTTP 로 이어진다(hub.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HUB_ROOT = path.resolve(STUDIO_DIR, '..');
export const UI_DIR = path.join(STUDIO_DIR, 'ui');
export const DATA_DIR = process.env.STUDIO_DATA_DIR ? path.resolve(process.env.STUDIO_DATA_DIR) : path.join(STUDIO_DIR, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(STUDIO_DIR, 'version.json'), 'utf8')).version; } catch { return '0.0.0'; } })();

/** 허브 설정(config.json)의 studio 칸 + 환경 변수. 시험은 STUDIO_PORT·ODDIN_HUB 로 바꾼다 */
export function loadConfig() {
  let hub = {};
  try { hub = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_FILE || path.join(HUB_ROOT, 'config.json'), 'utf8')); } catch {}
  const s = hub.studio || {};
  return {
    port: Number(process.env.STUDIO_PORT) || Number(s.port) || 7710,
    hubUrl: (process.env.ODDIN_HUB || `http://127.0.0.1:${Number(hub.port) || 7700}`).replace(/\/+$/, ''),
    video: { ...(hub.video || {}), ...(s.video || {}) },
    browser: { ...(hub.browser || {}), ...(s.browser || {}) },
  };
}
export const error = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
