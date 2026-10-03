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

/** 스킬: 이름별로 합치고, 어느 도구에서 보이는지 표시 */
export function loadSkills() {
  const roots = [
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
      const cur = map.get(name.toLowerCase()) || { name, description: String(meta.description || '').replace(/\s+/g, ' ').slice(0, 300), tools: new Set(), file };
      cur.tools.add(tool);
      // Claude 쪽은 Codex 스킬도 연결돼 있어 claude 에서도 보인다
      map.set(name.toLowerCase(), cur);
    }
  }
  return [...map.values()].map((s) => ({ ...s, tools: [...s.tools].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

export function catalog(hubDir) {
  return { commands: loadCommands(hubDir), agents: loadAgents(hubDir), skills: loadSkills() };
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
  return { ...stat, commands: cat.commands.length, agents: cat.agents.length, skills: cat.skills.length };
}

/** 원본 폴더가 바뀌면 다시 설치하고 알린다 */
export function watchCatalog(hubDir, onChange) {
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(() => { try { onChange(installToClis(hubDir)); } catch (e) { onChange({ error: String(e.message || e) }); } }, 400); };
  for (const sub of ['commands', 'agents']) {
    const d = path.join(hubDir, sub); fs.mkdirSync(d, { recursive: true });
    try { fs.watch(d, kick); } catch {}
  }
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
