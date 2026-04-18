'use strict';

/* ================================================================
   ETW PMC Profiler – Renderer (Frontend Logic)
   ================================================================ */

// State
let selectedProcess = null;
let autoRefreshTimer = null;
let isMeasuring = false;

// DOM refs
const adminBanner   = document.getElementById('admin-banner');
const procSearch    = document.getElementById('proc-search');
const btnRefresh    = document.getElementById('btn-refresh');
const chkAutoRefresh = document.getElementById('chk-auto-refresh');
const procTbody     = document.getElementById('proc-tbody');
const selectedInfo  = document.getElementById('selected-info');
const selMode       = document.getElementById('sel-mode');
const selDuration   = document.getElementById('sel-duration');
const btnMeasure    = document.getElementById('btn-measure');
const modeInfoDiv   = document.getElementById('mode-info');
const rawResults    = document.getElementById('raw-results');
const rawTbody      = document.getElementById('raw-tbody');
const derivedResults = document.getElementById('derived-results');
const derivedTbody  = document.getElementById('derived-tbody');
const measureInfo   = document.getElementById('measure-info');
const measureMeta   = document.getElementById('measure-meta');
const btnRefreshUsage = document.getElementById('btn-refresh-usage');
const gpuResults    = document.getElementById('gpu-results');
const gpuTbody      = document.getElementById('gpu-tbody');
const gpuAdaptersInfo = document.getElementById('gpu-adapters-info');
const systemInfoDiv = document.getElementById('system-info');
const logContainer  = document.getElementById('log-container');

/* ------------------------------------------------------------------ */
/*  Initialization                                                     */
/* ------------------------------------------------------------------ */

(async function init() {
  // Check admin status
  const adminRes = await window.api.checkAdmin();
  if (adminRes.ok && !adminRes.data.isAdmin) {
    adminBanner.style.display = 'block';
    log('관리자 권한 없음 — PMC 측정이 제한됩니다.', 'warn');
  } else {
    log('관리자 권한 확인됨', 'info');
  }

  // Load system info
  loadSystemInfo();

  // Check PMC availability
  const pmcRes = await window.api.pmcAvailability();
  if (pmcRes.ok && pmcRes.data.available) {
    log(`PMC 상태: ${pmcRes.data.reason}`, 'info');
  } else {
    log(`PMC 상태: ${pmcRes.ok ? pmcRes.data.reason : pmcRes.error}`, 'warn');
  }

  // Load initial process list
  refreshProcessList();

  // Setup auto-refresh
  setupAutoRefresh();

  // Setup event listeners
  procSearch.addEventListener('input', filterProcessList);
  btnRefresh.addEventListener('click', refreshProcessList);
  chkAutoRefresh.addEventListener('change', setupAutoRefresh);
  btnMeasure.addEventListener('click', startMeasurement);
  selMode.addEventListener('change', onModeChange);
  btnRefreshUsage.addEventListener('click', refreshUsage);
  onModeChange(); // init mode state

  // Initial usage
  refreshUsage();

  // PMC progress events
  window.api.onPmcProgress((msg) => {
    log(msg, 'progress');
  });
})();

/* ------------------------------------------------------------------ */
/*  Process List                                                       */
/* ------------------------------------------------------------------ */

let allProcesses = [];

async function refreshProcessList() {
  const res = await window.api.listProcesses();
  if (!res.ok) {
    log(`프로세스 목록 오류: ${res.error}`, 'error');
    return;
  }
  allProcesses = res.data;
  filterProcessList();
}

function filterProcessList() {
  const query = procSearch.value.toLowerCase().trim();
  const filtered = query
    ? allProcesses.filter(p =>
        p.name.toLowerCase().includes(query) ||
        String(p.pid).includes(query))
    : allProcesses;

  renderProcessTable(filtered);
}

function renderProcessTable(processes) {
  procTbody.innerHTML = '';
  for (const p of processes) {
    const tr = document.createElement('tr');
    if (selectedProcess && selectedProcess.pid === p.pid) {
      tr.classList.add('selected');
    }

    tr.innerHTML = `<td>${p.pid}</td><td>${escHtml(p.name)}</td><td>${p.ppid}</td>`;
    tr.addEventListener('click', () => selectProcess(p));
    procTbody.appendChild(tr);
  }
}

function selectProcess(proc) {
  selectedProcess = proc;
  selectedInfo.innerHTML = `
    <span class="pid-label">PID: ${proc.pid}</span> &nbsp;
    <span class="name-label">${escHtml(proc.name)}</span>
    <span style="color:#666"> (PPID: ${proc.ppid})</span>
  `;
  updateMeasureButton();
  filterProcessList();
  log(`프로세스 선택: ${proc.name} (PID ${proc.pid})`, 'info');

  // If app mode, show process tree preview
  if (selMode.value === 'app') {
    showProcessTreePreview(proc.pid);
  }
}

function onModeChange() {
  const mode = selMode.value;
  updateMeasureButton();

  if (mode === 'system') {
    modeInfoDiv.textContent = '시스템 전체 CPU 활동을 측정합니다. 프로세스 선택 불필요.';
  } else if (mode === 'app') {
    modeInfoDiv.textContent = '선택한 프로세스 + 모든 자식 프로세스를 함께 측정합니다.';
    if (selectedProcess) showProcessTreePreview(selectedProcess.pid);
  } else {
    modeInfoDiv.textContent = '';
  }
}

function updateMeasureButton() {
  const mode = selMode.value;
  if (mode === 'system') {
    btnMeasure.disabled = false;
  } else {
    btnMeasure.disabled = !selectedProcess;
  }
}

async function showProcessTreePreview(pid) {
  const res = await window.api.getProcessTree(pid);
  if (res.ok && res.data.length > 1) {
    modeInfoDiv.innerHTML = `프로세스 트리: <span class="tree-pids">${res.data.length}개 PID (${res.data.slice(0, 8).join(', ')}${res.data.length > 8 ? '...' : ''})</span>`;
  } else {
    modeInfoDiv.textContent = '자식 프로세스 없음 — 단일 PID로 측정됩니다.';
  }
}

function setupAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (chkAutoRefresh.checked) {
    autoRefreshTimer = setInterval(refreshProcessList, 2000);
  }
}

/* ------------------------------------------------------------------ */
/*  PMC Measurement                                                    */
/* ------------------------------------------------------------------ */

async function startMeasurement() {
  const mode = selMode.value;

  if (mode !== 'system' && !selectedProcess) return;
  if (isMeasuring) return;

  isMeasuring = true;
  btnMeasure.textContent = '측정 중...';
  btnMeasure.classList.add('measuring');
  btnMeasure.disabled = true;

  rawResults.style.display = 'none';
  derivedResults.style.display = 'none';
  gpuResults.style.display = 'none';
  measureInfo.style.display = 'none';

  const duration = parseInt(selDuration.value, 10);
  const opts = { mode };
  if (mode === 'pid' || mode === 'app') {
    opts.pid = selectedProcess.pid;
  }

  const modeLabels = { pid: `PID ${opts.pid}`, app: `앱 PID ${opts.pid}+자식`, system: '시스템 전체' };
  log(`측정 시작: ${modeLabels[mode]}, ${duration}초`, 'info');

  try {
    const res = await window.api.pmcMeasure(opts, duration);

    if (!res.ok) {
      log(`측정 실패: ${res.error}`, 'error');
      return;
    }

    const data = res.data;
    log(`측정 완료 [${data.modeLabel}]: ${data.sampleCount} 샘플 (시스템: ${data.totalSystemSamples})`, 'info');

    renderRawCounters(data.raw);
    renderDerivedMetrics(data.derived);
    if (data.gpu) renderGpuMetrics(data.gpu, opts.pid || null);
    renderMeasureMeta(data);

  } catch (e) {
    log(`측정 오류: ${e.message}`, 'error');
  } finally {
    isMeasuring = false;
    btnMeasure.textContent = '측정 시작';
    btnMeasure.classList.remove('measuring');
    updateMeasureButton();
  }
}

/* ------------------------------------------------------------------ */
/*  Result Rendering                                                   */
/* ------------------------------------------------------------------ */

const COUNTER_LABELS = {
  InstructionRetired: 'Instructions Retired',
  TotalCycles: 'Total Cycles',
  LLCMisses: 'LLC Misses',
  BranchMispredictions: 'Branch Mispredictions',
  BranchInstructions: 'Branch Instructions',
  LLCReference: 'LLC References',
  TotalIssues: 'uOps Dispatched',
  UnhaltedReferenceCycles: 'Reference Cycles',
};

function renderRawCounters(counters) {
  rawTbody.innerHTML = '';

  for (const [key, label] of Object.entries(COUNTER_LABELS)) {
    const val = counters[key] || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td class="val">${formatNum(val)}</td>`;
    rawTbody.appendChild(tr);
  }

  rawResults.style.display = 'block';
}

function renderDerivedMetrics(d) {
  derivedTbody.innerHTML = '';

  const dramVal = d.dramGiB >= 1
    ? `${d.dramGiB.toFixed(2)} GiB (${formatNum(d.dramBytes)} B)`
    : `${d.dramMB.toFixed(1)} MB (${formatNum(d.dramBytes)} B)`;

  const freqVal = d.effectiveFreqGHz > 0
    ? `${d.effectiveFreqGHz.toFixed(2)} GHz`
    : d.freqRatio.toFixed(3);

  const rows = [
    { label: 'IPC',                 value: d.ipc.toFixed(3),                      formula: 'instr / cycles' },
    { label: 'L3 MPKI',             value: d.l3Mpki.toFixed(2),                   formula: 'LLC miss / instr x 1000',       estimate: true },
    { label: 'Branch MPKI',         value: d.branchMpki.toFixed(2),               formula: 'br mispredict / instr x 1000',  estimate: true },
    { label: 'Branch Mispred Rate', value: d.branchMispredRate.toFixed(2) + ' %', formula: 'br mispredict / br instr x 100', estimate: true },
    { label: 'LLC Hit Rate',        value: d.llcHitRate.toFixed(2) + ' %',        formula: '(ref - miss) / ref x 100',      estimate: true },
    { label: 'LLC Ref MPKI',        value: d.llcRefMpki.toFixed(2),               formula: 'LLC ref / instr x 1000',        estimate: true },
    { label: 'uOps / Instruction',  value: d.uopsPerInst.toFixed(2),             formula: 'TotalIssues / InstrRetired',     estimate: true },
    { label: 'Effective Frequency', value: freqVal,                               formula: 'core cyc / ref cyc x base',     estimate: true },
    { label: 'DRAM accesses',       value: formatNum(d.dramAccesses),             formula: 'LLC miss (P+E)',                estimate: true },
    { label: 'DRAM bytes',          value: dramVal,                               formula: 'LLC miss x 64B',                estimate: true },
  ];

  for (const row of rows) {
    const tr = document.createElement('tr');
    const badge = row.estimate ? ' <span class="estimate-badge">추정</span>' : '';
    tr.innerHTML = `<td>${row.label}${badge}</td><td class="val">${row.value}</td><td class="formula">${row.formula}</td>`;
    derivedTbody.appendChild(tr);
  }

  derivedResults.style.display = 'block';
}

function renderMeasureMeta(data) {
  const parts = [
    `모드: ${data.modeLabel || data.mode}`,
    `수집 시간: ${data.durationSec}초`,
    `대상 샘플: ${data.sampleCount}`,
    `시스템 샘플: ${data.totalSystemSamples}`,
  ];
  if (data.pids && data.pids.length > 1) {
    parts.push(`PID: ${data.pids.length}개`);
  }
  if (data.elapsedSec) {
    parts.push(`소요 시간: ${data.elapsedSec}s`);
  }
  parts.push(`수집 시각: ${data.collectedAt}`);
  measureMeta.textContent = parts.join(' | ');
  measureInfo.style.display = 'block';
}

/* ------------------------------------------------------------------ */
/*  System Usage (Task Manager style)                                  */
/* ------------------------------------------------------------------ */

async function refreshUsage() {
  btnRefreshUsage.disabled = true;
  btnRefreshUsage.textContent = '측정 중...';

  try {
    const res = await window.api.getUsage();
    if (!res.ok) return;
    const d = res.data;

    // CPU
    setBar('cpu', d.cpu.percent, `${d.cpu.percent}%`);

    // RAM
    setBar('ram', d.ram.percent, `${d.ram.usedGB} / ${d.ram.totalGB} GB (${d.ram.percent}%)`);

    // GPU (3D engine)
    const gpu3d = d.gpu.utilization.total3d;
    setBar('gpu', gpu3d, `${gpu3d}%`);

    // VRAM
    const vramUsed = d.gpu.memory.dedicatedBytes + d.gpu.memory.sharedBytes;
    const vramTotal = d.totalVramBytes > 0 ? d.totalVramBytes : vramUsed;
    const vramPercent = vramTotal > 0 ? Math.min(100, (vramUsed / vramTotal) * 100) : 0;
    setBar('vram', vramPercent, `${fmtBytes(vramUsed)} / ${fmtBytes(vramTotal)} (${vramPercent.toFixed(0)}%)`);

    // Detail text
    const detail = document.getElementById('usage-detail');
    const parts = [
      `CPU ${d.cpu.logicalCores} cores`,
    ];
    if (d.gpu.utilization.totalVideo > 0) parts.push(`Video ${d.gpu.utilization.totalVideo}%`);
    if (d.gpu.utilization.totalCopy > 0) parts.push(`Copy ${d.gpu.utilization.totalCopy}%`);
    detail.textContent = parts.join(' | ');

  } catch (_) {}
  finally {
    btnRefreshUsage.disabled = false;
    btnRefreshUsage.textContent = '새로고침';
  }
}

function setBar(id, percent, text) {
  const fill = document.getElementById(`bar-${id}`);
  const val = document.getElementById(`val-${id}`);
  fill.style.width = `${Math.min(100, percent)}%`;
  fill.className = 'usage-fill' + (percent >= 90 ? ' high' : percent >= 70 ? ' mid' : '');
  val.textContent = text;
}

/* ------------------------------------------------------------------ */
/*  GPU Raw 카운터 (CPU와 통합 측정)                                    */
/* ------------------------------------------------------------------ */

function renderGpuMetrics(gpu, targetPid) {
  gpuTbody.innerHTML = '';

  const rows = [
    { label: '3D Engine Utilization',  value: gpu.utilization.total3d + ' %' },
    { label: 'Copy Engine Utilization', value: gpu.utilization.totalCopy + ' %' },
    { label: 'Video Engine Utilization', value: gpu.utilization.totalVideo + ' %' },
    { label: 'VRAM Dedicated',          value: fmtBytes(gpu.memory.dedicatedBytes) },
    { label: 'VRAM Shared',             value: fmtBytes(gpu.memory.sharedBytes) },
  ];

  // 프로세스별 VRAM (상위 5개)
  if (gpu.perProcess && gpu.perProcess.length > 0) {
    for (const p of gpu.perProcess.slice(0, 5)) {
      rows.push({
        label: `PID ${p.pid} VRAM`,
        value: `Dedicated ${fmtBytes(p.dedicated)} / Shared ${fmtBytes(p.shared)}`,
      });
    }
  }

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.label}</td><td class="val">${row.value}</td>`;
    gpuTbody.appendChild(tr);
  }

  // 어댑터 정보
  if (gpu.adapters && gpu.adapters.length > 0) {
    gpuAdaptersInfo.textContent = gpu.adapters
      .map(a => `${a.name} (${a.vramMB > 0 ? a.vramMB + ' MB' : 'Shared'}, driver ${a.driver})`)
      .join(' / ');
  }

  gpuResults.style.display = 'block';
}

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/* ------------------------------------------------------------------ */
/*  System Info                                                        */
/* ------------------------------------------------------------------ */

async function loadSystemInfo() {
  const res = await window.api.getSystemInfo();
  if (!res.ok) {
    systemInfoDiv.innerHTML = `<span class="placeholder">${res.error}</span>`;
    return;
  }

  const { cpu, mem } = res.data;
  systemInfoDiv.innerHTML = `
    <div class="info-row"><span class="info-label">CPU</span><span class="info-value">${escHtml(cpu.model)}</span></div>
    <div class="info-row"><span class="info-label">코어</span><span class="info-value">${cpu.physicalCores}P / ${cpu.logicalCores}L${cpu.isHybrid ? ' (하이브리드)' : ''}</span></div>
    <div class="info-row"><span class="info-label">클럭</span><span class="info-value">${cpu.baseFreqMHz} MHz (max ${cpu.maxFreqMHz} MHz)</span></div>
    <div class="info-row"><span class="info-label">메모리</span><span class="info-value">${mem.totalGB} GB ${mem.type} @ ${mem.speedMHz} MHz (${mem.channels}ch)</span></div>
    <div class="info-row"><span class="info-label">메모리 레이턴시</span><span class="info-value">${mem.typicalLatencyNs} (일반적)</span></div>
  `;
}

/* ------------------------------------------------------------------ */
/*  Status Log                                                         */
/* ------------------------------------------------------------------ */

function log(message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${level}`;

  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  entry.innerHTML = `<span class="log-time">${time}</span>${escHtml(message)}`;

  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;

  // Keep only last 200 entries
  while (logContainer.children.length > 200) {
    logContainer.removeChild(logContainer.firstChild);
  }
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatNum(n) {
  if (n === 0) return '0';
  return n.toLocaleString('en-US');
}
