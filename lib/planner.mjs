// 목표 → 작업 분배 계획(JSON), 그리고 최종 보고서 생성
import fs from 'node:fs';
import path from 'node:path';
import { runWorker } from './workers.mjs';
import { extractJson, truncate } from './util.mjs';
import { catalogText, usageText, internalSettings, AUTO } from './router.mjs';
import { instructionText } from './intercepts.mjs';
import { resolveAttachments } from './attachments.mjs';

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'tasks'],
  properties: {
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'assignee', 'prompt', 'dependsOn', 'model', 'effort', 'reason', 'agent'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          assignee: { type: 'string', enum: ['claude', 'codex'] },
          prompt: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          model: { type: 'string' },
          effort: { type: 'string' },
          reason: { type: 'string' },
          agent: { type: 'string' },
        },
      },
    },
  },
};

export function pickPlanner(config, healthy, jobPref) {
  const choice = jobPref && jobPref !== 'auto' ? jobPref : config.planner;
  const pref = choice && choice !== 'auto' ? [choice] : [];
  // 기본: Codex(비용 없이 구독으로 빠름) → Claude
  for (const t of [...pref, 'codex', 'claude']) if (healthy.includes(t)) return t;
  return null;
}

function toolLine(name, status, cfg) {
  const s = status[name];
  const state = s?.ok ? '사용 가능' : `사용 불가(${s?.installed ? (s?.loggedIn ? '비활성' : '로그인 필요') : '미설치'})`;
  return `- ${name}: ${state}. 잘하는 일: ${(cfg.tools[name]?.specialties || []).join(', ')}`;
}

export function buildPlanPrompt({ goal, cwd, config, status, healthy, memoryCtx, historyCtx = '', attachmentCount = 0, settings = {}, usage = null, agents = [], share = null, agentHint = null }) {
  const only = healthy.length === 1 ? healthy[0] : null;
  return `당신은 로컬 AI 작업 허브의 플래너입니다. 사용자의 목표를 Claude Code와 Codex 두 CLI 에이전트가 나눠서 병렬로 처리할 수 있게 작업을 분해하고 담당자를 정하세요.

# 사용자 목표
${goal}
${attachmentCount ? `
(사용자가 이미지 ${attachmentCount}장을 첨부했습니다. 이미지는 당신과 모든 작업자에게 함께 전달됩니다.)
` : ''}${historyCtx ? `
# 같은 세션의 이전 대화 (이어지는 요청이면 이 맥락을 따르세요)
${historyCtx}
` : ''}
# 작업 폴더
${cwd}

# 에이전트
${toolLine('claude', status, config)}
${toolLine('codex', status, config)}
${only ? `\n현재 ${only}만 사용 가능하므로 모든 작업의 assignee 는 "${only}" 로 지정하세요.` : ''}

# 모델·추론 강도
${['claude', 'codex'].map((n) => { const s = settings[n] || {}; return `- ${n}: 모델 ${s.model === AUTO ? '자동(당신이 고름)' : s.model || 'CLI 기본'}, 강도 ${s.effort === AUTO ? '자동(당신이 고름)' : s.effort || 'CLI 기본'}`; }).join('\n')}
자동인 항목은 작업 난이도에 맞춰 작업마다 고르세요. 고정된 항목은 그 값을 그대로 적으세요.
${catalogText(config)}

# 남은 구독 한도
${usageText(usage)}
${share ? `
# 분배 비율
${share.note}. 작업 수 기준으로 이 비율에 가깝게 배정하세요. 한도가 95% 이상인 AI는 이미 에이전트 목록에서 빠졌습니다.
` : ''}${agents.length ? `
# 서브 에이전트 (전문 역할)
${agents.map((a) => `- ${a.name} (${a.label}, ${a.tool === 'auto' ? '담당 AI 자유' : a.tool + ' 전용'}${a.readonly ? ', 파일 수정 안 함' : ''}): ${a.description}`).join('\n')}
작업마다 딱 맞는 역할이 있으면 agent 에 그 이름을, 없으면 빈 문자열을 적으세요. 역할에 담당 AI가 정해져 있으면 assignee 도 그 AI로 맞추세요.${agentHint ? `\n이번 요청은 ${agentHint} 역할이 중심입니다. 핵심 작업에 agent "${agentHint}" 를 붙이세요.` : ''}
` : ''}
# 공유 메모리 요약 (두 에이전트가 함께 쓰는 장기 기억)
${memoryCtx || '(없음)'}

# 규칙
1. 작업은 1~6개. 작을수록 좋지만 쪼개서 이득이 없으면 1개로.
2. 서로 의존 없는 작업은 dependsOn 을 비워 병렬로 실행되게 하세요. 의존은 앞 작업의 결과물(파일·결정)이 없으면 시작할 수 없을 때, 또는 같은 파일을 고칠 때만 겁니다.
3. 각 prompt 는 그 에이전트가 이 텍스트만 보고 혼자 끝낼 수 있게 구체적으로: 무엇을, 어디(경로)에, 완료 기준, 검증 방법. 한국어로 작성.
4. 담당자는 "잘하는 일"과 작업 성격으로 배정하되, 두 에이전트가 모두 가능하면 부하를 고르게.
5. 의존 사슬은 최대 2단계(선행 → 후속)까지만. 같은 AI가 이어서 할 수 있는 "조사 → 구현"은 한 작업으로 합치세요. 조사를 따로 떼는 것은 다른 AI가 그 결과물을 꼭 써야 할 때만.
6. 사용자에게 되물을 수 없다. 모호하면 가장 합리적인 해석을 summary 에 명시하고 진행.
7. id 는 t1, t2 … 형식.
8. 검증·확인·점검·리뷰만 하는 작업을 따로 만들지 마세요. 각 작업이 끝내기 전에 직접 실행·테스트해서 스스로 검증합니다.
9. 작업 크기를 비슷하게 나눠 한쪽만 오래 걸리지 않게 하세요. 기다리는 시간이 가장 큰 낭비입니다.

# 출력
아래 JSON 하나만 출력하세요(설명·코드펜스 없이):
{"summary":"해석과 분배 요약 1~3문장","tasks":[{"id":"t1","title":"짧은 제목","assignee":"claude|codex","prompt":"상세 지시","dependsOn":[],"model":"모델 id","effort":"강도","reason":"이 모델·강도를 고른 이유 한 문장","agent":"서브 에이전트 이름 또는 빈 문자열"}]}`;
}

export async function makePlan({ goal, cwd, config, status, healthy, memoryCtx, historyCtx = '', settings = {}, attachments = [], plannerPref, usage = null, agents = [], share = null, agentHint = null, runDir, onEvent, onWorker, job, resumeSessionId, allowEmpty = false }) {
  const planner = pickPlanner(config, healthy, plannerPref);
  if (!planner) throw new Error('사용 가능한 에이전트가 없습니다 (로그인 상태를 확인하세요)');
  const prompt = buildPlanPrompt({ goal, cwd, config, status, healthy, memoryCtx, historyCtx, attachmentCount: attachments.length, settings, usage, agents, share, agentHint }) + instructionText(job || {});
  const dir = path.join(runDir, 'plan');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  let schemaFile = null;
  if (planner === 'codex') { schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(PLAN_SCHEMA)); }
  const worker = runWorker({
    tool: planner, prompt, cwd, runDir: dir, toolCfg: config.tools[planner], schemaFile,
    settings: internalSettings(config, planner, settings[planner] || {}), attachments: [...attachments, ...(job?.intercepts || []).flatMap((i) => resolveAttachments(i.attachments))],
    modelPolicy: { config, fixed: settings[planner] || {} }, addDirs: [config.hubDir, runDir].filter(Boolean),
    timeoutMs: 15 * 60_000,
    managed: !!onWorker, resumeSessionId,
    onEvent: (ev) => onEvent?.({ ...ev, phase: 'plan', tool: planner }),
  });
  const res = await (onWorker?.(worker, 'plan') || worker.promise);
  if (!res.ok) throw new Error(`플래너(${planner}) CLI 실행 실패 [${res.errorKind || 'CLI_ERROR'}]: ${truncate(res.error || res.text || '응답 없음', 600)}`);
  const plan = extractJson(res.text);
  if (!plan || !Array.isArray(plan.tasks) || (!allowEmpty && plan.tasks.length === 0)) {
    throw new Error(`플래너(${planner}) 응답을 계획으로 해석하지 못함: ${truncate(res.error || res.text || '(빈 응답)', 300)}`);
  }
  // 정규화 + 사용 불가 도구 배정 교정
  const ids = new Set();
  plan.tasks = plan.tasks.map((t, i) => {
    let id = String(t.id || `t${i + 1}`); while (ids.has(id)) id += '_'; ids.add(id);
    let assignee = t.assignee === 'claude' || t.assignee === 'codex' ? t.assignee : healthy[i % healthy.length];
    if (!healthy.includes(assignee)) assignee = healthy[i % healthy.length];
    return { id, title: String(t.title || `작업 ${i + 1}`).slice(0, 120), assignee, prompt: String(t.prompt || goal), dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [], choice: { model: String(t.model || ''), effort: String(t.effort || ''), reason: String(t.reason || '').slice(0, 200) }, agent: agents.some((a) => a.name === String(t.agent || '').replace(/^@/, '').toLowerCase()) ? String(t.agent).replace(/^@/, '').toLowerCase() : null };
  });
  const known = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) t.dependsOn = t.dependsOn.filter((d) => known.has(d) && d !== t.id);
  plan.dropped = dropVerifyOnly(plan.tasks);
  if (plan.dropped.length) plan.tasks = plan.tasks.filter((t) => !plan.dropped.includes(t));
  return { planner, plan, raw: res };
}

export function buildWorkerPrompt({ job, task, depResults, siblings, hubDir, memoryCtx, historyCtx = '', agentText = '' }) {
  const others = siblings.filter((s) => s.id !== task.id).map((s) => `  - ${s.id} (${s.assignee}, ${s.status}): ${s.title}`).join('\n');
  const deps = depResults.map((d) => `### ${d.id} · ${d.title} (${d.assignee}) 결과\n${truncate(d.text || '(결과 없음)', 6000)}`).join('\n\n');
  return `[AI Hub 작업] 작업 ${job.id}/${task.id} · 담당: ${task.assignee} · 프로젝트 폴더: ${job.cwd}

# 전체 목표 (사용자가 대시보드에 입력)
${job.goal}
${instructionText(job)}
${job.attachments?.length ? `
(사용자가 첨부한 이미지 ${job.attachments.length}장이 이 메시지와 함께 전달됩니다.)
` : ''}${historyCtx ? `
# 같은 세션의 이전 대화
${historyCtx}
` : ''}
# 분배 요약
${job.summary || '-'}

${agentText ? `${agentText}\n\n` : ''}# 이번 작업: ${task.title}
${task.prompt}
${deps ? `\n# 선행 작업 결과 (이어서 작업하세요)\n${deps}\n` : ''}
# 같은 목표를 함께 진행 중인 다른 작업 (충돌 방지용 참고)
${others || '  (없음)'}

# 공유 메모리 요약
${memoryCtx || '(없음)'}

# 규칙
- 사용자에게 질문할 수 없습니다. 불확실하면 합리적인 가정을 적고 끝까지 진행하세요.
- 다른 작업이 담당하는 파일은 건드리지 마세요. 꼭 필요하면 결과에 "전달 사항"으로 남기세요.
- 장기적으로 기억할 사실(결정, 경로, 사용자 선호)은 공유 메모리 규칙(${hubDir}\\AGENTS.md 3절)대로 저장하세요. 일회성 로그는 저장하지 않습니다.
- 따로 검증 담당이 없습니다. 끝내기 전에 결과를 직접 실행·테스트해서 확인하세요.
- 마지막 메시지는 반드시 한국어 결과 요약으로 끝내세요: ① 한 일 ② 바뀐/만든 파일 경로 ③ 검증 결과 ④ 미해결·다음 작업자에게 전달 사항.`;
}

export function buildReportPrompt({ job, memoryCtx = '' }) {
  const tasks = job.tasks.map((t) => `## ${t.id} · ${t.title} (${t.assignee}, ${t.status})\n${truncate(t.resultText || t.error || '(결과 없음)', 5000)}`).join('\n\n');
  return `당신은 AI 작업 허브의 보고 담당입니다. 아래는 사용자의 목표와, Claude Code/Codex가 나눠 수행한 각 작업의 결과입니다. 사용자에게 보여줄 최종 보고를 한국어 마크다운으로 작성하세요.

# 목표
${job.goal}
${instructionText(job)}

# 분배 요약
${job.summary || '-'}

# 작업 결과
${tasks}

# 공유 메모리 최신 확인
${memoryCtx || '(메모리 컨텍스트 없음)'}

# 보고 형식 (이 형식 그대로, 군더더기 없이)
## 결론
(목표 달성 여부를 첫 문장에. 실패·부분 완료면 그 사실을 먼저.)
## 한 일
- 담당자별로 1~3줄
## 바뀐 파일
- 경로 목록 (없으면 "없음")
## 검증
- 실제로 실행·확인된 것만. 확인 안 된 것은 "미검증"으로 표시
## 남은 일 / 사용자가 직접 해야 할 일
- 항목`;
}

export async function makeReport({ job, config, healthy, memoryCtx = '', runDir, onEvent, onWorker, resumeSessionId }) {
  const settings = job.settings || {};
  const planner = pickPlanner(config, healthy, job.plannerPref);
  if (!planner) return null;
  const prompt = buildReportPrompt({ job, memoryCtx });
  const dir = path.join(runDir, 'report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  const worker = runWorker({
    tool: planner, prompt, cwd: job.cwd, runDir: dir, toolCfg: config.tools[planner], timeoutMs: 15 * 60_000,
    attachments: [...resolveAttachments(job.attachments), ...(job.intercepts || []).flatMap((i) => resolveAttachments(i.attachments))],
    settings: internalSettings(config, planner, settings[planner] || {}),
    modelPolicy: { config, fixed: settings[planner] || {} }, addDirs: [config.hubDir, runDir].filter(Boolean),
    managed: !!onWorker, resumeSessionId,
    onEvent: (ev) => onEvent?.({ ...ev, phase: 'report', tool: planner }),
  });
  const res = await (onWorker?.(worker, 'report') || worker.promise);
  if (!res.ok) throw new Error(`보고 CLI 실행 실패 [${res.errorKind || 'CLI_ERROR'}]: ${res.error || '응답 없음'}`);
  return res.text || null;
}

/**
 * 검증·확인만 하는 끝 작업을 뺀다. 그 내용은 선행 작업 지시문에 "끝내기 전 직접 검증"으로 합친다.
 * 다른 작업이 기다리지 않는 마지막 작업이고, 제목이 검증류이며, 만드는 일이 아닐 때만 뺀다.
 */
const VERIFY_RE = /(검증|확인|점검|리뷰|검토|QA|테스트\s*(실행|통과)|동작\s*테스트)/i;
const MAKE_RE = /(구현|작성|만들|추가|수정|고치|고침|변경|생성|개발|적용|설치|이전|옮기)/;
export function dropVerifyOnly(tasks) {
  if (tasks.length < 2) return [];
  const dependedOn = new Set(tasks.flatMap((t) => t.dependsOn));
  const drop = tasks.filter((t) => t.dependsOn.length && !dependedOn.has(t.id) && VERIFY_RE.test(t.title) && !MAKE_RE.test(t.title));
  if (drop.length >= tasks.length) return [];
  for (const d of drop) for (const pid of d.dependsOn) {
    const p = tasks.find((x) => x.id === pid);
    if (p) p.prompt += `\n\n# 끝내기 전 직접 검증\n(따로 있던 검증 작업 "${d.title}"을 이 작업에 합쳤습니다. 해당하는 부분을 직접 확인하세요.)\n${d.prompt.slice(0, 1500)}`;
  }
  return drop;
}
