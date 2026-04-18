'use strict';

/**
 * 시스템 정보 + 실시간 사용률 서비스
 *
 * CPU/메모리 하드웨어 정보 조회 (캐싱) 및
 * 작업 관리자 스타일 실시간 점유율 측정.
 */

const { execSync } = require('child_process');
const os = require('os');

let cachedInfo = null;

/** 시스템 하드웨어 정보 (첫 호출 후 캐싱) */
async function get() {
  if (cachedInfo) return cachedInfo;
  cachedInfo = { cpu: getCpuInfo(), mem: getMemoryInfo() };
  return cachedInfo;
}

/** CPU 정보 조회 */
function getCpuInfo() {
  const cpus = os.cpus();
  const model = cpus.length > 0 ? cpus[0].model : 'Unknown';
  const logicalCores = cpus.length;

  let physicalCores = logicalCores;
  let maxFreqMHz = cpus.length > 0 ? cpus[0].speed : 0;
  let baseFreqMHz = maxFreqMHz;

  try {
    const ps = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object NumberOfCores,MaxClockSpeed,CurrentClockSpeed | ConvertTo-Json"',
      { timeout: 10000, windowsHide: true }
    ).toString().trim();
    const item = Array.isArray(JSON.parse(ps)) ? JSON.parse(ps)[0] : JSON.parse(ps);
    if (item) {
      physicalCores = item.NumberOfCores || physicalCores;
      maxFreqMHz = item.MaxClockSpeed || maxFreqMHz;
      baseFreqMHz = item.CurrentClockSpeed || maxFreqMHz;
    }
  } catch (_) {}

  // 하이브리드 아키텍처 감지 (Intel 12세대+)
  const isHybrid = /12th gen|13th gen|14th gen|core ultra/i.test(model);

  return {
    model, physicalCores, logicalCores, baseFreqMHz, maxFreqMHz,
    maxFreqGHz: +(maxFreqMHz / 1000).toFixed(2),
    isHybrid,
  };
}

/** 메모리 정보 조회 */
function getMemoryInfo() {
  const totalBytes = os.totalmem();
  const totalGB = +(totalBytes / (1024 ** 3)).toFixed(1);

  let type = 'Unknown', speedMHz = 0, channels = 0;

  try {
    const ps = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_PhysicalMemory | Select-Object SMBIOSMemoryType,Speed,DeviceLocator | ConvertTo-Json"',
      { timeout: 10000, windowsHide: true }
    ).toString().trim();
    const items = Array.isArray(JSON.parse(ps)) ? JSON.parse(ps) : [JSON.parse(ps)];
    if (items[0]) {
      speedMHz = items[0].Speed || 0;
      channels = items.length;
      type = smbiosTypeToString(items[0].SMBIOSMemoryType);
    }
  } catch (_) {}

  return { totalGB, type, speedMHz, channels, typicalLatencyNs: getTypicalLatency(type) };
}

function smbiosTypeToString(code) {
  const map = { 20:'DDR', 21:'DDR2', 24:'DDR3', 26:'DDR4', 30:'LPDDR4', 34:'DDR5', 35:'LPDDR5' };
  return map[code] || `Unknown (${code})`;
}

function getTypicalLatency(t) {
  if (/DDR5|LPDDR5/i.test(t)) return '70-105 ns';
  if (/DDR4|LPDDR4/i.test(t)) return '65-100 ns';
  if (/DDR3/i.test(t)) return '50-75 ns';
  return 'N/A';
}

/**
 * 실시간 사용률 (작업 관리자 스타일).
 * CPU는 1초 간격 두 스냅샷 비교, RAM은 즉시.
 */
function getUsage() {
  return new Promise((resolve) => {
    const snap1 = os.cpus();
    setTimeout(() => {
      const snap2 = os.cpus();

      // CPU 사용률 (코어별 + 전체)
      let totalIdle = 0, totalTick = 0;
      const perCore = [];
      for (let i = 0; i < snap2.length; i++) {
        const t1 = snap1[i].times, t2 = snap2[i].times;
        const idle = t2.idle - t1.idle;
        const total = (t2.user - t1.user) + (t2.nice - t1.nice) +
                      (t2.sys - t1.sys) + (t2.irq - t1.irq) + idle;
        totalIdle += idle;
        totalTick += total;
        perCore.push(total > 0 ? round((1 - idle / total) * 100, 1) : 0);
      }

      // RAM 사용률
      const totalMem = os.totalmem();
      const usedMem = totalMem - os.freemem();

      resolve({
        cpu: {
          percent: totalTick > 0 ? round((1 - totalIdle / totalTick) * 100, 1) : 0,
          perCore,
          logicalCores: snap2.length,
        },
        ram: {
          percent: round((usedMem / totalMem) * 100, 1),
          totalBytes: totalMem,
          usedBytes: usedMem,
          freeBytes: totalMem - usedMem,
          totalGB: round(totalMem / (1024 ** 3), 1),
          usedGB: round(usedMem / (1024 ** 3), 1),
        },
      });
    }, 1000);
  });
}

function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }
function clearCache() { cachedInfo = null; }

module.exports = { get, getUsage, clearCache };
