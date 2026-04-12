'use strict';

const psList = require('ps-list');

let trackingState = null;
let trackingTimer = null;

/**
 * List running processes (name, pid, ppid).
 */
async function listProcesses() {
  const list = await psList();
  return list.map(p => ({
    pid: p.pid,
    name: p.name || 'unknown',
    ppid: p.ppid || 0,
  })).sort((a, b) => a.pid - b.pid);
}

/**
 * Start tracking a specific process (check if it's still alive periodically).
 */
function startTracking(pid, name) {
  stopTracking();
  trackingState = { pid, name, startedAt: Date.now(), alive: true };

  trackingTimer = setInterval(async () => {
    try {
      const list = await psList();
      const found = list.some(p => p.pid === pid);
      if (!found && trackingState) {
        trackingState.alive = false;
      }
    } catch (_) {}
  }, 3000);

  return trackingState;
}

/**
 * Stop tracking.
 */
function stopTracking() {
  if (trackingTimer) {
    clearInterval(trackingTimer);
    trackingTimer = null;
  }
  const prev = trackingState;
  trackingState = null;
  return prev;
}

/**
 * Get current tracking state.
 */
function getTrackingState() {
  return trackingState;
}

module.exports = {
  listProcesses,
  startTracking,
  stopTracking,
  getTrackingState,
};
