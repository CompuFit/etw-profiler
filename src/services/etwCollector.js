'use strict';

/**
 * ETW PMC 수집기
 *
 * Windows 빌트인 wpr.exe를 사용하여 하드웨어 카운터를 수집합니다.
 * 카운터별 멀티패스 방식: 8개 카운터를 하나씩 프로파일링 소스로 설정하여 순차 수집.
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { parseEtlDetailed, extractTidPidMap } = require('./etlParser');

// 수집 대상 PMC 카운터 (8개)
const COUNTER_NAMES = [
  'InstructionRetired',        // 실행 완료 명령어 수
  'TotalCycles',               // CPU 클럭 사이클 수
  'LLCMisses',                 // LLC 미스 횟수
  'BranchMispredictions',      // 분기 예측 실패 횟수
  'BranchInstructions',        // 전체 분기 명령어 수
  'LLCReference',              // LLC 접근 횟수
  'TotalIssues',               // uOps dispatched
  'UnhaltedReferenceCycles',   // 기준 클럭 사이클
];

const SAMPLING_INTERVAL = 65536;   // PMC 샘플링 간격
const WPR_EXE = 'C:\\Windows\\System32\\wpr.exe';

/* ------------------------------------------------------------------ */
/*  공개 API                                                           */
/* ------------------------------------------------------------------ */

/** ETW PMC 프로파일링 가용성 확인 */
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
 * 8개 PMC 카운터 멀티패스 수집.
 *
 * @param {object} opts          { mode: 'pid'|'system'|'app', pid?, pids? }
 * @param {number} durationSec   총 측정 시간 (패스당 = durationSec / 8)
 * @param {function} onProgress  진행 상황 콜백
 */
async function collect(opts, durationSec, onProgress = () => {}) {
  const mode = opts.mode || 'pid';
  const perPassSec = Math.max(2, Math.ceil(durationSec / COUNTER_NAMES.length));
  const tempDir = path.join(os.tmpdir(), `etw-pmc-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const startTime = Date.now();

  try {
    // 모드별 대상 TID 세트 구성
    let targetTids = null;     // null = 시스템 전체
    let targetPids = [];
    let modeLabel = '';

    if (mode === 'system') {
      modeLabel = '시스템 전체';
      onProgress('시스템 전체 측정 모드');

    } else if (mode === 'app') {
      const rootPid = opts.pid;
      targetPids = opts.pids || getProcessTree(rootPid);
      modeLabel = `앱 (${targetPids.length}개 프로세스)`;
      onProgress(`앱 측정: PID ${rootPid} + 자식 ${targetPids.length}개`);

      targetTids = new Set();
      for (const p of targetPids) {
        for (const t of getThreadIds(p)) targetTids.add(t);
      }
      onProgress(`총 ${targetTids.size}개 스레드`);
      if (targetTids.size === 0) throw new Error('프로세스 트리의 스레드를 찾을 수 없습니다.');

    } else {
      // mode === 'pid'
      const pid = opts.pid;
      targetPids = [pid];
      modeLabel = `PID ${pid}`;
      onProgress('대상 프로세스 스레드 수집 중...');
      targetTids = getThreadIds(pid);
      onProgress(`PID ${pid}: ${targetTids.size}개 스레드`);
      if (targetTids.size === 0) throw new Error(`PID ${pid}의 스레드를 찾을 수 없습니다.`);
    }

    // 카운터별 멀티패스 수집
    const counters = {};
    COUNTER_NAMES.forEach(n => { counters[n] = 0; });
    let totalPidSamples = 0;
    let totalSystemSamples = 0;

    for (let i = 0; i < COUNTER_NAMES.length; i++) {
      const name = COUNTER_NAMES[i];
      const etlPath = path.join(tempDir, `p${i}.etl`);
      const wprpPath = path.join(tempDir, `p${i}.wprp`);

      onProgress(`[${i + 1}/${COUNTER_NAMES.length}] ${name} (${perPassSec}초)...`);

      // .wprp 생성 → WPR 시작 → 대기 → WPR 중지
      writeSingleCounterWprp(wprpPath, name);
      await cancelSession();
      await runCmd(WPR_EXE, ['-start', `${wprpPath}!PMC`, '-filemode'], 30000);
      for (let t = 0; t < perPassSec; t++) await sleep(1000);
      await runCmd(WPR_EXE, ['-stop', etlPath, '-skipPdbGen'], 120000);

      if (!fs.existsSync(etlPath)) {
        onProgress(`  ${name}: ETL 미생성`);
        continue;
      }

      // TID 새로고침 (ETL 내 매핑 + 라이브)
      let parseTids = targetTids;
      if (mode !== 'system' && targetTids) {
        const { tidToPid } = extractTidPidMap(etlPath);
        parseTids = new Set(targetTids);
        for (const [tid, p] of tidToPid) {
          if (targetPids.includes(p)) parseTids.add(tid);
        }
        for (const p of targetPids) {
          for (const t of getThreadIds(p)) parseTids.add(t);
        }
      }

      // ETL 바이너리 파싱
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
      mode, modeLabel,
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

/* ------------------------------------------------------------------ */
/*  내부 함수                                                          */
/* ------------------------------------------------------------------ */

/** 프로세스 트리 조회 (부모 PID + 모든 자식 재귀) */
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

/** 단일 카운터용 .wprp 프로파일 생성 */
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

/** 프로세스의 스레드 ID 목록 조회 */
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

/** 기존 WPR 세션 취소 */
async function cancelSession() {
  try { await runCmd(WPR_EXE, ['-cancel'], 10000); } catch (_) {}
}

/** 외부 명령 실행 (Promise) */
function runCmd(exe, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('시간 초과')); }, timeoutMs);
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

/** WPR 오류 메시지 한글 번역 */
function translateError(msg, code) {
  const l = msg.toLowerCase();
  if (l.includes('0xc5585011') || l.includes('policy') || (l.includes('access') && l.includes('denied')))
    return '관리자 권한이 필요합니다.';
  if (l.includes('another session') || l.includes('already running'))
    return '다른 WPR 세션이 실행 중입니다.';
  return `WPR 오류 (code=${code}): ${msg.substring(0, 200)}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

module.exports = { checkAvailability, collect, COUNTER_NAMES, SAMPLING_INTERVAL };
