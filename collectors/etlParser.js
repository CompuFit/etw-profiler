'use strict';

/**
 * Lightweight ETL binary parser for SampledProfile events.
 *
 * Event header formats:
 *   PERFINFO_TRACE_HEADER (0xC011/0xC010): 16-byte header
 *   SYSTEM_TRACE_HEADER (0xC002/0xC001): 48-byte header
 *
 * SampledProfile (Opcode 0x2E = 46):
 *   payload: IP(8) + ThreadId(4) + Count(2) + Source(2) = 16 bytes
 */

const fs = require('fs');

const BUF_HEADER_SIZE = 72;
const OPCODE_SAMPLED_PROFILE = 0x2E;

/**
 * Parse ETL and return per-source sample counts for both system-wide and target PID.
 * @param {string} etlPath
 * @param {Set<number>|null} targetTids - TIDs to filter, or null for system-wide (count all)
 */
function parseEtlDetailed(etlPath, targetTids) {
  const isSystemWide = !targetTids;
  const buf = fs.readFileSync(etlPath);

  let totalSamples = 0;
  let pidSamples = 0;
  const systemSourceDist = new Map();
  const pidSourceDist = new Map();

  let offset = 0;
  while (offset + BUF_HEADER_SIZE < buf.length) {
    const bufferSize = buf.readUInt32LE(offset);
    if (bufferSize === 0 || bufferSize > buf.length - offset) break;

    const savedOffset = buf.readUInt32LE(offset + 4);
    const bufEnd = offset + Math.min(savedOffset > 0 ? savedOffset : bufferSize, bufferSize);

    let eventOffset = offset + BUF_HEADER_SIZE;

    while (eventOffset + 16 < bufEnd) {
      const marker = buf.readUInt32LE(eventOffset);
      const markerHi = (marker >> 16) & 0xFFFF;

      let headerSize, eventSize;

      if (markerHi === 0xC011 || markerHi === 0xC010) {
        headerSize = 16;
      } else if (markerHi === 0xC002 || markerHi === 0xC001) {
        headerSize = 48;
      } else {
        eventOffset += 8;
        continue;
      }

      eventSize = buf.readUInt16LE(eventOffset + 4);
      if (eventSize < headerSize || eventSize > bufEnd - eventOffset) break;

      const hookId = buf.readUInt16LE(eventOffset + 6);
      const opcode = hookId & 0xFF;

      if (opcode === OPCODE_SAMPLED_PROFILE) {
        const dataOffset = eventOffset + headerSize;
        if (eventSize - headerSize >= 16) {
          const threadId = buf.readUInt32LE(dataOffset + 8);
          const source = buf.readUInt16LE(dataOffset + 14);

          totalSamples++;
          systemSourceDist.set(source, (systemSourceDist.get(source) || 0) + 1);

          if (isSystemWide || targetTids.has(threadId)) {
            pidSamples++;
            pidSourceDist.set(source, (pidSourceDist.get(source) || 0) + 1);
          }
        }
      }

      eventOffset += (eventSize + 7) & ~7;
    }

    offset += bufferSize;
  }

  return { totalSamples, pidSamples, systemSourceDist, pidSourceDist };
}

/**
 * Extract TID→PID mapping from thread/process events in ETL.
 */
function extractTidPidMap(etlPath) {
  const buf = fs.readFileSync(etlPath);
  const tidToPid = new Map();

  let offset = 0;
  while (offset + BUF_HEADER_SIZE < buf.length) {
    const bufferSize = buf.readUInt32LE(offset);
    if (bufferSize === 0 || bufferSize > buf.length - offset) break;

    const savedOffset = buf.readUInt32LE(offset + 4);
    const bufEnd = offset + Math.min(savedOffset > 0 ? savedOffset : bufferSize, bufferSize);

    let eventOffset = offset + BUF_HEADER_SIZE;

    while (eventOffset + 16 < bufEnd) {
      const marker = buf.readUInt32LE(eventOffset);
      const markerHi = (marker >> 16) & 0xFFFF;

      let headerSize, eventSize;

      if (markerHi === 0xC011 || markerHi === 0xC010) {
        headerSize = 16;
      } else if (markerHi === 0xC002 || markerHi === 0xC001) {
        headerSize = 48;

        // SYSTEM_TRACE_HEADER has TID/PID in header
        eventSize = buf.readUInt16LE(eventOffset + 4);
        if (eventSize >= 16 && eventSize <= bufEnd - eventOffset) {
          const tid = buf.readUInt32LE(eventOffset + 8);
          const pid = buf.readUInt32LE(eventOffset + 12);
          if (tid > 0 && tid < 0xFFFFFFFF && pid >= 0 && pid < 0xFFFFFFFF) {
            tidToPid.set(tid, pid);
          }
        }
      } else {
        eventOffset += 8;
        continue;
      }

      eventSize = buf.readUInt16LE(eventOffset + 4);
      if (eventSize < headerSize || eventSize > bufEnd - eventOffset) break;

      // For PERFINFO events with payload containing ProcessId+ThreadId
      if (headerSize === 16 && eventSize > headerSize + 8) {
        const payloadOffset = eventOffset + headerSize;
        const val1 = buf.readUInt32LE(payloadOffset);
        const val2 = buf.readUInt32LE(payloadOffset + 4);
        if (val1 > 0 && val1 < 100000 && val2 > 0 && val2 < 200000) {
          tidToPid.set(val2, val1);
        }
      }

      eventOffset += (eventSize + 7) & ~7;
    }

    offset += bufferSize;
  }

  return { tidToPid };
}

module.exports = { parseEtlDetailed, extractTidPidMap };
