const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  exitApp: () => ipcRenderer.invoke('exit-app')
});
