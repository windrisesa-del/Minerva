@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "WEB_DIR=%ROOT_DIR%"
set "BACKEND_DIR=%WEB_DIR%backend"
set "ENSURE_SCRIPT=%BACKEND_DIR%\scripts\ensure_data_api.ps1"
set "WIKI_ENSURE_SCRIPT=%WEB_DIR%services\wikijs\ensure.ps1"
set "WEB_URL=http://127.0.0.1:30141"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "NPM_CLI=C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"

if not exist "%WEB_DIR%\package.json" (
    echo [Minerva] Web project not found:
    echo %WEB_DIR%
    pause
    exit /b 1
)

if not exist "%WEB_DIR%\node_modules" (
    echo [Minerva] Web dependencies are missing.
    echo Run npm install in:
    echo %WEB_DIR%
    pause
    exit /b 1
)

if not exist "%ENSURE_SCRIPT%" (
    echo [Minerva] Data API helper not found:
    echo %ENSURE_SCRIPT%
    pause
    exit /b 1
)

if /i "%~1"=="--check" (
    echo [Minerva] Launcher check passed.
    echo Web directory: %WEB_DIR%
    echo Backend directory: %BACKEND_DIR%
    echo Web URL: %WEB_URL%
    echo Data API docs: http://127.0.0.1:8000/docs
    echo Wiki.js URL: http://127.0.0.1:3002/
    exit /b 0
)

echo [Minerva] Ensuring local PostgreSQL data API...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ENSURE_SCRIPT%"
if errorlevel 1 (
    echo [Minerva] Failed to start PostgreSQL / the local data API.
    echo Student assignment views need this service.
    pause
    exit /b 1
)

if exist "%WIKI_ENSURE_SCRIPT%" (
    echo [Minerva] Ensuring local Wiki.js...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WIKI_ENSURE_SCRIPT%"
    if errorlevel 1 echo [Minerva] Wiki.js is unavailable; student graphs will use Minerva profile data only.
)

powershell.exe -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 30141 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
    echo [Minerva] Web is already running. Opening browser...
    start "" "%WEB_URL%"
    exit /b 0
)

echo [Minerva] Starting Web server...
pushd "%WEB_DIR%"

if exist "%NODE_EXE%" if exist "%NPM_CLI%" (
    start "Minerva Web" cmd.exe /k ""%NODE_EXE%" "%NPM_CLI%" run dev"
) else (
    start "Minerva Web" cmd.exe /k "npm.cmd run dev"
)

popd

echo [Minerva] Waiting for %WEB_URL% ...
powershell.exe -NoProfile -Command "$deadline = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $deadline) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri '%WEB_URL%' -TimeoutSec 2; if ($response.StatusCode -lt 500) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"

if errorlevel 1 (
    echo [Minerva] The server did not become ready within 60 seconds.
    echo Check the Minerva Web terminal for details.
    pause
    exit /b 1
)

echo [Minerva] Web is ready. Opening browser...
start "" "%WEB_URL%"
exit /b 0
