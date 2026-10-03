/* AI Hub — 원격 접속 화면: 설정 › 원격 접속 섹션, 사이드바 "원격" 배지, 연결 끊김 안내 줄
   commands.js 다음에 읽힌다. 서버 계약은 workspace/remote-access-plan.md 4절 (GET /api/remote, POST /api/remote/enable|disable).
   옛 서버(원격 기능 없음)는 /api/remote 에 404 를 돌려주므로 "재시작 필요"로 안내한다. */
'use strict';

IC.globe = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>';
IC.unplug = '<path d="m19 5 3-3M2 22l3-3M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4z"/><path d="M7.5 13.5 10 11M10.5 16.5 13 14M12 6l6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0z"/>';

const REMOTE = { data: null, state: 'idle', error: '', busy: '', result: null, at: 0, inflight: null };
const TS_STATE_KO = { NotInstalled: '설치 안 됨', NotRunning: '실행 안 됨', Stopped: '연결 끊김', Starting: '연결 중', NeedsLogin: '로그인 필요', NeedsMachineAuth: '기기 승인 필요', Running: '연결됨', Unknown: '알 수 없음' };
const REMOTE_STEPS = ['Tailscale 설치', '로그인·연결', 'HTTPS 허용', '공유 켜기'];
const REMOTE_STEP_AT = { install: 0, start: 1, login: 1, 'enable-https': 2, enable: 3, conflict: 3, ready: 4 };
const REMOTE_STEP_MSG = {
  install: '이 PC에 Tailscale이 없어요. 먼저 설치하세요.',
  start: 'Tailscale이 꺼져 있어요. 작업 표시줄의 Tailscale 아이콘에서 Connect를 누르세요.',
  login: 'Tailscale에 로그인해야 해요. 로그인 페이지를 열어 계정을 고르세요.',
  'enable-https': 'Tailscale 계정에서 HTTPS 인증서를 한 번 허용해야 해요. 허용한 뒤 다시 켜세요.',
  enable: '준비가 끝났어요. 켜면 같은 Tailscale 계정의 기기에서 이 허브를 열 수 있어요.',
  conflict: '443 포트를 이미 다른 Tailscale 공유가 쓰고 있어요.',
  ready: '다른 컴퓨터에서 위 주소를 열면 돼요. 그 기기도 같은 Tailscale 계정으로 로그인되어 있어야 해요.',
};
const httpUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** 지금 화면을 원격으로 보고 있는지. 서버 응답이 있으면 그것을, 없으면 주소로 판단 */
function isRemoteView() { const v = REMOTE.data?.viewer; return v ? !!v.remote : !LOCAL_HOSTS.has(location.hostname); }

/* ================= 상태 조회 ================= */
function fetchRemote(force = false) {
  if (REMOTE.inflight && !force) return REMOTE.inflight;
  if (!REMOTE.data && REMOTE.state !== 'old') REMOTE.state = 'loading';
  const run = (async () => {
    try {
      const r = await fetch(`/api/remote${force ? '?force=1' : ''}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (r.status === 404) { REMOTE.state = 'old'; REMOTE.data = null; REMOTE.error = ''; }
      else if (!r.ok || !j) { REMOTE.state = 'error'; REMOTE.error = j?.error || `${r.status} ${r.statusText}`; }
      else { REMOTE.data = j; REMOTE.state = 'ok'; REMOTE.error = ''; }
    } catch { REMOTE.state = 'error'; REMOTE.error = '허브에 연결하지 못했어요'; }
    finally { REMOTE.at = Date.now(); if (REMOTE.inflight === run) REMOTE.inflight = null; paintRemote(); applyRemoteBadge(); }
  })();
  REMOTE.inflight = run;
  return run;
}

/* ================= 설정 › 원격 접속 섹션 =================
   side.js 의 openSettings() 가 모달을 그릴 때마다 부른다. 몇 번 불려도 같은 결과가 나오고,
   마지막 상태를 먼저 그린 뒤 오래됐으면(5초) 다시 조회해서 깜빡임을 줄인다. */
function renderRemoteSection(sec) {
  if (!sec) return;
  sec.onclick = onRemoteClick;
  paintRemote(sec);
  if (!REMOTE.busy && (REMOTE.state === 'idle' || Date.now() - REMOTE.at > 5000)) fetchRemote(false);
}
function paintRemote(sec = document.getElementById('remoteSec')) {
  if (!sec || !sec.isConnected) return;
  sec.innerHTML = remoteHtml();
}

function remoteHtml() {
  const busy = !!REMOTE.busy;
  const head = (tone, label) => `<div class="rm-head"><h3>원격 접속</h3><span class="rm-state ${tone}"><i></i>${esc(label)}</span><span class="grow"></span><button class="rm-link" data-r="recheck" ${busy ? 'disabled' : ''} title="Tailscale 상태를 새로 읽어요">${icon('refresh')}<span>다시 확인</span></button></div>`;
  const risk = '<p class="fine">원격으로 연 화면에서도 이 PC에서 승인 없이 작업이 실행돼요. 본인 기기만 Tailscale에 연결하세요. 자세한 안내는 허브 폴더의 <span class="mono">docs\\remote-access.md</span>에 있어요.</p>';

  if (REMOTE.state === 'idle' || (REMOTE.state === 'loading' && !REMOTE.data)) {
    return head('', '확인 중…') + '<div class="rm-skel" aria-hidden="true"><i></i><i></i></div>';
  }
  if (REMOTE.state === 'old') {
    return head('warn', '서버 재시작 필요') + `<div class="rm-card warn"><p>지금 실행 중인 허브는 원격 접속 기능이 들어가기 전 버전이에요. 진행 중인 작업이 끝난 뒤 허브를 다시 시작하면 여기서 켜고 끌 수 있어요.</p>
      <div class="rm-cmdrow"><code class="rm-cmd">npm run restart</code><button class="btn" data-r="copy" data-v="npm run restart">${icon('copy')}복사</button></div>
      <p class="fine">허브 폴더(<span class="mono">${esc(S.cfg?.root || 'ai-hub')}</span>)에서 실행하세요. 작업이 없을 때까지 기다렸다가 허브만 다시 시작해요.</p></div>` + risk;
  }
  if (REMOTE.state === 'error' && !REMOTE.data) {
    return head('err', '확인 실패') + `<div class="rm-card err"><p>원격 접속 상태를 불러오지 못했어요.</p><p class="fine">${esc(REMOTE.error)}</p></div>`;
  }

  const d = REMOTE.data; const ts = d.tailscale || {}; const nx = d.next || {};
  const step = d.ready ? 'ready' : (nx.step || 'enable');
  const manage = d.canManage !== false;
  const tone = d.ready ? 'ok' : (d.enabled || step === 'conflict' || (d.warnings || []).length) ? 'warn' : 'off';
  const label = d.ready ? '켜짐' : tone === 'warn' ? '조치 필요' : '꺼짐';
  let h = head(tone, label);

  if (REMOTE.state === 'error') h += `<div class="rm-note err">${icon('alert')}<span>새로 확인하지 못해 마지막 상태를 보여 줘요 · ${esc(REMOTE.error)}</span></div>`;

  // 주소
  const url = httpUrl(d.url);
  if (url && (d.ready || d.enabled)) {
    h += `<div class="rm-addr ${d.ready ? 'on' : ''}">${icon('globe')}<a class="mono" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="새 창에서 열기">${esc(url)}</a>
      <button class="icon-btn" data-r="copy" data-v="${esc(url)}" title="주소 복사">${icon('copy')}</button><a class="icon-btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="새 창에서 열기">${icon('open')}</a></div>`;
  }

  // 준비 단계 (켜지기 전까지만, 허브 PC에서만)
  if (!d.ready && manage) {
    const at = REMOTE_STEP_AT[step] ?? 3;
    h += `<ol class="rm-steps">${REMOTE_STEPS.map((s, i) => `<li class="${i < at ? 'done' : i === at ? (step === 'conflict' ? 'cur bad' : 'cur') : ''}"><span class="n">${i < at ? icon('check') : i + 1}</span><span>${s}</span></li>`).join('')}</ol>`;
  }

  // 다음에 할 일
  const msg = nx.message || REMOTE_STEP_MSG[step] || '';
  const link = httpUrl(REMOTE.result?.step === step && REMOTE.result.url) || httpUrl(nx.url);
  const acts = [];
  const extra = [];
  if (step === 'install') {
    if (link) acts.push(`<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${icon('open')}다운로드 페이지</a>`);
    extra.push(`<p class="fine">허브 폴더에서 <span class="mono">npm run remote -- enable --install</span>을 실행하면 설치부터 이어서 해요. 관리자 승인 창이 한 번 떠요.</p>`);
  } else if (step === 'login') {
    if (link && manage) acts.push(`<a class="btn primary" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${icon('open')}Tailscale 로그인 열기</a>`);
    extra.push('<p class="fine">로그인을 마쳤으면 "다시 확인"을 누르세요.</p>');
  } else if (step === 'enable-https') {
    if (link && manage) acts.push(`<a class="btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${icon('open')}HTTPS 허용 페이지 열기</a>`);
    if (manage) acts.push(`<button class="btn primary" data-r="enable" ${busy ? 'disabled' : ''}>${icon('globe')}다시 켜기</button>`);
  } else if (step === 'enable') {
    if (manage) acts.push(`<button class="btn primary" data-r="enable" ${busy ? 'disabled' : ''}>${icon('globe')}켜기</button>`);
  } else if (step === 'conflict') {
    extra.push('<p class="fine">그 공유를 계속 써야 하면 그대로 두세요. 덮어쓰려면 허브 폴더에서 <span class="mono">npm run remote -- enable --force</span>를 실행하세요. 원래 공유는 끊겨요.</p>');
  }
  const cmd = nx.command && step !== 'ready' && manage ? String(nx.command) : '';
  if (!manage && !d.ready) { acts.length = 0; extra.length = 0; extra.push('<p class="fine">허브 PC 앞에서 처리해야 하는 단계예요.</p>'); }
  if (step !== 'ready' || msg) {
    h += `<div class="rm-card ${step === 'conflict' ? 'warn' : ''}"><p>${esc(d.ready ? REMOTE_STEP_MSG.ready : msg)}</p>
      ${cmd ? `<div class="rm-cmdrow"><code class="rm-cmd">${esc(cmd)}</code><button class="btn" data-r="copy" data-v="${esc(cmd)}">${icon('copy')}복사</button></div>` : ''}
      ${acts.length ? `<div class="rm-acts">${acts.join('')}</div>` : ''}${extra.join('')}</div>`;
  }

  // 진행 중 · 결과
  if (busy) h += `<div class="rm-note">${'<span class="spin-xs"></span>'}<span>${REMOTE.busy === 'enable' ? '켜는 중이에요' : '끄는 중이에요'} · Tailscale 응답을 기다리느라 최대 30초 걸릴 수 있어요</span></div>`;
  else if (REMOTE.result && REMOTE.result.ok === false && REMOTE.result.message) {
    h += `<div class="rm-note warn">${icon('alert')}<span>${esc(REMOTE.result.message)}</span></div>`;
    if (REMOTE.result.output) h += `<pre class="rm-out">${esc(String(REMOTE.result.output).slice(0, 1500))}</pre>`;
  }

  // 경고
  if ((d.warnings || []).length) h += `<div class="rm-warns">${d.warnings.map((w) => `<div>${icon('alert')}<span>${esc(w)}</span></div>`).join('')}</div>`;

  // 세부 정보
  const row = (k, v) => `<div class="set-row"><span class="set-k">${k}</span><span>${v}</span></div>`;
  const tsText = ts.installed === false || ts.state === 'NotInstalled' ? '설치 안 됨'
    : `${esc(TS_STATE_KO[ts.state] || ts.state || '알 수 없음')}${ts.version ? ` · ${esc(ts.version)}` : ''}${ts.dnsName ? `<br><span class="mono c-muted">${esc(ts.dnsName)}</span>` : ''}`;
  h += row('Tailscale', tsText + (ts.error ? `<br><span class="c-err">${esc(ts.error)}</span>` : ''));
  if (ts.funnel) h += row('공개(Funnel)', '<span class="c-err">켜져 있음 — 허브는 공개 요청을 막지만 Tailscale에서 꺼 두세요</span>');
  h += row('허용 계정', `${esc(d.allowedCount ?? 0)}개<br><span class="fine-inline">추가·삭제는 허브 PC에서 <span class="mono">npm run remote -- allow &lt;로그인&gt;</span> · <span class="mono">revoke</span></span>`);
  const v = d.viewer || {};
  h += row('지금 보는 곳', v.remote ? `원격${v.name || v.login ? ` · ${esc(v.name || v.login)}` : ''}` : '이 PC (로컬)');

  // 켜기·끄기
  if (manage) {
    if (d.enabled || ts.serving) h += `<div class="rm-acts end"><button class="btn danger" data-r="disable" ${busy ? 'disabled' : ''}>${icon('unplug')}원격 접속 끄기</button></div>`;
  } else {
    h += '<p class="fine">켜기·끄기와 계정 허용은 허브 PC에서만 바꿀 수 있어요.</p>';
  }
  if (d.checkedAt) h += `<p class="fine">${esc(hm(d.checkedAt))} 확인</p>`;
  return h + risk;
}

async function onRemoteClick(e) {
  const b = e.target.closest('[data-r]'); if (!b || b.disabled) return;
  const act = b.dataset.r;
  if (act === 'recheck') { REMOTE.result = null; paintRemote(); return fetchRemote(true); }
  if (act === 'copy') return copyText(b.dataset.v, '복사했어요');
  if (act === 'enable' || act === 'disable') return remoteToggle(act);
}

async function remoteToggle(act) {
  if (REMOTE.busy) return;
  if (act === 'disable' && !confirm('원격 접속을 끌까요?\n다른 컴퓨터에 열려 있는 허브 화면은 바로 연결이 끊겨요.')) return;
  REMOTE.busy = act; REMOTE.result = null; paintRemote();
  try {
    const j = await api(`/api/remote/${act}`, { method: 'POST', body: '{}' });
    REMOTE.data = j; REMOTE.state = 'ok'; REMOTE.at = Date.now(); REMOTE.result = j.result || null;
    if (!j.result || j.result.ok) toast(act === 'enable' ? '원격 접속을 켰어요' : '원격 접속을 껐어요');
    else toast(j.result.message || '한 단계가 더 필요해요. 설정 화면의 안내를 보세요', true);
  } catch (err) {
    REMOTE.result = { ok: false, message: err.message };
    toast(err.message, true);
  } finally {
    REMOTE.busy = ''; paintRemote(); applyRemoteBadge();
  }
}

/* ================= 사이드바 "원격" 배지 ================= */
function applyRemoteBadge() {
  const brand = document.querySelector('#side .brand'); if (!brand) return;
  let b = brand.querySelector('.remote-badge');
  const v = REMOTE.data?.viewer;
  document.body.classList.toggle('is-remote', !!v?.remote);
  if (!v?.remote) { b?.remove(); return; }
  if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'remote-badge'; b.addEventListener('click', () => openSettings('remoteSec')); brand.appendChild(b); }
  b.innerHTML = `${icon('globe')}<span>원격</span>`;
  b.title = `다른 컴퓨터에서 원격으로 보는 중${v.login ? `\n${v.login}` : ''}\n눌러서 원격 접속 정보 보기`;
}

/* ================= 연결 끊김 안내 줄 =================
   app.js 의 connect() 가 실시간 이벤트(SSE)가 열리고 끊길 때마다 onHubConn(true|false) 를 부른다.
   잠깐 끊긴 것(3초 이내)은 보여 주지 않고, 계속 끊기면 원인을 짐작해서 알려 준다. */
const CONN = { down: false, since: 0, shown: false, timer: null, probedAt: 0, info: null };
function onHubConn(ok) {
  const bar = document.getElementById('connBar'); if (!bar) return;
  if (ok) {
    clearTimeout(CONN.timer);
    const was = CONN.shown;
    Object.assign(CONN, { down: false, shown: false, info: null });
    bar.hidden = true;
    if (was) { toast('허브와 다시 연결됐어요'); fetchRemote(false); }
    return;
  }
  if (!CONN.down) {
    CONN.down = true; CONN.since = Date.now();
    clearTimeout(CONN.timer);
    CONN.timer = setTimeout(() => { if (CONN.down) { CONN.shown = true; probeConn(); } }, 3000);
    return;
  }
  if (CONN.shown) { if (Date.now() - CONN.probedAt > 8000) probeConn(); else paintConn(); }
}
async function probeConn() {
  CONN.probedAt = Date.now();
  let info;
  try {
    const r = await fetch('/api/remote', { cache: 'no-store', headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    info = j?.code ? { code: j.code, msg: j.error || '' } : { code: 'retry' };
  } catch { info = { code: 'unreachable' }; }
  CONN.info = info;
  if (CONN.down) paintConn();
}
function paintConn() {
  const bar = document.getElementById('connBar'); if (!bar || !CONN.down) return;
  const info = CONN.info || { code: 'retry' };
  const remote = isRemoteView();
  let title; let hint; let tone = 'warn';
  if (info.code === 'unreachable') {
    title = remote ? '허브 PC에 닿지 않아요' : '허브 서버가 응답하지 않아요';
    hint = remote ? '허브 PC가 켜져 있고 허브가 실행 중인지, 이 기기의 Tailscale이 연결되어 있는지 확인하세요.'
      : '서버가 다시 시작되는 중일 수 있어요. 계속되면 허브 폴더에서 start-hub.cmd 로 켜세요.';
  } else if (info.code === 'remote_off') {
    title = info.msg || '원격 접속이 꺼졌어요'; hint = '허브 PC에서 원격 접속을 다시 켜면 자동으로 이어져요.'; tone = 'crit';
  } else if (info.code === 'retry') {
    title = '허브와 연결이 잠깐 끊겼어요'; hint = '자동으로 다시 연결하는 중이에요.';
  } else {
    title = info.msg || '허브가 이 연결을 막았어요'; hint = '새로고침하면 막힌 이유와 해결 방법이 보여요.'; tone = 'crit';
  }
  const sec = Math.round((Date.now() - CONN.since) / 1000);
  bar.className = tone;
  bar.innerHTML = `<div class="cb-in" role="status" aria-live="polite">${tone === 'crit' ? icon('alert') : '<span class="spin-xs"></span>'}<div class="cb-main"><b>${esc(title)}</b><small>${esc(hint)} <span class="cb-sec">${sec}초째 다시 연결하는 중</span></small></div><button class="btn" data-conn="reload">${icon('refresh')}새로고침</button></div>`;
  bar.hidden = false;
}
document.addEventListener('click', (e) => { if (e.target.closest('#connBar [data-conn="reload"]')) location.reload(); });

/* 시작할 때 한 번 조회해서 원격 보기 여부(배지)를 정한다 */
document.addEventListener('DOMContentLoaded', () => fetchRemote(false));
