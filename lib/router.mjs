// "자동" 모델·추론 강도 선택 (알잘딱)
// - 자동 분배: 플래너가 작업마다 model/effort/reason 을 함께 정한다.
// - 단독·비교 모드: 라우터 호출 한 번으로 고른다 (실패하면 규칙 기반).
// - 어느 쪽이든 사용자 하한(Opus·high / GPT-6.1-Sol·high) 이상을 보장하고, 한도가 빠듯하면 최상위만 피한다.
import fs from 'node:fs';
import path from 'node:path';
import { modelOptions } from './options.mjs';
import { runWorker } from './workers.mjs';
import { extractJson } from './util.mjs';
import { instructionText } from './intercepts.mjs';
import { resolveAttachments } from './attachments.mjs';

export const AUTO = 'auto';
const TIERS = ['light', 'standard', 'strong', 'top'];
const TIER_KO = { light: '가벼움', standard: '보통', strong: '어려움', top: '아주 어려움' };

/**
 * 등급별 후보 (앞에서부터 쓸 수 있는 것을 고름). 목록에 없거나 계정에서 거부된 모델은 건너뛴다.
 * 사용자 기준(2026-10-03): 자동 선택은 최소 Claude Opus·high, Codex GPT-6.1-Sol·high 이상.
 * 더 낮은 모델은 자동으로 고르지 않는다. 바꾸려면 config.json 의 autoFloor 를 고친다.
 */
const PLAN = {
  claude: {
    light: { models: ['opus', 'fable'], effort: 'high' },
    standard: { models: ['opus', 'fable'], effort: 'high' },
    strong: { models: ['opus', 'fable'], effort: 'high' },
    top: { models: ['fable', 'opus'], effort: 'xhigh' },
  },
  codex: {
    light: { models: ['gpt-6.1-sol', 'gpt-6-astra'], effort: 'high' },
    standard: { models: ['gpt-6.1-sol', 'gpt-6-astra'], effort: 'high' },
    strong: { models: ['gpt-6.1-sol', 'gpt-6-astra'], effort: 'high' },
    top: { models: ['gpt-6-astra', 'gpt-6.1-sol'], effort: 'xhigh' },
  },
};
const EFF = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_FLOOR = { claude: { model: 'opus', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'high' } };
const MODEL_RANK = { opus: 1, fable: 2, 'gpt-6.1-sol': 1, 'gpt-6-astra': 2 };
/** 자동 선택 하한 (config.autoFloor 로 바꿀 수 있음) */
export function autoFloor(config, tool) { return { ...DEFAULT_FLOOR[tool], ...(config?.autoFloor?.[tool] || {}) }; }
/** 실행 중 "지원 안 됨" 오류가 난 모델 (서버 재시작 전까지 자동 선택에서 제외) */
export const badModels = new Set();
export function markUnsupported(model) { if (model) badModels.add(model); }
const MODEL_NOTE = {
  opus: 'Opus 5.5 — 기본: 코딩·문서·분석·리팩터 대부분',
  fable: 'Fable 5.1 — 최상위: 아주 어렵고 긴 작업, 설계',
  'gpt-6.1-sol': 'GPT-6.1-Sol — 기본: 코딩·일상 작업',
  'gpt-6-astra': 'GPT-6-Astra — 최상위: 가장 까다로운 작업',
};
const maxEffort = (a, b) => (EFF.indexOf(a) >= EFF.indexOf(b) ? a : b);

export const isAuto = (s) => s?.model === AUTO || s?.effort === AUTO;

/** 실제 쓸 수 있는 자동 후보표 (하한 미만 모델은 후보에 넣지 않는다) */
export function autoCatalog(config) {
  const opts = modelOptions(config);
  const out = {};
  for (const tool of ['claude', 'codex']) {
    const ids = new Set(opts[tool].models.map((m) => m.id).filter((id) => !badModels.has(id)));
    const floor = autoFloor(config, tool);
    out[tool] = {};
    for (const tier of TIERS) {
      const p = PLAN[tool][tier];
      const order = tier === 'top' ? p.models : [floor.model, ...p.models.filter((m) => m !== floor.model)];
      const supportsFloor = (id) => {
        if (tool !== 'codex') return true;
        const entry = opts.codex.models.find((m) => m.id === id);
        return !entry?.efforts?.length || entry.efforts.some((e) => EFF.indexOf(e) >= EFF.indexOf(floor.effort));
      };
      const model = order.find((m) => ids.has(m) && supportsFloor(m) && (m === floor.model || (MODEL_RANK[m] !== undefined && MODEL_RANK[floor.model] !== undefined && MODEL_RANK[m] >= MODEL_RANK[floor.model]))) || '';
      out[tool][tier] = { model, effort: maxEffort(p.effort, floor.effort) };
    }
    out[tool].models = [...new Set(TIERS.map((t) => out[tool][t].model).filter(Boolean))];
    const all = tool === 'claude' ? opts.claude.efforts : opts.codex.efforts;
    out[tool].efforts = all.filter((e) => EFF.indexOf(e) >= EFF.indexOf(floor.effort));
    out[tool].floor = floor;
  }
  return out;
}

export function catalogText(config, ctx = {}) {
  const cat = autoCatalog(config);
  const dt = designTarget(config, ctx);
  const line = (tool) => cat[tool].models.map((m) => `${m} (${MODEL_NOTE[m] || ''})`).join(' / ');
  const text = `- claude 모델: ${line('claude')}\n  claude 강도: ${cat.claude.efforts.join(', ')}\n- codex 모델: ${line('codex')}\n  codex 강도: ${cat.codex.efforts.join(', ')}
${config?.browser?.claudeChrome !== false ? '- 브라우저: 두 작업자 모두 웹 페이지를 직접 열고 누르고 입력하고 확인할 수 있습니다(claude = Claude in Chrome, codex = 브라우저 플러그인·컴퓨터 사용). 브라우저 작업도 어느 쪽에나 맡기세요.\n' : ''}- 사용자 기준: 이보다 낮은 모델·강도는 고르지 마세요 (최소 ${cat.claude.floor.model}·${cat.claude.floor.effort}, ${cat.codex.floor.model}·${cat.codex.floor.effort}).
- 기준: 거의 모든 작업은 기본 모델·high 입니다. xhigh 는 ① 원인을 모르는 버그 ② 여러 모듈에 걸친 큰 설계·구조 변경 ③ 이전 시도가 실패한 경우에만 고르고, reason 에 그 근거를 적으세요.
  xhigh 는 같은 일도 2~3배 오래 걸립니다. 최상위 모델(fable / gpt-6-astra)은 사용자가 이름을 말했거나 정말 어려울 때만.${designRule(config) ? `
- 사용자 규칙: 최상위 모델(${(premiumRule(config)?.models.claude || []).join(", ")} / ${(premiumRule(config)?.models.codex || []).join(", ")})은 기획·${designRule(config).mode === 'whole' ? '눈으로 보는 결과물' : '디자인 기획'}·중요한 글쓰기 작업에만 고르고, 나머지는 기본 모델(opus / gpt-6.1-sol)로 하세요.
${designRule(config).mode === 'whole' ? `- 사용자 규칙(무조건): 눈으로 보는 결과물(UI·화면·디자인·색·아이콘·로고·폰트·이미지·일러스트·영상·애니메이션·3D·렌더 등, "설계"는 제외)을 만드는 작업은 ${dt.tool}·모델 ${dt.model} 한 작업자가 기획부터 구현·눈으로 확인까지 끝까지 맡습니다. 그런 작업은 나누지 말고 assignee 를 "${dt.tool}", model 을 "${dt.model}" 로 적으세요.` : `- 사용자 규칙: 디자인(시안·UI·화면 구성·색·아이콘·로고·폰트·일러스트·도트 등, "설계"는 제외)은 **기획만** 담당 ${dt.tool}·모델 ${dt.model}이 맡고, 구현·검증은 ${dt.switched ? '기본 모델(gpt-6.1-sol 또는 opus) 작업으로 따로 둡니다' : '다른 AI가 합니다'}. 디자인이 섞인 요청은 제목이 "디자인 기획: …"인 명세 작성 작업(코드·파일 수정 없음)과, 그 작업에 dependsOn을 건 구현·검증 작업으로 나누세요.${dt.switched ? `
  (${designRule(config).model} 전용 주간 한도가 ${Math.round(dt.percent)}%로 기준 ${designRule(config).switchAt}% 이상이라 디자인 기획만 ${dt.tool}·${dt.model}에 넘깁니다. ${dt.model}은 디자인 기획 명세에만 쓰고 구현·수정·검증에는 고르지 마세요.)` : dt.note ? `
  (${dt.note})` : ''}${designRule(config).check ? `
- 사용자 규칙: 눈으로 보는 결과물(UI·화면·디자인·이미지·영상·애니메이션·3D·렌더 등)을 만드는 작업 뒤에는 허브가 "눈으로 확인: …" 작업(${designRule(config).check.tool}·${designRule(config).check.model}, 렌더·스크린샷으로 확인하고 어긋난 곳 수정)을 자동으로 붙입니다. 확인 작업은 직접 만들지 마세요.` : ''}`}` : ''}`;
  const rule = designRule(config);
  if (!rule?.adaptive) return text;
  // 디자인 진행 방식(사용자 요구 2026-10-05): 플래너가 작업마다 design 을 적고 허브가 나눈다 — 예전 "명세 작업과 구현으로 나누라"는 문장은 뺀다
  return text.replace(' 디자인이 섞인 요청은 제목이 "디자인 기획: …"인 명세 작성 작업(코드·파일 수정 없음)과, 그 작업에 dependsOn을 건 구현·검증 작업으로 나누세요.', '') + `
- 사용자 규칙(디자인 진행 방식): 디자인 작업마다 design 칸을 적으세요. "draft" = 시안·컨셉 아트·로고·썸네일·화면 디자인처럼 디자인 판단이 핵심인 결과물을 만들거나 고쳐 가는 일 → 허브가 디자인 담당(${dt.tool}·${dt.model})에게 한 작업으로 맡깁니다(명세·구현으로 나누지 않음, 직전 대화를 이어 씀). "build" = 디자인 명세가 필요한 큰 구현(새 화면·앱 UI·사이트를 코드로 만드는 일) → 허브가 기획(${dt.model})→구현(기본 모델)→눈으로 확인으로 나눕니다. 디자인이 아니면 "". 어느 쪽이든 "디자인 기획: …" 작업을 직접 만들지 마세요.`;
}

/** 사용자가 고정한 값은 그대로, 자동인 부분만 후보로 채운다 (자동이면 하한 이상 보장) */
export function finalizeChoice(config, tool, fixed = {}, choice = {}, usage) {
  const cat = autoCatalog(config);
  const opts = modelOptions(config);
  const floor = cat[tool].floor;
  const okModel = (m) => m && !badModels.has(m) && cat[tool].models.includes(m);
  let model = fixed.model === AUTO ? (okModel(choice.model) ? choice.model : cat[tool].standard.model) : fixed.model;
  if (fixed.model === AUTO && !model) throw new Error(`${tool}: 사용자 최소 모델(${floor.model}) 이상인 지원 후보가 없습니다. CLI 기본값으로 내리지 않습니다.`);
  let effort = fixed.effort === AUTO ? (EFF.includes(choice.effort) ? maxEffort(choice.effort, floor.effort) : cat[tool].standard.effort) : fixed.effort;
  let reason = choice.reason || '';
  if (fixed.model === AUTO && choice.model && !okModel(choice.model)) reason += ` · ${choice.model} 대신 기준 이상인 ${model} 사용`;
  // 모델 전용 한도: Fable 주간 한도가 75% 이상이면 자동 선택은 Fable 대신 기본(Opus)
  if (tool === 'claude' && fixed.model === AUTO && model === 'fable') {
    const fu = modelWindowUsed(usage?.claude, 'fable');
    const alt = cat.claude.models.find((m) => m !== 'fable');
    if (fu != null && fu >= 75 && alt) { model = alt; reason += ` · Fable 주간 한도 ${Math.round(fu)}%라 ${alt}로 바꿈`; }
  }
  // 한도 안전장치: 많이 쓴 쪽은 최상위를 피하고 강도를 줄이되, 하한 아래로는 내리지 않는다 (사용자 고정값은 건드리지 않음)
  const used = maxUsed(usage?.[tool]);
  if (used != null && used >= 75) {
    if (fixed.model === AUTO && model === cat[tool].top.model && model !== cat[tool].standard.model) { model = cat[tool].standard.model; reason += ` · 한도 ${Math.round(used)}% 사용 중이라 최상위 모델은 피함`; }
    const effCap = used >= 90 ? floor.effort : 'xhigh';
    if (fixed.effort === AUTO && EFF.indexOf(effort) > EFF.indexOf(effCap)) effort = effCap;
  }
  // Codex는 모델마다 지원 강도가 다르다 → 지원하는 것 중 하한 이상 가장 낮은 값
  if (tool === 'codex' && effort) {
    const m = opts.codex.models.find((x) => x.id === (model || opts.codex.cliDefault.model));
    if (fixed.effort === AUTO && m?.efforts?.length && !m.efforts.includes(effort)) {
      effort = m.efforts.find((e) => EFF.indexOf(e) >= EFF.indexOf(floor.effort));
      if (!effort) throw new Error(`${tool}: ${model}에 최소 강도 ${floor.effort} 이상인 지원 후보가 없습니다.`);
    }
  }
  return { model, effort, reason: reason.trim().replace(/^· /, ''), auto: fixed.model === AUTO || fixed.effort === AUTO };
}
/**
 * 디자인 고정 규칙 (사용자 요구 2026-10-03: "디자인은 페이블이 고정으로 맡아서")
 * 디자인 기획 작업에만 Claude·Fable 을 쓴다(2026-10-03 갱신, 구현·검증은 다른 AI).
 * Fable 전용 주간 한도가 switchAt 이상이면 디자인 기획만 fallback(Codex·gpt-6-astra)에 넘긴다(2026-10-04, designTarget).
 * config.designRule = { enabled, tool, model, pattern, switchAt, fallback: { tool, model } } 로 끄거나 바꾼다 (fallback:false = 넘기지 않음).
 * "설계"(아키텍처)는 디자인으로 보지 않는다. "DDingUI" 같은 이름 속 UI 는 단어 경계로 걸러낸다.
 */
const DESIGN_RE = /(디자인|design|시안|목업|mockup|와이어프레임|레이아웃|배색|색상|컬러|팔레트|테마|아이콘|로고|브랜딩|타이포|폰트|글꼴|일러스트|썸네일|스프라이트|도트|픽셀\s*아트|프로필\s*(사진|이미지|그림)|\bUI\b|\bUX\b|\bCSS\b)/i;
// 눈으로 보는 결과물 (사용자 요구 2026-10-04 "눈으로 보는건 무조건 아스트라가 하자"): 디자인 + 이미지·영상·애니메이션·렌더·화면 등
const VISUAL_RE = new RegExp(DESIGN_RE.source.slice(1, -1) + '|이미지|사진|그림|영상|동영상|비디오|\\bvideo\\b|애니메이션|animation|모션|렌더|\\brender|\\b3d\\b|3D|화면|스크린샷|screenshot|\\bGIF\\b|움짤|쇼츠|릴스|시각화|비주얼|visual|배너|포스터|카드뉴스|슬라이드|\\bPPT\\b|(?<![검탐수모사])색(?!인)|버튼|예쁘|이쁘|꾸며|꾸미', 'i');
/**
 * mode: 'whole'(2026-10-04 기본 설정) = 눈으로 보는 결과물 작업은 규칙 담당(Codex·gpt-6-astra) 한 작업자가 기획부터 구현·눈 확인까지.
 *       'split'(예전) = 디자인 기획만 규칙 담당(Claude·Fable), 구현·검증은 다른 AI. config 에 mode 가 없으면 예전 방식.
 */
export function designRule(config) {
  const r = config?.designRule;
  if (r?.enabled === false) return null;
  const whole = r?.mode === 'whole';
  const out = { tool: whole ? 'codex' : 'claude', model: whole ? 'gpt-6-astra' : 'fable', switchAt: 75, ...(r || {}), mode: whole ? 'whole' : 'split', fallback: r?.fallback === false ? null : { tool: 'codex', model: 'gpt-6-astra', ...(r?.fallback || {}) } };
  // check(2026-10-04 "디자인은 페이블 / 눈으로 확인은 아스트라"): 눈으로 보는 결과물을 만든 작업 뒤에 붙는 확인 담당
  if (r?.check && !whole) out.check = { tool: 'codex', model: 'gpt-6-astra', ...(typeof r.check === 'object' ? r.check : {}) };
  else delete out.check;
  // adaptive(2026-10-05): 고쳐 가는 시안은 디자인 담당이 한 작업으로, 큰 구현만 기획→구현→확인으로 나눈다
  if (r?.adaptive && !whole) out.adaptive = true; else delete out.adaptive;
  return out;
}
/** 눈으로 보는 결과물인가(디자인 + 이미지·영상·애니메이션·렌더·화면 등). 눈으로 확인 단계를 붙일지 정한다 */
export function isVisualText(config, text = '') {
  if (!designRule(config)) return false;
  return VISUAL_RE.test(String(text));
}
export function isDesignText(config, text = '') {
  const r = designRule(config);
  if (!r) return false;
  const re = r.pattern ? new RegExp(r.pattern, 'i') : r.mode === 'whole' ? VISUAL_RE : DESIGN_RE;
  return re.test(String(text));
}
const TOOL_KO = { claude: 'Claude', codex: 'Codex' };
/**
 * 디자인 기획을 누가·어느 모델로 맡는지 (사용자 요구 2026-10-04: "페이블 주간사용량 높으면 디자인 기획 아스트라에 넘겨")
 * 규칙 모델(Fable) **전용** 주간 사용률이 switchAt(기본 75%) 이상이면 fallback(기본 Codex·gpt-6-astra)에 넘긴다.
 * - Claude 전체 5시간·주간 사용률은 보지 않는다. 전용 사용률을 모르면(미확인) 0%로도 초과로도 보지 않고 기본 담당을 유지한다.
 * - 사용자가 모델을 직접 골랐으면 그 선택이 우선이라 넘기지 않는다.
 * - 넘겨받을 AI·모델을 쓸 수 없으면 넘기지 않고(기존 처리: Fable 유지, 전용 한도 95% 이상이면 기존 선택) 이유를 note 에 남긴다.
 * @returns {{tool, model, switched, percent, note}|null} 규칙이 꺼져 있으면 null
 */
export function designTarget(config, { usage = null, usable = null, settings = null } = {}) {
  const r = designRule(config);
  if (!r) return null;
  const base = { tool: r.tool, model: r.model, switched: false, percent: null, note: null };
  if (r.mode === 'whole') return base; // 눈으로 보는 결과물은 무조건 규칙 담당(Astra)
  const used = modelWindowUsed(usage?.[r.tool], r.model);
  if (used == null || Number.isNaN(used)) return base; // 미확인
  base.percent = used;
  const fb = r.fallback, at = Number(r.switchAt);
  if (!fb?.tool || !fb?.model || !(at > 0) || used < at || (fb.tool === r.tool && fb.model === r.model)) return base;
  if (settings?.[r.tool]?.model !== AUTO) return base; // 기획 담당 모델을 사용자가 직접 고름 → 그 선택 그대로
  const head = `디자인 규칙: ${r.model} 주간 한도 ${Math.round(used)}%로 기준 ${at}% 이상`;
  const stay = (why) => ({ ...base, note: `${head}이지만 ${why} ${TOOL_KO[fb.tool] || fb.tool}·${fb.model}에 넘기지 못함 (${TOOL_KO[r.tool] || r.tool} 유지)` });
  const theirs = settings?.[fb.tool] || {};
  if (usable && !usable.includes(fb.tool)) return stay(`${TOOL_KO[fb.tool] || fb.tool}를 지금 쓸 수 없어(로그인·한도)`);
  if (theirs.model !== AUTO && theirs.model !== fb.model) return stay(`${TOOL_KO[fb.tool] || fb.tool} 모델을 직접 고르셔서(${theirs.model || 'CLI 기본'})`);
  if (badModels.has(fb.model) || !autoCatalog(config)[fb.tool]?.models.includes(fb.model)) return stay(`${fb.model} 모델이 지원 안 됨이라`);
  if (fb.tool === 'codex' && theirs.effort && theirs.effort !== AUTO) {
    const entry = modelOptions(config).codex.models.find((m) => m.id === fb.model);
    if (entry?.efforts?.length && !entry.efforts.includes(theirs.effort)) return stay(`${fb.model}이 고르신 강도 ${theirs.effort}를 지원하지 않아`);
  }
  return { tool: fb.tool, model: fb.model, switched: true, percent: used, note: `${head}이라 디자인 기획을 ${TOOL_KO[fb.tool] || fb.tool}·${fb.model}에 넘김` };
}
/**
 * 디자인 기획 작업의 모델을 규칙 모델로 고정한다. 사용자가 모델을 직접 고른 경우(자동 아님)는 건드리지 않는다.
 * target(designTarget 결과)이 한도 전환이면 넘겨받은 쪽을 전환 모델(gpt-6-astra)로 고정한다. 강도는 그대로 두고, 그 모델이 지원하지 않을 때만 그 이상인 가장 낮은 값으로 올린다.
 * 전환이 아니면: 규칙 모델이 지원 안 됨으로 표시됐거나 그 모델 전용 한도가 95% 이상일 때 기존 선택을 유지하고 이유를 남긴다.
 */
export function applyDesignModel(config, tool, fixed = {}, settings = {}, usage, target = null) {
  const r = designRule(config);
  if (!r || fixed.model !== AUTO) return { ...settings, applied: false };
  if (r.mode === 'whole') {
    if (tool !== r.tool) return { ...settings, applied: false };
    if (badModels.has(r.model)) return { ...settings, applied: false, note: `눈으로 보는 결과물 규칙: ${r.model} 지원 안 됨이라 ${settings.model} 유지` };
    return { ...settings, model: r.model, applied: true, note: `눈으로 보는 결과물 규칙: ${r.model}` };
  }
  if (target?.switched && tool === target.tool) {
    let effort = settings.effort;
    if (tool === 'codex' && fixed.effort === AUTO && effort) {
      const entry = modelOptions(config).codex.models.find((m) => m.id === target.model);
      if (entry?.efforts?.length && !entry.efforts.includes(effort)) effort = entry.efforts.find((e) => EFF.indexOf(e) >= EFF.indexOf(effort)) || effort;
    }
    return { ...settings, model: target.model, effort, applied: true, note: target.note || `디자인 규칙: ${target.model}` };
  }
  if (tool !== r.tool) return { ...settings, applied: false };
  const keep = target?.note || '디자인 규칙: Fable 고정'; // 전환하지 못한 이유가 있으면 함께 남긴다
  if (settings.model === r.model) return { ...settings, applied: true, note: keep };
  if (badModels.has(r.model)) return { ...settings, applied: false, note: `디자인 규칙: ${r.model} 지원 안 됨이라 ${settings.model} 유지` };
  const mu = modelWindowUsed(usage?.[tool], r.model);
  if (mu != null && mu >= 95) return { ...settings, applied: false, note: `디자인 규칙: ${r.model} 전용 한도 ${Math.round(mu)}%라 ${settings.model} 유지${target?.note ? ` · ${target.note}` : ''}` };
  return { ...settings, model: r.model, applied: true, note: keep };
}

/**
 * 최상위 모델 사용 규칙 (사용자 요구 2026-10-03: "페이블/아스트라는 기획·디자인 기획·중요한 글쓰기에만, 나머지는 오푸스 5.5와 솔 6.1")
 * 자동 선택이 최상위 모델을 골라도 해당 작업이 아니면 기본 모델(Opus·Sol)로 내린다. 사용자가 직접 고른 모델은 건드리지 않는다.
 * config.premiumModels = { enabled, models: { claude: [...], codex: [...] }, pattern } 로 끄거나 바꾼다.
 */
const PREMIUM_RE = /(기획|전략|로드맵|제안서|계획서|사업 ?계획|글쓰기|원고|대본|카피|문안|보도 ?자료|공지문|소개글|자기 ?소개|에세이|블로그 ?글|기고문|발표 ?자료|연설문|README|가이드 ?작성|문서 ?작성|보고서 ?작성|번역)/i;
export function premiumRule(config) {
  const r = config?.premiumModels;
  if (r?.enabled === false) return null;
  return { models: { claude: ['fable'], codex: ['gpt-6-astra'], ...(r?.models || {}) }, pattern: r?.pattern || null };
}
/** 이 작업이 최상위 모델을 써도 되는 종류인지: 디자인 기획, 글쓰기 담당 역할, 제목(단일 작업이면 요청문)이 기획·중요한 글쓰기 */
export function premiumAllowed(config, task = {}, jobText = '') {
  const r = premiumRule(config);
  if (!r) return true;
  if (task.designPlan || task.designMake || task.visual || task.visualCheck) return true;
  if (task.designImpl) return false;
  if (task.agent === 'writer') return true;
  const re = r.pattern ? new RegExp(r.pattern, 'i') : PREMIUM_RE;
  return re.test(`${task.title || ''} ${jobText || ''}`);
}
/** 최상위 모델이 허용되지 않는 작업이면 기본 모델로 내린다. 반환: { model, note } */
export function capPremium(config, tool, model, allowed) {
  const r = premiumRule(config);
  if (!r || allowed || !(r.models[tool] || []).includes(model)) return { model, note: null };
  const std = autoCatalog(config)[tool]?.standard?.model;
  if (!std || std === model) return { model, note: null };
  return { model: std, note: `최상위 모델은 기획·디자인 기획·중요한 글쓰기에만 써서 ${std}로` };
}

// 모델 전용 한도(예: Fable 주간)는 빼고 5시간·주간 중 큰 값
function maxUsed(u) { const v = (u?.windows || []).filter((w) => w.scope !== 'model').map((w) => Number(w.usedPercent)).filter((x) => !Number.isNaN(x)); return v.length ? Math.max(...v) : null; }
function modelWindowUsed(u, model) { const w = (u?.windows || []).find((x) => x.scope === 'model' && x.model === model); return w ? Number(w.usedPercent) : null; }

/** 계획·보고·라우터처럼 허브 내부 단계에 쓸 설정: 자동이면 하한(기본) 모델·강도 */
export function internalSettings(config, tool, fixed = {}, effort = 'high') {
  const cat = autoCatalog(config);
  const floor = cat[tool].floor;
  if (fixed.model === AUTO && !cat[tool].standard.model) throw new Error(`${tool}: 최소 모델 ${floor.model} 이상인 지원 후보가 없습니다.`);
  const model = fixed.model === AUTO ? cat[tool].standard.model : fixed.model;
  let chosenEffort = fixed.effort === AUTO ? maxEffort(effort, floor.effort) : fixed.effort;
  if (tool === 'codex' && fixed.effort === AUTO) {
    const entry = modelOptions(config).codex.models.find((m) => m.id === model);
    if (entry?.efforts?.length && !entry.efforts.includes(chosenEffort)) {
      chosenEffort = entry.efforts.find((e) => EFF.indexOf(e) >= EFF.indexOf(chosenEffort));
      if (!chosenEffort) throw new Error(`${tool}: ${model}은 최소 강도 ${floor.effort} 이상을 지원하지 않습니다.`);
    }
  }
  return { model, effort: chosenEffort };
}

/** 실패 재실행은 자동 선택에만 허용. 원래 선택 등급/강도 및 사용자 하한을 내리지 않는다. */
export function supportedFallback(config, tool, fixed, failed, settings) {
  if (fixed?.model !== AUTO) return null;
  const candidates = autoCatalog(config)[tool].models;
  const model = candidates.find((m) => m !== failed && MODEL_RANK[m] !== undefined && MODEL_RANK[failed] !== undefined && MODEL_RANK[m] >= MODEL_RANK[failed]);
  if (!model) return null;
  const effort = settings.effort;
  if (tool === 'codex') {
    const entry = modelOptions(config).codex.models.find((m) => m.id === model);
    if (entry?.efforts?.length && effort && !entry.efforts.includes(effort)) return null;
  }
  return { ...settings, model };
}

/** 규칙 기반 난이도 추정 (라우터 실패 시) */
export function heuristicTier(text = '') {
  const t = String(text);
  if (/리팩터|refactor|아키텍처|설계|마이그레이션|전체\s*(구조|코드)|원인|디버그|debug|성능|최적화|보안|동시성|복잡/i.test(t)) return 'strong';
  if (t.length < 80 && !/구현|만들|작성|고쳐|수정|추가|테스트|빌드|코드/.test(t)) return 'light';
  return 'standard';
}

const routeSchema = (n) => ({
  type: 'object', additionalProperties: false, required: ['choices'],
  properties: { choices: { type: 'array', minItems: n, maxItems: n, items: { type: 'object', additionalProperties: false, required: ['id', 'model', 'effort', 'reason'], properties: { id: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, reason: { type: 'string' } } } } },
});

/**
 * 단독·비교 모드용: 작업마다 모델·강도를 고른다.
 * @returns {Promise<Map<string,{model,effort,reason}>>}
 */
export async function routeTasks({ config, job, tasks, healthy, usage, memoryCtx = '', historyCtx = '', runDir, onEvent, onWorker }) {
  const pick = new Map();
  const need = tasks.filter((t) => isAuto(job.settings?.[t.assignee]));
  if (!need.length) return pick;
  // 라우터는 한도 여유가 더 많은 쪽의 가벼운 모델로 돌린다
  const cand = healthy.slice().sort((a, b) => (maxUsed(usage?.[a]) ?? 0) - (maxUsed(usage?.[b]) ?? 0));
  const router = cand[0];
  const cat = autoCatalog(config);
  const prompt = `당신은 작업마다 알맞은 AI 모델과 추론 강도를 고르는 배정 담당입니다. 작업은 하지 말고 고르기만 하세요.

# 사용자 요청
${job.goal}
${instructionText(job)}
${job.attachments?.length ? `(이미지 ${job.attachments.length}장 첨부)` : ''}

# 고를 작업
${need.map((t) => `- id=${t.id}, 담당=${t.assignee}, 내용: ${t.title}`).join('\n')}

# 고를 수 있는 값
${catalogText(config, { usage, usable: healthy, settings: job.settings })}

# 남은 한도
${usageText(usage)}

# 같은 세션의 이전 대화
${historyCtx || '(없음)'}

# 공유 메모리 최신 확인
${memoryCtx || '(메모리 컨텍스트 없음)'}

위 ${need.length}개 작업 모두에 대해 하나씩, 정확히 ${need.length}개를 답하세요. 담당이 claude 인 작업은 claude 모델에서, codex 인 작업은 codex 모델에서 고르세요.
JSON 하나만 출력: {"choices":[{"id":"...","model":"...","effort":"...","reason":"한국어 한 문장, 왜 이 등급인지"}]}`;
  const dir = path.join(runDir, 'route');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  let schemaFile = null;
  if (router === 'codex') { schemaFile = path.join(dir, 'schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(routeSchema(need.length))); }
  try {
    const worker = runWorker({
      tool: router, prompt, cwd: job.cwd, runDir: dir, toolCfg: config.tools[router], schemaFile,
      attachments: [...resolveAttachments(job.attachments), ...(job.intercepts || []).flatMap((i) => resolveAttachments(i.attachments))],
      settings: internalSettings(config, router, { model: AUTO, effort: AUTO }), timeoutMs: 180_000,
      modelPolicy: { config, fixed: { model: AUTO, effort: AUTO } }, addDirs: [config.hubDir, runDir].filter(Boolean),
      onEvent: (ev) => onEvent?.({ ...ev, phase: 'route', tool: router }),
      managed: !!onWorker,
    });
    const res = await (onWorker?.(worker, 'route') || worker.promise);
    if (!res.ok) throw new Error(`라우터 CLI 실행 실패 [${res.errorKind || 'CLI_ERROR'}]: ${res.error || '응답 없음'}`);
    const json = extractJson(res.text);
    for (const c of json?.choices || []) if (c && c.id) pick.set(String(c.id), { model: String(c.model || ''), effort: String(c.effort || ''), reason: String(c.reason || '').slice(0, 200) });
  } catch (e) { onEvent?.({ kind: 'error', phase: 'route', text: `모델 자동 선택 실패, 규칙으로 대신 고름: ${e.message}` }); }
  for (const t of need) {
    if (pick.has(t.id)) continue;
    const tier = heuristicTier(job.goal + instructionText(job));
    pick.set(t.id, { ...cat[t.assignee][tier], reason: `요청 길이·키워드로 ${TIER_KO[tier]} 작업으로 판단` });
  }
  return pick;
}

export function usageText(usage) {
  const f = (n) => { const u = usage?.[n]; if (!u?.windows?.length) return `${n}: 알 수 없음`; return `${n}: ` + u.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}% 사용`).join(', '); };
  return `${f('claude')}\n${f('codex')}\n(많이 쓴 쪽에는 작업을 덜 주세요. 75% 이상이면 최상위 모델은 피하고, Fable 주간 한도가 75% 이상이면 fable 대신 opus 를 고르세요. 디자인 기획 작업만 예외로, '모델·추론 강도'의 디자인 규칙에 적힌 담당·모델을 따르세요. 'Fable 주간'은 Fable 전용 한도이고 claude '주간'(전체)과 다른 값입니다.)`;
}

/** high 보다 높은 강도를 쓸 근거가 있는지 (원인 불명 버그, 큰 설계·구조 변경, 이전 시도 실패) */
const DEEP_RE = /(원인|디버그|debug|재현|간헐|크래시|crash|메모리\s*누수|교착|deadlock|race|동시성|아키텍처|구조\s*(변경|개편)|전체\s*(구조|설계)|대규모|마이그레이션|보안\s*취약|실패한|안\s*되던|다시\s*시도)/i;
export function deepEffortJustified(text = '') { return DEEP_RE.test(String(text)); }

/**
 * 품질 우선(기본): 자동 강도를 사용자가 단독으로 쓸 때의 평소 설정(Codex config.toml 의 model_reasoning_effort)까지 올린다.
 * 한도를 90% 이상 쓴 쪽은 올리지 않고, 모델이 지원하지 않으면 지원하는 것 중 평소 설정 이하에서 가장 높은 값.
 * Claude 는 평소 강도 설정이 따로 없어 그대로 둔다. 돌려주는 값: { effort, note } (안 올리면 note 없음)
 */
export function raiseToStandalone(config, tool, model, effort, usage, { cap = 'xhigh' } = {}) {
  const opts = modelOptions(config);
  const own = opts[tool]?.cliDefault?.effort;
  // 평소 설정이 max 처럼 상한보다 높으면 상한까지만 (2026-10-05 "단순 질문에도 10분": max 는 xhigh 보다 훨씬 느림)
  const want = own && EFF.includes(own) && EFF.includes(cap) && EFF.indexOf(own) > EFF.indexOf(cap) ? cap : own;
  if (!want || !EFF.includes(want) || EFF.indexOf(want) <= EFF.indexOf(effort)) return { effort };
  const used = maxUsed(usage?.[tool]);
  if (used != null && used >= 90) return { effort };
  let next = want;
  if (tool === 'codex') {
    const m = opts.codex.models.find((x) => x.id === (model || opts.codex.cliDefault.model));
    if (m?.efforts?.length && !m.efforts.includes(want)) next = [...m.efforts].filter((e) => EFF.includes(e) && EFF.indexOf(e) <= EFF.indexOf(want)).sort((a, b) => EFF.indexOf(b) - EFF.indexOf(a))[0];
  }
  if (!next || EFF.indexOf(next) <= EFF.indexOf(effort)) return { effort };
  return { effort: next, note: want === own ? `평소 단독 설정 강도(${want})에 맞춤 — 품질 우선` : `평소 설정(${own}) 대신 상한 ${want}로 — 품질 우선` };
}
