// 허브 목록 저장·주소 검사·세션 요약 (Electron 없이 시험할 수 있는 순수 로직)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCAL_ID = 'local';
const MAX_SESSIONS = 30;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ID_RE = /^[\w-]{1,80}$/;

const fail = (msg) => { throw new Error(msg); };

/**
 * 원격 허브 주소 검사. 이 PC 허브(루프백 http)와 Tailscale 주소(https://*.ts.net)만 받는다.
 * 경로·쿼리는 버리고 origin 만 남긴다.
 */
function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) fail('주소를 입력해 주세요');
  if (s.length > 300) fail('주소가 너무 길어요');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { fail('주소 형식이 올바르지 않아요'); }
  if (u.username || u.password) fail('주소에 계정 정보를 넣을 수 없어요');
  const host = u.hostname.toLowerCase();
  const loop = LOOPBACK.has(host) || LOOPBACK.has(`[${host}]`);
  if (u.protocol === 'http:' && !loop) fail('원격 허브는 https 주소만 쓸 수 있어요 (예: https://기기이름.tailnet이름.ts.net)');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('http 또는 https 주소만 쓸 수 있어요');
  if (!loop && !host.endsWith('.ts.net')) fail('원격 허브는 Tailscale 주소(…ts.net)만 쓸 수 있어요');
  return u.origin;
}

function originOf(url) { try { return new URL(url).origin; } catch { return null; } }

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function cleanName(name, fallback) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return n || fallback;
}
function defaultName(url) {
  try { const h = new URL(url).hostname; return LOOPBACK.has(h) ? '이 PC' : h.split('.')[0]; } catch { return '허브'; }
}

/** 저장 파일을 읽고, 이 PC 허브가 항상 첫 번째로 있게 맞춘다. */
function loadState(file, { localUrl }) {
  const raw = readJson(file, {}) || {};
  const hubs = [];
  const seen = new Set();
  const local = { id: LOCAL_ID, name: '이 PC', url: normalizeUrl(localUrl), local: true };
  const savedLocal = Array.isArray(raw.hubs) ? raw.hubs.find((h) => h && h.id === LOCAL_ID) : null;
  if (savedLocal?.name) local.name = cleanName(savedLocal.name, '이 PC');
  hubs.push(local); seen.add(local.url);
  for (const h of Array.isArray(raw.hubs) ? raw.hubs : []) {
    if (!h || h.id === LOCAL_ID || !ID_RE.test(String(h.id || ''))) continue;
    let url;
    try { url = normalizeUrl(h.url); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    hubs.push({ id: h.id, name: cleanName(h.name, defaultName(url)), url, local: false });
  }
  const current = hubs.some((h) => h.id === raw.current) ? raw.current : LOCAL_ID;
  return { current, hubs };
}
function saveState(file, state) {
  writeJsonAtomic(file, { current: state.current, hubs: state.hubs.map(({ id, name, url, local }) => ({ id, name, url, local: !!local })) });
}

function hubById(state, id) { return state.hubs.find((h) => h.id === id) || null; }

function addHub(state, { name, url }) {
  const origin = normalizeUrl(url);
  if (state.hubs.some((h) => h.url === origin)) fail('이미 등록된 허브예요');
  if (state.hubs.length >= 20) fail('허브는 20개까지 등록할 수 있어요');
  const hub = { id: `h-${crypto.randomBytes(5).toString('hex')}`, name: cleanName(name, defaultName(origin)), url: origin, local: false };
  state.hubs.push(hub);
  return hub;
}
function renameHub(state, id, name) {
  const hub = hubById(state, id) || fail('없는 허브예요');
  const n = cleanName(name, '');
  if (!n) fail('이름을 입력해 주세요');
  hub.name = n;
  return hub;
}
function removeHub(state, id) {
  const hub = hubById(state, id) || fail('없는 허브예요');
  if (hub.local) fail('이 PC 허브는 등록 해제할 수 없어요');
  state.hubs = state.hubs.filter((h) => h.id !== id);
  if (state.current === id) state.current = LOCAL_ID;
}

/** 원격 허브의 /api/sessions 응답을 화면에 필요한 필드만 남겨 최근 순으로 줄인다. */
function summarizeSessions(list) {
  if (!Array.isArray(list)) return [];
  return list
    // 다른 PC 세션 사본(실행 PC 고르기로 비춘 것, machine·rm- id)은 빼고 그 허브 자신의 세션만
    .filter((s) => s && ID_RE.test(String(s.id || '')) && !s.machine && !String(s.id).startsWith('rm-'))
    .map((s) => ({
      id: String(s.id),
      title: String(s.title || '새 세션').slice(0, 120),
      cwd: String(s.cwd || '').slice(0, 400),
      updatedAt: String(s.updatedAt || s.createdAt || ''),
      status: String(s.status || 'empty').slice(0, 20),
      pinned: !!s.pinned,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SESSIONS);
}

/** 창에 띄울 주소. 세션 ID 는 형식 검사 후 #s= 로 붙인다 (허브 화면이 시작 시 읽음). */
function hubPageUrl(hub, sessionId) {
  const base = `${hub.url}/`;
  if (!sessionId) return base;
  if (!ID_RE.test(String(sessionId))) fail('세션 ID 형식이 올바르지 않아요');
  return `${base}#s=${sessionId}`;
}

/** 이 주소가 등록된 허브 화면인지 (연결 객체를 쓸 수 있는 화면인지) */
function isHubOrigin(state, url) {
  const o = originOf(url);
  return !!o && state.hubs.some((h) => h.url === o);
}

/** /api/status 응답이 AI Hub 의 것인지 대략 확인 */
function looksLikeHub(status) {
  return !!status && typeof status === 'object' && typeof status.config === 'object' && status.config !== null && 'tools' in status;
}

/** 원격 게이트 오류 코드를 사람이 읽을 문장으로 */
function explainHttpError(status, body) {
  const msg = body && typeof body.error === 'string' ? body.error : '';
  if (status === 421) return '이 주소는 상대 허브의 허용 목록에 없어요. 상대 PC에서 원격 접속을 다시 켜 주세요';
  if (status === 403) return msg ? `상대 허브가 거절했어요: ${msg}` : '상대 허브가 거절했어요 (원격 접속이 꺼져 있거나 허용되지 않은 계정)';
  if (status === 404) return 'AI Hub 가 아닌 주소예요';
  return msg || `상대 허브 응답 오류 (${status})`;
}

module.exports = {
  LOCAL_ID, MAX_SESSIONS,
  normalizeUrl, originOf, readJson, writeJsonAtomic,
  loadState, saveState, hubById, addHub, renameHub, removeHub,
  summarizeSessions, hubPageUrl, isHubOrigin, looksLikeHub, explainHttpError,
};
