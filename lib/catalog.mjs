// 공통 커맨드 · 서브 에이전트 · 스킬 목록
//  - 원본: ~/.ai-shared/commands/*.md, ~/.ai-shared/agents/*.md
//  - 스킬: ~/.claude/skills, ~/.codex/skills, ~/.agents/skills 의 <이름>/SKILL.md
//  - 설치: Claude Code(~/.claude/commands/hub/, ~/.claude/agents/hub-*.md), Codex(~/.codex/prompts/hub-*.md)
//    허브가 만든 파일만 덮어쓰고 지운다 (표식 MANAGED).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const MANAGED = '<!-- ai-hub:managed — 원본은 ~/.ai-shared 에 있음. 여기서 고치면 덮어써집니다 -->';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const CLAUDE_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
/** 허브 입력창에서 커맨드 이름으로 쓸 수 없는 것 */
export const RESERVED = new Set(['skill', 'agent', 'help']);

export function parseFrontmatter(text = '') {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([\w-]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[mm[1]] = v;
  }
  return { meta, body: m[2].trim() };
}

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const listMd = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md'); } catch { return []; } };

export function loadCommands(hubDir) {
  const dir = path.join(hubDir, 'commands');
  return listMd(dir).map((n) => {
    const name = n.replace(/\.md$/, '').toLowerCase();
    if (!NAME_RE.test(name) || RESERVED.has(name)) return null;
    const { meta, body } = parseFrontmatter(readText(path.join(dir, n)) || '');
    const mode = ['auto', 'claude', 'codex', 'both'].includes(meta.mode) ? meta.mode : null;
    return { name, description: meta.description || '', argumentHint: meta['argument-hint'] || '', mode, agent: meta.agent || null, body, file: path.join(dir, n) };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgents(hubDir) {
  const dir = path.join(hubDir, 'agents');
  return listMd(dir).map((n) => {
    const name = n.replace(/\.md$/, '').toLowerCase();
    if (!NAME_RE.test(name)) return null;
    const { meta, body } = parseFrontmatter(readText(path.join(dir, n)) || '');
    return {
      name, label: meta.label || name, description: meta.description || '',
      tool: ['claude', 'codex'].includes(meta.tool) ? meta.tool : 'auto',
      model: meta.model || 'auto', effort: meta.effort || 'auto',
      readonly: /^(true|yes|1)$/i.test(meta.readonly || ''),
      skills: (meta.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
      body, file: path.join(dir, n),
    };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

/** 스킬: 이름별로 합치고, 어느 도구에서 보이는지 표시. hubDir 이 있으면 두 PC 공유 스킬(~/.ai-shared/skills)을 먼저(shared 표시) */
export function loadSkills(hubDir = null) {
  const roots = [
    ...(hubDir ? [{ dir: path.join(hubDir, 'skills'), tool: 'shared' }] : []),
    { dir: path.join(HOME, '.claude', 'skills'), tool: 'claude' },
    { dir: path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'skills'), tool: 'codex' },
    { dir: path.join(HOME, '.agents', 'skills'), tool: 'codex' },
  ];
  const map = new Map();
  for (const { dir, tool } of roots) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('source-command-') || n.startsWith('.')) continue; // Claude 커맨드를 Codex용으로 옮긴 사본은 제외
      const file = path.join(dir, n, 'SKILL.md');
      const text = readText(file); if (text === null) continue;
      const { meta } = parseFrontmatter(text);
      const name = (meta.name || n).trim();
      const cur = map.get(name.toLowerCase()) || { name, description: String(meta.description || '').replace(/\s+/g, ' ').slice(0, 300), tools: new Set(), file, shared: false };
      if (tool === 'shared') { cur.shared = true; cur.tools.add('claude'); cur.tools.add('codex'); } else cur.tools.add(tool);
      // Claude 쪽은 Codex 스킬도 연결돼 있어 claude 에서도 보인다
      map.set(name.toLowerCase(), cur);
    }
  }
  return [...map.values()].map((s) => ({ ...s, tools: [...s.tools].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

export function catalog(hubDir) {
  return { commands: loadCommands(hubDir), agents: loadAgents(hubDir), skills: loadSkills(hubDir) };
}

/**
 * 두 PC 공유 스킬(2026-10-05 사용자 "chart reels 같은 스킬은 오딘에도 등록" → 2026-10-06 "모든 스킬은 다 공유 기억 폴더로 가게 해줘").
 * 모든 스킬의 원본은 ~/.ai-shared/skills/<이름>/ 하나다. 공유 기억과 함께 두 PC·드라이브에 맞춰지고,
 * 각 PC의 Claude(~/.claude/skills)·Codex(~/.agents/skills)에는 정션으로만 연결한다.
 *  - adoptLocalSkills: Claude·Codex 가 각자 폴더에 만든 스킬(정션 아닌 진짜 폴더)을 공유 폴더로 옮긴다.
 *    공유 폴더에 같은 이름이 이미 있으면 파일 단위로 합친다(없는 파일은 더하고, 다른 파일은 최근 것을 쓰고 밀린 판은 백업). 지우는 것 없음 —
 *    옮기고 남은 원래 폴더도 ~/.ai-shared/backups/skills/ (PC마다 따로, 맞추지 않음)로 옮겨 둔다.
 *    방금 만들고 있는 스킬(최근 settleMs 안에 바뀐 파일이 있음)은 다음 차례로 미룬다.
 *  - linkSharedSkills: 공유 스킬을 두 도구 폴더에 연결. 옛 위치(세 스킬 폴더)를 가리키거나 끊어진 연결은 공유 폴더로 다시 잇는다.
 *    source-command-*(Codex 가 Claude 커맨드를 가져와 만든 스킬)는 공유하되 Codex 쪽에만 잇는다.
 *  - 건드리지 않는 것: 이름이 . 으로 시작하는 폴더(Codex 내장 .system), SKILL.md 가 바로 안에 없는 폴더(Claude 앱의 계정 스킬 synced),
 *    세 스킬 폴더·공유 폴더가 아닌 다른 곳을 가리키는 연결.
 */
const codexOnly = (n) => n.startsWith('source-command-');
const skillRoots = (home = HOME, codexHome = null) => {
  const cx = codexHome || (home === HOME ? (process.env.CODEX_HOME || path.join(home, '.codex')) : path.join(home, '.codex'));
  return { claude: path.join(home, '.claude', 'skills'), agents: path.join(home, '.agents', 'skills'), codex: path.join(cx, 'skills') };
};
const lstatOf = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const linkOf = (p) => { try { return path.resolve(path.dirname(p), fs.readlinkSync(p).replace(/^\\\\\?\\/, '')); } catch { return null; } };
const inside = (p, dir) => !!p && (path.resolve(p).toLowerCase() + path.sep).startsWith(path.resolve(dir).toLowerCase() + path.sep);
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
function walkFiles(dir, rel = '', out = []) {
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name, full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walkFiles(full, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}
const newest = (dir) => walkFiles(dir).reduce((m, r) => { try { return Math.max(m, fs.statSync(path.join(dir, ...r.split('/'))).mtimeMs); } catch { return m; } }, 0);
const sameFile = (a, b) => { try { const x = fs.readFileSync(a), y = fs.readFileSync(b); return x.equals(y); } catch { return false; } };
function copyKeepTime(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  try { const st = fs.statSync(from); fs.utimesSync(to, st.atime, st.mtime); } catch {}
}
/** 폴더 옮기기: 같은 드라이브면 이름 바꾸기, 아니면 복사 뒤 원래 폴더를 백업으로(지우지 않음) */
function moveDir(from, to, backupDir) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  fs.mkdirSync(path.dirname(backupDir), { recursive: true });
  fs.renameSync(from, backupDir);
}

export function adoptLocalSkills(hubDir, { home = HOME, codexHome = null, settleMs = 60_000, now = Date.now() } = {}) {
  const src = path.join(hubDir, 'skills'), roots = skillRoots(home, codexHome);
  const backupRoot = path.join(hubDir, 'backups', 'skills', stampNow());
  const out = { moved: [], merged: [], waiting: [], failed: [] };
  fs.mkdirSync(src, { recursive: true });
  for (const [where, dir] of Object.entries(roots)) {
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const at = path.join(dir, n), st = lstatOf(at);
      if (!st || st.isSymbolicLink() || !st.isDirectory() || !fs.existsSync(path.join(at, 'SKILL.md'))) continue;
      if (now - newest(at) < settleMs) { out.waiting.push(n); continue; } // 아직 만드는 중일 수 있음
      const dest = path.join(src, n), keep = path.join(backupRoot, `${n}.${where}`);
      try {
        if (!fs.existsSync(dest)) { moveDir(at, dest, keep); out.moved.push(`${n} (${where})`); continue; }
        // 같은 이름이 이미 공유돼 있음: 파일 단위로 합친다
        let changed = 0;
        for (const r of walkFiles(at)) {
          const a = path.join(at, ...r.split('/')), b = path.join(dest, ...r.split('/'));
          if (!fs.existsSync(b)) { copyKeepTime(a, b); changed++; continue; }
          if (sameFile(a, b)) continue;
          if (fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs) { copyKeepTime(b, path.join(backupRoot, `${n}.shared`, ...r.split('/'))); copyKeepTime(a, b); changed++; }
        }
        fs.mkdirSync(backupRoot, { recursive: true });
        fs.renameSync(at, keep); // 합친 뒤 남은 이 PC 판은 백업으로
        out.merged.push(`${n} (${where}${changed ? ` · ${changed}개 파일 반영` : ' · 같음'})`);
      } catch (e) { out.failed.push(`${n} (${where}): ${e.code || e.message}`); } // 사용 중이면 다음 차례에 다시
    }
  }
  return out;
}

export function linkSharedSkills(hubDir, { home = HOME, codexHome = null } = {}) {
  const src = path.join(hubDir, 'skills'), out = { linked: [], kept: [], removed: [] };
  const roots = skillRoots(home, codexHome), local = Object.values(roots);
  const targets = [{ dir: roots.claude, tool: 'claude' }, { dir: roots.agents, tool: 'codex' }];
  const names = (() => { try { return fs.readdirSync(src).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(src, n, 'SKILL.md'))); } catch { return []; } })();
  const inSrc = (p) => inside(linkOf(p), src);
  for (const { dir, tool } of targets) {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      const at = path.join(dir, n), want = path.join(src, n), st = lstatOf(at);
      if (tool === 'claude' && codexOnly(n)) { if (st?.isSymbolicLink() && inSrc(at)) { fs.unlinkSync(at); out.removed.push(n); } continue; }
      if (st && !st.isSymbolicLink()) { out.kept.push(`${n} (${path.basename(path.dirname(dir))})`); continue; } // 아직 옮기지 못한 이 PC 판
      if (st && inSrc(at) && fs.existsSync(at)) continue;
      // 옛 위치(세 스킬 폴더 안)를 가리키거나 끊어진 연결은 공유 폴더로 다시 잇는다. 다른 곳을 가리키는 연결은 건드리지 않는다
      if (st && !inSrc(at) && fs.existsSync(at) && !local.some((d) => inside(linkOf(at), d))) { out.kept.push(`${n} (${path.basename(path.dirname(dir))})`); continue; }
      if (st) fs.unlinkSync(at);
      fs.symlinkSync(want, at, 'junction'); out.linked.push(n);
    }
    // 공유에서 빠진 스킬의 연결 정리(공유 폴더를 가리키는 연결만)
    for (const n of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
      const at = path.join(dir, n), st = lstatOf(at);
      if (st?.isSymbolicLink() && inSrc(at) && !names.includes(n)) { fs.unlinkSync(at); out.removed.push(n); }
    }
  }
  return out;
}

/** 옮기기 + 연결 한 번. 바뀐 게 있으면 changed */
export function syncSkillFolders(hubDir, opts = {}) {
  let adopt = null; try { adopt = adoptLocalSkills(hubDir, opts); } catch (e) { adopt = { error: String(e.message || e), moved: [], merged: [], waiting: [], failed: [] }; }
  const link = linkSharedSkills(hubDir, opts);
  const changed = !!(adopt.moved.length || adopt.merged.length || link.linked.length || link.removed.length);
  return { ...link, adopt, changed };
}

/** 커맨드 본문에 인자를 채운다 ($ARGUMENTS, $1~$9) */
export function expandTemplate(body, args = '') {
  const parts = String(args).trim().split(/\s+/).filter(Boolean);
  let out = String(body).replace(/\$ARGUMENTS/g, String(args).trim() || '(지정 없음)');
  out = out.replace(/\$([1-9])/g, (_, i) => parts[Number(i) - 1] || '');
  return out;
}

/**
 * 입력창 문장을 해석한다.
 *  /goal 목표        → { kind:'goal', text }
 *  /<커맨드> 인자     → { kind:'command', name, args, prompt, mode, agent }
 *  /<스킬> 인자       → { kind:'skill', name, args, prompt, tools }
 *  /skill <스킬> 인자 → 위와 같음
 *  @<에이전트> 할 일   → { kind:'agent', name, text }
 *  그 외              → null (일반 요청)
 */
export function parseInput(text, cat) {
  const t = String(text || '').trim();
  let m = t.match(/^@([a-z0-9-]+)\s*([\s\S]*)$/i);
  if (m) {
    const a = cat.agents.find((x) => x.name === m[1].toLowerCase() || x.label === m[1]);
    if (!a) throw httpError(400, `모르는 서브 에이전트: @${m[1]} (있는 것: ${cat.agents.map((x) => '@' + x.name).join(', ')})`);
    if (!m[2].trim()) throw httpError(400, `@${a.name} 뒤에 맡길 일을 적어 주세요`);
    return { kind: 'agent', name: a.name, text: m[2].trim() };
  }
  m = t.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  let name = m[1].toLowerCase(); let args = (m[2] || '').trim();
  if (name === 'goal') { if (!args) throw httpError(400, '/goal 뒤에 목표를 적어 주세요'); return { kind: 'goal', text: args }; }
  if (name === 'skill') { const mm = args.match(/^([\w.-]+)\s*([\s\S]*)$/); if (!mm) throw httpError(400, '/skill <스킬 이름> <할 일>'); name = mm[1].toLowerCase(); args = mm[2].trim(); return skillCall(name, args, cat, true); }
  const c = cat.commands.find((x) => x.name === name);
  if (c) return { kind: 'command', name, args, prompt: expandTemplate(c.body, args), mode: c.mode, agent: c.agent };
  return skillCall(name, args, cat, false);
}
function skillCall(name, args, cat, explicit) {
  const s = cat.skills.find((x) => x.name.toLowerCase() === name);
  if (!s) throw httpError(400, explicit ? `모르는 스킬: ${name}` : `모르는 커맨드: /${name}  (커맨드: ${cat.commands.map((c) => '/' + c.name).join(' ')}, /goal · 스킬은 /skill <이름>)`);
  const prompt = `[스킬 사용] "${s.name}" 스킬의 절차대로 처리하세요. 먼저 ${s.file} 를 읽고 그 지시를 따르세요.${s.description ? `\n스킬 설명: ${s.description}` : ''}\n\n할 일: ${args || '(스킬 설명에 맞게 기본 작업 수행)'}`;
  return { kind: 'skill', name: s.name, args, prompt, tools: s.tools };
}

/** 워커 프롬프트에 넣을 서브 에이전트 지시문 */
export function agentBrief(agent, skills = []) {
  if (!agent) return '';
  const sk = agent.skills.map((n) => skills.find((s) => s.name.toLowerCase() === n.toLowerCase())).filter(Boolean);
  return `# 맡은 역할: ${agent.label} (@${agent.name})
${agent.body}${agent.readonly ? '\n- 이 역할은 파일을 만들거나 고치지 않습니다(조사·보고만). 결과 파일을 쓰라는 지시가 있을 때만 예외.' : ''}${sk.length ? `\n- 시작 전에 다음 스킬 문서를 읽고 따르세요: ${sk.map((s) => `${s.name} (${s.file})`).join(', ')}` : ''}`;
}

// ---------------- CLI 에 설치 ----------------
function writeManaged(file, content, written) {
  const cur = readText(file);
  if (cur !== null && !cur.includes('ai-hub:managed')) return 'skip-user'; // 사용자가 직접 만든 파일은 건드리지 않음
  written.add(path.resolve(file).toLowerCase());
  if (cur === content) return 'same';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return 'write';
}
function cleanupManaged(dir, prefix, written) {
  let removed = 0;
  for (const n of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
    if (!n.startsWith(prefix) || !n.endsWith('.md')) continue;
    const f = path.join(dir, n);
    if (written.has(path.resolve(f).toLowerCase())) continue;
    const t = readText(f); if (t && t.includes('ai-hub:managed')) { fs.unlinkSync(f); removed++; }
  }
  return removed;
}
const fm = (obj) => `---\n${Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${/[:#"']/.test(String(v)) ? JSON.stringify(String(v)) : v}`).join('\n')}\n---\n`;

export function installToClis(hubDir, { home = HOME, codexHome = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
  // 잘못된 원본 경로로 기존 설치본을 지우지 않는다. 빈 원본의 동기화도 보류한다.
  for (const sub of ['commands', 'agents']) if (!fs.existsSync(path.join(hubDir, sub))) throw new Error(`공통 ${sub} 원본 폴더가 없어 설치를 건너뜁니다`);
  const cat = catalog(hubDir);
  if (!cat.commands.length && !cat.agents.length) throw new Error('공통 커맨드·에이전트 원본이 비어 있어 설치를 건너뜁니다');
  const claudeCmd = path.join(home, '.claude', 'commands', 'hub');
  const claudeAgents = path.join(home, '.claude', 'agents');
  const codexPrompts = path.join(codexHome, 'prompts');
  const written = new Set();
  const stat = { write: 0, same: 0, 'skip-user': 0, removed: 0 };
  for (const c of cat.commands) {
    stat[writeManaged(path.join(claudeCmd, `${c.name}.md`), `${fm({ description: c.description, 'argument-hint': c.argumentHint })}${c.body}\n\n${MANAGED}\n`, written)]++;
    stat[writeManaged(path.join(codexPrompts, `hub-${c.name}.md`), `${fm({ description: c.description, 'argument-hint': c.argumentHint })}${c.body}\n\n${MANAGED}\n`, written)]++;
  }
  for (const a of cat.agents) {
    const model = a.tool !== 'codex' && CLAUDE_MODELS.has(a.model) ? a.model : undefined;
    const body = agentBrief(a, cat.skills);
    stat[writeManaged(path.join(claudeAgents, `hub-${a.name}.md`), `${fm({ name: `hub-${a.name}`, description: `${a.label}: ${a.description}`, model })}${body}\n\n${MANAGED}\n`, written)]++;
    stat[writeManaged(path.join(codexPrompts, `hub-agent-${a.name}.md`), `${fm({ description: `${a.label} 역할로 처리: ${a.description}`, 'argument-hint': '<맡길 일>' })}${body}\n\n# 할 일\n$ARGUMENTS\n\n${MANAGED}\n`, written)]++;
  }
  stat.removed += cleanupManaged(claudeCmd, '', written);
  stat.removed += cleanupManaged(claudeAgents, 'hub-', written);
  stat.removed += cleanupManaged(codexPrompts, 'hub-', written);
  let shared = null; try { shared = syncSkillFolders(hubDir, { home, codexHome }); } catch (e) { shared = { error: String(e.message || e) }; }
  return { ...stat, commands: cat.commands.length, agents: cat.agents.length, skills: cat.skills.length, sharedSkills: cat.skills.filter((s) => s.shared).length, shared };
}

/** 원본 폴더가 바뀌면 다시 설치하고 알린다.
 *  Claude·Codex 스킬 폴더에 새 스킬이 생기면 공유 폴더로 옮긴다: 폴더 변화 + 1분마다 확인(방금 만드는 스킬은 1분 뒤에) */
export function watchCatalog(hubDir, onChange, { everyMs = 60_000 } = {}) {
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(() => { try { onChange(installToClis(hubDir)); } catch (e) { onChange({ error: String(e.message || e) }); } }, 400); };
  for (const sub of ['commands', 'agents', 'skills']) {
    const d = path.join(hubDir, sub); fs.mkdirSync(d, { recursive: true });
    try { fs.watch(d, kick); } catch {}
  }
  let s = null;
  const check = () => { try { if (syncSkillFolders(hubDir).changed) kick(); } catch {} };
  const soon = () => { clearTimeout(s); s = setTimeout(check, 5000); };
  for (const d of Object.values(skillRoots(HOME))) { try { fs.mkdirSync(d, { recursive: true }); fs.watch(d, soon); } catch {} }
  setInterval(check, everyMs).unref?.();
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
