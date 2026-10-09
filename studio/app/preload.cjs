// 스튜디오 화면에 window.studioDesktop 을 준다(엔진 주소에서 연 화면만): 끌어 놓은 파일의 실제 경로 · 탐색기에서 보기 · 기본 프로그램으로 열기 · 창 앞으로
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

let info = { trusted: false };
try { info = ipcRenderer.sendSync('studio:info') || info; } catch {}
if (info.trusted) {
  contextBridge.exposeInMainWorld('studioDesktop', {
    isApp: true,
    version: String(info.version || ''),
    pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
    showItem: (p) => ipcRenderer.invoke('studio:show-item', String(p || '')),
    openPath: (p) => ipcRenderer.invoke('studio:open-path', String(p || '')),
    focus: () => ipcRenderer.send('studio:focus'),
  });
}
