import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../public/tools-ui.js', import.meta.url), 'utf8');
function boot({ remote = false, session = 's1', job = '', dir = false } = {}) {
  const calls = [], listeners = {};
  const node = () => ({
    innerHTML: '', style: {}, offsetWidth: 320, offsetHeight: 400,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, before() {}, scrollIntoView() {},
    querySelector: () => node(), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 500, bottom: 520 }),
  });
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const target = { path: dir ? 'C:\\work\\result' : 'C:\\work\\result\\movie.mp4', name: dir ? 'result' : 'movie.mp4', kind: dir ? 'dir' : 'file', size: 100 };
  const scope = vm.createContext({
    S: { current: session, sessions: new Map(), pop: null }, IC: {}, input: {},
    $: get, icon: () => '', esc: String, pointAnchor: () => node(),
    document: { addEventListener() {}, getElementById: get, createElement: node },
    window: { innerWidth: 1200, innerHeight: 900, addEventListener: (type, fn) => { listeners[type] = fn; }, openPath: (...args) => calls.push(args) },
    localStorage: { getItem: () => null }, isRemoteView: () => remote,
    api: async url => { assert.match(url, /^\/api\/stat\?/); return target; },
  });
  vm.runInContext(app.slice(app.indexOf('function openPop('), app.indexOf('function openModePicker(')), scope);
  vm.runInContext(tools, scope);
  return {
    scope, calls, target,
    open: async () => {
      await scope.window.hubPathMenu({ dataset: { open: target.path }, closest: () => job ? { id: 'job-' + job } : null }, 10, 10);
      const items = vm.runInContext('popItems()', scope);
      const index = items.findIndex(i => i.label === '탐색기에서 열기');
      assert.ok(index >= 0);
      return { index, item: items[index], html: get('#pop').innerHTML };
    },
  };
}

test('같은 PC의 파일과 폴더는 탐색기로 열고 기본 프로그램 실행과 구분한다', async () => {
  for (const dir of [false, true]) {
    const page = boot({ dir }), { item, index } = await page.open();
    assert.equal(item.disabled, false);
    page.scope.popPick(index);
    assert.equal(page.calls.length, 1);
    assert.equal(page.calls[0][0], page.target.path);
    assert.equal(page.calls[0][1], 'reveal');
  }
});

test('다른 작업 PC와 원격 접속에서는 메뉴를 표시하되 마우스·키보드·직접 호출을 막는다', async () => {
  for (const context of [{ session: 'rm-peer-s1' }, { job: 'rm-peer-j1' }, { remote: true }]) {
    const page = boot(context), { item, index, html } = await page.open();
    assert.equal(item.disabled, true);
    assert.match(item.desc, /현재 PC와 작업 PC가 같을 때만/);
    assert.match(html, /aria-disabled="true"/);
    page.scope.popPick(index);
    page.scope.S.pop.sel = index;
    page.scope.popPick();
    page.scope.S.pop.kbd = true;
    page.scope.popMove(1);
    assert.notEqual(page.scope.S.pop.sel, index);
    page.scope.popMove(-1);
    assert.notEqual(page.scope.S.pop.sel, index, '역방향에서도 비활성 항목을 건너뛴다');
    await item.run();
    assert.equal(page.calls.length, 0);
  }
});

test('비활성 항목뿐인 메뉴도 방향키에 멈추지 않고 실행하지 않는다', () => {
  const page = boot();
  page.scope.S.pop = { items: [{ label: '열기', disabled: true, run: () => assert.fail('disabled') }], sel: 0, kbd: true };
  page.scope.popMove(1); page.scope.popMove(-1); page.scope.popPick();
  assert.equal(page.scope.S.pop.sel, 0);
});
