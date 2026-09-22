@echo off
setlocal
title Minerva Stopper
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Stop-Minerva.ps1"
set "MINERVA_EXIT=%ERRORLEVEL%"
if not "%MINERVA_EXIT%"=="0" (
  echo.
  echo Minerva failed to stop.
  pause
)
endlocal & exit /b %MINERVA_EXIT%
