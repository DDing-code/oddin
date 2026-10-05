/* 폰 앱·알림 (2026-10-06 사용자 "오딘 앱으로도 쓰고 싶어 아이폰")
   - 홈 화면에 추가: manifest.webmanifest · app/ 아이콘 · mobile.css (아이폰은 사파리 공유 → 홈 화면에 추가)
   - 알림: 서비스 워커(sw.js)를 등록하고, 계정 메뉴 "폰 알림"에서 켜면 이 기기 구독을 허브에 저장(서버 lib/push.mjs).
     아이폰은 홈 화면에 추가한 앱 안에서만 알림을 켤 수 있다(iOS 16.4+). 알림을 누르면 그 세션이 열린다.
   - 나눈 칸·새 창(embed)에서는 아무것도 하지 않는다. */
(() => {
  if (document.documentElement.classList.contains('embed')) return;
  const hasSW = 'serviceWorker' in navigator && window.isSecureContext;
  const supported = hasSW && 'PushManager' in window && 'Notification' in window;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let reg = null;

  // 폰처럼 좁은 화면: 입력창 안내 글을 짧게(긴 안내가 두 줄로 잘려 보이지 않게)
  const inp = document.getElementById('in'), longPh = inp?.placeholder || '';
  const narrow = matchMedia('(max-width: 560px)');
  window.hubInputPh = () => (narrow.matches ? '무엇을 할까요?' : longPh); // intercept.js 가 안내 글을 되돌릴 때도 이 값
  const setPh = () => { if (inp && !inp.disabled) inp.placeholder = window.hubInputPh(); };
  narrow.addEventListener?.('change', setPh); setPh();

  if (hasSW) {
    navigator.serviceWorker.register('sw.js').then((r) => { reg = r; }).catch(() => {});
    // 알림을 눌렀을 때 이미 열린 앱이면 그 세션으로
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type !== 'open') return;
      const m = String(d.url || '').match(/s=([\w-]+)/);
      if (m && S.sessions.has(m[1]) && typeof openSession === 'function') openSession(m[1]);
    });
  }

  const toBytes = (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  const sameKey = (sub, key) => { try { const a = new Uint8Array(sub.options.applicationServerKey), b = toBytes(key); return a.length === b.length && a.every((x, i) => x === b[i]); } catch { return false; } };
  const deviceName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? '아이폰' : /iPad/.test(u) || (isIOS && !/iPhone/.test(u)) ? '아이패드' : /Android/.test(u) ? '안드로이드' : /Windows/.test(u) ? 'Windows PC' : /Mac/.test(u) ? 'Mac' : '기기'; };
  async function mySub() { try { const r = reg || (hasSW && await navigator.serviceWorker.getRegistration()); return r ? await r.pushManager.getSubscription() : null; } catch { return null; } }

  async function enable() {
    if (!supported) { toast(isIOS && !standalone() ? '먼저 사파리 공유 버튼 → 홈 화면에 추가 → 홈 화면의 ODDIN 앱에서 켜 주세요' : '이 브라우저는 알림을 지원하지 않아요', true); return false; }
    const perm = await Notification.requestPermission(); // 누른 순간 바로 물어야 한다(아이폰)
    if (perm !== 'granted') { toast('알림이 허용되지 않았어요. 아이폰 설정 → 알림 → ODDIN 에서 켤 수 있어요', true); return false; }
    try {
      reg = reg || await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await api('/api/push');
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
      sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
      await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), name: deviceName() }) });
      toast('이 기기 알림을 켰어요 — 작업이 끝나거나 질문이 오면 알려요');
      return true;
    } catch (e) { toast(`알림을 켜지 못했어요: ${e.message}`, true); return false; }
  }
  async function disable() {
    const sub = await mySub();
    if (sub) { try { await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }); } catch {} await sub.unsubscribe().catch(() => {}); }
    toast('이 기기 알림을 껐어요');
  }

  async function open() {
    const body = modal('폰 앱 · 알림', true);
    body.innerHTML = '<div class="push-box"><div class="c-muted">불러오는 중…</div></div>';
    let info = { devices: [] }, rem = null, sub = null;
    try { [info, rem, sub] = await Promise.all([api('/api/push'), api('/api/remote').catch(() => null), mySub()]); } catch (e) { body.innerHTML = `<div class="push-box"><p class="c-err">${esc(e.message)}</p></div>`; return; }
    const on = !!sub, phone = isIOS || /Android/.test(navigator.userAgent);
    const addr = rem?.url || '';
    const steps = `<ol class="push-steps">
        <li>아이폰에 <b>Tailscale</b> 앱을 깔고 이 PC와 같은 계정으로 로그인해 켜요</li>
        <li>사파리에서 ${addr ? `<code>${esc(addr)}</code>` : '원격 접속 주소'}를 열어요${addr ? ` <button class="btn mini-btn" data-push-copy>주소 복사</button>` : ''}</li>
        <li>아래 <b>공유</b> 버튼 → <b>홈 화면에 추가</b></li>
        <li>홈 화면의 <b>ODDIN</b>을 열고, 왼쪽 아래 계정 메뉴 → <b>폰 앱 · 알림</b> → <b>이 기기 알림 켜기</b></li>
      </ol>`;
    body.innerHTML = `<div class="push-box">
      ${!phone || !standalone() ? `<section><h4>아이폰에 앱으로 넣기</h4>${steps}${addr ? '' : '<p class="c-muted">원격 접속이 꺼져 있어요. 계정 메뉴 → 원격 접속에서 먼저 켜 주세요</p>'}</section>` : ''}
      <section><h4>이 기기 알림</h4>
        <p class="c-muted">${!supported ? (isIOS ? '홈 화면에 추가한 ODDIN 앱에서만 켤 수 있어요(iOS 16.4 이상)' : '이 브라우저는 알림을 지원하지 않아요') : on ? '켜져 있어요. 작업이 끝나거나(완료·일부 완료·실패) 질문·승인 요청이 오면 알려요' : '꺼져 있어요'}</p>
        <div class="push-acts">${supported ? (on ? '<button class="btn" data-push-off>이 기기 알림 끄기</button>' : '<button class="btn primary" data-push-on>이 기기 알림 켜기</button>') : ''}${info.devices.length ? '<button class="btn" data-push-test>모든 기기에 시험 알림</button>' : ''}</div>
      </section>
      <section><h4>알림 받는 기기 ${info.devices.length ? `· ${info.devices.length}대` : ''}</h4>
        ${info.devices.length ? `<div class="push-devs">${info.devices.map((d) => `<div class="push-dev"><span class="ico-w">${icon('bell')}</span><span class="grow"><b>${esc(d.name)}</b><small>${d.lastError ? `<span class="c-err">마지막 전송 실패: ${esc(d.lastError)}</span>` : d.lastOk ? `마지막 알림 ${esc(new Date(d.lastOk).toLocaleString('ko-KR'))}` : `켠 날 ${esc(new Date(d.createdAt).toLocaleDateString('ko-KR'))}`}</small></span><button class="btn" data-push-rm="${esc(d.id)}">빼기</button></div>`).join('')}</div>` : '<p class="c-muted">아직 없어요</p>'}
      </section></div>`;
    const q = (s) => body.querySelector(s);
    q('[data-push-copy]')?.addEventListener('click', () => copyText(addr, '주소를 복사했어요'));
    q('[data-push-on]')?.addEventListener('click', async () => { if (await enable()) open(); });
    q('[data-push-off]')?.addEventListener('click', async () => { await disable(); open(); });
    q('[data-push-test]')?.addEventListener('click', async () => {
      try { const r = await api('/api/push/test', { method: 'POST', body: '{}' }); const ok = r.results.filter((x) => x.ok).length; toast(ok ? `시험 알림을 ${ok}대에 보냈어요` : `보내지 못했어요: ${r.results.map((x) => x.error || (x.gone ? '구독이 끊김' : '')).filter(Boolean).join(', ') || '받을 기기 없음'}`, !ok); open(); } catch (e) { toast(e.message, true); }
    });
    body.querySelectorAll('[data-push-rm]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ id: b.dataset.pushRm }) }); open(); } catch (e) { toast(e.message, true); }
    }));
  }
  window.hubPushOpen = open;
})();
