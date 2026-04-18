'use strict';

/**
 * GPU 메트릭 수집 서비스
 *
 * Windows 빌트인 Performance Counter(Get-Counter)로 GPU 활용률/VRAM 수집.
 * 관리자 권한 불필요. Windows 10 1709+ 필요.
 */

const { execSync } = require('child_process');
const fs = require('fs');

/** GPU 어댑터 정보 조회 (이름, VRAM, 드라이버 버전) */
function getAdapters() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json"`,
      { timeout: 10000, windowsHide: true }
    ).toString().trim();
    const data = JSON.parse(out);
    const items = Array.isArray(data) ? data : [data];
    return items
      .filter(a => a.Name)
      .map(a => ({
        name: a.Name,
        vramBytes: a.AdapterRAM || 0,
        vramMB: a.AdapterRAM ? Math.round(a.AdapterRAM / (1024 * 1024)) : 0,
        driver: a.DriverVersion || '',
      }));
  } catch (_) {
    return [];
  }
}

/**
 * GPU 메트릭 스냅샷 (1초 샘플링).
 * 임시 PS1 스크립트 생성 → 실행 → JSON 파싱 → 삭제.
 *
 * @param {number|null} targetPid  PID 필터. null이면 전체
 * @returns {{ utilization, memory, perProcess }}
 */
function snapshot(targetPid = null) {
  const result = {
    adapters: [],
    utilization: { total3d: 0, totalCopy: 0, totalVideo: 0 },
    memory: { dedicatedBytes: 0, sharedBytes: 0 },
    perProcess: [],
    timestamp: new Date().toISOString(),
  };

  try {
    const os = require('os');
    const path = require('path');
    const scriptPath = path.join(os.tmpdir(), `gpu-snap-${Date.now()}.ps1`);

    // PowerShell 스크립트: GPU 엔진 활용률 + 어댑터 메모리 + 프로세스별 메모리 수집
    fs.writeFileSync(scriptPath, `
$ErrorActionPreference='SilentlyContinue'
$out = @{}
$eng = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 1 -MaxSamples 1).CounterSamples
$engData = @()
foreach($s in $eng) {
  if($s.CookedValue -gt 0) {
    $inst = $s.InstanceName
    $pidMatch = [regex]::Match($inst, 'pid_(\\d+)')
    $typeMatch = [regex]::Match($inst, 'engtype_(\\w+)')
    $engData += @{
      pid = if($pidMatch.Success){[int]$pidMatch.Groups[1].Value}else{0}
      engType = if($typeMatch.Success){$typeMatch.Groups[1].Value}else{'unknown'}
      value = [math]::Round($s.CookedValue, 2)
    }
  }
}
$out.engine = $engData
$amem = (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage' -SampleInterval 1 -MaxSamples 1).CounterSamples
$amemData = @()
foreach($s in $amem) {
  $luidMatch = [regex]::Match($s.InstanceName, 'luid_0x[0-9a-f]+_0x([0-9a-f]+)')
  $counterName = if($s.Path -match 'dedicated'){'dedicated'}else{'shared'}
  $amemData += @{
    luid = if($luidMatch.Success){$luidMatch.Groups[1].Value}else{''}
    type = $counterName
    bytes = [long]$s.CookedValue
  }
}
$out.adapterMemory = $amemData
$pmem = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Process Memory(*)\\Shared Usage' -SampleInterval 1 -MaxSamples 1).CounterSamples
$pmemData = @()
foreach($s in $pmem) {
  if($s.CookedValue -gt 0) {
    $pidMatch = [regex]::Match($s.InstanceName, 'pid_(\\d+)')
    $counterName = if($s.Path -match 'dedicated'){'dedicated'}else{'shared'}
    $pmemData += @{
      pid = if($pidMatch.Success){[int]$pidMatch.Groups[1].Value}else{0}
      type = $counterName
      bytes = [long]$s.CookedValue
    }
  }
}
$out.processMemory = $pmemData
$out | ConvertTo-Json -Depth 3 -Compress
`, 'utf8');

    const raw = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 }
    ).toString().trim();

    try { fs.unlinkSync(scriptPath); } catch (_) {}

    // PowerShell 경고 무시하고 JSON 파싱
    const jsonStart = raw.indexOf('{"');
    if (jsonStart < 0) return result;
    const data = JSON.parse(raw.substring(jsonStart));

    // 엔진 활용률 집계
    const pidUtil = new Map();
    if (data.engine) {
      for (const e of Array.isArray(data.engine) ? data.engine : [data.engine]) {
        if (targetPid && e.pid !== targetPid) continue;
        if (!pidUtil.has(e.pid)) pidUtil.set(e.pid, { '3d': 0, copy: 0, video: 0 });
        const entry = pidUtil.get(e.pid);
        if (e.engType === '3d') entry['3d'] += e.value;
        else if (e.engType === 'copy') entry.copy += e.value;
        else if (e.engType && e.engType.startsWith('video')) entry.video += e.value;
      }
    }
    for (const [, u] of pidUtil) {
      result.utilization.total3d += u['3d'];
      result.utilization.totalCopy += u.copy;
      result.utilization.totalVideo += u.video;
    }
    result.utilization.total3d = round(result.utilization.total3d, 2);
    result.utilization.totalCopy = round(result.utilization.totalCopy, 2);
    result.utilization.totalVideo = round(result.utilization.totalVideo, 2);

    // 어댑터 메모리 집계
    const adapterMem = new Map();
    if (data.adapterMemory) {
      for (const m of Array.isArray(data.adapterMemory) ? data.adapterMemory : [data.adapterMemory]) {
        if (!adapterMem.has(m.luid)) adapterMem.set(m.luid, { luid: m.luid, dedicated: 0, shared: 0 });
        adapterMem.get(m.luid)[m.type] = m.bytes;
      }
    }
    for (const [, a] of adapterMem) {
      result.memory.dedicatedBytes += a.dedicated;
      result.memory.sharedBytes += a.shared;
      result.adapters.push(a);
    }

    // 프로세스별 GPU 메모리 집계
    const pidMem = new Map();
    if (data.processMemory) {
      for (const m of Array.isArray(data.processMemory) ? data.processMemory : [data.processMemory]) {
        if (targetPid && m.pid !== targetPid) continue;
        if (!pidMem.has(m.pid)) pidMem.set(m.pid, { pid: m.pid, dedicated: 0, shared: 0 });
        pidMem.get(m.pid)[m.type] += m.bytes;
      }
    }
    result.perProcess = [...pidMem.values()].sort((a, b) => b.dedicated - a.dedicated);

  } catch (_) {}

  return result;
}

function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

module.exports = { getAdapters, snapshot };
