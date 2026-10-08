/* 테마 = 색(팔레트) × 모양(스타일). 첫 화면을 그리기 전에 복원한다. 별도 키라 세션 설정 저장과 충돌하지 않는다.
   색은 themes.css 의 [data-theme], 모양은 [data-style] 로 <html> 에 붙는다. 선택은 이 브라우저·앱에 저장되고 다른 창과 맞춘다(storage 이벤트). */
(() => {
  const KEY = 'oddin.theme', SKEY = 'oddin.style';
  const THEMES = [
    // 어두운
    { id: 'graphite', name: '그래파이트', desc: '어두운 회색 · 선명한 파랑', dark: true },
    { id: 'forest', name: '터미널 그린', desc: '깊은 녹색 · 밝은 민트', dark: true },
    { id: 'amber', name: '앰버', desc: '따뜻한 차콜 · 호박색', dark: true },
    { id: 'violet', name: '바이올렛', desc: '짙은 보라 · 라벤더', dark: true },
    { id: 'ocean', name: '오션', desc: '깊은 남색 · 청록색', dark: true },
    { id: 'mono', name: '모노크롬', desc: '어두운 회색 · 은은한 은색', dark: true },
    { id: 'rose', name: '로즈', desc: '검붉은 바탕 · 분홍', dark: true },
    { id: 'sunset', name: '선셋', desc: '어두운 적갈색 · 주황', dark: true },
    { id: 'nordic', name: '노르딕', desc: '청회색 · 하늘색', dark: true },
    { id: 'midnight', name: '미드나이트', desc: '한밤 남색 · 금색', dark: true },
    { id: 'contrast', name: '하이 콘트라스트', desc: '순검정 · 노랑 · 큰 대비', dark: true },
    // 밝은
    { id: 'paper', name: '페이퍼', desc: '따뜻한 흰색 · 테라코타', dark: false },
    { id: 'snow', name: '스노우', desc: '차가운 흰색 · 파랑', dark: false },
    { id: 'sand', name: '샌드', desc: '베이지 · 올리브 금색', dark: false },
    { id: 'sage', name: '세이지', desc: '연한 회녹색 · 짙은 녹색', dark: false },
    { id: 'lilac', name: '라일락', desc: '연보라 · 보라', dark: false },
  ];
  const STYLES = [
    { id: 'terminal', name: '터미널', desc: '각진 모서리 · 고정폭 글꼴 · [ ] › 표시' },
    { id: 'soft', name: '소프트', desc: '둥근 모서리 · 산세리프 · 카드와 말풍선' },
    { id: 'glass', name: '글래스', desc: '반투명 유리판 · 은은한 색 번짐' },
    { id: 'flat', name: '플랫', desc: '선 없이 면으로만 · 넓은 여백' },
    { id: 'crt', name: '레트로 CRT', desc: '주사선 · 글자 빛번짐 · 고정폭' },
  ];
  let current = THEMES[0], style = STYLES[0];
  function saved(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function store(key, value) {
    try { localStorage.setItem(key, value); }
    catch { window.toast?.('테마는 적용했지만 이 창에는 저장할 수 없어요'); }
  }
  function paint() {
    const root = document.documentElement;
    root.dataset.theme = current.id; root.dataset.style = style.id;
    const name = document.getElementById('themeName'); if (name) name.textContent = `${current.name} · ${style.name}`;
    for (const input of document.querySelectorAll('input[name="oddin-theme"]')) input.checked = input.value === current.id;
    for (const input of document.querySelectorAll('input[name="oddin-style"]')) input.checked = input.value === style.id;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }
  function apply(id, persist = false) {
    current = THEMES.find(t => t.id === id) || THEMES[0];
    paint();
    if (persist) store(KEY, current.id);
  }
  function applyStyle(id, persist = false) {
    style = STYLES.find(s => s.id === id) || STYLES[0];
    paint();
    if (persist) store(SKEY, style.id);
  }
  const palette = t => `<label class="theme-choice" data-theme="${t.id}"><span class="theme-choice-head"><input type="radio" name="oddin-theme" value="${t.id}" ${current.id === t.id ? 'checked' : ''}><b>${t.name}</b></span><span class="theme-description">${t.desc}</span><span class="theme-swatches" aria-hidden="true"><i></i><i></i><i></i><i></i></span></label>`;
  const shape = s => `<label class="style-choice" data-style="${s.id}"><span class="tp-mini" aria-hidden="true"><i class="tp-mini-bar"><b></b></i><i class="tp-mini-side"></i><i class="tp-mini-row"><b>Aa</b><u></u></i><i class="tp-mini-line"></i><i class="tp-mini-line s"></i></span><span class="theme-choice-head"><input type="radio" name="oddin-style" value="${s.id}" ${style.id === s.id ? 'checked' : ''}><b>${s.name}</b></span><span class="theme-description">${s.desc}</span></label>`;
  function open() {
    const body = window.modal('테마', true);
    body.innerHTML = `<div class="theme-picker"><p>모양과 색을 따로 고를 수 있어요. 선택하면 바로 적용되고 이 브라우저·앱에 저장돼요.</p>
      <h4>모양</h4><fieldset class="style-grid"><legend class="sr-only">모양 선택</legend>${STYLES.map(shape).join('')}</fieldset>
      <h4>색 · 어두운</h4><fieldset class="theme-grid"><legend class="sr-only">어두운 색 선택</legend>${THEMES.filter(t => t.dark).map(palette).join('')}</fieldset>
      <h4>색 · 밝은</h4><fieldset class="theme-grid"><legend class="sr-only">밝은 색 선택</legend>${THEMES.filter(t => !t.dark).map(palette).join('')}</fieldset></div>`;
    body.onclick = null;
    body.scrollTop = 0; // 지난번 연 창의 스크롤 위치가 남지 않게 — 모양부터 보인다
    body.querySelector('input[name="oddin-style"]:checked')?.focus({ preventScroll: true });
  }
  window.hubTheme = { open, select: id => apply(id, true), selectStyle: id => applyStyle(id, true), current: () => current, style: () => style, themes: THEMES, styles: STYLES };
  style = STYLES.find(s => s.id === saved(SKEY)) || STYLES[0];
  apply(saved(KEY));
  window.addEventListener('storage', e => {
    if (e.key === SKEY || e.key === null) style = STYLES.find(s => s.id === saved(SKEY)) || STYLES[0];
    if (e.key === KEY || e.key === SKEY || e.key === null) apply(saved(KEY));
  });
  document.addEventListener('DOMContentLoaded', () => {
    paint();
    document.getElementById('btnTheme')?.addEventListener('click', open);
    document.addEventListener('change', e => {
      if (e.target.matches('input[name="oddin-theme"]')) apply(e.target.value, true);
      else if (e.target.matches('input[name="oddin-style"]')) applyStyle(e.target.value, true);
    });
    window.hubCommands = window.hubCommands || [];
    window.hubCommands.push(() => [
      { label: '테마 고르기', desc: `${current.name} · ${style.name}`, icon: 'board', run: open },
      ...STYLES.map(s => ({ label: `모양 · ${s.name}`, desc: s.desc, icon: 'panel', run: () => applyStyle(s.id, true) })),
      ...THEMES.map(t => ({ label: `색 · ${t.name}`, desc: `${t.dark ? '어두운' : '밝은'} · ${t.desc}`, icon: 'board', run: () => apply(t.id, true) })),
    ]);
  });
})();
