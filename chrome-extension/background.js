// ODDIN 크롬 연결 — 서비스 워커. 본체는 core.js, 여기서는 크롬 소식을 잇고 배지를 그린다.
import { createConnector } from './core.js';

const badge = (s) => {
  const text = !s.enabled ? '끔' : !s.connected ? '!' : s.tabs.length ? String(s.tabs.length) : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: !s.enabled ? '#888888' : !s.connected ? '#c0392b' : '#2e7d32' }).catch(() => {});
  chrome.action.setTitle({ title: `ODDIN 크롬 연결 — ${!s.enabled ? '꺼짐' : s.connected ? `연결됨${s.tabs.length ? ` · AI 탭 ${s.tabs.length}개` : ''}` : s.error || '연결 중'}` }).catch(() => {});
};
const c = createConnector({ chrome, onChange: badge });

chrome.tabs.onUpdated.addListener(c.onTabUpdated);
chrome.tabs.onRemoved.addListener(c.onTabRemoved);
chrome.windows.onRemoved.addListener(c.onWindowRemoved);
chrome.debugger.onEvent.addListener(c.onDebuggerEvent);
chrome.debugger.onDetach.addListener(c.onDetach);

// 서비스 워커는 쉬면 꺼진다 — 30초마다 깨워서 연결이 끊겼으면 다시 잇는다
chrome.alarms.create('oddin-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'oddin-keepalive') c.loop(); });
chrome.runtime.onStartup.addListener(() => c.loop());
chrome.runtime.onInstalled.addListener(() => c.loop());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL('popup.html'))) return; // 이 확장의 팝업에서 온 것만
  (async () => {
    await c.load();
    if (msg?.type === 'enable') await c.setEnabled(!!msg.on);
    else if (msg?.type === 'port') { await c.setPort(msg.port); c.loop(); }
    else if (msg?.type === 'closeAll') await c.closeAll();
    const s = c.status();
    const tabs = [];
    for (const id of s.tabs) { try { const t = await chrome.tabs.get(id); tabs.push({ id, title: t.title, url: t.url }); } catch {} }
    return { ...s, tabs };
  })().then((s) => { badge({ ...s, tabs: s.tabs.map((t) => t.id) }); reply({ ok: true, status: s }); }, (e) => reply({ ok: false, error: e.message }));
  return true;
});

c.load().then(() => { badge(c.status()); c.loop(); });
