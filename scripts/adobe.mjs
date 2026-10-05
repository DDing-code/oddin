#!/usr/bin/env node
// 작업자(Claude·Codex)용: 프리미어·애프터이펙트 안 ODDIN 플러그인에 ExtendScript 를 보내고 결과를 받는다.
//   node scripts/adobe.mjs status
//   node scripts/adobe.mjs run premiere --code "return app.project.path"
//   node scripts/adobe.mjs run aftereffects --file C:/work/make-comp.jsx [--timeout 1800]
//   node scripts/adobe.mjs install            (이 PC에 두 앱용 플러그인 설치·다시 설치)
// 스크립트는 함수 몸통으로 실행된다 — 마지막에 return 한 값이 JSON 으로 돌아온다(ODDIN.json).
// 허브 주소: 환경 변수 ODDIN_HUB (기본 http://127.0.0.1:<config.json port>)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = 7700;
try { port = JSON.parse(fs.readFileSync(process.env.HUB_CONFIG_FILE || path.join(root, 'config.json'), 'utf8')).port || port; } catch {}
const HUB = (process.env.ODDIN_HUB || `http://127.0.0.1:${port}`).replace(/\/$/, '');

const [cmd, app, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const call = async (method, p, body) => {
  const r = await fetch(HUB + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

try {
  if (cmd === 'status') {
    const s = await call('GET', '/api/adobe/status');
    console.log(JSON.stringify(s, null, 2));
  } else if (cmd === 'install') {
    console.log(JSON.stringify(await call('POST', '/api/adobe/install', {}), null, 2));
  } else if (cmd === 'op' && app) {
    // 이름 붙은 명령: op premiere status · op aftereffects newComp '{"name":"A","width":1080,"height":1920}'
    const ns = { premiere: 'pr', pr: 'pr', ppro: 'pr', aftereffects: 'ae', ae: 'ae', aeft: 'ae' }[String(app).toLowerCase()];
    const name = rest[0], arg = rest[1];
    if (!ns || !/^[A-Za-z]\w*$/.test(name || '')) throw new Error(`예: op premiere status · op aftereffects newComp '{"name":"A"}'`);
    let json = '';
    if (arg) { try { json = JSON.stringify(JSON.parse(arg)); } catch { throw new Error('인자는 JSON 이어야 해요'); } }
    const r = await call('POST', '/api/adobe/run', { app, script: `return ODDIN.${ns}.${name}(${json});`, timeoutSeconds: Number(opt('timeout')) || 600 });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'run' && app) {
    const file = opt('file'), code = opt('code');
    if (!file && !code) throw new Error('--code "스크립트" 또는 --file 경로 를 주세요');
    const body = { app, timeoutSeconds: Number(opt('timeout')) || 600 };
    if (file) body.file = path.resolve(file); else body.script = code;
    const r = await call('POST', '/api/adobe/run', body);
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  } else {
    console.log(`사용법: node scripts/adobe.mjs status | install | op <premiere|aftereffects> <명령> ['{JSON 인자}'] | run <premiere|aftereffects> (--code "..." | --file 경로) [--timeout 초]`);
    process.exitCode = 2;
  }
} catch (e) { console.error(`실패: ${e.message}`); process.exitCode = 1; }
