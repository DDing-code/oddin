import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/themes.js', import.meta.url), 'utf8');
function boot(value, blocked = false) {
  const data = new Map(value == null ? [] : [['oddin.theme', value]]);
  const listeners = {}, notices = [], root = { dataset: {} }, label = {}, meta = {};
  let writes = 0;
  const window = { addEventListener: (type, fn) => { listeners[type] = fn; }, toast: text => notices.push(text) };
  const context = {
    window,
    localStorage: {
      getItem: key => { if (blocked) throw Error('storage blocked'); return data.get(key) ?? null; },
      setItem: (key, v) => { if (blocked) throw Error('storage blocked'); writes++; data.set(key, v); },
    },
    document: {
      documentElement: root,
      getElementById: id => id === 'themeName' ? label : null,
      querySelectorAll: () => [],
      querySelector: () => ({ setAttribute: (key, v) => { meta[key] = v; } }),
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#101010' }),
  };
  vm.runInNewContext(source, context);
  return { api: window.hubTheme, data, listeners, root, label, meta, notices, writes: () => writes };
}

test('테마 선택을 복원하고 다른 창의 변경을 반영하며 잘못된 값·저장 차단에 안전하게 대처한다', () => {
  const initial = boot();
  assert.equal(initial.root.dataset.theme, 'graphite');
  assert.equal(initial.writes(), 0, '시작할 때 다른 창의 저장값을 덮어쓰지 않는다');
  for (const id of ['graphite', 'forest', 'amber', 'violet', 'ocean', 'mono']) {
    initial.api.select(id);
    assert.equal(initial.data.get('oddin.theme'), id);
    assert.equal(boot(initial.data.get('oddin.theme')).root.dataset.theme, id);
  }
  initial.data.set('oddin.theme', 'amber');
  const before = initial.writes();
  initial.listeners.storage({ key: 'oddin.theme' });
  assert.equal(initial.root.dataset.theme, 'amber');
  assert.equal(initial.label.textContent, '앰버');
  assert.equal(initial.writes(), before, '동기화 이벤트를 다시 저장하지 않는다');
  initial.data.set('oddin.theme', 'forest');
  initial.listeners.storage({ key: 'hub.prefs' });
  assert.equal(initial.root.dataset.theme, 'amber');
  initial.data.clear(); initial.listeners.storage({ key: null });
  assert.equal(initial.root.dataset.theme, 'graphite');
  assert.equal(boot('<invalid>').root.dataset.theme, 'graphite');
  initial.api.select('__proto__'); assert.equal(initial.root.dataset.theme, 'graphite');
  const unavailable = boot('amber', true);
  unavailable.api.select('forest');
  assert.equal(unavailable.root.dataset.theme, 'forest');
  assert.equal(unavailable.notices.length, 1);
});
