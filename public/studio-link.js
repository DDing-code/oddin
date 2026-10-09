/* ODDIN 스튜디오로 열기 (2026-10-10 사용자 "오딘 내에 만드는 게 아니라 오딘과 연동되는 프로그램으로") — 편집기는 이제 ODDIN 안에 없다.
   - 이 PC 화면: 허브가 스튜디오를 켜고(꺼져 있으면) 그 창에서 연다(POST /api/studio/start)
   - 원격·폰: ODDIN 주소의 /studio/ 를 새 탭으로(허브가 이 PC 스튜디오를 비춘다)
   여는 곳: 경로 오른쪽 클릭 메뉴(window.hubPathItems) · 작업 카드(결과에 편집 파일 경로) · 검색 팔레트 · PC 탭 "ODDIN 스튜디오" */
(() => {
  const remote = () => (typeof isRemoteView === 'function' ? isRemoteView() : !/^(127\.0\.0\.1|localhost)$/.test(location.hostname));
  const EDIT_RE = /\.oddin-edit\.json$/i, VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi|mts|m2ts|wmv|mxf)$/i;
  async function open(p = null) {
    if (remote()) { window.open(`/studio/${p ? `?${EDIT_RE.test(p) ? 'path' : 'video'}=${encodeURIComponent(p)}` : ''}`, '_blank', 'noopener'); return; }
    try {
      const r = await api('/api/studio/start', { method: 'POST', body: JSON.stringify({ open: p }) });
      if (r.windows) toast(p ? '스튜디오 창에서 열었어요' : '스튜디오 창을 앞으로 가져왔어요');
      else if (r.launch?.launched) toast(r.launch.how === 'app' ? 'ODDIN 스튜디오를 띄웠어요' : 'ODDIN 스튜디오를 Edge 앱 창으로 띄웠어요(PC 탭에서 프로그램을 설치하면 전용 창으로 열려요)');
      else toast(`스튜디오 창을 띄우지 못했어요: ${r.launch?.reason || r.error || '알 수 없음'}`, true);
    } catch (e) { toast(`스튜디오를 켜지 못했어요: ${e.message}`, true); }
  }
  window.hubStudio = { open };
  // 경로 오른쪽 클릭(tools-ui.js pathMenu)
  (window.hubPathItems ||= []).push((info, { fed }) => {
    if (fed || !info || info.kind === 'dir') return [];
    const p = info.path;
    if (EDIT_RE.test(p)) return [{ label: 'ODDIN 스튜디오에서 열기', desc: '싱크·디자인·모션 고치기', icon: 'image', run: () => { try { closePop(); } catch {} open(p); } }];
    if (VIDEO_RE.test(p)) return [{ label: 'ODDIN 스튜디오로 편집하기', desc: '이 영상으로 편집 만들기 · 같은 이름 SRT 는 자막으로', icon: 'image', run: () => { try { closePop(); } catch {} open(p); } }];
    return [];
  });
  // 작업 카드: 결과에 편집 파일 경로가 있으면 "스튜디오에서 열기"
  (window.hubJobExtras ||= []).push((j) => {
    if (String(j.id).startsWith('rm-')) return '';
    const text = `${j.report || ''}\n${(j.tasks || []).map((t) => t.text || '').join('\n')}`;
    const m = [...new Set((text.match(/[A-Za-z]:[\\/][^\s`'"<>|*?()\[\]]+?\.oddin-edit\.json/g) || []))];
    return m.length ? m.slice(0, 3).map((p) => `<div class="handoff-row ve-job">${icon('image')}<span class="t"><b>영상 편집</b> · ${esc(p.split(/[\\/]/).pop())}</span><button type="button" class="btn" data-studio-open="${esc(p)}">스튜디오에서 열기</button></div>`).join('') : '';
  });
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-studio-open]'); if (b) { e.preventDefault(); open(b.dataset.studioOpen); } });
  (window.hubCommands ||= []).push(() => [
    { label: 'ODDIN 스튜디오 열기', desc: '영상 편집 프로그램 — 컷·자막 싱크·글자 디자인·모션, 프리미어 가져오기', icon: 'image', run: () => open() },
    { label: 'ODDIN 스튜디오 · 경로로 열기…', desc: '편집 파일(.oddin-edit.json) 또는 영상 파일 경로', icon: 'image', run: () => { const p = prompt('편집 파일(.oddin-edit.json) 또는 영상 파일의 전체 경로'); if (p) open(p.trim().replace(/^"|"$/g, '')); } },
  ]);
})();
