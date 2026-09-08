@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\scripts\start_dbeaver.ps1"
if errorlevel 1 (
  echo.
  echo Failed to start Minerva data manager.
  pause
)
endlocal
