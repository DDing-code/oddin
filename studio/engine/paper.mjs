// 종이 편집표 — 컷을 자르기 전에 대본과 촬영본을 줄 단위로 맞춘다(편집 PD 가 하는 일).
// 사용자 "숏폼이어도 PD 목소리가 들어갈 때가 있고, 리드만 할 때가 있는데 실제 편집 PD처럼 하는 과정이 필요"(2026-10-12).
// 화면 밖 목소리를 무조건 빼면 질문·대화 형식의 내용이 사라지고, 무조건 두면 선창이 들어간다. 그래서 셋으로 나눈다.
//   선창(lead)    — PD 가 읽고 출연자가 같은 문장을 따라 함 → PD 를 빼고 출연자 테이크를 쓴다
//   지시(direction) — 대본에 없는 말("좋습니다, 다음") → 뺀다
//   내용(content) — 대본에 PD·질문자 대사로 적혀 있거나, 출연자가 따라 하지 않고 다음 줄로 대답함 → PD 목소리를 쓴다
// 판단이 안 서는 줄은 '확인 필요'로 남긴다(첫 편에서 한 번 묻고 그 답을 시리즈 규칙으로 적어 둔다).
import fs from 'node:fs';
import { sameLine } from './speakers.mjs';

const tokens = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;

const OFF_RE = /^(pd|피디|질문자?|q|인터뷰어|진행자?|mc|감독|스태프)\s*[:：)\]]\s*/i;
const ON_RE = /^(출연자?|원장님?|대표님?|선생님?|a|답변?|주인공|talent|host)\s*[:：)\]]\s*/i;
const NONE_RE = /^(자막|내레이션|나레이션|na|tts|화면|효과음|bgm|cg|인서트|b-?roll)\s*[:：)\]]\s*/i;

/** 대본: 한 줄에 대사 하나. 줄 앞의 "PD:"·"Q:"·"질문:" = 화면 밖 사람의 대사, "출연자:"·"A:" = 출연자, "자막:"·"내레이션:" = 촬영 대사가 아님. #으로 시작하면 주석 */
export function readScript(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let t = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!t || t.startsWith('#')) continue;
    let who = null;
    if (OFF_RE.test(t)) { who = 'off'; t = t.replace(OFF_RE, ''); }
    else if (NONE_RE.test(t)) { who = 'none'; t = t.replace(NONE_RE, ''); }
    else if (ON_RE.test(t)) { who = 'on'; t = t.replace(ON_RE, ''); }
    if (tokens(t).length) out.push({ n: out.length + 1, who, text: t });
  }
  return out;
}

/** 말 덩어리를 말한 사람이 바뀌거나 0.7초 넘게 쉬는 데서 끊어 '발화'로 묶는다 */
export function utterances(islands, gap = 0.7) {
  const out = [];
  for (const i of islands) {
    const last = out.at(-1);
    if (last && last.who === i.who && last.group === i.group && i.start - last.end <= gap) { last.end = i.end; last.level = Math.max(last.level, i.level); if (i.text) last.text = `${last.text} ${i.text}`.trim(); }
    else out.push({ start: i.start, end: i.end, who: i.who, group: i.group || null, level: i.level, text: i.text || '' });
  }
  return out.filter((u) => u.end - u.start >= 0.25);
}

/** 발화가 대본의 어느 줄인가(가장 닮은 줄, 0.55 미만이면 대본에 없는 말). cover = 그 줄 낱말 중 발화에 들어 있는 비율 */
export function matchLine(text, script) {
  const ut = tokens(text); if (!ut.length) return null;
  let best = null;
  for (const line of script) {
    if (line.who === 'none') continue;
    const s = sameLine(text, line.text); if (s < 0.55) continue;
    const lt = tokens(line.text), pool = [...ut]; let hit = 0;
    for (const w of lt) { const k = pool.indexOf(w); if (k >= 0) { hit++; pool.splice(k, 1); } }
    const cover = hit / lt.length;
    if (!best || s * 0.5 + cover > best.score) best = { line: line.n, score: s * 0.5 + cover, cover: round(cover) };
  }
  return best;
}

/**
 * 종이 편집표. speakers = analyzeSpeakers 결과(받아쓴 글을 붙인 것), script = readScript 결과.
 * 줄마다: 출연자 테이크(시각·온전함), 화면 밖 목소리(선창·내용·확인 필요), 고를 것. 그리고 대본에 없는 말(지시·잡담).
 */
export function paperEdit(speakers, script) {
  const utts = utterances(speakers.islands);
  for (const u of utts) { const m = matchLine(u.text, script); u.line = m?.line || null; u.cover = m?.cover || 0; }
  const lines = script.map((l) => ({ ...l, takes: [], off: [], unsure: [] }));
  const byN = new Map(lines.map((l) => [l.n, l]));
  for (const u of utts) {
    if (!u.line) continue;
    const L = byN.get(u.line), item = { start: u.start, end: u.end, cover: u.cover, level: u.level, text: u.text };
    if (u.who === 'on') L.takes.push(item); else if (u.who === 'off') L.off.push(item); else L.unsure.push(item);
  }
  // 화면 밖 목소리의 종류
  const repeatedBy = (L, o) => L.takes.some((t) => t.start > o.start && t.cover >= 0.5);
  // 이 촬영이 '읽어 주고 따라 하기' 방식인가: 선창이 세 번 넘게 확인되고 대본에 PD 대사 표시가 없으면, 따라 한 테이크를 못 찾은 줄도 질문이 아니라 판정 문제다
  const leadCount = lines.reduce((a, L) => a + (L.who === 'off' ? 0 : L.off.filter((o) => repeatedBy(L, o)).length), 0);
  const leadFormat = leadCount >= 3 && !script.some((l) => l.who === 'off');
  for (const L of lines) {
    for (const o of L.off) {
      if (L.who === 'off') o.kind = 'content';                 // 대본이 PD·질문자 대사라고 적음
      else if (repeatedBy(L, o)) o.kind = 'lead';              // 출연자가 같은 문장을 뒤에 따라 함
      else {
        // 출연자가 따라 하지 않고 다음 줄들로 넘어갔는가(질문 → 대답). 누구인지 못 정한 후보가 같은 줄에 있으면 그게 출연자 테이크일 수 있으니 단정하지 않는다
        const next = utts.find((u) => u.who === 'on' && u.start >= o.end && u.line);
        o.kind = !leadFormat && !L.unsure.length && next && next.line > L.n && !L.takes.length ? 'content?' : 'unknown';
      }
    }
    const good = L.takes.filter((t) => t.cover >= 0.8);
    L.pick = (good.length ? good : [...L.takes].sort((a, b) => b.cover - a.cover)).at(good.length ? -1 : 0) || null; // 온전한 것 중 마지막(없으면 가장 온전한 것)
    const content = L.off.filter((o) => o.kind === 'content');
    L.verdict = L.who === 'none' ? 'not-spoken'
      : L.who === 'off' ? (content.length ? 'pd-voice' : L.takes.length ? 'check' : 'missing')
        : L.pick ? (L.pick.cover >= 0.8 ? 'take' : 'partial')
          : L.off.some((o) => o.kind === 'content?') ? 'pd-voice?' : L.off.length || L.unsure.length ? 'check' : 'missing';
  }
  const extra = utts.filter((u) => !u.line && u.text);
  const sum = (v) => lines.filter((l) => l.verdict === v).length;
  return {
    file: speakers.file, basis: speakers.basis, onGroup: speakers.onGroup ?? null,
    counts: { lines: lines.length, take: sum('take'), partial: sum('partial'), pdVoice: sum('pd-voice'), pdVoiceMaybe: sum('pd-voice?'), check: sum('check'), missing: sum('missing'), notSpoken: sum('not-spoken') },
    leads: lines.reduce((a, l) => a + l.off.filter((o) => o.kind === 'lead').length, 0), leadFormat,
    lines,
    directions: extra.filter((u) => u.who === 'off').map((u) => ({ start: u.start, end: u.end, text: u.text })),   // 대본에 없는 화면 밖 말 = 지시·잡담 → 뺀다
    adlibs: extra.filter((u) => u.who === 'on').map((u) => ({ start: u.start, end: u.end, text: u.text })),        // 대본에 없는 출연자 말 = 잡담·NG·애드리브
    unplaced: extra.filter((u) => u.who === 'unsure').map((u) => ({ start: u.start, end: u.end, text: u.text })),
  };
}

const VERDICT = { take: '출연자 테이크', partial: '출연자 테이크(일부만 — 확인)', 'pd-voice': 'PD 목소리 사용(대본에 PD 대사)', 'pd-voice?': 'PD 목소리로 보임 — 확인 필요', check: '확인 필요', missing: '촬영본에서 못 찾음', 'not-spoken': '촬영 대사 아님(자막·내레이션)' };
const KIND = { lead: '선창 → 뺌', content: '내용 → 씀', 'content?': '질문으로 보임 → 확인', unknown: '확인 필요' };
const span = (x) => `${mmss(x.start)}~${mmss(x.end)}`;
/** 사람이 읽는 표(마크다운) */
export function paperReport(p) {
  const c = p.counts, out = [];
  out.push('# 종이 편집표');
  out.push(`대본 ${c.lines}줄 — 출연자 테이크 ${c.take}줄 · 일부만 ${c.partial}줄 · PD 목소리 사용 ${c.pdVoice}줄 · PD 목소리로 보임(확인) ${c.pdVoiceMaybe}줄 · 확인 필요 ${c.check}줄 · 못 찾음 ${c.missing}줄${c.notSpoken ? ` · 촬영 대사 아님 ${c.notSpoken}줄` : ''}`);
  if (p.leadFormat) out.push('이 촬영은 PD 가 읽어 주고 출연자가 따라 하는 방식으로 보여요 — 대본의 모든 줄은 출연자 테이크로 채운다. 출연자 테이크가 안 보이는 줄은 화자 판정을 화면으로 확인한다.');
  out.push(`빼는 것 — 선창 ${p.leads}곳 · 지시·잡담 ${p.directions.length}곳${p.adlibs.length ? ` · 대본에 없는 출연자 말 ${p.adlibs.length}곳(아래에서 쓸지 정함)` : ''}`);
  if (!['level+motion', 'channels+motion', 'motion'].includes(p.basis)) out.push(`주의: 누가 말했는지의 근거가 약해요(${p.basis}). 이 표의 화면 속/밖 구분을 화면으로 먼저 확인하세요.`);
  out.push('', '| 줄 | 대본 | 고를 것 | 출연자 테이크(시각 · 온전함) | 화면 밖 목소리 |', '|---|---|---|---|---|');
  for (const l of p.lines) {
    const takes = l.takes.map((t) => `${t === l.pick ? '**' : ''}${span(t)} ${Math.round(t.cover * 100)}%${t === l.pick ? '**' : ''}`).join('<br>') || '-';
    const off = [...l.off.map((o) => `${span(o)} ${KIND[o.kind]}`), ...l.unsure.map((o) => `${span(o)} 누구인지 확인 필요`)].join('<br>') || '-';
    out.push(`| ${l.n} | ${l.who === 'off' ? '(PD) ' : l.who === 'none' ? '(자막) ' : ''}${l.text.replace(/\|/g, '/')} | ${VERDICT[l.verdict]} | ${takes} | ${off} |`);
  }
  const list = (title, arr, max = 40) => { if (!arr.length) return; out.push('', `## ${title} (${arr.length})`); for (const x of arr.slice(0, max)) out.push(`- ${span(x)} ${x.text}`); if (arr.length > max) out.push(`- … 외 ${arr.length - max}곳`); };
  list('대본에 없는 화면 밖 말 — 지시·잡담, 뺀다', p.directions);
  list('대본에 없는 출연자 말 — 잡담·NG·애드리브, 쓸지 정한다', p.adlibs);
  list('누가 말했는지 확인이 필요한 말', p.unplaced);
  return out.join('\n');
}
/** 표에서 고른 것만 남긴 구간 목록(컷의 출발점). PD 목소리(내용)도 넣는다. '확인 필요'는 넣지 않는다 */
export function paperKeep(p, source = '') {
  const out = [];
  for (const l of p.lines) {
    if (l.verdict === 'take' && l.pick) out.push({ source, start: l.pick.start, end: l.pick.end, text: l.text, line: l.n, speaker: 'on' });
    if (l.verdict === 'pd-voice') for (const o of l.off.filter((x) => x.kind === 'content').slice(-1)) out.push({ source, start: o.start, end: o.end, text: l.text, line: l.n, speaker: 'pd' });
  }
  return out;
}
export const readScriptFile = (file) => readScript(fs.readFileSync(file, 'utf8'));
