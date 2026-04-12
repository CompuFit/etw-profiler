'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Process management
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  startTracking: (pid, name) => ipcRenderer.invoke('start-tracking', pid, name),
  stopTracking: () => ipcRenderer.invoke('stop-tracking'),
  getTrackingState: () => ipcRenderer.invoke('get-tracking-state'),

  // PMC measurement
  pmcAvailability: () => ipcRenderer.invoke('pmc-availability'),
  pmcMeasure: (pid, durationSec) => ipcRenderer.invoke('pmc-measure', pid, durationSec),
  onPmcProgress: (callback) => {
    ipcRenderer.on('pmc-progress', (_event, msg) => callback(msg));
  },

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // Admin check
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
});
