/* 첫 화면을 그리기 전에 복원한다. 별도 키라 세션 설정 저장과 충돌하지 않는다. */
(() => {
  const KEY = 'oddin.theme';
  const THEMES = [
    { id: 'graphite', name: '그래파이트', desc: '어두운 회색 · 선명한 파랑' },
    { id: 'forest', name: '터미널 그린', desc: '깊은 녹색 · 밝은 민트' },
    { id: 'amber', name: '앰버', desc: '따뜻한 차콜 · 호박색' },
    { id: 'violet', name: '바이올렛', desc: '짙은 보라 · 라벤더' },
    { id: 'ocean', name: '오션', desc: '깊은 남색 · 청록색' },
    { id: 'mono', name: '모노크롬', desc: '어두운 회색 · 은은한 은색' },
  ];
  let current = THEMES[0];
  function saved() { try { return localStorage.getItem(KEY); } catch { return null; } }
  function apply(id, persist = false) {
    current = THEMES.find(t => t.id === id) || THEMES[0];
    document.documentElement.dataset.theme = current.id;
    const name = document.getElementById('themeName'); if (name) name.textContent = current.name;
    for (const input of document.querySelectorAll('input[name="oddin-theme"]')) input.checked = input.value === current.id;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
    if (persist) {
      try { localStorage.setItem(KEY, current.id); }
      catch { window.toast?.('테마는 적용했지만 이 창에는 저장할 수 없어요'); }
    }
  }
  function open() {
    const body = window.modal('색상 테마', true);
    body.innerHTML = `<div class="theme-picker"><p>선택하면 바로 적용됩니다. 이 브라우저·앱에 저장됩니다.</p><fieldset class="theme-grid"><legend class="sr-only">색상 테마 선택</legend>${THEMES.map(t => `<label class="theme-choice" data-theme="${t.id}"><span class="theme-choice-head"><input type="radio" name="oddin-theme" value="${t.id}" ${current.id === t.id ? 'checked' : ''}><b>${t.name}</b></span><span class="theme-description">${t.desc}</span><span class="theme-swatches" aria-hidden="true"><i></i><i></i><i></i><i></i></span></label>`).join('')}</fieldset></div>`;
    body.onclick = null;
    body.querySelector('input:checked')?.focus();
  }
  window.hubTheme = { open, select: id => apply(id, true), current: () => current };
  apply(saved());
  window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) apply(saved()); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(current.id);
    document.getElementById('btnTheme')?.addEventListener('click', open);
    document.addEventListener('change', e => { if (e.target.matches('input[name="oddin-theme"]')) apply(e.target.value, true); });
    window.hubCommands = window.hubCommands || [];
    window.hubCommands.push(() => THEMES.map(t => ({ label: `테마 · ${t.name}`, desc: t.desc, icon: 'board', run: () => apply(t.id, true) })));
  });
})();
