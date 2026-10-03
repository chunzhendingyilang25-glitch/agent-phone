const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentPhoneDesktop', Object.freeze({
  pick: kind => ipcRenderer.invoke('agent-phone:pick', kind),
  getSettings: () => ipcRenderer.invoke('agent-phone:settings'),
  setAutostart: enabled => ipcRenderer.invoke('agent-phone:autostart', enabled),
  showDataFolder: () => ipcRenderer.invoke('agent-phone:data-folder'),
  setKeepAwake: enabled => ipcRenderer.invoke('agent-phone:keep-awake', enabled),
}));
