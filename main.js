'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const processService = require('./processService');
const pmcService = require('./pmcService');
const systemInfo = require('./systemInfo');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'ETW PMC Profiler',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1e1e1e',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open DevTools in dev (set ENV ETW_DEV=1)
  if (process.env.ETW_DEV === '1') {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

/* ------------------------------------------------------------------ */
/*  IPC Handlers                                                       */
/* ------------------------------------------------------------------ */

// Process list
ipcMain.handle('list-processes', async () => {
  try {
    const list = await processService.listProcesses();
    return { ok: true, data: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Tracking
ipcMain.handle('start-tracking', (_event, pid, name) => {
  try {
    const state = processService.startTracking(pid, name);
    return { ok: true, data: state };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop-tracking', () => {
  try {
    const state = processService.stopTracking();
    return { ok: true, data: state };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-tracking-state', () => {
  return { ok: true, data: processService.getTrackingState() };
});

// PMC availability check
ipcMain.handle('pmc-availability', async () => {
  try {
    const result = await pmcService.getAvailability();
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// PMC measurement
ipcMain.handle('pmc-measure', async (event, pid, durationSec) => {
  try {
    const result = await pmcService.startCollection(pid, durationSec, (msg) => {
      // Send progress to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pmc-progress', msg);
      }
    });
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// System info
ipcMain.handle('get-system-info', async () => {
  try {
    const info = await systemInfo.get();
    return { ok: true, data: info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Check admin
ipcMain.handle('check-admin', () => {
  try {
    const isAdmin = checkIsAdmin();
    return { ok: true, data: { isAdmin } };
  } catch (e) {
    return { ok: true, data: { isAdmin: false } };
  }
});

function checkIsAdmin() {
  try {
    const { execSync } = require('child_process');
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
