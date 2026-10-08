// ODDIN 크롬 연결 — 팝업. 상태를 보여 주고 켜기/끄기·포트·AI 탭 모두 닫기만 한다.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg).then((r) => { if (!r?.ok) throw new Error(r?.error || '확장이 답하지 않아요'); return r.status; });

function paint(s) {
  $('on').checked = s.enabled;
  $('port').value = s.port;
  $('dot').className = `dot ${!s.enabled ? '' : s.connected ? 'on' : 'bad'}`;
  $('state').textContent = !s.enabled ? '꺼져 있어요' : s.connected ? 'ODDIN 에 연결됐어요' : '연결 중…';
  $('detail').textContent = !s.enabled ? 'AI가 이 크롬을 쓰지 않아요.' : s.connected ? 'Claude·Codex 작업자가 이 크롬(로그인된 상태)을 쓸 수 있어요.' : (s.error || 'ODDIN 이 켜져 있는지 확인해 주세요.');
  const ul = $('tabs'); ul.textContent = '';
  for (const t of s.tabs) { const li = document.createElement('li'); li.textContent = t.title || t.url || '빈 탭'; li.title = t.url || ''; ul.append(li); }
  $('none').hidden = s.tabs.length > 0; $('closeAll').hidden = !s.tabs.length;
}
const refresh = () => ask({ type: 'status' }).then(paint, (e) => { $('state').textContent = e.message; });

$('on').addEventListener('change', (e) => ask({ type: 'enable', on: e.target.checked }).then(paint));
$('closeAll').addEventListener('click', () => ask({ type: 'closeAll' }).then(paint));
$('save').addEventListener('click', () => ask({ type: 'port', port: $('port').value }).then(paint, (e) => { $('detail').textContent = e.message; }));
refresh();
setInterval(refresh, 1500);
