'use strict';

/**
 * CPU PMC 측정 서비스
 *
 * etwCollector로 Raw 카운터를 수집한 뒤 유도 지표(IPC, MPKI 등)를 계산합니다.
 */

const etwCollector = require('./etwCollector');
const systemInfo = require('./systemInfo');

let currentSession = null;

/** ETW PMC 가용성 확인 */
async function getAvailability() {
  return etwCollector.checkAvailability();
}

/** 현재 측정 진행 중 여부 */
function isBusy() {
  return currentSession !== null;
}

/**
 * 측정 시작 (CPU PMC).
 *
 * @param {object} opts          { mode: 'pid'|'system'|'app', pid? }
 * @param {number} durationSec   1~60초
 * @param {function} onProgress  진행 콜백
 * @returns {Promise<object>}    Raw + 유도 지표 포함 결과
 */
async function startCollection(opts, durationSec, onProgress = () => {}) {
  if (currentSession) throw new Error('이미 측정이 진행 중입니다.');

  // 하위 호환: 숫자가 오면 PID로 처리
  if (typeof opts === 'number') opts = { mode: 'pid', pid: opts };

  const avail = await getAvailability();
  if (!avail.available) throw new Error(avail.reason);

  durationSec = Math.max(1, Math.min(60, durationSec));
  currentSession = { opts, durationSec, startedAt: Date.now() };

  try {
    const raw = await etwCollector.collect(opts, durationSec, onProgress);

    onProgress('시스템 정보 수집 중...');
    const sys = await systemInfo.get();
    const derived = computeDerivedMetrics(raw.counters, sys);

    return {
      mode: raw.mode,
      modeLabel: raw.modeLabel,
      pid: raw.pid,
      pids: raw.pids,
      durationSec,
      raw: raw.counters,
      sampleCount: raw.sampleCount,
      totalSystemSamples: raw.totalSystemSamples,
      samplingInterval: raw.samplingInterval,
      derived,
      system: sys,
      elapsedSec: raw.elapsedSec,
      collectedAt: new Date().toISOString(),
    };
  } finally {
    currentSession = null;
  }
}

/**
 * 유도 지표 계산.
 * Raw 카운터 8개에서 분석 지표 10개를 산출합니다.
 */
function computeDerivedMetrics(counters, sys) {
  const inst = counters.InstructionRetired || 0;
  const cycles = counters.TotalCycles || 0;
  const llcMisses = counters.LLCMisses || 0;
  const llcRefs = counters.LLCReference || 0;
  const brMisp = counters.BranchMispredictions || 0;
  const brInst = counters.BranchInstructions || 0;
  const uops = counters.TotalIssues || 0;
  const refCycles = counters.UnhaltedReferenceCycles || 0;

  // IPC (사이클당 명령어)
  const ipc = cycles > 0 ? inst / cycles : 0;

  // L3 MPKI (1000 명령어당 LLC 미스)
  const l3Mpki = inst > 0 ? (llcMisses / inst) * 1000 : 0;

  // Branch MPKI (1000 명령어당 분기 실패)
  const branchMpki = inst > 0 ? (brMisp / inst) * 1000 : 0;

  // 분기 예측 실패율 (%)
  const branchMispredRate = brInst > 0 ? (brMisp / brInst) * 100 : 0;

  // DRAM 접근 ≈ LLC 미스
  const dramAccesses = llcMisses;
  const dramBytes = llcMisses * 64;   // 캐시라인 64바이트

  // LLC 적중률 (%)
  const llcHitRate = llcRefs > 0 ? ((llcRefs - llcMisses) / llcRefs) * 100 : 0;

  // LLC 참조 MPKI
  const llcRefMpki = inst > 0 ? (llcRefs / inst) * 1000 : 0;

  // 명령어당 uOps (마이크로 오퍼레이션)
  const uopsPerInst = inst > 0 ? uops / inst : 0;

  // 실효 CPU 주파수 추정 (터보/스로틀링 감지)
  const freqRatio = refCycles > 0 ? cycles / refCycles : 0;
  const baseFreqGHz = sys && sys.cpu ? sys.cpu.maxFreqGHz : 0;
  const effectiveFreqGHz = baseFreqGHz > 0 ? round(freqRatio * baseFreqGHz, 2) : 0;

  return {
    ipc: round(ipc, 3),
    l3Mpki: round(l3Mpki, 2),
    branchMpki: round(branchMpki, 2),
    branchMispredRate: round(branchMispredRate, 2),
    dramAccesses,
    dramBytes,
    dramMB: round(dramBytes / (1024 * 1024), 2),
    dramGiB: round(dramBytes / (1024 * 1024 * 1024), 2),
    llcHitRate: round(llcHitRate, 2),
    llcRefMpki: round(llcRefMpki, 2),
    uopsPerInst: round(uopsPerInst, 2),
    freqRatio: round(freqRatio, 3),
    effectiveFreqGHz,
    instructions: inst, cycles, llcMisses, llcReferences: llcRefs,
    branchMispredictions: brMisp, branchInstructions: brInst,
    totalIssues: uops, referenceCycles: refCycles,
  };
}

function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

module.exports = { getAvailability, isBusy, startCollection, computeDerivedMetrics };
