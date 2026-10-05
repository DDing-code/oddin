// ODDIN 어도비 플러그인 설치 (adobe/ 폴더 → 이 PC의 CEP 확장 폴더)
// 프리미어용 com.oddin.premiere 와 애프터이펙트용 com.oddin.aftereffects 를 따로 설치한다.
// 둘 다 같은 플러그인 파일(adobe/plugin)에 앱별 manifest(adobe/manifests/<앱>.xml)를 붙이고,
// 로고는 허브 로고(public/mark.svg), 붙을 허브 주소는 app.json 에 적는다.
// 예전 플러그인(집 UXP 연결 패널·회사 DDstudio)은 건드리지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ADOBE_APPS = ['premiere', 'aftereffects'];
const MARK = '.oddin-plugin';

export function extensionsDir() {
  if (process.env.HUB_ADOBE_EXT_DIR) return path.resolve(process.env.HUB_ADOBE_EXT_DIR); // 시험용
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
}
export const pluginVersion = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'adobe', 'version.json'), 'utf8')).version; } catch { return '0.0.0'; } };
const targetOf = (app) => path.join(extensionsDir(), `com.oddin.${app}`);

/** 서명 없는 확장을 읽는 개발 모드(PlayerDebugMode) 값 — 읽기만 한다 */
export function debugMode() {
  if (process.platform !== 'win32' || process.env.HUB_ADOBE_EXT_DIR) return {};
  const out = {};
  for (let v = 9; v <= 14; v++) {
    try {
      const r = execFileSync('reg', ['query', `HKCU\\Software\\Adobe\\CSXS.${v}`, '/v', 'PlayerDebugMode'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const m = r.match(/PlayerDebugMode\s+REG_\w+\s+(\S+)/); if (m) out[v] = m[1];
    } catch {}
  }
  return out;
}

/** 이 PC에 설치된 그 앱용 플러그인 판과 앱 안 도우미 경로(허브가 예전 도우미를 새 것으로 읽힐 때) */
export function installedHost(app) {
  try {
    const dir = targetOf(app), j = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    const host = path.join(dir, 'host', 'oddin.jsx');
    return fs.existsSync(host) ? { version: j.version || null, host } : null;
  } catch { return null; }
}

export function adobeInstallStatus(root) {
  const version = pluginVersion(root);
  const apps = ADOBE_APPS.map((app) => {
    let installed = null;
    try { installed = JSON.parse(fs.readFileSync(path.join(targetOf(app), 'app.json'), 'utf8')); } catch {}
    return { app, dir: targetOf(app), installed: installed?.version || null, installedAt: installed?.installedAt || null, upToDate: installed?.version === version };
  });
  return { version, apps, debugMode: debugMode() };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

/** 두 앱용 플러그인을 (다시) 설치한다. 우리가 설치한 폴더(표시 파일 있음)만 지우고 새로 놓는다 */
export function installAdobePlugins(root, { port = 7700, apps = ADOBE_APPS } = {}) {
  const version = pluginVersion(root), src = path.join(root, 'adobe', 'plugin'), out = [];
  for (const app of apps) {
    const dir = targetOf(app);
    try {
      if (fs.existsSync(dir)) {
        if (!fs.existsSync(path.join(dir, MARK))) throw new Error(`${dir} 에 ODDIN이 만들지 않은 폴더가 있어 건드리지 않았어요`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      copyDir(src, dir);
      const manifest = fs.readFileSync(path.join(root, 'adobe', 'manifests', `${app}.xml`), 'utf8').replaceAll('@VERSION@', version);
      fs.mkdirSync(path.join(dir, 'CSXS'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'CSXS', 'manifest.xml'), manifest);
      fs.copyFileSync(path.join(root, 'public', 'mark.svg'), path.join(dir, 'logo.svg'));
      fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ app, hub: `http://127.0.0.1:${port}`, version, installedAt: new Date().toISOString() }, null, 2));
      fs.writeFileSync(path.join(dir, MARK), 'ODDIN이 설치한 폴더입니다. ODDIN이 다시 설치할 때 지우고 새로 놓습니다.\n');
      out.push({ app, ok: true, dir, version });
    } catch (e) { out.push({ app, ok: false, dir, error: e.message }); }
  }
  const dm = debugMode();
  const debugOn = Object.values(dm).some((v) => v === '1');
  return { ok: out.every((x) => x.ok), version, apps: out, debugMode: dm, note: debugOn || process.platform !== 'win32' ? '프리미어·애프터이펙트를 다시 켜면 창 › 확장(Extensions) › ODDIN 에 패널이 생겨요' : '서명 없는 확장을 읽는 어도비 개발 모드(PlayerDebugMode)가 꺼져 있어 앱이 플러그인을 읽지 않을 수 있어요' };
}

/** 허브가 켜질 때: 이미 설치된 플러그인이 예전 판이면 새 판으로 바꾼다(처음 설치는 사용자가 정한 때만) */
export function refreshAdobePlugins(root, opts = {}) {
  const st = adobeInstallStatus(root);
  const stale = st.apps.filter((a) => a.installed && !a.upToDate).map((a) => a.app);
  return stale.length ? installAdobePlugins(root, { ...opts, apps: stale }) : null;
}
