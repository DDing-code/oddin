/* 연결된 PC 화면 (lib/peers.mjs · lib/shared-sync.mjs · lib/shared-setup.mjs 짝, 2026-10-05 집·회사 PC 두 대)
   - 오른쪽 패널 'PC' 탭: 이 PC 이름, 연결된 PC(다른 ODDIN 허브) 목록·상태·추가·이름 바꾸기·끊기,
     공유 기억(~/.ai-shared) 동기화 상태·지금 맞추기, 이 PC의 Claude·Codex 공유 기억 훅 상태·설치
   - 실시간: hub:event 의 peers / shared-sync 로 갱신 */
// 탭 아이콘: 모니터 (사용량 탭의 계기판과 겹치지 않게). 아래 함수 안의 IC 는 도우미라 전역 아이콘 목록은 여기서 더한다
if (typeof IC === 'object' && IC && !IC.monitor) IC.monitor = '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>';
(() => {
  const E = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IC = (n) => (typeof icon === 'function' ? icon(n) : '');
  const say = (m, err) => (typeof toast === 'function' ? toast(m, err) : null);
  const call = (url, opt) => (typeof api === 'function' ? api(url, opt) : fetch(url, opt).then((r) => r.json()));
  const P = { view: null, setup: null, loading: false, busy: '', error: '' };
  const when = (iso) => {
    if (!iso) return '아직 안 함';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? '방금' : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : new Date(iso).toLocaleString('ko-KR');
  };
  // ODDIN 버전: 커밋 번호 대신 날짜로 (번호는 마우스를 올리면)
  const verText = (x) => (x?.commitDate ? `${new Date(x.commitDate).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })} 버전` : x?.commit || '버전 모름') + (x?.pendingCommit ? ' · 새 버전 받음, 재시작 대기' : '');
  const countsText = (c) => !c ? '' : [c.pulled && `받음 ${c.pulled}`, c.pushed && `보냄 ${c.pushed}`, c.merged && `목록 합침 ${c.merged}`, c.conflicts && `겹침 ${c.conflicts}`, c.deleted && `지움 ${c.deleted}`].filter(Boolean).join(' · ') || '바뀐 것 없음';

  // 화면 파일은 바로 바뀌지만 서버는 진행 중인 작업이 끝나야 재시작된다 — 그 사이엔 서버가 이 기능을 모른다
  const OLD_SERVER = '이 PC의 ODDIN 서버가 아직 재시작 전(예전 버전)이에요. 진행 중인 작업이 끝나면 자동으로 재시작되고, 그 뒤에 쓸 수 있어요';
  const why = (e) => (/^없는 API$/.test(String(e?.message || '')) ? OLD_SERVER : String(e?.message || e));
  async function load() {
    if (P.loading) return; P.loading = true; P.tried = true;
    try { [P.view, P.setup, P.folders, P.drive, P.hub] = await Promise.all([call('/api/peers'), call('/api/shared/setup').catch(() => null), call('/api/shared-folders').catch(() => null), call('/api/drive-folders').catch(() => null), call('/api/drive-hub').catch(() => null)]); P.error = ''; }
    catch (e) { P.error = why(e); }
    P.loading = false; refresh();
  }
  function refresh() { if (typeof S !== 'undefined' && S.insp?.tab === 'peers' && typeof renderInspector === 'function') renderInspector(); }
  async function act(key, fn, ok) {
    P.busy = key; refresh();
    try { const r = await fn(); if (ok) say(typeof ok === 'function' ? ok(r) : ok); await load(); }
    catch (e) { say(why(e), true); }
    P.busy = ''; refresh();
  }

  function render(body) {
    // 실시간 이벤트가 연결된 PC 목록만 먼저 채웠어도 나머지(훅·공유 폴더·드라이브)는 한 번 불러온다
    if (P.view && !P.tried) load();
    if (!P.view && !P.error) { load(); body.innerHTML = '<div class="pc-pane"><div class="ch-skel" aria-busy="true"><i></i><i></i><i></i></div></div>'; return; }
    if (!P.view) { body.innerHTML = `<div class="pc-pane"><div class="mem-cur err">${IC('alert')}<span>${P.error === OLD_SERVER ? '' : '불러오지 못했어요: '}${E(P.error)}</span></div></div>`; return; }
    const v = P.view, sync = new Map((v.sync?.peers || []).map((x) => [x.id, x]));
    let h = '<div class="pc-pane">';
    h += `<div class="ilabel">이 PC</div><form class="pc-self" data-pc-self><input name="n" maxlength="30" value="${E(v.self.name)}" aria-label="이 PC 이름" title="다른 PC에서 이 이름으로 보여요"><button class="btn" type="submit" ${P.busy === 'self' ? 'disabled' : ''}>저장</button></form>`;
    h += `<p class="pc-hint">${E(v.self.hostname)} · <span title="${E(v.self.commit || '')}">ODDIN ${E(verText(v.self))}</span> · 다른 PC에서 이 이름(예: 집, 회사)으로 보여요. <button class="linkish" data-pc-update="self" ${P.busy === 'update:self' ? 'disabled' : ''}>${P.busy === 'update:self' ? '업데이트 중…' : '이 PC 업데이트'}</button></p>`;

    h += `<div class="ilabel">연결된 PC ${v.peers.length || ''}</div>`;
    if (!v.peers.length) h += '<div class="mem-empty">아직 없어요. 다른 PC의 ODDIN 주소(Tailscale)를 아래에 넣으면 기억을 함께 써요.</div>';
    for (const p of v.peers) {
      const st = p.status, sy = sync.get(p.id) || {};
      const tone = !st ? 'wait' : st.online ? 'ok' : 'off';
      h += `<div class="pc-peer"><div class="pc-row"><span class="pc-dot ${tone}" title="${tone === 'ok' ? '연결됨' : tone === 'off' ? '연결 안 됨' : '확인 전'}"></span><b>${E(p.name)}</b><span class="pc-url" title="${E(p.url)}">${E(p.url.replace(/^https?:\/\//, ''))}</span><span class="grow"></span>`
        + `<button class="icon-btn" data-pc-rename="${E(p.id)}" title="이름 바꾸기">${IC('pencil')}</button><button class="icon-btn" data-pc-remove="${E(p.id)}" title="연결 끊기">${IC('x')}</button></div>`;
      if (st && !st.online) h += `<div class="pc-err">${IC('alert')}<span>${E(st.error || '연결 안 됨')}</span></div>`;
      if (st?.online) {
        const same = st.commit && st.commit === v.self.commit;
        h += `<div class="pc-sync">${IC('bolt')}<span title="${E(st.commit || '')}">ODDIN ${E(verText(st))}${st.commit ? same ? ' · 이 PC와 같은 버전' : ' · 이 PC와 다른 버전' : ''}</span><span class="grow"></span><button class="btn sm" data-pc-update="${E(p.id)}" ${P.busy === `update:${p.id}` ? 'disabled' : ''} title="그 PC의 ODDIN을 GitHub 최신 버전으로 업데이트해요. 서버가 바뀌면 진행 중인 작업이 끝난 뒤 재시작">${P.busy === `update:${p.id}` ? '<span class="spin-xs"></span>업데이트 중' : '업데이트'}</button></div>`;
      }
      h += `<div class="pc-sync ${sy.ok === false ? 'err' : ''}">${IC('refresh')}<span>공유 기억 ${sy.via === 'drive' ? '· 구글 드라이브 ODDIN 폴더로 맞추는 중' : `${E(when(sy.lastAt))}${sy.lastAt ? ` · ${E(countsText(sy.counts))}` : ''}`}${sy.ok === false && sy.error ? ` · ${E(sy.error)}` : ''}</span></div></div>`;
    }
    h += `<form class="pc-add" data-pc-add><input name="u" placeholder="https://회사pc이름.tailnet.ts.net" autocomplete="off" aria-label="연결할 PC 주소"><input name="n" placeholder="이름 (예: 회사)" maxlength="30" autocomplete="off" aria-label="연결할 PC 이름"><button class="btn" type="submit" ${P.busy === 'add' ? 'disabled' : ''}>${IC('plus')}연결</button></form>`;
    h += '<p class="pc-hint">상대 PC의 ODDIN에서 원격 접속이 켜져 있어야 해요(설정 › 원격 접속). 연결하면 두 PC가 지침·메모리·공통 커맨드·에이전트를 1분마다, 바뀔 때마다 맞춰요.</p>';

    if (v.peers.length) {
      h += `<div class="ilabel">공유 기억</div><div class="pc-actions"><button class="btn" data-pc-sync ${P.busy === 'sync' || v.sync?.running ? 'disabled' : ''}>${v.sync?.running ? '<span class="spin-xs"></span>맞추는 중' : `${IC('refresh')}지금 맞추기`}</button></div>`;
      h += `<p class="pc-hint">둘 다 고친 파일은 목록(MEMORY.md)이면 줄을 합치고, 아니면 최근에 고친 쪽을 써요. 밀린 판과 지운 파일은 ${E((v.sync?.root || '~/.ai-shared') + '\\backups\\sync')}에 남아요.</p>`;
    }

    // ODDIN 드라이브 폴더: 구글 드라이브 "내 드라이브/ODDIN" 에 공유 기억 사본과 함께 쓸 자산을 모은다
    const hb = P.hub;
    if (hb && hb.enabled !== false) {
      h += '<div class="ilabel">ODDIN 드라이브 폴더</div>';
      if (!hb.drive) h += '<div class="mem-empty">이 PC에서 구글 드라이브 앱을 찾지 못했어요. 드라이브 데스크탑 앱을 켜면 쓸 수 있어요.</div>';
      else if (!hb.hub) {
        h += `<div class="pc-actions"><button class="btn" data-hub-create ${P.busy === 'hub-create' ? 'disabled' : ''}>${P.busy === 'hub-create' ? '<span class="spin-xs"></span>만드는 중' : `${IC('plus')}드라이브에 ODDIN 폴더 만들기`}</button></div>`;
        h += `<p class="pc-hint">${E(hb.drive.myDrive)} 안에 ODDIN 폴더를 만들고, 공유 기억(지침·메모리·공통 커맨드·에이전트)과 이 PC가 공유하는 폴더를 올려요. 다른 PC도 같은 구글 계정이면 그 폴더를 알아서 찾아 함께 써요.</p>`;
      } else {
        const ds = hb.sync || {};
        h += `<div class="pc-peer"><div class="pc-row">${IC('folder')}<b>ODDIN</b><span class="pc-url" title="${E(hb.hub.root)}">${E(hb.hub.root)}</span><span class="grow"></span><button class="btn sm" data-dv-open="${E(hb.hub.root)}" title="${E(hb.hub.root)}">열기</button></div>`;
        const syncText = !ds.lastAt ? '아직 맞추기 전' : !ds.joined ? `처음 맞추는 중 — 다른 PC가 올린 파일을 기다려요${ds.joinUntil ? ` (${E(new Date(ds.joinUntil).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }))}까지)` : ''}` : `${E(when(ds.lastAt))} · ${E(countsText(ds.counts))}`;
        h += `<div class="pc-sync ${ds.ok === false ? 'err' : ''}">${IC('refresh')}<span>공유 기억 ${syncText}${ds.ok === false && ds.error ? ` · ${E(ds.error)}` : ''}</span></div></div>`;
        for (const a of hb.assets || []) {
          const label = a.common ? '자산 · 공용' : `자산 · ${a.pc} · ${a.folder}`;
          h += `<div class="pc-peer"><div class="pc-row">${IC('folder')}<b>${E(label)}</b><span class="pc-url">파일 ${a.files}개</span><span class="grow"></span><button class="btn sm" data-dv-work="${E(a.path)}" title="이 폴더로 새 세션을 열어요">여기서 작업</button><button class="btn sm" data-dv-open="${E(a.path)}" title="${E(a.path)}">열기</button></div></div>`;
        }
        h += '<p class="pc-hint">공유 기억/ = 두 PC가 쓰는 지침·메모리 사본(각 PC의 ODDIN이 20초마다·바뀔 때마다 맞춤). 자산/&lt;PC&gt;/&lt;폴더&gt;/ = 각 PC가 공유하는 폴더를 원본 PC가 올린 것. 자산/공용/ = 함께 쓸 파일을 직접 넣는 곳. 다른 PC도 이 폴더를 쓰면 PC끼리 직접 맞추기는 쉬고 드라이브로만 맞춰요.</p>';
      }
    }

    // 드라이브 작업 폴더: 구글 드라이브로 두 PC가 함께 쓰는 폴더에서 바로 작업
    const dv = P.drive;
    if (dv) {
      h += `<div class="ilabel">드라이브 작업 폴더 ${dv.folders.length || ''}</div>`;
      h += `<p class="pc-hint">${dv.drive ? `이 PC 구글 드라이브: ${E(dv.drive.root)} (${E(dv.drive.myDrive.split(/[\\\\/]/).pop())}${dv.drive.computers ? ` · ${E(dv.drive.computers.split(/[\\\\/]/).pop())}` : ''})` : '이 PC에서 구글 드라이브 앱을 찾지 못했어요'}. 드라이브로 두 PC에 맞춰지는 폴더를 등록하면 두 PC 모두 그 폴더에서 바로 작업하고, 같은 프로젝트 기억을 써요.</p>`;
      for (const f of dv.folders) {
        const busy = f.busy ? `<div class="pc-sync err">${IC('clock')}<span>${E(f.busy.machine)}에서 작업 중 — 다른 PC의 새 작업은 끝날 때까지 기다려요</span></div>` : '';
        h += `<div class="pc-peer"><div class="pc-row">${IC('folder')}<b>${E(f.name)}</b><span class="grow"></span>${f.here ? `<button class="btn sm" data-dv-work="${E(f.here)}" title="이 폴더로 새 세션을 열어요">여기서 작업</button><button class="btn sm" data-dv-open="${E(f.here)}" title="${E(f.here)}">열기</button>` : ''}<button class="icon-btn" data-dv-remove="${E(f.id)}" title="등록 빼기 (폴더·파일은 그대로)">${IC('x')}</button></div>`
          + `<div class="pc-sync"><span>이 PC: ${f.here ? `<span class="pc-path">${E(f.here)}</span>` : '<span class="c-err">아직 못 찾음</span> <button class="linkish" data-dv-path="' + E(f.id) + '">경로 직접 지정</button>'}</span></div>`
          + f.others.map((o) => `<div class="pc-sync"><span>${E(o.name)}: <span class="pc-path">${E(o.path)}</span></span></div>`).join('')
          + (f.hasGit ? `<div class="pc-sync err">${IC('alert')}<span>안에 git 저장소가 있어요. 드라이브 동기화와 git이 겹치면 저장소가 깨질 수 있어요</span></div>` : '') + busy + '</div>';
      }
      h += `<form class="pc-add" data-dv-add><input name="p" placeholder="드라이브 폴더 경로 (예: D:\\다른 컴퓨터\\내 컴퓨터\\작업폴더 (1))" autocomplete="off" aria-label="드라이브 작업 폴더 경로"><input name="n" placeholder="이름 (예: 업무 보관함)" maxlength="60" autocomplete="off" aria-label="드라이브 작업 폴더 이름"><button class="btn" type="submit" ${P.busy === 'dv-add' ? 'disabled' : ''}>${IC('plus')}등록</button></form>`;
      h += `<div class="pc-actions"><button class="btn" data-dv-resolve ${P.busy === 'dv-resolve' ? 'disabled' : ''}>${IC('refresh')}다른 PC 경로 다시 찾기</button></div><p class="pc-hint">고친 파일은 드라이브가 10~20초 안에 다른 PC에 맞춰요. 같은 파일을 두 PC가 동시에 고치면 충돌 사본이 생기니, 한 PC가 작업 중이면 다른 PC는 기다려요. 드라이브 앱에서 이 폴더를 "오프라인 사용"으로 두면 빨라요.</p>`;
    }

    // 공유 폴더(읽기용 사본): 플러그인 소스처럼 파일까지 다른 PC가 봐야 하는 것
    const fo = P.folders;
    if (fo) {
      const size = (b) => b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`;
      h += `<div class="ilabel">이 PC가 공유하는 폴더 ${fo.own.length || ''}</div>`;
      if (!fo.own.length) h += '<div class="mem-empty">없어요. 플러그인 소스처럼 다른 PC의 AI가 코드를 봐야 하는 폴더를 넣어 두세요.</div>';
      for (const f of fo.own) h += `<div class="pc-peer"><div class="pc-row">${IC('folder')}<b>${E(f.name)}</b><span class="pc-url" title="${E(f.path)}">${E(f.path)}</span><span class="grow"></span><button class="btn sm" data-sf-mode="${E(f.id)}" data-mode="${f.mode === 'all' ? 'code' : 'all'}" title="${f.mode === 'all' ? '코드·문서만 공유하기(그림·PDF 빼기)' : '그림·PDF 등도 함께 공유하기'}">${f.mode === 'all' ? '그림 포함' : '코드·문서만'}</button><button class="icon-btn" data-sf-remove="${E(f.id)}" title="공유 그만두기 (다른 PC의 사본도 지워짐)">${IC('x')}</button></div><div class="pc-sync">${f.exists ? `<span>파일 ${f.files}개 · ${size(f.bytes)}${f.truncated ? ' · 한도(5,000개·100MB)까지만' : ''}${f.published ? (f.published.ok === false ? ` · <span class="c-err">드라이브에 올리지 못함: ${E(f.published.error || '')}</span>` : ` · 드라이브 ODDIN에 올림 ${E(when(f.published.at))}`) : ''}</span>` : `<span class="c-err">폴더가 없어요</span>`}</div></div>`;
      h += `<form class="pc-add" data-sf-add><input name="p" placeholder="공유할 폴더 경로 (예: C:\\…\\플러그인)" autocomplete="off" aria-label="공유할 폴더 경로"><input name="n" placeholder="이름 (예: 프리미어 플러그인)" maxlength="60" autocomplete="off" aria-label="공유할 폴더 이름"><select name="m" aria-label="공유 방식"><option value="code">코드·문서만</option><option value="all">그림 포함</option></select><button class="btn" type="submit" ${P.busy === 'sf-add' ? 'disabled' : ''}>${IC('plus')}공유</button></form>`;
      h += '<p class="pc-hint">연결된 PC가 이 폴더의 읽기용 사본을 2분마다 받아 가요. 기본은 코드·문서만(그림·PDF 빼기), node_modules·.git·빌드 결과·2MB 넘는 파일은 늘 빼요. 사본을 고쳐도 여기 원본은 안 바뀌어요.</p>';
      if (v.peers.length) {
        h += `<div class="ilabel">다른 PC에서 받은 폴더 ${fo.mirrors.length || ''}</div>`;
        if (!fo.mirrors.length) h += '<div class="mem-empty">아직 없어요. 상대 PC에서 폴더를 공유하면 여기로 받아 와요.</div>';
        for (const m of fo.mirrors) h += `<div class="pc-peer"><div class="pc-row">${IC('folder')}<b>${E(m.peer)} · ${E(m.name)}</b><span class="grow"></span><button class="btn sm" data-sf-open="${E(m.dir)}" title="${E(m.dir)}">열기</button></div><div class="pc-sync ${m.ok === false ? 'err' : ''}">${IC('refresh')}<span>파일 ${m.files ?? '-'}개 · ${E(when(m.at))}${m.ok === false ? ` · ${E(m.error)}` : ''}</span></div></div>`;
        h += `<div class="pc-actions"><button class="btn" data-sf-pull ${P.busy === 'sf-pull' ? 'disabled' : ''}>${P.busy === 'sf-pull' ? '<span class="spin-xs"></span>받는 중' : `${IC('refresh')}지금 받기`}</button></div><p class="pc-hint">사본 위치: ${E(fo.root)} — 각 PC의 AI는 목록 ${E(fo.root)}\\INDEX.md 를 보고 찾아가요. 고칠 때는 원본 PC에서.</p>`;
      }
    }

    const su = P.setup;
    if (su) {
      const item = (ok, label) => `<li class="${ok ? 'ok' : 'no'}">${IC(ok ? 'check' : 'minus')}<span>${label}</span></li>`;
      h += `<div class="ilabel">이 PC의 Claude·Codex</div><ul class="pc-setup">${item(su.ready, '공유 기억 받음')}${item(su.claude.ok, 'Claude 훅 (세션 시작·끝 동기화, 매 메시지 기억 확인)')}${item(su.codex.ok, 'Codex 훅')}${item(su.claudeMd.ok, 'CLAUDE.md 공유 지침·메모리 불러오기')}</ul>`;
      if (!su.done) h += `<div class="pc-actions"><button class="btn" data-pc-setup ${!su.ready || P.busy === 'setup' ? 'disabled' : ''}>${IC('bolt')}빠진 것 설치</button></div><p class="pc-hint">${su.ready ? '기존 설정은 그대로 두고 빠진 훅·줄만 더해요(원본은 .bak-oddin 으로 보관). Codex는 새 훅을 처음 쓸 때 한 번 신뢰할지 물어요.' : '연결된 PC와 먼저 맞추면 설치할 수 있어요.'} ODDIN 작업은 훅이 없어도 공유 기억을 바로 써요.</p>`;
    }
    body.innerHTML = h + '</div>';
  }
  window.hubTabs = window.hubTabs || [];
  window.hubTabs.push({ key: 'peers', label: '연결된 PC', icon: 'monitor', render });

  document.addEventListener('submit', (e) => {
    const add = e.target.closest('[data-pc-add]'), self = e.target.closest('[data-pc-self]'), sf = e.target.closest('[data-sf-add]'), dva = e.target.closest('[data-dv-add]');
    if (dva) {
      e.preventDefault();
      const p = dva.p.value.trim(), name = dva.n.value.trim(); if (!p) return;
      act('dv-add', () => call('/api/drive-folders', { method: 'POST', body: JSON.stringify({ path: p, name }) }), (f) => `"${f.name}" 등록했어요. 다른 PC에서 경로를 찾는 중이에요`);
      return;
    }
    if (sf) {
      e.preventDefault();
      const p = sf.p.value.trim(), name = sf.n.value.trim(), mode = sf.m?.value || 'code'; if (!p) return;
      act('sf-add', () => call('/api/shared-folders', { method: 'POST', body: JSON.stringify({ path: p, name, mode }) }), (f) => `"${f.name}" 공유를 시작했어요 (파일 ${f.files}개)`);
      return;
    }
    if (!add && !self) return;
    e.preventDefault();
    if (add) {
      const url = add.u.value.trim(), name = add.n.value.trim(); if (!url) return;
      act('add', () => call('/api/peers', { method: 'POST', body: JSON.stringify({ url, name }) }), (p) => `${p.name} 연결했어요. 공유 기억을 맞추는 중이에요`);
    } else {
      const name = self.n.value.trim(); if (!name) return;
      act('self', () => call('/api/peers/self', { method: 'POST', body: JSON.stringify({ name }) }), '이 PC 이름을 바꿨어요');
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pc-sync],[data-pc-setup],[data-pc-remove],[data-pc-rename],[data-pc-update],[data-sf-remove],[data-sf-pull],[data-sf-open],[data-sf-mode],[data-hub-create],[data-dv-work],[data-dv-open],[data-dv-remove],[data-dv-path],[data-dv-resolve]'); if (!b) return;
    if (b.hasAttribute('data-hub-create')) { act('hub-create', () => call('/api/drive-hub', { method: 'POST', body: '{}' }), (r) => r.created ? 'ODDIN 폴더를 만들었어요. 공유 기억과 공유 폴더를 올리는 중이에요' : '이미 있는 ODDIN 폴더를 쓰기 시작했어요'); return; }
    if (b.hasAttribute('data-dv-work')) { if (typeof newSession === 'function') { newSession(b.dataset.dvWork); say('드라이브 작업 폴더에서 새 세션을 시작해요. 요청을 입력하세요'); } return; }
    if (b.hasAttribute('data-dv-open')) { if (typeof window.openPath === 'function') window.openPath(b.dataset.dvOpen); return; }
    if (b.hasAttribute('data-dv-resolve')) { act('dv-resolve', () => call('/api/drive-folders/resolve', { method: 'POST', body: '{}' }), (r) => r.found?.length ? `찾았어요: ${r.found.map((x) => x.name).join(', ')}` : r.missing?.length ? `아직 못 찾은 폴더: ${r.missing.join(', ')}` : '모두 찾아 두었어요'); return; }
    if (b.hasAttribute('data-dv-remove')) { const f = P.drive?.folders.find((x) => x.id === b.dataset.dvRemove); if (f && confirm(`"${f.name}" 등록을 뺄까요? 폴더와 파일은 그대로예요.`)) act('dv-remove', () => call(`/api/drive-folders/${encodeURIComponent(f.id)}`, { method: 'DELETE' }), '등록을 뺐어요'); return; }
    if (b.hasAttribute('data-dv-path')) { const p = prompt('이 PC에서 그 폴더의 경로'); if (p && p.trim()) act('dv-path', () => call(`/api/drive-folders/${encodeURIComponent(b.dataset.dvPath)}/path`, { method: 'POST', body: JSON.stringify({ path: p.trim() }) }), '이 PC 경로를 지정했어요'); return; }
    if (b.hasAttribute('data-sf-mode')) { act('sf-mode', () => call(`/api/shared-folders/${encodeURIComponent(b.dataset.sfMode)}`, { method: 'POST', body: JSON.stringify({ mode: b.dataset.mode }) }), (f) => `${f.name}: ${f.mode === 'all' ? '그림 포함' : '코드·문서만'}으로 바꿨어요 (파일 ${f.files}개)`); return; }
    if (b.hasAttribute('data-sf-open')) { if (typeof window.openPath === 'function') window.openPath(b.dataset.sfOpen); return; }
    if (b.hasAttribute('data-sf-pull')) { act('sf-pull', () => call('/api/shared-folders/pull', { method: 'POST', body: '{}' }), (r) => (r.results || []).every((x) => x.ok) ? '다른 PC의 공유 폴더를 받았어요' : `일부 못 받았어요: ${(r.results || []).find((x) => !x.ok)?.error || ''}`); return; }
    if (b.hasAttribute('data-sf-remove')) {
      const f = P.folders?.own.find((x) => x.id === b.dataset.sfRemove);
      if (f && confirm(`"${f.name}" 공유를 그만둘까요? 원본은 그대로이고, 다른 PC의 사본만 지워져요.`)) act('sf-remove', () => call(`/api/shared-folders/${encodeURIComponent(f.id)}`, { method: 'DELETE' }), '공유를 그만뒀어요');
      return;
    }
    if (b.hasAttribute('data-pc-update')) {
      const id = b.dataset.pcUpdate, name = id === 'self' ? '이 PC' : P.view?.peers.find((x) => x.id === id)?.name || '그 PC';
      act(`update:${id}`, () => call(id === 'self' ? '/api/hub/update' : `/api/peers/${encodeURIComponent(id)}/update`, { method: 'POST', body: '{}' }), (r) => `${name}: ${r.message}${r.updated ? ` (${r.from} → ${r.to}, 파일 ${r.files}개)` : ''}`);
    } else if (b.hasAttribute('data-pc-sync')) act('sync', () => call('/api/shared/sync', { method: 'POST', body: '{}' }), (r) => (r.results || []).every((x) => x.ok) ? '공유 기억을 맞췄어요' : `일부 못 맞췄어요: ${(r.results || []).find((x) => !x.ok)?.error || (r.results || []).find((x) => !x.ok)?.errors?.[0] || ''}`);
    else if (b.hasAttribute('data-pc-setup')) act('setup', () => call('/api/shared/setup', { method: 'POST', body: '{}' }), (r) => r.changed?.length ? `설치했어요: ${r.changed.join(', ')}` : '이미 다 있어요');
    else if (b.hasAttribute('data-pc-remove')) {
      const p = P.view?.peers.find((x) => x.id === b.dataset.pcRemove);
      if (p && confirm(`${p.name} 연결을 끊을까요? 공유 기억 파일은 지우지 않아요.`)) act('remove', () => call(`/api/peers/${encodeURIComponent(p.id)}`, { method: 'DELETE' }), '연결을 끊었어요');
    } else {
      const p = P.view?.peers.find((x) => x.id === b.dataset.pcRename);
      const name = p && prompt('새 이름', p.name);
      if (name && name.trim()) act('rename', () => call(`/api/peers/${encodeURIComponent(p.id)}`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) }));
    }
  });
  window.addEventListener('hub:event', (e) => {
    const ev = e.detail || {};
    if (ev.type === 'peers' && ev.self) { P.view = { self: ev.self, peers: ev.peers, sync: ev.sync }; refresh(); }
    else if (ev.type === 'shared-sync' && P.view) { P.view.sync = ev.status; if (P.hub?.hub && ev.status?.drive) P.hub = { ...P.hub, sync: ev.status.drive }; if (!ev.status.running) call('/api/shared/setup').then((s) => { P.setup = s; refresh(); }).catch(() => {}); refresh(); }
    else if (ev.type === 'drive-hub') { call('/api/drive-hub').then((d) => { P.hub = d; refresh(); }).catch(() => {}); }
    else if (ev.type === 'drive-folders') { call('/api/drive-folders').then((d) => { P.drive = d; refresh(); }).catch(() => {}); }
    else if (ev.type === 'shared-folders' && ev.own) { P.folders = { ...(P.folders || {}), own: ev.own, mirrors: ev.mirrors }; refresh(); }
    else if (ev.type === 'hello' && P.view) load();
  });
})();
