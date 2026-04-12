@echo off
:: ETW PMC Profiler - Admin Elevation Script
:: Prevents recursive elevation via sentinel argument

if "%1"=="__ELEVATED__" goto :RUN

echo ETW PMC Profiler 를 관리자 권한으로 시작합니다...
powershell -Command "Start-Process -FilePath '%~f0' -ArgumentList '__ELEVATED__' -Verb RunAs -WorkingDirectory '%~dp0'"
exit /b

:RUN
cd /d "%~dp0"
echo 관리자 권한으로 실행 중...
npm start
pause
