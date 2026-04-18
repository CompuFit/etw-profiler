'use strict';

const gpu = require('../src/services/gpuService');

console.log('=== GPU 어댑터 ===');
console.log(JSON.stringify(gpu.getAdapters(), null, 2));

console.log('\n=== GPU 스냅샷 (시스템 전체) ===');
const s = gpu.snapshot(null);
console.log(JSON.stringify(s, null, 2));
