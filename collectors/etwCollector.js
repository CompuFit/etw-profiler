'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseEtlDetailed, extractTidPidMap } = require('./etlParser');

const COUNTER_NAMES = [
  'InstructionRetired',
  'TotalCycles',
  'LLCMisses',
  'BranchMispredictions',
  'BranchInstructions',
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
 * Each pass configures one counter as the profiling source.
 * Per-PID sample count × SAMPLING_INTERVAL = counter estimate.
 *
 * Note: Background system profiling adds noise. IPC ratio is reliable;
 * absolute counter values and cross-counter metrics (MPKI, branch rate)
 * are sampled estimates.
 */
async function collect(pid, durationSec, onProgress = () => {}) {
  const perPassSec = Math.max(2, Math.ceil(durationSec / COUNTER_NAMES.length));
  const tempDir = path.join(os.tmpdir(), `etw-pmc-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    onProgress('대상 프로세스 스레드 ID 수집 중...');
    const preTids = getThreadIds(pid);
    onProgress(`PID ${pid}: ${preTids.size}개 스레드`);

    if (preTids.size === 0) {
      throw new Error(`PID ${pid}의 스레드를 찾을 수 없습니다.`);
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
        onProgress(`  ⚠ ${name}: ETL 미생성`);
        continue;
      }

      // Build TID set from ETL + live
      const { tidToPid } = extractTidPidMap(etlPath);
      const allTids = new Set(preTids);
      for (const [tid, p] of tidToPid) {
        if (p === pid) allTids.add(tid);
      }
      const liveTids = getThreadIds(pid);
      for (const t of liveTids) allTids.add(t);

      const result = parseEtlDetailed(etlPath, allTids);

      counters[name] = result.pidSamples * SAMPLING_INTERVAL;
      totalPidSamples += result.pidSamples;
      totalSystemSamples += result.totalSamples;

      onProgress(`  ${name}: ${result.pidSamples} 샘플 (시스템: ${result.totalSamples})`);

      try { fs.unlinkSync(etlPath); } catch (_) {}
    }

    onProgress('수집 완료!');

    return {
      pid,
      sampleCount: totalPidSamples,
      totalSystemSamples,
      counters,
      samplingInterval: SAMPLING_INTERVAL,
      counterNames: COUNTER_NAMES,
      pmcValuesAvailable: true,
      perPassDuration: perPassSec,
    };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
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

module.exports = { checkAvailability, collect, COUNTER_NAMES, SAMPLING_INTERVAL };
