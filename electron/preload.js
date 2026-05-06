/**
 * preload.js
 * Exposes a minimal, safe API to the setup window renderer.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  closeSetup: ()       => ipcRenderer.invoke('close-setup'),
  getConfig:  ()       => ipcRenderer.invoke('get-config'),
});
