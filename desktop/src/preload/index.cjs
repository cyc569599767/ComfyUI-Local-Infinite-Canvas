'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getRuntimeInfo: () => ipcRenderer.invoke('app:get-runtime-info'),
  getState: () => ipcRenderer.invoke('app:get-state'),
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('app:save-config', config),
  chooseComfy: () => ipcRenderer.invoke('app:choose-comfy'),
  openData: () => ipcRenderer.invoke('app:open-data'),
  restart: () => ipcRenderer.invoke('app:restart'),
  connect: () => ipcRenderer.invoke('app:connect'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  showPage: (target) => ipcRenderer.invoke('app:show-page', target),
  reloadPage: () => ipcRenderer.invoke('app:reload-page'),
  openDevTools: () => ipcRenderer.invoke('app:devtools'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('app:state', listener);
    return () => ipcRenderer.removeListener('app:state', listener);
  },
});
