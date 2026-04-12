'use strict';

const { execSync } = require('child_process');
const os = require('os');

let cachedInfo = null;

/**
 * Get system CPU and memory information.
 * Results are cached after the first call.
 */
async function get() {
  if (cachedInfo) return cachedInfo;

  const cpu = getCpuInfo();
  const mem = getMemoryInfo();

  cachedInfo = { cpu, mem };
  return cachedInfo;
}

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

    const data = JSON.parse(ps);
    const item = Array.isArray(data) ? data[0] : data;
    if (item) {
      physicalCores = item.NumberOfCores || physicalCores;
      maxFreqMHz = item.MaxClockSpeed || maxFreqMHz;
      baseFreqMHz = item.CurrentClockSpeed || maxFreqMHz;
    }
  } catch (_) {}

  // Detect hybrid architecture (Intel 12th gen+)
  const isHybrid = model.toLowerCase().includes('12th gen') ||
                   model.toLowerCase().includes('13th gen') ||
                   model.toLowerCase().includes('14th gen') ||
                   model.toLowerCase().includes('core ultra');

  return {
    model,
    physicalCores,
    logicalCores,
    baseFreqMHz,
    maxFreqMHz,
    maxFreqGHz: +(maxFreqMHz / 1000).toFixed(2),
    isHybrid,
  };
}

function getMemoryInfo() {
  const totalBytes = os.totalmem();
  const totalGB = +(totalBytes / (1024 ** 3)).toFixed(1);

  let type = 'Unknown';
  let speedMHz = 0;
  let channels = 0;

  try {
    const ps = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_PhysicalMemory | Select-Object SMBIOSMemoryType,Speed,DeviceLocator | ConvertTo-Json"',
      { timeout: 10000, windowsHide: true }
    ).toString().trim();

    const data = JSON.parse(ps);
    const items = Array.isArray(data) ? data : [data];

    if (items.length > 0 && items[0]) {
      speedMHz = items[0].Speed || 0;
      channels = items.length;

      const smbiosType = items[0].SMBIOSMemoryType;
      type = smbiosTypeToString(smbiosType);
    }
  } catch (_) {}

  const typicalLatency = getTypicalLatency(type);

  return {
    totalGB,
    type,
    speedMHz,
    channels,
    typicalLatencyNs: typicalLatency,
  };
}

function smbiosTypeToString(code) {
  const map = {
    20: 'DDR',
    21: 'DDR2',
    22: 'DDR2 FB-DIMM',
    24: 'DDR3',
    26: 'DDR4',
    27: 'LPDDR',
    28: 'LPDDR2',
    29: 'LPDDR3',
    30: 'LPDDR4',
    34: 'DDR5',
    35: 'LPDDR5',
  };
  return map[code] || `Unknown (${code})`;
}

function getTypicalLatency(memType) {
  if (memType.includes('DDR5') || memType.includes('LPDDR5')) return '70-105 ns';
  if (memType.includes('DDR4') || memType.includes('LPDDR4')) return '65-100 ns';
  if (memType.includes('DDR3') || memType.includes('LPDDR3')) return '50-75 ns';
  return 'N/A';
}

/**
 * Clear cached info (useful for testing).
 */
function clearCache() {
  cachedInfo = null;
}

module.exports = { get, clearCache };
