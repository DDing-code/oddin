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
  required: ['summary', 'tasks', 'questions', 'workdir'],
  properties: {
    summary: { type: 'string' },
    // 이 요청을 실행할 프로젝트 폴더(절대 경로). 지금 폴더가 맞거나 확실하지 않으면 빈 문자열
    workdir: { type: 'string' },
    // 요청이 모호해 결과가 크게 갈리면 계획 대신 사용자에게 먼저 물을 질문 (없으면 빈 배열)
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'header', 'options', 'multiSelect'],
        properties: {
          question: { type: 'string' },
          header: { type: 'string' },
          options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: { label: { type: 'string' }, description: { type: 'string' } } } },
          multiSelect: { type: 'boolean' },
        },
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'assignee', 'prompt', 'dependsOn', 'model', 'effort', 'reason', 'agent', 'visualOutput', 'design'],
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
          visualOutput: { type: 'boolean' },
          // 디자인 진행 방식: draft(고쳐 가는 시안·디자인 결과물 — 한 작업) / build(명세가 필요한 큰 구현 — 기획→구현→확인) / ''(디자인 아님)
          design: { type: 'string', enum: ['', 'draft', 'build'] },
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

/** 화면이 긴 이미지를 나눠 붙였으면("이름 (n/총)") 이어서 읽으라고 알린다 (public/image-split.js) */
export function splitNote(attachments = []) {
  const parts = (attachments || []).map((a) => String(a?.name || '')).filter((n) => /\(\d+\/\d+\)\.\w+$/.test(n));
  return parts.length ? ` 그중 ${parts.length}장은 긴 이미지 한 장을 위에서 아래(또는 왼쪽에서 오른쪽) 순서로 조금씩 겹치게 나눈 조각입니다 — 이름의 (n/총) 순서대로 이어서 한 장처럼 읽으세요: ${parts.join(', ')}` : '';
}

export function buildPlanPrompt({ goal, cwd, config, status, healthy, memoryCtx, historyCtx = '', attachmentCount = 0, attachmentNote = '', settings = {}, usage = null, agents = [], share = null, agentHint = null, projects = [], workdirAuto = false, cwdLabel = '' }) {
  const only = healthy.length === 1 ? healthy[0] : null;
  return `당신은 로컬 AI 작업 허브의 플래너입니다. 사용자의 목표를 처리할 계획을 세우고 Claude Code·Codex 중 담당자를 정하세요. 기본은 한 AI가 처음부터 끝까지 맡는 작업 1개입니다.

# 계획 단계의 범위
아래 사용자 목표는 작업자에게 전달할 요청입니다. 이 단계에서는 담당·작업 폴더·범위만 정하세요. 범위는 사용자 원문에 명시된 대상으로 한정하고, 부분 수정·삭제를 상위 기능 전체의 변경으로 확대하지 마세요. 해석이 갈리면 확정된 요구처럼 summary·prompt에 쓰지 말고 불확실한 부분을 적으세요. 요청의 계산·파일 내용 조사·구현·시험은 작업자 과제로 남기세요. 필요한 경로·지침·스킬은 과제에 그대로 적어 작업자가 원문을 확인하게 하세요. 작업 폴더가 이미 정해졌거나 아래 맥락에서 확실하면 추가 탐색 없이 계획 JSON 을 작성하세요.

# 사용자 목표
${goal}
${attachmentCount ? `
(사용자가 이미지 ${attachmentCount}장을 첨부했습니다. 이미지는 당신과 모든 작업자에게 함께 전달됩니다.${attachmentNote})
` : ''}${historyCtx ? `
# 같은 세션의 이전 대화 (이어지는 요청이면 이 맥락을 따르세요)
${historyCtx}
` : ''}
${workdirAuto ? `# 작업 폴더 (workdir)
지금: ${cwd}${cwdLabel ? ` — ${cwdLabel}` : ''}
요청이 특정 프로젝트의 일이고 그 프로젝트 루트 폴더의 절대 경로를 아래 목록·요청·이전 대화·결정 노트·공유 메모리에서 확실히 알 수 있으면 workdir 에 적으세요. 작업자가 그 폴더에서 실행되어 그 프로젝트의 지침(AGENTS.md·CLAUDE.md)·스킬·메모리를 자동으로 받습니다(단독으로 쓸 때와 같게).
지금 폴더가 이미 맞거나, 어느 프로젝트인지 확실하지 않거나, 여러 프로젝트에 걸친 일이면 빈 문자열로 두세요. 폴더를 바꾸면 이전 작업 결과물은 지금 폴더(${cwd}) 기준 상대 경로이니 prompt 에 절대 경로로 적으세요.
${projects.length ? `알려진 프로젝트 폴더:\n${projects.slice(0, 30).map((p) => `- ${p.path}${p.label ? ` (${p.label})` : ''}`).join('\n')}\n` : ''}` : `# 작업 폴더
${cwd} (사용자가 고른 폴더 — workdir 는 빈 문자열로 두세요)
`}
# 에이전트
${toolLine('claude', status, config)}
${toolLine('codex', status, config)}
${only ? `\n현재 ${only}만 사용 가능하므로 모든 작업의 assignee 는 "${only}" 로 지정하세요.` : ''}

# 모델·추론 강도
${['claude', 'codex'].map((n) => { const s = settings[n] || {}; return `- ${n}: 모델 ${s.model === AUTO ? '자동(당신이 고름)' : s.model || 'CLI 기본'}, 강도 ${s.effort === AUTO ? '자동(당신이 고름)' : s.effort || 'CLI 기본'}`; }).join('\n')}
자동인 항목은 작업 난이도에 맞춰 작업마다 고르세요. 고정된 항목은 그 값을 그대로 적으세요.
${catalogText(config, { usage, usable: healthy, settings })}

# 남은 구독 한도
${usageText(usage)}
${share ? `
# 분배 비율
${share.note}. 작업이 여러 개일 때 담당을 고르는 참고로만 쓰세요. 비율을 맞추려고 작업을 나누지 마세요. 한도가 95% 이상인 AI는 이미 에이전트 목록에서 빠졌습니다.
` : ''}${agents.length ? `
# 서브 에이전트 (전문 역할)
${agents.map((a) => `- ${a.name} (${a.label}, ${a.tool === 'auto' ? '담당 AI 자유' : a.tool + ' 전용'}${a.readonly ? ', 파일 수정 안 함' : ''}): ${a.description}`).join('\n')}
작업마다 딱 맞는 역할이 있으면 agent 에 그 이름을, 없으면 빈 문자열을 적으세요. 역할에 담당 AI가 정해져 있으면 assignee 도 그 AI로 맞추세요.${agentHint ? `\n이번 요청은 ${agentHint} 역할이 중심입니다. 핵심 작업에 agent "${agentHint}" 를 붙이세요.` : ''}
` : ''}
# 공유 메모리 요약 (두 에이전트가 함께 쓰는 장기 기억)
${memoryCtx || '(없음)'}

# 규칙
1. 기본은 작업 1개: 한 AI가 조사·기획·구현·검증까지 처음부터 끝까지 맡습니다(단독으로 쓸 때처럼 맥락이 끊기지 않게). 여러 작업으로 나누는 것은 (가) 서로 다른 결과물을 만드는 독립된 큰 일이 둘 이상이라 병렬로 시간이 크게 줄 때, (나) 사용자가 두 AI의 비교·교차 검토를 원할 때만입니다. 같은 결과물의 조사·기획·구현·검증을 다른 작업으로 나누지 마세요 — 넘겨주는 과정에서 의도가 사라집니다(단 아래 '사용자 규칙'의 디자인 기획 분리는 따르세요). 최대 4개.
2. 서로 의존 없는 작업은 dependsOn 을 비워 병렬로 실행되게 하세요. 의존은 앞 작업의 결과물(파일·결정)이 없으면 시작할 수 없을 때, 또는 같은 파일을 고칠 때만 겁니다.
3. 각 prompt 는 사용자 요청 원문을 먼저 그대로 인용하고, 그 아래에 꼭 필요한 맥락(파일 경로·직전 결정)만 400자 이내로 덧붙이세요. 사용자가 말하지 않은 요구사항·형식·가정을 지어내지 마세요. 특히 메모리·과거 피드백·세션 노트에서 확인 항목, 검증 절차, 비교·검토 페이지, 보고서·기록 파일, 참고 자료·스킬 문서 정독 지시를 끌어와 덧붙이지 마세요 — 작업자도 같은 메모리와 노트를 받습니다(2026-10-05: 45자 요청이 이런 덧붙임으로 1,256자 과제가 되어 작업량이 몇 배가 됐다). 모호한 부분은 작업자가 판단하거나 사용자에게 묻게 두세요. 한국어로 작성.
4. 담당자는 작업 성격에 더 잘 맞는 AI로 고르세요(부하는 그다음).
5. 의존 사슬은 최대 2단계(선행 → 후속)까지만.
6. 요청이 모호해서 해석에 따라 결과가 크게 달라지거나 되돌리기 어려운 선택이 필요하면, tasks 를 빈 배열로 두고 questions 에 사용자에게 먼저 물을 질문(최대 3개, 질문마다 선택지 2~4개, header 는 12자 이내)을 적으세요. 사소한 것은 묻지 말고 가장 합리적인 해석을 summary 에 적고 진행하세요. 목표에 "# 사용자 답변"이 이미 있으면 다시 묻지 말고 그 답대로 계획하세요.
7. id 는 t1, t2 … 형식.
8. 검증·확인·점검·리뷰만 하는 작업을 따로 만들지 마세요. 각 작업이 끝내기 전에 직접 실행·테스트해서 스스로 검증합니다.
9. visualOutput 은 이 작업이 실제로 화면·UI·이미지·영상 같은 시각 결과물을 만들거나 바꿀 때만 true 입니다. 현황 답변·로그 조사·모델 설정·서버 로직 수정·기획 명세만 작성은 false 입니다. 과거 영상 언급이나 검증 방법으로 스크린샷을 읽는다는 이유로 true 를 쓰지 마세요.

# 출력
아래 JSON 하나만 출력하세요(설명·코드펜스 없이):
{"summary":"해석과 분배 요약 1~3문장","workdir":"","questions":[],"tasks":[{"id":"t1","title":"짧은 제목","assignee":"claude|codex","prompt":"상세 지시","dependsOn":[],"model":"모델 id","effort":"강도","reason":"이 모델·강도를 고른 이유 한 문장","agent":"서브 에이전트 이름 또는 빈 문자열","design":"","visualOutput":false}]}`;
}

export async function makePlan({ goal, cwd, config, status, healthy, memoryCtx, historyCtx = '', settings = {}, attachments = [], plannerPref, usage = null, agents = [], share = null, agentHint = null, projects = [], workdirAuto = false, cwdLabel = '', runDir, onEvent, onWorker, job, resumeSessionId, allowEmpty = false }) {
  const planner = pickPlanner(config, healthy, plannerPref);
  if (!planner) throw new Error('사용 가능한 에이전트가 없습니다 (로그인 상태를 확인하세요)');
  const prompt = buildPlanPrompt({ goal, cwd, config, status, healthy, memoryCtx, historyCtx, attachmentCount: attachments.length, attachmentNote: splitNote(attachments), settings, usage, agents, share, agentHint, projects, workdirAuto, cwdLabel }) + instructionText(job || {});
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
  if (plan && typeof plan === 'object') plan.workdir = typeof plan.workdir === 'string' ? plan.workdir.trim().slice(0, 400) : '';
  // 먼저 물을 질문 정리 (최대 3개, 선택지 최대 4개)
  if (plan && typeof plan === 'object') plan.questions = (Array.isArray(plan.questions) ? plan.questions : []).filter((q) => q && String(q.question || '').trim()).slice(0, 3).map((q) => ({
    question: String(q.question).trim().slice(0, 300), header: String(q.header || '').trim().slice(0, 24),
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && String(o.label || '').trim()).slice(0, 4).map((o) => ({ label: String(o.label).trim().slice(0, 80), description: String(o.description || '').trim().slice(0, 200) })),
    multiSelect: !!q.multiSelect,
  }));
  if (!plan || !Array.isArray(plan.tasks) || (!allowEmpty && plan.tasks.length === 0 && !plan.questions.length)) {
    throw new Error(`플래너(${planner}) 응답을 계획으로 해석하지 못함: ${truncate(res.error || res.text || '(빈 응답)', 300)}`);
  }
  // 정규화 + 사용 불가 도구 배정 교정
  const ids = new Set();
  plan.tasks = plan.tasks.map((t, i) => {
    let id = String(t.id || `t${i + 1}`); while (ids.has(id)) id += '_'; ids.add(id);
    let assignee = t.assignee === 'claude' || t.assignee === 'codex' ? t.assignee : healthy[i % healthy.length];
    if (!healthy.includes(assignee)) assignee = healthy[i % healthy.length];
    return { id, title: String(t.title || `작업 ${i + 1}`).slice(0, 120), assignee, prompt: String(t.prompt || goal), dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [], choice: { model: String(t.model || ''), effort: String(t.effort || ''), reason: String(t.reason || '').slice(0, 200) }, visualOutput: typeof t.visualOutput === 'boolean' ? t.visualOutput : null, designKind: ['draft', 'build'].includes(t.design) ? t.design : '', agent: agents.some((a) => a.name === String(t.agent || '').replace(/^@/, '').toLowerCase()) ? String(t.agent).replace(/^@/, '').toLowerCase() : null };
  });
  const known = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) t.dependsOn = t.dependsOn.filter((d) => known.has(d) && d !== t.id);
  plan.dropped = dropVerifyOnly(plan.tasks);
  if (plan.dropped.length) plan.tasks = plan.tasks.filter((t) => !plan.dropped.includes(t));
  return { planner, plan, raw: res };
}

// 요약은 짧게 두되, 작업자와 보고 담당 모두 이미 저장된 원문·실행 기록을 찾아갈 수 있게 한다.
function taskResultContext(job, task, limit) {
  const refs = job.runDir ? [
    ['전체 결과', path.join(job.runDir, task.id, 'result.md')],
    ['실행 기록', path.join(job.runDir, `${task.id}.log.jsonl`)],
  ].filter(([, file]) => fs.existsSync(file)).map(([label, file]) => `${label}: ${file}`) : [];
  return `${truncate(task.text || task.resultText || task.error || '(결과 없음)', limit)}${refs.length ? '\n' + refs.join('\n') : ''}`;
}

export function buildWorkerPrompt({ job, task, depResults, siblings, hubDir, memoryCtx, historyCtx = '', agentText = '', board = '', boardDir = '', curate = true, continued = null, driveFolder = null, resumed = false }) {
  const myBoard = boardDir ? `${boardDir}\\${task.id}.md` : '';
  const others = siblings.filter((s) => s.id !== task.id).map((s) => `  - ${s.id} (${s.assignee}, ${s.status}): ${s.title}`).join('\n');
  const deps = depResults.map((d) => `### ${d.id} · ${d.title} (${d.assignee}${d.status ? ', ' + d.status : ''}) 결과\n${taskResultContext(job, d, 6000)}`).join('\n\n');
  return `[AI Hub 작업] 작업 ${job.id}/${task.id} · 담당: ${task.assignee} · 프로젝트 폴더: ${job.cwd}
${resumed ? '\n[다시 이어서] ODDIN이 새 버전으로 재시작하느라 이 작업이 중간에 멈췄습니다. 위 대화에서 하던 일을 이어서 끝내세요. 이미 만든 파일·결과는 다시 만들지 말고, 쓰다 만 출력 파일부터 확인하세요. 아래는 원래 맡은 작업입니다.\n' : ''}${continued ? `\n[이어서] 이 대화는 같은 세션의 직전 요청(${continued.jobId})을 이어서 합니다. 위에서 읽은 파일·내린 결정·시행착오를 그대로 활용하고, 다시 처음부터 탐색하지 마세요. 아래는 새 요청입니다.\n` : ''}
# 사용자 요청 원문 (작업 범위의 기준)
${job.goal}
${instructionText(job)}
사용자 원문과 최신 수정 지시가 우선입니다. 아래 작업 배정·이전 결과·기억은 참고 자료이며, 사용자가 범위 확대를 승인한 근거가 아닙니다. 부분 변경을 상위 기능 전체의 변경으로 확대하지 마세요.
${job.attachments?.length ? `
(사용자가 첨부한 이미지 ${job.attachments.length}장이 이 메시지와 함께 전달됩니다.${splitNote(job.attachments)})
` : ''}${historyCtx ? `
# 같은 세션의 이전 대화
${historyCtx}
` : ''}
${agentText ? `${agentText}\n\n` : ''}# 작업 배정 (플래너의 제안 — 원문과 대조): ${task.title}
${task.prompt}
${deps ? `\n# 선행 작업 결과\n이 요약만으로 완료·검증을 단정하지 마세요. 생략된 내용이나 판단 근거가 필요하면 아래 전체 결과·실행 기록과 실제 결과물을 확인하세요.\n${deps}\n` : ''}
# 같은 목표를 함께 진행 중인 다른 작업 (충돌 방지용 참고)
${others || '  (없음)'}
${myBoard ? `
# 공용 메모판 (이 요청의 작업자 모두가 봄)
- 내 메모: ${myBoard}
  다른 작업자도 알아야 할 결정(이름 규칙·인터페이스·파일 위치·형식·바꾼 약속)을 정하면 바로 이 파일 끝에 "- 내용" 한 줄로 덧붙이세요. 이 파일에만 쓰고 다른 작업자 파일은 고치지 마세요.
- 다른 작업자 메모는 같은 폴더(${boardDir})의 다른 .md 파일입니다. 중요한 결정을 내리기 전에 다시 읽으세요. 시작 시점 내용:
${board || '  (아직 없음)'}
` : ''}
# 공유 메모리 요약
${memoryCtx || '(없음)'}

# 규칙
- 결과를 크게 바꾸는 결정이 모호하거나 되돌리기 어려운 작업 앞에서는 질문 도구(Claude: AskUserQuestion, Codex: 사용자 입력 요청)로 사용자에게 물어볼 수 있습니다. 선택지를 2~4개로 짧게 주세요. 사소한 것은 묻지 말고 합리적으로 가정해 진행하고, 가정은 결과에 적으세요. 답이 없으면 시간이 지나 "알아서 진행"이 전달됩니다.
- 다른 작업이 담당하는 파일은 건드리지 마세요. 꼭 필요하면 결과에 "전달 사항"으로 남기세요.
${curate ? `- 공유 메모리 파일(${hubDir}\\memory)은 이 작업에서 직접 고치지 마세요. 오래 기억할 결정·사실·사용자 선호는 결과 요약 ④에 "기억할 것: …"으로 적으면 허브가 끝난 뒤 정리해 저장합니다.` : `- 장기적으로 기억할 사실(결정, 경로, 사용자 선호)은 공유 메모리 규칙(${hubDir}\\AGENTS.md 3절)대로 저장하세요. 일회성 로그는 저장하지 않습니다.`}
${driveFolder ? `- 이 폴더는 구글 드라이브로 두 PC가 함께 쓰는 작업 폴더(${driveFolder.name})입니다${driveFolder.others?.length ? ` — 다른 PC에서는 ${driveFolder.others.map((o) => `${o.name}: ${o.path}`).join(', ')}` : ''}. 고친 파일은 몇 초 뒤 다른 PC에도 반영되니, 고칠 파일만 고치고 큰 임시 파일·node_modules·가상환경·git 저장소를 만들지 마세요.\n` : ''}- 끝내기 전에 결과를 직접 확인하세요(코드는 실행·테스트, 그림·화면은 직접 열어 보기). 후속 검수 작업이 있어도 자기 결과를 확인할 책임은 유지됩니다. 필요한 지침·스킬·참고 자료를 읽고, 기존 검사를 우선 쓰되 회귀 방지에 필요한 최소 검사도 남기세요.
- 요청 범위를 넓히는 별도 결과물·비교 페이지·보고서는 만들지 마세요. 요청한 결과물을 완성하는 데 필요한 조사·자료 확인·검증은 수행하세요.
- 만든 HTML·그림·영상은 결과에 절대 경로 링크만 적으면 허브 화면이 원격에서도 페이지로 바로 열어 줍니다. 원격에서 보이게 하려고 따로 복사·게시·서버 설정을 하지 마세요.
${job.fast ? '- 범위가 분명한 작은 수정입니다. 기획·검수 담당을 따로 만들지 말고 직접 수정하고 확인하세요. 화면을 고쳤다면 실제 화면도 확인하세요. 관련 없는 파일 조사나 전체 재설계로 넓히지 마세요.\n' : ''}${job.answer ? '- 이 요청은 질문입니다. 위 최근 대화·결정과 원문 기록을 먼저 활용하고, 현재 상태가 필요할 때만 관련 파일·도구를 좁게 조회하세요. 질문만으로 파일을 수정하거나 작업을 새로 시작하지 마세요. 근거가 부족하면 기록을 확인하고, 확인한 범위에서 한국어로 바로 답하세요. 작업 보고 형식(① 한 일 ② 바뀐 파일 …)은 쓰지 마세요.' : '- 마지막 메시지는 반드시 한국어 결과 요약으로 끝내세요: ① 한 일 ② 바뀐/만든 파일 경로 ③ 검증 결과 ④ 미해결·다음 작업자에게 전달 사항.'}`;
}

export function buildReportPrompt({ job, memoryCtx = '' }) {
  const tasks = job.tasks.map((t) => `## ${t.id} · ${t.title} (${t.assignee}, ${t.status})\n${taskResultContext(job, t, 5000)}`).join('\n\n');
  return `당신은 AI 작업 허브의 보고 담당입니다. 아래는 사용자의 목표와, Claude Code/Codex가 나눠 수행한 각 작업의 결과입니다. 사용자에게 보여줄 최종 보고를 한국어 마크다운으로 작성하세요.

# 목표
${job.goal}
${instructionText(job)}

# 작업 결과
${tasks}
사용자 원문과 최신 수정 지시를 기준으로 달성 여부를 판단하세요. 작업자의 완료 주장은 검증 근거와 구분하고, 요약에서 잘린 내용이나 서로 다른 주장이 있으면 전체 결과·실행 기록을 확인하세요. 근거가 없으면 미검증으로 남기세요.

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
const MAKE_RE = /(구현|작성|만들|제작|편집|렌더|빌드|출력|배포|추가|수정|고치|고침|변경|생성|개발|적용|설치|이전|옮기|\b(create|implement|render|build|deploy)\b)/i;
export function dropVerifyOnly(tasks) {
  if (tasks.length < 2) return [];
  const dependedOn = new Set(tasks.flatMap((t) => t.dependsOn));
  const drop = tasks.filter((t) => t.dependsOn.length && !dependedOn.has(t.id) && !t.visualOutput && VERIFY_RE.test(t.title) && !MAKE_RE.test(t.title));
  if (drop.length >= tasks.length) return [];
  for (const d of drop) for (const pid of d.dependsOn) {
    const p = tasks.find((x) => x.id === pid);
    if (p) p.prompt += `\n\n# 끝내기 전 직접 검증\n(따로 있던 검증 작업 "${d.title}"을 이 작업에 합쳤습니다. 해당하는 부분을 직접 확인하세요.)\n${d.prompt.slice(0, 1500)}`;
  }
  return drop;
}
