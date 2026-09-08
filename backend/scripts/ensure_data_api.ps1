$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot "start_data_api.ps1"
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"
$apiUrl = "http://127.0.0.1:8000/api/health"

function Test-ApiReady {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $apiUrl -TimeoutSec 2
    return $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $startScript)) {
  throw "Data API start script not found: $startScript"
}
if (-not (Test-Path -LiteralPath $python)) {
  throw "FastAPI environment is missing. Run backend\scripts\setup.ps1 first."
}

if (Test-ApiReady) {
  Write-Output "Minerva data API is already running at http://127.0.0.1:8000/"
  exit 0
}

$occupied = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
if ($occupied) {
  throw "Port 8000 is in use but the Minerva data API is not healthy."
}

Write-Output "Starting Minerva data API (PostgreSQL + FastAPI)..."
$cmd = Join-Path $env:SystemRoot "System32\cmd.exe"
Start-Process -FilePath $cmd -WorkingDirectory $backendRoot -ArgumentList @(
  "/k",
  "title Minerva Data API & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_data_api.ps1"
) | Out-Null

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (Test-ApiReady) {
    Write-Output "Minerva data API is ready at http://127.0.0.1:8000/"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

throw "The Minerva data API did not become ready within 60 seconds."
