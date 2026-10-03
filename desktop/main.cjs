// ODDIN(오딘, 구 AI Hub) 데스크탑 프로그램: 허브 화면을 창으로 감싸고 트레이·알림·허브 전환(원격 세션)을 더한다.
// 허브 서버는 따로 돈다. 프로그램은 서버가 꺼져 있으면 숨김 실행만 하고, 끌 때 서버를 끄지 않는다.
'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, net, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const H = require('./lib/hubs.cjs');

const APP_ID = 'local.aihub.desktop';
const REFRESH_MS = 30_000;
const PAGES = path.join(__dirname, 'pages');
const ICON = path.join(__dirname, 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'build', 'tray.png');

/* ---------- 바로가기 (시작 메뉴 바로가기에 앱 식별자를 넣어야 Windows 알림이 뜬다) ---------- */
function writeShortcut(file) {
  const opts = { target: process.execPath, cwd: path.dirname(process.execPath), description: 'ODDIN — Claude Code·Codex 공동 작업', icon: app.isPackaged ? process.execPath : path.join(__dirname, 'build', 'icon.ico'), iconIndex: 0, appUserModelId: APP_ID };
  if (!app.isPackaged) opts.args = `"${app.getAppPath()}"`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', opts);
}
const startMenuLink = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ODDIN.lnk');

app.setAppUserModelId(APP_ID);
// 설정 폴더: 이름이 ODDIN으로 바뀌어도 예전(AI Hub) 설정을 계속 쓴다. 시험 때는 AI_HUB_DESKTOP_DATA 로 분리
app.setPath('userData', process.env.AI_HUB_DESKTOP_DATA || path.join(app.getPath('appData'), 'AI Hub'));
if (process.argv.includes('--install-shortcuts')) {
  // 실행 중인 프로그램이 있어도 바로가기만 만들고 끝낸다
  app.whenReady().then(() => {
    const ok = [writeShortcut(startMenuLink()), writeShortcut(path.join(app.getPath('desktop'), 'ODDIN.lnk'))].every(Boolean);
    console.log(ok ? '바로가기를 만들었어요 (시작 메뉴·바탕화면)' : '바로가기 일부를 만들지 못했어요');
    app.exit(ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else main();

function main() {
  const userDir = app.getPath('userData');
  const files = { hubs: path.join(userDir, 'hubs.json'), win: path.join(userDir, 'window.json'), prefs: path.join(userDir, 'prefs.json') };
  const startHidden = process.argv.includes('--hidden');

  /* ---------- 허브 위치 · 목록 ---------- */
  function hubRoot() {
    const cands = [process.env.AI_HUB_ROOT, H.readJson(path.join(__dirname, 'hub-root.json'))?.root, app.isPackaged ? null : path.resolve(__dirname, '..')];
    return cands.find((p) => p && fs.existsSync(path.join(p, 'server.mjs'))) || null;
  }
  const root = hubRoot();
  const port = Number(root && H.readJson(path.join(root, 'config.json'))?.port) || 7700;
  let state = H.loadState(files.hubs, { localUrl: `http://127.0.0.1:${port}` });
  const save = () => H.saveState(files.hubs, state);
  const prefs = H.readJson(files.prefs, {}) || {};
  const savePrefs = () => H.writeJsonAtomic(files.prefs, prefs);
  const local = () => H.hubById(state, H.LOCAL_ID);
  const current = () => H.hubById(state, state.current) || local();

  // 허브별 상태: { status, error, sessions, checkedAt }
  const live = new Map();
  const statusOf = (id) => live.get(id) || { status: 'checking', error: null, sessions: null };

  let win = null, tray = null, quitting = false, busy = 0;

  /* ---------- 네트워크 ---------- */
  async function getJson(url, timeoutMs = 6000) {
    let res;
    try { res = await net.fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', cache: 'no-store' }); }
    catch (e) {
      const why = e?.name === 'TimeoutError' ? '응답이 없어요' : '연결할 수 없어요';
      throw new Error(`${why} (허브 실행 상태와 Tailscale 연결을 확인해 주세요)`);
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) throw new Error(H.explainHttpError(res.status, body));
    return body;
  }
  async function probe(hub) {
    try {
      const st = await getJson(`${hub.url}/api/status`, hub.local ? 2500 : 6000);
      if (!H.looksLikeHub(st)) throw new Error('ODDIN 허브가 아닌 주소예요');
      return { status: 'online', error: null };
    } catch (e) { return { status: 'offline', error: e.message }; }
  }
  async function refreshHub(hub, withSessions) {
    const p = await probe(hub);
    const prev = statusOf(hub.id);
    const next = { ...prev, ...p, checkedAt: Date.now() };
    if (p.status === 'online' && withSessions) {
      try { next.sessions = H.summarizeSessions(await getJson(`${hub.url}/api/sessions`)); next.error = null; }
      catch (e) { next.sessions = null; next.error = e.message; }
    } else if (p.status !== 'online') next.sessions = null;
    live.set(hub.id, next);
    if (hub.id !== state.current) notifyFinished(hub, prev.sessions, next.sessions);
    return next;
  }
  // 창에 열려 있지 않은 허브(원격 세션)의 작업이 끝나면 알린다. 처음 불러올 때는 알리지 않는다.
  const DONE_KO = { done: '완료', partial: '일부 완료', failed: '실패', cancelled: '중지됨', interrupted: '중단됨' };
  function notifyFinished(hub, before, after) {
    if (!before || !after || !Notification.isSupported()) return;
    const was = new Map(before.map((s) => [s.id, s.status]));
    for (const s of after) {
      if (was.get(s.id) !== 'running' || s.status === 'running' || !DONE_KO[s.status]) continue;
      const note = new Notification({ title: `${hub.local ? '이 PC' : `원격 · ${hub.name}`} — ${DONE_KO[s.status]}`, body: s.title, icon: ICON });
      note.on('click', () => switchHub(hub.id, s.id).catch(() => {}));
      note.show();
    }
  }
  let refreshing = null;
  function refreshAll() {
    if (refreshing) return refreshing;
    const before = JSON.stringify([...live.entries()].map(([k, v]) => [k, v.status, v.error, v.sessions]));
    refreshing = Promise.all(state.hubs.map((h) => refreshHub(h, h.id !== state.current)))
      .then(() => {
        const after = JSON.stringify([...live.entries()].map(([k, v]) => [k, v.status, v.error, v.sessions]));
        if (after !== before) { send('hubs-changed'); buildTray(); }
      })
      .catch(() => {})
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  /* ---------- 허브 서버 시작 (이 PC) ---------- */
  async function ensureLocalHub() {
    if ((await probe(local())).status === 'online') return true;
    const vbs = root && path.join(root, 'start-hub-hidden.vbs');
    if (!vbs || !fs.existsSync(vbs)) return false;
    try { spawn('wscript.exe', [vbs], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { return false; }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await probe(local())).status === 'online') return true;
    }
    return false;
  }

  /* ---------- 창 ---------- */
  const trusted = (url) => {
    if (!url) return false;
    if (url.startsWith('file:')) { try { return path.resolve(fileURLToPath(url.split(/[?#]/)[0])).toLowerCase().startsWith(PAGES.toLowerCase() + path.sep); } catch { return false; } }
    return H.isHubOrigin(state, url);
  };
  function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
  function command(cmd) { showWindow(); send('command', cmd); }
  function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  }
  function showPage(name, query = {}) {
    win.loadFile(path.join(PAGES, `${name}.html`), { query }).catch(() => {});
  }
  async function openHub(hub, sessionId) {
    if (hub.local && !(await ensureLocalHub())) {
      return showPage('offline', { hub: hub.name, url: hub.url, error: root ? '이 PC의 허브 서버를 시작하지 못했어요. 허브 폴더의 logs\\server.log 를 확인해 주세요' : '이 PC에서 허브 폴더를 찾지 못했어요', local: '1' });
    }
    win.loadURL(H.hubPageUrl(hub, sessionId)).catch(() => {});
  }
  function createWindow() {
    const ws = H.readJson(files.win, {}) || {};
    win = new BrowserWindow({
      width: ws.width || 1360, height: ws.height || 880, x: ws.x, y: ws.y,
      minWidth: 720, minHeight: 520, show: false, title: 'ODDIN', icon: ICON,
      backgroundColor: '#141416', autoHideMenuBar: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    win.setMenuBarVisibility(false);
    if (ws.maximized) win.maximize();
    win.once('ready-to-show', () => { if (!startHidden) win.show(); });
    let saveT = null;
    const keep = () => { clearTimeout(saveT); saveT = setTimeout(() => { if (!win || win.isDestroyed()) return; const b = win.getNormalBounds(); H.writeJsonAtomic(files.win, { ...b, maximized: win.isMaximized() }); }, 400); };
    win.on('resize', keep); win.on('move', keep); win.on('maximize', keep); win.on('unmaximize', keep);
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault(); win.hide();
      if (!prefs.trayHintShown && Notification.isSupported()) {
        prefs.trayHintShown = true; savePrefs();
        new Notification({ title: 'ODDIN은 트레이에서 계속 실행 중이에요', body: '작업이 끝나면 알려 드려요. 완전히 끄려면 트레이 아이콘 메뉴에서 "종료"를 누르세요.', icon: ICON }).show();
      }
    });
    win.on('focus', () => { win.flashFrame(false); refreshAll(); });

    const wc = win.webContents;
    wc.on('will-navigate', (e, url) => { if (!trusted(url)) { e.preventDefault(); openExternal(url); } });
    wc.setWindowOpenHandler(({ url }) => {
      if (H.isHubOrigin(state, url)) return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, backgroundColor: '#141416', autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      openExternal(url);
      return { action: 'deny' };
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || url.startsWith('file:')) return;
      const hub = current();
      // 연결 실패를 바로 상태에 반영해야 안내 화면이 "응답해요"라고 잘못 말하지 않는다
      live.set(hub.id, { ...statusOf(hub.id), status: 'offline', error: `연결할 수 없어요 (${desc})`, checkedAt: Date.now() });
      buildTray();
      showPage('offline', { hub: hub.name, url: hub.url, error: `연결할 수 없어요 (${desc})`, local: hub.local ? '1' : '' });
    });
    wc.on('did-create-window', (child) => { child.setMenuBarVisibility(false); child.webContents.on('will-navigate', (e, url) => { if (!H.isHubOrigin(state, url)) { e.preventDefault(); openExternal(url); } }); });
  }
  function openExternal(url) {
    try { const u = new URL(url); if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href); } catch {}
  }

  /* ---------- 자동 업데이트 (이 PC 허브가 내려주는 설치 파일로) ---------- */
  // 허브의 /desktop-updates/ 가 desktop/dist 의 latest.yml·설치 파일을 내려준다. 다른 PC는 Tailscale 주소의 허브에서 받는다.
  let updater = null, update = null; // update: { version, state: 'downloading'|'ready', percent }
  function setupUpdater() {
    if (!app.isPackaged) return;
    try { updater = require('electron-updater').autoUpdater; } catch { return; }
    updater.autoDownload = true; updater.autoInstallOnAppQuit = true; updater.logger = null;
    updater.on('update-available', (i) => { update = { version: i.version, state: 'downloading', percent: 0 }; buildTray(); });
    updater.on('download-progress', (p) => { if (update) update.percent = Math.round(p.percent || 0); });
    updater.on('update-downloaded', (i) => {
      update = { version: i.version, state: 'ready' }; buildTray();
      if (Notification.isSupported()) {
        const n = new Notification({ title: `ODDIN ${i.version} 업데이트 준비됨`, body: '눌러서 다시 시작하면 적용돼요. 그냥 두면 다음에 끌 때 적용돼요.', icon: ICON });
        n.on('click', () => installUpdate()); n.show();
      }
    });
    updater.on('error', () => { if (update?.state === 'downloading') { update = null; buildTray(); } });
  }
  function installUpdate() { if (update?.state === 'ready') { quitting = true; updater.quitAndInstall(false, true); } }
  async function checkUpdates(manual = false) {
    const say = (title, body = '') => { if (manual && Notification.isSupported()) new Notification({ title, body, icon: ICON }).show(); };
    if (!updater) return say('개발 실행에서는 업데이트를 확인하지 않아요');
    const src = [local(), ...state.hubs.filter((h) => !h.local)].find((h) => statusOf(h.id).status === 'online');
    if (!src) return say('업데이트를 확인할 허브에 연결할 수 없어요');
    try {
      updater.setFeedURL({ provider: 'generic', url: `${src.url}/desktop-updates/` });
      const r = await updater.checkForUpdates();
      if (!r?.isUpdateAvailable) say('최신 버전이에요', `지금 버전 ${app.getVersion()}`);
    } catch (e) { say('업데이트 확인에 실패했어요', String(e?.message || e).slice(0, 160)); }
  }

  /* ---------- 트레이 ---------- */
  function buildTray() {
    if (!tray) return;
    const hubItems = state.hubs.map((h) => {
      const st = statusOf(h.id).status;
      return { label: `${h.name}${h.local ? '' : ' (원격)'}${st === 'offline' ? ' · 연결 안 됨' : ''}`, type: 'radio', checked: h.id === state.current, click: () => switchHub(h.id) };
    });
    const login = app.getLoginItemSettings(loginOpts());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'ODDIN 열기', click: showWindow },
      { type: 'separator' },
      { label: '허브 전환', submenu: hubItems },
      { label: '원격 허브 추가…', click: () => command({ type: 'add-hub' }) },
      { label: '원격 접속 설정', click: () => command({ type: 'remote-settings' }) },
      { type: 'separator' },
      { label: 'Windows 시작 시 실행', type: 'checkbox', checked: !!login.openAtLogin, click: (item) => { app.setLoginItemSettings({ ...loginOpts(), openAtLogin: item.checked }); buildTray(); } },
      ...(root ? [{ label: '허브 폴더 열기', click: () => shell.openPath(root) }] : []),
      update?.state === 'ready'
        ? { label: `다시 시작해서 ${update.version} 적용`, click: installUpdate }
        : { label: update?.state === 'downloading' ? `업데이트 받는 중… ${update.version}` : `업데이트 확인 (지금 ${app.getVersion()})`, enabled: !update, click: () => checkUpdates(true) },
      { type: 'separator' },
      { label: '종료', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.setToolTip(busy ? `ODDIN · 작업 ${busy}개 실행 중` : `ODDIN · ${current().name}`);
  }
  function loginOpts() {
    return app.isPackaged ? { path: process.execPath, args: ['--hidden'] } : { path: process.execPath, args: [app.getAppPath(), '--hidden'] };
  }

  /* ---------- 허브 전환 ---------- */
  async function switchHub(id, sessionId) {
    const hub = H.hubById(state, id);
    if (!hub) throw new Error('없는 허브예요');
    if (id === state.current && sessionId && win && H.isHubOrigin(state, win.webContents.getURL()) && H.originOf(win.webContents.getURL()) === hub.url) {
      command({ type: 'open-session', sessionId });
      return;
    }
    state.current = id; save();
    busy = 0; if (win) win.setProgressBar(-1);
    buildTray(); showWindow();
    await openHub(hub, sessionId);
    refreshAll();
  }

  /* ---------- 화면 연결 (preload ↔ main) ---------- */
  const handle = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e.senderFrame?.url)) return { ok: false, error: '허용되지 않은 화면이에요' };
    try { return { ok: true, value: await fn(e, ...args) }; } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });
  const publicHubs = () => ({ current: state.current, hubs: state.hubs.map((h) => ({ id: h.id, name: h.name, url: h.url, local: !!h.local, status: statusOf(h.id).status, error: statusOf(h.id).error })) });
  ipcMain.on('hub:info', (e) => {
    const url = e.senderFrame?.url || '';
    e.returnValue = { version: app.getVersion(), isLocalHub: H.originOf(url) === local().url, trusted: trusted(url) };
  });
  handle('hubs:get', () => publicHubs());
  handle('hubs:switch', (_e, id, opts) => switchHub(String(id), opts?.sessionId ? String(opts.sessionId) : null));
  handle('hubs:add', async (_e, input) => {
    const draft = { current: state.current, hubs: state.hubs.map((h) => ({ ...h })) };
    const hub = H.addHub(draft, { name: input?.name, url: input?.url });
    const p = await probe(hub);
    if (p.status !== 'online') throw new Error(`연결 확인 실패: ${p.error}`);
    state = draft; save();
    live.set(hub.id, { ...p, sessions: null, checkedAt: Date.now() });
    buildTray(); refreshAll().then(() => send('hubs-changed'));
    return { id: hub.id, name: hub.name, url: hub.url, local: false, status: 'online', error: null };
  });
  handle('hubs:rename', (_e, id, name) => { const h = H.renameHub(state, String(id), name); save(); buildTray(); send('hubs-changed'); return { id: h.id, name: h.name, url: h.url, local: !!h.local, status: statusOf(h.id).status, error: statusOf(h.id).error }; });
  handle('hubs:remove', async (_e, id) => {
    const wasCurrent = state.current === String(id);
    H.removeHub(state, String(id)); live.delete(String(id)); save(); buildTray(); send('hubs-changed');
    if (wasCurrent) await openHub(current());
  });
  handle('hubs:remote-sessions', async () => {
    const others = state.hubs.filter((h) => h.id !== state.current);
    if (others.some((h) => !statusOf(h.id).checkedAt || Date.now() - statusOf(h.id).checkedAt > 10_000 || (statusOf(h.id).status === 'online' && !statusOf(h.id).sessions))) await refreshAll();
    return state.hubs.filter((h) => h.id !== state.current).map((h) => {
      const st = statusOf(h.id);
      return { hubId: h.id, hubName: h.name, local: !!h.local, online: st.status === 'online', error: st.error, sessions: st.sessions || [] };
    });
  });
  ipcMain.on('notify', (e, n) => {
    if (!trusted(e.senderFrame?.url) || !Notification.isSupported()) return;
    if (win && win.isVisible() && win.isFocused()) return;
    const hubId = state.current;
    const sessionId = /^[\w-]{1,80}$/.test(String(n?.sessionId || '')) ? String(n.sessionId) : null;
    const note = new Notification({ title: String(n?.title || 'ODDIN').slice(0, 120), body: String(n?.body || '').slice(0, 240), icon: ICON });
    note.on('click', () => { showWindow(); if (sessionId) switchHub(hubId, sessionId).catch(() => {}); });
    note.show();
    if (win) win.flashFrame(true);
  });
  ipcMain.on('busy', (e, n) => {
    if (!trusted(e.senderFrame?.url) || !win) return;
    busy = Math.max(0, Math.min(99, Number(n) || 0));
    win.setProgressBar(busy ? 2 : -1, busy ? { mode: 'indeterminate' } : undefined);
    buildTray();
  });

  /* ---------- 시작 ---------- */
  // 두 번째 실행: 창 보이기. "ODDIN.exe --quit"이면 실행 중인 프로그램을 끈다(받아 둔 업데이트가 있으면 이때 설치)
  app.on('second-instance', (_e, argv) => { if (argv.includes('--quit')) { quitting = true; app.quit(); return; } showWindow(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {}); // 트레이에 남는다
  app.whenReady().then(async () => {
    const allow = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications']);
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(allow.has(perm) && trusted(details?.requestingUrl || '')));
    session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => allow.has(perm) && trusted(origin || ''));
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '보기', submenu: [
      { role: 'reload', accelerator: 'CmdOrCtrl+R', label: '새로고침' }, { role: 'forceReload', label: '강제 새로고침' },
      { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I', label: '개발자 도구' }, { type: 'separator' },
      { role: 'resetZoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' },
    ] }]));
    const trayImg = nativeImage.createFromPath(TRAY_ICON);
    tray = new Tray(trayImg.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : trayImg);
    tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
    if (app.isPackaged && !fs.existsSync(startMenuLink())) { try { writeShortcut(startMenuLink()); } catch {} } // 알림에 필요한 시작 메뉴 바로가기가 없으면 만든다
    setupUpdater();
    createWindow(); buildTray();
    showPage('loading');
    await openHub(current());
    refreshAll();
    setInterval(refreshAll, REFRESH_MS).unref?.();
    setTimeout(() => checkUpdates(false), 15_000); // 켠 뒤 잠시 있다가, 그다음은 6시간마다
    setInterval(() => checkUpdates(false), 6 * 3600_000).unref?.();
  });
}

