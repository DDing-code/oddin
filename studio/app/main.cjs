// ODDIN 스튜디오 프로그램 창 (2026-10-10 사용자 "오딘 내에 만드는 게 아니라 오딘과 연동(프리미어/애프터이펙트 플러그인처럼)되는 프로그램으로").
// 창은 엔진(studio/engine/server.mjs)이 내주는 화면을 띄우는 껍데기다. 엔진이 꺼져 있으면 숨겨서 켜고, 창을 닫아도 엔진은 남는다
// (AI 가 계속 쓸 수 있게 — 끄려면 node studio/cli.mjs quit 또는 ODDIN 의 PC 탭). 끌어 놓은 파일의 실제 경로·탐색기 열기를 화면에 준다(preload.cjs).
//   electron studio/app [--open <편집파일|영상>] [--install-shortcuts]
'use strict';
const { app, BrowserWindow, shell, ipcMain, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const APP_ID = 'local.oddin.studio';
const STUDIO = path.resolve(__dirname, '..');
const ROOT = path.resolve(STUDIO, '..');
const ICON = path.join(__dirname, 'build', 'icon.png');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const PORT = Number(process.env.STUDIO_PORT) || Number(readJson(path.join(ROOT, 'config.json'))?.studio?.port) || 7710;
const BASE = `http://127.0.0.1:${PORT}`;

app.setAppUserModelId(APP_ID);
app.setPath('userData', process.env.ODDIN_STUDIO_DATA || path.join(app.getPath('appData'), 'ODDIN Studio'));
const argOpen = () => { const i = process.argv.indexOf('--open'); return i >= 0 ? process.argv[i + 1] || null : null; };

/* ---------- 바로가기 (시작 메뉴·바탕화면) ---------- */
function writeShortcut(file) {
  const ico = path.join(__dirname, 'build', 'icon.ico');
  const opts = { target: process.execPath, args: `"${app.getAppPath()}"`, cwd: __dirname, description: 'ODDIN 스튜디오 — ODDIN 과 연동되는 영상 편집', icon: fs.existsSync(ico) ? ico : process.execPath, iconIndex: 0, appUserModelId: APP_ID };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', opts);
}
if (process.argv.includes('--install-shortcuts')) {
  app.whenReady().then(() => {
    const links = [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ODDIN 스튜디오.lnk'), path.join(app.getPath('desktop'), 'ODDIN 스튜디오.lnk')];
    const ok = links.map(writeShortcut).every(Boolean);
    console.log(ok ? '바로가기를 만들었어요 (시작 메뉴·바탕화면 "ODDIN 스튜디오")' : '바로가기 일부를 만들지 못했어요');
    app.exit(ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else main();

function main() {
  let win = null;
  const winFile = path.join(app.getPath('userData'), 'window.json');

  /** 엔진 켜기: 이 PC 의 Node 가 있으면 그것으로, 없으면 이 프로그램의 Node(ELECTRON_RUN_AS_NODE)로 */
  async function engine() {
    const { ensureEngine } = await import(pathToFileURL(path.join(STUDIO, 'engine', 'launch.mjs')).href);
    let node = null;
    try { const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true }); node = (r.stdout || '').split(/\r?\n/).find((l) => l.trim())?.trim() || null; } catch {}
    return ensureEngine({ port: PORT, node: node || process.execPath, electronAsNode: !node });
  }
  async function post(p, body) {
    const r = await net.fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => ({}));
  }

  function createWindow(openPath) {
    const saved = readJson(winFile, {}) || {};
    win = new BrowserWindow({
      width: saved.width || 1500, height: saved.height || 950, x: saved.x, y: saved.y, minWidth: 720, minHeight: 480,
      backgroundColor: '#101010', icon: fs.existsSync(ICON) ? ICON : undefined, autoHideMenuBar: true, title: 'ODDIN 스튜디오', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
    });
    if (saved.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    const save = () => { if (!win || win.isDestroyed()) return; const b = win.getNormalBounds(); try { fs.writeFileSync(winFile, JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch {} };
    win.on('close', save);
    win.on('closed', () => { win = null; });
    // 스튜디오 화면 밖 주소는 기본 브라우저로
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url) && !url.startsWith(BASE)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(BASE)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
    win.loadURL(`${BASE}/${openPath ? `?${/\.oddin-edit\.json$/i.test(openPath) ? 'path' : 'video'}=${encodeURIComponent(openPath)}` : ''}`);
  }
  const trusted = (e) => { try { return new URL(e.senderFrame?.url || e.sender.getURL()).origin === BASE; } catch { return false; } };
  ipcMain.on('studio:info', (e) => { e.returnValue = { trusted: trusted(e), version: app.getVersion() }; });
  ipcMain.handle('studio:show-item', (e, p) => { if (!trusted(e) || typeof p !== 'string') return false; shell.showItemInFolder(path.resolve(p)); return true; });
  // 기본 프로그램으로 열기는 장면·미디어·글 파일만(실행 파일은 열지 않는다)
  const OPENABLE = /\.(html?|css|js|json|srt|txt|md|png|jpe?g|webp|gif|svg|mp4|mov|m4v|webm|mkv|mp3|wav|m4a|aac|flac|ogg)$/i;
  ipcMain.handle('studio:open-path', async (e, p) => { if (!trusted(e) || typeof p !== 'string' || !OPENABLE.test(p)) return false; return (await shell.openPath(path.resolve(p))) === ''; });
  ipcMain.on('studio:focus', (e) => { if (trusted(e) && win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    const i = argv.indexOf('--open'); const p = i >= 0 ? argv[i + 1] : null;
    if (p) post('/api/open', { path: p, launch: false }).catch(() => {});
    else if (!win) createWindow(null);
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    try { await engine(); }
    catch (e) { const { dialog } = require('electron'); dialog.showErrorBox('ODDIN 스튜디오', `엔진을 켜지 못했어요.\n${e.message}`); app.quit(); return; }
    createWindow(argOpen());
  });
}
