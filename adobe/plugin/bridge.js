/* ODDIN 연결 고리 — 프리미어·애프터이펙트 안에서 ODDIN 허브의 명령을 기다렸다가 실행하고 결과를 돌려준다.
   worker.html(앱이 켜질 때 함께 뜨는 보이지 않는 창)이 기본으로 쓰고, panel.html 은 워커가 안 붙어 있으면 대신 쓴다.
   허브 API: lib/adobe-bridge.mjs (hello · next · result). Node(CEP --enable-nodejs)로 요청해 출처 검사에 걸리지 않는다. */
(function () {
  'use strict';
  var http = require('http');
  var fs = require('fs');
  var path = require('path');
  var cep = window.__adobe_cep__;

  var env = {};
  try { env = JSON.parse(cep.getHostEnvironment()); } catch (e) {}
  var APP = env.appName === 'AEFT' ? 'aftereffects' : 'premiere';
  var HERE = decodeURI(location.pathname).replace(/^\/(?=[A-Za-z]:)/, '').replace(/\/[^/]*$/, '');
  var conf = { hub: 'http://127.0.0.1:7700', version: '1.0.0' };
  try { var c = JSON.parse(fs.readFileSync(path.join(HERE, 'app.json'), 'utf8')); for (var k in c) conf[k] = c[k]; } catch (e) {}
  var HUB = new URL(conf.hub);

  function request(method, p, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      var req = http.request({ host: HUB.hostname, port: HUB.port || 80, path: p, method: method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, function (res) {
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8'), json = null;
          try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, json: json });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs || 15000, function () { req.destroy(new Error('응답이 없어요')); });
      if (data) req.write(data);
      req.end();
    });
  }

  function evalScript(code) {
    return new Promise(function (resolve) { cep.evalScript(code, function (r) { resolve(r); }); });
  }
  // 한글 등은 \uXXXX 로 바꿔 보낸다 (프리미어 스크립트 엔진의 글자 깨짐 방지, 문자열·주석·이름 어디서나 같은 뜻)
  function ascii(code) { return String(code).replace(/[^\x00-\x7e]/g, function (ch) { return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4); }); }

  var hostPath = path.join(HERE, 'host', 'oddin.jsx').replace(/\\/g, '/');
  // 앱 안 도우미(host/oddin.jsx)가 없거나 예전 판이면 다시 읽는다 — 플러그인을 다시 설치해도 앱을 다시 켤 필요가 없게
  function ensureHost() {
    return evalScript('typeof ODDIN === "object" && typeof ODDIN.run === "function" ? String(ODDIN.version) : ""').then(function (r) {
      if (r === String(conf.version)) return;
      return evalScript('$.evalFile(' + JSON.stringify(hostPath) + ')');
    });
  }

  // 화면 없이 뜬 앱(백그라운드 AE, Dynamic Link·렌더용 AE)인지: 이 창을 띄운 앱 프로세스의 실행 줄을 본다
  function detectHeadless() {
    return new Promise(function (resolve) {
      if (process.platform !== 'win32') return resolve(false);
      var cp = require('child_process');
      cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 }, function (err, out) {
        if (err) return resolve(false);
        var list; try { list = JSON.parse(out); } catch (e) { return resolve(false); }
        var byId = {}; list.forEach(function (p) { byId[p.ProcessId] = p; });
        var cur = byId[process.pid], hops = 0;
        while (cur && hops++ < 8 && !/^(AfterFX|Adobe Premiere Pro)/i.test(cur.Name || '')) cur = byId[cur.ParentProcessId];
        if (!cur) return resolve(false);
        var parent = byId[cur.ParentProcessId] || {};
        resolve(/(^|\s)-(noui|re|m)(\s|$)/i.test(cur.CommandLine || '') || /dynamiclink|aerender/i.test(parent.Name || ''));
      });
    });
  }

  function runCommand(cmd) {
    var code = cmd.script || '';
    if (!code && cmd.file) {
      try { code = fs.readFileSync(cmd.file, 'utf8').replace(/^﻿/, ''); } catch (e) { return Promise.resolve({ ok: false, error: '스크립트 파일을 읽지 못했어요: ' + e.message }); }
    }
    return ensureHost().then(function () {
      return evalScript('ODDIN.run(function () {\n' + ascii(code) + '\n})');
    }).then(function (out) {
      if (out === 'EvalScript error.' || out === undefined || out === null) return { ok: false, error: '스크립트 문법 오류예요 (앱이 "EvalScript error"를 돌려줬어요)' };
      try { return JSON.parse(out); } catch (e) { return { ok: true, result: out }; }
    });
  }

  var state = { role: 'worker', instance: '', running: false, connected: false, lastError: '', done: 0, lastCommandAt: 0, info: null, headless: false, listeners: [] };
  function notify() { state.listeners.forEach(function (f) { try { f(state); } catch (e) {} }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function hello() {
    return evalScript('typeof ODDIN === "object" ? ODDIN.json(ODDIN.info()) : ""').then(function (out) {
      try { state.info = JSON.parse(out); } catch (e) {}
      return request('POST', '/api/adobe/hello', { app: APP, instance: state.instance, version: conf.version, appVersion: env.appVersion || '', project: (state.info && state.info.project) || '', role: state.role, headless: state.headless });
    });
  }

  function loop() {
    var lastHello = 0;
    function step() {
      if (!state.running) return;
      var p = Promise.resolve();
      if (Date.now() - lastHello > 60000) p = p.then(hello).then(function () { lastHello = Date.now(); });
      p.then(function () {
        return request('GET', '/api/adobe/next?app=' + APP + '&instance=' + encodeURIComponent(state.instance) + '&wait=25', undefined, 40000);
      }).then(function (r) {
        if (r.status !== 200) throw new Error((r.json && r.json.error) || ('허브 응답 ' + r.status));
        if (!state.connected || state.lastError) { state.connected = true; state.lastError = ''; notify(); }
        var cmd = r.json && r.json.cmd;
        if (!cmd) return;
        state.busy = true; notify();
        // 오래 걸리는 명령(렌더 등) 동안에도 살아 있다고 알린다 (앱 스크립트가 도는 동안 이 창의 타이머는 계속 돈다)
        var beat = setInterval(function () { request('POST', '/api/adobe/hello', { app: APP, instance: state.instance, version: conf.version, appVersion: env.appVersion || '', project: (state.info && state.info.project) || '', role: state.role, headless: state.headless }).catch(function () {}); }, 20000);
        return runCommand(cmd).then(function (res) {
          clearInterval(beat);
          state.busy = false; state.done++; state.lastCommandAt = Date.now(); notify();
          var err = res.ok === true ? null : (res.error || '실패했어요') + (res.line ? ' (' + res.line + '번째 줄)' : '');
          return request('POST', '/api/adobe/result', { id: cmd.id, ok: res.ok === true, result: res.result === undefined ? null : res.result, error: err });
        }, function (e) { clearInterval(beat); throw e; });
      }).then(function () { setTimeout(step, 0); }, function (e) {
        state.busy = false;
        if (state.connected || state.lastError !== e.message) { state.connected = false; state.lastError = e.message; notify(); }
        lastHello = 0; // 다시 붙으면 소개부터
        sleep(3000).then(step);
      });
    }
    step();
  }

  window.ODDINBridge = {
    app: APP, hub: conf.hub, version: conf.version, env: env, state: state, request: request,
    onChange: function (f) { state.listeners.push(f); f(state); },
    start: function (role) {
      if (state.running) return;
      state.role = role || 'worker';
      state.instance = APP + '-' + state.role + '-' + Math.random().toString(36).slice(2, 10);
      state.running = true; notify();
      detectHeadless().then(function (h) { state.headless = h; loop(); });
    },
    stop: function () { state.running = false; notify(); },
  };
})();
