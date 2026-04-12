# ETW PMC Profiler

Windows 빌트인 ETW(Event Tracing for Windows) PMC 하드웨어 카운터를 사용하는 프로세스 성능 프로파일러.

**외부 도구 설치 불필요** -- Windows 8.1+ 내장 `wpr.exe`만 사용. Intel / AMD / ARM64 지원.

## 사용법

```bash
npm install                # 최초 1회
start-as-admin.bat         # 관리자 권한으로 Electron 앱 실행
```

> PMC 하드웨어 카운터 접근에는 **관리자 권한**이 필수입니다.

## 측정 모드

| 모드 | 설명 |
|------|------|
| **단일 PID** | 선택한 프로세스 1개 측정 |
| **앱 (프로세스 트리)** | 선택한 프로세스 + 모든 자식 프로세스를 함께 측정 |
| **시스템 전체** | PID 필터 없이 전체 시스템 CPU 활동 측정 |

## Raw 카운터 (8개)

ETW PMC에서 직접 수집하는 하드웨어 카운터입니다.

| 카운터 | 설명 |
|--------|------|
| `InstructionRetired` | 실행 완료된 명령어 수 |
| `TotalCycles` | CPU 클럭 사이클 수 |
| `LLCMisses` | Last-Level Cache 미스 횟수 (DRAM 접근 프록시) |
| `BranchMispredictions` | 분기 예측 실패 횟수 |
| `BranchInstructions` | 전체 분기 명령어 수 |
| `LLCReference` | LLC 접근 횟수 |
| `TotalIssues` | uOps dispatched (uops retired 근사치) |
| `UnhaltedReferenceCycles` | 기준 클럭 사이클 (실효 CPU 주파수 추정용) |

### ETW 미지원 카운터

아래 카운터는 ETW PMC에서 노출하지 않습니다. Intel VTune의 SEP 드라이버만 접근 가능합니다.

| 카운터 | 용도 |
|--------|------|
| L1D miss | L1 데이터 캐시 미스 |
| L2 miss | L2 캐시 미스 |
| dTLB walk | 페이지 테이블 워크 (대용량 메모리 워크로드) |
| offcore latency | 오프코어 메모리 지연 |

## 유도 지표 (10개)

Raw 카운터에서 계산되는 분석 지표입니다.

| 지표 | 산식 | 추정 | 설명 |
|------|------|------|------|
| **IPC** | instr / cycles | - | 사이클당 처리 명령어. 높을수록 효율적 (일반 1.0~3.0) |
| **L3 MPKI** | LLC miss / instr x 1000 | 추정 | 1000 명령어당 LLC 미스. 높으면 메모리 바운드 |
| **Branch MPKI** | br mispredict / instr x 1000 | 추정 | 1000 명령어당 분기 예측 실패 |
| **Branch Mispred Rate** | br mispredict / br instr x 100% | 추정 | 분기 예측 실패율. 5% 이상 주의 |
| **LLC Hit Rate** | (ref - miss) / ref x 100% | 추정 | LLC 적중률. 95% 이상이면 양호 |
| **LLC Ref MPKI** | LLC ref / instr x 1000 | 추정 | 1000 명령어당 LLC 접근 횟수 |
| **uOps / Instruction** | TotalIssues / InstrRetired | 추정 | 명령어당 마이크로 오퍼레이션 수. 1.0~1.5 양호 |
| **Effective Frequency** | core cycles / ref cycles x base freq | 추정 | 실효 CPU 주파수 (터보/스로틀링 반영) |
| **DRAM accesses** | = LLC miss 합계 | 추정 | DRAM 접근 횟수 (P+E 코어 합산) |
| **DRAM bytes** | LLC miss x 64B 캐시라인 | 추정 | DRAM 전송 바이트. GiB/MB 자동 단위 |

> **"추정" 표시 기준**: IPC는 비율이라 배경 노이즈가 상쇄되어 신뢰도 높음. 나머지 지표는 ETW 멀티패스 샘플링 + 시스템 배경 프로파일링 노이즈가 포함된 추정치입니다. 절대값보다 **프로세스 간 상대 비교**에 적합합니다.

## 동작 방식

1. **wpr.exe** (Windows Performance Recorder, 빌트인)로 ETW 트레이스 수집
2. 커스텀 **ETL 바이너리 파서**로 SampledProfile 이벤트 직접 파싱 (tracerpt 불필요, 45MB ETL 50ms 파싱)
3. 카운터별 **멀티패스**: 8개 카운터 x N초 = 총 8N초 측정 시간
4. **TID->PID 매핑**으로 대상 프로세스 귀속 (ETL 내 Thread/Process DC 이벤트 활용)
5. 앱 모드: PowerShell `Get-CimInstance Win32_Process`로 프로세스 트리 재귀 탐색

## 프로젝트 구조

```
main.js                    Electron 메인 프로세스
preload.js                 IPC 브릿지 (context isolation)
collectors/
  etwCollector.js          WPR 세션 관리 + 멀티패스 수집 오케스트레이션
  etlParser.js             ETL 바이너리 직접 파싱 (PERFINFO_TRACE_HEADER 0xC011)
pmcService.js              측정 서비스 (수집 + 유도 지표 계산)
processService.js          프로세스 목록 + 추적
systemInfo.js              CPU/메모리 정보 (PowerShell CIM)
renderer/
  index.html               UI 레이아웃
  style.css                다크 테마
  app.js                   프론트엔드 로직
scripts/
  test-etw-parser.js       파서 유닛 테스트
  test-etw-collection.js   통합 테스트 (관리자 필요)
start-as-admin.bat         관리자 권한 실행 스크립트
```

## 제한사항

| 제한 | 설명 |
|------|------|
| **관리자 권한 필수** | PMC 접근은 Windows에서 항상 admin 필요 |
| **시스템 전체 수집** | ETW PMC는 system-wide 수집 후 PID 필터링 방식 |
| **배경 프로파일링 노이즈** | Windows 시스템 프로파일링이 동시 실행되어 절대값에 노이즈 포함 |
| **Hyper-V / VBS** | 가상화 환경에서 PMU 접근 불가능할 수 있음 |
| **ETW SampledCounter 미지원** | 카운팅 카운터 값이 ETL 바이너리에 포함되지 않아 멀티패스 방식 사용 |
| **P-Core / E-Core 미분리** | 현재 System(통합) 값만 제공. 코어 타입별 분리는 미구현 |
| **L1D/L2/dTLB/offcore** | ETW PMC에서 해당 카운터를 노출하지 않아 수집 불가 |

## 테스트

```bash
node scripts/test-etw-parser.js        # 파서 유닛 테스트
node scripts/test-etw-collection.js    # 통합 테스트 (관리자 필요)
```

## 관련 프로젝트

- [pmc-profiler](https://github.com/CompuFit/pmc-profiler) -- Intel VTune 기반 프로파일러 (정확하지만 설치 필요)
