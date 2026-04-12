'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseEtlDetailed, extractTidPidMap } = require('./etlParser');

const COUNTER_NAMES = [
  // MVP (5)
  'InstructionRetired',
  'TotalCycles',
  'LLCMisses',
  'BranchMispredictions',
  'BranchInstructions',
  // v1.1 (3) — ETW에서 추가로 사용 가능한 카운터
  'LLCReference',            // LLC 접근 횟수 → Hit Rate 유도
  'TotalIssues',             // uops dispatched (uops retired 근사치)
  'UnhaltedReferenceCycles', // 기준 사이클 → 실효 주파수 추정
];

const SAMPLING_INTERVAL = 65536;
const WPR_EXE = 'C:\\Windows\\System32\\wpr.exe';

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

async function checkAvailability() {
  if (!fs.existsSync(WPR_EXE)) {
    return { available: false, reason: 'wpr.exe를 찾을 수 없습니다.' };
  }
  try {
    const out = await runCmd(WPR_EXE, ['-pmcsources']);
    if (!out.includes('InstructionRetired')) {
      return { available: false, reason: 'PMC 카운터가 이 시스템에서 지원되지 않습니다.' };
    }
  } catch (e) {
    return { available: false, reason: `PMC 소스 확인 실패: ${e.message}` };
  }
  return { available: true, reason: 'ETW PMC 프로파일링 사용 가능' };
}

/**
 * Collect all 5 PMC counters via multi-pass approach.
 *
 * @param {object} opts
 * @param {string} opts.mode  'pid' | 'system' | 'app'
 * @param {number} [opts.pid] Target PID (required for 'pid' and 'app' modes)
 * @param {number[]} [opts.pids] All PIDs to include (for 'app' mode, auto-resolved if omitted)
 * @param {number} durationSec
 * @param {function} onProgress
 */
async function collect(opts, durationSec, onProgress = () => {}) {
  const mode = opts.mode || 'pid';
  const perPassSec = Math.max(2, Math.ceil(durationSec / COUNTER_NAMES.length));
  const tempDir = path.join(os.tmpdir(), `etw-pmc-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const startTime = Date.now();

  try {
    // Build target TID set based on mode
    let targetTids = null; // null = system-wide
    let targetPids = [];
    let modeLabel = '';

    if (mode === 'system') {
      modeLabel = '시스템 전체';
      onProgress('시스템 전체 측정 모드');
      // targetTids stays null → parseEtlDetailed counts all samples

    } else if (mode === 'app') {
      const rootPid = opts.pid;
      targetPids = opts.pids || getProcessTree(rootPid);
      modeLabel = `앱 (${targetPids.length}개 프로세스)`;
      onProgress(`앱 측정: PID ${rootPid} + 자식 프로세스 ${targetPids.length}개`);

      targetTids = new Set();
      for (const p of targetPids) {
        for (const t of getThreadIds(p)) targetTids.add(t);
      }
      onProgress(`총 ${targetTids.size}개 스레드`);

      if (targetTids.size === 0) {
        throw new Error('대상 프로세스 트리의 스레드를 찾을 수 없습니다.');
      }

    } else {
      // mode === 'pid'
      const pid = opts.pid;
      targetPids = [pid];
      modeLabel = `PID ${pid}`;
      onProgress('대상 프로세스 스레드 ID 수집 중...');
      targetTids = getThreadIds(pid);
      onProgress(`PID ${pid}: ${targetTids.size}개 스레드`);

      if (targetTids.size === 0) {
        throw new Error(`PID ${pid}의 스레드를 찾을 수 없습니다.`);
      }
    }

    const counters = {};
    COUNTER_NAMES.forEach(n => { counters[n] = 0; });
    let totalPidSamples = 0;
    let totalSystemSamples = 0;

    for (let i = 0; i < COUNTER_NAMES.length; i++) {
      const name = COUNTER_NAMES[i];
      const etlPath = path.join(tempDir, `p${i}.etl`);
      const wprpPath = path.join(tempDir, `p${i}.wprp`);

      onProgress(`[${i + 1}/${COUNTER_NAMES.length}] ${name} (${perPassSec}초)...`);

      writeSingleCounterWprp(wprpPath, name);
      await cancelSession();
      await runCmd(WPR_EXE, ['-start', `${wprpPath}!PMC`, '-filemode'], 30000);

      for (let t = 0; t < perPassSec; t++) {
        await sleep(1000);
      }

      await runCmd(WPR_EXE, ['-stop', etlPath, '-skipPdbGen'], 120000);

      if (!fs.existsSync(etlPath)) {
        onProgress(`  ${name}: ETL 미생성`);
        continue;
      }

      // For pid/app modes: refresh TIDs from ETL + live processes
      let parseTids = targetTids;
      if (mode !== 'system' && targetTids) {
        const { tidToPid } = extractTidPidMap(etlPath);
        parseTids = new Set(targetTids);
        for (const [tid, p] of tidToPid) {
          if (targetPids.includes(p)) parseTids.add(tid);
        }
        // Refresh live TIDs
        for (const p of targetPids) {
          for (const t of getThreadIds(p)) parseTids.add(t);
        }
      }

      const result = parseEtlDetailed(etlPath, parseTids);

      counters[name] = result.pidSamples * SAMPLING_INTERVAL;
      totalPidSamples += result.pidSamples;
      totalSystemSamples += result.totalSamples;

      onProgress(`  ${name}: ${result.pidSamples} 샘플 (시스템: ${result.totalSamples})`);

      try { fs.unlinkSync(etlPath); } catch (_) {}
    }

    const elapsedSec = round((Date.now() - startTime) / 1000, 2);
    onProgress(`수집 완료! (${elapsedSec}초 소요)`);

    return {
      mode,
      modeLabel,
      pid: opts.pid || null,
      pids: targetPids,
      sampleCount: totalPidSamples,
      totalSystemSamples,
      counters,
      samplingInterval: SAMPLING_INTERVAL,
      counterNames: COUNTER_NAMES,
      pmcValuesAvailable: true,
      perPassDuration: perPassSec,
      elapsedSec,
    };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Get all PIDs in a process tree (the root PID + all descendants).
 */
function getProcessTree(rootPid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "function Get-Tree($id){$id;Get-CimInstance Win32_Process|Where-Object{$_.ParentProcessId -eq $id}|ForEach-Object{Get-Tree $_.ProcessId}};Get-Tree ${rootPid}"`,
      { timeout: 10000, windowsHide: true }
    ).toString().trim();
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (!isNaN(pid) && pid > 0) pids.push(pid);
    }
    return pids.length > 0 ? pids : [rootPid];
  } catch (_) {
    return [rootPid];
  }
}

function writeSingleCounterWprp(filePath, counterName) {
  fs.writeFileSync(filePath, `<?xml version="1.0" encoding="utf-8"?>
<WindowsPerformanceRecorder Version="1.0">
  <Profiles>
    <SystemCollector Id="SC" Name="NT Kernel Logger">
      <BufferSize Value="1024"/>
      <Buffers Value="32"/>
    </SystemCollector>
    <SystemProvider Id="SP">
      <Keywords>
        <Keyword Value="SampledProfile"/>
        <Keyword Value="ProcessThread"/>
      </Keywords>
    </SystemProvider>
    <HardwareCounter Id="HC">
      <Counters>
        <Counter Value="${counterName}"/>
      </Counters>
    </HardwareCounter>
    <Profile Id="PMC.Verbose.File" Name="PMC" Description="${counterName}" DetailLevel="Verbose" LoggingMode="File">
      <ProblemCategories><ProblemCategory Value="First Level Triage"/></ProblemCategories>
      <Collectors>
        <SystemCollectorId Value="SC">
          <SystemProviderId Value="SP"/>
          <HardwareCounterId Value="HC"/>
        </SystemCollectorId>
      </Collectors>
    </Profile>
  </Profiles>
</WindowsPerformanceRecorder>`, 'utf8');
}

function getThreadIds(pid) {
  const tids = new Set();
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid}).Threads | ForEach-Object { $_.Id }"`,
      { timeout: 5000, windowsHide: true }
    ).toString().trim();
    for (const line of out.split(/\r?\n/)) {
      const tid = parseInt(line.trim(), 10);
      if (!isNaN(tid) && tid > 0) tids.add(tid);
    }
  } catch (_) {}
  return tids;
}

async function cancelSession() {
  try { await runCmd(WPR_EXE, ['-cancel'], 10000); } catch (_) {}
}

function runCmd(exe, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`시간 초과`)); }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(translateError(stderr || stdout, code)));
      else resolve(stdout);
    });
  });
}

function translateError(msg, code) {
  const l = msg.toLowerCase();
  if (l.includes('0xc5585011') || l.includes('policy') || (l.includes('access') && l.includes('denied')))
    return '관리자 권한이 필요합니다.';
  if (l.includes('another session') || l.includes('already running'))
    return '다른 WPR 세션이 실행 중입니다.';
  return `WPR 오류 (code=${code}): ${msg.substring(0, 200)}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function round(val, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

module.exports = { checkAvailability, collect, COUNTER_NAMES, SAMPLING_INTERVAL };
