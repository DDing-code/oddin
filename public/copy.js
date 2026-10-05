/* 복사 버튼 (2026-10-05 사용자 "텍스트 박스나 코드 출력물에 복사 버튼 있으면 좋겠어")
   - 코드·명령·출력 상자(pre): 오른쪽 위에 복사 버튼(마우스를 올리거나 초점이 가면 보임, 터치 화면은 늘 보임)
   - 보고: 카드 아래 "다시 보내기" 옆 "보고 복사", 작업별 결과 글: 오른쪽 위 복사 버튼(화면에 보이는 글 그대로)
   - 내가 보낸 요청 말풍선: 아래 시간 줄 옆 "복사"
   어떤 화면이 다시 그려져도 새로 생긴 상자에 알아서 붙는다(MutationObserver). 공용 파일은 건드리지 않는다. */
(() => {
  const ic = (n) => (typeof icon === 'function' ? icon(n) : '');
  const SKIP = '.cp-box, #fv .fv-code, .xterm, [contenteditable]';

  async function copy(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try { const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove(); } catch {}
    }
    if (btn) { btn.classList.add('done'); btn.innerHTML = ic(ok ? 'check' : 'alert') + (btn.dataset.cpLabel ? `<span>${ok ? '복사함' : '실패'}</span>` : ''); setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = ic('copy') + (btn.dataset.cpLabel ? `<span>${btn.dataset.cpLabel}</span>` : ''); }, 1300); }
    if (typeof toast === 'function') toast(ok ? '복사했어요' : '복사하지 못했어요', !ok);
  }
  const button = (label, extra = '') => `<button type="button" class="cp-btn ${extra}" title="${label}" aria-label="${label}">${ic('copy')}</button>`;

  function decorate(root) {
    // 코드·출력 상자: 감싸서 버튼을 상자 밖 모서리에 둔다(가로로 스크롤해도 버튼이 따라 움직이지 않게)
    for (const pre of root.querySelectorAll('pre:not([data-cp])')) {
      pre.dataset.cp = '1';
      if (pre.closest(SKIP) || !pre.isConnected || !pre.parentNode) continue;
      const box = document.createElement('div');
      box.className = 'cp-box';
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(pre);
      box.insertAdjacentHTML('beforeend', button('복사', 'cp-corner'));
    }
    // 보고: 카드 아래 "다시 보내기" 줄에 "보고 복사" (글 위에 겹치지 않게)
    for (const foot of root.querySelectorAll('.turn .afoot:not([data-cp])')) {
      foot.dataset.cp = '1';
      if (!foot.closest('.turn')?.querySelector('.report > .md')) continue;
      const html = `<button type="button" class="btn cp-btn cp-foot" data-cp-label="보고 복사" title="보고 글 복사">${ic('copy')}<span>보고 복사</span></button>`;
      const reuse = foot.querySelector('[data-reuse]');
      if (reuse) reuse.insertAdjacentHTML('beforebegin', html); else foot.insertAdjacentHTML('beforeend', html);
    }
    // 작업별 결과 글(여러 작업일 때)
    for (const el of root.querySelectorAll('.tres:not([data-cp])')) {
      el.dataset.cp = '1';
      el.classList.add('cp-host');
      el.insertAdjacentHTML('beforeend', button('글 복사', 'cp-corner cp-text'));
    }
    // 내가 보낸 요청
    for (const meta of root.querySelectorAll('.user > .umeta:not([data-cp])')) {
      meta.dataset.cp = '1';
      meta.insertAdjacentHTML('beforeend', `<button type="button" class="cp-btn cp-inline" data-cp-label="복사" title="요청 글 복사" aria-label="요청 글 복사">${ic('copy')}<span>복사</span></button>`);
    }
  }

  // 버튼을 뺀 글만 (보고 안의 코드 상자 버튼 등)
  function textOf(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('.cp-btn').forEach((b) => b.remove());
    document.body.appendChild(c); c.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap';
    const t = c.innerText; c.remove();
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('.cp-btn'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.classList.contains('cp-foot')) { const md = b.closest('.turn')?.querySelector('.report > .md'); if (md) copy(textOf(md), b); return; }
    if (b.classList.contains('cp-inline')) { const bubble = b.closest('.user')?.querySelector('.bubble'); if (bubble) copy(bubble.textContent, b); return; }
    const box = b.closest('.cp-box');
    if (box) { const pre = box.querySelector('pre'); if (pre) copy(pre.innerText.replace(/\n$/, ''), b); return; }
    const host = b.closest('.cp-host'); if (host) copy(textOf(host), b);
  }, true);

  let queued = false;
  const run = () => { queued = false; decorate(document.body); };
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(run, 30); } }).observe(document.body, { childList: true, subtree: true });
  run();
})();
