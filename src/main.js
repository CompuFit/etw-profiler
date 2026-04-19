'use strict';

/* ------------------------------------------------------------------ */
/*  관리자 권한 자동 요청                                                */
/* ------------------------------------------------------------------ */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function isAdmin() {
  try {
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

if (!isAdmin() && !process.argv.includes('--no-elevate')) {
  // 관리자가 아님 → UAC로 재실행 요청 후 대기
  const exe = process.execPath;
  const appRoot = path.resolve(__dirname, '..');

  const scriptPath = path.join(os.tmpdir(), `elevate-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath,
    `Start-Process -FilePath '${exe}' -ArgumentList '${appRoot}','--no-elevate' -Verb RunAs\n` +
    `Remove-Item -Path '${scriptPath}' -Force -ErrorAction SilentlyContinue\n`,
  'utf8');

  // execSync로 UAC 팝업이 처리될 때까지 대기 후 종료
  try {
    execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      windowsHide: true, timeout: 30000,
    });
  } catch (_) {}

  process.exit(0);

} else {
  // 관리자 권한 확인됨 → 앱 실행
  startApp();
}

/* ------------------------------------------------------------------ */
/*  앱 초기화                                                          */
/* ------------------------------------------------------------------ */

function startApp() {
  const electronModule = require('electron');
  const app = electronModule.app;
  const BrowserWindow = electronModule.BrowserWindow;
  const ipcMain = electronModule.ipcMain;

  // 유틸리티 프로세스 가드
  if (!app || !app.whenReady) return;

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

    if (process.env.ETW_DEV === '1') {
      mainWindow.webContents.openDevTools();
    }
  }

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { app.quit(); });

  /* ---------------------------------------------------------------- */
  /*  IPC 핸들러                                                       */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('list-processes', async () => {
    try { return { ok: true, data: await processService.listProcesses() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

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

  ipcMain.handle('pmc-availability', async () => {
    try { return { ok: true, data: await pmcService.getAvailability() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('pmc-measure', async (_ev, opts, durationSec) => {
    try {
      const progress = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pmc-progress', msg);
        }
      };

      const cpuResult = await pmcService.startCollection(opts, durationSec, progress);

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

  ipcMain.handle('get-process-tree', async (_ev, pid) => {
    try {
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

  ipcMain.handle('get-system-info', async () => {
    try { return { ok: true, data: await systemInfo.get() }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('get-usage', async () => {
    try {
      const [usage, gpuSnap] = await Promise.all([
        systemInfo.getUsage(),
        Promise.resolve(gpuService.snapshot(null)),
      ]);
      const adapters = gpuService.getAdapters();
      const realAdapters = adapters.filter(a => !/virtual|mirror/i.test(a.name));
      const totalVram = realAdapters.reduce((sum, a) => sum + a.vramBytes, 0);
      return { ok: true, data: { ...usage, gpu: gpuSnap, totalVramBytes: totalVram } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('check-admin', () => {
    return { ok: true, data: { isAdmin: isAdmin() } };
  });
}
