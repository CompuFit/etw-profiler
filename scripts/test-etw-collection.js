'use strict';

/**
 * ETW PMC Collection Integration Test
 * Must be run with administrator privileges!
 *
 * Usage: node scripts/test-etw-collection.js [pid] [duration]
 */

const pmcService = require('../src/services/pmcService');
const systemInfo = require('../src/services/systemInfo');

const targetPid = parseInt(process.argv[2], 10) || process.pid;
const duration = parseInt(process.argv[3], 10) || 5;

async function main() {
  console.log('========================================');
  console.log('  ETW PMC Collection Integration Test');
  console.log('========================================\n');

  // System info
  const sys = await systemInfo.get();
  console.log(`CPU: ${sys.cpu.model} (${sys.cpu.physicalCores}P/${sys.cpu.logicalCores}L)`);
  console.log(`MEM: ${sys.mem.totalGB} GB ${sys.mem.type}\n`);

  // Generate CPU load if targeting self
  let worker = null;
  if (targetPid === process.pid) {
    console.log(`Target: self (PID ${process.pid}) - generating CPU load...`);
    worker = startLoad();
  } else {
    console.log(`Target: PID ${targetPid}`);
  }

  console.log(`Duration: ${duration} seconds (per-pass: ~${Math.ceil(duration/5)}s × 5 passes)\n`);

  try {
    const result = await pmcService.startCollection(targetPid, duration, (msg) => {
      console.log(`  → ${msg}`);
    });

    if (worker) worker.stop();

    console.log('\n=== Raw Counters ===');
    for (const [key, val] of Object.entries(result.raw)) {
      console.log(`  ${key.padEnd(25)} ${val.toLocaleString()}`);
    }

    console.log('\n=== Derived Metrics ===');
    const d = result.derived;
    console.log(`  IPC:                    ${d.ipc}`);
    console.log(`  LLC MPKI:               ${d.llcMpki}`);
    console.log(`  DRAM Bandwidth:         ${d.dramMB} MB (estimated)`);
    console.log(`  Branch Mispred. Rate:   ${d.branchMispredRate}%`);

    console.log(`\n=== Meta ===`);
    console.log(`  Total PID samples:      ${result.sampleCount}`);
    console.log(`  Total system samples:   ${result.totalSystemSamples}`);
    console.log(`  Collected at:           ${result.collectedAt}`);

    // Sanity
    console.log('\n=== Validation ===');
    if (d.ipc > 0 && d.ipc < 20) console.log(`  ✓ IPC ${d.ipc} (normal range)`);
    else console.log(`  ⚠ IPC ${d.ipc}`);

    if (result.sampleCount > 0) console.log(`  ✓ Samples collected: ${result.sampleCount}`);
    else console.log(`  ✗ No samples!`);

    console.log('\nDone!');

  } catch (e) {
    if (worker) worker.stop();
    console.error(`\n✗ Failed: ${e.message}`);
    if (e.message.includes('관리자')) {
      console.log('\n  Run as administrator!');
    }
    process.exit(1);
  }
}

function startLoad() {
  let running = true;
  const interval = setInterval(() => {
    if (!running) return;
    let x = 0;
    for (let i = 0; i < 5_000_000; i++) x += Math.sin(i) * Math.cos(i);
  }, 10);
  return { stop: () => { running = false; clearInterval(interval); } };
}

main();
