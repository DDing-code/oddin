// /goal 목표 모드: 라운드가 끝날 때마다 "목표를 달성했는지" 판정하고 다음 라운드 지시를 만든다
import fs from 'node:fs';
import path from 'node:path';
import { runWorker } from './workers.mjs';
import { extractJson, truncate } from './util.mjs';
import { pickPlanner } from './planner.mjs';
import { internalSettings } from './router.mjs';
import { instructionText } from './intercepts.mjs';
import { resolveAttachments } from './attachments.mjs';

export const GOAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['done', 'progress', 'remaining', 'next', 'blocked', 'reason'],
  properties: {
    done: { type: 'boolean' },
    progress: { type: 'number' },
    remaining: { type: 'string' },
    next: { type: 'string' },
    blocked: { type: 'boolean' },
    reason: { type: 'string' },
  },
};

/** 라운드 작업 지시문 */
export function roundPrompt(goal) {
  const head = `[목표 모드 · ${goal.round}/${goal.maxRounds}라운드]\n최종 목표: ${goal.text}${instructionText(goal)}`;
  if (goal.round <= 1) return `${head}\n\n이번 라운드에서 목표 달성을 위해 할 수 있는 만큼 진행하세요. 끝나면 목표 기준 중 무엇이 충족됐고 무엇이 남았는지 근거와 함께 보고하세요.`;
  return `${head}\n\n지금까지 진행률: ${Math.round(goal.progress || 0)}%\n남은 일: ${goal.remaining || '-'}\n\n# 이번 라운드에서 할 일\n${goal.next || '남은 일을 처리하세요.'}\n\n끝나면 목표 기준 중 무엇이 충족됐고 무엇이 남았는지 근거와 함께 보고하세요.`;
}

/**
 * 목표 달성 판정
 * @returns {Promise<{done:boolean, progress:number, remaining:string, next:string, blocked:boolean, reason:string}>}
 */
export async function checkGoal({ config, goal, jobs, healthy, plannerPref, settings = {}, cwd, runDir, onEvent, onWorker, memoryCtx = '' }) {
  const tool = pickPlanner(config, healthy, plannerPref);
  if (!tool) throw new Error('판정할 AI가 없습니다');
  const rounds = jobs.map((j) => `## ${j.goalRound || '?'}라운드 (${j.status})\n요청: ${truncate(j.goal, 1500)}\n\n결과:\n${truncate(j.report || j.error || '(결과 없음)', 5000)}`).join('\n\n');
  const prompt = `당신은 목표 달성 판정 담당입니다. 작업은 하지 말고, 아래 기록만 보고 판정하세요. 필요하면 작업 폴더의 파일을 읽어 확인해도 됩니다(수정 금지).

# 최종 목표
${goal.text}
${instructionText(goal)}

# 작업 폴더
${cwd}

# 지금까지의 라운드 (${goal.round}/${goal.maxRounds})
${rounds}
\n# 공유 메모리 최신 확인\n${memoryCtx}

# 판정 기준
- done: 목표의 모든 기준이 실제로 충족됐고 검증 근거가 있을 때만 true. 말로만 "완료"라고 한 것은 근거가 아닙니다.
- progress: 0~100 추정 진행률.
- remaining: 아직 안 된 일을 한국어로 짧게 (done 이면 빈 문자열).
- next: 다음 라운드에 작업자에게 줄 구체적 지시 (무엇을, 어디서, 완료 기준). done 이면 빈 문자열.
- blocked: 사용자만 할 수 있는 일(로그인·결제·승인·정보 제공) 없이는 더 진행할 수 없으면 true, reason 에 무엇이 필요한지.
- reason: 판정 근거 한두 문장.

JSON 하나만 출력: {"done":false,"progress":40,"remaining":"...","next":"...","blocked":false,"reason":"..."}`;
  const dir = path.join(runDir, 'goal-check');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  let schemaFile = null;
  if (tool === 'codex') { schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(GOAL_SCHEMA)); }
  const worker = runWorker({
    tool, prompt, cwd, runDir: dir, toolCfg: config.tools[tool], schemaFile,
    attachments: (jobs.at(-1)?.intercepts || []).flatMap((i) => resolveAttachments(i.attachments)),
    settings: internalSettings(config, tool, settings[tool] || {}),
    modelPolicy: { config, fixed: settings[tool] || {} }, addDirs: [config.hubDir, runDir].filter(Boolean),
    timeoutMs: 10 * 60_000,
    managed: !!onWorker,
    onEvent: (ev) => onEvent?.({ ...ev, phase: 'goal-check', tool }),
  });
  const res = await (onWorker?.(worker, 'goal-check') || worker.promise);
  if (!res.ok) throw new Error(`목표 판정 실패: ${truncate(res.error || res.text || '응답 없음', 300)}`);
  const j = extractJson(res.text);
  if (!j || typeof j.done !== 'boolean') throw new Error(`목표 판정 응답을 해석하지 못함: ${truncate(res.text || '', 200)}`);
  return {
    done: j.done, blocked: !!j.blocked,
    progress: Math.max(0, Math.min(100, Number(j.progress) || 0)),
    remaining: String(j.remaining || '').slice(0, 600), next: String(j.next || '').slice(0, 2000), reason: String(j.reason || '').slice(0, 400),
  };
}
