'use strict';

const etwCollector = require('./collectors/etwCollector');
const systemInfo = require('./systemInfo');

let currentSession = null;

/**
 * Check if ETW PMC profiling is available.
 */
async function getAvailability() {
  return etwCollector.checkAvailability();
}

/**
 * Whether a collection is currently in progress.
 */
function isBusy() {
  return currentSession !== null;
}

/**
 * Start a PMC collection.
 *
 * @param {object} opts
 * @param {string} opts.mode   'pid' | 'system' | 'app'
 * @param {number} [opts.pid]  Target PID (required for pid/app modes)
 * @param {number} durationSec  1–60
 * @param {function} onProgress
 * @returns {Promise<object>}   Enriched result with derived metrics
 */
async function startCollection(opts, durationSec, onProgress = () => {}) {
  if (currentSession) {
    throw new Error('이미 측정이 진행 중입니다.');
  }

  // Backwards compat: if opts is a number, treat as PID
  if (typeof opts === 'number') {
    opts = { mode: 'pid', pid: opts };
  }

  const avail = await getAvailability();
  if (!avail.available) {
    throw new Error(avail.reason);
  }

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
 * Compute IPC, LLC MPKI, bandwidth estimate, and branch misprediction rate.
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

  // === MVP Metrics ===

  // IPC (Instructions Per Cycle)
  const ipc = cycles > 0 ? inst / cycles : 0;

  // L3 MPKI (LLC Misses Per Kilo Instructions)
  const l3Mpki = inst > 0 ? (llcMisses / inst) * 1000 : 0;

  // Branch MPKI (Branch Mispredictions Per Kilo Instructions)
  const branchMpki = inst > 0 ? (brMisp / inst) * 1000 : 0;

  // Branch misprediction rate (%)
  const branchMispredRate = brInst > 0 ? (brMisp / brInst) * 100 : 0;

  // DRAM accesses ≈ LLC misses
  const dramAccesses = llcMisses;

  // DRAM bytes ≈ LLC misses × 64 bytes cache line
  const dramBytes = llcMisses * 64;

  // === v1.1 Metrics ===

  // LLC Hit Rate (%)
  const llcHitRate = llcRefs > 0 ? ((llcRefs - llcMisses) / llcRefs) * 100 : 0;

  // LLC MPKI (references, not just misses)
  const llcRefMpki = inst > 0 ? (llcRefs / inst) * 1000 : 0;

  // uOps per Instruction (근사 — TotalIssues ≈ uops dispatched)
  const uopsPerInst = inst > 0 ? uops / inst : 0;

  // Effective CPU Frequency estimate
  // ratio = core_cycles / ref_cycles; if >1 → turbo, if <1 → throttled
  const freqRatio = refCycles > 0 ? cycles / refCycles : 0;
  const baseFreqGHz = sys && sys.cpu ? sys.cpu.maxFreqGHz : 0;
  const effectiveFreqGHz = baseFreqGHz > 0 ? round(freqRatio * baseFreqGHz, 2) : 0;

  return {
    // MVP
    ipc: round(ipc, 3),
    l3Mpki: round(l3Mpki, 2),
    branchMpki: round(branchMpki, 2),
    branchMispredRate: round(branchMispredRate, 2),
    dramAccesses,
    dramBytes,
    dramMB: round(dramBytes / (1024 * 1024), 2),
    dramGiB: round(dramBytes / (1024 * 1024 * 1024), 2),
    // v1.1
    llcHitRate: round(llcHitRate, 2),
    llcRefMpki: round(llcRefMpki, 2),
    uopsPerInst: round(uopsPerInst, 2),
    freqRatio: round(freqRatio, 3),
    effectiveFreqGHz,
    // Raw values
    instructions: inst,
    cycles,
    llcMisses,
    llcReferences: llcRefs,
    branchMispredictions: brMisp,
    branchInstructions: brInst,
    totalIssues: uops,
    referenceCycles: refCycles,
  };
}

function round(val, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

module.exports = {
  getAvailability,
  isBusy,
  startCollection,
  computeDerivedMetrics,
};
