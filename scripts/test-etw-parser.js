'use strict';

// Basic smoke test for the ETL parser module
const { parseEtlDetailed, extractTidPidMap } = require('../collectors/etlParser');
const { checkAvailability, COUNTER_NAMES, SAMPLING_INTERVAL } = require('../collectors/etwCollector');

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

console.log('\n=== Module Load ===');
assert(typeof parseEtlDetailed === 'function', 'parseEtlDetailed is a function');
assert(typeof extractTidPidMap === 'function', 'extractTidPidMap is a function');
assert(typeof checkAvailability === 'function', 'checkAvailability is a function');
assert(COUNTER_NAMES.length === 5, '5 counters defined');
assert(SAMPLING_INTERVAL === 65536, 'Sampling interval = 65536');

console.log('\n=== Counter Names ===');
assert(COUNTER_NAMES.includes('InstructionRetired'), 'Has InstructionRetired');
assert(COUNTER_NAMES.includes('TotalCycles'), 'Has TotalCycles');
assert(COUNTER_NAMES.includes('LLCMisses'), 'Has LLCMisses');
assert(COUNTER_NAMES.includes('BranchMispredictions'), 'Has BranchMispredictions');
assert(COUNTER_NAMES.includes('BranchInstructions'), 'Has BranchInstructions');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
