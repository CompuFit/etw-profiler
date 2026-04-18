# ETW PMC Profiler

Windows 빌트인 도구만으로 CPU Raw 카운터 + GPU Raw 카운터를 **한 번에** 측정하는 프로세스 성능 프로파일러.

**외부 도구 설치 불필요** -- Windows 8.1+ 내장 `wpr.exe` + Performance Counter 사용. Intel / AMD / ARM64 지원.

## 사용법

```bash
npm install                # 최초 1회
start-as-admin.bat         # 관리자 권한으로 Electron 앱 실행
```

> CPU PMC 측정에는 **관리자 권한** 필수. GPU 측정은 관리자 권한 불필요.

## 측정 흐름

1. 프로세스 목록에서 대상 선택 (또는 시스템 전체 모드)
2. **"측정 시작"** 버튼 한 번 클릭
3. CPU Raw 카운터 8개 멀티패스 수집 + GPU Raw 카운터 5개 스냅샷 **동시 실행**
4. 결과: CPU Raw 카운터 → CPU 유도 지표 → GPU Raw 카운터 순서로 통합 표시

## 측정 모드

| 모드 | 설명 | CPU | GPU |
|------|------|-----|-----|
| **단일 PID** | 선택한 프로세스 1개 | 해당 PID 스레드 필터링 | 해당 PID GPU 사용량 |
| **앱 (프로세스 트리)** | 선택한 프로세스 + 모든 자식 | 트리 전체 합산 | 트리 전체 합산 |
| **시스템 전체** | 전체 시스템 | 모든 프로세스 | 모든 프로세스 |

## 측정 항목 상세

### CPU Raw 카운터 (8개)

ETW PMC(`wpr.exe`)로 수집. 관리자 권한 필요.

| 카운터 | 뭘 측정하나 | 왜 필요한가 |
|--------|-------------|-------------|
| `InstructionRetired` | CPU가 실행 완료한 명령어 수 | 모든 유도 지표의 기준. 워크로드 크기 파악 |
| `TotalCycles` | CPU 클럭 사이클 수 | IPC 계산의 분모. 실제 CPU 시간 소모량 |
| `LLCMisses` | Last-Level Cache 미스 횟수 | DRAM 접근 횟수의 프록시. 메모리 병목 진단 |
| `LLCReference` | LLC 접근 횟수 (hit + miss) | LLC 적중률 계산. 캐시 효율 진단 |
| `BranchMispredictions` | 분기 예측 실패 횟수 | 파이프라인 플러시 비용. 조건 분기 최적화 대상 |
| `BranchInstructions` | 전체 분기 명령어 수 | 분기 실패율 분모. if/switch/loop 빈도 |
| `TotalIssues` | 디스패치된 마이크로 오퍼레이션 수 | uops/명령어 비율. CISC 명령어 복잡도 힌트 |
| `UnhaltedReferenceCycles` | 고정 주파수 기준 사이클 수 | 실효 CPU 주파수 추정 (터보/스로틀링 감지) |

### CPU 유도 지표 (10개)

Raw 카운터에서 계산. "추정" 표시된 항목은 ETW 멀티패스 샘플링 노이즈가 포함된 근사치.

| 지표 | 산식 | 추정 | 뭘 알 수 있나 |
|------|------|------|---------------|
| **IPC** | instr / cycles | - | 사이클당 처리 명령어. 1.0 미만이면 파이프라인 병목 |
| **L3 MPKI** | LLC miss / instr x 1000 | 추정 | 1000 명령어당 LLC 미스. 10 이상이면 메모리 바운드 |
| **Branch MPKI** | br mispredict / instr x 1000 | 추정 | 1000 명령어당 분기 실패. 높으면 분기 최적화 필요 |
| **Branch Mispred Rate** | br mispredict / br instr x 100% | 추정 | 분기 예측 실패율. 5% 이상이면 주의 |
| **LLC Hit Rate** | (ref - miss) / ref x 100% | 추정 | LLC 적중률. 95% 이상이면 캐시 효율 양호 |
| **LLC Ref MPKI** | LLC ref / instr x 1000 | 추정 | 1000 명령어당 LLC 접근. 워킹셋 크기 힌트 |
| **uOps / Instruction** | TotalIssues / InstrRetired | 추정 | 명령어당 마이크로 오퍼레이션. 1.5 이상이면 복잡한 명령어 비중 높음 |
| **Effective Frequency** | core cyc / ref cyc x base freq | 추정 | 실효 CPU 주파수. base보다 높으면 터보 부스트 작동 중 |
| **DRAM accesses** | = LLC miss 합계 | 추정 | DRAM 접근 총 횟수 (P+E 코어 합산) |
| **DRAM bytes** | LLC miss x 64B 캐시라인 | 추정 | DRAM 전송 바이트. 메모리 대역폭 추정 |

> **IPC만 "추정" 아닌 이유**: IPC는 두 카운터의 비율이라 배경 노이즈가 상쇄됨. 나머지는 서로 다른 패스에서 수집된 값의 교차 비율이라 노이즈 영향을 받음. 절대값보다 **프로세스 간 상대 비교**에 적합.

### GPU Raw 카운터 (5개)

Windows Performance Counter(`Get-Counter`)로 수집. 관리자 권한 불필요. CPU 측정과 동시에 자동 수집.

| 카운터 | 뭘 측정하나 | PID별 |
|--------|-------------|-------|
| **3D Engine Utilization** (%) | 3D 렌더링 엔진 점유율 | O |
| **Copy Engine Utilization** (%) | 메모리 복사 엔진 점유율 (DMA) | O |
| **Video Engine Utilization** (%) | 비디오 인코딩/디코딩 엔진 점유율 | O |
| **VRAM Dedicated** | GPU 전용 메모리 사용량 (물리 VRAM) | 어댑터 단위 |
| **VRAM Shared** | 시스템 RAM에서 GPU가 빌려 쓰는 메모리 | 어댑터 단위 |

> **Dedicated vs Shared**: Dedicated는 GPU에 물리적으로 탑재된 VRAM(가장 빠름). Shared는 시스템 RAM을 GPU가 공유(내장 GPU는 이것만 사용). 작업 관리자 "GPU 메모리"와 동일한 값.
>
> 가상 디스플레이 드라이버(Meta Virtual Monitor 등)는 자동으로 필터링되어 VRAM 합산 및 어댑터 목록에서 제외됩니다.

### ETW 미지원 카운터

아래 카운터는 ETW PMC에서 노출하지 않음. Intel VTune의 SEP 드라이버만 접근 가능.

| 카운터 | 용도 |
|--------|------|
| L1D miss | L1 데이터 캐시 미스 |
| L2 miss | L2 캐시 미스 |
| dTLB walk | 페이지 테이블 워크 (대용량 메모리 워크로드) |
| offcore latency | 오프코어 메모리 지연 |

## 시스템 현황 (작업 관리자 스타일)

앱 상단에 실시간 점유율 바 표시. 관리자 권한 불필요. "새로고침" 버튼으로 갱신.

| 바 | 소스 | 의미 |
|----|------|------|
| **CPU** | `os.cpus()` 1초 간격 비교 | 전체 CPU 사용률 |
| **RAM** | `os.totalmem()` / `os.freemem()` | 물리 메모리 사용률 |
| **GPU** | `GPU Engine\Utilization Percentage` | GPU 3D 엔진 사용률 |
| **VRAM** | `GPU Adapter Memory` | GPU 메모리 사용량 (아래 참고) |

70% 이상 노란색, 90% 이상 빨간색.

**VRAM 바 표시 로직:**

| 상황 | 표시 예시 | 설명 |
|------|-----------|------|
| Dedicated만 사용 | `Ded 500 MB / 2 GiB` | 외장 GPU 활성 시 |
| Shared만 사용 | `Shared 4.42 GiB` | 내장 GPU만 사용 시 (Dedicated VRAM 없음) |
| 둘 다 사용 | `Ded 500 MB + Shared 2 GiB` | 외장+내장 혼합 사용 시 |

바 비율 = GPU 총 메모리 사용량(Ded+Shared) / 시스템 RAM 총량. 가상 모니터(Virtual/Mirror)는 자동 제외.

## 동작 방식

"측정 시작" 버튼을 누르면:

1. **CPU PMC** -- `wpr.exe`로 ETW 트레이스 수집 -> ETL 바이너리 직접 파싱 (45MB -> 50ms). 카운터별 멀티패스 8회.
2. **GPU** -- PowerShell `Get-Counter`로 GPU Performance Counter 1초 샘플링. 임시 PS1 스크립트 생성 -> 실행 -> JSON 파싱 -> 삭제.
3. 두 결과를 합쳐서 **한 화면에 통합 표시**.

PID 필터링: CPU는 ETL 내 TID->PID 매핑으로 귀속, GPU는 카운터 인스턴스명의 PID로 필터링.

## 프로젝트 구조

```
src/
  main.js                    Electron 메인 프로세스 + IPC 핸들러
  preload.js                 IPC 브릿지 (context isolation)
  services/
    etwCollector.js          wpr.exe 세션 관리 + 멀티패스 수집 오케스트레이션
    etlParser.js             ETL 바이너리 직접 파싱 (PERFINFO_TRACE_HEADER)
    pmcService.js            CPU 측정 통합 서비스 (Raw 수집 + 유도 지표 계산)
    gpuService.js            GPU Raw 카운터 수집 (Windows Performance Counter)
    processService.js        프로세스 목록 조회 + 생존 추적
    systemInfo.js            시스템 하드웨어 정보 + 실시간 사용률
  renderer/
    index.html               UI 레이아웃
    style.css                다크 테마
    app.js                   프론트엔드 로직
scripts/
  test-etw-parser.js         유닛 테스트 (19개)
  test-gpu.js                GPU 스냅샷 테스트
  test-etw-collection.js     PMC 통합 테스트 (관리자 필요)
start-as-admin.bat           관리자 권한 실행 스크립트
package.json                 main: "src/main.js"
```

## 제한사항

| 제한 | 설명 |
|------|------|
| **관리자 권한 (CPU만)** | PMC 접근은 Windows에서 항상 admin 필요. GPU는 불필요 |
| **시스템 전체 수집** | ETW PMC는 system-wide 수집 후 PID 필터링 방식 |
| **배경 프로파일링 노이즈** | Windows 시스템 프로파일링이 동시 실행되어 절대값에 노이즈 포함 |
| **Hyper-V / VBS** | 가상화 환경에서 PMU 접근 불가능할 수 있음 |
| **ETW SampledCounter 미지원** | 카운팅 카운터 값이 ETL에 미포함. 멀티패스 방식으로 우회 |
| **P-Core / E-Core 미분리** | System(통합) 값만 제공 |
| **L1D/L2/dTLB/offcore** | ETW PMC에서 해당 카운터 미노출 |

## 테스트

```bash
node scripts/test-etw-parser.js        # 유닛 테스트 (18개)
node scripts/test-gpu.js               # GPU 스냅샷 테스트
node scripts/test-etw-collection.js    # PMC 통합 테스트 (관리자 필요)
```

## 관련 프로젝트

- [pmc-profiler](https://github.com/CompuFit/pmc-profiler) -- Intel VTune 기반 프로파일러 (정확하지만 설치 필요)
