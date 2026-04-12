# ETW PMC Profiler

Windows 빌트인 ETW(Event Tracing for Windows) PMC 하드웨어 카운터를 사용하는 프로세스 성능 프로파일러.

**설치 불필요** — Windows 8.1+ 내장 `wpr.exe` 만 사용. Intel/AMD/ARM64 지원.

## 측정 항목

| 카운터 | 용도 |
|--------|------|
| InstructionRetired | 실행된 명령어 수 |
| TotalCycles | CPU 사이클 수 |
| LLCMisses | Last-Level Cache 미스 |
| BranchMispredictions | 분기 예측 실패 |
| BranchInstructions | 전체 분기 명령어 |

### 유도 지표
- **IPC** (Instructions Per Cycle)
- **LLC MPKI** (Misses Per 1K Instructions)
- **DRAM Bandwidth** (LLC Miss x 64B 캐시라인)
- **Branch Misprediction Rate** (%)

## 사용법

```bash
npm install
npm start              # 일반 실행 (PMC 측정 불가)
start-as-admin.bat     # 관리자 권한으로 실행 (PMC 측정 가능)
```

> PMC 하드웨어 카운터 접근에는 관리자 권한이 필수입니다.

## 동작 방식

1. **wpr.exe** (Windows Performance Recorder, 빌트인)로 ETW 트레이스 수집
2. 커스텀 **ETL 바이너리 파서**로 SampledProfile 이벤트 직접 파싱 (tracerpt 불필요)
3. 카운터별 멀티패스: 5개 카운터 x N초 = 총 5N초 측정 시간
4. TID->PID 매핑으로 대상 프로세스 귀속

## 구조

```
main.js               # Electron 메인 프로세스
preload.js            # IPC 브릿지 (context isolation)
collectors/
  etwCollector.js     # WPR 세션 관리 + 수집 오케스트레이션
  etlParser.js        # ETL 바이너리 직접 파싱
pmcService.js         # 측정 서비스 (수집 + 유도 지표 계산)
processService.js     # 프로세스 목록 + 추적
systemInfo.js         # CPU/메모리 정보 (PowerShell)
renderer/
  index.html
  style.css
  app.js
scripts/
  test-etw-parser.js
start-as-admin.bat    # 관리자 권한 실행 스크립트
```

## 알려진 제한사항

- **관리자 권한 필수**: PMC 접근은 Windows 에서 항상 admin 필요
- **시스템 전체 수집**: ETW PMC는 system-wide 수집 후 PID 필터링
- **배경 프로파일링 노이즈**: Windows 시스템 프로파일링이 동시 실행되어 절대값에 노이즈 포함. IPC 비율은 신뢰도 높음. LLC MPKI/분기실패율은 추정치
- **Hyper-V/VBS**: 가상화 환경에서 PMU 접근 불가능할 수 있음
- **ETW 제한**: 카운팅 카운터 값은 ETL 바이너리에 포함되지 않아 멀티패스 방식 사용

## 테스트

```bash
node scripts/test-etw-parser.js        # 파서 유닛 테스트
node scripts/test-etw-collection.js    # 통합 테스트 (관리자 필요)
```
