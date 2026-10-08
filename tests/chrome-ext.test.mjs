// 크롬 연결(2026-10-08): 허브 lib/chrome-ext.mjs ↔ 확장 chrome-extension/core.js 를 가짜 크롬으로 맞물려 돌린다.
// 실제 크롬으로 하는 확인은 docs/chrome-extension.md "직접 확인".
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeExtBrowser, EXT_ID, EXT_ORIGIN, isExtRequest } from '../lib/chrome-ext.mjs';
import { checkRemoteRequest } from '../lib/remote.mjs';
import { createConnector, ALLOWED } from '../chrome-extension/core.js';

/** 가짜 크롬: 창·탭·디버거·저장소. 디버거 명령은 기록하고 그럴듯하게 답한다 */
function fakeChrome() {
  let nextTab = 100, nextWin = 10;
  const tabs = new Map(), wins = new Map(), sent = [], attachedTabs = new Set(), store = { local: {}, session: {} };
  const bag = (k) => ({ get: async (def) => ({ ...def, ...store[k] }), set: async (o) => { Object.assign(store[k], o); } });
  const chrome = {
    runtime: { id: EXT_ID, getManifest: () => ({ version: '0.1.0' }), getPlatformInfo: (cb) => cb?.({}) },
    storage: { local: bag('local'), session: bag('session') },
    windows: {
      create: async ({ url }) => { const w = { id: nextWin++, state: 'normal' }; wins.set(w.id, w); const t = { id: nextTab++, windowId: w.id, url, title: '', active: true }; tabs.set(t.id, t); return { ...w, tabs: [t] }; },
      get: async (id) => { const w = wins.get(id); if (!w) throw new Error('No window'); return w; },
    },
    tabs: {
      create: async ({ windowId, url }) => { for (const t of tabs.values()) if (t.windowId === windowId) t.active = false; const t = { id: nextTab++, windowId, url, title: '', active: true }; tabs.set(t.id, t); return t; },
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('No tab'); return t; },
      update: async (id, o) => { const t = tabs.get(id); if (o.active) for (const x of tabs.values()) if (x.windowId === t.windowId) x.active = false; Object.assign(t, o); return t; },
      remove: async (id) => { tabs.delete(id); },
    },
    debugger: {
      attach: async ({ tabId }) => { if (!tabs.has(tabId)) throw new Error('No tab'); attachedTabs.add(tabId); },
      detach: async ({ tabId }) => { attachedTabs.delete(tabId); },
      sendCommand: async ({ tabId }, method, params) => {
        if (!attachedTabs.has(tabId)) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        sent.push({ tabId, method, params });
        const t = tabs.get(tabId);
        if (method === 'Page.navigate') { t.url = params.url; t.title = '시험 페이지'; return { frameId: 'f' }; }
        if (method === 'Runtime.evaluate') {
          const e = params.expression;
          if (e === 'document.readyState') return { result: { value: 'complete' } };
          if (e.startsWith('({ url: location.href')) return { result: { value: { url: t.url, title: t.title } } };
          if (e.includes('data-oddin-ref')) return { result: { value: { url: t.url, title: t.title, text: '안녕', items: [], scroll: {} } } };
          return { result: { value: 42 } };
        }
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
        return {};
      },
    },
  };
  return { chrome, tabs, wins, sent, attachedTabs, store };
}

/** 허브와 확장을 HTTP 없이 잇는다(확장의 fetch → 허브 메서드) */
function wire(hub, chrome) {
  const doFetch = async (url, init) => {
    const name = url.split('/api/chrome-ext/')[1], body = JSON.parse(init.body);
    assert.equal(init.headers['X-Oddin-Ext'], EXT_ID);
    try {
      const out = name === 'hello' ? hub.hello(body) : name === 'poll' ? await hub.poll({ ...body, wait: Math.min(body.wait, 0.2) }) : hub.result(body);
      return { ok: true, status: 200, json: async () => out };
    } catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: e.message }) }; }
  };
  const ext = createConnector({ chrome, fetch: doFetch, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
  return ext;
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

test('확장이 붙기 전에는 "확장이 연결돼 있지 않아요"', async () => {
  const hub = new ChromeExtBrowser();
  try {
    assert.equal(hub.running, false);
    await assert.rejects(hub.act('job1/t1', { action: 'open', url: 'example.com' }), (e) => e.status === 503 && /크롬 확장이 연결돼 있지 않아요/.test(e.message));
  } finally { hub.dispose(); }
});

test('작업자 동작이 확장을 거쳐 크롬의 ODDIN 창 탭에서 실행된다', async () => {
  const hub = new ChromeExtBrowser(), f = fakeChrome(), ext = wire(hub, f.chrome);
  try {
    ext.loop();
    assert.ok(await until(() => hub.running), '연결됨');
    const r = await hub.act('job1/t1', { action: 'open', url: 'example.com' });
    assert.equal(r.url, 'https://example.com');
    assert.equal(f.wins.size, 1, '따로 ODDIN 창을 하나 띄움');
    const [tabId] = [...f.tabs.keys()];
    assert.ok(f.sent.some((x) => x.method === 'Page.navigate' && x.params.url === 'https://example.com'));
    assert.ok(f.sent.some((x) => x.method === 'Emulation.setDeviceMetricsOverride'));
    assert.deepEqual([...hub.tabs.keys()], [String(tabId)]);
    // 같은 작업은 같은 탭, 다른 작업은 같은 창의 새 탭
    assert.equal((await hub.act('job1/t1', { action: 'read' })).text, '안녕');
    await hub.act('job2/t1', { action: 'open', url: 'https://example.org' });
    assert.equal(f.wins.size, 1); assert.equal(f.tabs.size, 2);
    const shot = await hub.act('job1/t1', { action: 'screenshot' });
    assert.equal(Buffer.from(shot.image, 'base64').toString(), 'png');
    assert.equal(f.tabs.get(tabId).active, true, '화면 찍기 전에 그 탭을 앞으로');
    // 서비스 워커가 다시 켜져 붙은 것을 잊어도 다시 붙여서 이어 간다
    f.attachedTabs.clear();
    assert.equal((await hub.act('job1/t1', { action: 'eval', expression: '6*7' })).value, 42);
    await hub.act('job1/t1', { action: 'close' });
    assert.ok(!f.tabs.has(tabId)); assert.equal(hub.tabs.size, 1);
  } finally { await ext.setEnabled(false); hub.dispose(); }
});

test('확장은 ODDIN 이 연 탭과 정해진 명령만 받는다', async () => {
  const f = fakeChrome(), ext = createConnector({ chrome: f.chrome, fetch: async () => { throw new Error('안 씀'); } });
  await ext.load();
  f.tabs.set(5, { id: 5, windowId: 1, url: 'https://mail.example.com', active: true }); // 사용자가 원래 열어 둔 탭
  await assert.rejects(ext.exec({ method: 'Runtime.evaluate', params: { expression: '1' }, tab: '5' }), /ODDIN 이 연 탭이 아니에요/);
  await assert.rejects(ext.exec({ method: 'Target.attachToTarget', params: { targetId: '5' } }), /ODDIN 이 연 탭이 아니에요/);
  await assert.rejects(ext.exec({ method: 'Target.closeTarget', params: { targetId: '5' } }), /ODDIN 이 연 탭이 아니에요/);
  const { targetId } = await ext.exec({ method: 'Target.createTarget', params: { url: 'about:blank' } });
  for (const m of ['Network.getAllCookies', 'Storage.getCookies', 'Browser.close', 'Target.getTargets', 'Runtime.callFunctionOn']) {
    assert.ok(!ALLOWED.has(m));
    await assert.rejects(ext.exec({ method: m, params: {}, tab: targetId }), /허용하지 않는 명령/);
    await assert.rejects(ext.exec({ method: m, params: {} }), /허용하지 않는 명령/);
  }
  assert.ok(f.tabs.has(5), '사용자 탭은 그대로');
});

test('크롬 알림줄에서 [취소]를 누르면 연결을 끄고 허브는 탭을 잊는다', async () => {
  const hub = new ChromeExtBrowser(), f = fakeChrome(), ext = wire(hub, f.chrome);
  try {
    ext.loop();
    assert.ok(await until(() => hub.running));
    await hub.act('job1/t1', { action: 'open', url: 'example.com' });
    const [tabId] = [...f.tabs.keys()];
    ext.onDetach({ tabId }, 'canceled_by_user');
    assert.ok(await until(() => hub.tabs.size === 0), '허브 탭 목록에서 빠짐');
    assert.ok(await until(() => ext.status().enabled === false));
    assert.ok(f.tabs.has(tabId), '탭은 열어 둔 채');
    assert.deepEqual(f.store.local.enabled, false);
  } finally { await ext.setEnabled(false); hub.dispose(); }
});

test('다른 브라우저의 확장이 기다리는 중이면 두 번째는 409, 같은 확장이 다시 켜지면 넘겨받는다', async () => {
  const hub = new ChromeExtBrowser();
  try {
    hub.hello({ instance: 'a', agent: 'Mozilla/5.0 Chrome/153.0' });
    const waiting = hub.poll({ instance: 'a', wait: 1 });
    assert.throws(() => hub.hello({ instance: 'b', agent: 'Mozilla/5.0 Chrome/153.0 Edg/155.0' }), (e) => e.status === 409 && /다른 브라우저/.test(e.message));
    await waiting; // 기다리기가 끝나 지금 기다리는 확장이 없다 → 다시 켜진 것으로 보고 넘겨받음
    assert.deepEqual(Object.keys(hub.hello({ instance: 'b', agent: 'x' })), ['hub']);
    assert.throws(() => hub.mine('a'), (e) => e.status === 409);
  } finally { hub.dispose(); }
});

test('허브 관문: 확장 출처는 /api/chrome-ext/ 만, 웹 페이지 출처·원격은 막는다', () => {
  const req = (url, origin, extra = {}) => ({ method: 'POST', url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:7700', ...(origin ? { origin } : {}), ...extra } });
  assert.equal(checkRemoteRequest(req('/api/chrome-ext/poll', EXT_ORIGIN), { port: 7700 }), null);
  assert.equal(checkRemoteRequest(req('/api/browser/act', EXT_ORIGIN), { port: 7700 })?.code, 'bad_origin');
  assert.equal(checkRemoteRequest(req('/api/chrome-ext/poll', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { port: 7700 })?.code, 'bad_origin');
  assert.equal(checkRemoteRequest(req('/api/chrome-ext/poll', 'https://evil.example'), { port: 7700 })?.code, 'bad_origin');
  assert.equal(isExtRequest(req('/api/chrome-ext/poll', EXT_ORIGIN, { 'x-oddin-ext': EXT_ID })), true);
  assert.equal(isExtRequest(req('/api/chrome-ext/poll', null, { 'x-oddin-ext': EXT_ID })), true, '출처 없이 머리만(이 PC 의 프로그램)');
  assert.equal(isExtRequest(req('/api/chrome-ext/poll', EXT_ORIGIN)), false, '머리 없음');
  assert.equal(isExtRequest(req('/api/chrome-ext/poll', 'http://127.0.0.1:7700', { 'x-oddin-ext': EXT_ID })), false, 'ODDIN 화면 출처도 아님');
});

test('확장 manifest 의 key 가 EXT_ID 와 맞는다', async () => {
  const fs = await import('node:fs'), crypto = await import('node:crypto');
  const m = JSON.parse(fs.readFileSync(new URL('../chrome-extension/manifest.json', import.meta.url), 'utf8'));
  const id = [...crypto.createHash('sha256').update(Buffer.from(m.key, 'base64')).digest('hex').slice(0, 32)].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
  assert.equal(id, EXT_ID);
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1/*']);
});
