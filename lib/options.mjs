// 작업별 모델·추론 강도 선택지와 기본값
import os from 'node:os';
import path from 'node:path';
import { readJson, readText } from './util.mjs';

const CLAUDE_MODELS = [
  { id: 'fable', label: 'Fable 5.1' },
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'haiku', label: 'Haiku 4.5' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const SAFE = /^[\w.:\-\[\]]{1,80}$/;

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

function codexConfigDefaults() {
  const toml = readText(path.join(codexHome(), 'config.toml'), '') || '';
  const top = toml.split(/\r?\n\[/)[0]; // 첫 테이블 전까지가 최상위 키
  const pick = (k) => top.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || '';
  return { model: pick('model'), effort: pick('model_reasoning_effort') };
}

function codexModels() {
  const cache = readJson(path.join(codexHome(), 'models_cache.json'), null);
  const list = Array.isArray(cache) ? cache : Array.isArray(cache?.models) ? cache.models : [];
  return list
    .filter((m) => m && (m.slug || m.id) && m.visibility !== 'hide')
    .map((m) => ({
      id: m.slug || m.id,
      label: m.display_name || m.slug || m.id,
      efforts: (m.supported_reasoning_levels || []).map((x) => (typeof x === 'string' ? x : x?.effort)).filter(Boolean),
      defaultEffort: m.default_reasoning_level || null,
    }));
}

/** 대시보드에 보낼 선택지. 빈 문자열('')은 "각 CLI의 평소 설정 그대로" */
export function modelOptions(config) {
  const cx = codexConfigDefaults();
  const cxModels = codexModels();
  const allCxEfforts = [...new Set(cxModels.flatMap((m) => m.efforts))];
  return {
    claude: {
      models: CLAUDE_MODELS,
      efforts: CLAUDE_EFFORTS,
      cliDefault: { model: 'fable', effort: '' },
      defaults: { model: config.defaults?.claude?.model || '', effort: config.defaults?.claude?.effort || '' },
    },
    codex: {
      models: cxModels.length ? cxModels : [{ id: cx.model || 'gpt-5.5', label: cx.model || 'gpt-5.5', efforts: CODEX_FALLBACK_EFFORTS }],
      efforts: allCxEfforts.length ? allCxEfforts : CODEX_FALLBACK_EFFORTS,
      cliDefault: { model: cx.model, effort: cx.effort },
      defaults: { model: config.defaults?.codex?.model || '', effort: config.defaults?.codex?.effort || '' },
    },
  };
}

/** 요청으로 들어온 설정을 기본값과 합치고 검증한다 */
export function resolveSettings(config, requested = {}) {
  const opts = modelOptions(config);
  const out = {};
  for (const tool of ['claude', 'codex']) {
    const req = requested?.[tool] || {};
    let model = req.model ?? opts[tool].defaults.model;
    let effort = req.effort ?? opts[tool].defaults.effort;
    model = typeof model === 'string' && (model === '' || SAFE.test(model)) ? model : opts[tool].defaults.model;
    effort = typeof effort === 'string' && (effort === '' || SAFE.test(effort)) ? effort : opts[tool].defaults.effort;
    if (tool === 'claude' && effort && effort !== 'auto' && !CLAUDE_EFFORTS.includes(effort)) effort = '';
    if (tool === 'codex' && effort && effort !== 'auto' && model !== 'auto') {
      const m = opts.codex.models.find((x) => x.id === (model || opts.codex.cliDefault.model));
      if (m?.efforts?.length && !m.efforts.includes(effort)) {
        const e = new Error(`${model || opts.codex.cliDefault.model}은 지정한 강도 ${effort}를 지원하지 않습니다. 강도를 자동으로 내리지 않습니다.`);
        e.status = 400; throw e;
      }
    }
    out[tool] = { model, effort };
  }
  return out;
}

/** 사람이 읽는 "모델·강도" 표기 (빈 값은 CLI 기본값으로 풀어서) */
export function settingsLabel(config, tool, s = {}) {
  const d = modelOptions(config)[tool].cliDefault;
  const model = s.model || d.model || '기본';
  const effort = s.effort || d.effort || '기본';
  return `${model}·${effort}`;
}
