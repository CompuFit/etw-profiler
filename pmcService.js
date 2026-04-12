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
 * Start a PMC collection for the given PID.
 *
 * @param {number} pid
 * @param {number} durationSec  1–60
 * @param {function} onProgress
 * @returns {Promise<object>}   Enriched result with derived metrics
 */
async function startCollection(pid, durationSec, onProgress = () => {}) {
  if (currentSession) {
    throw new Error('이미 측정이 진행 중입니다.');
  }

  // Validate
  const avail = await getAvailability();
  if (!avail.available) {
    throw new Error(avail.reason);
  }

  durationSec = Math.max(1, Math.min(60, durationSec));

  currentSession = { pid, durationSec, startedAt: Date.now() };

  try {
    // Collect raw PMC data
    const raw = await etwCollector.collect(pid, durationSec, onProgress);

    // Get system info
    onProgress('시스템 정보 수집 중...');
    const sys = await systemInfo.get();

    // Compute derived metrics
    const derived = computeDerivedMetrics(raw.counters);

    return {
      pid,
      durationSec,
      raw: raw.counters,
      sampleCount: raw.sampleCount,
      totalSystemSamples: raw.totalSystemSamples,
      samplingInterval: raw.samplingInterval,
      derived,
      system: sys,
      collectedAt: new Date().toISOString(),
    };
  } finally {
    currentSession = null;
  }
}

/**
 * Compute IPC, LLC MPKI, bandwidth estimate, and branch misprediction rate.
 */
function computeDerivedMetrics(counters) {
  const inst = counters.InstructionRetired || 0;
  const cycles = counters.TotalCycles || 0;
  const llcMisses = counters.LLCMisses || 0;
  const brMisp = counters.BranchMispredictions || 0;
  const brInst = counters.BranchInstructions || 0;

  // IPC (Instructions Per Cycle)
  const ipc = cycles > 0 ? inst / cycles : 0;

  // LLC MPKI (Misses Per Kilo Instructions)
  const llcMpki = inst > 0 ? (llcMisses / inst) * 1000 : 0;

  // DRAM Bandwidth estimate (LLC misses × 64 bytes cache line)
  const dramBytes = llcMisses * 64;

  // Branch misprediction rate (%)
  const branchMispredRate = brInst > 0 ? (brMisp / brInst) * 100 : 0;

  return {
    ipc: round(ipc, 3),
    llcMpki: round(llcMpki, 3),
    dramBytes,
    dramMB: round(dramBytes / (1024 * 1024), 2),
    branchMispredRate: round(branchMispredRate, 2),
    instructions: inst,
    cycles,
    llcMisses,
    branchMispredictions: brMisp,
    branchInstructions: brInst,
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
