// ODDIN 크롬 연결 — 확장 본체 (2026-10-08 사용자 "크롬에서 로그인한 화면을 쓰고 싶은데 확장프로그램으로 만들어서 코덱스나 클로드가 조작할 수 있게").
// 서비스 워커(background.js)가 이걸 만들어 돌린다. chrome·fetch 를 바깥에서 받아서 시험(tests/chrome-ext.test.mjs)에서도 돈다.
//
// 허브(lib/chrome-ext.mjs)와는 롱 폴링으로 이야기한다 — 모두 POST, 머리 X-Oddin-Ext: <확장 id>
//   /api/chrome-ext/hello  { instance, version, agent }          → { hub }          연결(허브가 다시 켜졌는지 hub 로 안다)
//   /api/chrome-ext/poll   { instance, wait }                    → { cmds: [...] }  명령 기다리기(최대 wait 초)
//   /api/chrome-ext/result { instance, results: [...], events }  → { ok }           명령 결과·탭 소식
// 명령은 CDP 그대로다({ id, method, params, tab }). tab 이 있으면 chrome.debugger 로 그 탭에 보내고,
// 없으면 탭 만들기·붙이기·닫기(Target.createTarget·attachToTarget·closeTarget)만 받는다.
//
// 지키는 것
// - 작업자는 ODDIN 이 연 탭(ODDIN 창 안)만 다룬다. 사용자가 원래 열어 둔 탭에는 손대지 않는다.
// - 쓸 수 있는 CDP 명령은 아래 ALLOWED 뿐이다(쿠키·저장소를 통째로 꺼내는 명령, 브라우저 끄기 등은 막음).
// - 크롬 위쪽 "디버깅 중" 알림줄에서 [취소]를 누르면 연결을 끈다(팝업에서 다시 켬).
export const ALLOWED = new Set([
  'Page.enable', 'Page.navigate', 'Page.reload', 'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.handleJavaScriptDialog',
  'Runtime.enable', 'Runtime.evaluate',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Emulation.setDeviceMetricsOverride',
]);
const EVENTS = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Page.javascriptDialogOpening']);
const WAIT_SECONDS = 20; // 서비스 워커는 30초 동안 아무 일도 없으면 꺼진다 — 그보다 짧게 기다리고 다시 부른다

export function createConnector({ chrome, fetch: doFetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onChange = () => {} }) {
  const st = { port: 7700, enabled: true, connected: false, error: '', hub: null, windowId: null };
  const tabs = new Set(); // ODDIN 이 연 탭 id
  const attached = new Set();
  const instance = (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2));
  let looping = false, loaded = null, outbox = { results: [], events: [] }, flushT = null;

  const changed = () => { try { onChange(status()); } catch {} };
  const save = () => chrome.storage.session.set({ oddinTabs: [...tabs], oddinWindow: st.windowId, oddinHub: st.hub }).catch(() => {});
  function load() {
    return (loaded ||= (async () => {
      const a = await chrome.storage.local.get({ port: 7700, enabled: true });
      st.port = Number(a.port) || 7700; st.enabled = a.enabled !== false;
      const s = await chrome.storage.session.get({ oddinTabs: [], oddinWindow: null, oddinHub: null });
      for (const id of s.oddinTabs) tabs.add(id);
      st.windowId = s.oddinWindow; st.hub = s.oddinHub;
    })());
  }

  async function post(name, body, timeoutMs = 15_000) {
    const r = await doFetch(`http://127.0.0.1:${st.port}/api/chrome-ext/${name}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Oddin-Ext': chrome.runtime.id },
      body: JSON.stringify({ instance, ...body }), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `ODDIN 이 ${r.status}로 답했어요`), { status: r.status });
    return j;
  }
  function setConnected(on, error = '') {
    if (st.connected === on && st.error === error) return;
    st.connected = on; st.error = error; changed();
  }

  /** 허브와 계속 이야기한다(이미 돌고 있으면 그대로) */
  async function loop() {
    await load();
    if (looping || !st.enabled) return;
    looping = true;
    try {
      while (st.enabled) {
        try {
          if (!st.connected) {
            const h = await post('hello', { version: chrome.runtime.getManifest().version, agent: globalThis.navigator?.userAgent || '' });
            if (st.hub && h.hub !== st.hub) forgetAll(); // 허브가 다시 켜졌다 — 허브는 예전 탭을 모른다(탭은 열어 둔 채 놓는다)
            st.hub = h.hub; save();
            setConnected(true);
          }
          chrome.runtime.getPlatformInfo?.(() => {}); // 확장 API 를 부르면 서비스 워커가 꺼지지 않는다
          const { cmds = [] } = await post('poll', { wait: WAIT_SECONDS }, (WAIT_SECONDS + 10) * 1000);
          for (const c of cmds) run(c);
        } catch (e) {
          setConnected(false, e.status === 409 ? e.message : e.status ? e.message : 'ODDIN 에 연결하지 못했어요(ODDIN 이 켜져 있는지 확인해 주세요)');
          await sleep(e.status === 409 ? 10_000 : 3000);
        }
      }
    } finally { looping = false; }
  }

  async function run(c) {
    let res;
    try { res = { id: c.id, ok: true, result: (await exec(c)) ?? {} }; }
    catch (e) { res = { id: c.id, ok: false, error: String(e?.message || e) }; }
    out('results', res);
  }
  function out(kind, item) {
    outbox[kind].push(item);
    if (!flushT) flushT = setTimeout(flush, kind === 'results' ? 0 : 50);
  }
  async function flush() {
    flushT = null;
    const body = outbox; outbox = { results: [], events: [] };
    if (!body.results.length && !body.events.length) return;
    try { await post('result', body); } catch { try { await sleep(500); await post('result', body); } catch {} }
  }
  const emit = (method, params, sessionId) => { if (st.connected) out('events', { method, params, ...(sessionId ? { sessionId } : {}) }); };

  /* ---------- 명령 실행 ---------- */
  async function exec({ method, params = {}, tab }) {
    if (tab == null) {
      if (method === 'Target.createTarget') return { targetId: String(await newTab(params.url)) };
      if (method === 'Target.attachToTarget') { const id = mine(params.targetId); await attach(id); return { sessionId: String(id) }; }
      if (method === 'Target.closeTarget') { const id = mine(params.targetId); forget(id); await chrome.tabs.remove(id).catch(() => {}); return { success: true }; }
      throw new Error(`허용하지 않는 명령이에요: ${method}`);
    }
    const id = mine(tab);
    if (!ALLOWED.has(method)) throw new Error(`허용하지 않는 명령이에요: ${method}`);
    if (method === 'Page.captureScreenshot') await showTab(id);
    return send(id, method, params);
  }
  function mine(raw) {
    const id = Number(raw);
    if (!tabs.has(id)) throw new Error('ODDIN 이 연 탭이 아니에요(사용자 탭은 다루지 않아요)');
    return id;
  }
  async function send(tabId, method, params) {
    if (!attached.has(tabId)) await attach(tabId);
    try { return await chrome.debugger.sendCommand({ tabId }, method, params); }
    catch (e) {
      if (!/not attached/i.test(String(e?.message))) throw e;
      attached.delete(tabId); await attach(tabId); // 서비스 워커가 다시 켜지면서 붙은 것을 잊었다
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
  }
  async function attach(tabId) {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (e) { if (!/already attached/i.test(String(e?.message))) throw new Error(`이 탭에 붙지 못했어요: ${e?.message || e}`); }
    attached.add(tabId);
    for (const m of ['Page.enable', 'Runtime.enable']) await chrome.debugger.sendCommand({ tabId }, m, {}).catch(() => {});
  }
  async function windowAlive() {
    if (st.windowId == null) return false;
    try { await chrome.windows.get(st.windowId); return true; } catch { return false; }
  }
  /** 작업자 탭은 따로 띄운 "ODDIN" 창에 연다 — 사용자가 보던 창·탭은 그대로 */
  async function newTab(url = 'about:blank') {
    let tab;
    if (await windowAlive()) tab = await chrome.tabs.create({ windowId: st.windowId, url: url || 'about:blank', active: true });
    else {
      const w = await chrome.windows.create({ url: url || 'about:blank', focused: false, width: 1300, height: 1000 });
      st.windowId = w.id; tab = w.tabs[0];
    }
    tabs.add(tab.id); save(); changed();
    return tab.id;
  }
  /** 화면 찍기는 그 창에서 보이는 탭이어야 한다(가려진 탭은 그림이 안 나온다) */
  async function showTab(tabId) {
    const t = await chrome.tabs.get(tabId);
    const w = await chrome.windows.get(t.windowId);
    if (w.state === 'minimized') throw new Error('크롬의 ODDIN 창이 최소화돼 있어 화면을 볼 수 없어요. 창을 펼쳐 주세요');
    if (!t.active) { await chrome.tabs.update(tabId, { active: true }); await sleep(150); }
  }
  function forget(id) {
    if (!tabs.delete(id)) return;
    if (attached.delete(id)) chrome.debugger.detach({ tabId: id }).catch(() => {});
    save(); changed();
  }
  function forgetAll() { for (const id of [...tabs]) forget(id); }

  /* ---------- 크롬 소식 ---------- */
  function onTabUpdated(tabId, info, tab) {
    if (!tabs.has(tabId) || !(info.title || info.url || info.status === 'complete')) return;
    emit('Target.targetInfoChanged', { targetInfo: { targetId: String(tabId), type: 'page', title: tab?.title || '', url: tab?.url || '' } });
  }
  function onTabRemoved(tabId) {
    if (!tabs.has(tabId)) return;
    attached.delete(tabId); forget(tabId);
    emit('Target.targetDestroyed', { targetId: String(tabId) });
  }
  function onWindowRemoved(windowId) { if (windowId === st.windowId) { st.windowId = null; save(); } }
  function onDebuggerEvent(source, method, params) {
    if (tabs.has(source.tabId) && EVENTS.has(method)) emit(method, params, String(source.tabId));
  }
  function onDetach(source, reason) {
    if (!tabs.has(source.tabId)) return;
    attached.delete(source.tabId);
    if (reason === 'canceled_by_user') {
      // 크롬 알림줄에서 [취소] = 그만 조작해 달라는 뜻. 연결을 끄고 탭은 열어 둔 채 놓는다
      setEnabled(false);
    }
  }

  /* ---------- 팝업 ---------- */
  function status() { return { enabled: st.enabled, port: st.port, connected: st.connected, error: st.error, tabs: [...tabs], windowId: st.windowId }; }
  async function setEnabled(on) {
    await load();
    st.enabled = !!on; await chrome.storage.local.set({ enabled: st.enabled });
    if (!st.enabled) { for (const id of [...tabs]) { emit('Target.targetDestroyed', { targetId: String(id) }); forget(id); } await flush(); setConnected(false, ''); }
    else loop();
    changed();
  }
  async function setPort(port) {
    await load();
    const p = Math.round(Number(port));
    if (!(p > 0 && p < 65536)) throw new Error('포트 번호가 이상해요');
    st.port = p; await chrome.storage.local.set({ port: p });
    setConnected(false, ''); changed();
  }
  async function closeAll() {
    await load();
    for (const id of [...tabs]) { emit('Target.targetDestroyed', { targetId: String(id) }); forget(id); await chrome.tabs.remove(id).catch(() => {}); }
    await flush();
  }

  return { loop, exec, status, setEnabled, setPort, closeAll, load, onTabUpdated, onTabRemoved, onWindowRemoved, onDebuggerEvent, onDetach, flush, _tabs: tabs };
}
