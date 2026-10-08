import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/commands.js', import.meta.url), 'utf8');
const KEY = 'oddin.usage-warnings-hidden';
const start = Date.UTC(2026, 0, 1), hour = 3_600_000;
const usage = () => ({ claude: { windows: [
  { key: 'model_fable', label: 'Fable 주간', model: 'fable', usedPercent: 100, resetsAt: new Date(start + hour).toISOString() },
  { key: 'seven_day', label: '주간', usedPercent: 89, resetsAt: new Date(start + 2 * hour).toISOString() },
] } });

function boot(data = new Map(), blocked = false) {
  let now = start, writes = 0, focused = false;
  const listeners = {}, nodes = {}, notices = [];
  const get = id => nodes[id] ||= { hidden: true, innerHTML: '', addEventListener: (type, fn) => { listeners[id + type] = fn; } };
  const context = vm.createContext({
    S: { usage: usage() }, $: get,
    input: { addEventListener() {}, focus() { focused = true; } },
    document: { addEventListener() {} },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    localStorage: {
      getItem: key => { if (blocked) throw Error('blocked'); return data.get(key) ?? null; },
      setItem: (key, value) => { if (blocked) throw Error('blocked'); writes++; data.set(key, value); },
    },
    Date: class extends Date { static now() { return now; } },
    renderUsage() {}, renderTop() {},
    icon: () => '', esc: String, resetPhrase: String, toast: text => notices.push(text),
  });
  vm.runInContext(source, context);
  return {
    state: context.S, bar: get('#warnBar'), notices, listeners,
    render: () => context.renderWarnings(), time: value => { now = value; },
    hide: () => listeners['#warnBarclick']({ target: { closest: selector => selector === '[data-wb-hide]' } }),
    writes: () => writes, focused: () => focused,
  };
}

test('한도 경고 숨김은 갱신·새로고침·다른 창에 유지되고 각 초기화 및 새 한도 경고는 다시 보인다', () => {
  const data = new Map(), page = boot(data), peer = boot(data);
  page.render(); peer.render();
  assert.match(page.bar.innerHTML, /다음 초기화까지 숨기기/);
  page.hide();
  assert.equal(page.bar.hidden, true);
  assert.equal(page.focused(), true);
  assert.equal(page.writes(), 1);
  page.notices.length = 0;
  page.state.usage.claude.windows[1].usedPercent = 99;
  page.render();
  assert.equal(page.bar.hidden, true, '정기 갱신과 위험 단계 상승에도 숨김 유지');
  assert.equal(page.notices.length, 0);
  peer.listeners.storage({ key: KEY });
  assert.equal(peer.bar.hidden, true);
  assert.equal(peer.writes(), 0, '다른 창의 숨김을 다시 저장하지 않는다');
  const reload = boot(data); reload.render();
  assert.equal(reload.bar.hidden, true);
  assert.equal(reload.notices.length, 0, '새로고침 후 팝업 알림도 숨긴다');
  reload.state.usage.codex = { windows: [{ key: 'w300', label: '5시간', usedPercent: 98, resetsAt: new Date(start + 3 * hour).toISOString() }] };
  reload.render();
  assert.match(reload.bar.innerHTML, /Codex/);
  assert.doesNotMatch(reload.bar.innerHTML, /Claude/);
  reload.time(start + hour);
  reload.render();
  assert.match(reload.bar.innerHTML, /Fable 주간/);
  assert.doesNotMatch(reload.bar.innerHTML, /<b>Claude 주간/);
  reload.time(start + 2 * hour);
  reload.render();
  assert.match(reload.bar.innerHTML, /<b>Claude 주간/);
  page.state.usage.claude.windows[0].resetsAt = new Date(start + 7 * 24 * hour).toISOString();
  page.render();
  assert.match(page.bar.innerHTML, /Fable 주간/, '새 초기화 주기는 예전 숨김에 포함하지 않는다');
  data.clear(); peer.listeners.storage({ key: null });
  assert.equal(peer.bar.hidden, false);
});

test('저장 실패·손상된 저장값·미확인 초기화 시각을 안전하게 처리한다', () => {
  const page = boot(new Map(), true);
  page.render(); page.hide(); page.render();
  assert.equal(page.bar.hidden, true, '저장 불가여도 현재 창에서는 숨긴다');
  assert.match(page.notices.at(-1), /저장하지 못했어요/);
  for (const value of ['{bad', 'null', '{"claude:seven_day":"forever"}', '{"claude:seven_day":0}']) {
    const invalid = boot(new Map([[KEY, value]])); invalid.render();
    assert.equal(invalid.bar.hidden, false);
  }
  const unknown = boot();
  unknown.state.usage.claude.windows[0].resetsAt = null;
  unknown.render();
  assert.equal(unknown.bar.hidden, false);
  assert.doesNotMatch(unknown.bar.innerHTML, /data-wb-hide/);
  assert.match(unknown.bar.innerHTML, /data-wb-close/);
});

test('초기화 시각의 조회 오차는 같은 주기로 보고 새로고침 후에도 숨긴다', () => {
  const data = new Map(), page = boot(data);
  // 실제 조회에서 같은 초기화가 xx:59.990 → xx:59.690으로 바뀐다.
  for (const w of page.state.usage.claude.windows) w.resetsAt = new Date(Date.parse(w.resetsAt) - 10).toISOString();
  page.render(); page.hide();
  for (const delta of [-300, 300, -30_000, 30_000]) {
    const reload = boot(data);
    reload.state.usage.claude.windows.forEach((w, i) => { w.resetsAt = new Date(start + (i + 1) * hour - 10 + delta).toISOString(); });
    reload.render();
    assert.equal(reload.bar.hidden, true, `초기화 시각 ${delta}ms 오차`);
    assert.equal(reload.notices.length, 0, '팝업 알림도 다시 띄우지 않는다');
    reload.time(start + 2 * hour);
    reload.render();
    assert.equal(reload.bar.hidden, false, '저장한 숨김 기한이 끝나면 다시 표시한다');
  }
});
