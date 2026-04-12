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
const selDuration   = document.getElementById('sel-duration');
const btnMeasure    = document.getElementById('btn-measure');
const rawResults    = document.getElementById('raw-results');
const rawTbody      = document.getElementById('raw-tbody');
const derivedResults = document.getElementById('derived-results');
const metricsGrid   = document.getElementById('metrics-grid');
const measureInfo   = document.getElementById('measure-info');
const measureMeta   = document.getElementById('measure-meta');
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
  btnMeasure.disabled = false;
  filterProcessList(); // re-render to highlight
  log(`프로세스 선택: ${proc.name} (PID ${proc.pid})`, 'info');
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
  if (!selectedProcess || isMeasuring) return;

  isMeasuring = true;
  btnMeasure.textContent = '측정 중...';
  btnMeasure.classList.add('measuring');
  btnMeasure.disabled = true;

  // Clear previous results
  rawResults.style.display = 'none';
  derivedResults.style.display = 'none';
  measureInfo.style.display = 'none';

  const duration = parseInt(selDuration.value, 10);
  log(`측정 시작: PID ${selectedProcess.pid}, ${duration}초`, 'info');

  try {
    const res = await window.api.pmcMeasure(selectedProcess.pid, duration);

    if (!res.ok) {
      log(`측정 실패: ${res.error}`, 'error');
      return;
    }

    const data = res.data;
    log(`측정 완료: ${data.sampleCount} 샘플 (시스템 전체: ${data.totalSystemSamples})`, 'info');

    renderRawCounters(data.raw);
    renderDerivedMetrics(data.derived);
    renderMeasureMeta(data);

  } catch (e) {
    log(`측정 오류: ${e.message}`, 'error');
  } finally {
    isMeasuring = false;
    btnMeasure.textContent = '측정 시작';
    btnMeasure.classList.remove('measuring');
    btnMeasure.disabled = false;
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
  metricsGrid.innerHTML = '';

  const metrics = [
    {
      label: 'IPC (Instructions Per Cycle)',
      value: d.ipc.toFixed(3),
      unit: '',
      rating: d.ipc >= 2.0 ? 'good' : d.ipc >= 1.0 ? 'warn' : 'bad',
    },
    {
      label: 'LLC MPKI (Misses Per 1K Instr)',
      value: d.llcMpki.toFixed(3),
      unit: '',
      rating: d.llcMpki <= 1.0 ? 'good' : d.llcMpki <= 5.0 ? 'warn' : 'bad',
    },
    {
      label: 'DRAM Bandwidth (추정)',
      value: d.dramMB >= 1 ? d.dramMB.toFixed(1) : (d.dramBytes / 1024).toFixed(1),
      unit: d.dramMB >= 1 ? 'MB' : 'KB',
      rating: 'neutral',
    },
    {
      label: 'Branch Misprediction Rate',
      value: d.branchMispredRate.toFixed(2),
      unit: '%',
      rating: d.branchMispredRate <= 1.0 ? 'good' : d.branchMispredRate <= 5.0 ? 'warn' : 'bad',
    },
  ];

  for (const m of metrics) {
    const div = document.createElement('div');
    div.className = `metric-card ${m.rating}`;
    div.innerHTML = `
      <div class="metric-label">${m.label}</div>
      <div>
        <span class="metric-value">${m.value}</span>
        <span class="metric-unit">${m.unit}</span>
      </div>
    `;
    metricsGrid.appendChild(div);
  }

  derivedResults.style.display = 'block';
}

function renderMeasureMeta(data) {
  measureMeta.textContent = [
    `수집 시간: ${data.durationSec}초`,
    `PID 샘플: ${data.sampleCount}`,
    `시스템 전체 샘플: ${data.totalSystemSamples}`,
    `샘플링 간격: ${data.samplingInterval}`,
    `수집 시각: ${data.collectedAt}`,
  ].join(' | ');
  measureInfo.style.display = 'block';
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
