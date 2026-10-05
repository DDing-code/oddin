// 공유 기억 훅 설치 (2026-10-05 집·회사 PC 두 대): 새 PC의 Claude Code·Codex 가 ~/.ai-shared 공유 기억을 쓰게 한다.
// 집 PC와 같은 훅(세션 시작·끝 sync.mjs, 매 메시지 memory-check.mjs)과 CLAUDE.md 불러오기 줄을 빠진 것만 더한다.
// 고치기 전 원본은 같은 폴더에 .bak-oddin-<시각> 으로 남긴다. ODDIN 작업자는 훅이 없어도 공유 기억을 직접 읽는다(memoryFor).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fwd = (p) => p.replace(/\\/g, '/');
const readJsonFile = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code === 'ENOENT') return {}; throw Object.assign(new Error(`${file} 을 읽지 못했어요: ${e.message}`), { status: 500 }); } };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function plan(hubDir, home) {
  const sync = fwd(path.join(hubDir, 'sync', 'sync.mjs')), check = fwd(path.join(hubDir, 'sync', 'memory-check.mjs'));
  return {
    ready: fs.existsSync(path.join(hubDir, 'sync', 'sync.mjs')) && fs.existsSync(path.join(hubDir, 'sync', 'memory-check.mjs')),
    claude: {
      file: path.join(home, '.claude', 'settings.json'),
      hooks: [
        { event: 'SessionStart', match: (c) => c.includes('sync.mjs') && !c.includes('--quiet'), entry: { hooks: [{ type: 'command', command: `node "${sync}"`, timeout: 30 }] } },
        { event: 'UserPromptSubmit', match: (c) => c.includes('memory-check.mjs'), entry: { hooks: [{ type: 'command', command: `node "${check}"`, timeout: 5 }] } },
        { event: 'Stop', match: (c) => c.includes('sync.mjs') && c.includes('--quiet'), entry: { hooks: [{ type: 'command', command: `node "${sync}" --quiet`, timeout: 30 }] } },
      ],
    },
    codex: {
      file: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
      hooks: [
        { event: 'SessionStart', match: (c) => c.includes('sync.mjs') && !c.includes('--quiet'), entry: { matcher: 'startup|resume', hooks: [{ type: 'command', command: `node "${sync}"`, timeout: 30, statusMessage: 'Claude↔Codex 공유 동기화' }] } },
        { event: 'UserPromptSubmit', match: (c) => c.includes('memory-check.mjs'), entry: { hooks: [{ type: 'command', command: `node "${check}" --codex`, timeout: 5, statusMessage: '공유 메모리 확인' }] } },
        { event: 'Stop', match: (c) => c.includes('sync.mjs') && c.includes('--quiet'), entry: { hooks: [{ type: 'command', command: `node "${sync}" --quiet`, timeout: 30 }] } },
      ],
    },
    // 이 PC 전용 지침(AGENTS.local.md, 맞추지 않음)도 불러온다. 이미 ~/.codex/AGENTS.md 를 불러오고 있으면 그 안의 LOCAL 블록으로 들어가므로 따로 넣지 않는다
    claudeMd: { file: path.join(home, '.claude', 'CLAUDE.md'), lines: ['@~/.ai-shared/AGENTS.md', '@~/.ai-shared/memory/global/MEMORY.md', { line: '@~/.ai-shared/AGENTS.local.md', alt: /^@.*[\\/]\.codex[\\/]AGENTS\.md$/i }] },
  };
}
export const LOCAL_FILE = (hubDir) => path.join(hubDir, 'AGENTS.local.md');
/** 이 PC 전용 지침(다른 PC와 맞추지 않음) */
export function readLocalInstructions(hubDir) {
  const file = LOCAL_FILE(hubDir);
  let content = ''; let exists = false; try { content = fs.readFileSync(file, 'utf8'); exists = true; } catch {}
  return { file, exists, content };
}
/** 이 PC 전용 지침 저장: 원래 판은 backups/local-instructions/ 에 두고, sync.mjs 를 한 번 돌려 Codex 지침 사본에 바로 반영 */
export function writeLocalInstructions(hubDir, content, { runSync = true } = {}) {
  const text = String(content ?? '');
  if (text.length > 200_000) throw Object.assign(new Error('지침이 너무 길어요'), { status: 413 });
  const file = LOCAL_FILE(hubDir);
  if (fs.existsSync(file)) { const dir = path.join(hubDir, 'backups', 'local-instructions'); fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(file, path.join(dir, `AGENTS.local-${stamp()}.md`)); }
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
  let sync = null;
  if (runSync && fs.existsSync(path.join(hubDir, 'sync', 'sync.mjs'))) {
    const r = spawnSync(process.execPath, [path.join(hubDir, 'sync', 'sync.mjs')], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    sync = { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim().slice(0, 2000) };
  }
  return { ...readLocalInstructions(hubDir), sync };
}
const commandsOf = (list) => (Array.isArray(list) ? list : []).flatMap((e) => (e?.hooks || []).map((h) => String(h?.command || '')));
function missingHooks(spec) {
  const data = readJsonFile(spec.file);
  return { data, missing: spec.hooks.filter((h) => !commandsOf(data.hooks?.[h.event]).some(h.match)) };
}
function missingLines(spec) {
  let text = ''; try { text = fs.readFileSync(spec.file, 'utf8'); } catch {}
  const have = text.split(/\r?\n/).map((x) => x.trim());
  return { text, missing: spec.lines.filter((l) => !(typeof l === 'string' ? have.includes(l) : have.includes(l.line) || have.some((x) => l.alt?.test(x)))).map((l) => (typeof l === 'string' ? l : l.line)) };
}

/** 이 PC의 공유 기억 연결 상태 */
export function setupStatus(hubDir, home = os.homedir()) {
  const p = plan(hubDir, home);
  const claude = missingHooks(p.claude).missing.map((h) => h.event), codex = missingHooks(p.codex).missing.map((h) => h.event), md = missingLines(p.claudeMd).missing;
  const local = readLocalInstructions(hubDir);
  return { ready: p.ready, claude: { ok: !claude.length, missing: claude }, codex: { ok: !codex.length, missing: codex }, claudeMd: { ok: !md.length, missing: md }, done: p.ready && !claude.length && !codex.length && !md.length,
    local: { file: local.file, exists: local.exists, chars: local.content.length, content: local.content } };
}

/** 빠진 훅·줄만 더한다. 공유 기억(sync 스크립트)이 아직 이 PC에 없으면 거절 */
export function installSharedHooks(hubDir, { home = os.homedir(), runSync = true } = {}) {
  const p = plan(hubDir, home);
  if (!p.ready) throw Object.assign(new Error('공유 기억이 아직 이 PC에 없어요. 연결된 PC와 먼저 맞춰 주세요'), { status: 409 });
  const changed = [];
  for (const [name, spec] of [['Claude', p.claude], ['Codex', p.codex]]) {
    const { data, missing } = missingHooks(spec);
    if (!missing.length) continue;
    if (fs.existsSync(spec.file)) fs.copyFileSync(spec.file, `${spec.file}.bak-oddin-${stamp()}`);
    data.hooks ||= {};
    for (const h of missing) (data.hooks[h.event] ||= []).push(h.entry);
    fs.mkdirSync(path.dirname(spec.file), { recursive: true });
    fs.writeFileSync(spec.file, JSON.stringify(data, null, 2) + '\n');
    changed.push(`${name} 훅 ${missing.map((h) => h.event).join('·')}`);
  }
  const md = missingLines(p.claudeMd);
  if (md.missing.length) {
    if (fs.existsSync(p.claudeMd.file)) fs.copyFileSync(p.claudeMd.file, `${p.claudeMd.file}.bak-oddin-${stamp()}`);
    fs.mkdirSync(path.dirname(p.claudeMd.file), { recursive: true });
    // 공유 불러오기 줄이 이미 있으면 그 바로 아래에 넣고(제목을 또 만들지 않게), 없으면 끝에 제목과 함께
    const lines = md.text.split(/\r?\n/), known = p.claudeMd.lines.map((l) => (typeof l === 'string' ? l : l.line));
    const last = lines.reduce((at, l, i) => (known.includes(l.trim()) ? i : at), -1);
    if (last >= 0) { lines.splice(last + 1, 0, ...md.missing); fs.writeFileSync(p.claudeMd.file, lines.join(md.text.includes('\r\n') ? '\r\n' : '\n')); }
    else fs.writeFileSync(p.claudeMd.file, md.text + `${md.text && !md.text.endsWith('\n') ? '\n' : ''}${md.text ? '\n' : ''}# 공용 지침 · 메모리 (Claude Code ↔ Codex 공유, ODDIN이 추가)\n${md.missing.join('\n')}\n`);
    changed.push('CLAUDE.md 공유 지침·메모리 불러오기');
  }
  // 한 번 돌려 메모리 정션·Codex 지침 사본을 바로 맞춘다
  let sync = null;
  if (runSync) {
    const r = spawnSync(process.execPath, [path.join(hubDir, 'sync', 'sync.mjs')], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    sync = { ok: r.status === 0, output: String(r.stdout || r.stderr || '').trim().slice(0, 2000) };
  }
  return { changed, sync, status: setupStatus(hubDir, home) };
}
