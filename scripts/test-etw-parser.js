'use strict';

const { parseEtlDetailed, extractTidPidMap } = require('../src/services/etlParser');
const { checkAvailability, COUNTER_NAMES, SAMPLING_INTERVAL } = require('../src/services/etwCollector');

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

console.log('\n=== 모듈 로드 ===');
assert(typeof parseEtlDetailed === 'function', 'parseEtlDetailed 함수');
assert(typeof extractTidPidMap === 'function', 'extractTidPidMap 함수');
assert(typeof checkAvailability === 'function', 'checkAvailability 함수');
assert(COUNTER_NAMES.length === 8, '8개 카운터 정의');
assert(SAMPLING_INTERVAL === 65536, '샘플링 간격 = 65536');

console.log('\n=== 카운터 이름 ===');
assert(COUNTER_NAMES.includes('InstructionRetired'), 'InstructionRetired');
assert(COUNTER_NAMES.includes('TotalCycles'), 'TotalCycles');
assert(COUNTER_NAMES.includes('LLCMisses'), 'LLCMisses');
assert(COUNTER_NAMES.includes('BranchMispredictions'), 'BranchMispredictions');
assert(COUNTER_NAMES.includes('BranchInstructions'), 'BranchInstructions');
assert(COUNTER_NAMES.includes('LLCReference'), 'LLCReference');
assert(COUNTER_NAMES.includes('TotalIssues'), 'TotalIssues');
assert(COUNTER_NAMES.includes('UnhaltedReferenceCycles'), 'UnhaltedReferenceCycles');

console.log('\n=== GPU 서비스 ===');
const gpu = require('../src/services/gpuService');
assert(typeof gpu.getAdapters === 'function', 'gpuService.getAdapters');
assert(typeof gpu.snapshot === 'function', 'gpuService.snapshot');
const adapters = gpu.getAdapters();
assert(Array.isArray(adapters), 'getAdapters 배열 반환');
assert(adapters.length > 0, `GPU 어댑터 ${adapters.length}개 감지`);

console.log('\n=== 시스템 정보 ===');
const sys = require('../src/services/systemInfo');
assert(typeof sys.get === 'function', 'systemInfo.get');
assert(typeof sys.getUsage === 'function', 'systemInfo.getUsage');

console.log(`\n${passed} 통과, ${failed} 실패`);
process.exit(failed > 0 ? 1 : 0);
