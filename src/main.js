'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const processService = require('./services/processService');
const pmcService = require('./services/pmcService');
const gpuService = require('./services/gpuService');
const systemInfo = require('./services/systemInfo');

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

  // 개발 모드: ETW_DEV=1 환경변수 설정 시 DevTools 자동 열기
  if (process.env.ETW_DEV === '1') {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { app.quit(); });

/* ------------------------------------------------------------------ */
/*  IPC 핸들러                                                         */
/* ------------------------------------------------------------------ */

// 프로세스 목록
ipcMain.handle('list-processes', async () => {
  try {
    return { ok: true, data: await processService.listProcesses() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 프로세스 추적
ipcMain.handle('start-tracking', (_ev, pid, name) => {
  try { return { ok: true, data: processService.startTracking(pid, name) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('stop-tracking', () => {
  try { return { ok: true, data: processService.stopTracking() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('get-tracking-state', () => {
  return { ok: true, data: processService.getTrackingState() };
});

// PMC 가용성 확인
ipcMain.handle('pmc-availability', async () => {
  try { return { ok: true, data: await pmcService.getAvailability() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 통합 측정 — CPU PMC + GPU 한 번에
ipcMain.handle('pmc-measure', async (_ev, opts, durationSec) => {
  try {
    const progress = (msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pmc-progress', msg);
      }
    };

    // CPU PMC 수집
    const cpuResult = await pmcService.startCollection(opts, durationSec, progress);

    // GPU 수집 (CPU 수집 직후, 같은 PID/모드)
    progress('GPU 메트릭 수집 중...');
    const targetPid = opts.mode === 'system' ? null : (opts.pid || null);
    const gpuSnap = gpuService.snapshot(targetPid);
    const gpuAdapters = gpuService.getAdapters();
    progress('GPU 수집 완료');

    return {
      ok: true,
      data: {
        ...cpuResult,
        gpu: {
          utilization: gpuSnap.utilization,
          memory: gpuSnap.memory,
          perProcess: gpuSnap.perProcess,
          adapters: gpuAdapters,
        },
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 프로세스 트리 (부모 + 모든 자식)
ipcMain.handle('get-process-tree', async (_ev, pid) => {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      `powershell -NoProfile -Command "function Get-Tree($id){$id;Get-CimInstance Win32_Process|Where-Object{$_.ParentProcessId -eq $id}|ForEach-Object{Get-Tree $_.ProcessId}};Get-Tree ${pid}"`,
      { timeout: 10000, windowsHide: true }
    ).toString().trim();
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const p = parseInt(line.trim(), 10);
      if (!isNaN(p) && p > 0) pids.push(p);
    }
    return { ok: true, data: pids.length > 0 ? pids : [pid] };
  } catch (_) {
    return { ok: true, data: [pid] };
  }
});

// 시스템 정보
ipcMain.handle('get-system-info', async () => {
  try { return { ok: true, data: await systemInfo.get() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 시스템 현황 (작업 관리자 스타일 점유율)
ipcMain.handle('get-usage', async () => {
  try {
    const [usage, gpuSnap] = await Promise.all([
      systemInfo.getUsage(),
      Promise.resolve(gpuService.snapshot(null)),
    ]);
    const adapters = gpuService.getAdapters();
    // 가상 모니터 제외하고 실제 GPU만 VRAM 합산
    const realAdapters = adapters.filter(a => !/virtual|mirror/i.test(a.name));
    const totalVram = realAdapters.reduce((sum, a) => sum + a.vramBytes, 0);
    return { ok: true, data: { ...usage, gpu: gpuSnap, totalVramBytes: totalVram } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 관리자 권한 확인
ipcMain.handle('check-admin', () => {
  try {
    const { execSync } = require('child_process');
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return { ok: true, data: { isAdmin: true } };
  } catch {
    return { ok: true, data: { isAdmin: false } };
  }
});
