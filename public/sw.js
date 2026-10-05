/* ODDIN 서비스 워커 — 폰 알림만 받는다(화면 파일을 저장해 두지 않음: 늘 허브에서 최신 화면을 받는다).
   서버 lib/push.mjs 가 보낸 { title, body, url, tag } 를 알림으로 띄우고, 누르면 그 세션을 연다(열린 앱이 있으면 그 창에서). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'ODDIN', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'app/icon-192.png',
    badge: 'app/icon-192.png',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins[0];
    if (w) { w.postMessage({ type: 'open', url }); return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
