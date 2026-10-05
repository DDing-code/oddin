/* ODDIN 패널: 가운데 로고 + 연결 상태만 보여 준다.
   명령은 보이지 않는 워커(worker.html)가 받는다. 패널을 열었는데 워커가 안 붙어 있으면(앱이 워커 자동 시작을 안 하는 경우) 패널이 대신 받는다. */
(function () {
  'use strict';
  var B = window.ODDINBridge;
  var $ = function (id) { return document.getElementById(id); };
  var NAME = { premiere: '프리미어', aftereffects: '애프터이펙트' };
  // 앱 패널 바탕색에 맞춘다
  try {
    var skin = B.env.appSkinInfo && B.env.appSkinInfo.panelBackgroundColor && B.env.appSkinInfo.panelBackgroundColor.color;
    if (skin) document.documentElement.style.setProperty('--bg', 'rgb(' + Math.round(skin.red) + ',' + Math.round(skin.green) + ',' + Math.round(skin.blue) + ')');
  } catch (e) {}

  function ago(iso) {
    if (!iso) return '';
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return s < 60 ? '방금' : s < 3600 ? Math.floor(s / 60) + '분 전' : Math.floor(s / 3600) + '시간 전';
  }
  function show(kind, text, sub) {
    $('main').className = kind;
    $('text').textContent = text;
    $('sub').textContent = sub || '';
  }

  var noWorkerSince = 0;
  function check() {
    B.request('GET', '/api/adobe/status', undefined, 5000).then(function (r) {
      var apps = (r.json && r.json.apps) || [];
      var mine = apps.filter(function (a) { return a.app === B.app && a.online; });
      if (!mine.length) {
        if (!noWorkerSince) noWorkerSince = Date.now();
        // 워커가 6초 넘게 안 보이면 패널이 직접 명령을 받는다
        if (!B.state.running && Date.now() - noWorkerSince > 6000) B.start('panel');
        show('wait', '연결 중', 'ODDIN에 ' + NAME[B.app] + '를 연결하고 있어요');
        return;
      }
      noWorkerSince = 0;
      var done = mine.reduce(function (n, a) { return n + (a.done || 0); }, 0);
      var busy = B.state.busy || mine.some(function (a) { return a.waiting > 0; }) || (r.json.pending > 0);
      show(busy ? 'ok busy' : 'ok', 'ODDIN 연결됨', busy ? '명령 실행 중' : done ? '명령 ' + done + '건 처리 · 최근 ' + ago(mine[0].lastSeen) : 'AI 명령을 기다리는 중');
    }, function () {
      noWorkerSince = 0;
      show('off', 'ODDIN 꺼짐', 'ODDIN이 켜지면 자동으로 다시 연결돼요');
    });
  }
  B.onChange(function () { check(); });
  check();
  setInterval(check, 3000);
})();
