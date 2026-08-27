// Preload for the pairing window. contextIsolation is on and nodeIntegration
// is off (main.js), so the renderer (pairing.html) gets no Node/Electron
// access of its own -- this is the only bridge, and it exposes exactly the
// three things pairing.html needs, nothing broader (no raw ipcRenderer, no
// fs, no shell).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hlm', {
  getPlatform: () => ipcRenderer.invoke('hlm-get-platform'),
  submitPairing: (email, pairingCode) => ipcRenderer.invoke('hlm-submit-pairing', { email, pairingCode }),
  pairingComplete: () => ipcRenderer.send('hlm-pairing-complete'),
});
