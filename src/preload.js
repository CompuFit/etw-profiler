'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 프로세스
  listProcesses: () => ipcRenderer.invoke('list-processes'),
  startTracking: (pid, name) => ipcRenderer.invoke('start-tracking', pid, name),
  stopTracking: () => ipcRenderer.invoke('stop-tracking'),
  getTrackingState: () => ipcRenderer.invoke('get-tracking-state'),

  // 측정 (CPU + GPU 통합)
  pmcAvailability: () => ipcRenderer.invoke('pmc-availability'),
  pmcMeasure: (opts, durationSec) => ipcRenderer.invoke('pmc-measure', opts, durationSec),
  onPmcProgress: (cb) => ipcRenderer.on('pmc-progress', (_ev, msg) => cb(msg)),

  // 프로세스 트리
  getProcessTree: (pid) => ipcRenderer.invoke('get-process-tree', pid),

  // 시스템 정보 + 현황
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getUsage: () => ipcRenderer.invoke('get-usage'),

  // 관리자 확인
  checkAdmin: () => ipcRenderer.invoke('check-admin'),
});
