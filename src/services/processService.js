'use strict';

/**
 * 프로세스 관리 서비스
 *
 * 실행 중인 프로세스 목록 조회 및 특정 프로세스 생존 추적.
 */

const psList = require('ps-list');

let trackingState = null;
let trackingTimer = null;

/** 실행 중인 프로세스 목록 (PID, 이름, PPID) */
async function listProcesses() {
  const list = await psList();
  return list.map(p => ({
    pid: p.pid,
    name: p.name || 'unknown',
    ppid: p.ppid || 0,
  })).sort((a, b) => a.pid - b.pid);
}

/** 특정 프로세스 추적 시작 (3초마다 생존 확인) */
function startTracking(pid, name) {
  stopTracking();
  trackingState = { pid, name, startedAt: Date.now(), alive: true };
  trackingTimer = setInterval(async () => {
    try {
      const list = await psList();
      if (!list.some(p => p.pid === pid) && trackingState) {
        trackingState.alive = false;
      }
    } catch (_) {}
  }, 3000);
  return trackingState;
}

/** 추적 중지 */
function stopTracking() {
  if (trackingTimer) { clearInterval(trackingTimer); trackingTimer = null; }
  const prev = trackingState;
  trackingState = null;
  return prev;
}

/** 현재 추적 상태 */
function getTrackingState() {
  return trackingState;
}

module.exports = { listProcesses, startTracking, stopTracking, getTrackingState };
