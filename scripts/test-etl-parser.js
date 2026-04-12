'use strict';

const { parseEtl, extractTidPidMap } = require('../collectors/etlParser');
const fs = require('fs');

const etlPath = process.argv[2] || 'C:/Users/khs81/AppData/Local/Temp/etw-diag-1775971130019/diag.etl';

if (!fs.existsSync(etlPath)) {
  console.error(`ETL file not found: ${etlPath}`);
  process.exit(1);
}

console.log(`ETL file: ${etlPath} (${(fs.statSync(etlPath).size / 1024 / 1024).toFixed(1)} MB)\n`);

// Step 1: Extract TID→PID mapping
console.log('Extracting TID→PID mapping...');
const t0 = Date.now();
const { tidToPid, sampledTids } = extractTidPidMap(etlPath);
console.log(`  TID→PID entries: ${tidToPid.size}`);
console.log(`  Unique sampled TIDs: ${sampledTids.size}`);
console.log(`  Time: ${Date.now() - t0}ms\n`);

// Show some TID→PID mappings
const pidToTids = new Map();
for (const [tid, pid] of tidToPid) {
  if (!pidToTids.has(pid)) pidToTids.set(pid, new Set());
  pidToTids.get(pid).add(tid);
}
console.log(`Unique PIDs found: ${pidToTids.size}`);

// Find PIDs with sampled TIDs
const pidsWithSamples = new Map();
for (const tid of sampledTids) {
  const pid = tidToPid.get(tid);
  if (pid !== undefined) {
    pidsWithSamples.set(pid, (pidsWithSamples.get(pid) || 0) + 1);
  }
}

console.log('\nPIDs with SampledProfile events (top 10):');
const sorted = [...pidsWithSamples.entries()].sort((a, b) => b[1] - a[1]);
for (const [pid, count] of sorted.slice(0, 10)) {
  const tids = pidToTids.get(pid);
  console.log(`  PID ${pid}: ${count} sampled TIDs, ${tids ? tids.size : '?'} total TIDs`);
}

// Step 2: Parse samples for each top PID
console.log('\n--- Parsing samples for top PIDs ---');
for (const [pid, _] of sorted.slice(0, 5)) {
  const tids = pidToTids.get(pid);
  if (!tids) continue;

  const t1 = Date.now();
  const result = parseEtl(etlPath, tids);
  console.log(`\nPID ${pid}: ${result.pidSamples} samples / ${result.totalSamples} total (${Date.now() - t1}ms)`);

  // Source distribution for this PID's samples
  console.log('  Source distribution (all PIDs):');
  const srcSorted = [...result.sourceDistribution.entries()].sort((a, b) => b[1] - a[1]);
  for (const [src, cnt] of srcSorted.slice(0, 8)) {
    console.log(`    Source ${src}: ${cnt} samples`);
  }
}
