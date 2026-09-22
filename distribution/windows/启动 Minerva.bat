@echo off
setlocal
title Minerva Launcher
echo Minerva is starting. The first initialization may take several minutes.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Start-Minerva.ps1"
set "MINERVA_EXIT=%ERRORLEVEL%"
if not "%MINERVA_EXIT%"=="0" (
  echo.
  echo Minerva failed to start. See the logs folder for details.
  pause
)
endlocal & exit /b %MINERVA_EXIT%
