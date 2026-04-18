'use strict';

/**
 * ETL 바이너리 직접 파서
 *
 * ETL 파일의 SampledProfile 이벤트를 바이너리 레벨에서 파싱합니다.
 * tracerpt.exe 대비 ~6000배 빠름 (45MB ETL → 50ms).
 *
 * 이벤트 헤더 포맷:
 *   PERFINFO_TRACE_HEADER (0xC011/0xC010): 16바이트 헤더
 *   SYSTEM_TRACE_HEADER   (0xC002/0xC001): 48바이트 헤더
 *
 * SampledProfile (Opcode 0x2E = 46):
 *   페이로드: IP(8) + ThreadId(4) + Count(2) + Source(2) = 16바이트
 */

const fs = require('fs');

const BUF_HEADER_SIZE = 72;              // ETL 버퍼 헤더 크기
const OPCODE_SAMPLED_PROFILE = 0x2E;     // SampledProfile 이벤트 Opcode

/**
 * ETL 파싱 — 소스별 샘플 수를 시스템 전체 + 대상 PID별로 반환.
 *
 * @param {string} etlPath       ETL 파일 경로
 * @param {Set<number>|null} targetTids  필터링할 TID 집합. null이면 시스템 전체 카운트
 * @returns {{ totalSamples, pidSamples, systemSourceDist, pidSourceDist }}
 */
function parseEtlDetailed(etlPath, targetTids) {
  const isSystemWide = !targetTids;
  const buf = fs.readFileSync(etlPath);

  let totalSamples = 0;
  let pidSamples = 0;
  const systemSourceDist = new Map();    // Source → 전체 카운트
  const pidSourceDist = new Map();       // Source → 대상 PID 카운트

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

      // 헤더 타입 판별
      let headerSize;
      if (markerHi === 0xC011 || markerHi === 0xC010) {
        headerSize = 16;     // PERFINFO_TRACE_HEADER
      } else if (markerHi === 0xC002 || markerHi === 0xC001) {
        headerSize = 48;     // SYSTEM_TRACE_HEADER
      } else {
        eventOffset += 8;
        continue;
      }

      const eventSize = buf.readUInt16LE(eventOffset + 4);
      if (eventSize < headerSize || eventSize > bufEnd - eventOffset) break;

      const hookId = buf.readUInt16LE(eventOffset + 6);
      const opcode = hookId & 0xFF;

      // SampledProfile 이벤트 처리
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

      // 8바이트 정렬
      eventOffset += (eventSize + 7) & ~7;
    }

    offset += bufferSize;
  }

  return { totalSamples, pidSamples, systemSourceDist, pidSourceDist };
}

/**
 * ETL에서 TID → PID 매핑 추출.
 * Thread/Process DC(Data Collection) 이벤트를 파싱하여 매핑 테이블 구축.
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

      let headerSize;

      if (markerHi === 0xC011 || markerHi === 0xC010) {
        headerSize = 16;
      } else if (markerHi === 0xC002 || markerHi === 0xC001) {
        headerSize = 48;
        // SYSTEM_TRACE_HEADER 헤더에 TID/PID 포함
        const eventSize = buf.readUInt16LE(eventOffset + 4);
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

      const eventSize = buf.readUInt16LE(eventOffset + 4);
      if (eventSize < headerSize || eventSize > bufEnd - eventOffset) break;

      // PERFINFO 이벤트 페이로드에서도 PID+TID 추출 시도
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
