// 허브 화면에 window.hubDesktop 연결 객체를 노출한다. 규약: docs/desktop.md
// 등록된 허브 화면과 프로그램 안내 화면에서만 노출하고, 모든 요청은 main 에서 다시 출처를 검사한다.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

let info = { trusted: false };
try { info = ipcRenderer.sendSync('hub:info') || info; } catch {}

if (info.trusted) {
  const call = async (channel, ...args) => {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r || !r.ok) throw new Error(r?.error || '프로그램 요청에 실패했어요');
    return r.value;
  };
  const listen = (channel, cb) => {
    if (typeof cb !== 'function') return () => {};
    const f = (_e, payload) => { try { cb(payload); } catch (err) { console.error(err); } };
    ipcRenderer.on(channel, f);
    return () => ipcRenderer.removeListener(channel, f);
  };
  contextBridge.exposeInMainWorld('hubDesktop', {
    isDesktop: true,
    version: String(info.version || ''),
    isLocalHub: !!info.isLocalHub,
    getHubs: () => call('hubs:get'),
    switchHub: (id, opts) => call('hubs:switch', String(id || ''), { sessionId: opts?.sessionId ? String(opts.sessionId) : '' }),
    addHub: (hub) => call('hubs:add', { name: String(hub?.name ?? ''), url: String(hub?.url ?? '') }),
    renameHub: (id, name) => call('hubs:rename', String(id || ''), String(name ?? '')),
    removeHub: (id) => call('hubs:remove', String(id || '')),
    remoteSessions: () => call('hubs:remote-sessions'),
    onHubsChanged: (cb) => listen('hubs-changed', () => cb()),
    onCommand: (cb) => listen('command', (c) => cb({ ...(c || {}) })),
    notify: (n) => ipcRenderer.send('notify', { title: String(n?.title ?? ''), body: String(n?.body ?? ''), sessionId: n?.sessionId ? String(n.sessionId) : '' }),
    setBusy: (count) => ipcRenderer.send('busy', Number(count) || 0),
    pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  });
}
